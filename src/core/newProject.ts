/**
 * New-project wizard (pure Node) — MRS2 createProject / createStaticLib
 * minimum equivalent. MRS2's wizard extracts an SDK template zip (a full
 * ready-to-build project: .project/.cproject/.launch/.template + sources)
 * into the target folder, writes an empty <name>.wvproj and renames the
 * project (renameProject semantics). This module reproduces that sequence
 * using MRVC's own renameProject, plus the template discovery the MRS2
 * wizard offers: <SDK>/<ARCH>/<series>/<os>/<chip>.zip.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { renameProject } from './projectFile';
import { Cproject } from './cproject';

export interface TemplateChip {
  /** series folder, e.g. CH32V307 */
  series: string;
  /** RTOS folder, e.g. NoneOS / FreeRTOS / "Harmony LiteOS-M" */
  os: string;
  /** template zip basename without extension, e.g. CH32V307RCT */
  chip: string;
  /** absolute zip path */
  zipPath: string;
}

export interface SdkTemplates {
  arch: 'RISC-V' | 'ARM';
  /** series -> os -> chips */
  series: Map<string, Map<string, TemplateChip[]>>;
}

/** the SDK component dir inside an MRS2 install (MRS2 findAllSDKOrigin) */
export function sdkRoot(resourcesWin32: string): string {
  return path.join(resourcesWin32, 'components', 'WCH', 'SDK', 'default');
}

/** enumerate every template zip MRS2's wizard would offer */
export function scanTemplates(resourcesWin32: string): SdkTemplates {
  const root = sdkRoot(resourcesWin32);
  const out: SdkTemplates = { arch: 'RISC-V', series: new Map() };
  for (const arch of ['RISC-V', 'ARM']) {
    const archDir = path.join(root, arch);
    if (!fs.existsSync(archDir)) continue;
    if (arch === 'ARM') out.arch = 'ARM';
    // each level tolerates an unreadable directory (corporate ACLs on the
    // SDK tree are common) — the wizard skips it instead of crashing the
    // whole scan with an unhandled rejection (same shape as chipdb.ts)
    let seriesDirs: fs.Dirent[];
    try {
      seriesDirs = fs.readdirSync(archDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const series of seriesDirs) {
      if (!series.isDirectory()) continue;
      const seriesDir = path.join(archDir, series.name);
      const osMap = out.series.get(series.name) ?? new Map<string, TemplateChip[]>();
      let osDirs: fs.Dirent[];
      try {
        osDirs = fs.readdirSync(seriesDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const os of osDirs) {
        if (!os.isDirectory()) continue;
        const chips: TemplateChip[] = [];
        let files: fs.Dirent[];
        try {
          files = fs.readdirSync(path.join(seriesDir, os.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.isFile() || !f.name.toLowerCase().endsWith('.zip')) continue;
          // -flash.json / -targetProcessor.json are metadata, not templates
          if (/-flash\.json$|-targetProcessor\.json$/i.test(f.name)) continue;
          chips.push({
            series: series.name,
            os: os.name,
            chip: f.name.replace(/\.zip$/i, ''),
            zipPath: path.join(seriesDir, os.name, f.name),
          });
        }
        if (chips.length) {
          const list = osMap.get(os.name) ?? [];
          osMap.set(os.name, list.concat(chips));
        }
      }
      if (osMap.size) out.series.set(series.name, osMap);
    }
  }
  return out;
}

export interface CreateProjectOptions {
  /** new project display name (and folder name) */
  projectName: string;
  /** parent folder — the project folder is created inside it */
  parentDir: string;
  /** artifact type: exe = application project, lib = static library */
  artifactType: 'exe' | 'lib';
}

export interface CreateProjectResult {
  projectRoot: string;
  /** display name renameProject actually applied */
  finalName: string;
}

/**
 * Create a project from an SDK template zip — MRS2 confirmCreateProject
 * sequence: extract zip into <parentDir>/<projectName>, write an empty
 * <projectName>.wvproj, then renameProject from the template's display
 * name to the requested one (renames .launch/.wvproj and rewrites
 * .template Target Path, never moves the folder).
 */
/**
 * Normalize the typed parent-folder input: trim trailing separators EXCEPT
 * on a drive root — "C:" alone must become "C:\", because path.resolve("C:")
 * resolves to THAT DRIVE'S CURRENT DIRECTORY and the project would land
 * somewhere else entirely.
 */
export function normalizeParentDirInput(raw: string): string {
  const v = raw.trim();
  // one branch covers every drive-root shape: "C:", "C:\", "C:/", "C:\\", "C://"
  if (/^[A-Za-z]:[\\/]*$/.test(v)) return v.slice(0, 2) + '\\';
  return v.replace(/[\\/]+$/, '');
}

export function createProjectFromTemplate(template: TemplateChip, opts: CreateProjectOptions): CreateProjectResult {
  const name = opts.projectName.trim();
  // PowerShell metacharacters are rejected in addition to filesystem-illegal
  // ones: the name is interpolated into the Expand-Archive -Command string,
  // where `$`, backtick and quotes would be evaluated or break quoting.
  // Whitespace too — renameProject rejects it, and letting a spaced name
  // through would fail creation halfway (half-renamed template state)
  if (!name || /[\\/:*?"<>|\s]/.test(name) || /[$`'"]/.test(name)) {
    throw new Error(`Invalid project name "${opts.projectName}"`);
  }
  const parent = path.resolve(opts.parentDir);
  const projectRoot = path.resolve(parent, name);
  // containment: the name is user input — prove the target stays inside
  // the chosen parent folder before touching the disk
  if (projectRoot !== parent && !projectRoot.startsWith(parent + path.sep)) {
    throw new Error(`Invalid project name "${opts.projectName}"`);
  }
  if (fs.existsSync(projectRoot)) {
    throw new Error(`"${projectRoot}" already exists`);
  }
  // extract (PowerShell Expand-Archive ships with Windows; the template
  // zip layout is a plain project folder). Both paths go in as PowerShell
  // SINGLE-quoted literals ('' escapes an inner quote): inside double quotes
  // PowerShell would expand `$vars` and eat backticks in user-typed folder
  // names, silently extracting to a different location
  const zip = path.resolve(template.zipPath);
  // validate the template BEFORE creating anything: a missing zip used to
  // leave an empty project folder behind and every retry then hit
  // "already exists"
  if (!fs.existsSync(zip)) throw new Error(`Template zip not found: ${zip}`);
  fs.mkdirSync(projectRoot, { recursive: true });
  const psLit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  try {
    // -ErrorAction Stop + exit 1: Windows PowerShell 5.1 reports archive
    // errors (broken zip, locked file) as NON-terminating and still exits 0
    // — without this the extraction failure would be silently swallowed
    // and creation would "succeed" with an empty project folder
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `try { Expand-Archive -LiteralPath ${psLit(zip)} -DestinationPath ${psLit(projectRoot)} -Force -ErrorAction Stop } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
      ],
      { stdio: 'pipe', timeout: 120000 }
    );
  } catch (e) {
    // the half-extracted folder would block every retry ("already exists")
    // and never shows up in the project tree — best-effort remove it
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // keep the partial dir rather than masking the extraction error
    }
    throw new Error(`Template extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // static-library creation (MRS2 createStaticLib semantics): flip the
  // template's exe build identity to a static library — makefile.ts then
  // emits the archive (ar) recipe and skips the hex/bin/lst/size post
  // steps. Artifact extension flips to CDT's static-lib default "a".
  // Non-fatal: the project is created and usable either way, and the
  // properties page (Build Artifact) can switch the type later.
  if (opts.artifactType === 'lib') {
    try {
      const cp = Cproject.load(projectRoot);
      cp.setBuildIdentity({ artifactType: 'staticLib', artifactExtension: 'a' });
      cp.save();
    } catch {
      // keep the template's exe build setup rather than failing creation
    }
  }

  // MRS2: an empty <name>.wvproj marks the project (content gets rebuilt
  // by the IDE on open)
  fs.writeFileSync(path.join(projectRoot, `${name}.wvproj`), '', 'utf-8');

  // rename from the template display name to the requested one
  const oldName = readProjectDisplayName(projectRoot);
  if (oldName && oldName !== name) {
    try {
      renameProject(projectRoot, name);
    } catch {
      // name change is cosmetic — the project still opens under the
      // template name rather than failing the whole creation
      return { projectRoot, finalName: oldName ?? name };
    }
  }
  return { projectRoot, finalName: name };
}

/** the template's .project display name (undefined when unparsable) */
function readProjectDisplayName(projectRoot: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.project'), 'utf-8');
    return (raw.match(/<name>([^<]*)<\/name>/) || [])[1];
  } catch {
    return undefined;
  }
}
