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

export async function renameProjectCmd(store: ProjectStore, node?: TreeNode): Promise<void> {
  const proj = node?.project ?? store.active;
  if (!proj) {
    vscode.window.showErrorMessage('MRVC: no project to rename.');
    return;
  }
  const oldName = proj.projectName;
  const name = await vscode.window.showInputBox({
    prompt: `Rename project "${oldName}"`,
    value: oldName,
    placeHolder: 'new project name',
    validateInput: (v) => (!v || /[\\/:*?"<>|\s]/.test(v) ? 'Invalid project name (no spaces or \\ / : * ? " < > |)' : undefined),
  });
  if (!name || name === oldName) return;
  try {
    renameProject(proj.root, name);
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: rename failed — ${msg(e)}`);
    return;
  }
  store.reloadProject(proj);
  vscode.window.showInformationMessage(`MRVC: project "${oldName}" renamed to "${name}".`);
}

/**
 * Sync the project display name from the folder it lives in. A folder name
 * containing spaces is refused with advice to rename the folder first — a
 * space would end up in the project name and break make targets.
 */
export async function syncProjectNameFromFolder(store: ProjectStore, node?: TreeNode): Promise<void> {
  const proj = node?.project ?? store.active;
  if (!proj) {
    vscode.window.showErrorMessage('MRVC: no project to sync.');
    return;
  }
  const folderName = path.basename(proj.root);
  if (/\s/.test(folderName)) {
    vscode.window.showWarningMessage(
      `MRVC: the folder name "${folderName}" contains spaces. Rename the folder first (without spaces), then sync — a space in the project name would break make targets.`
    );
    return;
  }
  if (/[\\/:*?"<>|]/.test(folderName)) {
    vscode.window.showWarningMessage(`MRVC: the folder name "${folderName}" contains characters not allowed in a project name.`);
    return;
  }
  if (folderName === proj.projectName) {
    vscode.window.showInformationMessage(`MRVC: project name already matches the folder name ("${folderName}").`);
    return;
  }
  try {
    renameProject(proj.root, folderName);
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: sync failed — ${msg(e)}`);
    return;
  }
  store.reloadProject(proj);
  vscode.window.showInformationMessage(`MRVC: project name synced to folder name ("${folderName}").`);
}
