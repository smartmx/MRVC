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
  func(name: string, retType: string, argTypes: string[]): (...args: number[]) => number;
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
  | 'setMemType';

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
    `
}
'@;
Add-Type -TypeDefinition $code;
`;
}

/** one operation per script; the JSON line on stdout is the result contract */
export function buildPsScript(commLib: CommLib, op: WlinkOp, args: WlinkArgs): string {
  const { chipId, clkSpeed, dbgMode } = args;
  const pre =
    `$ErrorActionPreference='Stop';\n` +
    `Add-Type -Namespace Win32 -Name Native -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetDllDirectory(string path);';\n` +
    `[Win32.Native]::SetDllDirectory('${commLib.dir.replace(/'/g, "''")}');\n` +
    psDeclarations() +
    `$r = @{op='${op}'};\n` +
    `try {\n` +
    `  if ('${op}' -ne 'queryMcuId') { ` +
    `[void][McuLink]::SetTargetChip(${chipId}, ${dbgMode}); }\n`;
  let body: string;
  switch (op) {
    case 'queryMcuId':
      body = `  $v = [McuLink]::GetLinkedMCUID(); $r.result = $v;\n`;
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
    default:
      throw new Error(`unknown wlink op: ${op}`);
  }
  const post =
    `} catch {\n  $r.error = $_.Exception.Message;\n}\n` +
    `$r | ConvertTo-Json -Compress | Write-Output;\n`;
  return pre + body + post;
}

export interface WlinkResult {
  op: WlinkOp;
  ok: boolean;
  /** raw DLL return value (3/4 for RPT state, chip id, mem type, 0=success...) */
  result?: number;
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
    if (op !== 'queryMcuId') SetTargetChip(args.chipId, args.dbgMode);
    let ok = false;
    let result: number | undefined;
    switch (op) {
      case 'queryMcuId':
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
      default:
        throw new Error(`unknown wlink op: ${op}`);
    }
    return { op, ok, result };
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
  const script = buildPsScript(commLib, op, args);
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
          // the raw DLL code for value-specific wording either way
          resolve({ op, ok: parsed.ok === true, ...parsed });
        } catch {
          resolve({ op, ok: false, error: `unparsable bridge output: ${line}` });
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
      return v > 0 && v < 10000 ? `Linked MCU chip id: ${v}` : `Linked MCU query failed (code ${v}) — check the WCH-Link connection`;
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
    default:
      return `${op}: ${v}`;
  }
}
