/*
 * WCH-Link bridge tests (pure Node): PowerShell script generation, DLL path
 * resolution from load.wcfg, op coverage, graceful degradation.
 */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEVELOP_DIR = path.dirname(here);
const outCore = path.join(DEVELOP_DIR, 'out', 'core');
const { buildPsScript, resolveCommLib, describeResult, OP_LOGIC_PATH, peMachine, bridgePowerShell, POWERSHELL_X86, POWERSHELL_X64 } = require(path.join(outCore, 'wlink.js'));

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
  check(
    'script: declares QueryRProtect under the CALLED name, bound to MRSFunc_QueryRProtect',
    /public static extern int QueryRProtect\(int chipId, int clk\)/.test(s) && s.includes('EntryPoint = "MRSFunc_QueryRProtect"')
  );
  check(
    'script: declares SetTargetChip bound to McuCompiler_SetTargetChip',
    /public static extern int SetTargetChip\(int chipId, int dbgMode\)/.test(s) && s.includes('EntryPoint = "McuCompiler_SetTargetChip"')
  );
  check('script: SetDllDirectory points at the CommunicationLib dir', s.includes('SetDllDirectory') && s.includes(COMM.dir));
  check('script: SetTargetChip called with chipId/dbgMode', s.includes('SetTargetChip(6, 0)'));
  check('script: queryRpt calls QueryRProtect(chipId, clk)', s.includes('QueryRProtect(6, 1)'));
  check('script: result JSON line emitted', s.includes('ConvertTo-Json -Compress'));

  // the regression that shipped from 0.1.2 to 0.2.1: bodies called bare names
  // (QueryRProtect/GetLinkedMCUID/...) while the class only declared the
  // MRSFunc_* spellings — every operation failed with "does not contain a
  // method named ..." before the DLL was reached. Invariant: every method the
  // script calls on [McuLink] must be declared in the SAME script.
  for (const op of ['queryMcuId', 'queryRpt', 'enableRpt', 'disableRpt', 'disableDbg', 'clearCodeFlash', 'getMemType', 'setMemType', 'sdiPrint']) {
    const text = buildPsScript(COMM, op, { chipId: 6, clkSpeed: 1, dbgMode: 0, eraseMode: 0, memVal: 1 });
    const called = [...text.matchAll(/\[McuLink\]::(\w+)\(/g)].map((m) => m[1]);
    const declared = [...text.matchAll(/public static extern int (\w+)\(/g)].map((m) => m[1]);
    const missing = called.filter((c) => !declared.includes(c));
    check(`script ${op}: every called method is declared`, called.length > 0 && missing.length === 0);
  }

  check('enableRpt: writes then re-reads after 200ms', buildPsScript(COMM, 'enableRpt', ARGS).includes('EnableRProtect(6, 1)') && buildPsScript(COMM, 'enableRpt', ARGS).includes('Start-Sleep -Milliseconds 200') && buildPsScript(COMM, 'enableRpt', ARGS).includes('-eq 3'));
  check('disableRpt: success is query==4', buildPsScript(COMM, 'disableRpt', ARGS).includes('-eq 4'));
  check('disableDbg: direct call, no re-read', buildPsScript(COMM, 'disableDbg', ARGS).includes('DisableDbgInterface(6, 1)'));
  check('clearCodeFlash: erase mode 0=pin / 1=power', buildPsScript(COMM, 'clearCodeFlash', { ...ARGS, eraseMode: 1 }).includes('ClearCodeFlash(6, 1, 1)'));
  check('setMemType: passes the select index', buildPsScript(COMM, 'setMemType', { ...ARGS, memVal: 3 }).includes('SetMemType(6, 1, 3)'));
  check('queryMcuId: runtime guard skips SetTargetChip', buildPsScript(COMM, 'queryMcuId', ARGS).includes("-ne 'queryMcuId'"));
  {
    // SDI Printf: MRS's own post-flash sequence, reduced to
    // RESET(1)|SDIPrintf(16) — MRSFunc_FlashOperationExB(6, 1, 17, addr, hex).
    // OpenDevice MUST come before SetTargetChip (the device has to be open
    // for the vendor command); the generic SetTargetChip prelude is skipped.
    const s = buildPsScript(COMM, 'sdiPrint', { ...ARGS, flashAddress: 0x08000000, flashPath: 'E:/prj/obj/LED.hex' });
    const bodyStart = s.indexOf('[McuLink]::GetDeviceVersion(');
    const targetInBody = s.indexOf('[McuLink]::SetTargetChip(6, 0)', bodyStart);
    check(
      'sdiPrint: OpenDevice -> GetDeviceVersion -> SetTargetChip -> FlashOperationExB(flags 0x11)',
      s.indexOf('[McuLink]::OpenDevice()') >= 0 &&
        s.indexOf('[McuLink]::OpenDevice()') < bodyStart &&
        bodyStart < targetInBody &&
        targetInBody < s.indexOf('[McuLink]::FlashOperationExB(6, 1, 17, 134217728, ', bodyStart) &&
        s.includes(`'E:/prj/obj/LED.hex'`)
    );
    check('sdiPrint: generic SetTargetChip prelude excluded', s.includes("-ne 'sdiPrint'"));
    check('sdiPrint: success = DLL return 0', s.includes('$r.ok = ($v -eq 0)'));
  }
  {
    // review round2 §3: CompareVersion can throw — the init sequence must
    // close the device in a finally, mirroring the POSIX in-process path.
    // Round5 P2: the script also reports HOW the init ended ($r.init), so
    // consumers that act on the id can require a completed init.
    const s = buildPsScript(COMM, 'queryMcuId', { ...ARGS, wcfgPath: 'C:/MRS/wchlink.wcfg' });
    check('queryMcuId init (win): CompareVersion result drives $r.init, CloseDevice in finally',
      s.includes(`$rc = [McuLink]::CompareVersion('C:/MRS/wchlink.wcfg', [ref]$ia, [ref]$ib);`) &&
        s.includes(`if ($rc -eq 0) { $r.init = 'ok' } else { $r.init = 'upgrade-needed' }`) &&
        s.includes(`$r.init = 'failed'`) &&
        // failed must be the state BEFORE the OpenDevice branch: an OpenDevice
        // failure skips the inner block and must not stay 'missing-wcfg'
        s.indexOf(`$r.init = 'failed'`) < s.indexOf(`if ([McuLink]::OpenDevice() -eq 0)`) &&
        s.includes('} finally { [void][McuLink]::CloseDevice(); }'));
    check('queryMcuId init (win): absent without a wcfg path -> missing-wcfg',
      (() => {
        const legacy = buildPsScript(COMM, 'queryMcuId', ARGS);
        return legacy.includes(`$r.init = 'missing-wcfg'`) && !legacy.includes(`$r.init = 'failed'`) && !legacy.includes('finally');
      })());
  }
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
  const MRS2_ROOT =
    process.env.MRS2_HOME ||
    ['C:/MounRiver/MounRiver_Studio2', 'D:/MounRiver/MounRiver_Studio2'].find((r) =>
      fs.existsSync(path.join(r, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'manifest.json'))
    );
  const WCH = MRS2_ROOT
    ? `${MRS2_ROOT}/resources/app/resources/win32/components/WCH`
    : 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/components/WCH';
  if (fs.existsSync(path.join(WCH, 'Others', 'CommunicationLib'))) {
    const win32 = `${MRS2_ROOT}/resources/app/resources/win32`;
    const lib = resolveCommLib({ resourcesDir: win32, kind: 'ide', root: '', components: '', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [] });
    check('commLib: resolved from the real installation', !!lib && /McuCompilerDll\.dll$/i.test(lib.mcuDll));
    check('commLib: DLL actually exists on disk', !!lib && fs.existsSync(lib.mcuDll));
    check('commLib: 32-bit bridge exists (SysWOW64 PowerShell)', fs.existsSync(OP_LOGIC_PATH));
  } else {
    console.log('SKIP  real CommunicationLib (MRS2 not present)');
  }
  check('commLib: missing dir -> null', resolveCommLib({ resourcesDir: 'Z:/no/such', kind: 'ide', root: '', components: '', makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [] }) === null);
}

// 3. result wording for the Operation Record
{
  check('describe: queryRpt 3 -> enabled', describeResult('queryRpt', { op: 'queryRpt', ok: true, result: 3 }).includes('Enable'));
  check('describe: queryRpt 4 -> disabled', describeResult('queryRpt', { op: 'queryRpt', ok: true, result: 4 }).includes('Disable'));
  check('describe: disableDbg 3 -> unsupported', describeResult('disableDbg', { op: 'disableDbg', ok: true, result: 3 }).includes('not support'));
  check('describe: error passthrough', describeResult('queryMcuId', { op: 'queryMcuId', ok: false, error: 'boom' }).includes('boom'));
}

// 4. bridge bitness follows the CommunicationLib DLL (MRS2 ships a 32-bit
// McuCompilerDll, the MRS3 beta a 64-bit one) — the PE machine type decides
// which PowerShell host runs the P/Invoke script
{
  // os.tmpdir, NOT .scratch — golden-check wipes the whole .scratch root at
  // startup and a parallel run would delete this fixture mid-test (round5 §4)
  const scratch = path.join(os.tmpdir(), 'mrvc-wlink-pe');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const writePe = (file, machine) => {
    const buf = Buffer.alloc(0x100);
    buf.write('MZ', 0, 'latin1');
    buf.writeUInt32LE(0x80, 0x3c);
    buf.writeUInt32LE(0x00004550, 0x80); // "PE\0\0"
    buf.writeUInt16LE(machine, 0x84);
    fs.writeFileSync(file, buf);
  };
  const pe32 = path.join(scratch, 'fake32.dll');
  const pe64 = path.join(scratch, 'fake64.dll');
  const notPe = path.join(scratch, 'plain.txt');
  writePe(pe32, 0x14c);
  writePe(pe64, 0x8664);
  fs.writeFileSync(notPe, 'not a PE image');

  check('pe: i386 image -> 0x14c', peMachine(pe32) === 0x14c);
  check('pe: x64 image -> 0x8664', peMachine(pe64) === 0x8664);
  check('pe: non-PE -> null', peMachine(notPe) === null);
  check('pe: missing file -> null', peMachine(path.join(scratch, 'nope.dll')) === null);
  check('bridge: 32-bit DLL picks SysWOW64 PowerShell', bridgePowerShell(pe32) === POWERSHELL_X86);
  check('bridge: 64-bit DLL picks System32 PowerShell', bridgePowerShell(pe64) === POWERSHELL_X64);
  check('bridge: both PowerShells exist on this machine', fs.existsSync(POWERSHELL_X86) && fs.existsSync(POWERSHELL_X64));

  // real installations, when present: MRS2 = 32-bit, the MRS3 beta = 64-bit
  const mrs2Dll = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/components/WCH/Others/CommunicationLib/default/McuCompilerDll.dll';
  if (fs.existsSync(mrs2Dll)) {
    check('bridge: real MRS2 McuCompilerDll is 32-bit -> SysWOW64', bridgePowerShell(mrs2Dll) === POWERSHELL_X86);
  } else {
    console.log('SKIP  real MRS2 McuCompilerDll (not present)');
  }
  const mrs3Dll = 'F:/MyProjects/MRS2_VSCODE/MRS3/MounRiver_Studio3/resources/app/resources/win32/components/WCH/Others/CommunicationLib/default/McuCompilerDll.dll';
  if (fs.existsSync(mrs3Dll)) {
    check('bridge: real MRS3 beta McuCompilerDll is 64-bit -> System32', bridgePowerShell(mrs3Dll) === POWERSHELL_X64);
  } else {
    console.log('SKIP  MRS3 beta install (not present)');
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---- POSIX transport: in-process koffi FFI (fake koffi module — the real
// one needs the vendor library and real hardware, validated on Linux/macOS
// physical machines; here we pin the SEQUENCE, the ok codes and the resolvers)
const { runWlinkOpPosix, mcuLibFileName } = require(path.join(outCore, 'wlink.js'));

// every path this helper writes must stay inside the scratch root —
// os.tmpdir, NOT .scratch (golden-check wipes .scratch wholesale at startup;
// a parallel run would delete this fixture mid-test, round5 §4)
const PROOT = path.join(os.tmpdir(), 'mrvc-wlink-posix');
fs.rmSync(PROOT, { recursive: true, force: true });
function inside(root, target) {
  const resolved = path.resolve(root, target);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('refusing to write outside the scratch root: ' + target);
  }
  return resolved;
}
/** fake MRS install whose CommunicationLib/default carries the POSIX library —
 *  one resources dir PER VARIANT (a shared dir would let the darwin fixture's
 *  isolation wipe the .so an earlier fixture installed) */
function posixInstall(libName) {
  const res = inside(PROOT, 'res-' + (libName ?? 'none'));
  const dir = inside(PROOT, path.join('res-' + (libName ?? 'none'), 'components', 'WCH', 'Others', 'CommunicationLib', 'default'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (libName) fs.writeFileSync(inside(PROOT, path.join('res-' + (libName ?? 'none'), 'components', 'WCH', 'Others', 'CommunicationLib', 'default', libName)), 'binary');
  return { root: PROOT, resourcesDir: res, kind: 'ide', components: path.join(res, 'components', 'WCH'), makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [], flavor: 'mrs3', label: 'MounRiver Studio 3' };
}
/** scripted koffi: records every func call, returns per-export values */
function fakeKoffi(results, opts = {}) {
  const calls = [];
  const loads = [];
  const mod = {
    calls,
    loads,
    load(p) {
      loads.push(p);
      if (opts.throwOnFirstLoad && loads.length === 1) throw new Error('dlopen failed: simulated missing dependency');
      return {
        func: (name, ret, argn) => (...a) => {
          calls.push([name, ...a]);
          const v = results[name];
          return typeof v === 'function' ? v(a) : (v ?? 0);
        },
      };
    },
  };
  return mod;
}
const INS = posixInstall('libmcuupdate.so');
const ARGS7 = { chipId: 7, clkSpeed: 1, dbgMode: 0 };

try {
  // 1. library-name mapping + POSIX resolveCommLib (no load.wcfg on POSIX)
  check('mcuLib: win/linux/darwin names', mcuLibFileName('win32') === 'McuCompilerDll.dll' && mcuLibFileName('linux') === 'libmcuupdate.so' && mcuLibFileName('darwin') === 'libmcuupdate.dylib');
  const linComm = resolveCommLib(INS, 'linux');
  check('commLib posix: resolves libmcuupdate.so directly (no wcfg needed)', !!linComm && linComm.mcuDll.endsWith('libmcuupdate.so') && linComm.usbDll === '');
  const macInstall = posixInstall('libmcuupdate.dylib');
  const macComm = resolveCommLib(macInstall, 'darwin');
  check('commLib posix: darwin resolves the dylib', !!macComm && macComm.mcuDll.endsWith('libmcuupdate.dylib'));
  check('commLib posix: missing library -> null', resolveCommLib(posixInstall(null), 'linux') === null);

  // 2. op sequences against the fake koffi (names/args/ok codes)
  {
    const k = fakeKoffi({ MRSFunc_QueryRProtect: 3, McuCompiler_SetTargetChip: 0 });
    const r = await runWlinkOpPosix(INS, 'queryRpt', ARGS7, k, 'linux');
    check('posix queryRpt: result 3, ok=false (3 needs the enable flow)', r.op === 'queryRpt' && r.result === 3 && r.ok === false);
    check(
      'posix queryRpt: SetTargetChip first, then the query (chipId, clkSpeed)',
      JSON.stringify(k.calls) === JSON.stringify([['McuCompiler_SetTargetChip', 7, 0], ['MRSFunc_QueryRProtect', 7, 1]])
    );
    check('posix queryRpt: describeResult wording matches the Windows contract', describeResult('queryRpt', r) === 'Code-Protect is Enable');
  }
  {
    const k = fakeKoffi({ MRSFunc_EnableRProtect: 0, MRSFunc_QueryRProtect: 3 });
    const r = await runWlinkOpPosix(INS, 'enableRpt', ARGS7, k, 'linux');
    check('posix enableRpt: query returns 3 -> ok=true', r.ok === true && r.result === 3);
    check('posix enableRpt: Set, Enable, then the settle-query', k.calls.map((c) => c[0]).join(',') === 'McuCompiler_SetTargetChip,MRSFunc_EnableRProtect,MRSFunc_QueryRProtect');
  }
  {
    const k = fakeKoffi({ MRSFunc_DisableRProtect: 0, MRSFunc_QueryRProtect: 4 });
    const r = await runWlinkOpPosix(INS, 'disableRpt', ARGS7, k, 'linux');
    check('posix disableRpt: query returns 4 -> ok=true', r.ok === true && r.result === 4);
  }
  {
    const k = fakeKoffi({ MRSFunc_ClearCodeFlash: 0 });
    const r = await runWlinkOpPosix(INS, 'clearCodeFlash', { ...ARGS7, eraseMode: 1 }, k, 'linux');
    check('posix clearCodeFlash: eraseMode passes through (chip, clk, mode), 0 -> ok', k.calls[1][0] === 'MRSFunc_ClearCodeFlash' && k.calls[1][3] === 1 && r.ok === true);
  }
  {
    const k = fakeKoffi({ MRSFunc_SetMemType: 0 });
    const r = await runWlinkOpPosix(INS, 'setMemType', { ...ARGS7, memVal: 5 }, k, 'linux');
    check('posix setMemType: memVal passes through, 0 -> ok', k.calls[1][3] === 5 && r.ok === true);
  }
  {
    const k = fakeKoffi({ MRSFunc_GetLinkedMCUID: 307 });
    const r = await runWlinkOpPosix(INS, 'queryMcuId', ARGS7, k, 'linux');
    // round (0.2.9 fix): without a wchlink.wcfg the init sequence is skipped —
    // the LEGACY raw query still runs (chips where it worked keep working)
    check('posix queryMcuId legacy: NO SetTargetChip, zero-arg call, id wording', k.calls.length === 1 && k.calls[0][0] === 'MRSFunc_GetLinkedMCUID' && r.result === 307 && describeResult('queryMcuId', r).includes('chip id: 307'));
    // round5 P2: a raw query is NOT trustworthy — the guard keys off initState
    check('posix queryMcuId legacy: initState missing-wcfg (id untrusted)', r.initState === 'missing-wcfg');
  }
  {
    // MRS parity (round 0.2.9): WITH a wchlink.wcfg present, the query runs
    // the init sequence Open → CompareVersion → Close first — without it the
    // raw GetLinkedMCUID returned the LINK id (2/6) instead of the MCU
    // family code on LinkE 2.23 (the remote Download Settings failure)
    const fwRes = path.join(INS.resourcesDir, 'components', 'WCH', 'Others', 'Firmware_Link', 'default');
    fs.mkdirSync(fwRes, { recursive: true });
    fs.writeFileSync(path.join(fwRes, 'wchlink.wcfg'), '[WCHLINK]\nLinkName=Default\n[Default]\nCH549Ver_RV=32\n');
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_CompareVersion: (a) => { a[1].writeInt32LE(2); return 0; },
      McuCompiler_CloseDevice: 0,
      MRSFunc_GetLinkedMCUID: 307,
    });
    const r = await runWlinkOpPosix(INS, 'queryMcuId', ARGS7, k, 'linux');
    check('posix queryMcuId init: Open → CompareVersion → Close precede the raw query',
      k.calls.map((c) => c[0]).join(',') === 'McuCompiler_OpenDevice,McuCompiler_CompareVersion,McuCompiler_CloseDevice,MRSFunc_GetLinkedMCUID',
      JSON.stringify(k.calls.map((c) => c[0])));
    check('posix queryMcuId init: CompareVersion got the wcfg path, raw family id in the result',
      typeof k.calls[1][1] === 'string' && k.calls[1][1].endsWith('wchlink.wcfg') && describeResult('queryMcuId', r).includes('chip id: 307'));
    check('posix queryMcuId init: CompareVersion 0 -> initState ok (id trusted)', r.initState === 'ok');
  }
  {
    // round5 P2 probes: OpenDevice failure and a nonzero CompareVersion must
    // NOT be reported as a trustworthy id (raw GetLinkedMCUID answers the
    // link's own 2/6 — 6 collides with CH32V30x's family id)
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 1,
      McuCompiler_CompareVersion: 0,
      McuCompiler_CloseDevice: 0,
      MRSFunc_GetLinkedMCUID: 6,
    });
    const r = await runWlinkOpPosix(INS, 'queryMcuId', ARGS7, k, 'linux');
    check('posix queryMcuId init: OpenDevice failure -> initState failed, raw 6 untrusted',
      r.initState === 'failed' && r.result === 6 && !k.calls.some((c) => c[0] === 'McuCompiler_CompareVersion') && !k.calls.some((c) => c[0] === 'McuCompiler_CloseDevice'));
  }
  {
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_CompareVersion: 1,
      McuCompiler_CloseDevice: 0,
      MRSFunc_GetLinkedMCUID: 6,
    });
    const r = await runWlinkOpPosix(INS, 'queryMcuId', ARGS7, k, 'linux');
    check('posix queryMcuId init: CompareVersion 1 (upgrade-needed) -> id untrusted, device closed',
      r.initState === 'upgrade-needed' && r.result === 6 && k.calls.map((c) => c[0]).join(',') === 'McuCompiler_OpenDevice,McuCompiler_CompareVersion,McuCompiler_CloseDevice,MRSFunc_GetLinkedMCUID');
  }
  {
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_CompareVersion: () => { throw new Error('wcfg unreadable'); },
      McuCompiler_CloseDevice: 0,
      MRSFunc_GetLinkedMCUID: 6,
    });
    const r = await runWlinkOpPosix(INS, 'queryMcuId', ARGS7, k, 'linux');
    check('posix queryMcuId init: CompareVersion throw -> initState failed, CloseDevice still ran',
      r.initState === 'failed' && r.result === 6 && k.calls.some((c) => c[0] === 'McuCompiler_CloseDevice'));
  }
  {
    const k = fakeKoffi({ MRSFunc_DisableDbgInterface: 3 });
    const r = await runWlinkOpPosix(INS, 'disableDbg', ARGS7, k, 'linux');
    check('posix disableDbg: code 3 -> "does not support" wording', describeResult('disableDbg', r).includes('does not support'));
  }

  // 2b. sdiPrint (POSIX koffi): an independent device session, flags 0x11,
  // CloseDevice in a finally. The Windows PS script is pinned separately above.
  {
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_GetDeviceVersion: 0,
      McuCompiler_SetTargetChip: 0,
      MRSFunc_FlashOperationExB: 0,
      McuCompiler_CloseDevice: 0,
    });
    const r = await runWlinkOpPosix(
      INS,
      'sdiPrint',
      { ...ARGS7, flashAddress: 0x08000000, flashPath: '/tmp/LED.hex' },
      k,
      'linux'
    );
    check('posix sdiPrint: success is FlashOperationExB return 0', r.ok === true && r.result === 0);
    check(
      'posix sdiPrint: Open -> GetDeviceVersion -> SetTargetChip -> FlashOperationExB(17) -> Close',
      JSON.stringify(k.calls.map((c) => c[0])) ===
        JSON.stringify([
          'McuCompiler_OpenDevice',
          'McuCompiler_GetDeviceVersion',
          'McuCompiler_SetTargetChip',
          'MRSFunc_FlashOperationExB',
          'McuCompiler_CloseDevice',
        ])
    );
    check(
      'posix sdiPrint: flash args carry chip/clk/0x11/address/path',
      JSON.stringify(k.calls.find((c) => c[0] === 'MRSFunc_FlashOperationExB').slice(1)) ===
        JSON.stringify([7, 1, 17, 0x08000000, '/tmp/LED.hex'])
    );
    check('posix sdiPrint: no generic SetTargetChip prelude call', k.calls.filter((c) => c[0] === 'McuCompiler_SetTargetChip').length === 1);
  }
  {
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_GetDeviceVersion: 0,
      McuCompiler_SetTargetChip: 0,
      MRSFunc_FlashOperationExB: 7,
      McuCompiler_CloseDevice: 0,
    });
    const r = await runWlinkOpPosix(INS, 'sdiPrint', { ...ARGS7, flashAddress: 0x08000000, flashPath: '/tmp/LED.hex' }, k, 'linux');
    check('posix sdiPrint: a non-zero DLL result is not success', r.ok === false && r.result === 7);
  }
  {
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_GetDeviceVersion: 0,
      McuCompiler_SetTargetChip: 0,
      MRSFunc_FlashOperationExB: () => {
        throw new Error('boom');
      },
      McuCompiler_CloseDevice: 0,
    });
    const r = await runWlinkOpPosix(INS, 'sdiPrint', { ...ARGS7, flashAddress: 0x08000000, flashPath: '/tmp/LED.hex' }, k, 'linux');
    check('posix sdiPrint: a throwing export becomes an error result', r.ok === false && r.error === 'boom');
    check('posix sdiPrint: CloseDevice still runs after a throw', k.calls.some((c) => c[0] === 'McuCompiler_CloseDevice'));
  }
  {
    const k = fakeKoffi({ McuCompiler_OpenDevice: 3, McuCompiler_CloseDevice: 0 });
    const r = await runWlinkOpPosix(INS, 'sdiPrint', { ...ARGS7, flashAddress: 0x08000000, flashPath: '/tmp/LED.hex' }, k, 'linux');
    check('posix sdiPrint: OpenDevice failure is reported', r.ok === false && /OpenDevice failed/.test(r.error ?? ''));
    check('posix sdiPrint: OpenDevice failure does not call CloseDevice', !k.calls.some((c) => c[0] === 'McuCompiler_CloseDevice'));
  }

  // 3. degradation paths
  {
    const r = await runWlinkOpPosix(posixInstall(null), 'queryRpt', ARGS7, fakeKoffi({}), 'linux');
    check('posix: missing CommunicationLib -> named error', !r.ok && r.error.includes('libmcuupdate.so'));
    const r2 = await runWlinkOpPosix(INS, 'queryRpt', ARGS7, null, 'linux');
    check('posix: missing koffi dependency -> named error', !r2.ok && r2.error.includes('koffi dependency is missing'));
  }
  {
    // dlopen fails once -> sibling preloads then the retry succeeds
    const k = fakeKoffi({ MRSFunc_QueryRProtect: 4 }, { throwOnFirstLoad: true });
    const r = await runWlinkOpPosix(INS, 'queryRpt', ARGS7, k, 'linux');
    check('posix: a failed first dlopen retries after sibling preloads', r.ok === false && r.result === 4 && k.loads.length === 2);
  }
  {
    // an FFI-level throw lands in error, never throws out
    const k = fakeKoffi({ McuCompiler_SetTargetChip: () => { throw new Error('USB device gone'); } });
    const r = await runWlinkOpPosix(INS, 'queryRpt', ARGS7, k, 'linux');
    check('posix: a throwing export becomes an error result', !r.ok && r.error.includes('USB device gone'));
  }
} finally {
  fs.rmSync(PROOT, { recursive: true, force: true });
}

// ---- WCH-Link firmware version check (READ-ONLY detect-only, 0.2.8): the
// decompiled mrs-vscode doUpdate semantics — OpenDevice → CompareVersion
// (out1 low byte = linkID; 0 = up to date, 1 = upgrade needed) →
// GetDeviceVersion → CloseDevice. MRVC never touches the link firmware.
const {
  checkWCHLinkFirmware,
  wchlinkFirmwareCfgPath,
  linkInfoFor,
  expectedFirmwareVersion,
  formatLinkVersion,
  buildPsFirmwareCheckScript,
  normalizeFirmwareCheck,
} = require(path.join(outCore, 'wlink.js'));

// round3 §2: the shared post-processor covers BOTH platforms — the Windows
// `version` field remap AND the 10..99 band, in one pure function
check('fwcheck: normalize remaps the Windows `version` field to currentVersion', (() => {
  const r = normalizeFirmwareCheck({ state: 'upgrade-needed', linkId: 2, version: 43 });
  return r.currentVersion === 43 && r.version === undefined && r.state === 'upgrade-needed';
})());
check('fwcheck: normalize rejects out-of-band versions on the Windows shape too', (() => {
  const low = normalizeFirmwareCheck({ state: 'upgrade-needed', linkId: 2, version: 0 });
  const high = normalizeFirmwareCheck({ state: 'upgrade-needed', linkId: 2, version: 100 });
  return low.state === 'error' && /out of range/.test(low.error ?? '') && high.state === 'error';
})());
check('fwcheck: normalize leaves currentVersion-carrying results untouched', (() => {
  const r = normalizeFirmwareCheck({ state: 'upgrade-needed', linkId: 5, currentVersion: 34 });
  return r.currentVersion === 34 && r.state === 'upgrade-needed';
})());

{
  // the real wchlink.wcfg from the MRS3 install (INI: link type -> expected
  // firmware version number)
  const WCFG = [
    '[WCHLINK]',
    'LinkName=Default',
    '',
    '[Default]',
    'CH549Ver_RV=32',
    'CH549Ver_ARM=31',
    'CH32V307Ver=43',
    'CH32V208Ver=34',
    'CH32V203Ver=32',
    '',
  ].join('\n');

  // fixture: install carrying BOTH the CommunicationLib library and the
  // Firmware_Link/default/wchlink.wcfg (a UNIQUE resources dir per case —
  // a shared name would let a later withCfg=false fixture wipe the wcfg an
  // earlier install points at)
  function fwInstall(withCfg, tag) {
    const res = inside(PROOT, 'fw-res-' + tag);
    const commDir = inside(PROOT, path.join('fw-res-' + tag, 'components', 'WCH', 'Others', 'CommunicationLib', 'default'));
    const fwDir = inside(PROOT, path.join('fw-res-' + tag, 'components', 'WCH', 'Others', 'Firmware_Link', 'default'));
    fs.mkdirSync(commDir, { recursive: true });
    fs.writeFileSync(path.join(commDir, 'libmcuupdate.so'), 'binary');
    if (withCfg) {
      fs.mkdirSync(fwDir, { recursive: true });
      fs.writeFileSync(path.join(fwDir, 'wchlink.wcfg'), WCFG);
    }
    return { root: PROOT, resourcesDir: res, kind: 'ide', components: path.join(res, 'components', 'WCH'), makeBin: '', openocdExe: '', openocdCfg: '', linkUtilityExe: '', toolchains: [], flavor: 'mrs3', label: 'MounRiver Studio 3' };
  }

  const FW_INS = fwInstall(true, 'main');
  check('fwcheck: wcfg path resolves under Firmware_Link/default', wchlinkFirmwareCfgPath(FW_INS).replace(/\\/g, '/').endsWith('/components/WCH/Others/Firmware_Link/default/wchlink.wcfg'));

  // pure helpers: linkID map, wcfg version lookup, formatting
  check('fwcheck: linkInfoFor — 0/1=CH549, 2/18=LinkE, 4=DAPLink, 5/133=LinkW, default=CH549',
    linkInfoFor(0).chipType === 'CH549' && linkInfoFor(1).name === 'WCH-Link' &&
    linkInfoFor(2).chipType === 'CH32V305' && linkInfoFor(18).name === 'WCH-LinkE' &&
    linkInfoFor(4).chipType === 'CH32V203' && linkInfoFor(4).name === 'WCH-DAPLink' &&
    linkInfoFor(5).chipType === 'CH32V208' && linkInfoFor(133).name === 'WCH-LinkW' &&
    linkInfoFor(999).chipType === 'CH549');
  check('fwcheck: expectedFirmwareVersion — CH549Ver_RV(0)=32, _ARM(1+DAP)=31, LinkE remapped to CH32V307Ver=43, DAPLink=32, LinkW=34',
    expectedFirmwareVersion(WCFG, 0) === 32 && expectedFirmwareVersion(WCFG, 1, false) === 32 &&
    expectedFirmwareVersion(WCFG, 1, true) === 31 && expectedFirmwareVersion(WCFG, 2) === 43 &&
    expectedFirmwareVersion(WCFG, 18) === 43 && expectedFirmwareVersion(WCFG, 4) === 32 &&
    expectedFirmwareVersion(WCFG, 5) === 34 && expectedFirmwareVersion(WCFG, 133) === 34);
  check('fwcheck: expectedFirmwareVersion — a key the cfg does not carry -> undefined (defensive branch)',
    expectedFirmwareVersion('[Default]\nCH549Ver_RV=32\n', 5) === undefined);
  check('fwcheck: formatLinkVersion pads to vNN within the 10..99 band, ? outside', formatLinkVersion(43) === 'v43' && formatLinkVersion(10) === 'v10' && formatLinkVersion(99) === 'v99' && formatLinkVersion(8) === '?' && formatLinkVersion(undefined) === '?');
  // the family display (CH32V30x) is resolved by the CALLER from the chip
  // database (SDK flash.json type for the series id) — describeResult keeps
  // the raw id
  check('fwcheck: queryMcuId describeResult keeps the raw SDK series id', (() => {
    const d = describeResult('queryMcuId', { op: 'queryMcuId', ok: false, result: 6 });
    return d.includes('chip id: 6') && !d.includes('CH32V');
  })());

  // POSIX flow against the fake koffi — the DLL parses the wcfg itself (the
  // JS only passes the path) and returns the linkID through out1
  {
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_CompareVersion: (a) => { a[1].writeInt32LE(2); return 1; },
      McuCompiler_GetDeviceVersion: 43,
      McuCompiler_CloseDevice: 0,
    });
    const r = await checkWCHLinkFirmware(FW_INS, k, 'linux');
    check('fwcheck posix: upgrade-needed with LinkE identity and v43/v43',
      r.state === 'upgrade-needed' && r.linkId === 2 && r.linkName === 'WCH-LinkE' && r.currentVersion === 43 && r.expectedVersion === 43);
    check('fwcheck posix: call sequence Open → Compare → Version → Close',
      k.calls.map((c) => c[0]).join(',') === 'McuCompiler_OpenDevice,McuCompiler_CompareVersion,McuCompiler_GetDeviceVersion,McuCompiler_CloseDevice');
    check('fwcheck posix: CompareVersion got the wcfg PATH as its first arg', typeof k.calls[1][1] === 'string' && k.calls[1][1].endsWith('wchlink.wcfg'));
  }
  {
    // round2 §6: a garbage device version (outside 10..99, mrs-vscode's -2
    // band) degrades to a silent error instead of a fabricated v00/v-1/v123
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_CompareVersion: (a) => { a[1].writeInt32LE(2); return 1; },
      McuCompiler_GetDeviceVersion: 5,
      McuCompiler_CloseDevice: 0,
    });
    const r = await checkWCHLinkFirmware(FW_INS, k, 'linux');
    check('fwcheck posix: version below the 10..99 band -> state error (no fake upgrade prompt)', r.state === 'error' && /out of range/.test(r.error ?? ''));
    const r2 = await checkWCHLinkFirmware(FW_INS, fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_CompareVersion: (a) => { a[1].writeInt32LE(2); return 1; },
      McuCompiler_GetDeviceVersion: 100,
      McuCompiler_CloseDevice: 0,
    }), 'linux');
    check('fwcheck posix: version above the band -> state error too', r2.state === 'error');
    check('fwcheck posix: formatLinkVersion refuses out-of-band values', formatLinkVersion(5) === '?' && formatLinkVersion(100) === '?' && formatLinkVersion(-1) === '?');
  }
  {
    const k = fakeKoffi({
      McuCompiler_OpenDevice: 0,
      McuCompiler_CompareVersion: (a) => { a[1].writeInt32LE(0); return 0; },
      McuCompiler_CloseDevice: 0,
    });
    const r = await checkWCHLinkFirmware(FW_INS, k, 'linux');
    check('fwcheck posix: compare 0 -> up-to-date, WCH-Link, no version read',
      r.state === 'up-to-date' && r.linkName === 'WCH-Link' && r.currentVersion === undefined && k.calls.length === 3);
  }
  {
    const k = fakeKoffi({ McuCompiler_OpenDevice: 5 });
    const r = await checkWCHLinkFirmware(FW_INS, k, 'linux');
    check('fwcheck posix: non-zero OpenDevice -> no-link (no further FFI)', r.state === 'no-link' && k.calls.length === 1);
  }
  {
    // an FFI-level throw is an error result, never an exception out
    const k = fakeKoffi({ McuCompiler_OpenDevice: () => { throw new Error('HID busy'); } });
    const r = await checkWCHLinkFirmware(FW_INS, k, 'linux');
    check('fwcheck posix: a throwing export becomes state error', r.state === 'error' && r.error.includes('HID busy'));
  }
  {
    const r = await checkWCHLinkFirmware(fwInstall(false, 'nocfg'), fakeKoffi({}), 'linux');
    check('fwcheck posix: missing wchlink.wcfg -> error (caller stays silent)', r.state === 'error' && r.error.includes('wchlink.wcfg'));
    const r2 = await checkWCHLinkFirmware(FW_INS, null, 'linux');
    check('fwcheck posix: missing koffi dependency -> error', r2.state === 'error' && r2.error.includes('koffi dependency is missing'));
  }

  // Windows script shape (no execution — PowerShell assertions live in the
  // wrapper suite; here we pin the declarations and the quoting)
  {
    const sc = buildPsFirmwareCheckScript({ dir: 'C:\\MRS\\lib', mcuDll: 'C:\\MRS\\lib\\McuCompilerDll.dll', usbDll: '' }, 'C:\\MRS\\Others\\Firmware_Link\\default\\wchlink.wcfg');
    check('fwcheck ps: the four read-only declarations with the right entry points',
      sc.includes('EntryPoint = "McuCompiler_OpenDevice"') && sc.includes('EntryPoint = "McuCompiler_CloseDevice"') &&
      sc.includes('EntryPoint = "McuCompiler_GetDeviceVersion"') && sc.includes('EntryPoint = "McuCompiler_CompareVersion"'));
    check('fwcheck ps: CompareVersion takes the wcfg path + two ref ints, no Update/SetIAPMode anywhere',
      sc.includes('CompareVersion(string path, ref int a, ref int b)') && !sc.includes('McuCompiler_Update') && !sc.includes('McuCompiler_SetIAPMode'));
    // round2 §4/§7: the script names the device version `version` (the JS
    // side remaps it to currentVersion) and guarantees CloseDevice even when
    // the check throws (finally on the $opened flag)
    check('fwcheck ps: device version is written as $r.version for the JS remap', sc.includes('$r.version = [McuLink]::GetDeviceVersion'));
    check('fwcheck ps: CloseDevice is guarded by $opened in a finally with its own try/catch (exception-safe, JSON always emitted)',
      sc.includes('$opened = $false') && sc.includes('finally {') && sc.includes("if ($opened) { try { [void][McuLink]::CloseDevice(); } catch { } }"));
    check('fwcheck ps: the wcfg path is single-quote escaped and SetDllDirectory gets the comm dir',
      sc.includes("CompareVersion('C:\\MRS\\Others\\Firmware_Link\\default\\wchlink.wcfg'") && sc.includes("SetDllDirectory('C:\\MRS\\lib')"));
    check('fwcheck ps: JSON contract line present', sc.includes("$r | ConvertTo-Json -Compress | Write-Output;"));
  }

  fs.rmSync(PROOT, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURES` : '\nall wlink tests passed');
process.exit(failures ? 1 : 0);
