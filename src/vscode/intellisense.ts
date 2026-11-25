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
import { t } from '../core/i18n';
import {
  stripJsonc,
  matchBracket,
  skipWs,
  indentOf,
  reindent,
  objectProps,
  arrayElements,
  hadTrailingCommaFn,
} from '../core/jsonc';

const CONFIG_NAME = 'MRVC';

function writeIfChanged(file: string, content: string): boolean {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === content) return false;
  } catch {
    // fall through to write
  }
  fs.writeFileSync(file, content, 'utf-8');
  return true;
}

type PropsWrite = 'written' | 'unchanged' | 'unreadable';

const CACHE_PATH_KEY = 'C_Cpp.intelliSenseCachePath';
const CACHE_SIZE_KEY = 'C_Cpp.intelliSenseCacheSize';

/** one workspace-settings key MRVC manages: the value plus the type a hand
 *  edit must keep (a path stays a string, a size stays a number) */
interface WorkspaceSettingWrite {
  key: string;
  value: string | number;
  kind: 'string' | 'number';
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
function writeWorkspaceCacheSettings(settingsFile: string, writes: WorkspaceSettingWrite[]): PropsWrite {
  let raw: string;
  try {
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unreadable';
  }
  if (raw === stripped) {
    const settings = (parsed ?? {}) as Record<string, unknown>;
    for (const w of writes) {
      const existing = settings[w.key];
      if (existing !== undefined && existing !== null && typeof existing !== w.kind) return 'unreadable';
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
    if (mine) {
      let frag: unknown;
      try {
        frag = JSON.parse(stripped.slice(mine.value.start, mine.value.end));
      } catch {
        return 'unreadable';
      }
      if (frag !== null && typeof frag !== w.kind) return 'unreadable'; // hand edit — never touch
      if (frag === w.value) continue; // already the desired value
      edits.push({ start: mine.value.start, end: mine.value.end, text: JSON.stringify(w.value) });
    } else {
      pending.push(w);
    }
  }
  if (pending.length) {
    const rootIndent = indentOf(stripped, rootOpen) + '  ';
    const empty = stripped.slice(rootOpen + 1, rootClose).trim() === '';
    const sep = props.length === 0 || hadTrailingCommaFn(trailingCommas, rootClose) ? '' : ',';
    const body = pending.map((w) => `"${w.key}": ${JSON.stringify(w.value)}`).join(`,\n${rootIndent}`);
    const text = empty
      ? `\n${rootIndent}${body}\n${indentOf(stripped, rootClose)}`
      : `${sep}\n${rootIndent}${body}`;
    edits.push({ start: rootClose, end: rootClose, text });
  }
  if (!edits.length) return 'unchanged';
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = raw;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return writeIfChanged(settingsFile, out) ? 'written' : 'unchanged';
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
  const dir = dbDir(workspaceRoot);
  const src = ccDbPath(dir, dbFileName(projectRoot, projectName));
  const dst = ccDbPath(dir, '_active.json');
  if (!src || !dst) return false;
  try {
    if (!fs.existsSync(src)) return false;
    const content = fs.readFileSync(src, 'utf-8');
    try {
      if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf-8') === content) return false;
    } catch {
      // fall through to copy
    }
    fs.copyFileSync(src, dst);
    return true;
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
  const vscodeDir = path.join(folder.uri.fsPath, '.vscode');
  try {
    const all = store.all;
    // nothing loaded (e.g. a generic Eclipse workspace activated us) — do
    // not pollute .vscode with an empty database and a bare MRVC entry
    if (!all.length) return { projects: 0, entries: 0, updated: false };
    fs.mkdirSync(vscodeDir, { recursive: true });

    // 1. classify by cross-project reference count: _shared.json carries
    // every file exactly ONE project compiles (deterministic parameters —
    // browsable under any context); per-project databases carry the
    // multi-referenced files' per-project variants, each database padded
    // with canonical fallbacks so it covers the whole context class.
    // _active.json = the active context's database (copied on switch).
    const install = getInstall();
    const ccDir = dbDir(folder.uri.fsPath);
    fs.mkdirSync(ccDir, { recursive: true });
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
        const wfVscodeDir = path.join(wf.uri.fsPath, '.vscode');
        fs.mkdirSync(wfVscodeDir, { recursive: true });
        const r = writePropsFile(path.join(wfVscodeDir, 'c_cpp_properties.json'), mine);
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
  if (rawPath === undefined || rawPath === null || rawPath === '') {
    // not configured — the path key is simply not written
  } else if (typeof rawPath === 'string') {
    const t = rawPath.trim();
    if (t) writes.push({ key: CACHE_PATH_KEY, value: t, kind: 'string' });
  } else {
    invalidSettings.push('mrvc.intellisense.cachePath: not a string (skipped)');
  }
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
      fs.mkdirSync(path.join(wf.uri.fsPath, '.vscode'), { recursive: true });
      const r = writeWorkspaceCacheSettings(path.join(wf.uri.fsPath, '.vscode', 'settings.json'), writes);
      if (r === 'unreadable') unreadable.push(wf.name);
    } catch {
      unreadable.push(wf.name);
    }
  }
  return { unreadable, invalidSettings };
}
