/**
 * File management operations for the project tree context menu:
 * new file/folder, copy/paste (internal clipboard), copy path/name,
 * rename, delete, reveal in OS file explorer.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TreeNode } from './tree';
import { ProjectStore, msg } from './projects';

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
  vscode.window.showInformationMessage(`MRVC: copied "${path.basename(node.fsPath)}" (use Paste on a folder)`);
}

export async function pasteNode(store: ProjectStore, node?: TreeNode): Promise<void> {
  if (!clip) {
    vscode.window.showInformationMessage('MRVC: clipboard is empty — use "Copy" on a file or folder first.');
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
    vscode.window.showErrorMessage('MRVC: cannot paste a folder into itself.');
    return;
  }
  const dest = uniqueDest(dir, path.basename(src));
  try {
    fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: true });
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: paste failed — ${msg(e)}`);
    return;
  }
  refresh();
  vscode.window.showInformationMessage(`MRVC: pasted ${path.basename(dest)}`);
}

export async function newFile(node: TreeNode): Promise<void> {
  const dir = targetDir(node);
  if (!dir) return;
  const name = await vscode.window.showInputBox({
    prompt: `New file in ${path.basename(dir)}`,
    placeHolder: 'file name (e.g. main.c)',
    validateInput: (v) => (!v || /[\\/:*?"<>|]/.test(v) ? 'Invalid file name' : undefined),
  });
  if (!name) return;
  const dest = path.join(dir, name);
  try {
    if (fs.existsSync(dest)) {
      vscode.window.showWarningMessage(`MRVC: "${name}" already exists.`);
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
    prompt: `New folder in ${path.basename(dir)}`,
    placeHolder: 'folder name',
    validateInput: (v) => (!v || /[\\/:*?"<>|]/.test(v) ? 'Invalid folder name' : undefined),
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
        vscode.window.showErrorMessage(
          `MRVC: "${path.basename(fsPath)}" is outside the project and not under any linked folder — no project-relative path exists.`
        );
        return;
      }
      logic = toPosix(path.join(link.name, path.relative(link.location, fsPath)));
    }
  } else {
    vscode.window.showErrorMessage('MRVC: node is not attached to a project.');
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
    prompt: 'Rename',
    value: oldName,
    validateInput: (v) => (!v || /[\\/:*?"<>|]/.test(v) ? 'Invalid name' : v === oldName ? undefined : fs.existsSync(path.join(path.dirname(node.fsPath!), v)) ? 'Name already exists' : undefined),
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
  const confirm = await vscode.window.showWarningMessage(
    `Delete "${name}"${isDir ? ' and all its contents' : ''} permanently?`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;
  try {
    fs.rmSync(node.fsPath, { recursive: true, force: true });
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${msg(e)}`);
    return;
  }
  refresh();
  vscode.window.showInformationMessage(`MRVC: deleted ${name}`);
}
