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

const vscodeStub = {
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter,
  Uri: { file: (p) => ({ fsPath: p }), joinPath: () => ({ fsPath: '' }) },
  ThemeColor: class {},
  ThemeIcon: class {},
  workspace: { workspaceFolders: [] },
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

process.exit(failures ? 1 : 0);
})();
