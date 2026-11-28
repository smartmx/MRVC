/**
 * Pure-Node cursor target extraction, local label / linker-script / include
 * resolution, and multi-project workspace-symbol ranking for .s/.S
 * navigation (0.3.8). Zero dependency on `vscode` so every function stays
 * unit-testable in plain Node (tools/asmnav-test.js).
 *
 * The provider bridges cpptools' workspace symbols (`main`, `SystemInit`,
 * handlers...) into assembly files, which cpptools does not serve itself:
 * it only registers definition providers for c/cpp/cuda-cpp, never for the
 * mrvc-qingke language mode MRVC opts .s/.S into.
 */
import * as fs from 'fs';
import * as path from 'path';
import { foldPathOnPlatform } from './cproject';

export interface TextPos {
  line: number; // 0-based
  col: number; // 0-based
}

export interface FileTarget {
  file: string;
  line: number;
  col: number;
}

export type CursorTarget =
  | { kind: 'include'; spec: string }
  | { kind: 'numeric-label'; label: string; dir: 'b' | 'f' }
  | { kind: 'symbol'; name: string };

/** ABI registers and zero-operand mnemonics that must never trigger a
 * symbol lookup when the cursor rests on them */
const SKIP_WORDS = new Set([
  'zero', 'ra', 'sp', 'gp', 'tp', 'fp',
  't0', 't1', 't2', 't3', 't4', 't5', 't6',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11',
  'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
  'ft0', 'ft1', 'ft2', 'ft3', 'ft4', 'ft5', 'ft6', 'ft7', 'ft8', 'ft9', 'ft10', 'ft11',
  'fs0', 'fs1', 'fs2', 'fs3', 'fs4', 'fs5', 'fs6', 'fs7', 'fs8', 'fs9', 'fs10', 'fs11',
  'fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7',
  'nop', 'ret', 'mret', 'sret', 'wfi', 'ecall', 'ebreak', 'fence',
]);

/** Return true if `col` lies inside a `#` or `//` comment on `line`. A `#`
 * that OPENS a C-preprocessor directive (#include/#define/...) is NOT a
 * comment — .S files run through cpp and those lines carry navigable
 * includes. (Block comments are handled at the document level by
 * isInBlockComment — a single line cannot know whether an earlier line
 * opened a banner that is still open.) */
export function isInLineComment(line: string, col: number): boolean {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < Math.min(col, line.length); i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (
      c === '#' &&
      !/^[ \t]*#[ \t]*(?:include|include_next|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|line|error|warning)\b/.test(line)
    ) {
      return true;
    }
    if (c === '/' && line[i + 1] === '/') return true;
  }
  return false;
}

/** Return true if the offset lies inside a `/* ... *`+`/` block comment in
 * `docText` (review M3: WCH startup banners span many lines and a cursor on
 * "main" inside them must not fire a workspace-symbol query). A line-based
 * check cannot see banners opened by EARLIER lines, so this walks the
 * document text up to the offset — O(n) over a small source file, once per
 * F12. */
export function isInBlockComment(docText: string, offset: number): boolean {
  let depth = 0;
  let i = 0;
  const end = Math.min(offset, docText.length);
  while (i < end) {
    if (docText.startsWith('/*', i)) {
      depth++;
      i += 2;
      continue;
    }
    if (depth > 0 && docText.startsWith('*/', i)) {
      depth--;
      i += 2;
      continue;
    }
    i++;
  }
  return depth > 0;
}

/** Extract the navigation target under `(line, col)`, or null if the cursor
 * rests on nothing navigable (comment, number, register, zero-operand
 * mnemonic) */
export function extractAsmCursorTarget(line: string, col: number): CursorTarget | null {
  if (isInLineComment(line, col)) return null;

  const inc = line.match(/^[ \t]*(?:#[ \t]*include(?:_next)?|\.include)[ \t]+["<]([^">]+)[">]/);
  if (inc) {
    const start = line.indexOf(inc[1]);
    if (start >= 0 && col >= start - 1 && col <= start + inc[1].length + 1) {
      return { kind: 'include', spec: inc[1] };
    }
  }

  // '.' is part of GNU-as identifiers: local labels are written `.Lloop`,
  // and a token split at the dot ("Lloop" out of ".Lloop") never matches the
  // real `.Lloop:` label — or worse, matches an unrelated bare `Lloop`
  // (review: .L* labels were unfindable by name)
  const isIdent = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_$.]/.test(ch);
  let s = col;
  let e = col;
  if (!isIdent(line[s]) && s > 0 && isIdent(line[s - 1])) s--;
  if (!isIdent(line[s])) return null;
  while (s > 0 && isIdent(line[s - 1])) s--;
  while (e < line.length && isIdent(line[e])) e++;
  const word = line.slice(s, e);

  const numRef = word.match(/^([0-9]+)([bf])$/);
  if (numRef) return { kind: 'numeric-label', label: numRef[1], dir: numRef[2] as 'b' | 'f' };

  if (/^(?:0[xXbB][0-9a-fA-F]+|[0-9]+)$/.test(word)) return null;
  if (/^[xfv](?:[0-9]|[12][0-9]|3[01])$/i.test(word)) return null;
  if (SKIP_WORDS.has(word.toLowerCase())) return null;

  return { kind: 'symbol', name: word };
}

/** Find local label, `.equ`/`.set`/`.equiv`/`.eqv`, or `#define` definitions
 * of `target` in a single assembly text. GAS numeric labels (`1b`/`1f`)
 * search from the cursor in their direction only; a named symbol skips the
 * cursor line itself so a `.weak` alias never jumps to its own line.
 * `cursorCol` (optional) refines the BACKWARD numeric search: a definition
 * on the reference's own line counts when it lies strictly before the
 * reference — the legal one-liner `1: j 1b` must resolve to THIS line's
 * `1:`, not to an earlier one (review P3). */
export function findLocalAsmDefinitions(
  docText: string,
  target: Extract<CursorTarget, { kind: 'numeric-label' | 'symbol' }>,
  cursorLine: number,
  cursorCol = -1
): TextPos[] {
  const lines = docText.split(/\r?\n/);

  if (target.kind === 'numeric-label') {
    const re = new RegExp(`^[ \\t]*(${target.label}):(?!:)`);
    const step = target.dir === 'b' ? -1 : 1;
    if (target.dir === 'b' && cursorCol >= 0) {
      const same = lines[cursorLine]?.match(re);
      if (same) {
        const defEnd = (same.index ?? 0) + same[0].length;
        if (defEnd < cursorCol) return [{ line: cursorLine, col: lines[cursorLine].indexOf(same[1]) }];
      }
    }
    for (let i = cursorLine + step; i >= 0 && i < lines.length; i += step) {
      const m = lines[i].match(re);
      if (m) return [{ line: i, col: lines[i].indexOf(m[1]) }];
    }
    return [];
  }

  const esc = target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelRe = new RegExp(`^[ \\t]*(${esc}):(?!:)`);
  const equRe = new RegExp(`^[ \\t]*\\.(?:equ|set|equiv|eqv)[ \\t]+(${esc})\\b`);
  const defRe = new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+(${esc})\\b`);
  const hits: TextPos[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === cursorLine) continue;
    const m = lines[i].match(labelRe) || lines[i].match(equRe) || lines[i].match(defRe);
    if (m) {
      // the column must come from INSIDE the matched text: `.equ eq, 1`
      // would otherwise find the substring "eq" at offset 1 — inside the
      // ".equ" keyword itself (review M2)
      hits.push({ line: i, col: (m.index ?? 0) + m[0].lastIndexOf(m[1]) });
    }
  }
  return hits;
}

/** Locate symbol assignments (`sym = ...` / `PROVIDE(sym = .)` /
 * `PROVIDE_HIDDEN(...)`) in a GNU ld script. Block comments are blanked
 * first (newlines preserved so line numbers stay true). */
export function findLinkerScriptSymbol(ldFile: string, symbol: string): FileTarget | null {
  let raw: string;
  try {
    raw = fs.readFileSync(ldFile, 'utf-8');
  } catch {
    return null;
  }
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '));
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:\\bPROVIDE(?:_HIDDEN)?[ \\t]*\\([ \\t]*|^[ \\t]*)(${esc})[ \\t]*=(?!=)`);
  const lines = clean.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      // locate the symbol inside the MATCHED text (`PROVIDE(OV = .)` must
      // not report the "OV" substring of the PROVIDE keyword — review M2)
      const col = (m.index ?? 0) + m[0].lastIndexOf(m[1]);
      return { file: ldFile, line: i, col: Math.max(0, col) };
    }
  }
  return null;
}

/** Resolve an `#include` / `.include` spec against the current file's own
 * directory first, then the project's assembler/C include dirs (`-I`,
 * `-isystem`) */
export function resolveIncludeFile(spec: string, currentFile: string, includeDirs: readonly string[]): string | null {
  const candidates = [path.join(path.dirname(currentFile), spec), ...includeDirs.map((d) => path.join(d, spec))];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
    } catch {
      // ignore unreadable candidate
    }
  }
  return null;
}

export interface WorkspaceSymbolCandidate {
  name: string;
  file: string;
  line: number;
  col: number;
  kindTag: 'function' | 'variable' | 'other';
}

/** cpptools' workspace symbols name functions WITH their parameter list
 * (`SystemInit(void)`, `main(int, char **)`) to distinguish overloads —
 * strip it so assembly's bare `SystemInit` matches. Class qualifiers are
 * KEPT: a member `Foo::SystemInit` must not answer an assembly call to the
 * global `SystemInit` (review H1). */
function bareSymbolName(raw: string): string {
  const paren = raw.indexOf('(');
  return (paren >= 0 ? raw.slice(0, paren) : raw).trim();
}

/** Filter exact matches, drop the cursor line's own hit (a `.weak` alias
 * must not jump to itself), de-duplicate, and rank owning-project C/C++
 * definitions first (EVT workspaces repeat `main`/`SystemInit`/handlers
 * across dozens of example projects — WCH's classic cross-project
 * mis-jump). */
export function rankWorkspaceSymbolCandidates(
  candidates: readonly WorkspaceSymbolCandidate[],
  symbol: string,
  opts: {
    currentFile: string;
    currentLine: number;
    projectFiles: ReadonlySet<string>;
    projectRoot?: string;
  }
): WorkspaceSymbolCandidate[] {
  const curKey = foldPathOnPlatform(path.resolve(opts.currentFile));
  const rootPrefix = opts.projectRoot ? foldPathOnPlatform(path.resolve(opts.projectRoot)) + path.sep : '';
  const isSource = (f: string): boolean => /\.(?:c|cc|cpp|cxx|cp|c\+\+)$/i.test(f);
  const isHeader = (f: string): boolean => /\.(?:h|hh|hpp|hxx)$/i.test(f);

  const score = (c: WorkspaceSymbolCandidate): number => {
    const fk = foldPathOnPlatform(path.resolve(c.file));
    const inProj = opts.projectFiles.has(fk) || (!!rootPrefix && fk.startsWith(rootPrefix));
    let s = inProj ? 100 : 0;
    if (isSource(c.file)) s += 30;
    else if (isHeader(c.file)) s += 10;
    if (c.kindTag === 'function' || c.kindTag === 'variable') s += 5;
    return s;
  };

  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      if (bareSymbolName(c.name) !== symbol) return false;
      const fk = foldPathOnPlatform(path.resolve(c.file));
      if (fk === curKey && c.line === opts.currentLine) return false;
      const dedup = `${fk}:${c.line}`;
      if (seen.has(dedup)) return false;
      seen.add(dedup);
      return true;
    })
    .sort((a, b) => score(b) - score(a));
}
