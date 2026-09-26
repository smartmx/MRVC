/**
 * Golden makefile comparison harness (dev tool, not shipped).
 * Copies a reference project into a scratch dir, generates makefiles with
 * the same inputs the golden build used, and byte-compares against the
 * golden files found in the original obj/ directory.
 *
 * Usage: node tools/golden-check.mjs [projectDir ...]
 * Without args, uses FreeRTOS + HarmonyOS from the CH585 EVT tree.
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

const EVT = ['E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM', 'F:/CH585/EVT/V1_2/EXAM'].find((r) => fs.existsSync(r)) ?? 'F:/CH585/EVT/V1_2/EXAM';
const defaults = [path.join(EVT, 'FreeRTOS'), path.join(EVT, 'HarmonyOS'), path.join(EVT, 'NFCA', 'PCD', 'MifareClassic')];

const argProjects = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const projects = argProjects.length ? argProjects : defaults;
const scratchRoot = path.join(here, '..', '.scratch');
fs.rmSync(scratchRoot, { recursive: true, force: true });

// golden toolchain: the prefix the EVT goldens were built with
const goldenTc = {
  name: 'GCC12',
  dir: '',
  compilerC: 'riscv-none-elf-gcc',
  compilerCpp: 'riscv-none-elf-g++',
  linkerC: 'riscv-none-elf-gcc',
  linkerCpp: 'riscv-none-elf-g++',
  debugger: 'riscv-none-elf-gdb',
  objcopy: 'riscv-none-elf-objcopy',
  objdump: 'riscv-none-elf-objdump',
  size: 'riscv-none-elf-size',
  prefix: 'riscv-none-elf-',
};

let pass = 0;
let fail = 0;
let loosePass = 0;
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

for (const proj of projects) {
  if (!fs.existsSync(path.join(proj, 'obj', 'makefile'))) {
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
  const goldenMakefile = fs.readFileSync(path.join(proj, 'obj', 'makefile'), 'utf-8');
  const ver = goldenMakefile.match(/^# MRS Version: (.+)$/m);
  const res = generateMakefiles(cp, goldenTc, { headerTool: `MRS Version: ${ver ? ver[1].trim() : '1.9.2'}` });

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
    const aText = aRaw.split(scratch.replace(/\\/g, '/')).join(proj.replace(/\\/g, '/')).split(scratch).join(proj);
    const bRaw = fs.readFileSync(goldenFile, 'utf-8');
    let a = Buffer.from(aText, 'utf-8');
    const b = Buffer.from(bRaw, 'utf-8');
    if (loose) {
      // ignore CRLF/LF placement (MRS 2.x goldens use a different mix)
      const aLoose = Buffer.from(aText.replace(/\r/g, ''), 'utf-8');
      const bLoose = Buffer.from(bRaw.replace(/\r/g, ''), 'utf-8');
      if (aLoose.equals(bLoose)) {
        pass++;
        loosePass++;
        continue;
      }
    }
    if (a.equals(b)) {
      pass++;
    } else {
      fail++;
      projPass = false;
      console.log(`  DIFF ${name}/${f}`);
      const at = a.toString('utf-8').split('\r\n');
      const bt = b.toString('utf-8').split('\r\n');
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
  }
  console.log(`${projPass ? 'OK  ' : 'FAIL'} ${name} (${res.sourceCount} sources)`);
}

console.log(`\n${pass} identical, ${loosePass} identical-modulo-EOL, ${fail} different`);
process.exit(fail ? 1 : 0);
