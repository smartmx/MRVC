/*
 * Scoped tree refresh (user report 2026-11-13): watcher events and the
 * post-build refresh must NOT fire the whole tree — a full fire re-renders
 * every expanded node and the async file-decoration pass repaints linked
 * folders white→blue. The provider keeps ONE TreeNode identity per slot;
 * refreshDirs() fires only the nodes at the changed directories (plus the
 * parent when the directory itself vanished). Pure Node with a vscode stub.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
// async command-layer checks drain before the exit (see the tail)
const asyncChecks = [];
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

class TreeItem {
  constructor(label, state) {
    this.label = label;
    this.collapsibleState = state;
    this.contextValue = undefined;
  }
}
class EventEmitter {
  constructor() {
    this.listeners = [];
    // arrow so `readonly onDidChangeTreeData = emitter.event` stays callable
    // without its original `this` (VSCode's own emitter binds the same way)
    this.event = (cb) => {
      this.listeners.push(cb);
      return { dispose: () => this.listeners.splice(this.listeners.indexOf(cb) >>> 0, 1) };
    };
  }
  fire(value) {
    for (const cb of [...this.listeners]) cb(value);
  }
  dispose() {
    this.listeners = [];
  }
}

const uiMessages = [];
let clipboardText = '';
let warnPick = undefined;
const executedCommands = [];
const vscodeStub = {
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter,
  Uri: { file: (p) => ({ fsPath: p, with: (o) => ({ fsPath: p, ...o }) }), joinPath: () => ({ fsPath: '' }) },
  ThemeColor: class {},
  ThemeIcon: class {},
  FileDecoration: class {},
  workspace: { workspaceFolders: [] },
  commands: { executeCommand: (cmd) => executedCommands.push(cmd) },
  env: { clipboard: { writeText: async (t) => { clipboardText = t; } } },
  // command-layer tests (excludeFromBuild/includeFromBuild/deleteNode)
  // report through these; the recorders let assertions prove no error path
  // fired. showWarningMessage returns the modal button picked via warnPick.
  window: {
    showErrorMessage: (m) => uiMessages.push(['error', String(m)]),
    showInformationMessage: (m) => uiMessages.push(['info', String(m)]),
    showWarningMessage: async () => warnPick,
    setStatusBarMessage: (m) => uiMessages.push(['status', String(m)]),
  },
};

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain) {
  if (request === 'vscode') return 'vscode-treescope-stub';
  if (request === './projects' && parent && /tree\.js$/.test(parent.filename || '')) return 'projects-treescope-stub';
  return origResolve.call(this, request, parent, isMain);
};
require.cache['vscode-treescope-stub'] = { id: 'vscode-treescope-stub', filename: 'vscode-treescope-stub', loaded: true, exports: vscodeStub };

const WS = path.join(__dirname, '..', '.scratch', 'treescope-ws');
const PROJ = path.join(WS, 'Demo');
const SRC = path.join(PROJ, 'src');
const OBJ = path.join(PROJ, 'obj');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(SRC, { recursive: true });
fs.mkdirSync(OBJ, { recursive: true });
fs.writeFileSync(path.join(SRC, 'main.c'), 'int main(){return 0;}\n');
fs.writeFileSync(path.join(OBJ, 'Demo.hex'), ':00000001FF\n');
const miniProject = (name) =>
  `<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>${name}</name><filteredResources></filteredResources></projectDescription>`;
fs.writeFileSync(path.join(PROJ, '.project'), miniProject('Demo'));

const keyOf = (p) => (process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p));
const storeListeners = [];
const dirListeners = [];
const projectsStub = {
  ProjectStore: class {
    static key(p) {
      return keyOf(p);
    }
    onDidChange(cb) {
      storeListeners.push(cb);
      return { dispose() {} };
    }
    onTreeDirsChanged(cb) {
      dirListeners.push(cb);
      return { dispose() {} };
    }
  },
  MrsSolution: { key: (f) => keyOf(f) },
};
require.cache['projects-treescope-stub'] = {
  id: 'projects-treescope-stub',
  filename: 'projects-treescope-stub',
  loaded: true,
  exports: projectsStub,
};

const project = {
  root: PROJ,
  projectName: 'Demo',
  buildDir: OBJ,
  outputDirs: [OBJ],
  cproject: { configName: 'obj' },
  projectFile: { linkedResources: [] },
  logicPathOf: () => undefined,
};
const store = {
  all: [project],
  solutionList: [],
  active: project,
  onDidChange: (cb) => {
    storeListeners.push(cb);
    return { dispose() {} };
  },
  onTreeDirsChanged: (cb) => {
    dirListeners.push(cb);
    return { dispose() {} };
  },
};

const { ProjectTreeProvider } = require('../out/vscode/tree.js');
const provider = new ProjectTreeProvider(store, { joinPath: () => ({ fsPath: '' }) });

let fullFires = 0;
provider.onDidChangeTreeData((el) => {
  if (el === undefined || el === null) fullFires++;
});

// 1. first render: capture the node identities VSCode would have received
const projectNode = provider.getChildren().find((n) => n.nodeType === 'project');
check('render: project node present', !!projectNode);
const level1 = provider.getChildren(projectNode);
const folderNode = level1.find((n) => n.nodeType === 'folder');
const productsNode = level1.find((n) => n.nodeType === 'products');
const rootFileNodes = level1.filter((n) => n.nodeType === 'file');
check('render: src folder + products nodes exist', !!folderNode && !!productsNode && folderNode.fsPath === SRC && productsNode.fsPath === OBJ);

// 2. a re-render keeps the SAME node identity (scoped fires need this)
const level1b = provider.getChildren(projectNode);
const folderNode2 = level1b.find((n) => n.nodeType === 'folder');
const productsNode2 = level1b.find((n) => n.nodeType === 'products');
check('cache: folder node identity is stable across renders', folderNode2 === folderNode);
check('cache: products node identity is stable across renders', productsNode2 === productsNode);

// 3. a build-dir change fires ONLY the products node — no full-tree fire
{
  const before = fullFires;
  const fired = [];
  const sub = provider.onDidChangeTreeData((el) => el && fired.push(el));
  provider.refreshDirs([OBJ]);
  sub.dispose();
  check('scoped: build dir fires exactly one node', fired.length === 1 && fired[0] === productsNode);
  check('scoped: no full-tree fire for a build dir change', fullFires === before);
}

// 4. a source-dir change fires ONLY that folder node
{
  const fired = [];
  const sub = provider.onDidChangeTreeData((el) => el && fired.push(el));
  provider.refreshDirs([SRC]);
  sub.dispose();
  check('scoped: source dir fires exactly the folder node', fired.length === 1 && fired[0] === folderNode);
}

// 5. shared path across projects: every project's node at that path fires
{
  const projectB = { ...project, root: path.join(WS, 'Demo2'), projectName: 'Demo2', buildDir: OBJ };
  fs.mkdirSync(projectB.root, { recursive: true });
  fs.writeFileSync(path.join(projectB.root, '.project'), miniProject('Demo2'));
  fs.mkdirSync(projectB.root, { recursive: true });
  store.all = [project, projectB];
  storeListeners.forEach((cb) => cb()); // re-render + cache pruning
  const rootNodes = provider.getChildren();
  const projNodeB = rootNodes.find((n) => n.nodeType === 'project' && n.project === projectB);
  const level1B = provider.getChildren(projNodeB);
  // Demo2 has no src/ or obj/ of its own; give it a products node by pointing
  // buildDir at the SHARED OBJ? buildDir is per-project; instead share SRC as
  // a linked folder is overkill — assert via a folder we create for Demo2.
  fs.mkdirSync(path.join(projectB.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectB.root, 'src', 'b.c'), '');
  const level1B2 = provider.getChildren(projNodeB);
  const folderB = level1B2.find((n) => n.nodeType === 'folder' && n.fsPath === path.join(projectB.root, 'src'));
  check('shared: Demo2 folder node cached separately', !!folderB && folderB !== folderNode);
  store.all = [project];
  storeListeners.forEach((cb) => cb());
}

// 6. a vanished directory also fires its parent (stale row must disappear)
{
  fs.rmSync(OBJ, { recursive: true, force: true });
  const fired = [];
  const sub = provider.onDidChangeTreeData((el) => el && fired.push(el));
  provider.refreshDirs([OBJ]);
  sub.dispose();
  check('vanished dir: the products node still fires', fired.includes(productsNode));
  check('vanished dir: the project node fires too (row removal)', fired.includes(projectNode));
  const level1c = provider.getChildren(projectNode);
  check('vanished dir: products row is gone after parent re-read', !level1c.some((n) => n.nodeType === 'products'));
}

// 6b. obj RE-created after deletion (round19 P2 + round20 P3 pruning): the
// stale products node was pruned when the row vanished, so only the project
// node fires — and the row reappears via the parent re-read
{
  fs.mkdirSync(OBJ, { recursive: true });
  fs.writeFileSync(path.join(OBJ, 'Demo.hex'), ':00000001FF\n');
  const fired = [];
  const sub = provider.onDidChangeTreeData((el) => el && fired.push(el));
  provider.refreshDirs([OBJ]);
  sub.dispose();
  check(
    'recreated obj: the stale products node was pruned — parent-only fire',
    fired.length === 1 && fired[0] === projectNode
  );
  const level1d = provider.getChildren(projectNode);
  check('recreated obj: the products row is back after the parent re-read', level1d.some((n) => n.nodeType === 'products'));
}

// 8. a brand-new directory (never rendered) fires the nearest cached
//    ancestor so the new row appears — the first-build obj case
{
  const SRC2 = path.join(PROJ, 'src2');
  fs.mkdirSync(SRC2, { recursive: true });
  fs.writeFileSync(path.join(SRC2, 'n.c'), '');
  const fired = [];
  const sub = provider.onDidChangeTreeData((el) => el && fired.push(el));
  provider.refreshDirs([SRC2]);
  sub.dispose();
  check('new dir: the nearest cached ancestor (project) fires', fired.length === 1 && fired[0] === projectNode);
  const level1e = provider.getChildren(projectNode);
  check('new dir: the src2 row appears after the parent re-read', level1e.some((n) => n.fsPath === SRC2));
  fs.rmSync(SRC2, { recursive: true, force: true });
}

// 7. content recompute merges into the cached identity (label update)
{
  fs.rmSync(path.join(SRC, 'main.c'), { force: true });
  fs.writeFileSync(path.join(SRC, 'renamed.c'), '');
  const children = provider.getChildren(folderNode);
  const renamed = children.find((n) => n.fsPath === path.join(SRC, 'renamed.c'));
  check('cache: new child rendered with fresh content', !!renamed && renamed.label === 'renamed.c');
  const mainGone = !children.some((n) => n.fsPath === path.join(SRC, 'main.c'));
  check('cache: deleted child no longer listed', mainGone);
}

// 8. store channel: noteTreeDirs debounces, folds while suspended, flushes
//    after resume (the post-build path goes through the same pending set)
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { ProjectStore: RealStore } = require('../out/vscode/projects.js');
  const s = new RealStore({ workspaceState: { get: () => undefined, update: async () => {} }, subscriptions: [] });
  const got = [];
  s.onTreeDirsChanged((dirs) => got.push(dirs));

  s.noteTreeDirs('A', 'B', 'A');
  await sleep(500);
  check('store: debounced flush emits unique dirs', JSON.stringify(got) === JSON.stringify([['A', 'B']]));

  s.suspendTreeRefresh();
  s.noteTreeDirs('C');
  await sleep(500);
  check('store: suspended dirs do not flush', got.length === 1);
  s.noteTreeDirs('D');
  s.resumeTreeRefresh();
  await sleep(500);
  check('store: resume flushes everything folded during the build', JSON.stringify(got) === JSON.stringify([['A', 'B'], ['C', 'D']]));

  s.dispose();
  // 9. solutions: node identity rides on the .wvsln FILE (round20 P2) — two
//    solutions sharing a directory must be distinct nodes
{
  const solA = { file: path.join(WS, 'Alpha.wvsln'), dir: WS, name: 'Alpha', members: [project], droppedPaths: [] };
  const solB = { file: path.join(WS, 'Beta.wvsln'), dir: WS, name: 'Beta', members: [], droppedPaths: [] };
  store.solutionList = [solA, solB];
  storeListeners.forEach((cb) => cb());
  const solNodes = provider.getChildren().filter((n) => n.nodeType === 'solution');
  check('solutions: two same-dir .wvsln render two nodes', solNodes.length === 2);
  check('solutions: distinct TreeNode identity per file', solNodes[0] !== solNodes[1]);
  check('solutions: labels follow the file names', solNodes.map((n) => n.label).sort().join(',') === 'Alpha,Beta');
  check('solutions: each node carries its own solution object', solNodes.some((n) => n.solution === solA) && solNodes.some((n) => n.solution === solB));
  const nodeA = solNodes.find((n) => n.solution === solA);
  const membersA = provider.getChildren(nodeA);
  check('solutions: expansion uses the node\'s own solution', membersA.length === 1 && membersA[0].project === project);
  store.solutionList = [];
  storeListeners.forEach((cb) => cb());
}

// 10. solutions: remove → add of the SAME file must drop the cached node
//     (the new MrsSolution object — and its member list — must be used)
{
  const A1 = { file: path.join(WS, 'Alpha.wvsln'), dir: WS, name: 'Alpha', members: [project], droppedPaths: [] };
  store.solutionList = [A1];
  storeListeners.forEach((cb) => cb());
  const nodeA1 = provider.getChildren().find((n) => n.nodeType === 'solution');
  check('reload: the first load caches a node for A1', !!nodeA1 && nodeA1.solution === A1);
  store.solutionList = []; // removeSolution → store change → prune
  storeListeners.forEach((cb) => cb());
  const A2 = { file: A1.file, dir: WS, name: 'Alpha', members: [], droppedPaths: [] };
  store.solutionList = [A2]; // addSolution back → a NEW MrsSolution instance
  storeListeners.forEach((cb) => cb());
  const nodeA2 = provider.getChildren().find((n) => n.nodeType === 'solution');
  check('reload: remove→add yields a fresh node identity', !!nodeA2 && nodeA2 !== nodeA1);
  check('reload: the fresh node carries the NEW solution object', !!nodeA2 && nodeA2.solution === A2);
  check('reload: expansion lists the NEW member list', provider.getChildren(nodeA2).length === 0);
  store.solutionList = [];
  storeListeners.forEach((cb) => cb());
}

// 11. leaf pruning (round20 P3): a deleted file's TreeNode identity leaves
//     the scoped-refresh index — long sessions don't accumulate targets
{
  const before = provider.getChildren(folderNode);
  const leaf = before.find((n) => n.fsPath === path.join(SRC, 'renamed.c'));
  check('prune: the leaf is rendered before deletion', !!leaf);
  fs.rmSync(path.join(SRC, 'renamed.c'), { force: true });
  provider.getChildren(folderNode); // re-render: the leaf is absent → pruned
  const fired = [];
  const sub = provider.onDidChangeTreeData((el) => el && fired.push(el));
  provider.refreshDirs([path.join(SRC, 'renamed.c')]);
  sub.dispose();
  check('prune: the deleted leaf is no longer a scoped-refresh target', fired.length === 0);
}

// 12. recursive subtree pruning (round22 P3): deleting an EXPANDED directory
//     drops its whole descendant chain from the caches, not just the node
{
  const nested = path.join(SRC, 'nested-probe');
  const deep = path.join(nested, 'deep.c');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(deep, '');
  const level = provider.getChildren(folderNode);
  const nestedNode = level.find((n) => n.fsPath === nested);
  check('prune-recursive: nested dir rendered', !!nestedNode);
  const nestedChildren = provider.getChildren(nestedNode);
  const deepNode = nestedChildren.find((n) => n.fsPath === deep);
  check('prune-recursive: deep leaf rendered', !!deepNode);
  fs.rmSync(nested, { recursive: true, force: true });
  provider.getChildren(folderNode); // re-render: nested dir absent → pruned
  const fired = [];
  const sub = provider.onDidChangeTreeData((el) => el && fired.push(el));
  provider.refreshDirs([nested]);
  provider.refreshDirs([deep]);
  sub.dispose();
  check('prune-recursive: nested dir no longer a scoped-refresh target', fired.length === 0);
  check('prune-recursive: deep leaf no longer a scoped-refresh target', fired.length === 0);
  const levelAfter = provider.getChildren(folderNode);
  check('prune-recursive: nested row gone after parent re-read', !levelAfter.some((n) => n.fsPath === nested));
}

// 13. every configuration's output directory (user report 2026-11-20): a
//     dual-config project builds obj1/ AND obj/ — BOTH must be recognized as
//     output dirs, not just the active configuration's (buildDir).
{
  const dual = path.join(WS, 'Dual');
  fs.rmSync(dual, { recursive: true, force: true });
  fs.mkdirSync(path.join(dual, 'obj'), { recursive: true });
  fs.writeFileSync(path.join(dual, 'obj', 'old.hex'), ':00000001FF\n');
  // a compilable-suffixed artifact in the INACTIVE output dir (generated /
  // copied source-looking file): it is an output, never a compile target
  fs.writeFileSync(path.join(dual, 'obj', 'generated.c'), 'int generated;\n');
  fs.mkdirSync(path.join(dual, 'obj1'), { recursive: true });
  fs.writeFileSync(path.join(dual, 'obj1', 'Dual.hex'), ':00000001FF\n');
  fs.writeFileSync(path.join(dual, '.project'), miniProject('Dual'));
  const cfgBlock = (id, name) =>
    `\t\t<cconfiguration id="${id}">
\t\t\t<storageModule moduleId="cdtBuildSystem" version="4.0.0">
\t\t\t\t<configuration id="${id}" artifactName="Dual" artifactExtension="elf" name="${name}">
\t\t\t\t\t<toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release"/>${
      name === 'obj1'
        ? '\n\t\t\t\t\t<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="" excluding="obj/old.hex"/></sourceEntries>'
        : ''
    }
\t\t\t\t</configuration>
\t\t\t</storageModule>
\t\t</cconfiguration>
`;
  fs.writeFileSync(
    path.join(dual, '.cproject'),
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?fileVersion 4.0.0?><cproject storage_type_id="org.eclipse.cdt.core.XmlProjectDescriptionStorage">
\t<storageModule moduleId="org.eclipse.cdt.core.settings">
${cfgBlock('c1', 'obj1')}${cfgBlock('c2', 'obj')}\t</storageModule>
</cproject>
`,
    'utf-8'
  );
  const { MrsProject } = require('../out/vscode/projects.js');
  const mp = new MrsProject(dual);
  check(
    'outputs: BOTH configuration dirs are output dirs (active first)',
    JSON.stringify(mp.outputDirs.map((p) => keyOf(p))) ===
      JSON.stringify([keyOf(path.join(dual, 'obj1')), keyOf(path.join(dual, 'obj'))]),
    JSON.stringify(mp.outputDirs)
  );
  check('outputs: buildDir stays the ACTIVE configuration dir', mp.buildDir === path.join(dual, 'obj1'), mp.buildDir);
  // the exclude/include machinery must skip EVERY output dir: the ACTIVE
  // config's exclusion table names obj/old.hex, but that file lives in the
  // INACTIVE config's output dir — without the skip it would be marked
  // `.excluded` (and offered "Exclude From Build"), writing nonsense.
  const dualStore = {
    all: [mp],
    solutionList: [],
    active: mp,
    onDidChange: () => ({ dispose() {} }),
    onTreeDirsChanged: () => ({ dispose() {} }),
  };
  const provider2 = new ProjectTreeProvider(dualStore, { joinPath: () => ({ fsPath: '' }) });
  const dualProjNode = provider2.getChildren().find((n) => n.nodeType === 'project');
  const dualLevel1 = provider2.getChildren(dualProjNode);
  const objNode = dualLevel1.find((n) => n.fsPath === path.join(dual, 'obj'));
  check(
    'outputs: the inactive config dir renders as an OUTPUT folder row, never a plain source folder (round1 P2.1)',
    !!objNode && objNode.nodeType === 'outputFolder' && objNode.contextValue === 'outputFolder',
    JSON.stringify(dualLevel1.map((n) => `${n.nodeType}:${n.fsPath}`))
  );
  const productsNode2 = dualLevel1.find((n) => n.nodeType === 'products');
  check(
    'outputs: the ACTIVE config dir is the products node, never a duplicate row',
    !!productsNode2 && productsNode2.fsPath === path.join(dual, 'obj1') && !dualLevel1.some((n) => n !== productsNode2 && n.fsPath === path.join(dual, 'obj1')),
    JSON.stringify(dualLevel1.map((n) => `${n.nodeType}:${n.fsPath}`))
  );
  const objChildren = provider2.getChildren(objNode);
  const hexNode = objChildren.find((n) => n.fsPath === path.join(dual, 'obj', 'old.hex'));
  const generatedNode = objChildren.find((n) => n.fsPath === path.join(dual, 'obj', 'generated.c'));
  provider2.getTreeItem(hexNode);
  provider2.getTreeItem(generatedNode);
  check(
    'outputs: a file inside the INACTIVE config dir is an output file — not excluded, no Exclude menu',
    !!hexNode && hexNode.contextValue === 'outputFile',
    String(hexNode && hexNode.contextValue)
  );
  check(
    'outputs: a compilable-suffixed file inside the INACTIVE config dir stays an output file (no Compile File)',
    !!generatedNode && generatedNode.contextValue === 'outputFile',
    String(generatedNode && generatedNode.contextValue)
  );
  // the INACTIVE output dir lists its content like the active one (0.3.7:
  // subdirectories included, nothing filtered)
  fs.mkdirSync(path.join(dual, 'obj', 'User'), { recursive: true });
  fs.writeFileSync(path.join(dual, 'obj', 'User', 'main.o'), 'o');
  const objChildren2 = provider2.getChildren(objNode);
  const mirrorNode = objChildren2.find((n) => n.fsPath === path.join(dual, 'obj', 'User'));
  check(
    'outputs: the inactive output dir expands its subdirectories the same way',
    !!mirrorNode && mirrorNode.nodeType === 'outputFolder' && provider2.getChildren(mirrorNode)[0].contextValue === 'outputFile',
    JSON.stringify(objChildren2.map((n) => `${n.nodeType}:${n.label}`))
  );
  // the menus VS Code OFFERS on output rows: no build-config command may
  // match outputFolder / outputFile. The when-clauses are evaluated the way
  // VS Code does (a `viewItem == X` list is an OR; the anchored regex form is
  // the other spelling; a clause without any viewItem term covers EVERY row) —
  // the old assertion only looked at contextValue === 'file' and so missed
  // that a plain `folder` row offered "Exclude From Build" (round1 P2.1).
  {
    const pkgCtx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const ctxItems = pkgCtx.contributes.menus['view/item/context'];
    const whensOf = (cmd) => ctxItems.filter((i) => i.command === cmd).map((i) => i.when || '');
    const offered = (when, value) => {
      const eq = [...when.matchAll(/viewItem == ([\w.]+)/g)].map((m) => m[1]);
      if (eq.length) return eq.includes(value);
      const rx = when.match(/viewItem =~ \/\^\((.*?)\)\$\//);
      return rx ? rx[1].split('|').map((s) => s.replace(/\\(.)/g, '$1')).includes(value) : true;
    };
    for (const cmd of ['mrvc.excludeFromBuild', 'mrvc.includeFromBuild', 'mrvc.compileFile', 'mrvc.file.rename', 'mrvc.flagFile', 'mrvc.clearFlag']) {
      const whens = whensOf(cmd);
      check(`outputs: ${cmd} has menu items to evaluate`, whens.length > 0);
      for (const v of ['outputFolder', 'outputFile']) {
        check(`outputs: ${cmd} is never offered on ${v}`, !whens.some((w) => offered(w, v)), whens.join(' || '));
      }
    }
    // (sanity) the same evaluator DOES see the menus on ordinary rows
    check('outputs: (sanity) Exclude From Build is offered on a plain folder row', whensOf('mrvc.excludeFromBuild').some((w) => offered(w, 'folder')));
    check('outputs: (sanity) Compile File is offered on file.src', whensOf('mrvc.compileFile').some((w) => offered(w, 'file.src')));
    check('outputs: (sanity) Rename is offered on file and folder rows', whensOf('mrvc.file.rename').some((w) => offered(w, 'file')) && whensOf('mrvc.file.rename').some((w) => offered(w, 'folder')));
  }
  fs.rmSync(dual, { recursive: true, force: true });

  // the output-dir WATCHER must cover every configuration too (round4 P3)
  const { outputWatchPattern } = require('../out/vscode/projects.js');
  check(
    'watch glob: every configuration dir and its contents',
    outputWatchPattern(['obj1', 'obj2']) === '{obj1,obj2,obj1/**,obj2/**}',
    outputWatchPattern(['obj1', 'obj2'])
  );
  check('watch glob: dedupes; empty set falls back to obj', outputWatchPattern(['obj', 'obj']) === '{obj,obj/**}' && outputWatchPattern([]) === '{obj,obj/**}');
  // round5 P2: a leading '-' is MRS-legal and glob-safe
  check('watch glob: dash names are glob-safe', outputWatchPattern(['-x']) === '{-x,-x/**}', outputWatchPattern(['-x']));
}

// 14. the output directory renders AS ON DISK (0.3.7, user request: "don't
//     filter the output dir — show its subdirectories like the disk does"):
//     the products row used to be a flat list of the top-level files, hiding
//     the per-source-folder mirrors (Core/, User/, ... with their .o/.d/
//     subdir.mk). Now: directories AND files, recursive, nothing filtered.
{
  const outProj = path.join(WS, 'OutTree');
  fs.rmSync(outProj, { recursive: true, force: true });
  const od = path.join(outProj, 'obj');
  fs.mkdirSync(path.join(od, 'Core'), { recursive: true });
  fs.mkdirSync(path.join(od, 'Peripheral', 'src'), { recursive: true });
  fs.writeFileSync(path.join(od, 'Core', 'core_riscv.d'), 'd');
  fs.writeFileSync(path.join(od, 'Core', 'core_riscv.o'), 'o');
  fs.writeFileSync(path.join(od, 'Core', 'subdir.mk'), 'mk');
  fs.writeFileSync(path.join(od, 'Peripheral', 'src', 'y.o'), 'o');
  fs.writeFileSync(path.join(od, 'Demo.elf'), 'elf');
  fs.writeFileSync(path.join(od, 'Demo.hex'), 'hex');
  fs.writeFileSync(path.join(od, 'makefile'), 'all:');
  // a compilable suffix left in the output dir (assembler listing output)
  // must NOT turn the row into a compile target
  fs.writeFileSync(path.join(od, 'listing.s'), '.text');
  fs.writeFileSync(path.join(outProj, '.project'), miniProject('OutTree'));
  const outProject = { ...project, root: outProj, projectName: 'OutTree', buildDir: od, outputDirs: [od] };
  const outStore = {
    all: [outProject],
    solutionList: [],
    active: outProject,
    onDidChange: () => ({ dispose() {} }),
    onTreeDirsChanged: () => ({ dispose() {} }),
  };
  const provider3 = new ProjectTreeProvider(outStore, { joinPath: () => ({ fsPath: '' }) });
  const outProjNode = provider3.getChildren().find((n) => n.nodeType === 'project');
  const outRows = provider3.getChildren(outProjNode);
  const outProducts = outRows.find((n) => n.nodeType === 'products');
  check('output tree: the output dir is still the products row (never a duplicate folder)', !!outProducts && outProducts.fsPath === od && !outRows.some((n) => n !== outProducts && n.fsPath === od));
  const top = provider3.getChildren(outProducts);
  const shape = top.map((n) => `${n.nodeType}:${n.label}`);
  check(
    'output tree: directories first then files — everything on disk is listed',
    JSON.stringify(shape) ===
      JSON.stringify(['outputFolder:Core', 'outputFolder:Peripheral', 'file:Demo.elf', 'file:Demo.hex', 'file:listing.s', 'file:makefile']),
    JSON.stringify(shape)
  );
  const coreNode = top[0];
  check(
    'output tree: a subdirectory is a collapsed outputFolder row at its real path',
    coreNode.nodeType === 'outputFolder' && coreNode.contextValue === 'outputFolder' && coreNode.collapsibleState === 1 && coreNode.fsPath === path.join(od, 'Core')
  );
  const coreKids = provider3.getChildren(coreNode).map((n) => `${n.nodeType}:${n.label}:${n.contextValue}`);
  check(
    'output tree: .o/.d/subdir.mk inside the mirror are outputFile rows',
    JSON.stringify(coreKids) === JSON.stringify(['file:core_riscv.d:outputFile', 'file:core_riscv.o:outputFile', 'file:subdir.mk:outputFile']),
    JSON.stringify(coreKids)
  );
  const srcNode = provider3.getChildren(top[1])[0];
  check(
    'output tree: recursion — Peripheral/src is an outputFolder holding its .o',
    srcNode.nodeType === 'outputFolder' && srcNode.fsPath === path.join(od, 'Peripheral', 'src') && provider3.getChildren(srcNode).length === 1
  );
  const listingNode = top.find((n) => n.label === 'listing.s');
  provider3.getTreeItem(listingNode);
  check('output tree: getTreeItem keeps the outputFile context on a compilable-suffixed artifact', listingNode.contextValue === 'outputFile', String(listingNode.contextValue));
  // identity is stable across renders (scoped fires ride on it)
  const topAgain = provider3.getChildren(outProducts);
  check('output tree: subdirectory node identity is stable across renders', topAgain[0] === coreNode && topAgain[1] === top[1]);
  // a deleted mirror: its own node fires AND the parent (the row goes away)
  const fired = [];
  const sub3 = provider3.onDidChangeTreeData((el) => el && fired.push(el));
  fs.rmSync(path.join(od, 'Core'), { recursive: true, force: true });
  provider3.refreshDirs([path.join(od, 'Core')]);
  sub3.dispose();
  check('output tree: a deleted subdirectory fires its node and the products row', fired.includes(coreNode) && fired.includes(outProducts), fired.map((n) => n.label).join(','));
  const topAfter = provider3.getChildren(outProducts);
  check('output tree: the deleted subdirectory row is gone after the re-read', !topAfter.some((n) => n.label === 'Core') && topAfter[0] === top[1]);
  // context-menu parity: whatever the products row offers, its subdirectories
  // offer too — and never a build-config command
  const pkgOut = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const ctxItems = pkgOut.contributes.menus['view/item/context'];
  const productItems = ctxItems.filter((i) => /viewItem == products\b/.test(i.when || ''));
  check('output tree: the products menu exists (sanity)', productItems.length >= 8, String(productItems.length));
  check('output tree: every products menu item also covers outputFolder', productItems.every((i) => /viewItem == outputFolder\b/.test(i.when)));
  const outputFolderItems = ctxItems.filter((i) => /viewItem == outputFolder\b/.test(i.when || ''));
  check(
    'output tree: no build-config command on output subdirectories',
    !outputFolderItems.some((i) => ['mrvc.excludeFromBuild', 'mrvc.includeFromBuild', 'mrvc.compileFile', 'mrvc.flag', 'mrvc.rename'].includes(i.command)),
    outputFolderItems.map((i) => i.command).join(',')
  );
  fs.rmSync(outProj, { recursive: true, force: true });
}

// ---- decorations: fire ONLY on real content change (user report
// 2026-11-18) — activating/expanding a project re-fed IDENTICAL link/output/
// exclusion sets and the setters fired a full decoration invalidation on
// every feed, repainting every visible row (all projects' file icons
// flickered). Batched feed must fire at most once, identical feeds never.
{
  const { TreeDecorations } = require('../out/vscode/tree.js');
  const deco = new TreeDecorations();
  let fires = 0;
  deco.onDidChangeFileDecorations(() => fires++);
  const feed = () => {
    deco.beginBatch();
    try {
      deco.setLinks([SRC]);
      deco.setOutputs([OBJ]);
      deco.setExcludedByProject(new Map([['proj', [SRC]]]));
      deco.setFlags(new Map());
    } finally {
      deco.endBatch();
    }
  };
  feed(); // first feed carries real content → exactly one fire
  const afterFirst = fires;
  check('deco: a first content feed fires exactly once', afterFirst === 1);
  feed(); // identical feed → nothing
  check('deco: an identical feed fires nothing', fires === afterFirst);
  feed(); // identical again, still nothing
  check('deco: repeated identical feeds stay silent', fires === afterFirst);
  deco.setLinks([SRC, OBJ]); // unbatched single change → one fire
  check('deco: a real unbatched change fires once', fires === afterFirst + 1);
  deco.beginBatch(); // batch with a real change → one fire for the whole feed
  deco.setLinks([SRC]);
  deco.setOutputs([OBJ, SRC]);
  deco.setExcludedByProject(new Map([['proj', [SRC, OBJ]]]));
  deco.setFlags(new Map([['proj', 'red']]));
  deco.endBatch();
  check('deco: a batched feed with changes fires exactly once', fires === afterFirst + 2);
  deco.beginBatch(); // batch without changes → nothing
  deco.setLinks([SRC]);
  deco.setOutputs([OBJ, SRC]);
  deco.setExcludedByProject(new Map([['proj', [SRC, OBJ]]]));
  deco.setFlags(new Map([['proj', 'red']]));
  deco.endBatch();
  check('deco: a batched identical feed fires nothing', fires === afterFirst + 2);
}

// ---- decorations are TREE-ONLY (user report 2026-11-19): VSCode asks every
// registered provider for EVERY view, so Explorer / search rows used to get
// the link/output colours and the UNION of all projects' exclusions. A URI
// without the project key in the resourceUri query must stay untouched.
{
  const { TreeDecorations } = require('../out/vscode/tree.js');
  const deco = new TreeDecorations();
  deco.setLinks([SRC]);
  deco.setOutputs([OBJ]);
  deco.setExcludedByProject(new Map([['proj', [SRC]]]));
  deco.setFlags(new Map([[keyOf(SRC), 'red']]));
  const treeRow = (p) => ({ fsPath: p, query: 'proj' });
  const explorerRow = (p) => ({ fsPath: p });
  check(
    'deco-scope: tree rows keep link/output decorations',
    !!deco.provideFileDecoration(treeRow(SRC)) && !!deco.provideFileDecoration(treeRow(OBJ))
  );
  check(
    'deco-scope: Explorer rows (no project key) stay untouched',
    deco.provideFileDecoration(explorerRow(SRC)) === undefined &&
      deco.provideFileDecoration(explorerRow(OBJ)) === undefined
  );
}

// --- the PRODUCTION end of the same contract: the tree must actually fold
//     real rows into every variant the menus consume (`file.src`,
//     `file.src.excluded`, `file.excluded`, `folder.excluded`) — without
//     these, a gating fix can silently aim at values nothing produces
{
  const ctx = path.join(WS, 'Ctx');
  fs.rmSync(ctx, { recursive: true, force: true });
  fs.mkdirSync(path.join(ctx, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(ctx, 'inc'), { recursive: true });
  fs.mkdirSync(path.join(ctx, 'lib2'), { recursive: true });
  // four linked folders: StdLib pre-excluded by a root token (the state whole-
  // link Exclude From Build writes once the named entry is gone), LibX clean,
  // Alias targeting a directory INSIDE the project root (round1 P2: its logic
  // name differs from the physical dir the link points at), RemovedLink
  // logically removed from the project (round1 P1: must not render a row)
  const stdTarget = path.join(WS, 'CtxLibs', 'StdLib');
  const libxTarget = path.join(WS, 'CtxLibs', 'LibX');
  const rmTarget = path.join(WS, 'CtxLibs', 'RemovedLink');
  const aliasTarget = path.join(ctx, 'Shared');
  fs.mkdirSync(stdTarget, { recursive: true });
  fs.mkdirSync(libxTarget, { recursive: true });
  fs.mkdirSync(rmTarget, { recursive: true });
  fs.mkdirSync(path.join(aliasTarget, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(stdTarget, 's.c'), 'int s(){return 3;}\n');
  fs.writeFileSync(path.join(libxTarget, 'x.c'), 'int x(){return 4;}\n');
  fs.writeFileSync(path.join(aliasTarget, 'sub', 'x.c'), 'int a(){return 5;}\n');
  fs.writeFileSync(path.join(ctx, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(path.join(ctx, 'lib', 'helper.c'), 'int h(){return 1;}\n');
  fs.writeFileSync(path.join(ctx, 'inc', 'app.h'), '#pragma once\n');
  fs.writeFileSync(path.join(ctx, 'lib2', 'x.c'), 'int x(){return 2;}\n');
  fs.writeFileSync(
    path.join(ctx, '.project'),
    `<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>Ctx</name><linkedResources>` +
    `<link><name>StdLib</name><type>2</type><location>${stdTarget}</location></link>` +
    `<link><name>LibX</name><type>2</type><location>${libxTarget}</location></link>` +
    `<link><name>Alias</name><type>2</type><location>${aliasTarget}</location></link>` +
    `<link><name>RemovedLink</name><type>2</type><location>${rmTarget}</location></link>` +
    `</linkedResources></projectDescription>`
  );
  // logical removal via the real API so the filter XML shape stays canonical
  require('../out/core/projectFile.js').appendRemovedResource(ctx, '', 'removedlink', true);
  fs.writeFileSync(
    path.join(ctx, '.cproject'),
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?fileVersion 4.0.0?><cproject storage_type_id="org.eclipse.cdt.core.XmlProjectDescriptionStorage">
\t<storageModule moduleId="org.eclipse.cdt.core.settings">
\t\t<cconfiguration id="c1">
\t\t\t<storageModule moduleId="cdtBuildSystem" version="4.0.0">
\t\t\t\t<configuration id="c1" artifactName="Ctx" artifactExtension="elf" name="obj">
\t\t\t\t\t<toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release"/>
\t\t\t\t\t<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="" excluding="lib/helper.c|inc/app.h|lib2|StdLib"/></sourceEntries>
\t\t\t\t</configuration>
\t\t\t</storageModule>
\t\t</cconfiguration>
\t</storageModule>
</cproject>
`,
    'utf-8'
  );
  const { MrsProject } = require('../out/vscode/projects.js');
  const mpCtx = new MrsProject(ctx);
  const ctxStore = {
    all: [mpCtx],
    solutionList: [],
    active: mpCtx,
    onDidChange: () => ({ dispose() {} }),
    onTreeDirsChanged: () => ({ dispose() {} }),
    reloadProject: () => {},
  };
  const provider3 = new ProjectTreeProvider(ctxStore, { joinPath: () => ({ fsPath: '' }) });
  const ctxProj = provider3.getChildren().find((n) => n.nodeType === 'project');
  const lvl = provider3.getChildren(ctxProj);
  // context values are folded in getTreeItem (VSCode calls it per rendered
  // row) — the raw getChildren node still carries the bare nodeType, so every
  // assertion below must pass through the real getChildren → getTreeItem pipe
  const rendered = (p, prov) => {
    prov = prov || provider3;
    const top = prov.getChildren(prov.getChildren().find((n) => n.nodeType === 'project'));
    const node = top.find((n) => n.fsPath === p) ||
      prov.getChildren(top.find((n) => n.fsPath === path.dirname(p))).find((n) => n.fsPath === p);
    return node ? prov.getTreeItem(node).contextValue : `<row not found: ${p}>`;
  };
  check('ctx: non-excluded .c folds to file.src', rendered(path.join(ctx, 'main.c')) === 'file.src',
    rendered(path.join(ctx, 'main.c')));
  check('ctx: excluded .c folds to file.src.excluded', rendered(path.join(ctx, 'lib', 'helper.c')) === 'file.src.excluded',
    rendered(path.join(ctx, 'lib', 'helper.c')));
  check('ctx: excluded .h folds to file.excluded', rendered(path.join(ctx, 'inc', 'app.h')) === 'file.excluded',
    rendered(path.join(ctx, 'inc', 'app.h')));
  check('ctx: non-excluded folder stays plain folder', rendered(path.join(ctx, 'lib')) === 'folder',
    rendered(path.join(ctx, 'lib')));
  check('ctx: excluded folder folds to folder.excluded', rendered(path.join(ctx, 'lib2')) === 'folder.excluded',
    rendered(path.join(ctx, 'lib2')));
  // whole-link state (0.3.5, MRS parity): the link row itself folds
  check('ctx: excluded whole link folds to linkedFolder.excluded', rendered(stdTarget) === 'linkedFolder.excluded',
    rendered(stdTarget));
  check('ctx: clean link folds to plain linkedFolder', rendered(libxTarget) === 'linkedFolder',
    rendered(libxTarget));
  // round1 P1: a logically-removed ROOT-level link must not render a row
  // removedlink (lowercase) vs the RemovedLink link — the scanner folds on
  // Windows, so the TREE must fold too or the row would render while its
  // content is already hidden (round2 P3; on case-sensitive platforms both
  // sides treat the spelling as a different name and the row stays)
  const expectRfHidden = process.platform === 'win32';
  check(
    'ctx: removed root link row is hidden (case-folded on win32)',
    lvl.some((n) => n.fsPath === rmTarget) === !expectRfHidden,
    JSON.stringify(lvl.filter((n) => n.nodeType === 'linkedFolder').map((n) => n.fsPath)));
  // round1 P2 fixture: the root-internal link Alias points at ctx/Shared —
  // rendered before its exclusion round below
  check('ctx: root-internal link folds to plain linkedFolder', rendered(aliasTarget) === 'linkedFolder',
    rendered(aliasTarget));

  // command layer end-to-end: Exclude/Include From Build must accept the
  // linkedFolder ROW (the glue that historically whitelisted file/folder)
  const { excludeFromBuild, includeFromBuild } = require('../out/vscode/exclude.js');
  const { Cproject } = require('../out/core/cproject.js');
  const libxRow = lvl.find((n) => n.fsPath === libxTarget);
  asyncChecks.push(
    excludeFromBuild(ctxStore, libxRow)
      .then(() => {
        const toks = Cproject.load(ctx).sourceEntries.find((e) => e.name === '').excluding;
        check('link-cmd: exclude wrote the link-name token', toks.includes('LibX'), toks.join('|'));
        check('link-cmd: no error path fired', !uiMessages.some(([k]) => k === 'error'), JSON.stringify(uiMessages));
        // fresh provider = post-reload state: the row now folds excluded
        const mp2 = new MrsProject(ctx);
        const prov2 = new ProjectTreeProvider({ all: [mp2], solutionList: [], active: mp2, onDidChange: () => ({ dispose() {} }), onTreeDirsChanged: () => ({ dispose() {} }) }, { joinPath: () => ({ fsPath: '' }) });
        check('link-cmd: row refolds to linkedFolder.excluded', rendered(libxTarget, prov2) === 'linkedFolder.excluded',
          rendered(libxTarget, prov2));
        const row2 = prov2.getChildren(prov2.getChildren().find((n) => n.nodeType === 'project')).find((n) => n.fsPath === libxTarget);
        return includeFromBuild(ctxStore, row2).then(() => {
          const toks2 = Cproject.load(ctx).sourceEntries.find((e) => e.name === '').excluding;
          check('link-cmd: include removed the token again', !toks2.includes('LibX'), toks2.join('|'));
          const mp3 = new MrsProject(ctx);
          const prov3 = new ProjectTreeProvider({ all: [mp3], solutionList: [], active: mp3, onDidChange: () => ({ dispose() {} }), onTreeDirsChanged: () => ({ dispose() {} }) }, { joinPath: () => ({ fsPath: '' }) });
          check('link-cmd: row refolds back to plain linkedFolder', rendered(libxTarget, prov3) === 'linkedFolder',
            rendered(libxTarget, prov3));
          // round1 P2: a link INSIDE the project root must exclude under its
          // LINK name (Alias), not the physical directory it points at (Shared)
          const aliasRow = prov3.getChildren(prov3.getChildren().find((n) => n.nodeType === 'project')).find((n) => n.fsPath === aliasTarget);
          const { scanSources: scanSrc } = require('../out/core/scan.js');
          return excludeFromBuild(ctxStore, aliasRow).then(() => {
            const toks3 = Cproject.load(ctx).sourceEntries.find((e) => e.name === '').excluding;
            check('alias-cmd: exclude wrote the LINK name', toks3.includes('Alias') && !toks3.includes('Shared'), toks3.join('|'));
            const scanAfter = [...scanSrc(Cproject.load(ctx)).values()].flat().map((x) => x.logicName);
            check('alias-cmd: link logic tree dropped from scan', !scanAfter.includes('Alias/sub/x.c'), scanAfter.join(','));
            check('alias-cmd: the physical directory keeps scanning', scanAfter.includes('Shared/sub/x.c'), scanAfter.join(','));
            const mp4 = new MrsProject(ctx);
            const prov4 = new ProjectTreeProvider({ all: [mp4], solutionList: [], active: mp4, onDidChange: () => ({ dispose() {} }), onTreeDirsChanged: () => ({ dispose() {} }) }, { joinPath: () => ({ fsPath: '' }) });
            check('alias-cmd: row refolds to linkedFolder.excluded', rendered(aliasTarget, prov4) === 'linkedFolder.excluded',
              rendered(aliasTarget, prov4));
            const row4 = prov4.getChildren(prov4.getChildren().find((n) => n.nodeType === 'project')).find((n) => n.fsPath === aliasTarget);
            return includeFromBuild(ctxStore, row4).then(() => {
              const toks4 = Cproject.load(ctx).sourceEntries.find((e) => e.name === '').excluding;
              check('alias-cmd: include removed the Alias token', !toks4.includes('Alias'), toks4.join('|'));
              const scanBack = [...scanSrc(Cproject.load(ctx)).values()].flat().map((x) => x.logicName);
              check('alias-cmd: link logic tree scans again', scanBack.includes('Alias/sub/x.c'), scanBack.join(','));
              // round2 P2: a CHILD under the root-internal link must key on the
              // LINK logic path (Alias/sub/x.c), not the physical path its
              // fsPath suggests — the linkedName has to propagate down
              const mp5 = new MrsProject(ctx);
              const prov5 = new ProjectTreeProvider({ all: [mp5], solutionList: [], active: mp5, onDidChange: () => ({ dispose() {} }), onTreeDirsChanged: () => ({ dispose() {} }) }, { joinPath: () => ({ fsPath: '' }) });
              const proj5 = prov5.getChildren().find((n) => n.nodeType === 'project');
              const aliasRow5 = prov5.getChildren(proj5).find((n) => n.fsPath === aliasTarget);
              const subRow5 = prov5.getChildren(aliasRow5).find((n) => n.fsPath === path.join(aliasTarget, 'sub'));
              const xcRow5 = prov5.getChildren(subRow5).find((n) => n.fsPath === path.join(aliasTarget, 'sub', 'x.c'));
              check('alias-child: descendant rows carry the link root', !!xcRow5 && xcRow5.linkedName === 'Alias', `${!!subRow5}/${!!xcRow5}/${xcRow5 && xcRow5.linkedName}`);
              return excludeFromBuild(ctxStore, xcRow5).then(() => {
                const toks5 = Cproject.load(ctx).sourceEntries.find((e) => e.name === '').excluding;
                // the token lands in the root entry (full path) OR — when the
                // whole-link include round rebuilt the paired named entry — in
                // the named `Alias` entry (folder-relative, MRS2 convention);
                // either way the LINK logic tree must be the target
                const cpAfter = Cproject.load(ctx);
                const rootTok = cpAfter.sourceEntries.find((e) => e.name === '').excluding;
                const aliasEntry = cpAfter.sourceEntries.find((e) => e.name === 'Alias');
                const aliasTok = aliasEntry ? aliasEntry.excluding : [];
                const wroteLink =
                  (rootTok.includes('Alias/sub/x.c') && !rootTok.includes('Shared/sub/x.c')) || aliasTok.includes('sub/x.c');
                check('alias-child: exclude wrote the LINK logic token', wroteLink, `root=[${rootTok.join('|')}] alias=[${aliasTok.join('|')}]`);
                const scan5 = [...scanSrc(Cproject.load(ctx)).values()].flat().map((x) => x.logicName);
                check('alias-child: link logic file dropped from scan', !scan5.includes('Alias/sub/x.c'), scan5.join(','));
                check('alias-child: physical file keeps scanning', scan5.includes('Shared/sub/x.c'), scan5.join(','));
                const mp6 = new MrsProject(ctx);
                const prov6 = new ProjectTreeProvider({ all: [mp6], solutionList: [], active: mp6, onDidChange: () => ({ dispose() {} }), onTreeDirsChanged: () => ({ dispose() {} }) }, { joinPath: () => ({ fsPath: '' }) });
                const proj6 = prov6.getChildren().find((n) => n.nodeType === 'project');
                const aliasRow6 = prov6.getChildren(proj6).find((n) => n.fsPath === aliasTarget);
                const xcRow6 = prov6.getChildren(prov6.getChildren(aliasRow6).find((n) => n.fsPath === path.join(aliasTarget, 'sub'))).find((n) => n.fsPath === path.join(aliasTarget, 'sub', 'x.c'));
                prov6.getTreeItem(xcRow6);
                check('alias-child: row folds to file.src.excluded', xcRow6.contextValue === 'file.src.excluded', xcRow6.contextValue);
                return includeFromBuild(ctxStore, xcRow6).then(() => {
                  const toks6 = Cproject.load(ctx).sourceEntries.find((e) => e.name === '').excluding;
                  check('alias-child: include removed the LINK logic token', !toks6.includes('Alias/sub/x.c'), toks6.join('|'));
                  const scan6 = [...scanSrc(Cproject.load(ctx)).values()].flat().map((x) => x.logicName);
                  check('alias-child: link logic file scans again', scan6.includes('Alias/sub/x.c'), scan6.join(','));
                  // round3 P2: the remaining three consumers (Remove / Copy
                  // Project Relative Path / Compile Single File) must key on
                  // the link logic path too — placed BEFORE the alias-removed
                  // round, which hides the sub row from expansion
                  const { copyProjectRelativePath, deleteNode } = require('../out/vscode/fileOps.js');
                  const { nodeLogicPath: nlp } = require('../out/vscode/logicPath.js');
                  const { objectTargetFor } = require('../out/core/makefile.js');
                  const i18nMod = require('../out/core/i18n.js');
                  const mp8 = new MrsProject(ctx);
                  const prov8 = new ProjectTreeProvider({ all: [mp8], solutionList: [], active: mp8, onDidChange: () => ({ dispose() {} }), onTreeDirsChanged: () => ({ dispose() {} }) }, { joinPath: () => ({ fsPath: '' }) });
                  const proj8 = prov8.getChildren().find((n) => n.nodeType === 'project');
                  const subRow8 = prov8.getChildren(prov8.getChildren(proj8).find((n) => n.fsPath === aliasTarget)).find((n) => n.fsPath === path.join(aliasTarget, 'sub'));
                  const xcRow8 = prov8.getChildren(subRow8).find((n) => n.fsPath === path.join(aliasTarget, 'sub', 'x.c'));
                  check('ops-seam: nodeLogicPath on the row is the link logic file', nlp(xcRow8) === 'Alias/sub/x.c', nlp(xcRow8));
                  check('ops-seam: link logic file targets Alias/sub/x.o', objectTargetFor('Alias/sub/x.c') === 'Alias/sub/x.o');
                  clipboardText = '';
                  return copyProjectRelativePath(xcRow8).then(() => {
                    check('ops: copy relative yields the link logic path', clipboardText === '${workspace_loc:/${ProjName}/Alias/sub/x.c}', clipboardText);
                    warnPick = i18nMod.t('remove');
                    const mp9 = new MrsProject(ctx);
                    const prov9 = new ProjectTreeProvider({ all: [mp9], solutionList: [], active: mp9, onDidChange: () => ({ dispose() {} }), onTreeDirsChanged: () => ({ dispose() {} }) }, { joinPath: () => ({ fsPath: '' }) });
                    const subRow9 = prov9.getChildren(prov9.getChildren(prov9.getChildren().find((n) => n.nodeType === 'project')).find((n) => n.fsPath === aliasTarget)).find((n) => n.fsPath === path.join(aliasTarget, 'sub'));
                    const xcRow9 = prov9.getChildren(subRow9).find((n) => n.fsPath === path.join(aliasTarget, 'sub', 'x.c'));
                    return deleteNode(xcRow9).then(() => {
                      const rem = require('../out/core/projectFile.js').listRemovedResources(ctx).find((r) => r.name === 'x.c');
                      check('ops: remove wrote parentLogic=Alias/sub', !!rem && rem.parentLogic === 'Alias/sub' && !rem.isFolder, JSON.stringify(rem));
                      const scan8 = [...scanSrc(Cproject.load(ctx)).values()].flat().map((x) => x.logicName);
                      check('ops: removed link file out of scan, physical stays', !scan8.includes('Alias/sub/x.c') && scan8.includes('Shared/sub/x.c'), scan8.join(','));
                    });
                  });
                  // second manifestation: logical removal UNDER the link must
                  // hide the expanded child (the tree's parentLogic used to
                  // resolve to the physical directory and miss the entry)
                  require('../out/core/projectFile.js').appendRemovedResource(ctx, 'Alias', 'sub', true);
                  const mp7 = new MrsProject(ctx);
                  const prov7 = new ProjectTreeProvider({ all: [mp7], solutionList: [], active: mp7, onDidChange: () => ({ dispose() {} }), onTreeDirsChanged: () => ({ dispose() {} }) }, { joinPath: () => ({ fsPath: '' }) });
                  const proj7 = prov7.getChildren().find((n) => n.nodeType === 'project');
                  const aliasRow7 = prov7.getChildren(proj7).find((n) => n.fsPath === aliasTarget);
                  const childNames = prov7.getChildren(aliasRow7).map((n) => n.label);
                  check('alias-removed: removed sub folder hidden in expansion', !childNames.includes('sub'), JSON.stringify(childNames));
                  const scan7 = [...scanSrc(Cproject.load(ctx)).values()].flat().map((x) => x.logicName);
                  check('alias-removed: scan agrees with the tree', !scan7.includes('Alias/sub/x.c') && scan7.includes('Shared/sub/x.c'), scan7.join(','));
                });
              });
            });
          });
        });
      })
      .catch((e) => {
        failures += 1;
        console.log(`FAIL  link-cmd: threw — ${e && e.message}`);
      })
      .finally(() => fs.rmSync(ctx, { recursive: true, force: true }))
  );
}

// --- menu when-clauses must cover every context value the tree can produce
// (user report: .c files lost Include/Exclude From Build — 0.3.4 introduced
// `file.src` for the compile menu but the exclude/include gating still listed
// only the bare `file`/`folder` variants, so `file.src` and `file.src.excluded`
// matched nothing) ---
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const items = pkg.contributes.menus['view/item/context'];
  const whenOf = (cmd) => (items.find((i) => i.command === cmd) || {}).when || '';
  // extract the viewItem alternation from the anchored regex form and rebuild
  // a REAL regex — the same semantics VSCode applies to `viewItem =~ /…/`
  const rxOf = (when) => {
    const m = when.match(/viewItem =~ \/\^\((.*?)\)\$\//);
    return m ? new RegExp('^(' + m[1] + ')$') : null;
  };
  const excl = rxOf(whenOf('mrvc.excludeFromBuild'));
  const incl = rxOf(whenOf('mrvc.includeFromBuild'));
  check('menu: exclude gating parses as the anchored regex form', !!excl);
  check('menu: include gating parses as the anchored regex form', !!incl);
  for (const v of ['file', 'file.src', 'folder', 'linkedFolder']) {
    check(`menu: Exclude From Build shows on ${v}`, !!excl && excl.test(v));
    check(`menu: Exclude From Build hidden on ${v}.excluded`, !!excl && !excl.test(`${v}.excluded`));
  }
  for (const v of ['file.excluded', 'file.src.excluded', 'folder.excluded', 'linkedFolder.excluded']) {
    check(`menu: Include From Build shows on ${v}`, !!incl && incl.test(v));
  }
  for (const v of ['file', 'file.src', 'folder', 'linkedFolder', 'outputFile', 'products', 'project', 'solution']) {
    check(`menu: Include From Build hidden on ${v}`, !!incl && !incl.test(v));
  }
}

Promise.all(asyncChecks).then(() => process.exit(failures ? 1 : 0));
})();
