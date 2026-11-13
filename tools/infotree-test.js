/*
 * Info view: the toolchain row must resolve against the SAME effective
 * install the build path uses — i.e. with mrvc.customToolchains merged in.
 * The raw selectMrsInstall() object only carries installed toolchains, so
 * resolving a custom name against it showed None (or the first built-in)
 * even though Build/Flash used the custom toolchain (round-8 P3).
 *
 * Pure Node with the vscode/projects modules stubbed: the test drives
 * InfoTreeProvider.getChildren() against mutable settings and checks the
 * third row's label. Fake trees live in .scratch.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const ROOT = path.join(__dirname, '..', '.scratch', 'infotree');
fs.rmSync(ROOT, { recursive: true, force: true });

/** every path this test writes/reads must stay inside ROOT */
function inside(root, target) {
  const resolved = path.resolve(root, target);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('refusing to touch outside the scratch root: ' + target);
  }
  return resolved;
}

function fakeToolchainDir(name, gccName) {
  const root = inside(ROOT, name);
  const bin = inside(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, path.basename(gccName)), '');
  return root;
}

const builtinDir = fakeToolchainDir('builtin', 'riscv-wch-elf-gcc.exe');
const customDir = fakeToolchainDir('custom', 'riscv-wch-elf-gcc.exe');
const custom2Dir = fakeToolchainDir('custom2', 'riscv32-wch-elf-gcc.exe');

const installed = {
  name: 'GCC12',
  dir: builtinDir,
  compilerC: path.join(builtinDir, 'bin', 'riscv-wch-elf-gcc'),
  compilerCpp: path.join(builtinDir, 'bin', 'riscv-wch-elf-g++'),
  linkerC: path.join(builtinDir, 'bin', 'riscv-wch-elf-gcc'),
  linkerCpp: path.join(builtinDir, 'bin', 'riscv-wch-elf-g++'),
  debugger: path.join(builtinDir, 'bin', 'riscv-wch-elf-gdb'),
  objcopy: path.join(builtinDir, 'bin', 'riscv-wch-elf-objcopy'),
  objdump: path.join(builtinDir, 'bin', 'riscv-wch-elf-objdump'),
  size: path.join(builtinDir, 'bin', 'riscv-wch-elf-size'),
  prefix: 'riscv-wch-elf-',
};

const install = {
  root: inside(ROOT, 'fake-mrs3'),
  resourcesDir: '',
  makeBin: '',
  openocdExe: '',
  openocdCfg: '',
  linkUtilityExe: '',
  kind: 'ide',
  flavor: 'mrs3',
  label: 'MounRiver Studio 3',
  toolchains: [installed],
};

// mutable mrvc.* settings the stub hands to infoTree.ts
let settings = {};

const vscodeStub = {
  workspace: {
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
  selectMrsInstall: () => ({ install, pinnedFellBack: undefined }),
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
  const store = { active: { projectName: 'Demo', cproject: { rvGccVersion: '12', storedPrefix: '' } } };
  const view = new InfoTreeProvider(store);

  // 1. no custom toolchains -> the installed GCC12 is shown
  settings = { toolchain: 'auto' };
  let rows = view.getChildren();
  check('info: four rows (config / project / toolchain / SDI Printf)', rows.length === 4);
  check('info: SDI Printf row is present and starts unknown', rows[3].description === 'SDI Printf' && !!rows[3].label);
  const { noteSdiPrintfEnabled, noteSdiPrintfFailed, noteSdiPrintfNotRequested, resetSdiPrintfStatus } = require('../out/core/sdiState.js');
  noteSdiPrintfEnabled(1700000000000);
  rows = view.getChildren();
  check('info: SDI row mirrors a successful MRVC write', rows[3].iconPath.id === 'pass-filled' && !!rows[3].tooltip);
  noteSdiPrintfFailed('no chip id');
  rows = view.getChildren();
  check('info: SDI row shows a failed/no-chip-id attempt as a warning', rows[3].iconPath.id === 'warning' && /failed/i.test(rows[3].label));
  noteSdiPrintfNotRequested(1700000001000);
  rows = view.getChildren();
  check('info: a download without SDIPrintf changes the row', rows[3].iconPath.id === 'circle-slash');
  resetSdiPrintfStatus();
  check('info: no custom tools -> installed GCC12 resolved', rows[2].label === 'GCC12 (riscv-wch-elf-)');

  // 2. custom toolchain selected -> the MERGED install resolves it (round-8 P3:
  //    the raw install cannot resolve "MyTC" and would show None / GCC12)
  settings = { toolchain: 'MyTC', customToolchains: [{ name: 'MyTC', path: customDir }] };
  rows = view.getChildren();
  check(
    'info: custom toolchain selected -> shows MyTC (custom merged into the install)',
    rows[2].label === 'MyTC (riscv-wch-elf-)'
  );

  // 3. an edit to mrvc.customToolchains / mrvc.toolchain is picked up on the
  //    next repaint (the extension refreshes the view on every mrvc.* change)
  settings = { toolchain: 'MyTC2', customToolchains: [{ name: 'MyTC2', path: custom2Dir }] };
  view.refresh();
  rows = view.getChildren();
  check(
    'info: repaint after a config edit -> shows the new custom name/prefix',
    rows[2].label === 'MyTC2 (riscv32-wch-elf-)'
  );

  // 4. a broken custom entry is skipped, not fatal (merge semantics)
  settings = { toolchain: 'auto', customToolchains: [{ name: 'Gone', path: inside(ROOT, 'missing') }] };
  rows = view.getChildren();
  check('info: unresolvable custom entry -> built-in fallback still renders', rows[2].label === 'GCC12 (riscv-wch-elf-)');
} finally {
  Module._load = originalLoad;
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURES` : '\nall infotree tests passed');
process.exit(failures ? 1 : 0);
