/**
 * "ReBuild Project All Configurations" orchestration (0.3.4, user request;
 * the MRS `mrs-vscode.rebuildAllConfig` counterpart).
 *
 * MRS semantics (reverse-engineered from build.ts cleanAllConfig/buildAllConfig
 * + handler.ts rebuildAllTempFromSourceProgressMonitor):
 *   phase 1  clean every configuration in ITS OWN output directory; the first
 *            configuration without a makefile ends the clean phase (later ones
 *            are not cleaned either); a failed clean only reports — the build
 *            phase ALWAYS runs.
 *   phase 2  build every configuration in file order, per-config
 *            toolchain/options/target, makefiles regenerated per config; the
 *            first failing configuration aborts the rest.
 *
 * This test drives the REAL compiled BuildManager with a task-API stub (no
 * make, no VS Code host) and pins the sequencing, the per-config build dirs,
 * the record-file rule (canonical record ONLY for the active configuration)
 * and the guard lifecycle.
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const here = path.dirname(fileURLToPath(import.meta.url));
const DEVELOP_DIR = path.join(here, '..');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ' + detail}`);
  if (!cond) failures++;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

const listeners = new Set();
let executed = [];
let messages = [];
let cleanMode = 'success'; // success | fail
let buildFailIndex = -1; // 0-based index of the BUILD task that exits 1
let buildCount = 0;

function emitEnd(exec, exitCode) {
  for (const cb of [...listeners]) cb({ execution: exec, exitCode });
}
function makeToken() {
  let requested = false;
  const callbacks = [];
  return {
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

const settings = { 'toolchain': 'auto', 'build.parallelJobs': 1, 'build.analysis': false };
const vscodeStub = {
  EventEmitter,
  ProcessExecution,
  Task,
  TaskGroup: { Build: 1, Test: 2 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  ProgressLocation: { Notification: 15 },
  workspace: {
    getConfiguration: () => ({
      get: (key, def) => (key in settings ? settings[key] : def),
      inspect: () => ({ defaultValue: undefined }),
    }),
  },
  window: {
    withProgress: (_opts, cb) => cb({ report() {} }, makeToken()),
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
      const exec = { task, terminate: () => Promise.resolve() };
      executed.push(task);
      if (task.definition.type === 'mrvc-clean') {
        queueMicrotask(() => emitEnd(exec, cleanMode === 'fail' ? 1 : 0));
      } else {
        const idx = buildCount++;
        queueMicrotask(() => emitEnd(exec, idx === buildFailIndex ? 1 : 0));
      }
      return Promise.resolve(exec);
    },
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-rebuildconfigs-stub';
  return origResolve.call(this, request, ...args);
};
require_.cache['vscode-rebuildconfigs-stub'] = {
  id: 'vscode-rebuildconfigs-stub',
  filename: 'vscode-rebuildconfigs-stub',
  loaded: true,
  exports: vscodeStub,
};

const CANONICAL_RECORD = '/tmp/mrvc-canonical-record.txt';
const projects = require_(path.join(DEVELOP_DIR, 'out', 'vscode', 'projects.js'));
projects.getInstall = () => ({ root: '/fake/mrs', makeBin: '/fake/mrs/bin', label: 'Fake MRS' });
const makefile = require_(path.join(DEVELOP_DIR, 'out', 'core', 'makefile.js'));
const genCalls = [];
makefile.generateMakefiles = (cp) => {
  genCalls.push(cp.configName);
  return {};
};
const toolchain = require_(path.join(DEVELOP_DIR, 'out', 'core', 'toolchain.js'));
toolchain.resolveMakeExe = () => '/fake/mrs/bin/make';
const tcCalls = [];
toolchain.selectToolchain = (_install, _req, rvGcc) => {
  tcCalls.push(rvGcc ?? 'auto');
  return { dir: `/fake/tc/${rvGcc ?? 'auto'}`, prefix: 'riscv-wch-elf-' };
};
const buildLog = require_(path.join(DEVELOP_DIR, 'out', 'core', 'buildLog.js'));
buildLog.buildRecordFile = () => CANONICAL_RECORD;
const taskWrapper = require_(path.join(DEVELOP_DIR, 'out', 'core', 'taskWrapper.js'));
const cleanDirs = [];
const buildDirs = [];
const buildRecords = [];
taskWrapper.writeCleanTaskWrapper = (_root, spec) => {
  cleanDirs.push(spec.buildDir);
  return '/tmp/mrvc-clean.cmd';
};
taskWrapper.writeBuildTaskWrapper = (_root, spec) => {
  buildDirs.push(spec.buildDir);
  buildRecords.push(spec.recordFile);
  return '/tmp/mrvc-build.cmd';
};
const cprojectMod = require_(path.join(DEVELOP_DIR, 'out', 'core', 'cproject.js'));
let scopeConfigs = [];
cprojectMod.Cproject.loadConfigAt = (_root, i) => scopeConfigs[i];
require_(path.join(DEVELOP_DIR, 'out', 'core', 'i18n.js')).setLanguage('en');

const { BuildManager } = require_(path.join(DEVELOP_DIR, 'out', 'vscode', 'tasks.js'));

const scratchRoot = path.join(DEVELOP_DIR, '.scratch', 'rebuildconfigs');
fs.rmSync(scratchRoot, { recursive: true, force: true });

function makeProject(names, builtConfigs) {
  const root = path.join(scratchRoot, 'proj');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const name of builtConfigs ?? []) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'makefile'), '# fixture\n');
  }
  return {
    root,
    projectName: 'AllCfgProbe',
    buildDir: path.join(root, names[0]),
    cproject: { configurationNames: names },
    toolchain: () => ({ dir: '/fake/tc', prefix: 'riscv-wch-elf-' }),
    reload() {},
  };
}
function makeScopeConfigs(names) {
  return names.map((n, i) => ({
    configName: n,
    rvGccVersion: i === 0 ? undefined : '12',
    storedPrefix: 'riscv-wch-elf-',
    artifactType: 'exe',
    targetName: 'AllCfgProbe',
  }));
}
const store = {
  active: null,
  all: [],
  setActive() {},
  suspendTreeRefresh() {},
  resumeTreeRefresh() {},
  reloadActive() {},
  reloadActiveQuiet() {},
  // round4 P3: per-config scoped refresh — the multi-config flows must note
  // EACH configuration's dir, not just the active buildDir
  noteTreeDirs: (...dirs) => notedDirs.push(...dirs.filter(Boolean)),
};
const notedDirs = [];
const manager = new BuildManager(store);

function reset(names) {
  executed = [];
  messages = [];
  genCalls.length = 0;
  tcCalls.length = 0;
  cleanDirs.length = 0;
  buildDirs.length = 0;
  buildRecords.length = 0;
  notedDirs.length = 0;
  cleanMode = 'success';
  buildFailIndex = -1;
  buildCount = 0;
  scopeConfigs = makeScopeConfigs(names);
}

const taskNames = (type) => executed.filter((t) => t.definition.type === type).map((t) => t.name);

// 1. two built configurations: clean BOTH first, then build BOTH (MRS phase order)
{
  const names = ['obj1', 'obj'];
  reset(names);
  const project = makeProject(names, names);
  await manager.rebuildAllConfigs({ project });
  check('two cfg: two clean tasks then two build tasks', executed.length === 4 && buildCount === 2, executed.map((t) => t.definition.type).join(','));
  check('two cfg: clean order follows the file order', cleanDirs.map((d) => path.basename(d)).join(',') === 'obj1,obj', cleanDirs.join(','));
  check('two cfg: build order follows the file order', buildDirs.map((d) => path.basename(d)).join(',') === 'obj1,obj', buildDirs.join(','));
  check('two cfg: makefiles generated per config', genCalls.join(',') === 'obj1,obj', genCalls.join(','));
  check('two cfg: toolchain resolved per config', tcCalls.join(',') === 'auto,12', tcCalls.join(','));
  check(
    'two cfg: canonical record ONLY for the active configuration',
    buildRecords[0] === CANONICAL_RECORD && !buildRecords[1].includes('mrs-cache'),
    buildRecords.join(' | ')
  );
  check('two cfg: task names carry the configuration', taskNames('mrvc-build')[0].includes('[obj1]') && taskNames('mrvc-build')[1].includes('[obj]'), taskNames('mrvc-build').join(' | '));
  check('two cfg: finished message counts the configurations', messages.some((m) => m.includes('rebuilt 2 configuration')), messages.join(' | '));
  check('two cfg: the guard is released', manager.buildInFlightForTests(project.root) === false);
  check(
    'two cfg: BOTH configuration dirs were noted for the scoped refresh',
    [...new Set(notedDirs.map((d) => path.basename(d)))].sort().join(',') === 'obj,obj1',
    notedDirs.join(' | ')
  );
}

// 2. second configuration never built: clean phase stops after obj1, build still runs BOTH
{
  const names = ['obj1', 'obj'];
  reset(names);
  const project = makeProject(names, ['obj1']);
  await manager.rebuildAllConfigs({ project });
  check('missing makefile: only the built configuration is cleaned', taskNames('mrvc-clean').length === 1 && cleanDirs[0].endsWith('obj1'), cleanDirs.join(','));
  check('missing makefile: the build phase still runs both configurations', buildCount === 2 && genCalls.join(',') === 'obj1,obj', `${buildCount} ${genCalls.join(',')}`);
  check('missing makefile: finished normally', messages.some((m) => m.includes('rebuilt 2 configuration')), messages.join(' | '));
}

// 3. a failing configuration aborts the remaining builds (MRS "Build Failed.")
{
  const names = ['obj1', 'obj', 'dbg'];
  reset(names);
  const project = makeProject(names, names);
  buildFailIndex = 1; // the SECOND configuration's build exits 1
  await manager.rebuildAllConfigs({ project });
  check('first failure: all three configurations were cleaned', taskNames('mrvc-clean').length === 3, String(taskNames('mrvc-clean').length));
  check('first failure: build stops after the failing configuration', buildCount === 2, String(buildCount));
  check('first failure: the error names the configuration', messages.some((m) => m.includes('build of configuration "obj" failed')), messages.join(' | '));
  check('first failure: the guard is released', manager.buildInFlightForTests(project.root) === false);
}

// 4. a failed clean only reports — the build phase still runs (MRS parity)
{
  const names = ['obj1', 'obj'];
  reset(names);
  const project = makeProject(names, names);
  cleanMode = 'fail';
  await manager.rebuildAllConfigs({ project });
  check('clean fail: the clean phase reported and stopped', taskNames('mrvc-clean').length === 1, String(taskNames('mrvc-clean').length));
  check('clean fail: the build phase still runs both configurations', buildCount === 2, String(buildCount));
  check('clean fail: the warning names the configuration', messages.some((m) => m.includes('clean of configuration "obj1" failed')), messages.join(' | '));
}

// 5. single configuration: one clean + one build (menu stays useful)
{
  const names = ['obj'];
  reset(names);
  const project = makeProject(names, ['obj']);
  await manager.rebuildAllConfigs({ project });
  check('single cfg: one clean + one build', taskNames('mrvc-clean').length === 1 && buildCount === 1, `${taskNames('mrvc-clean').length}/${buildCount}`);
}

// 6. the single-build guard refuses a second run while one is in flight
{
  const names = ['obj1', 'obj'];
  reset(names);
  const project = makeProject(names, names);
  manager.building.set(require_(path.join(DEVELOP_DIR, 'out', 'core', 'cproject.js')).foldPathOnPlatform(path.resolve(project.root)), {});
  await manager.rebuildAllConfigs({ project });
  check('busy: refused with the already-building message', messages.some((m) => m.toLowerCase().includes('already building')), messages.join(' | '));
  check('busy: no task started', executed.length === 0);
  manager.building.delete(require_(path.join(DEVELOP_DIR, 'out', 'core', 'cproject.js')).foldPathOnPlatform(path.resolve(project.root)));
}

// 7. MRVC-specific "Clean Project All Configurations": every configuration's
//    output dir cleaned independently — skipped when never built, failures
//    never stop the run, download chain untouched
{
  const names = ['obj1', 'obj'];
  reset(names);
  const project = makeProject(names, names);
  await manager.cleanAllConfigs({ project });
  check(
    'cleanAll: every built configuration is cleaned, no build runs',
    cleanDirs.map((d) => path.basename(d)).join(',') === 'obj1,obj' && buildCount === 0 && executed.every((t) => t.definition.type === 'mrvc-clean'),
    `${cleanDirs.join(',')} builds=${buildCount}`
  );
  check('cleanAll: finished message counts the configurations', messages.some((m) => m.includes('cleaned the output of 2 configuration')), messages.join(' | '));
  check('cleanAll: the guard is released', manager.buildInFlightForTests(project.root) === false);
  check(
    'cleanAll: BOTH configuration dirs were noted for the scoped refresh',
    notedDirs.map((d) => path.basename(d)).sort().join(',') === 'obj,obj1',
    notedDirs.join(' | ')
  );

  // a never-built configuration is skipped, the built one still cleaned
  reset(names);
  const projectB = makeProject(names, ['obj']);
  await manager.cleanAllConfigs({ project: projectB });
  check('cleanAll: a configuration without a makefile is skipped', cleanDirs.map((d) => path.basename(d)).join(',') === 'obj' && taskNames('mrvc-clean').length === 1, cleanDirs.join(','));
  check('cleanAll: the skipped run still reports success', messages.some((m) => m.includes('cleaned the output of 1 configuration')), messages.join(' | '));

  // a failed clean never stops the run — the next configuration still cleans
  reset(names);
  const projectC = makeProject(names, names);
  cleanMode = 'fail';
  await manager.cleanAllConfigs({ project: projectC });
  check('cleanAll: both configurations attempted despite the first failing', cleanDirs.map((d) => path.basename(d)).join(',') === 'obj1,obj', cleanDirs.join(','));
  check('cleanAll: the failure names the configuration', messages.some((m) => m.includes('clean failed for configuration(s) obj1')), messages.join(' | '));
  check('cleanAll: the guard is released after a failed run', manager.buildInFlightForTests(projectC.root) === false);

  // busy: refused like every other make path
  reset(names);
  const projectD = makeProject(names, names);
  const keyOf = require_(path.join(DEVELOP_DIR, 'out', 'core', 'cproject.js')).foldPathOnPlatform;
  manager.building.set(keyOf(path.resolve(projectD.root)), {});
  await manager.cleanAllConfigs({ project: projectD });
  check('cleanAll busy: refused with the already-building message', messages.some((m) => m.toLowerCase().includes('already building')), messages.join(' | '));
  check('cleanAll busy: no task started', executed.length === 0);
  manager.building.delete(keyOf(path.resolve(projectD.root)));
}

// the Problems-panel path fix (user report 2026-11-24): GCC diagnostics are
// printed relative to the BUILD directory (`../<folder>/<file>.c` — make runs
// there), and the $mrvcgcc matcher used to resolve them against the WORKSPACE
// folder, so `../` cancelled the project folder segment and every entry
// pointed at a file outside the project ("由于找不到该文件" on click). The fix
// has two halves: each build task must run IN its build directory, and the
// wrapper's terminal copy absolute-izes the diagnostic prefix (the matcher
// then takes them as-is with fileLocation "absolute").
{
  const names = ['obj1', 'obj'];
  reset(names);
  const project = makeProject(names, names);
  await manager.rebuildAllConfigs({ project });
  const buildTasks = executed.filter((t) => t.definition.type === 'mrvc-build');
  check(
    'cwd: each configuration build runs in ITS OWN build directory',
    buildTasks.length === 2 &&
      buildTasks.map((t) => t.execution.options && t.execution.options.cwd).join(',') ===
        [path.join(project.root, 'obj1'), path.join(project.root, 'obj')].join(','),
    buildTasks.map((t) => t.execution.options && t.execution.options.cwd).join(',')
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(DEVELOP_DIR, 'package.json'), 'utf8'));
  const matcher = (pkg.contributes.problemMatchers || []).find((m) => m.name === 'mrvcgcc');
  // the diagnostics are made ABSOLUTE in the build wrapper's terminal copy —
  // the matcher just takes them as-is (VS Code's FileLocationKind schema is
  // case-sensitive and a 1-item array is absolute-only: "autodetect" was
  // doubly invalid and the matcher never registered, round6 P2.1)
  check(
    'cwd: the mrvcgcc matcher takes the (absolute) diagnostics as-is',
    !!matcher && matcher.fileLocation === 'absolute',
    JSON.stringify(matcher && matcher.fileLocation)
  );
}

fs.rmSync(scratchRoot, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
