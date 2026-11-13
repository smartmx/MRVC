/**
 * Project-configuration audit & repair (pure Node).
 *
 * Born from the 2026-11-12 damage: the properties page deleted an enumerated
 * option's `value` attribute, and MRS's own reader crashed on it — the
 * project would not open in MRS2/MRS3 AT ALL. An audit pass walks the same
 * structures MRS reads and reports every deviation we know breaks (or can
 * break) the MRS project model; the repair applies only the findings that
 * have a safe, well-defined fix, backing each file up first.
 *
 * Findings (codes stable — they surface in messages):
 *   project-xml       .project/.cproject is not parseable XML        (report only)
 *   project-name      .project <name> differs from the folder name    (report only)
 *   enum-value-missing  enumerated <option> without a value attribute (fixable:
 *                     the element is REMOVED — CDT semantics: absent option
 *                     inherits the superClass default, and MRS's reader never
 *                     sees it, so the unguarded value.match() cannot crash)
 *   rvgcc-form        rvGcc option whose value is neither known form  (report only)
 *   template-address  .template Address is not 0x-formatted           (fixable: cleared,
 *                     the download then falls back to inference)
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseXml, XElement } from './xml';
import { Cproject } from './cproject';
import { readTemplate, templateSet } from './templateFile';
import { ADDRESS_RE } from './flash';

export type AuditCode = 'project-xml' | 'project-name' | 'enum-value-missing' | 'rvgcc-form' | 'template-address';

export interface AuditFinding {
  code: AuditCode;
  /** project-root-relative file the finding is about */
  file: string;
  /** human-readable detail (paths/ids raw; the caller localizes the frame) */
  detail: string;
  fixable: boolean;
  /** the option id, for enum-value-missing repair lookup */
  optionId?: string;
}

export interface AuditResult {
  findings: AuditFinding[];
}

/** strict validation of the RAW source: the bundled parser is lenient by
 *  design (it must round-trip MRS's odd spellings for the editors), so
 *  mismatched close tags / unclosed elements / trailing roots parse "fine"
 *  there and audit would report a healthy project while MRS/Eclipse's strict
 *  parser refuses the file (round-10 P2-3: a `</cconfiguration>` rewritten as
 *  `</broken>` audited clean).
 *
 *  The tag stack is not enough on its own (round-11 P2-2): non-whitespace text
 *  before/after the root and markup the token grid cannot consume (a bare
 *  `<`) are equally fatal to strict parsers yet invisible to a tag-only walk.
 *  Non-tag tokens obey their XML CONTEXT rules (round-12 P2) — skipping them
 *  unconditionally let trailing CDATA / DOCTYPE / a second XML declaration
 *  audit clean:
 *   - `<![CDATA[` only inside an element (never in prolog/epilog)
 *   - `<!DOCTYPE` only in the prolog, at most once (an internal subset is
 *     legal and its `<!ENTITY>` declarations are honoured)
 *   - `<?xml …?>` only as the document's first token
 *   - comments / PIs obey their own shapes; duplicate attributes never
 *  Character data and attribute values are validated too (round-13 P2):
 *  a bare `&`, an entity that is neither predefined nor declared in the
 *  DOCTYPE subset, a raw `<` in an attribute value and `]]>` in character
 *  data are all rejected. ANYWHERE in the document, only the XML 1.0 `Char`
 *  production is allowed (round-14 P2): raw NUL/control characters and
 *  numeric references such as `&#0;`, `&#xD800;` or `&#x110000;` are rejected.
 *  The caller reading the file must use `strictXmlFileError`, which also
 *  decodes UTF-8 FATALLY: `readFileSync(file,'utf-8')` turns invalid bytes
 *  into U+FFFD, and a later rewrite would silently destroy the originals.
 *  Anything the lenient parser tolerates and a standard XML parser refuses
 *  must surface here.
 *  The expected root name is checked here too. Returns undefined when the
 *  document is well-formed enough for a strict parser. Exported for the
 *  properties page's PRE-WRITE gate: Apply must never rewrite such a file. */
export function strictXmlStructureError(src: string, expectRoot: string): string | undefined {
  // XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
  const isXmlChar = (cp: number): boolean =>
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff);
  // a raw character outside the Char production is fatal anywhere in the
  // document (text, attributes, CDATA, comments, PIs) — for...of walks code
  // points, so a lone surrogate is caught too
  for (const ch of src) {
    const cp = ch.codePointAt(0)!;
    if (!isXmlChar(cp)) return `invalid XML character U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  const tokenRe =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE(?:[^>["']|"[^"]*"|'[^']*'|\[[\s\S]*?\])*>|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w.:_-]*)\s*>|<([A-Za-z_][\w.:_-]*)((?:\s+[\w.:_-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)\s*>/g;
  const stack: string[] = [];
  let rootClosed = false;
  let pos = 0;
  let firstToken = true;
  let sawDoctype = false;
  /** XML's predefined entities plus whatever the internal DTD subset declares */
  const predefined = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
  const declared = new Set<string>();
  const refRe = /&(?:#(\d+)|#x([0-9A-Fa-f]+)|([A-Za-z_][\w.:-]*));/g;
  /** every '&' must open a character reference or a predefined/declared
   *  entity — a bare '&' (AT&T) and an undeclared entity both reject; a
   *  well-shaped numeric reference is only legal when its CODE POINT is an
   *  XML Char (`&#0;`, surrogates, noncharacters and >10FFFF reject) */
  const entityError = (text: string, where: string): string | undefined => {
    let badRef: string | undefined;
    let undeclared: string | undefined;
    text.replace(refRe, (m, dec?: string, hex?: string, name?: string) => {
      if (dec !== undefined || hex !== undefined) {
        const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
        if (!isXmlChar(cp)) badRef = m;
        return '';
      }
      if (name && !predefined.has(name) && !declared.has(name)) undeclared = name;
      return '';
    });
    if (badRef) return `invalid character reference ${badRef} in ${where}`;
    if (undeclared) return `undeclared entity &${undeclared}; in ${where}`;
    if (text.replace(refRe, '').includes('&')) return `bare "&" in ${where}`;
    return undefined;
  };
  /** the chunk between two tokens: whitespace outside the root, character
   *  data inside an element — and never a stray '<' */
  const gapError = (gap: string): string | undefined => {
    if (gap.includes('<')) return `unparsed markup near "${gap.trim().slice(0, 40)}"`;
    if (stack.length === 0) {
      if (gap.trim() !== '') return rootClosed ? 'text after the root element closed' : 'text before the root element';
      return undefined;
    }
    if (gap.includes(']]>')) return 'character data must not contain "]]>"';
    return entityError(gap, 'character data');
  };
  for (const m of src.matchAll(tokenRe)) {
    const gap = src.slice(pos, m.index);
    pos = m.index! + m[0].length;
    const g = gapError(gap);
    if (g) return g;
    const token = m[0];
    const isFirst = firstToken;
    firstToken = false;
    if (token.startsWith('<?')) {
      // a PI has a target Name and ends with '?>'; target "xml" (any case)
      // IS the declaration — first token of the document only, never inside
      // an element, never after the root. Other PIs are legal in the prolog,
      // the epilog and element content.
      if (!/^<\?[A-Za-z_][\w.:-]*(?:\s[\s\S]*?)?\?>$/.test(token)) return 'invalid processing instruction';
      if (/^<\?xml(?:\s|\?>)/i.test(token) && !isFirst) return 'XML declaration is not at the start of the document';
      continue;
    }
    if (token.startsWith('<!DOCTYPE')) {
      if (stack.length > 0) return 'DOCTYPE inside an element';
      if (rootClosed) return 'DOCTYPE after the root element closed';
      if (sawDoctype) return 'duplicate DOCTYPE';
      sawDoctype = true;
      // an internal subset is legal and may DECLARE entities the document uses
      const subset = token.match(/\[[\s\S]*\]/);
      if (subset) for (const em of subset[0].matchAll(/<!ENTITY\s+([A-Za-z_][\w.:-]*)/g)) declared.add(em[1]);
      continue;
    }
    if (token.startsWith('<![CDATA[')) {
      if (stack.length === 0) return rootClosed ? 'CDATA after the root element closed' : 'CDATA outside the root element';
      continue;
    }
    if (token.startsWith('<!--')) {
      // "--" is forbidden inside a comment, and it must not end with '-'
      const inner = token.slice(4, -3);
      if (inner.includes('--') || inner.endsWith('-')) return 'XML comments must not contain "--"';
      continue;
    }
    const [, closeName, openName, attrs, selfClose] = m;
    if (closeName !== undefined) {
      const top = stack.pop();
      if (top === undefined) return `stray closing tag </${closeName}>`;
      if (top !== closeName) return `<${top}> closed by </${closeName}>`;
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    // attributes: no duplicates (id/value included); no raw '<'; every '&'
    // must be a valid reference — all of these are strict-parser rejections
    if (attrs) {
      const seen = new Set<string>();
      for (const am of attrs.matchAll(/([\w.:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const name = am[1];
        if (seen.has(name)) return `duplicate attribute "${name}" on <${openName}>`;
        seen.add(name);
        const value = am[2] ?? am[3] ?? '';
        if (value.includes('<')) return `raw "<" in the value of attribute "${name}"`;
        const e = entityError(value, `attribute "${name}"`);
        if (e) return e;
      }
    }
    if (rootClosed) return 'content after the root element closed';
    if (stack.length === 0) {
      // document level: this must be THE expected root
      if (openName !== expectRoot) return `root element is <${openName}>, expected <${expectRoot}>`;
      if (selfClose === '/') {
        rootClosed = true;
        continue;
      }
      stack.push(openName);
      continue;
    }
    if (selfClose !== '/') stack.push(openName);
  }
  const tail = gapError(src.slice(pos));
  if (tail) return tail;
  if (stack.length > 0) return `unclosed element <${stack[stack.length - 1]}>`;
  if (!rootClosed) return 'no root element';
  return undefined;
}

/** File-level variant of the gate: decode UTF-8 FATALLY, then run the
 *  string-level check. `fs.readFileSync(file, 'utf-8')` silently replaces
 *  invalid bytes with U+FFFD, so the string check would pass and a later
 *  Apply would write the replacement back — destroying the original bytes.
 *  Exported for the properties page's pre-write gate and used by audit. */
export function strictXmlFileError(file: string, expectRoot: string): string | undefined {
  let src: string;
  try {
    // ignoreBOM keeps the BOM code point (fs.readFileSync('utf-8') does too,
    // and the prolog gap rule already tolerates it before the root)
    src = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
  } catch {
    return 'file is not valid UTF-8';
  }
  return strictXmlStructureError(src, expectRoot);
}

function parseFile(file: string, findings: AuditFinding[], code: AuditCode, expectRoot: string): XElement | undefined {
  const structure = strictXmlFileError(file, expectRoot);
  if (structure) {
    findings.push({ code, file: path.basename(file), detail: structure, fixable: false });
    return undefined;
  }
  let doc: XElement | undefined;
  try {
    doc = parseXml(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    findings.push({ code, file: path.basename(file), detail: e instanceof Error ? e.message : String(e), fixable: false });
    return undefined;
  }
  // parseXml returns a "#doc" document node wrapping the real root — and it
  // is extremely lenient (trailing junk, mismatched close tags and unclosed
  // elements all "parse"), so throw-catching alone is dead code. Validate the
  // SHAPE instead: a truncated/garbled file comes back without the expected
  // root element.
  const px = doc?.child(expectRoot);
  if (!px) {
    findings.push({
      code,
      file: path.basename(file),
      detail: `root element is "${doc?.children[0]?.name || doc?.name || '(none)'}", expected <${expectRoot}>`,
      fixable: false,
    });
    return undefined;
  }
  return px;
}

/** the rvGcc option's two valid storage forms end with `rvGcc` + optional
 *  `.NN` (target form `…option.target.rvGcc.12`, base form
 *  `…option.base.target.rvGcc.8`); anything else is a report-only anomaly */
function rvGccFormOk(value: string): boolean {
  return /rvGcc(\.\d+)?$/.test(value);
}

export function auditProjectConfig(root: string): AuditResult {
  const findings: AuditFinding[] = [];

  // ---- .project: parseable + the name matches the folder (MRS binds the
  // window title and the wvproj name to it)
  const projectFile = path.join(root, '.project');
  if (fs.existsSync(projectFile)) {
    const px = parseFile(projectFile, findings, 'project-xml', 'projectDescription');
    if (px) {
      const name = px.child('name')?.text?.trim();
      if (name && name !== path.basename(root)) {
        findings.push({
          code: 'project-name',
          file: '.project',
          detail: name,
          fixable: false,
        });
      }
    }
  }

  // ---- .cproject: parseable + shape, then walk every option MRS will read
  const cprojectFile = path.join(root, '.cproject');
  if (fs.existsSync(cprojectFile)) {
    let cp: Cproject | undefined;
    try {
      const px = parseFile(cprojectFile, findings, 'project-xml', 'cproject');
      if (px) {
        cp = Cproject.load(root);
        if (!cp.config) {
          findings.push({ code: 'project-xml', file: '.cproject', detail: 'no <cconfiguration> found', fixable: false });
          cp = undefined;
        }
      }
    } catch (e) {
      findings.push({ code: 'project-xml', file: '.cproject', detail: e instanceof Error ? e.message : String(e), fixable: false });
      cp = undefined;
    }
    if (cp) {
      for (const opt of cp.config.findAll((e) => e.name === 'option')) {
        const id = opt.attr('id') ?? '';
        const valueType = opt.attr('valueType');
        const value = opt.attr('value');
        if (valueType === 'enumerated' && value === undefined) {
          findings.push({
            code: 'enum-value-missing',
            file: '.cproject',
            detail: id.slice(id.lastIndexOf('.') + 1) || id,
            fixable: true,
            optionId: id,
          });
          continue;
        }
        const isRvGcc = id.includes('.target.rvGcc.') || (opt.attr('superClass') ?? '').includes('.target.rvGcc');
        if (isRvGcc && value !== undefined && !rvGccFormOk(value)) {
          findings.push({ code: 'rvgcc-form', file: '.cproject', detail: `${id.slice(0, 48)}… value=${value}`, fixable: false });
        }
      }
    }
  }

  // ---- .template: the download address must be 0x-formatted when present
  const tpl = readTemplate(root);
  const address = (tpl.values['Address'] ?? '').trim();
  if (address && !ADDRESS_RE.test(address)) {
    findings.push({
      code: 'template-address',
      file: '.template',
      detail: address,
      fixable: true,
    });
  }

  return { findings };
}

export interface RepairOutcome {
  /** basenames of the files written */
  repairedFiles: string[];
  /** where the pre-repair copies live (inside the project, .vscode/mrvc/) */
  backupDir: string;
}

/** back up one file before the repair overwrites it */
function backup(root: string, backupDir: string, basename: string): void {
  const src = path.join(root, basename);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(src, path.join(backupDir, basename));
}

export function repairProjectConfig(root: string, findings: AuditFinding[]): RepairOutcome {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + String(process.pid % 10000).padStart(4, '0');
  const backupDir = path.join(root, '.vscode', 'mrvc', 'repair-backup', stamp);
  const repairedFiles: string[] = [];

  // --- .cproject findings share one load → edit → save cycle
  const cprojectFindings = findings.filter((f) => f.file === '.cproject' && f.fixable);
  if (cprojectFindings.length) {
    backup(root, backupDir, '.cproject');
    const cp = Cproject.load(root);
    for (const f of cprojectFindings) {
      if (f.code !== 'enum-value-missing' || !f.optionId) continue;
      const opt = cp.config.findAll((e) => e.name === 'option' && e.attr('id') === f.optionId)[0];
      if (opt?.parent) opt.parent.removeChild(opt);
    }
    cp.save();
    repairedFiles.push('.cproject');
  }

  // --- .template Address: clear it; the download falls back to inference
  if (findings.some((f) => f.code === 'template-address' && f.fixable)) {
    backup(root, backupDir, '.template');
    templateSet(root, 'Address', '');
    repairedFiles.push('.template');
  }

  return { repairedFiles, backupDir };
}
