/**
 * Post-build static analysis (pure Node) — the open-source equivalent of
 * MRS2's analysis trio:
 *   Static stack usage — MRS2 runs a closed-source parser over the ELF;
 *   MRVC instead compiles with `-fstack-usage` (GCC-native) and aggregates
 *   the per-function `.su` files this module parses.
 *   Function call analysis — MRS2 dumps `-fdump-rtl-expand` files and
 *   converts them with perl/egypt into a dot graph; MRVC parses the same
 *   dump files directly (call sites appear as plain text there; see
 *   parseDumpCalls).
 *
 * A build with `analysisFlags()` emitted into buildDir produces:
 *   <file>.su        one "file:line:col:name TAB size TAB scope" record
 *                    per function
 *   *.c.*r.expand    RTL expand dumps (the file name carries the
 *                    GCC-version-specific pass number)
 */

export interface StackRecord {
  /** function name */
  name: string;
  /** static stack bytes for this function itself */
  size: number;
  /** source file the function is defined in */
  file: string;
  line: number;
  /** static (bounds-known) — GCC marks dynamic/unknown frames here */
  isStatic: boolean;
}

export interface CallEdge {
  caller: string;
  callee: string;
}

export interface AnalysisResult {
  stacks: StackRecord[];
  calls: CallEdge[];
  /** functions with dynamic stack frames (alloca / VLA) — bounds unknown */
  dynamic: string[];
  /** sum of own-size over all functions (per-function total, not a
   * worst-case path — MRS2 shows MaxStackSize from its closed-source
   * parser; MRVC reports the comparable per-function sum) */
  totalOwnStack: number;
}

/** parse one GCC .su line: "file:line:col:name TAB size TAB scope" */
export function parseSuLine(line: string): StackRecord | undefined {
  const tab = line.indexOf('\t');
  if (tab <= 0) return undefined;
  const loc = line.slice(0, tab);
  const rest = line.slice(tab + 1);
  const m = loc.match(/^(.*):(\d+):(\d+):(.+)$/);
  if (!m) return undefined;
  const parts = rest.split('\t');
  if (parts.length < 2) return undefined;
  const size = parseInt(parts[0], 10);
  if (!Number.isFinite(size)) return undefined;
  return {
    file: m[1],
    line: parseInt(m[2], 10),
    name: m[4],
    size,
    isStatic: parts[1] === 'static',
  };
}

/** aggregate every .su content into per-function stack records */
export function parseStackUsage(contents: string[]): StackRecord[] {
  const out: StackRecord[] = [];
  const seen = new Set<string>();
  for (const content of contents) {
    for (const line of content.split(/\r?\n/)) {
      const rec = parseSuLine(line);
      if (!rec) continue;
      const key = rec.name + '\x00' + rec.file;
      if (seen.has(key)) continue; // same function compiled in multiple TUs
      seen.add(key);
      out.push(rec);
    }
  }
  out.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  return out;
}

/** a human-readable report (opened by the Show commands) */
export function stackReport(records: StackRecord[]): string {
  const lines: string[] = [];
  lines.push('# MRVC Static Stack Usage');
  lines.push('');
  lines.push('Per-function static frames from -fstack-usage (build with analysis enabled).');
  lines.push('');
  lines.push('| Function | Size (B) | Static | Location |');
  lines.push('|---|---|---|---|');
  for (const r of records) {
    lines.push('| ' + r.name + ' | ' + r.size + ' | ' + (r.isStatic ? 'yes' : 'dynamic') + ' | ' + r.file + ':' + r.line + ' |');
  }
  const total = records.reduce((n, r) => n + r.size, 0);
  lines.push('');
  lines.push('Functions: ' + records.length + ', total own stack: ' + total + ' bytes.');
  const dyn = records.filter((r) => !r.isStatic);
  if (dyn.length) {
    lines.push('');
    lines.push('Dynamic frames (bounds unknown): ' + dyn.map((r) => r.name).join(', '));
  }
  return lines.join('\r\n') + '\r\n';
}

// RTL dump text markers (plain constants — no pattern literals)
const FUNC_HEADER_MARK = ';; Function ';
const CALL_WORD = 'call';
const QUOTE = '"';

/** word-boundary check for a marker inside a dump line */
function hasWord(line: string, word: string): boolean {
  let idx = line.indexOf(word);
  while (idx !== -1) {
    const before = idx === 0 ? ' ' : line[idx - 1];
    const after = idx + word.length >= line.length ? ' ' : line[idx + word.length];
    const boundaryBefore = !/[A-Za-z0-9_]/.test(before);
    const boundaryAfter = !/[A-Za-z0-9_]/.test(after);
    if (boundaryBefore && boundaryAfter) return true;
    idx = line.indexOf(word, idx + 1);
  }
  return false;
}

function unquote(s: string): string {
  return s.startsWith(QUOTE) && s.endsWith(QUOTE) ? s.slice(1, -1) : s;
}

/**
 * Extract the call graph from GCC RTL expand dumps. Caller sections start
 * with a ";; Function <name>" header; within a section, lines containing
 * the word "call" (whitespace-bounded) carry the callee as the first
 * quoted string.
 *
 * Real GCC (8 / 12 / 15 alike) writes the header as
 * `;; Function main (main, funcid=1)` — the bare function name is the
 * FIRST token; the parenthesised tail is GCC bookkeeping and must not
 * leak into the caller name (it would never match a .su record or the
 * UI's function list).
 */
export function parseDumpCalls(dump: string): CallEdge[] {
  const calls: CallEdge[] = [];
  let caller = '';
  const seen = new Set<string>();
  for (const line of dump.split(/\r?\n/)) {
    if (line.startsWith(FUNC_HEADER_MARK)) {
      const header = line.slice(FUNC_HEADER_MARK.length).match(/^\s*([^\s(]+)/);
      caller = header ? header[1] : '';
      continue;
    }
    if (!caller) continue;
    // RTL call lines open with "(call ..." — accept any non-alphanumeric
    // boundary around the word so tab-indented lines match too
    if (!hasWord(line, CALL_WORD)) continue;
    const first = line.indexOf(QUOTE);
    if (first === -1) continue;
    const last = line.indexOf(QUOTE, first + 1);
    if (last === -1) continue;
    const callee = unquote(line.slice(first, last + 1));
    const key = caller + '\x00' + callee;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ caller, callee });
  }
  return calls;
}

/** render the call edges as a sorted markdown list */
export function callReport(calls: CallEdge[]): string {
  const lines: string[] = [];
  lines.push('# MRVC Function Call Analysis');
  lines.push('');
  lines.push('Caller to callee edges from -fdump-rtl-expand dumps.');
  lines.push('');
  const byCaller = new Map<string, string[]>();
  for (const e of calls) {
    const list = byCaller.get(e.caller) ?? [];
    list.push(e.callee);
    byCaller.set(e.caller, list);
  }
  for (const caller of [...byCaller.keys()].sort()) {
    lines.push('- ' + caller + ' -> ' + byCaller.get(caller)!.sort().join(', '));
  }
  if (!byCaller.size) lines.push('(no call edges found)');
  return lines.join('\r\n') + '\r\n';
}

/** GCC flags that enable both analyses for one compilation */
export function analysisFlags(): string[] {
  return ['-fstack-usage', '-fdump-rtl-expand'];
}
