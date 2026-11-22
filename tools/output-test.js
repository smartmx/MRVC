/*
 * Output-directory maintenance tests (clearOutputDir / removeOutputDir):
 * keep flash images, recursive deletion, and the project-root containment
 * guard. Run: node tools/output-test.js
 */
const path = require('path');
const fs = require('fs');
const { clearOutputDir, removeOutputDir } = require('../out/core/output.js');

const scratch = path.join(path.dirname(__dirname), '.scratch', 'output');
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

fs.rmSync(scratch, { recursive: true, force: true });

// build a fake project: root with src/ + obj output dir
const root = path.join(scratch, 'LED');
const obj = path.join(root, 'obj');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(path.join(obj, 'Debug'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'main.c'), 'int main(void){return 0;}\n');
for (const f of ['makefile', 'sources.mk', 'LED.elf', 'LED.hex', 'LED.bin', 'LED.map', 'objdump.lst']) {
  fs.writeFileSync(path.join(obj, f), 'x');
}
fs.writeFileSync(path.join(obj, 'Debug', 'main.o'), 'x');
fs.writeFileSync(path.join(obj, 'Debug', 'main.d'), 'x');
fs.mkdirSync(path.join(scratch, 'elsewhere'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'elsewhere', 'keep.txt'), 'x');

// 1. clear with keep list: hex/bin survive (case-insensitive on win32), everything else goes
const n = clearOutputDir(root, obj, ['LED.hex', 'LED.bin']);
const left = fs.readdirSync(obj).sort().join(',');
check(`clearOutputDir keeps only hex/bin (left: ${left})`, left === 'LED.bin,LED.hex');
check('clearOutputDir returns removed count', n === 6);
check('clearOutputDir removed subdirectory contents', !fs.existsSync(path.join(obj, 'Debug')));
check('clearOutputDir leaves unrelated dirs untouched', fs.existsSync(path.join(root, 'src', 'main.c')));

// 2. keep list matches case-insensitively on Windows
fs.writeFileSync(path.join(obj, 'LED.HEX'), 'x');
clearOutputDir(root, obj, ['led.hex', 'led.bin']);
check('keep list is case-insensitive on win32', fs.existsSync(path.join(obj, 'LED.HEX')) === (process.platform === 'win32'));
fs.rmSync(path.join(obj, 'LED.HEX'), { force: true });

// 3. removeOutputDir removes the directory itself
removeOutputDir(root, obj);
check('removeOutputDir removes the directory itself', !fs.existsSync(obj));

// 4. containment guard: project root and outside dirs are refused
let threw = false;
try {
  clearOutputDir(root, root, []);
} catch {
  threw = true;
}
check('guard: clearing the project root is refused', threw);
threw = false;
try {
  removeOutputDir(root, path.join(root, '..', 'elsewhere'));
} catch {
  threw = true;
}
check('guard: removing outside the project root is refused', threw);
check('guard: nothing outside was touched', fs.existsSync(path.join(scratch, 'elsewhere', 'keep.txt')));

// 5. deleteConfigOutputs (0.3.6): every configuration's output dir in one
//    pass — the batch "delete output" commands. A config dir that does not
//    exist (never built) is skipped; keep lists are per configuration.
const { deleteConfigOutputs } = require('../out/core/output.js');
const root2 = path.join(scratch, 'TWO');
fs.mkdirSync(path.join(root2, 'obj'), { recursive: true });
fs.mkdirSync(path.join(root2, 'objDbg'), { recursive: true });
fs.writeFileSync(path.join(root2, 'obj', 'TWO.elf'), 'x');
fs.writeFileSync(path.join(root2, 'obj', 'TWO.hex'), 'x');
fs.writeFileSync(path.join(root2, 'obj', 'TWO.bin'), 'x');
fs.writeFileSync(path.join(root2, 'obj', 'makefile'), 'x');
fs.writeFileSync(path.join(root2, 'objDbg', 'TWO_DBG.elf'), 'x');
fs.writeFileSync(path.join(root2, 'objDbg', 'TWO_DBG.hex'), 'x');
fs.writeFileSync(path.join(root2, 'objDbg', 'TWO_DBG.bin'), 'x');
const keepRes = deleteConfigOutputs(root2, [
  { dir: path.join(root2, 'obj'), keep: ['TWO.hex', 'TWO.bin'] },
  { dir: path.join(root2, 'objDbg'), keep: ['TWO_DBG.hex', 'TWO_DBG.bin'] },
]);
check('allConfigs: two configs cleared (2 + 1 entries)', keepRes.dirs === 0 && keepRes.files === 3);
check(
  'allConfigs: each config keeps its OWN hex/bin',
  fs.readdirSync(path.join(root2, 'obj')).sort().join(',') === 'TWO.bin,TWO.hex' &&
    fs.readdirSync(path.join(root2, 'objDbg')).sort().join(',') === 'TWO_DBG.bin,TWO_DBG.hex'
);
const dirsRes = deleteConfigOutputs(root2, [
  { dir: path.join(root2, 'obj') },
  { dir: path.join(root2, 'objDbg') },
  { dir: path.join(root2, 'objNever') }, // never built — skipped silently
]);
check('allConfigs: dirs variant removes both, missing config skipped', dirsRes.dirs === 2 && dirsRes.files === 0);
check('allConfigs: output dirs gone', !fs.existsSync(path.join(root2, 'obj')) && !fs.existsSync(path.join(root2, 'objDbg')));
threw = false;
try {
  deleteConfigOutputs(root2, [{ dir: root2 }]);
} catch {
  threw = true;
}
check('allConfigs: a project-root spec is refused (containment guard)', threw);

// 6. wiring (0.3.6): the two ORIGINAL commands keep their labels and menu
//    places (active-config semantics), the two all-configurations commands
//    sit BELOW them in the title-bar menu
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const vt = pkg.contributes.menus['view/title'].filter((m) => m.group.startsWith('2_delete'));
  check('wiring: four delete-output entries in the title-bar menu', vt.length === 4, JSON.stringify(vt.map((m) => m.command)));
  check(
    'wiring: order = keepImages, dirs, allConfigs dirs, allConfigs keepImages',
    JSON.stringify(vt.map((m) => m.command)) ===
      JSON.stringify(['mrvc.deleteOutputKeepImages', 'mrvc.deleteOutputDirs', 'mrvc.deleteAllConfigsOutputDirs', 'mrvc.deleteAllConfigsOutputKeepImages'])
  );
  check('wiring: all four gated on mrvc.hasProjects', vt.every((m) => m.when.includes('mrvc.hasProjects')));
  const enNls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf8'));
  const zhNls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.zh-cn.json'), 'utf8'));
  check(
    'wiring: new command titles exist in BOTH languages',
    ['command.mrvc.deleteAllConfigsOutputDirs.title', 'command.mrvc.deleteAllConfigsOutputKeepImages.title'].every(
      (k) => k in enNls && k in zhNls
    )
  );
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'out', 'extension.js'), 'utf-8');
  check('wiring: both new commands registered in the extension', extSrc.includes('mrvc.deleteAllConfigsOutputDirs') && extSrc.includes('mrvc.deleteAllConfigsOutputKeepImages'));
  check('wiring: original commands keep active-config semantics (p.buildDir)', /deleteOutputOne[\s\S]{0,700}p\.buildDir/.test(extSrc));
  check('wiring: new commands route through deleteConfigOutputs', /deleteAllConfigsOne[\s\S]{0,700}deleteConfigOutputs/.test(extSrc));
}

console.log(failures ? `\n${failures} FAILURES` : '\nall output tests passed');
process.exit(failures ? 1 : 0);
