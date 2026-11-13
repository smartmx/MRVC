/**
 * MRVC for WCH — extension entry point.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectStore, MrsProject, MrsSolution, msg, installGate, getInstall, selectMrsInstall } from './vscode/projects';
import { ProjectTreeProvider, TreeDecorations } from './vscode/tree';
import { InfoTreeProvider } from './vscode/infoTree';
import { BuildManager } from './vscode/tasks';
import { flashProject, openLinkUtility, openMrsTerminal } from './vscode/flash';
import { powerOffResetCmd } from './vscode/powerCycle';
import { auditRepairCmd } from './vscode/auditCmd';
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
  flagFileCmd,
  clearFlagCmd,
} from './vscode/fileOps';
import { excludeFromBuild, includeFromBuild, excludedResourcePaths } from './vscode/exclude';
import { listMarks } from './core/colorMarks';
import { renameProjectCmd, syncProjectNameFromFolder } from './vscode/renameProject';
import { writeSolution } from './core/solution';
import { setProjectCpp } from './core/projectType';
import { SyncPage } from './vscode/syncPage';
import { MacroBatchPage } from './vscode/macroBatch';
import { comTransmitCmd, hexBinToolCmd, ispToolCmd, touchkeyToolCmd, uiDesignerCmd, wchToolKitCmd } from './vscode/mrsTools';
import { openWithMrsCmd } from './vscode/openMrs';
import { initSdiMonitor, sdiPrintMonitorCmd, sdiPrintStopCmd } from './vscode/sdiMonitor';
import { onSdiPrintfStatusChanged } from './core/sdiState';
import { ensureIntellisenseConfig, applyCacheOverrides, resolveProjectForFile, switchContext, maybePromptCppTools } from './vscode/intellisense';
import { addProjectToSolutionCmd, addProjectsByBatchCmd, setBuildOrderCmd, closeSolutionCmd, modifySolutionToolchainCmd, recoverSolutionPath } from './vscode/solutionLife';
import { generateCMakeListCmd, exportAsCMakeCmd } from './vscode/cmakeExport';
import { buildRecordFile } from './core/buildLog';
import { setLanguage, vscodeLanguageIsChinese, t } from './core/i18n';
import { createProjectCmd, createStaticLibCmd } from './vscode/newProject';
import { showStackUsageCmd, showCallAnalysisCmd } from './vscode/analysisReport';
import { cppCacheCandidates, dirSizeBytes, clearCppIntelliSenseCache, isSafeCachePath } from './core/cppCache';

/** V0.1.7 renamed the persisted keys mrs2.* → mrvc.*. One-time migration:
 * copy legacy values the new keys don't have yet, then drop the old keys
 * (both stores — without this, cpptoolsDontAsk would re-prompt and the
 * create-dir memory reset even though the values are still on disk). */

/** surface ensureIntellisenseConfig failures once per message. The activation
 *  path used to ignore the result entirely, so a broken/unparsable
 *  settings.json silently disabled the cache-path override (round21 §5.4). */
const intellisenseErrorsShown = new Set<string>();
function reportIntellisenseError(error: string | undefined): void {
  if (!error || intellisenseErrorsShown.has(error)) return;
  intellisenseErrorsShown.add(error);
  vscode.window.showWarningMessage(`MRVC: ${error}`);
}
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

  // keep the mrvc.mrs3Active context key in sync with the ACTIVE installation:
  // MRS3-only menu items (WCH Toolkit) hang off it. Registered here — before the
  // install gate — so it works whether or not the extension started, and picks
  // up later changes (the gate's adopt button, the mrsVersion pin buttons).
  const syncActiveFlavor = (): void => {
    void vscode.commands.executeCommand('setContext', 'mrvc.mrs3Active', selectMrsInstall().install?.flavor === 'mrs3');
  };
  syncActiveFlavor();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('mrvc.mrs2InstallPath') &&
        !e.affectsConfiguration('mrvc.mrs3InstallPath') &&
        !e.affectsConfiguration('mrvc.toolchainOnlyPath') &&
        !e.affectsConfiguration('mrvc.mrsVersion')
      ) {
        return;
      }
      syncActiveFlavor();
    })
  );

  // Startup gate: a configured AND valid MounRiver installation is a
  // precondition — without one the extension does not start (no tree, no
  // commands, no watchers). installGate reports the state itself and starts the
  // extension as soon as the settings are fixed, so no reload is needed.
  if (!installGate(context, () => startExtension(context))) return;
  startExtension(context);
}

/** everything the gate protects: project store, tree, commands, watchers */
function startExtension(context: vscode.ExtensionContext): void {
  const store = new ProjectStore(context);
  context.subscriptions.push(store);
  store.restoreState();

  const tree = new ProjectTreeProvider(store, context.extensionUri);
  const treeView = vscode.window.createTreeView('mrvc.projectExplorer', { treeDataProvider: tree, dragAndDropController: undefined });
  context.subscriptions.push(treeView);

  // the Info view mirrors the effective configuration builds reuse (0.3.0-2):
  // refreshed by store changes (active project, project list) and by ANY
  // mrvc.* configuration change, so the view always matches the next build
  const info = new InfoTreeProvider(store);
  const infoView = vscode.window.createTreeView('mrvc.info', { treeDataProvider: info });
  context.subscriptions.push(infoView);
  context.subscriptions.push(store.onDidChange(() => info.refresh()));
  // the SDI Printf row reflects MRVC's own last write (no hardware read-back
  // exists); refresh the Info view as soon as a download pass changes it
  context.subscriptions.push(onSdiPrintfStatusChanged(() => info.refresh()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mrvc')) {
        // a custom-toolchain edit can change resolutions without any memo
        // key input changing — drop the per-project memos, refresh the view
        store.expireToolchainMemos();
        info.refresh();
      }
    })
  );

  // lazy workspace init (0.2.8): opening a folder must NOT start MRVC —
  // no scan, no compile databases, no cpptools prompt — until the user
  // actually engages the extension. Memoized so every entry point (view
  // becoming visible, commands that need the store) shares one run; the
  // activation events in package.json match (onView/onCommand). A FAILED
  // run is NOT cached (round1 §7): the memo resets so the next user action
  // retries, and the error surfaces once via the report channel.
  let workspaceInit: Promise<void> | undefined;
  const ensureWorkspaceInit = (): Promise<void> => {
    if (!workspaceInit) {
      workspaceInit = (async () => {
        await store.discoverInWorkspace();
        reportIntellisenseError(ensureIntellisenseConfig(store).error);
        // the databases are only half of code navigation — make sure the
        // extension that consumes them is present and new enough
        maybePromptCppTools(context, store);
      })();
      workspaceInit.catch((e) => {
        workspaceInit = undefined; // allow the next user action to retry
        reportIntellisenseError(`workspace scan failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    return workspaceInit;
  };
  // the user clicking the MRVC icon in the activity bar (first time the
  // view becomes visible) is the explicit "start working" signal — plus a
  // visible-at-creation check (round1 §5): createTreeView may report the
  // restored layout's visible state before this listener exists, and
  // onDidChangeVisibility only fires on CHANGES
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) void ensureWorkspaceInit();
    })
  );
  if (treeView.visible) void ensureWorkspaceInit();

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
      // clicking a project row ACTIVATES it (0.3.0 user request): the Info
      // view and every store.active consumer follow immediately — build/
      // flash were already per-node, this makes "selected" mean "active".
      const active = store.active;
      if (!active || active.root.toLowerCase() !== key) {
        store.setActive(proj as MrsProject);
      }
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
    // file flags (MRS2-compatible .mrs/preferredColor.json)
    const flagMap = new Map<string, string>();
    for (const p of store.all) {
      for (const m of listMarks(p.root, p.cproject.linkedFolders)) flagMap.set(ProjectStore.key(m.absFile), m.color);
    }
    treeDecorations.setFlags(flagMap);
  };
  store.onDidChange(updateTreeDecorations);
  updateTreeDecorations();
  // flags can also be edited OUTSIDE MRVC (MRS2 writes the same
  // .mrs/preferredColor.json): watch each project's copy so decorations
  // refresh without waiting for an unrelated store change
  const flagWatcher = vscode.workspace.createFileSystemWatcher('**/.mrs/preferredColor.json');
  flagWatcher.onDidChange(updateTreeDecorations);
  flagWatcher.onDidCreate(updateTreeDecorations);
  flagWatcher.onDidDelete(updateTreeDecorations);
  context.subscriptions.push(flagWatcher);

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
      reportIntellisenseError(ensureIntellisenseConfig(store).error);
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
  } else if (slnSetting) {
    // stale path (renamed/moved solution, or a tree copied to another
    // machine): repair from a sibling *.wvsln instead of silently opening
    // the window as a plain folder
    void recoverSolutionPath(store, slnSetting);
  }

  // ---- commands ----
  // Every command AWAITS the lazy workspace init before running (round1 §3):
  // the command palette can invoke mrvc.* the moment the extension activates
  // — without the scan, Build/Flash/Properties would report "No MRS project
  // loaded" on a perfectly good folder. Only commands that never touch the
  // project store are exempted (NO_SCAN list: pure tool/settings/file
  // operations — launching them must not trigger a full workspace scan).
  const NO_SCAN = new Set([
    'mrvc.openFolder', // opens ANOTHER window; scanning here would be premature
    'mrvc.openProject', // opens a picker that leads to another window
    'mrvc.clearIntelliSenseCache',
    'mrvc.flashUtility', // WCH-LinkUtility GUI
    'mrvc.ispTool',
    'mrvc.touchkeyTool',
    'mrvc.uiDesigner',
    'mrvc.hexBinTool',
    'mrvc.comTransmit',
    'mrvc.wchToolKit',
    'mrvc.sdiPrintMonitor', // pure serial-port surface; no project store touch
    'mrvc.sdiPrintStop',
    'mrvc.openSettings',
    'mrvc.resetInstallGuidance',
    // syncSettings/batchMacros are NOT exempt (round2 §1.1): their pages
    // render from store.all — invoked on an empty store they would show
    // empty UIs, so they join the scan-first set
    'mrvc.collapseAll',
    'mrvc.refreshTreeDecorations',
    // file-node operations act on the TreeItem's own paths, not the store
    'mrvc.file.copy',
    'mrvc.file.paste',
    'mrvc.file.newFile',
    'mrvc.file.newFolder',
    'mrvc.file.copyPath',
    'mrvc.file.copyRelPath',
    'mrvc.file.copyName',
    'mrvc.file.reveal',
    'mrvc.file.rename',
    'mrvc.file.delete',
  ]);
  const reg = (id: string, fn: (...a: never[]) => unknown) => {
    const impl = NO_SCAN.has(id)
      ? fn
      : async (...a: never[]) => {
          await ensureWorkspaceInit();
          return fn(...a);
        };
    context.subscriptions.push(vscode.commands.registerCommand(id, impl as (...a: unknown[]) => unknown));
  };

  reg('mrvc.openProject', () => store.openProject());
  reg('mrvc.openFolder', () => store.openFolder());
  reg('mrvc.clearIntelliSenseCache', () => void clearIntelliSenseCacheCommand());
  // the Flag commands refresh decorations through this (fileOps cannot
  // reach the decoration provider instance directly)
  reg('mrvc.refreshTreeDecorations', () => updateTreeDecorations());
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
  reg('mrvc.modifySolutionToolchain', (item?: unknown) => modifySolutionToolchainCmd(store, item));
  reg('mrvc.closeSolution', (item?: unknown) => closeSolutionCmd(store, item));
  reg('mrvc.generateCMakeList', (item?: { project?: unknown }) => generateCMakeListCmd(store, item));
  reg('mrvc.exportAsCMake', (item?: { project?: unknown }) => exportAsCMakeCmd(store, item));
  // MRS2 showFullBuildOutput: open the recorded full make output of the
  // active project (written by the build wrapper's PowerShell tee script)
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
  // MRS3-only tool: the menu item is gated on mrvc.mrs3Active (kept in sync with
  // the active installation below)
  reg('mrvc.wchToolKit', () => wchToolKitCmd());
  // SDI PRINT monitor: pure serial-port surface (no project store), wired up
  // with its terminal-close tracking
  initSdiMonitor(context);
  reg('mrvc.sdiPrintMonitor', () => sdiPrintMonitorCmd());
  reg('mrvc.sdiPrintStop', () => sdiPrintStopCmd());
  // open the project folder in the currently effective MRS IDE (project
  // context menu; launcher resolved per install flavor, folder path arg only)
  reg('mrvc.openWithMrs', (item?: unknown) => openWithMrsCmd(store, item as never));
  // power-off reset (掉电复位): WCH-Link rail power cycle via two short
  // OpenOCD sessions — project context menu + command palette
  reg('mrvc.powerOffReset', (item?: unknown) => void powerOffResetCmd(store, item as { project?: unknown }));
  // audit & repair project configuration (enumerated-value damage, address
  // format, …): modal findings list, explicit confirm before any write
  reg('mrvc.auditProject', (item?: unknown) => void auditRepairCmd(store, item as { project?: unknown }));
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
  reg('mrvc.flagFile', (item?: unknown) => flagFileCmd(store, item));
  reg('mrvc.clearFlag', (item?: unknown) => clearFlagCmd(store, item));
  reg('mrvc.renameProject', (item?: unknown) => renameProjectCmd(store, item as never));
  reg('mrvc.syncProjectName', (item?: unknown) => syncProjectNameFromFolder(store, item as never));
  // C/C++ toggle = the CDT cxx nature in .project (MRS2 types projects by
  // exactly this key) PLUS, when switching to C++, the .cproject option
  // mirror — a C project has almost no cpp.* options, so a nature-only toggle
  // would build C++ without include paths or the linker script
  reg('mrvc.switchProjectType', (item?: { project?: unknown }) => {
    const project = (item as { project?: MrsProject })?.project ?? store.active;
    if (!project) {
      vscode.window.showErrorMessage(t('noActiveProject'));
      return;
    }
    try {
      setProjectCpp(project.root, !project.cproject.isCpp);
    } catch (e) {
      vscode.window.showErrorMessage(t('switchTypeFailed', e instanceof Error ? e.message : String(e)));
      return;
    }
    store.reloadProject(project);
  });

  // exclude/include from build (CDT sourceEntries excluding)
  reg('mrvc.excludeFromBuild', (item?: unknown) => excludeFromBuild(store, item as never));
  reg('mrvc.includeFromBuild', (item?: unknown) => includeFromBuild(store, item as never));

  // ---- C/C++ IntelliSense (cpptools) cache maintenance ----
  async function clearIntelliSenseCacheCommand(): Promise<void> {
    // the user's C_Cpp.intelliSenseCachePath (if set) wins, then the built-in
    // default — an old default can still hold gigabytes after a custom path
    // was configured, so both are offered. Runtime-typed (round28 §3.1):
    // get<T> is compile-time only, a hand-edited non-string value must not
    // reach the resolver (its .trim() would throw inside the command)
    const rawConfigured = vscode.workspace.getConfiguration('C_Cpp').get<unknown>('intelliSenseCachePath', '');
    const configured = typeof rawConfigured === 'string' ? rawConfigured : '';
    // a hand-edited non-string value (number, boolean, object…) is dropped
    // below — say so instead of silently falling back to the default path,
    // which would let the user believe their custom cache was cleaned
    // (round29 §3.1); explicit null counts as "unset", like VS Code's own UI
    if (rawConfigured !== '' && rawConfigured != null && typeof rawConfigured !== 'string') {
      void vscode.window.showWarningMessage(
        t('cacheClearMalformedPath', Array.isArray(rawConfigured) ? 'array' : typeof rawConfigured)
      );
    }
    const forbidden = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    // the safety guard runs HERE, before any size walk or dialog: an unsafe
    // candidate (home ancestor, inside a workspace) is excluded up front
    // instead of being scanned and only refused at deletion time (round23 §5.3)
    const existing = cppCacheCandidates(configured || undefined).filter((c) => fs.existsSync(c.path));
    const safe = existing.filter((c) => isSafeCachePath(c.path, forbidden, c.requireCacheShape));
    const guarded = existing.filter((c) => !safe.includes(c));
    if (!safe.length) {
      if (guarded.length) {
        // every candidate was refused by the safety guard — say WHY instead
        // of a misleading "no cache found" (round25 §5.2)
        vscode.window.showWarningMessage(t('cacheClearAllGuarded', guarded.map((c) => c.path).join('\n')));
      } else {
        vscode.window.showInformationMessage(t('cacheClearNone'));
      }
      return;
    }
    const sized = safe.map((c) => ({ ...c, bytes: dirSizeBytes(c.path) }));
    const total = sized.reduce((s, x) => s + x.bytes, 0);
    const okBtn = t('cacheClearConfirm');
    // a partial guard refusal is stated IN the confirmation: the user must
    // see that some discovered caches will NOT be touched (round26 §4.4)
    const guardedNote = guarded.length ? '\n' + t('cacheClearGuardedNote', guarded.map((c) => c.path).join('\n')) : '';
    const pick = await vscode.window.showWarningMessage(
      t('cacheClearConfirmDetail', sized.map((s) => `${s.path} (${(s.bytes / 1048576).toFixed(1)} MB, ${s.source})`).join('\n'), (total / 1048576).toFixed(1)) + guardedNote,
      { modal: true },
      okBtn
    );
    if (pick !== okBtn) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('cacheClearProgress') }, async () => {
      const r = clearCppIntelliSenseCache(sized, forbidden);
      if (!r.failed.length) {
        vscode.window.showInformationMessage(t('cacheClearDone', (r.cleared.reduce((s, x) => s + x.bytes, 0) / 1048576).toFixed(1)));
        return;
      }
      // "Reload Window" is offered ONLY for lock-type failures: a running
      // cpptools holding a PCH open is the one case the extension-host
      // restart actually finishes the cleanup. TOCTOU content loss, guard
      // refusals and plain permission errors get their reason shown without
      // a reload button — reloading would fix none of them (round26 §4.3 /
      // round29 §3.2; the kind comes from the core classifier)
      const detail = r.failed.map((f) => `${f.path}: ${f.error}`).join('\n');
      const reload = t('reloadWindow');
      const locked = r.failed.some((f) => f.kind === 'locked');
      void vscode.window
        .showWarningMessage(t('cacheClearPartial', detail), ...(locked ? [reload] : []))
        .then((p) => {
          if (p === reload) void vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
    });
  }


  // while one of OUR build/clean/flash tasks runs, suspend the watcher-driven
  // tree refreshes: make's obj/ write storm would otherwise re-render the
  // tree every debounce window and blink the linked-folder decorations
  // white↔blue for the whole build. After the LAST task ends, only the
  // products nodes of the touched roots re-read their children — never a
  // whole-tree fire (the async decoration pass repaints linked folders
  // white→blue on a full rebuild; user report 2026-11-13).
  let buildTasksActive = 0;
  const dirtyRoots = new Set<string>();
  const isTreeHeavyTask = (type: string): boolean =>
    type === 'mrvc-build' || type === 'mrvc-build-all' || type === 'mrvc-clean' || type === 'mrvc-clean-all' || type === 'mrvc-flash';
  context.subscriptions.push(
    vscode.tasks.onDidStartTaskProcess((e) => {
      if (isTreeHeavyTask(e.execution.task.definition.type) && ++buildTasksActive === 1) {
        dirtyRoots.clear();
        store.suspendTreeRefresh();
      }
    })
  );
  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      const t = e.execution.task.definition.type;
      if (!isTreeHeavyTask(t)) return;
      const root = e.execution.task.definition.root as string | undefined;
      if (root) dirtyRoots.add(root);
      if (buildTasksActive > 0 && --buildTasksActive === 0) {
        store.resumeTreeRefresh();
        if (!store.isTreeRefreshSuspended()) {
          for (const r of dirtyRoots) {
            const p = store.all.find((x) => ProjectStore.key(x.root) === ProjectStore.key(r));
            if (p) store.noteTreeDirs(p.buildDir);
          }
        }
        dirtyRoots.clear();
      }
      reportIntellisenseError(ensureIntellisenseConfig(store).error);
    })
  );

  // cache settings take effect IMMEDIATELY via the CHEAP override writer
  // (round22 §5.2 / round23 §5.4) — a full ensureIntellisenseConfig on a big
  // EVT workspace would stall the host just because a cache setting changed.
  // The whole callback is guarded: a settings change must NEVER surface as
  // an unhandled extension-host exception (round25 §5.4).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('mrvc.intellisense.cachePath') && !e.affectsConfiguration('mrvc.intellisense.cacheSize')) return;
      try {
        const r = applyCacheOverrides();
        if (r.invalidSettings.length) {
          reportIntellisenseError(t('invalidCacheSettings', r.invalidSettings.join('; ')));
        }
        if (r.unreadable.length) {
          reportIntellisenseError(t('cacheSettingsUnreadable', r.unreadable.join(', ')));
        }
      } catch (e2) {
        reportIntellisenseError(e2 instanceof Error ? e2.message : String(e2));
      }
    })
  );

  // the install notes (an invalid configured path, a pin that had to fall back,
  // both paths valid) surface once at startup — getInstall() is their entry
  void getInstall();
}

export function deactivate(): void {
  // nothing to do
}
