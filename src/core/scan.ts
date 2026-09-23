/**
 * Source-file scanner: reproduces the logic->file mapping MRS builds use.
 * Walks the real project tree plus linked folders, honours sourceEntries
 * (including `excluding` lists), and returns files grouped per logic dir.
 * Pure Node — no vscode imports.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Cproject } from './cproject';
import { toPosix } from './macros';

export const C_SOURCE_EXTS = ['c', 's', 'S'];
export const CPP_SOURCE_EXTS = ['c', 's', 'S', 'cpp', 'C', 'cc', 'cxx'];

export interface LogicFile {
  /** path relative to project root (or linked-name rooted), posix separators */
  logicName: string;
  /** absolute path, posix separators */
  fullpath: string;
  isC: boolean; // false => C++
}

export type LogicDirMap = Map<string, LogicFile[]>; // key: logic dir ('' = root)

const SKIP_DIRS = new Set(['.settings', '.vscode', '.mrs', 'CMakeFiles']);

export function isSourceFile(exts: string[], name: string): boolean {
  return exts.some((e) => name.endsWith('.' + e));
}

/**
 * Build the logic dir -> files map for a project.
 * MRS semantics (getLogicDirFilesMap): walk the real project tree AND every
 * linked folder; CDT sourceEntries contribute `excluding` filters only
 * (root entry -> project-wide tokens, named entries -> tokens relative to
 * that folder). Linked folders are always scanned, whether or not they have
 * their own sourceEntry.
 */
export function scanSources(cp: Cproject): LogicDirMap {
  const isCpp = cp.isCpp;
  const exts = isCpp ? CPP_SOURCE_EXTS : C_SOURCE_EXTS;
  const result: LogicDirMap = new Map();
  const configNames = new Set<string>([cp.configName]);

  // exclusion tokens: root-level (relative to project root) and per-folder
  const rootTokens: string[] = [];
  const dirTokens = new Map<string, string[]>();
  for (const entry of cp.sourceEntries) {
    if (!entry.excluding.length) continue;
    if (entry.name === '') {
      rootTokens.push(...entry.excluding);
    } else {
      const prev = dirTokens.get(entry.name) ?? [];
      dirTokens.set(entry.name, [...prev, ...entry.excluding]);
    }
  }

  const addFile = (logicName: string, fullpath: string) => {
    const dir = path.posix.dirname(toPosix(logicName));
    const key = dir === '.' ? '' : dir;
    if (!result.has(key)) result.set(key, []);
    const arr = result.get(key)!;
    const l = toPosix(logicName);
    if (arr.some((f) => f.logicName === l)) return; // dedupe (named entry under root)
    arr.push({
      logicName: l,
      fullpath: toPosix(fullpath),
      isC: !isCpp || nameExt(logicName).isC,
    });
  };

  // real-folder entries contribute excluding tokens that prune inside the
  // root walk (e.g. BLE_UART excludes two of three service variants under
  // its real APP/ folder); linked walks carry their own tokens
  const logicBases: Array<[string, string[]]> = [];
  for (const [dirName, toks] of dirTokens) {
    if (!cp.linkedFolders.has(dirName) && fs.existsSync(path.join(cp.projectRoot, dirName))) {
      logicBases.push([dirName + '/', toks]);
    }
  }

  // 1. real project tree (root entry tokens apply project-wide)
  walk(cp.projectRoot, cp.projectRoot, '', rootTokens, configNames, exts, addFile, logicBases);

  // 1.5 real-folder named entries re-scan their subtree: a root entry that
  // excludes the folder (CH32V307 RT-Thread excludes 'Core') relies on the
  // named entry to add it back; addFile dedupes when it wasn't excluded
  for (const entry of cp.sourceEntries) {
    if (entry.name === '' || cp.linkedFolders.has(entry.name)) continue;
    const dir = path.join(cp.projectRoot, entry.name);
    if (!fs.existsSync(dir)) continue; // linked/implicit handled in step 2
    walk(dir, dir, entry.name, entry.excluding, configNames, exts, addFile, []);
  }

  // 2. linked folders, always scanned (MRS scans basic.linkedFolders)
  for (const [name, target] of cp.linkedFolders) {
    if (!fs.existsSync(target)) continue;
    // tokens may be written relative to the linked folder itself (bare file
    // names) or relative to the project root (StdPeriphDriver/CH58x_x.c) —
    // walk() matches both via the logic path. Root tokens that are just the
    // link's own name are "don't double-scan" markers, not content filters.
    const tokens = [...rootTokens.filter((t) => t !== name), ...(dirTokens.get(name) ?? [])];
    walk(target, target, name, tokens, configNames, exts, addFile, []);
  }

  // deterministic ordering: files by logicName
  for (const files of result.values()) {
    files.sort((a, b) => (a.logicName < b.logicName ? -1 : a.logicName > b.logicName ? 1 : 0));
  }
  return result;
}

function nameExt(logicName: string): { ext: string; isC: boolean } {
  const base = path.posix.basename(logicName);
  const dot = base.lastIndexOf('.');
  const ext = dot < 0 ? '' : base.slice(dot + 1);
  return { ext, isC: ext !== 'cpp' && ext !== 'cc' && ext !== 'cxx' && ext !== 'C' };
}

function walk(
  fsRoot: string,
  dir: string,
  logicPrefix: string,
  excluded: string[],
  configNames: Set<string>,
  exts: string[],
  add: (logicName: string, fullpath: string) => void,
  logicBases: Array<[string, string[]]> = []
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const logic = logicPrefix ? `${logicPrefix}/${ent.name}` : ent.name;
    const relPosix = toPosix(path.relative(fsRoot, full));
    // excluding tokens may be written relative to the walk root (bare file
    // names, LED-style) or relative to the project root via the logic path
    // (StdPeriphDriver/CH58x_usbhostClass.c, CH587 EVT style); real-folder
    // entry tokens apply below that folder's logic prefix (BLE_UART APP)
    let excludedHere = isExcluded(relPosix, excluded) || isExcluded(logic, excluded);
    if (!excludedHere) {
      for (const [base, toks] of logicBases) {
        if ((logic + '/').startsWith(base) && isExcluded(logic.slice(base.length), toks)) {
          excludedHere = true;
          break;
        }
      }
    }
    if (excludedHere) continue;
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name) || configNames.has(ent.name)) continue;
      walk(fsRoot, full, logic, excluded, configNames, exts, add, logicBases);
    } else if (ent.isFile()) {
      if (!isSourceFile(exts, ent.name)) continue;
      add(logic, full);
    }
  }
}

/** CDT excluding semantics: token is a '/'-separated path or bare name. */
function isExcluded(relPosix: string, tokens: string[]): boolean {
  for (const t of tokens) {
    if (!t) continue;
    if (relPosix === t || relPosix.startsWith(t + '/') || relPosix.endsWith('/' + t)) {
      return true;
    }
  }
  return false;
}

/** Source-file extension groups used in makefile fragments. */
export interface ExtGroup {
  ext: string; // c | s | S (| cpp ...)
  variable: string; // C | S | S_UPPER (| CPP ...)
  isAsm: boolean;
  isCppFile: boolean;
}

export function extGroups(isCpp: boolean): ExtGroup[] {
  const exts = isCpp ? CPP_SOURCE_EXTS : C_SOURCE_EXTS;
  return exts.map((ext) => {
    const isUpper = ext === ext.toUpperCase();
    const variable = isUpper ? `${ext}_UPPER` : ext.toUpperCase();
    return {
      ext,
      variable,
      isAsm: ext === 's' || ext === 'S',
      isCppFile: ext === 'cpp' || ext === 'C' || ext === 'cc' || ext === 'cxx',
    };
  });
}
