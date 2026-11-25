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
 * Scope: read + build + hardware (flash / power-off-reset), read-only static
 * analysis (preprocessor define consistency; GCC .su stack usage and
 * -fdump-rtl-expand call graphs over builds made with analysis enabled), and
 * guarded project-config WRITES (include paths / defines / optimization level
 * / linker script, configuration add/rename/delete/set-active, linked-folder
 * add/remove/list). Every write tool runs through withBackup: the touched
 * files (.cproject / .project / the <name>.wvproj marker / .template) are
 * copied into .vscode/mrvc/mcp-backup/<stamp>/ first, mutated via a fresh
 * core load, and re-parsed afterwards — a failed re-parse restores the
 * backups and raises, so no half-written state survives. The hardware tools
 * open with a HARD GATE — the
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
import { scanSources, danglingSourceEntries } from '../core/scan';
import { auditProjectConfig } from '../core/audit';
import { buildCMakeContent } from '../core/cmake';
import { buildCompileEntries, type CompileCommandEntry } from '../core/intellisense';
import { buildRecordFile } from '../core/buildLog';
import { ppDivergences } from '../core/ppConsistency';
import { readExportRecord, installFromRecord } from '../core/mcpExport';
import { parseStackUsage, parseDumpCalls, isExpandDump } from '../core/analysis';
import {
  listConfigurations,
  addConfiguration,
  renameConfiguration,
  deleteConfiguration,
  switchConfiguration,
} from '../core/configSwitch';
import { readProjectFile, addLinkedFolder, removeLinkedFolder, staleLinkedFolders, isSafeLinkName, assertSafeLinkTarget } from '../core/projectFile';
import { XElement } from '../core/xml';

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
  'mrvc_check_preprocessor',
  'mrvc_set_config_option',
  'mrvc_manage_configurations',
  'mrvc_list_linked_folders',
  'mrvc_add_linked_folder',
  'mrvc_remove_linked_folder',
  'mrvc_build',
  'mrvc_stack_usage',
  'mrvc_call_analysis',
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
        'Resolve the MounRiver Studio installation MRVC would use (explicit path > MRVC_MRS_INSTALL_PATH > conventional C:/D: locations > the install paths recorded when this server was exported) and report its generation, toolchains and make/openocd paths. Read-only.',
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
      name: 'mrvc_check_preprocessor',
      description:
        'Check the three preprocessor define lists (C / C++ / assembler) of the ACTIVE configuration for the same macro being defined with DIFFERENT values in different lists — the silent-bug class where one toolchain sees FOO=1 and another sees FOO=0. Read-only; reports, never repairs.',
      inputSchema: {
        type: 'object',
        properties: { root: { type: 'string', description: PROJECT_ROOT_DESC } },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_set_config_option',
      description:
        'Write ONE class of build-configuration fields: include paths, preprocessor defines, the optimization level or the linker script. ' +
        'List fields take the FULL replacement list (read mrvc_get_project_config first and write back everything you want to keep — an empty list clears). ' +
        'Absolute paths inside the project (and bare relative entries) are stored in the MRS "${workspace_loc:/${ProjName}/rel}" spelling; values that already start with "$" pass through untouched. ' +
        'C and C++ twins are written together by default (language "both") so the two languages cannot drift — pass language "c" / "cpp" (or "asm" for includePaths) to target one. ' +
        'Every write is guarded: the touched files are copied to .vscode/mrvc/mcp-backup/<stamp>/ first and re-parsed after — a failed parse restores the originals.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          field: { type: 'string', enum: ['includePaths', 'defines', 'optimizationLevel', 'linkerScript'], description: 'Which field class to write.' },
          value: {
            description:
              'includePaths / defines / linkerScript: the FULL replacement list of strings (defines are raw macros like DEBUG=1, no quoting). optimizationLevel: one of size (-Os), none (-O0), optimize (-O1), more (-O2), most (-O3), fast (-Ofast), debug (-Og), z (-Oz).',
          },
          configIndex: { type: 'number', description: 'Configuration row to write (0 = the ACTIVE configuration, the .cproject array position). Default 0.' },
          language: { type: 'string', enum: ['both', 'c', 'cpp', 'asm'], description: 'Which language twin(s) to write (default both; "asm" applies to includePaths only).' },
        },
        required: ['root', 'field', 'value'],
      },
    },
    {
      name: 'mrvc_manage_configurations',
      description:
        'Manage the build configurations of a project (the .cproject <cconfiguration> list; index 0 is the ACTIVE one): list, add, rename, delete, or setActive. ' +
        'add deep-copies an existing configuration under the new name (MRS add-dialog semantics: copyFrom, default the active one; copyFromIndex picks the source row when names are shared). ' +
        'Renaming the ACTIVE configuration also rewrites the .template Target Path; deleting the ACTIVE configuration is refused (setActive another one first) and at least one must remain. ' +
        'setActive moves the chosen configuration to index 0 (MRS Save semantics: A,B,C + set C -> C,A,B), rewrites the .template Target Path and reorders the marker snapshot; a no-op when already active. ' +
        'Duplicate names are refused — on Windows case-insensitively, because the name IS the output directory. ' +
        'Every mutation is guarded: .cproject / .project / the <name>.wvproj marker / .template are backed up first and re-parsed after — a failed parse restores all of them.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          action: { type: 'string', enum: ['list', 'add', 'rename', 'delete', 'setActive'], description: 'list returns the names (active first). add/rename/delete/setActive mutate.' },
          name: { type: 'string', description: 'add: the NEW name. rename: the existing name. delete: the name to remove. setActive: the configuration to make active.' },
          newName: { type: 'string', description: 'rename: the replacement name.' },
          copyFrom: { type: 'string', description: 'add: source configuration name (default: the active one).' },
          copyFromIndex: { type: 'number', description: 'add: source ROW index — disambiguates two same-named configurations carrying different option sets.' },
          index: { type: 'number', description: 'rename/delete/setActive: ROW index of "name" when more than one configuration shares it.' },
        },
        required: ['root', 'action'],
      },
    },
    {
      name: 'mrvc_list_linked_folders',
      description:
        'List the project\u2019s linked folders (.project linkedResources): link name, raw locationURI (PARENT-N-PROJECT_LOC macro form), resolved absolute path and whether the target directory currently exists on disk. STRICTLY read-only — no auto-repair of stale links, no writes.',
      inputSchema: {
        type: 'object',
        properties: { root: { type: 'string', description: PROJECT_ROOT_DESC } },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_add_linked_folder',
      description:
        'Add a linked folder and wire it into the build exactly like the extension\u2019s Add command: "name" is the project-tree display name, "location" an ABSOLUTE path to an EXISTING directory (inside or outside the project; outside targets are stored in the PARENT-N-PROJECT_LOC macro form, so the project stays portable). ' +
        'The .cproject gets the include-path entries (C + assembler), the link is excluded from the root source scan and a named sourceEntry is created. Refuses duplicate link names, relative paths and names with \\ / : * ? " < > |. Guarded write (.project + .cproject backed up, re-parsed after).',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          name: {
            type: 'string',
            minLength: 1,
            pattern: '^(?!.*[. ]$)[^\\\\/:*?"<>|\\x00-\\x1f]+$',
            description:
              'Link name shown in the project tree — the same safe-name rule as the extension\u2019s Add command: a single safe directory segment, no \\ / : * ? " < > | or control characters, no "."/"..", no trailing dot/space, no Windows reserved device names (CON.txt counts too), unique case-insensitively.',
          },
          location: { type: 'string', description: 'ABSOLUTE path of an existing directory to link.' },
        },
        required: ['root', 'name', 'location'],
      },
    },
    {
      name: 'mrvc_remove_linked_folder',
      description:
        'Remove a linked folder by its link name and clean the .cproject references the same way the extension\u2019s Remove command does (include-path entries, the named sourceEntry, the root-scan excluding token) — removing one that compiled sources still reference changes what gets built, so check mrvc_get_project_config / mrvc_audit_project afterwards. Unknown names are refused. Guarded write (whole transaction rolls back on failure).',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          name: { type: 'string', description: 'Link name to remove (see mrvc_list_linked_folders).' },
        },
        required: ['root', 'name'],
      },
    },
    {
      name: 'mrvc_build',
      description:
        'Build, clean or rebuild one MRS project headlessly. Build/rebuild regenerate the CDT-style makefiles from .cproject (byte-identical to the extension) and run the MRS-bundled make; clean runs make clean on the EXISTING makefile and is a deterministic no-op on a never-built project (extension parity — no regeneration, no toolchain needed). Rebuild = clean with the old makefile first (a failed clean aborts before building), then regenerate and build. Returns the exit code, the output tail and the produced artifact sizes. With configs:"all" it orchestrates every configuration listed in .cproject (index 0 is the active one): build = build each, first failure aborts; clean = clean each built configuration, failures do not stop; rebuild = the MRS ReBuild-All sequence (clean phase, then build each, first failure aborts). No download — hardware operations are not exposed.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          target: { type: 'string', enum: ['build', 'clean', 'rebuild'], description: 'Default build. rebuild = clean first, then build.' },
          configs: { type: 'string', enum: ['active', 'all'], description: 'Default active — the active configuration only. all — every configuration in .cproject (per-config model, toolchain and target follow each configuration).' },
          analysis: { type: 'boolean', description: 'Generate makefiles with GCC analysis instrumentation (-fstack-usage and -fdump-rtl-expand), enabling mrvc_stack_usage / mrvc_call_analysis on the build output (default false).' },
          jobs: { type: 'number', description: 'Parallel make jobs (default 8).' },
          timeoutSec: { type: 'number', description: 'Hard timeout per make invocation in seconds (default 600 / MRVC_MCP_BUILD_TIMEOUT_SEC, clamped 5–3600). A timed-out run reports ok:false with timedOut:true.' },
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_stack_usage',
      description:
        'Read the static stack-usage report of the ACTIVE configuration\u2019s build directory: per-function stack sizes from GCC .su files (a build with analysis:true is required to produce them). Returns the total own-size sum, dynamic-frame functions, and the top functions by stack size. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          limit: { type: 'number', description: 'How many top functions to return (default 50, clamped 1–2000).' },
        },
        required: ['root'],
      },
    },
    {
      name: 'mrvc_call_analysis',
      description:
        'Read the function-call graph of the ACTIVE configuration\u2019s build directory from GCC -fdump-rtl-expand dumps (a build with analysis:true is required to produce them). Returns caller→callee edges. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          limit: { type: 'number', description: 'How many edges to return (default 200, clamped 1–20000).' },
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
  // repairProject:false — this load runs on EVERY tool (read-only ones
  // included) and must never auto-repair stale links as a side effect
  // (round14 P3.1: the default repair path rewrote .project on first open)
  const cp = Cproject.load(abs, { repairProject: false });
  // note: configuration names compose on-disk paths (output dir / flash
  // script / power logs) — Cproject.load itself REFUSES traversal shapes
  // ("unsafe configuration name"), so a poisoned .cproject cannot steer
  // these writes outside the project tree
  return cp;
}

/** round15 P2.1: with auto-repair off (round14 P3.1), scanSources silently
 *  SKIPS linked folders whose target does not exist — a copied EVT project
 *  would build/export/generate a compile database WITHOUT entire linked
 *  source trees (SRC/Startup, StdPeriphDriver, …) and still look successful.
 *  build/rebuild and the two export tools therefore refuse up-front and
 *  spell out the would-be repair; the fix itself stays with the extension's
 *  first-open auto-repair (the MCP layer never writes project files).
 *  `clean` is not gated — it never scans sources. */
function requireLinkedTargets(root: string): void {
  const stale = staleLinkedFolders(root);
  if (!stale.length) return;
  const detail = stale
    .map((s) => `"${s.name}" -> ${s.locationUri}${s.suggestedFix ? ` (repairable to ${s.suggestedFix})` : ''}`)
    .join('; ');
  throw new ToolError(
    `stale linked folder(s) — their targets do not exist on disk, so a build/scan would silently skip them: ${detail}. ` +
      'Open the project once in the MRVC extension (its first-open pass repairs stale links automatically), then retry.'
  );
}

/** explicit argument > MRVC_MRS_INSTALL_PATH > conventional locations > the
 *  locations recorded in an EXPORTED copy's marker (the headless copy cannot
 *  read VS Code settings, so Export AI MCP Server stamps them into the marker —
 *  only reached when nothing was named explicitly: an explicit path is
 *  validated STRICTLY and never silently redirected — locateInstall would
 *  fall back to a conventional install when the requested path fails, and an
 *  AI that named a path must get a structured error instead). */
function resolveInstall(explicit?: string): MrsInstall | null {
  const requested = explicit?.trim() || process.env['MRVC_MRS_INSTALL_PATH']?.trim() || '';
  const install = locateInstall(requested || undefined);
  if (!install) {
    if (!requested) {
      const rec = readExportRecord(__dirname);
      if (rec) {
        const fromRecord = installFromRecord(rec);
        if (fromRecord) return fromRecord;
      }
    }
    return null;
  }
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
    // duplicate names share ONE output directory (name = dir): a client must
    // not expect one artifact folder per configuration entry (0.3.7)
    duplicateConfigurations: cp.duplicateConfigurationNames,
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

/** containment guard for configuration names composing on-disk paths: the
 *  Cproject loader already refuses traversal shapes ("unsafe configuration
 *  name"), but the all-configs loop composes paths from per-config data —
 *  prove every join stays inside the project root before touching disk. */
function containedJoin(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments);
  const r = path.resolve(root);
  if (target !== r && !target.startsWith(r + path.sep)) {
    throw new ToolError(`configuration path escapes the project root: ${segments.join('/')}`);
  }
  return target;
}

/** the produced artifacts of one configuration, by its own artifact type —
 *  static-library projects archive .a (0.3.2), exe projects link elf/hex/bin.
 *  The artifact name is project data too — same containment proof. */
function productsFor(cp: Cproject, buildDir: string): Array<{ file: string; size: number | null }> {
  const dir = path.resolve(buildDir);
  const exts = cp.artifactType === 'staticLib' ? ['a'] : ['elf', 'hex', 'bin'];
  return exts.map((ext) => {
    const f = path.resolve(dir, `${cp.targetName}.${ext}`);
    if (f !== dir && !f.startsWith(dir + path.sep)) throw new ToolError(`artifact path escapes the build directory: ${cp.targetName}.${ext}`);
    return { file: f, size: fs.existsSync(f) ? fs.statSync(f).size : null };
  });
}

/** read every file matching `test` under buildDir (recursive). Files that
 *  vanish between readdir and read are skipped — a parallel Clean may be
 *  eating the tree (the same tolerance the extension's report viewer uses). */
function collectAnalysisFiles(buildDir: string, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (test(e.name)) {
        try {
          out.push(fs.readFileSync(p, 'utf-8'));
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(buildDir);
  return out;
}

/** the configs:"all" orchestration — the headless shape of the extension's
 *  ReBuild-All / Clean-All flows (vscode/tasks.ts), minus everything VSCode:
 *  no tasks, no tree refresh, no build record (round6 P3: MCP build logs
 *  live in the return value only). MRS semantics kept:
 *  - clean: skip never-built configurations, failures do NOT stop the run
 *  - rebuild: clean phase stops at the first configuration without a
 *    makefile (and on a failed clean), then the build phase always runs
 *  - build: every configuration, first failure aborts the rest
 *  Per-configuration model: index 0 is the ACTIVE configuration; options /
 *  target name / toolchain follow each configuration (Cproject.loadConfigAt),
 *  the exclusion table still comes from the active one. */
async function buildAllConfigs(opts: {
  root: string;
  cp: Cproject;
  target: 'build' | 'clean' | 'rebuild';
  jobs: number;
  analysis: boolean;
  install: MrsInstall;
  timeoutSec: number;
}): Promise<Record<string, unknown>> {
  const { root, cp, target, jobs, analysis, install, timeoutSec } = opts;
  const names = cp.configurationNames;
  if (!names.length) {
    throw new ToolError('.cproject: no <cconfiguration> found');
  }
  const configs: Array<Record<string, unknown>> = [];
  const tailCap = 4000;
  const pushRun = (name: string, kind: 'clean' | 'build', run: Awaited<ReturnType<typeof runProcess>>, extra: Record<string, unknown> = {}): void => {
    configs.push({
      config: name,
      phase: kind,
      ok: run.exitCode === 0 && !run.timedOut,
      exitCode: run.exitCode,
      ...(run.timedOut ? { timedOut: true } : {}),
      ...extra,
      outputTail: run.tail.length > tailCap ? '…' + run.tail.slice(-tailCap) : run.tail,
    });
  };

  if (target === 'clean') {
    if (!names.some((n) => fs.existsSync(containedJoin(root, n, 'makefile')))) {
      return { ok: true, mode: 'all', target, configCount: names.length, configs: [], note: 'no configuration has been built yet — nothing to clean' };
    }
    const makeExe = requireMake(install);
    for (const name of names) {
      const dir = containedJoin(root, name);
      if (!fs.existsSync(containedJoin(dir, 'makefile'))) {
        configs.push({ config: name, phase: 'clean', skipped: true, note: 'never built (no makefile)' });
        continue;
      }
      const run = await runProcess(makeExe, ['clean'], dir, [install.makeBin], timeoutSec * 1000, 96 * 1024);
      pushRun(name, 'clean', run);
    }
    return { ok: configs.every((c) => c['ok'] !== false), mode: 'all', target, configCount: names.length, configs };
  }

  // build / rebuild: make is always needed
  const makeExe = requireMake(install);
  if (target === 'rebuild') {
    // MRS: the first configuration without a makefile ends the clean phase —
    // later ones may never have been built; the build phase regenerates all
    for (const name of names) {
      const dir = containedJoin(root, name);
      if (!fs.existsSync(containedJoin(dir, 'makefile'))) break;
      const run = await runProcess(makeExe, ['clean'], dir, [install.makeBin], timeoutSec * 1000, 96 * 1024);
      pushRun(name, 'clean', run);
      if (run.exitCode !== 0 || run.timedOut) break; // build phase still runs
    }
  }
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    let cpConfig: Cproject;
    let tc: ToolchainInfo;
    let generatedFiles = 0;
    try {
      cpConfig = Cproject.loadConfigAt(root, i, { repairProject: false });
      const selected = selectProjectToolchain(install, cpConfig);
      if (!selected) throw new Error(`no usable RISC-V toolchain for rvGcc ${cpConfig.rvGccVersion || '(default)'}`);
      tc = selected;
      generatedFiles = generateMakefiles(cpConfig, tc, { analysis }).files.length;
    } catch (e) {
      throw new ToolError(`configuration [${name}]: ${e instanceof Error ? e.message : String(e)}`);
    }
    const buildDir = containedJoin(root, cpConfig.configName);
    const run = await runProcess(makeExe, [`-j${jobs}`, 'all'], buildDir, [path.join(tc.dir, 'bin'), install.makeBin], timeoutSec * 1000, 192 * 1024);
    const ok = run.exitCode === 0 && !run.timedOut;
    configs.push({
      config: name,
      phase: 'build',
      ok,
      exitCode: run.exitCode,
      ...(run.timedOut ? { timedOut: true } : {}),
      toolchain: tc.name,
      generatedMakefiles: generatedFiles,
      ...(ok ? { products: productsFor(cpConfig, buildDir) } : {}),
      outputTail: run.tail.length > tailCap ? '…' + run.tail.slice(-tailCap) : run.tail,
    });
    if (!ok) {
      return {
        ok: false,
        mode: 'all',
        target,
        configCount: names.length,
        abortedAt: name,
        configs,
        note: 'first build failure aborts the remaining configurations (MRS semantics)',
      };
    }
  }
  return { ok: true, mode: 'all', target, configCount: names.length, configs };
}

// ------------------------------------------------- config-write helpers --

/** the enumerated id MRS stores for the optimization level choice — the tool
 *  takes the MRS last-segment spellings and composes this prefix on write,
 *  exactly the composition the extension's Apply posts (configView enumBase) */
const OPT_LEVEL_ID = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.optimization.level.';
const OPT_LEVELS = ['size', 'none', 'optimize', 'more', 'most', 'fast', 'debug', 'z'] as const;

/** field class → per-language option suffix (suffixIndex key, i.e. WITHOUT
 *  the ilg.gnumcueclipse…option. base). c/cpp twins are written together by
 *  default; the assembler include paths have no twin. */
const CONFIG_FIELD_SUFFIXES: Record<string, { c?: string; cpp?: string; asm?: string; paths: boolean }> = {
  includePaths: { c: 'c.compiler.include.paths', cpp: 'cpp.compiler.include.paths', asm: 'assembler.include.paths', paths: true },
  defines: { c: 'c.compiler.defs', cpp: 'cpp.compiler.defs', paths: false },
  linkerScript: { c: 'c.linker.scriptfile', cpp: 'cpp.linker.scriptfile', paths: true },
};

/**
 * MRS storage spelling for path-ish list entries: a path inside the project
 * (absolute, or bare relative) becomes "${workspace_loc:/${ProjName}/rel}"
 * — the literal ${ProjName} macro, exactly the shape MRS2's dialogs write
 * (configView mok; EVT evidence). Values that already start with "$" and
 * outside-project absolutes pass through untouched.
 */
function normalizeStoredPath(root: string, value: string): string {
  const v = value.trim();
  if (!v || v.startsWith('$')) return v;
  const abs = path.resolve(root, v);
  const rootF = foldPathOnPlatform(root);
  const absF = foldPathOnPlatform(abs);
  if (absF === rootF) return '${workspace_loc:/${ProjName}}';
  if (absF.startsWith(rootF + path.sep)) {
    return '${workspace_loc:/${ProjName}/' + abs.slice(root.length + 1).replace(/\\/g, '/') + '}';
  }
  return v;
}

/** files a config-write tool may touch, those present on disk. The project
 *  marker carries the project's OWN name (<name>.wvproj — the three-file
 *  contract), not a literal ".wvproj": find it the way the configuration
 *  manager does. .template joins when present — an active rename / set-active
 *  rewrites its Target Path, so it must be inside the same transaction. */
function projectWriteTargets(root: string): string[] {
  const names = ['.cproject', '.project'];
  try {
    const marker = fs.readdirSync(root).find((n) => n.toLowerCase().endsWith('.wvproj'));
    if (marker) names.push(marker);
  } catch {
    // unreadable root: requireCproject would already have failed before us
  }
  if (fs.existsSync(path.join(root, '.template'))) names.push('.template');
  return names;
}

/** the write guard's post-check: every touched file must still parse */
function reparseWritten(root: string, basename: string, backupFile: string): void {
  if (basename === '.cproject') {
    Cproject.load(root);
  } else if (basename === '.project') {
    readProjectFile(root, { repair: false });
  } else if (basename === '.template') {
    readTemplate(root);
  } else {
    // the <name>.wvproj marker: the configuration manager rewrites it ONLY as
    // a snapshot row (a readWv failure means no write at all — core contract
    // "MRS2 never reads it"). A file the mutation did not touch (an XML
    // stand-in or a marker that never parsed) passes through untouched;
    // anything REWRITTEN must parse.
    const now = fs.readFileSync(path.join(root, basename));
    const was = fs.readFileSync(backupFile);
    if (!now.equals(was)) JSON.parse(now.toString('utf-8'));
  }
}

/**
 * The guarded-write shell every config / linked-folder tool runs through:
 *  1. copy every file about to be touched into .vscode/mrvc/mcp-backup/<stamp>/
 *  2. run the mutation — each core call does its own FRESH load → edit → save
 *     (no stale in-memory model can overwrite an external edit)
 *  3. re-parse every written file; a parse failure restores all backups and
 *     re-raises, so the project is never left half-written
 */
function withBackup(root: string, mutate: () => Record<string, unknown>): Record<string, unknown> {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + String(process.pid % 10000).padStart(4, '0');
  const backupDir = path.join(root, '.vscode', 'mrvc', 'mcp-backup', stamp);
  const targets = projectWriteTargets(root);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const b of targets) fs.copyFileSync(path.join(root, b), path.join(backupDir, b));
  try {
    const result = mutate();
    for (const b of targets) reparseWritten(root, b, path.join(backupDir, b));
    return { ...result, backupDir, backedUp: targets };
  } catch (e) {
    for (const b of targets) fs.copyFileSync(path.join(backupDir, b), path.join(root, b));
    throw e;
  }
}

/** configIndex bound-checked against the live configuration list. Absent
 *  means "the active configuration"; anything PRESENT but invalid is an
 *  error — a write tool must not silently guess (round13 P3.1). */
function configIndexOrThrow(root: string, raw: unknown): { index: number; names: string[] } {
  const names = listConfigurations(root);
  if (raw === undefined || raw === null) return { index: 0, names };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new ToolError(`configIndex must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  if (raw >= names.length) {
    throw new ToolError(`configIndex ${raw} out of range — the project has ${names.length} configuration(s): ${names.join(', ')}`);
  }
  return { index: raw, names };
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
        // repairProject:false — the scan is read-only (round14 P3.1)
        return summarizeProject(abs, Cproject.load(abs, { repairProject: false }));
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
    // dangling named source entries are HINTS, not refusals (user ruling
    // 2026-11-25: MRS compiles the EVT V1_2 BLE projects whose shipped
    // .cproject carries a leftover dangling `Profile` entry) — build/export
    // proceed at MRS parity and the note lists what was skipped
    const dangling = danglingSourceEntries(cp);
    if (dangling.length) {
      summary['danglingSourceEntries'] = dangling.map(
        (d) => `${d.name} -> ${d.dir} (no resolvable directory — skipped at MRS parity, not an error)`
      );
    }
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (install) {
      const tc = selectProjectToolchain(install, cp);
      if (tc) {
        summary['toolchain'] = { name: tc.name, installLabel: install.label, compiler: tc.compilerC };
        try {
          const entries = buildCompileEntries(cp, tc);
          summary['compileEntryCount'] = entries.length;
          summary['sampleCommand'] = entries.length ? entries[0].arguments.join(' ') : '';
        } catch (e) {
          // round18: the stale-link gate refuses scanning — the READ tool still
          // returns its summary (the AI must be able to SEE the project to
          // diagnose it), carrying the refusal as a note instead of failing
          summary['sampleCommand'] = null;
          summary['scanNote'] = e instanceof Error ? e.message : String(e);
        }
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
    const target = args['target'] === 'clean' ? 'clean' : args['target'] === 'rebuild' ? 'rebuild' : 'build';
    if (target !== 'clean') requireLinkedTargets(root); // stale links must not silently shrink the source set
    const all = args['configs'] === 'all';
    const jobs = typeof args['jobs'] === 'number' && args['jobs'] > 0 ? Math.floor(args['jobs']) : 8;
    const analysis = args['analysis'] === true;
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) {
      throw new ToolError('no valid MRS install found — pass mrsInstallPath, set MRVC_MRS_INSTALL_PATH, or install MRS at a conventional location');
    }
    const timeoutSec = buildTimeoutSec(args['timeoutSec']);
    if (all) {
      return buildAllConfigs({ root, cp, target, jobs, analysis, install, timeoutSec });
    }
    // ---- active configuration, extension-parity semantics (review F1–F5) ----
    // cleanOne: no makefile → deterministic no-op WITHOUT make or toolchain;
    // rebuild: clean with the OLD makefile FIRST, a failed clean ABORTS
    // (rebuildOne), then makefiles regenerate and the build runs — the same
    // ordering as the extension, so a changed source list really cleans the
    // old objects; build: generate + make. The toolchain is a build-phase
    // requirement only (a clean never needs it).
    const cwd = containedJoin(root, cp.configName);
    const hasMakefile = fs.existsSync(containedJoin(cwd, 'makefile'));
    const timeoutMs = timeoutSec * 1000;
    const makeOnly = (): string[] => [install.makeBin];
    const runClean = () => runProcess(requireMake(install), ['clean'], cwd, makeOnly(), timeoutMs, 96 * 1024);
    if (target === 'clean') {
      if (!hasMakefile) {
        return { ok: true, target, config: cp.configName, skipped: true, note: 'no makefile — nothing to clean (never built)' };
      }
      const run = await runClean();
      return {
        ok: run.exitCode === 0 && !run.timedOut,
        target,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        config: cp.configName,
        outputTail: run.tail,
        outputTruncated: run.truncated,
        note: 'MCP build log is returned here only; it is not written to the extension build record',
      };
    }
    let cleanRun: Awaited<ReturnType<typeof runProcess>> | undefined;
    if (target === 'rebuild' && hasMakefile) {
      cleanRun = await runClean();
      if (cleanRun.exitCode !== 0 || cleanRun.timedOut) {
        // the extension's rebuildOne aborts on a failed clean — carry its
        // tail so the failure is diagnosable (review F4)
        return {
          ok: false,
          target,
          phase: 'clean',
          config: cp.configName,
          exitCode: cleanRun.exitCode,
          timedOut: cleanRun.timedOut,
          outputTail: cleanRun.tail,
          outputTruncated: cleanRun.truncated,
          note: 'clean failed — rebuild aborted before the build phase (extension semantics)',
        };
      }
    }
    const tc = requireToolchain(install, cp);
    const makeExe = requireMake(install);
    const gen = generateMakefiles(cp, tc, { analysis });
    const buildRun = await runProcess(makeExe, [`-j${jobs}`, 'all'], cwd, [path.join(tc.dir, 'bin'), install.makeBin], timeoutMs, 192 * 1024);
    const result: Record<string, unknown> = {
      ok: buildRun.exitCode === 0 && !buildRun.timedOut,
      target,
      exitCode: buildRun.exitCode,
      timedOut: buildRun.timedOut,
      config: cp.configName,
      toolchain: tc.name,
      generatedMakefiles: gen.files.length,
      sources: gen.sourceCount,
      outputTail: buildRun.tail,
      outputTruncated: buildRun.truncated,
      ...(cleanRun ? { cleanExitCode: cleanRun.exitCode } : {}),
      ...(target === 'rebuild' && !hasMakefile ? { cleanSkipped: true } : {}),
      // round6 P3.1: the MCP build does NOT write the extension's build
      // record (the record feeds the download-target resolution and carries
      // the full instruction list that only the extension pipeline captures)
      // — this build's log lives ONLY in outputTail/output here
      note: 'MCP build log is returned here only; it is not written to the extension build record',
    };
    result['products'] = productsFor(cp, cwd);
    return result;
  },

  async mrvc_check_preprocessor(args) {
    const cp = requireCproject(path.resolve(String(args['root']).trim()));
    const divergences = ppDivergences(cp).map((d) => ({
      name: d.name,
      occurrences: d.occurrences.map((o) => ({ tool: o.tool, stored: o.raw, value: o.value })),
    }));
    return {
      ok: divergences.length === 0,
      divergenceCount: divergences.length,
      lists: ['c.compiler.defs', 'cpp.compiler.defs', 'assembler.defs'],
      divergences,
      note:
        divergences.length === 0
          ? 'all three preprocessor define lists agree'
          : 'the same macro is defined with different values in different preprocessor lists — align them in the extension properties page',
    };
  },

  async mrvc_set_config_option(args) {
    const root = path.resolve(String(args['root']).trim());
    requireCproject(root); // three-file contract first
    const field = String(args['field'] ?? '');
    const { index, names } = configIndexOrThrow(root, args['configIndex']);
    const language = typeof args['language'] === 'string' && args['language'] ? args['language'] : 'both';
    // an unknown language value must not fall through to the both-twins write
    // (it would touch two lists the caller never asked for — round13 P3.1)
    if (!['both', 'c', 'cpp', 'asm'].includes(language)) {
      throw new ToolError(`unknown language "${language}" — valid: both, c, cpp, asm`);
    }

    // ---- optimization level: enumerated, same id composition as Apply ----
    if (field === 'optimizationLevel') {
      if (language !== 'both') throw new ToolError('the optimization level has no language twins — drop "language"');
      const level = typeof args['value'] === 'string' ? args['value'].trim() : '';
      if (!(OPT_LEVELS as readonly string[]).includes(level)) {
        throw new ToolError(
          `unknown optimization level "${level}" — valid: ${OPT_LEVELS.join(', ')} ` +
            '(size=-Os, none=-O0, optimize=-O1, more=-O2, most=-O3, fast=-Ofast, debug=-Og, z=-Oz)'
        );
      }
      const before = Cproject.loadConfigAt(root, index, { repairProject: false }).optimizationLevel;
      const written = withBackup(root, () => {
        const cp = Cproject.loadConfigAt(root, index, { repairProject: false });
        cp.setOptionValue('optimization.level', OPT_LEVEL_ID + level);
        cp.save();
        return {};
      });
      return { ok: true, field, config: names[index], before, after: level, ...written };
    }

    // ---- list fields ----
    const def = CONFIG_FIELD_SUFFIXES[field];
    if (!def) {
      throw new ToolError(`unknown field "${field}" — valid: ${Object.keys(CONFIG_FIELD_SUFFIXES).join(', ')}, optimizationLevel`);
    }
    if (language === 'asm' && field !== 'includePaths') {
      throw new ToolError('language "asm" applies to includePaths only');
    }
    const langs: Array<'c' | 'cpp' | 'asm'> = language === 'c' ? ['c'] : language === 'cpp' ? ['cpp'] : language === 'asm' ? ['asm'] : ['c', 'cpp'];
    const targets = langs.map((l) => ({ lang: l, suffix: def[l as 'c' | 'cpp' | 'asm'] })).filter((t) => t.suffix);
    if (!targets.length) {
      throw new ToolError(`field "${field}" has no ${language} option to write`);
    }
    const raw = args['value'];
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
      throw new ToolError(`value must be an array of strings for "${field}" (an empty array clears the list)`);
    }
    // the extension's list round-trip: getters strip ONE surrounding quote
    // pair, setters trim and drop empties — mirror that so what
    // mrvc_get_project_config shows is exactly what a write-back stores
    const cleaned = (raw as string[]).map((v) => v.replace(/^"(.*)"$/, '$1').trim()).filter((v) => v);
    const values = def.paths ? cleaned.map((v) => normalizeStoredPath(root, v)) : cleaned;
    const beforeModel = Cproject.loadConfigAt(root, index, { repairProject: false });
    const before: Record<string, string[]> = {};
    for (const t of targets) before[t.lang] = beforeModel.listOption(t.suffix!).values;
    const written = withBackup(root, () => {
      const cp = Cproject.loadConfigAt(root, index, { repairProject: false });
      for (const t of targets) cp.setOptionList(t.suffix!, values);
      cp.save();
      return {};
    });
    return { ok: true, field, config: names[index], language, before, after: values, ...written };
  },

  async mrvc_manage_configurations(args) {
    const root = path.resolve(String(args['root']).trim());
    requireCproject(root); // three-file contract first
    const action = String(args['action'] ?? '');
    const strArg = (k: string): string | undefined => {
      const v = args[k];
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const intArg = (k: string): number | undefined => {
      const v = args[k];
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
    };
    if (action === 'list') {
      const list = listConfigurations(root);
      return { ok: true, action, names: list, active: list[0] ?? null };
    }
    if (action !== 'add' && action !== 'rename' && action !== 'delete' && action !== 'setActive') {
      throw new ToolError(`unknown action "${action}" — valid: list, add, rename, delete, setActive`);
    }
    // the mutation runs INSIDE the guard: backup first, mutate, re-parse
    return withBackup(root, () => {
      let outcome: Record<string, unknown>;
      if (action === 'add') {
        const name = strArg('name');
        if (!name) throw new ToolError('add needs "name" — the new configuration name');
        outcome = { action, ...addConfiguration(root, name, strArg('copyFrom'), intArg('copyFromIndex')) };
      } else if (action === 'rename') {
        const name = strArg('name');
        const newName = strArg('newName');
        if (!name || !newName) throw new ToolError('rename needs "name" (existing) and "newName"');
        outcome = { action, ...renameConfiguration(root, name, newName, intArg('index')) };
      } else if (action === 'delete') {
        const name = strArg('name');
        if (!name) throw new ToolError('delete needs "name"');
        outcome = { action, ...deleteConfiguration(root, name, intArg('index')) };
      } else {
        // setActive: MRS 保存 semantics — the chosen block MOVES to index 0
        // (C,A,B order, never a swap), the .template Target Path follows and
        // the marker snapshot reorders with it; a no-op when already active
        const name = strArg('name');
        if (!name) throw new ToolError('setActive needs "name" — the configuration to make active');
        outcome = { action, ...switchConfiguration(root, name, intArg('index')) };
      }
      return { ok: true, ...outcome };
    });
  },

  async mrvc_list_linked_folders(args) {
    const root = path.resolve(String(args['root']).trim());
    requireCproject(root); // three-file contract first
    // STRICT read: repair:false keeps readProjectFile from rewriting stale
    // absolute links on our behalf (round13 P3.3 — a read-only tool must not
    // mutate the project, not even the auto-repair the extension does on
    // first open)
    const folders = readProjectFile(root, { repair: false }).linkedResources.map((l) => ({
      name: l.name,
      type: l.type,
      locationUri: l.locationUri,
      location: l.location,
      exists: fs.existsSync(l.location) && fs.statSync(l.location).isDirectory(),
    }));
    return { ok: true, count: folders.length, folders };
  },

  async mrvc_add_linked_folder(args) {
    const root = path.resolve(String(args['root']).trim());
    requireCproject(root);
    const name = typeof args['name'] === 'string' ? args['name'].trim() : '';
    const rawName = typeof args['name'] === 'string' ? args['name'] : '';
    if (!name) throw new ToolError('name is required — the link name shown in the project tree');
    // the FULL core safe-name rule (round21 P3-2): separators/controls,
    // dot-only names, trailing dot/space and Windows device names — the old
    // charset pre-check was a subset and the real refusal surfaced only
    // inside the backup transaction
    if (!isSafeLinkName(name)) {
      throw new ToolError(
        `link name "${name}" is not safe — a link name must be a single safe directory segment (no separators, control characters, "."/"..", trailing dot/space, or Windows reserved device names)`
      );
    }
    // the raw value must carry no trailing/leading dot/space either: a
    // silent trim would write a different name than the caller sent
    // (round23 P3-3 — "Trail " used to be accepted as "Trail")
    if (rawName !== name) {
      throw new ToolError(`link name must not have leading/trailing spaces ("${rawName}")`);
    }
    const location = typeof args['location'] === 'string' ? args['location'].trim() : '';
    if (!location) throw new ToolError('location is required — an absolute path to an existing directory');
    if (!path.isAbsolute(location)) {
      // a relative path would silently resolve against the SERVER working
      // directory — refuse instead of linking something the caller never
      // meant (round13 P3.3)
      throw new ToolError(`location must be an ABSOLUTE path (got "${location}")`);
    }
    const abs = path.resolve(location);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new ToolError(`location is not an existing directory: ${abs}`);
    }
    // linking the project root (or an ancestor containing it) re-scans the
    // whole tree under the link name — refuse BEFORE any backup (round21 P2-2)
    assertSafeLinkTarget(root, abs);
    // crisp duplicate error BEFORE any backup is taken (addLinkedFolder throws
    // the same refusal, but only after its own fresh .project parse).
    // Case-folded on win32: "Foo" and "foo" are one physical directory, and
    // two links over it race their object files (round21 P2-1)
    const foldN = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const present = readProjectFile(root, { repair: false }).linkedResources;
    const existing = present.find((l) => foldN(l.name) === foldN(name));
    if (existing) {
      throw new ToolError(`a linked folder named "${name}" already exists as "${existing.name}" (${existing.locationUri})`);
    }
    const added = withBackup(root, () => {
      // addLinkedFolder composes the PARENT-N-PROJECT_LOC form itself (.project);
      // the .cproject integration below is the SAME set of updates the
      // extension's Add command makes (linkedFolders.ts): include paths for C
      // and the assembler, the link excluded from the root scan, and a named
      // sourceEntry — otherwise the linked headers would not resolve and the
      // build semantics would differ from the extension (round13 P2.2)
      const r = addLinkedFolder(root, name, abs);
      const cp = Cproject.load(root, { repairProject: false });
      const logic = '${workspace_loc:/${ProjName}/' + name + '}';
      cp.addToListOption('c.compiler.include.paths', logic);
      cp.addToListOption('assembler.include.paths', logic);
      const entries = cp.sourceEntries;
      const rootEntry = entries.find((e) => e.name === '');
      if (rootEntry) {
        const excluding = new Set(rootEntry.excluding);
        excluding.add(name);
        rootEntry.element.setAttr('excluding', [...excluding].join('|'));
      }
      const sourceEntriesEl = cp.config.find((x) => x.name === 'sourceEntries');
      if (sourceEntriesEl && !entries.some((e) => e.name === name)) {
        const entry = new XElement('entry');
        entry.setAttr('flags', 'VALUE_WORKSPACE_PATH|RESOLVED');
        entry.setAttr('kind', 'sourcePath');
        entry.setAttr('name', name);
        sourceEntriesEl.append(entry);
      }
      cp.save();
      return { name: r.name, locationUri: r.locationUri, location: r.location, integratedIntoBuild: true };
    });
    return { ok: true, ...added };
  },

  async mrvc_remove_linked_folder(args) {
    const root = path.resolve(String(args['root']).trim());
    requireCproject(root);
    const name = typeof args['name'] === 'string' ? args['name'].trim() : '';
    if (!name) throw new ToolError('name is required — the link name to remove');
    const present = readProjectFile(root, { repair: false }).linkedResources;
    const before = present.find((l) => l.name === name);
    if (!before) {
      throw new ToolError(`no linked folder named "${name}" — present: ${present.map((l) => l.name).join(', ') || '(none)'}`);
    }
    const removed = withBackup(root, () => {
      // .project first, then clean the .cproject references the same way the
      // extension's Remove command does: the include-path entries, the named
      // sourceEntry and the root-scan excluding token (round13 P2.2). No
      // inner catch: an unreferenced folder makes every step a silent no-op,
      // so anything that throws here is a REAL failure and must roll the
      // whole transaction back through the guard.
      removeLinkedFolder(root, name);
      const cp = Cproject.load(root, { repairProject: false });
      const logic = '${workspace_loc:/${ProjName}/' + name + '}';
      cp.removeFromListOption('c.compiler.include.paths', logic);
      cp.removeFromListOption('assembler.include.paths', logic);
      for (const se of cp.sourceEntries) {
        if (se.name === name) {
          se.element.parent?.removeChild(se.element);
        } else if (se.name === '') {
          const excluding = se.excluding.filter((x) => x !== name);
          se.element.setAttr('excluding', excluding.join('|'));
        }
      }
      cp.save();
      return { integratedIntoBuild: true };
    });
    return {
      ok: true,
      removed: { name: before.name, locationUri: before.locationUri, location: before.location },
      ...removed,
    };
  },

  async mrvc_stack_usage(args) {
    const root = path.resolve(String(args['root']).trim());
    const cp = requireCproject(root);
    const buildDir = containedJoin(root, cp.configName);
    const contents = collectAnalysisFiles(buildDir, (n) => n.endsWith('.su'));
    if (!contents.length) {
      throw new ToolError(
        `no .su files under ${buildDir} — stack usage needs a build with analysis enabled (mrvc_build analysis:true, or the extension's mrvc.build.analysis setting)`
      );
    }
    const records = parseStackUsage(contents);
    if (!records.length) {
      throw new ToolError('the .su files contain no parseable records');
    }
    const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? Math.min(2000, Math.max(1, Math.floor(args['limit']))) : 50;
    const sorted = [...records].sort((a, b) => b.size - a.size);
    return {
      ok: true,
      config: cp.configName,
      functionCount: records.length,
      totalOwnStack: records.reduce((s, r) => s + r.size, 0),
      dynamicFrames: records.filter((r) => !r.isStatic).map((r) => r.name),
      top: sorted.slice(0, limit),
      truncated: records.length > limit,
      note: 'totalOwnStack is the per-function own-size sum (no call-path weighting), not a worst-case path',
    };
  },

  async mrvc_call_analysis(args) {
    const root = path.resolve(String(args['root']).trim());
    const cp = requireCproject(root);
    const buildDir = containedJoin(root, cp.configName);
    const dumps = collectAnalysisFiles(buildDir, isExpandDump);
    if (!dumps.length) {
      throw new ToolError(
        `no -fdump-rtl-expand dumps under ${buildDir} — call analysis needs a build with analysis enabled (mrvc_build analysis:true, or the extension's mrvc.build.analysis setting)`
      );
    }
    const calls = dumps.flatMap((d) => parseDumpCalls(d));
    if (!calls.length) {
      throw new ToolError('the expand dumps contain no parseable call edges');
    }
    const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? Math.min(20000, Math.max(1, Math.floor(args['limit']))) : 200;
    const callers = new Set(calls.map((c) => c.caller));
    const callees = new Set(calls.map((c) => c.callee));
    return {
      ok: true,
      config: cp.configName,
      edgeCount: calls.length,
      callerCount: callers.size,
      calleeCount: callees.size,
      edges: calls.slice(0, limit),
      truncated: calls.length > limit,
    };
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
    requireLinkedTargets(root); // stale links must not silently shrink the exported source set
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
    requireLinkedTargets(root); // stale links must not silently shrink the database
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
