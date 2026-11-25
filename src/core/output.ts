/**
 * Build-output directory maintenance for the batch "delete output" commands:
 * clear everything inside the output directory (optionally keeping the flash
 * images) or remove the directory itself. Every entry point refuses to
 * operate on the project root or anything outside it — same containment
 * rule as makefile.ts writeMk. Pure Node.
 */
import * as fs from 'fs';
import * as path from 'path';

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

/** refuse a junction/symlink output directory: clearOutputDir lists and
 * deletes ENTRIES, which would follow the link and wipe the TARGET's
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
 * Remove every entry inside the output directory. Entries whose file name
 * matches keepNames (case-insensitive on Windows) are kept — used to
 * preserve the flash images (工程名.hex / 工程名.bin). Returns the number
 * of removed entries.
 */
export function clearOutputDir(projectRoot: string, dir: string, keepNames: string[] = []): number {
  const d = contained(projectRoot, dir);
  refuseLinkedDir(d);
  const keep = new Set(keepNames.map(fold));
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return 0; // never built — nothing to clear
  }
  for (const ent of entries) {
    if (ent.isFile() && keep.has(fold(ent.name))) continue;
    fs.rmSync(path.join(d, ent.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Remove the output directory itself. */
export function removeOutputDir(projectRoot: string, dir: string): void {
  const d = contained(projectRoot, dir);
  refuseLinkedDir(d);
  fs.rmSync(d, { recursive: true, force: true });
}

export interface OutputSpec {
  /** one configuration's output directory (MRS convention: the
   *  configuration's name IS its output directory name) */
  dir: string;
  /** file names to keep when CLEARING (the flash images); undefined =
   *  remove the whole directory */
  keep?: string[];
}

/**
 * Delete every configuration's output directory in one pass — the batch
 * "delete output" commands (0.3.6: ALL configurations, not just the active
 * one). Missing directories (never built) are skipped silently; per-
 * configuration keep lists are the caller's job (each configuration names
 * its own flash images). Returns how many directories were removed and how
 * many entries the clearing variant deleted.
 */
export function deleteConfigOutputs(projectRoot: string, specs: OutputSpec[]): { dirs: number; files: number } {
  let dirs = 0;
  let files = 0;
  for (const spec of specs) {
    if (!fs.existsSync(path.resolve(projectRoot, spec.dir))) continue; // never built
    if (spec.keep) {
      files += clearOutputDir(projectRoot, spec.dir, spec.keep);
    } else {
      removeOutputDir(projectRoot, spec.dir);
      dirs++;
    }
  }
  return { dirs, files };
}
