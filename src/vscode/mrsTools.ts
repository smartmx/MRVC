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

/** start a tool exe detached; missing installations get a clear error */
function launchTool(exe: string, title: string): void {
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(`MRVC: cannot start ${title} — MRS2 installation not found (set mrvc.mrs2InstallPath).`);
    return;
  }
  if (!exe || !fs.existsSync(exe)) {
    vscode.window.showErrorMessage(`MRVC: ${title} not found under the MRS2 installation (${install.resourcesWin32}).`);
    return;
  }
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => {
      vscode.window.showErrorMessage(`MRVC: failed to start ${title} — ${e.message}`);
    });
    child.unref();
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: failed to start ${title} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** resolve all six tools against the current installation */
function resolveTools(): ReturnType<typeof resolveMrsTools> | null {
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage('MRVC: MRS2 installation not found — set mrvc.mrs2InstallPath.');
    return null;
  }
  return resolveMrsTools(install);
}

export function ispToolCmd(): void {
  const t = resolveTools();
  if (t) launchTool(t.ispStudio, 'WCH In-System Programmer (WchIspStudio)');
}

export function touchkeyToolCmd(): void {
  const t = resolveTools();
  if (t) launchTool(t.touchkeyTool, 'WCH Touchkey Calibrate Tool');
}

export function uiDesignerCmd(): void {
  const t = resolveTools();
  if (t) launchTool(t.uiDesigner, 'WCHGUIDesigner');
}

export function hexBinToolCmd(): void {
  const t = resolveTools();
  if (t) launchTool(t.hexBinStudio, 'HexBin Studio');
}

export function comTransmitCmd(): void {
  const t = resolveTools();
  if (t) launchTool(t.comTransmit, 'Serial Port Debug Tool (COMTransmit)');
}
