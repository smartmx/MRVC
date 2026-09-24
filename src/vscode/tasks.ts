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

export type BuildKind = 'build' | 'rebuild' | 'clean';

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

  constructor(private store: ProjectStore) {}

  /**
   * Build every loaded project sequentially. A failing project never stops
   * the run — every project is attempted, results are summarized at the end.
   */
  async buildAll(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('mrvc');
    const toolchainReq = cfg.get<string>('toolchain', 'auto');
    const jobs = cfg.get<number>('build.parallelJobs', 0) || os.cpus().length;
    return this.runBatch(this.store.all, {
      progressTitle: 'MRVC: Build All',
      label: 'Build All',
      emptyMessage: 'No MRS project loaded. Use "MRVC: Open MRS Project" first.',
      needsMake: true,
      worker: (p, install) => this.buildOne(p, install, toolchainReq, jobs),
    });
  }

  /** Build one solution's member projects in BuildOrder order. */
  async buildSolution(sol: MrsSolution): Promise<void> {
    const members = sol.members;
    if (!members.length) {
      vscode.window.showErrorMessage(`MRVC: solution "${sol.name}" has no loadable projects.`);
      return;
    }
    const cfg = vscode.workspace.getConfiguration('mrvc');
    const toolchainReq = cfg.get<string>('toolchain', 'auto');
    const jobs = cfg.get<number>('build.parallelJobs', 0) || os.cpus().length;
    return this.runBatch(members, {
      progressTitle: `MRVC: Build Solution - ${sol.name}`,
      label: `Build Solution (${sol.name})`,
      emptyMessage: `MRVC: solution "${sol.name}" has no loadable projects.`,
      needsMake: true,
      worker: (p, install) => this.buildOne(p, install, toolchainReq, jobs),
    });
  }

  /** Clean then build every loaded project, one project at a time. */
  async rebuildAll(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('mrvc');
    const toolchainReq = cfg.get<string>('toolchain', 'auto');
    const jobs = cfg.get<number>('build.parallelJobs', 0) || os.cpus().length;
    return this.runBatch(this.store.all, {
      progressTitle: 'MRVC: Rebuild All',
      label: 'Rebuild All',
      emptyMessage: 'No MRS project loaded. Use "MRVC: Open MRS Project" first.',
      needsMake: true,
      worker: (p, install) => this.rebuildOne(p, install, toolchainReq, jobs),
    });
  }

  /**
   * Delete every project's output directory contents, keeping the flash
   * images (工程名.hex / 工程名.bin). Makefiles and objects go — the next
   * build regenerates them.
   */
  async deleteOutputFiles(): Promise<void> {
    return this.runBatch(this.store.all, {
      progressTitle: 'MRVC: Delete Output Files (Keep hex/bin)',
      label: 'Delete Output Files (Keep hex/bin)',
      emptyMessage: 'No MRS project loaded. Use "MRVC: Open MRS Project" first.',
      worker: (p) => this.deleteOutputOne(p, true),
    });
  }

  /** Delete every project's whole output directory. */
  async deleteOutputDirs(): Promise<void> {
    return this.runBatch(this.store.all, {
      progressTitle: 'MRVC: Delete Output Directories',
      label: 'Delete Output Directories',
      emptyMessage: 'No MRS project loaded. Use "MRVC: Open MRS Project" first.',
      worker: (p) => this.deleteOutputOne(p, false),
    });
  }

  /**
   * Clean every loaded project sequentially. Never-built projects (no
   * makefile yet) are skipped; failures never stop the run.
   */
  async cleanAll(): Promise<void> {
    return this.runBatch(this.store.all, {
      progressTitle: 'MRVC: Clean All',
      label: 'Clean All',
      emptyMessage: 'No MRS project loaded. Use "MRVC: Open MRS Project" first.',
      needsMake: true,
      worker: (p, install) => this.cleanOne(p, install),
    });
  }

  /** Clean one solution's member projects in BuildOrder order. */
  async cleanSolution(sol: MrsSolution): Promise<void> {
    const members = sol.members;
    if (!members.length) {
      vscode.window.showErrorMessage(`MRVC: solution "${sol.name}" has no loadable projects.`);
      return;
    }
    return this.runBatch(members, {
      progressTitle: `MRVC: Clean Solution - ${sol.name}`,
      label: `Clean Solution (${sol.name})`,
      emptyMessage: `MRVC: solution "${sol.name}" has no loadable projects.`,
      needsMake: true,
      worker: (p, install) => this.cleanOne(p, install),
    });
  }

  /** Sequential never-stopping batch over a project list (Build/Clean/Rebuild All, solutions, output deletion). */
  private async runBatch(projects: MrsProject[], opts: BatchOptions): Promise<void> {
    if (this.buildAllRunning) {
      vscode.window.showWarningMessage('MRVC: another batch operation is already running.');
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
        vscode.window.showErrorMessage(`make.exe not found under the MounRiver installation (${install?.makeBin ?? '?'})`);
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
      vscode.window.showWarningMessage(`MRVC: ${opts.label} cancelled — ${results.length - failed.length}/${results.length} OK, ${failed.length} failed.`);
    } else if (failed.length) {
      const names = failed.map((r) => r.project).join(', ');
      void vscode.window
        .showWarningMessage(
          `MRVC: ${opts.label} finished — ${results.length - failed.length}/${results.length} OK, ${failed.length} failed (${names}). See Problems panel and "MRVC Build All" output.`,
          'Show Output'
        )
        .then((pick) => pick === 'Show Output' && channel.show(true));
    } else {
      vscode.window.showInformationMessage(`MRVC: ${opts.label} finished — all ${results.length} projects OK (${seconds}s).`);
    }
  }

  /** Clean one project, then build it fresh; a failed clean fails the rebuild. */
  private async rebuildOne(p: MrsProject, install: NonNullable<ReturnType<typeof getInstall>>, toolchainReq: string, jobs: number): Promise<BuildAllResult> {
    const cleaned = await this.cleanOne(p, install);
    if (!cleaned.ok) {
      return { project: p.projectName, ok: false, detail: `clean failed: ${cleaned.detail}` };
    }
    return this.buildOne(p, install, toolchainReq, jobs);
  }

  /** Delete output entries (keepImages: spare 工程名.hex/.bin); never throws. */
  private async deleteOutputOne(p: MrsProject, keepImages: boolean): Promise<BuildAllResult> {
    const ok = (detail: string): BuildAllResult => ({ project: p.projectName, ok: true, detail });
    try {
      p.reload();
      if (!fs.existsSync(p.buildDir)) {
        return ok('no output directory');
      }
      if (keepImages) {
        const n = clearOutputDir(p.root, p.buildDir, [`${p.cproject.targetName}.hex`, `${p.cproject.targetName}.bin`]);
        return ok(n ? `${n} entries removed` : '');
      }
      removeOutputDir(p.root, p.buildDir);
      return ok('output directory removed');
    } catch (e) {
      return { project: p.projectName, ok: false, detail: msg(e) };
    }
  }

  /** Clean one project; never throws. */
  private cleanOne(p: MrsProject, install: NonNullable<ReturnType<typeof getInstall>>): Promise<BuildAllResult> {
    if (!fs.existsSync(path.join(p.buildDir, 'makefile'))) {
      return Promise.resolve({ project: p.projectName, ok: true, detail: 'nothing to clean' });
    }
    return new Promise<BuildAllResult>((resolve) => {
      let settled = false;
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (settled || e.execution.task.definition.type !== 'mrvc-clean-all') return;
        settled = true;
        sub.dispose();
        const code = e.exitCode ?? -1;
        resolve({ project: p.projectName, ok: code === 0, detail: code === 0 ? '' : `make exit ${code}` });
      });
      const task = new vscode.Task(
        { type: 'mrvc-clean-all' },
        'MRVC: Clean All',
        'MRVC',
        new vscode.ProcessExecution(path.join(install.makeBin, 'make.exe'), ['clean'], {
          cwd: p.buildDir,
          env: { PATH: `${install.makeBin};${process.env['PATH'] ?? ''}` },
        }),
        []
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Shared, clear: true };
      void vscode.tasks.executeTask(task);
    });
  }

  /** Build one project; never throws. */
  private buildOne(p: MrsProject, install: NonNullable<ReturnType<typeof getInstall>>, toolchainReq: string, jobs: number): Promise<BuildAllResult> {
    const fail = (detail: string): BuildAllResult => ({ project: p.projectName, ok: false, detail });
    let toolchainBinDir = '';
    try {
      p.reload();
      const tc = p.toolchain(install, toolchainReq);
      if (!tc) return Promise.resolve(fail('no RISC-V toolchain found'));
      toolchainBinDir = path.join(tc.dir, 'bin');
      generateMakefiles(p.cproject, tc);
    } catch (e) {
      return Promise.resolve(fail(msg(e)));
    }
    return new Promise<BuildAllResult>((resolve) => {
      let settled = false;
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (settled || e.execution.task.definition.type !== 'mrvc-build-all') return;
        settled = true;
        sub.dispose();
        const code = e.exitCode ?? -1;
        resolve({ project: p.projectName, ok: code === 0, detail: code === 0 ? '' : `make exit ${code}` });
      });
      const task = new vscode.Task(
        { type: 'mrvc-build-all' },
        'MRVC: Build All',
        'MRVC',
        new vscode.ProcessExecution(path.join(install.makeBin, 'make.exe'), ['-j' + jobs, 'all'], {
          cwd: p.buildDir,
          env: { PATH: `${toolchainBinDir};${install.makeBin};${process.env['PATH'] ?? ''}` },
        }),
        ['$mrvcgcc']
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Shared, clear: true };
      void vscode.tasks.executeTask(task);
    });
  }

  async run(kind: BuildKind, proj?: MrsProject): Promise<void> {
    const project = proj ?? (await this.pickProject());
    if (!project) return;
    this.store.setActive(project); // last explicitly built project = status bar target

    const install = getInstall();
    const tc = project.toolchain(install, vscode.workspace.getConfiguration('mrvc').get('toolchain', 'auto'));
    if (!tc) {
      vscode.window.showErrorMessage(
        'No RISC-V toolchain found. Check the "mrvc.mrs2InstallPath" setting — it must point to your MRS2 (MounRiver Studio 2) installation folder.'
      );
      return;
    }
    if (!install || !fs.existsSync(path.join(install.makeBin, 'make.exe'))) {
      vscode.window.showErrorMessage(`make.exe not found under the MounRiver installation (${install?.makeBin ?? '?'})`);
      return;
    }

    // regenerate makefiles from the current .cproject every time
    let genResult;
    try {
      genResult = generateMakefiles(project.cproject, tc);
    } catch (e) {
      vscode.window.showErrorMessage(`Makefile generation failed: ${msg(e)}`);
      return;
    }

    const cfg = vscode.workspace.getConfiguration('mrvc');
    const jobs = cfg.get<number>('build.parallelJobs', 0) || os.cpus().length;
    const makeArgs: string[] = [];
    if (kind !== 'clean') {
      makeArgs.push(`-j${jobs}`);
    }
    makeArgs.push(kind === 'clean' ? 'clean' : 'all');

    const target = kind === 'clean' ? 'MRVC: clean' : kind === 'rebuild' ? 'MRVC: rebuild' : 'MRVC: build';
    const task = new vscode.Task(
      { type: 'mrvc-build', task: target, project: project.projectName },
      project.projectName ? `${target} - ${project.projectName}` : target,
      'MRVC',
      new vscode.ProcessExecution(path.join(install.makeBin, 'make.exe'), makeArgs, {
        cwd: project.buildDir,
        env: {
          PATH: `${tc.dir}\\bin;${install.makeBin};${process.env['PATH'] ?? ''}`,
        },
      }),
      ['$mrvcgcc']
    );
    task.group = vscode.TaskGroup.Build;
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, focus: false, clear: true };

    if (kind === 'rebuild') {
      // visible clean task first, then the full build — a failed clean can
      // no longer masquerade as a successful rebuild
      const cleanTask = new vscode.Task(
        { type: 'mrvc-clean', project: project.projectName },
        `MRVC: clean - ${project.projectName}`,
        'MRVC',
        new vscode.ProcessExecution(path.join(install.makeBin, 'make.exe'), ['clean'], {
          cwd: project.buildDir,
          env: { PATH: `${tc.dir}\\bin;${install.makeBin};${process.env['PATH'] ?? ''}` },
        }),
        []
      );
      cleanTask.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Shared, clear: true };
      await this.executeAndWait(cleanTask, 'mrvc-clean');
    }

    this.store.reloadActive();
    await vscode.tasks.executeTask(task);
    void genResult;
  }

  /** Execute a task and resolve when its process ends. */
  private executeAndWait(task: vscode.Task, defType: string): Promise<number | undefined> {
    return new Promise<number | undefined>((resolve) => {
      let settled = false;
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (settled || e.execution.task.definition.type !== defType) return;
        settled = true;
        sub.dispose();
        resolve(e.exitCode);
      });
      void vscode.tasks.executeTask(task);
    });
  }

  private async pickProject(): Promise<MrsProject | undefined> {
    const active = this.store.active;
    if (active) return active;
    const all = this.store.all;
    if (!all.length) {
      vscode.window.showErrorMessage('No MRS project loaded. Use "MRVC: Open MRS Project" first.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((p) => ({ label: p.projectName, description: p.root, project: p })),
      { placeHolder: 'Select project' }
    );
    return pick?.project;
  }
}
