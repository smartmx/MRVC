/*
 * Bare project-root include resolution.
 *
 * MRS templates store the project root itself in the C/C++ compiler include
 * list as `"${workspace_loc:/${ProjName}}"` — no trailing segment. MRS's
 * makefile generator emits `-I"<project dir>"` for it, which is the only way
 * root-level headers (e.g. CH58x_NFCA_LIB.h sitting next to NFC_LIB.wvproj)
 * are found from sources in subdirectories.
 *
 * Regression: the generic `${workspace_loc:/…}` catch-all used to run first,
 * take the literal `${ProjName}` macro as a path segment, resolve to
 * `<root>/${ProjName}` (a path that never exists) and get dropped by
 * dropMissing — so MRVC-generated makefiles silently lost the root -I.
 */
const path = require('path');
const fs = require('fs');
const { convertLogicToFullPath } = require('../out/core/macros.js');
const { Cproject } = require('../out/core/cproject.js');
const { cCompilerOptions, cppCompilerOptions, assemblerOptions } = require('../out/core/flags.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const scratch = path.join(__dirname, '..', '.scratch', 'macros');
fs.rmSync(scratch, { recursive: true, force: true });
const proj = path.join(scratch, 'NFC_LIB');
fs.mkdirSync(path.join(proj, 'Core'), { recursive: true });

const posixLowerDrive = (p) => p.split('\\').join('/').replace(/^([A-Za-z]):/, (m) => m.toLowerCase());

// --- 1. convertLogicToFullPath: every bare/root spelling resolves to the root
for (const v of [
  '${workspace_loc:/${ProjName}}',
  '"${workspace_loc:/${ProjName}}"',
  '${workspace_loc:/${ProjName}/}',
  '${workspace_loc:/${ProjName}/.}',
  '${workspace_loc:/}',
]) {
  const r = convertLogicToFullPath(proj, 'NFC_LIB', v, new Map());
  check(`root form ${v} -> project root`, r === path.normalize(proj), `got ${r}`);
}

// subpath still resolves normally (no regression on the existing forms)
check(
  'subpath form -> <root>/Core',
  convertLogicToFullPath(proj, 'NFC_LIB', '${workspace_loc:/${ProjName}/Core}', new Map()) === path.join(proj, 'Core')
);

// --- 2. compiler flags: root -I present, missing dir dropped, relative kept
const OPT = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
const makeCproject = (suffix, values) => `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<cproject>
	<cconfiguration id="x">
		<storageModule moduleId="cdtBuildSystem">
			<configuration artifactName="\${ProjName}" name="obj">
				<folderInfo name="/">
					<toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">
						<option superClass="${OPT}${suffix}" valueType="includePath">
${values.map((v) => `							<listOptionValue builtIn="false" value="&quot;${v}&quot;"/>`).join('\n')}
						</option>
					</toolChain>
				</folderInfo>
			</configuration>
		</storageModule>
	</cconfiguration>
</cproject>`;

const C_VALUES = [
  '${workspace_loc:/${ProjName}}',
  '${workspace_loc:/${ProjName}/Core}',
  '${workspace_loc:/${ProjName}/Missing}',
  '../',
];
const cDir = path.join(scratch, 'c');
fs.mkdirSync(path.join(cDir, 'Core'), { recursive: true });
fs.writeFileSync(path.join(cDir, '.cproject'), makeCproject('c.compiler.include.paths', C_VALUES));
const cCp = Cproject.load(cDir);

const cFlags = cCompilerOptions(cCp, false, '2x');
const rootFlag = `-I"${posixLowerDrive(cDir)}"`;
const coreFlag = `-I"${posixLowerDrive(path.join(cDir, 'Core'))}"`;
check('C flags carry -I"<project root>"', cFlags.includes(rootFlag), cFlags);
check('C flags keep an existing subdir -I', cFlags.includes(coreFlag), cFlags);
check('C flags drop a missing include dir', !cFlags.includes('Missing'), cFlags);
check('C flags keep a plain relative entry', cFlags.includes('-I"../"'), cFlags);
check('root -I does not leak a literal ${ProjName}', !cFlags.includes('${ProjName}'), cFlags);

const cppDir = path.join(scratch, 'cpp');
fs.mkdirSync(cppDir, { recursive: true });
fs.writeFileSync(path.join(cppDir, '.cproject'), makeCproject('cpp.compiler.include.paths', ['${workspace_loc:/${ProjName}}']));
const cppCp = Cproject.load(cppDir);

const cppFlags = cppCompilerOptions(cppCp, false, '2x');
check('C++ flags carry -I"<project root>"', cppFlags.includes(`-I"${posixLowerDrive(cppDir)}"`), cppFlags);

// the ASM include list shares the same resolver — the bare root form must
// reach the assembler recipe as -I"<project root>" too (MRS emits -I in ASM
// rules exactly like C/C++, e.g. the FreeRTOS/HarmonyOS EVT asm rules)
const asmDir = path.join(scratch, 'asm');
fs.mkdirSync(path.join(asmDir, 'Core'), { recursive: true });
fs.writeFileSync(path.join(asmDir, '.cproject'), makeCproject('assembler.include.paths', C_VALUES));
const asmCp = Cproject.load(asmDir);

const asmFlags = assemblerOptions(asmCp, false, '2x');
check('ASM flags carry -I"<project root>"', asmFlags.includes(`-I"${posixLowerDrive(asmDir)}"`), asmFlags);
check('ASM flags keep an existing subdir -I', asmFlags.includes(`-I"${posixLowerDrive(path.join(asmDir, 'Core'))}"`), asmFlags);
check('ASM flags drop a missing include dir', !asmFlags.includes('Missing'), asmFlags);
check('ASM flags keep a plain relative entry', asmFlags.includes('-I"../"'), asmFlags);
check('ASM flags do not leak a literal ${ProjName}', !asmFlags.includes('${ProjName}'), asmFlags);

// -isystem lists share the resolver as well (no dropMissing there — MRS keeps
// every resolved entry); the bare root form must not leak the macro either
const sysDir = path.join(scratch, 'sys');
fs.mkdirSync(sysDir, { recursive: true });
fs.writeFileSync(path.join(sysDir, '.cproject'), makeCproject('c.compiler.include.systempaths', ['${workspace_loc:/${ProjName}}']));
const sysCp = Cproject.load(sysDir);

const sysFlags = cCompilerOptions(sysCp, false, '2x');
check('C -isystem carries the project root', sysFlags.includes(`-isystem"${posixLowerDrive(sysDir)}"`), sysFlags);

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nall macros assertions passed');
