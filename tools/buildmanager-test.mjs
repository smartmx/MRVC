/**
 * BuildManager guard lifecycle (round16 P2).
 *
 * A rebuild runs a clean task BEFORE the build task. The single-build guard
 * must cover the whole flow: a failed or cancelled clean, or a wrapper write
 * that throws, must release it — otherwise the project stays "already
 * building" until the window reloads. This test drives the REAL compiled
 * BuildManager with a task-API stub (no make, no VS Code host).
 */
import path from 'path';
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
const tick = () => new Promise((resolve) => setImmediate(resolve));

const listeners = new Set();
let executed = [];
let messages = [];
let cleanMode = 'success'; // success | fail | hang
let tokenSeq = 0;

function emitEnd(exec, exitCode) {
  for (const cb of [...listeners]) cb({ execution: exec, exitCode });
}
function makeToken() {
  let requested = false;
  const callbacks = [];
  return {
    id: ++tokenSeq,
    get isCancellationRequested() {
      return requested;
    },
    onCancellationRequested(cb) {
      callbacks.push(cb);
      return { dispose: () => callbacks.splice(callbacks.indexOf(cb) >>> 0, 1) };
    },
    cancel() {
      requested = true;
      for (const cb of [...callbacks]) cb();
    },
  };
}

class Task {
  constructor(definition, name, source, execution, problemMatchers) {
    this.definition = definition;
    this.name = name;
    this.source = source;
    this.execution = execution;
    this.problemMatchers = problemMatchers;
    this.group = undefined;
    this.presentationOptions = undefined;
  }
}
class ProcessExecution {
  constructor(command, args, options) {
    this.command = command;
    this.args = args;
    this.options = options;
  }
}
class EventEmitter {
  constructor() {
    this.listeners = [];
  }
  event(cb) {
    this.listeners.push(cb);
    return { dispose: () => this.listeners.splice(this.listeners.indexOf(cb) >>> 0, 1) };
  }
  fire(value) {
    for (const cb of [...this.listeners]) cb(value);
  }
  dispose() {
    this.listeners = [];
  }
}

const settings = {
  'toolchain': 'auto',
  'build.parallelJobs': 1,
  'build.analysis': false,
};
const vscodeStub = {
  EventEmitter,
  ProcessExecution,
  Task,
  TaskGroup: { Build: 1, Test: 2 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  ProgressLocation: { Notification: 15 },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (key, def) => (key in settings ? settings[key] : def),
      inspect: () => ({ defaultValue: undefined }),
    }),
  },
  window: {
    withProgress: (_opts, cb) => {
      const token = makeToken();
      return cb({ report() {} }, token);
    },
    showErrorMessage: (m) => {
      messages.push(String(m));
      return Promise.resolve(undefined);
    },
    showWarningMessage: (m) => {
      messages.push(String(m));
      return Promise.resolve(undefined);
    },
    showInformationMessage: (m) => {
      messages.push(String(m));
      return Promise.resolve(undefined);
    },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  },
  tasks: {
    onDidEndTaskProcess(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    executeTask: (task) => {
      const exec = {
        task,
        terminated: 0,
        pending: false,
        terminate() {
          this.terminated++;
          if (this.pending) {
            this.pending = false;
            queueMicrotask(() => emitEnd(exec, undefined));
          }
          return Promise.resolve();
        },
      };
      executed.push(task);
      if (task.definition.type === 'mrvc-clean') {
        if (cleanMode === 'fail') queueMicrotask(() => emitEnd(exec, 1));
        else if (cleanMode === 'hang') exec.pending = true;
        else queueMicrotask(() => emitEnd(exec, 0));
      } else {
        queueMicrotask(() => emitEnd(exec, 0));
      }
      return Promise.resolve(exec);
    },
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-buildmanager-stub';
  return origResolve.call(this, request, ...args);
};
require_.cache['vscode-buildmanager-stub'] = {
  id: 'vscode-buildmanager-stub',
  filename: 'vscode-buildmanager-stub',
  loaded: true,
  exports: vscodeStub,
};

// stub the filesystem/toolchain seams BEFORE tasks.js resolves them
const projects = require_(path.join(DEVELOP_DIR, 'out', 'vscode', 'projects.js'));
projects.getInstall = () => ({ root: '/fake/mrs', makeBin: '/fake/mrs/bin', label: 'Fake MRS', resourcesDir: '/fake/res' });
const makefile = require_(path.join(DEVELOP_DIR, 'out', 'core', 'makefile.js'));
makefile.generateMakefiles = () => ({});
const toolchain = require_(path.join(DEVELOP_DIR, 'out', 'core', 'toolchain.js'));
toolchain.resolveMakeExe = () => '/fake/mrs/bin/make';
const buildLog = require_(path.join(DEVELOP_DIR, 'out', 'core', 'buildLog.js'));
buildLog.buildRecordFile = () => '/tmp/mrvc-build-record.txt';
const taskWrapper = require_(path.join(DEVELOP_DIR, 'out', 'core', 'taskWrapper.js'));
taskWrapper.writeBuildTaskWrapper = () => '/tmp/mrvc-build.cmd';
taskWrapper.writeCleanTaskWrapper = () => '/tmp/mrvc-clean.cmd';require_(path.join(DEVELOP_DIR, 'out', 'core', 'i18n.js')).setLanguage('en');

const { BuildManager } = require_(path.join(DEVELOP_DIR, 'out', 'vscode', 'tasks.js'));

const root = path.join(here, '..', '.scratch', 'buildmanager-guard');
const project = {
  root,
  projectName: 'GuardProbe',
  buildDir: path.join(root, 'obj'),
  cproject: {},
  kernel: false,
  toolchain: () => ({ dir: '/fake/mrs/toolchain', prefix: 'riscv-wch-elf-' }),
  reload() {},
};
const store = {
  active: project,
  all: [project],
  setActive(p) {
    this.active = p;
  },
  suspendTreeRefresh() {},
  resumeTreeRefresh() {},
  reloadActive() {},
  reloadActiveQuiet() {},
};
const manager = new BuildManager(store);

function resetRunState() {
  executed = [];
  messages = [];
  cleanMode = 'success';
}
function hasAlreadyBuilding() {
  return messages.some((m) => m.toLowerCase().includes('already building'));
}
function cleanCount() {
  return executed.filter((t) => t.definition.type === 'mrvc-clean').length;
}

// 1. a failed clean releases the guard and the next rebuild starts a task
{
  resetRunState();
  cleanMode = 'fail';
  await manager.run('rebuild', project);
  check('clean exit 1: the clean task ran and failed', cleanCount() === 1 && messages.some((m) => m.includes('clean failed')));
  check('clean exit 1: the guard is released', manager.buildInFlightForTests(root) === false);

  resetRunState();
  await manager.run('rebuild', project);
  check('clean exit 1: the second rebuild is not refused', !hasAlreadyBuilding());
  check('clean exit 1: the second rebuild runs clean + build', cleanCount() === 1 && executed.length === 2);
  check('clean exit 1: the guard is released again', manager.buildInFlightForTests(root) === false);
}

// 2. cancelling during the clean phase releases the guard
{
  resetRunState();
  cleanMode = 'hang';
  // capture the progress token without depending on the manager's internals
  let captured;
  const original = vscodeStub.window.withProgress;
  vscodeStub.window.withProgress = (opts, cb) => {
    const token = makeToken();
    captured = token;
    return cb({ report() {} }, token);
  };
  const first = manager.run('rebuild', project);
  await tick();
  check('cancel clean: the clean task started and is waiting', cleanCount() === 1);
  captured.cancel();
  await first;
  check('cancel clean: the guard is released', manager.buildInFlightForTests(root) === false);
  check('cancel clean: a cancellation message is shown', messages.some((m) => m.toLowerCase().includes('cancelled')));
  vscodeStub.window.withProgress = original;

  resetRunState();
  await manager.run('rebuild', project);
  check('cancel clean: the next rebuild is not refused', !hasAlreadyBuilding());
  check('cancel clean: the next rebuild runs clean + build', cleanCount() === 1 && executed.length === 2);
}

// 3. a wrapper write that throws releases the guard
{
  resetRunState();
  taskWrapper.writeCleanTaskWrapper = () => {
    throw new Error('wrapper write failed');
  };
  let threw = false;
  try {
    await manager.run('rebuild', project);
  } catch {
    threw = true;
  }
  check('wrapper throw: the rebuild rejects', threw);
  check('wrapper throw: no task started', executed.length === 0);
  check('wrapper throw: the guard is released', manager.buildInFlightForTests(root) === false);
  taskWrapper.writeCleanTaskWrapper = () => '/tmp/mrvc-clean.cmd';

  resetRunState();
  await manager.run('rebuild', project);
  check('wrapper throw: the next rebuild is not refused', !hasAlreadyBuilding());
  check('wrapper throw: the next rebuild runs clean + build', cleanCount() === 1 && executed.length === 2);
}

// 4. a wrapper/task construction failure in Build All releases the guard
{
  resetRunState();
  taskWrapper.writeBuildTaskWrapper = () => {
    throw new Error('batch wrapper write failed');
  };
  let threw = false;
  try {
    await manager.buildAll();
  } catch {
    threw = true;
  }
  check('buildAll wrapper throw: does not escape as a rejection', threw === false);
  check('buildAll wrapper throw: the guard is released', manager.buildInFlightForTests(root) === false);
  check('buildAll wrapper throw: the failure is summarized', messages.some((m) => m.includes('0/1 OK')));

  taskWrapper.writeBuildTaskWrapper = () => '/tmp/mrvc-build.cmd';
  resetRunState();
  await manager.buildAll();
  check('buildAll after throw: the next Build All is not refused', !messages.some((m) => m.toLowerCase().includes('build all already running')));
  check('buildAll after throw: a build-all task starts', executed.length === 1 && executed[0].definition.type === 'mrvc-build-all');
}

// leave the stub factory in place (this test loads its own module cache);
// no later test in this process runs a real wrapper
process.exit(failures ? 1 : 0);
