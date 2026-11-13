/**
 * WCH-Link operations bridge (pure Node).
 *
 * MRS drives the Download Settings hardware operations (read protection,
 * chip ID query, memory assign, ...) through FFI into the CommunicationLib
 * native library — same MRSFunc_* / McuCompiler_* export family on every
 * OS: Windows "McuCompilerDll.dll", Linux "libmcuupdate.so", macOS
 * "libmcuupdate.dylib". MRS's own mrs-vscode extension binds them
 * IN-PROCESS with koffi; MRVC mirrors that mechanism per platform:
 *
 *   Windows  a generated PowerShell script (Add-Type P/Invoke) run
 *            out-of-process — the 0.2.x path, byte-identical. Out of
 *            process because MRS2's DLL is 32-bit and cannot load into the
 *            64-bit extension host at all.
 *   POSIX    in-process koffi FFI (koffi ships as a real dependency with
 *            linux_x64 + darwin_arm64 prebuilds; MRS3's POSIX IDEs are
 *            x64/arm64 respectively). Native-width libraries load fine
 *            in-process — exactly what MRS itself does.
 *
 * All 9 exports the ops need exist under the same names in the Linux/macOS
 * libraries (verified from libmcuupdate.so's .dynstr: QueryRProtect,
 * EnableRProtect, DisableRProtect, DisableDbgInterface, GetLinkedMCUID,
 * GetMemType, SetMemType, ClearCodeFlash as MRSFunc_, SetTargetChip as
 * McuCompiler_), so the signature table is shared verbatim.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { MrsInstall } from './toolchain';

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
export const POWERSHELL_X86 = path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const POWERSHELL_X64 = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** the 32-bit bridge path (MRS2's DLL bitness); kept for compatibility */
export const OP_LOGIC_PATH = POWERSHELL_X86;

/** PE COFF machine type of a file (0x14c = i386, 0x8664 = x64), null when
 *  the file is not a readable PE image */
export function peMachine(file: string): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const dos = Buffer.alloc(4);
    if (fs.readSync(fd, dos, 0, 4, 0x3c) !== 4) return null;
    const lfanew = dos.readUInt32LE(0);
    const head = Buffer.alloc(6);
    if (fs.readSync(fd, head, 0, 6, lfanew) !== 6) return null;
    if (head.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"
    return head.readUInt16LE(4);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

/** the PowerShell whose bitness matches the CommunicationLib DLL — a host of
 *  the other bitness cannot load it (an unknown image keeps the historical
 *  32-bit choice) */
export function bridgePowerShell(dll: string): string {
  return peMachine(dll) === 0x8664 ? POWERSHELL_X64 : POWERSHELL_X86;
}

export interface CommLib {
  dir: string;
  mcuDll: string;
  usbDll: string;
}

/** the CommunicationLib native library file name for the host OS — the same
 *  MRSFunc_* export family ships as PE/SO/dylib (platform param is a test
 *  seam: resolvers are exercised for linux/darwin shapes on any host) */
export function mcuLibFileName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'libmcuupdate.dylib';
  if (platform === 'win32') return 'McuCompilerDll.dll';
  return 'libmcuupdate.so';
}

/** CommunicationLib/default + load.wcfg -> { mcudll, libdll }. Windows reads
 *  MRS's load.wcfg (mcudll=/libdll= entries); POSIX ships no load.wcfg — the
 *  libmcuupdate.* name is fixed by the MRS packages, so it resolves directly. */
export function resolveCommLib(install: MrsInstall, platform: NodeJS.Platform = process.platform): CommLib | null {
  const dir = path.join(install.resourcesDir, 'components', 'WCH', 'Others', 'CommunicationLib', 'default');
  if (platform !== 'win32') {
    const mcu = path.join(dir, mcuLibFileName(platform));
    if (!fs.existsSync(mcu)) return null;
    return { dir, mcuDll: mcu, usbDll: '' };
  }
  const wcfg = path.join(dir, 'load.wcfg');
  try {
    let mcuDll = '';
    let usbDll = '';
    for (const line of fs.readFileSync(wcfg, 'utf-8').split(/\r?\n/)) {
      if (line.startsWith('mcudll=')) mcuDll = line.slice(7).trim();
      else if (line.startsWith('libdll=')) usbDll = line.slice(7).trim();
    }
    if (!mcuDll) return null;
    return { dir, mcuDll: path.join(dir, mcuDll), usbDll: usbDll ? path.join(dir, usbDll) : '' };
  } catch {
    return null;
  }
}

/**
 * The koffi surface MRVC uses. koffi ships as a real dependency (static
 * `require('koffi')` — the user's Mimosa rule forbids runtime-path requires)
 * with linux_x64 + darwin_arm64 prebuilds packaged for the POSIX bridge;
 * MRS's own extension binds the same library family in-process with koffi,
 * so this mirrors the vendor mechanism exactly.
 */
interface KoffiLib {
  func(name: string, retType: string, argTypes: string[]): (...args: unknown[]) => number;
}
interface KoffiLike {
  load(path: string): KoffiLib;
}

export type WlinkOp =
  | 'queryMcuId'
  | 'queryRpt'
  | 'enableRpt'
  | 'disableRpt'
  | 'disableDbg'
  | 'clearCodeFlash'
  | 'getMemType'
  | 'setMemType'
  /** reset the target with SDI printf enabled — MRS's own post-flash step
   *  (MRSFunc_FlashOperationExB with flags RESET|SDIPrintf). Needed because
   *  the link only forwards printf data after this vendor sequence; plain
   *  SetSDIPrn or OpenOCD's sdi_printf leave the link in a state where the
   *  next reset does not reach the CDC port. */
  | 'sdiPrint';

export interface WlinkArgs {
  /** chip id from the series flash.json */
  chipId: number;
  /** CLK speed: 1=High 2=Middle 3=Low */
  clkSpeed: number;
  /** debug interface mode: 0=1-wire 1=2-wires */
  dbgMode: number;
  /** ClearCodeFlash sub-mode: 0=By Pin NRST 1=By Power */
  eraseMode?: number;
  /** SetMemType select value */
  memVal?: number;
  /** the install's wchlink.wcfg — required by the queryMcuId init sequence
   * (Windows transport; POSIX derives it from the install) */
  wcfgPath?: string;
  /** sdiPrint: .template Address as a number (unused by the flag set but
   *  required by the DLL signature) */
  flashAddress?: number;
  /** sdiPrint: resolved target file (unused by the flag set but required by
   *  the DLL signature) */
  flashPath?: string;
}

/**
 * The P/Invoke declaration block. The DLL exports ONLY the MRSFunc_* names
 * (verified from its export table), while the script bodies call the short
 * names — so each method is declared under the name the body uses and bound
 * to the real export through EntryPoint. Without EntryPoint every operation
 * failed with "does not contain a method named QueryRProtect" (the DLL was
 * never reached). Exports/signatures follow MRS2's own koffi bindings.
 */
function psDeclarations(): string {
  const decl = (name: string, entry: string, sig: string): string =>
    `  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall, EntryPoint = "${entry}")]\n` +
    `  public static extern int ${name}(${sig});\n`;
  return `
$code = @'
using System;
using System.Runtime.InteropServices;
public static class McuLink {
` +
    decl('QueryRProtect', 'MRSFunc_QueryRProtect', 'int chipId, int clk') +
    decl('EnableRProtect', 'MRSFunc_EnableRProtect', 'int chipId, int clk') +
    decl('DisableRProtect', 'MRSFunc_DisableRProtect', 'int chipId, int clk') +
    decl('DisableDbgInterface', 'MRSFunc_DisableDbgInterface', 'int chipId, int clk') +
    decl('GetLinkedMCUID', 'MRSFunc_GetLinkedMCUID', '') +
    decl('GetMemType', 'MRSFunc_GetMemType', 'int chipId, int clk') +
    decl('SetMemType', 'MRSFunc_SetMemType', 'int chipId, int clk, int val') +
    decl('ClearCodeFlash', 'MRSFunc_ClearCodeFlash', 'int chipId, int clk, int mode') +
    decl('SetTargetChip', 'McuCompiler_SetTargetChip', 'int chipId, int dbgMode') +
    decl('OpenDevice', 'McuCompiler_OpenDevice', '') +
    decl('CloseDevice', 'McuCompiler_CloseDevice', '') +
    decl('CompareVersion', 'McuCompiler_CompareVersion', 'string path, ref int a, ref int b') +
    // sdiPrint only: MRSFunc_FlashOperationExB is the same entry MRS2's
    // DownloadOperation binds; flags = RESET(1) | SDIPrintf(16) performs the
    // one sequence the WCH link needs before it forwards SDI data.
    decl('GetDeviceVersion', 'McuCompiler_GetDeviceVersion', 'ref int a, ref int b') +
    decl('FlashOperationExB', 'MRSFunc_FlashOperationExB', 'int chipId, int clk, int flags, int address, string path') +
    `
}
'@;
Add-Type -TypeDefinition $code;
`;
}

/** one operation per script; the JSON line on stdout is the result contract */
export function buildPsScript(commLib: CommLib, op: WlinkOp, args: WlinkArgs): string {
  const { chipId, clkSpeed, dbgMode } = args;
  // queryMcuId runs the MRS-parity init sequence first (OpenDevice →
  // CompareVersion → CloseDevice — MRS2's getChipID RPC runs its firmware
  // check before the query; without it the raw GetLinkedMCUID returns the
  // LINK's id (2/6) instead of the MCU family code on some chips/links).
  // $r.init reports how that sequence ended ('ok' only when the device opened
  // and CompareVersion said 0): consumers that ACT on the id (the download
  // chip guard) must not trust anything else.
  const initQueryMcuId =
    op === 'queryMcuId'
      ? `  $r.init = 'missing-wcfg';\n` +
        (args.wcfgPath
          ? `  try {\n` +
            `    $r.init = 'failed';\n` +
            `    if ([McuLink]::OpenDevice() -eq 0) {\n` +
            `      try {\n` +
            `        $ia = 0; $ib = 0;\n` +
            `        $rc = [McuLink]::CompareVersion('${String(args.wcfgPath).replace(/'/g, "''")}', [ref]$ia, [ref]$ib);\n` +
            `        if ($rc -eq 0) { $r.init = 'ok' } else { $r.init = 'upgrade-needed' }\n` +
            `      } finally { [void][McuLink]::CloseDevice(); }\n` +
            `    }\n` +
            `  } catch { }\n`
          : '')
      : '';
  const pre =
    `$ErrorActionPreference='Stop';\n` +
    `Add-Type -Namespace Win32 -Name Native -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetDllDirectory(string path);';\n` +
    `[Win32.Native]::SetDllDirectory('${commLib.dir.replace(/'/g, "''")}');\n` +
    psDeclarations() +
    `$r = @{op='${op}'};\n` +
    `try {\n` +
    `  if ('${op}' -ne 'queryMcuId' -and '${op}' -ne 'sdiPrint') { ` +
    `[void][McuLink]::SetTargetChip(${chipId}, ${dbgMode}); }\n`;
  let body: string;
  switch (op) {
    case 'queryMcuId':
      body = initQueryMcuId + `  $v = [McuLink]::GetLinkedMCUID(); $r.result = $v;\n`;
      break;
    case 'queryRpt':
      body = `  $v = [McuLink]::QueryRProtect(${chipId}, ${clkSpeed}); $r.result = $v;\n`;
      break;
    case 'enableRpt':
      body =
        `  [void][McuLink]::EnableRProtect(${chipId}, ${clkSpeed}); Start-Sleep -Milliseconds 200;\n` +
        `  $v = [McuLink]::QueryRProtect(${chipId}, ${clkSpeed}); $r.result = $v; $r.ok = ($v -eq 3);\n`;
      break;
    case 'disableRpt':
      body =
        `  [void][McuLink]::DisableRProtect(${chipId}, ${clkSpeed}); Start-Sleep -Milliseconds 200;\n` +
        `  $v = [McuLink]::QueryRProtect(${chipId}, ${clkSpeed}); $r.result = $v; $r.ok = ($v -eq 4);\n`;
      break;
    case 'disableDbg':
      body = `  $v = [McuLink]::DisableDbgInterface(${chipId}, ${clkSpeed}); $r.result = $v;\n`;
      break;
    case 'clearCodeFlash': {
      const mode = args.eraseMode ?? 0;
      body = `  $v = [McuLink]::ClearCodeFlash(${chipId}, ${clkSpeed}, ${mode}); $r.result = $v; $r.ok = ($v -eq 0);\n`;
      break;
    }
    case 'getMemType':
      body = `  $v = [McuLink]::GetMemType(${chipId}, ${clkSpeed}); $r.result = $v;\n`;
      break;
    case 'setMemType': {
      const val = args.memVal ?? 0;
      body = `  $v = [McuLink]::SetMemType(${chipId}, ${clkSpeed}, ${val}); $r.result = $v; $r.ok = ($v -eq 0);\n`;
      break;
    }
    case 'sdiPrint': {
      // flags 0x11 = RESET | SDIPrintf: the DLL resets the target and leaves
      // the link forwarding SDI printf. This is the minimal slice of MRS2's
      // FlashOperationExB (program/verify/erase flags omitted) — the full
      // call was verified on hardware to print the CH394Q boot banner.
      const addr = args.flashAddress ?? 0;
      const hexPath = String(args.flashPath ?? '').replace(/'/g, "''");
      body =
        `  if ([McuLink]::OpenDevice() -ne 0) { $r.error = 'McuCompiler_OpenDevice failed'; }\n` +
        `  else {\n` +
        `    try {\n` +
        `      $ga = 0; $gb = 0; [void][McuLink]::GetDeviceVersion([ref]$ga, [ref]$gb);\n` +
        `      [void][McuLink]::SetTargetChip(${chipId}, ${dbgMode});\n` +
        `      $v = [McuLink]::FlashOperationExB(${chipId}, ${clkSpeed}, 17, ${addr}, '${hexPath}');\n` +
        `      $r.result = $v; $r.ok = ($v -eq 0);\n` +
        `    } finally { [void][McuLink]::CloseDevice(); }\n` +
        `  }\n`;
      break;
    }
    default:
      throw new Error(`unknown wlink op: ${op}`);
  }
  const post =
    `} catch {\n  $r.error = $_.Exception.Message;\n}\n` +
    `$r | ConvertTo-Json -Compress | Write-Output;\n`;
  return pre + body + post;
}

/** How the queryMcuId init sequence (OpenDevice → CompareVersion →
 *  CloseDevice) ended. 'ok' = device opened AND CompareVersion reported 0;
 *  only then is GetLinkedMCUID a target-MCU answer rather than possibly the
 *  LINK's own id (LinkE 2.23 answers 2/6 raw — and 6 IS CH32V30x's id). */
export type WlinkInitState = 'ok' | 'upgrade-needed' | 'failed' | 'missing-wcfg';

export interface WlinkResult {
  op: WlinkOp;
  ok: boolean;
  /** raw DLL return value (3/4 for RPT state, chip id, mem type, 0=success...) */
  result?: number;
  /** queryMcuId only — see WlinkInitState */
  initState?: WlinkInitState;
  error?: string;
}

/** koffi.load with a sibling-preload fallback: the CommunicationLib directory
 *  holds libusb/hidapi next to libmcuupdate, and plain dlopen does not search
 *  the loading library's own directory for DT_NEEDED entries */
function loadMcuLib(koffi: KoffiLike, libPath: string): KoffiLib {
  try {
    return koffi.load(libPath);
  } catch (first) {
    const dir = path.dirname(libPath);
    const base = path.basename(libPath);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f === base || !f.startsWith('lib')) continue;
        if (!f.includes('.so') && !f.includes('.dylib')) continue;
        try {
          koffi.load(path.join(dir, f));
        } catch {
          // a sibling that fails to load may simply not be needed — skip
        }
      }
      return koffi.load(libPath);
    } catch (retry) {
      // report the ORIGINAL failure (the retry's dependency-chain noise hides it)
      throw first instanceof Error ? first : new Error(String(first));
    }
  }
}

/**
 * POSIX transport: IN-PROCESS koffi FFI — the same mechanism MRS's own
 * mrs-vscode extension uses, against the same CommunicationLib library
 * (libmcuupdate.so/.dylib). Sync FFI calls; the 200 ms settle gap between
 * Set and Query for the RPT toggles is the one await. `koffiModule` is a
 * test seam: undefined = the real require('koffi'), null = simulate a
 * missing dependency, an object = a scripted fake.
 */
export async function runWlinkOpPosix(
  install: MrsInstall,
  op: WlinkOp,
  args: WlinkArgs,
  koffiModule?: KoffiLike | null,
  /** test seam: the host the POSIX path runs on (production = process.platform;
   *  tests on a Windows machine pass 'linux' to exercise the POSIX resolvers) */
  platform: NodeJS.Platform = process.platform
): Promise<WlinkResult> {
  const commLib = resolveCommLib(install, platform);
  if (!commLib) {
    return {
      op,
      ok: false,
      error: `WCH CommunicationLib (${mcuLibFileName(platform)}) not found under the MounRiver installation`,
    };
  }
  let koffi: KoffiLike;
  if (koffiModule !== undefined) {
    if (!koffiModule) {
      return { op, ok: false, error: 'the koffi dependency is missing from this MRVC installation' };
    }
    koffi = koffiModule;
  } else {
    // two static literals: the dev repo resolves koffi from node_modules, the
    // installed extension from the shipped vendor-ffi copy (vsce cannot
    // re-include a negated node_modules subtree, so the runtime lives there)
    try {
      koffi = require('koffi') as KoffiLike;
    } catch {
      try {
        koffi = require('../vendor-ffi/node_modules/koffi') as KoffiLike;
      } catch {
        return { op, ok: false, error: 'the koffi dependency is missing from this MRVC installation' };
      }
    }
  }
  try {
    const lib = loadMcuLib(koffi, commLib.mcuDll);
    const bind = (name: string, n: number) => lib.func(name, 'int', Array(n).fill('int'));
    const SetTargetChip = bind('McuCompiler_SetTargetChip', 2);
    const QueryRProtect = bind('MRSFunc_QueryRProtect', 2);
    const EnableRProtect = bind('MRSFunc_EnableRProtect', 2);
    const DisableRProtect = bind('MRSFunc_DisableRProtect', 2);
    const DisableDbgInterface = bind('MRSFunc_DisableDbgInterface', 2);
    const GetLinkedMCUID = bind('MRSFunc_GetLinkedMCUID', 0);
    const GetMemType = bind('MRSFunc_GetMemType', 2);
    const SetMemType = bind('MRSFunc_SetMemType', 3);
    const ClearCodeFlash = bind('MRSFunc_ClearCodeFlash', 3);
    // same call sequence as the Windows P/Invoke script: SetTargetChip first
    // for everything except the raw chip-id query
    if (op !== 'queryMcuId' && op !== 'sdiPrint') {
      SetTargetChip(args.chipId, args.dbgMode);
    }
    let ok = false;
    let result: number | undefined;
    let initState: WlinkInitState | undefined;
    switch (op) {
      case 'queryMcuId':
        // MRS parity (MRS2's getChipID RPC runs its firmware check first):
        // without the init sequence the raw GetLinkedMCUID returns the LINK's
        // id (2/6) instead of the MCU family code on some chips/links
        // (LinkE 2.23 observed). The init stays best-effort for the query
        // itself (legacy raw fallback), but its outcome is REPORTED: the id
        // is only trustworthy with 'ok' (the download chip guard requires
        // that — raw 6 would otherwise pass for CH32V30x and raise a false
        // mismatch for every other family).
        {
          const wcfg = wchlinkFirmwareCfgPath(install);
          if (!fs.existsSync(wcfg)) {
            initState = 'missing-wcfg';
          } else {
            initState = 'failed';
            try {
              const OpenDevice = bind('McuCompiler_OpenDevice', 0);
              const CloseDevice = bind('McuCompiler_CloseDevice', 0);
              const CompareVersion = lib.func('McuCompiler_CompareVersion', 'int', ['string', 'int *', 'int *']);
              if (OpenDevice() === 0) {
                try {
                  initState = CompareVersion(wcfg, Buffer.alloc(4), Buffer.alloc(4)) === 0 ? 'ok' : 'upgrade-needed';
                } finally {
                  CloseDevice();
                }
              }
            } catch {
              // init failed — initState stays 'failed', the raw query below
              // still runs (legacy behaviour for Download Settings)
            }
          }
        }
        result = GetLinkedMCUID();
        break;
      case 'queryRpt':
        result = QueryRProtect(args.chipId, args.clkSpeed);
        break;
      case 'enableRpt':
        EnableRProtect(args.chipId, args.clkSpeed);
        await new Promise((res) => setTimeout(res, 200));
        result = QueryRProtect(args.chipId, args.clkSpeed);
        ok = result === 3;
        break;
      case 'disableRpt':
        DisableRProtect(args.chipId, args.clkSpeed);
        await new Promise((res) => setTimeout(res, 200));
        result = QueryRProtect(args.chipId, args.clkSpeed);
        ok = result === 4;
        break;
      case 'disableDbg':
        result = DisableDbgInterface(args.chipId, args.clkSpeed);
        break;
      case 'clearCodeFlash':
        result = ClearCodeFlash(args.chipId, args.clkSpeed, args.eraseMode ?? 0);
        ok = result === 0;
        break;
      case 'getMemType':
        result = GetMemType(args.chipId, args.clkSpeed);
        break;
      case 'setMemType':
        result = SetMemType(args.chipId, args.clkSpeed, args.memVal ?? 0);
        ok = result === 0;
        break;
      case 'sdiPrint': {
        // MRS parity: the reset+SDI sequence needs its own device session,
        // and SetTargetChip must run AFTER OpenDevice (unlike the config ops
        // above, which are handed an already-open device by the caller).
        const OpenDevice = bind('McuCompiler_OpenDevice', 0);
        const CloseDevice = bind('McuCompiler_CloseDevice', 0);
        const GetDeviceVersion = lib.func('McuCompiler_GetDeviceVersion', 'int', ['int *', 'int *']);
        const FlashOperationExB = lib.func('MRSFunc_FlashOperationExB', 'int', ['int', 'int', 'int', 'int', 'string']);
        if (OpenDevice() !== 0) {
          return { op, ok: false, error: 'McuCompiler_OpenDevice failed' };
        }
        try {
          GetDeviceVersion(Buffer.alloc(4), Buffer.alloc(4));
          SetTargetChip(args.chipId, args.dbgMode);
          result = FlashOperationExB(args.chipId, args.clkSpeed, 17, args.flashAddress ?? 0, args.flashPath ?? '');
          ok = result === 0;
        } finally {
          CloseDevice();
        }
        break;
      }
      default:
        throw new Error(`unknown wlink op: ${op}`);
    }
    return { op, ok, result, initState };
  } catch (e) {
    return { op, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** run one operation through the platform bridge: Windows PowerShell P/Invoke
 *  (the 32-bit MRS2 DLL cannot load into the 64-bit extension host), POSIX
 *  in-process koffi against the install's own libmcuupdate */
export function runWlinkOp(install: MrsInstall, op: WlinkOp, args: WlinkArgs): Promise<WlinkResult> {
  if (process.platform !== 'win32') {
    return runWlinkOpPosix(install, op, args);
  }
  const commLib = resolveCommLib(install);
  if (!commLib || !fs.existsSync(commLib.mcuDll)) {
    return Promise.resolve({ op, ok: false, error: 'WCH CommunicationLib (McuCompilerDll.dll) not found under the MounRiver installation' });
  }
  // MRS2 ships a 32-bit DLL (SysWOW64 PowerShell), the MRS3 beta a 64-bit one
  const psExe = bridgePowerShell(commLib.mcuDll);
  if (!fs.existsSync(psExe)) {
    return Promise.resolve({ op, ok: false, error: 'Windows PowerShell not found on this system (' + psExe + ')' });
  }
  // queryMcuId: hand the wcfg over only when it exists — a nonexistent path
  // would turn the script's init state into failed/upgrade-needed instead of
  // the truthful 'missing-wcfg', plus a pointless CompareVersion call
  let psArgs = args;
  if (op === 'queryMcuId') {
    const wcfgPath = wchlinkFirmwareCfgPath(install);
    psArgs = { ...args, wcfgPath: fs.existsSync(wcfgPath) ? wcfgPath : undefined };
  }
  const script = buildPsScript(commLib, op, psArgs);
  const ps1 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mrvc-wlink-')), 'op.ps1');
  // BOM: Windows PowerShell 5.1 decodes BOM-less scripts as ANSI, which
  // mangles non-ASCII install paths (Chinese folder names are common)
  fs.writeFileSync(ps1, '\uFEFF' + script, 'utf-8');
  const timeout = op === 'clearCodeFlash' ? 120000 : 30000; // chip erase is slow
  return new Promise((resolve) => {
    execFile(
      psExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { timeout, windowsHide: true },
      (err, stdout) => {
        try {
          fs.rmSync(path.dirname(ps1), { recursive: true, force: true });
        } catch {
          // temp cleanup best-effort
        }
        const line = (stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
        if (!line) {
          resolve({ op, ok: false, error: err?.message ?? 'no result from the PowerShell bridge' });
          return;
        }
        try {
          const parsed = JSON.parse(line);
          // ok = the operation succeeded (script sets it); result carries
          // the raw DLL code for value-specific wording either way. The
          // script's $r.init is the queryMcuId trust state — surfaced under a
          // typed name so consumers cannot confuse it with ok.
          const init = parsed.init;
          const initState =
            init === 'ok' || init === 'upgrade-needed' || init === 'failed' || init === 'missing-wcfg' ? init : undefined;
          resolve({ op, ok: parsed.ok === true, ...parsed, initState });
        } catch {
          resolve({ op, ok: false, error: `unparsable bridge output: ${line}` });
        }
      }
    );
  });
}

// ---- WCH-Link firmware version check (0.2.8, READ-ONLY) --------------------
//
// An out-of-date WCH-Link firmware misbehaves during flashing (MRS's own
// download path runs a version check before every download and refuses into
// a modal upgrade flow — decompiled from mrs-vscode's doUpdate). MRVC does
// NOT touch the link firmware: it only detects the version mismatch and
// directs the user to WCH-LinkUtility. Everything here is read-only —
// OpenDevice / CompareVersion / GetDeviceVersion / CloseDevice — and any
// failure degrades to state 'error' (the flash path treats that as silent).

export interface WlinkFirmwareCheck {
  state: 'no-link' | 'up-to-date' | 'upgrade-needed' | 'error';
  /** raw linkID byte from CompareVersion's out param (0/1=WCH-Link, 2/18=LinkE, 4=DAPLink, 5/133=LinkW) */
  linkId?: number;
  /** the connected link model, e.g. "WCH-Link", "WCH-LinkE" */
  linkName?: string;
  /** current link firmware version number (10..99 meaningful, MRS parity) */
  currentVersion?: number;
  /** expected version from the installation's wchlink.wcfg */
  expectedVersion?: number;
  error?: string;
}

/**
 * The installation's wchlink.wcfg (the DLL parses it itself — MRS only
 * hands the path over FFI): `<platform layer>/components/WCH/Others/
 * Firmware_Link/default/wchlink.wcfg`. Ships with MRS3; an MRS2-era install
 * may lack it, in which case the check reports an error and the caller
 * stays silent.
 */
export function wchlinkFirmwareCfgPath(install: MrsInstall): string {
  return path.join(install.resourcesDir, 'components', 'WCH', 'Others', 'Firmware_Link', 'default', 'wchlink.wcfg');
}

/** linkID → model/chip (decompiled from mrs-vscode's getByLinkID) */
export function linkInfoFor(linkId: number): { name: string; chipType: string } {
  switch (linkId) {
    case 2:
    case 18:
      return { name: 'WCH-LinkE', chipType: 'CH32V305' };
    case 4:
      return { name: 'WCH-DAPLink', chipType: 'CH32V203' };
    case 5:
    case 133:
      return { name: 'WCH-LinkW', chipType: 'CH32V208' };
    default:
      return { name: 'WCH-Link', chipType: 'CH549' };
  }
}

/**
 * Does this link support power-OUTPUT control (the pow3v3/pow5v rail
 * switching the power-off reset needs)? Per WCH's own manuals only
 * WCH-LinkE / WCH-DAPLink / WCH-LinkW have it — the plain WCH-Link does not
 * (its 3.3 V target feed is not switchable, and there is no 5 V rail at
 * all). Unknown ids answer undefined: never guessed into either direction.
 */
export function linkSupportsPowerOutput(linkId: number | undefined): boolean | undefined {
  if (linkId === undefined) return undefined;
  if (linkId === 2 || linkId === 18 || linkId === 4 || linkId === 5 || linkId === 133) return true;
  if (linkId === 0 || linkId === 1) return false;
  return undefined;
}

/**
 * Expected link firmware version from the wcfg text (decompiled from
 * mrs-vscode's version lookup): key = chipType + "Ver", with the CH549
 * special cases "_RV" (linkId 0) / "_ARM" (linkId 1 + DAP variant) and the
 * "CH32V305Ver" → "CH32V307Ver" remap. Undefined when the key is absent.
 */
export function expectedFirmwareVersion(cfgText: string, linkId: number, isDap = false): number | undefined {
  let key = linkInfoFor(linkId).chipType + 'Ver';
  if (linkId === 0) key += '_RV';
  else if (linkId === 1) key += isDap ? '_ARM' : '_RV';
  if (key === 'CH32V305Ver') key = 'CH32V307Ver';
  for (const line of cfgText.split(/\r?\n/)) {
    const m = line.trim().match(new RegExp('^' + key + '=(\\d+)$'));
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** `v` + zero-padded two-digit version (mrs-vscode's w() formatting); a
 *  value outside the meaningful 10..99 band formats as `?` — never show a
 *  fabricated v00/v-1/v123 (round2 §6) */
export function formatLinkVersion(n: number | undefined): string {
  return n !== undefined && n >= 10 && n <= 99 ? 'v' + String(n).padStart(2, '0') : '?';
}

/**
 * The Windows P/Invoke counterpart of buildPsScript for the firmware check.
 * CompareVersion takes a string (the wcfg path) and two int* out params —
 * the ONLY string/pointer declarations in the whole bridge — returning
 * 0 = up to date, 1 = upgrade needed; out1's low byte is the linkID.
 */
export function buildPsFirmwareCheckScript(commLib: CommLib, wcfgPath: string): string {
  const decl = (name: string, entry: string, sig: string): string =>
    `  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall, EntryPoint = "${entry}")]\n` +
    `  public static extern int ${name}(${sig});\n`;
  const quoted = wcfgPath.replace(/'/g, "''");
  return (
    `$ErrorActionPreference='Stop';\n` +
    `Add-Type -Namespace Win32 -Name Native -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetDllDirectory(string path);';\n` +
    `[Win32.Native]::SetDllDirectory('${commLib.dir.replace(/'/g, "''")}');\n` +
    `$code = @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class McuLink {\n` +
    decl('OpenDevice', 'McuCompiler_OpenDevice', '') +
    decl('CloseDevice', 'McuCompiler_CloseDevice', '') +
    decl('GetDeviceVersion', 'McuCompiler_GetDeviceVersion', 'ref int a, ref int b') +
    decl('CompareVersion', 'McuCompiler_CompareVersion', 'string path, ref int a, ref int b') +
    `\n}\n'@;\n` +
    `Add-Type -TypeDefinition $code;\n` +
    `$r = @{op='firmwareCheck'};\n` +
    `$opened = $false;\n` +
    `try {\n` +
    `  $open = [McuLink]::OpenDevice();\n` +
    `  if ($open -ne 0) { $r.state = 'no-link'; }\n` +
    `  else {\n` +
    `    $opened = $true;\n` +
    `    $a = 0; $b = 0;\n` +
    `    $c = [McuLink]::CompareVersion('${quoted}', [ref]$a, [ref]$b);\n` +
    `    $r.linkId = ($a -band 255);\n` +
    `    if ($c -eq 0) { $r.state = 'up-to-date'; }\n` +
    `    elseif ($c -eq 1) {\n` +
    `      $r.state = 'upgrade-needed';\n` +
    `      $va = 0; $vb = 0;\n` +
    `      $r.version = [McuLink]::GetDeviceVersion([ref]$va, [ref]$vb);\n` +
    `    }\n` +
    `    else { $r.state = 'error'; $r.error = ('CompareVersion code ' + $c); }\n` +
    `  }\n` +
    `} catch {\n  $r.state = 'error'; $r.error = $_.Exception.Message;\n` +
    `} finally {\n` +
    `  if ($opened) { try { [void][McuLink]::CloseDevice(); } catch { } }\n` +
    `}\n` +
    `$r | ConvertTo-Json -Compress | Write-Output;\n`
  );
}

/**
 * Shared post-processing for a bridge result (round3 §2): remaps the
 * Windows script's `version` field to `currentVersion` and rejects device
 * versions outside the meaningful 10..99 band (mrs-vscode's -2 semantics —
 * a garbage FFI read must not surface as a fabricated v00/v123 upgrade
 * prompt). Exported for direct unit testing of BOTH platforms' behaviour
 * from one place.
 */
export function normalizeFirmwareCheck(parsed: Partial<WlinkFirmwareCheck> & { version?: number }): Partial<WlinkFirmwareCheck> {
  if (parsed.version !== undefined && parsed.currentVersion === undefined) {
    parsed.currentVersion = parsed.version;
    delete parsed.version;
  }
  const v = parsed.currentVersion;
  if (v !== undefined && (v < 10 || v > 99)) {
    return { ...parsed, state: 'error', error: `device version out of range: ${v}` };
  }
  return parsed;
}

/**
 * Read-only WCH-Link firmware version check (the detect-only half of MRS's
 * doUpdate). POSIX: in-process koffi, Buffer args for the int* out params
 * (the same marshalling mrs-vscode uses — a Buffer IS the pointer target).
 * Windows: the PowerShell bridge above. Never throws — every failure path
 * resolves to state 'error' so the flash flow can skip it silently.
 */
export async function checkWCHLinkFirmware(
  install: MrsInstall,
  koffiModule?: KoffiLike | null,
  platform: NodeJS.Platform = process.platform
): Promise<WlinkFirmwareCheck> {
  const wcfg = wchlinkFirmwareCfgPath(install);
  const finish = (c: Partial<WlinkFirmwareCheck>): WlinkFirmwareCheck => {
    if (c.linkId !== undefined) {
      const info = linkInfoFor(c.linkId);
      c.linkName = info.name;
      try {
        c.expectedVersion = expectedFirmwareVersion(fs.readFileSync(wcfg, 'utf-8'), c.linkId);
      } catch {
        // unreadable wcfg — the expected version stays undefined
      }
    }
    return { state: 'error', ...c } as WlinkFirmwareCheck;
  };
  if (!fs.existsSync(wcfg)) {
    return { state: 'error', error: 'wchlink.wcfg not found under the MounRiver installation' };
  }

  const runPosix = async (): Promise<WlinkFirmwareCheck> => {
    const commLib = resolveCommLib(install, platform);
    if (!commLib) {
      return { state: 'error', error: `WCH CommunicationLib (${mcuLibFileName(platform)}) not found under the MounRiver installation` };
    }
    let koffi: KoffiLike;
    if (koffiModule !== undefined) {
      if (!koffiModule) return { state: 'error', error: 'the koffi dependency is missing from this MRVC installation' };
      koffi = koffiModule;
    } else {
      try {
        koffi = require('koffi') as KoffiLike;
      } catch {
        try {
          koffi = require('../vendor-ffi/node_modules/koffi') as KoffiLike;
        } catch {
          return { state: 'error', error: 'the koffi dependency is missing from this MRVC installation' };
        }
      }
    }
    try {
      const lib = loadMcuLib(koffi, commLib.mcuDll);
      const OpenDevice = lib.func('McuCompiler_OpenDevice', 'int', []);
      const CloseDevice = lib.func('McuCompiler_CloseDevice', 'int', []);
      const GetDeviceVersion = lib.func('McuCompiler_GetDeviceVersion', 'int', ['int *', 'int *']);
      const CompareVersion = lib.func('McuCompiler_CompareVersion', 'int', ['string', 'int *', 'int *']);
      const open = OpenDevice();
      if (open !== 0) return finish({ state: 'no-link', linkId: undefined });
      try {
        const out1 = Buffer.alloc(4);
        const out2 = Buffer.alloc(4);
        const c = CompareVersion(wcfg, out1, out2);
        const linkId = out1.readInt32LE(0) & 255;
        if (c === 0) return finish({ state: 'up-to-date', linkId });
        if (c === 1) {
          const v = GetDeviceVersion(Buffer.alloc(4), Buffer.alloc(4));
          // the 10..99 band check lives in normalizeFirmwareCheck — shared
          // with the Windows JSON path (round3 §2)
          return finish(normalizeFirmwareCheck({ state: 'upgrade-needed', linkId, currentVersion: v }));
        }
        return finish({ state: 'error', linkId, error: `CompareVersion code ${c}` });
      } finally {
        try {
          CloseDevice();
        } catch {
          // close is best-effort — the check result stands
        }
      }
    } catch (e) {
      return { state: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  };

  if (platform !== 'win32') return runPosix();

  const commLib = resolveCommLib(install, 'win32');
  if (!commLib || !fs.existsSync(commLib.mcuDll)) {
    return { state: 'error', error: 'WCH CommunicationLib (McuCompilerDll.dll) not found under the MounRiver installation' };
  }
  const psExe = bridgePowerShell(commLib.mcuDll);
  if (!fs.existsSync(psExe)) {
    return { state: 'error', error: 'Windows PowerShell not found on this system (' + psExe + ')' };
  }
  const script = buildPsFirmwareCheckScript(commLib, wcfg);
  const ps1 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mrvc-wlink-')), 'fwcheck.ps1');
  fs.writeFileSync(ps1, '\uFEFF' + script, 'utf-8');
  return new Promise((resolve) => {
    execFile(
      psExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        try {
          fs.rmSync(path.dirname(ps1), { recursive: true, force: true });
        } catch {
          // temp cleanup best-effort
        }
        const line = (stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
        if (!line) {
          resolve({ state: 'error', error: err?.message ?? 'no result from the PowerShell bridge' });
          return;
        }
        try {
          const parsed = JSON.parse(line) as Partial<WlinkFirmwareCheck> & { op?: string; version?: number };
          delete parsed.op;
          // normalizeFirmwareCheck remaps `version` → currentVersion and
          // enforces the 10..99 band for BOTH platforms (round3 §2)
          resolve(finish(normalizeFirmwareCheck(parsed)));
        } catch {
          resolve({ state: 'error', error: `unparsable bridge output: ${line}` });
        }
      }
    );
  });
}

/** human-readable result for the Operation Record pane */
export function describeResult(op: WlinkOp, r: WlinkResult): string {
  if (r.error) return `${op}: ERROR — ${r.error}`;
  const v = r.result ?? -1;
  switch (op) {
    case 'queryMcuId':
      // the id is an SDK SERIES id (CH32V307 -> 6) — the caller resolves the
      // display name (CH32V30x) from the chip database, not here
      return v > 0 && v < 10000
        ? `Linked MCU chip id: ${v}`
        : `Linked MCU query failed (code ${v}) — check the WCH-Link connection`;
    case 'queryRpt':
      return v === 3 ? 'Code-Protect is Enable' : v === 4 ? 'Code-Protect is Disable' : `Query failed (code ${v})`;
    case 'enableRpt':
      return r.ok ? 'Read protection ENABLED' : `Enable failed (query returned ${v})`;
    case 'disableRpt':
      return r.ok ? 'Read protection DISABLED' : `Disable failed (query returned ${v})`;
    case 'disableDbg':
      return v === 0 ? 'Debug interface disabled' : v === 3 ? 'Current MCU does not support this function' : `Operation failed (code ${v})`;
    case 'clearCodeFlash':
      return r.ok ? 'Code flash erased' : `Erase failed (code ${v})`;
    case 'getMemType':
      return v >= 10 && v < 100 ? `Memory assign: group ${Math.floor(v / 10)}, option ${v % 10}` : `Memory assign query failed (code ${v})`;
    case 'setMemType':
      return r.ok ? 'Memory assign applied' : `Memory assign failed (code ${v})`;
    case 'sdiPrint':
      return r.ok ? 'SDI printf enabled (target reset)' : `SDI printf reset failed (code ${v})`;
    default:
      return `${op}: ${v}`;
  }
}
