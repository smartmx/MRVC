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
const { parseSolution, writeSolution } = require(path.join(outCore, 'solution.js'));
const { Cproject } = require(path.join(outCore, 'cproject.js'));
const { scanSources } = require(path.join(outCore, 'scan.js'));

const H417 = 'F:/CH32H417/EVT/V1_0/EXAM';
const LEGACY_TREES = ['F:/CH585/EVT/V1_2/EXAM', 'F:/CH587/EVT/V1_0/EXAM', 'F:/ch573/EVT/V2_4/EXAM', 'F:/CH32V307/EVT/V2_9/EXAM'];

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// ---------- 1. discovery ----------
const slnFiles = findSolutionFiles(H417);
check(`discovered 70 solutions in CH32H417 (got ${slnFiles.length})`, slnFiles.length === 70);
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
for (const f of slnFiles) {
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
const roots = findProjectRoots(H417);
const rootKeys = new Set(roots.map((r) => r.toLowerCase()));
const missing = roots.filter((r) => !uniqueMembers.has(r.toLowerCase()));
check(`solution members cover all ${roots.length} discovered projects (missing ${missing.length})`, missing.length === 0);

// ---------- 3. stale absolute paths + dedupe (CH372Device) ----------
{
  const p = parseSolution(path.join(H417, 'USBFS/DEVICE/CH372Device/CH372Device.wvsln'));
  check('CH372Device: 2 deduped members (4 raw lines)', p.entries.length === 2);
  check('CH372Device: 2 stale absolute paths dropped', p.dropped.length === 2);
  check('CH372Device: members are the local V3F/V5F', p.entries.every((e) => e.resolved.startsWith(path.join(H417, 'USBFS/DEVICE/CH372Device'))));

  // Host_UDisk_Exams.wvsln is a copy of CH372Device's: the stale absolute
  // lines point elsewhere (dropped), the ..\ lines resolve to its OWN local
  // V3F/V5F projects
  const h = parseSolution(path.join(H417, 'USBFS/HOST/Host_UDisk_Exams/Host_UDisk_Exams.wvsln'));
  const local = h.entries.filter((e) => e.resolved.startsWith(path.join(H417, 'USBFS/HOST/Host_UDisk_Exams')));
  check(`Host_UDisk_Exams: 2 members are its local V3F/V5F (got ${local.length})`, h.entries.length === 2 && local.length === 2);
  check('Host_UDisk_Exams: stale CH372Device absolute paths dropped', h.dropped.length === 2);
}

// ---------- 4. member projects work with the existing core ----------
{
  const cp = Cproject.load(path.join(H417, 'GPIO/GPIO_Toggle/V3F'));
  const sources = [...scanSources(cp).values()].reduce((n, v) => n + v.length, 0);
  check('GPIO_Toggle V3F: toolchain rvGcc 12', cp.rvGccVersion === '12');
  check('GPIO_Toggle V3F: scan finds sources', sources > 0);
  const linkedNames = [...cp.linkedFolders.keys()].sort().join(',');
  check(`GPIO_Toggle V3F: linked folders resolved (${linkedNames})`, cp.linkedFolders.size >= 5);
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

// ---------- 6. writeSolution round-trip (generate -> parse back) ----------
{
  const fixtureDir = path.join(here, '..', '.scratch', 'solution-fixture');
  const members = [path.join(H417, 'GPIO/GPIO_Toggle/V3F'), path.join(H417, 'GPIO/GPIO_Toggle/V5F')];
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
}

console.log(failures ? `\n${failures} FAILURES` : '\nall solution tests passed');
process.exit(failures ? 1 : 0);
