/**
 * The "Info" view under the project explorer — the visible form of the
 * effective MRS configuration that builds and downloads reuse (requirement
 * 0.3.0-2): which configuration is in effect (IDE install vs standalone
 * toolchain, generation, path), the active project and its toolchain. The
 * extension refreshes it on every store change and on any mrvc.*
 * configuration change, so what the view shows is what the next build uses.
 *
 * The toolchain row resolves through selectToolchain() DIRECTLY — not
 * Project.toolchain(), whose per-call POSIX arch check would raise the
 * mismatch warning dialog every time this view repaints.
 */
import * as vscode from 'vscode';
import { ProjectStore, selectMrsInstall } from './projects';
import { CustomToolchain, mergeCustomToolchains, selectToolchain } from '../core/toolchain';
import { sdiPrintfStatus } from '../core/sdiState';
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
    const cfg = vscode.workspace.getConfiguration('mrvc');
    // merge mrvc.customToolchains exactly as the build path (getInstall) does:
    // the raw selection carries only installed toolchains, so resolving a
    // custom name against it would show None / the first built-in instead
    const install = selection.install
      ? mergeCustomToolchains(selection.install, cfg.get<CustomToolchain[]>('customToolchains', []))
      : null;
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

    // 3. that project's toolchain (arch-warning-free resolution — see header)
    let tcText = t('infoNone');
    if (project && install) {
      const tc = selectToolchain(install, cfg.get<string>('toolchain', 'auto'), project.cproject.rvGccVersion, project.cproject.storedPrefix);
      if (tc) tcText = `${tc.name} (${tc.prefix})`;
    }
    const tcRow = new vscode.TreeItem(tcText, vscode.TreeItemCollapsibleState.None);
    tcRow.description = t('infoToolchainCat');
    tcRow.iconPath = new vscode.ThemeIcon('debug-alt');
    rows.push(tcRow);

    // 4. SDI Printf: NOT a hardware read-back — WCH's CommunicationLib only
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

    return rows;
  }
}
