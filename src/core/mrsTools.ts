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

/** resolve every tool executable; empty string = that component is missing */
export function resolveMrsTools(install: MrsInstall): MrsTools {
  const wchOthers = path.join(install.resourcesDir, 'components', 'WCH', 'Others');
  const othersFlat = path.join(install.resourcesDir, 'others');
  const tool = (base: string, rel: string): string => {
    const p = path.join(base, rel);
    return fs.existsSync(p) ? p : '';
  };
  return {
    linkUtility: install.linkUtilityExe ?? '',
    ispStudio: tool(wchOthers, path.join('WCHISPTool', 'default', 'WchIspStudio.exe')),
    touchkeyTool: tool(wchOthers, path.join('WCHTouchKeyTool', 'default', 'WCHTouchKeyTool.exe')),
    uiDesigner: tool(wchOthers, path.join('WCHGUIDesigner', 'default', 'WCHGUIDesigner.exe')),
    hexBinStudio: tool(othersFlat, path.join('HexBinStudio', 'HexBinStudio.exe')),
    comTransmit: tool(othersFlat, path.join('COMTransmit', 'COMTransmit.exe')),
    wchToolKit: tool(wchOthers, path.join('WCHToolKit', 'default', 'WCHToolKit.exe')),
  };
}
