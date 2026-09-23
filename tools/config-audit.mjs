/**
 * Config audit: parse every .cproject in a tree, aggregate all option
 * superClasses (suffix + valueType + distinct values), and diff against
 * the suffixes our code actually reads. Answers "which config items do
 * the test projects use, and do we handle them all".
 *
 * Usage: node tools/config-audit.mjs [rootDir]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const developRoot = path.join(here, '..');
const { Cproject } = require(path.join(developRoot, 'out', 'core', 'cproject.js'));

const root = process.argv[2] ?? 'F:/CH585/EVT/V1_2/EXAM';

const projects = [];
(function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === '.cproject')) {
    projects.push(dir);
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  }
})(root, 0);

// ---- collect suffixes our code reads (from src sources) ----
function collectHandledSuffixes() {
  const set = new Set();
  const files = ['core/flags.ts', 'core/cproject.ts', 'core/makefile.ts', 'vscode/configView.ts', 'vscode/linkedFolders.ts'];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(developRoot, 'src', rel), 'utf-8');
    for (const m of text.matchAll(/'([a-zA-Z]+(?:\.[a-zA-Z]+)+)'/g)) {
      const s = m[1];
      // heuristic: option-suffix-shaped identifiers
      if (/^(target|c\.compiler|cpp\.compiler|c\.linker|cpp\.linker|assembler|optimization|warnings|debugging|createflash|createlisting|printsize|addtools|command)\./.test(s)) {
        set.add(s);
      }
    }
    for (const m of text.matchAll(/`(c|cpp)\.linker\.\$\{[^`]+\}`/g)) {
      // dynamic prefix templates: register the static parts they can produce
    }
  }
  // dynamic linker suffixes generated via `${p}.linker.X` in flags.ts
  const dynamic = [
    'c.linker.scriptfile', 'cpp.linker.scriptfile',
    'c.linker.nostart', 'cpp.linker.nostart',
    'c.linker.nodeflibs', 'cpp.linker.nodeflibs',
    'c.linker.nostdlibs', 'cpp.linker.nostdlibs',
    'c.linker.gcsections', 'cpp.linker.gcsections',
    'c.linker.printgcsections', 'cpp.linker.printgcsections',
    'c.linker.strip', 'cpp.linker.strip',
    'c.linker.paths', 'cpp.linker.paths',
    'c.linker.flags', 'cpp.linker.flags',
    'c.linker.mapfilename', 'cpp.linker.mapfilename',
    'c.linker.cref', 'cpp.linker.cref',
    'c.linker.printmap', 'cpp.linker.printmap',
    'c.linker.usenewlibnano', 'cpp.linker.usenewlibnano',
    'c.linker.useprintffloat', 'cpp.linker.useprintffloat',
    'c.linker.usescanffloat', 'cpp.linker.usescanffloat',
    'c.linker.usenewlibnosys', 'cpp.linker.usenewlibnosys',
    'c.linker.verbose', 'cpp.linker.verbose',
    'c.linker.other', 'cpp.linker.other',
    'c.linker.otherobjs', 'cpp.linker.otherobjs',
    'c.linker.libs', 'cpp.linker.libs',
    'c.linker.iqmath', 'cpp.linker.iqmath',
    'c.linker.picolibc', 'cpp.linker.picolibc',
    'c.linker.printf', 'cpp.linker.printf',
    'c.linker.printfloat', 'cpp.linker.printfloat',
  ];
  dynamic.forEach((s) => set.add(s));
  return set;
}
const handled = collectHandledSuffixes();

// ---- parse all projects ----
const suffixCount = new Map(); // suffix -> { count, valueTypes:Set, values:Map<string,count>, example }
const fullEnums = new Map(); // full superClass -> Map(value -> count)
const parseErrors = [];
const archStats = new Map();
let cppProjects = 0;

for (const proj of projects) {
  let cp;
  try {
    cp = Cproject.load(proj);
  } catch (e) {
    parseErrors.push([proj, String(e).slice(0, 120)]);
    continue;
  }
  if (cp.isCpp) cppProjects++;
  const raw = fs.readFileSync(path.join(proj, '.cproject'), 'utf-8');
  const optRe = /<option\b[^>]*superClass="([^"]+)"[^>]*>/g;
  let m;
  while ((m = optRe.exec(raw))) {
    const sc = m[1];
    const tag = m[0];
    const vt = (tag.match(/valueType="([^"]+)"/) ?? [, ''])[1];
    const val = (tag.match(/value="([^"]*)"/) ?? [, ''])[1];
    const suffix = sc
      .replace(/^ilg\.gnumcueclipse\.managedbuild\.cross\.riscv\.option\./, '')
      .replace(/^ilg\.gnuarmeclipse\.managedbuild\.cross\.option\./, '');
    const rec = suffixCount.get(suffix) ?? { count: 0, valueTypes: new Set(), values: new Map(), example: sc };
    rec.count++;
    if (vt) rec.valueTypes.add(vt);
    if (val) rec.values.set(val, (rec.values.get(val) ?? 0) + 1);
    suffixCount.set(suffix, rec);
    if (vt === 'enumerated') {
      const vm = fullEnums.get(sc) ?? new Map();
      vm.set(val, (vm.get(val) ?? 0) + 1);
      fullEnums.set(sc, vm);
    }
  }
  const arch = cp.optionEnum('target.isa.base') ?? '(none)';
  archStats.set(arch, (archStats.get(arch) ?? 0) + 1);
}

console.log(`[audit] projects: ${projects.length}, parse errors: ${parseErrors.length}, C++ projects: ${cppProjects}`);
console.log(`[audit] arch distribution:`, [...archStats].map(([k, v]) => `${k}=${v}`).join(' '));

const unhandled = [...suffixCount.entries()].filter(([s]) => !handled.has(s));
console.log(`\n=== all option suffixes seen (${suffixCount.size} distinct) ===`);
for (const [s, rec] of [...suffixCount.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const mark = handled.has(s) ? ' ' : '!';
  const vals = [...rec.values.entries()].slice(0, 3).map(([v, c]) => `${v.slice(-28)}x${c}`).join(' ');
  console.log(`${mark} ${s.padEnd(44)} ${String(rec.count).padStart(3)}  [${[...rec.valueTypes].join(',')}]  ${vals}`);
}
if (unhandled.length) {
  console.log(`\n=== UNHANDLED suffixes (${unhandled.length}) ===`);
  for (const [s, rec] of unhandled) {
    console.log(`  ${s}  (x${rec.count}, valueType ${[...rec.valueTypes].join(',')})`);
    for (const [v, c] of rec.values) console.log(`      value: ${v.slice(0, 120)} x${c}`);
  }
} else {
  console.log('\n=== no unhandled suffixes — every config item in the test tree is covered ===');
}

console.log('\n=== enumerated values observed (full superClass -> values) ===');
for (const [sc, vm] of [...fullEnums.entries()].sort()) {
  console.log(`  ${sc.replace('ilg.gnumcueclipse.managedbuild.cross.riscv.option.', '')}`);
  for (const [v, c] of vm) console.log(`      ${v.replace('ilg.gnumcueclipse.managedbuild.cross.riscv.option.', '')} x${c}`);
}

if (parseErrors.length) {
  console.log('\n=== parse errors ===');
  for (const [p, e] of parseErrors) console.log(`  ${p}: ${e}`);
}
