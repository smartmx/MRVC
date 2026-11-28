/*
 * Build-artifact syntax-highlight tests (0.3.8): MRVC ships two more
 * clean-room TextMate grammars for read-only build output — objdump / GAS
 * -adhlns listings (source.mrvc-lst) and GNU ld -Map files
 * (source.mrvc-ld-map). Guards the package.json contributions, JSON
 * well-formedness, that EVERY rule regex compiles with only its own (?i)
 * (the extended (?x) form is banned, same as the assembly grammar), the
 * listing grammar's reuse of source.mrvc-qingke for the mnemonic column,
 * and sample-line probes for both formats.
 *
 * Run: node tools/buildartifact-highlight-test.js
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail === undefined ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const LST = path.join(root, 'syntaxes', 'qingke-objdump-lst.tmLanguage.json');
const MAP = path.join(root, 'syntaxes', 'gnu-ld-map.tmLanguage.json');

const LANG_LST = 'mrvc-objdump-lst';
const LANG_MAP = 'mrvc-ld-map';

// ---- package.json contributions: opt-in languages, no extensions anywhere
const languages = pkg.contributes.languages || [];
const grammars = pkg.contributes.grammars || [];
for (const [id, scope, file] of [
  [LANG_LST, 'source.mrvc-lst', 'qingke-objdump-lst.tmLanguage.json'],
  [LANG_MAP, 'source.mrvc-ld-map', 'gnu-ld-map.tmLanguage.json'],
]) {
  const lang = languages.find((l) => l.id === id);
  check(`pkg: the ${id} language is contributed with NO extensions`, !!lang && lang.extensions === undefined, JSON.stringify(lang));
  const g = grammars.find((x) => x.language === id);
  check(
    `pkg: the ${id} grammar is bound to ${scope} and its file exists`,
    !!g && g.scopeName === scope && g.path === `./syntaxes/${file}` && fs.existsSync(path.join(root, 'syntaxes', file)),
    JSON.stringify(g)
  );
}
check(
  'pkg: NO language claims extensions (every mode is opt-in via associations)',
  languages.every((l) => l.extensions === undefined),
  JSON.stringify(languages.filter((l) => l.extensions !== undefined).map((l) => l.id))
);

// ---- JSON parse + FULL rule compile audit: every match/begin/end must be
// a valid JS regex under exactly the flags the rule itself declares (this
// is what real TextMate/Oniguruma does; a hardcoded 'i' here would hide
// rules that forgot their (?i))
function loadRules(file) {
  const grammar = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  check(
    `${base}: parses as JSON with scopeName/patterns/repository`,
    typeof grammar.scopeName === 'string' && Array.isArray(grammar.patterns) && !!grammar.repository,
    String(grammar.scopeName)
  );
  const rules = [];
  const walk = (patterns) => {
    for (const r of patterns || []) {
      if (typeof r.include === 'string') continue;
      if (typeof r.match === 'string' || typeof r.begin === 'string') rules.push(r);
      if (Array.isArray(r.patterns)) walk(r.patterns);
    }
  };
  walk(grammar.patterns);
  for (const key of Object.keys(grammar.repository || {})) {
    const node = grammar.repository[key];
    if (Array.isArray(node.patterns)) walk(node.patterns);
    else if (typeof node.match === 'string' || typeof node.begin === 'string') rules.push(node);
  }
  const bad = [];
  for (const r of rules) {
    for (const slot of ['match', 'begin', 'end']) {
      const raw = r[slot];
      if (typeof raw !== 'string') continue;
      const fm = raw.match(/^\(\?([a-z]+)\)/);
      const rest = fm ? raw.slice(fm[0].length) : raw;
      if (/\(\?[a-z-]+\)/.test(rest)) bad.push(`${slot} mid-pattern flag: ${raw.slice(0, 50)}`);
      let flags = '';
      if (fm && fm[1].indexOf('i') >= 0) flags += 'i';
      try {
        new RegExp(rest, flags);
      } catch (e) {
        bad.push(`${slot}: ${raw.slice(0, 50)} (${e.message})`);
      }
    }
  }
  check(
    `${base}: all ${rules.length} rules compile (no (?x), per-rule (?i))`,
    bad.length === 0,
    bad.join(' | ').slice(0, 240)
  );
  return { grammar, rules };
}

const lst = loadRules(LST);
const map = loadRules(MAP);

// the listing grammar must reuse the assembly grammar for the mnemonic
// column — QingKe XW/V3B instructions, WCH CSRs, RVV and the standard
// RISC-V families come along with zero duplicate maintenance
const lstJson = JSON.stringify(lst.grammar);
check(
  'lst: the mnemonic column includes source.mrvc-qingke (zero duplicate maintenance)',
  lstJson.includes('"include": "source.mrvc-qingke"') || lstJson.includes('"include":"source.mrvc-qingke"'),
  'no include of source.mrvc-qingke found'
);
// ...and must NOT carry a vendored copy of its own instruction rules
check(
  'lst: no duplicated instruction vocabulary (rules stay in the assembly grammar)',
  !lstJson.includes('lbusp') && !lstJson.includes('mrslu') && !lstJson.includes('gintenr'),
  'grammar embeds instruction/CSR data of its own'
);

// ---- positional probes (same model as asmhighlight-test: the rule whose
// match starts EARLIEST wins, ties go to rule order; capture-shaped rules
// report their capture-1 / begin-capture-1 scope)
function makeScopeOf(rules) {
  const compile = (r) => {
    let pattern = typeof r.match === 'string' ? r.match : r.begin;
    let flags = '';
    const fm = pattern.match(/^\(\?([a-z]+)\)/);
    if (fm) {
      pattern = pattern.slice(fm[0].length);
      if (fm[1].indexOf('i') >= 0) flags += 'i';
    }
    return new RegExp(pattern, flags);
  };
  return (token) => {
    let best = null;
    for (const r of rules) {
      const m = token.match(compile(r));
      if (m && (best === null || m.index < best.index)) best = { index: m.index, rule: r };
    }
    if (!best) return '(none)';
    const hit = best.rule;
    if (typeof hit.name === 'string') return hit.name;
    const cap = hit.captures && (hit.captures['1'] || Object.values(hit.captures)[0]);
    const bcap = hit.beginCaptures && (hit.beginCaptures['1'] || Object.values(hit.beginCaptures)[0]);
    return (cap && cap.name) || (bcap && bcap.name) || '(unnamed)';
  };
}
const probeLst = makeScopeOf(lst.rules);
const probeMap = makeScopeOf(map.rules);
const probe = (scopeOf, family, token, want) => {
  const got = scopeOf(token);
  check(`${family}: ${JSON.stringify(token)}`, got === want, `${got} (want ${want})`);
};

// objdump / GAS -adhlns listing samples
[
  ['00000084 <main>:', 'constant.numeric.address.lst'],
  ['  84:\t1141\taddi\tsp,sp,-16', 'constant.numeric.address.lst'],
  ['  88:\t00000097\tc.lbusp\ta0,0(sp) # 20000000 <g_buf>', 'constant.numeric.address.lst'],
  ['  12 0002 4111 \t\tc.addi\tsp,-16', 'constant.numeric.line-number.lst'],
  ['  10:User/main.c   **** int main(void) { /* comment */', 'constant.numeric.line-number.lst'],
  ['Disassembly of section .text:', 'keyword.control.lst'],
  ['...', 'comment.line.ellipsis.lst'],
  ['./User/main.o:     file format elf32-littleriscv', 'string.unquoted.path.lst'],
].forEach(([t, want]) => probe(probeLst, 'lst', t, want));

// GNU ld -Map samples
[
  ['Discarded input sections', 'markup.heading.ld-map'],
  ['Memory Configuration', 'markup.heading.ld-map'],
  ['Cross Reference Table', 'markup.heading.ld-map'],
  ['FLASH  0x00000000  0x00038000  xr', 'entity.name.type.region.ld-map'],
  ['.text  0x00000084  0x2c0 load address 0x00000084', 'entity.name.section.output.ld-map'],
  [' .text.main  0x00000120  0x48 ./User/main.o', 'entity.name.section.input.ld-map'],
  ['  0x00000120  main', 'constant.numeric.address.ld-map'],
  ['  0x20000000  PROVIDE (__global_pointer$ = .)', 'constant.numeric.address.ld-map'],
  ['LOAD ./User/main.o', 'keyword.control.ld-map'],
  ['OUTPUT(dtm.elf elf32-littleriscv)', 'keyword.control.ld-map'],
  ['START GROUP', 'keyword.control.ld-map'],
  ['  *fill*  0x00000100  0x4 00', 'keyword.other.fill.ld-map'],
  ['*(.text .text.*)', 'keyword.operator.wildcard.ld-map'],
].forEach(([t, want]) => probe(probeMap, 'map', t, want));

console.log(failures ? '\n' + failures + ' FAILURES' : '\nall build-artifact highlight tests passed');
process.exit(failures ? 1 : 0);
