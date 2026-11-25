/**
 * MRS Tools launcher paths (pure Node) — resolves the external tools that
 * MRS2/MRS3's Tools menu starts. Two layouts, matching MRS:
 *   component layout: <res>/components/WCH/Others/<comp>/default/<exe>
 *   flat others layout: <res>/others/<dir>/<exe>
 * Every entry is existence-checked: the GUI tools ship only in the Windows
 * installs, so on Linux/macOS (and for a standalone toolchain root) all of
 * them resolve to '' and the commands degrade to a not-found message.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MrsInstall } from './toolchain';

export interface MrsTools {
  linkUtility: string;
  ispStudio: string;
  touchkeyTool: string;
  uiDesigner: string;
  hexBinStudio: string;
  comTransmit: string;
  /** MRS3-only: the WCH ToolKit launcher (component WCHToolKit). MRS2 ships no
   *  such component, so this resolves to '' there — and the menu item, gated on
   *  the ACTIVE installation being MRS3, is not offered at all. */
  wchToolKit: string;
}

/** resolve every tool executable; empty string = that component is missing.
 *  linkUtility is existence-checked like the rest (0.3.7 round1 P3.1 exposed
 *  it: `install.linkUtilityExe` is only the EXPECTED path, and the old
 *  all-six gate happened to mask the unchecked value — with one key per tool
 *  it would have shown a launcher whose exe is absent) */
export function resolveMrsTools(install: MrsInstall): MrsTools {
  const wchOthers = path.join(install.resourcesDir, 'components', 'WCH', 'Others');
  const othersFlat = path.join(install.resourcesDir, 'others');
  const tool = (base: string, rel: string): string => {
    const p = path.join(base, rel);
    return fs.existsSync(p) ? p : '';
  };
  const linkUtility = install.linkUtilityExe ?? '';
  return {
    linkUtility: linkUtility && fs.existsSync(linkUtility) ? linkUtility : '',
    ispStudio: tool(wchOthers, path.join('WCHISPTool', 'default', 'WchIspStudio.exe')),
    touchkeyTool: tool(wchOthers, path.join('WCHTouchKeyTool', 'default', 'WCHTouchKeyTool.exe')),
    uiDesigner: tool(wchOthers, path.join('WCHGUIDesigner', 'default', 'WCHGUIDesigner.exe')),
    hexBinStudio: tool(othersFlat, path.join('HexBinStudio', 'HexBinStudio.exe')),
    comTransmit: tool(othersFlat, path.join('COMTransmit', 'COMTransmit.exe')),
    wchToolKit: tool(wchOthers, path.join('WCHToolKit', 'default', 'WCHToolKit.exe')),
  };
}

/**
 * Context key each `…` menu entry is gated on, by tool (0.3.7).
 * wchToolKit's entry is additionally gated on `mrvc.mrs3Active` in the menu
 * itself — MRS2 ships no such component.
 */
export const MRS_TOOL_CONTEXT_KEYS: Record<keyof MrsTools, string> = {
  linkUtility: 'mrvc.tool.linkUtility',
  ispStudio: 'mrvc.tool.ispStudio',
  touchkeyTool: 'mrvc.tool.touchkey',
  uiDesigner: 'mrvc.tool.uiDesigner',
  hexBinStudio: 'mrvc.tool.hexBinStudio',
  comTransmit: 'mrvc.tool.comTransmit',
  wchToolKit: 'mrvc.tool.wchToolKit',
};

/**
 * Which of the `…` menu's tools exist in the effective install — PER TOOL
 * (0.3.7 round1 P3.1: the first cut used ONE key for all six, so a single
 * missing exe hid the five working tools behind it). The GUI tools ship only
 * in Windows IDE installs: on Linux/macOS and for a standalone toolchain
 * root every exe is absent and every key is false without any further
 * check. Existence is the truth for Windows.
 */
export function mrsToolAvailability(
  install: MrsInstall | null | undefined,
  platform: NodeJS.Platform = process.platform
): Record<keyof MrsTools, boolean> {
  const tools = install && platform === 'win32' ? resolveMrsTools(install) : undefined;
  const out = {} as Record<keyof MrsTools, boolean>;
  for (const key of Object.keys(MRS_TOOL_CONTEXT_KEYS) as Array<keyof MrsTools>) {
    out[key] = !!tools && tools[key] !== '';
  }
  return out;
}
