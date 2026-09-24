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
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
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
