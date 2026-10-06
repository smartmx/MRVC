/*
 * Analysis + custom toolchain tests: GCC .su parsing/aggregation, RTL dump
 * call extraction, report rendering, custom toolchain resolution and
 * merge-over-installed semantics.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const a = require('../out/core/analysis.js');
const tc = require('../out/core/toolchain.js');

// ---------- 1. .su parsing ----------
{
  const su = [
    'F:/x/src/main.c:12:5:main\t64\tstatic',
    'F:/x/src/led.c:8:1:led_on\t8\tstatic',
    '',
    'F:/x/src/alloc.c:3:1:use_alloca\t16\tdynamic',
  ].join('\n');
  const recs = a.parseStackUsage([su]);
  check('su: 3 records', recs.length === 3);
  check('su: sorted by size desc', recs[0].name === 'main' && recs[0].size === 64);
  check('su: dynamic flag parsed', recs.some((r) => r.name === 'use_alloca' && !r.isStatic));
  check('su: static flag parsed', recs.every((r) => r.name !== 'use_alloca' || true) && recs.find((r) => r.name === 'main').isStatic);
  check('su: location kept', recs.find((r) => r.name === 'led_on').file === 'F:/x/src/led.c');
  check('su: garbage line skipped', a.parseStackUsage(['not a su line']).length === 0);
  check('su: dedupe across TUs', a.parseStackUsage([su, su]).length === 3);
}

// ---------- 2. report rendering ----------
{
  const recs = a.parseStackUsage(['F:/x/main.c:1:1:main\t100\tstatic', 'F:/x/a.c:2:1:dyn\t4\tdynamic']);
  const rep = a.stackReport(recs);
  check('report: header', rep.startsWith('# MRVC Static Stack Usage'));
  check('report: total line', rep.includes('total own stack: 104 bytes'));
  check('report: dynamic warning', rep.includes('Dynamic frames') && rep.includes('dyn'));
}

// ---------- 3. RTL dump call extraction ----------
{
  const dump = [
    // real GCC headers (GCC8/12/15): "name (name, funcid=1)"; a bare name must be tolerated too
    ';; Function main (main, funcid=1)',
    '',
    '\t(insn 10 8 12 (set (mem/f (plus (reg) (reg)) [0 S4 A32]))',
    '\t    (call (mem:SI (symbol_ref:SI ("led_on") [flags 0x3]) [0 S4 A32]) ()))',
    '',
    ';; Function led_on (led_on, funcdef=1)',
    '',
    '\t(call (mem:SI (symbol_ref:SI ("delay_ms") [flags 0x3]) ()))',
    '',
    ';; Function bare_header',
    '\t(call (mem:SI (symbol_ref:SI ("noop") [flags 0x3]) ()))',
  ].join('\r\n');
  const calls = a.parseDumpCalls(dump);
  check('dump: 3 edges', calls.length === 3);
  check('dump: main -> led_on', calls.some((e) => e.caller === 'main' && e.callee === 'led_on'));
  check('dump: led_on -> delay_ms', calls.some((e) => e.caller === 'led_on' && e.callee === 'delay_ms'));
  check('dump: bare header still a caller', calls.some((e) => e.caller === 'bare_header' && e.callee === 'noop'));
  check('dump: caller never carries the (name, funcid=..) tail', calls.every((e) => !/[()]/.test(e.caller)));
  const rep = a.callReport(calls);
  check('call report: markdown edges', rep.includes('- led_on -> delay_ms') && rep.includes('- main -> led_on'));
  check('call report: empty safe', a.callReport([]).includes('(no call edges found)'));
}

// ---------- 4. analysis flags ----------
check('flags: stack usage + rtl expand', JSON.stringify(a.analysisFlags()) === JSON.stringify(['-fstack-usage', '-fdump-rtl-expand']));

// ---------- 5. custom toolchains ----------
{
  const WS = path.join(__dirname, '..', '.scratch', 'analysis-tc');
  // fake toolchain: bin/riscv-fake-gcc.exe etc.
  const bin = path.join(WS, 'fake-tc', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['riscv-fake-gcc.exe', 'riscv-fake-g++.exe', 'riscv-fake-gdb.exe', 'riscv-fake-objcopy.exe', 'riscv-fake-objdump.exe', 'riscv-fake-size.exe']) {
    fs.writeFileSync(path.join(bin, f), '', 'utf-8');
  }
  const resolved = tc.resolveCustomToolchain({ name: 'FAKE', path: path.join(WS, 'fake-tc') });
  check('custom: resolved', !!resolved);
  check('custom: prefix auto-detected', resolved?.prefix === 'riscv-fake-');
  check('custom: compiler path under bin', !!resolved && resolved.compilerC.toLowerCase().includes(path.join('bin', 'riscv-fake-gcc')));
  check('custom: missing bin -> null', tc.resolveCustomToolchain({ name: 'X', path: path.join(WS, 'no-such') }) === null);
  check('custom: no gcc -> null', (() => {
    const bin2 = path.join(WS, 'nogcc', 'bin');
    fs.mkdirSync(bin2, { recursive: true });
    fs.writeFileSync(path.join(bin2, 'riscv-x-size.exe'), '');
    return tc.resolveCustomToolchain({ name: 'X', path: path.join(WS, 'nogcc') }) === null;
  })());

  // merge over installed: custom wins by name (case-insensitive), others kept
  const install = {
    root: 'C:/MRS2', resourcesWin32: '', components: '', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '',
    toolchains: [
      { name: 'FAKE', dir: 'C:/installed-fake', compilerC: 'c', compilerCpp: 'cpp', linkerC: '', linkerCpp: '', debugger: '', objcopy: '', objdump: '', size: '', prefix: 'p-' },
      { name: 'GCC12', dir: 'C:/gcc12', compilerC: 'c12', compilerCpp: 'cpp12', linkerC: '', linkerCpp: '', debugger: '', objcopy: '', objdump: '', size: '', prefix: 'q-' },
    ],
  };
  const merged = tc.mergeCustomToolchains(install, [{ name: 'fake', path: path.join(WS, 'fake-tc') }]);
  const fakeEntry = merged.toolchains.find((t2) => t2.name.toLowerCase() === 'fake');
  check('merge: custom wins same name (case-insensitive)', !!fakeEntry && fakeEntry.dir === path.join(WS, 'fake-tc'));
  check('merge: installed others kept', merged.toolchains.some((t2) => t2.name === 'GCC12'));
  check('merge: no duplicates', merged.toolchains.filter((t2) => t2.name.toLowerCase() === 'fake').length === 1);
  const mergedNone = tc.mergeCustomToolchains(install, []);
  check('merge: empty custom is identity', mergedNone === install);
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURES` : '\nall analysis tests passed');
process.exit(failures ? 1 : 0);
