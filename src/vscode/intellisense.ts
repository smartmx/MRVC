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
import { Cproject } from '../core/cproject';
import { ToolchainInfo } from '../core/toolchain';
import { buildCompileEntries, partitionByReference, contextDatabases, CompileCommandEntry } from '../core/intellisense';
import { t } from '../core/i18n';

const CONFIG_NAME = 'MRVC';

type JsonRead = Record<string, unknown> | null | undefined;

function readJson(file: string): JsonRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null; // file absent
  }
  try {
    return JSON.parse(raw);
  } catch {
    // cpptools' c_cpp_properties.json is JSONC (comments / trailing commas
    // are officially allowed) — strip them and retry; still unparsable =>
    // "unreadable" sentinel: the file must NEVER be overwritten by us
    try {
      const stripped = raw
        .replace(/^\uFEFF/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(stripped);
    } catch {
      return undefined;
    }
  }
}

function writeIfChanged(file: string, content: string): boolean {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === content) return false;
  } catch {
    // fall through to write
  }
  fs.writeFileSync(file, content, 'utf-8');
  return true;
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
  const norm = path.resolve(projectRoot).toLowerCase();
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
const CLANGD_ID = 'llvm-vscode-extensions.vscode-clangd';
const CPPTOLS_MIN = [1, 23, 5]; // multi-database compileCommands needs >= 1.23.5

function versionAtLeast(v: string, min: number[]): boolean {
  const parts = v.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    if (a !== min[i]) return a > min[i];
  }
  return true;
}

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
  if (context.globalState.get<boolean>('mrs2.cpptoolsDontAsk')) return;
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
      void vscode.commands.executeCommand('extension.open', CPPTOLS_ID);
    } else if (pick === t('cpptoolsDontAsk')) {
      void context.globalState.update('mrs2.cpptoolsDontAsk', true);
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
    const contextKeys = new Set((databases[0] ?? []).map((e) => e.file.toLowerCase()));
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
        const sameShape = cur.length === contextKeys.size && cur.every((e) => contextKeys.has(path.resolve(e.file).toLowerCase()));
        if (!sameShape) seedActive();
      } catch {
        seedActive(); // unparsable content — reseed
      }
    }

    // 2. c_cpp_properties.json — add/update only OUR configuration entry,
    // leaving any user-defined configurations untouched
    const propsFile = path.join(vscodeDir, 'c_cpp_properties.json');
    const parsed = readJson(propsFile);
    if (parsed === undefined) {
      // user file exists but we cannot parse it even as JSONC — leave it
      // completely untouched rather than risk destroying their configs
      return { projects: all.length, entries, updated: ccUpdated, error: 'c_cpp_properties.json unreadable — left untouched' };
    }
    const props = (parsed ?? {}) as { configurations?: Array<Record<string, unknown>>; [k: string]: unknown };
    if (!Array.isArray(props.configurations)) props.configurations = [];
    const mine: Record<string, unknown> = {
      name: CONFIG_NAME,
      compileCommands: [
        '${workspaceFolder}/.vscode/mrvc/cc/_shared.json',
        '${workspaceFolder}/.vscode/mrvc/cc/_active.json',
      ],
      // browse fallback for files no compile database covers (cpptools logs
      // a "not found in compile_commands.json" warning for those and falls
      // back to includePath — keep that fallback useful): everything inside
      // the workspace recursively plus every absolute include dir referenced
      // by any project (linked trees can live outside the workspace folder)
      includePath: ['${workspaceFolder}/**', ...[...includeDirs].sort()],
      intelliSenseMode: 'gcc-x64',
    };
    if (firstTc) {
      mine.compilerPath = firstTc.compilerC;
      mine.cppCompilerPath = firstTc.compilerCpp;
    }
    if (firstCp) {
      // cpptools accepts c99/c11/c17/c23 and gnu* variants; exotic CDT
      // names (ansi, iso9899:199409) fall back to gnu11 instead of an
      // invalid value cpptools would reject
      const std = firstCp.languageStandard;
      mine.cStandard = /^(c|gnu)(9[09]|1[178]|2[03])$/.test(std) ? std : 'gnu11';
      mine.cppStandard = 'gnu++14';
    }
    const idx = props.configurations.findIndex((c) => c && c.name === CONFIG_NAME);
    if (idx >= 0) props.configurations[idx] = { ...props.configurations[idx], ...mine };
    else props.configurations.push(mine);
    // declare the schema version only when the user's file doesn't carry one
    if (props.version === undefined) props.version = 4;
    const propsUpdated = writeIfChanged(propsFile, JSON.stringify(props, null, 2) + '\n');

    return { projects: all.length, entries, updated: ccUpdated || propsUpdated };
  } catch (e) {
    return { projects: 0, entries: 0, updated: false, error: e instanceof Error ? e.message : String(e) };
  }
}
