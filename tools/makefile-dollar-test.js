/*
 * makefile dollar-escaping regression. A user-supplied `$` (an -I/-L/-T/-D
 * path, a macro value) must be doubled so make emits one real dollar, while
 * make-SYNTAX tokens stay verbatim. Guards "Generate Assembly Listing":
 * CDT's -Wa,-adhlns="$@.lst" flag names its .lst after $@ — doubling it to
 * `$$@` sends an empty `$@` to the shell and every listing silently
 * collapses onto a bare ".lst".
 */
const { escapeMakeDollars } = require('../out/core/makefile.js');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// ---------- 1. user text: every `$` doubled ----------
check('single user $ doubled', escapeMakeDollars('-IC:/a$b') === '-IC:/a$$b');
check('several user $ doubled', escapeMakeDollars('$x$y$') === '$$x$$y$$');
check('no $ is a no-op', escapeMakeDollars('-Os -g') === '-Os -g');

// ---------- 2. make tokens: preserved verbatim ----------
check('$@ survives (assm listing)', escapeMakeDollars('-Wa,-adhlns="$@.lst"') === '-Wa,-adhlns="$@.lst"');
check('$< survives', escapeMakeDollars('-MT"$<"') === '-MT"$<"');
check('$^ survives', escapeMakeDollars('-flto $^') === '-flto $^');
check('$* survives', escapeMakeDollars('$*.d') === '$*.d');
check('$? survives', escapeMakeDollars('$?') === '$?');
check('$(VAR) survives', escapeMakeDollars('-D$(USER_DEFINE)') === '-D$(USER_DEFINE)');
check('${VAR} survives', escapeMakeDollars('${FLAGS}') === '${FLAGS}');

// ---------- 3. a realistic mixed option string ----------
check(
  'mixed: only user dollars move',
  escapeMakeDollars('-IC:/lit$eral -Wa,-adhlns="$@.lst" -D$(USER_DEFINE)') === '-IC:/lit$$eral -Wa,-adhlns="$@.lst" -D$(USER_DEFINE)'
);

// ---------- 4. pipeline: the commonOptions string (target/optimization/
// warnings/debugging "other" user text) must go through the same escaping —
// a real generateMakefiles run on an LED scratch copy with `$` in
// target.other (previously it reached the recipe raw and make swallowed it)
// ----------
{
  const fs = require('fs');
  const path = require('path');
  const LED_PROJ = ['F:/CH585/EVT/V1_2/EXAM/LED', 'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find((p) =>
    fs.existsSync(path.join(p, '.cproject'))
  );
  if (LED_PROJ) {
    const scratch = path.join(__dirname, '..', '.scratch', 'dollar-common');
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
    for (const f of ['.project', '.cproject']) fs.copyFileSync(path.join(LED_PROJ, f), path.join(scratch, f));
    fs.writeFileSync(path.join(scratch, 'src', 'main.c'), 'int main(void){return 0;}\n');
    const { Cproject } = require('../out/core/cproject.js');
    const { generateMakefiles } = require('../out/core/makefile.js');
    const cp = Cproject.load(scratch);
    cp.setOptionValue('target.other', '-flto-partition=$foo');
    cp.save();
    const goldenTc = () => ({
      name: 'GCC8',
      dir: '',
      compilerC: 'riscv-none-embed-gcc',
      compilerCpp: 'riscv-none-embed-g++',
      linkerC: 'riscv-none-embed-gcc',
      linkerCpp: 'riscv-none-embed-g++',
      debugger: 'riscv-none-embed-gdb',
      objcopy: 'riscv-none-embed-objcopy',
      objdump: 'riscv-none-embed-objdump',
      size: 'riscv-none-embed-size',
      prefix: 'riscv-none-embed-',
    });
    generateMakefiles(cp, goldenTc());
    const mk = fs.readFileSync(path.join(scratch, 'obj', 'makefile'), 'utf-8');
    check('pipeline: common options escaped (target.other $ doubled)', mk.includes('-flto-partition=$$foo'));
    check('pipeline: no bare user $ left in the common string', !mk.includes('=$foo'));
  } else {
    console.log('SKIP  4. pipeline common-escaping (no real LED tree found)');
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nall makefile dollar-escaping tests passed');
process.exit(failures ? 1 : 0);
