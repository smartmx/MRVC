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
    for (const series of fs.readdirSync(archDir, { withFileTypes: true })) {
      if (!series.isDirectory()) continue;
      const seriesDir = path.join(archDir, series.name);
      const osMap = out.series.get(series.name) ?? new Map<string, TemplateChip[]>();
      for (const os of fs.readdirSync(seriesDir, { withFileTypes: true })) {
        if (!os.isDirectory()) continue;
        const chips: TemplateChip[] = [];
        for (const f of fs.readdirSync(path.join(seriesDir, os.name), { withFileTypes: true })) {
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
export function createProjectFromTemplate(template: TemplateChip, opts: CreateProjectOptions): CreateProjectResult {
  const name = opts.projectName.trim();
  // PowerShell metacharacters are rejected in addition to filesystem-illegal
  // ones: the name is interpolated into the Expand-Archive -Command string,
  // where `$`, backtick and quotes would be evaluated or break quoting
  if (!name || /[\\/:*?"<>|]/.test(name) || /[$`'"]/.test(name)) {
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
  fs.mkdirSync(projectRoot, { recursive: true });

  // extract (PowerShell Expand-Archive ships with Windows; the template
  // zip layout is a plain project folder)
  const zip = path.resolve(template.zipPath);
  if (!fs.existsSync(zip)) throw new Error(`Template zip not found: ${zip}`);
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${projectRoot}" -Force`],
      { stdio: 'pipe', timeout: 120000 }
    );
  } catch (e) {
    throw new Error(`Template extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // static-library projects keep the template's build setup; the wizard
  // difference vs createProject is only the template family naming
  void opts.artifactType;

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
