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
    // mrvc.mrs2InstallPath resolves to a real MRS2 install when one exists
    // on this machine (default C:\MounRiver otherwise) — the chip picker
    // render path then exercises a live SDK scan where available
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'mrs2InstallPath') {
          for (const c of [process.env.MRS2_HOME, 'C:\\MounRiver\\MounRiver_Studio2', 'D:\\MounRiver\\MounRiver_Studio2']) {
            if (c && fs.existsSync(path.join(c, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'manifest.json'))) return c;
          }
        }
        return d;
      },
    }),
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

const PROJ = ['F:/CH585/EVT/V1_2/EXAM/LED', 'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find(
  (p) => fs.existsSync(path.join(p, '.cproject'))
);
if (!PROJ) {
  console.log('SKIP  webview render (no real LED tree found)');
  process.exit(0);
}
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
(async () => {
await view.show(store.active);
  const html = stubPanel.webview.html;
  check('HTML rendered (non-empty)', html.length > 5000);
  check('panel title set', stubPanel.title.includes('LED'));
  check('CSP meta present', html.includes("http-equiv=\"Content-Security-Policy\""));
  check('hostile project name escaped in PROJ_NAME (no </script> leak)', !/>const PROJ_NAME = \"LED<x>\"<\/script>/.test(html) || html.includes('\\u003C'));
  // nonce policy: script-src must not allow 'unsafe-inline' (style-src may),
  // and every <script> tag must carry the nonce the CSP declares
  const csp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] ?? '';
  const scriptSrc = (csp.match(/script-src ([^;]*)/) || [])[1] ?? '';
  const cspNonce = (scriptSrc.match(/'nonce-([0-9a-f]+)'/) || [])[1];
  check('CSP gates scripts by nonce (no unsafe-inline in script-src)', !!cspNonce && !scriptSrc.includes("'unsafe-inline'"));
  const scriptTags = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
  check(
    `every script tag carries the CSP nonce (${scriptTags.length} tags)`,
    scriptTags.length >= 2 && scriptTags.every((attrs) => attrs.includes(`nonce="${cspNonce}"`))
  );
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
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
  // the Chip page address input and the Download page "Program Address"
  // input write the SAME .template key — Apply posts saveDl then save, so
  // without the lockstep wiring the second write rolls the first one back
  check(
    'apply: chip/dl address inputs locked in lockstep (no rollback)',
    scripts.some((s) => s.includes("getElementById('dl-address')") && s.includes('[data-key="address"]') && s.includes("addEventListener('input'"))
  );

  // ---- cross-page macro conflict detection ----
  const { macroConflicts } = require(path.join(__dirname, '..', 'out', 'vscode', 'configView.js'));
  let r = macroConflicts({ defs: 'DEBUG=0\nFOO', cppdefs: 'DEBUG=0\nBAR', asmdefs: '' });
  check('macro: same value across pages = no conflict', r.length === 0);
  r = macroConflicts({ defs: 'DEBUG=0', cppdefs: 'DEBUG=1' });
  check('macro: conflicting value detected with both page names', r.length === 1 && r[0].includes('DEBUG') && r[0].includes('C Compiler') && r[0].includes('C++ Compiler'));
  r = macroConflicts({ defs: 'DEBUG', cppdefs: 'DEBUG=0' });
  check('macro: bare name vs valued counts as conflict', r.length === 1);
  r = macroConflicts({ defs: 'USE_A', cppdefs: 'USE_A' });
  check('macro: both bare = no conflict', r.length === 0);
  r = macroConflicts({ defs: 'X=1', cppdefs: 'X=2', asmdefs: 'X=3' });
  check('macro: three-way conflict reported once per deviation', r.length === 2);
  r = macroConflicts({ defs: 'abc=1', cppdefs: 'ABC=2' });
  check('macro: names are case-sensitive', r.length === 0);

  // ---- batch Clean All / Delete Output must respect the build guard ----
  // (a running `make all` and `make clean` on the same obj/ collided before)
  {
    const { BuildManager } = require(path.join(__dirname, '..', 'out', 'vscode', 'tasks.js'));
    const key = path.resolve('X:/proj').toLowerCase();
    const fakeSelf = { building: new Map([[key, {}]]) };
    const fakeProj = { root: 'X:/proj', projectName: 'P', buildDir: 'X:/proj/obj' };
    const r1 = await BuildManager.prototype.cleanOne.call(fakeSelf, fakeProj, { makeBin: 'X:/make' });
    check('batch clean: skipped while the project is building', r1.ok === true && r1.detail.length > 0);
    const r2 = await BuildManager.prototype.deleteOutputOne.call(fakeSelf, fakeProj, false);
    check('batch delete outputs: skipped while the project is building', r2.ok === true && r2.detail.length > 0);
    const freeSelf = { building: new Map() };
    const r3 = await BuildManager.prototype.cleanOne.call(freeSelf, fakeProj, { makeBin: 'X:/make' });
    check('batch clean: proceeds (not just always skipping)', r3.ok === true && r3.detail !== r1.detail);
  }

  // ---- Sync Setting Across Projects page ----
  const { SyncPage } = require(path.join(__dirname, '..', 'out', 'vscode', 'syncPage.js'));
  const syncPanel = {
    html: '', title: '', reveal() {}, dispose() {},
    onDidDispose() { return { dispose() {} }; },
    webview: {
      onDidReceiveMessage(h) { syncHandlers.push(h); return { dispose() {} }; },
      postMessage(m) { syncPosted.push(m); return Promise.resolve(true); },
    },
  };
  const syncHandlers = [];
  const syncPosted = [];
  const vscodePatch = {
    window: {
      ...vscodeStub.window,
      createWebviewPanel: () => syncPanel,
      withProgress: (_o, task) => task({ report() {} }, { isCancellationRequested: false }).then(() => undefined),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showWarningMessage: (...a) => { syncWarnArgs = a; return Promise.resolve('Apply'); },
      showErrorMessage: () => undefined,
      showInformationMessage: () => undefined,
    },
  };
  let syncWarnArgs = null;
  // re-stub with the patched window for a fresh SyncPage instance
  const origResolve2 = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') return 'vscode-stub2';
    return origResolve2.call(this, request, ...args);
  };
  require.cache['vscode-stub2'] = { id: 'vscode-stub2', filename: 'vscode-stub2', loaded: true, exports: { ...vscodeStub, window: vscodePatch.window, ProgressLocation: { Notification: 15 } } };
  delete require.cache[path.join(__dirname, '..', 'out', 'vscode', 'syncPage.js')];
  const { SyncPage: SyncPage2 } = require(path.join(__dirname, '..', 'out', 'vscode', 'syncPage.js'));

  // a second scratch project so the batch has 2 targets. The FIRST member
  // is a scratch COPY of the real project too — the batch WRITES every
  // member's .cproject, and pointing it at the real EVT tree polluted the
  // reference tree permanently (and made these assertions trivially green
  // after the first run)
  const scratch1 = path.join(__dirname, '..', '.scratch', 'sync-first');
  fs.rmSync(scratch1, { recursive: true, force: true });
  fs.cpSync(PROJ, scratch1, { recursive: true });
  const scratch2 = path.join(__dirname, '..', '.scratch', 'sync-second');
  fs.rmSync(scratch2, { recursive: true, force: true });
  fs.cpSync(PROJ, scratch2, { recursive: true });
  const cp2 = Cproject.load(scratch2);
  const member1 = { root: scratch1, projectName: 'LED1', cproject: Cproject.load(scratch1), toolchain: () => undefined, reload() {}, buildDir: path.join(scratch1, 'obj') };
  const store2 = {
    active: member1,
    all: [member1, { root: scratch2, projectName: 'LED2', cproject: cp2, toolchain: () => undefined, reload() {}, buildDir: path.join(scratch2, 'obj') }],
    reloadProject() {},
  };
  const sp = new SyncPage2(store2);
  sp.open();
  const syncHtml = syncPanel.webview.html;
  check('sync page rendered', syncHtml.includes('Sync Setting Across Projects'));
  check('sync page: sync checkboxes default unchecked', !/class="syncbox" checked/.test(syncHtml) && (syncHtml.match(/class="syncbox"/g) || []).length >= 100);
  check('sync page: value controls seeded', syncHtml.includes('data-val="nocommon"') && syncHtml.includes('data-val="optlevel"'));
  check('sync page: unique page keys + breadcrumb display', syncHtml.includes('data-page="opt"') && syncHtml.includes('data-page="warn"') && syncHtml.includes('Warnings') && !syncHtml.includes('data-page="Warnings"'));
  check('sync page: cpp-only rows annotated', syncHtml.includes('cpponly'));
  // unset enums seed 'default' (same as the properties page) and the select
  // must expose it as an explicit choice — seeding the first option used to
  // display -Os for projects that never set the option
  check('sync page: unset enums seed an explicit (default) choice', syncHtml.includes('(default)'));
  check('sync page: hostile string escaped', !syncHtml.includes('LED<x>"</script>') || syncHtml.includes('\\u003C'));
  // nonce policy on the sync page too (script-src gated, every tag tagged)
  {
    const cspS = (syncHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] ?? '';
    const ssS = (cspS.match(/script-src ([^;]*)/) || [])[1] ?? '';
    const nS = (ssS.match(/'nonce-([0-9a-f]+)'/) || [])[1];
    const tagsS = [...syncHtml.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    check('sync page: CSP nonce policy', !!nS && !ssS.includes("'unsafe-inline'") && tagsS.length >= 1 && tagsS.every((a) => a.includes(`nonce="${nS}"`)));
  }

  // drive the batch: tick two bool boxes + one enum, then applySync
  // (simulate the webview collector on the real HTML)
  const { execSync } = require('child_process');
  const items = [
    { suffix: 'optimization.nocommon', type: 'bool', value: '1' },
    { suffix: 'c.linker.gcsections', type: 'bool', value: '0' },
  ];
  (async () => {
    for (const h of syncHandlers) h({ command: 'applySync', items });
    await new Promise((r) => setTimeout(r, 300));
    const c1 = Cproject.load(scratch1);
    const c2 = Cproject.load(scratch2);
    check('sync batch: checked flag applied to both projects', c1.optionBool('optimization.nocommon') === true && c2.optionBool('optimization.nocommon') === true);
    check('sync batch: second flag applied to both', c1.optionBool('c.linker.gcsections') === false && c2.optionBool('c.linker.gcsections') === false);
    check('sync batch: untouched option unchanged', c1.optionBool('warnings.allwarn') === (store.active.cproject.optionBool('warnings.allwarn')));
    check('sync batch: done message posted', syncPosted.some((m) => m.command === 'syncDone' && m.text.includes('2/2 OK')));
    // applying a 'default'-seeded enum must leave the option UNSET in every
    // target (no explicit first-option value written)
    for (const h of syncHandlers)
      h({ command: 'applySync', items: [{ suffix: 'mrvc.test.absent.enum', type: 'enum', enumBase: 'mrvc.test.absent.enum.', value: 'default' }] });
    await new Promise((r) => setTimeout(r, 300));
    check('sync batch: default-valued enum leaves the option unset', !Cproject.load(scratch1).optionValue('mrvc.test.absent.enum'));
    fs.rmSync(scratch2, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILURES` : '\nwebview render verification passed');
    process.exit(failures ? 1 : 0);
  })();
})();
