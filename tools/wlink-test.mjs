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
  for (const op of ['queryMcuId', 'queryRpt', 'enableRpt', 'disableRpt', 'disableDbg', 'clearCodeFlash', 'getMemType', 'setMemType']) {
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
  const scratch = path.join(DEVELOP_DIR, '.scratch', 'wlink-pe');
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

// every path this helper writes must stay inside the scratch root
const PROOT = path.join(DEVELOP_DIR, '.scratch', 'wlink-posix');
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
    check('posix queryMcuId: NO SetTargetChip, zero-arg call, id wording', k.calls.length === 1 && k.calls[0][0] === 'MRSFunc_GetLinkedMCUID' && r.result === 307 && describeResult('queryMcuId', r).includes('chip id: 307'));
  }
  {
    const k = fakeKoffi({ MRSFunc_DisableDbgInterface: 3 });
    const r = await runWlinkOpPosix(INS, 'disableDbg', ARGS7, k, 'linux');
    check('posix disableDbg: code 3 -> "does not support" wording', describeResult('disableDbg', r).includes('does not support'));
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

console.log(failures ? `\n${failures} FAILURES` : '\nall wlink tests passed');
process.exit(failures ? 1 : 0);
