/**
 * ONE-OFF golden restoration (round5 follow-up): the round-5 review's
 * build-all run overwrote the REAL EVT tree's obj/ goldens (F:/CH585) with
 * default-header builds, destroying the byte-frozen baselines. The goldens
 * are reproducible: golden-check itself regenerates them from metadata
 * (version string -> header/style/-lm flags; toolchain prefix from the
 * golden text) and demands byte equality — so regenerating with the
 * ORIGINAL metadata restores the original bytes. Original metadata source:
 * develop/.goldens/<name>/makefile headers (1.9.2 / 2.1.0 / 1.9.2) and the
 * legacy prefixes. Restores only the 29 default-golden files, then the
 * normal `npm run golden` verifies the restoration.
 *
 * Usage: node tools/restore-goldens.mjs
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outCore = path.join(here, '..', 'out', 'core');
const { Cproject } = require(path.join(outCore, 'cproject.js'));
const { generateMakefiles } = require(path.join(outCore, 'makefile.js'));
const { linkedFolderMap, readProjectFile } = require(path.join(outCore, 'projectFile.js'));

const EVT = 'F:/CH585/EVT/V1_2/EXAM';
const LEGACY = path.join(here, '..', '.goldens');
const RESTORE = [
  { proj: path.join(EVT, 'FreeRTOS'), legacy: 'FreeRTOS' },
  { proj: path.join(EVT, 'HarmonyOS'), legacy: 'HarmonyOS' },
  { proj: path.join(EVT, 'NFCA', 'PCD', 'MifareClassic'), legacy: 'NFCA_PCD_MifareClassic' },
];

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
const inferPrefix = (makeText) => {
  const m = makeText.match(/([A-Za-z0-9_-]+)gcc(\.exe)?/);
  return m ? m[1] + 'gcc' : 'riscv-none-elf-gcc';
};
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

// the recipes embed ABSOLUTE paths of the generation scratch (-T/-L point
// into .scratch/<name>/...) — the originals were generated from .scratch/
// <name>, the exact layout golden-check uses, so restoration must use the
// same paths or the bytes cannot match
const scratchRoot = path.join(here, '..', '.scratch');
fs.rmSync(scratchRoot, { recursive: true, force: true });

for (const { proj, legacy } of RESTORE) {
  const legacyMake = fs.readFileSync(path.join(LEGACY, legacy, 'makefile'), 'utf-8');
  const ver = legacyMake.match(/^# MRS Version: (.+)$/m)?.[1]?.trim();
  if (!ver) throw new Error(`no version header in legacy ${legacy}`);
  const mrs2Style = /^2\./.test(ver);
  const vNum = /^(\d+)\.(\d+)/.exec(ver);
  const autoMathLib = vNum ? Number(vNum[1]) * 1000 + Number(vNum[2]) >= 2003 : false;
  const goldenTc = TcFor(inferPrefix(legacyMake));

  const name = path.basename(proj);
  const scratch = path.join(scratchRoot, name);
  copyTree(proj, scratch);
  // rewrite PARENT-N-PROJECT_LOC tokens exactly like golden-check does
  const projFile = path.join(scratch, '.project');
  let text = fs.readFileSync(projFile, 'utf-8');
  for (const m of text.matchAll(/PARENT-(\d+)-PROJECT_LOC/g)) {
    let base = proj;
    for (let i = 0; i < Number(m[1]); i++) base = path.dirname(base);
    text = text.split(m[0]).join(base.replace(/\\/g, '/'));
  }
  fs.writeFileSync(projFile, text, 'utf-8');

  const cp = new Cproject(path.join(scratch, '.cproject'));
  cp.linkedFolders = linkedFolderMap(readProjectFile(scratch));
  generateMakefiles(cp, goldenTc, { headerTool: `MRS Version: ${ver}`, mrs2Style, autoMathLib });

  // copy the regenerated obj files back over the destroyed goldens — the
  // recipes embed the scratch's absolute paths (-T/-L into .scratch/<name>/),
  // but the real goldens carry PROJECT-absolute paths (golden-check compares
  // AFTER normalizing scratch -> project, so the baseline itself must hold
  // the normalized form). Apply the same four-way rewrite here.
  const genObj = path.join(scratch, 'obj');
  const dstObj = path.join(proj, 'obj');
  fs.mkdirSync(dstObj, { recursive: true });
  const scratchFwd = scratch.replace(/\\/g, '/');
  const projFwd = proj.replace(/\\/g, '/');
  const lower = (s) => s.slice(0, 1).toLowerCase() + s.slice(1);
  const normalize = (t) =>
    t.split(scratchFwd).join(projFwd)
      .split(lower(scratchFwd)).join(lower(projFwd))
      .split(scratch).join(proj)
      .split(lower(scratch)).join(lower(proj));
  let n = 0;
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name);
      const d = path.join(dst, ent.name);
      if (ent.isDirectory()) {
        walk(s, d);
      } else {
        // EVERY generated file under obj carries the embedded scratch paths
        // (deep subdir.mk files too) — normalize at every depth (round5)
        fs.writeFileSync(d, normalize(fs.readFileSync(s, 'utf-8')), 'utf-8');
        n++;
      }
    }
  };
  walk(genObj, dstObj);
  console.log(`restored ${name}: ver=${ver} style=${mrs2Style ? 'mrs2' : 'new'} math=${autoMathLib} files=${n}`);
}
fs.rmSync(scratchRoot, { recursive: true, force: true });
console.log('done — verify with: npm run golden');
