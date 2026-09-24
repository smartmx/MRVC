/**
 * MRS solution (.wvsln) parser — a line-based text file that groups several
 * standard MRS projects (CH32H417 EVT style, multi-core V3F/V5F).
 *
 * Line kinds (mirrors MRS2's own lenient parsing):
 *   -`-key:value`            toolchain config (-arm/-build/-openocd/-rv),
 *                            `${eclipse_home}` = MRS2 install dir — skipped
 *   -`<path>.wvsln:`         header line written by MRS2's export — skipped
 *   -`BuildOrder=n1,n2`      build order by project NAME (absent names later)
 *   -anything else non-empty member project path, absolute or relative to
 *                            the solution dir, `/` or `\` separators
 *
 * Real-world files contain stale absolute entries (author-machine paths)
 * and duplicates of the same project — resolution dedupes (case-insensitive
 * on Windows, like the fs) and flags non-existing paths. Pure Node.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface SolutionEntry {
  /** line as written in the file */
  raw: string;
  /** absolute directory after resolving relative entries */
  resolved: string;
  /** directory exists on disk */
  exists: boolean;
}

export interface ParsedSolution {
  dir: string;
  /** verbatim `-key:value` toolchain lines */
  configLines: string[];
  /** project names from BuildOrder=, or undefined when the line is absent */
  buildOrder: string[] | undefined;
  /** member entries in file order, deduped (case-insensitive on win32) */
  entries: SolutionEntry[];
  /** deduped entries whose directory does not exist */
  dropped: SolutionEntry[];
}

const CASE_FOLD = process.platform === 'win32';

/** toolchain lines MRS2 itself writes; `${eclipse_home}` = its install dir */
const TOOLCHAIN_LINES = [
  '-arm:${eclipse_home}\\toolchain\\arm-none-eabi-gcc\\bin',
  '-build:${eclipse_home}\\toolchain\\Build Tools\\bin',
  '-openocd name:openocd.exe',
  '-openocd path:${eclipse_home}\\toolchain\\OpenOCD\\bin',
  '-rv:${eclipse_home}\\toolchain\\RISC-V Embedded GCC\\bin',
];

/**
 * Write a .wvsln grouping the given project roots — the inverse of
 * parseSolution. Member paths are relative to the .wvsln FILE treated as
 * the base "directory" (path.relative(file, root)), which makes them start
 * with `..\` exactly like MRS2's own files; a plain `X\Y` line would
 * resolve BESIDE the file name and miss. Backslash separators, CRLF;
 * projects that cannot be expressed relatively (other drive) fall back to
 * absolute lines.
 */
export function writeSolution(file: string, projectRoots: string[]): void {
  const lines: string[] = [...TOOLCHAIN_LINES];
  for (const root of projectRoots) {
    let line = path.relative(file, root);
    if (!line || path.isAbsolute(line)) line = root; // cross-drive etc.
    lines.push(line.split(path.sep).join('\\'));
  }
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf-8');
}

export function parseSolution(file: string): ParsedSolution {
  const dir = path.dirname(file);
  const raw = fs.readFileSync(file, 'utf-8');
  const configLines: string[] = [];
  let buildOrder: string[] | undefined;
  const seen = new Set<string>();
  const entries: SolutionEntry[] = [];
  const dropped: SolutionEntry[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('-')) {
      configLines.push(t);
      continue;
    }
    if (/\.wvsln:/i.test(t)) continue; // export header
    if (t.startsWith('BuildOrder=')) {
      buildOrder = t
        .substring('BuildOrder='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    // MRS2 resolves relative member paths against the .wvsln FILE path, not
    // its directory — EVT files write `..\V3F` meaning "V3F beside the file"
    const resolved = path.isAbsolute(t) ? path.normalize(t) : path.resolve(file, t);
    const key = CASE_FOLD ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: SolutionEntry = { raw: t, resolved, exists: fs.existsSync(resolved) };
    if (entry.exists) entries.push(entry);
    else dropped.push(entry);
  }
  return { dir, configLines, buildOrder, entries, dropped };
}
