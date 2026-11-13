/**
 * Locate build tools inside a MounRiver installation and resolve the RISC-V
 * toolchain component from the WCH sub_manifest.json.
 *
 * Two shapes are supported:
 *   IDE install (kind 'ide')       — MRS2/MRS3, same layout on every OS:
 *     Windows  <root>/resources/app/resources/win32   launcher "MounRiver Studio <N>.exe"
 *     Linux    <root>/resources/app/resources/linux   launcher "mounriver-studio <n>" (root or bin/)
 *     macOS    <root(.app)>/Contents/Resources/app/resources/darwin
 *              launcher <root>/Contents/MacOS/Electron (generation comes from product.json)
 *   standalone toolchain (kind 'toolchain') — an unpacked MRS_Toolchain_* package:
 *     <root>/Toolchain/sub_manifest.json + <root>/OpenOCD/…, no IDE, no bundled
 *     make (the system make from PATH is used). These packages are the
 *     MRS2-generation toolchains (GCC8 riscv-none-embed / GCC12+ riscv-wch-elf).
 *
 * The sub_manifest.json schema and the relative component layout are identical
 * across OSes and shapes; executable names lose their .exe suffix outside
 * Windows. Pure Node — no vscode imports.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Test seam: the host platform this module's DETECTION logic reasons about
 * (launcher names, resources layer, conventional locations, arch gate). It is
 * process.platform everywhere in production; the tests point it at linux /
 * darwin to exercise those layouts from any host. Real EXECUTION gates
 * (tasks.ts's bash launch, the wlink bridge) keep reading process.platform —
 * they must follow the machine that actually runs the code.
 */
let hostPlatform: NodeJS.Platform = process.platform;
export function setHostPlatformForTests(p: NodeJS.Platform): void {
  hostPlatform = p;
}
export function host(): NodeJS.Platform {
  return hostPlatform;
}

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
  root: string; // install root (.../MounRiver_Studio2, an .app bundle, a toolchain dir)
  /** the OS resources layer: <root>/resources/app/resources/<win32|linux|darwin>
   *  (macOS: <root>.app/Contents/Resources/app/resources/darwin); for a
   *  standalone toolchain root this is the root itself — consumers derive
   *  Windows-only GUI tools from it and degrade on the missing subtrees */
  resourcesDir: string;
  /** 'ide' = a MounRiver Studio installation; 'toolchain' = standalone */
  kind: 'ide' | 'toolchain';
  components: string; // .../components (ide) or <root> (toolchain)
  makeBin: string; // bundled make's dir ('' for a standalone root — system make)
  openocdExe: string;
  openocdCfg: string; // wch-riscv.cfg next to openocd
  linkUtilityExe: string; // '' outside Windows (the GUI tool is Windows-only)
  toolchains: ToolchainInfo[];
  flavor: MrsFlavor;
  /** branding for messages/logs, e.g. "MounRiver Studio 3" */
  label: string;
}

/** label for a standalone toolchain root (no product.json to brand it) */
export const STANDALONE_LABEL = 'MRS Toolchain (standalone)';

/** conventional Windows install locations, per generation (root and the win32
 *  dir). The schema defaults are EMPTY — a package.json default cannot vary by
 *  platform, so the per-OS lists come from conventionalInstalls() at runtime;
 *  these constants stay the Windows lists (the platform every 0.2.x user has). */
export const MRS2_DEFAULT_PATHS = [
  'C:\\MounRiver\\MounRiver_Studio2',
  'C:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32',
];
export const MRS3_DEFAULT_PATHS = [
  'C:\\MounRiver\\MounRiver_Studio3',
  'C:\\MounRiver\\MounRiver_Studio3\\resources\\app\\resources\\win32',
];

/**
 * Per-platform conventional IDE locations, probed when the settings are empty:
 *   Windows — the C:\MounRiver\... roots (unchanged since 0.2.4)
 *   Linux   — the .deb's real prefix (/usr/share/MRS3/MRS-linux-x64); the
 *             tar.xz has no fixed location and the V2.x line ships no Linux IDE
 *   macOS   — /Applications (the arm64 .app)
 * A standalone toolchain root has no conventional location (users unpack it
 * wherever they like), so it is never probed implicitly.
 */
export function conventionalInstalls(): { mrs2: string[]; mrs3: string[] } {
  if (host() === 'win32') return { mrs2: MRS2_DEFAULT_PATHS, mrs3: MRS3_DEFAULT_PATHS };
  if (host() === 'darwin') return { mrs2: [], mrs3: ['/Applications/MounRiver Studio 3.app'] };
  return { mrs2: [], mrs3: ['/usr/share/MRS3/MRS-linux-x64'] };
}

/** '.exe' on Windows, '' elsewhere (POSIX binaries carry no suffix) */
export function platformSuffix(): string {
  return host() === 'win32' ? '.exe' : '';
}

/** the OS resources layer directory name under .../resources/app/resources/ */
export function platformLayerName(): 'win32' | 'linux' | 'darwin' {
  return host() === 'win32' ? 'win32' : host() === 'darwin' ? 'darwin' : 'linux';
}

/** canonical generation label — used in messages when no install of that
 *  generation exists to carry its own product.json branding (a wrong-field
 *  value must never put the other generation's name into such a message) */
export function flavorLabel(flavor: 'mrs2' | 'mrs3'): string {
  return flavor === 'mrs3' ? 'MounRiver Studio 3' : 'MounRiver Studio 2';
}

/** a macOS root is accepted as the .app folder itself or its Contents dir */
function normalizeMacAppRoot(root: string): string | null {
  if (root.toLowerCase().endsWith('.app')) return root;
  const parent = path.dirname(root);
  if (path.basename(root).toLowerCase() === 'contents' && parent.toLowerCase().endsWith('.app')) return parent;
  return null;
}

/** where the OS resources layer lives for a root (or null when the root is
 *  neither an IDE tree nor — on macOS — an .app bundle) */
interface PlatformLayout {
  root: string; // normalized (macOS: the .app path)
  res: string; // .../resources/app/resources/<layer>
  appDir: string; // .../resources/app (product.json lives here)
}

function locateLayout(inputRoot: string): PlatformLayout | null {
  let root = inputRoot;
  if (host() === 'darwin') {
    const normalized = normalizeMacAppRoot(root);
    if (!normalized) return null;
    root = normalized;
  }
  const appDir =
    host() === 'darwin'
      ? path.join(root, 'Contents', 'Resources', 'app')
      : path.join(root, 'resources', 'app');
  const res = path.join(appDir, 'resources', platformLayerName());
  if (fs.existsSync(path.join(res, 'components', 'WCH', 'manifest.json'))) {
    return { root, res, appDir };
  }
  // the configured path may already BE the resources layer dir; the shape
  // <install>/resources/app/resources/<layer> is identical on every OS, so
  // climbing four dirname hops lands on the install root (macOS: on Contents,
  // which normalizeMacAppRoot folds back to the .app)
  if (fs.existsSync(path.join(root, 'components', 'WCH', 'manifest.json'))) {
    const up = path.dirname(path.dirname(path.dirname(path.dirname(root))));
    const upAppDir =
      host() === 'darwin'
        ? path.join(up, 'Contents', 'Resources', 'app')
        : path.join(up, 'resources', 'app');
    const upRes = path.join(upAppDir, 'resources', platformLayerName());
    if (fs.existsSync(path.join(upRes, 'components', 'WCH', 'manifest.json'))) {
      const upRoot = host() === 'darwin' ? normalizeMacAppRoot(up) : up;
      if (upRoot) return { root: upRoot, res: upRes, appDir: upAppDir };
    }
  }
  return null;
}

function readRootNames(root: string): string[] | null {
  try {
    return fs.readdirSync(root);
  } catch {
    return null;
  }
}

/**
 * The generation's launcher program, per host OS (relative to the root):
 *   Windows  "MounRiver Studio <N>.exe" in the root
 *   Linux    "mounriver-studio <n>" in the root or bin/ (the .deb ships bin/)
 *   macOS    Contents/MacOS/Electron — the same Electron stub for both
 *            generations, so on macOS the generation can only come from
 *            product.json (always present in a real bundle; an unmarked tree
 *            passes the launcher step for either generation)
 */
export function launcherFileNames(gen: 'mrs2' | 'mrs3'): string[] {
  if (host() === 'darwin') return [path.join('Contents', 'MacOS', 'Electron')];
  if (host() === 'win32') return [gen === 'mrs3' ? 'MounRiver Studio 3.exe' : 'MounRiver Studio 2.exe'];
  const n = gen === 'mrs3' ? '3' : '2';
  return [`mounriver-studio ${n}`, path.join('bin', `mounriver-studio ${n}`)];
}

function hasLauncher(root: string, gen: 'mrs2' | 'mrs3'): boolean {
  const wanted = launcherFileNames(gen);
  if (host() === 'darwin') {
    return wanted.every((rel) => fs.existsSync(path.join(root, rel)));
  }
  const names = readRootNames(root);
  const rootHit = (n: string): boolean => !!names && names.some((f) => f.toLowerCase() === n.toLowerCase());
  if (wanted.some(rootHit)) return true;
  const binNames = readRootNames(path.join(root, 'bin'));
  const binBase = wanted[0];
  return !!binNames && binNames.some((f) => f.toLowerCase() === binBase.toLowerCase());
}

/**
 * The IDE launcher binary of an install, resolved to an absolute path —
 * '' for a toolchain-only install (there is no IDE to open) and '' when the
 * launcher is missing. Mirrors hasLauncher's matching, including the
 * case-insensitive root/bin fallback the Linux .deb layout needs; the
 * returned name may contain spaces ("mounriver-studio 2"), which spawn()
 * handles as a single argv[0].
 */
export function installLauncherPath(install: MrsInstall): string {
  if (install.kind !== 'ide') return '';
  const gen = install.flavor === 'mrs3' ? 'mrs3' : 'mrs2';
  const wanted = launcherFileNames(gen);
  if (host() === 'darwin') return path.join(install.root, ...wanted);
  const rootHit = path.join(install.root, wanted[0]);
  if (fs.existsSync(rootHit)) return rootHit;
  const binHit = path.join(install.root, 'bin', wanted[0]);
  if (fs.existsSync(binHit)) return binHit;
  // case-insensitive fallback over the actual directory listings
  const binNames = readRootNames(path.join(install.root, 'bin'));
  const inBin = binNames?.find((f) => f.toLowerCase() === wanted[0].toLowerCase());
  if (inBin) return path.join(install.root, 'bin', inBin);
  const names = readRootNames(install.root);
  const inRoot = names?.find((f) => f.toLowerCase() === wanted[0].toLowerCase());
  if (inRoot) return path.join(install.root, inRoot);
  return '';
}

/**
 * CLI arguments that make the MRS launcher open a project file.
 *
 * TWO separate argv elements, `-m <path>` — the exact form MRS's own
 * installers register for the shell context menu (install-openwith.bat:
 * `"<exe>" "-m" "%1"`). The bundled extension's internal `-m=<path>` (equals
 * form) is NOT equivalent on a real desktop: it opens a window titled after
 * the project but leaves the workspace EMPTY (explorer blank, and the mrs
 * extension's getProjectProperties crashes with JSON.parse(undefined) since
 * no project is in the tree — real-desktop evidence 2026-11-12).
 */
export function mrsOpenProjectArgs(wvprojPath: string): string[] {
  return ['-m', wvprojPath];
}

/**
 * The detached Windows launch argv for opening a project: PowerShell
 * Start-Process, launched with -WorkingDirectory = the project root and the
 * .wvproj given as an ABSOLUTE path.
 *
 * MRS itself refuses a relative .wvproj ("The following file path is not
 * absolute", 2026-11-12 user report) — the earlier -WorkingDirectory +
 * relative-basename form was wrong even though it avoided quoting.
 * PS 5.1's Start-Process -ArgumentList does NOT quote elements, so the
 * absolute path is passed with EMBEDDED double quotes; probe-verified that
 * the quotes survive the EncodedCommand channel and the child receives one
 * argv token even when the path contains spaces (2026-11-12 follow-up).
 * -FilePath and -WorkingDirectory are real PS parameters: PS binds and
 * quotes them itself, so space-containing install paths and project roots
 * are fine.
 */
export function mrsWindowsLaunchArgv(launcher: string, wvprojPath: string, workingDir: string): string[] {
  const psQuote = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
  // -EncodedCommand (base64 UTF-16LE) instead of -Command: the plain -Command
  // channel STRIPS the inner quotes when the script is passed through Node's
  // argv quoting (probe-verified — the whole Start-Process line lost every
  // quote), while -EncodedCommand delivers the script verbatim.
  const quotedProject = '"' + wvprojPath + '"';
  const script =
    `Start-Process -FilePath ${psQuote(launcher)} -WorkingDirectory ${psQuote(workingDir)} -ArgumentList ${psQuote('-m')},${psQuote(quotedProject)}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
}

/**
 * The launch argv for a platform, decided PURELY (every platform is testable
 * on any host — round-11 P3-1):
 *   - win32: the PowerShell Start-Process wrapper with -WorkingDirectory +
 *     the ABSOLUTE .wvproj (embedded quotes — see mrsWindowsLaunchArgv).
 *   - POSIX: sh -c with "$1" "$2" "$3" — the quoting carries spaces in both
 *     the launcher and the absolute .wvproj path.
 */
export function mrsLaunchSpec(
  platform: NodeJS.Platform,
  launcher: string,
  wvprojPath: string,
  workingDir: string
): { argv: string[] } {
  if (platform === 'win32') {
    return { argv: mrsWindowsLaunchArgv(launcher, wvprojPath, workingDir) };
  }
  return { argv: ['sh', '-c', '"$1" "$2" "$3" >/dev/null 2>&1 &', 'mrvc', launcher, ...mrsOpenProjectArgs(wvprojPath)] };
}

/**
 * Probe the generation. Both MRS2 and MRS3 carry a dedicated `mrsVersion`
 * key in the app dir's product.json ("2.0.0" / "3.0.0") — that is
 * authoritative. The branding string and the launcher name are the fallbacks
 * (a hand-assembled install may lack product.json).
 */
export function detectFlavor(root: string): { flavor: MrsFlavor; label: string } {
  let label = '';
  try {
    const layout = locateLayout(root);
    const pj = layout ? path.join(layout.appDir, 'product.json') : '';
    if (pj && fs.existsSync(pj)) {
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

/** the install root ships the generation's launcher program — presence-only
 *  probe (per-OS launcher names; the "bin/mounriver-studio <n>" form has no
 *  distinct flavor spelling, so it is checked through the root-level name) */
function detectLauncherFlavor(root: string): 'mrs2' | 'mrs3' | null {
  if (host() === 'darwin') return null; // Electron stub names no generation
  const names = readRootNames(root);
  if (!names) return null;
  const hit = (n: string): boolean => names.some((f) => f.toLowerCase() === n.toLowerCase());
  if (hit('MounRiver Studio 3.exe') || hit('mounriver-studio 3')) return 'mrs3';
  if (hit('MounRiver Studio 2.exe') || hit('mounriver-studio 2')) return 'mrs2';
  return null;
}

/** why a configured install path can not be used */
export type InstallPathProblem =
  /** the directory does not exist */
  | 'missing'
  /** exists, but has no components/WCH/manifest.json — not a MounRiver tree */
  | 'not-install'
  /** exists, but is not a standalone toolchain root (no Toolchain sub_manifest
   *  + OpenOCD, or no RISC-V gcc resolves from the manifest) */
  | 'not-toolchain'
  /** it IS an installation, but of the OTHER generation */
  | 'wrong-generation'
  /** the generation's launcher program is absent */
  | 'no-launcher'
  /** (Linux/macOS) the toolchain binaries are built for another CPU arch —
   *  e.g. the arm64-only macOS IDE configured on an Intel Mac */
  | 'wrong-arch';

export interface InstallPathCheck {
  /** the configured value (trimmed) */
  path: string;
  ok: boolean;
  install?: MrsInstall;
  problem?: InstallPathProblem;
  /** the generation the path itself declares (for the reason message) */
  foundFlavor?: MrsFlavor;
  /** (wrong-arch) the arch the binaries were built for, e.g. "arm64" */
  foundArch?: string;
}

/**
 * Read a toolchain binary's header and compare its CPU arch with this host.
 *   ELF      e_machine: 0x3E x86-64 / 0xB7 AArch64
 *   Mach-O   cputype:   0x00000007 x86_64 / 0x0100000C arm64 (both byte orders)
 *   FAT      universal — always a match
 * 'unknown' passes (a header we cannot read must not reject an install).
 */
export function checkBinaryArch(file: string): { verdict: 'match' | 'mismatch' | 'unknown'; arch?: string } {
  let host = '';
  if (process.arch === 'x64') host = 'x64';
  else if (process.arch === 'arm64') host = 'arm64';
  else return { verdict: 'unknown' };
  let head: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      head = Buffer.alloc(24);
      const read = fs.readSync(fd, head, 0, 24, 0);
      if (read < 20) return { verdict: 'unknown' };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { verdict: 'unknown' };
  }
  let arch = '';
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    const machine = head[18] | (head[19] << 8);
    if (machine === 0x3e) arch = 'x64';
    else if (machine === 0xb7) arch = 'arm64';
    else return { verdict: 'unknown' };
  } else if (head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) {
    const cpu = head.readUInt32LE(4);
    if (cpu === 0x0100000c) arch = 'arm64';
    else if (cpu === 0x00000007) arch = 'x64';
    else return { verdict: 'unknown' };
  } else if (head[0] === 0xfe && head[1] === 0xed && head[2] === 0xfa && head[3] === 0xce) {
    const cpu = head.readUInt32BE(4);
    if (cpu === 0x0100000c) arch = 'arm64';
    else if (cpu === 0x00000007) arch = 'x64';
    else return { verdict: 'unknown' };
  } else if (
    (head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe) ||
    (head[0] === 0xbe && head[1] === 0xba && head[2] === 0xfe && head[3] === 0xca)
  ) {
    return { verdict: 'match' }; // universal binary
  } else {
    return { verdict: 'unknown' };
  }
  return arch === host ? { verdict: 'match' } : { verdict: 'mismatch', arch };
}

/**
 * Platform-correct existence of a manifest-named tool BINARY. The manifest
 * carries BARE file names (riscv-none-embed-gcc) and that is what makefile
 * recipes must keep using — but executability differs: Windows runs only
 * `foo.exe` (CreateProcess/PATHEXT), POSIX only the bare name. A POSIX
 * package copied onto Windows (bare files, no .exe) must therefore be
 * rejected, not accepted because the bytes exist. Never rewrite the emitted
 * paths — bare names stay in ToolchainInfo for the recipes.
 */
function toolFileExists(p: string): boolean {
  const s = platformSuffix();
  return fs.existsSync(s === '' ? p : p + s);
}

/** the real on-disk spelling of a manifest-named binary (for direct reads
 *  like the arch header, and for tool paths handed to OTHER programs —
 *  e.g. cpptools' compilerPath — that stat the file instead of relying on
 *  CreateProcess's .exe fallback) */
export function withRealSuffix(p: string): string {
  const s = platformSuffix();
  return s === '' ? p : fs.existsSync(p + s) ? p + s : p;
}

/** (Linux/macOS) the first existing gcc of the install decides the arch gate;
 *  Windows binaries are not checked (x86-only toolchains, no arch variance).
 *
 *  "At least one toolchain matches" semantics: a MIXED-ARCH package (mac
 *  V2.4: GCC8 x86_64, GCC12/15 arm64) must not be rejected wholesale because
 *  its FIRST manifest entry mismatches — the host can still build natively
 *  with GCC12/15. The install is rejected only when toolchain binaries exist
 *  and NONE matches the host (the arm64-only macOS MRS3 IDE on an Intel
 *  Mac) — binaries whose arch cannot be read do not count as matches, so one
 *  clearly-mismatched binary with no matching sibling still rejects. Which
 *  toolchain the project actually selects is judged at selection time
 *  (toolchainArchProblem). */
function archGate(install: MrsInstall): InstallPathCheck | null {
  if (host() === 'win32') return null;
  let sawBinary = false;
  let firstMismatch: string | undefined;
  for (const t of install.toolchains) {
    if (!toolFileExists(t.compilerC)) continue;
    sawBinary = true;
    const arch = checkBinaryArch(withRealSuffix(t.compilerC));
    if (arch.verdict === 'match') return null; // one native toolchain is enough
    if (arch.verdict === 'mismatch' && !firstMismatch) firstMismatch = arch.arch;
    // an 'unknown' binary is not a match; rejection still requires one we
    // COULD read that clearly mismatches (round20 §5.2 wording)
  }
  if (sawBinary && firstMismatch) {
    return { path: install.root, ok: false, problem: 'wrong-arch', foundArch: firstMismatch };
  }
  return null;
}

/**
 * Selection-time arch gate (POSIX): judge the toolchain the project
 * ACTUALLY selected. Mixed-arch packages pass startup via their native
 * toolchains and fail here only when the selected one mismatches the host
 * (e.g. GCC8 — x86_64 — chosen on Apple Silicon; it would run only under
 * Rosetta 2). Returns the mismatch details for the message, or null.
 * Windows always null; unreadable/missing binaries pass (never reject on
 * what we cannot read).
 */
export function toolchainArchProblem(
  tc: ToolchainInfo,
  /** defaults to the module's host seam (setHostPlatformForTests) so the
   *  vscode-layer glue in MrsProject.toolchain is testable from any host */
  platform: NodeJS.Platform = host()
): { toolchain: string; foundArch: string; hostArch: string } | null {
  if (platform === 'win32') return null;
  if (!toolFileExists(tc.compilerC)) return null;
  const arch = checkBinaryArch(withRealSuffix(tc.compilerC));
  if (arch.verdict !== 'mismatch') return null;
  return { toolchain: tc.name, foundArch: arch.arch ?? '?', hostArch: process.arch };
}

/**
 * Validate ONE configured IDE path for ONE generation: the directory must
 * exist, be a MounRiver installation for THIS OS (the WCH manifest marker in
 * the platform layer), declare that generation (product.json / launcher name —
 * an unmarked tree can not be verified and fails here), ship the launcher
 * program, and — outside Windows — carry toolchain binaries for this CPU.
 * This is the startup criterion: the extension starts only when at least one
 * field passes it.
 */
export function checkInstallPath(configured: string, expect: 'mrs2' | 'mrs3'): InstallPathCheck {
  const root = configured.trim();
  if (!fs.existsSync(root)) return { path: root, ok: false, problem: 'missing' };
  const layout = locateLayout(root);
  if (!layout) return { path: root, ok: false, problem: 'not-install' };
  const { flavor } = detectFlavor(layout.root);
  if (flavor !== 'unknown' && flavor !== expect) {
    return { path: root, ok: false, problem: 'wrong-generation', foundFlavor: flavor };
  }
  if (!hasLauncher(layout.root, expect)) {
    return { path: root, ok: false, problem: 'no-launcher', foundFlavor: flavor };
  }
  const install = buildInstall(layout.root, layout.res);
  const arch = archGate(install);
  if (arch) return arch;
  return { path: root, ok: true, install, foundFlavor: flavor };
}

/**
 * Validate ONE configured standalone-toolchain root: Toolchain/ + OpenOCD/ at
 * the top, a RISC-V toolchain resolvable from Toolchain/sub_manifest.json, and
 * (outside Windows) binaries for this CPU.
 */
export function checkToolchainPath(configured: string): InstallPathCheck {
  const root = configured.trim();
  if (!fs.existsSync(root)) return { path: root, ok: false, problem: 'missing' };
  const install = buildStandaloneInstall(root);
  if (!install) return { path: root, ok: false, problem: 'not-toolchain' };
  const arch = archGate(install);
  if (arch) return arch;
  return { path: root, ok: true, install, foundFlavor: install.flavor };
}

/**
 * First valid candidate wins. `configured` comes first so an explicit setting
 * beats the conventional locations; `opts.defaults` replaces the built-in
 * conventional list (MRS2 first, then MRS3; tests inject hermetic paths).
 */
export function locateInstall(
  configured?: string | string[],
  opts: { defaults?: string[] } = {}
): MrsInstall | null {
  const configuredList = (Array.isArray(configured) ? configured : configured ? [configured] : [])
    .map((p) => p.trim())
    .filter(Boolean);
  const defaults = opts.defaults ?? [...conventionalInstalls().mrs2, ...conventionalInstalls().mrs3];
  const seen = new Set<string>();
  for (const root of [...configuredList, ...defaults]) {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const layout = locateLayout(root);
    if (layout) return buildInstall(layout.root, layout.res);
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
    resourcesDir: res,
    kind: 'ide',
    components,
    makeBin,
    openocdExe: path.join(openocdBin, 'openocd' + platformSuffix()),
    openocdCfg: path.join(openocdBin, 'wch-riscv.cfg'),
    // the WCH-LinkUtility GUI ships only in the Windows installs; POSIX
    // flashing goes through OpenOCD, so there is no utility to point at
    linkUtilityExe:
      host() === 'win32'
        ? path.join(components, 'Others', 'SWDTool', 'default', 'WCH-LinkUtility.exe')
        : '',
    toolchains: loadToolchains(components),
    flavor,
    label,
  };
}

/** the standalone shape: Toolchain/ and OpenOCD/ at the top of the root (the
 *  unpacked MRS_Toolchain_* packages); no IDE, no bundled make */
function buildStandaloneInstall(root: string): MrsInstall | null {
  if (!fs.existsSync(path.join(root, 'Toolchain', 'sub_manifest.json'))) return null;
  if (!fs.existsSync(path.join(root, 'OpenOCD'))) return null;
  // the standalone manifest sits at <root>/Toolchain/sub_manifest.json — the
  // same relative shape the IDE layout keeps under components/, so the plain
  // loader resolves it when handed the root. At least one compiler binary
  // must really exist (bare or — on Windows — .exe): a manifest whose gcc is
  // nowhere on disk is a broken unpack, and the arch gate would silently
  // skip it.
  const toolchains = loadToolchains(root);
  if (!toolchains.some((t) => toolFileExists(t.compilerC))) return null;
  const openocdBin = path.join(root, 'OpenOCD', 'OpenOCD', 'bin');
  return {
    root,
    resourcesDir: root,
    kind: 'toolchain',
    components: root,
    makeBin: '',
    openocdExe: path.join(openocdBin, 'openocd' + platformSuffix()),
    openocdCfg: path.join(openocdBin, 'wch-riscv.cfg'),
    linkUtilityExe: '',
    toolchains,
    flavor: 'mrs2', // the shipped MRS_Toolchain_* packages are MRS2-generation
    label: STANDALONE_LABEL,
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

/** bundled make for an install, else the system make from PATH ('' = none) */
export function resolveMakeExe(install: MrsInstall | null): string {
  if (install?.makeBin) {
    const bundled = path.join(install.makeBin, 'make' + platformSuffix());
    if (fs.existsSync(bundled)) return bundled;
  }
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'make' + platformSuffix());
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // an unreadable PATH entry must not break the search
    }
  }
  return '';
}

/**
 * How the install settings combine into ONE active installation:
 *   mrvc.mrs2InstallPath / mrvc.mrs3InstallPath — IDE roots, each validated
 *     for its own generation
 *   mrvc.toolchainOnlyPath — a standalone toolchain root (no generation pin;
 *     these packages are the MRS2-generation toolchains)
 *
 * Startup criterion: at least one field must pass its validation, otherwise
 * `install` is null and the caller must not start (the gate asks the user for
 * a correct path). When ALL fields are empty the platform's conventional IDE
 * locations are validated and adopted silently (fromDefault-marked: this is
 * the zero-config experience — on Windows the same C:\MounRiver\... roots the
 * 0.2.x schema defaults pointed at); an installation found at a conventional
 * location while fields ARE configured is only OFFERED for one-click adoption
 * (`detected`), never used silently.
 *
 * Among the valid candidates `mrvc.mrsVersion` picks: mrs2 → IDE2 →
 * standalone → IDE3; mrs3 → IDE3 → IDE2 → standalone; auto → IDE3 → IDE2 →
 * standalone. A pin whose generation is not valid falls back down that order
 * and is reported (pinnedFellBack), so the user always knows which install is
 * active.
 */
export interface InstallSelection {
  install: MrsInstall | null;
  requested: 'auto' | 'mrs2' | 'mrs3';
  /** every non-empty field plus the zero-config conventional hits, validated */
  checks: InstallFieldCheck[];
  /** the fields that FAILED validation (reported, never substituted) */
  failedFields: InstallFieldCheck[];
  /** every field is empty AND no conventional location holds an install —
   *  nothing to check at all */
  notConfigured: boolean;
  /** the two IDE fields hold each other's generation (a plausible mis-edit):
   *  the gate can offer to swap the two values */
  swappedFields: boolean;
  /** an installation found at a conventional location — offered for one-click
   *  adoption when no field is valid, never used by itself (null as soon as a
   *  field passes validation) */
  detected: MrsInstall | null;
  /** the preferred generation is not valid and `install` is a fallback */
  pinnedFellBack?: 'mrs2' | 'mrs3';
  /** auto only: both IDE generations valid (explicit fields or conventional) */
  bothValid: boolean;
  mrs2Label: string;
  mrs3Label: string;
  /** branding for the standalone candidate in notes ("MRS Toolchain …") */
  toolchainLabel: string;
  /** the configured values (trimmed) — lets a "swap them" action write them
   *  back without re-reading the settings */
  mrs2PathValue: string;
  mrs3PathValue: string;
  toolchainPathValue: string;
}

/** one of the install settings, validated */
export interface InstallFieldCheck extends InstallPathCheck {
  field: 'mrs2InstallPath' | 'mrs3InstallPath' | 'toolchainOnlyPath';
  /** the value was not a user choice (schema default or the zero-config
   *  conventional probe): its failure is listed in the gate's diagnostics but
   *  not warned about at every start — a user who only has MRS2 must not be
   *  nagged about the MRS3 slot */
  fromDefault?: boolean;
}

/** the policy that turns the settings into one active install */
export function selectInstall(
  opts: {
    mrs2Path?: string;
    mrs3Path?: string;
    toolchainPath?: string;
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
  const rawT = (opts.toolchainPath ?? '').trim();
  const requested: InstallSelection['requested'] =
    opts.version === 'mrs2' || opts.version === 'mrs3' ? opts.version : 'auto';
  const fromDefault = (value: string, dflt?: string): boolean => !!dflt && value === dflt.trim();
  // each field is validated independently: an IDE field for its own
  // generation, the toolchain field for the standalone shape
  const c2: InstallFieldCheck | null = raw2
    ? { field: 'mrs2InstallPath', fromDefault: fromDefault(raw2, opts.mrs2Default), ...checkInstallPath(raw2, 'mrs2') }
    : null;
  const c3: InstallFieldCheck | null = raw3
    ? { field: 'mrs3InstallPath', fromDefault: fromDefault(raw3, opts.mrs3Default), ...checkInstallPath(raw3, 'mrs3') }
    : null;
  const ct: InstallFieldCheck | null = rawT ? { field: 'toolchainOnlyPath', ...checkToolchainPath(rawT) } : null;
  let v2 = c2?.ok ? c2.install! : null;
  let v3 = c3?.ok ? c3.install! : null;
  const vt = ct?.ok ? ct.install! : null;
  // zero-config: with every field empty the platform's conventional IDE
  // locations are validated and adopted (marked fromDefault — this is not a
  // user choice; the Windows roots here are the ones the 0.2.x schema
  // defaults carried). `defaults` (the tests' hermetic lists) replaces them.
  const implicit: InstallFieldCheck[] = [];
  if (!raw2 && !raw3 && !rawT) {
    const convM2 = defaults.mrs2 ?? conventionalInstalls().mrs2;
    const convM3 = defaults.mrs3 ?? conventionalInstalls().mrs3;
    const probe = (gen: 'mrs2' | 'mrs3', list: string[]): InstallFieldCheck | null => {
      for (const p of list) {
        const c = checkInstallPath(p, gen);
        if (c.ok) return { field: gen === 'mrs3' ? 'mrs3InstallPath' : 'mrs2InstallPath', fromDefault: true, ...c };
      }
      return null;
    };
    const i2 = probe('mrs2', convM2);
    const i3 = probe('mrs3', convM3);
    if (i2) {
      v2 = i2.install!;
      implicit.push(i2);
    }
    if (i3) {
      v3 = i3.install!;
      implicit.push(i3);
    }
  }
  const checks = [...implicit, ...([c2, c3, ct].filter((c): c is InstallFieldCheck => !!c))];
  const failedFields = checks.filter((c) => !c.ok);
  const notConfigured = checks.length === 0;
  const swappedFields =
    !!c2 && !!c3 && c2.problem === 'wrong-generation' && c3.problem === 'wrong-generation' &&
    c2.foundFlavor === 'mrs3' && c3.foundFlavor === 'mrs2';

  let install: MrsInstall | null = null;
  let pinnedFellBack: 'mrs2' | 'mrs3' | undefined;
  if (requested === 'mrs2') {
    // the pin is a preference: when its generation is not valid the ranking
    // (standalone toolchain next, then the other IDE) applies and is reported
    install = v2 ?? vt ?? v3;
    if (!v2 && (vt || v3)) pinnedFellBack = 'mrs2';
  } else if (requested === 'mrs3') {
    install = v3 ?? v2 ?? vt;
    if (!v3 && (v2 || vt)) pinnedFellBack = 'mrs3';
  } else {
    install = v3 ?? v2 ?? vt; // auto prefers MRS3, then MRS2, then standalone
  }
  // only when no field is valid: look at the conventional locations, merely to
  // OFFER them (the caller asks the user before adopting)
  const detected = install
    ? null
    : locateInstall(undefined, {
        defaults: [
          ...(defaults.mrs2 ?? conventionalInstalls().mrs2),
          ...(defaults.mrs3 ?? conventionalInstalls().mrs3),
        ],
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
    toolchainLabel: vt?.label ?? STANDALONE_LABEL,
    mrs2PathValue: raw2,
    mrs3PathValue: raw3,
    toolchainPathValue: rawT,
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
