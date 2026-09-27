/**
 * MRVC for WCH — extension entry point.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectStore, MrsProject, MrsSolution, msg } from './vscode/projects';
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
import { excludeFromBuild, includeFromBuild, excludedResourcePaths } from './vscode/exclude';
import { renameProjectCmd, syncProjectNameFromFolder } from './vscode/renameProject';
import { writeSolution } from './core/solution';
import { setCppNature } from './core/projectFile';
import { SyncPage } from './vscode/syncPage';
import { comTransmitCmd, hexBinToolCmd, ispToolCmd, touchkeyToolCmd, uiDesignerCmd } from './vscode/mrsTools';
import { ensureIntellisenseConfig, resolveProjectForFile, switchContext } from './vscode/intellisense';

export function activate(context: vscode.ExtensionContext): void {
  const store = new ProjectStore(context);
  context.subscriptions.push(store);
  store.restoreState();

  const tree = new ProjectTreeProvider(store, context.extensionUri);
  const treeView = vscode.window.createTreeView('mrs2.projectExplorer', { treeDataProvider: tree, dragAndDropController: undefined });
  context.subscriptions.push(treeView);

  // IntelliSense context switch: selecting a (different) project in the tree
  // copies that project's compile_commands database over the active one —
  // cpptools re-parses with the project's own macros/includes (the MRS2
  // "one active project context" model). 500ms debounce; solution/group
  // nodes resolve to nothing and keep the current context.
  let ctxProject: string | undefined;
  let ctxTimer: NodeJS.Timeout | undefined;
  // opening a source file ALSO switches the context to its owning project
  // (MRS2's resolveEditorChanged model) — so the file's macros/includes are
  // always the ones of the project being worked on
  const switchToFile = (fsPath: string | undefined): void => {
    if (!fsPath || !vscode.workspace.workspaceFolders?.length) return;
    const owner = store.all.find((p) => {
      try {
        return !!p.logicPathOf(fsPath);
      } catch {
        return false;
      }
    });
    if (!owner) return;
    const key = owner.root.toLowerCase();
    if (key === ctxProject) return;
    if (switchContext(vscode.workspace.workspaceFolders[0].uri.fsPath, owner.root, owner.projectName)) {
      ctxProject = key;
    }
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((ed) => switchToFile(ed?.document.uri.fsPath)));
  treeView.onDidChangeSelection((e) => {
    if (ctxTimer) clearTimeout(ctxTimer);
    ctxTimer = setTimeout(() => {
      const sel = e.selection[0] as unknown as { project?: { root?: string; projectName?: string } } | undefined;
      const proj = sel?.project;
      if (!proj?.root || !proj.projectName) return;
      const key = proj.root.toLowerCase();
      if (key === ctxProject) return;
      if (switchContext(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', proj.root, proj.projectName)) {
        ctxProject = key;
      }
    }, 500);
  });

  // tree decorations: linked folders blue, output directories red
  const treeDecorations = new TreeDecorations();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(treeDecorations));
  const updateTreeDecorations = () => {
    treeDecorations.setLinks(
      store.all.flatMap((p) => p.projectFile.linkedResources.filter((l) => l.type === 2).map((l) => l.location))
    );
    treeDecorations.setOutputs(store.all.map((p) => p.buildDir));
    treeDecorations.setExcludedByProject(new Map(store.all.map((p) => [ProjectStore.key(p.root), excludedResourcePaths(p)] as const)));
  };
  store.onDidChange(updateTreeDecorations);
  updateTreeDecorations();

  const build = new BuildManager(store);
  const configView = new ConfigView(store, context);

  // ---- global UI context keys (menu/keybinding gating) ----
  // no status bar items: the tree stays the single MRVC surface
  const refreshContext = () => {
    vscode.commands.executeCommand('setContext', 'mrs2.hasActiveProject', !!store.active);
    vscode.commands.executeCommand('setContext', 'mrs2.hasProjects', store.all.length > 0);
  };
  store.onDidChange(refreshContext);
  refreshContext();

  // IntelliSense config: rebuild (hash-gated, so no-op when nothing
  // config-related changed) whenever the store settles — covers property
  // Apply, Exclude toggles, project add/remove, refresh
  let intellisenseTimer: NodeJS.Timeout | undefined;
  store.onDidChange(() => {
    if (intellisenseTimer) clearTimeout(intellisenseTimer);
    intellisenseTimer = setTimeout(() => ensureIntellisenseConfig(store), 1000);
  });

  // a solution workspace (generated when a .wvsln was opened) reloads its
  // solution on activation — the persisted "explicitly opened this solution"
  // state; plain folder windows never have this setting
  const slnSetting = vscode.workspace.getConfiguration('mrvc').get<string>('solution');
  if (slnSetting && fs.existsSync(slnSetting)) {
    store.addSolution(slnSetting);
  }

  // ---- commands ----
  const reg = (id: string, fn: (...a: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn as (...a: unknown[]) => unknown));

  reg('mrs2.openProject', () => store.openProject());
  reg('mrs2.openFolder', () => store.openFolder());
  reg('mrs2.build', (item?: { project?: unknown }) => build.run('build', (item as { project?: MrsProject })?.project));
  reg('mrs2.buildAll', () => build.buildAll());
  reg('mrs2.rebuildAll', () => build.rebuildAll());
  reg('mrs2.deleteOutputKeepImages', () => build.deleteOutputFiles());
  reg('mrs2.deleteOutputDirs', () => build.deleteOutputDirs());
  reg('mrs2.buildSolution', (item?: { solution?: unknown }) => {
    const sol = (item as { solution?: MrsSolution })?.solution;
    if (sol) void build.buildSolution(sol);
  });
  reg('mrs2.cleanSolution', (item?: { solution?: unknown }) => {
    const sol = (item as { solution?: MrsSolution })?.solution;
    if (sol) void build.cleanSolution(sol);
  });
  reg('mrs2.cleanAll', () => build.cleanAll());
  // collapse every project/folder row via the tree view's built-in command
  reg('mrs2.collapseAll', () =>
    vscode.commands.executeCommand('workbench.actions.treeView.mrs2.projectExplorer.collapseAll')
  );
  reg('mrs2.rebuild', (item?: { project?: unknown }) => build.run('rebuild', (item as { project?: MrsProject })?.project));
  reg('mrs2.clean', (item?: { project?: unknown }) => build.run('clean', (item as { project?: MrsProject })?.project));
  reg('mrs2.flashUtility', () => openLinkUtility());
  reg('mrs2.flash', (item?: { project?: unknown }) => flashProject(store, (item as { project?: MrsProject })?.project));
  reg('mrs2.configure', (item?: { project?: unknown }) => configView.show((item as { project?: MrsProject })?.project));
  reg('mrs2.addLinkedFolder', (item?: { project?: unknown }) => addLinkedFolderCmd(store, (item as { project?: MrsProject })?.project));
  reg('mrs2.removeLinkedFolder', (item?: unknown) => removeLinkedFolderCmd(store, item as { linkedName?: string; project?: MrsProject } | undefined));
  reg('mrs2.openMrsTerminal', () => openMrsTerminal(store));
  reg('mrs2.revealProducts', () => revealProducts(store));
  reg('mrs2.updateIntellisense', () => {
    const r = ensureIntellisenseConfig(store);
    if (r.error) {
      vscode.window.showErrorMessage(`MRVC: IntelliSense configuration failed — ${r.error}`);
    } else {
      vscode.window.showInformationMessage(
        `MRVC: IntelliSense configuration updated (${r.entries} files from ${r.projects} projects).`
      );
    }
  });
  reg('mrs2.refreshTree', async () => {
    // refresh = full re-scan of the workspace folders: projects renamed or
    // deleted outside MRVC are dropped, new/renamed ones are discovered
    await store.refreshWorkspace();
  });

  // generate a .wvsln grouping every discovered project (writes next to the
  // workspace root; members stay in BuildOrder-less file order)
  const syncPage = new SyncPage(store);
  reg('mrs2.syncSettings', () => syncPage.open());
  reg('mrs2.ispTool', () => ispToolCmd());
  reg('mrs2.touchkeyTool', () => touchkeyToolCmd());
  reg('mrs2.uiDesigner', () => uiDesignerCmd());
  reg('mrs2.hexBinTool', () => hexBinToolCmd());
  reg('mrs2.comTransmit', () => comTransmitCmd());
  reg('mrs2.generateSolution', async () => {    const all = store.all;
    if (!all.length) {
      vscode.window.showErrorMessage('No MRS project loaded. Use "MRVC: Open MRS Project" first.');
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('MRVC: open a workspace folder first — the solution is saved in it.');
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: `Save solution as (in ${folder.uri.fsPath})`,
      value: path.basename(folder.uri.fsPath),
      placeHolder: 'solution file name',
      validateInput: (v) => (!v || /[\\/:*?"<>|]/.test(v) ? 'Invalid file name' : undefined),
    });
    if (!name) return;
    const base = name.toLowerCase().endsWith('.wvsln') ? name : `${name}.wvsln`;
    const file = path.join(folder.uri.fsPath, base);
    if (fs.existsSync(file)) {
      const pick = await vscode.window.showWarningMessage(`"${base}" already exists. Overwrite?`, { modal: true }, 'Overwrite');
      if (pick !== 'Overwrite') return;
    }
    try {
      writeSolution(file, all.map((p) => p.root));
    } catch (e) {
      vscode.window.showErrorMessage(`MRVC: writing solution failed — ${msg(e)}`);
      return;
    }
    store.removeSolution(file); // overwrite: drop the stale loaded instance
    store.addSolution(file);
    vscode.window.showInformationMessage(`MRVC: solution "${base}" created with ${all.length} projects.`);
  });

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
  reg('mrs2.renameProject', (item?: unknown) => renameProjectCmd(store, item as never));
  reg('mrs2.syncProjectName', (item?: unknown) => syncProjectNameFromFolder(store, item as never));
  // C/C++ toggle = the CDT cxx nature in .project: it drives which property
  // pages show (C++ compiler/linker), which source extensions the scanner
  // picks and how makefiles treat .cpp — same key MRS2/CDT use
  reg('mrs2.switchProjectType', (item?: { project?: unknown }) => {
    const project = (item as { project?: MrsProject })?.project ?? store.active;
    if (!project) {
      vscode.window.showErrorMessage('No active MRS project.');
      return;
    }
    try {
      setCppNature(project.root, !project.cproject.isCpp);
    } catch (e) {
      vscode.window.showErrorMessage(`MRVC: switching project type failed — ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    store.reloadProject(project);
  });

  // exclude/include from build (CDT sourceEntries excluding)
  reg('mrs2.excludeFromBuild', (item?: unknown) => excludeFromBuild(store, item as never));
  reg('mrs2.includeFromBuild', (item?: unknown) => includeFromBuild(store, item as never));

  // discover projects already inside the workspace (debounced once at start)
  setTimeout(() => {
    void store.discoverInWorkspace().then(() => ensureIntellisenseConfig(store));
  }, 800);

  // build dir watcher: refresh products after a build finishes (single and
  // batch tasks alike — artifacts land outside the source-file watcher)
  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      const t = e.execution.task.definition.type;
      if (t === 'mrvc-build' || t === 'mrvc-build-all' || t === 'mrvc-clean-all' || t === 'mrvc-flash') {
        tree.refresh();
        ensureIntellisenseConfig(store);
      }
    })
  );
}

export function deactivate(): void {
  // nothing to do
}
