/*
 * Assembly syntax-highlight tests (0.3.8): MRVC ships its OWN RISC-V
 * TextMate grammar (syntaxes/qingke-risc-v.tmLanguage, authored in-repo —
 * instruction/register/CSR data assembled from the open RISC-V ISA manual
 * and the WCH QingKe V2/V3/V4/V5 manuals; no third-party code or license
 * is bundled). Guards the package.json contributions, the grammar's XML
 * plist well-formedness, the instruction/CSR coverage, the absence of any
 * third-party attribution, and the language configuration.
 *
 * Run: node tools/asmhighlight-test.js
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

/* the files the contribution MUST point at — these exact literals are
   asserted against package.json AND used directly in every fs call */
const TM = path.join(root, 'syntaxes', 'qingke-risc-v.tmLanguage');
const LANGCFG = path.join(root, 'syntaxes', 'qingke-risc-v-language-configuration.json');

// ---- package.json contributions: the language id is mrvc-qingke
// and it claims NO extensions — the .s/.S binding is opt-in per folder,
// written by applyAsmAssociations into each workspace's files.associations
// (v0.3.8 user-directed design: a global claim would hijack the extensions
// for every folder and race installed assembly extensions)
const LANG_ID = 'mrvc-qingke';
const languages = pkg.contributes.languages || [];
const grammars = pkg.contributes.grammars || [];
const lang = languages.find((l) => l.id === LANG_ID);
check('pkg: the mrvc-qingke language is contributed', !!lang, JSON.stringify(languages.map((l) => l.id)));
check(
  'pkg: the language claims NO extensions (opt-in via files.associations)',
  !!lang && lang.extensions === undefined,
  JSON.stringify(lang && lang.extensions)
);
check(
  'pkg: the display alias is exactly MRVC QingKe (no RISC-V suffix)',
  !!lang && Array.isArray(lang.aliases) && lang.aliases.length === 1 && lang.aliases[0] === 'MRVC QingKe',
  JSON.stringify(lang && lang.aliases)
);
check(
  'pkg: NO language claims extensions (every mode is opt-in via associations)',
  languages.every((l) => l.extensions === undefined),
  JSON.stringify(languages.filter((l) => l.extensions !== undefined).map((l) => l.id))
);
check(
  'pkg: the language configuration points at the grammar folder',
  !!lang && lang.configuration === './syntaxes/qingke-risc-v-language-configuration.json' && fs.existsSync(LANGCFG),
  JSON.stringify(lang && lang.configuration)
);
const grammar = grammars.find((g) => g.language === LANG_ID);
check('pkg: the grammar is bound to mrvc-qingke with scope source.mrvc-qingke', !!grammar && grammar.scopeName === 'source.mrvc-qingke', JSON.stringify(grammars.map((g) => [g.language, g.scopeName])));
check(
  'pkg: the grammar points at the own qingke-risc-v file',
  !!grammar && grammar.path === './syntaxes/qingke-risc-v.tmLanguage' && fs.existsSync(TM),
  JSON.stringify(grammar && grammar.path)
);

// ---- grammar plist: well-formed XML, WCH additions, base sanity
const src = fs.readFileSync(TM, 'utf8');

/* minimal plist XML parser (same shape as .scratch/tm-extract.js) */
function parsePlist(src) {
  let i = 0;
  const skipWs = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i);
        if (end < 0) throw new Error('unclosed comment');
        i = end + 3;
        continue;
      }
      return;
    }
  };
  const readText = (tag) => {
    const end = src.indexOf('</' + tag + '>', i);
    if (end < 0) throw new Error('unclosed ' + tag);
    const text = src.slice(i, end);
    i = end + tag.length + 3;
    return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  };
  function parseValue() {
    skipWs();
    if (src.startsWith('<array>', i)) {
      i += 7;
      const arr = [];
      skipWs();
      while (!src.startsWith('</array>', i)) {
        arr.push(parseValue());
        skipWs();
      }
      i += 8;
      return arr;
    }
    if (src.startsWith('<dict>', i)) {
      i += 6;
      const dict = {};
      skipWs();
      while (!src.startsWith('</dict>', i)) {
        skipWs();
        if (!src.startsWith('<key>', i)) throw new Error('expected <key> at ' + i + ': ' + src.slice(i, i + 40));
        i += 5;
        const key = readText('key');
        skipWs();
        dict[key.trim()] = parseValue();
        skipWs();
      }
      i += 7;
      return dict;
    }
    if (src.startsWith('<string>', i)) {
      i += 8;
      return readText('string');
    }
    if (src.startsWith('<true/>', i)) return (i += 7), true;
    if (src.startsWith('<false/>', i)) return (i += 8), false;
    if (src.startsWith('<integer>', i)) return (i += 9), parseInt(readText('integer'), 10);
    throw new Error('unknown plist node at ' + i + ': ' + src.slice(i, i + 40));
  }
  const start = src.indexOf('<plist');
  i = src.indexOf('>', start) + 1;
  return parseValue();
}

/* rules are probed SEMANTICALLY: a TextMate rule is a regex, so a literal
   substring grep on an alternation like (?:lbusp|lhusp|...) always reports
   0 hits — compile each rule instead and push real tokens through it */
let rules = [];
try {
  const plist = parsePlist(src);
  rules = Array.isArray(plist.patterns) ? plist.patterns : [];
  const isRule = (r) =>
    (typeof r.match === 'string' || (typeof r.begin === 'string' && typeof r.end === 'string')) &&
    (typeof r.name === 'string' || (r.captures && typeof r.captures === 'object'));
  check(
    'grammar: the tmLanguage parses as a well-formed plist with the full rule set',
    rules.length > 50 && rules.every(isRule),
    String(rules.length)
  );
} catch (e) {
  check('grammar: the tmLanguage parses as a well-formed plist with the full rule set', false, e.message);
}
// compile EXACTLY what the rule says: the case-insensitive flag only when
// the rule itself carries `(?i)` — hardcoding 'i' here would hide rules
// that forgot their flag (real TextMate/Oniguruma defaults to sensitive).
// The extended (?x) form is banned in the grammar so plain patterns stay
// testable verbatim in JavaScript.
const ruleSource = (r) => (typeof r.match === 'string' ? r.match : r.begin);
const ruleRegex = (r) => {
  let pattern = ruleSource(r);
  let flags = '';
  const flagMatch = pattern.match(/^\(\?([a-z]+)\)/);
  if (flagMatch) {
    pattern = pattern.slice(flagMatch[0].length);
    if (flagMatch[1].indexOf('i') >= 0) flags += 'i';
  }
  return new RegExp(pattern, flags);
};
// mirror the real tokenizer: the rule whose match starts EARLIEST in the
// token wins (ties go to rule order) — a plain any-position test would let
// e.g. the register rule claim `cbo.zero` via its inner `zero`
const scopeOf = (token) => {
  let best = null;
  for (const r of rules) {
    const m = token.match(ruleRegex(r));
    if (m && (best === null || m.index < best.index)) best = { index: m.index, rule: r };
  }
  if (!best) return '(none)';
  const hit = best.rule;
  if (typeof hit.name === 'string') return hit.name;
  // capture-shaped rule (label/preprocessor): the scope lives on capture 1 —
  // checked BY GROUP NUMBER so a misplaced group cannot pass silently
  const cap1 = hit.captures && hit.captures['1'];
  return cap1 && cap1.name ? cap1.name : '(unnamed)';
};
const probe = (family, token, want) => {
  const got = scopeOf(token);
  check(`grammar: ${family} — ${token}`, got === want, `${got} (want ${want})`);
};

// H1: block comments MUST be a begin/end state rule — TextMate tokenizes
// line by line, a `match` rule can never span lines
const beginComment = rules.find((r) => r.begin === '/\\*' && r.end === '\\*/');
check(
  'grammar: block comments are a begin/end state rule (match cannot span lines)',
  !!beginComment && beginComment.name === 'comment.block.riscv',
  JSON.stringify(beginComment && beginComment.name)
);
// and the state machine holds the scope across the banner lines, releasing
// it after the closer
{
  const beginRe = new RegExp(beginComment.begin);
  const endRe = new RegExp(beginComment.end);
  let inside = false;
  const banner = ['/*', ' * Copyright (c) 2021 Qinheng, sets a0/a1 and jumps to main', ' */', 'add a0, a1'];
  const states = banner.map((line) => {
    if (!inside) {
      if (!beginRe.test(line)) return 'code';
      inside = !endRe.test(line.slice(line.indexOf('/*') + 2));
      return 'comment';
    }
    if (endRe.test(line)) inside = false;
    return 'comment';
  });
  check(
    'grammar: a multi-line /* */ banner holds the comment scope until the closer',
    JSON.stringify(states) === JSON.stringify(['comment', 'comment', 'comment', 'code']),
    JSON.stringify(states)
  );
}

// the grammar is MRVC's own: the header names the DATA sources only (the
// open ISA manual + the QingKe manuals) and carries no upstream attribution
check(
  'grammar: the header states MRVC authorship and names the data sources',
  src.includes('Authored in-repo for MRVC') && src.includes('QingKe V2/V3/V4/V5'),
  src.slice(0, 160)
);
check(
  'grammar: NO third-party attribution remains (project names, licenses, copyrights)',
  !/(sunshaoce|zhwu95|kubigenov|shao-ce|zhuanhao|riscv-support|third-party|copyright|mit license)/i.test(src),
  (src.match(/(sunshaoce|zhwu95|kubigenov|shao-ce|zhuanhao|riscv-support|third-party|copyright|mit license)/i) || ['clean'])[0]
);
// the scope name must be MRVC's own: TextMate grammars are indexed GLOBALLY
// by scopeName, so reusing a shared source.riscv would let a co-installed
// RISC-V grammar overwrite ours (losing the WCH block) or vice versa
check(
  'grammar: the scopeName is the unique source.mrvc-qingke (no shared source.riscv)',
  src.includes('<string>source.mrvc-qingke</string>') && !src.includes('source.riscv'),
  src.includes('<string>source.mrvc-qingke</string>') ? 'unique' : 'missing'
);
// VS Code ignores the plist's fileTypes (contributes.languages rules) — the
// key stays out so nobody mistakes the grammar for claiming .riscv/.asm
check(
  'grammar: no fileTypes key (no .riscv/.asm claim)',
  !src.includes('<key>fileTypes</key>'),
  '<key>fileTypes</key>'
);
// guard rail first: an unknown word must match NOTHING, so every probe
// below proves its family rule rather than a loose fallback
probe('sanity', 'zzznotaninstruction', '(none)');

// WCH XW compressed stack-pointer forms (+ plain byte/half in the C rule)
['c.lbusp', 'c.lhusp', 'c.sbsp', 'c.shsp'].forEach((t) => probe('WCH XW', t, 'support.function.riscv.wch'));
['c.lbu', 'c.lhu', 'c.sb', 'c.sh'].forEach((t) => probe('Zc byte/half', t, 'support.function.riscv.c'));
// WCH V3B custom instructions — mnemonics from the WCH SDK core headers
// (ASM_MCPY/ASM_MRSLU/ASM_MRSL/ASM_WEXTI inline asm; the QingKe V3 manual
// documents the family without mnemonics)
['mcpy', 'mrslu', 'mrsl', 'wexti'].forEach((t) => probe('WCH V3B', t, 'support.function.riscv.wch'));
// WCH vendor CSRs from the QingKe manuals (17 names — `mie` at WCH's
// non-standard 0xBC8 stays covered by the standard rule)
const wchCsrs = [
  'gintenr',
  'intsyscr',
  'inestcr',
  'corecfgr',
  'cstrcr',
  'cache_strtg_ctlr',
  'cpmpocr',
  'cache_pmp_ovr',
  'cmcr',
  'opcache_ctlr',
  'cinfor',
  'meminfo',
  'hw_popdm_addr',
  'memary_cfgr',
  'tcm_rrduty_cfgr',
  'dbgmcu_0',
  'mcount_inhibit',
];
wchCsrs.forEach((n) => probe('WCH CSR', n, 'variable.other.csr.wch'));

// ISA coverage: one representative token per family/scope
[
  ['add', 'support.function.riscv.i'],
  ['ld', 'support.function.riscv.i'],
  ['sd', 'support.function.riscv.i'],
  ['bltz', 'support.function.riscv.i'],
  ['mulhsu', 'support.function.riscv.m'],
  ['remu', 'support.function.riscv.m'],
  ['amoadd.w', 'support.function.riscv.a'],
  ['lr.w.aq', 'support.function.riscv.a'],
  ['sc.d', 'support.function.riscv.a'],
  ['flw', 'support.function.riscv.f'],
  ['fcvt.s.w', 'support.function.riscv.f'],
  ['fld', 'support.function.riscv.d'],
  ['fcvt.s.d', 'support.function.riscv.d'],
  ['c.addi', 'support.function.riscv.c'],
  ['c.ldsp', 'support.function.riscv.c'],
  ['c.addi16sp', 'support.function.riscv.c'],
  ['csrw', 'support.function.riscv.zicsr'],
  ['csrrci', 'support.function.riscv.zicsr'],
  ['fence.i', 'support.function.riscv.zifencei'],
  ['rdcycleh', 'support.function.riscv.zicntr'],
  ['mret', 'support.function.riscv.privileged'],
  ['sfence.vma', 'support.function.riscv.privileged'],
  ['sh1add.uw', 'support.function.riscv.zba'],
  ['orc.b', 'support.function.riscv.zbb'],
  ['rev8', 'support.function.riscv.zbb'],
  ['clmulr', 'support.function.riscv.zbc'],
  ['bseti', 'support.function.riscv.zbs'],
  ['xperm8', 'support.function.riscv.zbkx'],
  ['cbo.zero', 'support.function.riscv.zicbo'],
  ['prefetch.r', 'support.function.riscv.zicbo'],
  ['czero.nez', 'support.function.riscv.zicond'],
  ['wrs.sto', 'support.function.riscv.zawrs'],
  ['fli.d', 'support.function.riscv.zfa'],
  ['fcvt.h.s', 'support.function.riscv.zfh'],
  ['aes32esmi', 'support.function.riscv.zk'],
  ['sm4ks', 'support.function.riscv.zk'],
  ['sha512sig0', 'support.function.riscv.zk'],
  ['vsetivli', 'support.function.riscv.v'],
  ['vluxei8.v', 'support.function.riscv.v'],
  ['vsse32.v', 'support.function.riscv.v'],
  ['vadd.vx', 'support.function.riscv.v'],
  ['vwadd.wv', 'support.function.riscv.v'],
  ['vnclip.wi', 'support.function.riscv.v'],
  ['vmseq.vi', 'support.function.riscv.v'],
  ['vmand.mm', 'support.function.riscv.v'],
  ['vmsbf.m', 'support.function.riscv.v'],
  ['vredmax.vs', 'support.function.riscv.v'],
  ['vfredusum.vs', 'support.function.riscv.v'],
  ['vfdiv.vf', 'support.function.riscv.v'],
  ['vfncvt.rtz.xu.f.w', 'support.function.riscv.v'],
  ['la', 'support.function.riscv.pseudo'],
  ['tail', 'support.function.riscv.pseudo'],
  ['.word', 'storage.type.riscv'],
  ['.option', 'storage.modifier.riscv'],
  ['%pcrel_hi(', 'support.function.relocation.riscv'],
  ['main:', 'entity.name.label.riscv'],
  ['pmpcfg3', 'variable.other.csr.riscv'],
  ['mcause', 'variable.other.csr.riscv'],
  ['stimecmp', 'variable.other.csr.riscv'],
  ['a3', 'variable.other.register.riscv'],
  ['ft9', 'variable.other.register.riscv'],
  ['v17', 'variable.other.register.riscv'],
  // H3: plain compressed loads/stores (the `sp?` regression) + phantom negatives
  ['c.lw', 'support.function.riscv.c'],
  ['c.sw', 'support.function.riscv.c'],
  ['c.ld', 'support.function.riscv.c'],
  ['c.sd', 'support.function.riscv.c'],
  ['c.flw', 'support.function.riscv.c'],
  ['c.fsw', 'support.function.riscv.c'],
  ['c.fld', 'support.function.riscv.c'],
  ['c.fsd', 'support.function.riscv.c'],
  ['c.lws', '(none)'],
  ['c.sws', '(none)'],
  // H4: csrr (read-only CSR pseudo) + uppercase mnemonics — every rule must
  // carry its own (?i); the test compiles case-sensitively otherwise
  ['csrr', 'support.function.riscv.zicsr'],
  ['CSRW', 'support.function.riscv.zicsr'],
  ['C.LBUSP', 'support.function.riscv.wch'],
  ['MCPY', 'support.function.riscv.wch'],
  ['MUL', 'support.function.riscv.m'],
  ['LR.W', 'support.function.riscv.a'],
  ['VADD.VX', 'support.function.riscv.v'],
  ['FENCE.I', 'support.function.riscv.zifencei'],
  // M1: RV64 *w words, fence.tso, float pseudos and RV64 float conversions
  ['addw', 'support.function.riscv.i'],
  ['sraiw', 'support.function.riscv.i'],
  ['mulw', 'support.function.riscv.m'],
  ['remuw', 'support.function.riscv.m'],
  ['fence.tso', 'support.function.riscv.zifencei'],
  ['fabs.s', 'support.function.riscv.f'],
  ['fmv.s', 'support.function.riscv.f'],
  ['frcsr', 'support.function.riscv.f'],
  ['fcvt.l.d', 'support.function.riscv.d'],
  ['fneg.d', 'support.function.riscv.d'],
  ['fmv.h', 'support.function.riscv.zfh'],
  ['negw', 'support.function.riscv.pseudo'],
  ['sgtz', 'support.function.riscv.pseudo'],
  // M2: the directive lookbehind keeps symbol-suffix dots uncolored; the
  // label scope lives on capture 1 (not the colon); the preprocessor rule
  // colors only the directive prefix
  ['foo.size', '(none)'],
  ['1:', 'entity.name.label.riscv'],
  ['#include', 'meta.preprocessor.riscv'],
].forEach(([t, want]) => probe('ISA', t, want));

// ---- no third-party license notice: the grammar is MRVC's own
check(
  'license: no third-party grammar license file ships (own-authored grammar)',
  !fs.existsSync(path.join(root, 'syntaxes', 'riscv-THIRD-PARTY-LICENSE.txt')),
  'the vendored-copy license file must stay deleted'
);

// ---- language configuration (MRVC's own)
const langCfg = JSON.parse(fs.readFileSync(LANGCFG, 'utf8'));
check(
  'langcfg: line comment #, block comment /* */, and the bracket pairs',
  langCfg.comments &&
    langCfg.comments.lineComment === '#' &&
    Array.isArray(langCfg.comments.blockComment) &&
    langCfg.comments.blockComment[0] === '/*' &&
    langCfg.comments.blockComment[1] === '*/' &&
    Array.isArray(langCfg.brackets) &&
    langCfg.brackets.length === 3,
  JSON.stringify(langCfg).slice(0, 160)
);

// ---- applyAsmAssociations: the opt-in .s/.S → mrvc-qingke writer
// (stub vscode the way intellisense-test does — needs the compiled out/)
const Module = require('module');
const WS = path.join(root, '.scratch', 'asm-assoc-ws');
const WS2 = path.join(root, '.scratch', 'asm-assoc-ws2');
fs.rmSync(WS, { recursive: true, force: true });
fs.rmSync(WS2, { recursive: true, force: true });
const settingsFile = path.join(WS, '.vscode', 'settings.json');
const settingsFile2 = path.join(WS2, '.vscode', 'settings.json');
const readFileText = (f) => {
  try {
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return null;
  }
};
const readSettings = () => readFileText(settingsFile);
// merged getConfiguration values per folder (undefined = the schema default
// {}, while null/[] are served VERBATIM like the real API does)
let workspaceFolders = [];
const mergedByWs = new Map();
const vscodeStub = {
  workspace: {
    get workspaceFolders() {
      return workspaceFolders;
    },
    getConfiguration: (section, uri) => ({
      get: (k, d) => {
        if (section !== 'files' || k !== 'associations') return d;
        const v = mergedByWs.get(uri.fsPath);
        return v === undefined ? d : v;
      },
    }),
  },
  window: {},
  Uri: { file: (f) => ({ fsPath: f }) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub-asm';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode-stub-asm'] = { id: 'vscode-stub-asm', filename: 'vscode-stub-asm', loaded: true, exports: vscodeStub };
try {
  const { applyAsmAssociations, LST_LANGUAGE_ID, MAP_LANGUAGE_ID } = require('../out/vscode/asmAssociations.js');
  const { writeWorkspaceCacheSettings } = require('../out/vscode/intellisense.js');
  const { stripJsonc } = require('../out/core/jsonc.js');
  const folder = (p, name, scheme) => ({ uri: { fsPath: p, scheme: scheme ?? 'file' }, name, index: 0 });
  const parseSettings = (text) => JSON.parse(stripJsonc(text));

  // 1. fresh folder inside a loaded MRS project: the assembler pair, *.lst
  //    and *.map are all written (no per-project output-dir glob — an
  //    EVT-style tree exploded that into dozens of lines, user feedback)
  workspaceFolders = [folder(WS, 'ws')];
  mergedByWs.clear();
  const r1 = applyAsmAssociations([WS]);
  const s1 = readSettings();
  const parsed1 = s1 !== null ? JSON.parse(s1) : null;
  check(
    'assoc: a fresh folder gets *.s/*.S → mrvc-qingke, *.lst and *.map defaults',
    r1.written.length === 1 &&
      parsed1 !== null &&
      parsed1['files.associations']?.['*.s'] === LANG_ID &&
      parsed1['files.associations']?.['*.S'] === LANG_ID &&
      parsed1['files.associations']?.['*.lst'] === LST_LANGUAGE_ID &&
      parsed1['files.associations']?.['*.map'] === MAP_LANGUAGE_ID,
    JSON.stringify(r1) + ' | ' + (s1 || 'null').slice(0, 200)
  );

  // 1b. migration: the per-output-dir globs the previous build generated are
  //     pruned where they still carry MRVC's own map language — the plain
  //     *.map replaces them (plain-JSON settings files)
  mergedByWs.clear();
  const legacyDirs = { 'adc/adc_x/obj/*.map': MAP_LANGUAGE_ID, 'ble/ble_uart/obj/*.map': MAP_LANGUAGE_ID };
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': { ...legacyDirs } }));
  mergedByWs.set(WS, { ...legacyDirs });
  const r1b = applyAsmAssociations([WS]);
  const assoc1b = JSON.parse(readSettings())['files.associations'];
  check(
    'assoc: per-output-dir *.map globs from the old build are pruned, plain *.map replaces them',
    r1b.written.length === 1 && assoc1b['*.map'] === MAP_LANGUAGE_ID && assoc1b['adc/adc_x/obj/*.map'] === undefined && assoc1b['ble/ble_uart/obj/*.map'] === undefined,
    JSON.stringify(assoc1b)
  );

  // 1c. a per-dir glob the USER repointed survives the migration untouched
  mergedByWs.clear();
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': { 'ble/obj/*.map': 'json' } }));
  mergedByWs.set(WS, { 'ble/obj/*.map': 'json' });
  const r1c = applyAsmAssociations([WS]);
  const assoc1c = JSON.parse(readSettings())['files.associations'];
  check(
    'assoc: a user-repointed per-dir *.map entry is never pruned',
    r1c.written.length === 1 && assoc1c['ble/obj/*.map'] === 'json' && assoc1c['*.map'] === MAP_LANGUAGE_ID,
    JSON.stringify(assoc1c)
  );

  // 1d. a JSONC settings file cannot take removals: its old per-dir keys
  //     stay (still pointing at mrvc-ld-map), its comments survive, and the
  //     new families are still merged in
  mergedByWs.clear();
  fs.writeFileSync(settingsFile, ['{', '  // my notes', '  "files.associations": {', '    "adc/obj/*.map": "mrvc-ld-map"', '  }', '}', ''].join('\n'));
  mergedByWs.set(WS, { 'adc/obj/*.map': 'mrvc-ld-map' });
  const r1d = applyAsmAssociations([WS]);
  const s1d = readSettings();
  const parsed1d = parseSettings(s1d);
  check(
    'assoc: a JSONC file keeps comments AND its old per-dir keys (removal skipped)',
    r1d.written.length === 1 &&
      s1d.includes('// my notes') &&
      parsed1d['files.associations']['adc/obj/*.map'] === 'mrvc-ld-map' &&
      parsed1d['files.associations']['*.map'] === MAP_LANGUAGE_ID &&
      parsed1d['files.associations']['*.lst'] === LST_LANGUAGE_ID,
    s1d.slice(0, 240)
  );

  // 2. idempotent: every family now carries its entries (a real VSCode
  //    merged view includes the workspace file) — skip
  mergedByWs.set(WS, { '*.s': LANG_ID, '*.S': LANG_ID, '*.lst': LST_LANGUAGE_ID, '*.map': MAP_LANGUAGE_ID });
  const r2 = applyAsmAssociations([WS]);
  check('assoc: the second run skips (own entries already present)', r2.skipped.length === 1 && r2.written.length === 0, JSON.stringify(r2));

  // 3. a user association for *.S blocks the whole assembler pair, but the
  //    INDEPENDENT .lst family still gets its default
  mergedByWs.set(WS, { '*.S': 'another-asm-mode' });
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': { '*.S': 'another-asm-mode' } }));
  const r3 = applyAsmAssociations([WS]);
  const parsed3 = JSON.parse(readSettings());
  check(
    'assoc: a user *.S value skips the assembler pair, *.lst still written',
    r3.written.length === 1 && parsed3['files.associations']['*.S'] === 'another-asm-mode' && parsed3['files.associations']['*.s'] === undefined && parsed3['files.associations']['*.lst'] === LST_LANGUAGE_ID,
    JSON.stringify(parsed3).slice(0, 200)
  );

  // 3b. same for *.s (the pair is all-or-nothing — MRVC never creates a
  //     mixed pair)
  mergedByWs.set(WS, { '*.s': 'arm' });
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': { '*.s': 'arm' } }));
  const r3b = applyAsmAssociations([WS]);
  const parsed3b = JSON.parse(readSettings());
  check(
    'assoc: a user value on ONE glob skips the pair (all-or-nothing)',
    r3b.written.length === 1 && parsed3b['files.associations']['*.s'] === 'arm' && parsed3b['files.associations']['*.S'] === undefined,
    JSON.stringify(parsed3b).slice(0, 200)
  );

  // 3c. a user *.map value keeps their choice; the other families still get
  //     their defaults
  mergedByWs.set(WS, { '*.map': 'json' });
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': { '*.map': 'json' } }));
  const r3c = applyAsmAssociations([WS]);
  const parsed3c = JSON.parse(readSettings());
  check(
    'assoc: a user *.map value keeps their choice; s/S and lst still written',
    r3c.written.length === 1 && parsed3c['files.associations']['*.map'] === 'json' && parsed3c['files.associations']['*.s'] === LANG_ID && parsed3c['files.associations']['*.lst'] === LST_LANGUAGE_ID,
    JSON.stringify(parsed3c).slice(0, 240)
  );

  // 4. sibling associations and settings survive the merge
  mergedByWs.set(WS, {});
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': { '*.foo': 'bar' }, 'editor.tabSize': 2 }));
  const r4 = applyAsmAssociations([WS]);
  const parsed4 = JSON.parse(readSettings());
  check(
    'assoc: sibling associations and settings survive the merge',
    r4.written.length === 1 && parsed4['files.associations']['*.foo'] === 'bar' && parsed4['files.associations']['*.s'] === LANG_ID && parsed4['editor.tabSize'] === 2,
    JSON.stringify(parsed4).slice(0, 200)
  );

  // 4b. JSONC comments inside and around files.associations survive (review H3)
  mergedByWs.set(WS, {});
  const jsonc = [
    '{',
    '  // MRVC cache notes',
    '  "files.associations": {',
    '    "*.h": "c" // C headers',
    '  },',
    '  "editor.tabSize": 2',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(settingsFile, jsonc);
  const r4b = applyAsmAssociations([WS]);
  const s4b = readSettings();
  const parsed4b = parseSettings(s4b);
  check(
    'assoc: JSONC comments inside files.associations survive the write',
    r4b.written.length === 1 &&
      s4b.includes('// MRVC cache notes') &&
      s4b.includes('// C headers') &&
      parsed4b['files.associations']['*.h'] === 'c' &&
      parsed4b['files.associations']['*.s'] === LANG_ID &&
      parsed4b['files.associations']['*.S'] === LANG_ID &&
      parsed4b['editor.tabSize'] === 2,
    s4b.slice(0, 240)
  );

  // 4c. an inline associations object is extended to still-valid JSONC
  mergedByWs.set(WS, {});
  fs.writeFileSync(settingsFile, '{\n  "files.associations": {"*.h": "c"},\n  "editor.tabSize": 2\n}\n');
  const r4c = applyAsmAssociations([WS]);
  const s4c = readSettings();
  let parsed4c = null;
  try {
    parsed4c = parseSettings(s4c);
  } catch {
    parsed4c = null;
  }
  check(
    'assoc: an inline associations object is extended to valid JSONC',
    r4c.written.length === 1 && parsed4c !== null && parsed4c['files.associations']['*.h'] === 'c' && parsed4c['files.associations']['*.s'] === LANG_ID && parsed4c['editor.tabSize'] === 2,
    s4c.slice(0, 200)
  );

  // 5. an unparsable settings.json is left untouched and reported
  fs.writeFileSync(settingsFile, '{{{ broken');
  const r5 = applyAsmAssociations([WS]);
  check('assoc: an unparsable settings.json is reported, not touched', r5.unreadable.length === 1 && readSettings() === '{{{ broken', JSON.stringify(r5));

  // 6. merged `files.associations: null` must not throw (review M1: the
  //    real API returns null verbatim — defaultValue only covers undefined)
  fs.rmSync(settingsFile, { force: true });
  mergedByWs.set(WS, null);
  const r6 = applyAsmAssociations([WS]);
  const parsed6 = JSON.parse(readSettings());
  check(
    'assoc: a null merged files.associations is coerced, the write proceeds',
    r6.written.length === 1 && r6.unreadable.length === 0 && parsed6['files.associations']['*.s'] === LANG_ID,
    JSON.stringify(r6)
  );

  // 7. a hand-edited ARRAY in files.associations is never overwritten
  mergedByWs.set(WS, {});
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': ['*.h'] }));
  const r7 = applyAsmAssociations([WS]);
  check(
    'assoc: an array in files.associations is reported, not overwritten',
    r7.unreadable.length === 1 && JSON.parse(readSettings())['files.associations'][0] === '*.h',
    JSON.stringify(r7)
  );

  // 7b. a disk `files.associations: null` carries nothing — replaced
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': null }, null, 2));
  const r7b = applyAsmAssociations([WS]);
  const parsed7b = JSON.parse(readSettings());
  check(
    'assoc: a disk null associations value is replaced by the object',
    r7b.written.length === 1 && parsed7b['files.associations']['*.S'] === LANG_ID,
    JSON.stringify(r7b)
  );

  // 8. a workspace folder WITHOUT an MRS project is left alone (review H2)
  mergedByWs.clear();
  workspaceFolders = [folder(WS2, 'docs')];
  const r8 = applyAsmAssociations([]);
  check(
    'assoc: a folder without an MRS project is not touched',
    r8.noProjects.length === 1 && r8.written.length === 0 && readFileText(settingsFile2) === null,
    JSON.stringify(r8)
  );

  // 8b. a non-file workspace folder (remote/virtual) is skipped (review M1)
  workspaceFolders = [folder(WS2, 'remote', 'vscode-remote')];
  const r8b = applyAsmAssociations([WS2]);
  check(
    'assoc: a non-file folder is skipped',
    r8b.noProjects.length === 1 && r8b.written.length === 0 && readFileText(settingsFile2) === null,
    JSON.stringify(r8b)
  );

  // 8c. multi-root: only the folder holding a project is written
  fs.rmSync(settingsFile, { force: true });
  mergedByWs.clear();
  workspaceFolders = [folder(WS, 'ws'), folder(WS2, 'docs')];
  const r8c = applyAsmAssociations([WS]);
  check(
    'assoc: multi-root — only the folder holding a project is written',
    r8c.written.length === 1 && r8c.noProjects.length === 1 && readFileText(settingsFile2) === null && JSON.parse(readSettings())['files.associations']['*.s'] === LANG_ID,
    JSON.stringify(r8c)
  );

  // 9. the legacy pre-release id counts as a plain user value — hands off
  //    (no migration code: the pre-release never shipped); the independent
  //    families still get their defaults
  mergedByWs.set(WS, { '*.s': 'mrvc-qingke-risc-v', '*.S': 'mrvc-qingke-risc-v' });
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': { '*.s': 'mrvc-qingke-risc-v', '*.S': 'mrvc-qingke-risc-v' } }, null, 2));
  const r9 = applyAsmAssociations([WS]);
  const assoc9 = JSON.parse(readSettings())['files.associations'];
  check(
    'assoc: a stale pre-release id pair is left untouched; lst/map defaults still written',
    r9.written.length === 1 && assoc9['*.s'] === 'mrvc-qingke-risc-v' && assoc9['*.S'] === 'mrvc-qingke-risc-v' && assoc9['*.lst'] === LST_LANGUAGE_ID && assoc9['*.map'] === MAP_LANGUAGE_ID,
    JSON.stringify(assoc9)
  );

  // 10. the exported object writer itself (review H3): array guard...
  fs.writeFileSync(settingsFile, JSON.stringify({ 'files.associations': [] }));
  const g1 = writeWorkspaceCacheSettings(settingsFile, [{ key: 'files.associations', value: { '*.s': LANG_ID }, kind: 'object' }]);
  check(
    'writer: an array in place of the object is unreadable',
    g1 === 'unreadable' && Array.isArray(JSON.parse(readSettings())['files.associations']),
    g1
  );

  // 10b. ...structural equality (a fresh literal is never ===; an equivalent
  //      object must not force a JSONC rewrite)
  const equalFile = '{ // keep me\n  "files.associations": { "*.s": "mrvc-qingke", "*.S": "mrvc-qingke" }\n}\n';
  fs.writeFileSync(settingsFile, equalFile);
  const g2 = writeWorkspaceCacheSettings(settingsFile, [
    { key: 'files.associations', value: { '*.s': LANG_ID, '*.S': LANG_ID }, kind: 'object' },
  ]);
  check('writer: an equivalent object value is "unchanged" (no rewrite)', g2 === 'unchanged' && readSettings() === equalFile, g2);

  // 10c. ...and a line-end comment behind the last entry stays on its line
  fs.writeFileSync(settingsFile, '{\n  "files.associations": {\n    "*.h": "c" // C headers\n  }\n}\n');
  const g3 = writeWorkspaceCacheSettings(settingsFile, [
    { key: 'files.associations', value: { '*.h': 'c', '*.s': LANG_ID }, kind: 'object' },
  ]);
  const s10c = readSettings();
  check(
    'writer: a line-end comment behind the last entry stays on its line',
    g3 === 'written' && s10c.includes('"*.h": "c", // C headers') && parseSettings(s10c)['files.associations']['*.s'] === LANG_ID,
    s10c
  );
} finally {
  Module._resolveFilename = origResolve;
  delete require.cache['vscode-stub-asm'];
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(WS2, { recursive: true, force: true });
}

console.log(failures ? '\n' + failures + ' FAILURES' : '\nall assembly highlight tests passed');
process.exit(failures ? 1 : 0);
