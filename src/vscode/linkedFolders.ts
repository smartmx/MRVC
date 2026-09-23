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
import { addLinkedFolder, removeLinkedFolder } from '../core/projectFile';
import { Cproject } from '../core/cproject';
import { XElement } from '../core/xml';

export async function addLinkedFolderCmd(store: ProjectStore, proj?: MrsProject): Promise<void> {
  const project = proj ?? store.active;
  if (!project) {
    vscode.window.showErrorMessage('No active MRS project.');
    return;
  }
  const picks = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Link folder',
    title: 'Add external linked folder',
  });
  if (!picks?.length) return;
  const target = picks[0].fsPath;
  if (path.normalize(target).toLowerCase() === path.normalize(project.root).toLowerCase()) {
    vscode.window.showErrorMessage('Cannot link the project folder itself.');
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Folder name as shown (and referenced) inside the project',
    value: path.basename(target),
    validateInput: (v) => (v && !/[\\/:*?"<>|]/.test(v) ? undefined : 'Invalid folder name'),
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
    vscode.window.showWarningMessage(
      `MRVC: linked folder added to .project, but .cproject update failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  project.reload();
  vscode.window.showInformationMessage(`MRVC: linked folder "${name}" added (${target})`);
}

export async function removeLinkedFolderCmd(store: ProjectStore, node?: { linkedName?: string; project?: MrsProject }): Promise<void> {
  let name = node?.linkedName;
  let project = node?.project ?? store.active;
  if (!name) {
    if (!project) {
      vscode.window.showErrorMessage('No active MRS project.');
      return;
    }
    const links = project.projectFile.linkedResources.filter((l) => l.type === 2);
    if (!links.length) {
      vscode.window.showInformationMessage('This project has no linked folders.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      links.map((l) => ({ label: l.name, description: l.location, name: l.name })),
      { placeHolder: 'Select linked folder to remove' }
    );
    if (!pick) return;
    name = pick.name;
  }
  if (!project) return;

  const confirm = await vscode.window.showWarningMessage(
    `Remove linked folder "${name}" from ${project.projectName}? (files on disk are not deleted)`,
    { modal: true },
    'Remove'
  );
  if (confirm !== 'Remove') return;

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

  project.reload();
  vscode.window.showInformationMessage(`MRVC: linked folder "${name}" removed`);
}

export function revealProducts(store: ProjectStore): void {
  const project = store.active;
  if (!project) return;
  if (fs.existsSync(project.buildDir)) {
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(project.buildDir, `${project.cproject.targetName}.elf`)));
  }
}
