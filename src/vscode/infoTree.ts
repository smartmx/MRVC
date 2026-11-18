/**
 * The "Info" view under the project explorer — the visible form of the
 * effective MRS configuration that builds and downloads reuse (requirement
 * 0.3.0-2): which configuration is in effect (IDE install vs standalone
 * toolchain, generation, path), the active project, the SDI Printf session
 * state, the flash power-output rail and the power-off reset action. The
 * extension refreshes it on every store change and on any mrvc.*
 * configuration change, so what the view shows is what the next build uses.
 *
 * The workspace and toolchain rows were dropped with the user request of
 * 2026-11-18 (the workspace is visible in the explorer itself; GCC
 * resolution stays inside the build path).
 *
 * Status rows are display-only by design: no hardware query runs on a
 * repaint. The SDI row reads MRVC's own session accounting (no getter
 * exists); the power-output row reads the SESSION rail state
 * (core/powerState — every window opens at 3.3 V, only a manual switch can
 * raise it to 5 V, closing the window restores 3.3 V) and its click opens
 * the switch QuickPick.
 */
import * as vscode from 'vscode';
import { ProjectStore, selectMrsInstall } from './projects';
import { sdiPrintfStatus } from '../core/sdiState';
import { powerOutputRail } from '../core/powerState';
import { t } from '../core/i18n';

interface InfoRow extends vscode.TreeItem {}

export class InfoTreeProvider implements vscode.TreeDataProvider<InfoRow> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly store: ProjectStore) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(row: InfoRow): vscode.TreeItem {
    return row;
  }

  getChildren(): InfoRow[] {
    const selection = selectMrsInstall();
    const install = selection.install;
    const project = this.store.active;
    const rows: InfoRow[] = [];

    // 1. effective configuration — clicking opens the extension settings
    const kindText = install
      ? `${install.label} · ${install.kind === 'ide' ? 'IDE' : t('infoKindToolchain')}`
      : t('infoNoConfig');
    const config = new vscode.TreeItem(kindText, vscode.TreeItemCollapsibleState.None);
    config.description = install ? install.root : undefined;
    config.tooltip = `${kindText}${selection.pinnedFellBack ? t('infoPinFallback') : ''}${install ? '\n' + install.root : ''}`;
    config.command = { command: 'mrvc.openSettings', title: t('infoOpenSettings') };
    config.iconPath = new vscode.ThemeIcon(install?.kind === 'toolchain' ? 'wrench' : 'vm');
    rows.push(config);

    // 2. the active project
    const projectRow = new vscode.TreeItem(project?.projectName ?? t('infoNone'), vscode.TreeItemCollapsibleState.None);
    projectRow.description = t('infoProjectCat');
    projectRow.iconPath = new vscode.ThemeIcon('folder-active');
    rows.push(projectRow);

    // 3. SDI Printf: NOT a hardware read-back — WCH's CommunicationLib only
    // exposes the SET command (McuCompiler_SetSDIPrn), with no getter. The
    // row reports what MRVC itself wrote in this session; the tooltip says so
    // and a click opens the monitor so the user can look at the actual stream.
    const sdi = sdiPrintfStatus();
    const sdiText =
      sdi.state === 'enabled'
        ? t('infoSdiEnabled')
        : sdi.state === 'failed'
          ? t('infoSdiFailed')
          : sdi.state === 'notRequested'
            ? t('infoSdiNotRequested')
            : t('infoSdiUnknown');
    const sdiRow = new vscode.TreeItem(sdiText, vscode.TreeItemCollapsibleState.None);
    sdiRow.description = t('infoSdiCat');
    sdiRow.iconPath = new vscode.ThemeIcon(
      sdi.state === 'enabled'
        ? 'pass-filled'
        : sdi.state === 'failed'
          ? 'warning'
          : sdi.state === 'notRequested'
            ? 'circle-slash'
            : 'question'
    );
    sdiRow.tooltip = [
      sdi.state === 'notRequested' ? t('infoSdiTooltipNotRequested') : t('infoSdiTooltip'),
      sdi.state !== 'failed' && sdi.at ? new Date(sdi.at).toLocaleTimeString() : '',
      sdi.detail ?? '',
    ]
      .filter(Boolean)
      .join('\n');
    sdiRow.command = { command: 'mrvc.sdiPrintMonitor', title: t('infoSdiOpenMonitor') };
    rows.push(sdiRow);

    // 4. Flash power output — the SESSION rail (core/powerState): every
    // window opens at 3.3 V; only a manual switch (this row's QuickPick)
    // raises it to 5 V; closing the window restores 3.3 V. The rail is what
    // the power-off-reset download and the row below feed the target with.
    // Display-only here; the link-model gate (only LinkE / DAPLink / LinkW
    // can switch rails) is enforced by the operations themselves and spelled
    // out in the tooltip.
    const railRow = new vscode.TreeItem(
      powerOutputRail() === '5v' ? t('infoPowerOutput5v') : t('infoPowerOutput3v3'),
      vscode.TreeItemCollapsibleState.None
    );
    railRow.description = t('infoPowerOutputCat');
    railRow.iconPath = new vscode.ThemeIcon('zap');
    railRow.tooltip = t('infoPowerOutputTooltip');
    railRow.command = { command: 'mrvc.powerOutputRail', title: t('infoPowerOutputSwitch') };
    rows.push(railRow);

    // 5. Power-Off Reset action row — a CLICKABLE action, not a status: the
    // project context menu was getting crowded (user request 2026-11-16), so
    // the WCH-Link power-cycle lives here instead. The command itself gates
    // on the link model (plain WCH-Link cannot switch rails) and shows its
    // own errors; the row is dimmed when there is no active project.
    const powerRow = new vscode.TreeItem(
      project ? t('infoPowerOffReset') : t('infoNone'),
      vscode.TreeItemCollapsibleState.None
    );
    powerRow.description = t('infoPowerCat');
    powerRow.iconPath = new vscode.ThemeIcon('debug-restart');
    powerRow.tooltip = t('infoPowerTooltip');
    if (project) {
      powerRow.command = { command: 'mrvc.powerOffReset', title: t('infoPowerOffReset'), arguments: [{ project }] };
    }
    rows.push(powerRow);

    return rows;
  }
}
