/*
 * Linked-folder retarget tests: copy the real LED project, add a link, then
 * verify MRS2 changelinkedFolderPath semantics — the NAME (and .cproject
 * references keyed by it) stays untouched, only the location moves.
 */
const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, '..', '.scratch', 'linkedfolder-ws');
const PROJ = path.join(WS, 'LED');
// real EVT tree: dev TEST copy, F:/ layout, or the local E:/WORK tree
const LED_SRC = ['F:/CH585/EVT/V1_2/EXAM/LED', 'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find(
  (p) => fs.existsSync(path.join(p, '.project'))
);
const EVT_ROOT = LED_SRC ? path.dirname(LED_SRC) : 'F:/CH585/EVT/V1_2/EXAM';
const SRC_TARGET = `${EVT_ROOT}/SRC`;
const NEW_TARGET = `${EVT_ROOT}/SRC/StdPeriphDriver`;

fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
if (!LED_SRC) {
  console.log('SKIP  linkedfolder-test (no real LED tree found)');
  process.exit(0);
}
fs.cpSync(LED_SRC, PROJ, { recursive: true });

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

// watchable linked dirs (0.3.3, user request): the auto-refresh watchers
// must cover linked folders OUTSIDE the project root only — links that
// resolve inside the root are already covered by the root's own watcher,
// duplicates are useless, empty entries are noise. Case-insensitive on win32.
{
  const { watchableLinkedDirs } = require('../out/core/projectFile.js');
  const ROOTW = 'C:\\work\\Demo';
  const dirs = watchableLinkedDirs(ROOTW, [
    'C:\\work\\LIB\\HAL', // outside -> kept
    'C:\\work\\Demo\\inc', // inside the root -> dropped
    'C:\\WORK\\LIB\\HAL', // case variant of the first -> dropped (win32)
    '', // empty -> dropped
    'C:/work/LIB/StdPeriphDriver', // forward slashes kept verbatim (dedupe by folded form)
    'C:\\work\\LIB\\HAL', // exact duplicate -> dropped
  ]);
  check(
    'watchable: outside dirs kept once, inside-root/case-dupes/empty dropped',
    JSON.stringify(dirs) === JSON.stringify(['C:\\work\\LIB\\HAL', 'C:/work/LIB/StdPeriphDriver'])
  );
  check('watchable: no links -> empty list', JSON.stringify(watchableLinkedDirs(ROOTW, [])) === '[]');
  check(
    'watchable: forward-slash link matching the root (different separator) is dropped',
    JSON.stringify(watchableLinkedDirs('C:/work/Demo', ['C:/work/Demo/inc'])) === '[]'
  );
}

// round53 P3-1/P3-2: the watchers must cover every source kind the scanner
// accepts (glob DERIVED from CPP_SOURCE_EXTS, so the two cannot drift) and
// the store's dispose must free the linked watchers with everything else
{
  const { SOURCE_WATCHER_GLOB, CPP_SOURCE_EXTS } = require('../out/core/scan.js');
  check('watcher glob covers every scanner extension', CPP_SOURCE_EXTS.every((e) => SOURCE_WATCHER_GLOB.includes(e)));
  check('watcher glob covers the listed headers too', SOURCE_WATCHER_GLOB.includes('h') && SOURCE_WATCHER_GLOB.includes('hpp'));
  check('watcher glob includes the round53-missed kinds (C/cc/cxx)', ['cc', 'cxx', ',C,'].every((k) => SOURCE_WATCHER_GLOB.includes(k)));
  const projectsSrc = fs.readFileSync(path.join(__dirname, '..', 'out', 'vscode', 'projects.js'), 'utf-8');
  check('compiled watchers use the derived glob (no hand-written leftovers)', !projectsSrc.includes('{c,h,cpp,hpp,s,S}') && projectsSrc.includes('SOURCE_WATCHER_GLOB'));
  const disposeBody = projectsSrc.slice(projectsSrc.indexOf('dispose() {'), projectsSrc.indexOf('dispose() {') + 900);
  check('store dispose() frees the linked watchers too', disposeBody.includes('linkedWatchers') && disposeBody.includes('clear()'));
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall linkedfolder tests passed');
process.exit(failures ? 1 : 0);
