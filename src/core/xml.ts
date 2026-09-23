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

  append(child: XElement): XElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: XElement): void {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
    }
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
  return s.replace(/&(quot|amp|lt|gt|apos|#10|#13|#9);/g, (m) => ENTITIES[m]);
}

export function encodeAttrValue(s: string): string {
  return s
    .replace(/&/g, '&amp;')
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
  const flushWs = () => {
    if (pendingWs.length) {
      top().ws.push(pendingWs.join(''));
      pendingWs.length = 0;
    }
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
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
      top().append(c);
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
      top().append(c);
      i = end < 0 ? n : end + 2;
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
      if (stack.length > 1 && stack[stack.length - 1].name === name) {
        flushWs();
        // trailing whitespace inside the element belongs after its last child
        stack.pop();
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
    parseAttrs(m[2], el);
    flushWs();
    top().append(el);
    if (!selfClose) {
      stack.push(el);
    }
    i = gt + 1;
  }
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
    return el.children.map((c) => serializeXml(c, depth)).join('');
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
    return `<${el.name}${attrs}/>`;
  }
  if (!el.children.length) {
    return `<${el.name}${attrs}>${encodeText(el.text)}</${el.name}>`;
  }
  let out = `<${el.name}${attrs}>`;
  for (let idx = 0; idx < el.children.length; idx++) {
    const ws = el.ws[idx];
    if (ws !== undefined) {
      out += ws;
    } else if (idx > 0 || el.text === '') {
      out += '\n\t';
      if (depth > 0) out += '\t'.repeat(depth);
    }
    out += serializeXml(el.children[idx], depth + 1);
  }
  if (el.ws[el.children.length] !== undefined) {
    out += el.ws[el.children.length];
  }
  out += `</${el.name}>`;
  return out;
}
