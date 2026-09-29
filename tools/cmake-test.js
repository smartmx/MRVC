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

const PROJ = 'F:/CH585/EVT/V1_2/EXAM/LED';
const cp = Cproject.load(PROJ);
const tc = selectToolchain(locateInstall(), 'auto', cp.rvGccVersion, cp.storedPrefix);
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

fs.rmSync(WS, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall cmake tests passed');
process.exit(failures ? 1 : 0);
