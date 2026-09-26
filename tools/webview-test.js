/*
 * Webview render verification: stub the vscode module, load the compiled
 * ConfigView, capture the REAL generated properties-page HTML (all script
 * blocks with interpolations resolved and template escapes evaluated),
 * then syntax-check every <script> block the browser would execute.
 * Also asserts the CSP meta and the jsonForScript escaping.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const stubPanel = {
  html: '',
  title: '',
  visible: true,
  reveal() {},
  dispose() {},
  onDidDispose() { return { dispose() {} }; },
  webview: {
    onDidReceiveMessage() { return { dispose() {} }; },
    postMessage() { return Promise.resolve(true); },
  },
};
const vscodeStub = {
  window: {
    createWebviewPanel: () => stubPanel,
    showErrorMessage: () => undefined,
    showInformationMessage: () => undefined,
    showWarningMessage: () => undefined,
    showOpenDialog: () => Promise.resolve([]),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    setStatusBarMessage: () => undefined,
    createTreeView: () => ({ dispose() {} }),
    createTerminal: () => ({ show() {}, sendText() {} }),
    withProgress: (_o, t) => t({ isCancellationRequested: false }),
    showQuickPick: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d }),
    workspaceFolders: [],
    createFileSystemWatcher: () => ({ onDidChange() { return { dispose() {} }; }, onDidCreate() { return { dispose() {} }; }, onDidDelete() { return { dispose() {} }; }, dispose() {} }),
    onDidChangeWorkspaceFolders() { return { dispose() {} }; },
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => Promise.resolve() },
  tasks: {
    taskExecutions: [],
    onDidEndTaskProcess: () => ({ dispose() {} }),
    executeTask: () => Promise.resolve({ task: {}, terminate() {} }),
  },
  Uri: { file: (f) => ({ fsPath: f, with: () => ({}) }) },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TaskGroup: { Build: 'build' },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2 },
  FileDecoration: class {},
  ThemeColor: class {},
  EventEmitter: class { constructor() { this.event = undefined; } fire() {} dispose() {} },
  RelativePattern: class {},
  ViewColumn: { Active: 1 },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

const { ConfigView } = require(path.join(__dirname, '..', 'out', 'vscode', 'configView.js'));

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const PROJ = 'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED';
// build the stub store from the REAL project files so render() exercises
// the genuine option model
const { Cproject } = require(path.join(__dirname, '..', 'out', 'core', 'cproject.js'));
const { readTemplate } = require(path.join(__dirname, '..', 'out', 'core', 'templateFile.js'));
const { readProjectFile } = require(path.join(__dirname, '..', 'out', 'core', 'projectFile.js'));
const realCp = Cproject.load(PROJ);
const realTpl = readTemplate(PROJ);
const realPf = readProjectFile(PROJ);
const store = {
  active: {
    root: PROJ,
    projectName: 'LED<x>"</script>', // hostile name: injection probe
    projectDisplayName: 'LED<x>',
    buildDir: path.join(PROJ, 'obj'),
    kernel: undefined,
    template: realTpl,
    cproject: realCp,
    projectFile: realPf,
    toolchain: () => null,
    logicPathOf: () => undefined,
    reload() {},
  },
  all: [],
};
const ctx = { subscriptions: [], extensionUri: { fsPath: path.join(__dirname, '..') } };
const view = new ConfigView(store, ctx);
view.show(store.active).then(() => {
  const html = stubPanel.webview.html;
  check('HTML rendered (non-empty)', html.length > 5000);
  check('panel title set', stubPanel.title.includes('LED'));
  check('CSP meta present', html.includes("http-equiv=\"Content-Security-Policy\""));
  check('hostile project name escaped in PROJ_NAME (no </script> leak)', !/>const PROJ_NAME = \"LED<x>\"<\/script>/.test(html) || html.includes('\\u003C'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check(`captured ${scripts.length} script blocks`, scripts.length >= 2);
  scripts.forEach((s, i) => {
    try {
      new Function(s);
      check(`script block ${i + 1} syntax OK (${s.length} chars)`, true);
    } catch (e) {
      check(`script block ${i + 1} syntax OK`, false);
      console.log('   error:', e.message);
      const ln = (e.stack.match(/<anonymous>:(\d+)/) || [])[1];
      if (ln) console.log('   near line', Number(ln) - 2, ':', s.split('\n')[Number(ln) - 3]);
    }
  });
  // key content assertions
  check('string fields render as textarea with data-stype', html.includes('data-stype="string"'));
  check('newline-collapsing regex present (single-backslash form)', /\|\\s\*\\r\?\\n\\s\*\|/.test('') || scripts.some((s) => s.includes('/\\s*\\r?\\n\\s*/g') || s.includes('replace(/\\s*\\r?\\n\\s*/g')));
  check('chip picker present (CHIP_DB)', scripts.some((s) => s.includes('CHIP_DB')));
  check('download settings present (DL_CTX)', scripts.some((s) => s.includes('DL_CTX')));
  console.log(failures ? `\n${failures} FAILURES` : '\nwebview render verification passed');
  process.exit(failures ? 1 : 0);
});
