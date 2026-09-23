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

export class MrsProject {
  readonly root: string;
  projectName!: string;
  projectFile!: MrsProjectFile;
  cproject!: Cproject;
  template!: TemplateData;

  constructor(root: string) {
    this.root = root;
    this.reload();
  }

  reload(): void {
    this.projectFile = readProjectFile(this.root);
    this.projectName = this.projectFile.name || path.basename(this.root);
    this.cproject = Cproject.load(this.root);
    this.template = readTemplate(this.root);
  }

  get buildDir(): string {
    return path.join(this.root, this.cproject.configName);
  }

  get hexPath(): string {
    const ext = this.cproject.flashFormat === 'binary' ? 'bin' : 'hex';
    return path.join(this.buildDir, `${this.cproject.targetName}.${ext}`);
  }

  toolchain(install: MrsInstall | null, request: string): ToolchainInfo | null {
    return selectToolchain(install, request, this.cproject.rvGccVersion, this.cproject.storedPrefix);
  }
}

export class ProjectStore implements vscode.Disposable {
  private projects = new Map<string, MrsProject>(); // key: root path (lowercase on win)
  private _active: MrsProject | null = null;
  private watchers: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {}

  get active(): MrsProject | null {
    return this._active;
  }

  get all(): MrsProject[] {
    return [...this.projects.values()];
  }

  static key(root: string): string {
    return process.platform === 'win32' ? path.normalize(root).toLowerCase() : path.normalize(root);
  }

  get(root: string): MrsProject | undefined {
    return this.projects.get(ProjectStore.key(root));
  }

  async openProject(): Promise<MrsProject | null> {
    const picks = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: 'Select project folder (or .project/.wvproj)',
      title: 'Open MRS Project',
    });
    if (!picks?.length) return null;
    const sel = picks[0].fsPath;
    let root: string;
    if (fs.statSync(sel).isFile()) {
      root = path.dirname(sel);
    } else {
      root = sel;
    }
    if (!fs.existsSync(path.join(root, '.project'))) {
      // not itself a project: discover every project below (EVT-style tree)
      const inner = findProjectRoots(root);
      if (inner.length === 1) {
        root = inner[0];
      } else if (inner.length > 1) {
        const pick = await vscode.window.showQuickPick(
          inner.map((r) => ({ label: path.basename(r), description: r, root: r })),
          { placeHolder: `Select a project (${inner.length} found under ${path.basename(root)})` }
        );
        if (!pick) return null;
        root = pick.root;
      } else {
        vscode.window.showErrorMessage('No .project found in the selected folder (not an MRS project?).');
        return null;
      }
    }
    return this.add(root);
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
      const proj = new MrsProject(root);
      const key = ProjectStore.key(root);
      this.projects.set(key, proj);
      if (!this._active) this._active = proj;
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

  remove(root: string): void {
    this.projects.delete(ProjectStore.key(root));
    if (this._active && ProjectStore.key(this._active.root) === ProjectStore.key(root)) {
      this._active = this.projects.values().next().value ?? null;
    }
    this.saveState();
    this._onDidChange.fire();
  }

  reloadActive(): void {
    try {
      this._active?.reload();
    } catch {
      // project files temporarily broken (mid-save) — ignore
    }
    this._onDidChange.fire();
  }

  /** scan workspace folders for .project files */
  async discoverInWorkspace(): Promise<MrsProject[]> {
    const found: MrsProject[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const root of findProjectRoots(folder.uri.fsPath)) {
        const proj = this.add(root);
        if (proj) found.push(proj);
      }
    }
    if (found.length && !this._active) {
      this._active = found[0];
      this.saveState();
      this._onDidChange.fire();
    }
    return found;
  }

  private saveState(): void {
    const roots = this.all.map((p) => p.root);
    this.context.workspaceState.update('mrs2.projects', roots);
    this.context.workspaceState.update('mrs2.active', this._active?.root ?? undefined);
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
    this._active = (activeRoot ? this.get(activeRoot) : undefined) ?? this.projects.values().next().value ?? null;
  }

  private watchProject(root: string): void {
    const key = ProjectStore.key(root);
    if (this.watchers.some((w) => (w as any).__key === key)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '{.project,.cproject,.template}'));
    (watcher as any).__key = key;
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
    this.watchers.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange));
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose();
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
