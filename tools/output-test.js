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

console.log(failures ? `\n${failures} FAILURES` : '\nall output tests passed');
process.exit(failures ? 1 : 0);
