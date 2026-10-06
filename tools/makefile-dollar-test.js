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

console.log(failures ? `\n${failures} FAILURES` : '\nall makefile dollar-escaping tests passed');
process.exit(failures ? 1 : 0);
