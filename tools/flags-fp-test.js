/*
 * Floating-point option key split (MRS2 semantics, verified against the
 * MRS2 builder source in extensions/mrs-team.mrs-vscode):
 *   -march F suffix <- `target.isa.fp`  ("Floating point"): f / fd / fdq
 *   -mabi suffix    <- `target.abi.fp`  ("Floating point ABI"): f / d
 * The two keys are independent options; shipped EVT trees always carry the
 * same value in both, which is why byte-goldens never caught the split.
 */
const path = require('path');
const fs = require('fs');
const { Cproject } = require('../out/core/cproject.js');
const { commonOptions, cCompilerOptions, cppCompilerOptions, cLinkerOptions, cppLinkerOptions } = require('../out/core/flags.js');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const scratch = path.join(__dirname, '..', '.scratch', 'flags-fp');
fs.rmSync(scratch, { recursive: true, force: true });

const OPT = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
const makeCproject = (isaFp, abiFp) => `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<cproject>
	<cconfiguration id="x">
		<storageModule moduleId="cdtBuildSystem">
			<configuration artifactName="\${ProjName}" name="obj">
				<folderInfo name="/">
					<toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">
						<option superClass="${OPT}target.isa.base" value="${OPT}target.arch.rv32i" valueType="enumerated"/>
						<option superClass="${OPT}target.abi.integer" value="${OPT}abi.integer.ilp32" valueType="enumerated"/>
						<option superClass="${OPT}target.isa.multiply" value="true" valueType="boolean"/>
						<option superClass="${OPT}target.isa.atomic" value="true" valueType="boolean"/>
						<option superClass="${OPT}target.isa.compressed" value="true" valueType="boolean"/>
						${isaFp === null ? '' : `<option superClass="${OPT}target.isa.fp" value="${OPT}isa.fp.${isaFp}" valueType="enumerated"/>`}
						${abiFp === null ? '' : `<option superClass="${OPT}target.abi.fp" value="${OPT}abi.fp.${abiFp}" valueType="enumerated"/>`}
					</toolChain>
				</folderInfo>
			</configuration>
		</storageModule>
	</cconfiguration>
</cproject>`;

const flagsFor = (isaFp, abiFp) => {
  const dir = path.join(scratch, `${isaFp ?? 'absent'}-${abiFp ?? 'absent'}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.cproject'), makeCproject(isaFp, abiFp));
  const cp = Cproject.load(dir);
  const t = commonOptions(cp, 'GCC12');
  const march = t.match(/-march=\S+/)?.[0] ?? '(missing)';
  const mabi = t.match(/-mabi=\S+/)?.[0] ?? '(missing)';
  return { march, mabi };
};

// 1. shipped-tree shape: both keys agree (or absent) — must match the
//    byte-goldens, i.e. the split changes nothing here
check('both absent -> no F/D anywhere', (() => {
  const { march, mabi } = flagsFor(null, null);
  return march === '-march=rv32imac' && mabi === '-mabi=ilp32';
})());
check('isa=single abi=single (FPU EVT shape) -> imafc / ilp32f', (() => {
  const { march, mabi } = flagsFor('single', 'single');
  return march === '-march=rv32imafc' && mabi === '-mabi=ilp32f';
})());

// 2. the keys DISAGREE — each flag follows its own option (MRS2 semantics)
check('isa=single abi=none -> march has f, mabi bare', (() => {
  const { march, mabi } = flagsFor('single', 'none');
  return march === '-march=rv32imafc' && mabi === '-mabi=ilp32';
})());
check('isa=none abi=single -> march bare, mabi has f', (() => {
  const { march, mabi } = flagsFor('none', 'single');
  return march === '-march=rv32imac' && mabi === '-mabi=ilp32f';
})());
check('isa=double abi=double -> fd / d (NOT ilp32fd)', (() => {
  const { march, mabi } = flagsFor('double', 'double');
  return march === '-march=rv32imafdc' && mabi === '-mabi=ilp32d';
})());
check('isa=double abi=none -> fd in march only', (() => {
  const { march, mabi } = flagsFor('double', 'none');
  return march === '-march=rv32imafdc' && mabi === '-mabi=ilp32';
})());

// 3. the real CH32V307 FPU EVT example (isa.fp=single, abi.fp=single)
const FPU_PROJ = ['E:/Projects/MRS_VSCODE/TEST/CH32V307EVT/EXAM/FPU/FPU', 'E:/WORK/CH32V307/V3_1/FPU/FPU'].find((p) =>
  fs.existsSync(path.join(p, '.cproject'))
);
if (FPU_PROJ) {
  const cp = Cproject.load(FPU_PROJ);
  check('real FPU project: isa.fp reads single', cp.optionEnum('target.isa.fp') === 'single');
  check('real FPU project: abi.fp reads single', cp.optionEnum('target.abi.fp') === 'single');
  const t = commonOptions(cp, 'GCC12');
  // the project also enables XW (GCC12 underscore form) — F suffix + ilp32f
  // are what this test pins down
  check('real FPU project: -march carries f (rv32imafc_xw)', /-march=rv32imafc_xw /.test(t));
  check('real FPU project: -mabi=ilp32f', /-mabi=ilp32f /.test(t));
} else {
  console.log('SKIP  real CH32V307 FPU project (tree not present)');
}

// 5. macro resolution parity in the "other" fields: ${ProjName} must be
//    resolved exactly like the C++ twin's field (it used to reach the
//    makefile raw and make swallowed it as an undefined variable)
{
  const dir = path.join(scratch, 'macros');
  fs.mkdirSync(dir, { recursive: true });
  const injection = '<option superClass="' + OPT + 'c.compiler.otheroptimizations" value="${ProjName}" valueType="string"/>';
  const xml = makeCproject(null, null).replace('</toolChain>', injection + '\n\t\t\t\t\t</toolChain>');
  fs.writeFileSync(path.join(dir, '.cproject'), xml);
  const cp = Cproject.load(dir);
  const { cCompilerOptions } = require('../out/core/flags.js');
  const opts = cCompilerOptions(cp);
  check('c.otheroptimizations: ${ProjName} resolved, not raw', !opts.includes('${ProjName}') && opts.includes(cp.projectName));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6. linker model: picolibc replaces nano/float; C model defaults (round37)
{
  const optXml = (suffix, value, type = 'boolean') => `<option superClass="${OPT}${suffix}" value="${value}" valueType="${type}"/>`;
  const linkerCp = (name, options) => {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.cproject'),
      makeCproject(null, null).replace('</toolChain>', options.join('\n') + '\n\t\t\t\t\t</toolChain>')
    );
    return Cproject.load(dir);
  };
  const bare = linkerCp('linker-bare', []);
  const tcFlags = cLinkerOptions(bare);
  const tcppFlags = cppLinkerOptions(bare);
  check(
    'linker defaults: C model enables start/gc/nano/nosys when absent',
    ['-nostartfiles', '-Xlinker --gc-sections', '--specs=nano.specs', '--specs=nosys.specs'].every((s) => tcFlags.includes(s))
  );
  check(
    'linker defaults: C++ model keeps them off when absent',
    !['-nostartfiles', '-Xlinker --gc-sections', '--specs=nano.specs', '--specs=nosys.specs'].some((s) => tcppFlags.includes(s))
  );

  const picl = linkerCp('linker-picolibc', [
    optXml('c.linker.picolibc', `${OPT}c.linker.picolibc.double`, 'enumerated'),
    optXml('c.linker.usenewlibnano', 'true'),
    optXml('c.linker.useprintffloat', 'true'),
    optXml('c.linker.usescanffloat', 'true'),
  ]);
  const pf = cLinkerOptions(picl);
  check(
    'picolibc double: full-printf defsyms + specs',
    pf.includes('vfprintf=__d_vfprintf') && pf.includes('vfscanf=__d_vfscanf') && pf.includes('--specs=picolibc.specs')
  );
  check(
    'picolibc double: nano/float switches suppressed',
    !pf.includes('--specs=nano.specs') && !pf.includes('-u _printf_float') && !pf.includes('-u _scanf_float')
  );
  check('picolibc double: nosys still applies (C default)', pf.includes('--specs=nosys.specs'));
  // round38 P2: picolibc.specs also switches the compiler's -isystem set
  const pCompile = cCompilerOptions(picl);
  check('picolibc compile: --specs=picolibc.specs reaches the C compiler', pCompile.includes('--specs=picolibc.specs'));
  check(
    'picolibc compile: link-only flags stay out of the compile line',
    !pCompile.includes('--specs=nano.specs') && !pCompile.includes('vfprintf')
  );
  check('non-picolibc compile: no picolibc specs (goldens unchanged)', !cCompilerOptions(bare).includes('picolibc.specs'));

  for (const [v, prefix] of [['integer', 'i'], ['minimal', 'm']]) {
    const cp2 = linkerCp('linker-picolibc-' + v, [optXml('c.linker.picolibc', `${OPT}c.linker.picolibc.${v}`, 'enumerated')]);
    const f2 = cLinkerOptions(cp2);
    check(
      `picolibc ${v}: __${prefix}_vfprintf selected`,
      f2.includes(`vfprintf=__${prefix}_vfprintf`) && f2.includes(`vfscanf=__${prefix}_vfscanf`)
    );
  }

  const cppPicl = linkerCp('linker-cpp-picolibc', [
    optXml('cpp.linker.picolibc', `${OPT}cpp.linker.picolibc.integer`, 'enumerated'),
    optXml('cpp.linker.usenewlibnano', 'true'),
  ]);
  const cpf = cppLinkerOptions(cppPicl);
  check('picolibc cpp: own option drives __i_ and suppresses nano', cpf.includes('vfprintf=__i_vfprintf') && !cpf.includes('--specs=nano.specs'));
  check('picolibc cpp compile: --specs=picolibc.specs reaches g++', cppCompilerOptions(cppPicl).includes('--specs=picolibc.specs'));
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall flags fp-split tests passed');
process.exit(failures ? 1 : 0);
