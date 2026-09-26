/*
 * Mass validation across every project in the local TEST trees.
 * For each discovered project: load .project/.cproject/.template, scan
 * sources, resolve exclusions, look up the chip database, generate all
 * makefile fragments (twice — byte-stable), and validate the .template
 * download address against the series metadata. Read-only on real trees
 * (makefile generation runs in a scratch mirror).
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEVELOP_DIR = path.dirname(here);
const outCore = path.join(DEVELOP_DIR, 'out', 'core');

const { findProjectRoots, findSolutionFiles } = require(path.join(outCore, 'discover.js'));
const { Cproject } = require(path.join(outCore, 'cproject.js'));
const { readProjectFile, linkedFolderMap } = require(path.join(outCore, 'projectFile.js'));
const { readTemplate } = require(path.join(outCore, 'templateFile.js'));
const { scanSources, isLogicExcluded, exclusionFsPaths } = require(path.join(outCore, 'scan.js'));
const { generateMakefiles } = require(path.join(outCore, 'makefile.js'));
const { parseSolution } = require(path.join(outCore, 'solution.js'));
const { scanChipDb, chipDbRoot } = require(path.join(outCore, 'chipdb.js'));

const TEST = 'E:/Projects/MRS_VSCODE/TEST';
const TREES = ['CH585EVT', 'CH32H417EVT', 'CH32V20xEVT', 'CH32V307EVT', 'CH587EVT'].map((t) => path.join(TEST, t, 'EXAM')).filter((p) => fs.existsSync(p));

const TC = {
  name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
  linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
  objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size',
  prefix: 'riscv-wch-elf-',
};

let failures = 0;
let warnings = 0;
const fail = (msg) => { console.log('  FAIL ' + msg); failures++; };
const warn = (msg) => { console.log('  WARN ' + msg); warnings++; };
const scratch = path.join(DEVELOP_DIR, '.scratch', 'mass');

// one chipdb scan for the whole run
const MRS2 = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32';
const chipDb = fs.existsSync(MRS2) ? scanChipDb(chipDbRoot(MRS2)) : { available: false, series: [] };

let totalProjects = 0;
let totalSources = 0;
let totalExcluded = 0;
const perTree = {};

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

for (const tree of TREES) {
  const label = path.basename(path.dirname(tree));
  perTree[label] = { projects: 0, sources: 0, errors: 0 };
  console.log(`\n===== ${label} =====`);
  const roots = findProjectRoots(tree);
  for (const root of roots) {
    totalProjects++;
    perTree[label].projects++;
    const rel = path.relative(tree, root);
    const errsBefore = failures;
    try {
      // 1. .project parse + linked folders
      const pf = readProjectFile(root);
      const links = linkedFolderMap(pf);
      for (const [name, loc] of links) {
        if (!fs.existsSync(loc)) warn(`${rel}: linked folder "${name}" target missing (${loc})`);
      }
      // 2. .cproject parse + option model
      const cp = Cproject.load(root);
      if (!cp.configName) fail(`${rel}: empty config name`);
      if (!cp.projectName) fail(`${rel}: empty project name`);
      // 3. .template
      const tpl = readTemplate(root);
      if (!tpl.values['Mcu Type']) warn(`${rel}: .template has no Mcu Type`);
      if (tpl.values['Address'] && !/^0x[0-9a-fA-F]{1,8}$/.test(tpl.values['Address'])) fail(`${rel}: bad .template Address "${tpl.values['Address']}"`);
      // 4. chipdb lookup: series must exist and the address must match its metadata
      if (chipDb.available && tpl.values['Mcu Type']) {
        const s = chipDb.series.find((x) => x.mcuType === tpl.values['Mcu Type']);
        if (!s) warn(`${rel}: Mcu Type "${tpl.values['Mcu Type']}" not in the chip database`);
        else if (s.flashAddress && tpl.values['Address'] && s.flashAddress.toLowerCase() !== tpl.values['Address'].toLowerCase()) {
          warn(`${rel}: .template Address ${tpl.values['Address']} != series default ${s.flashAddress} (${s.name})`);
        }
      }
      // 5. source scan + exclusion consistency (UI queries mirror the scanner)
      const map = scanSources(cp);
      let srcCount = 0;
      for (const files of map.values()) srcCount += files.length;
      totalSources += srcCount;
      perTree[label].sources += srcCount;
      const excludedPaths = exclusionFsPaths(cp, root);
      totalExcluded += excludedPaths.length;
      for (const p of excludedPaths) {
        if (!fs.existsSync(p)) warn(`${rel}: exclusion token maps to missing path ${path.relative(tree, p)}`);
      }
      if (srcCount === 0) warn(`${rel}: scan finds no sources`);
      // 6. makefile generation in a scratch mirror — byte-stable across runs
      const mirror = path.join(scratch, label, rel.replace(/[^a-zA-Z0-9]+/g, '_'));
      fs.mkdirSync(mirror, { recursive: true });
      const cpMirror = Object.create(Object.getPrototypeOf(cp));
      Object.assign(cpMirror, cp);
      cpMirror.projectRoot = mirror;
      // mirror the real tree structure (dirs + linked folders) so the walk works
      const mirrorTree = (src, dst) => {
        let entries;
        try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name === cp.configName || e.name.startsWith('.')) continue;
          const s2 = path.join(src, e.name), d2 = path.join(dst, e.name);
          if (e.isDirectory()) { fs.mkdirSync(d2, { recursive: true }); mirrorTree(s2, d2); }
        }
      };
      mirrorTree(root, mirror);
      // link targets live outside; rewrite them to a stub dir inside the mirror
      const stub = path.join(mirror, '__linkstub');
      const pfMirror = readProjectFile(root);
      for (const l of pfMirror.linkedResources) {
        if (l.type !== 2) continue;
        const d = path.join(stub, l.name);
        fs.mkdirSync(d, { recursive: true });
        l.element.childrenNamed('location').forEach((c) => (c.text = d));
        l.element.childrenNamed('locationURI').forEach((c) => (c.text = d));
      }
      fs.writeFileSync(path.join(mirror, '.project'), pfMirror.raw ? serializeMirror(pfMirror) : '');
      fs.copyFileSync(path.join(root, '.cproject'), path.join(mirror, '.cproject'));
      if (fs.existsSync(path.join(root, '.template'))) fs.copyFileSync(path.join(root, '.template'), path.join(mirror, '.template'));
      const cpGen = Cproject.load(mirror);
      generateMakefiles(cpGen, TC);
      const hash1 = hashMakefiles(mirror);
      generateMakefiles(Cproject.load(mirror), TC);
      const hash2 = hashMakefiles(mirror);
      if (hash1 !== hash2) fail(`${rel}: makefile generation not byte-stable across runs`);
      const mk = fs.readFileSync(path.join(mirror, cpGen.configName, 'makefile'), 'utf8');
      if (!/all:/.test(mk)) fail(`${rel}: makefile has no all target`);
      if (/\$\{workspace_loc/.test(mk)) warn(`${rel}: makefile still contains unresolved workspace_loc macros`);
    } catch (e) {
      fail(`${rel}: ${e.message}`);
    }
    if (failures > errsBefore) perTree[label].errors += failures - errsBefore;
  }
  // solutions in this tree
  try {
    const slns = findSolutionFiles(tree);
    for (const s of slns) {
      const p = parseSolution(s);
      for (const m of p.entries) {
        if (!fs.existsSync(path.join(m.resolved, '.project'))) fail(`${path.relative(tree, s)}: member without .project (${m.resolved})`);
      }
    }
    console.log(`  solutions: ${slns.length} parsed OK`);
  } catch (e) {
    fail(`solution scan in ${label}: ${e.message}`);
  }
}

function serializeMirror(pf) {
  // minimal re-serialization is not needed — write the RAW bytes and patch links via a reload
  return pf.raw;
}
function hashMakefiles(dir) {
  let h = '';
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p2 = path.join(d, e.name);
      if (e.isDirectory()) walk(p2);
      else if (e.name === 'makefile' || e.name.endsWith('.mk')) h += p2 + '\x00' + fs.statSync(p2).size + '\x00' + hashStr(fs.readFileSync(p2, 'utf8')) + '\x01';
    }
  };
  walk(dir);
  return h;
}
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(16);
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log('\n===== SUMMARY =====');
for (const [t, v] of Object.entries(perTree)) console.log(`${t}: ${v.projects} projects, ${v.sources} sources, ${v.errors} errors`);
console.log(`chip database: ${chipDb.available ? chipDb.series.length + ' series' : 'unavailable'}`);
console.log(`totals: ${totalProjects} projects, ${totalSources} source files, ${totalExcluded} exclusion mappings`);
console.log(failures ? `\n${failures} FAILURES, ${warnings} warnings` : `\nall ${totalProjects} projects passed (${warnings} warnings)`);
process.exit(failures ? 1 : 0);
