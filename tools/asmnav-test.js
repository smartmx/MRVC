/*
 * Assembly navigation tests (0.3.8): the pure-Node core of the .s/.S
 * Go-to-Definition provider (src/core/asmNav.ts) — comment/register/
 * mnemonic masking, #include/.include extraction, GAS numeric labels
 * (1b/1f), local .equ/.set/#define labels, GNU ld symbol lookup with
 * block-comment skipping, include resolution over -I dirs, and the
 * owning-project ranking that keeps EVT-style cross-project duplicate
 * symbols (main/SystemInit/handlers) from mis-jumping.
 *
 * Run: node tools/asmnav-test.js   (needs the compiled out/core/asmNav.js)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail === undefined ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const {
  isInLineComment,
  isInBlockComment,
  extractAsmCursorTarget,
  findLocalAsmDefinitions,
  findLinkerScriptSymbol,
  resolveIncludeFile,
  rankWorkspaceSymbolCandidates,
} = require('../out/core/asmNav.js');

// ---- comment masking
check('mask: `call main # note` cursor in the comment is masked', isInLineComment('call main # note', 13) === true);
check('mask: `// SystemInit` cursor inside is masked', isInLineComment('// SystemInit', 5) === true);
check('mask: a #include line is NOT a comment at the directive', isInLineComment('#include "ch32v30x.h"', 2) === false);
check('mask: plain code is not masked', isInLineComment('la a0, SystemInit', 6) === false);

// ---- cursor target extraction
const at = (line, col) => extractAsmCursorTarget(line, col);
let t = at('#include "ch32v30x.h"', 10);
check('target: #include spec extracted', t !== null && t.kind === 'include' && t.spec === 'ch32v30x.h', JSON.stringify(t));
t = at('.include "macros.inc"', 12);
check('target: .include spec extracted', t !== null && t.kind === 'include' && t.spec === 'macros.inc', JSON.stringify(t));
t = at('bne a0, a1, 1b', 13);
check('target: 1b is a backward numeric label', t !== null && t.kind === 'numeric-label' && t.label === '1' && t.dir === 'b', JSON.stringify(t));
t = at('1: bne a0, a1, 1f', 15);
check('target: 1f is a forward numeric label', t !== null && t.kind === 'numeric-label' && t.dir === 'f', JSON.stringify(t));
t = at('addi sp,sp,-16', 12);
check('target: an immediate number is not navigable', t === null, JSON.stringify(t));
t = at('mv sp, a0', 3);
check('target: ABI register sp is not navigable', t === null, JSON.stringify(t));
check('target: x10 register form is not navigable', at('csrr x10, mepc', 6) === null);
t = at('fmv.s fa3, ft0', 7);
check('target: float ABI register fa3 is not navigable', t === null, JSON.stringify(t));
check('target: float ABI register ft0 is not navigable', at('fmv.s fa3, ft0', 12) === null);
t = at('call main', 5);
check('target: call main yields the symbol', t !== null && t.kind === 'symbol' && t.name === 'main', JSON.stringify(t));
// GNU-as local labels carry a leading dot — the token must keep it, or the
// lookup would search "Lloop" and miss (or mismatch) the real `.Lloop:`
t = at('j .Lloop', 4);
check('target: .Lloop keeps its leading dot', t !== null && t.kind === 'symbol' && t.name === '.Lloop', JSON.stringify(t));
t = at('j .Ldone', 2);
check('target: .Ldone extracted at the dot itself', t !== null && t.kind === 'symbol' && t.name === '.Ldone', JSON.stringify(t));
t = at('la a0, SystemInit', 10);
check('target: la a0, SystemInit yields the symbol', t !== null && t.kind === 'symbol' && t.name === 'SystemInit', JSON.stringify(t));
t = at('la gp, __global_pointer$', 9);
check('target: linker symbols keep their trailing $', t !== null && t.kind === 'symbol' && t.name === '__global_pointer$', JSON.stringify(t));
t = at('.word NMI_Handler', 6);
check('target: .word handler reference yields the symbol', t !== null && t.kind === 'symbol' && t.name === 'NMI_Handler', JSON.stringify(t));
check('target: ret is masked as a zero-operand mnemonic', at('ret', 1) === null);
check('target: cursor on whitespace yields nothing', at('la a0, SystemInit', 5) === null);
check('target: cursor inside a # comment yields nothing', at('call main # note', 12) === null);
// H1 companion: block comments (WCH startup banners) mask the document too
const bannerOne = ['/* banner with main inside */', 'call main'].join('\n');
check('block: inside a same-line banner is masked', isInBlockComment(bannerOne, bannerOne.indexOf('main')) === true);
check('block: code after the closer is not masked', isInBlockComment(bannerOne, bannerOne.lastIndexOf('main')) === false);
const bannerMulti = ['/*', ' * main lives here', ' */', 'call main'].join('\n');
check('block: a banner opened by an EARLIER line masks inner words', isInBlockComment(bannerMulti, bannerMulti.indexOf('lives')) === true);
check('block: code after the multi-line banner is clean', isInBlockComment(bannerMulti, bannerMulti.lastIndexOf('main')) === false);

// ---- local definitions (labels / .equ / #define / numeric)
const doc = [
  '1: bne a0, a1, 1f',
  '2: j handle_reset',
  '1: nop',
  '.equ STACK_SIZE, 0x400',
  '#define USE_API 1',
  'handle_reset:',
  '  call main',
  '  j 1b',
  '.equ eq, 1',
  '#define def 1',
].join('\n');
const nl = (dir) => findLocalAsmDefinitions(doc, { kind: 'numeric-label', label: '1', dir }, 7);
let hits = nl('b');
check('numeric: 1b from line 7 lands on the NEAREST 1: above (line 2)', hits.length === 1 && hits[0].line === 2, JSON.stringify(hits));
hits = nl('f');
check('numeric: 1f has no label below — empty', hits.length === 0, JSON.stringify(hits));
hits = findLocalAsmDefinitions(doc, { kind: 'numeric-label', label: '1', dir: 'f' }, 0);
check('numeric: 1f from line 0 lands on line 2', hits.length === 1 && hits[0].line === 2, JSON.stringify(hits));
hits = findLocalAsmDefinitions(doc, { kind: 'symbol', name: 'handle_reset' }, 1);
check('label: handle_reset defined at line 5 (cursor line 1 self-alias skipped)', hits.length === 1 && hits[0].line === 5, JSON.stringify(hits));
hits = findLocalAsmDefinitions(doc, { kind: 'symbol', name: 'STACK_SIZE' }, 6);
check('.equ: STACK_SIZE found on line 3', hits.length === 1 && hits[0].line === 3, JSON.stringify(hits));
hits = findLocalAsmDefinitions(doc, { kind: 'symbol', name: 'USE_API' }, 6);
check('#define: USE_API found on line 4', hits.length === 1 && hits[0].line === 4, JSON.stringify(hits));
hits = findLocalAsmDefinitions(doc, { kind: 'symbol', name: 'eq' }, 0);
check('.equ: short name `eq` column points at the symbol (not inside .equ)', hits.length === 1 && hits[0].line === 8 && hits[0].col === 5, JSON.stringify(hits));
hits = findLocalAsmDefinitions(doc, { kind: 'symbol', name: 'def' }, 0);
check('#define: short name `def` column points at the symbol', hits.length === 1 && hits[0].line === 9 && hits[0].col === 8, JSON.stringify(hits));

// ---- .L local labels (review P2): the dotted token must match the dotted
// definition, and a bare same-name label must NOT shadow it
{
  const ldoc = ['.Lloop:', '  j .Lloop', 'Lloop:', '  nop', '  j .Lloop'].join('\n');
  const lh = findLocalAsmDefinitions(ldoc, { kind: 'symbol', name: '.Lloop' }, 1);
  check('.L: the dotted reference resolves to the DOTTED label (line 0)', lh.length === 1 && lh[0].line === 0, JSON.stringify(lh));
  const lh2 = findLocalAsmDefinitions(ldoc, { kind: 'symbol', name: '.Lloop' }, 4);
  check('.L: the later dotted reference still finds only line 0', lh2.length === 1 && lh2[0].line === 0, JSON.stringify(lh2));
  const bh = findLocalAsmDefinitions(ldoc, { kind: 'symbol', name: 'Lloop' }, 4);
  check('.L: the bare Lloop still finds its own bare label (line 2)', bh.length === 1 && bh[0].line === 2, JSON.stringify(bh));
}

// ---- same-line backward numeric label (review P3): the legal one-liner
// `1: j 1b` must resolve to THIS line's `1:` — the reference column puts
// the definition strictly before it
{
  const sdoc = ['1: nop', '2: j 1b', '1: j 1b', '3: nop'].join('\n');
  const sh = findLocalAsmDefinitions(sdoc, { kind: 'numeric-label', label: '1', dir: 'b' }, 2, 7);
  check('same-line: 1b at col 7 lands on THIS line 2 label', sh.length === 1 && sh[0].line === 2, JSON.stringify(sh));
  const sh2 = findLocalAsmDefinitions(sdoc, { kind: 'numeric-label', label: '1', dir: 'b' }, 1, 7);
  check('same-line: without a same-line def, 1b from line 1 lands on line 0', sh2.length === 1 && sh2[0].line === 0, JSON.stringify(sh2));
  const sh3 = findLocalAsmDefinitions(sdoc, { kind: 'numeric-label', label: '1', dir: 'b' }, 2, -1);
  check('same-line: no column given keeps the legacy cross-line search (line 1 has no 1:, so line 0)', sh3.length === 1 && sh3[0].line === 0, JSON.stringify(sh3));
}

// ---- GNU ld script lookup (block comments blanked, line numbers true)
const tmpDir = path.join(os.tmpdir(), 'mrvc-asmnav-test');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpDir, 'inc'), { recursive: true });
const ldFile = path.join(tmpDir, 'Link.ld');
fs.writeFileSync(
  ldFile,
  ['/* the old _eusrstack note lives in a comment */', '_eusrstack = ORIGIN(FLASH) + LENGTH(FLASH);', 'PROVIDE(_sbss = _ebss);', 'PROVIDE_HIDDEN(__global_pointer$ = . + 0x800);', 'PROVIDE(OV = .);', ''].join('\n')
);
let ld = findLinkerScriptSymbol(ldFile, '_eusrstack');
check('ld: _eusrstack assignment found on line 1 (comment on line 0 skipped)', ld !== null && ld.line === 1 && ld.col === 0, JSON.stringify(ld));
ld = findLinkerScriptSymbol(ldFile, '_sbss');
check('ld: PROVIDE(_sbss = …) found on line 2', ld !== null && ld.line === 2, JSON.stringify(ld));
ld = findLinkerScriptSymbol(ldFile, '__global_pointer$');
check('ld: PROVIDE_HIDDEN with $ suffix found on line 3', ld !== null && ld.line === 3, JSON.stringify(ld));
ld = findLinkerScriptSymbol(ldFile, 'comment');
check('ld: a word inside the block comment is not a symbol', ld === null, JSON.stringify(ld));
ld = findLinkerScriptSymbol(ldFile, 'OV');
check('ld: short name `OV` column points at the symbol (not inside PROVIDE)', ld !== null && ld.line === 4 && ld.col === 8, JSON.stringify(ld));
ld = findLinkerScriptSymbol(path.join(tmpDir, 'missing.ld'), '_eusrstack');
check('ld: a missing script file degrades to null', ld === null);

// ---- include resolution over -I dirs
fs.writeFileSync(path.join(tmpDir, 'main.S'), '');
fs.writeFileSync(path.join(tmpDir, 'header.h'), '');
fs.writeFileSync(path.join(tmpDir, 'inc', 'ch32v30x.h'), '');
const incDirs = [path.join(tmpDir, 'inc')];
let inc = resolveIncludeFile('header.h', path.join(tmpDir, 'main.S'), incDirs);
check('include: sibling header resolves next to the .S first', inc !== null && path.basename(inc) === 'header.h', String(inc));
inc = resolveIncludeFile('ch32v30x.h', path.join(tmpDir, 'main.S'), incDirs);
check('include: -I dir member resolves through the include path', inc !== null && path.basename(inc) === 'ch32v30x.h', String(inc));
inc = resolveIncludeFile('nope.h', path.join(tmpDir, 'main.S'), incDirs);
check('include: an unknown header degrades to null', inc === null);

// ---- owning-project ranking (EVT duplicate-symbol guard)
const A = path.join(tmpDir, 'projA');
const B = path.join(tmpDir, 'projB');
const projectFiles = new Set([
  path.join(A, 'main.c'),
  path.join(A, 'main.h'),
  path.join(A, 'startup.S'),
].map((f) => f.toLowerCase()));
const candidates = [
  { name: 'SystemInit', file: path.join(B, 'system_B.c'), line: 4, col: 0, kindTag: 'function' },
  { name: 'SystemInit', file: path.join(A, 'main.h'), line: 2, col: 0, kindTag: 'function' },
  { name: 'SystemInit', file: path.join(A, 'main.c'), line: 10, col: 0, kindTag: 'function' },
  { name: 'SystemInit', file: path.join(A, 'startup.S'), line: 33, col: 6, kindTag: 'other' },
  { name: 'SystemInit', file: path.join(A, 'main.c'), line: 10, col: 0, kindTag: 'function' }, // exact duplicate
  { name: 'SystemInitX', file: path.join(A, 'main.c'), line: 99, col: 0, kindTag: 'function' }, // not exact
];
const ranked = rankWorkspaceSymbolCandidates(candidates, 'SystemInit', {
  currentFile: path.join(A, 'startup.S'),
  currentLine: 33,
  projectFiles,
  projectRoot: A,
});
check(
  'rank: owning-project .c first, then .h, foreign project last; self-line, duplicate and non-exact dropped',
  ranked.length === 3 &&
    ranked[0].file === path.join(A, 'main.c') &&
    ranked[0].line === 10 &&
    ranked[1].file === path.join(A, 'main.h') &&
    ranked[2].file === path.join(B, 'system_B.c'),
  JSON.stringify(ranked.map((r) => `${r.file}:${r.line}`))
);

// H1: cpptools names functions WITH their parameter list — the ranking must
// strip it (keeping class qualifiers, so members do not answer globals)
const cppNames = [
  { name: 'SystemInit(void)', file: path.join(A, 'main.c'), line: 10, col: 0, kindTag: 'function' },
  { name: 'Foo::SystemInit(void)', file: path.join(B, 'cxx.cpp'), line: 3, col: 0, kindTag: 'function' },
  { name: 'SystemInitEx(void)', file: path.join(A, 'main.h'), line: 5, col: 0, kindTag: 'function' },
  { name: 'SystemInit', file: path.join(A, 'main.h'), line: 2, col: 0, kindTag: 'variable' },
];
const rankedCpp = rankWorkspaceSymbolCandidates(cppNames, 'SystemInit', {
  currentFile: path.join(A, 'startup.S'),
  currentLine: 33,
  projectFiles,
  projectRoot: A,
});
check(
  'rank: `SystemInit(void)` matches the bare symbol alongside plain entries',
  rankedCpp.length === 2 && rankedCpp[0].file === path.join(A, 'main.c') && rankedCpp[0].line === 10 && rankedCpp[1].file === path.join(A, 'main.h'),
  JSON.stringify(rankedCpp.map((r) => `${r.file}:${r.line}`))
);
check(
  'rank: Foo::SystemInit(void) and SystemInitEx(void) do NOT answer SystemInit',
  rankedCpp.every((r) => r.file !== path.join(B, 'cxx.cpp') && r.line !== 5),
  JSON.stringify(rankedCpp.map((r) => `${r.file}:${r.line}`))
);
const rankedMain = rankWorkspaceSymbolCandidates(
  [{ name: 'main(int, char **)', file: path.join(A, 'main.c'), line: 12, col: 0, kindTag: 'function' }],
  'main',
  { currentFile: path.join(A, 'startup.S'), currentLine: 33, projectFiles, projectRoot: A }
);
check('rank: `main(int, char **)` matches bare main', rankedMain.length === 1 && rankedMain[0].line === 12, JSON.stringify(rankedMain));

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures ? '\n' + failures + ' FAILURES' : '\nall asm navigation tests passed');
process.exit(failures ? 1 : 0);
