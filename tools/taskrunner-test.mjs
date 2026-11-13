/**
 * waitTaskProcess cancellation plumbing (out/vscode/taskRunner.js).
 *
 * The build/download progress notifications pass a CancellationToken down to
 * the task waiter; pressing Cancel must terminate THAT task execution, even
 * when the token fires before executeTask() has handed us the execution.
 * The vscode module is stubbed here (same pattern as webview-test.js) so the
 * two race windows can be exercised without a live VS Code host.
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
const tasks = {
  onDidEndTaskProcess(cb) {
    listeners.add(cb);
    return { dispose: () => listeners.delete(cb) };
  },
  executeTask: undefined,
};
const vscodeStub = { tasks };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-taskrunner-stub';
  return origResolve.call(this, request, ...args);
};
require_.cache['vscode-taskrunner-stub'] = {
  id: 'vscode-taskrunner-stub',
  filename: 'vscode-taskrunner-stub',
  loaded: true,
  exports: vscodeStub,
};
const { waitTaskProcess } = require_(path.join(DEVELOP_DIR, 'out', 'vscode', 'taskRunner.js'));

function fakeExec(type) {
  return {
    task: { definition: { type } },
    terminated: 0,
    terminate() {
      this.terminated++;
      return Promise.resolve();
    },
  };
}
function fireEnd(exec, exitCode) {
  for (const cb of [...listeners]) cb({ execution: exec, exitCode });
}

{
  // normal completion: the exit code is returned and no token is required
  const exec = fakeExec('mrvc-build');
  tasks.executeTask = () => Promise.resolve(exec);
  const p = waitTaskProcess({}, 'mrvc-build');
  await tick();
  fireEnd(exec, 0);
  check('normal: resolves with the task exit code', (await p) === 0);
  check('normal: end listener is released', listeners.size === 0);
}
{
  // cancel before executeTask() resolves: terminate once the execution exists
  let resolveExec;
  const exec = fakeExec('mrvc-flash');
  tasks.executeTask = () => new Promise((resolve) => (resolveExec = resolve));
  let cancel;
  let disposed = 0;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(cb) {
      cancel = cb;
      return { dispose: () => disposed++ };
    },
  };
  const p = waitTaskProcess({}, 'mrvc-flash', token);
  cancel();
  check('cancel before start: nothing to terminate yet', exec.terminated === 0);
  resolveExec(exec);
  await tick();
  check('cancel before start: the execution is terminated on arrival', exec.terminated === 1);
  fireEnd(exec, undefined);
  check('cancel before start: resolves with no exit code', (await p) === undefined);
  check('cancel before start: token listener is released', disposed === 1);
}
{
  // cancel after the execution is known
  const exec = fakeExec('mrvc-build');
  tasks.executeTask = () => Promise.resolve(exec);
  let cancel;
  let disposed = 0;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(cb) {
      cancel = cb;
      return { dispose: () => disposed++ };
    },
  };
  const p = waitTaskProcess({}, 'mrvc-build', token);
  await tick();
  cancel();
  check('cancel after start: terminates the running execution', exec.terminated === 1);
  fireEnd(exec, 1);
  check('cancel after start: the real exit code still settles the waiter', (await p) === 1);
  check('cancel after start: token listener is released', disposed === 1);
}
{
  // an already-cancelled token (progress opened after a quick Cancel)
  let resolveExec;
  const exec = fakeExec('mrvc-flash');
  tasks.executeTask = () => new Promise((resolve) => (resolveExec = resolve));
  const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
  const p = waitTaskProcess({}, 'mrvc-flash', token);
  resolveExec(exec);
  await tick();
  check('already cancelled: the fresh execution is terminated', exec.terminated === 1);
  fireEnd(exec, undefined);
  check('already cancelled: resolves without waiting for another cancel', (await p) === undefined);
}
{
  // executeTask() rejecting must not hang the progress notification
  tasks.executeTask = () => Promise.reject(new Error('task provider refused'));
  const p = waitTaskProcess({}, 'mrvc-build');
  check('never started: resolves undefined', (await p) === undefined);
  check('never started: the end listener is released', listeners.size === 0);
}
{
  // a same-type task that is NOT ours must not settle this waiter
  const ours = fakeExec('mrvc-build');
  const other = fakeExec('mrvc-build');
  tasks.executeTask = () => Promise.resolve(ours);
  const p = waitTaskProcess({}, 'mrvc-build');
  await tick();
  fireEnd(other, 7);
  check('foreign execution: ignored (identity matching)', listeners.size === 1);
  fireEnd(ours, 0);
  check('foreign execution: ours still settles with its own code', (await p) === 0);
}

process.exit(failures ? 1 : 0);
