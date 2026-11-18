/*
 * Info view row layout (user requests 2026-11-18):
 *   0 effective configuration (click -> settings)
 *   1 active project
 *   2 SDI Printf session state
 *   3 Flash power output rail — SESSION state (core/powerState): every
 *     window opens at 3.3 V, only a manual switch (mrvc.powerOutputRail
 *     QuickPick) raises it to 5 V, closing the window restores 3.3 V
 *   4 Power-Off Reset action (click -> mrvc.powerOffReset)
 *
 * The workspace and toolchain rows were REMOVED (user request): the
 * workspace is visible in the explorer itself and GCC resolution stays
 * inside the build path. Status rows stay display-only — no hardware query
 * runs on a repaint.
 *
 * Pure Node with the vscode/projects modules stubbed: the test drives
 * InfoTreeProvider.getChildren() against mutable settings and the session
 * rail state, and checks the rows' labels/descriptions/icons/commands.
 */
const Module = require('module');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// mutable mrvc.* settings the stub hands to infoTree.ts
let settings = {};

const vscodeStub = {
  workspace: {
    get name() {
      return 'DemoWS';
    },
    get workspaceFolders() {
      return [{ uri: { fsPath: 'C:/work/DemoWS' } }];
    },
    getConfiguration: () => ({ get: (key, dflt) => (key in settings ? settings[key] : dflt) }),
  },
  TreeItem: class {
    constructor(label, state) {
      this.label = label;
      this.collapsibleState = state;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
};

const projectsStub = {
  selectMrsInstall: () => ({ install: { label: 'MounRiver Studio 3', kind: 'ide', root: 'C:/MRS3', toolchains: [] }, pinnedFellBack: undefined }),
  ProjectStore: class {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  if (request === './projects' && parent && /infoTree\.js$/.test(parent.filename || '')) return projectsStub;
  return originalLoad.apply(this, arguments);
};

try {
  const { InfoTreeProvider } = require('../out/vscode/infoTree.js');
  const { powerOutputRail, notePowerOutputRail, resetPowerOutputRail, onPowerOutputRailChanged } = require('../out/core/powerState.js');
  const store = { active: { projectName: 'Demo', cproject: {} } };
  const view = new InfoTreeProvider(store);

  // 1. default layout: five rows, no workspace / toolchain row anywhere
  settings = {};
  resetPowerOutputRail();
  let rows = view.getChildren();
  check('info: five rows (config / project / SDI / power output / reset)', rows.length === 5);
  check('info: no toolchain row anywhere', !rows.some((r) => /GCC|riscv-wch/.test(String(r.label))));
  check('info: no workspace row (the explorer already shows it)', !rows.some((r) => r.description === 'Workspace' || r.iconPath.id === 'root-folder'));
  check('info: config row keeps the install root as description', rows[0].description === 'C:/MRS3' && rows[0].iconPath.id === 'vm');
  check('info: project row follows the config row', rows[1].description === 'Active project' && rows[1].label === 'Demo');
  check('info: SDI Printf row stays the third row', rows[2].description === 'SDI Printf');

  // 2. Flash power output row: the SESSION rail, 3.3 V at window start
  const rail = rows[3];
  check('info: power output row opens at the default 3.3 V', rail.label === '3.3 V' && powerOutputRail() === '3v3');
  check('info: power output row carries the Flash power output category', rail.description === 'Flash power output');
  check('info: power output row click opens the switch QuickPick command', rail.command && rail.command.command === 'mrvc.powerOutputRail');
  check('info: power output row uses the zap icon', rail.iconPath.id === 'zap');
  check('info: power output tooltip explains the session semantics', /every window opens at 3\.3 V/.test(rail.tooltip) && /never persisted/.test(rail.tooltip));
  check('info: power output tooltip names the link gate', /LinkE/.test(rail.tooltip));

  // 3. a manual switch is the only way to 5 V — and the view repaints via
  //    the change event (the same wiring the extension installs)
  let repaints = 0;
  const sub = onPowerOutputRailChanged(() => repaints++);
  notePowerOutputRail('5v');
  rows = view.getChildren();
  check('info: after a manual switch the row shows 5 V', rows[3].label === '5 V' && powerOutputRail() === '5v');
  check('info: the rail change fired the repaint event', repaints === 1);
  check('info: a plain setting cannot move the session rail', (() => {
    settings = { 'flash.powerOutput': '5v' };
    const r = view.getChildren();
    settings = {};
    return r[3].label === '5 V' && powerOutputRail() === '5v'; // still 5 V from the switch, setting is inert
  })());
  resetPowerOutputRail();
  rows = view.getChildren();
  check('info: window close equivalent (reset) restores 3.3 V', rows[3].label === '3.3 V' && powerOutputRail() === '3v3');
  check('info: the reset (5 V -> 3.3 V) fired its own repaint', repaints === 2);
  notePowerOutputRail('3v3'); // same-value write is a no-op
  check('info: same-value switch fires no repaint', repaints === 2);
  sub.dispose();

  // 4. Power-Off Reset row moved behind the rail row, still clickable
  const powerRow = rows[4];
  check('info: Power-Off Reset row is present with the WCH-Link rail category', powerRow.description === 'WCH-Link power rail' && powerRow.command && powerRow.command.command === 'mrvc.powerOffReset' && powerRow.command.arguments[0].project === store.active);
  check('info: Power-Off Reset tooltip mentions rail switching', /power-cycle/.test(powerRow.tooltip));

  // 5. SDI session accounting still drives the third row
  const { noteSdiPrintfEnabled, noteSdiPrintfFailed, noteSdiPrintfNotRequested, resetSdiPrintfStatus } = require('../out/core/sdiState.js');
  noteSdiPrintfEnabled(1700000000000);
  rows = view.getChildren();
  check('info: SDI row mirrors a successful MRVC write', rows[2].iconPath.id === 'pass-filled' && !!rows[2].tooltip);
  noteSdiPrintfFailed('no chip id');
  rows = view.getChildren();
  check('info: SDI row shows a failed/no-chip-id attempt as a warning', rows[2].iconPath.id === 'warning' && /failed/i.test(rows[2].label));
  noteSdiPrintfNotRequested(1700000001000);
  rows = view.getChildren();
  check('info: a download without SDIPrintf changes the row', rows[2].iconPath.id === 'circle-slash');
  resetSdiPrintfStatus();

  // 6. no active project: the reset row degrades to a dash without a command
  const emptyView = new InfoTreeProvider({ active: undefined });
  rows = emptyView.getChildren();
  check('info: without a project the reset row is a bare dash', rows[4].label === '—' && !rows[4].command);
} finally {
  Module._load = originalLoad;
}

console.log(failures ? `\n${failures} FAILURES` : '\nall infotree tests passed');
process.exit(failures ? 1 : 0);
