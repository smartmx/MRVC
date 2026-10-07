/*
 * CMakeLists generator tests: run the REAL LED project through the
 * generator (writing to a scratch output file, never touching the project)
 * and verify the MRS2-shaped output — manual header, toolchain set() block,
 * relative sources (linked folders as <linkName>/...), flags from the
 * makefile option model, executable target + POST_BUILD objcopy/size.
 */
const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, '..', '.scratch', 'cmake-ws');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const { Cproject } = require('../out/core/cproject.js');
const { locateInstall, selectToolchain } = require('../out/core/toolchain.js');
const { buildCMakeContent } = require('../out/core/cmake.js');

// real EVT tree: dev TEST copy, F:/ layout, or the local E:/WORK tree
const PROJ = ['F:/CH585/EVT/V1_2/EXAM/LED', 'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find(
  (p) => fs.existsSync(path.join(p, '.cproject'))
);
if (!PROJ) {
  console.log('SKIP  cmake-test (no real LED tree found)');
  process.exit(0);
}
const cp = Cproject.load(PROJ);
const MRS2_ROOT =
  process.env.MRS2_HOME ||
  ['C:/MounRiver/MounRiver_Studio2', 'D:/MounRiver/MounRiver_Studio2'].find((r) =>
    fs.existsSync(path.join(r, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'manifest.json'))
  );
const tc = selectToolchain(locateInstall(MRS2_ROOT), 'auto', cp.rvGccVersion, cp.storedPrefix);
check('toolchain resolved', !!tc && !!tc.compilerC);

const file = path.join(WS, 'CMakeLists.txt');
const built = buildCMakeContent(cp, tc, file);
const raw = fs.readFileSync(file, 'utf-8');

check('25 sources (2 root + 1 Startup + 22 StdPeriph) and 2 include dirs', built.sourceCount === 25 && built.includeCount === 2);
check('in-place: linked sources as ../SRC/... climb-out paths', raw.includes('"../SRC/Startup/startup_CH585.S"') && raw.includes('"../SRC/StdPeriphDriver/CH58x_adc.c"'));
check('in-place: includes as ../SRC/... paths', raw.includes('"../SRC/StdPeriphDriver/inc"') && raw.includes('"../SRC/RVMSIS"'));
check('CRLF endings', raw.includes('\r\n'));
check('bilingual manual present', raw.includes('[Chinese Manual]') && raw.includes('[English Manual]') && raw.includes('cmake -B build -G "Unix Makefiles"'));
check('cmake minimum 3.16 + Generic system + static-lib guard', raw.includes('cmake_minimum_required(VERSION 3.16)') && raw.includes('set(CMAKE_SYSTEM_NAME Generic)') && raw.includes('set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)'));

check('toolchain folder is absolute posix', raw.includes(`set(TOOLCHAIN_FOLDER "${tc.dir.replace(/\\/g, '/')}"`));
check('toolchain prefix from tc', raw.includes(`set(TOOLCHAIN_PREFIX "${tc.prefix}"`));
check('compilers under ${TOOLCHAIN_FOLDER}/bin with .exe suffix', (raw.match(/\$\{TOOLCHAIN_FOLDER\}\/bin\//g) || []).length >= 7 && raw.includes('riscv-wch-elf-gcc.exe'));
check('bin tools carry the tc prefix (riscv-wch-elf-objcopy)', raw.includes('${TOOLCHAIN_FOLDER}/bin/${prefix}'.replace('${prefix}', 'riscv-wch-elf-objcopy')) || raw.includes('riscv-wch-elf-objcopy'));
check('compiler works skips', (raw.match(/COMPILER_WORKS TRUE/g) || []).length === 3);

check('project name from .project display name', raw.includes('set(PROJECT_NAME "LED")'));
check('target artifact from targetName', new RegExp(`set\\(TARGET_ARTIFACT "${cp.targetName}"\\)`).test(raw));
check('project() declares C ASM CXX', raw.includes('project("${PROJECT_NAME}" LANGUAGES C ASM CXX)'));
check('macro-prefix-map relative path line', raw.includes('add_compile_options(-fmacro-prefix-map=${CMAKE_SOURCE_DIR}=..)'));

check('sources are quoted relative posix paths', raw.includes('set(SRC_FILES \r\n"'));
check('startup .S as in-place climb-out path', raw.includes('"../SRC/Startup/startup_CH585.S"'));
check('StdPeriphDriver sources as climb-out paths', raw.includes('"../SRC/StdPeriphDriver/CH58x_adc.c"'));
check('root sources keep their relative path', raw.includes('"src/Main.c"'));
check('no absolute paths in SRC_FILES', !/"[A-Za-z]:[\\/]/.test(raw.slice(raw.indexOf('SRC_FILES'), raw.indexOf('CMAKE_C_FLAGS'))));

check('include_directories block exists', /include_directories\(/.test(raw));
check('per-language flags set', /set\(CMAKE_C_FLAGS "/.test(raw) && /set\(CMAKE_ASM_FLAGS "/.test(raw));
check('c flags carry the ISA march', /set\(CMAKE_C_FLAGS "[^"]*-march=/.test(raw));
check('executable target + LINK_FLAGS with linker script', raw.includes('add_executable("${TARGET_ARTIFACT}" ${SRC_FILES})') && /LINK_FLAGS "[^"]*-T /.test(raw));
check('target_link_libraries present', /target_link_libraries\(/.test(raw));

check('POST_BUILD block exists', raw.includes('add_custom_command(TARGET "${TARGET_ARTIFACT}" \r\nPOST_BUILD'));
check('hex generation via quoted prefixed objcopy', /COMMAND "\$\{CMAKE_OBJCOPY\}" ARGS -O ihex/.test(raw));
check('objcopy section flags carried', /-O ihex( ?-j \.\w+)* "\$<TARGET_FILE:\$\{TARGET_ARTIFACT\}>" "\$\{TARGET_ARTIFACT\}\.hex"/.test(raw));
check('size command gated by printSize option', raw.includes('COMMAND "${CMAKE_SIZE}"') === cp.printSize);

// idempotent regeneration (same content)
const first = fs.readFileSync(file, 'utf-8');
buildCMakeContent(cp, tc, file);
check('regeneration is deterministic', fs.readFileSync(file, 'utf-8') === first);

// ---- export helpers (vscode layer, pure functions) ----
{
  const Module = require('module');
  const stubPath = require.resolve('./vscode-stub.js');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain) {
    if (request === 'vscode') return stubPath;
    return origResolve.call(this, request, parent, isMain);
  };
  const { copyTree, isSafeLinkName, copyLinkedFolders } = require('../out/vscode/cmakeExport.js');

  // link-name guard: separators / Windows-illegal chars / dot-names refused
  check('linkname: plain name ok', isSafeLinkName('SRC') && isSafeLinkName('我的库') && isSafeLinkName('lib v2'));
  check('linkname: traversal refused', !isSafeLinkName('..') && !isSafeLinkName('.') && !isSafeLinkName('..\\evil') && !isSafeLinkName('a/b'));
  check('linkname: windows-illegal refused', !isSafeLinkName('a:b') && !isSafeLinkName('a*b') && !isSafeLinkName('a?b') && !isSafeLinkName('a"b'));
  // trailing dots/spaces are stripped by Windows on create ("Lib." and "Lib"
  // would merge into one directory); DOS device names make mkdir fail and
  // abort the whole export
  check('linkname: trailing dot/space refused', !isSafeLinkName('Lib.') && !isSafeLinkName('Lib '));
  check('linkname: DOS reserved device names refused', !isSafeLinkName('CON') && !isSafeLinkName('nul') && !isSafeLinkName('Com1') && !isSafeLinkName('LPT4'));
  check('linkname: reserved as substring still fine', isSafeLinkName('console') && isSafeLinkName('my lib') && isSafeLinkName('Library.v2'));

  // export target INSIDE the project must not copy itself into the export
  const xw = path.join(WS, 'export-self');
  fs.rmSync(xw, { recursive: true, force: true });
  const projSrc = path.join(xw, 'proj');
  fs.mkdirSync(path.join(projSrc, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(projSrc, 'Main.c'), 'int main(void){return 0;}\n');
  fs.writeFileSync(path.join(projSrc, 'sub', 'Extra.c'), '// x\n');
  // simulate the export dir already existing inside the project (it does:
  // the command rm+mkdirs it before copyTree runs)
  const dst = path.join(projSrc, 'proj_cmake');
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, 'CMakeLists.txt'), '# portable\n');
  copyTree(projSrc, dst, path.resolve(dst));
  check('export-in-project: no nested self copy', !fs.existsSync(path.join(dst, 'proj_cmake')));
  check('export-in-project: project files copied', fs.existsSync(path.join(dst, 'Main.c')) && fs.existsSync(path.join(dst, 'sub', 'Extra.c')));
  // regular out-of-project export unaffected (no skipDir passed)
  const plain = path.join(xw, 'plain');
  copyTree(projSrc, plain);
  check('plain export still recursive', fs.existsSync(path.join(plain, 'Main.c')) && fs.existsSync(path.join(plain, 'sub', 'Extra.c')));

  // export dir INSIDE a LINKED-FOLDER target must not nest either (the
  // link-target copy is the third copyTree call — EVT's biggest tree, and
  // a shared scratch dir is exactly where users point the export)
  const libDir = path.join(xw, 'LIB');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'a.c'), '// a\n');
  const dst2 = path.join(libDir, 'proj_cmake');
  fs.mkdirSync(dst2, { recursive: true });
  copyLinkedFolders(new Map([['LIB', libDir]]), dst2);
  check('export-in-link: no nested self copy', !fs.existsSync(path.join(dst2, 'LIB', 'proj_cmake')));
  check('export-in-link: target copied under link name', fs.existsSync(path.join(dst2, 'LIB', 'a.c')));
  // unsafe link names still skipped, missing targets tolerated
  copyLinkedFolders(
    new Map([
      ['..\\evil', libDir],
      ['gone', path.join(xw, 'missing')],
    ]),
    dst2
  );
  check('export-in-link: unsafe names + missing targets skipped', fs.existsSync(path.join(dst2, 'LIB', 'a.c')) && !fs.existsSync(path.join(dst2, 'evil')) && !fs.existsSync(path.join(dst2, 'gone')));
  fs.rmSync(xw, { recursive: true, force: true });
}

// ---- forced includes (-include), system paths and assembler includes ----
// previously the generator harvested only bare -I from C/C++ (skipIncludes
// removes ALL include forms from the flag strings) and dropped assembler
// includes entirely — CMake builds lost those paths
{
  const projInc = path.join(WS, 'proj-inc');
  fs.cpSync(PROJ, projInc, { recursive: true });
  fs.mkdirSync(path.join(projInc, 'sysinc'), { recursive: true });
  fs.mkdirSync(path.join(projInc, 'asminc'), { recursive: true });
  fs.writeFileSync(path.join(projInc, 'sysinc', 'force.h'), '#pragma once\n');
  const cpInc = Cproject.load(projInc);
  cpInc.addToListOption('c.compiler.include.systempaths', path.join(projInc, 'sysinc'));
  cpInc.addToListOption('c.compiler.include.files', path.join(projInc, 'sysinc', 'force.h'));
  cpInc.addToListOption('assembler.include.paths', path.join(projInc, 'asminc'));
  cpInc.save();
  const cpIncR = Cproject.load(projInc);
  const fileInc = path.join(WS, 'CMakeLists-inc.txt');
  const builtInc = buildCMakeContent(cpIncR, tc, fileInc);
  const rawInc = fs.readFileSync(fileInc, 'utf-8');
  const incBlock = (rawInc.match(/include_directories\([\s\S]*?\)\r\n/) || [''])[0];
  check('systempaths reach include_directories', incBlock.includes('"sysinc"'));
  check('assembler include paths reach include_directories', incBlock.includes('"asminc"'));
  check('forced -include file stays in CMAKE_C_FLAGS', /set\(CMAKE_C_FLAGS "[\s\S]*?-include\\"sysinc\/force\.h\\"/.test(rawInc));
  check('include count reflects the harvest', builtInc.includeCount >= 2);
  fs.rmSync(projInc, { recursive: true, force: true });
}

// ---- static-library project exports as add_library (MRS2 lib branch) ----
// previously isExecutable was hardcoded true: a lib's sources hit the
// executable link path and failed on undefined `main`
{
  const projLib = path.join(WS, 'proj-lib');
  fs.cpSync(PROJ, projLib, { recursive: true });
  const cpLib = Cproject.load(projLib);
  cpLib.setBuildIdentity({ artifactType: 'staticLib', artifactExtension: 'a' });
  cpLib.save();
  const cpLibR = Cproject.load(projLib);
  const fileLib = path.join(WS, 'CMakeLists-lib.txt');
  const builtLib = buildCMakeContent(cpLibR, tc, fileLib);
  const rawLib = fs.readFileSync(fileLib, 'utf-8');
  check('static lib: add_library emitted, no add_executable', rawLib.includes('add_library("${TARGET_ARTIFACT}" ${SRC_FILES})') && !rawLib.includes('add_executable'));
  check('static lib: archive rules via CMAKE_AR', rawLib.includes('CMAKE_C_ARCHIVE_CREATE "<CMAKE_AR> crs') && rawLib.includes('CMAKE_ASM_ARCHIVE_CREATE'));
  check('static lib: no link flags / post-build steps', !rawLib.includes('LINK_FLAGS "') && !rawLib.includes('add_custom_command'));
  check('static lib: result reports library', builtLib.isExecutable === false);
  fs.rmSync(projLib, { recursive: true, force: true });
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall cmake tests passed');
process.exit(failures ? 1 : 0);
