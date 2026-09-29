/**
 * Solution lifecycle commands (MRS2 addProjectToSolution(ByBatch) /
 * setBuildOrder / closeSolution equivalents).
 *
 *  - Add MRS Project to Solution: pick a .wvproj/.project anywhere; the
 *    member line is APPENDED (existing file content byte-preserved).
 *  - Batch Import of Projects: pick a folder, all discovered projects under
 *    it are appended (duplicates skipped).
 *  - Identify Build Order: reorder members via QuickPick steps, then
 *    rewrite only the BuildOrder= line (all other lines byte-preserved).
 *  - Close Solution: close the window (MRS2 closeExplorer ->
 *    workbench.action.closeFolder).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectStore, MrsSolution, MrsProject, msg } from './projects';
import { appendSolutionMembers, recordBuildOrder } from '../core/solution';
import { findProjectRoots } from '../core/discover';
import { t } from '../core/i18n';

function solutionArg(item?: unknown): MrsSolution | undefined {
  return (item as { solution?: MrsSolution } | undefined)?.solution;
}

/** append one or more project roots to a solution file and reload it */
async function appendAndReload(store: ProjectStore, sol: MrsSolution, roots: string[]): Promise<void> {
  let added: string[];
  try {
    added = appendSolutionMembers(sol.file, roots);
  } catch (e) {
    vscode.window.showErrorMessage(t('addFailed', msg(e)));
    return;
  }
  if (!added.length) {
    vscode.window.showInformationMessage(t('alreadyMember'));
    return;
  }
  store.removeSolution(sol.file); // drop the stale loaded instance
  store.addSolution(sol.file);
  vscode.window.showInformationMessage(t('addedToSolution', added.length, path.basename(sol.file)));
}

/** pick one project file (.wvproj / .project) anywhere on disk */
async function pickProjectFile(): Promise<string | undefined> {
  const picks = await vscode.window.showOpenDialog({
    title: t('openProject'),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'MRS Project': ['wvproj', 'project'] },
  });
  if (!picks?.length) return undefined;
  const file = picks[0].fsPath;
  if (file.toLowerCase().endsWith('.wvproj')) return path.dirname(file);
  return path.dirname(file); // .project — same handling
}

export async function addProjectToSolutionCmd(store: ProjectStore, item?: unknown): Promise<void> {
  const sol = solutionArg(item) ?? store.solutionList[0];
  if (!sol) {
    vscode.window.showWarningMessage(t('needSolution'), { modal: true });
    return;
  }
  const root = await pickProjectFile();
  if (!root) return;
  await appendAndReload(store, sol, [root]);
}

export async function addProjectsByBatchCmd(store: ProjectStore, item?: unknown): Promise<void> {
  const sol = solutionArg(item) ?? store.solutionList[0];
  if (!sol) {
    vscode.window.showWarningMessage(t('needSolution'), { modal: true });
    return;
  }
  const picks = await vscode.window.showOpenDialog({
    title: t('openFolderTitle'),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!picks?.length) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('searchProjects'), cancellable: false },
    async () => {
      const roots = findProjectRoots(picks[0].fsPath);
      await appendAndReload(store, sol, roots);
    }
  );
}

/**
 * Build order editor: repeated QuickPick "move to end" passes — each pass
 * appends the chosen project to the result list; Cancel aborts, Escape on
 * the pass list finishes. Final order is recorded via recordBuildOrder
 * (MRS2 recordBuildOrderToSolution line-preserving semantics).
 */
export async function setBuildOrderCmd(store: ProjectStore, item?: unknown): Promise<void> {
  const sol = solutionArg(item) ?? store.solutionList[0];
  if (!sol) {
    vscode.window.showWarningMessage(t('needSolutionOrder'), { modal: true });
    return;
  }
  const members = sol.members;
  if (members.length < 2) {
    vscode.window.showInformationMessage(t('orderNeedTwo'));
    return;
  }

  const ordered: MrsProject[] = [];
  let remaining = members.slice();
  while (remaining.length > 1) {
    const pick = await vscode.window.showQuickPick(
      remaining.map((p) => ({
        label: p.projectName,
        description: path.relative(sol.dir, p.root),
        project: p,
      })),
      {
        placeHolder: t('orderPick', ordered.length + 1, remaining.length),
        ignoreFocusOut: true,
      }
    );
    if (!pick) break; // Escape: finish early with the current ordering
    ordered.push(pick.project);
    remaining = remaining.filter((p) => p !== pick.project);
  }
  const final = [...ordered, ...remaining]; // Escape-rest append keeps relative order
  if (final.length !== members.length) return;

  // unchanged order -> nothing to write
  const changed = final.some((p, i) => p !== members[i]);
  if (!changed) {
    vscode.window.showInformationMessage(t('orderUnchanged'));
    return;
  }
  try {
    recordBuildOrder(sol.file, final.map((p) => p.projectName));
  } catch (e) {
    vscode.window.showErrorMessage(t('orderRecordFailed', msg(e)));
    return;
  }
  store.removeSolution(sol.file);
  store.addSolution(sol.file);
  vscode.window.showInformationMessage(t('orderRecorded', final.map((p) => p.projectName).join(' → ')));
}

/** MRS2 closeSolution == closeExplorer == close the workspace folder */
export async function closeSolutionCmd(_store: ProjectStore, item?: unknown): Promise<void> {
  const sol = solutionArg(item);
  void sol; // any solution node closes the window, matching MRS2
  await vscode.commands.executeCommand('workbench.action.closeFolder');
}
