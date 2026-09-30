/**
 * New MounRiver Project / New Static Library wizards — MRS2
 * createProject / createStaticLib minimum equivalents. Template
 * discovery + generation live in core/newProject; this module is the
 * QuickPick flow: series → RTOS → chip template → name → location, then
 * the created project is loaded into the tree.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectStore, getInstall, msg } from './projects';
import { scanTemplates, createProjectFromTemplate, normalizeParentDirInput, TemplateChip, SdkTemplates } from '../core/newProject';
import { t } from '../core/i18n';

async function pickTemplate(db: SdkTemplates): Promise<TemplateChip | undefined> {
  const seriesNames = [...db.series.keys()].sort((a, b) => a.localeCompare(b));
  const seriesPick = await vscode.window.showQuickPick(seriesNames, { placeHolder: t('wizardSeries') });
  if (!seriesPick) return undefined;
  const osNames = [...db.series.get(seriesPick)!.keys()].sort((a, b) => a.localeCompare(b));
  const osPick = await vscode.window.showQuickPick(osNames, { placeHolder: t('wizardRtos') });
  if (!osPick) return undefined;
  const chips = db.series.get(seriesPick)!.get(osPick) ?? [];
  const chipPick = await vscode.window.showQuickPick(
    chips.map((c) => ({ label: c.chip, description: c.os, template: c })),
    { placeHolder: t('wizardChip') }
  );
  return chipPick?.template;
}

/**
 * Location step, MRS2-style: its wizard field accepts ANY folder path
 * (createRealProject mkdirs it recursively), so typing must be possible —
 * a plain folder dialog can only pick existing directories. This is the
 * "Open Folder" interaction: an editable QuickPick pre-filled with the last
 * creation folder, plus a Browse item that opens the system dialog.
 */
async function pickLocation(defaultDir?: string): Promise<string | undefined> {
  const qp = vscode.window.createQuickPick();
  qp.title = t('wizardLocationTitle');
  qp.placeholder = t('wizardLocationPlaceholder');
  qp.value = defaultDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  qp.ignoreFocusOut = true;
  // the browse action must be a BUTTON, not a list item: QuickPick filters
  // items against the typed path, so a pre-filled value would hide it
  const browseButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('folder-opened'),
    tooltip: t('wizardBrowse'),
  };
  qp.buttons = [browseButton];
  const browseWithDialog = (seed: string): void => {
    void vscode.window.showOpenDialog({
      title: t('wizardLocationTitle'),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: seed && /^[A-Za-z]:[\\/]/.test(seed) ? vscode.Uri.file(seed) : undefined,
      openLabel: t('wizardCreateHere'),
    }).then((picks) => {
      if (picks?.length) {
        qp.value = picks[0].fsPath; // feed the choice back into the editor
      }
    });
  };
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const done = (v: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    qp.onDidTriggerButton((b) => {
      if (b === browseButton) browseWithDialog(qp.value.trim());
    });
    qp.onDidAccept(() => {
      done(normalizeParentDirInput(qp.value) || undefined);
      qp.hide();
    });
    qp.onDidHide(() => {
      done(undefined);
      qp.dispose(); // hide() only hides — the QuickInput is a Disposable
    });
    qp.show();
  });
}

async function runWizard(store: ProjectStore, artifactType: 'exe' | 'lib'): Promise<void> {
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(t('installNotFound'));
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('newProjectScanning'), cancellable: false },
    () => Promise.resolve(scanTemplates(install.resourcesWin32))
  ).then((db) => pickTemplate(db))
    .then(async (template) => {
      if (!template) return;
      const name = await vscode.window.showInputBox({
        prompt: t('newProjectNamePrompt', template.chip),
        validateInput: (v) => (v && !/[\\/:*?"<>|]/.test(v.trim()) ? undefined : t('invalidProjectName')),
      });
      if (!name) return;
      const parentDir = await pickLocation(store.getLastCreateDir());
      if (!parentDir) return;
      try {
        const result = createProjectFromTemplate(template, { projectName: name.trim(), parentDir, artifactType });
        store.setLastCreateDir(parentDir);
        store.add(result.projectRoot);
        store.setActive(store.get(result.projectRoot)!);
        // the created project lives outside this workspace — offer the same
        // "new window" opening the Open MRS Project command uses
        const openPick = await vscode.window.showInformationMessage(
          t('newProjectCreated', result.finalName, result.projectRoot, template.chip, template.series, template.os),
          t('openInNewWindow')
        );
        if (openPick === t('openInNewWindow')) {
          void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(result.projectRoot), {
            forceNewWindow: true,
          });
        }
      } catch (e) {
        vscode.window.showErrorMessage(`MRVC: ${msg(e)}`);
      }
    });
}

export function createProjectCmd(store: ProjectStore): Promise<void> {
  return runWizard(store, 'exe');
}

export function createStaticLibCmd(store: ProjectStore): Promise<void> {
  return runWizard(store, 'lib');
}

/** re-export for tests */
export { path };
