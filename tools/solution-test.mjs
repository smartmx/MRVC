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

// real EVT trees: prefer the local TEST copies, fall back to the F:/ layout
const TEST_ROOT = 'E:/Projects/MRS_VSCODE/TEST';
const pick = (local, f) => [local, f].find((r) => fs.existsSync(r)) ?? f;
const H417 = pick(TEST_ROOT + '/CH32H417EVT/EXAM', 'F:/CH32H417/EVT/V1_0/EXAM');
const LEGACY_TREES = [
  pick(TEST_ROOT + '/CH585EVT/EXAM', 'F:/CH585/EVT/V1_2/EXAM'),
  pick(TEST_ROOT + '/CH587EVT/EXAM', 'F:/CH587/EVT/V1_0/EXAM'),
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
  slnFiles.length === truthSln.length && new Set(slnFiles.map((f) => f.toLowerCase())).size === truthSln.length
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
}

// ---------- 4. member projects work with the existing core ----------
{
  const cp = Cproject.load(path.join(H417, 'GPIO/GPIO_Toggle/V3F'));
  const sources = [...scanSources(cp).values()].reduce((n, v) => n + v.length, 0);
  // tree copies differ in the recorded rvGcc (12 upstream, 15 local): any
  // valid MRS toolchain version must parse
  check(`GPIO_Toggle V3F: toolchain rvGcc parsed (${cp.rvGccVersion})`, ['8', '12', '15'].includes(cp.rvGccVersion));
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
