/*
 * filteredResources (logical remove / restore) tests — real LED project
 * copy: XML shape (MRS2-compatible), scanner hiding, tree data provider
 * filtering, restore, idempotence, foreign-filter preservation.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// stub vscode before loading tree.js (real module file: tools/vscode-stub.js)
const Module = require('module');
const stubPath = require.resolve('./vscode-stub.js');
const vscodeStub = require(stubPath);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain) {
  if (request === 'vscode') return stubPath;
  return origResolve.call(this, request, parent, isMain);
};

const WS = path.join(__dirname, '..', '.scratch', 'removed-ws');
const PROJ = path.join(WS, 'LED');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
const LED_SRC = ['F:/CH585/EVT/V1_2/EXAM/LED', 'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find(
  (r) => fs.existsSync(r)
);
if (!LED_SRC) {
  console.error('removedresources-test: no CH585 EVT LED project found (TEST/ or F:/ or E:/WORK/)');
  process.exit(2);
}
fs.cpSync(LED_SRC, PROJ, { recursive: true });

const pf = require('../out/core/projectFile.js');
const { Cproject } = require('../out/core/cproject.js');
const { scanSources } = require('../out/core/scan.js');
const { ProjectTreeProvider } = require('../out/vscode/tree.js');
const vscode = vscodeStub;

// 1. append + list: MRS2 XML shape
pf.appendRemovedResource(PROJ, '', 'APP_LogicallyRemoved.c', false);
pf.appendRemovedResource(PROJ, 'src', 'ch58x_drv_ledc.c', false);
pf.appendRemovedResource(PROJ, 'User', 'SomeFolder', true);
const list = pf.listRemovedResources(PROJ);
check('list: 3 added + 1 template preset (*.wvproj)', list.length === 4);
check('list: root file entry', list.some((r) => r.parentLogic === '' && r.name === 'APP_LogicallyRemoved.c' && !r.isFolder));
check('list: folder entry type', list.some((r) => r.parentLogic === 'User' && r.name === 'SomeFolder' && r.isFolder));

const raw = fs.readFileSync(path.join(PROJ, '.project'), 'utf-8');
check('xml: filteredResources block written', raw.includes('<filteredResources>'));
check('xml: multiFilter matcher id', raw.includes('org.eclipse.ui.ide.multiFilter'));
check('xml: MRS2 arguments form', raw.includes('1.0-name-matches-false-false-APP_LogicallyRemoved.c'));
check('xml: type 6 for file / 10 for folder', raw.includes('<type>6</type>') && raw.includes('<type>10</type>'));

// 2. scanner hides removed files (build + IntelliSense share this path)
const cp = Cproject.load(PROJ);
const files = [...scanSources(cp).values()].flat().map((f) => f.logicName);
check('scan: root removed file hidden', !files.includes('APP_LogicallyRemoved.c'));
check('scan: nested removed file hidden', !files.includes('src/ch58x_drv_ledc.c'));
check('scan: other sources intact', files.includes('src/Main.c'));
const beforeCount = files.length;

// 3. restore one entry -> scanner sees it again
pf.clearRemovedResource(PROJ, 'src', 'ch58x_drv_ledc.c', false);
const files2 = [...scanSources(Cproject.load(PROJ)).values()].flat().map((f) => f.logicName);
check('restore: nested file back in scan', files2.includes('src/ch58x_drv_ledc.c'));
check('restore: root file still hidden', !files2.includes('APP_LogicallyRemoved.c'));
check('restore: list shrank to 3 (preset stays)', pf.listRemovedResources(PROJ).length === 3);

// 4. idempotent append
pf.appendRemovedResource(PROJ, '', 'APP_LogicallyRemoved.c', false);
check('append: idempotent', pf.listRemovedResources(PROJ).length === 3);

// 5. foreign filters preserved (an Eclipse user filter must survive)
{
  const projPath = path.join(PROJ, '.project');
  let raw2 = fs.readFileSync(projPath, 'utf-8');
  const foreign = '<filter><id>org.eclipse.ui.ide.orFilter</id></filter>';
  raw2 = raw2.replace('</filteredResources>', foreign + '</filteredResources>');
  fs.writeFileSync(projPath, raw2, 'utf-8');
  pf.clearRemovedResource(PROJ, '', 'APP_LogicallyRemoved.c', false);
  const raw3 = fs.readFileSync(projPath, 'utf-8');
  check('foreign filter preserved on clear', raw3.includes('orFilter'));
  check('own entry cleared', !raw3.includes('APP_LogicallyRemoved.c'));
  check('foreign filters not listed as removed', pf.listRemovedResources(PROJ).every((r) => r.name !== 'orFilter'));
}

// 6. tree filtering (vscode stub): removed root file/folder invisible
{
  const store = {
    all: [],
    solutions: [],
    active: null,
    onDidChange: () => ({ dispose() {} }),
  };
  const provider = new ProjectTreeProvider(store, { joinPath: () => ({ fsPath: '' }) });
  const proj = Cproject.load(PROJ);
  const projNode = { nodeType: 'project', fsPath: PROJ.replace(/\//g, path.sep), project: proj, children: [] };
  // emulate MrsProject surface the tree uses
  proj.projectFile = proj.projectFile || { linkedResources: [] };
  const fakeProj = {
    root: PROJ.replace(/\//g, path.sep),
    projectName: proj.projectName,
    buildDir: path.join(PROJ.replace(/\//g, path.sep), 'obj'),
    cproject: proj,
    projectFile: { linkedResources: [] },
    logicPathOf: (f) => {
      const norm = f.replace(/\\/g, '/');
      const root = PROJ.replace(/\\/g, '/');
      return norm.startsWith(root + '/') ? norm.slice(root.length + 1) : undefined;
    },
  };
  projNode.project = fakeProj;
  return Promise.resolve(provider.getChildren(projNode)).then((children) => {
    const names = children.map((c) => c.label || (c.treeItem || {}).label);
    check('tree: removed root file hidden', !names.includes('APP_LogicallyRemoved.c'));
    void names;
    fs.rmSync(WS, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILURES` : '\nall removedresources tests passed');
    process.exit(failures ? 1 : 0);
  }).catch((e) => {
    // the tree section IS what this suite guards — an exception here is a
    // regression, not a skippable environment problem: count it, exit red
    failures++;
    console.log(`FAIL  tree section threw: ${e.message}`);
    fs.rmSync(WS, { recursive: true, force: true });
    console.log(`\n${failures} FAILURES`);
    process.exit(1);
  });
}
