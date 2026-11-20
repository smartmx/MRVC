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
 * Make `name` the active configuration.
 *
 * Throws (without writing anything) for an unknown name or a .cproject whose
 * configuration elements cannot be reordered safely. Idempotent when the name
 * is already active.
 */
export function switchConfiguration(projectRoot: string, name: string): SwitchResult {
  const { cp, els, names } = loadForWrite(projectRoot);
  const idx = names.indexOf(name);
  if (idx < 0) {
    throw new Error(`unknown configuration: ${name}`);
  }
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
      const wi = Array.isArray(arr) ? arr.findIndex((c) => c?.name === name) : -1;
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

  return {
    changed: true,
    active: name,
    names: [name, ...names.filter((n) => n !== name)],
    targetPath,
    wvproj,
  };
}

/**
 * Add a configuration by deep-copying `copyFrom` (default: the active one) and
 * appending it — MRS's 添加 dialog semantics (copy source + unique name).
 */
export function addConfiguration(projectRoot: string, name: string, copyFrom?: string): ManageResult {
  const { cp, els, names } = loadForWrite(projectRoot);
  assertValidName(name);
  if (names.length >= MAX_CONFIGURATIONS) {
    throw new Error(`at most ${MAX_CONFIGURATIONS} configurations are supported`);
  }
  assertUnique(names, name);
  const sourceName = copyFrom && names.includes(copyFrom) ? copyFrom : names[0];
  const source = els[names.indexOf(sourceName)];
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
      const srcCfg = Array.isArray(arr) ? arr.find((c) => c?.name === sourceName) : undefined;
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

/** Rename a configuration. Renaming the ACTIVE one moves the Target Path. */
export function renameConfiguration(projectRoot: string, oldName: string, newName: string): ManageResult {
  const { cp, els, names } = loadForWrite(projectRoot);
  const idx = names.indexOf(oldName);
  if (idx < 0) {
    throw new Error(`unknown configuration: ${oldName}`);
  }
  if (newName === oldName) {
    return { names, active: names[0] };
  }
  assertValidName(newName);
  assertUnique(names, newName);
  renameConfigBlock(els[idx], newName);
  const nextNames = names.map((n, i) => (i === idx ? newName : n));
  const targetPath = idx === 0 ? writeTemplateTarget(projectRoot, cp, newName) : undefined;
  cp.save();

  const wvFile = findWvproj(projectRoot);
  if (wvFile) {
    try {
      const doc = readWv(wvFile);
      const arr = doc?.buildConfig?.configurations;
      const cfg = Array.isArray(arr) ? arr.find((c) => c?.name === oldName) : undefined;
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
export function deleteConfiguration(projectRoot: string, name: string): ManageResult {
  const { cp, els, names } = loadForWrite(projectRoot);
  const idx = names.indexOf(name);
  if (idx < 0) {
    throw new Error(`unknown configuration: ${name}`);
  }
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
      const wi = Array.isArray(arr) ? arr.findIndex((c) => c?.name === name) : -1;
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
