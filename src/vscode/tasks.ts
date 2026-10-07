/**
 * Build / clean / rebuild via make tasks.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ProjectStore, MrsProject, MrsSolution, msg, getInstall } from './projects';
import { generateMakefiles } from '../core/makefile';
import { clearOutputDir, removeOutputDir } from '../core/output';
import { t } from '../core/i18n';
import { buildRecordFile, buildWrapperFile } from '../core/buildLog';
import { encodeArtifact } from '../core/platformEncoding';
import { downloadProject } from './flash';

export type BuildKind = 'build' | 'rebuild' | 'clean';

/** cmd batch-file escaping for LITERAL paths embedded in a wrapper body:
 * a single % would start variable expansion ("100% done" is fine but
 * "a%x%y" would lose "x%y" as a variable reference) — doubling makes cmd
 * emit one literal percent. %VAR% references must NOT be escaped. */
function pct(s: string): string {
  return s.replace(/%/g, '%%');
}

export interface RunOptions {
  /** MRS2 "Build Project And Download" mode: wait for the build to end and
   * download only on success */
  andDownload?: boolean;
}

export interface BuildAllResult {
  project: string;
  ok: boolean;
  detail: string;
}

interface BatchOptions {
  /** progress notification title, e.g. "MRVC: Build All" */
  progressTitle: string;
  /** summary label, e.g. "Build All" or "Build Solution (GPIO_Toggle)" */
  label: string;
  /** message when there is nothing to process */
  emptyMessage: string;
  /** check make.exe availability up front (build/clean/rebuild need it) */
  needsMake?: boolean;
  /** per-project operation; install is non-null when needsMake */
  worker: (p: MrsProject, install: NonNullable<ReturnType<typeof getInstall>>) => Promise<BuildAllResult>;
}

export class BuildManager {
  private buildAllRunning = false;
  private buildAllChannel: vscode.OutputChannel | null = null;
  /** projects with a make task in flight (single-build guard): two
   * concurrent `make -jN` runs write the same obj/ and append to the same
   * build-record file. Keyed by the lowercased project root; the stored
   * execution lets a repeated trigger terminate the running task. */
  private building = new Map<string, { exec?: vscode.TaskExecution }>();

  constructor(private store: ProjectStore) {}

  /**
   * Build every loaded project sequentially. A failing project never stops
   * the run — every project is attempted, results are summarized at the end.
   */
  async buildAll(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('mrvc');
    const toolchainReq = cfg.get<string>('toolchain', 'auto');
    const jobs = cfg.get<number>('build.parallelJobs', 0) || os.cpus().length;
    const analysis = cfg.get<boolean>('build.analysis', false);
    return this.runBatch(this.store.all, {
      progressTitle: t('progressBuildAll'),
      label: 'Build All',
      emptyMessage: t('noProjectsLoaded'),
      needsMake: true,
      worker: (p, install) => this.buildOne(p, install, toolchainReq, jobs, analysis),
    });
  }

  /** Build one solution's member projects in BuildOrder order. */
  async buildSolution(sol: MrsSolution): Promise<void> {
    const members = sol.members;
    if (!members.length) {
      vscode.window.showErrorMessage(t('solutionNoMembers', sol.name));
      return;
    }
    const cfg = vscode.workspace.getConfiguration('mrvc');
    const toolchainReq = cfg.get<string>('toolchain', 'auto');
    const jobs = cfg.get<number>('build.parallelJobs', 0) || os.cpus().length;
    const analysis = cfg.get<boolean>('build.analysis', false);
    return this.runBatch(members, {
      progressTitle: t('progressBuildSolution', sol.name),
      label: `Build Solution (${sol.name})`,
      emptyMessage: t('solutionNoMembers', sol.name),
      needsMake: true,
      worker: (p, install) => this.buildOne(p, install, toolchainReq, jobs, analysis),
    });
  }

  /** Clean then build every loaded project, one project at a time. */
  async rebuildAll(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('mrvc');
    const toolchainReq = cfg.get<string>('toolchain', 'auto');
    const jobs = cfg.get<number>('build.parallelJobs', 0) || os.cpus().length;
    const analysis = cfg.get<boolean>('build.analysis', false);
    return this.runBatch(this.store.all, {
      progressTitle: t('progressRebuildAll'),
      label: 'Rebuild All',
      emptyMessage: t('noProjectsLoaded'),
      needsMake: true,
      worker: (p, install) => this.rebuildOne(p, install, toolchainReq, jobs, analysis),
    });
  }

  /**
   * Delete every project's output directory contents, keeping the flash
   * images (工程名.hex / 工程名.bin). Makefiles and objects go — the next
   * build regenerates them.
   */
  async deleteOutputFiles(): Promise<void> {
    await this.runBatch(this.store.all, {
      progressTitle: t('progressDeleteKeep'),
      label: 'Delete Output Files (Keep hex/bin)',
      emptyMessage: t('noProjectsLoaded'),
      worker: (p) => this.deleteOutputOne(p, true),
    });
    this.refreshTree();
  }

  /** Delete every project's whole output directory. */
  async deleteOutputDirs(): Promise<void> {
    await this.runBatch(this.store.all, {
      progressTitle: t('progressDeleteDirs'),
      label: 'Delete Output Directories',
      emptyMessage: t('noProjectsLoaded'),
      worker: (p) => this.deleteOutputOne(p, false),
    });
    this.refreshTree();
  }

  /** output directories are not covered by any file watcher — the tree must
   * be told explicitly that they changed */
  private refreshTree(): void {
    void vscode.commands.executeCommand('mrs2.refreshTree');
  }

  /**
   * Clean every loaded project sequentially. Never-built projects (no
   * makefile yet) are skipped; failures never stop the run.
   */
  async cleanAll(): Promise<void> {
    return this.runBatch(this.store.all, {
      progressTitle: t('progressCleanAll'),
      label: 'Clean All',
      emptyMessage: t('noProjectsLoaded'),
      needsMake: true,
      worker: (p, install) => this.cleanOne(p, install),
    });
  }

  /** Clean one solution's member projects in BuildOrder order. */
  async cleanSolution(sol: MrsSolution): Promise<void> {
    const members = sol.members;
    if (!members.length) {
      vscode.window.showErrorMessage(t('solutionNoMembers', sol.name));
      return;
    }
    return this.runBatch(members, {
      progressTitle: t('progressCleanSolution', sol.name),
      label: `Clean Solution (${sol.name})`,
      emptyMessage: t('solutionNoMembers', sol.name),
      needsMake: true,
      worker: (p, install) => this.cleanOne(p, install),
    });
  }

  /** Sequential never-stopping batch over a project list (Build/Clean/Rebuild All, solutions, output deletion). */
  private async runBatch(projects: MrsProject[], opts: BatchOptions): Promise<void> {
    if (this.buildAllRunning) {
      vscode.window.showWarningMessage(t('batchRunning'));
      return;
    }
    if (!projects.length) {
      vscode.window.showErrorMessage(opts.emptyMessage);
      return;
    }
    let install: ReturnType<typeof getInstall> = null;
    if (opts.needsMake) {
      install = getInstall();
      if (!install || !fs.existsSync(path.join(install.makeBin, 'make.exe'))) {
        vscode.window.showErrorMessage(t('makeNotFound', install?.makeBin ?? '?'));
        return;
      }
    }
    const worker = opts.worker;

    if (!this.buildAllChannel) {
      this.buildAllChannel = vscode.window.createOutputChannel('MRVC Build All');
    }
    const channel = this.buildAllChannel;
    this.buildAllRunning = true;
    const results: BuildAllResult[] = [];
    const started = Date.now();
    let cancelled = false;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: opts.progressTitle, cancellable: true },
        async (progress, token) => {
          for (let i = 0; i < projects.length; i++) {
            if (token.isCancellationRequested) {
              cancelled = true;
              break;
            }
            const p = projects[i];
            progress.report({ message: `(${i + 1}/${projects.length}) ${p.projectName}`, increment: 100 / projects.length });
            const r = await worker(p, install as NonNullable<ReturnType<typeof getInstall>>);
            results.push(r);
            channel.appendLine(`[${r.ok ? 'OK' : 'FAIL'}] ${p.projectName}${r.detail ? '  — ' + r.detail : ''}`);
          }
        }
      );
    } finally {
      this.buildAllRunning = false;
    }

    const failed = results.filter((r) => !r.ok);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    channel.appendLine(
      `===== ${opts.label} ${cancelled ? '(cancelled)' : 'finished'}: ${results.length - failed.length}/${results.length} OK, ${failed.length} failed, ${seconds}s =====`
    );
    channel.show(true);
    if (cancelled) {
      vscode.window.showWarningMessage(t('batchCancelled', opts.label, results.length - failed.length, results.length, failed.length));
    } else if (failed.length) {
      const names = failed.map((r) => r.project).join(', ');
      void vscode.window
        .showWarningMessage(
          t('batchFinishedFailed', opts.label, results.length - failed.length, results.length, failed.length, names),
          'Show Output'
        )
        .then((pick) => pick === 'Show Output' && channel.show(true));
    } else {
      vscode.window.showInformationMessage(t('batchFinishedAll', opts.label, results.length, seconds));
    }
  }

  /** Clean one project, then build it fresh; a failed clean fails the rebuild. */
  private async rebuildOne(p: MrsProject, install: NonNullable<ReturnType<typeof getInstall>>, toolchainReq: string, jobs: number, analysis: boolean): Promise<BuildAllResult> {
    const cleaned = await this.cleanOne(p, install);
    if (!cleaned.ok) {
      return { project: p.projectName, ok: false, detail: `clean failed: ${cleaned.detail}` };
    }
    return this.buildOne(p, install, toolchainReq, jobs, analysis);
  }

  /** Delete output entries (keepImages: spare 工程名.hex/.bin); never throws. */
  private async deleteOutputOne(p: MrsProject, keepImages: boolean): Promise<BuildAllResult> {
    const ok = (detail: string): BuildAllResult => ({ project: p.projectName, ok: true, detail });
    // shared guard with run()/buildOne: deleting obj/ under a running make
    // would pull .o/.d files out from under the compiler/linker
    if (this.building.has(path.resolve(p.root).toLowerCase())) {
      return ok(t('buildBusySkip'));
    }
    try {
      p.reload();
      if (!fs.existsSync(p.buildDir)) {
        return ok(t('noOutputDir'));
      }
      if (keepImages) {
        const n = clearOutputDir(p.root, p.buildDir, [`${p.cproject.targetName}.hex`, `${p.cproject.targetName}.bin`]);
        return ok(n ? t('entriesRemoved', n) : '');
      }
      removeOutputDir(p.root, p.buildDir);
      return ok(t('outputDirRemoved'));
    } catch (e) {
      return { project: p.projectName, ok: false, detail: msg(e) };
    }
  }

  /** Clean one project; never throws. */
  private cleanOne(p: MrsProject, install: NonNullable<ReturnType<typeof getInstall>>): Promise<BuildAllResult> {
    // shared guard with run()/buildOne: `make clean` against a running
    // build of the same project would delete .o/.d files mid-compile
    if (this.building.has(path.resolve(p.root).toLowerCase())) {
      return Promise.resolve({ project: p.projectName, ok: true, detail: t('buildBusySkip') });
    }
    if (!fs.existsSync(path.join(p.buildDir, 'makefile'))) {
      return Promise.resolve({ project: p.projectName, ok: true, detail: t('nothingToClean') });
    }
    return new Promise<BuildAllResult>((resolve) => {
      let settled = false;
      let exec: vscode.TaskExecution | undefined;
      // end events arriving before executeTask() hands us the execution
      // cannot be attributed yet — buffer them and match on resolution
      // (otherwise ANY same-type task ending in that window settles this
      // waiter with a foreign exit code)
      const early: Array<[vscode.TaskExecution, number | undefined]> = [];
      const finish = (code: number | undefined): void => {
        settled = true;
        sub.dispose();
        const c = code ?? -1;
        resolve({ project: p.projectName, ok: c === 0, detail: c === 0 ? '' : `make exit ${c}` });
      };
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (settled || e.execution.task.definition.type !== 'mrvc-clean-all') return;
        if (!exec) {
          early.push([e.execution, e.exitCode]);
          return;
        }
        if (e.execution !== exec) return;
        finish(e.exitCode);
      });
      const task = new vscode.Task(
        { type: 'mrvc-clean-all' },
        'MRVC: Clean All',
        'MRVC',
        new vscode.ProcessExecution(this.writeCleanWrapper(p.root, p.buildDir, path.join(install.makeBin, 'make.exe')), [], {
          env: { PATH: `${install.makeBin};${process.env['PATH'] ?? ''}` },
        }),
        []
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Shared, clear: true };
      // a rejected executeTask must settle the promise too, or the batch
      // progress hangs forever and buildAllRunning stays latched
      vscode.tasks.executeTask(task).then(
        (e) => {
          exec = e;
          const hit = early.find(([x]) => x === e);
          if (hit && !settled) finish(hit[1]);
        },
        () => {
          if (settled) return;
          settled = true;
          sub.dispose();
          resolve({ project: p.projectName, ok: false, detail: 'task failed to start' });
        }
      );
    });
  }

  /** Build one project; never throws. */
  private buildOne(p: MrsProject, install: NonNullable<ReturnType<typeof getInstall>>, toolchainReq: string, jobs: number, analysis: boolean): Promise<BuildAllResult> {
    const fail = (detail: string): BuildAllResult => ({ project: p.projectName, ok: false, detail });
    let toolchainBinDir = '';
    try {
      p.reload();
      const tc = p.toolchain(install, toolchainReq);
      if (!tc) return Promise.resolve(fail('no RISC-V toolchain found'));
      toolchainBinDir = path.join(tc.dir, 'bin');
      generateMakefiles(p.cproject, tc, { analysis });
    } catch (e) {
      return Promise.resolve(fail(msg(e)));
    }
    // single-build guard, shared with run(): a batch member and a manual
    // Build of the same project must not both write its obj/
    const key = path.resolve(p.root).toLowerCase();
    if (this.building.has(key)) return Promise.resolve(fail(t('buildAlreadyRunning', p.projectName)));
    // the entry must carry the execution once it starts, so a manual Build
    // during the batch can offer "Terminate Build" and actually stop it
    const entry: { exec?: vscode.TaskExecution } = {};
    this.building.set(key, entry);
    return new Promise<BuildAllResult>((resolve) => {
      let settled = false;
      let exec: vscode.TaskExecution | undefined;
      // pre-resolution end events are buffered and matched on resolution
      // (same cross-fire hazard as cleanOne above)
      const early: Array<[vscode.TaskExecution, number | undefined]> = [];
      const finish = (code: number | undefined): void => {
        settled = true;
        sub.dispose();
        this.building.delete(key);
        const c = code ?? -1;
        resolve({ project: p.projectName, ok: c === 0, detail: c === 0 ? '' : `make exit ${c}` });
      };
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (settled || e.execution.task.definition.type !== 'mrvc-build-all') return;
        if (!exec) {
          early.push([e.execution, e.exitCode]);
          return;
        }
        if (e.execution !== exec) return;
        finish(e.exitCode);
      });
      const wrapper = this.writeBuildWrapper(p.root, p.buildDir, path.join(install.makeBin, 'make.exe'), ['-j' + jobs, 'all'], buildRecordFile(p.root));
      const task = new vscode.Task(
        { type: 'mrvc-build-all' },
        'MRVC: Build All',
        'MRVC',
        new vscode.ProcessExecution(wrapper, [], {
          env: { PATH: `${toolchainBinDir};${install.makeBin};${process.env['PATH'] ?? ''}` },
        }),
        ['$mrvcgcc']
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Shared, clear: true };
      vscode.tasks.executeTask(task).then(
        (e) => {
          exec = e;
          entry.exec = e;
          const hit = early.find(([x]) => x === e);
          if (hit && !settled) finish(hit[1]);
        },
        () => {
          if (settled) return;
          settled = true;
          sub.dispose();
          this.building.delete(key);
          resolve(fail('task failed to start'));
        }
      );
    });
  }

  async run(kind: BuildKind, proj?: MrsProject, opts?: RunOptions): Promise<void> {
    const project = proj ?? (await this.pickProject());
    if (!project) return;
    this.store.setActive(project); // last explicitly built project = status bar target

    // one make per project at a time — F7 double-press, an inline button
    // double-click, or a per-project Build while Build All runs that project
    // would otherwise start two `make -jN` on the same obj/
    const buildKey = path.resolve(project.root).toLowerCase();
    if (this.building.has(buildKey)) {
      const inFlight = this.building.get(buildKey)!;
      void vscode.window
        .showWarningMessage(t('buildAlreadyRunning', project.projectName), t('terminateBuild'))
        .then((pick) => {
          if (pick === t('terminateBuild')) inFlight.exec?.terminate();
        });
      return;
    }

    const install = getInstall();
    const tc = project.toolchain(install, vscode.workspace.getConfiguration('mrvc').get('toolchain', 'auto'));
    if (!tc) {
      vscode.window.showErrorMessage(t('noToolchainFound'));
      return;
    }
    if (!install || !fs.existsSync(path.join(install.makeBin, 'make.exe'))) {
      vscode.window.showErrorMessage(t('makeNotFound', install?.makeBin ?? '?'));
      return;
    }

    // regenerate makefiles from the current .cproject every time
    let genResult;
    try {
      genResult = generateMakefiles(project.cproject, tc, {
        analysis: vscode.workspace.getConfiguration('mrvc').get<boolean>('build.analysis', false),
      });
    } catch (e) {
      vscode.window.showErrorMessage(t('makefileGenFailed', msg(e)));
      return;
    }
    void genResult;

    const cfg = vscode.workspace.getConfiguration('mrvc');
    const jobs = cfg.get<number>('build.parallelJobs', 0) || os.cpus().length;
    if (kind === 'clean' && !fs.existsSync(path.join(project.buildDir, 'makefile'))) {
      vscode.window.showInformationMessage(t('neverBuilt', project.projectName));
      return;
    }
    const makeArgs: string[] = [];
    if (kind !== 'clean') {
      makeArgs.push(`-j${jobs}`);
    }
    makeArgs.push(kind === 'clean' ? 'clean' : 'all');

    // from here on a make may run: hold the guard until its process ends
    this.building.set(buildKey, {});

    const envPath = [path.join(tc.dir, 'bin'), install.makeBin, process.env['PATH'] ?? ''].join(path.delimiter);
    const target = kind === 'clean' ? 'MRVC: clean' : kind === 'rebuild' ? 'MRVC: rebuild' : 'MRVC: build';
    const makeExe = path.join(install.makeBin, 'make.exe');
    const shell =
      kind === 'clean'
        ? // a clean must not trample the last build's record — run make via
          // the clean wrapper (no record writes, same metacharacter safety)
          new vscode.ProcessExecution(this.writeCleanWrapper(project.root, project.buildDir, makeExe), [], {
            env: { PATH: envPath },
          })
        : new vscode.ProcessExecution(
            this.writeBuildWrapper(project.root, project.buildDir, makeExe, makeArgs, buildRecordFile(project.root)),
            [],
            { env: { PATH: envPath } }
          );
    const task = new vscode.Task(
      { type: 'mrvc-build', task: target, project: project.projectName },
      project.projectName ? `${target} - ${project.projectName}` : target,
      'MRVC',
      shell,
      ['$mrvcgcc']
    );
    task.group = vscode.TaskGroup.Build;
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, focus: false, clear: true };

    if (kind === 'rebuild') {
      // visible clean task first, then the full build — a failed clean must
      // not masquerade as a successful rebuild
      const cleanTask = new vscode.Task(
        { type: 'mrvc-clean', project: project.projectName },
        `MRVC: clean - ${project.projectName}`,
        'MRVC',
        new vscode.ProcessExecution(this.writeCleanWrapper(project.root, project.buildDir, makeExe), [], {
          env: { PATH: envPath },
        }),
        []
      );
      cleanTask.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Shared, clear: true };
      const cleanCode = await this.executeAndWait(cleanTask, 'mrvc-clean', this.building.get(buildKey));
      if (cleanCode !== 0 && cleanCode !== undefined) {
        vscode.window.showErrorMessage(t('rebuildCleanFailed', cleanCode));
        return;
      }
    }

    this.store.reloadActive();
    try {
      if (opts?.andDownload) {
        // MRS2 buildAndDownload semantics (buildSuccessCallback): the download
        // runs only after a successful build — a failed or cancelled build
        // stops here.
        const code = await this.executeBuildTask(buildKey, task);
        if (code !== 0) {
          vscode.window.showErrorMessage(t('buildFailedNoDownload', project.projectName, code ?? 'unknown'));
          return;
        }
        // downloadProject surfaces its own failures; this catch is the last
        // net so no rejection escapes after an otherwise successful build
        try {
          await downloadProject(this.store, project);
        } catch (e) {
          vscode.window.showErrorMessage(t('downloadThrew', project.projectName, msg(e)));
        }
        return;
      }
      // fire-and-forget build: the guard releases when THIS make process ends,
      // not when run() returns — handled inside executeBuildTask
      await this.executeBuildTask(buildKey, task);
    } finally {
      this.building.delete(buildKey);
    }

  }

  /** MRS2 "Build Project And Download": one pipeline — build, then flash the
   * fresh firmware; the download never runs after a failed build. */
  async buildAndDownload(proj?: MrsProject): Promise<void> {
    await this.run('build', proj, { andDownload: true });
  }

  /** Execute a task and resolve when ITS process ends (matched by execution
   * identity, so concurrent tasks of the same type cannot cross-fire). */
  private executeAndWait(task: vscode.Task, defType: string, entry?: { exec?: vscode.TaskExecution }): Promise<number | undefined> {
    return new Promise<number | undefined>((resolve) => {
      let settled = false;
      let exec: vscode.TaskExecution | undefined;
      // pre-resolution end events are buffered and matched on resolution
      // (same cross-fire hazard as the other task waiters)
      const early: Array<[vscode.TaskExecution, number | undefined]> = [];
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (settled || e.execution.task.definition.type !== defType) return;
        if (!exec) {
          early.push([e.execution, e.exitCode]);
          return;
        }
        if (e.execution !== exec) return;
        settled = true;
        sub.dispose();
        resolve(e.exitCode);
      });
      vscode.tasks.executeTask(task).then(
        (e) => {
          exec = e;
          // write the execution into the caller's guard entry as soon as it
          // exists — during a rebuild's clean phase the entry would
          // otherwise hold no exec and "Terminate Build" silently no-ops
          if (entry) entry.exec = e;
          const hit = early.find(([x]) => x === e);
          if (hit && !settled) {
            settled = true;
            sub.dispose();
            resolve(hit[1]);
          }
        },
        () => {
          if (settled) return;
          settled = true;
          sub.dispose();
          resolve(undefined);
        }
      );
    });
  }

  /**
   * Run the single-build task to completion and resolve with make's exit
   * code, holding the single-build guard for the whole run: the execution is
   * recorded under `key` (so a repeated trigger can terminate it) and the
   * key is released when THIS make process ends — or at once if the task
   * never started. Same execution-identity matching as executeAndWait, so
   * concurrent tasks of the same type cannot cross-fire.
   */
  private executeBuildTask(key: string, task: vscode.Task): Promise<number | undefined> {
    const entry = this.building.get(key);
    return new Promise<number | undefined>((resolve) => {
      let settled = false;
      let exec: vscode.TaskExecution | undefined;
      // pre-resolution end events are buffered and matched on resolution
      // (same cross-fire hazard as the other task waiters)
      const early: Array<[vscode.TaskExecution, number | undefined]> = [];
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (settled || e.execution.task.definition.type !== 'mrvc-build') return;
        if (!exec) {
          early.push([e.execution, e.exitCode]);
          return;
        }
        if (e.execution !== exec) return;
        settled = true;
        sub.dispose();
        this.building.delete(key);
        resolve(e.exitCode);
      });
      vscode.tasks.executeTask(task).then(
        (e) => {
          exec = e;
          if (entry) entry.exec = e;
          const hit = early.find(([x]) => x === e);
          if (hit && !settled) {
            settled = true;
            sub.dispose();
            this.building.delete(key);
            resolve(hit[1]);
          }
        },
        () => {
          if (settled) return;
          settled = true;
          sub.dispose();
          this.building.delete(key);
          resolve(undefined);
        }
      );
    });
  }

  /**
   * The generated wrapper captures the build output into the MRS2 build-record
   * location (%TEMP%/mrs-cache/<project>-<md5>/buildContentRecord.txt, read by
   * "Show Full Build Output"), echoes it into the task terminal and propagates
   * make's exit code. The redirection lives in a wrapper FILE — a
   * ShellExecution string with cmd.exe nesting breaks VSCode's auto-quoting
   * ("文件名、目录名或卷标语法不正确") — and both build paths (single and
   * batch) go through it so the record always reflects the last build.
   *
   * The wrapper lives under %TEMP%/mrs-build/<md5>.cmd, NOT in the build
   * directory: VSCode hands the task command line to the terminal shell
   * UNQUOTED, and a user-controlled project path containing cmd
   * metacharacters (`EVT-IPV4&6` is a common EVT folder name) gets split by
   * cmd at every `&`. The hash-named temp path has nothing to split; the
   * build directory is entered via `cd /d "<buildDir>"` inside the file
   * (quoted — cmd keeps `&` inside quotes literal), so the ProcessExecution
   * carries neither a metacharacter command nor a cwd for VSCode to echo.
   *
   * MRS's makefile recipes carry `@` silencing prefixes, so make's own output
   * never contains the per-file command lines. The record therefore ends with
   * a `make -n -B` dry run, which prints every command the makefile drives
   * (all sources, link, objcopy) — the record then answers "how was each file
   * compiled", which neither MRS2's nor a bare make log does.
   */
  private writeBuildWrapper(projectRoot: string, buildDir: string, makeExe: string, makeArgs: string[], recordFile: string): string {
    const wrapper = buildWrapperFile(projectRoot);
    const body =
      `@echo off\r\n` +
      // `!` is only safe with delayed expansion off — a parent environment can
      // turn it on (AutoRun / /v:on), which would eat `!` in the build path
      `setlocal DisableDelayedExpansion\r\n` +
      `cd /d "${pct(buildDir)}"\r\n` +
      `"${pct(makeExe)}" ${makeArgs.join(' ')} > "${pct(recordFile)}" 2>&1\r\n` +
      `set "MRVC_EXIT=%errorlevel%"\r\n` +
      `type "${pct(recordFile)}"\r\n` +
      `>> "${pct(recordFile)}" echo(\r\n` +
      `>> "${pct(recordFile)}" echo ===== All Build Commands (dry run: make -n -B) =====\r\n` +
      `"${pct(makeExe)}" -n -B all >> "${pct(recordFile)}" 2>&1\r\n` +
      `exit /b %MRVC_EXIT%\r\n`;
    // the paths inside the wrapper (record lives under %TEMP%) are not ASCII
    // on machines with a Chinese user name, and cmd parses the file in the
    // ANSI code page — same encoding the generated makefiles use
    fs.writeFileSync(wrapper, encodeArtifact(body));
    return wrapper;
  }

  /**
   * Same metacharacter-safe shape as writeBuildWrapper, for `make clean`:
   * no record writes (a clean must not trample the last build's record) and
   * no dry-run appendix. Used by single Clean, Rebuild's clean step and
   * batch Clean — every make invocation carries a wrapper, so no
   * ProcessExecution ever carries a user-controlled cwd again.
   */
  private writeCleanWrapper(projectRoot: string, buildDir: string, makeExe: string): string {
    const wrapper = buildWrapperFile(projectRoot, 'clean');
    const body =
      `@echo off\r\n` +
      `setlocal DisableDelayedExpansion\r\n` +
      `cd /d "${pct(buildDir)}"\r\n` +
      `"${pct(makeExe)}" clean\r\n` +
      `exit /b %errorlevel%\r\n`;
    fs.writeFileSync(wrapper, encodeArtifact(body));
    return wrapper;
  }

  private async pickProject(): Promise<MrsProject | undefined> {
    const active = this.store.active;
    if (active) return active;
    const all = this.store.all;
    if (!all.length) {
      vscode.window.showErrorMessage(t('noProjectsLoaded'));
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((p) => ({ label: p.projectName, description: p.root, project: p })),
      { placeHolder: t('pickProject') }
    );
    return pick?.project;
  }
}
