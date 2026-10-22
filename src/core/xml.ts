/**
 * Minimal XML DOM for .project / .cproject files — no runtime dependencies.
 * Supports: declaration, processing instructions, comments, elements,
 * attributes with entities, text content. Whitespace between elements is
 * recorded in `ws` arrays so serialization stays close to the original file.
 */

export class XElement {
  name: string;
  attrs: Record<string, string> = {};
  children: XElement[] = [];
  /** non-whitespace text content, if any */
  text = '';
  /** whitespace text recorded before each child element */
  ws: string[] = [];
  /**
   * Set while parsing when the source spelled this element as an explicit
   * open/close pair that held nothing (MRS2 writes empty `.project` elements as
   * `<projects>\r\n\t</projects>`; `ws[children.length]` holds that inner
   * whitespace). Serialization keeps that shape instead of normalizing to
   * `<projects/>` — collapsing it would rewrite 1,485 of the 2,687 sampled
   * .project files on any unrelated edit. An element that HAD children and was
   * emptied by an edit is not marked: there the previous `<x/>` output stands.
   */
  emptyPairInSource?: boolean;
  /**
   * Source spelled the self-closing tag with whitespace before the slash
   * (`<projects />` — 4 of the 2,609 sampled .project files do). Kept so a
   * rewrite does not silently re-spell a tag the edit did not touch.
   */
  selfCloseSpaced?: boolean;
  parent: XElement | null = null;

  constructor(name: string) {
    this.name = name;
  }

  attr(name: string): string | undefined {
    return this.attrs[name];
  }

  setAttr(name: string, value: string): void {
    this.attrs[name] = value;
  }

  child(name: string): XElement | undefined {
    return this.children.find((c) => c.name === name);
  }

  childrenNamed(name: string): XElement[] {
    return this.children.filter((c) => c.name === name);
  }

  /**
   * Append a programmatically created child. `ws[i]` is the whitespace BEFORE
   * child i, while `ws[children.length]` is the close-tag indent — so an
   * explicit empty slot is inserted for the newcomer. Without it a stale
   * close-tag entry ends up at the newcomer's index and is consumed as its
   * leading whitespace, which renders it one level too shallow and shifts the
   * close tag (seen when a list option's values are rewritten a second time).
   */
  append(child: XElement): XElement {
    this.ws.splice(this.children.length, 0, undefined as unknown as string);
    return this.appendParsed(child);
  }

  /**
   * Parser entry point: the whitespace preceding this child has already been
   * pushed onto `ws` (flushWs), so no slot is inserted here. Use `append()`
   * everywhere else.
   */
  appendParsed(child: XElement): XElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: XElement): void {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      // keep the recorded whitespace aligned with the children
      this.ws.splice(i, 1);
    }
  }

  /** insert at an index keeping `ws` aligned (no whitespace recorded for
   * the newcomer — serialization falls back to a fresh CRLF indent) */
  insertChild(child: XElement, index: number): void {
    child.parent = this;
    this.children.splice(index, 0, child);
    this.ws.splice(index, 0, undefined as unknown as string);
  }

  /** depth-first search for first element matching predicate */
  find(pred: (e: XElement) => boolean): XElement | undefined {
    for (const c of this.children) {
      if (pred(c)) return c;
      const r = c.find(pred);
      if (r) return r;
    }
    return undefined;
  }

  findAll(pred: (e: XElement) => boolean, out: XElement[] = []): XElement[] {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.findAll(pred, out);
    }
    return out;
  }
}

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&apos;': "'",
  '&#10;': '\n',
  '&#13;': '\r',
  '&#9;': '\t',
};

function decodeEntities(s: string): string {
  return s.replace(/&(quot|amp|lt|gt|apos|#x[0-9a-fA-F]+|#\d+);/g, (m, g: string) => {
    if (ENTITIES[m] !== undefined) return ENTITIES[m];
    // numeric entities, decimal and hex
    return String.fromCodePoint(parseInt(g.startsWith('#x') ? g.slice(2) : g.slice(1), g.startsWith('#x') ? 16 : 10));
  });
}

export function encodeAttrValue(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/\r/g, '&#xD;')
    .replace(/\n/g, '&#xA;')
    .replace(/\t/g, '&#x9;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Parse an XML document. The returned root is a synthetic element named
 * "#doc"; declarations/comments appear as children named "?xml"/"!--".
 */
export function parseXml(src: string): XElement {
  const root = new XElement('#doc');
  let i = 0;
  const n = src.length;
  const pendingWs: string[] = [];

  const stack: XElement[] = [root];
  const top = (): XElement => stack[stack.length - 1];
  // ws[i] must be the whitespace BEFORE children[i] — push unconditionally
  // (empty string when none) so ws.length === children.length stays true;
  // a compacted array shifts every later index and corrupts serialization
  const flushWs = () => {
    top().ws.push(pendingWs.join(''));
    pendingWs.length = 0;
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      // trailing content after the last tag: record pure-whitespace tails
      // (the file's final newline) so serialization keeps them
      const tail = src.slice(i);
      if (tail.length && !/\S/.test(tail)) pendingWs.push(tail);
      break;
    }
    const between = src.slice(i, lt);
    if (/\S/.test(between)) {
      // non-whitespace text: attach to currently open element
      if (stack.length > 1) {
        top().text += decodeEntities(between);
      }
    } else if (between.length) {
      pendingWs.push(between);
    }

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      flushWs();
      const c = new XElement('!--');
      c.text = src.slice(lt + 4, end < 0 ? n : end);
      top().appendParsed(c);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt);
      flushWs();
      const inner = src.slice(lt + 2, end < 0 ? n : end);
      const sp = inner.search(/\s/);
      const name = sp < 0 ? inner : inner.slice(0, sp);
      const c = new XElement('?' + name);
      c.text = sp < 0 ? '' : inner.slice(sp);
      top().appendParsed(c);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      const content = src.slice(lt + 9, end < 0 ? n : end);
      if (stack.length > 1) top().text += content; // raw, no entity decoding
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // regular tag
    const gt = findTagEnd(src, lt);
    if (gt < 0) break;
    const tagSrc = src.slice(lt + 1, gt);
    if (tagSrc.startsWith('/')) {
      const name = tagSrc.slice(1).trim();
      if (stack.length > 1) {
        // lenient recovery: pop to the matching open tag even when inner
        // elements were left unclosed — keeps the tree depth correct
        // instead of silently nesting everything one level deeper
        const idx = stack.map((e) => e.name).lastIndexOf(name);
        if (idx > 0) {
          const closedEl = stack[idx];
          // an explicit pair that held nothing: remember the source shape
          if (!closedEl.children.length && !closedEl.text) closedEl.emptyPairInSource = true;
          flushWs();
          stack.length = idx;
        }
      }
      i = gt + 1;
      continue;
    }
    const selfClose = tagSrc.endsWith('/');
    const nameAndAttrs = selfClose ? tagSrc.slice(0, -1) : tagSrc;
    const m = nameAndAttrs.match(/^([^\s/>]+)([\s\S]*)$/);
    if (!m) {
      i = gt + 1;
      continue;
    }
    const el = new XElement(m[1]);
    if (selfClose && /\s$/.test(tagSrc.slice(0, -1))) el.selfCloseSpaced = true;
    parseAttrs(m[2], el);
    flushWs();
    top().appendParsed(el);
    if (!selfClose) {
      stack.push(el);
    }
      i = gt + 1;
  }
  // file-level trailing whitespace recorded on #doc (top() === root when
  // every element closed properly)
  flushWs();
  return root;
}

function findTagEnd(src: string, from: number): number {
  let inQuote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"') {
      inQuote = '"';
    } else if (ch === "'") {
      inQuote = "'";
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseAttrs(s: string, el: XElement): void {
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const m of s.matchAll(re)) {
    el.attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
}

function encodeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * Serialize back to XML, preserving the original inter-element whitespace
 * recorded during parse. Newly created children (no ws entry) get a tab.
 */
export function serializeXml(el: XElement, depth = 0): string {
  if (el.name === '#doc') {
    // preserve document-level whitespace (the newline after the declaration,
    // trailing newline) so rewrites stay byte-faithful at the file edges
    let out = '';
    for (let idx = 0; idx < el.children.length; idx++) {
      if (el.ws[idx] !== undefined) out += el.ws[idx];
      out += serializeXml(el.children[idx], depth);
    }
    if (el.ws[el.children.length] !== undefined) out += el.ws[el.children.length];
    return out;
  }
  if (el.name === '!--') {
    return `<!--${el.text}-->`;
  }
  if (el.name.startsWith('?')) {
    return `<?${el.name.slice(1)}${el.text}?>`;
  }
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => ` ${k}="${encodeAttrValue(v)}"`)
    .join('');
  if (!el.children.length && !el.text) {
    if (el.emptyPairInSource) {
      // keep the open/close shape the source used (see emptyPairInSource);
      // the recorded whitespace is the close-tag indent
      const inner = el.ws[el.children.length] !== undefined ? el.ws[el.children.length] : '';
      return `<${el.name}${attrs}>${inner}</${el.name}>`;
    }
    return `<${el.name}${attrs}${el.selfCloseSpaced ? ' ' : ''}/>`;
  }
  if (!el.children.length) {
    return `<${el.name}${attrs}>${encodeText(el.text)}</${el.name}>`;
  }
  let out = `<${el.name}${attrs}>`;
  // mixed content (text + element children, e.g. a hand-written comment
  // inside <name>My <!--note--> Proj</name>): the parse keeps the text on
  // el.text — dropping it here would silently erase it on rewrite
  if (el.text !== '') {
    out += encodeText(el.text);
  }
  for (let idx = 0; idx < el.children.length; idx++) {
    const ws = el.ws[idx];
    if (ws !== undefined) {
      out += ws;
    } else if (idx > 0 || el.text === '') {
      // newly created children: CRLF + one tab per depth, matching the
      // MRS/CDT file convention
      out += '\r\n' + '\t'.repeat(depth + 1);
    }
    out += serializeXml(el.children[idx], depth + 1);
  }
  if (el.ws[el.children.length] !== undefined) {
    out += el.ws[el.children.length];
  } else {
    // keep the closing tag on its own line for freshly appended children
    out += '\r\n' + '\t'.repeat(depth);
  }
  out += `</${el.name}>`;
  return out;
}
