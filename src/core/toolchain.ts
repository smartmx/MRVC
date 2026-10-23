/**
 * Locate build tools inside a MounRiver Studio installation (MRS2 or MRS3 —
 * both use the resources/app/resources/win32 layout) and resolve the RISC-V
 * toolchain component from components/WCH/Toolchain/sub_manifest.json.
 * Pure Node — no vscode imports.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ToolchainInfo {
  name: string; // GCC8 | GCC12 | GCC15
  dir: string; // absolute component dir
  compilerC: string; // e.g. riscv-wch-elf-gcc
  compilerCpp: string;
  linkerC: string;
  linkerCpp: string;
  debugger: string;
  objcopy: string;
  objdump: string;
  size: string;
  prefix: string;
}

/** which MounRiver generation an install is; "unknown" = the layout checked
 *  out but no branding/version marker could be read (still usable) */
export type MrsFlavor = 'mrs2' | 'mrs3' | 'unknown';

export interface MrsInstall {
  root: string; // install root (.../MounRiver_Studio2, .../MounRiver_Studio3)
  resourcesWin32: string; // <root>/resources/app/resources/win32
  components: string; // .../components
  makeBin: string;
  openocdExe: string;
  openocdCfg: string; // wch-riscv.cfg next to openocd
  linkUtilityExe: string;
  toolchains: ToolchainInfo[];
  flavor: MrsFlavor;
  /** branding for messages/logs, e.g. "MounRiver Studio 3" */
  label: string;
}

/** conventional install locations, per generation (root and the win32 dir) */
export const MRS2_DEFAULT_PATHS = [
  'C:\\MounRiver\\MounRiver_Studio2',
  'C:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32',
];
export const MRS3_DEFAULT_PATHS = [
  'C:\\MounRiver\\MounRiver_Studio3',
  'C:\\MounRiver\\MounRiver_Studio3\\resources\\app\\resources\\win32',
];
/** kept for callers that only know the MRS2 defaults */
export const DEFAULT_INSTALL_PATHS: string[] = MRS2_DEFAULT_PATHS;

/** canonical generation label — used in messages when no install of that
 *  generation exists to carry its own product.json branding (a wrong-field
 *  value must never put the other generation's name into such a message) */
export function flavorLabel(flavor: 'mrs2' | 'mrs3'): string {
  return flavor === 'mrs3' ? 'MounRiver Studio 3' : 'MounRiver Studio 2';
}

/**
 * Probe the generation. Both MRS2 and MRS3 carry a dedicated `mrsVersion`
 * key in <root>/resources/app/product.json ("2.0.0" / "3.0.0") — that is
 * authoritative. The branding string and the install-root launcher name are
 * the fallbacks (a hand-assembled install may lack product.json).
 */
export function detectFlavor(root: string): { flavor: MrsFlavor; label: string } {
  let label = '';
  try {
    const pj = path.join(root, 'resources', 'app', 'product.json');
    if (fs.existsSync(pj)) {
      const j = JSON.parse(fs.readFileSync(pj, 'utf-8')) as {
        mrsVersion?: string;
        nameShort?: string;
        applicationName?: string;
      };
      label = (j.nameShort ?? '').trim();
      // "3.0.0" -> "3" (plain string split keeps the probe readable)
      const verText = (j.mrsVersion ?? '').trim();
      const dot = verText.indexOf('.');
      const major = dot > 0 ? verText.slice(0, dot) : '';
      if (major === '2' || major === '3') {
        const fallback = major === '3' ? 'MounRiver Studio 3' : 'MounRiver Studio 2';
        return { flavor: major === '3' ? 'mrs3' : 'mrs2', label: label || fallback };
      }
      const branding = `${j.nameShort ?? ''} ${j.applicationName ?? ''}`.toLowerCase();
      if (/studio\s*3|studio-3/.test(branding)) return { flavor: 'mrs3', label: label || 'MounRiver Studio 3' };
      if (/studio\s*2|studio-2/.test(branding)) return { flavor: 'mrs2', label: label || 'MounRiver Studio 2' };
    }
  } catch {
    // malformed product.json -> fall through to the launcher-name probe
  }
  const launcher = detectLauncherFlavor(root);
  if (launcher) {
    const fallback = launcher === 'mrs3' ? 'MounRiver Studio 3' : 'MounRiver Studio 2';
    return { flavor: launcher, label: label || fallback };
  }
  return { flavor: 'unknown', label: label || 'MounRiver Studio' };
}

/** the install root ships "MounRiver Studio <N>.exe" — presence-only probe */
function detectLauncherFlavor(root: string): 'mrs2' | 'mrs3' | null {
  const names = readRootNames(root);
  if (!names) return null;
  const hit = (n: string): boolean => names.some((f) => f.toLowerCase() === n.toLowerCase());
  if (hit('MounRiver Studio 3.exe')) return 'mrs3';
  if (hit('MounRiver Studio 2.exe')) return 'mrs2';
  return null;
}

function readRootNames(root: string): string[] | null {
  try {
    return fs.readdirSync(root);
  } catch {
    return null;
  }
}

/** the generation's own launcher program ("MounRiver Studio 2.exe" / "3.exe") */
export function launcherFileName(gen: 'mrs2' | 'mrs3'): string {
  return gen === 'mrs3' ? 'MounRiver Studio 3.exe' : 'MounRiver Studio 2.exe';
}

/** why a configured install path can not be used */
export type InstallPathProblem =
  /** the directory does not exist */
  | 'missing'
  /** exists, but has no components/WCH/manifest.json — not a MounRiver tree */
  | 'not-install'
  /** it IS an installation, but of the OTHER generation */
  | 'wrong-generation'
  /** no "MounRiver Studio <N>.exe" — the program (and the version marker) is absent */
  | 'no-launcher';

export interface InstallPathCheck {
  /** the configured value (trimmed) */
  path: string;
  ok: boolean;
  install?: MrsInstall;
  problem?: InstallPathProblem;
  /** the generation the path itself declares (for the reason message) */
  foundFlavor?: MrsFlavor;
}

/**
 * Validate ONE configured path for ONE generation: the directory must exist, be
 * a MounRiver installation (the WCH manifest marker), declare that generation
 * (product.json / launcher name — an unmarked tree can not be verified and
 * fails here), and ship the launcher program "MounRiver Studio <N>.exe".
 * This is the startup criterion: the extension starts only when at least one
 * of the two fields passes it.
 */
export function checkInstallPath(configured: string, expect: 'mrs2' | 'mrs3'): InstallPathCheck {
  const root = configured.trim();
  if (!fs.existsSync(root)) return { path: root, ok: false, problem: 'missing' };
  const install = locateInstall(root, { defaults: [] });
  if (!install) return { path: root, ok: false, problem: 'not-install' };
  const flavor = install.flavor;
  if (flavor !== 'unknown' && flavor !== expect) {
    return { path: root, ok: false, problem: 'wrong-generation', foundFlavor: flavor };
  }
  const names = readRootNames(install.root);
  const wanted = launcherFileName(expect);
  const hasLauncher = !!names && names.some((f) => f.toLowerCase() === wanted.toLowerCase());
  if (!hasLauncher) return { path: root, ok: false, problem: 'no-launcher', foundFlavor: flavor };
  return { path: root, ok: true, install, foundFlavor: flavor };
}

/**
 * First valid candidate wins. `configured` comes first so an explicit setting
 * beats the conventional locations; `opts.prefer` picks which generation's
 * defaults are appended (no prefer = MRS2 defaults first, then MRS3 — an
 * existing MRS2 user keeps their install unless the MRS3 path is filled in).
 * `opts.defaults` replaces the built-in list (tests inject hermetic paths).
 */
export function locateInstall(
  configured?: string | string[],
  opts: { prefer?: 'mrs2' | 'mrs3'; defaults?: string[] } = {}
): MrsInstall | null {
  const configuredList = (Array.isArray(configured) ? configured : configured ? [configured] : [])
    .map((p) => p.trim())
    .filter(Boolean);
  const defaults =
    opts.defaults ??
    (opts.prefer === 'mrs2'
      ? MRS2_DEFAULT_PATHS
      : opts.prefer === 'mrs3'
        ? MRS3_DEFAULT_PATHS
        : [...MRS2_DEFAULT_PATHS, ...MRS3_DEFAULT_PATHS]);
  const seen = new Set<string>();
  for (const root of [...configuredList, ...defaults]) {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // regular layout: <install>/resources/app/resources/win32
    const res = path.join(root, 'resources', 'app', 'resources', 'win32');
    let candidate: MrsInstall | null = null;
    if (fs.existsSync(path.join(res, 'components', 'WCH', 'manifest.json'))) {
      candidate = buildInstall(root, res);
    } else if (fs.existsSync(path.join(root, 'components', 'WCH', 'manifest.json'))) {
      // the configured path may already BE the win32 resources dir
      // win32 -> resources -> app -> <install>: four dirname hops
      candidate = buildInstall(path.dirname(path.dirname(path.dirname(path.dirname(root)))), root);
    }
    if (!candidate) continue;
    return candidate;
  }
  return null;
}

function buildInstall(root: string, res: string): MrsInstall {
  const components = path.join(res, 'components', 'WCH');
  const makeBin = path.join(res, 'others', 'Build_Tools', 'Make', 'bin');
  const openocdBin = path.join(components, 'OpenOCD', 'OpenOCD', 'bin');
  const { flavor, label } = detectFlavor(root);
  return {
    root,
    resourcesWin32: res,
    components,
    makeBin,
    openocdExe: path.join(openocdBin, 'openocd.exe'),
    openocdCfg: path.join(openocdBin, 'wch-riscv.cfg'),
    linkUtilityExe: path.join(components, 'Others', 'SWDTool', 'default', 'WCH-LinkUtility.exe'),
    toolchains: loadToolchains(components),
    flavor,
    label,
  };
}

interface ManifestDetail {
  name: string;
  path: string;
  status?: number;
  type?: string;
  compiler_c_executable?: { folder: string; name: string };
  compiler_cpp_executable?: { folder: string; name: string };
  linker_c_executable?: { folder: string; name: string };
  linker_cpp_executable?: { folder: string; name: string };
  debugger_executable?: { folder: string; name: string };
  objdump_executable?: { folder: string; name: string };
  other_tool_dir?: string;
  other_tool_prefix?: string;
}

function loadToolchains(componentsDir: string): ToolchainInfo[] {
  const manifest = path.join(componentsDir, 'Toolchain', 'sub_manifest.json');
  const out: ToolchainInfo[] = [];
  if (!fs.existsSync(manifest)) return out;
  try {
    const data = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { details?: ManifestDetail[] };
    for (const d of data.details ?? []) {
      if (d.type !== 'RISC-V') continue;
      const dir = path.resolve(componentsDir, 'Toolchain', d.path.replace(/^\.\//, ''));
      const prefix = d.other_tool_prefix ?? '';
      const toolDir = path.join(dir, d.other_tool_dir ?? 'bin');
      const bin = (sub?: { folder: string; name: string }, fallback = '') =>
        sub ? path.join(dir, sub.folder.replace(/^\.\//, ''), sub.name) : path.join(toolDir, fallback);
      out.push({
        name: d.name,
        dir,
        compilerC: bin(d.compiler_c_executable, prefix + 'gcc'),
        compilerCpp: bin(d.compiler_cpp_executable, prefix + 'g++'),
        linkerC: bin(d.linker_c_executable, prefix + 'gcc'),
        linkerCpp: bin(d.linker_cpp_executable, prefix + 'g++'),
        debugger: bin(d.debugger_executable, prefix + 'gdb'),
        objcopy: path.join(toolDir, prefix + 'objcopy'),
        objdump: bin(d.objdump_executable, prefix + 'objdump'),
        size: path.join(toolDir, prefix + 'size'),
        prefix,
      });
    }
  } catch {
    // malformed manifest -> empty toolchain list
  }
  return out;
}

/**
 * How the two install settings (mrvc.mrs2InstallPath / mrvc.mrs3InstallPath,
 * both carrying a C:\MounRiver\... default) combine into ONE active
 * installation.
 *
 * Startup criterion: each field is VALIDATED for its own generation — the
 * directory must exist, be a MounRiver installation, declare that generation
 * and ship its launcher program ("MounRiver Studio <N>.exe"). At least one
 * field must pass, otherwise `install` is null and the caller must not start
 * (the gate asks the user for a correct path); an installation found at a
 * conventional location is only OFFERED for one-click adoption (`detected`),
 * never used silently.
 *
 * Among the valid fields `mrvc.mrsVersion` picks: mrs2 / mrs3 pin the
 * generation, auto prefers MRS3 (the newer one). A pin whose generation is not
 * valid falls back to the other VALID field and is reported (pinnedFellBack),
 * so the user always knows which installation is active.
 */
export interface InstallSelection {
  install: MrsInstall | null;
  requested: 'auto' | 'mrs2' | 'mrs3';
  /** every non-empty field, validated for its own generation */
  checks: InstallFieldCheck[];
  /** the fields that FAILED validation (reported, never substituted) */
  failedFields: InstallFieldCheck[];
  /** both values are empty — nothing to check at all */
  notConfigured: boolean;
  /** both fields hold each other's generation (a plausible mis-edit): the gate
   *  can offer to swap the two values */
  swappedFields: boolean;
  /** an installation found at a conventional location — offered for one-click
   *  adoption when no field is valid, never used by itself (null as soon as a
   *  field passes validation) */
  detected: MrsInstall | null;
  /** the preferred generation is not valid and `install` is the other one */
  pinnedFellBack?: 'mrs2' | 'mrs3';
  /** auto only: both fields valid */
  bothValid: boolean;
  mrs2Label: string;
  mrs3Label: string;
  /** what each non-empty field resolves to (undefined = empty or unusable) */
  mrs2FieldFlavor?: MrsFlavor;
  mrs3FieldFlavor?: MrsFlavor;
  /** the configured values (trimmed) — lets a "swap them" action write them
   *  back without re-reading the settings */
  mrs2PathValue: string;
  mrs3PathValue: string;
}

/** one of the two settings, validated for its own generation */
export interface InstallFieldCheck extends InstallPathCheck {
  field: 'mrs2InstallPath' | 'mrs3InstallPath';
  /** the value is the setting's schema default (nothing the user chose): its
   *  failure is listed in the gate's diagnostics but not warned about at every
   *  start — a user who only has MRS2 must not be nagged about the MRS3 default */
  fromDefault?: boolean;
}

/** the policy that turns the settings into one active install */
export function selectInstall(
  opts: {
    mrs2Path?: string;
    mrs3Path?: string;
    version?: string;
    /** the settings' schema defaults: a value equal to its default is a
     *  suggestion, not a user choice (its failure is not warned about) */
    mrs2Default?: string;
    mrs3Default?: string;
  },
  defaults: { mrs2?: string[]; mrs3?: string[] } = {}
): InstallSelection {
  const raw2 = (opts.mrs2Path ?? '').trim();
  const raw3 = (opts.mrs3Path ?? '').trim();
  const requested: InstallSelection['requested'] =
    opts.version === 'mrs2' || opts.version === 'mrs3' ? opts.version : 'auto';
  const fromDefault = (value: string, dflt?: string): boolean => !!dflt && value === dflt.trim();
  // each field is validated against its OWN generation, independently
  const c2: InstallFieldCheck | null = raw2
    ? { field: 'mrs2InstallPath', fromDefault: fromDefault(raw2, opts.mrs2Default), ...checkInstallPath(raw2, 'mrs2') }
    : null;
  const c3: InstallFieldCheck | null = raw3
    ? { field: 'mrs3InstallPath', fromDefault: fromDefault(raw3, opts.mrs3Default), ...checkInstallPath(raw3, 'mrs3') }
    : null;
  const checks = [c2, c3].filter((c): c is InstallFieldCheck => !!c);
  const failedFields = checks.filter((c) => !c.ok);
  const notConfigured = checks.length === 0;
  const v2 = c2?.ok ? c2.install! : null;
  const v3 = c3?.ok ? c3.install! : null;
  const swappedFields =
    !!c2 && !!c3 && c2.problem === 'wrong-generation' && c3.problem === 'wrong-generation' &&
    c2.foundFlavor === 'mrs3' && c3.foundFlavor === 'mrs2';

  let install: MrsInstall | null = null;
  let pinnedFellBack: 'mrs2' | 'mrs3' | undefined;
  if (requested === 'mrs2') {
    // the pin is a preference: when its generation is not valid the other
    // VALID field is used and reported
    install = v2 ?? v3;
    if (!v2 && v3) pinnedFellBack = 'mrs2';
  } else if (requested === 'mrs3') {
    install = v3 ?? v2;
    if (!v3 && v2) pinnedFellBack = 'mrs3';
  } else {
    install = v3 ?? v2; // auto prefers MRS3
  }
  // only when no field is valid: look at the conventional locations, merely to
  // OFFER them (the caller asks the user before adopting)
  const detected = install
    ? null
    : locateInstall(undefined, {
        defaults: [...(defaults.mrs2 ?? MRS2_DEFAULT_PATHS), ...(defaults.mrs3 ?? MRS3_DEFAULT_PATHS)],
      });
  return {
    install,
    requested,
    checks,
    failedFields,
    notConfigured,
    swappedFields,
    detected,
    pinnedFellBack,
    bothValid: requested === 'auto' && !!v2 && !!v3,
    mrs2Label: v2?.label ?? flavorLabel('mrs2'),
    mrs3Label: v3?.label ?? flavorLabel('mrs3'),
    mrs2FieldFlavor: v2?.flavor ?? c2?.foundFlavor,
    mrs3FieldFlavor: v3?.flavor ?? c3?.foundFlavor,
    mrs2PathValue: raw2,
    mrs3PathValue: raw3,
  };
}

/**
 * A user-provided toolchain (mrvc.customToolchains setting). MRS2's
 * equivalent stores the same shape in toolchain_local.json and references
 * entries from .cproject as ${Local:Toolchain:<name>}; MRVC keeps the list
 * in settings and matches by name (case-insensitive) in selectToolchain.
 */
export interface CustomToolchain {
  name: string;
  /** toolchain root folder containing bin/ */
  path: string;
  /** executable prefix; auto-detected from bin/ when omitted */
  prefix?: string;
}

/** build a ToolchainInfo from a custom entry: prefix auto-detected from
 * the first *gcc* executable in bin/ when not given explicitly */
export function resolveCustomToolchain(entry: CustomToolchain): ToolchainInfo | null {
  const binDir = path.join(entry.path, 'bin');
  if (!fs.existsSync(binDir)) return null;
  let prefix = entry.prefix;
  if (!prefix) {
    const gcc = fs.readdirSync(binDir).find((f) => /^.*gcc\.exe$/i.test(f) || /^.*gcc$/i.test(f));
    if (!gcc) return null;
    prefix = gcc.slice(0, gcc.toLowerCase().lastIndexOf('gcc'));
  }
  // Windows executables carry .exe in the directory listing even though
  // makefiles reference the bare prefix+name — check both forms
  const has = (f: string): boolean =>
    fs.existsSync(path.join(binDir, prefix + f)) || fs.existsSync(path.join(binDir, prefix + f + '.exe'));
  if (!has('gcc')) return null;
  return {
    name: entry.name,
    dir: entry.path,
    compilerC: path.join(binDir, prefix + 'gcc'),
    compilerCpp: path.join(binDir, prefix + 'g++'),
    linkerC: path.join(binDir, prefix + 'gcc'),
    linkerCpp: path.join(binDir, prefix + 'g++'),
    debugger: path.join(binDir, prefix + 'gdb'),
    objcopy: path.join(binDir, prefix + 'objcopy'),
    objdump: path.join(binDir, prefix + 'objdump'),
    size: path.join(binDir, prefix + 'size'),
    prefix,
  };
}

/**
 * Merge custom toolchains over the MRS2-installed ones (same name —
 * case-insensitive — custom wins). Unresolvable entries (missing bin/,
 * no gcc) are skipped.
 */
export function mergeCustomToolchains(install: MrsInstall, custom: CustomToolchain[]): MrsInstall {
  if (!custom.length) return install;
  const resolved: ToolchainInfo[] = [];
  const customNames = new Set<string>();
  for (const entry of custom) {
    const tc = resolveCustomToolchain(entry);
    if (tc) {
      resolved.push(tc);
      customNames.add(tc.name.toLowerCase());
    }
  }
  const installed = install.toolchains.filter((t) => !customNames.has(t.name.toLowerCase()));
  return { ...install, toolchains: [...resolved, ...installed] };
}

/**
 * Pick the toolchain for a project. Preference order:
 *   1. explicit request (GCC8/GCC12/GCC15, custom names, from settings)
 *   2. rvGcc option recorded in .cproject
 *   3. legacy command.prefix mapping
 *   4. first installed
 */
export function selectToolchain(
  install: MrsInstall | null,
  request: string,
  rvGccVersion?: string,
  storedPrefix?: string
): ToolchainInfo | null {
  if (!install || !install.toolchains.length) return null;
  // names fold: the settings value may spell 'gcc12' for an installed
  // 'GCC12', and the custom/installed merge dedup is already
  // case-insensitive — matching must agree (the doc comment says so too)
  const byName = new Map(install.toolchains.map((t) => [t.name.toLowerCase(), t]));
  const firstInstalled = () => install.toolchains.find((t) => fs.existsSync(path.join(t.dir, 'bin'))) ?? install.toolchains[0];

  if (request && request !== 'auto' && byName.has(request.toLowerCase())) {
    return byName.get(request.toLowerCase())!;
  }
  if (rvGccVersion === '12') return byName.get('gcc12') ?? firstInstalled();
  if (rvGccVersion === '15') return byName.get('gcc15') ?? firstInstalled();
  if (rvGccVersion === '8') return byName.get('gcc8') ?? firstInstalled();
  if (storedPrefix === 'riscv-none-embed-') return byName.get('gcc8') ?? firstInstalled();
  if (storedPrefix === 'riscv-wch-elf-') return byName.get('gcc12') ?? firstInstalled();
  if (storedPrefix === 'riscv32-wch-elf-') return byName.get('gcc15') ?? firstInstalled();
  return firstInstalled();
}
