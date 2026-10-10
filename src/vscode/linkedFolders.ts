/**
 * Add / remove external linked source folders (MRS "外部链接文件夹").
 * Updates .project (linkedResources) AND .cproject (include paths +
 * sourceEntries) so the folder participates in the build exactly like
 * folders linked by MRS.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectStore, MrsProject } from './projects';
import { addLinkedFolder, removeLinkedFolder, changeLinkedFolderTarget } from '../core/projectFile';
import { Cproject } from '../core/cproject';
import { t } from '../core/i18n';
import { XElement } from '../core/xml';

export async function addLinkedFolderCmd(store: ProjectStore, proj?: MrsProject): Promise<void> {
  const project = proj ?? store.active;
  if (!project) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  const picks = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: t('linkFolder'),
    title: t('addExternalLinked'),
  });
  if (!picks?.length) return;
  const target = picks[0].fsPath;
  if (path.normalize(target).toLowerCase() === path.normalize(project.root).toLowerCase()) {
    vscode.window.showErrorMessage(t('cannotLinkSelf'));
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: t('linkFolderName'),
    value: path.basename(target),
    validateInput: (v) => (v && !/[\\/:*?"<>|]/.test(v) ? undefined : t('invalidName')),
  });
  if (!name) return;

  try {
    addLinkedFolder(project.root, name, target);
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // integrate into the build: include paths + source entry
  try {
    const cp = Cproject.load(project.root);
    const logic = '${workspace_loc:/${ProjName}/' + name + '}';
    cp.addToListOption('c.compiler.include.paths', logic);
    cp.addToListOption('assembler.include.paths', logic);
    // sourceEntries: add entry for the new folder, exclude it from the root scan
    const entries = cp.sourceEntries;
    const rootEntry = entries.find((e) => e.name === '');
    if (rootEntry) {
      const excluding = new Set(rootEntry.excluding);
      excluding.add(name);
      rootEntry.element.setAttr('excluding', [...excluding].join('|'));
    }
    const sourceEntriesEl = cp.config.find((x) => x.name === 'sourceEntries');
    if (sourceEntriesEl && !entries.some((e) => e.name === name)) {
      const entry = new XElement('entry');
      entry.setAttr('flags', 'VALUE_WORKSPACE_PATH|RESOLVED');
      entry.setAttr('kind', 'sourcePath');
      entry.setAttr('name', name);
      sourceEntriesEl.append(entry);
    }
    cp.save();
  } catch (e) {
    vscode.window.showWarningMessage(t('linkedCpUpdateFailed', e instanceof Error ? e.message : String(e)));
  }

  store.reloadProject(project);
  vscode.window.showInformationMessage(t('linkedAdded', name, target));
}

/**
 * Re-point a linked folder to a new target (MRS2 changelinkedFolderPath):
 * the link NAME and all build references keyed by it stay untouched — only
 * the location changes, so the tree keeps showing the same folder name.
 */
export async function changeLinkedFolderPathCmd(store: ProjectStore, node?: { linkedName?: string; project?: MrsProject }): Promise<void> {
  let name = node?.linkedName;
  let project = node?.project ?? store.active;
  if (!name) {
    if (!project) {
      vscode.window.showErrorMessage(t('noActiveProject'));
      return;
    }
    const links = project.projectFile.linkedResources.filter((l) => l.type === 2);
    if (!links.length) {
      vscode.window.showInformationMessage(t('linkedNone'));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      links.map((l) => ({ label: l.name, description: l.location, name: l.name })),
      { placeHolder: t('linkedSelectChange') }
    );
    if (!pick) return;
    name = pick.name;
  }
  if (!project) return;
  const link = project.projectFile.linkedResources.find((l) => l.type === 2 && l.name === name);
  if (!link) {
    vscode.window.showErrorMessage(t('linkedNotFound', name, project.projectName));
    return;
  }

  const newTarget = await vscode.window.showInputBox({
    prompt: t('linkedPrompt', name),
    value: link.location,
    validateInput: (v) => (v && v.trim().length > 0 ? undefined : t('enterName')),
  });
  if (!newTarget || newTarget === link.location) return;

  try {
    changeLinkedFolderTarget(project.root, name, newTarget);
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  store.reloadProject(project);
  vscode.window.showInformationMessage(t('linkedChanged', name, newTarget));
}

export async function removeLinkedFolderCmd(store: ProjectStore, node?: { linkedName?: string; project?: MrsProject }): Promise<void> {
  let name = node?.linkedName;
  let project = node?.project ?? store.active;
  if (!name) {
    if (!project) {
      vscode.window.showErrorMessage(t('noActiveProject'));
      return;
    }
    const links = project.projectFile.linkedResources.filter((l) => l.type === 2);
    if (!links.length) {
      vscode.window.showInformationMessage(t('linkedNone'));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      links.map((l) => ({ label: l.name, description: l.location, name: l.name })),
      { placeHolder: t('linkedSelectRemove') }
    );
    if (!pick) return;
    name = pick.name;
  }
  if (!project) return;

  const confirm = await vscode.window.showWarningMessage(
    t('linkedRemoveConfirm', name, project.projectName),
    { modal: true },
    t('remove')
  );
  if (confirm !== t('remove')) return;

  try {
    removeLinkedFolder(project.root, name);
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // clean .cproject references
  try {
    const cp = Cproject.load(project.root);
    const logic = '${workspace_loc:/${ProjName}/' + name + '}';
    cp.removeFromListOption('c.compiler.include.paths', logic);
    cp.removeFromListOption('assembler.include.paths', logic);
    for (const se of cp.sourceEntries) {
      if (se.name === name) {
        se.element.parent?.removeChild(se.element);
      } else if (se.name === '') {
        const excluding = se.excluding.filter((x) => x !== name);
        se.element.setAttr('excluding', excluding.join('|'));
      }
    }
    cp.save();
  } catch {
    // .cproject may not reference the folder
  }

  store.reloadProject(project);
  vscode.window.showInformationMessage(t('linkedRemoved', name));
}

export function revealProducts(store: ProjectStore): void {
  const project = store.active;
  if (!project) return;
  if (!fs.existsSync(project.buildDir)) return; // never built
  const elf = path.join(project.buildDir, `${project.cproject.targetName}.elf`);
  // reveal the elf only when it exists — otherwise locate the build dir
  const target = fs.existsSync(elf) ? elf : project.buildDir;
  vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
}
