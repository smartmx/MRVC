/**
 * Locate build tools inside a MounRiver Studio 2 installation and resolve
 * the RISC-V toolchain component from components/WCH/Toolchain/sub_manifest.json.
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

export interface MrsInstall {
  root: string; // MounRiver_Studio2 install root
  resourcesWin32: string; // <root>/resources/app/resources/win32
  components: string; // .../components
  makeBin: string;
  openocdExe: string;
  openocdCfg: string; // wch-riscv.cfg next to openocd
  linkUtilityExe: string;
  toolchains: ToolchainInfo[];
}

export const DEFAULT_INSTALL_PATHS = [
  'C:\\MounRiver\\MounRiver_Studio2',
  'C:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32',
];

export function locateInstall(configuredPath?: string): MrsInstall | null {
  const candidates: string[] = [];
  if (configuredPath) candidates.push(configuredPath);
  candidates.push(...DEFAULT_INSTALL_PATHS);
  for (const root of candidates) {
    const res = path.join(root, 'resources', 'app', 'resources', 'win32');
    const flat = path.join(root, 'resources', 'app', 'resources', 'win32');
    if (fs.existsSync(path.join(res, 'components', 'WCH', 'manifest.json'))) {
      return buildInstall(root, res);
    }
    // configuredPath may already be the win32 resources dir
    if (fs.existsSync(path.join(flat, 'components', 'WCH', 'manifest.json'))) {
      return buildInstall(path.dirname(path.dirname(path.dirname(root))), flat);
    }
  }
  return null;
}

function buildInstall(root: string, res: string): MrsInstall {
  const components = path.join(res, 'components', 'WCH');
  const makeBin = path.join(res, 'others', 'Build_Tools', 'Make', 'bin');
  const openocdBin = path.join(components, 'OpenOCD', 'OpenOCD', 'bin');
  return {
    root,
    resourcesWin32: res,
    components,
    makeBin,
    openocdExe: path.join(openocdBin, 'openocd.exe'),
    openocdCfg: path.join(openocdBin, 'wch-riscv.cfg'),
    linkUtilityExe: path.join(components, 'Others', 'SWDTool', 'default', 'WCH-LinkUtility.exe'),
    toolchains: loadToolchains(components),
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
 * Pick the toolchain for a project. Preference order:
 *   1. explicit request (GCC8/GCC12/GCC15 from settings)
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
  const byName = new Map(install.toolchains.map((t) => [t.name, t]));
  const firstInstalled = () => install.toolchains.find((t) => fs.existsSync(path.join(t.dir, 'bin'))) ?? install.toolchains[0];

  if (request && request !== 'auto' && byName.has(request)) {
    return byName.get(request)!;
  }
  if (rvGccVersion === '12') return byName.get('GCC12') ?? firstInstalled();
  if (rvGccVersion === '15') return byName.get('GCC15') ?? firstInstalled();
  if (rvGccVersion === '8') return byName.get('GCC8') ?? firstInstalled();
  if (storedPrefix === 'riscv-none-embed-') return byName.get('GCC8') ?? firstInstalled();
  if (storedPrefix === 'riscv-wch-elf-') return byName.get('GCC12') ?? firstInstalled();
  if (storedPrefix === 'riscv32-wch-elf-') return byName.get('GCC15') ?? firstInstalled();
  return firstInstalled();
}
