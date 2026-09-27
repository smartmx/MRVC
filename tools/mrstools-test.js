/*
 * MRS Tools path resolution tests: all six tool executables must resolve
 * against the real MRS2 installation; missing installations degrade to
 * empty strings.
 */
const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const { resolveMrsTools } = require(path.join(__dirname, '..', 'out', 'core', 'mrsTools.js'));

const WIN32 = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32';
if (fs.existsSync(path.join(WIN32, 'components', 'WCH', 'manifest.json'))) {
  const install = {
    root: 'C:/MounRiver/MounRiver_Studio2',
    resourcesWin32: WIN32.replace(/\//g, '\\'),
    components: '', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: path.join(WIN32, 'components', 'WCH', 'Others', 'SWDTool', 'default', 'WCH-LinkUtility.exe'), toolchains: [],
  };
  const t = resolveMrsTools(install);
  check('linkUtility resolved', !!t.linkUtility && fs.existsSync(t.linkUtility));
  check('ispStudio resolved (WchIspStudio.exe)', !!t.ispStudio && fs.existsSync(t.ispStudio) && /WchIspStudio\.exe$/.test(t.ispStudio));
  check('touchkeyTool resolved (WCHTouchKeyTool.exe)', !!t.touchkeyTool && fs.existsSync(t.touchkeyTool) && /WCHTouchKeyTool\.exe$/.test(t.touchkeyTool));
  check('uiDesigner resolved (WCHGUIDesigner.exe)', !!t.uiDesigner && fs.existsSync(t.uiDesigner) && /WCHGUIDesigner\.exe$/.test(t.uiDesigner));
  check('hexBinStudio resolved (flat others layout)', !!t.hexBinStudio && fs.existsSync(t.hexBinStudio) && /HexBinStudio\.exe$/.test(t.hexBinStudio));
  check('comTransmit resolved (flat others layout)', !!t.comTransmit && fs.existsSync(t.comTransmit) && /COMTransmit\.exe$/.test(t.comTransmit));
  check('all six tools present', [t.linkUtility, t.ispStudio, t.touchkeyTool, t.uiDesigner, t.hexBinStudio, t.comTransmit].every((p) => !!p));
} else {
  console.log('SKIP  real MRS2 installation not present');
}

// missing installation -> all empty, no throw
const empty = resolveMrsTools({
  root: '', resourcesWin32: 'Z:/no/such/dir', components: '', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [],
});
check('missing installation degrades to empty paths', Object.values(empty).every((v) => v === ''));

console.log(failures ? `\n${failures} FAILURES` : '\nall mrsTools tests passed');
process.exit(failures ? 1 : 0);
