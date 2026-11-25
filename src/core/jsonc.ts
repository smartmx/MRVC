/**
 * Pure JSONC (JSON-with-comments) surgical-edit primitives: offset-preserving
 * stripping plus value-span location over the stripped view. Extracted from
 * the vscode intellisense layer (round15 code-review H5) so the splice rules
 * are directly unit-testable in plain Node — these functions protect user
 * hand-edits in settings.json / c_cpp_properties.json and MUST never corrupt
 * them.
 *
 * Contract: every helper works on the STRIPPED text (comments blanked to
 * spaces, offsets preserved), and any helper that splits value spans takes
 * the trailingCommas map recorded by stripJsonc — a blanked TRAILING comma
 * must terminate the span it sits in, or the span swallows up to its closer
 * and a later splice silently erases the comma (and anything behind it).
 */

export interface ValueSpan {
  start: number;
  end: number; // exclusive
}

export function stripJsonc(raw: string, trailingCommas?: Map<number, number>): string {
  const out: string[] = [];
  let i = 0;
  let inStr = false;
  const blankTo = (end: number): void => {
    while (i < end) {
      out.push(raw[i] === '\n' || raw[i] === '\r' ? raw[i] : ' ');
      i++;
    }
  };
  if (raw.charCodeAt(0) === 0xfeff) {
    out.push(' '); // BOM -> whitespace: JSON.parse skips it, offsets stay
    i = 1;
  }
  while (i < raw.length) {
    const c = raw[i];
    if (inStr) {
      out.push(c);
      if (c === '\\') {
        out.push(raw[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out.push(c);
      i++;
      continue;
    }
    if (c === '/' && raw[i + 1] === '/') {
      let j = i;
      while (j < raw.length && raw[j] !== '\n') j++;
      blankTo(j);
      continue;
    }
    if (c === '/' && raw[i + 1] === '*') {
      let j = i + 2;
      while (j < raw.length && !(raw[j] === '*' && raw[j + 1] === '/')) j++;
      blankTo(Math.min(j + 2, raw.length));
      continue;
    }
    if (c === ',') {
      // trailing comma — the closer may sit behind whitespace or a comment
      let j = i + 1;
      while (j < raw.length) {
        if (/\s/.test(raw[j])) {
          j++;
          continue;
        }
        if (raw[j] === '/' && raw[j + 1] === '/') {
          while (j < raw.length && raw[j] !== '\n') j++;
          continue;
        }
        if (raw[j] === '/' && raw[j + 1] === '*') {
          j += 2;
          while (j + 1 < raw.length && !(raw[j] === '*' && raw[j + 1] === '/')) j++;
          j += 2;
          continue;
        }
        break;
      }
      if (raw[j] === '}' || raw[j] === ']') {
        // record where a trailing comma was blanked: the surgical splice
        // must NOT add a separator after it (the raw text still carries
        // the comma — adding ours would produce ", ," and a file that no
        // longer parses, permanently bricking the 'unreadable' sentinel).
        // The value is the comma's OWN container closer: a nested element's
        // trailing comma closes long before the array/object we splice into
        // and must never suppress that container's separator.
        if (trailingCommas) trailingCommas.set(i, j);
        out.push(' ');
        i++;
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

// ---- minimal offset arithmetic over stripped JSONC (comments are spaces;
// strings still need their own state so brackets inside them never count) ----

export function matchString(s: string, open: number): number {
  let i = open + 1;
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === '"') return i + 1;
    else i++;
  }
  return -1;
}

export function matchBracket(s: string, open: number): number {
  const closeCh = s[open] === '{' ? '}' : ']';
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      i = matchString(s, i);
      if (i < 0) return -1;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return c === closeCh ? i : -1;
    }
    i++;
  }
  return -1;
}

export function skipWs(s: string, p: number): number {
  while (p < s.length && /\s/.test(s[p])) p++;
  return p;
}

/** whitespace between the line start and pos (non-whitespace becomes spaces:
 * still a usable indent even when pos is not the first token of its line) */
export function indentOf(s: string, pos: number): string {
  const lineStart = s.lastIndexOf('\n', pos - 1) + 1;
  return s.slice(lineStart, pos).replace(/\S/g, '');
}

export function reindent(json: string, indent: string): string {
  const lines = json.split('\n');
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

/** does the raw file carry a trailing comma whose own container closes at
 * `closer`? (the splice layer checks this before adding a separator) */
export function hadTrailingCommaFn(trailingCommas: Map<number, number>, closer: number): boolean {
  for (const end of trailingCommas.values()) if (end === closer) return true;
  return false;
}

/** spans of the ROOT object's properties (key must be a string, value span
 * stops at the next same-depth comma or the root close). `trailingCommas`
 * MUST be the map stripJsonc recorded when the raw text carries trailing
 * commas: a blanked comma is whitespace on the stripped view, so without it
 * the LAST property's span swallows everything up to `close` — replacing
 * that span would erase the user's raw trailing comma (and any line-end
 * comment behind it), and a same-pass insert would then produce a
 * missing-separator file that no longer parses (round15 code-review H5). */
export function objectProps(s: string, trailingCommas?: Map<number, number>): Array<{ key: string; value: ValueSpan }> | null {
  const open = skipWs(s, 0);
  if (s[open] !== '{') return null;
  const close = matchBracket(s, open);
  if (close < 0) return null;
  const props: Array<{ key: string; value: ValueSpan }> = [];
  let p = skipWs(s, open + 1);
  while (p < close) {
    if (s[p] !== '"') return null;
    const kEnd = matchString(s, p);
    if (kEnd < 0) return null;
    let key: string;
    try {
      key = JSON.parse(s.slice(p, kEnd)) as string;
    } catch {
      return null;
    }
    const colon = skipWs(s, kEnd);
    if (s[colon] !== ':') return null;
    const vStart = skipWs(s, colon + 1);
    let depth = 0;
    let i = vStart;
    while (i < close) {
      const c = s[i];
      if (c === '"') {
        i = matchString(s, i);
        if (i < 0) return null;
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (depth === 0 && (c === ',' || trailingCommas?.has(i))) break;
      i++;
    }
    const vEnd = i < close ? i : close;
    props.push({ key, value: { start: vStart, end: vEnd } });
    p = skipWs(s, vEnd + 1); // past the separating comma
  }
  return props;
}

/** spans of an array's elements (between the brackets, split at depth-1
 * commas). A blanked TRAILING comma (recorded in trailingCommas) must also
 * terminate the last element's span: on the stripped view it is whitespace,
 * so without this the final element's span swallows everything up to the
 * closing bracket — replacing that span would silently erase the user's
 * raw trailing comma and any line-end comment sitting behind it. */
export function arrayElements(s: string, open: number, trailingCommas?: Map<number, number>): ValueSpan[] | null {
  if (s[open] !== '[') return null;
  const close = matchBracket(s, open);
  if (close < 0) return null;
  const spans: ValueSpan[] = [];
  let p = skipWs(s, open + 1);
  while (p < close) {
    let depth = 0;
    let i = p;
    while (i < close) {
      const c = s[i];
      if (c === '"') {
        i = matchString(s, i);
        if (i < 0) return null;
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (depth === 0 && (c === ',' || trailingCommas?.has(i))) break;
      i++;
    }
    const end = i < close ? i : close;
    spans.push({ start: p, end });
    p = skipWs(s, end + 1);
  }
  return spans;
}
