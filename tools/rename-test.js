/*
 * Project rename tests (MRS2 semantics: display name only, directory stays):
 * .project name write-back, .wvproj reset, .launch field update + file
 * rename, .template Target Path, and slave-kernel skip. Run:
 *   node tools/rename-test.js
 */
const path = require('path');
const fs = require('fs');
const { renameProject, readProjectFile } = require('../out/core/projectFile.js');
const { readTemplate } = require('../out/core/templateFile.js');
const { Cproject } = require('../out/core/cproject.js');
const { generateMakefiles } = require('../out/core/makefile.js');

const DEVELOP_DIR = path.dirname(__dirname);
const scratch = path.join(DEVELOP_DIR, '.scratch', 'rename');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function buildFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, '.project'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription>\n<name>OldName</name>\n<comment/>\n<projects/>\n<buildSpec/>\n<natures>\n<nature>org.eclipse.cdt.core.cnature</nature>\n</natures>\n<linkedResources>\n<link>\n<name>Ld</name>\n<type>2</type>\n<locationURI>PARENT-1-PROJECT_LOC/SRC/Ld</locationURI>\n</link>\n</linkedResources>\n</projectDescription>`
  );
  fs.writeFileSync(
    path.join(root, '.template'),
    ['Vendor=WCH', 'MCU=CH582M', 'Address=0x00000000', 'Target Path=obj\\OldName.hex', 'Erase All=true', ''].join('\r\n')
  );
  fs.writeFileSync(path.join(root, 'OldName.wvproj'), '{"old":"state"}');
  fs.writeFileSync(
    path.join(root, 'OldName.launch'),
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<launchConfiguration type="org.eclipse.cdt.launch.applicationLaunchType">\n<stringAttribute key="org.eclipse.cdt.launch.PROGRAM_NAME" value="obj/Debug/OldName.elf"/>\n<stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="OldName"/>\n<stringAttribute key="org.eclipse.cdt.launch.CORE_FILE_PATH" value=""/>\n<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_PATHS">\n<listEntry value="/OldName"/>\n</listAttribute>\n<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_TYPES">\n<listEntry value="4"/>\n</listAttribute>\n</launchConfiguration>`
  );
  fs.writeFileSync(
    path.join(root, '.cproject'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>`
  );
  fs.writeFileSync(path.join(root, 'main.c'), 'int main(void){return 0;}\n');
}

const proj = path.join(scratch, 'proj');

// ---------- 1. master rename: all companion files updated ----------
buildFixture(proj);
renameProject(proj, 'NewName');
{
  const pf = readProjectFile(proj);
  check('.project name updated', pf.name === 'NewName');
  check('.project linkedResources intact', pf.linkedResources.length === 1 && pf.linkedResources[0].name === 'Ld');

  const wvprojs = fs.readdirSync(proj).filter((f) => f.toLowerCase().endsWith('.wvproj'));
  check('.wvproj reset to single empty NewName.wvproj', wvprojs.length === 1 && wvprojs[0] === 'NewName.wvproj' && fs.readFileSync(path.join(proj, wvprojs[0]), 'utf-8') === '');

  check('.launch renamed to NewName.launch', fs.existsSync(path.join(proj, 'NewName.launch')) && !fs.existsSync(path.join(proj, 'OldName.launch')));
  const launch = fs.readFileSync(path.join(proj, 'NewName.launch'), 'utf-8');
  check('.launch PROGRAM_NAME follows new name', launch.includes('obj/Debug/NewName.elf'));
  check('.launch PROJECT_ATTR updated', launch.includes('value="NewName"') && !launch.includes('"OldName"'));
  check('.launch MAPPED_RESOURCE_PATHS updated', launch.includes('value="/NewName"'));

  const tpl = readTemplate(proj);
  check('.template Target Path filename follows new name', tpl.values['Target Path'] === 'obj\\NewName.hex');
  check('.template other keys preserved', tpl.values['Vendor'] === 'WCH' && tpl.values['Erase All'] === 'true');

  // the renamed project still loads and keeps its build config
  const cp = Cproject.load(proj);
  check('.cproject untouched and project still loads', !!cp && cp.configName === 'obj');
}

// ---------- 2. slave kernel: Target Path skipped ----------
{
  const slave = path.join(scratch, 'slave');
  buildFixture(slave);
  renameProject(slave, 'SlaveName', { isSlave: true });
  check('slave: .project renamed', readProjectFile(slave).name === 'SlaveName');
  check('slave: Target Path untouched', readTemplate(slave).values['Target Path'] === 'obj\\OldName.hex');
}

// ---------- 3. project without .launch/.template: no crash ----------
{
  const bare = path.join(scratch, 'bare');
  fs.rmSync(bare, { recursive: true, force: true });
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(
    path.join(bare, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>Bare</name></projectDescription>'
  );
  renameProject(bare, 'Bare2');
  check('bare project (no launch/template/wvproj) renamed cleanly', readProjectFile(bare).name === 'Bare2');
}

// ---------- 4. project whose DIRECTORY has spaces (MRS2 ${ProjName} semantics) ----------
// .project display name has no spaces ("I2C") while the folder does ("I2C copy"):
// make targets must follow the display name — targets cannot carry spaces
{
  const spaced = path.join(scratch, 'I2C copy');
  fs.rmSync(spaced, { recursive: true, force: true });
  fs.mkdirSync(path.join(spaced, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(spaced, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>I2C</name></projectDescription>'
  );
  fs.writeFileSync(
    path.join(spaced, '.cproject'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj" artifactName="\${ProjName}">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>`
  );
  fs.writeFileSync(path.join(spaced, 'src', 'main.c'), 'int main(void){return 0;}\n');

  const cp = Cproject.load(spaced);
  check('space-dir project: targetName from .project name (no spaces)', cp.targetName === 'I2C');
  generateMakefiles(cp, goldenTc());
  const mk = fs.readFileSync(path.join(spaced, cp.configName, 'makefile'), 'utf-8');
  check('makefile targets use space-free name', mk.includes('all: I2C.elf') && mk.includes('I2C.elf: $(OBJS) $(USER_OBJS)'));
  check('makefile has no space-bearing unquoted targets', !/^\S*\s*I2C copy\.elf/m.test(mk));
  check('linker recipe quotes the real artifact name', mk.includes('-o "I2C.elf"'));

  // display name vs dir name: MrsProject-level name comes from .project too
  check('.project display name unchanged by builds', readProjectFile(spaced).name === 'I2C');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall rename tests passed');
process.exit(failures ? 1 : 0);

// ---------- helpers ----------
function goldenTc() {
  return {
    name: 'GCC12',
    dir: '',
    compilerC: 'riscv-none-elf-gcc',
    compilerCpp: 'riscv-none-elf-g++',
    linkerC: 'riscv-none-elf-gcc',
    linkerCpp: 'riscv-none-elf-g++',
    debugger: 'riscv-none-elf-gdb',
    objcopy: 'riscv-none-elf-objcopy',
    objdump: 'riscv-none-elf-objdump',
    size: 'riscv-none-elf-size',
    prefix: 'riscv-none-elf-',
  };
}
