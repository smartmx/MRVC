/**
 * MRS2 Tools launcher paths (pure Node) — resolves the external tools that
 * MRS2's Tools menu starts. Two layouts, matching MRS2:
 *   component layout: <win32>/components/WCH/Others/<comp>/default/<exe>
 *   flat others layout: <win32>/others/<dir>/<exe>
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
}

/** resolve every tool executable; empty string = that component is missing */
export function resolveMrsTools(install: MrsInstall): MrsTools {
  const wchOthers = path.join(install.resourcesWin32, 'components', 'WCH', 'Others');
  const othersFlat = path.join(install.resourcesWin32, 'others');
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
  };
}
