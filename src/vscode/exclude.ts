/**
 * Exclude From Build / Include From Build — the MRS (Eclipse CDT) right-click
 * feature. Exclusions live in .cproject sourceEntries `excluding` lists and
 * are honoured by the scanner on every build (makefiles are regenerated).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode } from './tree';
import { ProjectStore, MrsProject, msg } from './projects';
import { Cproject } from '../core/cproject';
import { isLogicExcluded, exclusionFsPaths } from '../core/scan';
import { t as translate } from '../core/i18n';

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
    vscode.window.showErrorMessage(translate('excludeApplies'));
    return;
  }
  if (isLogicExcluded(t.proj.cproject, t.logic)) {
    vscode.window.showInformationMessage(translate('alreadyExcluded', t.label));
    return;
  }
  try {
    // fresh-load .cproject before the read-modify-write: the store's cached
    // model can be stale when the file changed since the last watcher event
    // (MRS2 had it open, an external editor saved it) — writing the cached
    // snapshot would clobber those edits. Same discipline as the property
    // page and the sync page.
    const cp = Cproject.load(t.proj.root);
    cp.excludeResource(t.logic);
    cp.save();
  } catch (e) {
    vscode.window.showErrorMessage(translate('excludeFailed', msg(e)));
    return;
  }
  store.reloadProject(t.proj);
}

export async function includeFromBuild(store: ProjectStore, node?: TreeNode): Promise<void> {
  const t = node && exclusionTarget(node);
  if (!t) {
    vscode.window.showErrorMessage(translate('includeApplies'));
    return;
  }
  if (!isLogicExcluded(t.proj.cproject, t.logic)) {
    vscode.window.showInformationMessage(translate('notExcluded', t.label));
    return;
  }
  try {
    // fresh-load for the same reason as excludeFromBuild (no lost updates)
    const cp = Cproject.load(t.proj.root);
    cp.includeResource(t.logic);
    cp.save();
  } catch (e) {
    vscode.window.showErrorMessage(translate('includeFailed', msg(e)));
    return;
  }
  store.reloadProject(t.proj);
}

/**
 * Map every exclusion token of the project back to a filesystem path so the
 * tree can decorate it. The mapping lives in core (exclusionFsPaths) so it
 * is node-testable; see there for the bare-token handling.
 */
export function excludedResourcePaths(proj: MrsProject): string[] {
  return exclusionFsPaths(proj.cproject, proj.root);
}
