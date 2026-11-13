/**
 * MRS project tree: projects, linked folders, source folders and products.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectStore, MrsProject, MrsSolution } from './projects';
import { isLogicExcluded } from '../core/scan';
import { RemovedResource, listRemovedResources } from '../core/projectFile';
import { toPosix } from '../core/macros';
import { themeColorFor } from '../core/colorMarks';
import { t } from '../core/i18n';

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

  /** copy the mutable TreeItem surface from a freshly computed twin. The
   *  provider keeps ONE object identity per tree slot (see nodeCache) so a
   *  scoped onDidChangeTreeData(el) fire reaches VSCode; the content itself
   *  is recomputed on every render and merged into the cached instance. */
  updateFrom(fresh: TreeNode): void {
    this.label = fresh.label;
    this.collapsibleState = fresh.collapsibleState;
    this.contextValue = fresh.contextValue;
    this.description = fresh.description;
    this.tooltip = fresh.tooltip;
    this.iconPath = fresh.iconPath;
    this.command = fresh.command;
    this.resourceUri = fresh.resourceUri;
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
  /** file flag colors (abs key → color alias), fed by the Flag commands */
  private flags = new Map<string, string>();

  private fireChanged(next: Set<string>, prev: Set<string>): void {
    const changed = [...new Set([...next, ...prev])];
    if (changed.length) this._onDidChange.fire(undefined);
  }

  setFlags(next: Map<string, string>): void {
    // only keys whose color actually changed (or added/removed) — firing on
    // every store change would recompute all decorations for nothing
    const changed = new Set<string>();
    for (const [k, c] of next) {
      if (this.flags.get(k) !== c) changed.add(k);
    }
    for (const k of this.flags.keys()) {
      if (!next.has(k)) changed.add(k);
    }
    this.flags = next;
    if (changed.size) this._onDidChange.fire(undefined);
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
      // fire undefined (= all decorations changed): tree nodes carry the
      // project key in their resourceUri query, so firing bare file URIs
      // would miss the per-node cache entries and greying would never update
      this._onDidChange.fire(undefined);
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
    // file flag (MRS2 "Flag" parity): colored dot badge — takes precedence
    // over the excluded grey (an explicit user action wins)
    const flag = this.flags.get(key);
    if (flag) {
      return new vscode.FileDecoration('●', `Flagged: ${flag}`, new vscode.ThemeColor(themeColorFor(flag)));
    }
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

  /** ONE TreeNode identity per tree slot. getChildren recomputes content on
   *  every render, but scoped refreshes (onTreeDirsChanged) fire cached
   *  instances — VSCode matches fired elements by identity, so a fresh twin
   *  would silently miss. Keyed by project|nodeType|fsPath|linkedName. */
  private readonly nodeCache = new Map<string, TreeNode>();
  /** fsPath → nodes at that path (a shared linked folder appears under
   *  several projects) — the scoped-refresh lookup index */
  private readonly nodesByPath = new Map<string, Set<TreeNode>>();
  /** last-rendered child nodes per expanded parent — lets recordChildren
   *  prune leaf identities that vanished (deleted/renamed/cleaned obj) so
   *  long sessions don't accumulate stale TreeNodes (round20 P3) */
  private readonly childrenByParent = new Map<TreeNode, Set<TreeNode>>();
  /** last-rendered child fsPaths per expanded parent — lets a scoped refresh
   *  detect "the parent's list is missing a directory that now exists"
   *  (deleted-then-recreated obj) without re-rendering it on every event */
  private readonly renderedChildren = new Map<TreeNode, Set<string>>();

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
      // drop cached identities of projects that are gone (removed / renamed)
      // and of solutions that are gone (closed / re-added with a fresh object
      // — a remove→add must NOT keep rendering the old member list, round20 P2)
      const validRoots = new Set(store.all.map((p) => ProjectStore.key(p.root)));
      const validSolFiles = new Set(store.solutionList.map((s) => MrsSolution.key(s.file)));
      for (const [key, el] of this.nodeCache) {
        const projectGone = !!el.project && !validRoots.has(ProjectStore.key(el.project.root));
        const solutionGone = !!el.solution && !validSolFiles.has(MrsSolution.key(el.solution.file));
        if (projectGone || solutionGone) {
          this.nodeCache.delete(key);
          this.renderedChildren.delete(el);
          this.childrenByParent.delete(el);
          if (el.fsPath) this.unindexNode(el);
        }
      }
      this.refresh();
    });
    // watcher-scoped refreshes: only the nodes at the changed directories
    store.onTreeDirsChanged?.((dirs) => this.refreshDirs(dirs));
  }

  private static nodeKey(el: TreeNode): string {
    const proj = el.project ? ProjectStore.key(el.project.root) : '';
    // solution identity rides on the .wvsln FILE: two solutions may share a
    // directory, and a remove→add reuses the path but must be a fresh node
    const sol = el.solution ? MrsSolution.key(el.solution.file) : '';
    return `${proj}|${el.nodeType}|${el.fsPath ?? ''}|${el.linkedName ?? ''}|${sol}`;
  }

  /** return the cached identity for this tree slot, merging the freshly
   *  computed content into it (or registering the fresh node on first render) */
  private cached<T extends TreeNode>(fresh: T): T {
    const key = ProjectTreeProvider.nodeKey(fresh);
    const hit = this.nodeCache.get(key);
    if (!hit || hit === fresh) {
      this.nodeCache.set(key, fresh);
      if (fresh.fsPath) {
        const pathKey = ProjectStore.key(fresh.fsPath);
        const set = this.nodesByPath.get(pathKey) ?? new Set<TreeNode>();
        set.add(fresh);
        this.nodesByPath.set(pathKey, set);
      }
      return fresh;
    }
    hit.updateFrom(fresh);
    return hit as T;
  }

  private unindexNode(el: TreeNode): void {
    if (!el.fsPath) return;
    const pathKey = ProjectStore.key(el.fsPath);
    const set = this.nodesByPath.get(pathKey);
    if (!set) return;
    set.delete(el);
    if (!set.size) this.nodesByPath.delete(pathKey);
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  /** scoped refresh: re-read ONLY the tree nodes at these paths — a watcher
   *  saw a file appear/disappear in that directory, or the build output dir
   *  changed. Nodes VSCode has never rendered have no cached identity and
   *  need no refresh: they fetch fresh children when expanded. Two extra
   *  cases keep the tree correct without a full fire:
   *  - the directory EXISTS but has no rendered node yet (first-time obj/,
   *    a freshly created source dir): fire the nearest cached ANCESTOR so
   *    the new row appears in its parent's children (round19 P2);
   *  - a fired node's own directory no longer exists (obj deleted, folder
   *    removed): also fire its parent so the stale row disappears. */
  refreshDirs(dirs: string[]): void {
    const fired = new Set<TreeNode>();
    for (const dir of dirs) {
      const exists = fs.existsSync(dir);
      const dirKey = ProjectStore.key(dir);
      const set = this.nodesByPath.get(dirKey);
      if (set && set.size) {
        for (const el of set) fired.add(el);
        if (exists) {
          // the row may be missing from a parent rendered BEFORE the dir
          // reappeared (deleted-then-recreated obj): fire the parents whose
          // last render did not include it — never on every event
          const parents = this.nodesByPath.get(ProjectStore.key(path.dirname(dir)));
          if (parents) {
            for (const p of parents) {
              const rendered = this.renderedChildren.get(p);
              if (rendered && !rendered.has(dirKey)) fired.add(p);
            }
          }
        }
      } else if (exists) {
        // no node rendered at this path yet (first-time obj, a freshly
        // created source dir): fire the nearest cached ANCESTOR so the new
        // row appears in its parent's children (round19 P2)
        let cur = dir;
        for (;;) {
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
          const parentSet = this.nodesByPath.get(ProjectStore.key(cur));
          if (parentSet && parentSet.size) {
            for (const el of parentSet) fired.add(el);
            break;
          }
        }
      }
    }
    for (const el of fired) {
      this._onDidChange.fire(el);
      if (el.fsPath && !fs.existsSync(el.fsPath)) {
        const parentSet = this.nodesByPath.get(ProjectStore.key(path.dirname(el.fsPath)));
        if (parentSet) {
          for (const p of parentSet) {
            if (!fired.has(p)) {
              fired.add(p);
              this._onDidChange.fire(p);
            }
          }
        }
      }
    }
  }

  /** remember which child nodes/paths a parent's last render contained.
   *  The node set drives leaf-cache pruning (a child absent from the new
   *  render has vanished — its TreeNode identity is dropped); the path set
   *  lets scoped refresh detect "the parent is missing a directory that
   *  now exists" (deleted-then-recreated obj). */
  private recordChildren(parent: TreeNode, nodes: TreeNode[]): TreeNode[] {
    const next = new Set(nodes);
    const prev = this.childrenByParent.get(parent);
    if (prev) {
      for (const old of prev) {
        if (next.has(old)) continue;
        // leaf vanished (deleted / renamed / build artifact cleaned): drop
        // its cache identity so long sessions don't accumulate stale nodes
        const key = ProjectTreeProvider.nodeKey(old);
        if (this.nodeCache.get(key) === old) this.nodeCache.delete(key);
        this.renderedChildren.delete(old);
        this.unindexNode(old);
      }
    }
    this.childrenByParent.set(parent, next);
    const paths = new Set<string>();
    for (const n of nodes) {
      if (n.fsPath) paths.add(ProjectStore.key(n.fsPath));
    }
    this.renderedChildren.set(parent, paths);
    return nodes;
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
        return [this.cached(new TreeNode('empty', t('noMrsProjectNode'), vscode.TreeItemCollapsibleState.None))];
      }
      const nodes: TreeNode[] = solutions.map(
        (s) => this.cached(new TreeNode('solution', s.name, vscode.TreeItemCollapsibleState.Expanded, s.dir, undefined, undefined, s))
      );
      for (const p of standalone) {
        // projects start collapsed: auto-expanding every linked folder makes
        // multi-project workspaces unreadable
        nodes.push(this.cached(new TreeNode('project', p.projectName, vscode.TreeItemCollapsibleState.Collapsed, p.root, p)));
      }
      return nodes;
    }
    if (el.nodeType === 'solution' && el.solution) {
      // member projects render exactly like top-level projects
      return el.solution.members.map(
        (p) => this.cached(new TreeNode('project', p.projectName, vscode.TreeItemCollapsibleState.Collapsed, p.root, p))
      );
    }
    const proj = el.project;
    if (!proj) return [];
    // NOTE: no re-parse here — the per-project config + source watchers in
    // ProjectStore keep MrsProject fresh and fire the tree refresh; parsing
    // every expanded project's XML on each render made saves O(projects)
    if (!proj.cproject || !proj.projectFile) return [];

    if (el.nodeType === 'project') {
      const nodes: TreeNode[] = [];
      for (const link of proj.projectFile.linkedResources) {
        if (link.type === 2) {
          nodes.push(
            this.cached(
              new TreeNode(
                'linkedFolder',
                link.name,
                fs.existsSync(link.location) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                link.location,
                proj,
                link.name
              )
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
      // logically-removed resources (filteredResources) are invisible
      const removedRoot = new Set(listRemovedResources(proj.root).filter((r) => !r.parentLogic).map((r) => r.name));
      const isNodeExcluded = (fsPath: string): boolean => {
        const logic = proj.logicPathOf(fsPath);
        return !!logic && isLogicExcluded(proj.cproject, logic);
      };
      const realFolders = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'obj' && !linkedNames.has(e.name) && !removedRoot.has(e.name))
        .map((e) => ({ e, full: path.join(proj.root, e.name) }))
        .sort((a, b) => {
          const ex = (isNodeExcluded(a.full) ? 1 : 0) - (isNodeExcluded(b.full) ? 1 : 0);
          return ex || a.e.name.localeCompare(b.e.name);
        })
        .map(({ e, full }) => this.cached(new TreeNode('folder', e.name, vscode.TreeItemCollapsibleState.Collapsed, full, proj)));
      nodes.push(...realFolders);
      // root-level files (11.c etc.) — the scanner compiles them, the tree
      // must show them too; project management files (.wvproj/.template/
      // .launch) stay hidden; excluded ones sink below the included ones
      const rootFiles = entries
        .filter((e) => e.isFile() && !e.name.startsWith('.') && !/\.(wvproj|template|launch)$/i.test(e.name) && !removedRoot.has(e.name))
        .map((e) => ({ e, full: path.join(proj.root, e.name) }))
        .sort((a, b) => {
          const ex = (isNodeExcluded(a.full) ? 1 : 0) - (isNodeExcluded(b.full) ? 1 : 0);
          return ex || a.e.name.localeCompare(b.e.name);
        })
        .map(({ e, full }) => this.cached(new TreeNode('file', e.name, vscode.TreeItemCollapsibleState.None, full, proj)));
      nodes.push(...rootFiles);
      // the output node only exists while the directory does — deleting obj
      // (MRVC menu or Explorer) must make it disappear on the next render
      if (fs.existsSync(proj.buildDir)) {
        nodes.push(this.cached(new TreeNode('products', proj.cproject.configName, vscode.TreeItemCollapsibleState.Collapsed, proj.buildDir, proj)));
      }
      return this.recordChildren(el, nodes);
    }

    if (el.nodeType === 'products' && el.fsPath) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(el.fsPath, { withFileTypes: true });
      } catch {
        // ignore
      }
      // build artifacts: no build-config context menu (exclusion etc.)
      return this.recordChildren(
        el,
        entries
          .filter((e) => e.isFile())
          .map((e) => {
            const n = this.cached(new TreeNode('file', e.name, vscode.TreeItemCollapsibleState.None, path.join(el.fsPath!, e.name), proj));
            n.contextValue = 'outputFile';
            return n;
          })
      );
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
      // logically-removed entries under THIS folder are invisible
      const parentLogic = toPosix(proj.logicPathOf(el.fsPath!) ?? '');
      const removedHere = new Set(
        listRemovedResources(proj.root)
          .filter((r) => r.parentLogic === parentLogic)
          .map((r) => r.name)
      );
      return this.recordChildren(
        el,
        entries
          .filter((e) => !e.name.startsWith('.') && !removedHere.has(e.name))
          .map((e) => ({ e, full: path.join(el.fsPath!, e.name) }))
          .sort((a, b) => {
            const ex = (isNodeExcluded(a.full) ? 1 : 0) - (isNodeExcluded(b.full) ? 1 : 0);
            if (ex) return ex;
            if (a.e.isDirectory() !== b.e.isDirectory()) return a.e.isDirectory() ? -1 : 1;
            return a.e.name.localeCompare(b.e.name);
          })
          .map(
            ({ e, full }) =>
              this.cached(
                new TreeNode(
                  e.isDirectory() ? 'folder' : 'file',
                  e.name,
                  e.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                  full,
                  proj
                )
              )
          )
      );
    }
    return [];
  }
}
