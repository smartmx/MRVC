/*
 * Linked-folder retarget tests: copy the real LED project, add a link, then
 * verify MRS2 changelinkedFolderPath semantics — the NAME (and .cproject
 * references keyed by it) stays untouched, only the location moves.
 */
const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, '..', '.scratch', 'linkedfolder-ws');
const PROJ = path.join(WS, 'LED');
const SRC_TARGET = 'F:/CH585/EVT/V1_2/EXAM/SRC';
const NEW_TARGET = 'F:/CH585/EVT/V1_2/EXAM/SRC/StdPeriphDriver';

fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
fs.cpSync('F:/CH585/EVT/V1_2/EXAM/LED', PROJ, { recursive: true });

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const { addLinkedFolder, changeLinkedFolderTarget } = require('../out/core/projectFile.js');
const { Cproject } = require('../out/core/cproject.js');

// snapshot .cproject bytes — must be untouched by a retarget
const cprojectBefore = fs.readFileSync(path.join(PROJ, '.cproject'));

// link SRC under the name "SRC" (portable PARENT-N-PROJECT_LOC form)
addLinkedFolder(PROJ, 'SRC', SRC_TARGET);
const cpBefore = Cproject.load(PROJ);
const includesBefore = JSON.stringify([...cpBefore.listOption('c.compiler.include.paths').values]);

// 1. retarget: name stays, location moves
const upd = changeLinkedFolderTarget(PROJ, 'SRC', NEW_TARGET);
check('retarget returns the updated resource', !!upd && upd.name === 'SRC');
check('location resolves to the new target', !!upd && path.resolve(upd.location) === path.resolve(NEW_TARGET));
check('locationUri is a portable form (no drive letter)', !!upd && !/^[A-Za-z]:/.test(upd.locationUri));

const after = require('../out/core/projectFile.js').readProjectFile(PROJ);
const link = after.linkedResources.find((l) => l.name === 'SRC');
check('.project still holds the link under the SAME name', !!link);
check('element serialized as locationURI', !!link && !!link.locationUri);

// 2. .cproject untouched (include paths keyed by the link name still resolve)
const cprojectAfter = fs.readFileSync(path.join(PROJ, '.cproject'));
check('.cproject byte-identical after retarget', cprojectBefore.equals(cprojectAfter));
const cpAfter = Cproject.load(PROJ);
check('include paths unchanged', JSON.stringify([...cpAfter.listOption('c.compiler.include.paths').values]) === includesBefore);
check('scanSources resolves through the new target', (() => {
  const { scanSources } = require('../out/core/scan.js');
  const cp = Cproject.load(PROJ);
  const files = [...scanSources(cp).values()].flat().map((f) => f.fullpath);
  return files.length > 0 && files.every((f) => !f.startsWith(path.resolve(SRC_TARGET) + path.sep) || f.startsWith(path.resolve(NEW_TARGET) + path.sep));
})());

// 3. unknown name refused, no file touched
const before = fs.readFileSync(path.join(PROJ, '.project'));
check('unknown link name -> undefined', changeLinkedFolderTarget(PROJ, 'NOPE', NEW_TARGET) === undefined);
check('unknown link name leaves .project untouched', before.equals(fs.readFileSync(path.join(PROJ, '.project'))));

// 4. MRS1-style <location> element is converted to <locationURI> on retarget
{
  const raw = fs.readFileSync(path.join(PROJ, '.project'), 'utf-8');
  const hacked = raw.replace('<locationURI>PARENT-2-PROJECT_LOC/SRC/StdPeriphDriver</locationURI>', '<location>F:\\nowhere\\old</location>');
  fs.writeFileSync(path.join(PROJ, '.project'), hacked, 'utf-8');
  const upd2 = changeLinkedFolderTarget(PROJ, 'SRC', SRC_TARGET);
  check('MRS1-style <location> converted to <locationURI>', !!upd2 && !!upd2.locationUri);
  const reread = require('../out/core/projectFile.js').readProjectFile(PROJ);
  const l2 = reread.linkedResources.find((l) => l.name === 'SRC');
  check('converted link resolves back to the original target', !!l2 && path.resolve(l2.location) === path.resolve(SRC_TARGET));
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall linkedfolder tests passed');
process.exit(failures ? 1 : 0);
