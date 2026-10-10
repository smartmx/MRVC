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
import { addLinkedFolderCmd, removeLinkedFolderCmd, changeLinkedFolderPathCmd, revealProducts } from './vscode/linkedFolders';
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
  restoreRemovedCmd,
} from './vscode/fileOps';
import { excludeFromBuild, includeFromBuild, excludedResourcePaths } from './vscode/exclude';
import { renameProjectCmd, syncProjectNameFromFolder } from './vscode/renameProject';
import { writeSolution } from './core/solution';
import { setCppNature } from './core/projectFile';
import { SyncPage } from './vscode/syncPage';
import { MacroBatchPage } from './vscode/macroBatch';
import { comTransmitCmd, hexBinToolCmd, ispToolCmd, touchkeyToolCmd, uiDesignerCmd } from './vscode/mrsTools';
import { ensureIntellisenseConfig, resolveProjectForFile, switchContext, maybePromptCppTools } from './vscode/intellisense';
import { addProjectToSolutionCmd, addProjectsByBatchCmd, setBuildOrderCmd, closeSolutionCmd } from './vscode/solutionLife';
import { generateCMakeListCmd, exportAsCMakeCmd } from './vscode/cmakeExport';
import { buildRecordFile } from './core/buildLog';
import { setLanguage, vscodeLanguageIsChinese, t } from './core/i18n';
import { createProjectCmd, createStaticLibCmd } from './vscode/newProject';
import { showStackUsageCmd, showCallAnalysisCmd } from './vscode/analysisReport';

/** V0.1.7 renamed the persisted keys mrs2.* → mrvc.*. One-time migration:
 * copy legacy values the new keys don't have yet, then drop the old keys
 * (both stores — without this, cpptoolsDontAsk would re-prompt and the
 * create-dir memory reset even though the values are still on disk). */
function migrateLegacyState(context: vscode.ExtensionContext): void {
  const ws = context.workspaceState;
  for (const [oldKey, newKey] of [
    ['mrs2.projects', 'mrvc.projects'],
    ['mrs2.active', 'mrvc.active'],
  ] as const) {
    const legacy = ws.get(oldKey);
    if (legacy !== undefined && ws.get(newKey) === undefined) void ws.update(newKey, legacy);
    void ws.update(oldKey, undefined);
  }
  const gs = context.globalState;
  for (const [oldKey, newKey] of [
    ['mrs2.lastCreateDir', 'mrvc.lastCreateDir'],
    ['mrs2.cpptoolsDontAsk', 'mrvc.cpptoolsDontAsk'],
  ] as const) {
    const legacy = gs.get(oldKey);
    if (legacy !== undefined && gs.get(newKey) === undefined) void gs.update(newKey, legacy);
    void gs.update(oldKey, undefined);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  migrateLegacyState(context);
  // UI language: mrvc.language ('auto' follows VSCode's display language)
  const langCfg = vscode.workspace.getConfiguration('mrvc').get<string>('language', 'auto');
  setLanguage(langCfg === 'zh-cn' || (langCfg === 'auto' && vscodeLanguageIsChinese(vscode.env.language)) ? 'zh-cn' : 'en');
  // the strings are captured at activation — a language change needs a
  // window reload; offer the restart instead of leaving a stale UI silently
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('mrvc.language')) return;
      void vscode.window
        .showInformationMessage(t('languageReload'), t('reloadWindow'))
        .then((pick) => pick === t('reloadWindow') && vscode.commands.executeCommand('workbench.action.reloadWindow'));
    })
  );

  const store = new ProjectStore(context);
  context.subscriptions.push(store);
  store.restoreState();

  const tree = new ProjectTreeProvider(store, context.extensionUri);
  const treeView = vscode.window.createTreeView('mrvc.projectExplorer', { treeDataProvider: tree, dragAndDropController: undefined });
  context.subscriptions.push(treeView);

  // IntelliSense context switch: selecting a (different) project in the tree
  // copies that project's compile_commands database over the active one —
  // cpptools re-parses with the project's own macros/includes (the MRS2
  // "one active project context" model). 500ms debounce; solution/group
  // nodes resolve to nothing and keep the current context.
  // the IntelliSense context currently loaded into _active.json. Tracked as
  // the full project identity EVEN when switchContext is a content no-op, so
  // the config-change handler below can refresh the slot after the project's
  // database was regenerated with new parameters.
  let ctxProject: { key: string; root: string; projectName: string } | undefined;
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
    if (ctxProject?.key === key) return;
    ctxProject = { key, root: owner.root, projectName: owner.projectName };
    switchContext(vscode.workspace.workspaceFolders[0].uri.fsPath, owner.root, owner.projectName);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((ed) => switchToFile(ed?.document.uri.fsPath)));
  treeView.onDidChangeSelection((e) => {
    if (ctxTimer) clearTimeout(ctxTimer);
    ctxTimer = setTimeout(() => {
      const sel = e.selection[0] as unknown as { project?: { root?: string; projectName?: string } } | undefined;
      const proj = sel?.project;
      if (!proj?.root || !proj.projectName) return;
      const key = proj.root.toLowerCase();
      if (ctxProject?.key === key) return;
      ctxProject = { key, root: proj.root, projectName: proj.projectName };
      switchContext(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', proj.root, proj.projectName);
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
    vscode.commands.executeCommand('setContext', 'mrvc.hasActiveProject', !!store.active);
    vscode.commands.executeCommand('setContext', 'mrvc.hasProjects', store.all.length > 0);
  };
  store.onDidChange(refreshContext);
  refreshContext();

  // IntelliSense config: rebuild (hash-gated, so no-op when nothing
  // config-related changed) whenever the store settles — covers property
  // Apply, Exclude toggles, project add/remove, refresh
  let intellisenseTimer: NodeJS.Timeout | undefined;
  store.onDidChange(() => {
    if (intellisenseTimer) clearTimeout(intellisenseTimer);
    intellisenseTimer = setTimeout(() => {
      ensureIntellisenseConfig(store);
      // a config change regenerates the context project's database — refresh
      // the _active.json slot with it so the current context picks up the new
      // parameters (switchContext is content-gated: no-op when unchanged).
      // A removed project just clears the context.
      const ctx = ctxProject;
      if (ctx) {
        const still = store.all.find((p) => p.root.toLowerCase() === ctx.key);
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (still && folder) {
          switchContext(folder.uri.fsPath, still.root, still.projectName);
        } else if (!still) {
          ctxProject = undefined;
        }
      }
    }, 1000);
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

  reg('mrvc.openProject', () => store.openProject());
  reg('mrvc.openFolder', () => store.openFolder());
  reg('mrvc.build', (item?: { project?: unknown }) => build.run('build', (item as { project?: MrsProject })?.project));
  reg('mrvc.buildAndDownload', (item?: { project?: unknown }) =>
    build.buildAndDownload((item as { project?: MrsProject })?.project)
  );
  reg('mrvc.buildAll', () => build.buildAll());
  reg('mrvc.rebuildAll', () => build.rebuildAll());
  reg('mrvc.deleteOutputKeepImages', () => build.deleteOutputFiles());
  reg('mrvc.deleteOutputDirs', () => build.deleteOutputDirs());
  reg('mrvc.buildSolution', (item?: { solution?: unknown }) => {
    const sol = (item as { solution?: MrsSolution })?.solution;
    if (sol) void build.buildSolution(sol);
  });
  reg('mrvc.cleanSolution', (item?: { solution?: unknown }) => {
    const sol = (item as { solution?: MrsSolution })?.solution;
    if (sol) void build.cleanSolution(sol);
  });
  reg('mrvc.addProjectToSolution', (item?: unknown) => addProjectToSolutionCmd(store, item));
  reg('mrvc.addProjectsByBatch', (item?: unknown) => addProjectsByBatchCmd(store, item));
  reg('mrvc.setBuildOrder', (item?: unknown) => setBuildOrderCmd(store, item));
  reg('mrvc.closeSolution', (item?: unknown) => closeSolutionCmd(store, item));
  reg('mrvc.generateCMakeList', (item?: { project?: unknown }) => generateCMakeListCmd(store, item));
  reg('mrvc.exportAsCMake', (item?: { project?: unknown }) => exportAsCMakeCmd(store, item));
  // MRS2 showFullBuildOutput: open the recorded full make output of the
  // active project (written by the build task's Tee-Object)
  reg('mrvc.createProject', () => createProjectCmd(store));
  reg('mrvc.createStaticLib', () => createStaticLibCmd(store));
  reg('mrvc.showStackUsage', (item?: unknown) => showStackUsageCmd(store, item));
  reg('mrvc.showCallAnalysis', (item?: unknown) => showCallAnalysisCmd(store, item));
  reg('mrvc.showFullBuildOutput', async (item?: { project?: unknown }) => {
    const project = (item as { project?: MrsProject } | undefined)?.project ?? store.active;
    if (!project) {
      vscode.window.showErrorMessage(t('noActiveProject'));
      return;
    }
    const record = buildRecordFile(project.root);
    if (!fs.existsSync(record)) {
      vscode.window.showInformationMessage(t('noBuildRecord', project.projectName));
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(record), { preview: true });
  });
  reg('mrvc.cleanAll', () => build.cleanAll());
  // collapse every project/folder row via the tree view's built-in command
  reg('mrvc.collapseAll', () =>
    vscode.commands.executeCommand('workbench.actions.treeView.mrvc.projectExplorer.collapseAll')
  );
  reg('mrvc.rebuild', (item?: { project?: unknown }) => build.run('rebuild', (item as { project?: MrsProject })?.project));
  reg('mrvc.clean', (item?: { project?: unknown }) => build.run('clean', (item as { project?: MrsProject })?.project));
  reg('mrvc.flashUtility', () => openLinkUtility());
  reg('mrvc.flash', (item?: { project?: unknown }) => flashProject(store, (item as { project?: MrsProject })?.project));
  reg('mrvc.configure', (item?: { project?: unknown }) => configView.show((item as { project?: MrsProject })?.project));
  reg('mrvc.addLinkedFolder', (item?: { project?: unknown }) => addLinkedFolderCmd(store, (item as { project?: MrsProject })?.project));
  reg('mrvc.removeLinkedFolder', (item?: unknown) => removeLinkedFolderCmd(store, item as { linkedName?: string; project?: MrsProject } | undefined));
  reg('mrvc.changeLinkedFolder', (item?: unknown) => changeLinkedFolderPathCmd(store, item as { linkedName?: string; project?: MrsProject } | undefined));
  reg('mrvc.openMrsTerminal', () => openMrsTerminal(store));
  reg('mrvc.revealProducts', () => revealProducts(store));
  reg('mrvc.updateIntellisense', () => {
    const r = ensureIntellisenseConfig(store);
    if (r.error) {
      vscode.window.showErrorMessage(t('intellisenseFail', r.error ?? ''));
    } else {
      vscode.window.showInformationMessage(t('intellisenseOk', r.entries, r.projects));
    }
  });
  reg('mrvc.resetInstallGuidance', () => {
    context.globalState.update('mrvc.cpptoolsDontAsk', false);
    vscode.window.showInformationMessage(t('guidanceReset'));
    // re-evaluate right away — "re-enabled" should feel like it did something
    maybePromptCppTools(context, store);
  });
  reg('mrvc.refreshTree', async () => {
    // refresh = full re-scan of the workspace folders: projects renamed or
    // deleted outside MRVC are dropped, new/renamed ones are discovered
    await store.refreshWorkspace();
  });

  // generate a .wvsln grouping every discovered project (writes next to the
  // workspace root; members stay in BuildOrder-less file order)
  const syncPage = new SyncPage(store);
  reg('mrvc.syncSettings', () => syncPage.open());
  // dedicated batch macro-editing page (independent of the Sync Setting page)
  const macroBatchPage = new MacroBatchPage(store);
  reg('mrvc.batchMacros', () => macroBatchPage.open());
  // open the Settings UI filtered to this extension's contributions
  // (@ext:<publisher>.<name> — dynamic so a publisher change stays correct)
  reg('mrvc.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`));
  reg('mrvc.ispTool', () => ispToolCmd());
  reg('mrvc.touchkeyTool', () => touchkeyToolCmd());
  reg('mrvc.uiDesigner', () => uiDesignerCmd());
  reg('mrvc.hexBinTool', () => hexBinToolCmd());
  reg('mrvc.comTransmit', () => comTransmitCmd());
  reg('mrvc.generateSolution', async () => {
    const all = store.all;
    if (!all.length) {
      vscode.window.showErrorMessage(t('noProjectsLoaded'));
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage(t('openFolderFirst'));

      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: t('solutionSaveAs', folder.uri.fsPath),
      value: path.basename(folder.uri.fsPath),
      placeHolder: t('solutionFileName'),
      validateInput: (v) => (!v || /[\\/:*?"<>|]/.test(v) ? t('invalidFileName') : undefined),
    });
    if (!name) return;
    const base = name.toLowerCase().endsWith('.wvsln') ? name : `${name}.wvsln`;
    const file = path.join(folder.uri.fsPath, base);
    if (fs.existsSync(file)) {
      const pick = await vscode.window.showWarningMessage(t('overwriteConfirm', base), { modal: true }, t('overwrite'));
      if (pick !== t('overwrite')) return;
    }
    try {
      writeSolution(file, all.map((p) => p.root));
    } catch (e) {
      vscode.window.showErrorMessage(t('solutionWriteFailed', msg(e)));
      return;
    }
    store.removeSolution(file); // overwrite: drop the stale loaded instance
    store.addSolution(file);
    vscode.window.showInformationMessage(t('solutionCreated', base, all.length));
  });

  // file management (tree context menu)
  reg('mrvc.file.copy', (item?: unknown) => copyNode(item as never));
  reg('mrvc.file.paste', (item?: unknown) => pasteNode(store, item as never));
  reg('mrvc.file.newFile', (item?: unknown) => newFile(item as never));
  reg('mrvc.file.newFolder', (item?: unknown) => newFolder(item as never));
  reg('mrvc.file.copyPath', (item?: unknown) => copyAbsolutePath(item as never));
  reg('mrvc.file.copyRelPath', (item?: unknown) => copyProjectRelativePath(item as never));
  reg('mrvc.file.copyName', (item?: unknown) => copyFileName(item as never));
  reg('mrvc.file.reveal', (item?: unknown) => revealInExplorer(item as never));
  reg('mrvc.file.rename', (item?: unknown) => renameNode(item as never));
  reg('mrvc.file.delete', (item?: unknown) => deleteNode(item as never));
  reg('mrvc.restoreRemoved', (item?: unknown) => restoreRemovedCmd(store, item));
  reg('mrvc.renameProject', (item?: unknown) => renameProjectCmd(store, item as never));
  reg('mrvc.syncProjectName', (item?: unknown) => syncProjectNameFromFolder(store, item as never));
  // C/C++ toggle = the CDT cxx nature in .project: it drives which property
  // pages show (C++ compiler/linker), which source extensions the scanner
  // picks and how makefiles treat .cpp — same key MRS2/CDT use
  reg('mrvc.switchProjectType', (item?: { project?: unknown }) => {
    const project = (item as { project?: MrsProject })?.project ?? store.active;
    if (!project) {
      vscode.window.showErrorMessage(t('noActiveProject'));
      return;
    }
    try {
      setCppNature(project.root, !project.cproject.isCpp);
    } catch (e) {
      vscode.window.showErrorMessage(t('switchTypeFailed', e instanceof Error ? e.message : String(e)));
      return;
    }
    store.reloadProject(project);
  });

  // exclude/include from build (CDT sourceEntries excluding)
  reg('mrvc.excludeFromBuild', (item?: unknown) => excludeFromBuild(store, item as never));
  reg('mrvc.includeFromBuild', (item?: unknown) => includeFromBuild(store, item as never));

  // discover projects already inside the workspace (debounced once at start)
  setTimeout(() => {
    void store.discoverInWorkspace().then(() => {
      ensureIntellisenseConfig(store);
      // the databases are only half of code navigation — make sure the
      // extension that consumes them is present and new enough
      maybePromptCppTools(context, store);
    });
  }, 800);

  // build dir watcher: refresh products after a build finishes (single and
  // batch tasks alike — artifacts land outside the source-file watcher)
  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      const t = e.execution.task.definition.type;
      if (t === 'mrvc-build' || t === 'mrvc-build-all' || t === 'mrvc-clean' || t === 'mrvc-clean-all' || t === 'mrvc-flash') {
        tree.refresh();
        ensureIntellisenseConfig(store);
      }
    })
  );
}

export function deactivate(): void {
  // nothing to do
}
