/**
 * Project discovery: walk a directory tree and collect every folder that
 * is an MRS project. The marker is `工程名.wvproj` (the file MRS itself
 * opens / file-associates), with `.project` as legacy fallback. Pure
 * Node — no vscode imports.
 */
import * as fs from 'fs';
import * as path from 'path';

/** EXAM-style trees nest projects up to 4 levels (e.g. USB/USBHS/HOST_IAP/HOST_APP). */
export const DEFAULT_DISCOVERY_DEPTH = 6;

export function findProjectRoots(dir: string, depth: number = DEFAULT_DISCOVERY_DEPTH): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  // a project root stops the descent (nested projects are not supported by
  // the CDT model anyway)
  if (isProjectRoot(entries)) {
    out.push(dir);
    return out;
  }
  if (depth <= 0) return out;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'obj') {
      out.push(...findProjectRoots(path.join(dir, e.name), depth - 1));
    }
  }
  return out;
}

function isProjectRoot(entries: fs.Dirent[]): boolean {
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name === '.project') return true;
    if (e.name.toLowerCase().endsWith('.wvproj')) return true;
  }
  return false;
}

/**
 * Collect every `.wvsln` (MRS solution) file under a tree. Solutions group
 * standard projects via relative/absolute member paths, so a solution dir
 * is NOT a project root itself — the walk descends into it to find the
 * member projects (and nested solutions), but stops at project roots.
 */
export function findSolutionFiles(dir: string, depth: number = DEFAULT_DISCOVERY_DEPTH): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  if (isProjectRoot(entries)) return out; // a project never contains a solution
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.wvsln')) {
      out.push(path.join(dir, e.name));
    }
  }
  if (depth <= 0) return out;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'obj') {
      out.push(...findSolutionFiles(path.join(dir, e.name), depth - 1));
    }
  }
  return out;
}
