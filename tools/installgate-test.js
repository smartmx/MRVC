/*
 * Install gate: the extension starts only when at least one install setting
 * (MRS2 IDE / MRS3 IDE / standalone toolchain) passes validation. Otherwise it
 * does not start, reports each checked field with the reason, and starts as
 * soon as the settings are fixed — no window reload. Stubs vscode (mutable
 * settings store, captured messages) and drives installGate() directly.
 *
 * Sections 1-5 run with the host platform forced to 'linux' so the machine's
 * real conventional locations (C:\MounRiver\...) can never leak into a
 * zero-config test; the adoption section runs on the real host, where the
 * conventional scan may find the machine's own install (SKIP elsewhere).
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const { setHostPlatformForTests } = require('../out/core/toolchain.js');
const REAL_HOST = process.platform;

const ROOT = path.join(__dirname, '..', '.scratch', 'installgate');
fs.rmSync(ROOT, { recursive: true, force: true });

/** every path this helper writes must stay inside ROOT */
function inside(root, target) {
  const resolved = path.resolve(root, target);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('refusing to write outside the scratch root: ' + target);
  }
  return resolved;
}

/** minimal fake IDE install for a host platform (linux/win32 shapes) */
function fakeInstall(name, gen, hostPlatform = 'linux') {
  const rootName = hostPlatform === 'darwin' ? name + '.app' : name;
  const root = inside(ROOT, rootName);
  const appDirName = path.join('resources', 'app');
  const appDir = inside(ROOT, path.join(rootName, appDirName));
  const layer = { win32: 'win32', linux: 'linux', darwin: 'darwin' }[hostPlatform] || 'linux';
  const res = inside(ROOT, path.join(rootName, appDirName, 'resources', layer));
  fs.mkdirSync(inside(ROOT, path.join(rootName, appDirName, 'resources', layer, 'components', 'WCH')), { recursive: true });
  fs.writeFileSync(inside(ROOT, path.join(rootName, appDirName, 'resources', layer, 'components', 'WCH', 'manifest.json')), '{}');
  fs.writeFileSync(
    inside(ROOT, path.join(rootName, appDirName, 'product.json')),
    JSON.stringify({ nameShort: 'MounRiver Studio ' + gen, mrsVersion: gen + '.0.0' })
  );
  if (hostPlatform === 'win32') {
    fs.writeFileSync(inside(ROOT, path.join(rootName, 'MounRiver Studio ' + gen + '.exe')), '');
  } else {
    fs.writeFileSync(inside(ROOT, path.join(rootName, 'mounriver-studio ' + gen)), '');
  }
  return root;
}

/** minimal standalone toolchain root (arch-agnostic: no gcc bytes) */
function fakeStandalone(name) {
  const root = inside(ROOT, name);
  const bin = inside(ROOT, path.join(name, 'Toolchain', 'RISC-V Embedded GCC', 'bin'));
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    inside(ROOT, path.join(name, 'Toolchain', 'sub_manifest.json')),
    JSON.stringify({
      details: [
        {
          name: 'GCC8',
          type: 'RISC-V',
          path: './RISC-V Embedded GCC',
          compiler_c_executable: { folder: './bin', name: 'riscv-none-embed-gcc' },
        },
      ],
    })
  );
  fs.writeFileSync(inside(ROOT, path.join(name, 'Toolchain', 'RISC-V Embedded GCC', 'bin', 'riscv-none-embed-gcc')), '');
  fs.mkdirSync(inside(ROOT, path.join(name, 'OpenOCD', 'OpenOCD', 'bin')), { recursive: true });
  fs.writeFileSync(inside(ROOT, path.join(name, 'OpenOCD', 'OpenOCD', 'bin', 'openocd')), '');
  return root;
}

const INST2 = fakeInstall('fake-mrs2', '2', 'linux');
const INST3 = fakeInstall('fake-mrs3', '3', 'linux');
const TCFIX = fakeStandalone('fake-tc');
const BAD = inside(ROOT, 'nope');
const BAD2 = inside(ROOT, 'nope2');
const BAD3 = inside(ROOT, 'nope3');
/** the stub's schema default for mrs3InstallPath (a path that does not exist) */
const DEFAULT3 = inside(ROOT, 'default-mrs3');

// ---- stub state the test drives ----
const settings = {};
const messages = [];
const configListeners = [];
/** every watcher the stub created, for driving ProjectStore's bump handlers */
const fakeWatchers = [];
const vscodeStub = {
  window: {
    showErrorMessage: (text, ...buttons) => {
      const m = { kind: 'error', text, buttons, reply: () => {} };
      messages.push(m);
      return new Promise((res) => {
        m.reply = res;
      });
    },
    showWarningMessage: (text, ...buttons) => {
      messages.push({ kind: 'warn', text, buttons, reply: () => {} });
      return Promise.resolve(undefined);
    },
    showInformationMessage: (text, ...buttons) => {
      messages.push({ kind: 'info', text, buttons, reply: () => {} });
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (k, d) => (k in settings ? settings[k] : d),
      inspect: (k) => ({
        key: 'mrvc.' + k,
        // the schema default is now EMPTY — the fromDefault machinery is
        // exercised by injecting a non-existent default for mrs3InstallPath
        defaultValue: k === 'mrs3InstallPath' ? DEFAULT3 : undefined,
        globalValue: settings[k],
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
      }),
      update: async (k, v) => {
        settings[k] = v;
      },
    }),
    onDidChangeConfiguration: (fn) => {
      configListeners.push(fn);
      return {
        dispose() {
          // real VSCode stops calling a disposed listener — the stub must too,
          // or a stale listener fires alongside the current one
          const i = configListeners.indexOf(fn);
          if (i >= 0) configListeners.splice(i, 1);
        },
      };
    },
    /** fake watchers so a real ProjectStore can be constructed and driven:
     *  every created watcher is recorded with its handlers for the tests */
    createFileSystemWatcher: (pattern) => {
      const w = {
        pattern: String(pattern.pattern ?? pattern),
        handlers: { change: [], create: [], delete: [] },
        onDidChange: (fn) => {
          w.handlers.change.push(fn);
          return { dispose() {} };
        },
        onDidCreate: (fn) => {
          w.handlers.create.push(fn);
          return { dispose() {} };
        },
        onDidDelete: (fn) => {
          w.handlers.delete.push(fn);
          return { dispose() {} };
        },
        dispose() {},
      };
      fakeWatchers.push(w);
      return w;
    },
  },
  commands: { executeCommand: () => Promise.resolve() },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  /** ProjectStore constructs EventEmitters — a minimal real one so the
   *  onDidChange subscription/fire cycle works in the stub */
  EventEmitter: class {
    constructor() {
      this.handlers = [];
    }
    get event() {
      return (fn) => {
        this.handlers.push(fn);
        return { dispose: () => this.handlers.splice(this.handlers.indexOf(fn), 1) };
      };
    }
    fire(x) {
      for (const fn of [...this.handlers]) fn(x);
    }
    dispose() {
      this.handlers = [];
    }
  },
  /** tree/monitor wiring constructs RelativePattern for every watcher */
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return orig.call(this, request, ...args);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failures++;
};

const { installGate, getInstall } = require('../out/vscode/projects.js');
const context = { subscriptions: [] };
let started = 0;
const onReady = () => {
  started++;
};
const fireConfig = (key) => configListeners.forEach((fn) => fn({ affectsConfiguration: (k) => k === 'mrvc.' + key }));
const flush = () => new Promise((res) => setImmediate(res));
const last = () => messages[messages.length - 1];

(async () => {
  // hermetic: no conventional location exists under a linux host on this box
  setHostPlatformForTests('linux');

  // 1. every field empty -> refuse to start, ask for a path
  check('gate: no path at all -> no start', installGate(context, onReady) === false && started === 0);
  check('gate: ... an error prompt is shown', messages.length === 1 && messages[0].kind === 'error');
  check(
    'gate: ... the prompt says the extension did not start and why',
    /did not start/.test(messages[0].text) && /no MounRiver installation path is configured/.test(messages[0].text)
  );
  check(
    'gate: ... and names all three settings (incl. the standalone toolchain)',
    /mrvc\.mrs2InstallPath/.test(messages[0].text) && /mrvc\.mrs3InstallPath/.test(messages[0].text) && /mrvc\.toolchainOnlyPath/.test(messages[0].text)
  );
  check('gate: ... offers to open the settings', messages[0].buttons[0] === 'Open settings');

  // 2. two paths that do not exist -> refuse, name both with the reason
  settings.mrs2InstallPath = BAD;
  settings.mrs3InstallPath = BAD3;
  check('gate: invalid paths -> no start', installGate(context, onReady) === false && started === 0);
  const invalid = last();
  check('gate: ... each field is named with its value', invalid.kind === 'error' && invalid.text.includes('mrvc.mrs2InstallPath = ' + BAD));
  check('gate: ... and with the reason', invalid.text.includes('the folder does not exist'));
  check('gate: ... a config listener is armed for the fix', configListeners.length === 1);

  // 3. fixing ONE field starts the extension, no reload needed
  settings.mrs3InstallPath = INST3;
  fireConfig('mrs3InstallPath');
  check('gate: fixing one path starts the extension (no reload)', started === 1);
  check('gate: ... and reports the start', messages.some((m) => m.kind === 'info' && /MRVC started/.test(m.text)));
  check('gate: ... afterwards the gate passes', installGate(context, onReady) === true && started === 1);

  // 3b. the standalone toolchain root alone also opens the gate
  settings.mrs2InstallPath = '';
  settings.mrs3InstallPath = '';
  settings.toolchainOnlyPath = TCFIX;
  check('gate: a standalone toolchain root alone starts the extension', installGate(context, onReady) === true && started === 1);
  settings.toolchainOnlyPath = BAD3;
  check('gate: ... an invalid one does not', installGate(context, onReady) === false && started === 1);
  settings.toolchainOnlyPath = TCFIX;
  fireConfig('toolchainOnlyPath');
  check('gate: ... fixing mrvc.toolchainOnlyPath starts it live', started === 2);

  // 4. a wrong-generation value in the OTHER field does not block the start:
  //    the valid field is used and the failure is reported as a warning
  settings.toolchainOnlyPath = '';
  settings.mrs2InstallPath = INST2;
  settings.mrs3InstallPath = INST2;
  check('gate: a valid field starts the extension despite the other one failing', installGate(context, onReady) === true && started === 2);
  {
    const before = messages.length;
    void getInstall();
    const warn = messages.slice(before).find((m) => m.kind === 'warn');
    check(
      'note: the failing field is reported with its reason',
      !!warn && warn.text.includes('mrvc.mrs3InstallPath') && warn.text.includes(INST2) && /it is a MounRiver Studio 2 installation/.test(warn.text)
    );
  }

  // 5. the two values swapped -> both wrong-generation, and the prompt offers
  //    to exchange them; that fix starts the extension
  settings.mrs2InstallPath = INST3;
  settings.mrs3InstallPath = INST2;
  check('gate: swapped values -> no start', installGate(context, onReady) === false && started === 2);
  const swapped = last();
  const swapBtn = swapped.buttons.find((b) => b === 'Swap them');
  check('gate: ... the prompt offers the swap', !!swapBtn);
  check(
    'gate: ... and says what is swapped where (per-field detected generation)',
    /look swapped/.test(swapped.text) && /"mrvc\.mrs2InstallPath" points at MounRiver Studio 3/.test(swapped.text)
  );
  if (swapBtn) {
    swapped.reply(swapBtn);
    await flush();
    check('gate: ... swapping writes both fields exchanged', settings.mrs2InstallPath === INST2 && settings.mrs3InstallPath === INST3);
    fireConfig('mrs2InstallPath');
    check('gate: ... and that starts the extension', started === 3);
  }

  // 6. back to the real host: schema-default silence + adopting a detected
  //    conventional install (only when this machine has one)
  setHostPlatformForTests(REAL_HOST);
  const WIN2 = fakeInstall('fake-win2', '2', 'win32');
  settings.mrs2InstallPath = WIN2;
  settings.mrs3InstallPath = DEFAULT3; // the schema default, and it does not exist
  {
    const before = messages.length;
    void getInstall();
    check(
      'note: a failing field that still holds the SCHEMA default stays silent',
      !messages.slice(before).some((m) => m.kind === 'warn')
    );
  }
  settings.mrs2InstallPath = BAD2;
  settings.mrs3InstallPath = BAD2;
  check('gate: two unusable paths -> no start', installGate(context, onReady) === false && started === 3);
  const promo = last();
  const useBtn = (promo.buttons || []).find((b) => /^Use detected /.test(b));
  if (useBtn) {
    promo.reply(useBtn);
    await flush();
    check('gate: adopting the detected install writes a real path', settings.mrs2InstallPath !== BAD2 && fs.existsSync(settings.mrs2InstallPath));
    fireConfig('mrs2InstallPath');
    check('gate: ... and that starts the extension', started === 4);
  } else {
    console.log('SKIP  gate: no conventional installation on this machine to adopt');
  }

  // 7. POSIX per-toolchain arch gate on MrsProject.toolchain (round20 §5.4):
  // the UI glue warns on EVERY mismatched call and returns null; the native
  // toolchain passes through untouched
  setHostPlatformForTests('linux');
  {
    const HOSTA = process.arch === 'arm64' ? 'arm64' : 'x64';
    const OTHERA = HOSTA === 'arm64' ? 'x64' : 'arm64';
    const elfBytes = (arch) => {
      const b = Buffer.alloc(24);
      b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46; // \x7fELF
      b.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18); // e_machine
      return b;
    };
    // minimal project fixture (same shape rename-test uses)
    const projRoot = inside(ROOT, 'arch-proj');
    fs.mkdirSync(path.join(projRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      inside(ROOT, 'arch-proj/.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>ArchProj</name></projectDescription>'
    );
    fs.writeFileSync(
      inside(ROOT, 'arch-proj/.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="c" name="obj" artifactName="${ProjName}">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
    );
    // fake install: two toolchains with distinct binary arches (mac V2.4 shape)
    const mkTc = (name, dirName, gccName, arch) => {
      const bin = inside(ROOT, 'tc-' + dirName + '/bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(inside(ROOT, 'tc-' + dirName + '/bin/' + gccName), elfBytes(arch));
      return {
        name,
        dir: inside(ROOT, 'tc-' + dirName),
        compilerC: inside(ROOT, 'tc-' + dirName + '/bin/' + gccName),
        compilerCpp: '', linkerC: '', linkerCpp: '', debugger: '', objcopy: '', objdump: '', size: '', prefix: '',
      };
    };
    const archInst = {
      root: ROOT, resourcesDir: '', kind: 'ide', components: '', makeBin: '',
      openocdExe: '', openocdCfg: '', linkUtilityExe: '',
      toolchains: [
        mkTc('GCC12', 'gcc12', 'riscv-wch-elf-gcc', OTHERA),
        mkTc('GCC8', 'gcc8', 'riscv-none-embed-gcc', HOSTA),
      ],
      flavor: 'mrs3', label: 'MounRiver Studio 3',
    };
    const { MrsProject } = require('../out/vscode/projects.js');
    const proj = new MrsProject(projRoot);
    const archWarns = () => messages.filter((m) => m.kind === 'warn' && m.text.includes(HOSTA)).length;
    const r1 = proj.toolchain(archInst, 'GCC12');
    check('arch gate: mismatched selection -> null + warned', r1 === null && archWarns() === 1);
    const r2 = proj.toolchain(archInst, 'GCC12');
    check('arch gate: EVERY mismatched call warns again (no silent retries)', r2 === null && archWarns() === 2);
    const r3 = proj.toolchain(archInst, 'GCC8');
    check('arch gate: the native toolchain passes through untouched', !!r3 && r3.name === 'GCC8');
  }

  // 8. build-time tree-refresh suspension (round: linked-folder decorations
  //    blinking white↔blue during a build) — a real ProjectStore is driven
  //    through its fake obj-watcher: unsuspended bumps fire (debounced),
  //    suspended bumps are swallowed, resume fires one catch-up refresh
  {
    // legality gate (0.2.8 contract: 工程名.wvproj + companions .project
    // AND .cproject) — probe debris carrying an incomplete triple must NOT
    // crash the loader with an ENOENT (the reported failure: reading
    // .cproject threw), it is refused with a clear warning instead; and a
    // VANISHED root must not throw either (round6 §2 — the readdirSync in
    // the missing-files probe used to abort the whole workspace scan)
    const badRoot = inside(ROOT, 'debris-proj');
    fs.mkdirSync(badRoot, { recursive: true });
    fs.writeFileSync(
      inside(ROOT, 'debris-proj/.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>Debris</name></projectDescription>'
    );
    const storeCtx0 = {
      subscriptions: [],
      workspaceState: { get: () => undefined, update: async () => {} },
      globalState: { get: () => undefined, update: async () => {} },
    };
    const store0 = new (require('../out/vscode/projects.js').ProjectStore)(storeCtx0);
    const before = messages.length;
    const rejected = store0.add(badRoot);
    const last = messages[messages.length - 1];
    check(
      'legality: an incomplete triple is refused with a warning, not an ENOENT',
      rejected === null && messages.length === before + 1 && typeof last?.text === 'string' && last.text.includes('.cproject'),
      rejected ? ' — add() accepted the debris root' : ''
    );
    // round6 §2: a root that VANISHED after discovery must resolve to null
    // without throwing (the readdirSync in the missing-files probe)
    let vanishedOk = true;
    let vanishedResult;
    try {
      vanishedResult = store0.add(inside(ROOT, 'gone-proj'));
    } catch (e) {
      vanishedOk = false;
      vanishedResult = `threw: ${e.message}`;
    }
    check(
      'legality: a vanished/unreadable root resolves to null without throwing',
      vanishedOk && vanishedResult === null
    );
    store0.dispose();
  }
  {
    const projRoot = inside(ROOT, 'watch-proj');
    fs.mkdirSync(path.join(projRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      inside(ROOT, 'watch-proj/WatchProj.wvproj'),
      'WatchProj'
    );
    fs.writeFileSync(
      inside(ROOT, 'watch-proj/.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>WatchProj</name></projectDescription>'
    );
    fs.writeFileSync(
      inside(ROOT, 'watch-proj/.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="c" name="obj" artifactName="${ProjName}">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
    );
    const { ProjectStore } = require('../out/vscode/projects.js');
    const storeCtx = {
      subscriptions: [],
      workspaceState: { get: () => undefined, update: async () => {} },
      globalState: { get: () => undefined, update: async () => {} },
    };
    const store = new ProjectStore(storeCtx);
    const proj = store.add(projRoot);
    check(
      'watch: the project is added with its watchers',
      !!proj && fakeWatchers.some((w) => /obj/.test(w.pattern)),
      proj ? '' : ' — last message: ' + (messages[messages.length - 1]?.text ?? '(none)')
    );
    let fires = 0;
    store.onDidChange(() => fires++);
    const outW = fakeWatchers.find((w) => w.pattern.includes('obj'));
    const bumpObj = (name) => outW.handlers.change.forEach((fn) => fn({ fsPath: path.join(projRoot, 'obj', name) }));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // unsuspended: an obj write bumps -> 400ms debounce -> exactly one fire
    bumpObj('a.o');
    await wait(520);
    const afterFree = fires;
    check('watch: an unsuspended bump fires exactly once (debounced)', afterFree === 1);
    // round22 §5.5 negative probe: a bump whose debounce is ALREADY queued,
    // followed immediately by suspend — the queued fire must be cancelled
    bumpObj('pending.o');
    store.suspendTreeRefresh();
    await wait(520);
    check('watch: a pre-suspension pending debounce stays suppressed', fires === afterFree);
    // suspended: a whole build's worth of obj writes fires NOTHING
    for (let i = 0; i < 5; i++) {
      bumpObj('b' + i + '.o');
      await wait(60);
    }
    check('watch: suspended bumps fire nothing during the build', fires === afterFree);
    // resume: catch-up refresh is DELAYED 1 s (coalesced with the task-end
    // refresh that fires immediately in the real wiring)
    store.resumeTreeRefresh();
    await wait(120);
    check('watch: resume does not fire immediately (coalesced)', fires === afterFree);
    // round23 §5.1: the catch-up must SURVIVE a re-suspend (Build All: the
    // catch-up window of member N overlaps member N+1's task start)
    store.suspendTreeRefresh();
    await wait(1100);
    check('watch: catch-up scheduled before a re-suspend is not lost', fires === afterFree);
    store.resumeTreeRefresh();
    await wait(1200);
    check('watch: catch-up preserved across the re-suspend fires once', fires === afterFree + 1);
    // round2 §3: deleting .cproject (legality broken) turns the loaded
    // project into a zombie — the watcher's delete handler and Refresh must
    // both drop it (previously only .project deletion did)
    fs.rmSync(inside(ROOT, 'watch-proj/.cproject'));
    const projWatcher = fakeWatchers.find((w) => w.pattern.includes('.cproject'));
    projWatcher.handlers.delete.forEach((fn) => fn({ fsPath: path.join(projRoot, '.cproject') }));
    check('watch: deleting .cproject drops the zombie from the store', store.get(projRoot) === null || store.get(projRoot) === undefined);
    store.dispose();
  }

  setHostPlatformForTests(REAL_HOST);
  console.log(failures ? `\n${failures} FAILURES` : '\nall install-gate tests passed');
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
