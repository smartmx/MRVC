/**
 * Flash (download) via OpenOCD (run as a VSCode task so output/stop come
 * for free), plus the WCH-LinkUtility GUI launcher and the MRS terminal.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectStore, MrsProject, getInstall } from './projects';
import { prepareFlash } from '../core/flash';

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

  // pick the firmware file
  let hex = project.hexPath;
  if (!fs.existsSync(hex)) {
    const pick = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(project.buildDir),
      filters: { Firmware: ['hex', 'bin'] },
      title: 'Select firmware to download',
    });
    if (!pick?.length) return;
    hex = pick[0].fsPath;
  }
  if (!fs.existsSync(hex)) {
    vscode.window.showErrorMessage(`Firmware file not found: ${hex}`);
    return;
  }

  const cfg = vscode.workspace.getConfiguration('mrvc');
  const openocd = cfg.get<string>('openocd.path') || install.openocdExe;
  const boardCfg = cfg.get<string>('openocd.config') || install.openocdCfg;
  if (!fs.existsSync(openocd)) {
    vscode.window.showErrorMessage(`openocd.exe not found: ${openocd}`);
    return;
  }
  if (!fs.existsSync(boardCfg)) {
    vscode.window.showErrorMessage(`OpenOCD config not found: ${boardCfg}`);
    return;
  }

  const address = cfg.get<string>('flash.address') || project.template.values['Address'] || '0x00000000';
  const plan = prepareFlash(project, {
    address,
    verify: cfg.get<boolean>('flash.verify', true),
    reset: cfg.get<boolean>('flash.reset', true),
    boardCfg,
    firmware: hex,
  });

  const task = new vscode.Task(
    { type: 'mrvc-flash', task: 'flash', project: project.projectName },
    `MRVC: download - ${project.projectName}`,
    'MRVC',
    new vscode.ProcessExecution(openocd, plan.args, { cwd: project.root })
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  await vscode.tasks.executeTask(task);
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
