/**
 * Preprocessor consistency within ONE project (0.3.3, user request).
 *
 * The C / C++ / Assembler preprocessor define lists may define the SAME
 * macro with DIFFERENT values — legal per-compiler (each tool gets its own
 * -D list) but almost always a mistake: C and C++ translation units then
 * disagree about feature gates / layout switches while ASM sees a third
 * variant. Detection feeds the unify flow in vscode/ppCheck.
 *
 * Comparison is RAW, the exact semantics of the properties page's
 * macroConflicts save gate: `FOO` (bare) and `FOO=1` count as DIFFERENT —
 * that page already second-confirms the pair at Apply time, and this
 * checker must not disagree with it. Same-name duplicates inside ONE list
 * follow GCC: the last entry wins.
 */
import { Cproject } from './cproject';

export type PpTool = 'c' | 'cpp' | 'asm';

/** the three preprocessor define lists, in properties-page order */
export const PP_DEFINE_SUFFIXES: ReadonlyArray<readonly [PpTool, string]> = [
  ['c', 'c.compiler.defs'],
  ['cpp', 'cpp.compiler.defs'],
  ['asm', 'assembler.defs'],
];

export interface PpOccurrence {
  tool: PpTool;
  /** the stored entry trimmed verbatim ("FOO" / "FOO=1") */
  raw: string;
  /** the value part of the entry ('' for a bare NAME) */
  value: string;
}

export interface PpDivergence {
  name: string;
  /** one occurrence per list the macro appears in, page order */
  occurrences: PpOccurrence[];
}

function splitEntry(raw: string): { name: string; value: string; raw: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const eq = t.indexOf('=');
  const name = (eq < 0 ? t : t.slice(0, eq)).trim();
  if (!name) return null;
  return { name, value: eq < 0 ? '' : t.slice(eq + 1).trim(), raw: t };
}

/** macros whose value differs between the lists that define them, sorted
 *  by name — [] when the three preprocessors agree */
export function ppDivergences(cp: Cproject): PpDivergence[] {
  const byTool = new Map<PpTool, Map<string, PpOccurrence>>();
  const names = new Set<string>();
  for (const [tool, suffix] of PP_DEFINE_SUFFIXES) {
    const m = new Map<string, PpOccurrence>();
    for (const raw of cp.listOption(suffix).values) {
      const s = splitEntry(raw);
      if (!s) continue;
      m.set(s.name, { tool, raw: s.raw, value: s.value }); // last entry wins
      names.add(s.name);
    }
    byTool.set(tool, m);
  }
  const out: PpDivergence[] = [];
  for (const name of [...names].sort()) {
    const occ: PpOccurrence[] = [];
    for (const [tool] of PP_DEFINE_SUFFIXES) {
      const o = byTool.get(tool)?.get(name);
      if (o) occ.push(o);
    }
    if (occ.length >= 2 && new Set(occ.map((o) => o.value)).size > 1) {
      out.push({ name, occurrences: occ });
    }
  }
  return out;
}
