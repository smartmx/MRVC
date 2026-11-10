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
  /** flash.json "special": one model whose flash control (id/type/support)
   *  differs from the series default — MRS2 swaps the whole control for it
   *  (current SDK: CH32V203CCT reports CH32V205's control, id 206) */
  special?: ChipSpecial;
}

export interface ChipSpecial {
  /** the model (zip basename) the override applies to */
  mcu: string;
  /** override MCU type ("type" of the corresponding control) */
  mcuType: string;
  /** override chip id (the "corresponding" control's id) */
  id: number;
  /** override capability switches (unlisted keys inherit the series values) */
  support: ChipSupport;
}

export interface ChipDb {
  /** false when the SDK component folder is missing (MRS2 without SDK) */
  available: boolean;
  series: ChipSeries[];
}

/** <MRS install resources dir>/components/WCH/SDK/default */
export function chipDbRoot(resourcesDir: string): string {
  return path.join(resourcesDir, 'components', 'WCH', 'SDK', 'default');
}

/**
 * The series a project .template targets: "Series" names the SDK folder
 * directly, "Mcu Type" the flash.json "type" value, "MCU" a specific model —
 * MRS2's own fallback chain, in that order. Shared by the properties page and
 * the download target-chip guard so both resolve a project identically.
 */
export function seriesForTemplate(
  db: ChipDb,
  values: Record<string, string | undefined>
): ChipSeries | undefined {
  const get = (k: string) => (values[k] ?? '').trim();
  const series = get('Series');
  const mcuType = get('Mcu Type');
  const mcu = get('MCU');
  // MRS2 itself also tries `${mcu.slice(0,-1)}.zip` (its getFlashControl):
  // .template MCU values carry the full part number (CH32V203CCT6) while the
  // SDK template zip can drop the last character (CH32V203CCT.zip)
  const mcuShort = mcu.length > 1 ? mcu.slice(0, -1) : mcu;
  return (
    db.series.find((s) => s.name === series) ??
    db.series.find((s) => s.mcuType === mcuType) ??
    db.series.find((s) => s.chips.includes(mcu)) ??
    db.series.find((s) => s.chips.includes(mcuShort))
  );
}

export interface ChipControl {
  /** the resolved series (SDK folder) */
  series: ChipSeries;
  /** the flash-control id MRS2 would use for this project — the series id, or
   *  the "special" override when the .template MCU is that one model */
  id: number;
  /** display type of the effective control (special.type when overridden) */
  mcuType: string;
  /** capability switches of the effective control */
  support: ChipSupport;
}

/**
 * The project's effective flash control — MRS2's getFlashControl() end result.
 * Kept separate from seriesForTemplate because flash.json may override the
 * whole control for ONE model ("special", e.g. CH32V203CCT -> CH32V205 flash
 * control id 206): comparing the series id against the linked chip would
 * raise a false mismatch on exactly those boards.
 */
export function chipForTemplate(
  db: ChipDb,
  values: Record<string, string | undefined>
): ChipControl | undefined {
  const series = seriesForTemplate(db, values);
  if (!series) return undefined;
  const mcu = (values['MCU'] ?? '').trim();
  const sp = series.special;
  // same zip-name tolerance as seriesForTemplate (CH32V203CCT6 -> CCT.zip)
  if (sp && mcu && (sp.mcu === mcu || sp.mcu === mcu.slice(0, -1))) {
    return { series, id: sp.id, mcuType: sp.mcuType, support: sp.support };
  }
  return { series, id: series.id, mcuType: series.mcuType, support: series.support };
}

export interface ChipTargetMismatch {
  /** the chip on the link (all series sharing its family id, deduped) */
  connected: string;
  /** the project's target chip (its .template MCU, else the control type) */
  expected: string;
}

/**
 * The download target-chip decision, pure so it can be tested without a
 * link: MRS2/MRS3 hand the PROJECT's flash-control id to
 * MRSFunc_FlashOperationExB and the DLL answers 10006 "Chip type mismatch."
 * when the connected chip differs. MRVC flashes through OpenOCD, so the same
 * comparison is made before the spawn — but only on a TRUSTED query result:
 * GetLinkedMCUID without a completed init answers the LINK's own id (LinkE
 * 2.23 -> 2/6, and 6 IS CH32V30x's family id), so an untrusted id must be
 * treated as unknown (skip) instead of compared — otherwise the guard would
 * silently pass a real mismatch for V30x projects and warn falsely for every
 * other family.
 */
export function chipTargetMismatch(
  db: ChipDb,
  values: Record<string, string | undefined>,
  linkedId: number | undefined,
  linkedTrusted: boolean
): ChipTargetMismatch | undefined {
  if (!db.available || !linkedTrusted) return undefined;
  const expected = chipForTemplate(db, values);
  if (!expected || expected.id <= 0) return undefined;
  if (linkedId === undefined || linkedId <= 0) return undefined;
  if (expected.id === linkedId) return undefined;
  const matches = db.series.filter((s) => s.id === linkedId);
  if (!matches.length) return undefined; // id outside this SDK — stay silent
  // several series can share a family id (78 = CH32M007 and CH32V002/4/5/6/7);
  // list every candidate so the warning cannot name the wrong one
  const connected = [...new Set(matches.map((s) => s.mcuType || s.name))].join(' / ');
  const expectedLabel = (values['MCU'] ?? '').trim() || expected.mcuType || expected.series.name;
  return { connected, expected: expectedLabel };
}

/** the bits of a queryMcuId result the guard consumes */
export interface LinkedChipQueryResult {
  result?: number;
  initState?: string;
}

/**
 * The guard's orchestration order, transport-free so the "never query the
 * link without a resolvable project target" rule is testable. EVT trees can
 * ship without .template — the download still works (address inferred from
 * sources) but the target chip is then unknown, and querying the link first
 * would add a pointless OpenDevice round trip (1–3 s on the Windows
 * PowerShell bridge) to every such download. Only a known target reaches
 * the query; its result is trusted only when the init sequence completed.
 */
export async function guardLinkedChip(
  db: ChipDb,
  values: Record<string, string | undefined>,
  query: () => Promise<LinkedChipQueryResult>
): Promise<ChipTargetMismatch | undefined> {
  const expected = chipForTemplate(db, values);
  if (!expected || expected.id <= 0) return undefined;
  const r = await query();
  return chipTargetMismatch(db, values, r.result, r.initState === 'ok');
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
      let special: ChipSpecial | undefined;
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
        // MRS2's per-model override: chip.flashControl = special.corresponding
        const sp = flash.special;
        const cor = sp?.corresponding;
        if (sp && typeof sp.mcu === 'string' && sp.mcu && cor && typeof cor.id === 'number') {
          const spSupport: ChipSupport = { ...support };
          for (const key of Object.keys(spSupport) as Array<keyof ChipSupport>) {
            if (typeof cor[`support_${key}`] === 'boolean') spSupport[key] = cor[`support_${key}`];
          }
          special = {
            mcu: sp.mcu,
            mcuType: typeof cor.type === 'string' && cor.type ? cor.type : mcuType,
            id: cor.id,
            support: spSupport,
          };
        }
      } catch {
        // missing/invalid metadata: keep the folder-name default
      }
      db.series.push({ name, arch: archDir.name, mcuType, flashAddress, chips, id, support, special });
    }
  }
  db.available = db.series.length > 0;
  return db;
}
