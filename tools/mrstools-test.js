/*
 * MRS Tools path resolution tests: all tool executables must resolve against
 * the real installation (MRS2, and MRS3 when present); missing installations
 * degrade to empty strings. Also pins the MRS3-only WCHToolKit menu gating.
 */
const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const { resolveMrsTools } = require('../out/core/mrsTools.js');

// prefer an env override, then the common install roots — lets the
// real-install assertions run on any machine with MRS2 installed
const MRS2_ROOT =
  process.env.MRS2_HOME ||
  ['C:/MounRiver/MounRiver_Studio2', 'D:/MounRiver/MounRiver_Studio2'].find((r) =>
    fs.existsSync(path.join(r, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'manifest.json'))
  );
const WIN32 = MRS2_ROOT ? `${MRS2_ROOT}/resources/app/resources/win32` : 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32';
const asInstall = (root, win32) => ({
  root,
  resourcesWin32: win32.replace(/\//g, '\\'),
  components: '',
  makeBin: '',
  openocdExe: '',
  openocdCfg: '',
  linkUtilityExe: path.join(win32, 'components', 'WCH', 'Others', 'SWDTool', 'default', 'WCH-LinkUtility.exe'),
  toolchains: [],
});

if (fs.existsSync(path.join(WIN32, 'components', 'WCH', 'manifest.json'))) {
  const t = resolveMrsTools(asInstall(MRS2_ROOT, WIN32));
  check('linkUtility resolved', !!t.linkUtility && fs.existsSync(t.linkUtility));
  check('ispStudio resolved (WchIspStudio.exe)', !!t.ispStudio && fs.existsSync(t.ispStudio) && /WchIspStudio\.exe$/.test(t.ispStudio));
  check('touchkeyTool resolved (WCHTouchKeyTool.exe)', !!t.touchkeyTool && fs.existsSync(t.touchkeyTool) && /WCHTouchKeyTool\.exe$/.test(t.touchkeyTool));
  check('uiDesigner resolved (WCHGUIDesigner.exe)', !!t.uiDesigner && fs.existsSync(t.uiDesigner) && /WCHGUIDesigner\.exe$/.test(t.uiDesigner));
  check('hexBinStudio resolved (flat others layout)', !!t.hexBinStudio && fs.existsSync(t.hexBinStudio) && /HexBinStudio\.exe$/.test(t.hexBinStudio));
  check('comTransmit resolved (flat others layout)', !!t.comTransmit && fs.existsSync(t.comTransmit) && /COMTransmit\.exe$/.test(t.comTransmit));
  check('all six shared tools present', [t.linkUtility, t.ispStudio, t.touchkeyTool, t.uiDesigner, t.hexBinStudio, t.comTransmit].every((p) => !!p));
  // MRS2 ships no WCHToolKit component: the MRS3-only entry stays empty here
  check('MRS2: no WCHToolKit component (MRS3-only tool) -> empty', t.wchToolKit === '');
} else {
  console.log('SKIP  real MRS2 installation not present');
}

// MRS3 — the component exists only there (env override, conventional roots, or
// the dev machine's test copy)
const MRS3_ROOT =
  process.env.MRS3_HOME ||
  ['C:/MounRiver/MounRiver_Studio3', 'D:/MounRiver/MounRiver_Studio3', 'F:/MyProjects/MRS2_VSCODE/MRS3/MounRiver_Studio3'].find((r) =>
    fs.existsSync(path.join(r, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'manifest.json'))
  );
if (MRS3_ROOT) {
  const t3 = resolveMrsTools(asInstall(MRS3_ROOT, `${MRS3_ROOT}/resources/app/resources/win32`));
  check(
    'MRS3: WCHToolKit resolved (WCHToolKit.exe)',
    !!t3.wchToolKit && fs.existsSync(t3.wchToolKit) && /WCHToolKit\.exe$/.test(t3.wchToolKit)
  );
  check('MRS3: the shared tools resolve there too', !!t3.ispStudio && !!t3.comTransmit && !!t3.hexBinStudio);
} else {
  console.log('SKIP  real MRS3 installation not present');
}

// the menu item is gated on the ACTIVE installation being MRS3
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const cmd = pkg.contributes.commands.find((c) => c.command === 'mrvc.wchToolKit');
  check('menu: the mrvc.wchToolKit command is declared', !!cmd && typeof cmd.title === 'string');
  const item = pkg.contributes.menus['view/title'].find((m) => m.command === 'mrvc.wchToolKit');
  check('menu: it lives in the tools group of the view title menu', !!item && item.group === '5_tools@7');
  check('menu: shown only when MRS3 is the active installation', !!item && item.when.includes('mrvc.mrs3Active'));
  const nls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf-8'));
  const nlsZh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.zh-cn.json'), 'utf-8'));
  check(
    'menu: both titles exist and mark the MRS3-only tool',
    /MRS3/.test(nls['command.mrvc.wchToolKit.title'] ?? '') && /MRS3/.test(nlsZh['command.mrvc.wchToolKit.title'] ?? '')
  );
}

// missing installation -> all empty, no throw
const empty = resolveMrsTools({
  root: '', resourcesWin32: 'Z:/no/such/dir', components: '', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [],
});
check('missing installation degrades to empty paths', Object.values(empty).every((v) => v === ''));

console.log(failures ? `\n${failures} FAILURES` : '\nall mrsTools tests passed');
process.exit(failures ? 1 : 0);
