/**
 * Real build test: generates makefiles with our core and runs the actual
 * MounRiver make + toolchain against an EXAM project.
 *
 * Usage: node tools/build-test.mjs <projectDir> [clean]
 */
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outCore = path.join(here, '..', 'out', 'core');

const { Cproject } = require(path.join(outCore, 'cproject.js'));
const { generateMakefiles } = require(path.join(outCore, 'makefile.js'));
const { locateInstall, selectToolchain } = require(path.join(outCore, 'toolchain.js'));

const projectDir = process.argv[2];
if (!projectDir) {
  console.error('usage: node tools/build-test.mjs <projectDir> [clean]');
  process.exit(2);
}

const install = locateInstall(undefined);
if (!install) {
  console.error('MounRiver install not found');
  process.exit(2);
}
const cp = Cproject.load(projectDir);
const tc = selectToolchain(install, 'auto', cp.rvGccVersion, cp.storedPrefix);
console.log(`[mrs2] project: ${cp.projectName}  config: ${cp.configName}`);
console.log(`[mrs2] toolchain: ${tc.name} (${path.basename(tc.compilerC)})`);
console.log(`[mrs2] target: -march flags from .cproject, artifact ${cp.targetName}.elf`);

const gen = generateMakefiles(cp, tc);
console.log(`[mrs2] generated ${gen.files.length} makefile fragments, ${gen.sourceCount} sources, dirs: ${gen.dirs.join(', ')}`);

const args = process.argv[3] === 'clean' ? ['clean'] : ['-j8', 'all'];
const proc = spawnSync(path.join(install.makeBin, 'make.exe'), args, {
  cwd: path.join(projectDir, cp.configName),
  env: { ...process.env, PATH: `${path.join(tc.dir, 'bin')};${install.makeBin};${process.env.PATH ?? ''}` },
  encoding: 'utf-8',
  shell: false,
});

const out = (proc.stdout ?? '') + (proc.stderr ?? '');
const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
const tail = lines.slice(-25).join('\n');
console.log('--- make output (tail) ---');
console.log(tail);
console.log(`--- exit code: ${proc.status} ---`);

if (process.argv[3] !== 'clean') {
  const elf = path.join(projectDir, cp.configName, `${cp.targetName}.elf`);
  const hex = path.join(projectDir, cp.configName, `${cp.targetName}.hex`);
  for (const f of [elf, hex]) {
    if (fs.existsSync(f)) {
      const st = fs.statSync(f);
      console.log(`[product] ${path.basename(f)}  ${st.size} bytes`);
    } else {
      console.log(`[product] ${path.basename(f)}  MISSING`);
    }
  }
}
process.exit(proc.status ?? 1);
