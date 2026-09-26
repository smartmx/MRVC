/* Round-trip tests for config write-back and linked folders (scratch copies). */
const path = require('path');
const fs = require('fs');
const { Cproject } = require('../out/core/cproject.js');
const { addLinkedFolder, removeLinkedFolder, readProjectFile, setCppNature } = require('../out/core/projectFile.js');

const scratch = path.join(__dirname, '..', '.scratch', 'roundtrip');
// real EVT tree: prefer the local TEST copy, fall back to the F:/ layout
const LED_PROJ = ['E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'F:/CH585/EVT/V1_2/EXAM/LED'].find((r) => fs.existsSync(r));
if (!LED_PROJ) {
  console.log('SKIP: LED project not found (no real EVT tree)');
  process.exit(0);
}
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
for (const f of ['.project', '.cproject', '.template']) {
  fs.copyFileSync(path.join(LED_PROJ, f), path.join(scratch, f));
}
// a minimal source tree so makefile generation has something to scan
fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'src', 'main.c'), 'int main(void){return 0;}\n');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// --- config round trip ---
let cp = Cproject.load(scratch);
const before = cp.optimizationLevel;
cp.setOptionValue('optimization.level', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.optimization.level.most');
cp.setOptionBool('warnings.allwarn', true, true);
cp.addToListOption('c.compiler.defs', 'TEST_MACRO=1');
cp.save();

cp = Cproject.load(scratch);
check('optimization level written', cp.optionEnum('optimization.level') === 'most');
check('was not most before', before !== 'most');
check('warning -Wall written', cp.optionBool('warnings.allwarn') === true);
check('define appended', cp.listOption('c.compiler.defs').values.includes('TEST_MACRO=1'));
check('original define kept', cp.listOption('c.compiler.defs').values.includes('DEBUG=0'));
check('still valid XML', Cproject.load(scratch) !== undefined);
const raw = fs.readFileSync(path.join(scratch, '.cproject'), 'utf-8');
check('declaration preserved (leading blank lines kept as in the source)', /^\s*<\?xml/.test(raw));
check('list values quoted', raw.includes('&quot;TEST_MACRO=1&quot;'));

// --- linked folder round trip ---
const target = path.join(path.dirname(LED_PROJ), 'SRC', 'RVMSIS');
const link = addLinkedFolder(scratch, 'TestLink', target);
check('link created', !!link);
const pf = readProjectFile(scratch);
check('link parses back', pf.linkedResources.some((l) => l.name === 'TestLink' && l.location === path.normalize(target)));
check('URI uses PARENT form', pf.linkedResources.find((l) => l.name === 'TestLink').locationUri.startsWith('PARENT-'));

removeLinkedFolder(scratch, 'TestLink');
check('link removed', !readProjectFile(scratch).linkedResources.some((l) => l.name === 'TestLink'));

// --- C++ nature toggle (the "C++ project" switch behind the C++ pages) ---
setCppNature(scratch, true);
check('cpp nature added', readProjectFile(scratch).natures.includes('org.eclipse.cdt.core.cxxnature'));
check('cpp nature sits right after cnature', readProjectFile(scratch).natures.indexOf('org.eclipse.cdt.core.cxxnature') === readProjectFile(scratch).natures.indexOf('org.eclipse.cdt.core.cnature') + 1);
setCppNature(scratch, true);
check('cpp nature toggle idempotent', readProjectFile(scratch).natures.filter((n) => n === 'org.eclipse.cdt.core.cxxnature').length === 1);
setCppNature(scratch, false);
check('cpp nature removed', !readProjectFile(scratch).natures.includes('org.eclipse.cdt.core.cxxnature'));
check('.project still parses after nature toggling', !!readProjectFile(scratch).name);

// --- P1 fields round trip (canonical CDT suffixes) ---
const { generateMakefiles } = require('../out/core/makefile.js');
const tcStub = {
  name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
  linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
  objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size',
  prefix: 'riscv-wch-elf-',
};

cp = Cproject.load(scratch);
cp.setOptionValue('target.rvGcc', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.rvGcc.15');
cp.setOptionBool('c.linker.printf', true, true);
cp.setOptionBool('c.linker.printfloat', true, true);
cp.setOptionBool('c.linker.iqmath', true, true);
cp.setOptionValue('debugging.level', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.debugging.level.none');
cp.setOptionBool('target.isa.zmmul', true, true);
cp.setOptionValue('cpp.compiler.std', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.cpp.compiler.std.cpp17');
cp.save();

cp = Cproject.load(scratch);
check('rvGcc = 15', cp.rvGccVersion === '15');
check('wch printf stored', cp.optionBool('c.linker.printf'));
check('debugging level = none', cp.optionEnum('debugging.level') === 'none');
check('zmmul stored', cp.optionBool('target.isa.zmmul'));
check('cpp std = cpp17', cp.optionEnum('cpp.compiler.std') === 'cpp17');

// wch libs must flow into objects.mk; -march must gain _zmmul; debug level none drops -g
const gen = generateMakefiles(cp, tcStub);
const objectsMk = fs.readFileSync(path.join(scratch, 'obj', 'objects.mk'), 'utf-8');
const srcSubdir = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
check('objects.mk has -lprintf', objectsMk.includes('-lprintf '));
check('objects.mk has -lprintfloat', objectsMk.includes('-lprintfloat'));
check('objects.mk has -lIQmath_RV32', objectsMk.includes('-lIQmath_RV32'));
check('user lib ISP585 kept', objectsMk.includes('-lISP585'));
check('-march gains _zmmul', srcSubdir.includes('_zba_zbb_zbc_zbs_zmmul_xw'));
check('debug level none removes -g', !srcSubdir.includes(' -g '));

// --- tune/align stored as full CDT enums (other-chip projects) ---
const TUNE_PREFIX = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.tune.';
cp = Cproject.load(scratch);
cp.setOptionValue('target.tune', TUNE_PREFIX + 'default');
cp.save();
cp = Cproject.load(scratch);
let srcMk = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
check('tune enum default -> no -mtune at all', !srcMk.includes('-mtune='));

cp = Cproject.load(scratch);
cp.setOptionValue('target.tune', TUNE_PREFIX + 'rv32imac');
cp.save();
cp = Cproject.load(scratch);
generateMakefiles(cp, tcStub);
srcMk = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
check('tune enum rv32imac -> -mtune=rv32imac', srcMk.includes('-mtune=rv32imac'));

cp = Cproject.load(scratch);
cp.setOptionValue('target.align', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.align.strict');
cp.save();
cp = Cproject.load(scratch);
generateMakefiles(cp, tcStub);
srcMk = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
check('align enum strict -> -mstrict-align', srcMk.includes('-mstrict-align'));

// --- Build Steps / Build Artifact (builder attrs + config attrs + makefile) ---
// kept last: it flips artifactType, which changes what the earlier makefile
// assertions below/above expect from the same scratch project
const { generateMakefiles: genMakefiles2 } = require('../out/core/makefile.js');
const tcStub2 = {
  name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
  linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
  objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size',
  prefix: 'riscv-wch-elf-',
};
cp = Cproject.load(scratch);
check('default artifact extension is elf', cp.artifactExtension === 'elf');
check('default prebuild is empty', cp.prebuildStep === '');
cp.setBuildIdentity({ prebuildStep: 'echo hello', prebuildAnnounce: 'pre note', postbuildStep: 'python post.py', artifactExtension: 'axf', outputPrefix: 'out_' });
cp.save();
const rawBuild = fs.readFileSync(path.join(scratch, '.cproject'), 'utf8');
check('announce property uses the CDT name preannouncebuildStep', rawBuild.includes('preannouncebuildStep="pre note"'));
check('outputPrefix lives on the linker tool, not the configuration', /<tool [^>]*tool\.c\.linker[^>]*outputPrefix="out_"/.test(rawBuild) && !/<configuration[^>]*outputPrefix=/.test(rawBuild));
cp = Cproject.load(scratch);
check('outputPrefix read back from the linker tool', cp.outputPrefix === 'out_');
check('prebuild survives reload', cp.prebuildStep === 'echo hello');
check('artifactExtension survives reload', cp.artifactExtension === 'axf');
genMakefiles2(cp, tcStub2);
let mk = fs.readFileSync(path.join(scratch, 'obj', 'makefile'), 'utf8');
check('makefile runs pre-build command', mk.includes('-echo hello'));
check('makefile runs post-build command', mk.includes('-python post.py'));
check('makefile honours output prefix + custom extension', mk.includes('out_LED.axf') && !mk.includes('LED.elf'));
cp.setBuildIdentity({ artifactType: 'staticLib' });
cp.save();
const rawLib = fs.readFileSync(path.join(scratch, '.cproject'), 'utf8');
check('buildArtefactType standalone attribute synced', /buildArtefactType="org\.eclipse\.cdt\.build\.core\.buildArtefactType\.staticLibrary"/.test(rawLib));
cp = Cproject.load(scratch);
check('artifactType staticLib survives reload', cp.artifactType === 'staticLib');
genMakefiles2(cp, tcStub2);
mk = fs.readFileSync(path.join(scratch, 'obj', 'makefile'), 'utf8');
check('makefile switches to static-lib rule', mk.includes('out_LED.a: $(OBJS)'));

console.log(failures ? `\n${failures} FAILURES` : '\nall round-trip checks passed');
process.exit(failures ? 1 : 0);
