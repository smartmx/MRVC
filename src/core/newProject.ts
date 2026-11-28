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

/** the SDK component dir inside an MRS install (MRS2 findAllSDKOrigin) */
export function sdkRoot(resourcesDir: string): string {
  return path.join(resourcesDir, 'components', 'WCH', 'SDK', 'default');
}

/** enumerate every template zip MRS2's wizard would offer */
export function scanTemplates(resourcesDir: string): SdkTemplates {
  const root = sdkRoot(resourcesDir);
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
  /** set when the final rename failed midway (locked files etc.) — the
   *  project is created and usable under `finalName`, and the pre-rename
   *  state (launches, .project, markers, .template) has been restored */
  warning?: string;
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
  // "/" (POSIX root) or a UNC share root would otherwise lose its trailing
  // separator and be mistaken for a cancelled pick — keep the root itself
  if (v && /^[\\/]+$/.test(v)) return path.parse(v).root;
  if (v && path.parse(v).root === v) return v;
  return v.replace(/[\\/]+$/, '');
}

/**
 * POSIX template extraction: system `unzip` first (macOS ships it; most
 * distros have it), falling back to `bsdtar` (macOS's native tar reads zip;
 * libarchive-based Linux builds too — GNU tar does NOT). Windows keeps its
 * inline Expand-Archive path in createProjectFromTemplate, byte-identical
 * to 0.2.x. Pure argv arrays — no shell string is ever composed.
 */
export function extractZipArchivePosix(zip: string, dest: string): void {
  try {
    execFileSync('unzip', ['-o', zip, '-d', dest], { stdio: 'pipe', timeout: 120000 });
    return;
  } catch (e) {
    // ENOENT = the tool is not installed — fall through to bsdtar. Any other
    // failure (broken zip etc.) is real and reported immediately.
    if ((e as { code?: string }).code !== 'ENOENT') {
      throw new Error(`unzip failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    execFileSync('bsdtar', ['-xf', zip, '-C', dest], { stdio: 'pipe', timeout: 120000 });
    return;
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') {
      throw new Error(`bsdtar failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error('no unzip tool available (both unzip and bsdtar missing) — install "unzip" and retry');
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
  // the chosen parent folder before touching the disk. path.relative is
  // the strict test: a `parent + sep` prefix check fails on a filesystem
  // ROOT ("D:\", "/") because the root already ends in a separator and the
  // doubled separator matches no normal child path — typing a bare drive
  // root in the wizard location box used to report "Invalid project name"
  // for a perfectly legal child (review P3)
  if (!isInsideParent(parent, projectRoot)) {
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
  if (process.platform !== 'win32') {
    // POSIX: system unzip (macOS ships it; most distros have it), bsdtar as
    // the fallback — see extractZipArchivePosix. The half-extracted folder
    // would block every retry ("already exists") just like on Windows.
    try {
      extractZipArchivePosix(zip, projectRoot);
    } catch (e) {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        // keep the partial dir rather than masking the extraction error
      }
      throw new Error(`Template extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    const psLit = (s: string) => {
      // PowerShell's tokenizer also accepts curly quotes as string
      // delimiters and the '' escape does not cover them — refuse such
      // paths instead of silently quoting a different file (code-review H1)
      if (/[\u2018\u2019\u201A\u201B]/.test(s)) {
        throw new Error('path contains a character PowerShell treats as a string delimiter: ' + s);
      }
      return `'${s.replace(/'/g, "''")}'`;
    };
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

  // (round30 P2) snapshot the extracted template BEFORE any creation step
  // mutates it: the fresh <name>.wvproj marker below and the launch
  // pre-rename are BOTH steps the failure path must undo — a snapshot taken
  // after them would "restore" the mixed state (pre-renamed launch + two
  // .wvproj markers) instead of the template's original file set.
  // (review L1) a corrupt/third-party zip without a .project must not leave
  // the extracted folder behind blocking every retry ("already exists") —
  // clean it up and report clearly, same shape as extraction failure
  let snapshot: {
    launches: Array<{ name: string; data: Buffer }>;
    project: Buffer;
    wvprojs: Array<{ name: string; data: Buffer }>;
    template: Buffer | undefined;
  };
  try {
    snapshot = {
      launches: fs
        .readdirSync(projectRoot)
        .filter((f) => f.toLowerCase().endsWith('.launch'))
        .map((f) => ({ name: f, data: fs.readFileSync(path.join(projectRoot, f)) })),
      project: fs.readFileSync(path.join(projectRoot, '.project')),
      wvprojs: fs
        .readdirSync(projectRoot)
        .filter((f) => f.toLowerCase().endsWith('.wvproj'))
        .map((f) => ({ name: f, data: fs.readFileSync(path.join(projectRoot, f)) })),
      template: fs.existsSync(path.join(projectRoot, '.template')) ? fs.readFileSync(path.join(projectRoot, '.template')) : undefined,
    };
  } catch (e) {
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // keep the partial dir rather than masking the snapshot error
    }
    throw new Error(`Template is not a valid MRS project (${e instanceof Error ? e.message : String(e)})`);
  }

  // MRS2: an empty <name>.wvproj marks the project (content gets rebuilt
  // by the IDE on open)
  fs.writeFileSync(path.join(projectRoot, `${name}.wvproj`), '', 'utf-8');

  // the template display name drives the launch migration: the launch named
  // after the TEMPLATE follows the project rename; user-named launches keep
  // their filenames. NEVER rename an arbitrary first launch when several
  // exist — a multi-launch template would clobber a user launch (round28
  // P2-2). Real MRS zips ship the launch as a bare ".launch" (no basename).
  const oldName = readProjectDisplayName(projectRoot);
  const launches = fs.readdirSync(projectRoot).filter((f) => f.toLowerCase().endsWith('.launch'));
  const namedLaunch = oldName ? launches.find((f) => f.toLowerCase() === `${oldName.toLowerCase()}.launch`) : undefined;
  const bareLaunch = launches.find((f) => f.toLowerCase() === '.launch');
  const singleLaunch = launches.length === 1 ? launches[0] : undefined;
  const preRename = namedLaunch ?? bareLaunch ?? singleLaunch; // template-named, then MRS's bare marker, then unambiguous single
  if (preRename && preRename.toLowerCase() !== `${name.toLowerCase()}.launch`) {
    // (round29 P2) a launch already carrying the requested name must NEVER be
    // overwritten by the template launch — fs.renameSync replaces the target
    // on Windows. Pick a unique fallback name ("Name-template",
    // "Name-template-2", …) instead: both launches survive and renameProject
    // migrates every launch's attrs anyway, so nothing is lost.
    let preTarget = `${name}.launch`;
    if (launches.some((f) => f.toLowerCase() === preTarget.toLowerCase())) {
      let k = 1;
      do {
        preTarget = `${name}-template${k > 1 ? '-' + k : ''}.launch`;
        k++;
      } while (launches.some((f) => f.toLowerCase() === preTarget.toLowerCase()));
    }
    fs.renameSync(path.join(projectRoot, preRename), path.join(projectRoot, preTarget));
  }

  // rename from the template display name to the requested one
  if (oldName && oldName !== name) {
    // (round29 P3-1 / round30 P2) the snapshot above was taken BEFORE the
    // fresh marker write and the launch pre-rename — the catch below can
    // therefore undo BOTH creation steps as well as the rename itself, and
    // the created project stays fully consistent under the template display
    // name; nothing needs manual repair.
    try {
      renameProject(projectRoot, name);
    } catch (e) {
      // restore the extracted template state exactly: drop launch/marker
      // files creation or the failed rename ADDED (the pre-renamed launch,
      // the fresh marker), rewrite every snapshotted file
      try {
        const keepL = new Set(snapshot.launches.map((l) => l.name.toLowerCase()));
        const keepW = new Set(snapshot.wvprojs.map((w) => w.name.toLowerCase()));
        for (const f of fs.readdirSync(projectRoot)) {
          const low = f.toLowerCase();
          const added = (low.endsWith('.launch') && !keepL.has(low)) || (low.endsWith('.wvproj') && !keepW.has(low));
          if (added) fs.rmSync(path.join(projectRoot, f), { force: true });
        }
        for (const l of snapshot.launches) fs.writeFileSync(path.join(projectRoot, l.name), l.data);
        fs.writeFileSync(path.join(projectRoot, '.project'), snapshot.project);
        for (const w of snapshot.wvprojs) fs.writeFileSync(path.join(projectRoot, w.name), w.data);
        if (snapshot.template !== undefined) fs.writeFileSync(path.join(projectRoot, '.template'), snapshot.template);
      } catch {
        // best effort — the warning below still reports the failure
      }
      const actual = readProjectDisplayName(projectRoot) ?? oldName ?? name;
      // real MRS template zips carry NO .wvproj — the fresh marker was ours,
      // and the restore correctly removed it. But a project without ANY
      // marker fails the three-file contract (the project store skips the
      // folder, MRS2 refuses to open it) — write one back under the
      // RESTORED display name so the rolled-back project stays legal and
      // openable (review M1)
      if (snapshot.wvprojs.length === 0) {
        try {
          fs.writeFileSync(path.join(projectRoot, `${actual}.wvproj`), '', 'utf-8');
        } catch {
          // best effort — the warning below still reports the failure
        }
      }
      return {
        projectRoot,
        finalName: actual,
        warning: `project rename failed (${e instanceof Error ? e.message : String(e)}) — files were restored to the pre-rename state; the project is created as "${actual}" instead of "${name}"`,
      };
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

/**
 * Strict child-of test via path.relative: `child === parent` and anything
 * outside (escape or a different root) refuse. Works for a filesystem ROOT
 * parent ("D:\", "/") where a `parent + sep` prefix test cannot. ONLY a
 * genuine parent segment escapes: `rel === ".."` or a `..` FOLLOWED BY a
 * separator — a child merely NAMED "..Blink" is a legal directory name and
 * must pass (review round2 P3: startsWith('..') also swallowed it).
 */
export function isInsideParent(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return false;
  if (path.isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith(`../`)) return false;
  return true;
}
