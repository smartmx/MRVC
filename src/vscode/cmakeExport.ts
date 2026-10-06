/**
 * CMake export commands (MRS2 exportAsCMake / generateCMakeList):
 *  - Generate CMakeLists File: write CMakeLists.txt into the project root
 *    and open it (MRS2 opens the file after generating too).
 *  - Export As CMake Project: assemble a portable copy in a user-chosen
 *    folder — CMakeLists.txt + every project file except build outputs and
 *    MRS metadata, linked-folder targets copied in under their link names —
 *    so the folder builds with cmake alone on any machine.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectStore, MrsProject, getInstall, msg } from './projects';
import { buildCMakeContent } from '../core/cmake';
import { t } from '../core/i18n';

async function pickProject(store: ProjectStore, item?: unknown): Promise<MrsProject | undefined> {
  const proj = (item as { project?: MrsProject } | undefined)?.project;
  if (proj) return proj;
  if (store.active) return store.active;
  if (!store.all.length) return undefined;
  const pick = await vscode.window.showQuickPick(
    store.all.map((p) => ({ label: p.projectName, description: p.root, project: p })),
    { placeHolder: t('pickProject') }
  );
  return pick?.project;
}

export async function generateCMakeListCmd(store: ProjectStore, item?: unknown): Promise<void> {
  const project = await pickProject(store, item);
  if (!project) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  const install = getInstall();
  const tc = project.toolchain(install, 'auto');
  if (!tc) {
    vscode.window.showErrorMessage(t('cmakeNoToolchain'));
    return;
  }
  const file = path.join(project.root, 'CMakeLists.txt');
  try {
    project.reload();
    const built = buildCMakeContent(project.cproject, tc, file, { forExport: false });
    void store; // store unused today; kept for symmetry with other commands
    await vscode.window.showTextDocument(vscode.Uri.file(built.file), { preview: true });
    vscode.window.showInformationMessage(t('cmakeGenerated', built.sourceCount, built.includeCount));
  } catch (e) {
    vscode.window.showErrorMessage(t('cmakeGenFailed', msg(e)));
  }
}

/** entries never copied into an export: build outputs, VCS, MRS metadata */
const EXPORT_SKIP = new Set(['obj', 'build', '.git', '.svn', '.mrs', '.vscode', '.settings']);

function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (EXPORT_SKIP.has(entry.name)) continue;
      copyTree(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

export async function exportAsCMakeCmd(store: ProjectStore, item?: unknown): Promise<void> {
  const project = await pickProject(store, item);
  if (!project) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  const install = getInstall();
  const tc = project.toolchain(install, 'auto');
  if (!tc) {
    vscode.window.showErrorMessage(t('cmakeNoToolchain'));
    return;
  }
  const out = await vscode.window.showOpenDialog({
    title: t('cmakeExportTitle', project.projectName),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: t('cmakeExportHere'),
  });
  if (!out?.length) return;

  project.reload();
  const dirName = `${project.projectName}_cmake`;
  const dst = path.join(out[0].fsPath, dirName);
  if (fs.existsSync(dst)) {
    const overwrite = await vscode.window.showWarningMessage(t('cmakeExists', dirName), { modal: true }, t('overwrite'));
    if (overwrite !== t('overwrite')) return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('cmakeProgress', project.projectName), cancellable: false },
    async () => {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(dst, { recursive: true });
      // 1. project files (skip outputs/metadata), 2. portable CMakeLists,
      //    3. linked folder targets copied under their link names so
      //    relative includes still resolve. Order matters: a project that
      //    ever ran "Generate CMakeLists File" carries an in-place
      //    CMakeLists.txt full of this machine's absolute paths —copying
      //    first and generating after keeps the portable version from being
      //    overwritten by it.
      copyTree(project.root, dst);
      buildCMakeContent(project.cproject, tc, path.join(dst, 'CMakeLists.txt'), { forExport: true });
      for (const [name, target] of project.cproject.linkedFolders) {
        if (fs.existsSync(target)) copyTree(target, path.join(dst, name));
      }
    }
  );
  store.setActive(project);
  const open = await vscode.window.showInformationMessage(t('cmakeExported', dst), t('cmakeOpenFolder'));
  if (open === t('cmakeOpenFolder')) void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(dst));
}
