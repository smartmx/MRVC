/**
 * Flash (download) via OpenOCD (run as a VSCode task so output/stop come
 * for free), plus the WCH-LinkUtility GUI launcher and the MRS terminal.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectStore, MrsProject, getInstall } from './projects';
import { prepareFlash } from '../core/flash';

/**
 * Board cfg selection, aligned with MRS2's own rule (its debug launcher):
 * the explicit setting wins, dual-core projects need wch-dual-core.cfg
 * (core1's flash bank sits at 0x00005000), ARM toolchains need
 * wch-arm.cfg, everything else uses the stock wch-riscv.cfg. Chip series
 * never enters the choice — address differences ride on the .template.
 */
function selectBoardCfg(project: MrsProject, cfg: vscode.WorkspaceConfiguration): string {
  const install = getInstall();
  if (!install) return '';
  const override = cfg.get<string>('openocd.config');
  if (override) return override;
  const binDir = path.dirname(install.openocdCfg);
  if (project.kernel) return path.join(binDir, 'wch-dual-core.cfg');
  const tc = project.toolchain(install, cfg.get<string>('toolchain', 'auto'));
  if (tc && tc.prefix.startsWith('arm')) return path.join(binDir, 'wch-arm.cfg');
  return install.openocdCfg;
}

/** firmware: .template Target Path (MRS2 convention, covers Merge.Bin) →
 * derived hexPath → file picker */
async function pickFirmware(project: MrsProject): Promise<string | undefined> {
  const target = project.template.values['Target Path']?.trim();
  if (target) {
    const cand = path.isAbsolute(target) ? target : path.join(project.root, target);
    if (fs.existsSync(cand)) return cand;
  }
  if (fs.existsSync(project.hexPath)) return project.hexPath;
  const pick = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(project.buildDir),
    filters: { Firmware: ['hex', 'bin'] },
    title: `Select firmware to download (${project.projectName})`,
  });
  return pick?.length ? pick[0].fsPath : undefined;
}

/** run the flash task and resolve with its exit code (undefined = no end event) */
async function executeFlashTask(task: vscode.Task): Promise<number | undefined> {
  const done = new Promise<number | undefined>((resolve) => {
    let settled = false;
    let exec: vscode.TaskExecution | undefined;
    const d = vscode.tasks.onDidEndTaskProcess((e) => {
      if (settled || e.execution.task.definition.type !== 'mrvc-flash') return;
      // match by execution identity: a still-running earlier flash must not
      // resolve this one with its exit code
      if (exec && e.execution !== exec) return;
      settled = true;
      d.dispose();
      resolve(e.exitCode);
    });
    vscode.tasks.executeTask(task).then(
      (e) => {
        exec = e;
      },
      () => {
        // task never started — release the listener, report failure
        if (settled) return;
        settled = true;
        d.dispose();
        resolve(undefined);
      }
    );
  });
  return done;
}

export async function flashProject(store: ProjectStore, proj?: MrsProject): Promise<void> {
  const project = proj ?? store.active;
  if (!project) {
    vscode.window.showErrorMessage('No active MRS project.');
    return;
  }
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage('MRS2 (MounRiver Studio 2) installation not found — set "mrvc.mrs2InstallPath" to your MRS2 install folder.');
    return;
  }

  const hex = await pickFirmware(project);
  if (!hex) return;
  if (!fs.existsSync(hex)) {
    vscode.window.showErrorMessage(`Firmware file not found: ${hex}`);
    return;
  }

  const cfg = vscode.workspace.getConfiguration('mrvc');
  const openocd = cfg.get<string>('openocd.path') || install.openocdExe;
  const boardCfg = selectBoardCfg(project, cfg);
  if (!fs.existsSync(openocd)) {
    vscode.window.showErrorMessage(`openocd.exe not found: ${openocd}`);
    return;
  }
  if (!fs.existsSync(boardCfg)) {
    vscode.window.showErrorMessage(`OpenOCD config not found: ${boardCfg}`);
    return;
  }

  const address = cfg.get<string>('flash.address') || project.template.values['Address'] || '0x00000000';
  const plan = prepareFlash({
    buildDir: project.buildDir,
    address,
    verify: cfg.get<boolean>('flash.verify', true),
    reset: cfg.get<boolean>('flash.reset', true),
    boardCfg,
    firmware: hex,
  });

  store.setActive(project);
  const task = new vscode.Task(
    { type: 'mrvc-flash', task: 'flash', project: project.projectName },
    `MRVC: download - ${project.projectName}`,
    'MRVC',
    new vscode.ProcessExecution(openocd, plan.args, { cwd: project.root })
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  const code = await executeFlashTask(task);
  if (code !== 0) {
    vscode.window.showErrorMessage(`MRVC: download failed for "${project.projectName}" (exit code ${code ?? 'unknown'}) — see the task output.`);
  }
}

export function openLinkUtility(): void {
  const install = getInstall();
  if (!install || !fs.existsSync(install.linkUtilityExe)) {
    vscode.window.showErrorMessage('WCH-LinkUtility.exe not found under the MounRiver installation.');
    return;
  }
  const task = new vscode.Task(
    { type: 'mrvc-tool', task: 'wch-link-utility' },
    'MRVC: WCH-LinkUtility',
    'MRVC',
    new vscode.ProcessExecution(install.linkUtilityExe, [], { cwd: path.dirname(install.linkUtilityExe) })
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Never };
  void vscode.tasks.executeTask(task);
}

export function openMrsTerminal(store: ProjectStore): void {
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage('MRS2 (MounRiver Studio 2) installation not found — set "mrvc.mrs2InstallPath" to your MRS2 install folder.');
    return;
  }
  const toolDirs: string[] = [];
  const tc = store.active?.toolchain(install, vscode.workspace.getConfiguration('mrvc').get('toolchain', 'auto'));
  if (tc) toolDirs.push(path.join(tc.dir, 'bin'));
  const envPath = [...toolDirs, install.makeBin, path.dirname(install.openocdExe), process.env['PATH'] ?? ''].join(';');
  const terminal = vscode.window.createTerminal({
    name: 'MRS Command Line',
    env: { ...process.env, PATH: envPath },
    cwd: store.active?.root,
  });
  terminal.show();
  terminal.sendText('echo MRVC toolchain environment ready (gcc, make, openocd on PATH)');
}
