/**
 * MRS2 Tools menu equivalents — launch the external tools bundled with
 * MRS2 (same executables MRS2 spawns with child_process.exec, here started
 * as detached processes so the extension host never waits on them).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getInstall } from './projects';
import { resolveMrsTools } from '../core/mrsTools';
import { t } from '../core/i18n';

/** start a tool exe detached; missing installations get a clear error */
function launchTool(exe: string, title: string): void {
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(t('mrsToolsNoInstallStart', title));
    return;
  }
  if (!exe || !fs.existsSync(exe)) {
    vscode.window.showErrorMessage(t('mrsToolsNotFound', title, install.resourcesWin32));
    return;
  }
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => {
      vscode.window.showErrorMessage(t('mrsToolsStartFailed', title, e.message));
    });
    child.unref();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(t('mrsToolsStartFailed', title, detail));
  }
}

/** resolve all six tools against the current installation */
function resolveTools(): ReturnType<typeof resolveMrsTools> | null {
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(t('installNotFound'));
    return null;
  }
  return resolveMrsTools(install);
}

export function ispToolCmd(): void {
  const tools = resolveTools();
  if (tools) launchTool(tools.ispStudio, 'WCH In-System Programmer (WchIspStudio)');
}

export function touchkeyToolCmd(): void {
  const tools = resolveTools();
  if (tools) launchTool(tools.touchkeyTool, 'WCH Touchkey Calibrate Tool');
}

export function uiDesignerCmd(): void {
  const tools = resolveTools();
  if (tools) launchTool(tools.uiDesigner, 'WCHGUIDesigner');
}

export function hexBinToolCmd(): void {
  const tools = resolveTools();
  if (tools) launchTool(tools.hexBinStudio, 'HexBin Studio');
}

export function comTransmitCmd(): void {
  const tools = resolveTools();
  if (tools) launchTool(tools.comTransmit, 'Serial Port Debug Tool (COMTransmit)');
}
