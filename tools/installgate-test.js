/*
 * Install gate: the extension starts only when at least one of the two install
 * paths passes validation (exists, is a MounRiver installation, right
 * generation, ships "MounRiver Studio <N>.exe"). Otherwise it does not start,
 * reports each checked field with the reason, and starts as soon as the
 * settings are fixed — no window reload. Stubs vscode (mutable settings store,
 * captured messages) and drives installGate() directly.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '.scratch', 'installgate');
fs.rmSync(ROOT, { recursive: true, force: true });

/** every path this helper writes must stay inside ROOT */
function inside(target) {
  const resolved = path.resolve(ROOT, target);
  if (resolved !== path.resolve(ROOT) && !resolved.startsWith(path.resolve(ROOT) + path.sep)) {
    throw new Error('refusing to write outside the scratch root: ' + target);
  }
  return resolved;
}

/** minimal fake install with its launcher program (valid per the new check) */
function fakeInstall(name, gen) {
  const root = inside(name);
  const win32 = path.join(root, 'resources', 'app', 'resources', 'win32');
  fs.mkdirSync(path.join(win32, 'components', 'WCH'), { recursive: true });
  fs.writeFileSync(path.join(win32, 'components', 'WCH', 'manifest.json'), '{}');
  fs.writeFileSync(
    path.join(root, 'resources', 'app', 'product.json'),
    JSON.stringify({ nameShort: 'MounRiver Studio ' + gen, mrsVersion: gen + '.0.0' })
  );
  fs.writeFileSync(path.join(root, 'MounRiver Studio ' + gen + '.exe'), '');
  return root;
}
const INST2 = fakeInstall('fake-mrs2', '2');
const INST3 = fakeInstall('fake-mrs3', '3');
const BAD = inside('nope');
const BAD2 = inside('nope2');
const BAD3 = inside('nope3');
/** the stub's schema default for mrs3InstallPath (a path that does not exist) */
const DEFAULT3 = inside('default-mrs3');

// ---- stub state the test drives ----
const settings = {};
const messages = [];
const configListeners = [];
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
        // the schema default tells a suggestion apart from a user choice
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
  },
  commands: { executeCommand: () => Promise.resolve() },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return orig.call(this, request, ...args);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
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
  // 1. both values empty -> refuse to start, ask for a path
  check('gate: no path at all -> no start', installGate(context, onReady) === false && started === 0);
  check('gate: ... an error prompt is shown', messages.length === 1 && messages[0].kind === 'error');
  check(
    'gate: ... the prompt says the extension did not start and why',
    /did not start/.test(messages[0].text) && /no MounRiver Studio installation path is configured/.test(messages[0].text)
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

  // 4. a wrong-generation value in the OTHER field does not block the start:
  //    the valid field is used and the failure is reported as a warning
  settings.mrs2InstallPath = INST2;
  settings.mrs3InstallPath = INST2;
  check('gate: a valid field starts the extension despite the other one failing', installGate(context, onReady) === true && started === 1);
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
  check('gate: swapped values -> no start', installGate(context, onReady) === false && started === 1);
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
    check('gate: ... and that starts the extension', started === 2);
  }

  // 6. adopting a detected conventional install (only when this machine has one)
  settings.mrs2InstallPath = INST2;
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
  check('gate: two unusable paths -> no start', installGate(context, onReady) === false && started === 2);
  const promo = last();
  const useBtn = promo.buttons.find((b) => /^Use detected /.test(b));
  if (useBtn) {
    promo.reply(useBtn);
    await flush();
    check('gate: adopting the detected install writes a real path', settings.mrs2InstallPath !== BAD2 && fs.existsSync(settings.mrs2InstallPath));
    fireConfig('mrs2InstallPath');
    check('gate: ... and that starts the extension', started === 3);
  } else {
    console.log('SKIP  gate: no conventional installation on this machine to adopt');
  }

  console.log(failures ? `\n${failures} FAILURES` : '\nall install-gate tests passed');
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
