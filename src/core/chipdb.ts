/**
 * Chip database (pure Node) — scans the MRS2 SDK component tree the same
 * way MRS2 builds its "Target MCU Type" picker:
 *   <SDK/default>/<ARCH>/<series>/NoneOS/*.zip  -> one chip model each
 *   <SDK/default>/<ARCH>/<series>/<series>-flash.json -> series-level
 *       MCU type ("type") and flash download address ("flash_address")
 * Chip series never change the OpenOCD config choice; the address rides on
 * the project .template (written by the properties Chip page).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ChipSupport {
  readProtectOpts: boolean;
  eraseCodeFlash: boolean;
  memoryAssign: boolean;
  eraseAll: boolean;
  program: boolean;
  verify: boolean;
  resetRun: boolean;
  spiPrintf: boolean;
  debugInterfaceMode: boolean;
}

export interface ChipSeries {
  /** series folder name, e.g. CH32H417 */
  name: string;
  /** RISC-V | ARM (top-level SDK folders) */
  arch: string;
  /** series-level MCU type from <series>-flash.json (defaults to the folder name) */
  mcuType: string;
  /** default flash download address from <series>-flash.json (may be empty) */
  flashAddress: string;
  /** chip models (NoneOS *.zip basenames), sorted */
  chips: string[];
  /** WCH-Link chip ID used by McuCompilerDll (flash.json "id") */
  id: number;
  /** per-chip hardware capability switches (flash.json "support_*") */
  support: ChipSupport;
}

export interface ChipDb {
  /** false when the SDK component folder is missing (MRS2 without SDK) */
  available: boolean;
  series: ChipSeries[];
}

/** <MRS2 install>/resources/win32/components/WCH/SDK/default */
export function chipDbRoot(resourcesWin32: string): string {
  return path.join(resourcesWin32, 'components', 'WCH', 'SDK', 'default');
}

export function scanChipDb(sdkDir: string): ChipDb {
  const db: ChipDb = { available: false, series: [] };
  let archDirs: fs.Dirent[];
  try {
    archDirs = fs.readdirSync(sdkDir, { withFileTypes: true });
  } catch {
    return db;
  }
  for (const archDir of archDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!archDir.isDirectory()) continue;
    const archPath = path.join(sdkDir, archDir.name);
    let seriesDirs: fs.Dirent[];
    try {
      seriesDirs = fs.readdirSync(archPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const seriesDir of seriesDirs.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!seriesDir.isDirectory()) continue;
      const name = seriesDir.name;
      const noneOs = path.join(archPath, name, 'NoneOS');
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(noneOs, { withFileTypes: true });
      } catch {
        continue; // no NoneOS payload -> not selectable in MRS2 either
      }
      const chips = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.zip'))
        .map((e) => e.name.slice(0, -4))
        .sort((a, b) => a.localeCompare(b));
      if (!chips.length) continue;
      let mcuType = name;
      let flashAddress = '';
      let id = 0;
      const support: ChipSupport = {
        readProtectOpts: false,
        eraseCodeFlash: false,
        memoryAssign: false,
        eraseAll: false,
        program: false,
        verify: false,
        resetRun: false,
        spiPrintf: false,
        debugInterfaceMode: false,
      };
      try {
        const flash = JSON.parse(fs.readFileSync(path.join(noneOs, `${name}-flash.json`), 'utf-8'));
        if (typeof flash.type === 'string' && flash.type) mcuType = flash.type;
        if (typeof flash.flash_address === 'string') flashAddress = flash.flash_address;
        if (typeof flash.id === 'number') id = flash.id;
        for (const key of Object.keys(support) as Array<keyof ChipSupport>) {
          if (typeof flash[`support_${key}`] === 'boolean') support[key] = flash[`support_${key}`];
        }
      } catch {
        // missing/invalid metadata: keep the folder-name default
      }
      db.series.push({ name, arch: archDir.name, mcuType, flashAddress, chips, id, support });
    }
  }
  db.available = db.series.length > 0;
  return db;
}
