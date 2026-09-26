/**
 * Workspace project registry: discovers MRS projects, tracks the active
 * project, persists the selection, and notifies views.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Cproject } from '../core/cproject';
import { MrsProjectFile, readProjectFile, linkedFolderMap } from '../core/projectFile';
import { readTemplate, TemplateData } from '../core/templateFile';
import { locateInstall, MrsInstall, selectToolchain, ToolchainInfo } from '../core/toolchain';
import { findProjectRoots } from '../core/discover';
import { parseSolution } from '../core/solution';

export class MrsProject {
  readonly root: string;
  projectName!: string;
  projectFile!: MrsProjectFile;
  cproject!: Cproject;
  template!: TemplateData;
  /** lazily computed kernel info; null = stale, undefined = no kernel */
  private kernelInfo: { kernelName: string; isMaster?: boolean; mate?: string } | null | undefined = null;

  constructor(root: string) {
    this.root = root;
    this.reload();
  }

  reload(): void {
    this.kernelInfo = null;
    this.projectFile = readProjectFile(this.root);
    this.projectName = this.projectFile.name || path.basename(this.root);
    this.cproject = Cproject.load(this.root);
    this.template = readTemplate(this.root);
  }

  get buildDir(): string {
    return path.join(this.root, this.cproject.configName);
  }

  /**
   * CDT logic path (posix, project-root relative, linked content rooted at
   * the link name) of a file/folder inside this project, or undefined when
   * it lives outside both.
   */
  logicPathOf(fsPath: string): string | undefined {
    const rel = path.relative(this.root, fsPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
    const link = this.projectFile.linkedResources.find(
      (l) => l.type === 2 && (fsPath === l.location || fsPath.startsWith(l.location + path.sep))
    );
    if (!link) return undefined;
    return path.join(link.name, path.relative(link.location, fsPath)).split(path.sep).join('/');
  }

  get hexPath(): string {
    const ext = this.cproject.flashFormat === 'binary' ? 'bin' : 'hex';
    return path.join(this.buildDir, `${this.cproject.targetName}.${ext}`);
  }

  toolchain(install: MrsInstall | null, request: string): ToolchainInfo | null {
    return selectToolchain(install, request, this.cproject.rvGccVersion, this.cproject.storedPrefix);
  }

  /**
   * Multi-core role from `.kernel` (authoritative project-side copy), with
   * the `.wvproj` basic.kernel JSON as fallback. Undefined for single-core
   * projects — CH32H417 EVT solutions carry V3F/V5F pairs. Cached per
   * reload: the tree calls this for every rendered row.
   */
  get kernel(): { kernelName: string; isMaster?: boolean; mate?: string } | undefined {
    if (this.kernelInfo !== null) return this.kernelInfo;
    const read = (f: string): Record<string, unknown> | undefined => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf-8'));
      } catch {
        return undefined;
      }
    };
    let result: { kernelName: string; isMaster?: boolean; mate?: string } | undefined;
    const file = read(path.join(this.root, '.kernel'));
    if (file && typeof file.kernelName === 'string') {
      result = file as { kernelName: string; isMaster?: boolean; mate?: string };
    } else {
      const wvproj = read(path.join(this.root, `${this.projectName}.wvproj`)) as
        | { basic?: { kernel?: { kernelName?: string } } }
        | undefined;
      const k = wvproj?.basic?.kernel;
      if (k && typeof k.kernelName === 'string') {
        result = k as { kernelName: string; isMaster?: boolean; mate?: string };
      }
    }
    this.kernelInfo = result;
    return result;
  }
}

/**
 * An MRS solution (.wvsln): a named group of standard projects. Members are
 * regular MrsProjects in the store, referenced by root; the same project may
 * theoretically be referenced by several solutions (EVT solutions sometimes
 * cross-reference projects in other directories).
 */
export class MrsSolution {
  readonly file: string;
  readonly dir: string;
  readonly name: string;
  /** project names from BuildOrder=; empty = file order */
  readonly buildOrder: string[];
  /** raw member lines whose directory does not exist (stale absolute paths) */
  readonly droppedPaths: string[];
  private readonly memberRoots: string[] = [];

  constructor(file: string, private store: ProjectStore) {
    this.file = file;
    this.dir = path.dirname(file);
    this.name = path.basename(file, '.wvsln');
    const parsed = parseSolution(file);
    this.buildOrder = parsed.buildOrder ?? [];
    this.droppedPaths = parsed.dropped.map((d) => d.raw);
    for (const entry of parsed.entries) {
      const proj = store.add(entry.resolved);
      if (proj) this.memberRoots.push(entry.resolved);
    }
  }

  static key(file: string): string {
    return ProjectStore.key(file);
  }

  /** members in BuildOrder order (file order when no BuildOrder line) */
  get members(): MrsProject[] {
    const list = this.memberRoots.map((r) => this.store.get(r)).filter((p): p is MrsProject => !!p);
    if (!this.buildOrder.length) return list;
    const rank = (p: MrsProject): number => {
      const i = this.buildOrder.indexOf(p.projectName);
      return i === -1 ? this.buildOrder.length : i;
    };
    return list.slice().sort((a, b) => rank(a) - rank(b));
  }
}

export class ProjectStore implements vscode.Disposable {
  private projects = new Map<string, MrsProject>(); // key: root path (lowercase on win)
  private solutions = new Map<string, MrsSolution>(); // key: .wvsln path (lowercase on win)
  private _active: MrsProject | null = null;
  private watchers = new Map<string, vscode.Disposable[]>(); // per project root
  private srcWatchers: vscode.Disposable[] = []; // workspace-wide source files
  private srcRefreshTimer: NodeJS.Timeout | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {
    this.watchWorkspaceSources();
  }

  get active(): MrsProject | null {
    return this._active;
  }

  get all(): MrsProject[] {
    return [...this.projects.values()];
  }

  get solutionList(): MrsSolution[] {
    return [...this.solutions.values()];
  }

  static key(root: string): string {
    return process.platform === 'win32' ? path.normalize(root).toLowerCase() : path.normalize(root);
  }

  get(root: string): MrsProject | undefined {
    return this.projects.get(ProjectStore.key(root));
  }

  /**
   * Open dialog (files only — MRS2-style type dropdown in the corner):
   *   .wvproj / .project file → open its folder in a NEW VSCode window
   *   .wvsln file             → generate the companion .code-workspace and
   *                             open it in a NEW VSCode window (loads the
   *                             solution)
   * Folders are opened through the dedicated openFolder() command instead —
   * canSelectFolders cannot be combined with filters: VSCode ignores filters
   * in folder mode.
   */
  async openProject(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: 'Open MRS Project / Solution',
      title: 'Open MRS Project / Solution',
      filters: {
        'MRS Project / Solution (*.wvproj, *.wvsln)': ['wvproj', 'wvsln'],
        'MRS Project (*.wvproj)': ['wvproj'],
        'MRS Solution (*.wvsln)': ['wvsln'],
        'All Files (*.*)': ['*'],
      },
    });
    if (!picks?.length) return;
    const sel = picks[0].fsPath;

    if (sel.toLowerCase().endsWith('.wvsln')) {
      await this.openSolutionWindow(sel);
      return;
    }
    await this.openFolderWindow(path.dirname(sel));
  }

  /**
   * Folder-only open dialog (no file filters — VSCode/Windows hide the type
   * dropdown in folder mode). Opens the picked folder in a NEW VSCode window;
   * projects are discovered there.
   */
  async openFolder(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Open MRS Folder',
      title: 'Open MRS Folder',
    });
    if (!picks?.length) return;
    await this.openFolderWindow(picks[0].fsPath);
  }

  /** open a project folder in a new window; projects are discovered there */
  private async openFolderWindow(root: string): Promise<void> {
    if (!fs.existsSync(path.join(root, '.project')) && !findProjectRoots(root).length) {
      vscode.window.showErrorMessage('No .project found in the selected folder (not an MRS project?).');
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true });
  }

  /**
   * Open a solution in a new window: generate a companion .code-workspace
   * (solution dir as folder + mrvc.solution setting) next to the .wvsln and
   * open that. The workspace setting re-triggers the solution load on
   * activation — the explicit "opened this .wvsln" state.
   */
  private async openSolutionWindow(slnFile: string): Promise<void> {
    const dir = path.dirname(slnFile);
    const name = path.basename(slnFile, '.wvsln');
    const wsFile = path.join(dir, `${name}.code-workspace`);
    const ws = {
      folders: [{ path: '.' }],
      settings: { 'mrvc.solution': slnFile },
    };
    try {
      fs.writeFileSync(wsFile, JSON.stringify(ws, null, '\t'), 'utf-8');
    } catch (e) {
      vscode.window.showErrorMessage(`MRVC: cannot write workspace file — ${msg(e)}`);
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsFile), { forceNewWindow: true });
  }

  add(root: string): MrsProject | null {
    if (!fs.existsSync(path.join(root, '.project'))) {
      // discovered via 工程名.wvproj (the MRS marker) but the parseable
      // project description is absent — MRVC-only project
      vscode.window.showWarningMessage(
        `Skipped "${path.basename(root)}": found a .wvproj marker but no .project (MRVC-only project cannot be parsed).`
      );
      return null;
    }
    try {
      const key = ProjectStore.key(root);
      // re-adding an existing root must reuse the instance: replacing it
      // would orphan store.active (the old object stops receiving reloads)
      const existing = this.projects.get(key);
      if (existing) return existing;
      const proj = new MrsProject(root);
      this.projects.set(key, proj);
      // NOTE: the active project is NOT auto-assigned here — discovery sets
      // it once, after the full scan, so the marker never flickers
      this.saveState();
      this.watchProject(root);
      this._onDidChange.fire();
      return proj;
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to open MRS project: ${msg(e)}`);
      return null;
    }
  }

  setActive(proj: MrsProject): void {
    this._active = proj;
    this.saveState();
    this._onDidChange.fire();
  }

  /** register a solution (.wvsln); its member projects join the store */
  addSolution(file: string): MrsSolution | null {
    const key = MrsSolution.key(file);
    const existing = this.solutions.get(key);
    if (existing) return existing;
    if (!fs.existsSync(file)) return null;
    const sol = new MrsSolution(file, this);
    this.solutions.set(key, sol);
    if (!this._active) {
      const first = sol.members[0];
      if (first) this._active = first;
    }
    this.saveState();
    this._onDidChange.fire();
    return sol;
  }

  /** unregister a solution (member projects stay in the store) */
  removeSolution(file: string): void {
    if (this.solutions.delete(MrsSolution.key(file))) {
      this.saveState();
      this._onDidChange.fire();
    }
  }

  remove(root: string): void {
    this.projects.delete(ProjectStore.key(root));
    this.unwatchProject(root);
    if (this._active && ProjectStore.key(this._active.root) === ProjectStore.key(root)) {
      this._active = this.projects.values().next().value ?? null;
    }
    this.saveState();
    this._onDidChange.fire();
  }

  /**
   * Re-scan the workspace folders: drop projects whose root has vanished
   * (folder renamed/deleted outside MRVC), then discover what is there now.
   * Bound to the tree's Refresh button.
   */
  async refreshWorkspace(): Promise<void> {
    for (const p of this.all) {
      if (!fs.existsSync(path.join(p.root, '.project'))) {
        this.remove(p.root);
      }
    }
    await this.discoverInWorkspace();
  }

  reloadActive(): void {
    try {
      this._active?.reload();
    } catch {
      // project files temporarily broken (mid-save) — ignore
    }
    this._onDidChange.fire();
  }

  /** reload one project after a direct .project/.cproject edit and notify views */
  reloadProject(proj: MrsProject): void {
    try {
      proj.reload();
    } catch {
      // project files temporarily broken (mid-save) — ignore
    }
    this._onDidChange.fire();
  }

  /**
   * Scan workspace folders for projects (plain findProjectRoots walk).
   * Solutions are NOT auto-discovered from folders — they only join the
   * store when the user explicitly opens a .wvsln file (openProject).
   */
  async discoverInWorkspace(): Promise<MrsProject[]> {
    const found: MrsProject[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const root of findProjectRoots(folder.uri.fsPath)) {
        const proj = this.add(root);
        if (proj) found.push(proj);
      }
    }
    // NOTE: no automatic active assignment — the status bar reflects the
    // project the user last built (or the first member of an opened
    // solution); the tree carries no marker
    return found;
  }

  private saveState(): void {
    const roots = this.all.map((p) => p.root);
    this.context.workspaceState.update('mrs2.projects', roots);
    this.context.workspaceState.update('mrs2.active', this._active?.root ?? undefined);
    // solutions are deliberately NOT persisted: they only exist because the
    // user explicitly opened a .wvsln in this session
  }

  restoreState(): void {
    const roots = this.context.workspaceState.get<string[]>('mrs2.projects') ?? [];
    for (const r of roots) {
      if (fs.existsSync(path.join(r, '.project'))) {
        try {
          this.projects.set(ProjectStore.key(r), new MrsProject(r));
          this.watchProject(r);
        } catch {
          // project vanished or broken
        }
      }
    }
    const activeRoot = this.context.workspaceState.get<string>('mrs2.active');
    this._active = activeRoot ? (this.get(activeRoot) ?? null) : null;
  }

  private watchProject(root: string): void {
    const key = ProjectStore.key(root);
    if (this.watchers.has(key)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '{.project,.cproject,.template}'));
    const onChange = () => {
      const p = this.projects.get(key);
      if (p) {
        try {
          p.reload();
        } catch {
          return;
        }
        this._onDidChange.fire();
      }
    };
    const onDelete = () => {
      // a deleted .project means the project is gone (renamed/removed
      // externally) — drop it from the store instead of keeping a zombie
      if (!fs.existsSync(path.join(root, '.project')) && !fs.existsSync(path.join(root, '.cproject'))) {
        this.remove(root);
      }
    };
    // source-file watcher per project root: covers solution members that
    // live OUTSIDE the workspace folders (the workspace-wide watcher in
    // watchWorkspaceSources cannot see them)
    const srcWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.{c,h,cpp,hpp,s,S}'));
    const bump = () => {
      if (this.srcRefreshTimer) clearTimeout(this.srcRefreshTimer);
      this.srcRefreshTimer = setTimeout(() => this._onDidChange.fire(), 400);
    };
    this.watchers.set(key, [
      watcher,
      watcher.onDidChange(onChange),
      watcher.onDidCreate(onChange),
      watcher.onDidDelete(onDelete),
      srcWatcher,
      srcWatcher.onDidChange(bump),
      srcWatcher.onDidCreate(bump),
      srcWatcher.onDidDelete(bump),
    ]);
  }

  /**
   * Workspace-wide watcher over source files: creating/deleting/renaming a
   * .c/.h/... must refresh the tree without a manual refresh (config files
   * have their own per-project watcher in watchProject). Fires are debounced
   * because build steps can touch many files at once.
   */
  private watchWorkspaceSources(): void {
    if (this.srcWatchers.length) return;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '**/*.{c,h,cpp,hpp,s,S}')
      );
      const bump = () => {
        if (this.srcRefreshTimer) clearTimeout(this.srcRefreshTimer);
        this.srcRefreshTimer = setTimeout(() => this._onDidChange.fire(), 400);
      };
      this.srcWatchers.push(watcher, watcher.onDidChange(bump), watcher.onDidCreate(bump), watcher.onDidDelete(bump));
    }
  }

  private unwatchProject(root: string): void {
    const key = ProjectStore.key(root);
    const list = this.watchers.get(key);
    if (list) {
      for (const d of list) d.dispose();
      this.watchers.delete(key);
    }
  }

  dispose(): void {
    for (const list of this.watchers.values()) {
      for (const d of list) d.dispose();
    }
    this.watchers.clear();
    for (const d of this.srcWatchers) d.dispose();
    this.srcWatchers = [];
    if (this.srcRefreshTimer) clearTimeout(this.srcRefreshTimer);
    this._onDidChange.dispose();
  }
}

export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function getInstall(): MrsInstall | null {
  const cfg = vscode.workspace.getConfiguration('mrvc');
  return locateInstall(cfg.get<string>('mrs2InstallPath'));
}
