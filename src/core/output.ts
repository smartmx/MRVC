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
  const d = path.resolve(dir);
  if (d === root || !d.startsWith(root + path.sep)) {
    throw new Error(`refusing to touch a directory outside the project root: ${d}`);
  }
  return d;
}

/**
 * Remove every entry inside the output directory. Entries whose file name
 * matches keepNames (case-insensitive on Windows) are kept — used to
 * preserve the flash images (工程名.hex / 工程名.bin). Returns the number
 * of removed entries.
 */
export function clearOutputDir(projectRoot: string, dir: string, keepNames: string[] = []): number {
  const d = contained(projectRoot, dir);
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
