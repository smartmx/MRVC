/**
 * WCH-Link operations bridge (pure Node).
 *
 * MRS2 drives the Download Settings hardware operations (read protection,
 * chip ID query, memory assign, ...) through in-process FFI on the 32-bit
 * McuCompilerDll.dll. MRVC runs inside a 64-bit VSCode host which cannot
 * load that DLL, so each operation is generated as a small PowerShell
 * script (Add-Type P/Invoke, same stdcall exports MRS2 binds with koffi)
 * and executed by the 32-bit Windows PowerShell that ships with every
 * 64-bit Windows (SysWOW64). Results come back as one JSON line.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { MrsInstall } from './toolchain';

export const OP_LOGIC_PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export interface CommLib {
  dir: string;
  mcuDll: string;
  usbDll: string;
}

/** CommunicationLib/default + load.wcfg -> { mcudll, libdll } */
export function resolveCommLib(install: MrsInstall): CommLib | null {
  const dir = path.join(install.resourcesWin32, 'components', 'WCH', 'Others', 'CommunicationLib', 'default');
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

/** The P/Invoke declaration block — same stdcall exports MRS2 binds. */
function psDeclarations(): string {
  return `
$code = @'
using System;
using System.Runtime.InteropServices;
public static class McuLink {
  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern int MRSFunc_QueryRProtect(int chipId, int clk);
  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern int MRSFunc_EnableRProtect(int chipId, int clk);
  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern int MRSFunc_DisableRProtect(int chipId, int clk);
  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern int MRSFunc_DisableDbgInterface(int chipId, int clk);
  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern int MRSFunc_GetLinkedMCUID();
  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern int MRSFunc_GetMemType(int chipId, int clk);
  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern int MRSFunc_SetMemType(int chipId, int clk, int val);
  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern int MRSFunc_ClearCodeFlash(int chipId, int clk, int mode);
  [DllImport("McuCompilerDll.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern int McuCompiler_SetTargetChip(int chipId, int dbgMode);
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

/** run one operation through the 32-bit PowerShell bridge */
export function runWlinkOp(install: MrsInstall, op: WlinkOp, args: WlinkArgs): Promise<WlinkResult> {
  const commLib = resolveCommLib(install);
  if (!commLib || !fs.existsSync(commLib.mcuDll)) {
    return Promise.resolve({ op, ok: false, error: 'WCH CommunicationLib (McuCompilerDll.dll) not found under the MRS2 installation' });
  }
  if (!fs.existsSync(OP_LOGIC_PATH)) {
    return Promise.resolve({ op, ok: false, error: '32-bit Windows PowerShell (SysWOW64) not found on this system' });
  }
  const script = buildPsScript(commLib, op, args);
  const ps1 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mrvc-wlink-')), 'op.ps1');
  // BOM: Windows PowerShell 5.1 decodes BOM-less scripts as ANSI, which
  // mangles non-ASCII install paths (Chinese folder names are common)
  fs.writeFileSync(ps1, '\uFEFF' + script, 'utf-8');
  const timeout = op === 'clearCodeFlash' ? 120000 : 30000; // chip erase is slow
  return new Promise((resolve) => {
    execFile(
      OP_LOGIC_PATH,
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
          resolve({ op, ok: false, error: err?.message ?? 'no result from the 32-bit PowerShell bridge' });
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
