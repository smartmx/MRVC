/**
 * Build configurations (MRS2's "编译配置列表" dropdown + "配置管理" dialog).
 *
 * MRS2 does NOT store an active flag anywhere: the active configuration is
 * simply the first <cconfiguration> in .cproject. Its settings page keeps the
 * whole list in memory and, on Apply, writes the currently edited one back to
 * configurations[0] (resources/html/store.js: GetNewSettingData) — after which
 * every property file is regenerated in that order. Everything downstream
 * (build directory, compiler options, per-config excludes, Target Path)
 * follows the file order alone, which is exactly what MRVC already assumes
 * (`Cproject` picks cconfigs[0]).
 *
 * Switching is a pure REORDER: the configuration blocks keep their bytes,
 * only their positions change. .template's Target Path is rewritten to
 * "<newConfig>/<same file name>" — the same rule as MRS's own
 * chooseOutType() (it keeps the last path segment and always joins with '/').
 *
 * Manage operations mirror the MRS dialog:
 *   add     — deep-copy a source configuration, append it, retarget the
 *             configuration-level CDT ids from the new name (MRS derives them
 *             as the first 8 hex digits of sha1(name), as an integer);
 *   rename  — change the name on the block (+ ids); renaming the ACTIVE one
 *             also moves the download Target Path, like MRS;
 *   delete  — refused for the active configuration (MRS wording), removes the
 *             block and its .wvproj entry.
 * Option-level ids are constants in MRS's own writer, so they are copied
 * unchanged — exactly what a real MRS2 project already contains.
 *
 * .wvproj is a generated snapshot: MRS2 never reads it (propertyManager's
 * updateWvProjContent is write-only), so it is kept in sync on a best-effort
 * basis and a broken/absent one never blocks an operation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Cproject, configurationName, configNameProblem, isValidConfigName } from './cproject';
import { strictXmlFileError } from './audit';
import { XElement } from './xml';
import { readTemplate, templateSet } from './templateFile';

/** what MRS's add dialog accepts: no spaces or special characters (letters,
 *  digits, Chinese, '_' and '-' — the same family it lets become a folder) */
export const CONFIG_NAME_RE = /^[\w\u4e00-\u9fa5-]+$/u;
/** MRS refuses the 11th configuration ("达到最大编译配置数量限制") */
export const MAX_CONFIGURATIONS = 10;

export interface SwitchResult {
  /** false when the requested configuration is already active */
  changed: boolean;
  /** the configuration that is active after the call */
  active: string;
  /** configuration names in their new file order (index 0 = active) */
  names: string[];
  /** the .template Target Path written (undefined when there is no .template) */
  targetPath?: string;
  wvproj: 'updated' | 'absent' | 'skipped';
}

export interface ManageResult {
  /** configuration names after the operation (index 0 = active) */
  names: string[];
  active: string;
  /** .template Target Path written (rename of the active config only) */
  targetPath?: string;
}

/** resolve a directory ENTRY name (no separators, not absolute) inside root */
function entryPath(root: string, name: string): string | null {
  if (!name || path.basename(name) !== name || path.isAbsolute(name)) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, name);
  return full.startsWith(base + path.sep) ? full : null;
}

function findWvproj(root: string): string | null {
  try {
    const name = fs.readdirSync(root).find((n) => n.toLowerCase().endsWith('.wvproj')) ?? '';
    return name ? entryPath(root, name) : null;
  } catch {
    return null;
  }
}

interface WvDoc {
  buildConfig?: { configurations?: Array<{ name?: string }> };
  flashConfig?: Record<string, unknown>;
}

function readWv(file: string): WvDoc {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as WvDoc;
}

/** MRS writes this file with JSON.stringify(model, null, '\t') — the same
 *  call keeps an untouched snapshot byte-identical (verified on real files) */
function writeWv(file: string, doc: WvDoc): void {
  fs.writeFileSync(file, JSON.stringify(doc, null, '\t'), 'utf-8');
}

/** MRS's configuration-level id suffix: first 8 hex digits of sha1(name).
 *  SHA-1 is used purely for byte-compatible id derivation with MRS's own
 *  writer (propertyManager.ts readCConfigurations) — not as a security
 *  primitive. */
function configIdSuffix(name: string): string {
  return String(parseInt(createHash('sha1').update(name).digest('hex').slice(0, 8), 16));
}

/** rewrite the name of a <cconfiguration> block and the CDT ids derived from
 *  it (cconfiguration / settings storageModule / configuration / toolChain).
 *  Option and error-parser ids are constants in MRS's own writer. */
function renameConfigBlock(el: XElement, name: string): void {
  const suffix = configIdSuffix(name);
  const idRe = /^(ilg\.gnumcueclipse\.managedbuild\.cross\.riscv\.(?:config|toolchain)\.elf\.(?:release|debug))\.\d+$/;
  const walk = (e: XElement): void => {
    if (e.name === 'configuration' && e.attr('name') !== undefined) e.setAttr('name', name);
    if (
      e.name === 'storageModule' &&
      e.attr('moduleId') === 'org.eclipse.cdt.core.settings' &&
      e.attr('name') !== undefined
    ) {
      e.setAttr('name', name);
    }
    for (const [k, v] of Object.entries(e.attrs)) {
      if (k === 'id' && idRe.test(v)) e.setAttr('id', v.replace(/\.\d+$/, `.${suffix}`));
    }
    for (const c of e.children) walk(c);
  };
  walk(el);
}

function cloneElement(src: XElement): XElement {
  const copy = new XElement(src.name);
  copy.attrs = { ...src.attrs };
  copy.text = src.text;
  copy.ws = src.ws.slice();
  copy.emptyPairInSource = src.emptyPairInSource;
  copy.selfCloseSpaced = src.selfCloseSpaced;
  for (const child of src.children) {
    const cc = cloneElement(child);
    cc.parent = copy;
    copy.children.push(cc);
  }
  return copy;
}

/** load .cproject for a write operation: same hard XML gate as Apply, and
 *  every configuration must live under one parent to be reorderable */
function loadForWrite(projectRoot: string): { cp: Cproject; els: XElement[]; names: string[] } {
  const cp = Cproject.load(projectRoot);
  const xmlError = strictXmlFileError(cp.file, 'cproject');
  if (xmlError) {
    throw new Error(`.cproject XML is invalid (${xmlError}) — run Audit And Repair first`);
  }
  const els = cp.configurationElements;
  if (els.length === 0) {
    throw new Error('.cproject: no configuration found');
  }
  const names = els.map((el) => configurationName(el));
  return { cp, els, names };
}

function assertValidName(name: string): void {
  if (!CONFIG_NAME_RE.test(name)) {
    throw new Error('configuration name may only contain letters, digits, Chinese, "_" and "-"');
  }
  // ONE shared definition of "safe directory name" (round4-6): the message
  // carries the concrete reason (reserved device name / too long / …) so the
  // Manage dialog shows an actionable hint instead of a shell error later
  const problem = configNameProblem(name);
  if (problem) {
    throw new Error(`configuration name ${problem}`);
  }
}

function assertUnique(names: string[], name: string): void {
  // case-insensitive: the name is a directory, and Windows folds case
  const fold = name.toLowerCase();
  if (names.some((n) => n.toLowerCase() === fold)) {
    throw new Error(`configuration already exists: ${name}`);
  }
}

/**
 * Resolve the configuration a Manage operation acts on (0.3.7).
 *
 * MRVC's own Add/Rename can never create two configurations with the same
 * name (assertUnique) — duplicates only arrive from OUTSIDE: WCH EVT trees,
 * MRS, or a hand-edited .cproject. For such a project a NAME is ambiguous,
 * and the old `names.indexOf(name)` silently resolved every operation to the
 * FIRST match: "Set as Active" on the 2nd became a no-op, "Delete" on the 2nd
 * refused with "cannot delete the active configuration", and "Rename" on the
 * 2nd renamed the ACTIVE one instead. The Manage dialog therefore addresses
 * rows by INDEX; `index` (when supplied) must name a row whose name is the
 * given one, and an ambiguous name without an index is an error rather than
 * a guess.
 */
function resolveConfigIndex(names: string[], name: string, index?: number): number {
  const byIndex = Number.isInteger(index) && index! >= 0 && index! < names.length ? index! : -1;
  if (byIndex >= 0) {
    if (names[byIndex] !== name) {
      throw new Error(`configuration #${byIndex} is not named "${name}" — the list changed, reopen Manage`);
    }
    return byIndex;
  }
  const first = names.indexOf(name);
  if (first < 0) {
    throw new Error(`unknown configuration: ${name}`);
  }
  if (names.indexOf(name, first + 1) >= 0) {
    throw new Error(
      `the name "${name}" is used by more than one configuration — pick the row to act on (rename one of them to make the names unique)`
    );
  }
  return first;
}

/** write "<name>/<same file name>" into .template (MRS chooseOutType rule) */
function writeTemplateTarget(projectRoot: string, cp: Cproject, name: string): string | undefined {
  if (!fs.existsSync(path.join(projectRoot, '.template'))) return undefined;
  const tpl = readTemplate(projectRoot);
  const old = (tpl.values['Target Path'] ?? '').trim();
  const file = old ? old.split(/[\\/]/).pop() ?? '' : '';
  const targetPath = `${name}/${file || `${cp.artifactName}.hex`}`;
  if (old !== targetPath) templateSet(projectRoot, 'Target Path', targetPath);
  return targetPath;
}

/** configuration names in file order — index 0 is the active one */
export function listConfigurations(projectRoot: string): string[] {
  return Cproject.load(projectRoot).configurationNames;
}

/**
 * Row of a configuration in the .wvproj `buildConfig.configurations` snapshot
 * — the SAME position as the .cproject row while the snapshot mirrors
 * .cproject (same length, same name at that index); by name otherwise, for a
 * snapshot whose order drifted.
 *
 * Returns -1 (leave the snapshot alone) when the name is ambiguous in the
 * drifted case: a guess would move, rename, delete or clone the WRONG row,
 * and the snapshot is generated — MRS2 never reads it — so skipping is the
 * safe outcome (0.3.7 round1 P3.2).
 */
function snapshotRowIndex(arr: unknown, names: readonly string[], idx: number, name: string): number {
  if (!Array.isArray(arr)) return -1;
  const nameAt = (i: number): unknown => (arr[i] as { name?: unknown } | undefined)?.name;
  if (arr.length === names.length && nameAt(idx) === name) return idx;
  const first = arr.findIndex((c) => (c as { name?: unknown } | undefined)?.name === name);
  if (first < 0) return -1;
  for (let i = first + 1; i < arr.length; i++) {
    if (nameAt(i) === name) return -1;
  }
  return first;
}

/**
 * Make the configuration at `index` (or the unique one named `name`) the
 * active configuration.
 *
 * Throws (without writing anything) for an unknown name, an ambiguous name
 * with no index (see resolveConfigIndex), or a .cproject whose configuration
 * elements cannot be reordered safely. Idempotent when it is already active.
 */
export function switchConfiguration(projectRoot: string, name: string, index?: number): SwitchResult {
  const { cp, els, names } = loadForWrite(projectRoot);
  const idx = resolveConfigIndex(names, name, index);
  const active = names[0];
  if (idx === 0) {
    return { changed: false, active, names, wvproj: 'skipped' };
  }

  const first = els[0];
  const target = els[idx];
  const parent = first.parent;
  if (!parent || target.parent !== parent) {
    throw new Error('.cproject: configurations do not share a parent element');
  }
  const i0 = parent.children.indexOf(first);
  const it = parent.children.indexOf(target);
  if (i0 < 0 || it < 0) {
    throw new Error('.cproject: inconsistent configuration order');
  }
  // MRS2's 保存 writes the chosen configuration at index 0 and leaves every
  // other configuration in its existing relative order (GetNewSettingData:
  // `configurations[0] = current`, the rest from StoreBuildConfig). Moving
  // the block — not swapping it with the old first one — is what a 3+
  // configuration project needs: A,B,C -> C must become C,A,B, never C,B,A.
  // `ws[i]` is the whitespace recorded BEFORE child i; it travels with the
  // block, so the rewrite touches nothing but the order.
  if (i0 > it) {
    throw new Error('.cproject: inconsistent configuration order');
  }
  const [moved] = parent.children.splice(it, 1);
  const [movedWs] = parent.ws.splice(it, 1);
  parent.children.splice(i0, 0, moved);
  parent.ws.splice(i0, 0, movedWs);
  cp.save();

  const targetPath = writeTemplateTarget(projectRoot, cp, name);

  // .wvproj snapshot: reorder the same way and keep flashConfig in step.
  // MRS2 ignores the file, so problems here are reported, never fatal.
  let wvproj: SwitchResult['wvproj'] = 'absent';
  const wvFile = findWvproj(projectRoot);
  if (wvFile) {
    wvproj = 'skipped';
    try {
      const doc = readWv(wvFile);
      const arr = doc?.buildConfig?.configurations;
      // address the .wvproj row by the SAME position as the .cproject one — a
      // name lookup would pick the first of two same-named rows
      const wi = snapshotRowIndex(arr, names, idx, name);
      if (Array.isArray(arr) && wi >= 0) {
        if (wi > 0) {
          const picked = arr.splice(wi, 1)[0];
          arr.unshift(picked);
        }
        if (targetPath && doc.flashConfig && typeof doc.flashConfig === 'object') {
          doc.flashConfig.target_path = targetPath;
        }
        writeWv(wvFile, doc);
        wvproj = 'updated';
      }
    } catch {
      wvproj = 'skipped';
    }
  }

  // the returned order is by POSITION, not by name: with two configurations
  // sharing a name a name-based filter would drop both
  const ordered = [names[idx], ...names.filter((_, i) => i !== idx)];
  return {
    changed: true,
    active: name,
    names: ordered,
    targetPath,
    wvproj,
  };
}

/**
 * Add a configuration by deep-copying `copyFrom` (default: the active one) and
 * appending it — MRS's 添加 dialog semantics (copy source + unique name).
 * `copyFromIndex` selects the SOURCE row when the name is shared (two
 * same-named configurations can carry different option sets).
 */
export function addConfiguration(
  projectRoot: string,
  name: string,
  copyFrom?: string,
  copyFromIndex?: number
): ManageResult {
  const { cp, els, names } = loadForWrite(projectRoot);
  assertValidName(name);
  if (names.length >= MAX_CONFIGURATIONS) {
    throw new Error(`at most ${MAX_CONFIGURATIONS} configurations are supported`);
  }
  assertUnique(names, name);
  let sourceIdx = 0;
  if (typeof copyFromIndex === 'number' && Number.isInteger(copyFromIndex) && copyFromIndex >= 0 && copyFromIndex < names.length) {
    if (copyFrom !== undefined && names[copyFromIndex] !== copyFrom) {
      throw new Error(`configuration #${copyFromIndex} is not named "${copyFrom}" — the list changed, reopen Manage`);
    }
    sourceIdx = copyFromIndex;
  } else if (copyFrom && names.includes(copyFrom)) {
    sourceIdx = resolveConfigIndex(names, copyFrom);
  }
  const sourceName = names[sourceIdx];
  const source = els[sourceIdx];
  const parent = source?.parent;
  if (!source || !parent) {
    throw new Error(`unknown configuration: ${sourceName}`);
  }
  const clone = cloneElement(source);
  renameConfigBlock(clone, name);
  parent.append(clone);
  // give the newcomer the same leading whitespace as its previous sibling —
  // append() records no ws, which would otherwise fall back to tabs
  const idx = parent.children.length - 1;
  const ws = parent.ws[idx - 1];
  if (ws !== undefined) parent.ws[idx] = ws;
  cp.save();

  const wvFile = findWvproj(projectRoot);
  if (wvFile) {
    try {
      const doc = readWv(wvFile);
      const arr = doc?.buildConfig?.configurations;
      // the SAME positional row as the .cproject source (round1 P3.2: the
      // name lookup copied the FIRST of two same-named rows even when the
      // user picked the second)
      const si = snapshotRowIndex(arr, names, sourceIdx, sourceName);
      const srcCfg = Array.isArray(arr) && si >= 0 ? arr[si] : undefined;
      if (Array.isArray(arr) && srcCfg) {
        const copy = JSON.parse(JSON.stringify(srcCfg)) as { name?: string };
        copy.name = name;
        arr.push(copy);
        writeWv(wvFile, doc);
      }
    } catch {
      // snapshot only — MRS2 never reads it
    }
  }
  return { names: [...names, name], active: names[0] };
}

/**
 * Rename a configuration. Renaming the ACTIVE one moves the Target Path.
 * `index` addresses the row when the old name is shared by more than one
 * configuration (see resolveConfigIndex).
 */
export function renameConfiguration(projectRoot: string, oldName: string, newName: string, index?: number): ManageResult {
  const { cp, els, names } = loadForWrite(projectRoot);
  const idx = resolveConfigIndex(names, oldName, index);
  if (newName === oldName) {
    return { names, active: names[0] };
  }
  assertValidName(newName);
  // the row being renamed is not its own competitor (a same-name rename is
  // the no-op above; every collision with ANOTHER row still refuses)
  const others = names.filter((_, i) => i !== idx);
  assertUnique(others, newName);
  renameConfigBlock(els[idx], newName);
  const nextNames = names.map((n, i) => (i === idx ? newName : n));
  const targetPath = idx === 0 ? writeTemplateTarget(projectRoot, cp, newName) : undefined;
  cp.save();

  const wvFile = findWvproj(projectRoot);
  if (wvFile) {
    try {
      const doc = readWv(wvFile);
      const arr = doc?.buildConfig?.configurations;
      // positional row first — two same-named rows must not resolve to the
      // same entry; the name lookup stays as the fallback for a .wvproj whose
      // order drifted from the .cproject
      const ri = snapshotRowIndex(arr, names, idx, oldName);
      const cfg = Array.isArray(arr) && ri >= 0 ? arr[ri] : undefined;
      if (Array.isArray(arr) && cfg) {
        cfg.name = newName;
        if (targetPath && doc.flashConfig && typeof doc.flashConfig === 'object') {
          doc.flashConfig.target_path = targetPath;
        }
        writeWv(wvFile, doc);
      }
    } catch {
      // snapshot only
    }
  }
  return { names: nextNames, active: nextNames[0], targetPath };
}

/**
 * Delete a configuration. The active one is refused (MRS: "不支持删除当前
 * 激活中的配置"); at least one configuration must remain.
 */
export function deleteConfiguration(projectRoot: string, name: string, index?: number): ManageResult {
  const { cp, els, names } = loadForWrite(projectRoot);
  const idx = resolveConfigIndex(names, name, index);
  if (idx === 0) {
    throw new Error('cannot delete the active configuration — switch to another one first');
  }
  if (names.length <= 1) {
    throw new Error('at least one configuration must remain');
  }
  const parent = els[idx].parent;
  if (!parent) {
    throw new Error('.cproject: inconsistent configuration layout');
  }
  parent.removeChild(els[idx]);
  cp.save();

  const wvFile = findWvproj(projectRoot);
  if (wvFile) {
    try {
      const doc = readWv(wvFile);
      const arr = doc?.buildConfig?.configurations;
      // remove the SAME positional row (a name lookup picks the first of two
      // same-named rows and would leave the wrong one behind)
      const wi = snapshotRowIndex(arr, names, idx, name);
      if (Array.isArray(arr) && wi >= 0) {
        arr.splice(wi, 1);
        writeWv(wvFile, doc);
      }
    } catch {
      // snapshot only
    }
  }
  const nextNames = names.filter((_, i) => i !== idx);
  return { names: nextNames, active: nextNames[0] };
}
