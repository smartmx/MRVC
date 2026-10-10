/**
 * Macro-definition parsing/merging for the batch-edit page (pure Node).
 *
 * A macro line is `NAME=VALUE` or a bare `NAME` (empty value) — the exact
 * rules of the properties page's macroConflicts: split on lines, trim,
 * ignore empty lines, split on the FIRST '=', case-SENSITIVE names.
 * Storage in .cproject is one `NAME=VALUE` string per listOptionValue.
 */
export interface MacroToken {
  name: string;
  value: string;
}

export function parseMacroLines(text: string): MacroToken[] {
  const out: MacroToken[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    out.push(eq < 0 ? { name: t, value: '' } : { name: t.slice(0, eq).trim(), value: t.slice(eq + 1).trim() });
  }
  return out;
}

/** serialize tokens back to textarea text — test-only today (the page
 * starts with empty textareas); kept as the inverse of parseMacroLines */
export function macroListToText(tokens: MacroToken[]): string {
  return tokens.map((m) => (m.value ? `${m.name}=${m.value}` : m.name)).join('\n');
}

/**
 * Same-name different-value conflicts ACROSS the three editor panes (the
 * properties page checks the same three lists before its save). Returns
 * one human-readable line per deviation, prefixed with the pane label.
 */
export function macroNameConflicts(
  panes: Array<{ label: string; text: string }>
): string[] {
  const seen = new Map<string, { value: string; label: string }>();
  const conflicts: string[] = [];
  for (const pane of panes) {
    for (const m of parseMacroLines(pane.text)) {
      const prev = seen.get(m.name);
      if (prev && prev.value !== m.value) {
        conflicts.push(`${m.name}: ${prev.label} = "${prev.value || '(no value)'}"  vs  ${pane.label} = "${m.value || '(no value)'}"`);
      } else if (!prev) {
        seen.set(m.name, { value: m.value, label: pane.label });
      }
    }
  }
  return conflicts;
}

/**
 * Cross-project union of one pane's stored macro strings: dedupe by the
 * whole NAME=VALUE string, keep first-seen order. Same name with different
 * values in different projects surfaces as parallel entries — the
 * disagreement the stats/summary display is built on (macroStats consumes
 * this; export kept for tooling).
 */
export function unionMacroLists(storedLists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of storedLists) {
    for (const entry of list) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/** per-pane statistics for the column header */
export function macroStats(storedLists: string[][]): { names: number; divergent: number } {
  const union = unionMacroLists(storedLists);
  const byName = new Map<string, Set<string>>();
  for (const entry of union) {
    const eq = entry.indexOf('=');
    const name = eq < 0 ? entry : entry.slice(0, eq);
    let set = byName.get(name);
    if (!set) {
      set = new Set();
      byName.set(name, set);
    }
    set.add(entry);
  }
  let divergent = 0;
  for (const set of byName.values()) if (set.size > 1) divergent++;
  return { names: byName.size, divergent };
}

export interface MergeResult {
  /** the merged stored strings (NAME=VALUE), ready for setOptionList */
  list: string[];
  /** existing entries whose value was rewritten in place */
  updated: number;
  /** targets appended because the project lacked them (addMissing only) */
  added: number;
}

/**
 * Merge the pane's target macros into one project's stored list.
 * NOT a whole-list replace: entries the targets don't mention stay
 * verbatim (projects keep their private macros); a mentioned name is
 * rewritten IN PLACE (order preserved, bare<->valued switches allowed);
 * unmentioned names are appended only when `addMissing` is on.
 * Matching is by exact, case-sensitive name (first '=' split).
 */
export function mergeMacroList(existing: string[], targets: MacroToken[], addMissing: boolean): MergeResult {
  const targetByName = new Map<string, string>();
  for (const t of targets) targetByName.set(t.name, t.value);
  const touched = new Set<string>();
  const list: string[] = [];
  let updated = 0;
  for (const entry of existing) {
    const eq = entry.indexOf('=');
    const name = eq < 0 ? entry : entry.slice(0, eq);
    const value = targetByName.get(name);
    if (value === undefined) {
      list.push(entry); // not mentioned — keep verbatim
      continue;
    }
    touched.add(name);
    const next = value ? `${name}=${value}` : name;
    if (next !== entry) updated++;
    list.push(next);
  }
  let added = 0;
  if (addMissing) {
    for (const t of targets) {
      if (touched.has(t.name)) continue;
      list.push(t.value ? `${t.name}=${t.value}` : t.name);
      touched.add(t.name);
      added++;
    }
  }
  return { list, updated, added };
}
