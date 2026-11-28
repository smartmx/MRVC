/**
 * Workspace IntelliSense configuration: merge every loaded project's
 * compile commands into `.vscode/compile_commands.json` and point
 * `.vscode/c_cpp_properties.json` at it (cpptools reads per-file entries,
 * so each project keeps its own defines and include paths).
 *
 * Writes are hash-gated: identical content never touches the disk, so the
 * frequent store refreshes (source-file saves) do not restart the
 * IntelliSense engine.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectStore, getInstall, MrsProject } from './projects';
import { Cproject, foldPathOnPlatform } from '../core/cproject';
import { ToolchainInfo, withRealSuffix } from '../core/toolchain';
import { buildCompileEntries, partitionByReference, contextDatabases, versionAtLeast, CompileCommandEntry } from '../core/intellisense';
import { assertContainedMetaFile, resolveContainedMetaDir } from '../core/outputHistory';
import { t } from '../core/i18n';
import {
  stripJsonc,
  matchBracket,
  skipWs,
  indentOf,
  reindent,
  objectProps,
  objectPropsAt,
  arrayElements,
  hadTrailingCommaFn,
} from '../core/jsonc';

const CONFIG_NAME = 'MRVC';

const RENAME_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function assertRegularOrMissing(file: string): void {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`refusing to write linked or non-regular metadata file: ${file}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
  }
}

function writeIfChanged(file: string, content: string): boolean {
  assertRegularOrMissing(file);
  try {
    if (fs.readFileSync(file, 'utf-8') === content) return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
  }
  const prior = fs.lstatSync(file, { throwIfNoEntry: false });
  if (prior) fs.accessSync(file, fs.constants.W_OK);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx', prior ? 0o600 : 0o666);
    try {
      fs.writeFileSync(fd, content, 'utf-8');
      if (prior && process.platform !== 'win32') fs.fchmodSync(fd, prior.mode & 0o777);
    } finally {
      fs.closeSync(fd);
    }
    assertRegularOrMissing(file);
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (attempt < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          Atomics.wait(RENAME_SLEEP_BUF, 0, 0, 10);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore temp cleanup failure
    }
    throw e;
  }
  return true;
}

type PropsWrite = 'written' | 'unchanged' | 'unreadable';

const CACHE_PATH_KEY = 'C_Cpp.intelliSenseCachePath';
const CACHE_SIZE_KEY = 'C_Cpp.intelliSenseCacheSize';

/** one workspace-settings key MRVC manages: the value plus the type a hand
 *  edit must keep (a path stays a string, a size stays a number, the
 *  files.associations object stays an object). `removeKeys` asks for keys to
 *  DELETE inside a managed object (plain-JSON files only — a JSONC file
 *  cannot have entries surgically removed without comma/comment surgery, so
 *  there the removal is silently skipped and the caller keeps its entries) */
export interface WorkspaceSettingWrite {
  key: string;
  value: string | number | Record<string, string>;
  kind: 'string' | 'number' | 'object';
  removeKeys?: readonly string[];
}

/**
 * Write managed keys into ONE workspace settings.json — preserving
 * everything else exactly like writePropsFile does for c_cpp_properties.json:
 * plain-JSON files (and absent ones) re-serialize whole; JSONC files get a
 * surgical value-span splice so user comments and sibling settings stay
 * byte-for-byte; unparsable files are never touched. A hand edit that turned
 * a managed key into the wrong type is respected by leaving the file alone —
 * never overwrite what we do not understand. MRVC only writes when the
 * corresponding setting is configured, and never deletes what it finds.
 */
export function writeWorkspaceCacheSettings(settingsFile: string, writes: WorkspaceSettingWrite[]): PropsWrite {
  let raw: string;
  try {
    const st = fs.lstatSync(settingsFile);
    if (st.isSymbolicLink() || !st.isFile()) return 'unreadable';
    raw = fs.readFileSync(settingsFile, 'utf-8');
  } catch {
    raw = ''; // absent — a fresh plain-JSON file is created below
  }
  const trailingCommas = new Map<number, number>();
  const stripped = stripJsonc(raw, trailingCommas);
  let parsed: Record<string, unknown> | undefined;
  if (raw !== '') {
    try {
      parsed = JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      return 'unreadable';
    }
    if (!isPlainObject(parsed)) return 'unreadable';
  }
  if (raw === stripped) {
    const settings = (parsed ?? {}) as Record<string, unknown>;
    for (const w of writes) {
      const existing = settings[w.key];
      if (existing !== undefined && existing !== null) {
        // `typeof [] === 'object'` — an array in place of the associations
        // object is a hand edit we must not overwrite (review H3)
        if (typeof existing !== w.kind || (w.kind === 'object' && Array.isArray(existing))) return 'unreadable';
      }
      if (w.kind === 'object') {
        const value = w.value as Record<string, string>;
        const merged = { ...(isPlainObject(existing) ? existing : {}), ...value };
        // removals happen AFTER the merge so a pruned key cannot re-enter
        // through `value`, and the equality check sees the final shape
        for (const k of w.removeKeys ?? []) delete merged[k];
        if (sameSettingValue(existing, merged)) continue;
        settings[w.key] = merged;
        continue;
      }
      if (existing === w.value) continue;
      settings[w.key] = w.value;
    }
    return writeIfChanged(settingsFile, JSON.stringify(settings, null, 2) + '\n') ? 'written' : 'unchanged';
  }
  // ---- JSONC path: splice only our value spans / insert our properties ----
  const props = objectProps(stripped, trailingCommas);
  if (!props) return 'unreadable';
  const rootOpen = skipWs(stripped, 0);
  const rootClose = matchBracket(stripped, rootOpen);
  if (rootClose < 0) return 'unreadable';
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const pending: WorkspaceSettingWrite[] = [];
  for (const w of writes) {
    const mine = props.find((p) => p.key === w.key);
    if (!mine) {
      pending.push(w);
      continue;
    }
    let frag: unknown;
    try {
      frag = JSON.parse(stripped.slice(mine.value.start, mine.value.end));
    } catch {
      return 'unreadable';
    }
    if (w.kind !== 'object') {
      if (frag !== null && typeof frag !== w.kind) return 'unreadable'; // hand edit — never touch
      if (frag === w.value) continue; // already the desired value
      edits.push({ start: mine.value.start, end: valueTokenEnd(stripped, mine.value.start, mine.value.end), text: JSON.stringify(w.value) });
      continue;
    }
    // ---- kind 'object': merge key-by-key INSIDE the existing object, so
    // the user's sibling entries, comments and layout survive (review H3).
    // Replacing the whole value span would flatten the object to one line
    // and permanently drop every comment inside it. NOTE: `removeKeys` is
    // plain-JSON only — a JSONC file keeps its stale entries (surgical
    // removal would need comma/comment reconstruction around the gap).
    if (frag !== null && !isPlainObject(frag)) return 'unreadable'; // scalar/array where an object must sit
    if (frag === null) {
      // null carries nothing to preserve — replace the token outright
      edits.push({
        start: mine.value.start,
        end: valueTokenEnd(stripped, mine.value.start, mine.value.end),
        text: formatSettingObject(w.value as Record<string, string>, indentOf(stripped, mine.keyStart)),
      });
      continue;
    }
    const openPos = skipWs(stripped, mine.value.start);
    if (stripped[openPos] !== '{') return 'unreadable';
    const objClose = matchBracket(stripped, openPos);
    if (objClose < 0) return 'unreadable';
    const nested = objectPropsAt(stripped, openPos, trailingCommas);
    if (!nested) return 'unreadable';
    const keyIndent = indentOf(stripped, mine.keyStart);
    const inserts: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(w.value as Record<string, string>)) {
      const p = nested.find((np) => np.key === k);
      if (!p) {
        inserts.push([k, v]);
        continue;
      }
      let pv: unknown;
      try {
        pv = JSON.parse(stripped.slice(p.value.start, p.value.end));
      } catch {
        return 'unreadable';
      }
      if (pv === v) continue; // entry already as desired
      // replace ONLY the value token: a line-end comment behind it survives
      edits.push({ start: p.value.start, end: valueTokenEnd(stripped, p.value.start, p.value.end), text: JSON.stringify(v) });
    }
    if (!inserts.length) continue;
    const lines = inserts.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    // where the object's closer sits decides the layout: on its own line the
    // new entries take that line's place (the closer keeps its indent);
    // an inline object gets entries on fresh lines at the key indent + 2
    const closerLineStart = stripped.lastIndexOf('\n', objClose - 1) + 1;
    const closerOnOwnLine = /^[ \t]*$/.test(stripped.slice(closerLineStart, objClose));
    const closeIndent = closerOnOwnLine ? indentOf(stripped, objClose) : keyIndent;
    let propIndent = closeIndent + '  ';
    if (nested.length) {
      const firstLineStart = stripped.lastIndexOf('\n', nested[0].keyStart - 1) + 1;
      propIndent = /^[ \t]*$/.test(stripped.slice(firstLineStart, nested[0].keyStart))
        ? indentOf(stripped, nested[0].keyStart)
        : keyIndent + '  ';
      if (!hadTrailingCommaFn(trailingCommas, objClose)) {
        // the separator goes right behind the last value token, BEFORE any
        // line-end comment, so `"*.h": "c", // note` keeps its note in place
        const last = nested[nested.length - 1];
        const tokenEnd = valueTokenEnd(stripped, last.value.start, last.value.end);
        edits.push({ start: tokenEnd, end: tokenEnd, text: ',' });
      }
    }
    const body = lines.map((l) => propIndent + l).join(',\n');
    if (closerOnOwnLine) edits.push({ start: closerLineStart, end: closerLineStart, text: `${body}\n` });
    else edits.push({ start: objClose, end: objClose, text: `\n${body}\n${closeIndent}` });
  }
  if (pending.length) {
    const rootIndent = indentOf(stripped, rootOpen) + '  ';
    const empty = stripped.slice(rootOpen + 1, rootClose).trim() === '';
    const body = pending
      .map((w) => {
        const value = w.kind === 'object' ? formatSettingObject(w.value as Record<string, string>, rootIndent) : JSON.stringify(w.value);
        return `"${w.key}": ${value}`;
      })
      .join(`,\n${rootIndent}`);
    if (empty) {
      edits.push({ start: rootClose, end: rootClose, text: `\n${rootIndent}${body}\n${indentOf(stripped, rootClose)}` });
    } else {
      // non-empty root: the separator goes right behind the LAST value token
      // (before any trailing line-end comment) and the entries take the
      // closer's own line when it has one — never a lone comma line above
      // the new keys nor `value}` glued together (review L2)
      const last = props[props.length - 1];
      if (!hadTrailingCommaFn(trailingCommas, rootClose)) {
        const tokenEnd = valueTokenEnd(stripped, last.value.start, last.value.end);
        edits.push({ start: tokenEnd, end: tokenEnd, text: ',' });
      }
      const closerLineStart = stripped.lastIndexOf('\n', rootClose - 1) + 1;
      if (/^[ \t]*$/.test(stripped.slice(closerLineStart, rootClose))) {
        edits.push({ start: closerLineStart, end: closerLineStart, text: `${rootIndent}${body}\n` });
      } else {
        edits.push({ start: rootClose, end: rootClose, text: `\n${rootIndent}${body}\n${indentOf(stripped, rootOpen)}` });
      }
    }
  }
  if (!edits.length) return 'unchanged';
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = raw;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return writeIfChanged(settingsFile, out) ? 'written' : 'unchanged';
}

/** plain (non-array) object test — `typeof [] === 'object'` would let an
 * array through every object guard (review H3) */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** end of the VALUE TOKEN inside a span that may include trailing
 * whitespace/comments (objectProps extends the LAST property's span to the
 * container's closer, and a comment before a comma is blanked to spaces on
 * the stripped view) — splicing the raw span would delete the user's
 * line-end comment. */
function valueTokenEnd(stripped: string, start: number, end: number): number {
  let i = end;
  while (i > start && /\s/.test(stripped[i - 1])) i--;
  return i;
}

/** managed-setting equality: scalars by identity, objects entry-wise — a
 * freshly built `{ ...existing }` literal is never `===` the parsed one, so
 * the identity test alone would rewrite an unchanged object every pass */
function sameSettingValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/** render a `kind: 'object'` value over several lines at the property's own
 * indent — the inserted body stays readable instead of one long line */
function formatSettingObject(value: Record<string, string>, indent: string): string {
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  const inner = indent + '  ';
  const lines = entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

/**
 * Add/update the MRVC configuration entry in one c_cpp_properties.json.
 * Plain-JSON files (and absent ones) are re-serialized whole — byte-stable
 * with what MRVC wrote before. Files carrying JSONC features (comments,
 * trailing commas, BOM) get a surgical splice of ONLY our entry: the strip
 * preserves offsets, so every user comment stays byte-for-byte. 'unreadable'
 * means the file cannot be understood and is never touched.
 */
function writePropsFile(propsFile: string, mine: Record<string, unknown>): PropsWrite {
  let raw: string;
  try {
    raw = fs.readFileSync(propsFile, 'utf-8');
  } catch {
    raw = ''; // absent — a fresh plain-JSON file is created below
  }
  const trailingCommas = new Map<number, number>();
  const stripped = stripJsonc(raw, trailingCommas);
  let parsed: Record<string, unknown> | undefined;
  if (raw !== '') {
    try {
      parsed = JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      return 'unreadable';
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unreadable';
  }
  if (raw === stripped) {
    const props = (parsed ?? {}) as { configurations?: Array<Record<string, unknown>>; [k: string]: unknown };
    if (!Array.isArray(props.configurations)) props.configurations = [];
    const idx = props.configurations.findIndex((c) => c && c.name === CONFIG_NAME);
    if (idx >= 0) {
      props.configurations[idx] = { ...props.configurations[idx], ...mine };
      // keys we retired must not survive the merge in already-written files
      // (cppCompilerPath: cpptools' schema rejects it)
      delete props.configurations[idx].cppCompilerPath;
    } else props.configurations.push(mine);
    // declare the schema version only when the user's file doesn't carry one
    if (props.version === undefined) props.version = 4;
    return writeIfChanged(propsFile, JSON.stringify(props, null, 2) + '\n') ? 'written' : 'unchanged';
  }

  // ---- JSONC path: splice only our entry into the original text ----
  const props = objectProps(stripped, trailingCommas);
  if (!props) return 'unreadable';
  const rootOpen = skipWs(stripped, 0);
  const rootClose = matchBracket(stripped, rootOpen);
  if (rootClose < 0) return 'unreadable';
  /** raw text carries a trailing comma whose OWN container closes at
   * `closer` — the raw file still HAS that comma, so adding our own
   * separator there would produce ", ," and an unparsable file. Matching
   * by closer (not by offset range) keeps a NESTED element's trailing
   * comma from suppressing the container's separator: `{"a": {"x": 1,}}`
   * needs a comma between its properties, only `{"a": {...},}` doesn't. */
  const hadTrailingComma = (closer: number): boolean => hadTrailingCommaFn(trailingCommas, closer);
  const rootIndent = indentOf(stripped, rootOpen) + '  ';
  const entryJson = JSON.stringify(mine, null, 2);
  const cfg = props.find((p) => p.key === 'configurations');
  if (cfg && stripped[cfg.value.start] !== '[') return 'unreadable';
  const hasVersion = props.some((p) => p.key === 'version');
  // edits never overlap; apply back-to-front so earlier offsets stay valid
  const edits: Array<{ start: number; end: number; text: string }> = [];

  if (cfg) {
    const cfgOpen = cfg.value.start;
    const cfgClose = matchBracket(stripped, cfgOpen);
    const spans = cfgClose >= 0 ? arrayElements(stripped, cfgOpen, trailingCommas) : null;
    if (!spans || cfgClose < 0) return 'unreadable';
    let replaced = false;
    for (const sp of spans) {
      let frag: Record<string, unknown>;
      try {
        frag = JSON.parse(stripped.slice(sp.start, sp.end)) as Record<string, unknown>;
      } catch {
        return 'unreadable';
      }
      if (!frag || frag.name !== CONFIG_NAME) continue;
      const merged = { ...frag, ...mine };
      // retired keys must not survive the merge in already-written entries
      // (cppCompilerPath: cpptools' schema rejects it)
      delete merged.cppCompilerPath;
      edits.push({
        start: sp.start,
        end: sp.end,
        text: reindent(JSON.stringify(merged, null, 2), indentOf(stripped, sp.start)),
      });
      replaced = true;
      break;
    }
    if (!replaced) {
      const ind = spans.length ? indentOf(stripped, spans[0].start) : rootIndent + '  ';
      const entryText = reindent(entryJson, ind);
      if (spans.length === 0) {
        const closeOwnLine = stripped.lastIndexOf('\n', cfgClose - 1) > cfgOpen;
        const fill = closeOwnLine ? `\n${ind}${entryText}\n${indentOf(stripped, cfgClose)}` : ` ${entryText} `;
        edits.push({ start: cfgOpen + 1, end: cfgClose, text: fill });
      } else {
        // insert before ']': a trailing comma already in the file separates
        const sep = hadTrailingComma(cfgClose) ? '' : ',';
        edits.push({ start: cfgClose, end: cfgClose, text: `${sep}\n${ind}${entryText}` });
      }
    }
    if (!hasVersion) edits.push({ start: rootOpen + 1, end: rootOpen + 1, text: `\n${rootIndent}"version": 4,` });
  } else {
    // no configurations property — append one (folding in version when also
    // missing, so both edits land as one insert and cannot collide). An
    // EMPTY root object (possibly comment-only or BOM-prefixed) has no
    // property to separate from: the leading comma would be the first
    // token and parse as `{,` — only add a separator after an existing
    // property, and only when the raw text doesn't already carry one.
    const sep = props.length === 0 ? '' : hadTrailingComma(rootClose) ? '' : ',';
    const verLine = hasVersion ? '' : `\n${rootIndent}"version": 4,`;
    const entryText = reindent(entryJson, rootIndent + '  ');
    const text = `${sep}${verLine}\n${rootIndent}"configurations": [\n${rootIndent}  ${entryText}\n${rootIndent}]`;
    edits.push({ start: rootClose, end: rootClose, text });
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = raw;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return writeIfChanged(propsFile, out) ? 'written' : 'unchanged';
}

export interface IntellisenseResult {
  projects: number;
  entries: number;
  updated: boolean;
  error?: string;
}

/** per-project database directory inside the workspace .vscode */
export function dbDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.vscode', 'mrvc', 'cc');
}

/** database file name: project name + path hash — project names repeat in
 * EVT trees, the absolute path is the disambiguator */
export function dbFileName(projectRoot: string, projectName: string): string {
  let h = 5381;
  const norm = foldPathOnPlatform(path.resolve(projectRoot));
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
  return `${projectName.replace(/[^\w.-]+/g, '_')}-${(h >>> 0).toString(16)}.json`;
}

/** the compile_commands.json cpptools actually reads */
/** merged shared-entries database (all projects' linked-folder files) */
export function sharedDbFile(workspaceRoot: string): string {
  return path.join(dbDir(workspaceRoot), '_shared.json');
}

/** compose a database path and prove it stays inside the cc directory —
 * dbFileName already sanitizes project names to [A-Za-z0-9_.-], this guard
 * keeps the containment invariant explicit before any disk access */
function ccDbPath(ccDir: string, fileName: string): string | null {
  const root = path.resolve(ccDir);
  const p = path.resolve(root, fileName);
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

/** fixed slot 2: the ACTIVE project's private entries — switching projects
 * copies a private database over this file (cpptools watches it and
 * re-parses just the changed database) */
export function activeCcFile(workspaceRoot: string): string {
  return path.join(dbDir(workspaceRoot), '_active.json');
}

/**
 * Switch the IntelliSense context: copy the project's own database over the
 * active compile_commands.json. cpptools watches that file and re-parses
 * with the project's macros/includes. Returns false when the file did not
 * change (same project re-selected) or the database is missing.
 */
export function switchContext(workspaceRoot: string, projectRoot: string, projectName: string): boolean {
  // copy the project's PRIVATE database over the _active.json slot — the
  // shared database (_shared.json) is declared separately in the
  // c_cpp_properties array and stays stable across context switches
  try {
    const realCcDir = resolveContainedMetaDir(workspaceRoot, ['.vscode', 'mrvc', 'cc'], false);
    if (!realCcDir) return false;
    const src = ccDbPath(realCcDir, dbFileName(projectRoot, projectName));
    const dst = ccDbPath(realCcDir, '_active.json');
    if (!src || !dst) return false;
    const srcInfo = assertContainedMetaFile(realCcDir, path.basename(src), true);
    if (!srcInfo.exists) return false;
    const dstInfo = assertContainedMetaFile(realCcDir, '_active.json', true);
    const content = fs.readFileSync(srcInfo.path, 'utf-8');
    return writeIfChanged(dstInfo.path, content);
  } catch {
    return false;
  }
}

/**
 * Which loaded project owns a file? Same rule the scanner uses: the file is
 * under the project root OR under one of its linked folders (shared SRC
 * trees legitimately belong to several projects — the caller decides which
 * one wins, e.g. first match).
 */
export function resolveProjectForFile(
  projects: Array<{ root: string; projectName: string; isOwner: (fsPath: string) => boolean }>,
  fsPath: string
): { root: string; projectName: string } | undefined {
  const norm = path.resolve(fsPath);
  return projects.find((p) => p.isOwner(norm));
}

const CPPTOLS_ID = 'ms-vscode.cpptools';
const CLANGD_ID = 'llvm-vs-code-extensions.vscode-clangd';
const CPPTOLS_MIN = [1, 23, 5]; // multi-database compileCommands needs >= 1.23.5

/**
 * One-shot guidance after projects load: code navigation (Go to Definition)
 * comes from the C/C++ extension consuming the databases MRVC generates —
 * without it the databases exist but nothing reads them (the exact
 * confusion reported on an offline machine, where an Extension Pack VSIX
 * was installed without its dependency). Skipped when the user picked
 * clangd instead, or after "Don't ask again" (globalState).
 */
export function maybePromptCppTools(context: vscode.ExtensionContext, store: ProjectStore): void {
  if (!store.all.length) return;
  if (context.globalState.get<boolean>('mrvc.cpptoolsDontAsk')) return;
  if (vscode.extensions.getExtension(CLANGD_ID)) return; // clangd route — not our business

  const ext = vscode.extensions.getExtension(CPPTOLS_ID);
  let message: string;
  if (!ext) {
    message = t('cpptoolsMissing');
  } else {
    const ver = String(ext.packageJSON?.version ?? '0');
    if (versionAtLeast(ver, CPPTOLS_MIN)) return; // installed and new enough
    message = t('cpptoolsTooOld', ver);
  }

  void vscode.window.showInformationMessage(message, t('installCpptools'), t('cpptoolsDontAsk')).then((pick) => {
    if (pick === t('installCpptools')) {
      // offline machines may not have a marketplace link — surface a clear
      // fallback instead of failing silently
      vscode.commands
        .executeCommand('extension.open', CPPTOLS_ID)
        .then(undefined, () => vscode.window.showErrorMessage(t('cpptoolsOpenFailed')));
    } else if (pick === t('cpptoolsDontAsk')) {
      void context.globalState.update('mrvc.cpptoolsDontAsk', true);
    }
  });
}

/** Rebuild and (conditionally) write the two .vscode files. Never throws. */
export function ensureIntellisenseConfig(store: ProjectStore): IntellisenseResult {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return { projects: 0, entries: 0, updated: false, error: 'no workspace folder' };
  try {
    const all = store.all;
    // nothing loaded (e.g. a generic Eclipse workspace activated us) — do
    // not pollute .vscode with an empty database and a bare MRVC entry
    if (!all.length) return { projects: 0, entries: 0, updated: false };
    resolveContainedMetaDir(folder.uri.fsPath, ['.vscode'], true);

    // 1. classify by cross-project reference count: _shared.json carries
    // every file exactly ONE project compiles (deterministic parameters —
    // browsable under any context); per-project databases carry the
    // multi-referenced files' per-project variants, each database padded
    // with canonical fallbacks so it covers the whole context class.
    // _active.json = the active context's database (copied on switch).
    const install = getInstall();
    const ccDir = resolveContainedMetaDir(folder.uri.fsPath, ['.vscode', 'mrvc', 'cc'], true)!;
    let firstTc: ToolchainInfo | null = null;
    let firstCp: Cproject | null = null;
    let entries = 0;
    let ccUpdated = false;
    const perProject: CompileCommandEntry[][] = [];
    const loaded: MrsProject[] = [];
    // projects whose toolchain did not resolve (or whose entries failed to
    // build): they contribute no entries, but their per-project database must
    // still be REWRITTEN — leaving the previous content on disk would feed a
    // stale database to cpptools forever (switchContext copies it verbatim
    // and nothing ever regenerates it). An empty own-entry list yields the
    // full canonical fallback database for the context class.
    const failed: MrsProject[] = [];
    // every include directory any project references — feeds the browse
    // fallback below so files OUTSIDE the compile databases (excluded from
    // build, not yet attached to a project) still resolve their #includes
    const includeDirs = new Set<string>();
    for (const p of all) {
      try {
        const tc = p.toolchain(install, 'auto');
        if (!tc) {
          failed.push(p);
          continue;
        }
        if (!firstTc) {
          firstTc = tc;
          firstCp = p.cproject;
        }
        const list = buildCompileEntries(p.cproject, tc);
        for (const e of list) {
          for (const a of e.arguments) {
            if (a.startsWith('-I') && a.length > 2) includeDirs.add(a.slice(2));
            else if (a.startsWith('-isystem') && a.length > 8) includeDirs.add(a.slice(8));
          }
        }
        entries += list.length;
        perProject.push(list);
        loaded.push(p);
      } catch {
        failed.push(p); // broken project must not block the rest
      }
    }
    const split = partitionByReference(perProject);
    // failed projects ride at the tail with an empty own-entry list — their
    // databases become pure canonical fallbacks (current, not stale)
    const databases = contextDatabases(
      [...split.contextEntries, ...failed.map(() => [] as CompileCommandEntry[])],
      [...loaded.map((p) => p.root), ...failed.map((p) => p.root)]
    );
    [...loaded, ...failed].forEach((p, i) => {
      const dbFile = ccDbPath(ccDir, dbFileName(p.root, p.projectName));
      if (dbFile && writeIfChanged(dbFile, JSON.stringify(databases[i], null, 2) + '\n')) ccUpdated = true;
    });
    if (writeIfChanged(sharedDbFile(folder.uri.fsPath), JSON.stringify(split.sharedEntries, null, 2) + '\n')) ccUpdated = true;
    const activeFile = activeCcFile(folder.uri.fsPath);
    // every generated database covers the same context-class file set — a
    // valid _active.json (the current OR one written before a parameter-
    // only change) matches that set; anything else (older MRVC layouts,
    // hand edits, a changed file set) is re-seeded from the active/first
    // project's database.
    const contextKeys = new Set((databases[0] ?? []).map((e) => foldPathOnPlatform(e.file)));
    const seedActive = (): void => {
      const seed = loaded.find((p) => p === store.active) ?? loaded[0];
      if (!seed) return;
      const src = ccDbPath(ccDir, dbFileName(seed.root, seed.projectName));
      if (!src) return;
      try {
        fs.copyFileSync(src, activeFile);
      } catch {
        // seed is best-effort; the tree watcher fills it on first selection
      }
    };
    if (!fs.existsSync(activeFile)) {
      seedActive();
    } else {
      try {
        const cur = JSON.parse(fs.readFileSync(activeFile, 'utf-8')) as Array<{ file: string }>;
        const sameShape = cur.length === contextKeys.size && cur.every((e) => contextKeys.has(foldPathOnPlatform(path.resolve(e.file))));
        if (!sameShape) seedActive();
      } catch {
        seedActive(); // unparsable content — reseed
      }
    }

    // 2. c_cpp_properties.json — add/update only OUR configuration entry,
    // leaving any user-defined configurations AND their comments untouched
    // (writePropsFile). EVERY workspace folder gets one: cpptools resolves
    // IntelliSense per root, so files edited under folder[2] of a multi-root
    // workspace must find the databases too — those entries point at the
    // primary folder's .vscode/mrvc/cc with absolute paths.
    let propsUpdated = false;
    const unreadableFolders: string[] = [];
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const isPrimary = foldPathOnPlatform(wf.uri.fsPath) === foldPathOnPlatform(folder.uri.fsPath);
      const mine: Record<string, unknown> = {
        name: CONFIG_NAME,
        compileCommands: isPrimary
          ? ['${workspaceFolder}/.vscode/mrvc/cc/_shared.json', '${workspaceFolder}/.vscode/mrvc/cc/_active.json']
          : [sharedDbFile(folder.uri.fsPath), activeCcFile(folder.uri.fsPath)],
        // browse fallback for files no compile database covers (cpptools logs
        // a "not found in compile_commands.json" warning for those and falls
        // back to includePath — keep that fallback useful): everything inside
        // the workspace recursively plus every absolute include dir referenced
        // by any project (linked trees can live outside the workspace folder)
        includePath: ['${workspaceFolder}/**', ...[...includeDirs].sort()],
        intelliSenseMode: 'gcc-x64',
      };
      if (firstTc) {
        // the real on-disk spelling: cpptools stats compilerPath, and on
        // Windows the manifest's bare name has no file behind it (only
        // name.exe does) — round13 §4.4 / round14 §2.4
        mine.compilerPath = withRealSuffix(firstTc.compilerC);
        // no cppCompilerPath: cpptools' c_cpp_properties schema rejects that
        // property and flags it in the Problems panel — compilerPath serves
        // both C and C++
      }
      if (firstCp) {
        // cpptools accepts c99/c11/c17/c23 and gnu* variants; exotic CDT
        // names (ansi, iso9899:199409) fall back to gnu11 instead of an
        // invalid value cpptools would reject
        const std = firstCp.languageStandard;
        mine.cStandard = /^(c|gnu)(9[09]|1[178]|2[03])$/.test(std) ? std : 'gnu11';
        mine.cppStandard = 'gnu++14';
      }
      try {
        const wfVscodeDir = resolveContainedMetaDir(wf.uri.fsPath, ['.vscode'], true)!;
        const propsInfo = assertContainedMetaFile(wfVscodeDir, 'c_cpp_properties.json', true);
        const r = writePropsFile(propsInfo.path, mine);
        if (r === 'written') propsUpdated = true;
        else if (r === 'unreadable') unreadableFolders.push(wf.name);
      } catch {
        unreadableFolders.push(wf.name);
      }
    }

    // 3. the cache overrides: when configured, MRVC writes
    // C_Cpp.intelliSenseCachePath (from mrvc.intellisense.cachePath) and
    // C_Cpp.intelliSenseCacheSize (from mrvc.intellisense.cacheSize, MB)
    // into each workspace folder's .vscode/settings.json (a workspace value
    // beats the user-level one), so the ipch cache lands on a chosen drive
    // with a chosen cap instead of filling C:. Per-key opt-out: an EMPTY
    // path setting skips the path key, a 0 size setting skips the size key —
    // the OTHER key is still written (round24 §5.2 wording).
    const cacheOverrides = applyCacheOverrides();
    // every problem AT ONCE (round31 §3.3): a user shouldn't have to fix
    // one and re-run to discover the next — the reported error is a
    // multi-line list of everything that went wrong in this pass
    const problems: string[] = [];
    if (cacheOverrides.invalidSettings.length) {
      problems.push(t('invalidCacheSettings', cacheOverrides.invalidSettings.join('; ')));
    }
    if (unreadableFolders.length) {
      problems.push(t('cppPropertiesUnreadable', unreadableFolders.join(', ')));
    }
    if (cacheOverrides.unreadable.length) {
      problems.push(t('cacheSettingsUnreadable', cacheOverrides.unreadable.join(', ')));
    }
    if (problems.length) {
      return {
        projects: all.length,
        entries,
        updated: ccUpdated || propsUpdated,
        error: problems.join('\n'),
      };
    }

    return { projects: all.length, entries, updated: ccUpdated || propsUpdated };
  } catch (e) {
    return { projects: 0, entries: 0, updated: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface CacheOverridesResult {
  /** workspace folders whose settings.json could not be parsed */
  unreadable: string[];
  /** settings whose hand-edited value had the wrong runtime type — skipped,
   *  surfaced so the user learns WHY a key was not written */
  invalidSettings: string[];
}

/**
 * The cache overrides ALONE (round23 §5.4): writing the two workspace
 * settings keys needs no project scan, no toolchain resolution and no
 * database rebuild — a cheap entry for the settings-change listener (a full
 * ensureIntellisenseConfig on a big EVT workspace would stall the host just
 * because the user edited a cache setting). Runtime-typed (round24 §5.1 /
 * round25 §5.1): a hand-edited non-string path or non-number size is
 * skipped and REPORTED via invalidSettings instead of throwing inside the
 * configuration listener.
 */
export function applyCacheOverrides(): CacheOverridesResult {
  const writes: WorkspaceSettingWrite[] = [];
  const invalidSettings: string[] = [];
  // runtime types: get<T> is a compile-time assertion only — a hand-edited
  // settings value can be anything
  const rawPath = vscode.workspace.getConfiguration('mrvc').get<unknown>('intellisense.cachePath', '');
  // v0.3.8 user ruling: cache governance is GATED by cachePath — with no
  // path configured NOTHING is written. The old behavior let the size key
  // ride alone, so the schema default (5120) landed uninvited in every
  // workspace's settings.json at activation. cacheSize only takes effect
  // once a cachePath is set.
  if (rawPath === undefined || rawPath === null || (typeof rawPath === 'string' && rawPath.trim() === '')) {
    return { unreadable: [], invalidSettings: [] };
  }
  if (typeof rawPath !== 'string') {
    // present but the wrong type: reported so the user can fix it — still
    // nothing written (a size-only write was the old standalone shape)
    return { unreadable: [], invalidSettings: ['mrvc.intellisense.cachePath: not a string (skipped)'] };
  }
  const t = rawPath.trim();
  if (t) writes.push({ key: CACHE_PATH_KEY, value: t, kind: 'string' });
  const rawSize = vscode.workspace.getConfiguration('mrvc').get<unknown>('intellisense.cacheSize', 0);
  if (typeof rawSize === 'number' && Number.isFinite(rawSize) && rawSize > 0) {
    // round26 §4.1: a fractional MB would floor to 0 (= "no cap" for
    // cpptools) — reject non-integers instead of writing a silent 0
    if (!Number.isInteger(rawSize)) {
      invalidSettings.push(`mrvc.intellisense.cacheSize: ${rawSize} is not a whole number of MB (skipped)`);
    } else {
      writes.push({ key: CACHE_SIZE_KEY, value: rawSize, kind: 'number' });
    }
  } else if (typeof rawSize === 'number' && rawSize < 0) {
    // round28 §3.2: a NEGATIVE value is reported (0 stays the silent opt-out)
    invalidSettings.push(`mrvc.intellisense.cacheSize: ${rawSize} MB is not a positive cap (skipped)`);
  } else if (rawSize !== undefined && rawSize !== null && rawSize !== 0 && typeof rawSize !== 'number') {
    invalidSettings.push('mrvc.intellisense.cacheSize: not a number (skipped)');
  }
  const unreadable: string[] = [];
  if (!writes.length) return { unreadable, invalidSettings };
  for (const wf of vscode.workspace.workspaceFolders ?? []) {
    try {
      const wfVscode = resolveContainedMetaDir(wf.uri.fsPath, ['.vscode'], true)!;
      const settingsInfo = assertContainedMetaFile(wfVscode, 'settings.json', true);
      const r = writeWorkspaceCacheSettings(settingsInfo.path, writes);
      if (r === 'unreadable') unreadable.push(wf.name);
    } catch {
      unreadable.push(wf.name);
    }
  }
  return { unreadable, invalidSettings };
}
