/**
 * MRS runner (out/vscode/mrsValidate.js) fake-vscode tests — round23 P3.
 * Covers the lifecycle fixes the pure-contract test cannot reach:
 *   - setup failures (no IDE / no wvproj) resolve verdict 'setup-failed' and
 *     show the error exactly ONCE (no double popup with the caller's warning);
 *   - batch preflight refuses a standalone toolchain BEFORE any per-project
 *     popup;
 *   - the happy path streams the seeded Build Finished into the dedicated
 *     log terminal and settles on the process exit.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const here = path.dirname(fileURLToPath(import.meta.url));
const DEVELOP_DIR = path.join(here, '..');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const messages = [];
const errCount = () => messages.filter((m) => m.kind === 'error').length;
const warnCount = () => messages.filter((m) => m.kind === 'warn').length;

class Emitter {
  constructor() {
    this.listeners = [];
    this.event = (cb) => {
      this.listeners.push(cb);
      return { dispose: () => this.listeners.splice(this.listeners.indexOf(cb) >>> 0, 1) };
    };
  }
  fire(v) {
    for (const cb of [...this.listeners]) cb(v);
  }
  dispose() {
    this.listeners = [];
  }
}

const terminals = [];
const vscodeStub = {
  EventEmitter: Emitter,
  ProcessExecution: class {
    constructor(command, args, options) {
      this.command = command;
      this.args = args;
      this.options = options;
    }
  },
  Task: class {
    constructor(definition, name, source, execution, matchers) {
      this.definition = definition;
      this.name = name;
      this.source = source;
      this.execution = execution;
      this.problemMatchers = matchers;
    }
  },
  TaskGroup: { Build: 1 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1 },
  ProgressLocation: { Notification: 15 },
  window: {
    withProgress: (_opts, cb) => cb({ report() {} }, makeToken()),
    showErrorMessage: (m) => {
      messages.push({ kind: 'error', text: String(m) });
      return Promise.resolve(undefined);
    },
    showWarningMessage: (m) => {
      messages.push({ kind: 'warn', text: String(m) });
      return Promise.resolve(undefined);
    },
    showInformationMessage: (m) => {
      messages.push({ kind: 'info', text: String(m) });
      return Promise.resolve(undefined);
    },
    createTerminal: (opts) => {
      const t = { name: opts.name, written: [], disposed: false };
      terminals.push(t);
      const emitter = new Emitter();
      opts.pty.onDidWrite((text) => t.written.push(text));
      return {
        show: () => undefined,
        dispose: () => {
          t.disposed = true;
        },
      };
    },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (key, def) => def,
      inspect: () => ({ defaultValue: undefined }),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose() {} }),
      onDidCreate: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    }),
  },
  tasks: {
    onDidEndTaskProcess: undefined,
    executeTask: undefined,
  },
  CancellationTokenSource: class {
    constructor() {
      this.isCancellationRequested = false;
      this.listeners = [];
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: (cb) => {
          this.listeners.push(cb);
          return { dispose() {} };
        },
      };
    }
    cancel() {
      this.isCancellationRequested = true;
      this.token.isCancellationRequested = true;
      for (const cb of [...this.listeners]) cb();
    }
    dispose() {}
  },
};
function makeToken() {
  const listeners = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested(cb) {
      listeners.push(cb);
      return { dispose() {} };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const cb of [...listeners]) cb();
    },
  };
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-mrsrunner-stub';
  return origResolve.call(this, request, ...args);
};
require_.cache['vscode-mrsrunner-stub'] = {
  id: 'vscode-mrsrunner-stub',
  filename: 'vscode-mrsrunner-stub',
  loaded: true,
  exports: vscodeStub,
};

// round24 P3: the runner computes its isolated dir from os.homedir() — the
// test must NOT write the real user profile. Patch os.homedir() to a temp
// location BEFORE the runner module loads, and clean the whole tree at exit.
const FAKE_HOME = path.join(os.tmpdir(), 'mrvc-mrsrunner-home');
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_HOME, { recursive: true });
const realHomedir = os.homedir;
os.homedir = () => FAKE_HOME;
process.on('exit', () => {
  os.homedir = realHomedir;
  try {
    fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const WS = path.join(os.tmpdir(), 'mrvc-mrsrunner-test');
fs.rmSync(WS, { recursive: true, force: true });
const projRoot = path.join(WS, 'Demo');
fs.mkdirSync(projRoot, { recursive: true });
const WVP = path.join(projRoot, 'Demo.wvproj');
fs.writeFileSync(WVP, 'Demo');

const project = {
  root: projRoot,
  projectName: 'Demo',
  buildDir: path.join(projRoot, 'obj'),
};

const store = {
  all: [project],
  solutionList: [],
  active: project,
  setActive() {},
  onDidChange: () => ({ dispose() {} }),
  onTreeDirsChanged: () => ({ dispose() {} }),
};

const projects = require_(path.join(DEVELOP_DIR, 'out', 'vscode', 'projects.js'));
const toolchain = require_(path.join(DEVELOP_DIR, 'out', 'core', 'toolchain.js'));
require_(path.join(DEVELOP_DIR, 'out', 'core', 'i18n.js')).setLanguage('en');

const INSTALLS = {
  ide: { root: '/fake/mrs', resourcesDir: '/fake/res', kind: 'ide', flavor: 'mrs2', label: 'Fake MRS2', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [] },
  toolchain: { root: '/fake/tc', resourcesDir: '/fake/res', kind: 'toolchain', flavor: 'mrs2', label: 'Fake TC', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [] },
};
let currentInstall = INSTALLS.ide;
projects.getInstall = () => currentInstall;
toolchain.installLauncherPath = (install) => (install.kind === 'ide' ? 'C:/fake/MRS.exe' : '');

const { mrsValidateCmd, mrsValidateAllCmd, buildWithMrsCmd } = require_(path.join(DEVELOP_DIR, 'out', 'vscode', 'mrsValidate.js'));

// wire task-end events through a controllable list
const endListeners = [];
vscodeStub.tasks.onDidEndTaskProcess = (cb) => {
  endListeners.push(cb);
  return { dispose: () => endListeners.splice(endListeners.indexOf(cb) >>> 0, 1) };
};
const fireTaskEnd = (exec, exitCode) => {
  for (const cb of [...endListeners]) cb({ execution: exec, exitCode });
};

function seedSession(marker) {
  const logsRoot = path.join(os.homedir(), '.mrvc', 'mrs-validate', 'mrs2', 'user-data', 'logs');
  // future-stamped so newSessionDirs (sorted newest first) surfaces it
  const session = '2999' + String(Date.now()).slice(4);
  fs.mkdirSync(path.join(logsRoot, session, 'window1', 'exthost'), { recursive: true });
  fs.writeFileSync(path.join(logsRoot, session, 'main.log'), marker);
  fs.writeFileSync(path.join(logsRoot, session, 'window1', 'exthost', 'exthost.log'), '');
  return session;
}

const item = { project };

// 1. no-IDE setup failure: ONE error, no follow-up warning
{
  messages.length = 0;
  currentInstall = INSTALLS.toolchain;
  await mrsValidateCmd(store, item);
  check('no-ide: exactly one error popup', errCount() === 1, JSON.stringify(messages));
  check('no-ide: no warning double-popup', warnCount() === 0);
  check('no-ide: the error names the toolchain setup', messages[0].text.includes('standalone toolchain'));
  currentInstall = INSTALLS.ide;
}
// 2. missing .wvproj: one error, no double popup
{
  messages.length = 0;
  fs.rmSync(WVP);
  await mrsValidateCmd(store, item);
  check('no-wvproj: exactly one error popup', errCount() === 1 && warnCount() === 0);
  fs.writeFileSync(WVP, 'Demo');
}
// 3. build cmd same single-popup contract
{
  messages.length = 0;
  fs.rmSync(WVP);
  await buildWithMrsCmd(store, 'build', item);
  check('build no-wvproj: exactly one error popup', errCount() === 1 && warnCount() === 0);
  fs.writeFileSync(WVP, 'Demo');
}
// 4. batch preflight
{
  messages.length = 0;
  currentInstall = INSTALLS.toolchain;
  await mrsValidateAllCmd(store);
  check('batch preflight: exactly one error for the whole batch', errCount() === 1 && warnCount() === 0);
  currentInstall = INSTALLS.ide;
}
// 5. happy path
{
  messages.length = 0;
  terminals.length = 0;
  vscodeStub.tasks.executeTask = (task) => {
    // seed AFTER the runner captured its `before` snapshot (executeTask runs
    // post-capture), so the poller sees this session as new
    seedSession('[07:16:55] Build Finished. (took 1s760ms)');
    const exec = { task, terminate() {} };
    setTimeout(() => fireTaskEnd(exec, 0), 2500);
    return Promise.resolve(exec);
  };
  await mrsValidateCmd(store, item);
  check('happy path: no error popups', errCount() === 0);
  check('happy path: the dedicated terminal was created', terminals.length === 1 && terminals[0].name.includes('MRVC MRS validate'));
  check('happy path: the command line is echoed', terminals[0].written.some((w) => w.includes('C:/fake/MRS.exe')));
  check('happy path: build markers streamed into the terminal', terminals[0].written.some((w) => w.includes('Build Finished')));
}
// 6. batch run
{
  messages.length = 0;
  seedSession('[07:16:55] Build Finished. (took 1s760ms)'); // pre-batch; the batch's per-run before-snapshot is taken inside runMrsSilent AFTER this — seeded once more below via executeTask
  const orig = vscodeStub.tasks.executeTask;
  vscodeStub.tasks.executeTask = (task) => {
    seedSession('[07:16:55] Build Finished. (took 1s760ms)');
    const exec = { task, terminate() {} };
    setTimeout(() => fireTaskEnd(exec, 0), 2500);
    return Promise.resolve(exec);
  };
  await mrsValidateAllCmd(store);
  check('batch run: no error popups on success', errCount() === 0);
  check('batch run: the success wording is used', messages.some((m) => m.kind === 'info' && m.text.includes('accepted by MRS')), JSON.stringify(messages));
}

// 7. round24 P3-B: a batch whose sessions carry NO markers must settle via
//    the timeout into the inconclusive wording — never the success wording
{
  messages.length = 0;
  // no marker anywhere; the timeout override seam (0.3s) keeps the test fast
  const { setTimeoutOverrideForTests } = require_(path.join(DEVELOP_DIR, 'out', 'vscode', 'mrsValidate.js'));
  setTimeoutOverrideForTests(0.3);
  const origTask = vscodeStub.tasks.executeTask;
  vscodeStub.tasks.executeTask = (task) => {
    // the stub must mirror real VSCode: terminate() ends the process, so the
    // end event fires AFTER the token cancel (the timeout path depends on it)
    const exec = {
      task,
      terminate() {
        setTimeout(() => fireTaskEnd(exec, undefined), 100);
      },
    };
    return Promise.resolve(exec);
  };
  await mrsValidateAllCmd(store);
  check('all-inconclusive: no error popups (timeout is not an error)', errCount() === 0);
  check('all-inconclusive: the warning branch is used, not success', messages.some((m) => m.kind === 'warn' && m.text.includes('NO clear verdict')), JSON.stringify(messages));
  setTimeoutOverrideForTests(undefined);
  vscodeStub.tasks.executeTask = origTask;
}

// 8. round24 P3-B: the crash fast-fail path (exthost signature present →
//    the poller terminates early with the rejected wording; the delayed
//    flush timer must not fire after the runner settled)
{
  const started = Date.now();
  const origTask = vscodeStub.tasks.executeTask;
  // seed a crash session AFTER the runner captured its before-snapshot
  vscodeStub.tasks.executeTask = (task) => {
    const logsRoot = path.join(os.homedir(), '.mrvc', 'mrs-validate', 'mrs2', 'user-data', 'logs');
    const session = '2999' + String(Date.now()).slice(4);
    fs.mkdirSync(path.join(logsRoot, session, 'window1', 'exthost'), { recursive: true });
    fs.writeFileSync(path.join(logsRoot, session, 'main.log'), 'no build markers here');
    fs.writeFileSync(path.join(logsRoot, session, 'window1', 'exthost', 'exthost.log'), `2026-11-15 10:43:35.577 [error] TypeError: Cannot read properties of undefined (reading 'match')`);
    const exec = {
      task,
      terminate() {
        setTimeout(() => fireTaskEnd(exec, undefined), 100);
      },
    };
    return Promise.resolve(exec);
  };
  await mrsValidateCmd(store, item);
  const seconds = (Date.now() - started) / 1000;
  check('crash fast-fail: the rejected wording is used', messages.some((m) => m.kind === 'error' && m.text.includes('REJECTED')), JSON.stringify(messages));
  check('crash fast-fail: settles in seconds (poller terminate, not the 180s timeout)', seconds < 30, seconds + 's');
  vscodeStub.tasks.executeTask = origTask;
}

// 9. round24/27/28/30/31/32 P3: the lock file — a second acquire while one is
//    held fails (cross-window mutual exclusion), release frees it, a stale
//    lock is claimed ATOMICALLY (observed content+mtime re-verified against
//    the renamed claim; a fresh lock written in between is restored, not
//    destroyed), EEXIST on the wx create maps to busy, the short-tenure
//    TAKEOVER GUARD serializes every main-lock mutation (fresh/stale guard
//    tests + its own stale-claim race probe + a three-process clobber
//    probe), and the heartbeat is verified with an INJECTED short period
{
  const mrsValidateVscode = require_(path.join(DEVELOP_DIR, 'out', 'vscode', 'mrsValidate.js'));
  const { acquireMrsLock, acquireMrsGuard, setHeartbeatMsForTests } = mrsValidateVscode;
  const dir = path.join(os.homedir(), '.mrvc', 'mrs-validate', 'mrs2');
  fs.mkdirSync(dir, { recursive: true });
  const first = acquireMrsLock('mrs2');
  check('lock: first acquire succeeds (ok + lock)', first.status === 'ok' && !!first.lock);
  check('lock: second acquire is refused while held', acquireMrsLock('mrs2').status === 'busy');
  first.lock.release();

  // heartbeat VERIFIED (round28 P3): inject a 300 ms period — right after
  // acquire the mtime is "not yet refreshed" past injection, and ~350 ms
  // later (past one tick) it MUST be refreshed by the heartbeat
  setHeartbeatMsForTests(300);
  const held = acquireMrsLock('mrs2');
  const atAcquire = fs.statSync(held.lock.file).mtimeMs;
  await new Promise((r) => setTimeout(r, 350));
  const afterTick = fs.statSync(held.lock.file).mtimeMs;
  check('heartbeat: the mtime is REFRESHED past the injected period', afterTick >= atAcquire && Date.now() - afterTick < 300, `acquire=${atAcquire} after=${afterTick}`);
  held.lock.release();

  // release STOPS the heartbeat (round28 P3): plant an orphan lock file with
  // a FRESH mtime but no owner (release already ran) — if any heartbeat were
  // still alive it would refresh it; after 500 ms the mtime must be unchanged
  // (release() itself deletes the file, so the orphan is planted by hand.)
  fs.writeFileSync(held.lock.file, String(process.pid));
  const planted = fs.statSync(held.lock.file).mtimeMs;
  await new Promise((r) => setTimeout(r, 500));
  const st = fs.statSync(held.lock.file);
  check('heartbeat: release STOPS the refresh (orphan mtime unmoved)', st.mtimeMs === planted, `planted=${planted} now=${st.mtimeMs}`);
  setHeartbeatMsForTests(undefined);
  fs.rmSync(held.lock.file, { force: true });

  // stale lock: write one with an old mtime, then claim — the rename is the
  // atomic takeover; a competing window's rename fails so it sees busy
  const lockFile = path.join(dir, 'silent-run.lock');
  fs.writeFileSync(lockFile, '12345');
  const past = new Date(Date.now() - 31 * 60 * 1000);
  fs.utimesSync(lockFile, past, past);
  const taken = acquireMrsLock('mrs2');
  check('lock: a stale lock (30min old) is claimed and taken over', taken.status === 'ok');
  check('lock: no claim residue remains', fs.readdirSync(dir).every((f) => !f.includes('.claim-')), fs.readdirSync(dir).filter((f) => f.includes('.claim-')).join(','));
  taken.lock.release();

  // a fresh FOREIGN lock is refused — note this exercises the exists+mtime
  // early return, NOT the wx EEXIST branch (round30 P3: the old "EEXIST"
  // test pre-created the lock and never reached the wx write)
  fs.writeFileSync(lockFile, String(999999)); // someone else's pid
  const fresh = acquireMrsLock('mrs2');
  check('lock: a fresh foreign lock is refused (exists path)', fresh.status === 'busy', JSON.stringify(fresh));
  fs.rmSync(lockFile, { force: true });

  // TRUE EEXIST coverage (round30 P3): with NO lock file on disk,
  // existsSync is false, so the ONLY way the wx create can fail is via
  // writeFileSync itself — patch it to throw EEXIST for the lock path and
  // assert busy (the wx-failure branch must not masquerade as init-failed)
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = function (p, data, opts) {
    if (String(p) === lockFile && opts && opts.flag === 'wx') {
      const err = new Error('EEXIST: file already exists, open');
      err.code = 'EEXIST';
      throw err;
    }
    return origWrite.call(fs, p, data, opts);
  };
  let wxBusy = false;
  try {
    wxBusy = acquireMrsLock('mrs2').status === 'busy';
  } catch {
    wxBusy = false; // a throw would violate the never-throw contract
  }
  fs.writeFileSync = origWrite;
  check('lock: wx write EEXIST maps to busy (real branch hit)', wxBusy);
  check('lock: no claim residue after the wx EEXIST path', fs.readdirSync(dir).every((f) => !f.includes('.claim-')));

  // STALE-CLAIM RACE (round30 P3): another window writes a FRESH lock in the
  // gap between our staleness observation and the rename. Deterministic via
  // a renameSync patch that injects the fresh lock just before the takeover
  // rename runs. The takeover must detect the mismatch (the claim no longer
  // matches the observed stale content+mtime), RESTORE the winner's lock and
  // report busy — with the old code this probe returned ok with the winner's
  // lock destroyed.
  fs.writeFileSync(lockFile, '12345');
  const pastRace = new Date(Date.now() - 31 * 60 * 1000);
  fs.utimesSync(lockFile, pastRace, pastRace);
  const origRename = fs.renameSync;
  let injected = false;
  fs.renameSync = function (from, to) {
    if (!injected && String(from) === lockFile) {
      injected = true;
      fs.writeFileSync(lockFile, String(424242)); // the winner's lock lands before our rename
    }
    return origRename.call(fs, from, to);
  };
  let raced;
  try {
    raced = acquireMrsLock('mrs2');
  } finally {
    fs.renameSync = origRename;
  }
  check('lock race: a fresh lock written between observe and rename is NOT taken (busy)', !!raced && raced.status === 'busy', JSON.stringify(raced));
  check('lock race: the winner lock is restored intact at the lock path', fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8').trim() === String(424242));
  check('lock race: no claim residue', fs.readdirSync(dir).every((f) => !f.includes('.claim-')));
  fs.rmSync(lockFile, { force: true });

  // TAKEOVER GUARD (round31 P3): the guard serializes every main-lock
  // mutation, closing the gap the claim rename leaves at the main path.
  const guardPath = lockFile + '.takeover';

  // a FRESH guard = another window is mid-takeover — the fast create path
  // must be refused too (this is the C-window the guard exists to close)
  fs.writeFileSync(guardPath, String(999999));
  const guardBlocked = acquireMrsLock('mrs2');
  check('guard: a fresh takeover guard blocks the fast create path (busy)', guardBlocked.status === 'busy', JSON.stringify(guardBlocked));
  check('guard: the blocked acquire created no main lock', !fs.existsSync(lockFile));
  check('guard: the fresh foreign guard is left untouched', fs.readFileSync(guardPath, 'utf8').trim() === String(999999));
  fs.rmSync(guardPath, { force: true });

  // a STALE guard (crashed holder) is claimable: the dead guard is rebuilt
  // as ours, then released before the main lock is handed out — the
  // successful content-checked deletion proves the rebuild was ours
  fs.writeFileSync(guardPath, String(888888));
  const pastGuard = new Date(Date.now() - 20 * 1000);
  fs.utimesSync(guardPath, pastGuard, pastGuard);
  const guardTaken = acquireMrsLock('mrs2');
  check('guard: a stale guard (15s+) is claimed and the acquire proceeds (ok)', guardTaken.status === 'ok', JSON.stringify(guardTaken));
  check('guard: the claimed guard is released after the takeover', !fs.existsSync(guardPath));
  check('guard: no guard-claim residue', fs.readdirSync(dir).every((f) => !f.includes('.claim-')));
  guardTaken.lock.release();
  fs.rmSync(lockFile, { force: true });

  // GUARD STALE-CLAIM RACE (round32 P3): a FRESH guard lands between the
  // guard's stale stat and its claim rename. The guard takeover must save
  // the observed identity and re-check the claim — the fresh guard wins
  // (restored), busy is reported, and no claim residue remains. With the
  // old unverified rename this probe returned ok with the fresh guard
  // destroyed.
  fs.writeFileSync(guardPath, String(888888));
  fs.utimesSync(guardPath, pastGuard, pastGuard);
  let injectedGuard = false;
  fs.renameSync = function (from, to) {
    if (!injectedGuard && String(from) === guardPath) {
      injectedGuard = true;
      fs.writeFileSync(guardPath, String(777777)); // a fresh guard lands before our claim rename
    }
    return origRename.call(fs, from, to);
  };
  let guardRaced;
  try {
    guardRaced = acquireMrsGuard(lockFile);
  } finally {
    fs.renameSync = origRename;
  }
  check('guard race: a fresh guard written between stat and rename is NOT taken (busy)', !!guardRaced && guardRaced.status === 'busy', JSON.stringify(guardRaced));
  check('guard race: the fresh guard is restored intact at the guard path', fs.existsSync(guardPath) && fs.readFileSync(guardPath, 'utf8').trim() === String(777777));
  check('guard race: no guard-claim residue', fs.readdirSync(dir).every((f) => !f.includes('.claim-')));
  fs.rmSync(guardPath, { force: true });

  // the guard is ALWAYS released — even on a busy return (fresh main lock)
  fs.writeFileSync(lockFile, String(777777));
  const guardAfterBusy = acquireMrsLock('mrs2');
  check('guard: released after a busy return (fresh main lock)', guardAfterBusy.status === 'busy' && !fs.existsSync(guardPath), JSON.stringify(guardAfterBusy));
  fs.rmSync(lockFile, { force: true });

  // THREE-PROCESS CLOBBER PROBE (round31 P3): B observes a stale lock, a
  // guard-IGNORING writer A lands a fresh lock before B's rename, and before
  // B's restore a third writer C fills the main path. The restore must NOT
  // rename over C — C's lock survives, the stranded claim (A) is dropped, and
  // B reports busy. The old unconditional restore overwrote C's 555555.
  fs.writeFileSync(lockFile, '12345');
  fs.utimesSync(lockFile, pastRace, pastRace);
  const origExists = fs.existsSync;
  let injectedWinner = false;
  let injectedThird = false;
  fs.renameSync = function (from, to) {
    if (!injectedWinner && String(from) === lockFile) {
      injectedWinner = true;
      fs.writeFileSync(lockFile, String(424242)); // A lands before our rename
    }
    return origRename.call(fs, from, to);
  };
  fs.existsSync = function (p) {
    // the restore branch's "is the main path still free?" check — C lands
    // just before it (only reachable for guard-ignoring writers)
    if (injectedWinner && !injectedThird && String(p) === lockFile) {
      injectedThird = true;
      fs.writeFileSync(lockFile, String(555555));
    }
    return origExists.call(fs, p);
  };
  let triProcess;
  try {
    triProcess = acquireMrsLock('mrs2');
  } finally {
    fs.renameSync = origRename;
    fs.existsSync = origExists;
  }
  check('guard 3-proc: restore never clobbers the third writer (busy)', !!triProcess && triProcess.status === 'busy', JSON.stringify(triProcess));
  check('guard 3-proc: the third writer lock survives at the main path', fs.readFileSync(lockFile, 'utf8').trim() === String(555555));
  check('guard 3-proc: the stranded winner claim is dropped, no residue', fs.readdirSync(dir).every((f) => !f.includes('.claim-')));
  check('guard 3-proc: the guard is released', !fs.existsSync(guardPath));
  fs.rmSync(lockFile, { force: true });

  // mkdir-failure never throws and is DISTINCT from busy (round27 P3):
  // point homedir at a FILE — the lock dir beneath it cannot be created
  const fileAsHome = path.join(os.tmpdir(), 'mrvc-mrsrunner-file-as-home');
  fs.rmSync(fileAsHome, { recursive: true, force: true });
  fs.writeFileSync(fileAsHome, 'not a directory');
  const origHomedir = os.homedir;
  os.homedir = () => fileAsHome;
  let initFailed = false;
  try {
    const r = acquireMrsLock('mrs2');
    initFailed = r.status === 'init-failed' && !!r.detail;
  } catch {
    initFailed = false; // a throw would violate the never-throw contract
  }
  os.homedir = origHomedir;
  check('lock: mkdir failure resolves init-failed with detail (never throws, not busy)', initFailed);
  fs.rmSync(fileAsHome, { force: true });
}

process.exit(failures ? 1 : 0);
