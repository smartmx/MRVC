/*
 * Static-library projects (MRS artefactType `staticLib`).
 *
 * MRS templates create library projects with
 *   buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.staticLib"
 * and MRS's makefile generator archives the objects:
 *   libX.a: $(OBJS) …
 *       riscv-wch-elf-ar -r "libX.a" $(OBJS)
 *
 * Regression: the detector looked for `buildArtefactType.staticLibrary`, a
 * spelling MRS never writes — every MRS library project was classified as an
 * executable, the generator emitted a LINK recipe with -T Ld/Link.ld and the
 * build died ("cannot open linker script file …/Ld/Link.ld: Invalid
 * argument" — the folder does not exist in library projects).
 */
const path = require('path');
const fs = require('fs');
const { Cproject } = require('../out/core/cproject.js');
const { generateMakefiles } = require('../out/core/makefile.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const scratch = path.join(__dirname, '..', '.scratch', 'staticlib');
fs.rmSync(scratch, { recursive: true, force: true });

const OPT = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
const makeCproject = (kind) => `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<cproject>
	<cconfiguration id="x">
		<storageModule moduleId="cdtBuildSystem">
			<configuration artifactName="LIBPROJ" artifactExtension="a" buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.${kind}" buildProperties="org.eclipse.cdt.build.core.buildArtefactType=org.eclipse.cdt.build.core.buildArtefactType.${kind},org.eclipse.cdt.build.core.buildType=org.eclipse.cdt.build.core.buildType.release" name="obj">
				<folderInfo name="/">
					<toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">
						<option superClass="${OPT}target.isa.base" value="${OPT}target.arch.rv32i" valueType="enumerated"/>
						<option superClass="${OPT}target.abi.integer" value="${OPT}abi.integer.ilp32" valueType="enumerated"/>
					</toolChain>
				</folderInfo>
			</configuration>
		</storageModule>
	</cconfiguration>
</cproject>`;

const TC = {
  name: 'GCC12',
  dir: '',
  compilerC: 'riscv-wch-elf-gcc',
  compilerCpp: 'riscv-wch-elf-g++',
  linkerC: 'riscv-wch-elf-gcc',
  linkerCpp: 'riscv-wch-elf-g++',
  debugger: 'riscv-wch-elf-gdb',
  objcopy: 'riscv-wch-elf-objcopy',
  objdump: 'riscv-wch-elf-objdump',
  size: 'riscv-wch-elf-size',
  prefix: 'riscv-wch-elf-',
};

const makeProject = (name) => `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
	<name>${name}</name>
	<comment></comment>
	<projects></projects>
	<buildSpec></buildSpec>
	<natures></natures>
	<linkedResources></linkedResources>
</projectDescription>`;

// --- 1. MRS's spelling is detected as a library
const proj = path.join(scratch, 'LIBPROJ');
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, '.project'), makeProject('LIBPROJ'));
fs.writeFileSync(path.join(proj, '.cproject'), makeCproject('staticLib'));
fs.writeFileSync(path.join(proj, 'main.c'), 'int x;\n');
const cp = Cproject.load(proj);
check('artifactType: MRS staticLib -> library', cp.artifactType === 'staticLib', cp.artifactType);
check('artifactExtension: a', cp.artifactExtension === 'a', cp.artifactExtension);

// --- 2. the makefile archives with ar, never links with -T
generateMakefiles(cp, TC);
const mk = fs.readFileSync(path.join(proj, 'obj', 'makefile'), 'utf8');
check('library makefile: archive rule uses ar', mk.includes(`${TC.prefix}ar -cr "LIBPROJ.a"`), mk.split('\n').find((l) => l.includes('ar -cr')) ?? '(no ar rule)');
check('library makefile: no linker -T recipe', !mk.includes(' -T "'), mk.split('\n').find((l) => l.includes(' -T "')) ?? '');
check('library makefile: main-build targets the .a', mk.includes('main-build: LIBPROJ.a'), mk.split('\n').find((l) => l.startsWith('main-build:')) ?? '');

// --- 3. setBuildIdentity writes CDT's id (staticLib), not staticLibrary
cp.setBuildIdentity({ artifactType: 'staticLib', artifactExtension: 'a', artifactName: 'LIBPROJ' });
cp.save();
const raw = fs.readFileSync(path.join(proj, '.cproject'), 'utf8');
check('written id is staticLib', raw.includes('buildArtefactType.staticLib') && !raw.includes('staticLibrary'), '');
const cp2 = Cproject.load(proj);
check('roundtrip still a library', cp2.artifactType === 'staticLib', cp2.artifactType);

// --- 4. legacy `staticLibrary` spelling (older tools) is still recognized
const legacy = path.join(scratch, 'LEGACY');
fs.mkdirSync(legacy, { recursive: true });
fs.writeFileSync(path.join(legacy, '.cproject'), makeCproject('staticLibrary'));
const cpLegacy = Cproject.load(legacy);
check('artifactType: legacy staticLibrary -> library', cpLegacy.artifactType === 'staticLib', cpLegacy.artifactType);

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nall static-library assertions passed');
