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
import { listRemovedResources, unscannableLinkedTarget, readProjectFile, assertSafeLinkTarget } from './projectFile';

export const C_SOURCE_EXTS = ['c', 's', 'S'];
export const CPP_SOURCE_EXTS = ['c', 's', 'S', 'cpp', 'C', 'cc', 'cxx'];

/** brace-glob covering EVERY source extension the scanner accepts plus the
 *  headers the tree lists. The file watchers must not cover fewer kinds
 *  than `classifySourceExt()` — round53 P3-1: a hand-written glob missed
 *  .cc/.cxx/.C, so new files of those kinds never refreshed the tree; the
 *  0.3.4 review found the same gap for `.cp` and `.c++`. The tokens below
 *  mirror the classifier's table (canonical spellings + every case form). */
export const SOURCE_WATCHER_GLOB = `**/*.{${[
  ...CPP_SOURCE_EXTS,
  'cpp',
  'CPP',
  '[cC][pP][pP]',
  '[cC][xX][xX]',
  '[cC][cC]',
  '[cC][pP]',
  '[cC]++',
  'h',
  'hpp',
].join(',')}}`;

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

/** language classification of ONE file by its extension (0.3.4: the
 *  multi-char C++ suffixes are recognized case-insensitively — g++ compiles
 *  ANY file as C++ regardless of suffix, so .Cxx/.Cc/.CC/.CPP/.cPP and
 *  friends are all C++ sources; the SINGLE-letter pairs stay case-sensitive
 *  because the case itself is the language: .c = C while .C = C++, .s = asm
 *  while .S = asm-with-preprocess, exactly as GCC's suffix table defines).
 *  Returns undefined for anything that is not a source file. `ext` carries
 *  the spelling AS RECORDED — the makefile pattern rule must use it
 *  verbatim (make's % matching is case-sensitive). */
export function classifySourceExt(name: string): { kind: 'c' | 'cpp' | 'asm'; ext: string } | undefined {
  const base = path.posix.basename(name);
  const dot = base.lastIndexOf('.');
  const ext = dot < 0 ? '' : base.slice(dot + 1);
  if (!ext) return undefined;
  if (ext === 'c') return { kind: 'c', ext };
  if (ext === 'C') return { kind: 'cpp', ext };
  if (ext === 's' || ext === 'S') return { kind: 'asm', ext };
  const lower = ext.toLowerCase();
  if (lower === 'cpp' || lower === 'cxx' || lower === 'cc' || lower === 'cp' || lower === 'c++') {
    return { kind: 'cpp', ext };
  }
  return undefined;
}

/**
 * Build the logic dir -> files map for a project.
 * MRS semantics (getLogicDirFilesMap): walk the real project tree AND every
 * linked folder; CDT sourceEntries contribute `excluding` filters only
 * (root entry -> project-wide tokens, named entries -> tokens relative to
 * that folder). Linked folders are always scanned, whether or not they have
 * their own sourceEntry.
 */
/** the linked folders scanSources would silently SKIP (missing target,
 *  stray file instead of a directory, unreadable) — build/export entries
 *  call assertScannableLinkedFolders so a missing linked source tree can
 *  never turn into a "successful" build (round18 P2-1 / P3-1) */
export function unscannableLinkedFolders(cp: Cproject): Array<{ name: string; location: string }> {
  const out: Array<{ name: string; location: string }> = [];
  for (const [name, target] of cp.linkedFolders) {
    if (unscannableLinkedTarget(target)) out.push({ name, location: target });
  }
  return out;
}

/** the shared build/export entry guard (extension parity with the MCP
 *  requireLinkedTargets gate): refuse when the scan would silently skip
 *  source trees — linked folders whose target is missing / not a directory /
 *  unreadable, EXCEPT links intentionally excluded from the build (root
 *  entry names the link and no paired named entry re-includes it — round19
 *  P3-1) or logically removed from the tree (round26).
 *  NAMED sourceEntries that resolve to nothing are NOT refused: MRS skips
 *  them silently and still produces a working elf — user-verified 2026-11-25
 *  on the EVT V1_2 BLE projects, whose shipped .cproject carries a leftover
 *  dangling `Profile` entry from an older layout. Parity wins (user ruling):
 *  the build proceeds and the dangling entries surface as HINTS instead
 *  (danglingSourceEntries → MCP get_project_config note / audit finding).
 *  Link-vs-entry names still match CASE-FOLDED (round20 P2-1); a root
 *  exclude token WITHOUT a paired named entry is a real exclusion. */
export function assertScannableLinkedFolders(cp: Cproject): void {
  const rootEntry = cp.sourceEntries.find((e) => e.name === '');
  const excluded = new Set((rootEntry?.excluding ?? []).map((t) => fold(t)));
  const named = new Set(cp.sourceEntries.filter((e) => e.name !== '').map((e) => fold(e.name)));
  // links logically REMOVED via filteredResources (project tree Remove) do
  // not participate in the build — they must not trip the duplicate-target
  // report either (round24 P3-1)
  const removedFolders = new Set(
    listRemovedResources(cp.projectRoot)
      .filter((r) => r.isFolder)
      .map((r) => fold((r.parentLogic ? toPosix(r.parentLogic) + '/' : '') + r.name))
  );
  const problems: string[] = [];
  for (const [name, target] of cp.linkedFolders) {
    // intentionally excluded link AND no paired named entry, or logically
    // REMOVED from the tree (filteredResources): the build does not need it —
    // never block on it, not even when its target has since been deleted
    // (round26 Low: the raw-links loop already skipped removals, the stale
    // loop above it did not)
    if ((excluded.has(fold(name)) && !named.has(fold(name))) || removedFolders.has(fold(name))) continue;
    if (unscannableLinkedTarget(target)) problems.push(`"${name}" -> ${target}`);
  }
  // named sourceEntries resolving to nothing: NOT reported here any more —
  // MRS builds such projects fine (see danglingSourceEntries above / the
  // gate's doc comment); the hint channels own them now
  // the linkedFolder Map COLLAPSES exact duplicate names (last wins, first
  // silently dropped) — check the RAW .project links instead (round23 P3-2,
  // refined round25):
  //  1. an exact duplicate name with a DIFFERENT target = one silently lost;
  //  2. a link intentionally excluded from the build (root token, no paired
  //     named entry) or logically REMOVED (filteredResources) does not
  //     participate — it trips neither the stale nor the duplicate report;
  //  3. DIFFERENT link names over the same physical target keep one scanned
  //     logic path (the source-set physical dedupe handles the rest);
  //  4. self/ancestor targets that pre-date the write guards.
  // A project may legally lack .project (Cproject.load tolerates it) — the
  // raw check then has nothing to inspect (round25 High).
  let rawLinks: Array<{ name: string; type: number; location: string }> = [];
  try {
    rawLinks = readProjectFile(cp.projectRoot, { repair: false }).linkedResources;
  } catch {
    rawLinks = [];
  }
  const normLoc = (s: string) => fold(path.resolve(s));
  const rawSeenNames = new Map<string, { name: string; location: string }>();
  const seenRealTargets = new Map<string, string>();
  for (const l of rawLinks) {
    if (l.type !== 2) continue;
    const k = fold(l.name);
    // intentionally excluded / logically removed links skip every report —
    // they were taken out of the build on purpose (round25 Medium-2a)
    if ((excluded.has(k) && !named.has(k)) || removedFolders.has(k)) continue;
    const prev = rawSeenNames.get(k);
    if (prev && normLoc(prev.location) !== normLoc(l.location)) {
      // linkedFolderMap keeps the LAST link per name: l.location is scanned,
      // prev.location is the copy that got dropped (round25 Medium-2b;
      // resolve both so trailing-slash spellings compare equal)
      problems.push(
        `duplicate link name "${l.name}" with a different target — only "${l.location}" is scanned, "${prev.location}" is silently dropped`
      );
    }
    if (!prev) rawSeenNames.set(k, { name: l.name, location: l.location });
    if (unscannableLinkedTarget(l.location)) continue;
    try {
      const real = normLoc(fs.realpathSync.native(l.location));
      const first = seenRealTargets.get(real);
      if (first !== undefined && fold(first) !== fold(l.name)) {
        problems.push(`"${first}" and "${l.name}" point at the same directory (${l.location}) — one physical tree scanned under two logic names`);
      } else if (first === undefined) {
        seenRealTargets.set(real, l.name);
      }
    } catch {
      /* unreadable target — the unscannable check above already reported it */
    }
    try {
      assertSafeLinkTarget(cp.projectRoot, l.location);
    } catch (e) {
      problems.push(`"${l.name}" -> ${l.location}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (problems.length) {
    throw new Error(
      'stale source trees — the scan would silently skip them: ' +
        problems.join('; ') +
        '. Repair the linked folders / source entries in the project tree and retry.'
    );
  }
}

/** named sourceEntries whose directory does not resolve (not a link, not on
 *  disk, not implicitly resolved, not tree-removed) — the gate does NOT
 *  refuse these (user ruling 2026-11-25: MRS compiles such projects, verified
 *  on the EVT V1_2 BLE projects whose shipped .cproject carries a leftover
 *  dangling `Profile` entry from an older layout); callers surface them as
 *  hints instead. Same shape as the old refusal, minus the block. */
export function danglingSourceEntries(cp: Cproject): Array<{ name: string; dir: string }> {
  const linked = new Set([...cp.linkedFolders.keys()].map((n) => fold(n)));
  const removedFolders = new Set(
    listRemovedResources(cp.projectRoot)
      .filter((r) => r.isFolder)
      .map((r) => fold((r.parentLogic ? toPosix(r.parentLogic) + '/' : '') + r.name))
  );
  const out: Array<{ name: string; dir: string }> = [];
  for (const entry of cp.sourceEntries) {
    if (entry.name === '') continue; // root entry — not a directory reference
    if (linked.has(fold(entry.name))) continue; // explicit link — the link loop owns it
    if (removedFolders.has(fold(entry.name))) continue; // tree-removed (round26)
    const dir = path.join(cp.projectRoot, entry.name);
    if (unscannableLinkedTarget(dir)) out.push({ name: entry.name, dir });
  }
  return out;
}

export class ScanError extends Error {
  /** the directories that could not be read */
  readonly unreadable: Array<{ dir: string; message: string }>;
  constructor(unreadable: Array<{ dir: string; message: string }>) {
    super(
      'scan could not read directory entries — the build would silently use an incomplete source set: ' +
        unreadable.map((u) => `"${u.dir}" (${u.message})`).join('; ')
    );
    this.name = 'ScanError';
    this.unreadable = unreadable;
  }
}

export function scanSources(cp: Cproject, opts?: { includeExcluded?: boolean }): LogicDirMap {
  // includeExcluded (IntelliSense db only — the BUILD path must never pass
  // it): excluded files stay out of makefiles but still need parse
  // parameters, or cpptools falls back to folder-level includePath for them
  // (user report 2026-11-20: the excluded *same_16bit_char.c variants)
  const includeExcluded = opts?.includeExcluded === true;
  const isCpp = cp.isCpp;
  const result: LogicDirMap = new Map();
  // EVERY configuration's output directory is build output, not source
  // (round4 P2: with two configurations the INACTIVE dir's generated .c/.s
  // files landed in the other config's build). The name IS the dir name;
  // Windows folds directory-name case, so the walk comparison folds too.
  const configNames = new Set(cp.configurationNames.map((n) => fold(n)));

  const { rootTokens, dirTokens } = exclusionTokens(cp);

  // unreadable directories are COLLECTED and surface as a ScanError after
  // the walk — an incomplete source set must never look like a successful
  // scan (round21 P3-1: walk() used to swallow nested readdir failures, so
  // a locked subdirectory silently dropped its whole tree from makefiles,
  // CMake exports and compile databases)
  const scanErrors: Array<{ dir: string; message: string }> = [];

  // logically-removed resources (.project filteredResources — MRS2's Remove
  // command) are invisible to the tree AND to the build: skip matches here.
  // A FOLDER removal also hides everything under it (round1 P1: only the
  // folder row itself matched the exact set, so a deleted User/SomeFolder
  // still contributed User/SomeFolder/child.c to the build while the tree
  // showed nothing); Windows folds case, mirroring the exclude-token match
  const removedExact = new Set<string>();
  const removedDirPrefixes = new Set<string>();
  for (const r of listRemovedResources(cp.projectRoot)) {
    const logic = (r.parentLogic ? toPosix(r.parentLogic) + '/' : '') + r.name;
    if (r.isFolder) removedDirPrefixes.add(fold(toPosix(logic)) + '/');
    else removedExact.add(fold(toPosix(logic)));
  }
  const isRemoved = (logicName: string): boolean => {
    const f = fold(toPosix(logicName));
    // the f + '/' self-match lets this serve as a DIRECTORY/link-node test
    // too (a removed folder's own row is only in the prefix set) — the walk
    // uses it to skip descending into removed subtrees entirely
    if (removedExact.has(f) || removedDirPrefixes.has(f + '/')) return true;
    for (const p of removedDirPrefixes) if (f.startsWith(p)) return true;
    return false;
  };

  // physical-identity dedupe (round23 P2-1, extended round24 P2-1): two
  // linked folders over the SAME target directory (or nested/overlapping
  // targets) produce the same physical file under two logic names, and so
  // does an in-project link whose name differs from the physical directory
  // (Lib → proj/src with root files). The dedupe spans the ROOT walk and the
  // LINKED walks: when a linked walk hits an already-seen physical file, the
  // earlier (root/physical-name) entry is REPLACED by the link logic name —
  // matching MRS2 marker semantics where the linked folder is scanned under
  // its link name and the physical path yields to it (round1 P2).
  const seenPhysical = new Map<string, { dir: string; logicName: string }>();
  let inLinkedWalk = false;
  const physicalKey = (fullpath: string): string => {
    try {
      return fold(fs.realpathSync.native(fullpath));
    } catch {
      return fold(toPosix(fullpath));
    }
  };

  const addFile = (logicName: string, fullpath: string) => {
    const l = toPosix(logicName);
    if (isRemoved(l)) return; // logically removed (filteredResources)
    const realKey = physicalKey(fullpath);
    const dir = path.posix.dirname(l);
    const key = dir === '.' ? '' : dir;
    const prev = seenPhysical.get(realKey);
    if (prev && inLinkedWalk) {
      // a linked folder re-covers a physical file first seen under another
      // name: drop the earlier entry and file it under the LINK logic name
      // (the linked folder is the canonical logic path in MRS2)
      const oldArr = result.get(prev.dir);
      if (oldArr) {
        const idx = oldArr.findIndex((f) => fold(f.logicName) === fold(prev.logicName));
        if (idx >= 0) oldArr.splice(idx, 1);
        if (!oldArr.length) result.delete(prev.dir);
      }
      seenPhysical.set(realKey, { dir: key, logicName: l });
    } else if (prev && !inLinkedWalk) {
      // root walk re-encounter (case-variant spelling of the same dir) —
      // keep the first spelling, drop the repeat
      return;
    } else {
      seenPhysical.set(realKey, { dir: key, logicName: l });
    }
    if (!result.has(key)) result.set(key, []);
    const arr = result.get(key)!;
    // dedupe folded (win32): a hand-written .cproject may spell a real
    // folder's named entry with different case than the disk — the root
    // walk and the entry walk then produce both spellings of the same
    // file, which compiled twice and broke the link with duplicate symbols
    if (arr.some((f) => fold(f.logicName) === fold(l))) return;
    arr.push({
      logicName: l,
      fullpath: toPosix(fullpath),
      isC: !isCpp || classifySourceExt(logicName)?.kind === 'c',
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
  walk(cp.projectRoot, cp.projectRoot, '', rootTokens, configNames, isCpp, addFile, logicBases, includeExcluded, scanErrors, isRemoved);

  // 1.5 real-folder named entries re-scan their subtree: a root entry that
  // excludes the folder (CH32V307 RT-Thread excludes 'Core') relies on the
  // named entry to add it back; addFile dedupes when it wasn't excluded
  for (const entry of cp.sourceEntries) {
    if (entry.name === '' || cp.linkedFolders.has(entry.name)) continue;
    const dir = path.join(cp.projectRoot, entry.name);
    if (!fs.existsSync(dir)) continue; // linked/implicit handled in step 2
    // spell the logic base with the DISK's casing: the root walk (step 1)
    // already added this subtree under the on-disk spelling, so walking
    // under the entry's own spelling filed the same sources AGAIN under a
    // case-variant path (a hand-written 'app' entry over a disk 'APP/'
    // folder) — different strings slip past any dedupe and every file
    // compiled twice (duplicate symbols at link time)
    const segs = entry.name.split('/');
    let base = entry.name;
    try {
      const hit = fs
        .readdirSync(cp.projectRoot, { withFileTypes: true })
        .find((d) => d.isDirectory() && fold(d.name) === fold(segs[0]));
      if (hit) base = [hit.name, ...segs.slice(1)].join('/');
    } catch {
      /* unreadable root — keep the entry's own spelling */
    }
    // a named entry whose top-level directory is an output directory or
    // logically REMOVED (filteredResources) is skipped whole — output dirs
    // never contribute compiled sources, and removed trees must not surface
    // unreadable directories (round26 follow-up)
    if (configNames.has(fold(segs[0]))) continue;
    if (isRemoved(base)) continue;
    walk(dir, dir, base, entry.excluding, new Set<string>(), isCpp, addFile, [], includeExcluded, scanErrors, isRemoved);
  }

  // 2. linked folders, always scanned (MRS scans basic.linkedFolders)
  const named = namedEntryNames(cp);
  inLinkedWalk = true;
  for (const [name, target] of cp.linkedFolders) {
    if (unscannableLinkedTarget(target)) continue;
    // a link logically REMOVED from the tree (filteredResources) is not part
    // of the build — walking it would also surface unreadable directories
    // under its target as scan failures instead of being invisible like the
    // tree view is (round26 Low)
    if (isRemoved(name)) continue;
    // tokens may be written relative to the linked folder itself (bare file
    // names) or relative to the project root (StdPeriphDriver/CH58x_x.c) —
    // walk() matches both via the logic path. A root token equal to the
    // link's own name is a "don't double-scan" marker ONLY while a named
    // entry still re-includes the folder (folded compare: some projects
    // spell the marker with mismatched case); Exclude From Build removes
    // the entry, and the leftover token then really excludes the whole link
    // dir tokens: folded lookup too — the .cproject entry name is sometimes
    // spelled with a different case than the .project link name, and a raw
    // Map.get silently dropped every token (exclude reported success, the
    // build compiled the file anyway)
    let linkedTokens: string[] = [];
    const direct = dirTokens.get(name);
    if (direct) {
      linkedTokens = [...direct];
    } else {
      for (const [k, v] of dirTokens) {
        if (fold(k) === fold(name)) linkedTokens.push(...v);
      }
    }
    const tokens = [...rootTokens.filter((t) => !(fold(t) === fold(name) && named.has(fold(name)))), ...linkedTokens];
    walk(target, target, name, tokens, linkedOutputNames(target), isCpp, addFile, [], includeExcluded, scanErrors, isRemoved);
  }
  inLinkedWalk = false;

  // an unreadable directory anywhere in the walk means the scan returned an
  // INCOMPLETE source set — surface it as a failure instead of letting
  // makefiles/CMake exports look successful (round21 P3-1)
  if (scanErrors.length) {
    throw new ScanError(scanErrors);
  }

  // deterministic ordering: files by logicName
  for (const files of result.values()) {
    files.sort((a, b) => (a.logicName < b.logicName ? -1 : a.logicName > b.logicName ? 1 : 0));
  }
  return result;
}

function walk(
  fsRoot: string,
  dir: string,
  logicPrefix: string,
  excluded: string[],
  configNames: Set<string>,
  isCpp: boolean,
  add: (logicName: string, fullpath: string) => void,
  logicBases: Array<[string, string[]]> = [],
  includeExcluded = false,
  errors: Array<{ dir: string; message: string }> = [],
  /** when the DIRECTORY's logic path is logically removed (filteredResources)
   *  the recursion is skipped entirely — add() would drop its files anyway,
   *  but descending would still surface unreadable directories under the
   *  removed tree as scan failures (round26 Low) */
  skipSubtree?: (logic: string) => boolean
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push({ dir, message: e instanceof Error ? e.message : String(e) });
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const logic = logicPrefix ? `${logicPrefix}/${ent.name}` : ent.name;
    const relPosix = toPosix(path.relative(fsRoot, full));
    // excluding tokens are matched as paths (CDT semantics, see isExcluded):
    // against the walk root's relative path and against the logic path (a root
    // token may spell a project path, StdPeriphDriver/CH58x_usbhostClass.c
    // CH587 EVT style); a named entry's tokens apply below THAT folder (a
    // linked folder's tokens are relative to the link's own root)
    let excludedHere = isExcluded(relPosix, excluded) || isExcluded(logic, excluded);
    if (!excludedHere) {
      for (const [base, toks] of logicBases) {
        if (fold(logic + '/').startsWith(fold(base)) && isExcluded(logic.slice(base.length), toks)) {
          excludedHere = true;
          break;
        }
      }
    }
    if (excludedHere && !includeExcluded) continue;
    if (ent.isDirectory()) {
      // Output directories sit directly at the physical walk root (`dir === fsRoot`
      // — projectRoot or linked-project root); nested source subdirectories (e.g.
      // `User/obj` or `Lib/Vendor/obj`) must remain scannable.
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name) || (dir === fsRoot && configNames.has(fold(ent.name)))) continue;
      if (skipSubtree?.(logic)) continue; // logically removed — do not descend
      walk(fsRoot, full, logic, excluded, configNames, isCpp, add, logicBases, includeExcluded, errors, skipSubtree);
    } else if (ent.isFile()) {
      const cl = classifySourceExt(ent.name);
      if (!cl) continue;
      // a plain C project has no C++ tool: cpp-kind files are not part of
      // its build (same as the old c/s/S list for isCpp=false)
      if (!isCpp && cl.kind === 'cpp') continue;
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

/** folded names of non-root sourceEntries. CDT treats source entries as a
 * union: a named entry re-includes its folder, so a matching root-entry
 * token is a "don't double-scan" marker rather than an exclusion (CH585 EVT
 * writes both: root `excluding="...|Startup|..."` + `<entry name="Startup"/>`). */
function namedEntryNames(cp: Cproject): Set<string> {
  const names = new Set<string>();
  for (const entry of cp.sourceEntries) {
    if (entry.name !== '') names.add(fold(entry.name));
  }
  return names;
}

function isExcluded(relPosix: string, tokens: string[]): boolean {
  const hay = fold(relPosix);
  for (const t of tokens) {
    if (!t) continue;
    const tok = fold(t);
    // CDT excluding semantics: a token is a path relative to the ENTRY's own
    // folder (a bare token names a direct child of it) — there is NO basename
    // search anywhere. The token `lib` means `<base>/lib` and must not match
    // `FRFXLL/src/lib`: matching it dropped a whole library from the build
    // (finger_11_27 — a stale root token `lib` made MRVC skip FRFXLL/src/lib,
    // which MRS2 DOES build, and the link then failed on undefined FRFXLL*
    // references). A basename-style match must never be reintroduced here.
    if (hay === tok || hay.startsWith(tok + '/')) return true;
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

/** Configuration output directory names of a linked folder when its target
 *  is itself a CDT/MRS project root (has a parseable `.cproject`, regardless
 *  of `.wvproj`); plain non-project linked directories return an empty set. */
function linkedOutputNames(target: string): Set<string> {
  if (!fs.existsSync(path.join(target, '.cproject'))) return new Set<string>();
  try {
    return new Set(Cproject.load(target, { repairProject: false }).configurationNames.map((n) => fold(n)));
  } catch {
    return new Set<string>();
  }
}

/**
 * True when `logic` points to (or inside) a top-level configuration output
 * directory on disk (or the output directory of a linked `.cproject` project).
 */
export function isOutputDirLogicPath(cp: Cproject, logic: string): boolean {
  const norm = toPosix(logic).replace(/^\/+/, '');
  if (!norm) return false;
  const top = norm.includes('/') ? norm.slice(0, norm.indexOf('/')) : norm;
  const target = findLink(cp, top);
  if (target) {
    const child = norm.includes('/') ? norm.slice(top.length + 1).split('/')[0] : '';
    if (!child || !linkedOutputNames(target).has(fold(child))) return false;
    try {
      return fs.lstatSync(path.join(target, child)).isDirectory();
    } catch {
      return true;
    }
  }
  if (!cp.configurationNames.some((n) => fold(n) === fold(top))) return false;
  try {
    return fs.lstatSync(path.join(cp.projectRoot, top)).isDirectory();
  } catch {
    return true;
  }
}

/**
 * Would the given logic path (project-root relative, linked folders rooted
 * at their link name) be skipped by scanSources? Mirrors the token
 * application in scanSources/walk exactly — used by the UI to show and
 * toggle the Exclude From Build state.
 */
export function isLogicExcluded(cp: Cproject, logic: string): boolean {
  const { rootTokens, dirTokens } = exclusionTokens(cp);
  const named = namedEntryNames(cp);
  // folded dir-token lookup: entry names sometimes differ in case from the
  // .project link names (the scanner's marker filter already folds)
  const dirTokensFor = (top: string): string[] => {
    const direct = dirTokens.get(top);
    if (direct) return direct;
    for (const [k, v] of dirTokens) {
      if (fold(k) === fold(top)) return v;
    }
    return [];
  };
  const top = logic.includes('/') ? logic.slice(0, logic.indexOf('/')) : logic;
  if (logic === top) {
    // A named sourceEntry re-includes the folder, so a matching root token
    // is just a "don't double-scan" marker, not an exclusion
    if (named.has(fold(top))) return false;
    if (findLink(cp, top)) {
      // linked folders are always scanned — but a root token naming the
      // link excludes it once its named entry is gone (Exclude From Build
      // removes the entry; without one the token is a real exclusion)
      return rootTokens.some((t) => fold(t) === fold(top));
    }
    return isExcluded(logic, rootTokens);
  }
  const rel = logic.slice(top.length + 1);
  if (findLink(cp, top)) {
    // the whole link is excluded when its root token lost its entry
    if (!named.has(fold(top)) && rootTokens.some((t) => fold(t) === fold(top))) return true;
    // linked walks ignore root tokens equal to the link's own name
    // ("don't double-scan" markers, folded compare) and carry their named
    // entry tokens
    const tokens = [...rootTokens.filter((t) => fold(t) !== fold(top)), ...dirTokensFor(top)];
    return isExcluded(rel, tokens) || isExcluded(logic, tokens);
  }
  if (named.has(fold(top)) && fs.existsSync(path.join(cp.projectRoot, top))) {
    // real folder with its own named entry: the root walk prunes the folder
    // (its root token is a marker) and the entry walk re-scans it with only
    // the entry's own tokens, so those are all that decide inside the folder
    const toks = dirTokensFor(top);
    return isExcluded(rel, toks) || isExcluded(logic, toks);
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
  const named = namedEntryNames(cp);
  for (const entry of cp.sourceEntries) {
    for (const tok of entry.excluding) {
      const segs = tok.split('/');
      if (entry.name === '') {
        // folded lookup: markers sometimes spell the link name with
        // mismatched case (see the marker filter in scanSources)
        const linkLoc = findLink(cp, segs[0]);
        if (linkLoc) {
          if (segs.length === 1 && named.has(fold(segs[0]))) continue; // marker: the entry re-includes this link
          // without its entry the token really excludes the whole link
          out.push(segs.length === 1 ? linkLoc : path.join(linkLoc, ...segs.slice(1)));
        } else if (segs.length === 1 && named.has(fold(segs[0]))) {
          continue; // marker: a named sourceEntry re-includes this folder
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
    // a bare root token names a DIRECT child of a walk root (isExcluded has no
    // basename search) — for linked folders that is the link target's own root,
    // where the scanner matches the same token against the walk-root-relative
    // path. The old depth-agnostic search here decorated deeper same-named
    // entries the engine does NOT exclude ("grey in the tree but still builds").
    for (const loc of cp.linkedFolders.values()) {
      const hit = path.join(loc, tok);
      if (fs.existsSync(hit)) out.push(hit);
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

/** per-directory compile groups (0.3.4 case-variant recognition): the
 *  canonical exts keep CDT variable names and CDT order (byte-identical
 *  goldens); a case-variant C++ suffix present in the dir gets its OWN
 *  group — the makefile pattern rule must carry the file's actual
 *  extension spelling, because make's % matching is case-sensitive — with
 *  a deduped variable name so mixed spellings in one dir can't collide on
 *  one make variable (two groups writing `CXX_OBJS` would lose one list). */
export function dirGroups(files: LogicFile[], isCpp: boolean): Array<ExtGroup & { files: LogicFile[] }> {
  const byExt = new Map<string, LogicFile[]>();
  for (const f of files) {
    const cl = classifySourceExt(f.logicName);
    if (!cl) continue;
    const list = byExt.get(cl.ext) ?? [];
    list.push(f);
    byExt.set(cl.ext, list);
  }
  const out: Array<ExtGroup & { files: LogicFile[] }> = [];
  const usedVars = new Set<string>();
  for (const g of extGroups(isCpp)) {
    const group = byExt.get(g.ext);
    if (!group?.length) continue;
    usedVars.add(g.variable);
    out.push({ ...g, files: group });
    byExt.delete(g.ext);
  }
  for (const ext of [...byExt.keys()].sort()) {
    const cl = classifySourceExt(`x.${ext}`);
    if (!cl) continue;
    const baseVar = ext.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    let variable = baseVar;
    let n = 2;
    while (usedVars.has(variable)) variable = `${baseVar}_${n++}`;
    usedVars.add(variable);
    out.push({ ext, variable, isAsm: cl.kind === 'asm', isCppFile: cl.kind === 'cpp', files: byExt.get(ext)! });
  }
  return out;
}
