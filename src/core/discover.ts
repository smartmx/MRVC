/**
 * Project discovery: walk a directory tree and collect every folder that
 * is an MRS project. LEGALITY (user rule, 0.2.8 final): a project OPENS
 * through its `工程名.wvproj` marker, and the companion files `.project`
 * (parseable description) and `.cproject` (build configuration) must BOTH
 * be present — the legal root carries all three. Probe debris and
 * half-deleted folders missing any of them are not projects and must never
 * reach the tree (they previously crashed the loader with an ENOENT on the
 * missing .cproject). The same contract is enforced by ProjectStore
 * (single helper isLegalProjectRoot below). Pure Node — no vscode imports.
 */
import * as fs from 'fs';
import * as path from 'path';

/** EXAM-style trees nest projects several levels deep (e.g.
 * USB/USBHS/HOST_IAP/HOST_APP = 4), and a user may open a big folder whose
 * projects sit even deeper among unrelated files; 8 leaves headroom for
 * that without scanning entire drives. */
export const DEFAULT_DISCOVERY_DEPTH = 8;

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

/**
 * THE project legality condition over one directory's entries — the SINGLE
 * implementation behind BOTH entries (round7 §2): discovery's isProjectRoot
 * and the store-side isLegalProjectRoot must never drift apart again (the
 * round-2 split — discovery accepting what the loader rejected — started
 * exactly as a duplicated condition). Legal = the `工程名.wvproj` open
 * marker AND both companion files (.project description, .cproject build
 * configuration).
 */
function entriesAreLegalProject(entries: fs.Dirent[]): boolean {
  let marker = false;
  let project = false;
  let cproject = false;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const n = e.name.toLowerCase();
    if (n.endsWith('.wvproj')) marker = true;
    else if (e.name === '.project') project = true;
    else if (e.name === '.cproject') cproject = true;
  }
  return marker && project && cproject;
}

/** store-side entry point: reads the directory and applies the shared
 *  condition (add / restoreState / refreshWorkspace / watchers) */
export function isLegalProjectRoot(root: string): boolean {
  try {
    return entriesAreLegalProject(fs.readdirSync(root, { withFileTypes: true }));
  } catch {
    return false;
  }
}

function isProjectRoot(entries: fs.Dirent[]): boolean {
  return entriesAreLegalProject(entries);
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
