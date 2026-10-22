/**
 * Build a project against a CHOSEN MounRiver installation (MRS2 or MRS3) with
 * the real generator + toolchain — the dual-install regression harness.
 *
 *   node tools/mrs-install-probe.mjs <installRoot> <projectDir> [cpp]
 *
 * Copies the project into .scratch/<name>-probe, resolves the install through
 * the unmodified locateInstall(), generates makefiles and runs the bundled
 * make. Unlike build-test.mjs (which resolves the DEFAULT installation) this
 * one pins the installation, so "MRVC + MRS3" is testable before switching.
 * The optional `cpp` argument runs the C -> C++ project-type conversion first
 * (nature + option mirror), so "does a converted project build" is testable.
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
const { setProjectCpp } = require(path.join(outCore, 'projectType.js'));

const installRoot = process.argv[2];
const projectDir = process.argv[3];
if (!installRoot || !projectDir) {
  console.error('usage: node tools/mrs-install-probe.mjs <installRoot> <projectDir>');
  process.exit(2);
}

const install = locateInstall(installRoot);
if (!install) {
  console.error('locateInstall returned null — not a MounRiver installation: ' + installRoot);
  process.exit(2);
}
console.log('install         : ' + install.label + ' (' + install.flavor + ')');
console.log('root            : ' + install.root);
console.log('makeBin         : ' + install.makeBin + '  (make.exe: ' + fs.existsSync(path.join(install.makeBin, 'make.exe')) + ')');
console.log('openocd         : ' + fs.existsSync(install.openocdExe) + '  | linkUtility: ' + fs.existsSync(install.linkUtilityExe));
console.log('toolchains      : ' + install.toolchains.map((t) => t.name + '(' + t.prefix + ')').join(', '));

const scratch = path.join(here, '..', '.scratch', path.basename(projectDir) + '-probe');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const projCopy = path.join(scratch, path.basename(projectDir));
fs.cpSync(projectDir, projCopy, {
  recursive: true,
  filter: (src) => !/[/\\](obj|\.settings|\.vscode)([/\\]|$)/.test(src),
});

// Standard EVT projects link their shared tree through
// PARENT-N-PROJECT_LOC/SRC/... — the copy sits at a different depth, so the
// tokens are rewritten to the ORIGINAL ancestor dirs (same fix golden-check
// applies). The build then READS the original shared tree but writes only
// inside .scratch (the build dir lives in the copy).
{
  const projFile = path.join(projCopy, '.project');
  if (fs.existsSync(projFile)) {
    let text = fs.readFileSync(projFile, 'utf-8');
    let rewrote = false;
    text = text.replace(/PARENT-(\d+)-PROJECT_LOC/g, (_m, n) => {
      let anc = projectDir;
      for (let i = 0; i < Number(n); i++) anc = path.dirname(anc);
      rewrote = true;
      return anc.split(path.sep).join('/');
    });
    if (rewrote) {
      fs.writeFileSync(projFile, text, 'utf-8');
      console.log('linked folders  : PARENT-N tokens point back at the original tree');
    }
  }
}

let cp = Cproject.load(projCopy);
const tc = selectToolchain(install, 'auto', cp.rvGccVersion, cp.storedPrefix);
console.log('project         : ' + cp.projectName + '  config: ' + cp.configName);

// optional third arg `cpp`: run the C/C++ project-type conversion first, so
// "does a converted project actually build" is testable end-to-end
if (process.argv[4] === 'cpp') {
  const before = cp.isCpp;
  const { mirrored } = setProjectCpp(projCopy, true);
  cp = Cproject.load(projCopy); // reload: the toggle rewrote .project/.cproject
  console.log('convert to cpp  : isCpp ' + before + ' -> ' + cp.isCpp + ', ' + mirrored + ' C options mirrored');
}

console.log('toolchain       : ' + tc.name + ' (' + path.basename(tc.compilerC) + ')');
const gen = generateMakefiles(cp, tc);
console.log('generated       : ' + gen.files.length + ' files, ' + gen.sourceCount + ' sources');
const proc = spawnSync(path.join(install.makeBin, 'make.exe'), ['-j8', 'all'], {
  cwd: path.join(projCopy, cp.configName),
  env: { ...process.env, PATH: `${path.join(tc.dir, 'bin')};${install.makeBin};${process.env.PATH ?? ''}` },
  encoding: 'utf-8',
  shell: false,
  timeout: 600000,
});
const out = ((proc.stdout ?? '') + (proc.stderr ?? '')).split(/\r?\n/).filter((l) => l.trim());
console.log('--- make output (tail) ---');
console.log(out.slice(-8).join('\n'));
const elf = path.join(projCopy, cp.configName, `${cp.targetName}.elf`);
const hex = path.join(projCopy, cp.configName, `${cp.targetName}.hex`);
console.log('--- exit code: ' + proc.status + ' ---');
console.log('elf: ' + (fs.existsSync(elf) ? fs.statSync(elf).size + ' bytes' : 'MISSING'));
console.log('hex: ' + (fs.existsSync(hex) ? fs.statSync(hex).size + ' bytes' : 'MISSING'));
process.exit(proc.status === 0 && fs.existsSync(elf) ? 0 : 1);
