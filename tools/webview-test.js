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
    // render path then exercises a live SDK scan where available. The
    // extension requires a CONFIGURED install, so the stub models the setting
    // the way a real settings.json would: a global value that `inspect` reports.
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'mrs2InstallPath') {
          for (const c of [process.env.MRS2_HOME, 'C:\\MounRiver\\MounRiver_Studio2', 'D:\\MounRiver\\MounRiver_Studio2']) {
            if (c && fs.existsSync(path.join(c, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'manifest.json'))) return c;
          }
        }
        return d;
      },
      inspect: (k) => ({
        key: 'mrvc.' + k,
        globalValue:
          k === 'mrs2InstallPath'
            ? [process.env.MRS2_HOME, 'C:\\MounRiver\\MounRiver_Studio2', 'D:\\MounRiver\\MounRiver_Studio2'].find(
                (c) => c && fs.existsSync(path.join(c, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'manifest.json'))
              )
            : undefined,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
      }),
      update: async () => {},
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
  QuickPickItemKind: { Separator: -1, Default: 0 },
  EventEmitter: class {
    constructor() {
      this.listeners = [];
      this.event = (cb) => {
        this.listeners.push(cb);
        return { dispose: () => { const i = this.listeners.indexOf(cb); if (i >= 0) this.listeners.splice(i, 1); } };
      };
    }
    fire(v) { for (const cb of [...this.listeners]) cb(v); }
    dispose() { this.listeners = []; }
  },
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

// field metadata for the P3-2 assertions (literal path keeps static analysis quiet)
const { FIELDS } = require('../out/vscode/configView.js');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const PROJ = [
  'F:/CH585/EVT/V1_2/EXAM/LED',
  'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED',
  'E:/WORK/CH585/V1_7/EXAM/LED',
  // local EVT tree in this repo — keeps the render (and the linker-widget
  // assertions below) from SKIPping on a machine without the CH585 trees
  'F:/MyProjects/MRS2_VSCODE/CH394QEVT/CH394Q__DHCP_CLIENT',
].find((p) => fs.existsSync(path.join(p, '.cproject')));
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
    // resolveDownloadTarget() stats this path — a real MrsProject always
    // returns a string (round-13 P3: the mock tripped a Node DEP0187 warning)
    hexPath: path.join(PROJ, 'obj', 'LED.hex'),
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
  // round-11 P3-2: 'default' must only exist where CDT defines it as a real
  // enumerated choice (align / debugging.level / debugging.format) — the
  // phantom entries on cpp std / abi version made "Default" a silent no-op
  {
    const keys = (k) => ((FIELDS.find((f) => f.key === k) || {}).options || []).map(([v]) => v);
    check(
      'fields: cpp std exposes gnucpp11 + the real Toolchain-default choice',
      keys('cppstd').includes('gnucpp11') && keys('cppstd').includes('default')
    );
    check('fields: cpp std default label mirrors MRS2 (Toolchain default)', (FIELDS.find((f) => f.key === 'cppstd').options || []).some(([v, l]) => v === 'default' && /Toolchain default/.test(l)));
    check(
      'fields: cpp abi version exposes 0 + the real Toolchain-default choice',
      keys('cppabi').includes('0') && keys('cppabi').includes('default')
    );
    check('fields: real default choices kept (align / debug level / debug format)', keys('align').includes('default') && keys('dbglevel').includes('default') && keys('dbgformat').includes('default'));
  }
  // Target Processor page parity with MRS2 (user report 2026-11-16): the F
  // extension select and the RVV checkbox were missing, Tuning was a text
  // box instead of the model enum select, and choices must carry the real
  // compiler flag hints
  {
    const page = (k) => (FIELDS.find((f) => f.key === k) || {}).page;
    const opts = (k) => FIELDS.find((f) => f.key === k) || {};
    const labels = (k) => (opts(k).options || []).map(([v, l]) => l);
    check('target: Floating point (F extension) select on the target page', page('fp') === 'target' && opts('fp').type === 'enum');
    check(
      'target: Floating point choices mirror MRS2 (none/RVF/RVFD/RVFDQ)',
      ['none', 'single', 'double', 'quad'].every((v) => (opts('fp').options || []).some(([k]) => k === v))
    );
    check('target: Vector Cryptography (RVV) checkbox exists', page('rvv') === 'target' && opts('rvv').type === 'bool');
    check('target: Tuning is a select with the MRS2 model choices', opts('tune').type === 'enum' && ['default', 'rocket', 'generic', 'size'].every((v) => (opts('tune').options || []).some(([k]) => k === v)));
    check('target: Code model hints carry the real -mcmodel flags', labels('codemodel').some((l) => l.includes('(-mcmodel=medany)')) && labels('codemodel').some((l) => l.includes('(-mcmodel=medlow)')));
    check(
      'target: Code model lists exactly the MRS2 choices (no Medium Medium)',
      (opts('codemodel').options || []).map(([v]) => v).join(',') === 'default,any,low'
    );
    check('target: Architecture hints carry the real -march flags', labels('arch').some((l) => l.includes('(-march=rv32i*)')) && labels('arch').some((l) => l.includes('(-march=rv64g*)')));
    check('target: Integer/Float ABI hints carry the real flags', labels('abi').some((l) => l.includes('(-mabi=ilp32*)')) && labels('fpabi').some((l) => l.includes('precision(')));
    check('target: Align default keeps the MRS2 hint (-mtune)', labels('align').some((l) => l === 'Toolchain default (-mtune)'));
    // Small data limit / Generate map are one-line el-inputs in MRS2; the
    // "Other ... flags" fields keep the tall textarea
    check(
      'target: Small data limit renders as a one-line input',
      /<input type="text" data-key="sdl"[^>]*>/.test(html) && !/<textarea data-key="sdl"/.test(html)
    );
    check(
      'linker: Generate map renders as a one-line input',
      /<input type="text" data-key="mapfile"[^>]*>/.test(html) && !/<textarea data-key="mapfile"/.test(html)
    );
    check(
      'target: Other target flags keeps the tall textarea',
      /<textarea data-key="targetother"/.test(html)
    );
    // order: RVM, RVA, Floating point, RVC, RVXW, RVB, RVV, Zmmul (MRS2 page)
    const order = ['rvm', 'rva', 'fp', 'rvc', 'rvxw', 'rvb', 'rvv', 'rvzmmul'].map((k) => FIELDS.findIndex((f) => f.key === k));
    check('target: extension controls appear in MRS2 order', order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])));
  }
  // C++ Compiler pages parity with MRS2 (user report 2026-11-16): Includes
  // gained system/file lists, Optimization absorbed the -fno-* dialect
  // switches + ABI version, Miscellaneous gained the three build switches,
  // Warnings follow MRS order/wording, symbol and include lists use the
  // Add/Edit/Delete table
  {
    const f = (k) => FIELDS.find((x) => x.key === k) || {};
    const page = (k) => f(k).page;
    check(
      'cpp: Includes has paths + system paths + include files',
      ['cppincs', 'cppsysincs', 'cppfileincs'].every((k) => page(k) === 'cpp.inc' && f(k).type === 'list')
    );
    check('cpp: ABI version sits on Optimization (MRS layout)', page('cppabi') === 'cpp.opt');
    check(
      'cpp: -fno-* dialect switches sit on Optimization (MRS layout)',
      ['cppnoexc', 'cppnortti', 'cppnocxa', 'cppnthreads'].every((k) => page(k) === 'cpp.opt')
    );
    check(
      'cpp: Miscellaneous has listing/save-temps/verbose/other flags',
      page('cppasmlisting') === 'cpp.misc' && page('cppsavetemps') === 'cpp.misc' && page('cppverbose') === 'cpp.misc' && page('cppother') === 'cpp.misc'
    );
    check(
      'cpp: Misc labels mirror MRS2 wording',
      (f('cppsavetemps').label || '').includes('Use with caution!') && (f('cppasmlisting').label || '').includes('-Wa,-adhlns=')
    );
    check(
      'cpp: Warnings order matches MRS2',
      ['cppwarnabi', 'cppctordtor', 'cppnoexcept', 'cppnonvdtor', 'cppstrictnull', 'cppsignpromo', 'cppwarneffc']
        .map((k) => FIELDS.findIndex((x) => x.key === k))
        .every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1]))
    );
    check(
      'cpp: Warning labels mirror MRS2 wording',
      (f('cppctordtor').label || '').includes('-Wctor-dtor-privacy') &&
        (f('cppstrictnull').label || '').includes('uncast NULL') &&
        (f('cppwarneffc').label || '').includes('Effective C++')
    );
    check(
      'cpp: Language standard carries the full MRS2 list',
      ['default', 'ansi', 'gnucpp98', 'cpp0x', 'cpp11', 'gnucpp0x', 'gnucpp11', 'cpp1y', 'cpp14', 'gnucpp1y', 'gnucpp14', 'cpp1z', 'cpp17', 'gnucpp1z', 'gnucpp17', 'cpp2a', 'gnucpp2a'].every(
        (v) => (f('cppstd').options || []).some(([k]) => k === v)
      )
    );
    check(
      'cpp: ABI version options carry MRS2 labels (default + 0..13)',
      (f('cppabi').options || []).length === 15 && (f('cppabi').options || []).some(([v, l]) => v === '0' && l === '0 (most conforming)')
    );
    // C++ Linker mirrors the C Linker layout (round34 P3)
    check(
      'cpp: Linker General mirrors the C layout',
      ['cppscript', 'cppnostart', 'cppnodeflibs', 'cppnostdlibs', 'cppgcsec', 'cppprintgc', 'cppstrip'].every((k) => page(k) === 'cppld.general')
    );
    check(
      'cpp: Linker Miscellaneous mirrors the C layout',
      ['cppldflags', 'cppotherobjs', 'cppmapfile', 'cppcref', 'cppprintmap', 'cppnano', 'cppfloatprintf', 'cppfloatscanf', 'cppnosys', 'cppldverbose', 'cppwchprintf', 'cppwchprintfloat', 'cppiqmath', 'cpppicolibc', 'cppldother'].every(
        (k) => page(k) === 'cppld.misc'
      )
    );
    check(
      'picolibc: both linkers expose the MRS2 enum with model default disabled',
      ['picolibc', 'cpppicolibc'].every(
        (k) =>
          f(k).type === 'enum' &&
          f(k).def === 'disabled' &&
          (f(k).options || []).map(([v]) => v).join(',') === 'disabled,double,integer,minimal' &&
          page(k) === (k === 'picolibc' ? 'ld.misc' : 'cppld.misc')
      )
    );
  }
  // path-entry validation (user request 2026-11-16): malformed macros abort,
  // unknown macros / missing targets ask before writing
  {
    const { checkPathEntries, pathSyntaxProblem } = require('../out/vscode/configView.js');
    const none = new Map();
    const s1 = pathSyntaxProblem('${workspace_loc:/${ProjName}/inc');
    check('path gate: unclosed macro is malformed', !!s1.problem && /unclosed/.test(s1.problem));
    const s2 = pathSyntaxProblem('${workspace_loc:/${ProjName}/inc}');
    check(
      'path gate: nested workspace_loc syntax accepted',
      !s2.problem && s2.names.length === 2 && s2.names.includes('workspace_loc') && s2.names.includes('ProjName')
    );
    const u = checkPathEntries({ incs: '${workspac_loc:/${ProjName}/inc}' }, none, PROJ);
    check('path gate: unknown macro flagged', u.unknown.length === 1 && u.unknown[0].includes('workspac_loc'));
    const missing = checkPathEntries({ incs: '${workspace_loc:/${ProjName}/__mrvc_missing__}' }, none, PROJ);
    check('path gate: missing folder flagged', missing.missing.length === 1);
    const okRoot = checkPathEntries({ incs: '${workspace_loc:/${ProjName}/}' }, new Map([['incs', 'old']]), PROJ);
    check('path gate: existing project root accepted', okRoot.malformed.length === 0 && okRoot.missing.length === 0);
    const untouched = checkPathEntries(
      { incs: '${workspace_loc:/${ProjName}/__mrvc_missing__}' },
      new Map([['incs', '${workspace_loc:/${ProjName}/__mrvc_missing__}']]),
      PROJ
    );
    check('path gate: pre-existing rows are not re-reported', untouched.missing.length === 0);
    const textMode = checkPathEntries({ defs: '${BAD', ldflags: '${BAD' }, none, PROJ);
    check('path gate: symbol/flag lists are not path-checked', textMode.malformed.length === 0);
  }
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

  // ---- MRS2-parity linker pages (user report 2026-11-16) ----
  {
    // Script files (-T) is an Add/Edit/Delete table like MRS2, not a textarea
    check('linker: Script files renders as the table widget (lb-add)', html.includes('class="lb-add" data-lkey="script"'));
    check('linker: Script files table carries its listrows key', html.includes('class="listrows" data-key="script"'));
    // field page regrouping: MRS2 puts everything but the script/standard
    // switches on Miscellaneous, and only -l/-L on Libraries
    const page = (k) => (FIELDS.find((f) => f.key === k) || {}).page;
    check('linker: MRS2 grouping (script=General)', page('script') === 'ld.general');
    check('linker: MRS2 grouping (libs/libpaths=Libraries)', page('libs') === 'ld.libs' && page('libpaths') === 'ld.libs');
    check(
      'linker: MRS2 grouping (flags/objects/map/specs=Miscellaneous)',
      ['ldflags', 'otherobjs', 'mapfile', 'nano', 'floatprintf', 'floatscanf', 'nosys', 'cref', 'printmap', 'ldverbose', 'ldother', 'wchprintf', 'wchprintfloat', 'iqmath'].every(
        (k) => page(k) === 'ld.misc'
      )
    );
    const migrated = ['nano', 'nosys', 'floatprintf', 'floatscanf', 'mapfile', 'cref', 'printmap', 'ldverbose', 'ldother'];
    check(
      'linker: General no longer holds the migrated misc fields',
      !FIELDS.some((f) => f.page === 'ld.general' && migrated.includes(f.key))
    );
    // Generate map: EVT projects never persist c.linker.mapfilename — MRS2
    // renders the toolchain default instead of a blank box (user report
    // 2026-11-16), so an unstored option must fall back to that default
    {
      const mapField = FIELDS.find((f) => f.key === 'mapfile');
      const stored = realCp.optionValue('c.linker.mapfilename');
      check(
        'linker: Generate map resolves default-or-stored like MRS2',
        stored !== undefined ? mapField.get(realCp) === stored : mapField.get(realCp) === '"${BuildArtifactFileBaseName}.map"'
      );
      check('linker: Generate map never renders blank', mapField.get(realCp) !== '');
    }
    // Linker flags: the MRS model defaults c.linker.flags to [] — an empty
    // stringList renders an empty table (ADC_DMA's -print-memory-usage row is
    // STORED in that project, not a default; user audit 2026-11-16)
    {
      const flagsField = FIELDS.find((f) => f.key === 'ldflags');
      const storedFlags = realCp.listOption('c.linker.flags').values;
      check(
        'linker: Linker flags is stored-or-empty (no invented default)',
        flagsField.get(realCp) === storedFlags.join('\n')
      );
      const pathsField = FIELDS.find((f) => f.key === 'libpaths');
      const storedPaths = realCp.listOption('c.linker.paths').values;
      check('linker: Library search path is stored-or-empty', pathsField.get(realCp) === storedPaths.join('\n'));
    }
    // Target / tool options whose MRS model constructors carry defaults that
    // EVT projects do not persist: the page must show those defaults rather
    // than a blank/first-unrelated choice (user audit 2026-11-16)
    {
      const enumDisplay = (key) => {
        const f = FIELDS.find((x) => x.key === key);
        const raw = realCp.optionValue(f.suffix);
        return raw === undefined || raw === '' ? (f.def ?? 'default') : raw;
      };
      const cmRaw = realCp.optionValue('target.codemodel');
      check(
        'defaults: Code model falls back to Toolchain default (not MedAny)',
        (cmRaw === undefined || cmRaw === '' ? enumDisplay('codemodel') === 'default' : true) &&
          (FIELDS.find((f) => f.key === 'codemodel').options || []).some(([v]) => v === 'default')
      );
      check(
        'defaults: Integer ABI has the Toolchain default choice',
        (FIELDS.find((f) => f.key === 'abi').options || []).some(([v]) => v === 'default')
      );
      check(
        'defaults: Architecture has the Toolchain Default choice',
        (FIELDS.find((f) => f.key === 'arch').options || []).some(([v]) => v === 'default')
      );
      const sdl = FIELDS.find((f) => f.key === 'sdl');
      check('defaults: Small data limit shows 8 when unstored', sdl.get(realCp) === (realCp.optionValue('target.smalldatalimit') ?? '8'));
      const tune = FIELDS.find((f) => f.key === 'tune');
      check('defaults: Tuning is the MRS2 model enum with default fallback', tune.type === 'enum' && tune.def === 'default');
      const sizeFmt = FIELDS.find((f) => f.key === 'sizefmt');
      const szRaw = realCp.optionValue('printsize.format');
      check(
        'defaults: Size format falls back to berkeley (MRS model default)',
        szRaw === undefined || szRaw === '' ? sizeFmt.def === 'berkeley' : true
      );
      const flashFmt = FIELDS.find((f) => f.key === 'flashfmt');
      const flRaw = realCp.optionValue('createflash.choice');
      check(
        'defaults: Output format falls back to ihex (MRS model default)',
        flRaw === undefined || flRaw === '' ? flashFmt.def === 'ihex' : true
      );
      check(
        'defaults: addtools Create switches default to checked like MRS2',
        ['flash', 'lst', 'size'].every((k) => FIELDS.find((f) => f.key === k).def === 'true')
      );
    }
    // the project-source pick conversion must be the MRS2 stored spelling and
    // must survive the render template (the old unescaped form emitted
    // '[object Object]/rel' instead of the macro)
    check('render: no [object Object] interpolation leak', !html.includes('[object Object]'));
    check(
      'linker: project-source picks convert to the workspace_loc macro',
      scripts.some((s) => s.includes("'${workspace_loc:/${ProjName}/'"))
    );
    // dialog modes are emitted for the webview and drive the OS picker
    check(
      'list dialogs: LIST_MODES emitted (script=ldfile, libs=text)',
      scripts.some((s) => s.includes('const LIST_MODES = {') && s.includes('"script":"ldfile"') && s.includes('"libs":"text"'))
    );
    check(
      'list dialogs: C++ symbol/include lists get their modes',
      scripts.some(
        (s) => s.includes('"cppdefs":"text"') && s.includes('"cppundefs":"text"') && s.includes('"cppsysincs":"dir"') && s.includes('"cppfileincs":"file"')
      )
    );
    check(
      'list dialogs: symbol lists get their own modal nouns (round34 P3)',
      scripts.some(
        (s) =>
          s.includes("defs: 'defined symbol'") &&
          s.includes("cppundefs: 'undefined symbol'") &&
          s.includes("asmdefs: 'defined symbol'") &&
          s.includes("ldflags: 'linker flag'") &&
          s.includes("cppldflags: 'linker flag'")
      )
    );
    check(
      'list dialogs: text mode hides the source row / browse controls',
      scripts.some((s) => s.includes("getElementById('msrcrow')") && s.includes("mode === 'text'"))
    );
    const cvSrc = fs.readFileSync(path.join(__dirname, '..', 'out', 'vscode', 'configView.js'), 'utf8');
    check('list dialogs: ldfile picker filters to .ld', cvSrc.includes("'Linker script': ['ld']"));
  }

  // ---- collectDl must scope to the PAGE, not the nav item ----
  // nav items also carry data-page and precede #content in the document;
  // the bare '[data-page="dlset"]' selector resolved to the nav div, every
  // checkbox lookup missed, and Apply persisted ALL boxes as false while
  // still reporting "Saved" (user report 2026-11-12). The behavioral probe
  // below runs the REAL emitted collectDl against a document whose nav item
  // shadows the page: only the '.page'-qualified selector can find the boxes.
  {
    const main = scripts.find((s) => s.includes('function collectDl'));
    // checkbox keys ONLY, from the markup (not the script text): select and
    // text inputs also carry data-dlkey, and collectDl's own selector literal
    // would match the naive regex
    const dlKeys = [
      ...html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').matchAll(/<input type="checkbox" data-dlkey="([^"]+)"/g),
    ].map((m) => m[1]);
    check('collectDl: page-qualified selector emitted', !!main && main.includes(".page[data-page=\"dlset\"]"));
    // extract exactly the collectDl function (balanced braces) and run it
    let fn = '';
    if (main) {
      const start = main.indexOf('function collectDl');
      const open = main.indexOf('{', start);
      let depth = 0, inStr = '';
      for (let i = open; i < main.length; i++) {
        const ch = main[i];
        if (inStr) {
          if (ch === inStr && main[i - 1] !== '\\') inStr = '';
          continue;
        }
        if (ch === "'" || ch === '"') inStr = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            fn = main.slice(start, i + 1);
            break;
          }
        }
      }
    }
    if (fn && dlKeys.length) {
      // user checked every box on the page
      const checkedSet = new Set(dlKeys);
      const navItem = { querySelector: () => null }; // the nav subtree has no inputs
      const page = {
        querySelector: (sel) => {
          const m = String(sel).match(/\[data-dlkey="([^"]+)"\]/);
          return m && checkedSet.has(m[1]) ? { checked: true } : null;
        },
      };
      const doc = {
        querySelector: (sel) =>
          sel === '.page[data-page="dlset"]' ? page : sel === '[data-page="dlset"]' ? navItem : null,
      };
      let dl = null;
      try {
        dl = new Function('document', 'dlEl', fn + '\n;return collectDl();')(doc, () => ({ value: '' }));
      } catch (e) {
        check('collectDl: runs against the emitted page (no throw)', false);
        console.log('   error:', e.message);
      }
      const okKeys = !!dl && dlKeys.length === 8 && dlKeys.every((k) => dl[k] === 'true');
      check(
        `collectDl: nav shadow does not swallow the page — all checked boxes report true`,
        okKeys
      );
      if (!okKeys) {
        console.log('   dl =', JSON.stringify(dl));
        console.log('   dlKeys =', JSON.stringify(dlKeys));
      }
    } else {
      check('collectDl: extracted from the emitted script with dl keys present', false);
    }
  }

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
    const fakeSelf = {
      building: new Map([[key, {}]]),
      store: { suspendTreeRefresh() {}, resumeTreeRefresh() {} },
      // cleanOne delegates to cleanOneInner on `this` — the stub supplies it
      cleanOneInner: () => Promise.resolve({ project: 'P', ok: true, detail: 'inner' }),
    };
    const fakeProj = { root: 'X:/proj', projectName: 'P', buildDir: 'X:/proj/obj' };
    const r1 = await BuildManager.prototype.cleanOne.call(fakeSelf, fakeProj, { makeBin: 'X:/make' });
    check('batch clean: skipped while the project is building', r1.ok === true && r1.detail.length > 0);
    const r2 = await BuildManager.prototype.deleteOutputOne.call(fakeSelf, fakeProj, false);
    check('batch delete outputs: skipped while the project is building', r2.ok === true && r2.detail.length > 0);
    const freeSelf = {
      building: new Map(),
      store: { suspendTreeRefresh() {}, resumeTreeRefresh() {} },
      cleanOneInner: () => Promise.resolve({ project: 'P', ok: true, detail: 'inner-free' }),
    };
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
  // unset enums now seed their MODEL default via shared readEnum (f.def) or
  // a synthetic (default) for fields without any def (align/dbglevel/
  // dbgformat in the LED base); the stronger invariant is: EVERY enum select
  // renders one selected option (no browser first-option fallback)
  check('sync page: unset enums seed an explicit choice (model default or (default))', (() => {
    const selects = [...syncHtml.matchAll(/<select class="valbox" data-val="[^"]*">([\s\S]*?)<\/select>/g)];
    return selects.length > 10 && selects.every((m) => /<option value="[^"]+" selected>/.test(m[1]));
  })());
  check('sync page: hostile string escaped', !syncHtml.includes('LED<x>"</script>') || syncHtml.includes('\\u003C'));
  // 0.3.1 additions ride along automatically (the page derives from FIELDS):
  // the Target-page RVV checkbox (custom get/set, enumerated storage) is the
  // one field that used to be filtered out
  check('sync page: picolibc + RVV rows present (0.3.1 fields)', syncHtml.includes('data-val="picolibc"') && syncHtml.includes('data-val="rvv"') && syncHtml.includes('Vector Cryptography extensions (RVV)'));
  // nonce policy on the sync page too (script-src gated, every tag tagged)
  {
    const cspS = (syncHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] ?? '';
    const ssS = (cspS.match(/script-src ([^;]*)/) || [])[1] ?? '';
    const nS = (ssS.match(/'nonce-([0-9a-f]+)'/) || [])[1];
    const tagsS = [...syncHtml.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    check('sync page: CSP nonce policy', !!nS && !ssS.includes("'unsafe-inline'") && tagsS.length >= 1 && tagsS.every((a) => a.includes(`nonce="${nS}"`)));
  }
  // round-46/47: the collector is the COMPILED exported function injected
  // into the page via toString() — calling it here executes the EXACT code
  // the browser runs (no eval needed, no drift possible). The DOM-reading
  // half of the page script stays pinned by the source check below.
  const syncCollector = require('../out/vscode/syncPage.js').collectSyncItems;
  const collectorMeta = {
    rvGcc: { suffix: 'target.rvGcc', type: 'enum', enumBase: 'X.' },
    nocommon: { suffix: 'optimization.nocommon', type: 'bool' },
  };
  const ctlRaw = { key: 'rvGcc', syncChecked: true, value: 'future-full-id', dataCurrent: true };
  const ctlSuffix = { key: 'rvGcc', syncChecked: true, value: 'futurechoice' };
  const ctlKnown = { key: 'rvGcc', syncChecked: true, value: '8' };
  const ctlUnchecked = { key: 'rvGcc', syncChecked: false, value: '8', dataCurrent: true };
  const ctlBool = { key: 'nocommon', syncChecked: true, boolChecked: false };
  const rawItems = syncCollector(collectorMeta, [ctlRaw]);
  check('collector behavior: verbatim id -> raw true and kept', rawItems.length === 1 && rawItems[0].raw === true && rawItems[0].value === 'future-full-id');
  const suffixItems = syncCollector(collectorMeta, [ctlSuffix]);
  check('collector behavior: unknown suffix without data-current -> raw stays falsy', suffixItems[0].raw === false && suffixItems[0].value === 'futurechoice');
  const knownItems = syncCollector(collectorMeta, [ctlKnown]);
  check('collector behavior: known choice -> raw stays falsy, registered value sent', !knownItems[0].raw && knownItems[0].value === '8');
  const uncheckedItems = syncCollector(collectorMeta, [ctlUnchecked]);
  check('collector behavior: unchecked syncbox filtered out', uncheckedItems.length === 0);
  const boolItems = syncCollector(collectorMeta, [ctlBool]);
  check('collector behavior: bool control sends its checked state', boolItems[0].value === '0' && !boolItems[0].raw);
  const scriptsSync = [...syncHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const collectorSrc = scriptsSync.find((s) => s.includes('applySync')) || '';
  check(
    'collector: page injects the shared collector and reads the data-current marker',
    collectorSrc.includes('const collectSyncItems = ') && collectorSrc.includes("hasAttribute('data-current')")
  );

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
    // RVV rides the sync batch through its own setter (enumerated storage:
    // checked -> ...isa.rvv.zve64x_zvl64b_zvbb, unchecked -> empty suffix)
    for (const h of syncHandlers)
      h({ command: 'applySync', items: [{ suffix: 'target.isa.rvv', type: 'bool', value: '1' }] });
    await new Promise((r) => setTimeout(r, 300));
    // value ids for the isa.* options carry NO `target.` segment (they are
    // OPT_BASE + 'isa.rvv.…', unlike the option's superClass suffix)
    const RVV = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.isa.rvv.';
    const rvv1 = Cproject.load(scratch1).optionValue('target.isa.rvv');
    check('sync batch: RVV checked writes the enumerated on-value', rvv1 === RVV + 'zve64x_zvl64b_zvbb');
    for (const h of syncHandlers)
      h({ command: 'applySync', items: [{ suffix: 'target.isa.rvv', type: 'bool', value: '0' }] });
    await new Promise((r) => setTimeout(r, 300));
    check('sync batch: RVV unchecked writes the MRS empty-suffix form', Cproject.load(scratch1).optionValue('target.isa.rvv') === RVV);

    // round-43 P2-1: a base-infix enum id (...option.base.<suffix><choice>)
    // must render its choice selected (not fall back to the first option)
    {
      const bs = path.join(__dirname, '..', '.scratch', 'sync-base-form');
      fs.rmSync(bs, { recursive: true, force: true });
      fs.cpSync(PROJ, bs, { recursive: true });
      const cpB = Cproject.load(bs);
      cpB.setOptionValue('target.rvGcc', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.base.target.rvGcc.12');
      cpB.save();
      const baseB = { root: bs, projectName: 'LEDB', cproject: Cproject.load(bs), toolchain: () => undefined, reload() {}, buildDir: path.join(bs, 'obj') };
      const storeB = { active: baseB, all: [baseB], reloadProject() {} };
      const bp = {
        title: '',
        reveal() {},
        dispose() {},
        onDidDispose() {
          return { dispose() {} };
        },
        webview: {
          htmlHolder: '',
          get html() {
            return this.htmlHolder;
          },
          set html(v) {
            this.htmlHolder = v;
          },
          handlers: [],
          onDidReceiveMessage(h) {
            this.handlers.push(h);
            return { dispose() {} };
          },
          postMessage() {
            return Promise.resolve(true);
          },
        },
      };
      // SyncPage2 talks to the patched window object it was loaded with
      vscodePatch.window.createWebviewPanel = () => bp;
      const sb = new SyncPage2(storeB);
      sb.open();
      delete vscodePatch.window.createWebviewPanel;
      check('sync base-form: GCC12 choice rendered selected, no first-option fallback', /<option value="12" selected>WCH Toolchain \(GCC12\)<\/option>/.test(bp.webview.html));
      // real Apply: the collector sends value '12' (a registered CHOICE), so
      // the stored id must be the NORMAL enum id — the toolchain stays GCC12
      const RVGCC = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.rvGcc.';
      for (const h of bp.webview.handlers)
        h({ command: 'applySync', items: [{ suffix: 'target.rvGcc', type: 'enum', enumBase: RVGCC, value: '12' }] });
      await new Promise((r) => setTimeout(r, 300));
      check('sync base-form: Apply writes the normal enum id (toolchain stays GCC12)', Cproject.load(bs).optionValue('target.rvGcc') === RVGCC + '12');
      // round-44 P2-1: the "(current)" value is a COMPLETE raw id — the
      // writer must echo it verbatim (no double enumBase prefix)
      const unknownId = 'ilg.other.tool.option.target.rvGcc.futurechoice';
      const cpB2 = Cproject.load(bs);
      cpB2.setOptionValue('target.rvGcc', unknownId);
      cpB2.save();
      baseB.cproject = Cproject.load(bs); // re-seed the render source too
      sb.open(); // re-render from the updated project
      check('sync base-form: unknown id rendered as (current) with data-current', /<option value="ilg\.other\.tool\.option\.target\.rvGcc\.futurechoice" data-current="1" selected>/.test(bp.webview.html));
      for (const h of bp.webview.handlers)
        h({ command: 'applySync', items: [{ suffix: 'target.rvGcc', type: 'enum', enumBase: RVGCC, value: unknownId, raw: true }] });
      await new Promise((r) => setTimeout(r, 300));
      check('sync base-form: unknown raw id echoed verbatim (no double prefix)', Cproject.load(bs).optionValue('target.rvGcc') === unknownId);
      fs.rmSync(bs, { recursive: true, force: true });
    }

    // round-45 P2: an unknown suffix under a KNOWN enumBase is NOT raw —
    // Apply must write enumBase + suffix, and the rendered (current) option
    // must NOT carry data-current
    {
      const bs2 = path.join(__dirname, '..', '.scratch', 'sync-unknown-suffix');
      fs.rmSync(bs2, { recursive: true, force: true });
      fs.cpSync(PROJ, bs2, { recursive: true });
      const AL = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.align.';
      const futureId = AL + 'futurechoice';
      const cpA = Cproject.load(bs2);
      cpA.setOptionValue('target.align', futureId);
      cpA.save();
      const baseA = { root: bs2, projectName: 'LEDA', cproject: Cproject.load(bs2), toolchain: () => undefined, reload() {}, buildDir: path.join(bs2, 'obj') };
      const storeA = { active: baseA, all: [baseA], reloadProject() {} };
      const ap = { html: '', title: '', reveal() {}, dispose() {}, onDidDispose() { return { dispose() {} }; }, webview: { handlers: [], htmlHolder: '', get html() { return this.htmlHolder; }, set html(v) { this.htmlHolder = v; }, onDidReceiveMessage(h) { this.handlers.push(h); return { dispose() {} }; }, postMessage() { return Promise.resolve(true); } } };
      vscodePatch.window.createWebviewPanel = () => ap;
      const sa = new SyncPage2(storeA);
      sa.open();
      delete vscodePatch.window.createWebviewPanel;
      const mAlign = ap.webview.html.match(/<select class="valbox" data-val="align">([\s\S]*?)<\/select>/);
      check(
        'sync unknown-suffix: (current) entry rendered WITHOUT data-current',
        !!mAlign && /<option value="futurechoice" selected>\(current\) futurechoice<\/option>/.test(mAlign[1]) && !mAlign[1].includes('data-current')
      );
      // collector contract: no data-current -> raw stays falsy -> the writer
      // composes enumBase + suffix
      for (const h of ap.webview.handlers)
        h({ command: 'applySync', items: [{ suffix: 'target.align', type: 'enum', enumBase: AL, value: 'futurechoice' }] });
      await new Promise((r) => setTimeout(r, 300));
      check('sync unknown-suffix: Apply writes enumBase + suffix (no bare suffix)', Cproject.load(bs2).optionValue('target.align') === futureId);
      fs.rmSync(bs2, { recursive: true, force: true });
    }

    // round-43 P2-2: base project uses its MODEL default (option absent) and
    // the target has an EXPLICIT value — choosing '(default)' must write the
    // field's model default choice (fp -> none), not silently no-op
    {
      const dB = path.join(__dirname, '..', '.scratch', 'sync-def-base');
      const dT = path.join(__dirname, '..', '.scratch', 'sync-def-target');
      fs.rmSync(dB, { recursive: true, force: true });
      fs.rmSync(dT, { recursive: true, force: true });
      fs.cpSync(PROJ, dB, { recursive: true });
      fs.cpSync(PROJ, dT, { recursive: true });
      // base: REMOVE the fp option entirely (model default none shows)
      const cpDb = Cproject.load(dB);
      cpDb.setOptionValue('target.isa.fp', undefined);
      cpDb.save();
      // target: EXPLICIT single precision
      const cpDt = Cproject.load(dT);
      cpDt.setOptionValue('target.isa.fp', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.isa.fp.single');
      cpDt.save();
      const memberDb = { root: dB, projectName: 'LEDd0', cproject: Cproject.load(dB), toolchain: () => undefined, reload() {}, buildDir: path.join(dB, 'obj') };
      const memberDt = { root: dT, projectName: 'LEDd1', cproject: Cproject.load(dT), toolchain: () => undefined, reload() {}, buildDir: path.join(dT, 'obj') };
      const storeD = { active: memberDb, all: [memberDb, memberDt], reloadProject() {} };
      const sd = new SyncPage2(storeD);
      const dPanel = { html: '', title: '', reveal() {}, dispose() {}, onDidDispose() { return { dispose() {} }; }, webview: { onDidReceiveMessage(h) { syncHandlers.push(h); return { dispose() {} }; }, postMessage(m) { syncPosted.push(m); return Promise.resolve(true); } } };
      vscodePatch.window.createWebviewPanel = () => dPanel;
      sd.open();
      delete vscodePatch.window.createWebviewPanel;
      for (const h of syncHandlers)
        h({ command: 'applySync', items: [{ suffix: 'target.isa.fp', type: 'enum', enumBase: 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.isa.fp.', value: 'default' }] });
      await new Promise((r) => setTimeout(r, 300));
      // fp has def='none' -> the TARGET now carries the explicit none id
      const FP = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.isa.fp.';
      check('sync default: target fp rewritten to the model default choice (none)', Cproject.load(dT).optionValue('target.isa.fp') === FP + 'none');
      // an enum with NO model default and NO real 'default' choice
      // (optimization.level: no def, options lack 'default'): a '(default)'
      // sync must be reported as SKIPPED, not OK — target keeps its stored
      // choice. A REAL enum field this time (round-44 P3-1: messagelength is
      // boolean, so the fd lookup trivially missed and proved nothing)
      const cpNo = Cproject.load(dT);
      const OL = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.optimization.level.';
      const targetLevelBefore = Cproject.load(dT).optionValue('optimization.level');
      check('sync default: the probe target stores an explicit optimization.level', !!targetLevelBefore);
      for (const h of syncHandlers)
        h({ command: 'applySync', items: [{ suffix: 'optimization.level', type: 'enum', enumBase: OL, value: 'default' }] });
      await new Promise((r) => setTimeout(r, 300));
      check(
        'sync default: no-model-default enum keeps target value and is reported skipped',
        syncPosted.some((m) => m.command === 'syncDone' && m.text.includes('skipped')) &&
          Cproject.load(dT).optionValue('optimization.level') === targetLevelBefore
      );
      fs.rmSync(dB, { recursive: true, force: true });
      fs.rmSync(dT, { recursive: true, force: true });
    }

    // round-43 P3-1: a second applySync while the first is in flight is
    // refused with a warning instead of interleaving two write loops
    {
      for (const h of syncHandlers) h({ command: 'applySync', items: [{ suffix: 'optimization.nocommon', type: 'bool', value: '1' }] });
      let warned = 0;
      const savedWarn = vscodePatch.window.showWarningMessage;
      vscodePatch.window.showWarningMessage = () => {
        warned++;
        return Promise.resolve(undefined);
      };
      for (const h of syncHandlers) h({ command: 'applySync', items: [{ suffix: 'optimization.nocommon', type: 'bool', value: '0' }] });
      await new Promise((r) => setTimeout(r, 300));
      vscodePatch.window.showWarningMessage = savedWarn;
      check('sync busy: overlapping applySync refused', warned >= 1);
    }

    // ---- Macro Definitions Across Projects (dedicated page) ----
    const macroPanel = {
      html: '', title: '', reveal() {}, dispose() {},
      onDidDispose() { return { dispose() {} }; },
      webview: {
        onDidReceiveMessage(h) { macroHandlers.push(h); return { dispose() {} }; },
        postMessage(m) { macroPosted.push(m); return Promise.resolve(true); },
      },
    };
    const macroHandlers = [];
    const macroPosted = [];
    // per-project review decisions: each element is an action string consumed
    // by ONE showQuickPick call ('apply'/'skip'/'applyRest'/'skipRest'), or
    // undefined (= Esc — cancels all remaining)
    const macroQuickPicks = [];
    const vscodePatch3 = {
      window: {
        ...vscodeStub.window,
        createWebviewPanel: () => macroPanel,
        withProgress: (_o, task) => task({ report() {} }, { isCancellationRequested: false }).then(() => undefined),
        createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
        showWarningMessage: (...a) => {
          macroWarnArgs = a;
          // the user always clicks the FIRST BUTTON (confirm). a[0] is the
          // message text itself — buttons start at a[1]. A modal with no
          // buttons resolves undefined (dismiss).
          const buttons = a.slice(1).filter((x) => typeof x === 'string');
          return Promise.resolve(buttons[0]);
        },
        showQuickPick: (items) => {
          const action = macroQuickPicks.shift();
          macroQuickPickItems = items;
          return Promise.resolve(action === undefined ? undefined : (items || []).find((i) => i.action === action));
        },
        showErrorMessage: () => undefined,
        showInformationMessage: () => undefined,
      },
    };
    let macroWarnArgs = null;
    let macroQuickPickItems = null;
    const origResolve3 = Module._resolveFilename;
    Module._resolveFilename = function (request, ...args) {
      if (request === 'vscode') return 'vscode-stub3';
      return origResolve3.call(this, request, ...args);
    };
    require.cache['vscode-stub3'] = { id: 'vscode-stub3', filename: 'vscode-stub3', loaded: true, exports: { ...vscodeStub, window: vscodePatch3.window, ProgressLocation: { Notification: 15 } } };
    delete require.cache[path.join(__dirname, '..', 'out', 'vscode', 'macroBatch.js')];
    const { MacroBatchPage } = require(path.join(__dirname, '..', 'out', 'vscode', 'macroBatch.js'));
    // fresh scratch pair (the sync scratch dirs were already loaded above)
    const mscratch1 = path.join(__dirname, '..', '.scratch', 'macro-page-1');
    const mscratch2 = path.join(__dirname, '..', '.scratch', 'macro-page-2');
    fs.rmSync(mscratch1, { recursive: true, force: true });
    fs.rmSync(mscratch2, { recursive: true, force: true });
    fs.cpSync(PROJ, mscratch1, { recursive: true });
    fs.cpSync(PROJ, mscratch2, { recursive: true });
    // a private macro the batch must never delete ("unmentioned stays
    // untouched" needs a real unmentioned macro to assert against)
    {
      const pre = Cproject.load(mscratch1);
      pre.setOptionList('c.compiler.defs', [...pre.listOption('c.compiler.defs').values, 'PRIVATE_MACRO']);
      pre.save();
    }
    const mbStore = {
      active: null,
      all: [mscratch1, mscratch2].map((root, i) => ({
        root,
        projectName: 'M' + (i + 1),
        cproject: Cproject.load(root),
        toolchain: () => undefined,
        reload() {},
        buildDir: path.join(root, 'obj'),
      })),
      reloadProject() {},
    };
    const mp = new MacroBatchPage(mbStore);
    mp.open();
    const mHtml = macroPanel.webview.html;
    check('macro page rendered', mHtml.includes('Macro Definitions Across Projects'));
    // Form A: read-only per-project summary + editor + target selection
    check('macro page: per-project summary (2 sections, open)', (mHtml.match(/<details class="proj" open>/g) || []).length === 2 && mHtml.includes('id="summary"'));
    check('macro page: summary rows carry pane tags + macro filter', mHtml.includes('class="mrow') && mHtml.includes('id="mfilter"'));
    check('macro page: three editor panes with sync checkboxes', (mHtml.match(/class="syncbox"/g) || []).length === 3);
    check('macro page: textareas start EMPTY (no union prefill)', (mHtml.match(/<textarea data-pane="[^"]*" spellcheck="false"><\/textarea>/g) || []).length === 3);
    check('macro page: undo button present', mHtml.includes('id="undo"'));
    check('macro page: per-pane stats + rules line + add-missing switch', mHtml.includes('data-stat=') && mHtml.includes('id="rules"') && mHtml.includes('id="addmissing"'));
    check('macro page: target project list (2 tick boxes, default unchecked, select all/none + filter)', (mHtml.match(/class="tbox"/g) || []).length === 2 && !/class="tbox" checked/.test(mHtml) && mHtml.includes('id="all"') && mHtml.includes('id="none"') && mHtml.includes('id="tfilter"') && mHtml.includes('id="tcount"'));
    check('macro page: CSP nonce gates scripts', !/script-src [^;]*'unsafe-inline'/.test(mHtml) && /script-src [^;]*'nonce-[0-9a-f]+'/.test(mHtml));

  // ---- buildMakeArgs: the mrvc.build.verbose setting must reach the make
  // command line (it was a declared-but-unimplemented setting before) ----
  {
    const tasksMod = require(path.join(__dirname, '..', 'out', 'vscode', 'tasks.js'));
    const buildMakeArgs = tasksMod.buildMakeArgs;
    const defaultJobs = tasksMod.defaultJobs;
    const realCpus = require('os').cpus().length;
    check('verbose normal: plain -j + all', JSON.stringify(buildMakeArgs('build', 8, 'normal')) === JSON.stringify(['-j8', 'all']));
    check('verbose full: --trace + VERBOSE=1 before -j', JSON.stringify(buildMakeArgs('build', 4, 'full')) === JSON.stringify(['--trace', 'VERBOSE=1', '-j4', 'all']));
    check('verbose concise: -s', JSON.stringify(buildMakeArgs('build', 4, 'concise')) === JSON.stringify(['-s', '-j4', 'all']));
    check('verbose clean: never -j, targets clean', JSON.stringify(buildMakeArgs('clean', 4, 'full')) === JSON.stringify(['--trace', 'VERBOSE=1', 'clean']));
    check('verbose unknown value falls back to normal', JSON.stringify(buildMakeArgs('rebuild', 2, 'bogus')) === JSON.stringify(['-j2', 'all']));
    check('defaultJobs = cpus-1, at least 1', defaultJobs() === Math.max(1, realCpus - 1) && defaultJobs() >= 1);
  }
    check('macro page: panes carry the suffix metadata', mHtml.includes('c.compiler.defs') && mHtml.includes('cpp.compiler.defs') && mHtml.includes('assembler.defs'));
    // selective sync: apply to ONLY the first project (targets filter) —
    // the per-project review gets ONE decision: apply
    macroQuickPicks.push('apply');
    for (const h of macroHandlers)
      h({
        command: 'applyMacros',
        panes: [
          { key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'DEBUG=1\nNEW_MACRO=42' },
          { key: 'cppdefs', suffix: 'cpp.compiler.defs', cppOnly: true, text: 'CPP_ONLY=1' },
        ],
        addMissing: true,
        targets: [mscratch1],
      });
    await new Promise((r) => setTimeout(r, 300));
    const mAfter1 = Cproject.load(mscratch1).listOption('c.compiler.defs').values;
    const mAfter2 = Cproject.load(mscratch2).listOption('c.compiler.defs').values;
    check('macro page: review QuickPick carried before/after + change lines', !!macroQuickPickItems && macroQuickPickItems.some((i) => (i.label || '').includes('Before')) && macroQuickPickItems.some((i) => (i.label || '').includes('After')) && macroQuickPickItems.some((i) => (i.label || '').includes('⇒')) && macroQuickPickItems.some((i) => (i.label || '').includes('+ NEW_MACRO=42')));
    check('macro page: target #1 written (DEBUG updated + NEW_MACRO added)', mAfter1.includes('DEBUG=1') && mAfter1.includes('NEW_MACRO=42'));
    check('macro page: target #2 NOT touched (selective sync)', !mAfter2.includes('DEBUG=1') && !mAfter2.includes('NEW_MACRO=42') && mAfter2.includes('DEBUG=0'));
    check('macro page: unmentioned macros preserved (PRIVATE_MACRO survives)', mAfter1.includes('PRIVATE_MACRO') && mAfter1.every((v) => !v.startsWith('DEBUG=0')));
    check('macro page: C++ pane skipped on C projects', !Cproject.load(mscratch1).listOption('cpp.compiler.defs').values.includes('CPP_ONLY=1'));
    check('macro page: done message posted (1/1 written)', macroPosted.some((m) => m.command === 'macroDone' && m.text.includes('1/1 written')));
    // skip decision: nothing written for the reviewed project
    macroQuickPicks.push('skip');
    const beforeSkip = JSON.stringify(Cproject.load(mscratch1).listOption('c.compiler.defs').values);
    for (const h of macroHandlers)
      h({ command: 'applyMacros', panes: [{ key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'DEBUG=7' }], addMissing: false, targets: [mscratch1] });
    await new Promise((r) => setTimeout(r, 300));
    check('macro page: skip decision writes nothing', JSON.stringify(Cproject.load(mscratch1).listOption('c.compiler.defs').values) === beforeSkip);
    // applyRest: first review SKIPS m1, second decision applies to ALL remaining
    macroQuickPicks.push('skip', 'applyRest');
    for (const h of macroHandlers)
      h({ command: 'applyMacros', panes: [{ key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'DEBUG=8' }], addMissing: false, targets: [mscratch1, mscratch2] });
    await new Promise((r) => setTimeout(r, 300));
    check('macro page: applyRest writes every remaining project', !Cproject.load(mscratch1).listOption('c.compiler.defs').values.includes('DEBUG=8') && Cproject.load(mscratch2).listOption('c.compiler.defs').values.includes('DEBUG=8'));
    check('macro page: applyRest done message (1/1 written, 1 skipped in review)', macroPosted.some((m) => m.command === 'macroDone' && m.text.includes('1/1 written') && m.text.includes('1 skipped')));
    // Esc on the first review cancels ALL remaining without writing
    macroQuickPicks.push(undefined);
    for (const h of macroHandlers)
      h({ command: 'applyMacros', panes: [{ key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'DEBUG=9' }], addMissing: false, targets: [mscratch1, mscratch2] });
    await new Promise((r) => setTimeout(r, 300));
    check('macro page: Esc on review cancels everything', !Cproject.load(mscratch1).listOption('c.compiler.defs').values.includes('DEBUG=9') && !Cproject.load(mscratch2).listOption('c.compiler.defs').values.includes('DEBUG=9'));
    // empty targets must be refused without writing anything
    const beforeEmpty = Cproject.load(mscratch1).listOption('c.compiler.defs').values;
    for (const h of macroHandlers)
      h({ command: 'applyMacros', panes: [{ key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'DEBUG=9' }], addMissing: false, targets: [] });
    await new Promise((r) => setTimeout(r, 300));
    check('macro page: empty targets refused (warning, no write)', macroWarnArgs !== null && JSON.stringify(Cproject.load(mscratch1).listOption('c.compiler.defs').values) === JSON.stringify(beforeEmpty));

    // ---- undo last apply: restore the BEFORE macros of everything the
    // last successful apply wrote (m1: DEBUG=1+NEW_MACRO=42 → back to DEBUG=0;
    // m2: DEBUG=8 → back to DEBUG=0), and the second undo has nothing to do
    const beforeUndo1 = Cproject.load(mscratch1).listOption('c.compiler.defs').values;
    const beforeUndo2 = Cproject.load(mscratch2).listOption('c.compiler.defs').values;
    check('undo fixture: both scratch projects were written earlier', beforeUndo1.includes('DEBUG=1') && beforeUndo2.includes('DEBUG=8'));
    for (const h of macroHandlers) h({ command: 'undoMacros' });
    await new Promise((r) => setTimeout(r, 300));
    const afterUndo1 = Cproject.load(mscratch1).listOption('c.compiler.defs').values;
    const afterUndo2 = Cproject.load(mscratch2).listOption('c.compiler.defs').values;
    // replacement semantics: only the LAST apply's projects ride the undo —
    // m1 was written by an EARLIER apply and keeps that earlier change
    check('undo: m2 restored (DEBUG=0 back, DEBUG=8 gone)', afterUndo2.includes('DEBUG=0') && !afterUndo2.includes('DEBUG=8'));
    check('undo: m1 untouched (earlier apply, not in the last snapshot)', afterUndo1.includes('DEBUG=1') && afterUndo1.includes('NEW_MACRO=42') && !afterUndo1.includes('DEBUG=0'));
    check('undo: stored shape intact on the restored project (quoted listOptionValue)', fs.readFileSync(mscratch2 + '/.cproject', 'utf-8').includes('&quot;DEBUG=0&quot;'));
    // the snapshot is consumed: a second undo reports nothing to undo
    const stable = JSON.stringify(Cproject.load(mscratch1).listOption('c.compiler.defs').values);
    for (const h of macroHandlers) h({ command: 'undoMacros' });
    await new Promise((r) => setTimeout(r, 300));
    check('undo: second undo is a no-op (snapshot consumed)', JSON.stringify(Cproject.load(mscratch1).listOption('c.compiler.defs').values) === stable);

    // ---- skip-review fast mode: writes WITHOUT any review QuickPick
    // (the decision queue stays empty — a review call would consume an
    // undefined = Esc = cancel everything, so success proves the review
    // never ran); Undo still snapshots the before state
    macroQuickPicks.length = 0;
    macroQuickPickItems = null;
    for (const h of macroHandlers)
      h({ command: 'applyMacros', panes: [{ key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'DEBUG=11\nFAST=1' }], addMissing: true, skipReview: true, targets: [mscratch1, mscratch2] });
    await new Promise((r) => setTimeout(r, 300));
    const fastAfter1 = Cproject.load(mscratch1).listOption('c.compiler.defs').values;
    const fastAfter2 = Cproject.load(mscratch2).listOption('c.compiler.defs').values;
    check('skip review: both projects written without any QuickPick', macroQuickPickItems === null && fastAfter1.includes('DEBUG=11') && fastAfter1.includes('FAST=1') && fastAfter2.includes('DEBUG=11') && fastAfter2.includes('FAST=1'));
    check('skip review: done message (2/2 written, 0 skipped)', macroPosted.some((m) => m.command === 'macroDone' && m.text.includes('2/2 written') && m.text.includes('0 skipped')));
    for (const h of macroHandlers) h({ command: 'undoMacros' });
    await new Promise((r) => setTimeout(r, 300));
    const fastUndo1 = Cproject.load(mscratch1).listOption('c.compiler.defs').values;
    const fastUndo2 = Cproject.load(mscratch2).listOption('c.compiler.defs').values;
    // each project restores to ITS OWN pre-apply state (m1: the earlier
    // apply's DEBUG=1; m2: the pristine DEBUG=0) — the fast-mode additions
    // are gone either way
    check('skip review: undo still restores the fast-mode apply', !fastUndo1.includes('DEBUG=11') && !fastUndo1.includes('FAST=1') && fastUndo1.includes('DEBUG=1') && !fastUndo2.includes('DEBUG=11') && !fastUndo2.includes('FAST=1') && fastUndo2.includes('DEBUG=0'));
    // re-entry guard (after the undo chain above): a second apply while one
    // is running must be refused — busy hint posted, second write never lands
    {
      const tBusyHint = require(path.join(__dirname, '..', 'out', 'core', 'i18n.js')).t('macroBatchBusy');
      const postedBefore = macroPosted.length;
      for (const h of macroHandlers) {
        h({ command: 'applyMacros', panes: [{ key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'BUSY=1' }], addMissing: true, skipReview: true, targets: [mscratch1] });
        h({ command: 'applyMacros', panes: [{ key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'BUSY=2' }], addMissing: true, skipReview: true, targets: [mscratch1] });
      }
      await new Promise((r) => setTimeout(r, 300));
      const busyPosted = macroPosted.slice(postedBefore).some((m) => m.command === 'macroDone' && m.text === tBusyHint);
      check('re-entry: the overlapped second apply is refused with the busy hint', busyPosted);
      check('re-entry: exactly one write landed (BUSY=1 from the first, BUSY=2 refused)', Cproject.load(mscratch1).listOption('c.compiler.defs').values.includes('BUSY=1') && !Cproject.load(mscratch1).listOption('c.compiler.defs').values.includes('BUSY=2'));
    }
    fs.rmSync(mscratch1, { recursive: true, force: true });
    fs.rmSync(mscratch2, { recursive: true, force: true });

    // ---- properties Apply: 'default' on a REAL enum choice (round-11 P3-2) ----
    // the handler used to map 'default' to setOptionValue(undefined), which
    // keeps an enumerated value attribute by design — switching a stored
    // non-default choice back to Default was a silent no-op
    {
      const scratchA = path.join(__dirname, '..', '.scratch', 'apply-default');
      fs.rmSync(scratchA, { recursive: true, force: true });
      fs.cpSync(PROJ, scratchA, { recursive: true });
      const projA = {
        root: scratchA,
        projectName: 'LED',
        projectDisplayName: 'LED',
        buildDir: path.join(scratchA, 'obj'),
        hexPath: path.join(scratchA, 'obj', 'LED.hex'),
        kernel: undefined,
        template: readTemplate(scratchA),
        cproject: Cproject.load(scratchA),
        projectFile: readProjectFile(scratchA),
        toolchain: () => null,
        logicPathOf: () => undefined,
        reload() {},
      };
      const handlersA = [];
      const panelA = {
        html: '',
        title: '',
        reveal() {},
        dispose() {},
        onDidDispose() { return { dispose() {} }; },
        webview: {
          onDidReceiveMessage(h) { handlersA.push(h); return { dispose() {} }; },
          postMessage() { return Promise.resolve(true); },
        },
      };
      const savedCreate = vscodeStub.window.createWebviewPanel;
      vscodeStub.window.createWebviewPanel = () => panelA;
      const viewA = new ConfigView({ active: projA, all: [] }, ctx);
      await viewA.show(projA);
      vscodeStub.window.createWebviewPanel = savedCreate;
      const ENUM = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.align.';
      for (const h of handlersA) h({ command: 'save', values: { align: 'strict', picolibc: 'double' } });
      await new Promise((r) => setTimeout(r, 300));
      check('apply: non-default enum written (align=strict)', Cproject.load(scratchA).optionValue('target.align') === ENUM + 'strict');
      check(
        'apply: picolibc enum written with the MRS2 value id',
        Cproject.load(scratchA).optionValue('c.linker.picolibc') ===
          'ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.linker.picolibc.double'
      );
      for (const h of handlersA) h({ command: 'save', values: { align: 'default' } });
      await new Promise((r) => setTimeout(r, 300));
      check(
        "apply: switching back to 'default' writes the REAL enum value (no silent clear)",
        Cproject.load(scratchA).optionValue('target.align') === ENUM + 'default'
      );
      fs.rmSync(scratchA, { recursive: true, force: true });
    }

    // ---- unknown enum choices are echoed back, never replaced (round-11
    // follow-up to the P1 incident: a stored value our list does not know
    // must not be silently overwritten by the <select>'s first entry) ----
    {
      const scratchC = path.join(__dirname, '..', '.scratch', 'apply-unknown-enum');
      fs.rmSync(scratchC, { recursive: true, force: true });
      fs.cpSync(PROJ, scratchC, { recursive: true });
      const ENUM = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.align.';
      const seeded = Cproject.load(scratchC);
      seeded.setOptionValue('target.align', ENUM + 'futurechoice');
      seeded.save();
      const projC = {
        root: scratchC,
        projectName: 'LED',
        projectDisplayName: 'LED',
        buildDir: path.join(scratchC, 'obj'),
        hexPath: path.join(scratchC, 'obj', 'LED.hex'),
        kernel: undefined,
        template: readTemplate(scratchC),
        cproject: Cproject.load(scratchC),
        projectFile: readProjectFile(scratchC),
        toolchain: () => null,
        logicPathOf: () => undefined,
        reload() {},
      };
      const handlersC = [];
      const panelC = {
        html: '',
        title: '',
        reveal() {},
        dispose() {},
        onDidDispose() { return { dispose() {} }; },
        webview: {
          onDidReceiveMessage(h) { handlersC.push(h); return { dispose() {} }; },
          postMessage() { return Promise.resolve(true); },
        },
      };
      const savedCreate2 = vscodeStub.window.createWebviewPanel;
      vscodeStub.window.createWebviewPanel = () => panelC;
      const viewC = new ConfigView({ active: projC, all: [] }, ctx);
      await viewC.show(projC);
      vscodeStub.window.createWebviewPanel = savedCreate2;
      check('unknown enum: rendered as a selected "(current)" option', /<option value="futurechoice" selected>\(current\) futurechoice<\/option>/.test(panelC.webview.html));
      for (const h of handlersC) h({ command: 'save', values: { align: 'futurechoice' } });
      await new Promise((r) => setTimeout(r, 300));
      check('unknown enum: Apply echoes it back unchanged', Cproject.load(scratchC).optionValue('target.align') === ENUM + 'futurechoice');
      fs.rmSync(scratchC, { recursive: true, force: true });
    }

    // ---- Apply with NOTHING edited must leave .cproject byte-identical ----
    // (the diff baseline: the handler writes only fields whose posted value
    // differs from what the page rendered)
    {
      const scratchD = path.join(__dirname, '..', '.scratch', 'apply-noop');
      fs.rmSync(scratchD, { recursive: true, force: true });
      fs.cpSync(PROJ, scratchD, { recursive: true });
      const cpFile = path.join(scratchD, '.cproject');
      const before = fs.readFileSync(cpFile);
      const projD = {
        root: scratchD,
        projectName: 'LED',
        projectDisplayName: 'LED',
        buildDir: path.join(scratchD, 'obj'),
        hexPath: path.join(scratchD, 'obj', 'LED.hex'),
        kernel: undefined,
        template: readTemplate(scratchD),
        cproject: Cproject.load(scratchD),
        projectFile: readProjectFile(scratchD),
        toolchain: () => null,
        logicPathOf: () => undefined,
        reload() {},
      };
      const handlersD = [];
      const panelD = {
        html: '',
        title: '',
        reveal() {},
        dispose() {},
        onDidDispose() { return { dispose() {} }; },
        webview: {
          onDidReceiveMessage(h) { handlersD.push(h); return { dispose() {} }; },
          postMessage() { return Promise.resolve(true); },
        },
      };
      const savedCreate3 = vscodeStub.window.createWebviewPanel;
      vscodeStub.window.createWebviewPanel = () => panelD;
      const viewD = new ConfigView({ active: projD, all: [] }, ctx);
      await viewD.show(projD);
      vscodeStub.window.createWebviewPanel = savedCreate3;
      // every control posts back the value it rendered — exactly what the
      // page does when the user clicks Apply without editing anything
      const untouched = Object.fromEntries(viewD.initial);
      check('apply noop: snapshot covers the whole form', Object.keys(untouched).length > 100);
      for (const h of handlersD) h({ command: 'save', values: untouched });
      await new Promise((r) => setTimeout(r, 300));
      const after = fs.readFileSync(cpFile);
      check('apply noop: no-edit Apply leaves .cproject byte-identical', before.equals(after));
      fs.rmSync(scratchD, { recursive: true, force: true });
    }

    // ---- Apply refuses a structurally damaged .cproject (pre-write gate) ----
    // the lenient parser can read it, a strict one cannot — rewriting it would
    // cement the damage, so the gate must abort BEFORE any write
    {
      const scratchE = path.join(__dirname, '..', '.scratch', 'apply-broken-xml');
      fs.rmSync(scratchE, { recursive: true, force: true });
      fs.cpSync(PROJ, scratchE, { recursive: true });
      const cpFileE = path.join(scratchE, '.cproject');
      fs.appendFileSync(cpFileE, '\nGARBAGE AFTER ROOT\n');
      const beforeE = fs.readFileSync(cpFileE);
      const projE = {
        root: scratchE,
        projectName: 'LED',
        projectDisplayName: 'LED',
        buildDir: path.join(scratchE, 'obj'),
        hexPath: path.join(scratchE, 'obj', 'LED.hex'),
        kernel: undefined,
        template: readTemplate(scratchE),
        cproject: Cproject.load(scratchE),
        projectFile: readProjectFile(scratchE),
        toolchain: () => null,
        logicPathOf: () => undefined,
        reload() {},
      };
      const handlersE = [];
      const panelE = {
        html: '',
        title: '',
        reveal() {},
        dispose() {},
        onDidDispose() { return { dispose() {} }; },
        webview: {
          onDidReceiveMessage(h) { handlersE.push(h); return { dispose() {} }; },
          postMessage() { return Promise.resolve(true); },
        },
      };
      const savedCreateE = vscodeStub.window.createWebviewPanel;
      vscodeStub.window.createWebviewPanel = () => panelE;
      const viewE = new ConfigView({ active: projE, all: [] }, ctx);
      await viewE.show(projE);
      vscodeStub.window.createWebviewPanel = savedCreateE;
      const savedErr = vscodeStub.window.showErrorMessage;
      let errorMsgE = '';
      vscodeStub.window.showErrorMessage = (msg) => {
        errorMsgE = String(msg);
      };
      for (const h of handlersE) h({ command: 'save', values: { align: 'strict' } });
      await new Promise((r) => setTimeout(r, 300));
      vscodeStub.window.showErrorMessage = savedErr;
      check('apply gate: damaged .cproject refused before any write', /damaged/.test(errorMsgE) && fs.readFileSync(cpFileE).equals(beforeE));
      // second corruption shape: an XML LEXICAL error (bare & in character
      // data) — the same gate must refuse it (round-13 P2)
      fs.writeFileSync(cpFileE, fs.readFileSync(cpFileE, 'utf-8').replace('</cconfiguration>', 'AT&T</cconfiguration>'));
      const beforeE2 = fs.readFileSync(cpFileE);
      errorMsgE = '';
      vscodeStub.window.showErrorMessage = (msg) => {
        errorMsgE = String(msg);
      };
      for (const h of handlersE) h({ command: 'save', values: { align: 'strict' } });
      await new Promise((r) => setTimeout(r, 300));
      vscodeStub.window.showErrorMessage = savedErr;
      check(
        'apply gate: XML lexical error (bare &) refused before any write',
        /damaged/.test(errorMsgE) && fs.readFileSync(cpFileE).equals(beforeE2)
      );
      // third corruption shape: an invalid XML character reference (&#0;) —
      // round-14 P2; the shape is a legal reference, the CODE POINT is not
      fs.writeFileSync(cpFileE, fs.readFileSync(cpFileE, 'utf-8').replace('</cconfiguration>', '&#0;</cconfiguration>'));
      const beforeE3 = fs.readFileSync(cpFileE);
      errorMsgE = '';
      vscodeStub.window.showErrorMessage = (msg) => {
        errorMsgE = String(msg);
      };
      for (const h of handlersE) h({ command: 'save', values: { align: 'strict' } });
      await new Promise((r) => setTimeout(r, 300));
      vscodeStub.window.showErrorMessage = savedErr;
      check(
        'apply gate: invalid character reference refused before any write',
        /damaged/.test(errorMsgE) && fs.readFileSync(cpFileE).equals(beforeE3)
      );
      // fourth corruption shape: invalid UTF-8 bytes — a text-level read
      // would show U+FFFD and pass, the fatal decode must refuse (round-14 P2)
      const bytesE = fs.readFileSync(cpFileE);
      const atE = bytesE.indexOf(Buffer.from('<cconfiguration'));
      fs.writeFileSync(cpFileE, Buffer.concat([bytesE.subarray(0, atE), Buffer.from([0x80]), bytesE.subarray(atE)]));
      const beforeE4 = fs.readFileSync(cpFileE);
      errorMsgE = '';
      vscodeStub.window.showErrorMessage = (msg) => {
        errorMsgE = String(msg);
      };
      for (const h of handlersE) h({ command: 'save', values: { align: 'strict' } });
      await new Promise((r) => setTimeout(r, 300));
      vscodeStub.window.showErrorMessage = savedErr;
      check(
        'apply gate: invalid UTF-8 refused before any write',
        /damaged/.test(errorMsgE) && fs.readFileSync(cpFileE).equals(beforeE4)
      );
      fs.rmSync(scratchE, { recursive: true, force: true });
    }

    // ---- path-entry validation on Apply (user request 2026-11-16) ----
    // a typo in ${workspace_loc:/${ProjName}/...} silently breaks the build;
    // the gate refuses malformed macros outright and asks about unknown
    // macros / missing folders before writing anything
    {
      const { t } = require('../out/core/i18n.js');
      const scratchP = path.join(__dirname, '..', '.scratch', 'path-gate');
      fs.rmSync(scratchP, { recursive: true, force: true });
      fs.cpSync(PROJ, scratchP, { recursive: true });
      const cpFileP = path.join(scratchP, '.cproject');
      const projP = {
        root: scratchP,
        projectName: 'LED',
        projectDisplayName: 'LED',
        buildDir: path.join(scratchP, 'obj'),
        hexPath: path.join(scratchP, 'obj', 'LED.hex'),
        kernel: undefined,
        template: readTemplate(scratchP),
        cproject: Cproject.load(scratchP),
        projectFile: readProjectFile(scratchP),
        toolchain: () => null,
        logicPathOf: () => undefined,
        reload() {},
      };
      const handlersP = [];
      const panelP = {
        html: '',
        title: '',
        reveal() {},
        dispose() {},
        onDidDispose() { return { dispose() {} }; },
        webview: {
          onDidReceiveMessage(h) { handlersP.push(h); return { dispose() {} }; },
          postMessage() { return Promise.resolve(true); },
        },
      };
      const savedCreateP = vscodeStub.window.createWebviewPanel;
      vscodeStub.window.createWebviewPanel = () => panelP;
      const viewP = new ConfigView({ active: projP, all: [] }, ctx);
      await viewP.show(projP);
      vscodeStub.window.createWebviewPanel = savedCreateP;
      const savedWarnP = vscodeStub.window.showWarningMessage;
      const savedErrP = vscodeStub.window.showErrorMessage;
      const missingEntry = '${workspace_loc:/${ProjName}/__mrvc_missing__}';
      // 1) missing folder + user backs out (dialog dismissed) → no write
      let warnedP = 0;
      vscodeStub.window.showWarningMessage = () => {
        warnedP++;
        return Promise.resolve(undefined);
      };
      const beforeP = fs.readFileSync(cpFileP);
      for (const h of handlersP) h({ command: 'save', values: { incs: missingEntry } });
      await new Promise((r) => setTimeout(r, 300));
      check(
        'path gate: dismissing the missing-path prompt writes nothing',
        warnedP === 1 && fs.readFileSync(cpFileP).equals(beforeP)
      );
      // 2) same entry, user continues → row lands in the .cproject
      vscodeStub.window.showWarningMessage = () => {
        warnedP++;
        return Promise.resolve(t('propertiesPathContinue'));
      };
      for (const h of handlersP) h({ command: 'save', values: { incs: missingEntry } });
      await new Promise((r) => setTimeout(r, 300));
      check(
        'path gate: continuing writes the acknowledged entry',
        warnedP === 2 && Cproject.load(scratchP).listOption('c.compiler.include.paths').values.includes(missingEntry)
      );
      // 3) malformed macro is a hard error — never prompts, never writes
      const beforeP3 = fs.readFileSync(cpFileP);
      let errorMsgP = '';
      let warnedP3 = 0;
      vscodeStub.window.showWarningMessage = () => {
        warnedP3++;
        return Promise.resolve(undefined);
      };
      vscodeStub.window.showErrorMessage = (msg) => {
        errorMsgP = String(msg);
      };
      for (const h of handlersP) h({ command: 'save', values: { incs: '${workspace_loc:/${ProjName}/oops' } });
      await new Promise((r) => setTimeout(r, 300));
      check(
        'path gate: malformed macro is a hard error with no prompt and no write',
        /unclosed/.test(errorMsgP) && warnedP3 === 0 && fs.readFileSync(cpFileP).equals(beforeP3)
      );
      // 4) unknown macro is only a confirmation, like a missing folder
      let unknownDetailP = '';
      vscodeStub.window.showWarningMessage = (_msg, opts) => {
        unknownDetailP = String(opts && opts.detail);
        return Promise.resolve(t('propertiesPathBack'));
      };
      vscodeStub.window.showErrorMessage = (msg) => {
        errorMsgP = String(msg);
      };
      for (const h of handlersP) h({ command: 'save', values: { incs: '${workspac_loc:/${ProjName}/inc}' } });
      await new Promise((r) => setTimeout(r, 300));
      check(
        'path gate: unknown macro asks before writing',
        /workspac_loc/.test(unknownDetailP) && fs.readFileSync(cpFileP).equals(beforeP3)
      );
      vscodeStub.window.showWarningMessage = savedWarnP;
      vscodeStub.window.showErrorMessage = savedErrP;
      fs.rmSync(scratchP, { recursive: true, force: true });
    }

    // ---- project store: the Refresh button re-renders unchanged workspaces ----
    // (user report 2026-11-12: files deleted inside a project stayed in the
    // tree — discovery fires nothing when the project SET is unchanged)
    {
      const { ProjectStore } = require('../out/vscode/projects.js');
      const storeR = new ProjectStore({ subscriptions: [] });
      let fired = 0;
      storeR.onDidChange(() => fired++);
      await storeR.refreshWorkspace();
      check('refresh: an unchanged workspace still fires a view refresh', fired >= 1);
      storeR.dispose();
    }

    // ---- C++ project render: the C++ Compiler pages must appear and show
    // the MRS2-aligned controls (user report 2026-11-16) ----
    {
      const CPP = ['F:/MyProjects/MRS2_VSCODE/TEST/FingerCode/FingerCode/FingerCode'].find((p) =>
        fs.existsSync(path.join(p, '.cproject'))
      );
      if (!CPP) {
        console.log('SKIP  C++ render (no C++ project tree found)');
      } else {
        const cppCp = Cproject.load(CPP);
        const storeCpp = {
          ...store,
          active: {
            ...store.active,
            root: CPP,
            projectName: 'FingerCode',
            projectDisplayName: 'FingerCode',
            buildDir: path.join(CPP, 'obj'),
            hexPath: path.join(CPP, 'obj', 'FingerCode.hex'),
            template: readTemplate(CPP),
            cproject: cppCp,
            projectFile: readProjectFile(CPP),
          },
        };
        await view.show(storeCpp.active);
        const h = stubPanel.webview.html;
        check('cpp render: C++ Compiler Optimization page is present', h.includes('data-page="cpp.opt"'));
        check('cpp render: Includes list controls render', h.includes('data-key="cppincs"') && h.includes('data-key="cppsysincs"') && h.includes('data-key="cppfileincs"'));
        check('cpp render: ABI version + -fno-* switches render on Optimization', h.includes('data-key="cppabi"') && h.includes('data-key="cppnoexc"'));
        check('cpp render: Miscellaneous switches render', h.includes('data-key="cppasmlisting"') && h.includes('data-key="cppsavetemps"') && h.includes('data-key="cppverbose"'));
        check(
          'cpp render: Linker pages expose the mirrored fields',
          h.includes('data-key="cppnodeflibs"') &&
            h.includes('data-key="cppldflags"') &&
            h.includes('data-key="cppmapfile"') &&
            h.includes('data-key="cppcref"') &&
            h.includes('data-key="cpppicolibc"')
        );
        check(
          'cpp render: stored gnu++17 is selected in the standard select',
          /<option value="gnucpp17"\s+selected>GNU ISO 2017 C\+\+ \(-std=gnu\+\+17\)<\/option>/.test(h)
        );
        check('cpp render: stored ABI 0 shows the MRS2 label', /<option value="0"\s+selected>0 \(most conforming\)<\/option>/.test(h));
        check('cpp render: picolibc shows the stored disabled choice', /<option value="disabled"\s+selected>Disabled<\/option>/.test(h));
        check('cpp render: no [object Object] interpolation leak', !h.includes('[object Object]'));
      }
    }

    fs.rmSync(scratch2, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILURES` : '\nwebview render verification passed');
    process.exit(failures ? 1 : 0);
  })();
})();
