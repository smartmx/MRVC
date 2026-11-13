/*
 * Project-configuration audit & repair tests (scratch copies of the real EVT
 * LED fixture — no real tree is ever touched). Covers: healthy project passes
 * clean, the enumerated-missing-value finding + removal repair (with backup
 * and byte-fidelity for untouched lines), the rvGcc unknown-form report, the
 * .template Address finding + clear repair, the XML-parse report, and the
 * .project name mismatch report.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');
const { auditProjectConfig, repairProjectConfig, strictXmlStructureError } = require('../out/core/audit.js');
const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const LED_PROJ = ['E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'F:/CH585/EVT/V1_2/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find((r) =>
  fs.existsSync(path.join(r, '.cproject'))
);
if (!LED_PROJ) {
  console.log('SKIP: LED project not found (no real EVT tree)');
  process.exit(0);
}

const ROOT = path.join(here, '..', '.scratch', 'audit');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

/** copy the 3 config files into <ROOT>/<folder>/<baseDirName> (default: LED) */
function fixture(folder, baseDirName = 'LED') {
  const dir = path.join(ROOT, folder, baseDirName);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['.project', '.cproject', '.template']) fs.copyFileSync(path.join(LED_PROJ, f), path.join(dir, f));
  return dir;
}

const BROKEN_ID = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.rvGcc.999001';
const BROKEN_ELEM =
  `\t\t\t\t<option id="${BROKEN_ID}" name="Broken" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.rvGcc" valueType="enumerated"/>`;

// 1. healthy fixture: zero findings
{
  const dir = fixture('ok');
  const { findings } = auditProjectConfig(dir);
  check('healthy: no findings', findings.length === 0);
}

// 2. damaged fixture: injected no-value enumerated option + junk rvGcc value + bad Address
const brokenDir = fixture('broken');
{
  const cp = path.join(brokenDir, '.cproject');
  let raw = fs.readFileSync(cp, 'utf-8');
  const healthy = raw.match(/<option id="ilg\.gnumcueclipse\.managedbuild\.cross\.riscv\.option\.target\.rvGcc\.\d+"[^/]*value="[^"]*rvGcc\.\d+"[^/]*\/>/);
  check('fixture: LED has a healthy rvGcc option to preserve', !!healthy);
  // inject AFTER the healthy element: one option without a value attr, one
  // with a junk value (the form report) — the healthy element stays untouched
  raw = raw.replace(
    /(<option id="ilg\.gnumcueclipse\.managedbuild\.cross\.riscv\.option\.target\.rvGcc\.[^/]*\/>)/,
    `$1\n${BROKEN_ELEM}\n\t\t\t\t<option id="ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.rvGcc.999002" name="FormJunk" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.rvGcc" value="junk" valueType="enumerated"/>`
  );
  fs.writeFileSync(cp, raw);
  const tpl = path.join(brokenDir, '.template');
  fs.writeFileSync(tpl, fs.readFileSync(tpl, 'utf-8').replace(/Address=.*/, 'Address=12345'));

  const { findings } = auditProjectConfig(brokenDir);
  const codes = new Set(findings.map((f) => f.code));
  check('broken: enum-value-missing reported as fixable', codes.has('enum-value-missing') && findings.find((f) => f.code === 'enum-value-missing').fixable === true);
  check('broken: rvgcc-form reported (report-only)', codes.has('rvgcc-form') && findings.find((f) => f.code === 'rvgcc-form').fixable === false);
  check('broken: template-address reported as fixable', codes.has('template-address') && findings.find((f) => f.code === 'template-address').fixable === true);

  // repair only the fixable ones
  const { repairedFiles, backupDir } = repairProjectConfig(brokenDir, findings.filter((f) => f.fixable));
  check('repair: touched .cproject and .template', repairedFiles.includes('.cproject') && repairedFiles.includes('.template'));
  check('repair: backups exist', fs.existsSync(path.join(backupDir, '.cproject')) && fs.existsSync(path.join(backupDir, '.template')));

  const after = fs.readFileSync(cp, 'utf-8');
  check('repair: broken option removed', !after.includes(BROKEN_ID));
  check('repair: healthy rvGcc option untouched (byte-identical line)', !!healthy && after.includes(healthy[0]));
  check('repair: junk rvGcc value NOT touched (report-only)', after.includes('value="junk"'));
  const tplAfter = fs.readFileSync(path.join(brokenDir, '.template'), 'utf-8');
  check('repair: Address cleared', /^Address=$/m.test(tplAfter));

  const after2 = auditProjectConfig(brokenDir);
  check('repair: re-audit drops the fixed codes', !after2.findings.some((f) => f.code === 'enum-value-missing' || f.code === 'template-address'));
  check('repair: re-audit still reports the report-only rvgcc-form', after2.findings.some((f) => f.code === 'rvgcc-form'));
}

// 3. XML-corrupt .cproject: shape-invalid → report-only (the parser itself
// is lenient, so the check validates the ROOT ELEMENT, not parse throws)
{
  const dir = fixture('xmlbad');
  const cp = path.join(dir, '.cproject');
  fs.writeFileSync(cp, 'not xml at all, just text\n');
  const { findings } = auditProjectConfig(dir);
  check(
    'xmlbad: shape-invalid reported, not fixable',
    findings.some((f) => f.code === 'project-xml' && f.fixable === false)
  );
}

// 4. .project name mismatch: report-only (folder renamed under the project)
{
  const dir = fixture('renamed', 'LEDRENAMED');
  const { findings } = auditProjectConfig(dir);
  check(
    'renamed: folder/name mismatch reported, not fixable',
    findings.some((f) => f.code === 'project-name' && f.fixable === false)
  );
}

// 5. strict structure shapes (round-10 P2-3 + round-11 P2-2): the bundled
// parser accepts all of these, MRS/Eclipse's strict parser does NOT — each
// must be reported. The last two are non-whitespace text / naked markup
// OUTSIDE the root, invisible to a tag-stack-only walk.
{
  const cases = [
    ['struct-mismatch', (r) => r.replace('</cconfiguration>', '</broken>'), 'mismatched close tag'],
    ['struct-unclosed', (r) => r.replace('</tool>', ''), 'unclosed child element'],
    ['struct-trailing', (r) => r.trimEnd() + '\n<extra/>\n', 'trailing second root'],
    ['struct-selfclose-root', () => '<cproject/>\n<extra/>\n', 'self-closing root + second root'],
    ['struct-text-before', (r) => 'GARBAGE BEFORE ROOT\n' + r, 'text before the root'],
    ['struct-text-after', (r) => r.trimEnd() + '\nGARBAGE AFTER ROOT\n', 'text after the root'],
    ['struct-naked-lt', (r) => r.trimEnd() + '\n<unclosed\n', 'naked < the token grid cannot consume'],
    // round-12 P2: non-tag tokens have POSITION rules — skipping them
    // unconditionally let these audit clean while strict parsers refuse them
    ['struct-cdata-after', (r) => r.trimEnd() + '\n<![CDATA[OUTSIDE]]>\n', 'CDATA after the root'],
    ['struct-cdata-before', (r) => r.replace(/^(<\?xml[^>]*\?>)/, '$1\n<![CDATA[OUTSIDE]]>'), 'CDATA outside the root'],
    ['struct-doctype-after', (r) => r.trimEnd() + '\n<!DOCTYPE extra>\n', 'DOCTYPE after the root'],
    ['struct-doctype-twice', (r) => r.replace(/^(<\?xml[^>]*\?>)/, '$1\n<!DOCTYPE cproject>\n<!DOCTYPE cproject>'), 'duplicate DOCTYPE'],
    ['struct-xmldecl-after', (r) => r.trimEnd() + "\n<?xml version='1.0'?>\n", 'XML declaration after the root'],
    ['struct-dup-attr', (r) => r.replace('<cproject ', '<cproject value="x" value="y" '), 'duplicate attribute'],
  ];
  for (const [folder, mutate, label] of cases) {
    const dir = fixture(folder);
    const cpPath = path.join(dir, '.cproject');
    fs.writeFileSync(cpPath, mutate(fs.readFileSync(cpPath, 'utf-8')));
    const { findings } = auditProjectConfig(dir);
    check(
      `struct: ${label} reported, not fixable`,
      findings.some((f) => f.code === 'project-xml' && f.fixable === false)
    );
  }
}

// 6. strictness must not false-positive on LEGAL surroundings: comments and
// processing instructions outside the root are fine (a strict parser the
// audit mimics accepts them); a healthy file with them stays clean
{
  const dir = fixture('struct-legal');
  const cpPath = path.join(dir, '.cproject');
  const raw = fs.readFileSync(cpPath, 'utf-8');
  // the XML declaration must stay the FIRST thing in the file — insert the
  // comment right after it when present
  const legal = /^<\?xml[^>]*\?>/.test(raw)
    ? raw.replace(/^(<\?xml[^>]*\?>)/, '$1\n<!-- leading comment -->')
    : '<!-- leading comment -->\n' + raw;
  fs.writeFileSync(cpPath, `${legal.trimEnd()}\n<!-- trailing comment -->\n`);
  const { findings } = auditProjectConfig(dir);
  check('struct: comments around the root stay clean (no false positive)', findings.length === 0);
}

// 7. XML syntax beyond structure (round-13 P2): character data and attribute
// values follow XML's lexical rules — a standard parser rejects these while
// the lenient parser reads them
{
  const E = (xml) => strictXmlStructureError(xml, 'cproject');
  check('syntax: bare & in character data rejected', !!E('<cproject><a>AT&T</a></cproject>'));
  check('syntax: undeclared entity rejected', !!E('<cproject><a>&foo;</a></cproject>'));
  check('syntax: raw < in an attribute value rejected', !!E('<cproject><a x="1<2"/></cproject>'));
  check('syntax: "]]>" in character data rejected', !!E('<cproject><a>x]]>y</a></cproject>'));
  check('syntax: comment containing "--" rejected', !!E('<!-- a -- b --><cproject/>'));
  check('syntax: PI with an invalid target rejected', !!E('<cproject><?1bad x?></cproject>'));
  check(
    'syntax: predefined and character references accepted',
    !E('<cproject><a x="a &amp; b &lt; c">x &#65; &#x41; &quot;q&quot; &apos;</a></cproject>')
  );
  check(
    'syntax: a legal internal DTD subset is accepted (entity declared there)',
    !E('<!DOCTYPE cproject [<!ELEMENT cproject ANY><!ENTITY foo "bar">]><cproject><a>&foo;</a></cproject>')
  );
  // end-to-end: auditProjectConfig (and thus the Apply gate) must report it
  check(
    'syntax: bare & injected into a real config is reported by audit',
    (() => {
      const dir = fixture('syntax-amp');
      const cpPath = path.join(dir, '.cproject');
      const raw = fs.readFileSync(cpPath, 'utf-8');
      fs.writeFileSync(cpPath, raw.replace('</cconfiguration>', 'AT&T</cconfiguration>'));
      const res = auditProjectConfig(dir);
      return res.findings.some((f) => f.code === 'project-xml' && f.fixable === false);
    })()
  );
}

// 8. XML 1.0 Char production (round-14 P2): character references must resolve
// to a legal Char, raw control characters are fatal anywhere, and invalid
// UTF-8 bytes must be refused instead of being silently replaced by U+FFFD
{
  const E = (xml) => strictXmlStructureError(xml, 'cproject');
  for (const ref of ['&#0;', '&#x1;', '&#xD800;', '&#xFFFE;', '&#x110000;', '&#55296;']) {
    check(`char: invalid character reference ${ref} rejected`, !!E(`<cproject><a>${ref}</a></cproject>`));
  }
  check('char: tab/LF/CR references accepted', !E('<cproject><a>&#x9;&#xA;&#xD;</a></cproject>'));
  check('char: astral character accepted raw and referenced', !E('<cproject><a>😀 &#x1F600;</a></cproject>'));
  check('char: raw NUL in character data rejected', !!E('<cproject><a>\u0000</a></cproject>'));
  check('char: raw control char in an attribute value rejected', !!E('<cproject><a x="\u0001"/></cproject>'));
  check(
    'char: raw invalid char in CDATA and in a comment rejected',
    !!E('<cproject><![CDATA[\u0001]]></cproject>') && !!E('<!-- \u0001 -->\n<cproject/>')
  );
  // invalid UTF-8 in a REAL config copy: the byte-level gate must report it
  // (a text-level check sees only the U+FFFD replacement and would pass)
  const dir = fixture('utf8bad');
  const cpPath = path.join(dir, '.cproject');
  const bytes = fs.readFileSync(cpPath);
  const at = bytes.indexOf(Buffer.from('<cconfiguration'));
  check('utf8: fixture has a byte position to corrupt', at > 0);
  fs.writeFileSync(cpPath, Buffer.concat([bytes.subarray(0, at), Buffer.from([0x80]), bytes.subarray(at)]));
  const res = auditProjectConfig(dir);
  check(
    'utf8: invalid byte reported as project-xml, not silently repaired',
    res.findings.some((f) => f.code === 'project-xml' && f.fixable === false)
  );
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall audit tests passed');
process.exit(failures ? 1 : 0);
