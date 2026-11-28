/**
 * Build-output directory maintenance for the batch "delete output" commands:
 * clear everything inside the output directory (optionally keeping the flash
 * images) or remove the directory itself. Every entry point refuses to
 * operate on the project root or anything outside it — same containment
 * rule as makefile.ts writeMk. Pure Node.
 *
 * (review round7 P1) the deletion list is FILE-LEVEL and derived from the
 * build model: a configuration CLAIMS exactly the paths its build writes
 * (makefile family, objects, deps, products, images, listing, flash script
 * — see makefile.buildOutputFiles). Only claimed paths are ever deleted, so
 * linker inputs (a vendor .a reached through USER_OBJS) and user data inside
 * the output directory survive every clear — the same distinction the clean
 * recipe makes ($(OBJS) removed, $(USER_OBJS) not).
 *
 * Directory ownership is proven independently of the file-name tiers: the
 * directory must carry a GENERATED makefile (CDT's "Automatically-generated
 * file. Do not edit!" header — every CDT generation emits it) that
 * references one of the configuration's target names as a whole word.
 * Without that anchor nothing is deleted even when claimed-looking files
 * exist (a never-built imported dir holding a factory image, a hand-written
 * Makefile beside stored data).
 *
 * The batch validates EVERY directory first (plans never execute when one
 * fails), executes per-file removals (never a recursive rm of the tree) and
 * removes directories with a NON-recursive rmdir that only ever succeeds on
 * directories left empty.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AnsiArtifactEncoding, ansiArtifactEncoding, decodeArtifact } from './platformEncoding';
import { loadDirHistory, mayReclaim, pruneDeletedHistory, sha256File } from './outputHistory';

const CASE_FOLD = process.platform === 'win32';
const fold = (s: string): string => (CASE_FOLD ? s.toLowerCase() : s);

function contained(projectRoot: string, dir: string): string {
  const root = path.resolve(projectRoot);
  // relative dirs resolve against the PROJECT (callers pass output-dir names
  // like "obj"), never against process.cwd() (code-review H3① follow-up)
  const d = path.resolve(root, dir);
  // case-folded on win32 (NTFS): dialog-supplied paths frequently spell the
  // drive/directory differently than path.resolve normalizes them, and a
  // case-only mismatch must not read as "outside the project". A drive-root
  // project root already ends with its separator — do not double it.
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (fold(d) === fold(root) || !fold(d).startsWith(fold(prefix))) {
    throw new Error(`refusing to touch a directory outside the project root: ${d}`);
  }
  // the logical prefix check cannot see LINKED ANCESTORS: <proj>/sub/obj with
  // `sub` as a junction passes the string compare while the real directory
  // lives outside the project. Re-verify through the OS for anything that
  // exists on disk (realpathSync.native resolves junctions/symlinks); a
  // missing directory is the "never built" case the callers handle.
  try {
    const realD = fs.realpathSync.native(d);
    const realR = fs.realpathSync.native(root);
    const realPrefix = realR.endsWith(path.sep) ? realR : realR + path.sep;
    // the SAME refusal shape as the logical check above — including "the
    // path resolves TO the project root itself": <proj>/sub → .. makes
    // sub/<projName> logically-inside but really the root, and clearing it
    // would wipe the whole project (review follow-up: the first cut had the
    // condition inverted here and let that through)
    if (fold(realD) === fold(realR) || !fold(realD).startsWith(fold(realPrefix))) {
      throw new Error(`refusing to touch a directory that resolves outside the project root through a link: ${d} -> ${realD}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return d; // never built — the caller's missing-dir path takes over
    }
    throw e;
  }
  return d;
}

/**
 * Execution-layer containment: every path the plan touches is joined from a
 * readdirSync-derived rel, and the executor asserts the join stays inside
 * the validated directory (defense in depth — no plan entry can escape).
 */
function assertInsideDir(d: string, rel: string): string {
  const joined = path.resolve(d, rel);
  const base = path.resolve(d);
  if (joined !== base && !joined.startsWith(base + path.sep)) {
    throw new Error(`refusing to operate outside the output directory: ${joined}`);
  }
  return joined;
}

/** refuse a junction/symlink output directory: the plans below list and
 * delete ENTRIES, which would follow the link and wipe the TARGET's
 * contents outside the project (code-review H3). Missing directories pass —
 * callers treat those as never-built. */
function refuseLinkedDir(d: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(d);
  } catch {
    return; // absent — nothing to clear/remove
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to operate on a linked (junction/symlink) output directory: ${d}`);
  }
}

/**
 * Flat traversal of the output tree (review round7 P2-B): traversal is
 * separate from ownership/claim decisions — intermediate directories carry
 * no "prove the whole subtree" responsibility, the per-file claimed set
 * decides. Returns relative posix paths; `dirs` is post-order so empty
 * directories can be removed bottom-up. Refuses links and special entries
 * (a link inside the tree would make the entry-level deletions follow it).
 */
function inspectTree(d: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  const visit = (rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(d, rel), { withFileTypes: true });
    } catch (e) {
      throw new Error(`cannot inspect the directory (${e instanceof Error ? e.message : String(e)}) — refusing to treat it as a build output directory`);
    }
    for (const ent of entries) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new Error(`refusing a link (junction/symlink) inside the output directory: ${child}`);
      if (ent.isFile()) files.push(child);
      else if (ent.isDirectory()) {
        visit(child);
        dirs.push(child); // post-order
      } else {
        throw new Error(`refusing a special entry (not a regular file or directory) inside the output directory: ${child}`);
      }
    }
  };
  visit('');
  return { files, dirs };
}

/**
 * The ownership anchor (review round5/round6/round7): the generated
 * makefile NAMES its own targets and carries the CDT generated-file header.
 * A vendor's hand-written Makefile that merely mentions the target in a
 * comment is not proof (word-boundary scan, no regex escaping needed);
 * neither is a foreign makefile that lacks the header.
 */
const GENERATED_HEADER = 'Automatically-generated file. Do not edit!';

function mentionsWord(text: string, word: string): boolean {
  let idx = text.indexOf(word);
  while (idx >= 0) {
    const before = idx > 0 ? text[idx - 1] : '';
    const after = text[idx + word.length] ?? '';
    const beforeOk = before === '' || !/[A-Za-z0-9_]/.test(before);
    const afterOk = after === '' || !/[A-Za-z0-9_]/.test(after);
    if (beforeOk && afterOk) return true;
    idx = text.indexOf(word, idx + 1);
  }
  return false;
}

const NOT_PROVEN = "not proven to be THIS build's output directory";

function makefileOwnershipProblem(d: string, targets: readonly string[], encoding?: AnsiArtifactEncoding): string | undefined {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(d, 'makefile'));
  } catch {
    return `it holds files this build writes, but there is no generated makefile in it — ${NOT_PROVEN}`;
  }
  const enc = encoding ?? ansiArtifactEncoding();
  const text = decodeArtifact(bytes, enc);
  // Node's UTF-8 decoder replaces invalid byte sequences with U+FFFD (as do
  // cross-codepage CJK decoders on incompatible byte streams). Surface an
  // actionable cross-machine diagnostic rather than just "missing target".
  if (text.includes('\uFFFD')) {
    return `the makefile is not valid ${enc}; it may have been generated on a machine with a different system code page — rebuild the project once to regenerate it in this machine's encoding`;
  }
  if (!text.includes(GENERATED_HEADER)) {
    return `the makefile here is not a generated build makefile (no generated-file header) — ${NOT_PROVEN}`;
  }
  // MRS lets same-named configurations SHARE one output directory whose
  // makefile was last generated by whichever config built last — the group's
  // UNION of target names decides (review round7 P2-C: requiring the FIRST
  // config's name alone refused a perfectly safe shared-directory clear)
  if (!targets.some((t) => mentionsWord(text, t))) {
    return `the generated makefile does not reference this configuration's target (${targets.join(' / ')}) — ${NOT_PROVEN}`;
  }
  return undefined;
}

interface OutputGroup {
  /** the resolved directory of the group */
  d: string;
  /** every contributing configuration's `outputPrefix + targetName` (raw
   *  spellings — the whole-word mention check is case-sensitive) */
  targets: string[];
  /** fold()-normalized top-level file names to KEEP in clear mode */
  keep: Set<string>;
  /** true when at least one spec asked for a CLEAR (keep list given);
   *  false = remove the whole directory */
  clear: boolean;
  /** fold()-normalized claimed output paths (build-model, posix rels) */
  claimed: Set<string>;
  /** explicit artifact decoding override (tests / cross-locale probes) */
  encoding?: AnsiArtifactEncoding;
}

interface PlannedDeleteFile {
  rel: string;
  expectedSha: string;
}

interface DirPlan {
  /** the validated output directory */
  d: string;
  /** canonical real directory path (key into output-history.json) */
  realD: string;
  /** relative posix paths + plan-time SHA-256 of files to remove (all claimed or
   *  history-verified); re-checked at execution time via assertInsideDir +
   *  lstatSync + SHA-256 match */
  deleteFiles: PlannedDeleteFile[];
  /** relative posix paths of files left untouched (unclaimed) — reported,
   *  never deleted */
  keptFiles: string[];
  /** relative posix directories, post-order — removed with a non-recursive
   *  rmdir that only succeeds when the directory is empty */
  dirs: string[];
  /** remove the output directory itself (remove mode, validated empty) */
  removeRoot: boolean;
}

/**
 * Validate one directory group and produce its plan. THROWS on every refusal
 * — the batch caller collects the problems and refuses wholly, so a thrown
 * plan never deletes anything.
 */
function planGroup(root: string, g: OutputGroup): DirPlan {
  const d = contained(root, g.d);
  refuseLinkedDir(d);
  let st: fs.Stats | undefined;
  let realD = d;
  try {
    st = fs.statSync(d);
    if (st.isDirectory()) realD = fs.realpathSync.native(d);
  } catch {
    st = undefined; // vanished between existsSync and stat — never built
  }
  if (!st) return { d, realD, deleteFiles: [], keptFiles: [], dirs: [], removeRoot: false };
  if (!st.isDirectory()) throw new Error(`refusing to delete "${d}": it is not a directory`);
  const tree = inspectTree(d);
  const hist = loadDirHistory(root, realD);
  const keepTop = g.keep;
  const deleteFiles: PlannedDeleteFile[] = [];
  const keptFiles: string[] = [];
  let sawOwned = false;
  for (const rel of tree.files) {
    const k = fold(rel);
    let owned: boolean;
    let fileSha: string | undefined;
    if (hist.files.has(k)) {
      // (review round9 P1-A) every file in output-history.json — whether still
      // claimed by the current config OR left over from a prior build — must
      // match its recorded SHA-256 so user-edited artifacts are never deleted
      fileSha = sha256File(path.join(d, rel));
      owned = fileSha !== undefined && mayReclaim(k, fileSha, hist.files);
    } else if (g.claimed.has(k)) {
      // no recorded hash (legacy pre-history build): fall back to build-model
      // claim, gated below by the generated-makefile ownership anchor, while
      // capturing its hash to close TOCTOU before unlink
      fileSha = sha256File(path.join(d, rel));
      if (fileSha === undefined) {
        throw new Error(`refusing to ${g.clear ? 'clear' : 'delete'} "${d}": cannot read planned output file "${rel}"`);
      }
      owned = true;
    } else {
      owned = false;
    }
    if (owned) {
      sawOwned = true;
      // clear mode keeps TOP-LEVEL kept names (the flash images) — sub-
      // directories and case-mismatched names are never kept entries
      if (g.clear && !rel.includes('/') && keepTop.has(k)) {
        keptFiles.push(rel);
        continue;
      }
      deleteFiles.push({ rel, expectedSha: fileSha! });
    } else {
      // NOT this build's output: a linker input, stored image, user data —
      // never deleted, never refused in clear mode (review round7 P1: the
      // suffix test used to classify exactly these as deletable)
      keptFiles.push(rel);
    }
  }
  if (g.clear) {
    if (deleteFiles.length === 0 && tree.files.length && !sawOwned) {
      // nothing here is written by this build at all — a loud refusal keeps
      // misconfigured/foreign directories visible instead of silently
      // "succeeding" (a kept-images-only re-run still passes: those files
      // ARE claimed and land in keptFiles above)
      throw new Error(
        `refusing to clear "${d}": none of the ${tree.files.length} file(s) here are written by this build (for example ${tree.files
          .slice(0, 3)
          .join(', ')}) — the directory is not this configuration's build output`
      );
    }
  } else if (keptFiles.length) {
    // remove mode: the whole directory must go, and it cannot while files
    // this build does not own are inside — refuse BEFORE deleting anything
    throw new Error(
      `refusing to delete "${d}": ${keptFiles.length} file(s) here are not written by this build (for example ${keptFiles
        .slice(0, 3)
        .join(', ')}) — remove them manually, or use the keep-images clear which leaves them alone`
    );
  }
  if (deleteFiles.length || (!g.clear && tree.dirs.length > 0)) {
    // the ownership anchor gates ANY deletion (including removing non-empty
    // directory trees that only hold empty subdirectories): files at claimed
    // paths or subtrees in a directory without a generated makefile naming
    // this build could belong to another tree; truly empty dirs pass through.
    const own = makefileOwnershipProblem(d, g.targets, g.encoding ?? hist.encoding);
    if (own) throw new Error(`refusing to ${g.clear ? 'clear' : 'delete'} "${d}": ${own}`);
  }
  return {
    d,
    realD,
    deleteFiles,
    keptFiles,
    dirs: tree.dirs,
    removeRoot: !g.clear,
  };
}

/** Remove the planned root output directory itself; propagate permission /
 *  non-empty / busy errors loudly instead of falsely reporting success
 *  (review round8 P2-D). `ENOENT` returns 0 (already gone). */
function removePlannedRoot(dir: string): number {
  try {
    fs.rmdirSync(dir);
    return 1;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return 0;
    throw new Error(
      `failed to remove output directory "${dir}" (${code ?? 'unknown'}): ${e instanceof Error ? e.message : String(e)} — some claimed files inside may already have been deleted`
    );
  }
}

/** Execution-time verification against intermediate directory replacement
 *  (review round36 P2): walk every relative directory component under `plan.d`
 *  with `lstatSync` to reject junctions/symlinks introduced after planning, and
 *  confirm `realpathSync.native(abs)` stays strictly inside `plan.realD`. */
function assertContainedExecutionPath(plan: DirPlan, rel: string, abs: string, kind: 'file' | 'dir'): void {
  const segs = rel.split('/').filter(Boolean);
  const dirSegCount = kind === 'dir' ? segs.length : Math.max(0, segs.length - 1);
  let cur = path.resolve(plan.d);
  for (let i = 0; i < dirSegCount; i++) {
    cur = path.join(cur, segs[i]);
    const st = fs.lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to traverse linked or non-directory path inside the output directory: ${segs.slice(0, i + 1).join('/')}`);
    }
  }
  const realTarget = fs.realpathSync.native(abs);
  const realPrefix = plan.realD.endsWith(path.sep) ? plan.realD : plan.realD + path.sep;
  if (fold(realTarget) === fold(plan.realD) || !fold(realTarget).startsWith(fold(realPrefix))) {
    throw new Error(`refusing to touch path escaping the output directory through a link: ${abs} -> ${realTarget}`);
  }
}

/** Execute a validated plan: per-file removals (never a recursive rm), prune
 *  recorded history for actually unlinked files, then non-recursive rmdirs
 *  that only ever succeed on emptied directories. The reported `dirs` counts
 *  the OUTPUT DIRECTORY itself (remove mode) — the emptied subdirectories go
 *  with it and are not counted separately. */
function executePlan(root: string, plan: DirPlan): { files: number; dirs: number } {
  if (!plan.deleteFiles.length && !plan.removeRoot) {
    return { files: 0, dirs: 0 }; // zero-change — nothing is touched at all
  }
  refuseLinkedDir(plan.d);
  try {
    const currentRealD = fs.realpathSync.native(plan.d);
    if (fold(currentRealD) !== fold(plan.realD)) {
      throw new Error(`refusing to operate on output directory whose real path changed after validation: ${plan.d} -> ${currentRealD}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { files: 0, dirs: 0 };
    }
    throw e;
  }
  const deletedRels: string[] = [];
  try {
    for (const item of plan.deleteFiles) {
      const abs = assertInsideDir(plan.d, item.rel);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw e;
      }
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error(`refusing to delete non-regular entry or link inside the output directory: ${item.rel}`);
      }
      assertContainedExecutionPath(plan, item.rel, abs, 'file');
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw e;
      }
      const actualSha = createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== item.expectedSha) {
        throw new Error(`refusing to delete "${item.rel}" in "${plan.d}": file content changed after validation (TOCTOU)`);
      }
      // Immediate pre-unlink re-verification (review round37 P2): minimizes the
      // window after readFileSync before unlinkSync. Note residual boundary of
      // pure Node.js path APIs: without native fd-relative `unlinkat(dirfd)`,
      // a local concurrent directory swap strictly between this check and the
      // `unlinkSync` syscall cannot be made OS-atomic.
      let stPreUnlink: fs.Stats;
      try {
        stPreUnlink = fs.lstatSync(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw e;
      }
      if (stPreUnlink.isSymbolicLink() || !stPreUnlink.isFile()) {
        throw new Error(`refusing to delete non-regular entry or link inside the output directory: ${item.rel}`);
      }
      assertContainedExecutionPath(plan, item.rel, abs, 'file');
      fs.unlinkSync(abs); // non-recursive single-file unlink
      deletedRels.push(item.rel);
    }
  } finally {
    if (deletedRels.length) {
      pruneDeletedHistory(root, plan.realD, deletedRels);
    }
  }
  for (const rel of plan.dirs) {
    const absDir = assertInsideDir(plan.d, rel);
    let stDir: fs.Stats;
    try {
      stDir = fs.lstatSync(absDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw e;
    }
    if (stDir.isSymbolicLink() || !stDir.isDirectory()) {
      throw new Error(`refusing to remove linked or non-directory subdirectory inside the output directory: ${rel}`);
    }
    assertContainedExecutionPath(plan, rel, absDir, 'dir');
    try {
      fs.rmdirSync(absDir); // only succeeds when empty
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (plan.removeRoot && code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') {
        throw new Error(
          `failed to remove subdirectory "${rel}" in "${plan.d}" (${code ?? 'unknown'}): ${e instanceof Error ? e.message : String(e)}`
        );
      }
      // clear mode (or an external race adding a file): keep untouched
    }
  }
  let dirs = 0;
  if (plan.removeRoot) {
    dirs += removePlannedRoot(assertInsideDir(plan.d, '.'));
  }
  return { files: deletedRels.length, dirs };
}

/**
 * Remove every entry the build CLAIMS inside the output directory (the
 * flash images listed in keepNames are spared). Returns the removed count
 * and the files left untouched (unclaimed — linker inputs, stored data).
 */
export function clearOutputDir(
  projectRoot: string,
  dir: string,
  keepNames: string[],
  target: string,
  claimed: string[],
  encoding?: AnsiArtifactEncoding
): { removed: number; kept: string[] } {
  // the containment contract holds even for a directory that does not
  // exist — the batch path skips missing dirs silently, the direct entry
  // must still refuse an outside-root spelling (round7 follow-up)
  contained(projectRoot, dir);
  const r = deleteConfigOutputs(projectRoot, [{ dir, keep: keepNames, target, claimed, encoding }]);
  return { removed: r.files, kept: r.kept };
}

/**
 * Remove the output directory itself: every claimed file goes first, then
 * non-recursive rmdirs. Files the build does not own REFUSE the operation
 * (the directory could not be removed anyway without destroying them).
 */
export function removeOutputDir(
  projectRoot: string,
  dir: string,
  target: string,
  claimed: string[],
  encoding?: AnsiArtifactEncoding
): { removed: boolean; files: number } {
  // same containment contract as clearOutputDir (see above)
  contained(projectRoot, dir);
  const r = deleteConfigOutputs(projectRoot, [{ dir, target, claimed, encoding }]);
  return { removed: r.dirs > 0, files: r.files };
}

export interface OutputSpec {
  /** one configuration's output directory (MRS convention: the
   *  configuration's name IS its output directory name) */
  dir: string;
  /** file names to keep when CLEARING (the flash images); undefined =
   *  remove the whole directory */
  keep?: string[];
  /** the configuration's `outputPrefix + targetName` — the generated
   *  makefile must reference one of the group's targets */
  target: string;
  /** relative posix paths THIS configuration's build writes into `dir`
   *  (makefile.buildOutputFiles) — the ONLY paths that may be deleted */
  claimed: string[];
  /** explicit ANSI encoding used to write `makefile` (optional override) */
  encoding?: AnsiArtifactEncoding;
}

/**
 * Delete every configuration's claimed outputs in one pass — the batch
 * "delete output" commands (0.3.6: ALL configurations, not just the active
 * one). Missing directories (never built) are skipped silently.
 *
 * (review round7 P2-C) same resolved directories are GROUPED FIRST —
 * targets union, keep lists union, clearing wins over removing — and ONE
 * combined validation + execution runs per directory. The old per-spec
 * validate-then-merge order refused a shared directory whose makefile was
 * generated by the last-built configuration (it does not name the other
 * config), although both images survive a union keep.
 *
 * (review round3 P2, kept) VALIDATE THE WHOLE BATCH FIRST: one failing
 * directory refuses the batch before ANY deletion starts.
 *
 * Returns how many directories were removed, how many files the clears
 * deleted, and the files left untouched (unclaimed survivors).
 */
export function deleteConfigOutputs(projectRoot: string, specs: OutputSpec[]): { dirs: number; files: number; kept: string[] } {
  const root = path.resolve(projectRoot);
  const groups = new Map<string, OutputGroup>();
  for (const spec of specs) {
    // validate containment & symlink BEFORE checking existence so an outside
    // non-existent path or dangling symlink cannot slip past as a silent skip
    const d = contained(root, spec.dir);
    refuseLinkedDir(d);
    let realD: string;
    try {
      realD = fs.realpathSync.native(d);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue; // never built — skipped silently
      throw e;
    }
    const key = fold(realD);
    let g = groups.get(key);
    if (!g) {
      g = { d, targets: [], keep: new Set(), clear: false, claimed: new Set(), encoding: spec.encoding };
      groups.set(key, g);
    } else if (!g.encoding && spec.encoding) {
      g.encoding = spec.encoding;
    }
    if (!g.targets.includes(spec.target)) g.targets.push(spec.target);
    if (spec.keep !== undefined) {
      g.clear = true;
      for (const k of spec.keep) g.keep.add(fold(k));
    }
    for (const c of spec.claimed) g.claimed.add(fold(c));
  }
  const problems: string[] = [];
  const plans: DirPlan[] = [];
  const kept: string[] = [];
  for (const g of groups.values()) {
    try {
      const plan = planGroup(root, g);
      plans.push(plan);
      kept.push(...plan.keptFiles);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (problems.length) {
    throw new Error(`refusing the batch delete — ${problems.length} of ${groups.size} directories failed the output-directory checks:\n${problems.join('\n')}`);
  }
  let dirs = 0;
  let files = 0;
  for (const plan of plans) {
    const r = executePlan(root, plan);
    files += r.files;
    dirs += r.dirs;
  }
  return { dirs, files, kept };
}
