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

  const { rootTokens, dirTokens } = exclusionTokens(cp);

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
    // link's own name are "don't double-scan" markers, not content filters
    // (folded compare: some projects spell the marker with mismatched case)
    const tokens = [...rootTokens.filter((t) => fold(t) !== fold(name)), ...(dirTokens.get(name) ?? [])];
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
        if (fold(logic + '/').startsWith(fold(base)) && isExcluded(logic.slice(base.length), toks)) {
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

/**
 * CDT excluding semantics: token is a '/'-separated path or bare name.
 * Case-insensitive on Windows: EVT tokens sometimes differ in case from the
 * on-disk names (ch58x_led.c token vs CH58x_led.c file) while the fs — and
 * therefore MRS2's notion of "same file" — is case-insensitive there.
 */
const CASE_FOLD = process.platform === 'win32';
const fold = (s: string): string => (CASE_FOLD ? s.toLowerCase() : s);

/** linked-folder location by (case-insensitively) matching logic name */
function findLink(cp: Cproject, name: string): string | undefined {
  for (const [key, loc] of cp.linkedFolders) {
    if (fold(key) === fold(name)) return loc;
  }
  return undefined;
}

function isExcluded(relPosix: string, tokens: string[]): boolean {
  const hay = fold(relPosix);
  for (const t of tokens) {
    if (!t) continue;
    const tok = fold(t);
    if (hay === tok || hay.startsWith(tok + '/') || hay.endsWith('/' + tok)) {
      return true;
    }
  }
  return false;
}

export interface ExclusionTokens {
  /** tokens from the root entry (name=""), project-root relative */
  rootTokens: string[];
  /** tokens per named entry, relative to that folder */
  dirTokens: Map<string, string[]>;
}

export function exclusionTokens(cp: Cproject): ExclusionTokens {
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
  return { rootTokens, dirTokens };
}

/**
 * Would the given logic path (project-root relative, linked folders rooted
 * at their link name) be skipped by scanSources? Mirrors the token
 * application in scanSources/walk exactly — used by the UI to show and
 * toggle the Exclude From Build state.
 */
export function isLogicExcluded(cp: Cproject, logic: string): boolean {
  const { rootTokens, dirTokens } = exclusionTokens(cp);
  const top = logic.includes('/') ? logic.slice(0, logic.indexOf('/')) : logic;
  if (logic === top) {
    // the top-level resource itself: only root-walk tokens apply
    return isExcluded(logic, rootTokens);
  }
  const rel = logic.slice(top.length + 1);
  if (cp.linkedFolders.has(top)) {
    // linked walks ignore root tokens equal to the link's own name
    // ("don't double-scan" markers, folded compare) and carry their named
    // entry tokens
    const tokens = [...rootTokens.filter((t) => fold(t) !== fold(top)), ...(dirTokens.get(top) ?? [])];
    return isExcluded(rel, tokens) || isExcluded(logic, tokens);
  }
  if (dirTokens.has(top) && fs.existsSync(path.join(cp.projectRoot, top))) {
    // real folder with its own named entry: root tokens apply project-wide
    // (walk 1), the named entry's tokens apply inside the folder
    const toks = dirTokens.get(top)!;
    return isExcluded(logic, rootTokens) || isExcluded(rel, toks) || isExcluded(logic, toks);
  }
  return isExcluded(logic, rootTokens);
}

/**
 * Map every exclusion token of a project back to a filesystem path so the
 * tree can decorate it. Full-path tokens map directly; a bare-name root
 * token that names content of a linked folder (CH585 legacy style, e.g.
 * `CH58x_usbhostClass.c` with no folder prefix) is resolved by scanning one
 * level of every linked folder — the same per-link matching the scanner
 * applies, so every location the scanner would exclude gets decorated.
 * "Don't double-scan" markers (token == a link's own name) are skipped.
 */
export function exclusionFsPaths(cp: Cproject, projectRoot: string): string[] {
  const out: string[] = [];
  const bare: string[] = [];
  for (const entry of cp.sourceEntries) {
    for (const tok of entry.excluding) {
      const segs = tok.split('/');
      if (entry.name === '') {
        // folded lookup: markers sometimes spell the link name with
        // mismatched case (see the marker filter in scanSources)
        const linkLoc = findLink(cp, segs[0]);
        if (linkLoc) {
          if (segs.length === 1) continue; // marker, not an exclusion
          out.push(path.join(linkLoc, ...segs.slice(1)));
        } else {
          out.push(path.join(projectRoot, ...segs));
          if (segs.length === 1) bare.push(tok); // may also name linked content
        }
      } else {
        const base = findLink(cp, entry.name) ?? path.join(projectRoot, entry.name);
        out.push(path.join(base, ...segs));
      }
    }
  }
  for (const tok of bare) {
    for (const loc of cp.linkedFolders.values()) {
      let names: string[];
      try {
        names = fs.readdirSync(loc);
      } catch {
        continue;
      }
      for (const name of names) {
        if (fold(name) === fold(tok)) {
          out.push(path.join(loc, name));
        }
      }
    }
  }
  return out;
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
