/**
 * End-to-end test: project defines must reach the compiler via the
 * generated makefile. Uses a source file that fails to compile unless
 * every expected macro is present, plus the real toolchain make.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { Cproject } = require(path.join(here, '..', 'out', 'core', 'cproject.js'));
const { generateMakefiles } = require(path.join(here, '..', 'out', 'core', 'makefile.js'));
const { locateInstall, selectToolchain } = require(path.join(here, '..', 'out', 'core', 'toolchain.js'));

const scratch = path.join(here, '..', '.scratch', 'define-test');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
for (const f of ['.project', '.cproject']) {
  fs.copyFileSync(path.join('F:/CH585/EVT/V1_2/EXAM/LED', f), path.join(scratch, f));
}
// point the scratch project's linked folders at the REAL SRC tree so the
// link stage (startup, linker script, libISP585) can succeed in isolation
{
  const projFile = path.join(scratch, '.project');
  fs.writeFileSync(
    projFile,
    fs.readFileSync(projFile, 'utf-8').split('PARENT-1-PROJECT_LOC').join('F:/CH585/EVT/V1_2/EXAM'),
    'utf-8'
  );
}

// configure defines via the same API the properties page uses
const cp = Cproject.load(scratch);
cp.setOptionList('c.compiler.defs', ['DEBUG=0', 'TEST_VALUE=42', 'BOARD_NAME="CH58x"', 'FEATURE_EN']);
cp.setOptionList('assembler.defs', ['ASM_FEATURE_EN']);
cp.save();

// source that compiles ONLY if the C defines arrive
fs.writeFileSync(
  path.join(scratch, 'src', 'main.c'),
  [
    '#include <stdint.h>',
    '#ifndef DEBUG',
    '#error "DEBUG missing"',
    '#endif',
    '#if DEBUG != 0',
    '#error "DEBUG wrong value"',
    '#endif',
    '#ifndef TEST_VALUE',
    '#error "TEST_VALUE missing"',
    '#endif',
    '#if TEST_VALUE != 42',
    '#error "TEST_VALUE wrong"',
    '#endif',
    '#ifndef BOARD_NAME',
    '#error "BOARD_NAME missing"',
    '#endif',
    '#ifndef FEATURE_EN',
    '#error "FEATURE_EN missing"',
    '#endif',
    'int main(void) { return 0; }',
  ].join('\n')
);
// assembler source that assembles ONLY if the asm define arrives
fs.writeFileSync(
  path.join(scratch, 'src', 'asm_check.S'),
  [
    '#ifdef ASM_FEATURE_EN',
    '.globl asm_check_fn',
    'asm_check_fn:',
    '    jr ra',
    '#endif',
  ].join('\n')
);

// regenerate makefiles and build with the real toolchain
const cp2 = Cproject.load(scratch);
const install = locateInstall(undefined);
const tc = selectToolchain(install, 'auto', cp2.rvGccVersion, cp2.storedPrefix);
generateMakefiles(cp2, tc);

const mk = path.join(install.makeBin, 'make.exe');
const proc = spawnSync(mk, ['-j4', 'all'], {
  cwd: path.join(scratch, 'obj'),
  env: { ...process.env, PATH: `${path.join(tc.dir, 'bin')};${install.makeBin};${process.env.PATH ?? ''}` },
  encoding: 'utf-8',
  shell: false,
});
const out = ((proc.stdout ?? '') + (proc.stderr ?? ''));

const compileLine = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};
check('makefile has -DDEBUG=0', compileLine.includes('-DDEBUG=0'));
check('makefile has -DTEST_VALUE=42', compileLine.includes('-DTEST_VALUE=42'));
check('makefile has -DFEATURE_EN', compileLine.includes('-DFEATURE_EN'));
check('makefile has -DBOARD_NAME', compileLine.includes('-DBOARD_NAME'));
check('assembler rule has -DASM_FEATURE_EN', fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8').includes('-DASM_FEATURE_EN'));
check('make build exit 0', proc.status === 0);
if (proc.status !== 0) {
  console.log(out.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(0, 6).join('\n'));
}
console.log(failures ? `\n${failures} FAILURES` : '\nall define checks passed');
process.exit(failures ? 1 : 0);
