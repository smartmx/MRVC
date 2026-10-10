/**
 * File flag colors (MRS2 "Flag"/"Clear Flag" parity) — pure Node.
 *
 * Storage is MRS2-compatible ON PURPOSE: the same project opened in MRS2
 * and MRVC shares flags. MRS2 (ColorPreferManager) keeps them in
 * `<projectRoot>/.mrs/preferredColor.json` as
 *   { "details": [ { "logic_file": "<logic path>", "color": "<alias>" } ] }
 * (its in-memory form carries an extra abs_file which is stripped on
 * write; we accept it on read). logic_file is the CDT logic path — the
 * project-root-relative path with LINKED folders rooted at their link
 * name, exactly what the tree shows.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface MarkColor {
  alias: string;
  displayName: string;
  rgb: string;
}

/** the 20 colors MRS2's flag box offers — aliases and rgb verbatim from
 * MRS2's getSupportedColors() (extension.js); same set so flags made in
 * either IDE display identically */
export const MARK_COLORS: MarkColor[] = [
  { alias: 'Red', displayName: 'Red', rgb: '#ea878a' },
  { alias: 'Orange', displayName: 'Orange', rgb: '#f6b17f' },
  { alias: 'Peach', displayName: 'Peach', rgb: '#ffd266' },
  { alias: 'Green', displayName: 'Green', rgb: '#a1db9a' },
  { alias: 'Teal', displayName: 'Teal', rgb: '#97dcc5' },
  { alias: 'Olive', displayName: 'Olive', rgb: '#c1cea4' },
  { alias: 'Blue', displayName: 'Blue', rgb: '#8aaae0' },
  { alias: 'Purple', displayName: 'Purple', rgb: '#ac96db' },
  { alias: 'Maroon', displayName: 'Maroon', rgb: '#ce9bb3' },
  { alias: 'DarkSteel', displayName: 'Dark Steel', rgb: '#5a6885' },
  { alias: 'Gray', displayName: 'Gray', rgb: '#c3c3c3' },
  { alias: 'DarkRed', displayName: 'Dark Red', rgb: '#be2029' },
  { alias: 'DarkOrange', displayName: 'Dark Orange', rgb: '#ba530e' },
  { alias: 'DarkPeach', displayName: 'Dark Peach', rgb: '#b58512' },
  { alias: 'DarkGreen', displayName: 'Dark Green', rgb: '#3b8c31' },
  { alias: 'DarkTeal', displayName: 'Dark Teal', rgb: '#328b6f' },
  { alias: 'DarkOlive', displayName: 'Dark Olive', rgb: '#6a7942' },
  { alias: 'DarkBlue', displayName: 'Dark Blue', rgb: '#2d589d' },
  { alias: 'DarkPurple', displayName: 'Dark Purple', rgb: '#5c3da0' },
  { alias: 'DarkMaroon', displayName: 'Dark Maroon', rgb: '#91416a' },
];

export function markColorByAlias(alias: string): MarkColor | undefined {
  return MARK_COLORS.find((c) => c.alias.toLowerCase() === alias.toLowerCase());
}

/** VSCode ThemeColor closest to each flag color (FileDecoration can only
 * reference theme colors, not raw rgb) */
export function themeColorFor(alias: string): string {
  const a = alias.toLowerCase();
  if (a === 'red' || a === 'darkred' || a === 'darkmaroon' || a === 'maroon') return 'terminal.ansiRed';
  if (a === 'orange' || a === 'darkorange' || a === 'darkpeach' || a === 'peach' || a === 'olive' || a === 'darkolive') return 'terminal.ansiYellow';
  if (a === 'green' || a === 'darkgreen') return 'terminal.ansiGreen';
  if (a === 'teal' || a === 'darkteal') return 'terminal.ansiCyan';
  if (a === 'purple' || a === 'darkpurple') return 'terminal.ansiMagenta';
  if (a === 'gray' || a === 'darksteel') return 'terminal.ansiWhite';
  return 'terminal.ansiBlue';
}

const markFile = (projectRoot: string): string => path.join(projectRoot, '.mrs', 'preferredColor.json');

interface MarkDetails {
  details?: Array<{ logic_file?: string; abs_file?: string; color?: string }>;
}

export interface ColorMark {
  logicFile: string;
  color: string;
  /** absolute path, resolved against the linked folders when read from disk */
  absFile: string;
}

/** fold for win32 path/name comparison (mirrors ProjectStore.key) */
const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** resolve a logic path (LINK/x/y.c or src/main.c) to an absolute path.
 * Linked-folder lookup folds case on win32: MRS2-written logic_file may
 * spell the link name differently than the current .project link (hand
 * edits, renames) — a raw get would miss it and resolve to a nonexistent
 * project-root path, breaking display AND clear (the entry would stick). */
function resolveLogic(projectRoot: string, linkedFolders: Map<string, string>, logicFile: string): string {
  const segs = logicFile.split('/');
  const direct = linkedFolders.get(segs[0]);
  if (direct) return path.normalize(path.join(direct, ...segs.slice(1)));
  for (const [k, v] of linkedFolders) {
    if (fold(k) === fold(segs[0])) return path.normalize(path.join(v, ...segs.slice(1)));
  }
  return path.normalize(path.join(projectRoot, ...segs));
}

/** read all marks of one project (empty when the file is absent/broken) */
export function listMarks(projectRoot: string, linkedFolders: Map<string, string>): ColorMark[] {
  const out: ColorMark[] = [];
  let data: MarkDetails;
  try {
    // strip BOM: some editors save JSON with one — parse would fail and the
    // existing marks would be wiped by the next setMark
    data = JSON.parse(fs.readFileSync(markFile(projectRoot), 'utf-8').replace(/^\uFEFF/, '')) as MarkDetails;
  } catch {
    return out;
  }
  // legal JSON with the wrong shape (null, a number, truncated edits) must
  // degrade to "no marks" rather than throw into decoration refreshes
  if (!data || !Array.isArray(data.details)) return out;
  for (const d of data.details) {
    if (!d || !d.logic_file || !d.color) continue;
    out.push({
      logicFile: d.logic_file,
      color: d.color,
      absFile: d.abs_file ? path.normalize(d.abs_file) : resolveLogic(projectRoot, linkedFolders, d.logic_file),
    });
  }
  return out;
}

function writeMarks(projectRoot: string, details: Array<{ logic_file: string; color: string }>): void {
  const file = markFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // MRS2 write shape: logic path + color only (no abs_file)
  fs.writeFileSync(file, JSON.stringify({ details }), 'utf-8');
}

/** add/overwrite the flag of one file (replacing any previous color) */
export function setMark(projectRoot: string, linkedFolders: Map<string, string>, logicFile: string, color: string): void {
  const marks = listMarks(projectRoot, linkedFolders);
  const abs = resolveLogic(projectRoot, linkedFolders, logicFile);
  const key = fold(abs);
  const next = marks.filter((m) => fold(m.absFile) !== key);
  next.push({ logicFile, color, absFile: abs });
  writeMarks(
    projectRoot,
    next.map((m) => ({ logic_file: m.logicFile, color: m.color }))
  );
}

/** remove one file's flag (no-op when it has none) */
export function clearMark(projectRoot: string, linkedFolders: Map<string, string>, logicFile: string): void {
  const abs = resolveLogic(projectRoot, linkedFolders, logicFile);
  const key = fold(abs);
  const marks = listMarks(projectRoot, linkedFolders);
  const next = marks.filter((m) => fold(m.absFile) !== key);
  if (next.length === marks.length) return;
  writeMarks(
    projectRoot,
    next.map((m) => ({ logic_file: m.logicFile, color: m.color }))
  );
}
