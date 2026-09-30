/**
 * Golden makefile comparison harness (dev tool, not shipped).
 * Copies a reference project into a scratch dir, generates makefiles with
 * the same inputs the golden build used, and byte-compares against the
 * golden files found in the original obj/ directory.
 *
 * Usage: node tools/golden-check.mjs [projectDir ...] [--loose]
 * Without args, uses FreeRTOS + HarmonyOS + MifareClassic from the EVT tree
 * (baseline root resolution: .goldens/ tree name -> TEST copy -> F: EVT).
 *
 * Counters are mutually exclusive:
 *   identical            byte-for-byte equal
 *   identical-modulo-EOL equal after stripping CR (loose mode promotes these)
 *   different            content differs
 */
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outCore = path.join(here, '..', 'out', 'core');

const { Cproject } = require(path.join(outCore, 'cproject.js'));
const { readProjectFile, linkedFolderMap } = require(path.join(outCore, 'projectFile.js'));
const { generateMakefiles } = require(path.join(outCore, 'makefile.js'));

// baseline root: the local .goldens/ tree already records which EVT the
// goldens came from (ch587-* names); fall back to TEST copy then F: EVT
const GOLDENS = path.join(here, '..', '.goldens');
const goldensMarker = fs.existsSync(GOLDENS) ? fs.readdirSync(GOLDENS).join(',') : '';

const EVT = [
  'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM',
  'F:/CH585/EVT/V1_2/EXAM',
].find((r) => fs.existsSync(r)) ?? 'F:/CH585/EVT/V1_2/EXAM';
const defaults = [path.join(EVT, 'FreeRTOS'), path.join(EVT, 'HarmonyOS'), path.join(EVT, 'NFCA', 'PCD', 'MifareClassic')];

const argProjects = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const projects = argProjects.length ? argProjects : defaults;
const scratchRoot = path.join(here, '..', '.scratch');
fs.rmSync(scratchRoot, { recursive: true, force: true });

console.log(`baseline EVT: ${EVT}${goldensMarker ? `  (.goldens: ${goldensMarker})` : ''}`);

// golden toolchain: prefix is PER-PROJECT — inferred from the golden
// makefile text itself (FreeRTOS golden uses riscv-none-elf-, HarmonyOS
// golden riscv-wch-elf-). A fixed prefix here was an analysis artifact
// that inflated the HarmonyOS diff list. name stays 'GCC12': the march
// assembly in flags.ts keys WCH-specific extension handling off it.
const TcFor = (gccName) => ({
  name: 'GCC12',
  dir: '',
  compilerC: gccName,
  compilerCpp: gccName.replace(/gcc$/, 'g++'),
  linkerC: gccName,
  linkerCpp: gccName.replace(/gcc$/, 'g++'),
  debugger: gccName.replace(/gcc$/, 'gdb'),
  objcopy: gccName.replace(/gcc$/, 'objcopy'),
  objdump: gccName.replace(/gcc$/, 'objdump'),
  size: gccName.replace(/gcc$/, 'size'),
  prefix: gccName.replace(/gcc$/, ''),
});

let identical = 0;
let moduloEol = 0;
let different = 0;
const loose = process.argv.includes('--loose');

function copyTree(src, dest, skip = new Set(['obj', '.settings'])) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

/** first *gcc* name quoted in the golden makefile (its own toolchain) */
function inferPrefixFromGolden(makeText) {
  const m = makeText.match(/([A-Za-z0-9_-]+)gcc(\.exe)?/);
  return m ? m[1] + 'gcc' : 'riscv-none-elf-gcc';
}

for (const proj of projects) {
  const goldenMakefilePath = path.join(proj, 'obj', 'makefile');
  if (!fs.existsSync(goldenMakefilePath)) {
    console.log(`SKIP ${proj} (no golden makefile)`);
    continue;
  }
  const name = path.basename(proj);
  const scratch = path.join(scratchRoot, name);
  copyTree(proj, scratch);

  // Rewrite PARENT-N-PROJECT_LOC tokens in the scratch .project so linked
  // folders resolve to the ORIGINAL ancestor dirs (the scratch copy sits at
  // a different depth, so the same tokens would resolve elsewhere).
  {
    const projFile = path.join(scratch, '.project');
    let text = fs.readFileSync(projFile, 'utf-8');
    for (const m of text.matchAll(/PARENT-(\d+)-PROJECT_LOC/g)) {
      let base = proj;
      for (let i = 0; i < Number(m[1]); i++) base = path.dirname(base);
      text = text.split(m[0]).join(base.replace(/\\/g, '/'));
    }
    fs.writeFileSync(projFile, text, 'utf-8');
  }

  const cp = new Cproject(path.join(scratch, '.cproject'));
  cp.linkedFolders = linkedFolderMap(readProjectFile(scratch));
  // reuse the golden's own version string so the header matches
  const goldenMakefile = fs.readFileSync(goldenMakefilePath, 'utf-8');
  const ver = goldenMakefile.match(/^# MRS Version: (.+)$/m);
  const verStr = ver ? ver[1].trim() : '1.9.2';
  // older CDT generations (MRS 1.9.2, e.g. the FreeRTOS golden) group OBJS
  // between SRCS and DEPS; newer ones (MRS 2.1.0, HarmonyOS golden) emit each
  // DEPS block right after its SRCS group
  const mrs2Style = /^2\./.test(verStr);
  // per-project toolchain: inferred from the golden text (review §4.1a —
  // a fixed riscv-none-elf- prefix was an analysis artifact that inflated
  // the HarmonyOS diff list)
  const goldenTc = TcFor(inferPrefixFromGolden(goldenMakefile));
  const res = generateMakefiles(cp, goldenTc, { headerTool: `MRS Version: ${verStr}`, mrs2Style });

  const goldenDir = path.join(proj, 'obj');
  const files = ['makefile', 'sources.mk', 'objects.mk', ...res.dirs.filter(Boolean).map((d) => `${d}/subdir.mk`)];
  let projPass = true;
  for (const f of files) {
    const genFile = path.join(scratch, 'obj', f);
    const goldenFile = path.join(goldenDir, f);
    if (!fs.existsSync(goldenFile)) {
      console.log(`  ?? ${name}/${f}: no golden`);
      continue;
    }
    const aRaw = fs.readFileSync(genFile, 'utf-8');
    // normalize the scratch project prefix back to the original project path
    // (both drive cases: the 2.x output lowercases the drive letter)
    const scratchFwd = scratch.replace(/\\/g, '/');
    const projFwd = proj.replace(/\\/g, '/');
    const lower = (s) => s.slice(0, 1).toLowerCase() + s.slice(1);
    const aText = aRaw
      .split(scratchFwd).join(projFwd)
      .split(lower(scratchFwd)).join(lower(projFwd))
      .split(scratch).join(proj)
      .split(lower(scratch)).join(lower(proj));
    const bRaw = fs.readFileSync(goldenFile, 'utf-8');
    if (aText === bRaw) {
      identical++;
      continue;
    }
    if (loose) {
      // equal after stripping CR: report as modulo-EOL only in loose mode
      const aLoose = Buffer.from(aText.replace(/\r/g, ''), 'utf-8');
      const bLoose = Buffer.from(bRaw.replace(/\r/g, ''), 'utf-8');
      if (aLoose.equals(bLoose)) {
        moduloEol++;
        continue;
      }
    }
    different++;
    projPass = false;
    console.log(`  DIFF ${name}/${f}`);
    const at = aText.split('\r\n');
    const bt = bRaw.split('\r\n');
    let shown = 0;
    for (let i = 0; i < Math.max(at.length, bt.length) && shown < 4; i++) {
      if (at[i] !== bt[i]) {
        console.log(`    line ${i + 1} (gen ${at.length} lines, gold ${bt.length} lines)`);
        const g = at[i] ?? '';
        const h = bt[i] ?? '';
        console.log(`      gen:  ${JSON.stringify(g.length > 260 ? g.slice(0, 260) + `...[+${g.length - 260}]` : g)}`);
        console.log(`      gold: ${JSON.stringify(h.length > 260 ? h.slice(0, 260) + `...[+${h.length - 260}]` : h)}`);
        if (g === h || g.length === h.length) {
          for (let k = 0; k < Math.max(g.length, h.length); k++) {
            if (g[k] !== h[k]) {
              console.log(`      first char diff at ${k}: ${JSON.stringify(g.slice(k, k + 40))} vs ${JSON.stringify(h.slice(k, k + 40))}`);
              break;
            }
          }
        }
        shown++;
      }
    }
  }
  console.log(`${projPass ? 'OK  ' : 'FAIL'} ${name} (${res.sourceCount} sources)`);
}

console.log(`\n${identical} identical, ${moduloEol} identical-modulo-EOL, ${different} different  (total ${identical + moduloEol + different})`);
process.exit(different ? 1 : 0);
