/*
 * MRS solution (.wvsln) tests against the CH32H417 EVT tree plus synthetic
 * fixtures: discovery, parsing (dedupe / stale paths / BuildOrder), member
 * project compatibility with the existing core, and absence of solutions
 * in the legacy test trees.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outCore = path.join(here, '..', 'out', 'core');

const { findSolutionFiles, findProjectRoots } = require(path.join(outCore, 'discover.js'));
const { parseSolution, writeSolution, appendSolutionMembers, recordBuildOrder } = require(path.join(outCore, 'solution.js'));
const { Cproject } = require(path.join(outCore, 'cproject.js'));
const { scanSources } = require(path.join(outCore, 'scan.js'));

// real EVT trees: prefer the local TEST copies, fall back to the F:/ layout
const TEST_ROOT = 'E:/Projects/MRS_VSCODE/TEST';
const pick = (...cands) => cands.find((r) => fs.existsSync(r)) ?? cands[cands.length - 1];
const H417 = pick(TEST_ROOT + '/CH32H417EVT/EXAM', 'F:/CH32H417/EVT/V1_0/EXAM');
const HAS_H417 = fs.existsSync(H417);
const LEGACY_TREES = [
  pick(TEST_ROOT + '/CH585EVT/EXAM', 'F:/CH585/EVT/V1_2/EXAM', 'E:/WORK/CH585/V1_7/EXAM'),
  pick(TEST_ROOT + '/CH587EVT/EXAM', 'F:/CH587/EVT/V1_0/EXAM', 'E:/WORK/CH587/V1_1/EXAM'),
  'F:/ch573/EVT/V2_4/EXAM',
  pick(TEST_ROOT + '/CH32V307EVT/EXAM', 'F:/CH32V307/EVT/V2_9/EXAM'),
].filter((t) => fs.existsSync(t));

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// ---------- 1. discovery ----------
const slnFiles = findSolutionFiles(H417);
// tree copies differ in solution count (70 upstream, 199 on the local TEST
// copy) — assert discovery completeness against a full enumeration, not a
// fixed count
const truthSln = [];
(function walk(dir, d) {
  if (d > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.wvsln')) truthSln.push(path.join(dir, e.name));
    else if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), d + 1);
  }
})(H417, 0);
check(
  `discovered all ${truthSln.length} solutions in CH32H417 (got ${slnFiles.length})`,
  !HAS_H417 || (slnFiles.length === truthSln.length && new Set(slnFiles.map((f) => f.toLowerCase())).size === truthSln.length)
);
// legacy trees have no NATIVE solutions (which always live in a project
// subdirectory); a root-level .wvsln can legitimately exist as a
// user-generated "all projects" artifact — tolerate it
for (const tree of LEGACY_TREES) {
  const nested = findSolutionFiles(tree).filter((f) => path.dirname(f) !== path.resolve(tree));
  check(`no native solutions in ${path.basename(path.dirname(path.dirname(tree)))}`, nested.length === 0);
}

// ---------- 2. parse all solutions: members exist and are real projects ----------
let parseFailures = 0;
let uniqueMembers = new Set();
for (const f of HAS_H417 ? slnFiles : []) {
  const p = parseSolution(f);
  if (!p.entries.length) {
    console.log(`  FAIL: ${f} has no resolvable members`);
    parseFailures++;
    continue;
  }
  for (const e of p.entries) {
    if (!fs.existsSync(path.join(e.resolved, '.project'))) {
      console.log(`  FAIL: member without .project: ${e.resolved}`);
      parseFailures++;
    }
    uniqueMembers.add(e.resolved.toLowerCase());
  }
}
check(`all ${slnFiles.length} solutions resolve >=1 real project member`, parseFailures === 0);

// every discoverable project in the tree is reachable as a solution member
if (HAS_H417) {
  const roots = findProjectRoots(H417);
  const rootKeys = new Set(roots.map((r) => r.toLowerCase()));
  const missing = roots.filter((r) => !uniqueMembers.has(r.toLowerCase()));
  check(`solution members cover all ${roots.length} discovered projects (missing ${missing.length})`, missing.length === 0);
} else {
  console.log('SKIP  2b. H417 member coverage (tree not present)');
}

// ---------- 3. stale absolute paths + dedupe (CH372Device) ----------
if (HAS_H417) {
  // tree copies differ: upstream ships 2 stale absolute member lines, the
  // local TEST copy ships none — expect exactly the stale lines the file has
  const staleCount = (raw) =>
    raw.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('-') && !l.startsWith('..') && /^[a-zA-Z]:/.test(l.trim())).length;
  const p = parseSolution(path.join(H417, 'USBFS/DEVICE/CH372Device/CH372Device.wvsln'));
  check('CH372Device: 2 deduped members', p.entries.length === 2);
  const raw372 = fs.readFileSync(path.join(H417, 'USBFS/DEVICE/CH372Device/CH372Device.wvsln'), 'utf-8');
  check(`CH372Device: stale absolute paths dropped (${p.dropped.length})`, p.dropped.length === staleCount(raw372));
  check('CH372Device: members are the local V3F/V5F', p.entries.every((e) => e.resolved.startsWith(path.join(H417, 'USBFS/DEVICE/CH372Device'))));

  // Host_UDisk_Exams.wvsln is a copy of CH372Device's: any stale absolute
  // lines point elsewhere (dropped), the ..\ lines resolve to its OWN local
  // V3F/V5F projects
  const h = parseSolution(path.join(H417, 'USBFS/HOST/Host_UDisk_Exams/Host_UDisk_Exams.wvsln'));
  const local = h.entries.filter((e) => e.resolved.startsWith(path.join(H417, 'USBFS/HOST/Host_UDisk_Exams')));
  check(`Host_UDisk_Exams: 2 members are its local V3F/V5F (got ${local.length})`, h.entries.length === 2 && local.length === 2);
  const rawHost = fs.readFileSync(path.join(H417, 'USBFS/HOST/Host_UDisk_Exams/Host_UDisk_Exams.wvsln'), 'utf-8');
  check('Host_UDisk_Exams: stale CH372Device absolute paths dropped', h.dropped.length === staleCount(rawHost));
} else {
  console.log('SKIP  3. CH372Device stale-path parsing (tree not present)');
}

// ---------- 4. member projects work with the existing core ----------
if (HAS_H417) {
  const cp = Cproject.load(path.join(H417, 'GPIO/GPIO_Toggle/V3F'));
  const sources = [...scanSources(cp).values()].reduce((n, v) => n + v.length, 0);
  // tree copies differ in the recorded rvGcc (12 upstream, 15 local): any
  // valid MRS toolchain version must parse
  check(`GPIO_Toggle V3F: toolchain rvGcc parsed (${cp.rvGccVersion})`, ['8', '12', '15'].includes(cp.rvGccVersion));
  check('GPIO_Toggle V3F: scan finds sources', sources > 0);
  const linkedNames = [...cp.linkedFolders.keys()].sort().join(',');
  check(`GPIO_Toggle V3F: linked folders resolved (${linkedNames})`, cp.linkedFolders.size >= 5);
} else {
  console.log('SKIP  4. H417 member core (tree not present)');
}

// ---------- 5. BuildOrder + header + config lines (synthetic fixture) ----------
{
  const fixtureDir = path.join(here, '..', '.scratch', 'solution-fixture');
  fs.mkdirSync(path.join(fixtureDir, 'B'), { recursive: true });
  fs.mkdirSync(path.join(fixtureDir, 'A'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'B', '.project'), '<?xml version="1.0" encoding="UTF-8"?><projectDescription></projectDescription>');
  fs.writeFileSync(path.join(fixtureDir, 'A', '.project'), '<?xml version="1.0" encoding="UTF-8"?><projectDescription></projectDescription>');
  const wvsln = [
    'F:/somewhere/MySln.wvsln:',
    '-arm:${eclipse_home}\\toolchain\\arm-none-eabi-gcc\\bin',
    '-build:${eclipse_home}\\toolchain\\Build Tools\\bin',
    '-openocd name:openocd.exe',
    '-openocd path:${eclipse_home}\\toolchain\\OpenOCD\\bin',
    '-rv:${eclipse_home}\\toolchain\\RISC-V Embedded GCC\\bin',
    'BuildOrder=B,A',
    '..\\B',
    '..\\A',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(fixtureDir, 'MySln.wvsln'), wvsln);
  const p = parseSolution(path.join(fixtureDir, 'MySln.wvsln'));
  check('fixture: 2 members resolved relative to the FILE', p.entries.length === 2);
  check('fixture: members are fixtureDir/B and fixtureDir/A', p.entries.every((e) => path.dirname(e.resolved) === fixtureDir));
  check('fixture: BuildOrder parsed [B, A]', JSON.stringify(p.buildOrder) === JSON.stringify(['B', 'A']));
  check('fixture: 5 toolchain config lines kept', p.configLines.length === 5);
  check('fixture: nothing dropped', p.dropped.length === 0);
}

// ---------- 6/7 member fixtures: the H417 dual-core projects where the
// tree exists, else synthetic same-name projects (a .project + <name>.wvproj
// is all parseSolution/appendSolutionMembers look at) ----------
const memberRoot = path.join(here, '..', '.scratch', 'solution-members');
const H417_MEMBERS = { V3F: 'GPIO/GPIO_Toggle/V3F', V5F: 'GPIO/GPIO_Toggle/V5F', ADC_DMA_V3F: 'ADC/ADC_DMA/V3F' };
const memberDir = (name) => {
  if (HAS_H417) return path.join(H417, H417_MEMBERS[name]);
  const d = path.join(memberRoot, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '.project'), `<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>${name}</name></projectDescription>`);
  fs.writeFileSync(path.join(d, `${name}.wvproj`), '');
  return d;
};

// ---------- 6. writeSolution round-trip (generate -> parse back) ----------
{
  const fixtureDir = path.join(here, '..', '.scratch', 'solution-fixture');
  const members = [memberDir('V3F'), memberDir('V5F')];
  const file = path.join(fixtureDir, 'Generated.wvsln');
  writeSolution(file, members);
  const raw = fs.readFileSync(file, 'utf-8');
  check('writeSolution: CRLF line endings', raw.includes('\r\n'));
  check('writeSolution: 5 toolchain lines, 4 with eclipse_home', (raw.match(/-.*eclipse_home/g) || []).length === 4 && (raw.match(/^-openocd name:openocd\.exe$/gm) || []).length === 1);
  const memberLines = raw.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('-'));
  check('writeSolution: member lines backslash-separated, ..\\ prefixed (MRS2 convention)', memberLines.length === 2 && memberLines.every((l) => l.startsWith('..\\') && !l.includes('/')));

  const back = parseSolution(file);
  check('round-trip: same member count', back.entries.length === members.length);
  const norm = (s) => s.toLowerCase();
  check(
    'round-trip: resolved member set identical to input',
    JSON.stringify(back.entries.map((e) => norm(e.resolved)).sort()) === JSON.stringify(members.map(norm).sort())
  );
  check('round-trip: nothing dropped', back.dropped.length === 0);
  check('round-trip: no BuildOrder written', back.buildOrder === undefined);

  if (HAS_H417) {
    // generating at the tree root: all 140 projects round-trip
    const allRoots = findProjectRoots(H417);
    const rootFile = path.join(H417, '_MRVC_AllProjects.wvsln');
    writeSolution(rootFile, allRoots);
    const backAll = parseSolution(rootFile);
    check(
      `round-trip at tree root: all ${allRoots.length} projects resolve back`,
      backAll.entries.length === allRoots.length &&
        JSON.stringify(backAll.entries.map((e) => norm(e.resolved)).sort()) === JSON.stringify(allRoots.map(norm).sort())
    );
    fs.rmSync(rootFile, { force: true }); // do not leave a synthetic solution in the real tree
  } else {
    console.log('SKIP  6b. tree-root round-trip (H417 tree not present)');
  }
}

// ---------- 7. solution lifecycle: appendSolutionMembers + recordBuildOrder ----------
{
  const fixtureDir = path.join(here, '..', '.scratch', 'solution-fixture');
  const m1 = memberDir('V3F');
  const m2 = memberDir('V5F');
  const m3 = memberDir('ADC_DMA_V3F');
  const file = path.join(fixtureDir, 'Lifecycle.wvsln');
  writeSolution(file, [m1, m2], ['V5F', 'V3F']);
  const before = fs.readFileSync(file, 'utf-8');

  // append a new member: existing bytes preserved, only new lines added
  const added = appendSolutionMembers(file, [m3]);
  check('append: one root added', added.length === 1);
  const afterAppend = fs.readFileSync(file, 'utf-8');
  check('append: existing content byte-preserved as prefix', afterAppend.startsWith(before.replace(/\r\n$/, '')));
  const pAfter = parseSolution(file);
  check('append: now 3 members', pAfter.entries.length === 3);
  check('append: BuildOrder untouched (2 names)', pAfter.buildOrder?.join(',') === 'V5F,V3F');

  // duplicate append is a no-op (case-insensitive)
  const added2 = appendSolutionMembers(file, [m3]);
  check('append: duplicate is a no-op', added2.length === 0);
  check('append: file unchanged after duplicate', fs.readFileSync(file, 'utf-8') === afterAppend);

  // recordBuildOrder: only the BuildOrder line moves, everything else preserved
  const linesBefore = afterAppend.split(/\r?\n/).filter((l) => l !== '');
  recordBuildOrder(file, ['V3F', 'V5F', 'ADC_DMA_V3F']);
  const linesAfter = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter((l) => l !== '');
  check(
    'recordOrder: only the BuildOrder line differs',
    linesBefore.filter((l) => !l.startsWith('BuildOrder=')).join('\n') === linesAfter.filter((l) => !l.startsWith('BuildOrder=')).join('\n')
  );
  const pOrder = parseSolution(file);
  check('recordOrder: new order parses back', pOrder.buildOrder?.join(',') === 'V3F,V5F,ADC_DMA_V3F');
  // MRS2 placement: an EXISTING line is rewritten in place — inserting after
  // the first line as well is exactly the duplicate-line bug (one call on a
  // file that already had BuildOrder= used to produce TWO lines, and every
  // further "Set Build Order" click added one more)
  const rawLines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
  const posBefore = afterAppend.split(/\r?\n/).findIndex((l) => l.startsWith('BuildOrder='));
  check('recordOrder: existing line rewritten in place', rawLines[posBefore] === 'BuildOrder=V3F,V5F,ADC_DMA_V3F');
  check('recordOrder: exactly one BuildOrder line', rawLines.filter((l) => l.startsWith('BuildOrder=')).length === 1);

  recordBuildOrder(file, ['V3F', 'V5F', 'ADC_DMA_V3F']);
  recordBuildOrder(file, ['V5F', 'V3F', 'ADC_DMA_V3F']);
  const rawRepeat = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
  check('recordOrder: repeated calls never accumulate', rawRepeat.filter((l) => l.startsWith('BuildOrder=')).length === 1);
  check('recordOrder: last call wins', parseSolution(file).buildOrder?.join(',') === 'V5F,V3F,ADC_DMA_V3F');

  // absent line: inserted right after the first line (toolchain block head)
  const noOrder = path.join(fixtureDir, 'NoOrder.wvsln');
  fs.writeFileSync(
    noOrder,
    afterAppend.split(/\r?\n/).filter((l) => !l.startsWith('BuildOrder=')).join('\r\n'),
    'utf-8'
  );
  recordBuildOrder(noOrder, ['V5F', 'V3F']);
  const noOrderLines = fs.readFileSync(noOrder, 'utf-8').split(/\r?\n/);
  check('recordOrder: missing line inserted after first line', noOrderLines[1] === 'BuildOrder=V5F,V3F');
  check('recordOrder: insert keeps every other line', noOrderLines.filter((l, i) => i !== 1 && !l.startsWith('BuildOrder=')).join('\n') === afterAppend.split(/\r?\n/).filter((l) => !l.startsWith('BuildOrder=')).join('\n'));
  check('recordOrder: insert leaves exactly one line', noOrderLines.filter((l) => l.startsWith('BuildOrder=')).length === 1);
  fs.rmSync(noOrder, { force: true });

  fs.rmSync(file, { force: true });
}

// ---------- byte-fidelity: LF files stay LF; hand-indented BuildOrder is
// detected on the write side (the parser trims) and rewritten in place ----------
{
  const dir = path.join(here, '..', '.scratch', 'solution-eol');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const lfFile = path.join(dir, 'lf.wvsln');
  fs.writeFileSync(lfFile, 'Toolchain=GCC12\nProj1\nProj2\n', 'utf-8');
  recordBuildOrder(lfFile, ['Proj2', 'Proj1']);
  const afterLf = fs.readFileSync(lfFile, 'utf-8');
  check('BuildOrder: LF file stays LF (no CRLF normalization)', !afterLf.includes('\r'));
  check('BuildOrder: LF file rewritten in place after first line', afterLf.startsWith('Toolchain=GCC12\nBuildOrder=Proj2,Proj1\n'));

  const indFile = path.join(dir, 'indented.wvsln');
  fs.writeFileSync(indFile, 'Toolchain=GCC12\r\n  BuildOrder=Proj2,Proj1\r\nProj1\r\nProj2\r\n', 'utf-8');
  recordBuildOrder(indFile, ['Proj1', 'Proj2']);
  const rawInd = fs.readFileSync(indFile, 'utf-8');
  check('BuildOrder: indented line detected (no duplicate inserted)', (rawInd.match(/BuildOrder=/g) || []).length === 1);
  check('BuildOrder: indented line rewritten in place, indent kept', rawInd.includes('\r\n  BuildOrder=Proj1,Proj2\r\n'));
  check('BuildOrder: indented order now effective on parse', parseSolution(indFile).buildOrder?.join(',') === 'Proj1,Proj2');
  // repeat: still exactly one line (idempotent on the indented form too)
  recordBuildOrder(indFile, ['Proj2', 'Proj1']);
  check('BuildOrder: indented rewrite idempotent', (fs.readFileSync(indFile, 'utf-8').match(/BuildOrder=/g) || []).length === 1);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURES` : '\nall solution tests passed');
process.exit(failures ? 1 : 0);
