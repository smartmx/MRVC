/*
 * Tree/batch enhancement tests: file flags (MRS2-compatible
 * .mrs/preferredColor.json), the batch toolchain modify write-back,
 * deep linked-folder scans, and parenthesized path handling.
 * Run: node tools/enhancements-test.js
 */
const path = require('path');
const fs = require('fs');

const {
  MARK_COLORS,
  setMark,
  clearMark,
  listMarks,
  markColorByAlias,
  themeColorFor,
} = require('../out/core/colorMarks.js');
const { Cproject } = require('../out/core/cproject.js');
const { scanSources } = require('../out/core/scan.js');
const { selectToolchain } = require('../out/core/toolchain.js');
const { generateMakefiles } = require('../out/core/makefile.js');
const { spawnSync } = require('child_process');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// ---------- 1. colorMarks: MRS2 file shape ----------
{
  const root = path.join(__dirname, '..', '.scratch', 'colormarks');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'SRC'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SRC', 'a.c'), 'int a;\n');

  const links = new Map(); // no linked folders here
  setMark(root, links, 'SRC/a.c', 'Green');
  setMark(root, links, 'SRC/a.c', 'Blue'); // re-flag overwrites

  const raw = JSON.parse(fs.readFileSync(path.join(root, '.mrs', 'preferredColor.json'), 'utf-8'));
  check('flag: MRS2 file shape {details:[{logic_file,color}]}', Array.isArray(raw.details) && raw.details.length === 1 && raw.details[0].logic_file === 'SRC/a.c' && raw.details[0].color === 'Blue' && raw.details[0].abs_file === undefined);

  const marks = listMarks(root, links);
  check('flag: list returns abs + logic + color', marks.length === 1 && marks[0].logicFile === 'SRC/a.c' && marks[0].color === 'Blue' && path.resolve(marks[0].absFile) === path.resolve(path.join(root, 'SRC', 'a.c')));

  clearMark(root, links, 'SRC/a.c');
  check('flag: clear removes the entry', listMarks(root, links).length === 0);
  const raw2 = JSON.parse(fs.readFileSync(path.join(root, '.mrs', 'preferredColor.json'), 'utf-8'));
  check('flag: clear persists an empty details list', Array.isArray(raw2.details) && raw2.details.length === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- 2. colorMarks: linked folder logic path + MRS2 file read-back ----------
{
  const root = path.join(__dirname, '..', '.scratch', 'colormarks-link');
  const lib = path.join(root, 'outside', 'LIB');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(lib, 'inc'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'inc', 'x.h'), '');
  fs.mkdirSync(root, { recursive: true });

  // a file written by MRS2 (logic_file only, linked path)
  fs.mkdirSync(path.join(root, '.mrs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.mrs', 'preferredColor.json'),
    JSON.stringify({ details: [{ logic_file: 'LIB/inc/x.h', color: 'Teal' }] }),
    'utf-8'
  );
  const links = new Map([['LIB', lib]]);
  const marks = listMarks(root, links);
  check('flag: MRS2-written file read back, abs resolved through the link', marks.length === 1 && marks[0].color === 'Teal' && path.resolve(marks[0].absFile) === path.resolve(path.join(lib, 'inc', 'x.h')));

  clearMark(root, links, 'LIB/inc/x.h');
  check('flag: clear works on a linked file', listMarks(root, links).length === 0);

  // color table: 20 MRS2 aliases + theme mapping total
  check('colors: 20 MRS2 aliases', MARK_COLORS.length === 20 && !!markColorByAlias('teal') && !markColorByAlias('nope'));
  check('colors: theme mapping covers all aliases', MARK_COLORS.every((c) => themeColorFor(c.alias).startsWith('terminal.ansi')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- 3. batch toolchain write-back (the command's core step) ----------
{
  const LED_PROJ = ['E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'F:/CH585/EVT/V1_2/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find((p) =>
    fs.existsSync(path.join(p, '.cproject'))
  );
  if (!LED_PROJ) {
    console.log('SKIP  3. toolchain write-back (no real LED tree found)');
  } else {
    const WS = path.join(__dirname, '..', '.scratch', 'toolchain-batch');
    fs.rmSync(WS, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
    const p1 = path.join(WS, 'p1');
    fs.cpSync(LED_PROJ, p1, { recursive: true });

    const OPT_BASE = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
    const cp = Cproject.load(p1);
    const before = cp.rvGccVersion;
    const isRiscv = /riscv/i.test(cp.toolChain.attr('superClass') ?? '');
    check('toolchain fixture: LED is RISC-V', isRiscv);
    // the exact write step of modifySolutionToolchainCmd
    const version = before === '15' ? '12' : '15'; // flip to a DIFFERENT value
    cp.setOptionValue('target.rvGcc', OPT_BASE + 'target.rvGcc.' + version);
    cp.save();
    const reloaded = Cproject.load(p1);
    check('toolchain: rvGcc rewritten and reads back', reloaded.rvGccVersion === version);
    // and the toolchain resolver follows it (the command's effect)
    const MRS2_ROOT = process.env.MRS2_HOME || 'C:/MounRiver/MounRiver_Studio2';
    const install = (() => {
      try {
        const { locateInstall } = require('../out/core/toolchain.js');
        return locateInstall(MRS2_ROOT);
      } catch {
        return null;
      }
    })();
    if (install) {
      const tc = selectToolchain(install, 'auto', reloaded.rvGccVersion, reloaded.storedPrefix);
      check('toolchain: resolver follows the new rvGcc (' + version + ')', !!tc && tc.name.toUpperCase().includes('GCC' + version));
    } else {
      console.log('SKIP  toolchain resolver probe (no MRS2 install)');
    }
    fs.rmSync(WS, { recursive: true, force: true });
  }
}

// ---------- 4. deep linked-folder scan (changelog V0.1.9 勘误的回归背书:
// "深层拆分只识别第 1 层" 系误判——MRVC 构建扫描与 MRS2 同为完整递归) ----------
{
  const base = path.join(__dirname, '..', '.scratch', 'deep-link');
  const proj = path.join(base, 'proj');
  const lib = path.join(base, 'libsrc');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(lib, 'Deep', 'USB'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'top.c'), 'int t;\n');
  fs.writeFileSync(path.join(lib, 'Deep', 'mid.c'), 'int m;\n');
  fs.writeFileSync(path.join(lib, 'Deep', 'USB', 'usb.c'), 'int u;\n');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.project'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription>\n<name>deep</name>\n<linkedResources>\n<link>\n<name>LIB</name>\n<type>2</type>\n<location>${lib}</location>\n</link>\n</linkedResources>\n</projectDescription>`
  );
  fs.writeFileSync(
    path.join(proj, '.cproject'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>`
  );
  const cp = Cproject.load(proj);
  const all = [...scanSources(cp).values()].flat().map((f) => f.logicName);
  check('deep link: L1/L2/L3 all scanned (full recursion, MRS2 parity)', all.includes('LIB/top.c') && all.includes('LIB/Deep/mid.c') && all.includes('LIB/Deep/USB/usb.c'));
  fs.rmSync(base, { recursive: true, force: true });
}

// ---------- 5. parenthesized project and linked-folder paths ----------
{
  const base = path.join(__dirname, '..', '.scratch', 'path-paren(2026)');
  const proj = path.join(base, 'proj(1)');
  const lib = path.join(base, 'lib(2)');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
  fs.writeFileSync(path.join(lib, 'extra.c'), 'int extra(void){return 1;}\n');
  fs.writeFileSync(path.join(proj, '.project'), `<?xml version="1.0"?><projectDescription><name>paren</name><linkedResources><link><name>LIB</name><type>2</type><location>${lib}</location></link></linkedResources></projectDescription>`);
  fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release"><option id="o" name="Create flash image" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.addtools.createflash" value="false" valueType="boolean"/><option id="p" name="Print size" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.addtools.printsize" value="false" valueType="boolean"/><sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="LIB"/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
  const tcStub = {
    name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
    linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
    objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size', prefix: 'riscv-wch-elf-',
  };
  const cp = Cproject.load(proj);
  const gen = generateMakefiles(cp, tcStub);
  check('path paren: project root and linked target are accepted', cp.projectRoot.includes('(') && [...cp.linkedFolders.values()].some((p) => p.includes(')')) && gen.sourceCount === 2);
  check('path paren: generated linked-folder rule keeps the literal path', fs.readFileSync(path.join(proj, 'obj', 'LIB', 'subdir.mk'), 'utf8').includes('lib(2)/extra.c'));
  const make = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/others/Build_Tools/Make/bin/make.exe';
  if (fs.existsSync(make)) {
    const r = spawnSync(make, ['-n', '-B', 'all'], { cwd: path.join(proj, 'obj'), encoding: 'utf8' });
    check('path paren: bundled make parses the generated rules', r.status === 0);
  } else {
    console.log('SKIP  path paren: bundled make not found');
  }
  fs.rmSync(base, { recursive: true, force: true });
}
// ---------- 7. hostile ROOT with same-ancestor links / USER_OBJS boundary ----------
// Round-11 review: the linked-folder check used to test the ABSOLUTE resolved
// path, so a root carrying ";" or "#" rejected every PARENT-n linked folder
// under it. That rejection is CORRECT: linked files get per-file rules with
// ABSOLUTE prereqs (MRS2 parity — the goldens do the same), so the root's
// characters ride into rule words and make breaks them. USER_OBJS under a
// hostile root is likewise rejected with an explicit message (absolute make
// words are unrepresentable). Linkless projects with a hostile root work
// (section 6).
{
  const SEMI = String.fromCharCode(59);
  const HASH = String.fromCharCode(35);
  const make = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/others/Build_Tools/Make/bin/make.exe';
  const tcStub = {
    name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
    linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
    objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size', prefix: 'riscv-wch-elf-',
  };
  const cproj = (links) => {
    const le = links.map((l) => '<link><name>' + l.name + '</name><type>2</type><location>' + l.loc + '</location></link>').join('');
    const se = links.map((l) => '<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="' + l.name + '"/>').join('');
    return '<?xml version="1.0"?><projectDescription><name>hr</name><linkedResources>' + le + '</linkedResources></projectDescription>';
  };
  const ccproj = (se, userobjs) => {
    const uo = userobjs ? '<option id="u" name="Other objects" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.' + (userobjs === "cpp" ? "cpp" : "c") + '.linker.otherobjs" valueType="userObjs"><listOptionValue builtIn="false" value="' + userobjs + '"/></option>' : '';
    return '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">' + uo + '<sourceEntries>' + se + '</sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>';
  };
  // 1. root ";" / "#" + same-ancestor linked folder: accepted, rules relative,
  //    real make parses them
  for (const [tag, ch] of [['semi-root', SEMI], ['hash-root', HASH]]) {
    const base = path.join(__dirname, '', '.scratch', 'path-r7' + ch.charCodeAt(0));
    const root = path.join(base, 'root' + ch);
    const proj = path.join(root, 'proj');
    const lib = path.join(root, 'lib');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    fs.writeFileSync(path.join(lib, 'extra.c'), 'int extra(void){return 1;}\n');
    fs.writeFileSync(path.join(proj, '.project'), cproj([{ name: 'LIB', loc: lib }]));
    fs.writeFileSync(path.join(proj, '.cproject'), ccproj('<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="LIB"/>', ''));
    try {
      const cp = Cproject.load(proj);
      // linked files get PER-FILE rules with ABSOLUTE prereqs (MRS2 parity),
      // so a hostile root rides into rule words — rejection is the contract
      let threw = '';
      try {
        generateMakefiles(cp, tcStub);
      } catch (e) {
        threw = String(e.message || e);
      }
      check('path ' + tag + ' + same-ancestor link: rejected with explicit message', threw.indexOf('Linked folder path') !== -1);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
  // 2. root ";" + USER_OBJS: explicit rejection
  {
    const base = path.join(__dirname, '', '.scratch', 'path-r7uo');
    const root = path.join(base, 'root' + SEMI);
    const proj = path.join(root, 'proj');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    const objFile = path.join(root, 'extra.o');
    fs.writeFileSync(objFile, 'placeholder');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>hr</name></projectDescription>');
    fs.writeFileSync(path.join(proj, '.cproject'), ccproj('<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>', objFile.replace(/\\/g, '/')));
    let threw = '';
    try {
      generateMakefiles(Cproject.load(proj), tcStub);
    } catch (e) {
      threw = String(e.message || e);
    }
    check('path root-semi + USER_OBJS: rejected with explicit message', threw.indexOf('Other Objects') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ---------- 6. ";" "#" "%" project-root paths (quoted flag args) ----------
// "project root" chars never reach rule words (prereqs are relative), but the
// ABSOLUTE -I flag does reach the recipe, which the make bundle's sh.exe would
// tear apart at ";" (command separator) or "#" (comment) - quoteUnsafeShell
// quotes such args so both sh and cmd pass them through literally.
{
  const SEMI = String.fromCharCode(59);
  const HASH = String.fromCharCode(35);
  const PCT = String.fromCharCode(37);
  const make = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/others/Build_Tools/Make/bin/make.exe';
  const mkProj = (ch) => {
    const base = path.join(__dirname, '..', '.scratch', 'path-chr' + ch.charCodeAt(0));
    const proj = path.join(base, 'proj' + ch + 'root');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'inc'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'inc', 'cfg.h'), '#define V 1\n');
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), '#include "cfg.h"\nint main(void){return V-1;}\n');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>chrp</name></projectDescription>');
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release"><option id="o" name="Create flash image" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.addtools.createflash" value="false" valueType="boolean"/><option id="p" name="Print size" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.addtools.printsize" value="false" valueType="boolean"/><option id="i" name="Include paths" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.compiler.include.paths" valueType="includePath"><listOptionValue builtIn="false" value="&quot;${project}/inc&quot;"/></option><sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    return { base, proj };
  };
  const tcStub = {
    name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
    linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
    objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size', prefix: 'riscv-wch-elf-',
  };
  for (const [tag, ch] of [['semi', SEMI], ['hash', HASH], ['pct', PCT]]) {
    const { base, proj } = mkProj(ch);
    try {
      const cp = Cproject.load(proj);
      generateMakefiles(cp, tcStub); // must NOT throw - root chars are accepted now
      const mk = fs.readFileSync(path.join(proj, 'obj', 'SRC', 'subdir.mk'), 'utf8');
      check('path ' + tag + ': generation accepted for project root', mk.length > 0);
      const incAbs = path.join(proj, 'inc').replace(/\\/g, '/').toLowerCase();
      check('path ' + tag + ': absolute -I flag is quoted', mk.toLowerCase().includes('-i"' + incAbs + '"'));
      if (fs.existsSync(make)) {
        const env = { ...process.env };
        env.PATH = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/components/WCH/Toolchain/RISC-V Embedded GCC12/bin' + path.delimiter + path.dirname(make);
        const r = spawnSync(make, ['-B', 'all'], { cwd: path.join(proj, 'obj'), encoding: 'utf8', env });
        check('path ' + tag + ': real make builds through sh (quoted args)', r.status === 0);
        if (r.status !== 0) console.log('  diag ' + tag + ':', String(r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ').slice(0, 300));
      } else {
        console.log('SKIP  path ' + tag + ': bundled make not found');
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
  // linked folder carrying ";" / "#" still rejected (rule words); "%" allowed
  {
    const base = path.join(__dirname, '..', '.scratch', 'path-linkchr');
    const proj = path.join(base, 'proj');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    const lib = path.join(base, 'lib' + SEMI + 'dir');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'extra.c'), 'int extra(void){return 1;}\n');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>linkchr</name><linkedResources><link><name>LIB</name><type>2</type><location>' + lib + '</location></link></linkedResources></projectDescription>');
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release"/><sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="LIB"/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    let threw = '';
    try {
      generateMakefiles(Cproject.load(proj), tcStub);
    } catch (e) {
      threw = String(e.message || e);
    }
    check('path link-semi: linked folder with ";" is still rejected', threw.indexOf('Linked folder path') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ---------- 8. character matrix on the REAL FreeRTOS-with-links layout ----------
// Source tree: F:/CH592/CH592-EVT-RTOS更新/CH592# (a real MRS2-2.5.0-built
// project whose root name carries "#" and whose SRC/StdPeriphDriver +
// SRC/RVMSIS links resolve INSIDE that root). Per character: copy the whole
// tree to a root named with that character, regenerate with MRVC, then full
// build with the bundled make. Established limits: linked paths carry the
// ABSOLUTE root, so ";" / "#" in the root break the rule words (MRS2 built
// the same layout under CH592% successfully — "%" is a literal in rule
// words); backticks would command-substitute inside the quoted sh args.
{
  const SRC_TREE = 'F:/CH592/CH592-EVT-RTOS更新/CH592#';
  const make = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/others/Build_Tools/Make/bin/make.exe';
  const tcStub = {
    name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
    linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
    objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size', prefix: 'riscv-wch-elf-',
  };
  // tag -> [char, expected]: "reject" = generateMakefiles throws; true/false = build status
  const CASES = {
    semi: [String.fromCharCode(59), 'reject'],
    hash: [String.fromCharCode(35), 'reject'],
    pct: [String.fromCharCode(37), true],
    lparen: ['(', true],
    rparen: [')', true],
    amp: ['&', true],
    at: ['@', true],
    bang: ['!', true],
    comma: [',', true],
    tilde: ['~', true],
    apos: [String.fromCharCode(39), true],
    lbracket: ['[', true],
    btick: ['`', 'reject'],
  };
  if (!fs.existsSync(SRC_TREE)) {
    console.log('SKIP  char matrix: source tree not found');
  } else {
    for (const [tag, chDef] of Object.entries(CASES)) {
      const [ch, expected] = chDef;
      const caseDir = path.join(__dirname, '', '.scratch', 'char-matrix', tag);
      const tree = path.join(caseDir, 'CH592' + ch);
      const proj = path.join(tree, 'FreeRTOS');
      fs.rmSync(caseDir, { recursive: true, force: true });
      fs.cpSync(SRC_TREE, tree, { recursive: true, filter: (s) => s.indexOf(path.sep + 'obj') === -1 && !s.endsWith(path.sep + 'obj') });
      let threw = '';
      let built = false;
      try {
        generateMakefiles(Cproject.load(proj), tcStub);
        if (fs.existsSync(make)) {
          const env = { ...process.env };
          env.PATH = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/components/WCH/Toolchain/RISC-V Embedded GCC12/bin' + path.delimiter + path.dirname(make);
          const r = spawnSync(make, ['all'], { cwd: path.join(proj, 'obj'), encoding: 'utf8', env });
          built = r.status === 0;
          if (!built) console.log('  diag ' + tag + ':', String(r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(0, 2).join(' | ').slice(0, 260));
        } else {
          console.log('SKIP  char matrix build: bundled make not found');
        }
      } catch (e) {
        threw = String(e.message || e);
      } finally {
        fs.rmSync(caseDir, { recursive: true, force: true });
      }
      if (expected === 'reject') {
        check('char matrix ' + tag + ': rejected with explicit message', threw.indexOf('Linked folder path') !== -1 || threw.indexOf('backtick') !== -1);
      } else {
        check('char matrix ' + tag + ': generation accepted, built=' + built + ' (expected ' + expected + ')', !threw && built === expected);
      }
    }
  }
}
// ---------- 9. round-2 boundaries: root backtick (linkless) + external USER_OBJS ----------
{
  const SEMI = String.fromCharCode(59);
  const HASH = String.fromCharCode(35);
  const BTICK = String.fromCharCode(96);
  const tcStub = {
    name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
    linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
    objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size', prefix: 'riscv-wch-elf-',
  };
  const gen = (proj) => {
    let threw = '';
    try {
      generateMakefiles(Cproject.load(proj), tcStub);
    } catch (e) {
      threw = String(e.message || e);
    }
    return threw;
  };
  // 1. linkless project, root contains a backtick: rejected (sh command
  //    substitution inside the quoted -I args), not left to sh cryptic EOF
  {
    const base = path.join(__dirname, '', '.scratch', 'path-r2-bt');
    const proj = path.join(base, 'proj' + BTICK);
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>bt</name></projectDescription>');
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release"/><sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    const threw = gen(proj);
    check('path root-backtick (linkless): rejected with explicit message', threw.indexOf('backtick') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
  // 2. clean root + EXTERNAL USER_OBJS paths carrying ";" / "#" / backtick:
  //    rejected per object path (the old check only looked at the root)
  for (const [tag, ch] of [['semi', SEMI], ['hash', HASH], ['btick', BTICK]]) {
    const base = path.join(__dirname, '', '.scratch', 'path-r2-uo');
    const proj = path.join(base, 'proj');
    const ext = path.join(base, 'ext' + ch + 'obj');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    const objFile = path.join(ext, 'extra.o').replace(/\\/g, '/');
    fs.writeFileSync(objFile, 'placeholder');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>uo</name></projectDescription>');
    const uo = '<option id="u" name="Other objects" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.linker.otherobjs" valueType="userObjs"><listOptionValue builtIn="false" value="' + objFile + '"/></option>';
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">' + uo + '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    const threw = gen(proj);
    check('path external USER_OBJS with ' + tag + ': rejected with explicit message', threw.indexOf('cannot be carried') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
}
// ---------- 10. round-3: backtick in EXTERNAL flag paths + USER_OBJS shell metachars ----------
{
  const BTICK = String.fromCharCode(96);
  const tcStub = {
    name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
    linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
    objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size', prefix: 'riscv-wch-elf-',
  };
  const gen = (proj) => {
    let threw = '';
    try {
      generateMakefiles(Cproject.load(proj), tcStub);
    } catch (e) {
      threw = String(e.message || e);
    }
    return threw;
  };
  // 1. clean root + EXTERNAL absolute include path with a backtick: the -I
  //    argument is quoted, and sh command-substitutes backticks even inside
  //    double quotes — rejected at generation (flag-layer check)
  {
    const base = path.join(__dirname, '', '.scratch', 'path-r3-inc');
    const proj = path.join(base, 'proj');
    const inc = path.join(base, 'inc' + BTICK + 'dir');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(inc, { recursive: true });
    fs.writeFileSync(path.join(inc, 'cfg.h'), '#define V 1\n');
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), '#include "cfg.h"\nint main(void){return V-1;}\n');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>r3</name></projectDescription>');
    const incOpt = '<option id="i" name="Include paths" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.compiler.include.paths" valueType="includePath"><listOptionValue builtIn="false" value="' + inc + '"/></option>';
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">' + incOpt + '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    const threw = gen(proj);
    check('path external include with backtick: rejected at generation (flag layer)', threw.indexOf('backtick') !== -1 && threw.indexOf('Compiler/linker flags') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
  // 2. USER_OBJS entries with the other shell metachars (& ( ) ') that break
  //    the UNQUOTED $(USER_OBJS) expansion in the link recipe: rejected
  for (const [tag, ch] of [['amp', '&'], ['lparen', '('], ['rparen', ')'], ['apos', String.fromCharCode(39)]]) {
    const base = path.join(__dirname, '', '.scratch', 'path-r3-uo');
    const proj = path.join(base, 'proj');
    const ext = path.join(base, 'ext' + ch + 'obj');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    const objFile = path.join(ext, 'extra.o').replace(/\\/g, '/');
    fs.writeFileSync(objFile, 'placeholder');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>uo</name></projectDescription>');
    const uo = '<option id="u" name="Other objects" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.linker.otherobjs" valueType="userObjs"><listOptionValue builtIn="false" value="' + objFile + '"/></option>';
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">' + uo + '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    const threw = gen(proj);
    check('path external USER_OBJS with ' + tag + ': rejected with explicit message', threw.indexOf('cannot be carried') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
  // 3. and a CLEAN external USER_OBJS path still passes (no over-rejection)
  {
    const base = path.join(__dirname, '', '.scratch', 'path-r3-uo-clean');
    const proj = path.join(base, 'proj');
    const ext = path.join(base, 'extobj');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    const objFile = path.join(ext, 'extra.o').replace(/\\/g, '/');
    fs.writeFileSync(objFile, 'placeholder');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>uo</name></projectDescription>');
    const uo = '<option id="u" name="Other objects" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.linker.otherobjs" valueType="userObjs"><listOptionValue builtIn="false" value="' + objFile + '"/></option>';
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">' + uo + '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    const threw = gen(proj);
    check('path external USER_OBJS clean: generation accepted', threw === '');
    fs.rmSync(base, { recursive: true, force: true });
  }
}
// ---------- 11. round-4: backtick reaches recipes via LIBS / post-process
// options / SOURCE FILE NAMES; USER_OBJS "[" globs to a wrong object. All
// four are rejected at generation now (writeMk sweeps every generated byte;
// USER_OBJS hostile set includes "[" and "]").
{
  const BTICK = String.fromCharCode(96);
  const tcStub = {
    name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
    linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
    objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size', prefix: 'riscv-wch-elf-',
  };
  const gen = (proj) => {
    let threw = '';
    try {
      generateMakefiles(Cproject.load(proj), tcStub);
    } catch (e) {
      threw = String(e.message || e);
    }
    return threw;
  };
  const minimalProj = (extraOption, srcName) => {
    const base = path.join(__dirname, '', '.scratch', 'path-r4');
    const proj = path.join(base, 'proj');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', srcName), 'int main(void){return 0;}\n');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>r4</name></projectDescription>');
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">' + extraOption + '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    return base;
  };
  // 1. LIBS with a backtick (executes commands from $(LIBS) in the link recipe)
  {
    const libsOpt = '<option id="l" name="Libraries" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.linker.libs" valueType="libs"><listOptionValue builtIn="false" value="foo' + BTICK + 'x' + BTICK + '"/></option>';
    const base = minimalProj(libsOpt, 'main.c');
    const threw = gen(path.join(base, 'proj'));
    check('path LIBS with backtick: rejected at generation', threw.indexOf('Library name') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
  // 2. post-process option with a backtick (objcopy recipe)
  {
    const cfOpt = '<option id="cf" name="Other flags" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.createflash.other" value="--add-gnu-debuglink=' + BTICK + 'x' + BTICK + '" valueType="string"/>';
    const base = minimalProj(cfOpt, 'main.c');
    const threw = gen(path.join(base, 'proj'));
    check('path createflash.other with backtick: rejected at generation', threw.indexOf('backtick') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
  // 3. SOURCE FILE NAME with a backtick ("$<" quotes do not stop substitution)
  {
    const base = minimalProj('', 'main' + BTICK + '.c');
    const threw = gen(path.join(base, 'proj'));
    check('path source file name with backtick: rejected at generation', threw.indexOf('backtick') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
  // 4. USER_OBJS with "[" (globs to an unrelated ext1 object at link time)
  {
    const base = path.join(__dirname, '', '.scratch', 'path-r4-uo');
    const proj = path.join(base, 'proj');
    const ext = path.join(base, 'ext[12]'); // decoy ext1 would prove the glob risk; rejection precedes it
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    const objFile = path.join(ext, 'extra.o').replace(/\\/g, '/');
    fs.writeFileSync(objFile, 'placeholder');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>uo</name></projectDescription>');
    const uo = '<option id="u" name="Other objects" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.linker.otherobjs" valueType="userObjs"><listOptionValue builtIn="false" value="' + objFile + '"/></option>';
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">' + uo + '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    const threw = gen(proj);
    check('path external USER_OBJS with brackets: rejected with explicit message', threw.indexOf('cannot be carried') !== -1);
    fs.rmSync(base, { recursive: true, force: true });
  }
}
// ---------- 12. LIBS allowlist: entries are data (-l<name> words), not ----------
// command text. They expand UNQUOTED from $(LIBS) in the link recipe, so a
// name carrying ";" (or any other shell separator) executes during make.
// Strict allowlist: letters, digits and "._+-" (printf/printfloat/
// IQmath_RV32 and every conventional -l name); paths belong in the search-
// paths list. Clean names pass byte-identically.
{
  const SEMI2 = String.fromCharCode(59);
  const tcStub = {
    name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
    linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
    objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size', prefix: 'riscv-wch-elf-',
  };
  const gen = (proj) => {
    let threw = '';
    try {
      generateMakefiles(Cproject.load(proj), tcStub);
    } catch (e) {
      threw = String(e.message || e);
    }
    return threw;
  };
  const mkCase = (libName) => {
    const caseDir = path.join(__dirname, '', '.scratch', 'path-r5-libs');
    const proj = path.join(caseDir, 'proj');
    fs.rmSync(caseDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    fs.writeFileSync(path.join(proj, '.project'), '<?xml version="1.0"?><projectDescription><name>r5</name></projectDescription>');
    const lo = '<option id="l" name="Libraries" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.linker.libs" valueType="libs"><listOptionValue builtIn="false" value="' + libName + '"/></option>';
    fs.writeFileSync(path.join(proj, '.cproject'), '<?xml version="1.0"?><cproject><cconfiguration id="x" name="obj"><storageModule moduleId="cdtBuildSystem" version="4.0.0"><configuration buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="obj"><folderInfo><toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">' + lo + '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries></toolChain></folderInfo></configuration></storageModule></cconfiguration></cproject>');
    return { caseDir, proj };
  };
  // hostile: ";" would split the link command inside the recipe shell
  {
    const c = mkCase('foo' + SEMI2 + 'mkdir SENTINEL_LIBS_SEMI');
    const threw = gen(c.proj);
    check('path LIBS with semi: rejected by the library-name allowlist', threw.indexOf('Library name') !== -1 && threw.indexOf('._+-') !== -1);
    fs.rmSync(c.caseDir, { recursive: true, force: true });
  }
  // clean conventional names still pass — and the FULL allowlist set
  // (._+-) must keep working, locking the implementation contract
  {
    const c = mkCase('printf');
    const threw = gen(c.proj);
    check('path LIBS clean name: generation accepted', threw === '');
    fs.rmSync(c.caseDir, { recursive: true, force: true });
  }
  {
    const c = mkCase('foo_bar+baz-qux');
    const threw = gen(c.proj);
    check('path LIBS full allowlist set (._+-): generation accepted', threw === '');
    fs.rmSync(c.caseDir, { recursive: true, force: true });
  }
}





console.log(failures ? `\n${failures} FAILURES` : '\nall enhancement tests passed');
process.exit(failures ? 1 : 0);
