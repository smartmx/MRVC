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
import { ProjectStore, getInstall } from './projects';
import { Cproject } from '../core/cproject';
import { ToolchainInfo } from '../core/toolchain';
import { buildCompileEntries, mergeSharedEntries, CompileCommandEntry } from '../core/intellisense';

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
  const src = path.join(dbDir(workspaceRoot), dbFileName(projectRoot, projectName));
  const dst = activeCcFile(workspaceRoot);
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

    // 1. per-project PRIVATE databases (.vscode/mrvc/cc/<name>-<hash>.json,
    // files physically inside the project root) + ONE merged SHARED database
    // (_shared.json, files reached through linked folders — the shared SRC
    // tree). Switching projects swaps only the private part in the active
    // compile_commands.json; the shared part never changes.
    const install = getInstall();
    const ccDir = dbDir(folder.uri.fsPath);
    fs.mkdirSync(ccDir, { recursive: true });
    let firstTc: ToolchainInfo | null = null;
    let firstCp: Cproject | null = null;
    let entries = 0;
    let ccUpdated = false;
    const sharedPerProject: CompileCommandEntry[][] = [];
    for (const p of all) {
      try {
        const tc = p.toolchain(install, 'auto');
        if (!tc) continue;
        if (!firstTc) {
          firstTc = tc;
          firstCp = p.cproject;
        }
        const split = buildCompileEntries(p.cproject, tc);
        entries += split.privateEntries.length + split.sharedEntries.length;
        sharedPerProject.push(split.sharedEntries);
        if (writeIfChanged(path.join(ccDir, dbFileName(p.root, p.projectName)), JSON.stringify(split.privateEntries, null, 2) + '\n')) ccUpdated = true;
      } catch {
        // broken project must not block the rest
      }
    }
    if (writeIfChanged(sharedDbFile(folder.uri.fsPath), JSON.stringify(mergeSharedEntries(sharedPerProject), null, 2) + '\n')) ccUpdated = true;
    const activeFile = activeCcFile(folder.uri.fsPath);
    // seed the active slot with the active/first project's private database
    // when missing (subsequent context switches are plain copies of one of
    // the private databases). A stale _active.json from an older MRVC layout
    // (a merged private+shared composition) is re-seeded once — its content
    // differs from any pure private database.
    const seedActive = (): void => {
      const seed = all.find((p) => p === store.active) ?? all[0];
      try {
        fs.copyFileSync(path.join(ccDir, dbFileName(seed.root, seed.projectName)), activeFile);
      } catch {
        // seed is best-effort; the tree watcher fills it on first selection
      }
    };
    if (!fs.existsSync(activeFile)) {
      seedActive();
    } else {
      try {
        // any shared entry means the file is an old merged composition —
        // private-only content (new layout) must be re-seeded
        const cur = JSON.parse(fs.readFileSync(activeFile, 'utf-8')) as Array<{ file: string }>;
        const sharedMerged = mergeSharedEntries(sharedPerProject);
        const sharedFiles = new Set(sharedMerged.map((e) => e.file));
        // only reseed when we actually HAVE shared content — an empty merged
        // block (no projects scanned yet) must not wipe the active file
        if (sharedFiles.size && cur.some((e) => sharedFiles.has(path.resolve(e.file)))) {
          seedActive();
        }
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
