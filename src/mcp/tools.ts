/**
 * MRVC MCP tool set — the headless surface over src/core for AI clients.
 *
 * The server (server.ts) speaks MCP stdio JSON-RPC; this module defines the
 * tools and their handlers. EVERY handler delegates to the zero-dependency
 * core modules (discover / cproject / makefile / toolchain / audit / cmake /
 * intellisense / buildLog) — no vscode import anywhere on this path, so the
 * same server runs inside VSCode, in a terminal, or on a CI machine with
 * nothing but an MRS install present.
 *
 * v1 scope: read + build + hardware (flash / power-off-reset). There is no
 * config-writing tool; the hardware tools open with a HARD GATE — the
 * receipt the extension writes after a successful MANUAL download must
 * exist, its .template hash must still match, and the plan the MCP is about
 * to run must fingerprint-match the plan that download executed (see
 * core/flashAck). Build + both hardware operations run through an in-server
 * mutex so a pipelining client can never open two link sessions at once,
 * and every spawned child is tracked and killed when the server exits.
 *
 * MRS install resolution: the per-call `mrsInstallPath` argument wins, then
 * the MRVC_MRS_INSTALL_PATH environment variable, then the conventional
 * install locations (locateInstall's own probe, the same C:/D: lists the
 * extension uses).
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  findProjectRoots,
  isLegalProjectRoot,
  DEFAULT_DISCOVERY_DEPTH,
} from '../core/discover';
import { Cproject } from '../core/cproject';
import { generateMakefiles } from '../core/makefile';
import {
  locateInstall,
  selectToolchain,
  resolveMakeExe,
  type MrsInstall,
  type ToolchainInfo,
} from '../core/toolchain';
import { foldPathOnPlatform } from '../core/cproject';
import { prepareFlash, inferFlashAddress, type PowerVoltage } from '../core/flash';
import { preparePowerPass, powerPassVerdict, freshLogPath, clampPowerOffDelay } from '../core/powerCycle';
import { checkWCHLinkFirmware, linkSupportsPowerOutput } from '../core/wlink';
import {
  checkFlashAck,
  fingerprintFlashPlan,
  samePlanFingerprint,
  describePlanFingerprint,
  type FlashPlanFingerprint,
  readPowerAck,
  fingerprintPowerPlan,
  samePowerFingerprint,
  describePowerFingerprint,
  powerAckPath,
  checkPowerAck,
} from '../core/flashAck';
import { readTemplate } from '../core/templateFile';
import { scanSources } from '../core/scan';
import { auditProjectConfig } from '../core/audit';
import { buildCMakeContent } from '../core/cmake';
import { buildCompileEntries, type CompileCommandEntry } from '../core/intellisense';
import { buildRecordFile } from '../core/buildLog';

/** the protocol version the server announces (echoed from the client's
 *  initialize request when present) */
export const SUPPORTED_PROTOCOL_VERSION = '2024-11-05';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_NAMES = [
  'mrvc_discover_projects',
  'mrvc_get_install_info',
  'mrvc_get_project_config',
  'mrvc_audit_project',
  'mrvc_build',
  'mrvc_get_build_log',
  'mrvc_export_cmake',
  'mrvc_generate_intellisense_db',
  'mrvc_flash',
  'mrvc_power_off_reset',
] as const;

const PROJECT_ROOT_DESC =
  'Absolute path of the MRS project directory (it must contain a *.wvproj marker, .project and .cproject).';

export function listTools(): ToolDescriptor[] {
  return [
    {
      name: 'mrvc_discover_projects',
      description:
        'Scan a directory tree for MounRiver (MRS) projects. A legal project directory holds a *.wvproj marker plus .project and .cproject. Returns a compact summary per project.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Directory to scan (default: the server working directory).' },
          depth: { type: 'number', description: `Maximum directory nesting to descend (default ${DEFAULT_DISCOVERY_DEPTH}).` },
        },
      },
    },
    {
      name: 'mrvc_get_install_info',
      description:
        'Resolve the MounRiver Studio installation MRVC would use (explicit path > MRVC_MRS_INSTALL_PATH > conventional C:/D: locations) and report its generation, toolchains and make/openocd paths. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
      },
    },
    {
      name: 'mrvc_get_project_config',
      description:
        'Read one project\u2019s build configuration: active configuration, all configuration names, C/C++ mode, toolchain, target name, linked folders and a sample compile command line with the real -I/-D flags. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { root: { type: 'string', description: PROJECT_ROOT_DESC } },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_audit_project',
      description:
        'Check a project\u2019s configuration for the known breakages (enum options missing their value, malformed .template Address, rvGcc value shape, XML structure, .project/.cproject name mismatch). Reports findings; does not repair.',
      inputSchema: {
        type: 'object',
        properties: { root: { type: 'string', description: PROJECT_ROOT_DESC } },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_build',
      description:
        'Build or clean one MRS project headlessly: regenerate the CDT-style makefiles from .cproject (byte-identical to the extension), then run the MRS-bundled make. Returns the exit code, the output tail and the produced elf/hex/bin sizes. No download — hardware operations are not exposed.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          target: { type: 'string', enum: ['build', 'clean'], description: 'Default build.' },
          jobs: { type: 'number', description: 'Parallel make jobs (default 8).' },
          timeoutSec: { type: 'number', description: 'Hard timeout for make in seconds (default 600 / MRVC_MCP_BUILD_TIMEOUT_SEC, clamped 5–3600). A timed-out run reports ok:false with timedOut:true.' },
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_get_build_log',
      description: 'Read the tail of the project\u2019s last full-build record (the same record the extension writes). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          lines: { type: 'number', description: 'How many trailing lines to return (default 100).' },
        },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_export_cmake',
      description:
        'Generate CMakeLists.txt in the project root from the current configuration. Refuses to overwrite an existing file unless overwrite is true.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          overwrite: { type: 'boolean', description: 'Replace an existing CMakeLists.txt (default false).' },
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_generate_intellisense_db',
      description:
        'Generate .vscode/compile_commands.json for the project with the exact per-file compile arguments (-I/-D) the build would use — including excluded-from-build files. Lets cpptools or an AI resolve headers and macros precisely.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_flash',
      description:
        'Download the built firmware to the attached WCH chip via OpenOCD (headless: no chip-mismatch dialog, no SDI printf pass, no firmware-upgrade prompt — the user\u2019s verified manual download covers the hardware setup). ' +
        'HARD GATE: refuses until the user has run Download in the MRVC extension at least once with the CURRENT .template parameters (MRVC records a receipt after a successful manual download; changing the parameters afterwards invalidates it), AND the plan to run must fingerprint-match the verified plan exactly (address / firmware path / board cfg / verify / reset / openocd binary — deviations are refused with the recorded plan quoted). ' +
        'The firmware target follows .template Target Path (missing files fall back to the project\u2019s own artifact) and the build must exist first.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          targetFile: { type: 'string', description: 'Firmware file to flash (absolute, or relative to the project root). Default: .template Target Path, else the project\u2019s own hex/bin. Must match the verified plan.' },
          address: { type: 'string', description: 'Flash address 0x00000000-form (default: .template Address, else inferred). Must match the verified plan.' },
          verify: { type: 'boolean', description: 'Verify after write (default true). Must match the verified plan.' },
          reset: { type: 'boolean', description: 'Reset run after the download (default true). Must match the verified plan.' },
          openocdPath: { type: 'string', description: 'OpenOCD binary override (the extension\u2019s mrvc.openocd.path setting equivalent). Must match the verified plan.' },
          openocdCfg: { type: 'string', description: 'Board cfg override (default: wch-riscv.cfg / wch-dual-core.cfg from the MRS install). Must match the verified plan.' },
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_power_off_reset',
      description:
        'Power-off reset via the WCH-Link rail (pow3v3/pow5v off → delay → on) — the reset path for chips whose NRST is repurposed by 1/2-wire debug. ' +
        'HARD GATE: refuses until the user has run Power-Off Reset in the MRVC extension once (Info view row / command palette) with the SAME rail voltage, delay and board cfg — MRVC records a marker-verified receipt (power-verified.json) after that manual sequence, and the requested plan must fingerprint-match it exactly. Only WCH-LinkE / DAPLink / LinkW can switch the rail — the plain WCH-Link is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          voltage: { type: 'string', enum: ['3v3', '5v'], description: 'Rail to switch (default 3v3). Must match the verified power receipt.' },
          delayMs: { type: 'number', description: 'De-energised duration in ms, 0–10000 (default 100). Must match the verified power receipt.' },
          openocdPath: { type: 'string', description: 'OpenOCD binary override. Must match the verified power receipt.' },
          openocdCfg: { type: 'string', description: 'Board cfg override (default: wch-riscv.cfg / wch-dual-core.cfg from the MRS install). Must match the verified power receipt.' },
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
        required: ['root'],
      },
    },
  ];
}

// ---------------------------------------------------------------- helpers --

class ToolError extends Error {}

/** the caller-named project directory (the tool contract) */
function toolRoot(args: Record<string, unknown>): string {
  const raw = typeof args['root'] === 'string' ? args['root'].trim() : '';
  if (!raw) throw new ToolError('root is required (the MRS project directory)');
  return path.resolve(raw);
}

/** validate + load; every project-taking tool starts here */
function requireCproject(root: string): Cproject {
  if (typeof root !== 'string' || !root.trim()) {
    throw new ToolError('root is required (the MRS project directory)');
  }
  const abs = path.resolve(root.trim());
  if (!isLegalProjectRoot(abs)) {
    throw new ToolError(
      `${abs} is not a legal MRS project — the directory must contain a *.wvproj marker, .project and .cproject (the three-file contract)`
    );
  }
  const cp = Cproject.load(abs);
  // note: configuration names compose on-disk paths (output dir / flash
  // script / power logs) — Cproject.load itself REFUSES traversal shapes
  // ("unsafe configuration name"), so a poisoned .cproject cannot steer
  // these writes outside the project tree
  return cp;
}

/** explicit argument > MRVC_MRS_INSTALL_PATH > conventional locations. An
 *  explicit path is validated STRICTLY: locateInstall would silently fall
 *  back to a conventional install when the requested path fails, and an AI
 *  that named a path must never be redirected to a different tree — it gets
 *  a structured error instead and can correct itself. */
function resolveInstall(explicit?: string): MrsInstall | null {
  const requested = explicit?.trim() || process.env['MRVC_MRS_INSTALL_PATH']?.trim() || '';
  const install = locateInstall(requested || undefined);
  if (!install) return null;
  if (requested && foldPathOnPlatform(path.resolve(requested)) !== foldPathOnPlatform(install.root)) {
    throw new ToolError(
      `the requested MRS install path is not a valid install: ${requested} (locateInstall fell back to ${install.root})`
    );
  }
  return install;
}

/** the hardware gate both flash/power tools open with: the receipt the
 *  extension writes after a successful MANUAL download must exist and
 *  still match the current .template hash. Returns the narrowed ok-state so
 *  the plan fingerprint comparison can read the receipt. */
function requireVerifiedFlash(root: string): Extract<ReturnType<typeof checkFlashAck>, { ok: true }> {
  const gate = checkFlashAck(root);
  if (!gate.ok) throw new ToolError(gate.message);
  return gate;
}

/** board cfg without the vscode settings layer: explicit override → the
 *  dual-core cfg for .kernel projects → the install's wch-riscv.cfg */
function selectBoardCfgHeadless(install: MrsInstall, root: string, cp: Cproject, override?: string): string {
  if (typeof override === 'string' && override.trim()) return path.resolve(root, override.trim());
  const binDir = path.dirname(install.openocdCfg);
  if (isDualCoreProject(root)) return path.join(binDir, 'wch-dual-core.cfg');
  return install.openocdCfg;
}

/** dual-core detection headless: the authoritative .kernel file, else the
 *  .wvproj's basic.kernel block (mirrors the store-side kernel getter) */
function isDualCoreProject(root: string): boolean {
  try {
    const kernelFile = JSON.parse(fs.readFileSync(path.join(root, '.kernel'), 'utf-8')) as { kernelName?: unknown };
    if (typeof kernelFile.kernelName === 'string') return true;
  } catch {
    // no .kernel — fall through to the .wvproj
  }
  try {
    const wvprojName = fs
      .readdirSync(root)
      .find((f) => f.toLowerCase().endsWith('.wvproj'));
    if (wvprojName) {
      const wvproj = JSON.parse(fs.readFileSync(path.join(root, wvprojName), 'utf-8')) as {
        basic?: { kernel?: { kernelName?: unknown } };
      };
      if (wvproj.basic?.kernel && typeof wvproj.basic.kernel.kernelName === 'string') return true;
    }
  } catch {
    // not JSON or absent — single-core
  }
  return false;
}

/** the firmware to flash: explicit targetFile → .template Target Path
 *  (existing files only — EVT trees record artifacts of OTHER projects;
 *  the headless flow falls back with a note instead of interactive-heal)
 *  → the project's own artifact. Refuses when nothing exists. */
function resolveFirmware(
  root: string,
  cp: Cproject,
  tpl: { values: Record<string, string> },
  targetFile: string | undefined
): { file: string; note: string } {
  const own = path.join(root, cp.configName, `${cp.targetName}.${cp.flashFormat === 'binary' ? 'bin' : 'hex'}`);
  if (typeof targetFile === 'string' && targetFile.trim()) {
    const abs = path.resolve(root, targetFile.trim());
    if (!fs.existsSync(abs)) throw new ToolError(`firmware not found: ${abs}`);
    return { file: abs, note: '' };
  }
  const targetRaw = (tpl.values['Target Path'] ?? '').trim();
  if (targetRaw) {
    const cand = path.resolve(root, targetRaw);
    if (fs.existsSync(cand)) {
      return {
        file: cand,
        note: path.resolve(cand) === path.resolve(own) ? '' : `using .template Target Path (${targetRaw}) instead of the project artifact`,
      };
    }
    return { file: own, note: `.template Target Path (${targetRaw}) does not exist on this machine — using the project's own artifact` };
  }
  if (!fs.existsSync(own)) {
    throw new ToolError(`nothing to flash: ${own} does not exist — run mrvc_build first (or pass targetFile)`);
  }
  return { file: own, note: '' };
}

/** toolchain for the project's stored rvGcc version + prefix */
function selectProjectToolchain(install: MrsInstall, cp: Cproject): ToolchainInfo | null {
  return selectToolchain(install, 'auto', cp.rvGccVersion, cp.storedPrefix);
}

function requireToolchain(install: MrsInstall, cp: Cproject): ToolchainInfo {
  const tc = selectProjectToolchain(install, cp);
  if (!tc) {
    throw new ToolError(
      `no usable RISC-V toolchain in ${install.root} for rvGcc version ${cp.rvGccVersion || '(default)'}`
    );
  }
  return tc;
}

function requireMake(install: MrsInstall): string {
  const makeExe = resolveMakeExe(install);
  if (!makeExe) {
    throw new ToolError(`make not found in the MRS install (${install.makeBin || 'no bundled make dir'}) nor on PATH`);
  }
  return makeExe;
}

function summarizeProject(abs: string, cp: Cproject): Record<string, unknown> {
  return {
    name: cp.projectName,
    dir: abs,
    activeConfig: cp.configName,
    configurations: cp.configurationNames,
    isCpp: cp.isCpp,
    rvGccVersion: cp.rvGccVersion,
    targetName: cp.targetName,
    artifactType: cp.artifactType,
    linkedFolders: [...cp.linkedFolders.entries()].map(([name, location]) => ({ name, location })),
  };
}

/** round4 P2 / round5 P3.2 / round6 P2: every spawned child is tracked with
 *  a promise that resolves on its REAL close event (error included), so the
 *  exit path can terminate the tree AND wait for the actual close instead
 *  of guessing. POSIX children spawn detached (own process group) so the
 *  group signal reaches make's gcc/objcopy children; Windows children are
 *  direct-kill only (taskkill /T rejected by the workspace security hook —
 *  known limitation). */
const activeChildren = new Map<ReturnType<typeof spawn>, Promise<void>>();

/** terminate every running child and WAIT for the close events — the exit
 *  paths call this so a client disconnect never orphans a make/OpenOCD
 *  session (round6 P2) */
export async function terminateChildren(): Promise<void> {
  const running = [...activeChildren.entries()];
  if (!running.length) return;
  for (const [proc] of running) {
    try {
      if (process.platform !== 'win32' && proc.pid) {
        try {
          process.kill(-proc.pid, 'SIGTERM'); // whole process group
        } catch {
          proc.kill();
        }
      } else {
        proc.kill();
      }
    } catch {
      // already dead — its close promise is already resolved
    }
  }
  await Promise.race([
    Promise.allSettled(running.map(([, closed]) => closed)),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  activeChildren.clear();
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  envPathDirs: string[],
  timeoutMs: number,
  maxChars: number
): Promise<{ exitCode: number | null; tail: string; output: string; truncated: boolean; timedOut: boolean }> {
  const MAX_CHARS = maxChars; // keep the response bounded for long builds
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      // POSIX: own process group so terminateChildren can signal the whole
      // tree; Windows children stay in the server's group (proc.kill only)
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PATH: [...envPathDirs, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<void>((r) => {
      let done = false;
      const once = () => {
        if (!done) {
          done = true;
          activeChildren.delete(proc);
          r();
        }
      };
      proc.on('close', once);
      proc.on('error', once);
    });
    activeChildren.set(proc, closed);
    let out = '';
    let truncated = false;
    let timedOut = false;
    const push = (chunk: Buffer | string) => {
      out += chunk.toString();
      if (out.length > MAX_CHARS) {
        // keep only the tail — make/openocd output is append-only for our purposes
        out = out.slice(out.length - MAX_CHARS);
        truncated = true;
      }
    };
    proc.stdout?.on('data', push);
    proc.stderr?.on('data', push);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            // round7 P3.3: terminate the WHOLE tree (POSIX group signal — the
            // child was spawned detached; Windows direct kill) and FORCE the
            // result after a short grace instead of waiting for close
            // forever — a make that ignores SIGTERM must not wedge the
            // hardware mutex queue. The (possibly surviving) tree stays
            // tracked in activeChildren for terminateChildren to reap.
            try {
              if (process.platform !== 'win32' && proc.pid) {
                try {
                  process.kill(-proc.pid, 'SIGKILL');
                } catch {
                  proc.kill();
                }
              } else {
                proc.kill();
              }
            } catch {
              // already dead
            }
            setTimeout(() => {
              const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
              resolve({ exitCode: null, tail: lines.slice(-60).join('\n'), output: out, truncated, timedOut });
            }, 1000);
          }, timeoutMs)
        : null;
    proc.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
      resolve({ exitCode: code, tail: lines.slice(-60).join('\n'), output: out, truncated, timedOut });
    });
  });
}

/** round4 P2: make + both hardware operations share ONE in-server mutex — a
 *  pipelining MCP client must never run two link sessions (or a build
 *  against a flashing target) concurrently. Cross-PROCESS serialization
 *  (two servers, or the extension flashing while the MCP builds) stays the
 *  user's responsibility for now, same as the extension's own scope. */
let hardwareChain: Promise<unknown> = Promise.resolve();

function serializeHardware<T>(fn: () => Promise<T>): Promise<T> {
  const run = hardwareChain.then(fn, fn);
  hardwareChain = run.catch(() => undefined);
  return run;
}

const HARDWARE_TOOLS = new Set(['mrvc_build', 'mrvc_flash', 'mrvc_power_off_reset']);

// --------------------------------------------------------------- handlers --

/** round6 P3.1: build timeout — per-call seconds > MRVC_MCP_BUILD_TIMEOUT_SEC
 *  > 600 s (the same order as the extension's mrsBuild.timeoutSec), clamped
 *  to 5..3600. A hung make must not wedge the mutex queue forever. */
function buildTimeoutSec(v: unknown): number {
  const arg = typeof v === 'number' && v > 0 ? v : Number(process.env['MRVC_MCP_BUILD_TIMEOUT_SEC']);
  const raw = Number.isFinite(arg) && arg > 0 ? arg : 600;
  return Math.min(3600, Math.max(5, Math.round(raw)));
}

const handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
  async mrvc_discover_projects(args) {
    const root = path.resolve(
      typeof args['root'] === 'string' && args['root'].trim()
        ? args['root'].trim()
        : process.env['MRVC_MCP_DEFAULT_ROOT']?.trim() || process.cwd()
    );
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new ToolError(`not a directory: ${root}`);
    }
    const depth = typeof args['depth'] === 'number' && args['depth'] > 0 ? Math.floor(args['depth']) : DEFAULT_DISCOVERY_DEPTH;
    const roots = findProjectRoots(root, depth);
    const projects = roots.map((abs) => {
      try {
        return summarizeProject(abs, Cproject.load(abs));
      } catch (e) {
        return { dir: abs, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { root, count: projects.length, projects };
  },

  async mrvc_get_install_info(args) {
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) {
      return {
        ok: false,
        error:
          'no valid MRS install found — pass mrsInstallPath, set MRVC_MRS_INSTALL_PATH, or install MRS at a conventional location (C:/D:\\MounRiver\\MounRiver_Studio2|3)',
      };
    }
    return {
      ok: true,
      label: install.label,
      generation: install.flavor,
      root: install.root,
      components: install.components,
      makeBin: install.makeBin || '(system PATH)',
      openocdExe: install.openocdExe,
      toolchains: install.toolchains.map((t) => t.name),
    };
  },

  async mrvc_get_project_config(args) {
    const root = path.resolve(String(args['root']).trim());
    const cp = requireCproject(root);
    const summary = summarizeProject(root, cp);
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (install) {
      const tc = selectProjectToolchain(install, cp);
      if (tc) {
        summary['toolchain'] = { name: tc.name, installLabel: install.label, compiler: tc.compilerC };
        const entries = buildCompileEntries(cp, tc);
        summary['compileEntryCount'] = entries.length;
        summary['sampleCommand'] = entries.length ? entries[0].arguments.join(' ') : '';
      }
    } else {
      summary['toolchain'] = null;
      summary['note'] = 'no valid MRS install resolved — toolchain/sampleCommand omitted (see mrvc_get_install_info)';
    }
    return summary;
  },

  async mrvc_audit_project(args) {
    const root = path.resolve(String(args['root']).trim());
    requireCproject(root); // the three-file contract first
    const result = auditProjectConfig(root);
    const findings = result.findings.map((f) => ({ code: f.code, file: f.file, detail: f.detail, fixable: f.fixable }));
    return {
      ok: findings.length === 0,
      findingCount: findings.length,
      fixableCount: findings.filter((f) => f.fixable).length,
      findings,
      note: findings.length ? 'repair is extension-only in this version (Project right-click → Audit And Repair)' : '',
    };
  },

  async mrvc_build(args) {
    const root = path.resolve(String(args['root']).trim());
    const cp = requireCproject(root);
    const target = args['target'] === 'clean' ? 'clean' : 'build';
    const jobs = typeof args['jobs'] === 'number' && args['jobs'] > 0 ? Math.floor(args['jobs']) : 8;
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) {
      throw new ToolError('no valid MRS install found — pass mrsInstallPath, set MRVC_MRS_INSTALL_PATH, or install MRS at a conventional location');
    }
    const tc = requireToolchain(install, cp);
    const makeExe = requireMake(install);
    const gen = generateMakefiles(cp, tc);
    const cwd = path.join(root, cp.configName);
    const makeArgs = target === 'clean' ? ['clean'] : [`-j${jobs}`, 'all'];
    const timeoutSec = buildTimeoutSec(args['timeoutSec']);
    const run = await runProcess(makeExe, makeArgs, cwd, [path.join(tc.dir, 'bin'), install.makeBin], timeoutSec * 1000, 192 * 1024);
    const result: Record<string, unknown> = {
      ok: run.exitCode === 0 && !run.timedOut,
      target,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      config: cp.configName,
      toolchain: tc.name,
      generatedMakefiles: gen.files.length,
      sources: gen.sourceCount,
      outputTail: run.tail,
      outputTruncated: run.truncated,
      // round6 P3.1: the MCP build does NOT write the extension's build
      // record (the record feeds the download-target resolution and carries
      // the full instruction list that only the extension pipeline captures)
      // — this build's log lives ONLY in outputTail/output here
      note: 'MCP build log is returned here only; it is not written to the extension build record',
    };
    if (target === 'build') {
      const products: Array<{ file: string; size: number | null }> = [];
      for (const ext of ['elf', 'hex', 'bin']) {
        const f = path.join(cwd, `${cp.targetName}.${ext}`);
        products.push({ file: f, size: fs.existsSync(f) ? fs.statSync(f).size : null });
      }
      result['products'] = products;
    }
    return result;
  },

  async mrvc_get_build_log(args) {
    const root = path.resolve(String(args['root']).trim());
    requireCproject(root);
    const record = buildRecordFile(root);
    const lines = typeof args['lines'] === 'number' && args['lines'] > 0 ? Math.floor(args['lines']) : 100;
    if (!fs.existsSync(record)) {
      return { ok: true, exists: false, recordFile: record, tail: '' };
    }
    const content = fs.readFileSync(record, 'utf-8');
    const all = content.split(/\r?\n/);
    return { ok: true, exists: true, recordFile: record, tail: all.slice(-lines).join('\n') };
  },

  async mrvc_export_cmake(args) {
    const root = path.resolve(String(args['root']).trim());
    const cp = requireCproject(root);
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) throw new ToolError('no valid MRS install found (see mrvc_get_install_info)');
    const tc = requireToolchain(install, cp);
    const file = path.join(root, 'CMakeLists.txt');
    const overwrite = args['overwrite'] === true;
    if (fs.existsSync(file) && !overwrite) {
      throw new ToolError(
        `${file} already exists — a hand-maintained CMakeLists.txt is not silently replaced; pass overwrite: true to replace it`
      );
    }
    const built = buildCMakeContent(cp, tc, file, { forExport: false });
    return { ok: true, file: built.file, sourceCount: built.sourceCount, includeCount: built.includeCount };
  },

  async mrvc_generate_intellisense_db(args) {
    const root = path.resolve(String(args['root']).trim());
    const cp = requireCproject(root);
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) throw new ToolError('no valid MRS install found (see mrvc_get_install_info)');
    const tc = requireToolchain(install, cp);
    const entries: CompileCommandEntry[] = buildCompileEntries(cp, tc);
    const dir = path.join(root, '.vscode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'compile_commands.json');
    fs.writeFileSync(file, JSON.stringify(entries, null, 1), 'utf-8');
    return { ok: true, file, entryCount: entries.length };
  },

  async mrvc_flash(args) {
    const root = path.resolve(String(args['root']).trim());
    const cp = requireCproject(root);
    // THE hardware gate: a verified manual download with the current parameters
    const ackGate = requireVerifiedFlash(root);
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) throw new ToolError('no valid MRS install found (see mrvc_get_install_info)');
    // openocdPath mirrors the extension's mrvc.openocd.path setting — the
    // verified receipt records whichever binary the manual download ran, so
    // a custom-path user aligns by passing the same value here (round5 P2)
    const openocd =
      typeof args['openocdPath'] === 'string' && args['openocdPath'].trim()
        ? path.resolve(args['openocdPath'].trim())
        : install.openocdExe;
    if (!fs.existsSync(openocd)) throw new ToolError(`openocd not found: ${openocd}`);
    const boardCfg = selectBoardCfgHeadless(install, root, cp, typeof args['openocdCfg'] === 'string' ? args['openocdCfg'] : undefined);
    if (!fs.existsSync(boardCfg)) throw new ToolError(`board cfg not found: ${boardCfg}`);
    const tpl = readTemplate(root);
    const fw = resolveFirmware(root, cp, tpl, typeof args['targetFile'] === 'string' ? args['targetFile'] : undefined);
    const sourcePaths = [...scanSources(cp).values()].flat().map((f) => f.fullpath);
    const address =
      (typeof args['address'] === 'string' && args['address'].trim()) ||
      (tpl.values['Address'] ?? '').trim() ||
      inferFlashAddress(sourcePaths) ||
      '0x00000000';
    const verify = args['verify'] !== false;
    const reset = args['reset'] !== false;
    const eraseAll = String(tpl.values['Erase All'] ?? '').trim().toLowerCase() === 'true';
    const banks = isDualCoreProject(root) ? 2 : 1;
    const plan = prepareFlash({
      buildDir: path.join(root, cp.configName),
      address,
      verify,
      reset,
      boardCfg,
      firmware: fw.file,
      eraseAll,
      banks,
    });
    // round4 P1: the receipt binds the plan that actually ran — the MCP plan
    // must fingerprint-match it EXACTLY (the verified download's parameters
    // came from extension settings this server does not read, so any
    // deviation is refused and the recorded plan is quoted for alignment)
    if (!ackGate.ack.plan) {
      throw new ToolError(
        'the flash receipt lacks a plan fingerprint (legacy receipt) — ask the user to re-run Download in the MRVC extension once with the current build so the receipt records the verified plan'
      );
    }
    const fp = fingerprintFlashPlan({
      scriptPath: plan.scriptPath,
      firmware: fw.file,
      boardCfg,
      openocdExe: openocd,
      address,
      verify,
      reset,
      eraseAll,
      banks,
      powerOn: null,
    });
    if (!samePlanFingerprint(fp, ackGate.ack.plan)) {
      const rec = ackGate.ack.plan;
      const hint =
        rec.powerOn
          ? ' The verified download used the power-off-reset rail flow (powerOn=' +
            rec.powerOn +
            '), which this tool does not replicate — ask the user to download via the extension, or run mrvc_power_off_reset separately.'
          : '';
      throw new ToolError(
        'the requested flash plan differs from the verified one — recorded plan: ' +
          describePlanFingerprint(rec) +
          '. Re-run Download in the MRVC extension with the current parameters, or pass exactly the recorded parameters (they were captured from the extension settings, which this server does not read).' +
          hint
      );
    }
    const run = await runProcess(openocd, plan.args, root, [], 300000, 192 * 1024);
    const result: Record<string, unknown> = {
      ok: run.exitCode === 0 && !run.timedOut,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      firmware: fw.file,
      address,
      boardCfg,
      verifiedBy: ackGate.ok ? ackGate.ack.time : '',
      outputTail: run.tail,
      outputTruncated: run.truncated,
    };
    if (fw.note) result['note'] = fw.note;
    if (!result['ok']) {
      result['hint'] =
        'openocd ended without success — see outputTail; common causes: no WCH-Link attached / another tool holds it, wrong board cfg, target not powered';
    }
    return result;
  },

  async mrvc_power_off_reset(args) {
    const root = toolRoot(args);
    const cp = requireCproject(root);
    // THE power gate (round5 P1) comes FIRST: a marker-verified MANUAL
    // Power-Off Reset with the SAME sequence (voltage / delay / board cfg /
    // openocd) — the flash receipt alone does not authorize rail switches.
    // checkPowerAck also reports corrupt receipts and receipts from another
    // machine (round6 P3.2/P3.3) with re-verify guidance
    const pGate = checkPowerAck(root);
    if (!pGate.ok) throw new ToolError(pGate.message);
    const pAck = pGate.ack;
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) throw new ToolError('no valid MRS install found (see mrvc_get_install_info)');
    // openocdPath mirrors the extension's mrvc.openocd.path setting (round5 P2)
    const openocd =
      typeof args['openocdPath'] === 'string' && args['openocdPath'].trim()
        ? path.resolve(args['openocdPath'].trim())
        : install.openocdExe;
    if (!fs.existsSync(openocd)) throw new ToolError(`openocd not found: ${openocd}`);
    const boardCfg = selectBoardCfgHeadless(install, root, cp, typeof args['openocdCfg'] === 'string' ? args['openocdCfg'] : undefined);
    if (!fs.existsSync(boardCfg)) throw new ToolError(`board cfg not found: ${boardCfg}`);
    const voltage: PowerVoltage = args['voltage'] === '5v' ? '5v' : '3v3';
    const delayMs = clampPowerOffDelay(typeof args['delayMs'] === 'number' ? args['delayMs'] : 100);
    const reqFp = fingerprintPowerPlan({ voltage, delayMs, boardCfg, openocdExe: openocd });
    if (!samePowerFingerprint(reqFp, pAck.plan)) {
      throw new ToolError(
        'the requested power plan differs from the verified one — recorded plan: ' +
          describePowerFingerprint(pAck.plan) +
          '. Ask the user to run Power-Off Reset in the MRVC extension with the desired parameters first.'
      );
    }
    // only WCH-LinkE / DAPLink / LinkW can switch the rail — query the link
    // model (best-effort: an unresolved model leaves the passes as ground truth)
    let fw: Awaited<ReturnType<typeof checkWCHLinkFirmware>> | undefined;
    try {
      fw = await checkWCHLinkFirmware(install);
    } catch {
      fw = undefined;
    }
    if (fw && fw.linkId !== undefined && linkSupportsPowerOutput(fw.linkId) === false) {
      throw new ToolError(`${fw.linkName ?? 'WCH-Link'} cannot switch the target power rail — only WCH-LinkE / DAPLink / LinkW can`);
    }
    const buildDir = path.join(root, cp.configName);
    for (const state of ['off', 'on'] as const) {
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        const logPath = freshLogPath(root, buildDir, state === 'off' ? 'mrvc_power_off' : 'mrvc_power_on', attempt);
        const passArgs = preparePowerPass({ boardCfg, voltage, state, logPath });
        const run = await runProcess(openocd, passArgs, root, [], 60000, 64 * 1024);
        const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
        const verdict = powerPassVerdict(state, run.exitCode ?? undefined, logText, attempt);
        if (verdict.action === 'done') {
          done = true;
        } else if (verdict.action === 'fail') {
          throw new ToolError(`power ${state} pass failed (exit ${run.exitCode}) — tail: ${run.tail.slice(-400)}`);
        }
        // retry → 500 ms backoff, next attempt (powerPassVerdict caps retries at 2)
        if (!done) await new Promise((r) => setTimeout(r, 500));
      }
      if (!done) throw new ToolError(`power ${state} pass failed after retries`);
      if (state === 'off') await new Promise((r) => setTimeout(r, delayMs));
    }
    return {
      ok: true,
      voltage,
      delayMs,
      verifiedBy: pAck.time,
      note: 'rail sequence off→delay→on completed (marker-verified)',
    };
  },
};

/** dispatch one tools/call. Unknown tool names are a protocol-level error
 *  (returned as a thrown ToolError); handler failures become tool results
 *  with isError: true carrying the message — the MCP convention for tool
 *  execution errors. Build and both hardware operations funnel through the
 *  in-server mutex (round4 P2). */
export async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const handler = handlers[name];
  if (!handler) {
    throw new ToolError(`unknown tool: ${name} (tools/list has the full set)`);
  }
  const invoke = (): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> =>
    handler(args ?? {}).then(
      (result) => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }),
      (e) => {
        const message = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }], isError: true };
      }
    );
  try {
    if (HARDWARE_TOOLS.has(name)) {
      return await serializeHardware(invoke);
    }
    return await invoke();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }], isError: true };
  }
}
