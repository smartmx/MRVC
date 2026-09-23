/**
 * MRS project tree: projects, linked folders, source folders and products.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectStore, MrsProject } from './projects';

type NodeType = 'project' | 'linkedFolder' | 'folder' | 'file' | 'products' | 'empty';

export class TreeNode extends vscode.TreeItem {
  constructor(
    public readonly nodeType: NodeType,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly fsPath?: string,
    public readonly project?: MrsProject,
    public readonly linkedName?: string
  ) {
    super(label, collapsibleState);
    this.contextValue = nodeType === 'project' ? 'project' : nodeType === 'linkedFolder' ? 'linkedFolder' : nodeType;
  }
}

/**
 * Tree decorations: linked (virtual) folders get a blue tint + hover
 * tooltip; build output directories get the custom red color. Same
 * mechanism VSCode uses for git decorations.
 */
export class TreeDecorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private links = new Set<string>();
  private outputs = new Set<string>();

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

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const key = ProjectStore.key(uri.fsPath);
    if (this.links.has(key)) {
      return new vscode.FileDecoration(undefined, 'Linked folder (external directory)', new vscode.ThemeColor('charts.blue'));
    }
    if (this.outputs.has(key)) {
      return new vscode.FileDecoration(undefined, 'Build output directory', new vscode.ThemeColor('mrvc.outputDirectory'));
    }
    return undefined;
  }
}

export class ProjectTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private store: ProjectStore) {
    store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    // With `resourceUri` set and no explicit iconPath, VSCode renders the
    // icon from the ACTIVE file icon theme (per-extension for files: .c,
    // .h, .ld, ... get their theme icons exactly like the Explorer).
    if (el.fsPath && el.nodeType !== 'project') {
      el.resourceUri = vscode.Uri.file(el.fsPath);
    }
    if (el.nodeType === 'file' && el.fsPath) {
      el.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(el.fsPath)] };
    }
    if (el.nodeType === 'project') {
      if (el.project === this.store.active) {
        el.iconPath = new vscode.ThemeIcon('folder-active');
        el.description = 'active';
      } else {
        el.resourceUri = vscode.Uri.file(el.fsPath!);
      }
    }
    return el;
  }

  getChildren(el?: TreeNode): TreeNode[] {
    if (!el) {
      const projects = this.store.all;
      if (!projects.length) return [new TreeNode('empty', 'No MRS project', vscode.TreeItemCollapsibleState.None)];
      return projects.map(
        (p) => new TreeNode('project', p.projectName, vscode.TreeItemCollapsibleState.Expanded, p.root, p)
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
      // real (non-linked) top-level folders, skipping build/config dirs
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(proj.root, { withFileTypes: true });
      } catch {
        // ignore
      }
      const linkedNames = new Set(proj.projectFile.linkedResources.map((l) => l.name));
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.') || e.name === 'obj' || linkedNames.has(e.name)) continue;
        nodes.push(
          new TreeNode('folder', e.name, vscode.TreeItemCollapsibleState.Collapsed, path.join(proj.root, e.name), proj)
        );
      }
      nodes.push(new TreeNode('products', `${proj.cproject.configName} (output)`, vscode.TreeItemCollapsibleState.Collapsed, proj.buildDir, proj));
      return nodes;
    }

    if (el.nodeType === 'products' && el.fsPath) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(el.fsPath, { withFileTypes: true });
      } catch {
        // ignore
      }
      return entries
        .filter((e) => e.isFile())
        .map((e) => new TreeNode('file', e.name, vscode.TreeItemCollapsibleState.None, path.join(el.fsPath!, e.name), proj));
    }

    if ((el.nodeType === 'linkedFolder' || el.nodeType === 'folder') && el.fsPath) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(el.fsPath, { withFileTypes: true });
      } catch {
        // ignore
      }
      return entries
        .filter((e) => !e.name.startsWith('.'))
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
        .map(
          (e) =>
            new TreeNode(
              e.isDirectory() ? 'folder' : 'file',
              e.name,
              e.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
              path.join(el.fsPath!, e.name),
              proj
            )
        );
    }
    return [];
  }
}
