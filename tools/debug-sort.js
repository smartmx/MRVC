/*
 * Throwaway check: does the tree-sort comparator really sink excluded
 * resources? Replicates MrsProject.logicPathOf + the tree.ts comparator on
 * real projects (no vscode imports — projects.ts can't be required here).
 */
const path = require('path');
const fs = require('fs');
const { Cproject } = require('../out/core/cproject.js');
const { readProjectFile } = require('../out/core/projectFile.js');
const { isLogicExcluded } = require('../out/core/scan.js');

function logicPathOf(proj, fsPath) {
  const rel = path.relative(proj.root, fsPath);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  const link = proj.projectFile.linkedResources.find(
    (l) => l.type === 2 && (fsPath === l.location || fsPath.startsWith(l.location + path.sep))
  );
  if (!link) return undefined;
  return path.join(link.name, path.relative(link.location, fsPath)).split(path.sep).join('/');
}

function listOrdered(proj, dirFsPath) {
  const isNodeExcluded = (p) => {
    const logic = logicPathOf(proj, p);
    return !!logic && isLogicExcluded(proj.cproject, logic);
  };
  const entries = fs
    .readdirSync(dirFsPath, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => ({ e, full: path.join(dirFsPath, e.name) }))
    .sort((a, b) => {
      const ex = (isNodeExcluded(a.full) ? 1 : 0) - (isNodeExcluded(b.full) ? 1 : 0);
      if (ex) return ex;
      if (a.e.isDirectory() !== b.e.isDirectory()) return a.e.isDirectory() ? -1 : 1;
      return a.e.name.localeCompare(b.e.name);
    });
  return entries.map((x) => `${x.e.isDirectory() ? '[D]' : '[f]'} ${x.e.name}${isNodeExcluded(x.full) ? '  <-- EXCLUDED' : ''}`);
}

const BLE = 'F:/CH585/EVT/V1_2/EXAM/BLE/BLE_UART';
const proj = { root: BLE, projectFile: readProjectFile(BLE), cproject: Cproject.load(BLE) };

console.log('=== APP (real folder, named entry) ===');
for (const l of listOrdered(proj, path.join(BLE, 'APP'))) console.log(' ', l);
console.log('=== APP/ble_uart_service (excluded files live here) ===');
for (const l of listOrdered(proj, path.join(BLE, 'APP', 'ble_uart_service'))) console.log(' ', l);

const spd = proj.cproject.linkedFolders.get('StdPeriphDriver');
if (spd && fs.existsSync(spd)) {
  console.log('=== StdPeriphDriver (linked folder, named entry) — first 12 ===');
  for (const l of listOrdered(proj, spd).slice(0, 12)) console.log(' ', l);
  const ordered = listOrdered(proj, spd);
  const firstExcluded = ordered.findIndex((l) => l.includes('EXCLUDED'));
  const lastIncluded = ordered.reduce((acc, l, i) => (!l.includes('EXCLUDED') ? i : acc), -1);
  console.log(`  -> all EXCLUDED entries after all included: ${firstExcluded < 0 || firstExcluded > lastIncluded}`);
}

// cross-project shared link: same physical LIB folder linked by two projects
// with different exclusion lists — state must differ per project
{
  const BLE = 'F:/CH587/EVT/V1_0/EXAM/BLE';
  const load = (name) => {
    const root = path.join(BLE, name);
    return { root, projectFile: readProjectFile(root), cproject: Cproject.load(root) };
  };
  const usb = load('BLE_USB');
  const oua = load('OnlyUpdateApp_Peripheral');
  const ipCore = path.join(BLE, 'LIB', 'ip_core.c');
  const perProject = (p) => {
    const logic = logicPathOf(p, ipCore);
    return logic && isLogicExcluded(p.cproject, logic);
  };
  console.log('=== shared LIB/ip_core.c ===');
  console.log(`  BLE_USB excluded:              ${perProject(usb)}  (expect false)`);
  console.log(`  OnlyUpdateApp_Peripheral excluded: ${perProject(oua)}  (expect true)`);

// USBPD: token case (ch58x_led.c) differs from disk case (CH58x_led.c) —
// must count as excluded on Windows and sink to the end of the listing
{
  const root = 'F:/CH587/EVT/V1_0/EXAM/USBPD';
  const p = { root, projectFile: readProjectFile(root), cproject: Cproject.load(root) };
  const led = path.join(root, '..', 'SRC', 'StdPeriphDriver', 'CH58x_led.c');
  const logic = logicPathOf(p, fs.realpathSync(led));
  console.log('=== USBPD case-mismatched LED driver ===');
  console.log(`  CH58x_led.c excluded: ${logic && isLogicExcluded(p.cproject, logic)}  (expect true on win32)`);
  const spdDir = p.cproject.linkedFolders.get('StdPeriphDriver');
  const ordered = listOrdered(p, spdDir).filter((l) => l.endsWith('.c'));
  const firstExcluded = ordered.findIndex((l) => l.includes('EXCLUDED'));
  const lastIncluded = ordered.reduce((acc, l, i) => (!l.includes('EXCLUDED') ? i : acc), -1);
  console.log(`  -> all EXCLUDED .c entries after all included: ${firstExcluded < 0 || firstExcluded > lastIncluded}`);
  console.log('  tail:', ordered.slice(-4).map((l) => l.split('  ')[0].trim()).join(' | '));
}
}
