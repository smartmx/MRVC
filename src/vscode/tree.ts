/**
 * MRS project tree: projects, linked folders, source folders and products.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectStore, MrsProject, MrsSolution } from './projects';
import { isLogicExcluded } from '../core/scan';

type NodeType = 'project' | 'solution' | 'linkedFolder' | 'folder' | 'file' | 'products' | 'empty';

export class TreeNode extends vscode.TreeItem {
  constructor(
    public readonly nodeType: NodeType,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly fsPath?: string,
    public readonly project?: MrsProject,
    public readonly linkedName?: string,
    public readonly solution?: MrsSolution
  ) {
    super(label, collapsibleState);
    this.contextValue = nodeType;
  }
}

/**
 * Tree decorations: linked (virtual) folders get a blue tint + hover
 * tooltip; build output directories get the custom red color; resources
 * excluded from the build get the custom gray. Same mechanism VSCode uses
 * for git decorations.
 *
 * Exclusions are tracked PER PROJECT: EVT trees link the same physical
 * folder (LIB, StdPeriphDriver, ...) into many projects whose exclusion
 * lists differ, so a path alone is ambiguous. Tree items carry their
 * project key in the resourceUri query; views without that context (VSCode
 * Explorer) fall back to the union of all projects.
 */
export class TreeDecorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private links = new Set<string>();
  private outputs = new Set<string>();
  private excludedByProject = new Map<string, Set<string>>();
  private excludedAll = new Set<string>();

  private fireChanged(next: Set<string>, prev: Set<string>): void {
    const changed = [...new Set([...next, ...prev])].map((p) => vscode.Uri.file(p));
    this._onDidChange.fire(changed);
  }

  setLinks(paths: Iterable<string>): void {
    const next = new Set([...paths].map((p) => ProjectStore.key(p)));
    this.fireChanged(next, this.links);
    this.links = next;
  }

  setOutputs(paths: Iterable<string>): void {
    const next = new Set([...paths].map((p) => ProjectStore.key(p)));
    this.fireChanged(next, this.outputs);
    this.outputs = next;
  }

  setExcludedByProject(perProject: Map<string, string[]>): void {
    const next = new Map<string, Set<string>>();
    const all = new Set<string>();
    for (const [key, paths] of perProject) {
      const set = new Set(paths.map((p) => ProjectStore.key(p)));
      next.set(key, set);
      for (const k of set) all.add(k);
    }
    const changed = new Set<string>(all);
    for (const k of this.excludedAll) changed.add(k);
    for (const s of this.excludedByProject.values()) {
      for (const k of s) changed.add(k);
    }
    this.excludedByProject = next;
    this.excludedAll = all;
    if (changed.size) {
      this._onDidChange.fire([...changed].map((p) => vscode.Uri.file(p)));
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const key = ProjectStore.key(uri.fsPath);
    if (this.links.has(key)) {
      return new vscode.FileDecoration(undefined, 'Linked folder (external directory)', new vscode.ThemeColor('charts.blue'));
    }
    if (this.outputs.has(key)) {
      return new vscode.FileDecoration(undefined, 'Build output directory', new vscode.ThemeColor('mrvc.outputDirectory'));
    }
    const perProject = uri.query ? this.excludedByProject.get(uri.query) : undefined;
    const excluded = perProject ? perProject.has(key) : this.excludedAll.has(key);
    if (excluded) {
      // VSCode has no icon overlays (MRS2/Eclipse-style slash), the closest
      // is the single-char badge next to the label plus the gray row
      return new vscode.FileDecoration('×', 'Excluded from build', new vscode.ThemeColor('mrvc.excludedFromBuild'));
    }
    return undefined;
  }
}

export class ProjectTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  /** lowercased project names shared by more than one loaded project */
  private duplicateNames: Set<string> = new Set();

  /** MRS2-original tree icons (media/), same art the MRS2 explorer uses */
  private readonly icons: { project: vscode.Uri; solution: vscode.Uri };

  constructor(private store: ProjectStore, extensionUri: vscode.Uri) {
    this.icons = {
      project: vscode.Uri.joinPath(extensionUri, 'media', 'project.svg'),
      solution: vscode.Uri.joinPath(extensionUri, 'media', 'solution.svg'),
    };
    store.onDidChange(() => {
      const counts = new Map<string, number>();
      for (const p of store.all) {
        const key = p.projectName.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      this.duplicateNames = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k));
      this.refresh();
    });
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    // With `resourceUri` set and no explicit iconPath, VSCode renders the
    // icon from the ACTIVE file icon theme (per-extension for files: .c,
    // .h, .ld, ... get their theme icons exactly like the Explorer).
    if (el.fsPath && el.nodeType !== 'project' && el.nodeType !== 'solution') {
      // the project key rides in the uri query so decorations can resolve
      // per project (same physical file often linked by several projects)
      el.resourceUri = vscode.Uri.file(el.fsPath).with({ query: el.project ? ProjectStore.key(el.project.root) : undefined });
    }
    if (el.nodeType === 'file' && el.fsPath) {
      el.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(el.fsPath)] };
    }
    if (el.nodeType === 'solution' && el.solution) {
      el.iconPath = { light: this.icons.solution, dark: this.icons.solution };
      el.description = 'solution';
      const dropped = el.solution.droppedPaths.length;
      el.tooltip = dropped
        ? `${el.solution.file}\n${dropped} stale member path(s) dropped`
        : el.solution.file;
    }
    if (el.nodeType === 'project') {
      // root-folder codicon reads as "project root" and, being an explicit
      // ThemeIcon, never lets themes match the project NAME
      el.iconPath = { light: this.icons.project, dark: this.icons.project };
      if (el.project) {
        let loc: string | undefined;
        if (el.project.projectName && this.duplicateNames.has(el.project.projectName.toLowerCase())) {
          loc = this.projectLocation(el.project);
          if (loc) el.description = loc;
        }
        const lines: string[] = [];
        const kernel = el.project.kernel;
        if (kernel?.kernelName) {
          lines.push(`kernel ${kernel.kernelName}${kernel.isMaster ? ' (master)' : ''}${kernel.mate ? ` · mate ${kernel.mate}` : ''}`);
        }
        lines.push(el.project.root);
        el.tooltip = lines.join('\n');
      }
    }
    // exclude/include menu visibility rides on contextValue
    if (
      (el.nodeType === 'file' || el.nodeType === 'folder') &&
      el.project &&
      el.fsPath &&
      !el.fsPath.startsWith(el.project.buildDir + path.sep)
    ) {
      const logic = el.project.logicPathOf(el.fsPath);
      if (logic && isLogicExcluded(el.project.cproject, logic)) {
        el.contextValue = `${el.contextValue}.excluded`;
      }
    }
    return el;
  }

  /** directory of the project inside its workspace folder, e.g. "I2C copy" */
  private projectLocation(proj: MrsProject): string | undefined {
    const wf = vscode.workspace.workspaceFolders?.find(
      (f) => proj.root === f.uri.fsPath || proj.root.startsWith(f.uri.fsPath + path.sep)
    );
    if (!wf) return path.basename(path.dirname(proj.root));
    const rel = path.relative(wf.uri.fsPath, proj.root);
    return rel ? rel.split(path.sep).join('/') : undefined;
  }

  getChildren(el?: TreeNode): TreeNode[] {
    if (!el) {
      const solutions = this.store.solutionList;
      const memberKeys = new Set(solutions.flatMap((s) => s.members.map((m) => ProjectStore.key(m.root))));
      const standalone = this.store.all.filter((p) => !memberKeys.has(ProjectStore.key(p.root)));
      if (!solutions.length && !standalone.length) {
        return [new TreeNode('empty', 'No MRS project', vscode.TreeItemCollapsibleState.None)];
      }
      const nodes: TreeNode[] = solutions.map(
        (s) => new TreeNode('solution', s.name, vscode.TreeItemCollapsibleState.Expanded, s.dir, undefined, undefined, s)
      );
      for (const p of standalone) {
        // projects start collapsed: auto-expanding every linked folder makes
        // multi-project workspaces unreadable
        nodes.push(new TreeNode('project', p.projectName, vscode.TreeItemCollapsibleState.Collapsed, p.root, p));
      }
      return nodes;
    }
    if (el.nodeType === 'solution' && el.solution) {
      // member projects render exactly like top-level projects
      return el.solution.members.map(
        (p) => new TreeNode('project', p.projectName, vscode.TreeItemCollapsibleState.Collapsed, p.root, p)
      );
    }
    const proj = el.project;
    if (!proj) return [];
    try {
      proj.reload();
    } catch {
      return [];
    }

    if (el.nodeType === 'project') {
      const nodes: TreeNode[] = [];
      for (const link of proj.projectFile.linkedResources) {
        if (link.type === 2) {
          nodes.push(
            new TreeNode(
              'linkedFolder',
              link.name,
              fs.existsSync(link.location) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
              link.location,
              proj,
              link.name
            )
          );
        }
      }
      // real (non-linked) top-level folders, skipping build/config dirs;
      // excluded-from-build folders sink below the included ones
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(proj.root, { withFileTypes: true });
      } catch {
        // ignore
      }
      const linkedNames = new Set(proj.projectFile.linkedResources.map((l) => l.name));
      const isNodeExcluded = (fsPath: string): boolean => {
        const logic = proj.logicPathOf(fsPath);
        return !!logic && isLogicExcluded(proj.cproject, logic);
      };
      const realFolders = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'obj' && !linkedNames.has(e.name))
        .map((e) => ({ e, full: path.join(proj.root, e.name) }))
        .sort((a, b) => {
          const ex = (isNodeExcluded(a.full) ? 1 : 0) - (isNodeExcluded(b.full) ? 1 : 0);
          return ex || a.e.name.localeCompare(b.e.name);
        })
        .map(({ e, full }) => new TreeNode('folder', e.name, vscode.TreeItemCollapsibleState.Collapsed, full, proj));
      nodes.push(...realFolders);
      nodes.push(new TreeNode('products', proj.cproject.configName, vscode.TreeItemCollapsibleState.Collapsed, proj.buildDir, proj));
      return nodes;
    }

    if (el.nodeType === 'products' && el.fsPath) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(el.fsPath, { withFileTypes: true });
      } catch {
        // ignore
      }
      // build artifacts: no build-config context menu (exclusion etc.)
      return entries
        .filter((e) => e.isFile())
        .map((e) => {
          const n = new TreeNode('file', e.name, vscode.TreeItemCollapsibleState.None, path.join(el.fsPath!, e.name), proj);
          n.contextValue = 'outputFile';
          return n;
        });
    }

    if ((el.nodeType === 'linkedFolder' || el.nodeType === 'folder') && el.fsPath) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(el.fsPath, { withFileTypes: true });
      } catch {
        // ignore
      }
      // excluded-from-build resources (files and folders) sort last, so the
      // compiled sources stay grouped at the top; dirs before files, then by name
      const isNodeExcluded = (fsPath: string): boolean => {
        const logic = proj.logicPathOf(fsPath);
        return !!logic && isLogicExcluded(proj.cproject, logic);
      };
      return entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({ e, full: path.join(el.fsPath!, e.name) }))
        .sort((a, b) => {
          const ex = (isNodeExcluded(a.full) ? 1 : 0) - (isNodeExcluded(b.full) ? 1 : 0);
          if (ex) return ex;
          if (a.e.isDirectory() !== b.e.isDirectory()) return a.e.isDirectory() ? -1 : 1;
          return a.e.name.localeCompare(b.e.name);
        })
        .map(
          ({ e, full }) =>
            new TreeNode(
              e.isDirectory() ? 'folder' : 'file',
              e.name,
              e.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
              full,
              proj
            )
        );
    }
    return [];
  }
}
