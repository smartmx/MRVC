/**
 * File management operations for the project tree context menu:
 * new file/folder, copy/paste (internal clipboard), copy path/name,
 * rename, delete, reveal in OS file explorer.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TreeNode } from './tree';
import { ProjectStore, MrsProject, msg } from './projects';
import { appendRemovedResource, clearRemovedResource, listRemovedResources } from '../core/projectFile';
import { t } from '../core/i18n';

interface Clip {
  path: string;
}
let clip: Clip | null = null;

/** Directory a paste/new-file operation should target for this node. */
export function targetDir(node: TreeNode): string | undefined {
  if (!node.fsPath) return undefined;
  switch (node.nodeType) {
    case 'folder':
    case 'linkedFolder':
    case 'products':
    case 'project':
      return node.fsPath;
    case 'file':
      return path.dirname(node.fsPath);
    default:
      return undefined;
  }
}

function refresh(): void {
  void vscode.commands.executeCommand('mrs2.refreshTree');
}

/** First non-existing "name - copy (n)" variant inside dir. */
function uniqueDest(dir: string, name: string): string {
  const dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 100; i++) {
    const candidate = path.join(dir, `${base} - copy${i > 1 ? ` (${i})` : ''}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${dest} - copy`;
}

export async function copyNode(node: TreeNode): Promise<void> {
  if (!node.fsPath) return;
  clip = { path: node.fsPath };
  vscode.window.showInformationMessage(t('copied', path.basename(node.fsPath)));
}

export async function pasteNode(store: ProjectStore, node?: TreeNode): Promise<void> {
  if (!clip) {
    vscode.window.showInformationMessage(t('clipboardEmpty'));
    return;
  }
  const dir = (node && targetDir(node)) ?? store.active?.root;
  if (!dir) return;
  const src = clip.path;
  if (src === dir) return;
  // folded compare (Windows): mixed-case drive letters between Uri.fsPath
  // and readdir results must not bypass the self-paste guard
  const samePath = (a: string, b: string): boolean => ProjectStore.key(a) === ProjectStore.key(b);
  const keyStartsWith = (a: string, b: string): boolean => ProjectStore.key(a).startsWith(ProjectStore.key(b) + path.sep);
  if (samePath(src, dir) || keyStartsWith(dir, src)) {
    vscode.window.showErrorMessage(t('pasteIntoSelf'));
    return;
  }
  const dest = uniqueDest(dir, path.basename(src));
  try {
    fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: true });
  } catch (e) {
    vscode.window.showErrorMessage(t('pasteFailed', msg(e)));
    return;
  }
  refresh();
  vscode.window.showInformationMessage(t('pasted', path.basename(dest)));
}

export async function newFile(node: TreeNode): Promise<void> {
  const dir = targetDir(node);
  if (!dir) return;
  const name = await vscode.window.showInputBox({
    prompt: t('newFileIn', path.basename(dir)),
    placeHolder: t('fileNameHint'),
    validateInput: (v) => (!v || /[\\/:*?"<>|]/.test(v) ? t('invalidNameKey') : undefined),
  });
  if (!name) return;
  const dest = path.join(dir, name);
  try {
    if (fs.existsSync(dest)) {
      vscode.window.showWarningMessage(t('nameExists', name));
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, '', 'utf-8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(dest));
    await vscode.window.showTextDocument(doc);
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${msg(e)}`);
  }
  refresh();
}

export async function newFolder(node: TreeNode): Promise<void> {
  const dir = targetDir(node);
  if (!dir) return;
  const name = await vscode.window.showInputBox({
    prompt: t('newFolderIn', path.basename(dir)),
    placeHolder: t('folderName'),
    validateInput: (v) => (!v || /[\\/:*?"<>|]/.test(v) ? t('invalidNameKey') : undefined),
  });
  if (!name) return;
  try {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${msg(e)}`);
    return;
  }
  refresh();
}

export async function copyAbsolutePath(node: TreeNode): Promise<void> {
  if (!node.fsPath) return;
  await vscode.env.clipboard.writeText(node.fsPath);
  vscode.window.setStatusBarMessage(`MRVC: path copied`, 3000);
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/**
 * Copy the CDT "logic path" used in .cproject lists:
 *   project file/folder  -> ${workspace_loc:/${ProjName}/src/Main.c}
 *   linked folder child  -> ${workspace_loc:/${ProjName}/Ld/Link.ld}
 * Paste-ready for include paths, linker scripts, libraries, other objects.
 */
export async function copyProjectRelativePath(node: TreeNode): Promise<void> {
  const fsPath = node.fsPath;
  if (!fsPath) return;
  const proj = node.project;
  let logic: string;
  if (proj) {
    const rel = path.relative(proj.root, fsPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      logic = toPosix(rel);
    } else {
      // outside the project root: must live under a linked folder
      const link = proj.projectFile.linkedResources.find(
        (l) => l.type === 2 && (fsPath === l.location || fsPath.startsWith(l.location + path.sep))
      );
      if (!link) {
        vscode.window.showErrorMessage(t('relPathNoProject', path.basename(fsPath)));
        return;
      }
      logic = toPosix(path.join(link.name, path.relative(link.location, fsPath)));
    }
  } else {
    vscode.window.showErrorMessage(t('nodeNotInProject'));
    return;
  }
  const text = `\${workspace_loc:/\${ProjName}/${logic}}`;
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(`MRVC: ${text}`, 5000);
}

export async function copyFileName(node: TreeNode): Promise<void> {
  if (!node.fsPath) return;
  await vscode.env.clipboard.writeText(path.basename(node.fsPath));
  vscode.window.setStatusBarMessage(`MRVC: file name copied`, 3000);
}

export async function revealInExplorer(node: TreeNode): Promise<void> {
  if (!node.fsPath) return;
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.fsPath));
}

export async function renameNode(node: TreeNode): Promise<void> {
  if (!node.fsPath) return;
  const oldName = path.basename(node.fsPath);
  const newName = await vscode.window.showInputBox({
    prompt: t('renameKeyRestore', oldName),
    value: oldName,
    validateInput: (v) => (!v || /[\\/:*?"<>|]/.test(v) ? t('invalidNameKey') : v === oldName ? undefined : fs.existsSync(path.join(path.dirname(node.fsPath!), v)) ? t('nameExists', v) : undefined),
  });
  if (!newName || newName === oldName) return;
  try {
    fs.renameSync(node.fsPath, path.join(path.dirname(node.fsPath), newName));
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${msg(e)}`);
    return;
  }
  refresh();
}

export async function deleteNode(node: TreeNode): Promise<void> {
  if (!node.fsPath) return;
  const name = path.basename(node.fsPath);
  const isDir = fs.existsSync(node.fsPath) && fs.statSync(node.fsPath).isDirectory();
  // linked-folder targets live OUTSIDE the project folder: Delete removes
  // the real external files, so the dialog says so explicitly
  const project = (node as unknown as { project?: { root?: string } }).project;
  // folded compare (ProjectStore.key): a .project link target may spell the
  // drive or path segments with different case than the workspace — a raw
  // startsWith misreports this hint line in both directions
  const outside =
    !!project?.root &&
    !ProjectStore.key(path.resolve(node.fsPath)).startsWith(ProjectStore.key(path.resolve(project.root)) + path.sep);
  // MRS2 Remove command semantics: [Remove] hides the resource from the
  // tree and the build (filteredResources, restorable via Restore Removed
  // Resources), [Delete] really removes the files — one dialog, two buttons.
  const confirm = await vscode.window.showWarningMessage(
    t('removeOrDeletePrompt', name),
    {
      modal: true,
      detail:
        (isDir ? t('removeOrDeleteDirDetail') : t('removeOrDeleteFileDetail')) +
        (outside ? '\n' + t('removeOrDeleteOutsideHint') : ''),
    },
    t('remove'),
    t('delete')
  );
  if (confirm === t('remove')) {
    if (!project?.root) {
      vscode.window.showErrorMessage(t('noActiveProject'));
      return;
    }
    try {
      const withLogic = project as { logicPathOf?: (f: string) => string | undefined; root: string };
      const logic = withLogic.logicPathOf?.(node.fsPath);
      const parentLogicRaw = logic ? path.posix.dirname(toPosix(logic)) : '';
      appendRemovedResource(project.root, parentLogicRaw === '.' ? '' : parentLogicRaw, name, isDir);
      refresh();
      vscode.window.showInformationMessage(t('removedHidden', name));
    } catch (e) {
      vscode.window.showErrorMessage(`MRVC: ${msg(e)}`);
    }
    return;
  }
  if (confirm !== t('delete')) return;
  try {
    fs.rmSync(node.fsPath, { recursive: true, force: true });
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${msg(e)}`);
    return;
  }
  refresh();
  vscode.window.showInformationMessage(t('deletedMsg', name));
}

/**
 * Restore logically-removed resources (MRS2 has no dedicated entry — its
 * only restore path is re-adding a same-named file; MRVC adds this
 * explicit command writing the same filteredResources storage).
 */
export async function restoreRemovedCmd(store: ProjectStore, node?: unknown): Promise<void> {
  const proj: MrsProject | undefined =
    (node as unknown as { project?: MrsProject } | undefined)?.project ?? store.active ?? undefined;
  if (!proj) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  const removed = listRemovedResources(proj.root);
  if (!removed.length) {
    vscode.window.showInformationMessage(t('nothingRemoved', proj.projectName));
    return;
  }
  const pick = await vscode.window.showQuickPick(
    removed.map((r) => ({
      label: (r.parentLogic ? r.parentLogic + '/' : '') + r.name,
      description: r.isFolder ? 'folder' : 'file',
      resource: r,
    })),
    {
      placeHolder: t('restorePick', proj.projectName),
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!pick?.length) return;
  for (const p of pick) {
    clearRemovedResource(proj.root, p.resource.parentLogic, p.resource.name, p.resource.isFolder);
  }
  refresh();
  vscode.window.showInformationMessage(t('restoredCount', pick.length));
}
