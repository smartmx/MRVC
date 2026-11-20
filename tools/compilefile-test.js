/*
 * Compile Single File (0.3.4, user request; the MRS 编译单个文件 counterpart).
 *
 * The design: right-click a .c/.cpp/.cc/.cxx/.s/.S tree file → regenerate
 * the project makefiles exactly like a build → run `make <dir>/<base>.o`.
 * The object rule carries the project's real flags, so the result is what a
 * full build would produce for that file.
 *
 * Tested here:
 *  1. objectTargetFor — the make target spelled as the subdir.mk spells it;
 *  2. singleFileMakeArg — per-shell quoting: cmd.exe double quotes (+ %
 *     doubling for a batch file), POSIX single quotes; `$` stays literal
 *     (a command-line goal is a file name, unlike a makefile rule word);
 *  2b. real wrapper + real make — space / $ / paren / % targets must resolve;
 *  3. pipeline — a generated subdir.mk really contains the rule the helper
 *     names (real LED tree when available, SKIP otherwise);
 *  4. wiring — command + menu (file.src only) + task type + tree context.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const { objectTargetFor, singleFileMakeArg, generateMakefiles } = require('../out/core/makefile.js');
const { Cproject } = require('../out/core/cproject.js');
const { classifySourceExt, SOURCE_WATCHER_GLOB } = require('../out/core/scan.js');

// ---------- 0a. watcher glob covers every spelling the classifier accepts ----------
// (0.3.4 review P3-1: .cp/.c++ built and scanned but never watched)
{
  const inner = SOURCE_WATCHER_GLOB.slice(SOURCE_WATCHER_GLOB.indexOf('{') + 1, SOURCE_WATCHER_GLOB.lastIndexOf('}'));
  const tokens = inner.split(',');
  const covered = (ext) => tokens.some((tok) => new RegExp('^' + tok.replace(/\+/g, '\\+') + '$').test(ext));
  for (const ext of ['cp', 'cP', 'Cp', 'CP', 'c++', 'C++', 'cc', 'Cxx', 'CPP']) {
    check(`watcher glob covers .${ext}`, covered(ext), SOURCE_WATCHER_GLOB);
  }
  check('watcher glob still covers .c and .C distinctly', covered('c') && covered('C'));
  check('watcher glob covers headers', covered('h') && covered('hpp'));
}

// ---------- 0. case-variant recognition (user request 2026-11-19) ----------
// multi-char C++ suffixes fold case (g++ compiles any file as C++); the
// single-letter pairs stay case-sensitive (.c=C vs .C=C++, .s vs .S asm)
const variantChecks = [
  ['x.c', 'c'],
  ['x.C', 'cpp'],
  ['x.cpp', 'cpp'],
  ['x.CPP', 'cpp'],
  ['x.Cpp', 'cpp'],
  ['x.cxx', 'cpp'],
  ['x.Cxx', 'cpp'],
  ['x.cXX', 'cpp'],
  ['x.cc', 'cpp'],
  ['x.Cc', 'cpp'],
  ['x.cC', 'cpp'],
  ['x.CC', 'cpp'],
  ['x.cp', 'cpp'],
  ['x.c++', 'cpp'],
  ['x.s', 'asm'],
  ['x.S', 'asm'],
  ['x.h', undefined],
  ['x.hpp', undefined],
  ['x.o', undefined],
  ['x', undefined],
  ['x.txt', undefined],
];
for (const [name, want] of variantChecks) {
  const got = classifySourceExt(name);
  check(`classify: ${name} -> ${want ?? 'not a source'}`, (got && got.kind) === want, got ? got.kind : 'undefined');
}
check('classify: variant keeps the recorded spelling for the make rule', classifySourceExt('x.Cxx').ext === 'Cxx');

// ---------- 1. objectTargetFor ----------
check('target: root file has no dir part', objectTargetFor('main.c') === 'main.o');
check('target: subdir file', objectTargetFor('Core/main.c') === 'Core/main.o');
check('target: nested subdir', objectTargetFor('src/App/hw_init.cpp') === 'src/App/hw_init.o');
check('target: linked dir (logic name keeps the link name)', objectTargetFor('SRC/StdPeriphDriver/chip.c') === 'SRC/StdPeriphDriver/chip.o');
check('target: spaces preserved (the rule spells them ESC\\-escaped)', objectTargetFor('Core A/b.c') === 'Core A/b.o');
check('target: .S uppercase assembly', objectTargetFor('Startup/startup.S') === 'Startup/startup.o');
check('target: posix separators normalized from windows input', objectTargetFor('Core\\main.c') === 'Core/main.o');

// ---------- 2. singleFileMakeArg ----------
// win32: cmd.exe quotes with double quotes; a literal % must be doubled for
// the .cmd the wrapper writes; $ is a file-name character, never re-expanded.
check('arg(win32): plain target is double-quoted', singleFileMakeArg('Core/main.o', 'win32').arg === '"Core/main.o"');
check('arg(win32): space target stays one argument', singleFileMakeArg('Core A/b.o', 'win32').arg === '"Core A/b.o"');
check('arg(win32): $ passes through verbatim (no makefile doubling)', singleFileMakeArg('Core$x/main.o', 'win32').arg === '"Core$x/main.o"');
check('arg(win32): % is doubled for the batch wrapper', singleFileMakeArg('Pct%1/e.o', 'win32').arg === '"Pct%%1/e.o"');
check('arg(win32): parentheses need no extra escaping', singleFileMakeArg('Core (1)/d.o', 'win32').arg === '"Core (1)/d.o"');
check('arg(win32): double quote in name refused', singleFileMakeArg('Core"q.o', 'win32').error === 'quote');
// POSIX: sh single quotes; an embedded ' closes and reopens the literal.
check('arg(posix): plain target quoted', singleFileMakeArg('Core/main.o', 'posix').arg === `'Core/main.o'`);
check('arg(posix): space target one argument', singleFileMakeArg('Core A/b.o', 'posix').arg === `'Core A/b.o'`);
check('arg(posix): $ stays literal inside single quotes', singleFileMakeArg('Core$x/main.o', 'posix').arg === `'Core$x/main.o'`);
check('arg(posix): embedded single quote is escaped', singleFileMakeArg("Core'b.o", 'posix').arg === `'Core'\\''b.o'`);

// ---------- 2b. REAL wrapper + REAL make (Windows) ----------
// The old helper's single-quoted target survived only as a string assertion;
// cmd.exe passed the quotes through and make failed with "No rule". These
// targets exercise the four shell hazards end to end through the same
// launcher/tee wrapper the extension runs. SKIP when no MRS make exists.
const makeCandidates = [
  'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/others/Build_Tools/Make/bin/make.exe',
  'D:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/others/Build_Tools/Make/bin/make.exe',
  'C:/MounRiver/MounRiver_Studio3/resources/app/resources/win32/others/Build_Tools/Make/bin/make.exe',
];
const realMake = makeCandidates.find((p) => fs.existsSync(p));
if (process.platform !== 'win32' || !realMake) {
  console.log('SKIP  2b. real wrapper make (win32 + MRS make required)');
} else {
  const { writeBuildTaskWrapper } = require('../out/core/taskWrapper.js');
  const root = path.join(__dirname, '..', '.scratch', 'compilefile-wrapper');
  const buildDir = path.join(root, 'obj');
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of ['Core A', 'Dollar$x', 'Core (1)', 'Pct%1']) fs.mkdirSync(path.join(buildDir, d), { recursive: true });
  // makefile escaping is per-syntax, NOT the command-line form:
  //   space -> \ , literal $ -> $$ , % -> \% (else it starts a pattern rule)
  fs.writeFileSync(
    path.join(buildDir, 'makefile'),
    [
      'all:',
      '\t@echo all',
      'Core\\ A/b.o:',
      '\t@echo hit > "Core A/b.o"',
      'Dollar$$x/c.o:',
      "\t@echo hit > 'Dollar$$x/c.o'",
      'Core\\ (1)/d.o:',
      '\t@echo hit > "Core (1)/d.o"',
      'Pct\\%1/e.o:',
      '\t@echo hit > "Pct%1/e.o"',
      '',
    ].join('\n'),
    'utf-8'
  );
  // A clean shell has no MRS entries in PATH. The PRODUCT task injects
  // install.makeBin itself (tasks.ts wrapperExecution), so the test must too:
  // make's recipes need sh.exe from that directory. Keep the fixture honest by
  // giving the child ONLY make's bin + System32 (plus TEMP/SystemRoot etc.),
  // not the parent's developer PATH.
  const cleanPath = [
    path.dirname(realMake),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  ].join(path.delimiter);
  const wrapperEnv = { ...process.env, PATH: cleanPath };
  for (const logic of ['Core A/b.c', 'Dollar$x/c.c', 'Core (1)/d.c', 'Pct%1/e.c']) {
    const target = objectTargetFor(logic);
    const q = singleFileMakeArg(target, 'win32');
    if (q.error || !q.arg) {
      check(`wrapper: ${target} arg produced`, false, q.error);
      continue;
    }
    const launcher = writeBuildTaskWrapper(root, {
      buildDir,
      makeExe: realMake,
      makeArgs: [q.arg],
      recordFile: path.join(os.tmpdir(), 'mrvc-review-compile-file.log'),
      label: 'review',
    });
    const run = spawnSync('cmd.exe', ['/d', '/c', launcher], { encoding: 'utf-8', windowsHide: true, env: wrapperEnv });
    const marker = path.join(buildDir, target);
    check(
      `wrapper: make resolves ${JSON.stringify(target)} (clean PATH)`,
      run.status === 0 && fs.existsSync(marker),
      `exit=${run.status} ${(run.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ')}`
    );
  }
}

// ---------- 2c. variant-suffix dependency tracking (P2-3) ----------
// .cp / .c++ / mixed .cxx+.Cxx get their own deduped *_DEPS variables in
// subdir.mk. The main makefile must include those too, and clean must remove
// them; otherwise a header edit never reaches those objects.
{
  const root = path.join(__dirname, '..', '.scratch', 'variant-deps');
  const rootAbs = path.resolve(root);
  // every write below is a fixture-relative name; reject anything that would
  // climb out of the scratch directory
  const safe = (rel) => {
    const p = path.resolve(rootAbs, rel);
    if (p !== rootAbs && !p.startsWith(rootAbs + path.sep)) throw new Error('fixture path escapes root: ' + rel);
    return p;
  };
  fs.rmSync(rootAbs, { recursive: true, force: true });
  fs.mkdirSync(safe('src'), { recursive: true });
  fs.writeFileSync(
    safe('.project'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<projectDescription>',
      '  <name>Variant</name>',
      '  <natures>',
      '    <nature>org.eclipse.cdt.core.cnature</nature>',
      '    <nature>org.eclipse.cdt.core.ccnature</nature>',
      '  </natures>',
      '</projectDescription>',
      '',
    ].join('\n'),
    'utf-8'
  );
  const cfgId = 'ilg.gnumcueclipse.managedbuild.cross.riscv.config.elf.release.1';
  const tcId = 'ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release.1';
  fs.writeFileSync(
    safe('.cproject'),
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?fileVersion 4.0.0?><cproject storage_type_id="org.eclipse.cdt.core.XmlProjectDescriptionStorage">
\t<storageModule moduleId="org.eclipse.cdt.core.settings">
\t\t<cconfiguration id="${cfgId}">
\t\t\t<storageModule buildSystemId="org.eclipse.cdt.managedbuilder.core.configurationDataProvider" id="${cfgId}" moduleId="org.eclipse.cdt.core.settings" name="obj"/>
\t\t\t<storageModule moduleId="cdtBuildSystem" version="4.0.0">
\t\t\t\t<configuration id="${cfgId}" artifactName="Variant" artifactExtension="elf" buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj">
\t\t\t\t\t<toolChain id="${tcId}" name="RISC-V Cross GCC" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release"/>
\t\t\t\t</configuration>
\t\t\t</storageModule>
\t\t</cconfiguration>
\t</storageModule>
</cproject>
`,
    'utf-8'
  );
  for (const f of ['a.cp', 'b.c++', 'mix.cxx', 'mix2.Cxx']) {
    fs.writeFileSync(safe('src/' + path.basename(f)), 'int x(void){return 1;}\n');
  }
  fs.writeFileSync(safe('src/dep.h'), '#define DEP 1\n');
  const cp = Cproject.load(rootAbs);
  const tc = {
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
  };
  generateMakefiles(cp, tc);
  const mainMk = fs.readFileSync(safe('obj/makefile'), 'utf-8');
  const subMk = fs.readFileSync(safe('obj/src/subdir.mk'), 'utf-8');
  // the clean RECIPE line only (not any `-include` line that happens to
  // mention the same variable) — P3-2 in the 0.3.4 review: the old assertion
  // could pass without the variable being in the clean command at all
  const cleanRecipe = (mainMk.match(/^clean:\r?\n([^\r\n]*)/m) || [])[1] || '';
  for (const v of ['CP_DEPS', 'C___DEPS', 'CXX_2_DEPS']) {
    check(`variant deps: subdir.mk defines ${v}`, subMk.includes(`${v} +=`), '');
    check(`variant deps: main makefile includes ${v}`, mainMk.includes(`-include $(${v})`), '');
    check(`variant deps: clean removes ${v}`, cleanRecipe.includes(`$(${v})`), cleanRecipe);
  }
  // incremental: a .d that names a NEWER header must trigger the recipe.
  // make -n prints it without needing a compiler. Without the include make
  // answers "'src/a.o' is up to date." and the object goes stale.
  const make = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/others/Build_Tools/Make/bin/make.exe';
  if (process.platform === 'win32' && fs.existsSync(make)) {
    const now = Date.now() / 1000;
    const touch = (p, t) => fs.utimesSync(p, t, t);
    for (const [src, obj, dep] of [
      ['a.cp', 'a.o', 'a.d'],
      ['b.c++', 'b.o', 'b.d'],
      ['mix.cxx', 'mix.o', 'mix.d'],
      ['mix2.Cxx', 'mix2.o', 'mix2.d'],
    ]) {
      touch(safe('src/' + path.basename(src)), now - 100);
      const o = safe('obj/src/' + path.basename(obj));
      fs.writeFileSync(o, '');
      touch(o, now - 50);
      const d = safe('obj/src/' + path.basename(dep));
      fs.writeFileSync(d, `src/${path.basename(obj)}: ../src/dep.h\n`, 'utf-8');
      touch(d, now - 40);
    }
    touch(safe('src/dep.h'), now + 10);
    // argv array, shell=false; fixed bundled make path (same probe other
    // makefile suites use)
    const run = spawnSync(make, ['-n', 'src/a.o', 'src/b.o', 'src/mix.o', 'src/mix2.o'], {
      cwd: safe('obj'),
      encoding: 'utf-8',
    });
    check('variant deps: make -n exits 0', run.status === 0, String(run.status));
    for (const obj of ['src/a.o', 'src/b.o', 'src/mix.o', 'src/mix2.o']) {
      check(
        `variant deps: header change rebuilds ${obj}`,
        (run.stdout || '').includes(obj) && !/is up to date/.test(run.stdout || ''),
        (run.stdout || '').trim()
      );
    }
  } else {
    console.log('SKIP  2c incremental header rebuild (win32 + MRS make required)');
  }
}

// ---------- 3. pipeline: generated subdir.mk contains the named rule ----------
const LED_PROJ = ['F:/CH585/EVT/V1_2/EXAM/LED', 'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find((p) =>
  fs.existsSync(path.join(p, '.cproject'))
);
if (LED_PROJ) {
  const scratch = path.join(__dirname, '..', '.scratch', 'compilefile');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(path.join(scratch, 'Core'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
  for (const f of ['.project', '.cproject']) fs.copyFileSync(path.join(LED_PROJ, f), path.join(scratch, f));
  fs.writeFileSync(path.join(scratch, 'Core', 'main.c'), 'int main(void){return 0;}\n');
  fs.writeFileSync(path.join(scratch, 'src', 'helper.cpp'), 'int f(void){return 1;}\n');
  const cp = Cproject.load(scratch);
  // LED is a plain C project (no C++ nature) — .cpp files are not scanned
  // for it at all; flip the fixture to C++ so the cpp rule is exercised
  const { setProjectCpp } = require('../out/core/projectType.js');
  setProjectCpp(scratch, true);
  const cpCpp = Cproject.load(scratch);
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
  generateMakefiles(cpCpp, goldenTc());
  // in-root files compile through the PATTERN rule `dir/%.o: ../dir/%.ext`:
  // make resolves `make dir/base.o` against it (stem = base, prereq =
  // ../dir/base.ext). Assert the pattern rule exists, the stem's source file
  // really exists (so the prereq resolves), and the recipe compiles.
  for (const [logic, mkPath] of [
    ['Core/main.c', path.join(scratch, 'obj', 'Core', 'subdir.mk')],
    ['src/helper.cpp', path.join(scratch, 'obj', 'src', 'subdir.mk')],
  ]) {
    const t = objectTargetFor(logic);
    const text = fs.readFileSync(mkPath, 'utf-8');
    const dir = path.posix.dirname(logic);
    const ext = path.posix.extname(logic).slice(1);
    const pat = dir === '.' || dir === '' ? `%.o: ../${logic}` : `${dir}/%.o: ../${dir}/%.${ext}`;
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex((l) => l === pat);
    check(`pipeline: pattern rule "${pat}" present`, idx >= 0, JSON.stringify(lines.filter((l) => l.includes('%'))));
    check(`pipeline: ${t} stem source exists (prereq resolves)`, fs.existsSync(path.join(scratch, logic)));
    check(`pipeline: ${t} pattern recipe compiles`, idx >= 0 && (lines[idx + 1] || '').includes(`-c -o "$@"`));
  }
  // the cpp rule invokes the C++ compiler
  const cppMk = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
  check('pipeline: cpp rule invokes the C++ compiler', cppMk.includes('riscv-none-embed-g++'));

  // ---- case variants get their OWN pattern rules (make % is case-sensitive)
  fs.writeFileSync(path.join(scratch, 'src', 'extra.cc'), 'int g(void){return 2;}\n');
  fs.writeFileSync(path.join(scratch, 'src', 'vclass.Cxx'), 'int h(void){return 3;}\n');
  fs.writeFileSync(path.join(scratch, 'src', 'mix.cxx'), 'int i(void){return 4;}\n');
  fs.writeFileSync(path.join(scratch, 'src', 'mix.Cxx'), 'int j(void){return 5;}\n');
  const cpV = Cproject.load(scratch);
  generateMakefiles(cpV, goldenTc());
  const vMk = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
  check('pipeline: .cc variant has its own pattern rule', vMk.includes('src/%.o: ../src/%.cc'));
  const vLines = vMk.split(/\r?\n/);
  const cxxRuleAt = vLines.findIndex((l) => l === 'src/%.o: ../src/%.Cxx');
  check('pipeline: .Cxx variant has its own pattern rule (actual spelling)', cxxRuleAt >= 0, JSON.stringify(vLines.filter((l) => l.includes('%'))));
  check('pipeline: .Cxx rule invokes the C++ compiler', cxxRuleAt >= 0 && (vLines[cxxRuleAt + 1] || '').includes('riscv-none-embed-g++'));
  // mixed spellings in ONE dir: make variables must not collide
  check('pipeline: mixed .cxx/.Cxx dedupes the make variable (no lost objects)', vMk.includes('CXX_2_SRCS') && vMk.includes('CXX_2_DEPS'), vMk.split(/\r?\n/).filter((l) => l.includes('CXX_2')).join(' | '));
  check('pipeline: both mixed-spelling objects are listed in OBJS', vMk.includes('mix.o') && vMk.includes('vclass.o'));
  fs.rmSync(scratch, { recursive: true, force: true });
} else {
  console.log('SKIP  3. pipeline rule check (no real LED tree found)');
}

// ---------- 4. wiring: command/menu/task/context ----------
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  check('wiring: command registered', !!pkg.contributes.commands.find((c) => c.command === 'mrvc.compileFile'));
  const menu = pkg.contributes.menus['view/item/context'].find((m) => m.command === 'mrvc.compileFile');
  check('wiring: menu only on file.src (not headers, not excluded)', !!menu && menu.when === 'view == mrvc.projectExplorer && viewItem == file.src');
  check('wiring: menu renders BELOW the file operation group', menu.group.split('@')[0] > 'file', menu.group);
  const fileMenus = pkg.contributes.menus['view/item/context'].filter((m) => m.when && m.when.includes('viewItem == file.excluded') && !m.when.includes('file.src'));
  check('wiring: every file menu covers file.src / file.src.excluded', fileMenus.length === 0, JSON.stringify(fileMenus.map((m) => m.command)));
  const treeJs = fs.readFileSync(path.join(__dirname, '..', 'out', 'vscode', 'tree.js'), 'utf-8');
  check('wiring: tree assigns file.src context values', treeJs.includes('file.src'));
  const extJs = fs.readFileSync(path.join(__dirname, '..', 'out', 'extension.js'), 'utf-8');
  check('wiring: extension registers the command and task type', extJs.includes('mrvc.compileFile') && extJs.includes('mrvc-compile-file'));
  const tasksJs = fs.readFileSync(path.join(__dirname, '..', 'out', 'vscode', 'tasks.js'), 'utf-8');
  check('wiring: single-file record is a throwaway temp file (never the build record)', tasksJs.includes('mrvc-single-file-record.log'));
}

console.log(failures ? `\n${failures} FAILURES` : '\nall compilefile tests passed');
process.exit(failures ? 1 : 0);
