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
import { scanTemplates, createProjectFromTemplate, TemplateChip, SdkTemplates } from '../core/newProject';

async function pickTemplate(db: SdkTemplates): Promise<TemplateChip | undefined> {
  const seriesNames = [...db.series.keys()].sort((a, b) => a.localeCompare(b));
  const seriesPick = await vscode.window.showQuickPick(seriesNames, { placeHolder: 'New MounRiver Project — chip series (1/3)' });
  if (!seriesPick) return undefined;
  const osNames = [...db.series.get(seriesPick)!.keys()].sort((a, b) => a.localeCompare(b));
  const osPick = await vscode.window.showQuickPick(osNames, { placeHolder: 'New MounRiver Project — RTOS (2/3)' });
  if (!osPick) return undefined;
  const chips = db.series.get(seriesPick)!.get(osPick) ?? [];
  const chipPick = await vscode.window.showQuickPick(
    chips.map((c) => ({ label: c.chip, description: c.os, template: c })),
    { placeHolder: 'New MounRiver Project — device template (3/3)' }
  );
  return chipPick?.template;
}

async function pickLocation(): Promise<string | undefined> {
  const picks = await vscode.window.showOpenDialog({
    title: 'Parent folder for the new project',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Create here',
  });
  return picks?.length ? picks[0].fsPath : undefined;
}

async function runWizard(store: ProjectStore, artifactType: 'exe' | 'lib'): Promise<void> {
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(
      'MRS2 (MounRiver Studio 2) installation not found — set "mrvc.mrs2InstallPath" to your MRS2 install folder.'
    );
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'MRVC: scanning project templates…', cancellable: false },
    () => Promise.resolve(scanTemplates(install.resourcesWin32))
  ).then((db) => pickTemplate(db))
    .then(async (template) => {
      if (!template) return;
      const name = await vscode.window.showInputBox({
        prompt: `Project name (folder created inside the chosen location) — template: ${template.chip}`,
        validateInput: (v) => (v && !/[\\/:*?"<>|]/.test(v.trim()) ? undefined : 'Invalid project name'),
      });
      if (!name) return;
      const parentDir = await pickLocation();
      if (!parentDir) return;
      try {
        const result = createProjectFromTemplate(template, { projectName: name.trim(), parentDir, artifactType });
        store.add(result.projectRoot);
        store.setActive(store.get(result.projectRoot)!);
        await vscode.window.showInformationMessage(
          `MRVC: project "${result.finalName}" created from ${template.chip} (${template.series} / ${template.os}).`
        );
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
