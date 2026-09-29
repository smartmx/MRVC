/**
 * Rename Project — the MRS (Eclipse CDT) right-click feature: renames the
 * project's display name and its companion files, never the directory.
 * See core/projectFile.ts renameProject for the exact semantics.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode } from './tree';
import { ProjectStore, msg } from './projects';
import { renameProject } from '../core/projectFile';
import { t } from '../core/i18n';

export async function renameProjectCmd(store: ProjectStore, node?: TreeNode): Promise<void> {
  const proj = node?.project ?? store.active;
  if (!proj) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  const oldName = proj.projectName;
  const name = await vscode.window.showInputBox({
    prompt: t('renameProjectTitle', oldName),
    value: oldName,
    placeHolder: t('newProjectName'),
    validateInput: (v) => (!v || /[\\/:*?"<>|\s]/.test(v) ? t('invalidProjectName') : undefined),
  });
  if (!name || name === oldName) return;
  try {
    renameProject(proj.root, name);
  } catch (e) {
    vscode.window.showErrorMessage(t('renameFailed', msg(e)));
    return;
  }
  store.reloadProject(proj);
  vscode.window.showInformationMessage(t('projectRenamed', oldName, name));
}

/**
 * Sync the project display name from the folder it lives in. A folder name
 * containing spaces is refused with advice to rename the folder first — a
 * space would end up in the project name and break make targets.
 */
export async function syncProjectNameFromFolder(store: ProjectStore, node?: TreeNode): Promise<void> {
  const proj = node?.project ?? store.active;
  if (!proj) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  const folderName = path.basename(proj.root);
  if (/\s/.test(folderName)) {
    vscode.window.showWarningMessage(t('syncFolderSpaces'));
    return;
  }
  if (/[\\/:*?"<>|]/.test(folderName)) {
    vscode.window.showWarningMessage(t('folderNameInvalid', folderName));
    return;
  }
  if (folderName === proj.projectName) {
    vscode.window.showInformationMessage(t('syncAlreadySame', folderName));
    return;
  }
  try {
    renameProject(proj.root, folderName);
  } catch (e) {
    vscode.window.showErrorMessage(t('syncFailed', msg(e)));
    return;
  }
  store.reloadProject(proj);
  vscode.window.showInformationMessage(t('syncDone', folderName));
}
