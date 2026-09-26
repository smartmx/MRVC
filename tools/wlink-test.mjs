/*
 * WCH-Link bridge tests (pure Node): PowerShell script generation, DLL path
 * resolution from load.wcfg, op coverage, graceful degradation.
 */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEVELOP_DIR = path.dirname(here);
const outCore = path.join(DEVELOP_DIR, 'out', 'core');
const { buildPsScript, resolveCommLib, describeResult, OP_LOGIC_PATH } = require(path.join(outCore, 'wlink.js'));

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const COMM = {
  dir: 'C:/MRS/CommunicationLib/default',
  mcuDll: 'C:/MRS/CommunicationLib/default/McuCompilerDll.dll',
  usbDll: 'C:/MRS/CommunicationLib/default/libusb-1.0.dll',
};
const ARGS = { chipId: 6, clkSpeed: 1, dbgMode: 0 };

// 1. declaration block + operation coverage
{
  const s = buildPsScript(COMM, 'queryRpt', ARGS);
  check('script: P/Invoke declares QueryRProtect', s.includes('QueryRProtect(int chipId, int clk)'));
  check('script: declares SetTargetChip', s.includes('SetTargetChip(int chipId, int dbgMode)'));
  check('script: SetDllDirectory points at the CommunicationLib dir', s.includes('SetDllDirectory') && s.includes(COMM.dir));
  check('script: SetTargetChip called with chipId/dbgMode', s.includes('SetTargetChip(6, 0)'));
  check('script: queryRpt calls QueryRProtect(chipId, clk)', s.includes('QueryRProtect(6, 1)'));
  check('script: result JSON line emitted', s.includes('ConvertTo-Json -Compress'));

  check('enableRpt: writes then re-reads after 200ms', buildPsScript(COMM, 'enableRpt', ARGS).includes('EnableRProtect(6, 1)') && buildPsScript(COMM, 'enableRpt', ARGS).includes('Start-Sleep -Milliseconds 200') && buildPsScript(COMM, 'enableRpt', ARGS).includes('-eq 3'));
  check('disableRpt: success is query==4', buildPsScript(COMM, 'disableRpt', ARGS).includes('-eq 4'));
  check('disableDbg: direct call, no re-read', buildPsScript(COMM, 'disableDbg', ARGS).includes('DisableDbgInterface(6, 1)'));
  check('clearCodeFlash: erase mode 0=pin / 1=power', buildPsScript(COMM, 'clearCodeFlash', { ...ARGS, eraseMode: 1 }).includes('ClearCodeFlash(6, 1, 1)'));
  check('setMemType: passes the select index', buildPsScript(COMM, 'setMemType', { ...ARGS, memVal: 3 }).includes('SetMemType(6, 1, 3)'));
  check('queryMcuId: runtime guard skips SetTargetChip', buildPsScript(COMM, 'queryMcuId', ARGS).includes("-ne 'queryMcuId'"));
  let threw = false;
  try {
    buildPsScript(COMM, 'nope', ARGS);
  } catch {
    threw = true;
  }
  check('unknown op rejected', threw);
}

// 2. load.wcfg parsing against the real MRS2 installation (present-only)
{
  const WCH = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/components/WCH';
  if (fs.existsSync(path.join(WCH, 'Others', 'CommunicationLib'))) {
    const win32 = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32';
    const lib = resolveCommLib({ resourcesWin32: win32, root: '', components: '', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [] });
    check('commLib: resolved from the real installation', !!lib && /McuCompilerDll\.dll$/i.test(lib.mcuDll));
    check('commLib: DLL actually exists on disk', !!lib && fs.existsSync(lib.mcuDll));
    check('commLib: 32-bit bridge exists (SysWOW64 PowerShell)', fs.existsSync(OP_LOGIC_PATH));
  } else {
    console.log('SKIP  real CommunicationLib (MRS2 not present)');
  }
  check('commLib: missing dir -> null', resolveCommLib({ resourcesWin32: 'Z:/no/such', root: '', components: '', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [] }) === null);
}

// 3. result wording for the Operation Record
{
  check('describe: queryRpt 3 -> enabled', describeResult('queryRpt', { op: 'queryRpt', ok: true, result: 3 }).includes('Enable'));
  check('describe: queryRpt 4 -> disabled', describeResult('queryRpt', { op: 'queryRpt', ok: true, result: 4 }).includes('Disable'));
  check('describe: disableDbg 3 -> unsupported', describeResult('disableDbg', { op: 'disableDbg', ok: true, result: 3 }).includes('not support'));
  check('describe: error passthrough', describeResult('queryMcuId', { op: 'queryMcuId', ok: false, error: 'boom' }).includes('boom'));
}

console.log(failures ? `\n${failures} FAILURES` : '\nall wlink tests passed');
process.exit(failures ? 1 : 0);
