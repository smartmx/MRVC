// npm-free vscode stub for node tests (removedresources-test loads tree.js)
module.exports = {
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { createTreeView: () => ({}) },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    constructor(label, collapse) {
      this.label = label;
      this.collapsibleState = collapse;
    }
  },
  Uri: {
    file: (f) => ({ fsPath: f }),
    joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
};
