/**
 * Exclude From Build / Include From Build — the MRS (Eclipse CDT) right-click
 * feature. Exclusions live in .cproject sourceEntries `excluding` lists and
 * are honoured by the scanner on every build (makefiles are regenerated).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode } from './tree';
import { ProjectStore, MrsProject, msg } from './projects';
import { isLogicExcluded, exclusionFsPaths } from '../core/scan';

interface Target {
  proj: MrsProject;
  logic: string;
  label: string;
}

function exclusionTarget(node: TreeNode): Target | undefined {
  if (!node.fsPath || !node.project) return undefined;
  if (node.nodeType !== 'file' && node.nodeType !== 'folder') return undefined;
  const logic = node.project.logicPathOf(node.fsPath);
  if (!logic) return undefined;
  return { proj: node.project, logic, label: path.basename(node.fsPath) };
}

export async function excludeFromBuild(store: ProjectStore, node?: TreeNode): Promise<void> {
  const t = node && exclusionTarget(node);
  if (!t) {
    vscode.window.showErrorMessage('MRVC: Exclude From Build applies to source files and folders in a project.');
    return;
  }
  if (isLogicExcluded(t.proj.cproject, t.logic)) {
    vscode.window.showInformationMessage(`MRVC: "${t.label}" is already excluded from build.`);
    return;
  }
  try {
    t.proj.cproject.excludeResource(t.logic);
    t.proj.cproject.save();
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: exclude failed — ${msg(e)}`);
    return;
  }
  store.reloadProject(t.proj);
  vscode.window.showInformationMessage(`MRVC: "${t.label}" excluded from build (${t.proj.projectName}). Rebuild to apply.`);
}

export async function includeFromBuild(store: ProjectStore, node?: TreeNode): Promise<void> {
  const t = node && exclusionTarget(node);
  if (!t) {
    vscode.window.showErrorMessage('MRVC: Include From Build applies to excluded files and folders.');
    return;
  }
  if (!isLogicExcluded(t.proj.cproject, t.logic)) {
    vscode.window.showInformationMessage(`MRVC: "${t.label}" is not excluded from build.`);
    return;
  }
  try {
    t.proj.cproject.includeResource(t.logic);
    t.proj.cproject.save();
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: include failed — ${msg(e)}`);
    return;
  }
  store.reloadProject(t.proj);
  vscode.window.showInformationMessage(`MRVC: "${t.label}" included in build (${t.proj.projectName}). Rebuild to apply.`);
}

/**
 * Map every exclusion token of the project back to a filesystem path so the
 * tree can decorate it. The mapping lives in core (exclusionFsPaths) so it
 * is node-testable; see there for the bare-token handling.
 */
export function excludedResourcePaths(proj: MrsProject): string[] {
  return exclusionFsPaths(proj.cproject, proj.root);
}
