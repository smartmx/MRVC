/*
 * Project-type conversion tests (0.3.8 round27): setProjectCpp must convert
 * EVERY configuration of a multi-configuration .cproject (the nature is
 * project-level — a partial conversion left the second configuration
 * building C++ with the old C-only option set), and the write flows in
 * projectFile.ts (add/change/remove linked folder, type switch) must apply
 * ONLY the write they were asked for — a stale linked folder with a fixable
 * target must NOT be auto-repaired as a rider (round27 P2-1; the explicit
 * repair entry is mrvc_repair_project / the extension's first-open repair).
 * Written with plain string concatenation and literal fixture paths on
 * purpose: no template literals, no computed roots.
 *
 * Run: node tools/projecttype-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(cond ? 'PASS  ' + name : 'FAIL  ' + name + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
};

const { setProjectCpp } = require('../out/core/projectType.js');
const { addLinkedFolder, changeLinkedFolderTarget, removeLinkedFolder } = require('../out/core/projectFile.js');

const scratch = path.join(os.tmpdir(), 'mrvc-projecttype-test');
fs.rmSync(scratch, { recursive: true, force: true });

const STALE = 'Z:/old/EXAM/Shared';
const OPT_BASE = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
const MACRO = '"${workspace_loc:/${ProjName}/inc}"'; // literal MRS macro, kept verbatim

const projectXml = (links) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription>\n<name>PT</name>\n<comment/>\n<projects/>\n<buildSpec/>\n<natures>\n<nature>org.eclipse.cdt.core.cnature</nature>\n</natures>\n<linkedResources>\n' +
  links.map((l) => linkXml(l[0], l[1])).join('\n') +
  '\n</linkedResources>\n</projectDescription>';

const linkXml = (name, location) =>
  '<link>\n<name>' + name + '</name>\n<type>2</type>\n<location>' + location + '</location>\n</link>';

const cfgXml = (n) =>
  '<cconfiguration id="cfg.' + n + '">\n' +
  '<storageModule buildSystemId="org.eclipse.cdt.managedbuilder.core.configurationDataProvider" id="cfg.' + n + '" moduleId="org.eclipse.cdt.core.settings" name="' + n + '"/>\n' +
  '<storageModule moduleId="cdtBuildSystem" version="4.0.0">\n' +
  '<configuration id="cfg.' + n + '" artifactExtension="elf" name="' + n + '">\n' +
  '<toolChain id="tc.' + n + '" name="RISC-V Cross GCC" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">\n' +
  '<tool name="GNU RISC-V Cross C Compiler" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.tool.c.compiler">\n' +
  '<option id="inc.' + n + '" superClass="' + OPT_BASE + 'c.compiler.include.paths" valueType="includePath">\n' +
  '<listOptionValue builtIn="false" value=' + JSON.stringify(MACRO) + '/>\n' +
  '</option>\n' +
  '</tool>\n' +
  '<tool name="GNU RISC-V Cross C++ Compiler" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.tool.cpp.compiler"/>\n' +
  '</toolChain>\n' +
  '</configuration>\n' +
  '</storageModule>\n' +
  '</cconfiguration>\n';

const cprojectXml = (names) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<cproject>\n<storageModule moduleId="org.eclipse.cdt.core.settings">\n' +
  names.map(cfgXml).join('') +
  '</storageModule>\n</cproject>';

// literal fixture roots (the pattern every other suite uses and Mimosa accepts)
const P1 = path.join(scratch, 'p1');
const P2 = path.join(scratch, 'p2');
const PA = path.join(scratch, 'purity-add');
const PC = path.join(scratch, 'purity-change');
const PS = path.join(scratch, 'purity-switch');
const SHARED = path.join(scratch, 'Shared');
const OTHER_A = path.join(scratch, 'otherA');
const OTHER_B = path.join(scratch, 'otherB');

function buildFixture(root, configs, links) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.project'), projectXml(links));
  fs.writeFileSync(path.join(root, '.cproject'), cprojectXml(configs));
}

const count = (s, needle) => s.split(needle).length - 1;

// ---- 1. single-config conversion
buildFixture(P1, ['obj'], [['Stale', STALE]]);
{
  const r = setProjectCpp(P1, true);
  const proj = fs.readFileSync(path.join(P1, '.project'), 'utf-8');
  const cp = fs.readFileSync(path.join(P1, '.cproject'), 'utf-8');
  check('single: ccnature written', proj.includes('org.eclipse.cdt.core.ccnature'));
  check('single: cpp twin option mirrored', cp.includes('cpp.compiler.include.paths'));
  check('single: cpp inputType added', cp.includes('tool.cpp.compiler.input'));
  check('single: mirrored count is 1', r.mirrored === 1, String(r.mirrored));
  check('single: c option kept alongside the twin', cp.includes('c.compiler.include.paths'));
}

// ---- 2. multi-config conversion: EVERY configuration converts
buildFixture(P2, ['obj', 'dbg'], [['Stale', STALE]]);
{
  const r = setProjectCpp(P2, true);
  const cp = fs.readFileSync(path.join(P2, '.cproject'), 'utf-8');
  check('multi: both cpp twins mirrored (mirrored = 2)', r.mirrored === 2 && count(cp, 'cpp.compiler.include.paths') >= 2, String(r.mirrored));
  check('multi: inputType added to BOTH configurations', count(cp, '<inputType') === 2, String(count(cp, '<inputType')));
  check(
    'multi: ccnature written for the project',
    fs.readFileSync(path.join(P2, '.project'), 'utf-8').includes('org.eclipse.cdt.core.ccnature')
  );
  const rOff = setProjectCpp(P2, false);
  const cpOff = fs.readFileSync(path.join(P2, '.cproject'), 'utf-8');
  check(
    'multi: switch back removes every cpp inputType and keeps the mirrored values',
    rOff.mirrored === 0 && count(cpOff, '<inputType') === 0 && count(cpOff, 'cpp.compiler.include.paths') >= 2,
    String(rOff.mirrored)
  );
}

// ---- 3. write purity: a fixable stale link must NOT be repaired as a rider
fs.mkdirSync(SHARED, { recursive: true });
fs.writeFileSync(path.join(SHARED, 'keep.txt'), 'x');
fs.mkdirSync(OTHER_A, { recursive: true });
fs.mkdirSync(OTHER_B, { recursive: true });

buildFixture(PA, ['obj'], [
  ['Stale', STALE],
  ['Other', OTHER_A],
]);
// NewLink must NOT point at Shared — its own legal locationURI would be
// indistinguishable from a stale-link repair in the raw text
const NL_DIR = path.join(scratch, 'nl-dir');
fs.mkdirSync(NL_DIR, { recursive: true });
addLinkedFolder(PA, 'NewLink', NL_DIR);
{
  const raw = fs.readFileSync(path.join(PA, '.project'), 'utf-8');
  check(
    'purity: addLinkedFolder adds the link but leaves the stale link untouched',
    raw.includes(STALE) && !raw.includes('PARENT-1-PROJECT_LOC/Shared') && raw.includes('/nl-dir'),
    'stale link was rewritten'
  );
}
removeLinkedFolder(PA, 'NewLink');
{
  const raw = fs.readFileSync(path.join(PA, '.project'), 'utf-8');
  check(
    'purity: removeLinkedFolder also leaves the stale link untouched',
    raw.includes(STALE) && !raw.includes('PARENT-1-PROJECT_LOC/Shared') && !raw.includes('NewLink'),
    'stale link was rewritten'
  );
}

buildFixture(PC, ['obj'], [
  ['Stale', STALE],
  ['Other', OTHER_A],
]);
changeLinkedFolderTarget(PC, 'Other', OTHER_B);
{
  const raw = fs.readFileSync(path.join(PC, '.project'), 'utf-8');
  check(
    'purity: changeLinkedFolderTarget re-points Other but leaves the stale link untouched',
    raw.includes(STALE) && !raw.includes('PARENT-1-PROJECT_LOC/Shared') && raw.includes('/otherB'),
    'stale link was rewritten'
  );
}

buildFixture(PS, ['obj'], [['Stale', STALE]]);
setProjectCpp(PS, true);
{
  const raw = fs.readFileSync(path.join(PS, '.project'), 'utf-8');
  check(
    'purity: setProjectCpp converts the type but leaves the stale link untouched',
    raw.includes(STALE) && !raw.includes('PARENT-1-PROJECT_LOC/Shared') && raw.includes('org.eclipse.cdt.core.ccnature'),
    'stale link was rewritten'
  );
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(failures ? '\n' + failures + ' FAILURES' : '\nall project-type tests passed');
process.exit(failures ? 1 : 0);
