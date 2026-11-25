/**
 * "Export AI MCP Server" command — Project Explorer `…` menu (0.3.7, user
 * request). VS Code installs every extension version in its own folder, so
 * an MCP client pointed at <extension>/mcp/mcp-server.js loses the server on
 * the next upgrade. The command copies the bundled server to a folder the
 * user owns (core/mcpExport decides the layout and the files) and hands back
 * the stable path to put into the client config.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { applyMcpExport, compareVersions, isInsideDir, McpExportInstallPaths, mcpClientConfig, MCP_SERVER_FILE, planMcpExport, resolveMcpExportDest } from '../core/mcpExport';
import { t } from '../core/i18n';

/** globalState key: the folder of the last export (re-offered next time) */
const LAST_DEST = 'mrvc.mcp.exportDest';

export async function exportMcpServerCmd(context: vscode.ExtensionContext): Promise<void> {
  const extRoot = context.extensionPath;
  // the headless copy cannot read VS Code settings: carry the MRS install
  // locations as configured here, so the copy falls back to them when the
  // conventional locations hold no install (tools.ts resolveInstall)
  const cfg = vscode.workspace.getConfiguration('mrvc');
  const installPaths: McpExportInstallPaths = {};
  const setting = (key: string): string => String(cfg.get(key, '') ?? '').trim();
  const mrs2 = setting('mrs2InstallPath');
  const mrs3 = setting('mrs3InstallPath');
  const toolchainOnly = setting('toolchainOnlyPath');
  if (mrs2) installPaths.mrs2 = mrs2;
  if (mrs3) installPaths.mrs3 = mrs3;
  if (toolchainOnly) installPaths.toolchainOnly = toolchainOnly;
  // the generation pin travels too: without it a copy exported from an
  // MRS2-pinned machine silently picked the MRS3 toolchain when both
  // installs were present (0.3.7 round3 P2.1)
  const mrsVersion = setting('mrsVersion');
  const planned = planMcpExport(extRoot, undefined, Object.keys(installPaths).length ? installPaths : undefined, mrsVersion || undefined);
  if (!planned.ok) {
    void vscode.window.showErrorMessage(t(planned.error === 'no-server' ? 'mcpExportNoServer' : 'mcpExportNoManifest'));
    return;
  }
  const plan = planned.plan;

  const last = context.globalState.get<string | undefined>(LAST_DEST);
  const picked = await vscode.window.showOpenDialog({
    title: t('mcpExportTitle'),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: t('mcpExportHere'),
    // reopen AROUND the previous destination: picking that same folder again
    // is the whole upgrade path (menu → pick → done)
    defaultUri: last && fs.existsSync(last) ? vscode.Uri.file(path.dirname(last)) : undefined,
  });
  if (!picked?.length) return;

  const dest = resolveMcpExportDest(picked[0].fsPath);
  // exporting INTO the installation is pointless and would copy the bundle
  // onto itself (copyFileSync refuses a file onto its own path)
  if (isInsideDir(dest.dir, extRoot)) {
    void vscode.window.showErrorMessage(t('mcpExportInsideExt'));
    return;
  }
  if (dest.mode === 'foreign') {
    const yes = await vscode.window.showWarningMessage(t('mcpExportForeign', dest.dir), { modal: true }, t('overwrite'));
    if (yes !== t('overwrite')) return;
  }
  // the marker carries the version of the export it belongs to (0.3.7,
  // user request): the message can name the old→new step, and a DOWNGRADE —
  // the copy is NEWER than this extension, which means the extension was
  // rolled back — is the one overwrite that asks first
  const prev = dest.mode === 'update' ? dest.version : undefined;
  if (prev && compareVersions(prev, plan.version) > 0) {
    const yes = await vscode.window.showWarningMessage(t('mcpExportDowngrade', dest.dir, prev, plan.version), { modal: true }, t('overwrite'));
    if (yes !== t('overwrite')) return;
  }

  let result;
  try {
    result = applyMcpExport(plan, dest.dir);
  } catch (e) {
    void vscode.window.showErrorMessage(t('mcpExportFailed', e instanceof Error ? e.message : String(e)));
    return;
  }
  void context.globalState.update(LAST_DEST, dest.dir);

  const serverPath = path.join(dest.dir, MCP_SERVER_FILE);
  const text =
    result.written === 0
      ? t('mcpExportSame', serverPath, plan.version)
      : prev && prev !== plan.version
        ? t('mcpExportUpgrade', serverPath, prev, plan.version, result.written)
        : dest.mode === 'update'
          ? t('mcpExportUpdated', serverPath, plan.version, result.written)
          : t('mcpExported', serverPath);
  const action = await vscode.window.showInformationMessage(text, t('mcpExportCopyConfig'), t('cmakeOpenFolder'));
  if (action === t('mcpExportCopyConfig')) {
    await vscode.env.clipboard.writeText(mcpClientConfig(serverPath));
    vscode.window.setStatusBarMessage(t('mcpExportConfigCopied'), 6000);
  } else if (action === t('cmakeOpenFolder')) {
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(serverPath));
  }
}
