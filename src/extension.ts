/**
 * MRVC for WCH — extension entry point.
 */
import * as vscode from 'vscode';
import { ProjectStore, MrsProject } from './vscode/projects';
import { ProjectTreeProvider, TreeDecorations } from './vscode/tree';
import { BuildManager } from './vscode/tasks';
import { flashProject, openLinkUtility, openMrsTerminal } from './vscode/flash';
import { ConfigView } from './vscode/configView';
import { addLinkedFolderCmd, removeLinkedFolderCmd, revealProducts } from './vscode/linkedFolders';
import {
  copyNode,
  pasteNode,
  newFile,
  newFolder,
  copyAbsolutePath,
  copyProjectRelativePath,
  copyFileName,
  revealInExplorer,
  renameNode,
  deleteNode,
} from './vscode/fileOps';

export function activate(context: vscode.ExtensionContext): void {
  const store = new ProjectStore(context);
  context.subscriptions.push(store);
  store.restoreState();

  const tree = new ProjectTreeProvider(store);
  const treeView = vscode.window.createTreeView('mrs2.projectExplorer', { treeDataProvider: tree, dragAndDropController: undefined });
  context.subscriptions.push(treeView);

  // tree decorations: linked folders blue, output directories red
  const treeDecorations = new TreeDecorations();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(treeDecorations));
  const updateTreeDecorations = () => {
    treeDecorations.setLinks(
      store.all.flatMap((p) => p.projectFile.linkedResources.filter((l) => l.type === 2).map((l) => l.location))
    );
    treeDecorations.setOutputs(store.all.map((p) => p.buildDir));
  };
  store.onDidChange(updateTreeDecorations);
  updateTreeDecorations();

  const build = new BuildManager(store);
  const configView = new ConfigView(store, context);

  // ---- status bar ----
  const statusBuild = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBuild.name = 'MRVC Build';
  statusBuild.command = 'mrs2.build';
  context.subscriptions.push(statusBuild);

  const statusTarget = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  statusTarget.name = 'MRVC Target';
  statusTarget.command = 'mrs2.configure';
  context.subscriptions.push(statusTarget);

  const refreshStatus = () => {
    const p = store.active;
    if (p) {
      statusBuild.text = `$(debug-start) ${p.projectName}`;
      statusBuild.tooltip = `Build ${p.projectName} (F7)`;
      statusBuild.show();
      const tcName = p.cproject.rvGccVersion ? `GCC${p.cproject.rvGccVersion}` : p.cproject.storedPrefix.replace(/-$/, '');
      statusTarget.text = `$(chip) ${p.projectName} · ${tcName} · ${p.cproject.configName}`;
      statusTarget.tooltip = `${p.root}\nClick to open project properties`;
      statusTarget.show();
    } else {
      statusBuild.hide();
      statusTarget.hide();
    }
    vscode.commands.executeCommand('setContext', 'mrs2.hasActiveProject', !!p);
    vscode.commands.executeCommand('setContext', 'mrs2.hasProjects', store.all.length > 0);
  };
  store.onDidChange(refreshStatus);
  refreshStatus();

  // ---- commands ----
  const reg = (id: string, fn: (...a: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn as (...a: unknown[]) => unknown));

  reg('mrs2.openProject', async () => {
    const proj = await store.openProject();
    if (proj) {
      store.setActive(proj);
      vscode.window.showInformationMessage(`MRVC: opened ${proj.projectName} (${proj.root})`);
    }
  });
  reg('mrs2.setActiveProject', async (item?: { project?: unknown }) => {
    const proj = (item as { project?: MrsProject })?.project ?? (await pickFrom(store));
    if (proj) store.setActive(proj);
  });
  reg('mrs2.build', (item?: { project?: unknown }) => build.run('build', (item as { project?: MrsProject })?.project));
  reg('mrs2.buildAll', () => build.buildAll());
  reg('mrs2.cleanAll', () => build.cleanAll());
  // collapse every project/folder row via the tree view's built-in command
  reg('mrs2.collapseAll', () =>
    vscode.commands.executeCommand('workbench.actions.treeView.mrs2.projectExplorer.collapseAll')
  );
  reg('mrs2.rebuild', (item?: { project?: unknown }) => build.run('rebuild', (item as { project?: MrsProject })?.project));
  reg('mrs2.clean', (item?: { project?: unknown }) => build.run('clean', (item as { project?: MrsProject })?.project));
  reg('mrs2.flash', (item?: { project?: unknown }) => flashProject(store, (item as { project?: MrsProject })?.project));
  reg('mrs2.flashUtility', () => openLinkUtility());
  reg('mrs2.configure', (item?: { project?: unknown }) => configView.show((item as { project?: MrsProject })?.project));
  reg('mrs2.addLinkedFolder', (item?: { project?: unknown }) => addLinkedFolderCmd(store, (item as { project?: MrsProject })?.project));
  reg('mrs2.removeLinkedFolder', (item?: unknown) => removeLinkedFolderCmd(store, item as { linkedName?: string; project?: MrsProject } | undefined));
  reg('mrs2.openMrsTerminal', () => openMrsTerminal(store));
  reg('mrs2.revealProducts', () => revealProducts(store));
  reg('mrs2.refreshTree', () => tree.refresh());

  // file management (tree context menu)
  reg('mrs2.file.copy', (item?: unknown) => copyNode(item as never));
  reg('mrs2.file.paste', (item?: unknown) => pasteNode(store, item as never));
  reg('mrs2.file.newFile', (item?: unknown) => newFile(item as never));
  reg('mrs2.file.newFolder', (item?: unknown) => newFolder(item as never));
  reg('mrs2.file.copyPath', (item?: unknown) => copyAbsolutePath(item as never));
  reg('mrs2.file.copyRelPath', (item?: unknown) => copyProjectRelativePath(item as never));
  reg('mrs2.file.copyName', (item?: unknown) => copyFileName(item as never));
  reg('mrs2.file.reveal', (item?: unknown) => revealInExplorer(item as never));
  reg('mrs2.file.rename', (item?: unknown) => renameNode(item as never));
  reg('mrs2.file.delete', (item?: unknown) => deleteNode(item as never));

  // discover projects already inside the workspace (debounced once at start)
  setTimeout(() => {
    void store.discoverInWorkspace();
  }, 800);

  // build dir watcher: refresh products after a build finishes
  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.definition.type === 'mrvc-build' || e.execution.task.definition.type === 'mrvc-flash') {
        tree.refresh();
      }
    })
  );

  async function pickFrom(s: ProjectStore): Promise<MrsProject | undefined> {
    const all = s.all;
    if (!all.length) return undefined;
    const pick = await vscode.window.showQuickPick(
      all.map((p) => ({ label: p.projectName, description: p.root, project: p })),
      { placeHolder: 'Select project' }
    );
    return pick?.project;
  }
}

export function deactivate(): void {
  // nothing to do
}
