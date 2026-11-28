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
 * Scope: read + build + hardware (flash / power-off-reset / power-rail /
 * WCH-Link firmware check), read-only static analysis (preprocessor define
 * consistency; GCC .su stack usage and -fdump-rtl-expand call graphs over
 * builds made with analysis enabled), and guarded project WRITES: config
 * fields (include paths / defines / optimization / linker script / warnings /
 * debug level / dialects / USER_OBJS / libs / artifact identity), the build
 * exclusion table (Exclude/Include From Build with the CDT marker semantics),
 * configuration add/rename/delete/set-active, linked-folder add/remove and
 * target change, audit REPAIR execution (fixable findings + stale-link
 * re-pointing), project rename, C↔C++ conversion, single-file compiles and
 * output-directory cleanup. Every write tool runs through withBackup: the
 * touched files (.cproject / .project / the <name>.wvproj marker / .template
 * / *.launch) are copied into .vscode/mrvc/mcp-backup/<stamp>/ first,
 * mutated via a fresh core load, and re-parsed afterwards — a failed
 * re-parse restores the backups and raises, so no half-written state
 * survives. The hardware tools open with a HARD GATE — the
 * receipt the extension writes after a successful MANUAL download must
 * exist, its .template hash must still match, and the plan the MCP is about
 * to run must fingerprint-match the plan that download executed (see
 * core/flashAck). Build + hardware operations run through an in-server
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
import { buildOutputFiles, generateMakefiles, imageCandidates, imageKeepNames, legacyPrintSizeCleanOverride, objectTargetFor, productsFor as coreProductsFor, singleFileMakeArg } from '../core/makefile';
import { recordBuildOutputs, snapshotExistingOutputs } from '../core/outputHistory';
import { flashExtensions } from '../core/flags';
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
import { checkWCHLinkFirmware, formatLinkVersion, linkSupportsPowerOutput } from '../core/wlink';
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
import {
  scanSources,
  danglingSourceEntries,
  classifySourceExt,
  isLogicExcluded,
  isOutputDirLogicPath,
  exclusionTokens,
} from '../core/scan';
import { auditProjectConfig, repairProjectConfig } from '../core/audit';
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
import {
  readProjectFile,
  addLinkedFolder,
  removeLinkedFolder,
  changeLinkedFolderTarget,
  renameProject,
  repairLinkedResources,
  staleLinkedFolders,
  unscannableLinkedTarget,
  listRemovedResources,
  isSafeLinkName,
  assertSafeLinkTarget,
} from '../core/projectFile';
import { setProjectCpp } from '../core/projectType';
import { clearOutputDir, removeOutputDir, deleteConfigOutputs } from '../core/output';
import { XElement, parseXml } from '../core/xml';

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
  'mrvc_repair_project',
  'mrvc_check_preprocessor',
  'mrvc_set_config_option',
  'mrvc_manage_configurations',
  'mrvc_set_build_exclusion',
  'mrvc_rename_project',
  'mrvc_switch_project_type',
  'mrvc_list_linked_folders',
  'mrvc_add_linked_folder',
  'mrvc_change_linked_folder_target',
  'mrvc_remove_linked_folder',
  'mrvc_build',
  'mrvc_compile_file',
  'mrvc_delete_output',
  'mrvc_stack_usage',
  'mrvc_call_analysis',
  'mrvc_get_build_log',
  'mrvc_export_cmake',
  'mrvc_generate_intellisense_db',
  'mrvc_flash',
  'mrvc_power_off_reset',
  'mrvc_set_power_output',
  'mrvc_check_wchlink_firmware',
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
      name: 'mrvc_repair_project',
      description:
        'Execute the audit repairs on a project: enum options missing their value attribute are removed (MRS\u2019s reader crashes on them) and a malformed .template Address is cleared (the download falls back to inference). ' +
        'With includeStaleLinks:true, linked folders whose target no longer exists are ALSO re-pointed when the original tree is found nearby (stored in the PARENT-N-PROJECT_LOC form) — the self-service half of the stale-link build refusal: run this, then retry mrvc_build. ' +
        'Links whose target cannot be found anywhere nearby are REPORTED, not invented. Every write is guarded: the touched files are backed up first and re-parsed after — a failed parse restores everything.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          includeStaleLinks: { type: 'boolean', description: 'Also re-point stale linked folders whose original target can be found nearby (default false).' },
        },
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
        'Write ONE class of build-configuration fields. Original four: includePaths / defines / optimizationLevel / linkerScript. 0.3.8 additions: ' +
        'warningsAll / warningsExtra / gcSections / functionSections / dataSections / lto (booleans), debugInfoLevel (default|none|minimal|max), ' +
        'cDialect / cppDialect (real C/C++ standard choices — "default" is refused), userObjects / linkedLibs / libSearchPaths (lists), ' +
        'artifactName / outputPrefix (build identity; plain name segments — an artifactName change means the .template Target Path needs a re-check before flashing). ' +
        'List fields take the FULL replacement list (read mrvc_get_project_config first and write back everything you want to keep — an empty list clears). ' +
        'Absolute paths inside the project (and bare relative entries) are stored in the MRS "${workspace_loc:/${ProjName}/rel}" spelling; values that already start with "$" pass through untouched. ' +
        'C and C++ twins are written together by default (language "both") so the two languages cannot drift — pass language "c" / "cpp" (or "asm" for includePaths) to target one. ' +
        'Every write is guarded: the touched files are copied to .vscode/mrvc/mcp-backup/<stamp>/ first and re-parsed after — a failed parse restores the originals.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          // derived from the SAME tables the handler reads — the enum can never
          // drift from what the tool actually accepts (v0.3.8 review H1)
          field: {
            type: 'string',
            enum: ['includePaths', 'defines', 'optimizationLevel', 'linkerScript', ...Object.keys(EXTRA_OPTION_FIELDS)],
            description: 'Which field class to write.',
          },
          value: {
            description:
              'includePaths / defines / linkerScript / userObjects / linkedLibs / libSearchPaths: the FULL replacement list of strings (defines are raw macros like DEBUG=1; userObjects/linkedLibs are stored UNQUOTED per the MRS2 model). ' +
              'optimizationLevel: size (-Os), none (-O0), optimize (-O1), more (-O2), most (-O3), fast (-Ofast), debug (-Og), z (-Oz). ' +
              'debugInfoLevel: default (-g) / none / minimal (-g1) / max (-g3) — "default" is a real stored choice here. ' +
              'cDialect / cppDialect: a REAL standard id (gnu99/c11/gnu17/…, ansi, gnucpp11/cpp17/… — "default" is refused). ' +
              'Booleans (warningsAll/warningsExtra/gcSections/functionSections/dataSections/lto): true|false — false is written explicitly, so model-default-on options (c.linker.gcsections) really turn off. ' +
              'artifactName / outputPrefix: a plain name segment, no path separators or shell metacharacters.',
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
      name: 'mrvc_set_build_exclusion',
      description:
        'Exclude a file or folder from the build / re-include it — the CDT sourceEntries exclusion table, with exactly the extension tree\u2019s Exclude-From-Build semantics. ' +
        '"path" is the LOGIC path: project-relative (APP/main.c) or under a linked folder (StdPeriphDriver/CH58x_adc.c — paths start with the link name, see mrvc_list_linked_folders). ' +
        'Excluding a top folder that carries its own named sourceEntry REMOVES that entry and writes the root token (a root token paired WITH a named entry is only CDT\u2019s re-include marker — the entry must go for the exclusion to be real); include strips the tokens and re-creates the named entry. ' +
        'action "check" is read-only: is the path excluded now, plus the raw exclusion table. Writes follow the ACTIVE configuration (MRS semantics). Guarded write.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          path: { type: 'string', description: 'Logic path of the file or folder (project-relative, or LinkName/sub/path for linked content).' },
          action: { type: 'string', enum: ['exclude', 'include', 'check'], description: 'exclude / include write the table; check only reports.' },
        },
        required: ['root', 'path', 'action'],
      },
    },
    {
      name: 'mrvc_rename_project',
      description:
        'Rename a MRS project the way the extension\u2019s Rename command does: the .project display name, the debug-launch configuration (rewritten AND renamed to <newName>.launch), the <newName>.wvproj marker (old marker deleted) and the .template Target Path filename segment. .cproject is untouched. ' +
        'Refuses names with \\ / : * ? " < > | or whitespace. Guarded write — everything is backed up first and rolled back if any step fails.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          newName: { type: 'string', description: 'The new project name (a single safe path segment).' },
        },
        required: ['root', 'newName'],
      },
    },
    {
      name: 'mrvc_switch_project_type',
      description:
        'Convert a project between C and C++ (the extension\u2019s Project Type toggle): toggles the ccnature in .project; switching TO C++ also mirrors every C option onto its cpp twin and adds the C++ compiler inputType (a nature-only toggle would build C++ with no include paths and no linker script); switching back to C removes the C++ inputType (the mirrored values stay in place — extension parity). Guarded write.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          cpp: { type: 'boolean', description: 'true = convert to C++, false = convert back to C.' },
        },
        required: ['root', 'cpp'],
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
      name: 'mrvc_change_linked_folder_target',
      description:
        'Point an existing linked folder at a new directory (the extension\u2019s Change Target command): rewrites the .project locationURI in the PARENT-N-PROJECT_LOC macro form so the project stays portable. The link NAME is untouched, so every .cproject reference keeps working. ' +
        'Refuses targets that are, contain, or resolve through a link back to the project root; the target need not exist, but a missing/unreadable target is reported in the response (builds refuse on it until repaired — see mrvc_repair_project includeStaleLinks). Unknown link names are refused. Guarded write.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          name: { type: 'string', description: 'Link name to re-target (see mrvc_list_linked_folders).' },
          newTarget: { type: 'string', description: 'ABSOLUTE path of the new target directory.' },
        },
        required: ['root', 'name', 'newTarget'],
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
      name: 'mrvc_compile_file',
      description:
        'Compile ONE source file headlessly: regenerates the makefiles from .cproject (byte-identical to the extension) and runs the MRS-bundled make on that single object target — the headless shape of the extension\u2019s Compile Single File. ' +
        '"file" is the LOGIC path: project-relative, or under a linked folder (LinkName/sub/file.c). Refused for excluded files, unknown source extensions, a C++ file on a plain-C project, and stale-linked projects (same gate as mrvc_build). ' +
        'The result is returned here only — the extension\u2019s build record is not written.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          file: { type: 'string', description: 'Logic path of the source file (.c/.cpp/.cc/.cxx/.s/.S).' },
          configIndex: { type: 'number', description: 'Configuration row to build under (0 = the ACTIVE configuration). Default 0.' },
          timeoutSec: { type: 'number', description: 'Hard timeout for the make invocation in seconds (default 600, clamped 5–3600).' },
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
        required: ['root', 'file'],
      },
    },
    {
      name: 'mrvc_delete_output',
      description:
        'Delete build output directories — the extension\u2019s four Delete commands in one tool. scope "active" cleans the ACTIVE configuration\u2019s output directory; "all" covers every configuration in .cproject (the configuration name IS the directory name). ' +
        'keepImages:true spares only <target>.hex / <target>.bin per configuration and otherwise clears the whole directory contents. Nothing outside <project>/<config>/ is ever touched; a symlinked output directory is refused. No make, no toolchain needed.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          scope: { type: 'string', enum: ['active', 'all'], description: 'active = the active configuration only; all = every configuration.' },
          keepImages: { type: 'boolean', description: 'Keep <target>.hex / <target>.bin, delete everything else in the output directory(ies) (default false = delete the directories).' },
        },
        required: ['root', 'scope'],
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
    {
      name: 'mrvc_set_power_output',
      description:
        'Switch the WCH-Link target power rail to 3.3 V or 5 V immediately (pow3v3/pow5v off → delay → on at the requested rail, each pass marker-verified). ' +
        'GATE: the user must have run Power-Off Reset in the MRVC extension at least once (MRVC records a marker-verified receipt after that manual sequence — rail operations stay anchored to that human go-ahead), and only WCH-LinkE / DAPLink / LinkW can switch the rail (the plain WCH-Link is refused). ' +
        'Note: this APPLIES the rail now — it does not latch a preference for later downloads; mrvc_flash\u2019s power steps follow their own verified plan.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: PROJECT_ROOT_DESC },
          rail: { type: 'string', enum: ['3v3', '5v'], description: 'The rail to apply (default 3v3).' },
          delayMs: { type: 'number', description: 'De-energised duration in ms, 0–10000 (default 100).' },
          openocdPath: { type: 'string', description: 'OpenOCD binary override.' },
          openocdCfg: { type: 'string', description: 'Board cfg override (default: wch-riscv.cfg / wch-dual-core.cfg from the MRS install).' },
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
        required: ['root', 'rail'],
      },
    },
    {
      name: 'mrvc_check_wchlink_firmware',
      description:
        'Check the attached WCH-Link\u2019s firmware version against the version the MRS install expects — a READ-ONLY FFI probe (OpenDevice / GetDeviceVersion / CloseDevice; MRVC never writes link firmware). ' +
        'Returns the link model and the current/expected version pair; state "upgrade-needed" carries the guidance (update with WCH-LinkUtility first — the IDE gates downloads on it).',
      inputSchema: {
        type: 'object',
        properties: {
          mrsInstallPath: { type: 'string', description: 'Explicit MRS install root (overrides the environment variable).' },
        },
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
  // the same exemption semantics as the scan gate: links excluded from the
  // build (root token, no paired named entry) or logically removed do not
  // participate, so their missing targets must not block (v0.3.8 review M7)
  const cp = Cproject.load(root, { repairProject: false });
  const rootEntry = cp.sourceEntries.find((e) => e.name === '');
  const excluded = new Set((rootEntry?.excluding ?? []).map((t) => foldPathOnPlatform(t)));
  const named = new Set(cp.sourceEntries.filter((e) => e.name !== '').map((e) => foldPathOnPlatform(e.name)));
  const removedFolders = new Set(
    listRemovedResources(root)
      .filter((r) => r.isFolder)
      .map((r) => foldPathOnPlatform((r.parentLogic ? r.parentLogic + '/' : '') + r.name))
  );
  const stale = staleLinkedFolders(root).filter((s) => {
    const k = foldPathOnPlatform(s.name);
    if (removedFolders.has(k)) return false;
    if (excluded.has(k) && !named.has(k)) return false;
    return true;
  });
  if (!stale.length) return;
  const detail = stale
    .map((s) => `"${s.name}" -> ${s.locationUri}${s.suggestedFix ? ` (repairable to ${s.suggestedFix})` : ''}`)
    .join('; ');
  throw new ToolError(
    `stale linked folder(s) — their targets do not exist on disk, so a build/scan would silently skip them: ${detail}. ` +
      'Repair headlessly with mrvc_repair_project (includeStaleLinks: true) and retry — or open the project once in the MRVC extension (its first-open pass repairs stale links automatically).'
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
  // the project's own artifact follows the generator's naming: the PREFIXED
  // image first (what the current build writes), then the prefix-less
  // legacy image — a bare targetName lookup handed a STALE prefix-less
  // image to the flasher while the current prefixed one sat next to it
  // (review round2 P2)
  const ext = cp.flashFormat === 'binary' ? 'bin' : 'hex';
  const ownCandidates = imageCandidates(cp.targetName, cp.outputPrefix, cp.flashFormat).map((f) => path.join(root, cp.configName, f));
  const own = ownCandidates[0];
  // EVERY candidate exits through ONE gate: the final image must be a
  // readable, non-empty regular file BEFORE OpenOCD starts. OpenOCD erases
  // the chip first and opens the image afterwards — a missing/empty image
  // discovered only then would leave the device erased (review P1). The
  // gate actually OPENS the file (round2 P1: statSync metadata alone passes
  // ACL-locked content whose read then fails mid-flash); a read failure
  // refuses while a successful read of NEW content stays allowed (rebuild
  // → re-flash the same path is the core flow this gate must keep open).
  const requireImage = (file: string): void => {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      throw new ToolError(`firmware image not found: ${file} — run mrvc_build first (or pass targetFile)`);
    }
    if (!st.isFile() || st.size === 0) {
      throw new ToolError(`firmware image is not a readable non-empty file: ${file} — rebuild the project first`);
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    } catch (e) {
      throw new ToolError(`firmware image is not readable: ${file} (${e instanceof Error ? e.message : String(e)}) — fix access to the file, then retry`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  if (typeof targetFile === 'string' && targetFile.trim()) {
    const abs = path.resolve(root, targetFile.trim());
    requireImage(abs);
    return { file: abs, note: '' };
  }
  const targetRaw = (tpl.values['Target Path'] ?? '').trim();
  if (targetRaw) {
    const cand = path.resolve(root, targetRaw);
    if (fs.existsSync(cand)) {
      requireImage(cand);
      return {
        file: cand,
        note: ownCandidates.some((o) => path.resolve(o) === path.resolve(cand)) ? '' : `using .template Target Path (${targetRaw}) instead of the project artifact`,
      };
    }
    // fall back to the project artifact: the FIRST candidate that exists
    // (prefixed preferred, legacy accepted), else the prefixed path for the
    // error message
    const existing = ownCandidates.find((o) => fs.existsSync(o)) ?? own;
    requireImage(existing);
    return { file: existing, note: `.template Target Path (${targetRaw}) does not exist on this machine — using the project's own artifact` };
  }
  const existing = ownCandidates.find((o) => fs.existsSync(o)) ?? own;
  requireImage(existing);
  return { file: existing, note: '' };
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

const HARDWARE_TOOLS = new Set([
  'mrvc_build',
  'mrvc_compile_file',
  'mrvc_delete_output',
  'mrvc_flash',
  'mrvc_power_off_reset',
  'mrvc_set_power_output',
  'mrvc_check_wchlink_firmware',
  // project-structure writes join the mutex too: a rename or type switch
  // racing a concurrent build's makefile generation would read half-moved
  // files (v0.3.8 review Low-3)
  'mrvc_rename_project',
  'mrvc_switch_project_type',
]);

/** the exclusion / single-file tools take LOGIC paths: project-relative
 *  posix, or a linked-folder path whose first segment is the link name.
 *  Resolve and validate: refuse absolutes, ".." escapes and paths that exist
 *  nowhere — a write tool must not invent exclusions for what the caller
 *  misspelled. Returns the normalized posix logic path AND its absolute
 *  location (compile_file needs the file itself). */
function resolveLogicPath(root: string, cp: Cproject, raw: string): { logic: string; abs: string } {
  const norm = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const firstSeg = norm.split('/')[0] ?? '';
  if (!norm || /^([A-Za-z]:)?\//.test(norm) || /^[A-Za-z]:$/.test(firstSeg) || norm.split('/').some((s) => s === '..')) {
    throw new ToolError(`path must be a project-relative logic path without ".." escapes (got "${raw}")`);
  }
  const segs = norm.split('/');
  for (const [name, target] of cp.linkedFolders) {
    if (foldPathOnPlatform(segs[0]) !== foldPathOnPlatform(name)) continue;
    const base = path.resolve(target);
    const full = segs.length > 1 ? path.join(base, ...segs.slice(1)) : base;
    if (!fs.existsSync(full)) {
      throw new ToolError(`"${segs.slice(1).join('/') || '(the link root)'}" does not exist under linked folder "${name}" (${base})`);
    }
    return { logic: norm, abs: full };
  }
  const full = path.resolve(root, ...segs);
  const rootF = foldPathOnPlatform(root);
  const fullF = foldPathOnPlatform(full);
  if (fullF === rootF) throw new ToolError('path must be INSIDE the project — the root itself cannot be named');
  // the separator is elided when the fold already ends with one (a drive
  // root "C:\" would otherwise compose "C:\\") — same shape as output.ts
  const sep = rootF.endsWith(path.sep) ? '' : path.sep;
  if (!fullF.startsWith(rootF + sep)) throw new ToolError(`path resolves outside the project root: ${norm}`);
  if (!fs.existsSync(full)) {
    throw new ToolError(
      `no such file or directory in the project: ${norm} (linked-folder content starts with the link name — see mrvc_list_linked_folders)`
    );
  }
  return { logic: norm, abs: full };
}

/** a logic path hidden by filteredResources (the project tree's Remove
 *  command) — a removed FOLDER hides everything under it. Files in this
 *  state never reach the makefiles, so a compile request for one would end
 *  in an opaque make error (v0.3.8 review M7). */
function logicallyRemoved(root: string, logic: string): boolean {
  const f = foldPathOnPlatform(logic.replace(/\\/g, '/'));
  for (const r of listRemovedResources(root)) {
    const parent = r.parentLogic ? r.parentLogic.replace(/\\/g, '/') + '/' : '';
    const name = foldPathOnPlatform(parent + r.name);
    if (r.isFolder ? f === name || f.startsWith(name + '/') : f === name) return true;
  }
  return false;
}

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

/** the produced artifacts of one configuration — moved to core/makefile.ts
 *  (round4 P2: shared with the generator's naming; null-size for missing
 *  candidates instead of ENOENT) */
const productsFor = (cp: Cproject, buildDir: string) => coreProductsFor(cp, buildDir, flashExtensions(cp));

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
      const run = await runProcess(makeExe, ['clean', ...legacyPrintSizeCleanOverride(dir)], dir, [install.makeBin], timeoutSec * 1000, 96 * 1024);
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
      const run = await runProcess(makeExe, ['clean', ...legacyPrintSizeCleanOverride(dir)], dir, [install.makeBin], timeoutSec * 1000, 96 * 1024);
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
    const candidateOutputs = buildOutputFiles(cpConfig);
    const preBuildSnap = snapshotExistingOutputs(buildDir, candidateOutputs);
    const run = await runProcess(makeExe, [`-j${jobs}`, 'all'], buildDir, [path.join(tc.dir, 'bin'), install.makeBin], timeoutSec * 1000, 192 * 1024);
    recordBuildOutputs(root, buildDir, candidateOutputs, preBuildSnap);
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

/** 0.3.8: the second batch of writable property-page fields — bools, enums,
 *  linker lists and the build identity. Enum choice tables are the EXACT
 *  configView FIELDS entries (options arrays) so what the tool accepts is
 *  what the property page offers. */
const ENUM_OPTION_BASE = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
const DEBUG_LEVELS = ['default', 'none', 'minimal', 'max'] as const;
// the dialects list NO 'default' choice that can be written: configView maps
// 'default' to a value-clear, and clearing an enumerated value attribute is a
// PROTECTED no-op (the MRS reader crashes on a missing one, cproject P1
// guard) — so the tool accepts the real stored choices only
const C_STD_LEVELS = ['gnu99', 'c99', 'gnu11', 'c11', 'gnu17', 'c17', 'gnu90', 'iso9899.1994090', 'c2x', 'gnu2x', 'ansi'] as const;
const CPP_STD_LEVELS = [
  'ansi',
  'gnucpp98',
  'cpp0x',
  'cpp11',
  'gnucpp0x',
  'gnucpp11',
  'cpp1y',
  'cpp14',
  'gnucpp1y',
  'gnucpp14',
  'cpp1z',
  'cpp17',
  'gnucpp1z',
  'gnucpp17',
  'cpp2a',
  'gnucpp2a',
] as const;

type ExtraFieldSpec =
  | { kind: 'bool'; global?: string; c?: string; cpp?: string; defaults?: Record<string, boolean> }
  | { kind: 'enum'; suffix: string; enumBase: string; options: readonly string[]; onlyLanguage?: 'c' | 'cpp' }
  | { kind: 'list'; c: string; cpp: string; paths: boolean }
  | { kind: 'identity'; id: 'artifactName' | 'outputPrefix' };

const EXTRA_OPTION_FIELDS: Record<string, ExtraFieldSpec> = {
  warningsAll: { kind: 'bool', global: 'warnings.allwarn' },
  warningsExtra: { kind: 'bool', global: 'warnings.extrawarn' },
  // c.linker.gcsections defaults ON when the option is absent (MRS2's C
  // linker model, mirrored in flags.ts) — before/after must report that
  // default, or a false write would claim an already-off option
  gcSections: { kind: 'bool', c: 'c.linker.gcsections', cpp: 'cpp.linker.gcsections', defaults: { 'c.linker.gcsections': true } },
  functionSections: { kind: 'bool', global: 'optimization.functionsections' },
  dataSections: { kind: 'bool', global: 'optimization.datasections' },
  lto: { kind: 'bool', global: 'optimization.lto' },
  debugInfoLevel: { kind: 'enum', suffix: 'debugging.level', enumBase: ENUM_OPTION_BASE + 'debugging.level.', options: DEBUG_LEVELS },
  cDialect: { kind: 'enum', suffix: 'c.compiler.std', enumBase: ENUM_OPTION_BASE + 'c.compiler.std.', options: C_STD_LEVELS, onlyLanguage: 'c' },
  cppDialect: { kind: 'enum', suffix: 'cpp.compiler.std', enumBase: ENUM_OPTION_BASE + 'cpp.compiler.std.', options: CPP_STD_LEVELS, onlyLanguage: 'cpp' },
  userObjects: { kind: 'list', c: 'c.linker.otherobjs', cpp: 'cpp.linker.otherobjs', paths: false },
  linkedLibs: { kind: 'list', c: 'c.linker.libs', cpp: 'cpp.linker.libs', paths: false },
  libSearchPaths: { kind: 'list', c: 'c.linker.paths', cpp: 'cpp.linker.paths', paths: true },
  artifactName: { kind: 'identity', id: 'artifactName' },
  outputPrefix: { kind: 'identity', id: 'outputPrefix' },
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
    const entries = fs.readdirSync(root);
    // EVERY .wvproj joins the backup: the rename flow deletes them all and
    // writes the new one — a second stray marker would be lost on rollback
    // (v0.3.8 review M6). EVERY .launch joins too: a rename migrates the
    // PROJECT_ATTR/MAPPED_RESOURCE_PATHS of all of them (round27 P2-3)
    for (const n of entries) {
      if (n.toLowerCase().endsWith('.wvproj') || n.toLowerCase().endsWith('.launch')) names.push(n);
    }
  } catch {
    // unreadable root: requireCproject would already have failed before us
  }
  if (fs.existsSync(path.join(root, '.template'))) names.push('.template');
  return names;
}

/** the write guard's post-check: every touched file must still parse */
function reparseWritten(root: string, basename: string, backupFile: string): void {
  if (basename === '.cproject') {
    // repair:false — the post-write check must VERIFY, never repair: the
    // default repairProject:true would ride the first-open stale-link
    // auto-repair on this load and silently rewrite .project outside the
    // transaction the caller asked for (v0.3.8 review H4)
    Cproject.load(root, { repairProject: false });
  } else if (basename === '.project') {
    readProjectFile(root, { repair: false });
  } else if (basename === '.template') {
    readTemplate(root);
  } else if (basename.toLowerCase().endsWith('.launch')) {
    // a CDT debug-launch configuration is plain XML; an untouched file
    // parses harmlessly, a rewritten one must too
    parseXml(fs.readFileSync(path.join(root, basename), 'utf-8'));
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
    const root = toolRoot(args);
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
    const root = toolRoot(args);
    requireCproject(root); // the three-file contract first
    const result = auditProjectConfig(root);
    const findings = result.findings.map((f) => ({ code: f.code, file: f.file, detail: f.detail, fixable: f.fixable }));
    return {
      ok: findings.length === 0,
      findingCount: findings.length,
      fixableCount: findings.filter((f) => f.fixable).length,
      findings,
      note: findings.length ? 'run mrvc_repair_project to execute the fixable ones' : '',
    };
  },

  async mrvc_repair_project(args) {
    const root = toolRoot(args);
    requireCproject(root); // three-file contract first
    const includeStaleLinks = args['includeStaleLinks'] === true;
    const report = auditProjectConfig(root);
    const fixable = report.findings.filter((f) => f.fixable);
    // a no-op must not leave a redundant backup directory behind (v0.3.8
    // review H4 + re-review #3): with nothing fixable and NO repairable stale
    // link (the planner only finds candidates, it never invents them) the
    // transaction would be zero-write — short-circuit instead
    const staleNow = includeStaleLinks ? staleLinkedFolders(root) : [];
    const staleWritable = staleNow.some((s) => !!s.suggestedFix);
    if (!fixable.length && !staleWritable) {
      const response: Record<string, unknown> = {
        ok: true,
        findingsTotal: report.findings.length,
        fixableCount: 0,
        repaired: [],
        note: 'nothing fixable and no repairable stale links — no backup taken',
      };
      if (includeStaleLinks) {
        response['staleLinksRemaining'] = staleNow.map((s) => ({ name: s.name, location: s.location }));
      }
      return response;
    }
    const written = withBackup(root, () => {
      // the STALE-LINK pass runs FIRST and owns the count (repairProjectConfig
      // no longer auto-repairs on load — audit.ts loads repair:false — so this
      // explicit pass is the only stale-link writer and its return value is
      // the truth)
      let staleRepaired = 0;
      if (includeStaleLinks) {
        const p = readProjectFile(root, { repair: false });
        staleRepaired = repairLinkedResources(root, p);
      }
      // repairProjectConfig keeps its own per-file backup (the extension's
      // Audit-And-Repair shares it); enum-value-missing removals and
      // .template Address clears happen here
      const outcome = fixable.length ? repairProjectConfig(root, fixable) : undefined;
      return {
        repairBackupDir: outcome?.backupDir ?? null,
        repairedFiles: outcome?.repairedFiles ?? [],
        staleLinksRepaired: staleRepaired,
      };
    });
    const response: Record<string, unknown> = {
      ok: true,
      findingsTotal: report.findings.length,
      fixableCount: fixable.length,
      repaired: fixable.map((f) => ({ code: f.code, file: f.file, detail: f.detail })),
      ...written,
    };
    if (includeStaleLinks) {
      // AFTER the repair: what the fixer could not resolve stays listed
      response['staleLinksRemaining'] = staleLinkedFolders(root).map((s) => ({ name: s.name, location: s.location }));
    }
    if (fixable.length === 0 && !includeStaleLinks) {
      response['note'] = 'nothing fixable found — report-only findings (if any) stay visible in mrvc_audit_project';
    }
    return response;
  },

  async mrvc_build(args) {
    const root = toolRoot(args);
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
    const runClean = () =>
      runProcess(requireMake(install), ['clean', ...legacyPrintSizeCleanOverride(cwd)], cwd, makeOnly(), timeoutMs, 96 * 1024);
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
    const candidateOutputs = buildOutputFiles(cp);
    const preBuildSnap = snapshotExistingOutputs(cwd, candidateOutputs);
    const buildRun = await runProcess(makeExe, [`-j${jobs}`, 'all'], cwd, [path.join(tc.dir, 'bin'), install.makeBin], timeoutMs, 192 * 1024);
    recordBuildOutputs(root, cwd, candidateOutputs, preBuildSnap);
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

  async mrvc_compile_file(args) {
    const root = toolRoot(args);
    requireCproject(root); // the three-file contract first (v0.3.8 review M7)
    const { index, names } = configIndexOrThrow(root, args['configIndex']);
    const cp = Cproject.loadConfigAt(root, index, { repairProject: false });
    const rawFile = typeof args['file'] === 'string' ? args['file'] : '';
    if (!rawFile.trim()) throw new ToolError('file is required — the logic path of the source file');
    const { logic, abs } = resolveLogicPath(root, cp, rawFile);
    if (!fs.statSync(abs).isFile()) {
      throw new ToolError(`"${logic}" is a directory — compile_file takes a single source file`);
    }
    // a tree-Removed file never reaches the makefiles — the make error for a
    // missing target would be opaque, refuse with the reason instead
    if (logicallyRemoved(root, logic)) {
      throw new ToolError(`"${logic}" is logically removed from the project (filteredResources) — restore it first`);
    }
    const cl = classifySourceExt(logic);
    if (!cl) {
      throw new ToolError(`"${logic}" is not a compilable source file (.c/.cpp/.cc/.cxx/.s/.S)`);
    }
    if (!cp.isCpp && cl.kind === 'cpp') {
      throw new ToolError(`the project is a plain-C project — there is no C++ tool to compile "${logic}" with (switch the project type first)`);
    }
    if (isOutputDirLogicPath(cp, logic)) {
      throw new ToolError(`"${logic}" is inside a build output directory — output directories are excluded from compilation`);
    }
    if (isLogicExcluded(cp, logic)) {
      throw new ToolError(`"${logic}" is excluded from the build — re-include it first (mrvc_set_build_exclusion action:"include")`);
    }
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) throw new ToolError('no valid MRS install found (see mrvc_get_install_info)');
    requireLinkedTargets(root); // stale links must not silently shrink the source set
    const tc = requireToolchain(install, cp);
    const makeExe = requireMake(install);
    const buildDir = containedJoin(root, cp.configName);
    const gen = generateMakefiles(cp, tc, {});
    const objTarget = objectTargetFor(logic);
    const arg = singleFileMakeArg(objTarget);
    if (arg.error || !arg.arg) throw new ToolError(`cannot hand the target to make safely: ${arg.error ?? 'unknown quoting problem'}`);
    const candidateOutputs = [objTarget, objTarget.slice(0, -2) + '.d', objTarget.slice(0, -2) + '.su'];
    const preBuildSnap = snapshotExistingOutputs(buildDir, candidateOutputs);
    const run = await runProcess(makeExe, [arg.arg], buildDir, [path.join(tc.dir, 'bin'), install.makeBin], buildTimeoutSec(args['timeoutSec']) * 1000, 192 * 1024);
    recordBuildOutputs(root, buildDir, candidateOutputs, preBuildSnap);
    return {
      ok: run.exitCode === 0 && !run.timedOut,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      file: logic,
      objectTarget: objTarget,
      config: cp.configName,
      toolchain: tc.name,
      generatedMakefiles: gen.files.length,
      outputTail: run.tail,
      outputTruncated: run.truncated,
      note: 'MCP result is returned here only; the extension build record is not written',
    };
  },

  async mrvc_delete_output(args) {
    const root = toolRoot(args);
    const cp = requireCproject(root);
    const scope = args['scope'] === 'all' ? 'all' : args['scope'] === 'active' ? 'active' : '';
    if (!scope) throw new ToolError(`scope must be "active" or "all" (got ${JSON.stringify(args['scope'])})`);
    const keepImages = args['keepImages'] === true;
    if (scope === 'active') {
      const dir = containedJoin(root, cp.configName);
      if (!fs.existsSync(dir)) {
        return { ok: true, scope, skipped: true, note: 'no output directory — the project has never been built' };
      }
      // (review round7 P1) file-level claimed set: only what the build writes
      // is deleted; linker inputs and stored data in the output dir survive
      // and come back as `survivors`
      const claimed = buildOutputFiles(cp);
      if (keepImages) {
        // keep lists share the generator's image naming (outputPrefix!)
        const keep = imageKeepNames(cp.targetName, cp.outputPrefix);
        const { removed, kept: survivors } = clearOutputDir(root, dir, keep, cp.outputPrefix + cp.targetName, claimed);
        return { ok: true, scope, config: cp.configName, keepImages: true, kept: keep, filesCleared: removed, survivors };
      }
      const r = removeOutputDir(root, dir, cp.outputPrefix + cp.targetName, claimed);
      if (!r.removed) {
        return { ok: true, scope, config: cp.configName, keepImages: false, skipped: true, filesCleared: r.files, note: 'output directory was already absent' };
      }
      return { ok: true, scope, config: cp.configName, keepImages: false, removedDir: cp.configName, filesCleared: r.files };
    }
    const names = listConfigurations(root);
    const specs = names.map((cfg, i) => {
      const ci = Cproject.loadConfigAt(root, i, { repairProject: false });
      return {
        dir: containedJoin(root, cfg),
        keep: keepImages ? imageKeepNames(ci.targetName, ci.outputPrefix) : undefined,
        target: ci.outputPrefix + ci.targetName,
        claimed: buildOutputFiles(ci),
      };
    });
    const r = deleteConfigOutputs(root, specs);
    return { ok: true, scope, configs: names, keepImages, ...r };
  },

  async mrvc_check_preprocessor(args) {
    const cp = requireCproject(toolRoot(args));
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
    const root = toolRoot(args);
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

    // ---- second batch: bools / enums / linker lists / build identity ----
    const extra = EXTRA_OPTION_FIELDS[field];
    if (extra && extra.kind === 'bool') {
      const targets: string[] = [];
      if (extra.global) {
        if (language !== 'both') throw new ToolError(`"${field}" is a global option — it has no language twins, drop "language"`);
        targets.push(extra.global);
      } else {
        if (language === 'asm') throw new ToolError(`"${field}" has no assembler option`);
        for (const l of language === 'c' ? ['c'] : language === 'cpp' ? ['cpp'] : ['c', 'cpp']) {
          const sfx = l === 'c' ? extra.c : extra.cpp;
          if (sfx) targets.push(sfx);
        }
      }
      if (typeof args['value'] !== 'boolean') throw new ToolError(`value must be true or false for "${field}"`);
      const v = args['value'];
      const load = () => Cproject.loadConfigAt(root, index, { repairProject: false });
      const boolDefault = (sfx: string): boolean => (extra.kind === 'bool' ? (extra.defaults?.[sfx] ?? false) : false);
      const before: Record<string, boolean> = {};
      for (const sfx of targets) before[sfx] = load().optionBool(sfx, boolDefault(sfx));
      const written = withBackup(root, () => {
        const cp = load();
        for (const sfx of targets) cp.setOptionBool(sfx, v, true);
        cp.save();
        return {};
      });
      const after: Record<string, boolean> = {};
      for (const sfx of targets) after[sfx] = load().optionBool(sfx, boolDefault(sfx));
      return { ok: true, field, config: names[index], language, before, after, ...written };
    }
    if (extra && extra.kind === 'enum') {
      if (language !== 'both' && language !== extra.onlyLanguage) {
        throw new ToolError(`"${field}" belongs to the ${extra.onlyLanguage ?? 'global (language-independent)'} side — language "${language}" does not apply`);
      }
      const v = typeof args['value'] === 'string' ? args['value'].trim() : '';
      if (!(extra.options as readonly string[]).includes(v)) {
        throw new ToolError(
          `unknown value "${v}" for "${field}" — valid: ${extra.options.join(', ')}` +
            (extra.onlyLanguage
              ? ' ("default" is not accepted: MRS always keeps one stored choice — write a specific id)'
              : '')
        );
      }
      const load = () => Cproject.loadConfigAt(root, index, { repairProject: false });
      const before = load().optionEnum(extra.suffix) ?? null;
      const written = withBackup(root, () => {
        const cp = load();
        cp.setOptionValue(extra.suffix, extra.enumBase + v);
        cp.save();
        return {};
      });
      const after = load().optionEnum(extra.suffix) ?? null;
      return { ok: true, field, config: names[index], before, after: v, stored: after, ...written };
    }
    if (extra && extra.kind === 'list') {
      if (language === 'asm') throw new ToolError(`"${field}" has no assembler option`);
      const targets = (language === 'c' ? ['c'] : language === 'cpp' ? ['cpp'] : ['c', 'cpp']).map((l) => ({
        lang: l,
        suffix: l === 'c' ? extra.c : extra.cpp,
      }));
      const raw = args['value'];
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
        throw new ToolError(`value must be an array of strings for "${field}" (an empty array clears the list)`);
      }
      const cleaned = (raw as string[]).map((v) => v.replace(/^"(.*)"$/, '$1').trim()).filter((v) => v);
      const values = extra.paths ? cleaned.map((v) => normalizeStoredPath(root, v)) : cleaned;
      const load = () => Cproject.loadConfigAt(root, index, { repairProject: false });
      const before: Record<string, string[]> = {};
      for (const t of targets) before[t.lang] = load().listOption(t.suffix).values;
      const written = withBackup(root, () => {
        const cp = load();
        for (const t of targets) cp.setOptionList(t.suffix, values);
        cp.save();
        return {};
      });
      return { ok: true, field, config: names[index], language, before, after: values, ...written };
    }
    if (extra && extra.kind === 'identity') {
      if (language !== 'both') throw new ToolError(`"${field}" is build identity — it has no language twins, drop "language"`);
      const v = typeof args['value'] === 'string' ? args['value'].trim() : '';
      if (!v) throw new ToolError(`value must be a non-empty string for "${field}"`);
      // plain name segments only: the makefile never mkdirs a prefix
      // subdirectory, and shell metacharacters would reach the link/objcopy
      // command lines verbatim (v0.3.8 review M5)
      if (/[\\/\r\n`$;&|'"<>\s]/.test(v)) {
        throw new ToolError(`${extra.id} must be a plain name segment — no path separators, whitespace or shell metacharacters (got "${v}")`);
      }
      const load = () => Cproject.loadConfigAt(root, index, { repairProject: false });
      const beforeModel = load();
      const before =
        extra.id === 'artifactName'
          ? { artifactName: beforeModel.artifactNameRaw, targetName: beforeModel.targetName }
          : { outputPrefix: beforeModel.outputPrefix };
      const written = withBackup(root, () => {
        const cp = load();
        cp.setBuildIdentity(extra.id === 'artifactName' ? { artifactName: v } : { outputPrefix: v });
        // a minimal .cproject carries no C/C++ linker <tool> — the prefix
        // would silently no-op. Crisp refusal over a silent no-op.
        if (extra.id === 'outputPrefix' && cp.outputPrefix !== v) {
          throw new ToolError('the .cproject carries no C/C++ linker <tool> element to hold outputPrefix — open and Apply the properties page once to materialize the toolchain block');
        }
        cp.save();
        return {};
      });
      const afterModel = load();
      const after =
        extra.id === 'artifactName'
          ? { artifactName: afterModel.artifactNameRaw, targetName: afterModel.targetName }
          : { outputPrefix: afterModel.outputPrefix };
      const result: Record<string, unknown> = { ok: true, field, config: names[index], before, after, ...written };
      if (extra.id === 'artifactName') {
        result['note'] = 'the artifact name changed — re-check the .template Target Path (download resolution) before the next flash';
      }
      return result;
    }

    // ---- list fields ----
    const def = CONFIG_FIELD_SUFFIXES[field];
    if (!def) {
      throw new ToolError(
        `unknown field "${field}" — valid: ${Object.keys(CONFIG_FIELD_SUFFIXES).join(', ')}, optimizationLevel, ` +
          `${Object.keys(EXTRA_OPTION_FIELDS).join(', ')}`
      );
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
    const root = toolRoot(args);
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

  async mrvc_set_build_exclusion(args) {
    const root = toolRoot(args);
    const cp = requireCproject(root);
    const action = args['action'] === 'exclude' ? 'exclude' : args['action'] === 'include' ? 'include' : args['action'] === 'check' ? 'check' : '';
    if (!action) throw new ToolError('action must be one of: exclude, include, check');
    const rawPath = typeof args['path'] === 'string' ? args['path'] : '';
    if (!rawPath.trim()) throw new ToolError('path is required — the logic path (project-relative, or LinkName/sub/path)');
    const logic = resolveLogicPath(root, cp, rawPath).logic;
    const isOutDir = isOutputDirLogicPath(cp, logic);
    if (action === 'check') {
      return {
        ok: true,
        action,
        path: logic,
        excluded: isOutDir || isLogicExcluded(cp, logic),
        ...(isOutDir ? { outputDirectory: true } : {}),
        rootTokens: exclusionTokens(cp).rootTokens,
        namedEntries: cp.sourceEntries.filter((e) => e.name !== '').map((e) => e.name),
        note: 'read-only',
      };
    }
    if (isOutDir) {
      throw new ToolError(`"${logic}" is inside a build output directory — output directories are always excluded from compilation and cannot be toggled`);
    }
    const wasExcluded = isLogicExcluded(cp, logic);
    const written = withBackup(root, () => {
      // the fresh load inside the guard: excludeResource/includeResource walk
      // the ACTIVE configuration's sourceEntries (entriesConfig = index 0,
      // MRS parity) and encode the marker semantics themselves — a named
      // entry is removed on exclude, re-created on include
      const fresh = Cproject.load(root, { repairProject: false });
      if (action === 'exclude') fresh.excludeResource(logic);
      else fresh.includeResource(logic);
      fresh.save();
      return {};
    });
    const after = Cproject.load(root, { repairProject: false });
    return {
      ok: true,
      action,
      path: logic,
      wasExcluded,
      excludedNow: isLogicExcluded(after, logic),
      rootTokens: exclusionTokens(after).rootTokens,
      namedEntries: after.sourceEntries.filter((e) => e.name !== '').map((e) => e.name),
      ...written,
    };
  },

  async mrvc_rename_project(args) {
    const root = toolRoot(args);
    requireCproject(root);
    const newName = typeof args['newName'] === 'string' ? args['newName'].trim() : '';
    if (!newName) throw new ToolError('newName is required — a single safe path segment');
    // validate BEFORE anything composes a path from it: the failure cleanup
    // below removes "<newName>.wvproj/.launch", and an unvalidated name could
    // make that rmSync reach outside the project root. The FULL safe-name
    // rule (dots, trailing dot/space, control characters, Windows device
    // names) plus no whitespace — a project name is a path segment
    // (v0.3.8 review M6)
    if (!isSafeLinkName(newName) || /\s/.test(newName)) {
      throw new ToolError(
        `newName must be a single safe path segment (no separators, whitespace, control characters, "."/"..", trailing dot/space, or Windows reserved device names): "${newName}"`
      );
    }
    const oldName = readProjectFile(root, { repair: false }).name ?? path.basename(root);
    if (newName === oldName) {
      return { ok: true, oldName, newName, changed: false, note: 'same name — nothing written' };
    }
    // the GENERIC withBackup cannot wrap a rename: the transaction LEGITIMATELY
    // removes <old>.wvproj / <old>.launch and creates them under the new name —
    // re-parsing the backed-up old paths would ENOENT and roll a SUCCESSFUL
    // rename back. Same backup set, restore-on-failure, but the post-checks
    // run under the POST-rename spellings instead.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + String(process.pid % 10000).padStart(4, '0');
    const backupDir = containedJoin(root, '.vscode', 'mrvc', 'mcp-backup', stamp);
    const targets = projectWriteTargets(root);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const b of targets) fs.copyFileSync(containedJoin(root, b), path.join(backupDir, b));
    try {
      renameProject(root, newName);
      // post-checks: the .project must parse; the launch — when one existed —
      // must be valid XML under the new name; the new marker is an empty
      // snapshot by core contract (MRS never reads it), existence is enough
      readProjectFile(root, { repair: false });
      const newMarker = containedJoin(root, `${newName}.wvproj`);
      if (!fs.existsSync(newMarker)) {
        throw new ToolError(`rename did not produce the ${newName}.wvproj marker`);
      }
      // every .launch must still exist and parse under the new name. Only a
      // launch named after the OLD PROJECT follows the rename — custom-named
      // launches (a.launch/b.launch) keep their filenames, so demanding
      // `<newName>.launch` whenever ANY launch existed falsely failed
      // custom-launch-only projects (round28 P2-1)
      const launchesNow = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.launch'));
      for (const b of targets) {
        if (!b.toLowerCase().endsWith('.launch')) continue;
        const expected =
          b.toLowerCase() === `${oldName.toLowerCase()}.launch` ? `${newName.toLowerCase()}.launch` : b.toLowerCase();
        // look the REAL on-disk spelling back up: `expected` is fold-normalized
        // and reading it verbatim throws ENOENT on case-sensitive filesystems
        // (Linux / case-sensitive APFS) whenever the name carries an uppercase
        // letter — a SUCCESSFUL rename would then be rolled back (review H1)
        const actual = launchesNow.find((f) => f.toLowerCase() === expected);
        if (!actual) {
          throw new ToolError(`rename lost the launch configuration ${b}`);
        }
        parseXml(fs.readFileSync(containedJoin(root, actual), 'utf-8'));
      }
      return { ok: true, oldName, newName, backupDir, backedUp: targets };
    } catch (e) {
      for (const b of targets) fs.copyFileSync(path.join(backupDir, b), containedJoin(root, b));
      // remove the half-renamed marker/launch the byte restore cannot reach —
      // but never a file the restore just RECREATED (a same-named original)
      for (const stale of [`${newName}.wvproj`, `${newName}.launch`]) {
        try {
          if (targets.some((b) => foldPathOnPlatform(b) === foldPathOnPlatform(stale))) continue;
          const p = containedJoin(root, stale);
          if (fs.existsSync(p)) fs.rmSync(p, { force: true });
        } catch {
          /* best effort — the diagnostic error below matters more */
        }
      }
      throw e;
    }
  },

  async mrvc_switch_project_type(args) {
    const root = toolRoot(args);
    const cp = requireCproject(root);
    if (typeof args['cpp'] !== 'boolean') {
      throw new ToolError('cpp is required and must be true (convert to C++) or false (convert back to C)');
    }
    const want = args['cpp'];
    const is = cp.isCpp;
    if (want === is) {
      return { ok: true, cpp: is, changed: false, note: `the project is already ${is ? 'C++' : 'C'} — nothing written` };
    }
    const written = withBackup(root, () => {
      const mirrored = setProjectCpp(root, want);
      return { mirrored: mirrored.mirrored };
    });
    return { ok: true, cpp: want, changed: true, ...written };
  },

  async mrvc_list_linked_folders(args) {
    const root = toolRoot(args);
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
    const root = toolRoot(args);
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

  async mrvc_change_linked_folder_target(args) {
    const root = toolRoot(args);
    requireCproject(root);
    const rawName = typeof args['name'] === 'string' ? args['name'].trim() : '';
    if (!rawName) throw new ToolError('name is required — the link name to re-target');
    const newTargetRaw = typeof args['newTarget'] === 'string' ? args['newTarget'].trim() : '';
    if (!newTargetRaw) throw new ToolError('newTarget is required — an absolute directory path');
    if (!path.isAbsolute(newTargetRaw)) throw new ToolError(`newTarget must be an ABSOLUTE path (got "${newTargetRaw}")`);
    const newTarget = path.resolve(newTargetRaw);
    // fold-match the link so a case-variant name resolves to the canonical
    // spelling the .project stores (core writes by EXACT name)
    const foldN = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const present = readProjectFile(root, { repair: false }).linkedResources;
    const link = present.find((l) => foldN(l.name) === foldN(rawName));
    if (!link) {
      throw new ToolError(`no linked folder named "${rawName}" — present: ${present.map((l) => l.name).join(', ') || '(none)'}`);
    }
    // crisp refusal BEFORE any backup — the same pre-check add_linked_folder runs
    assertSafeLinkTarget(root, newTarget);
    const written = withBackup(root, () => {
      const r = changeLinkedFolderTarget(root, link.name, newTarget);
      if (!r) throw new ToolError(`link "${link.name}" has no location element to rewrite`);
      return { name: r.name, locationUri: r.locationUri, location: r.location };
    });
    const usable = !unscannableLinkedTarget(newTarget);
    return {
      ok: true,
      ...written,
      ...(usable
        ? {}
        : {
            warning:
              'the new target is missing or not a readable directory — builds refuse until it resolves (mrvc_repair_project includeStaleLinks can re-point it)',
          }),
    };
  },

  async mrvc_remove_linked_folder(args) {
    const root = toolRoot(args);
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
    const root = toolRoot(args);
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
    const root = toolRoot(args);
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
    const root = toolRoot(args);
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
    const root = toolRoot(args);
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
    const root = toolRoot(args);
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
    const root = toolRoot(args);
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
          ' [computed: ' +
          describePlanFingerprint(fp) +
          ']' +
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

  async mrvc_set_power_output(args) {
    const root = toolRoot(args);
    const cp = requireCproject(root);
    // the human go-ahead: ONE verified manual Power-Off Reset anchors every
    // MCP rail operation — the flash receipt alone does not authorize rail
    // switches (round5 P1)
    const pGate = checkPowerAck(root);
    if (!pGate.ok) throw new ToolError(pGate.message);
    const pAck = pGate.ack;
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) throw new ToolError('no valid MRS install found (see mrvc_get_install_info)');
    const rail: PowerVoltage = args['rail'] === '5v' ? '5v' : args['rail'] === '3v3' ? '3v3' : ('' as PowerVoltage);
    if (!rail) throw new ToolError(`rail must be "3v3" or "5v" (got ${JSON.stringify(args['rail'])})`);
    // the receipt's plan anchors EVERYTHING here (v0.3.8 review H2) — checks
    // run BEFORE any binary/cfg resolution so the destructive dimension is
    // refused first: the rail must be one the user manually exercised (a
    // 3.3V-only board getting a 5V rail off a 3.3V receipt is hardware
    // damage), and the openocd binary + board cfg are bound too, so an
    // arbitrary openocdPath can never reach runProcess. Only delayMs stays
    // flexible. Comparisons fold case: the receipt stores normPath spellings
    // (lowercase drive) while the caller's args resolve to mixed case.
    if (pAck.plan.voltage !== rail) {
      throw new ToolError(
        `the verified Power-Off Reset receipt was recorded at ${pAck.plan.voltage} — switching to ${rail} needs the user to run Power-Off Reset in the MRVC extension at ${rail} once first (each rail is anchored to its own manual verification)`
      );
    }
    const openocdArg =
      typeof args['openocdPath'] === 'string' && args['openocdPath'].trim() ? path.resolve(args['openocdPath'].trim()) : install.openocdExe;
    // a deviating binary is a PLAN deviation, not a missing file — bind it
    // before the existence check so the refusal names the real reason
    if (foldPathOnPlatform(path.resolve(openocdArg)) !== foldPathOnPlatform(path.resolve(pAck.plan.openocdExe))) {
      throw new ToolError('the openocd binary differs from the verified one — recorded: ' + describePowerFingerprint(pAck.plan));
    }
    const openocd = openocdArg;
    if (!fs.existsSync(openocd)) throw new ToolError(`openocd not found: ${openocd}`);
    const boardCfg = selectBoardCfgHeadless(install, root, cp, typeof args['openocdCfg'] === 'string' ? args['openocdCfg'] : undefined);
    if (!fs.existsSync(boardCfg)) throw new ToolError(`board cfg not found: ${boardCfg}`);
    // everything beyond the rail locks to the receipt's plan via the SAME
    // fingerprint the manual verification recorded — openocd binary, board
    // cfg path AND its CONTENT hash (a .cfg tampered after the manual run is
    // caught here exactly like mrvc_power_off_reset catches it). Re-computing
    // with the RECEIPT's own delayMs keeps delayMs flexible (v0.3.8 re-review
    // #1: the path-only compare skipped boardCfgSha)
    const reqFp = fingerprintPowerPlan({ voltage: rail, delayMs: pAck.plan.delayMs, boardCfg, openocdExe: openocd });
    if (!samePowerFingerprint(reqFp, pAck.plan)) {
      throw new ToolError('the power plan differs from the verified one — recorded: ' + describePowerFingerprint(pAck.plan));
    }
    const delayMs = clampPowerOffDelay(typeof args['delayMs'] === 'number' ? args['delayMs'] : 100);
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
        const logPath = freshLogPath(root, buildDir, state === 'off' ? 'mrvc_rail_off' : 'mrvc_rail_on', attempt);
        const passArgs = preparePowerPass({ boardCfg, voltage: rail, state, logPath });
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
      rail,
      delayMs,
      verifiedBy: pAck.time,
      note: 'rail applied off→delay→on at the requested voltage (marker-verified); no MCP-side latch — mrvc_flash follows its own verified plan',
    };
  },

  async mrvc_check_wchlink_firmware(args) {
    const install = resolveInstall(typeof args['mrsInstallPath'] === 'string' ? String(args['mrsInstallPath']) : undefined);
    if (!install) throw new ToolError('no valid MRS install found (see mrvc_get_install_info)');
    const fw = await checkWCHLinkFirmware(install);
    const response: Record<string, unknown> = {
      ok: fw.state !== 'error',
      state: fw.state,
      linkId: fw.linkId ?? null,
      linkName: fw.linkName ?? null,
      currentVersion: fw.currentVersion !== undefined ? formatLinkVersion(fw.currentVersion) : null,
      expectedVersion: fw.expectedVersion !== undefined ? formatLinkVersion(fw.expectedVersion) : null,
    };
    if (fw.error) response['error'] = fw.error;
    if (fw.state === 'upgrade-needed') {
      response['guidance'] =
        `the link firmware ${formatLinkVersion(fw.currentVersion)} is older than the install expects (${formatLinkVersion(fw.expectedVersion)}) — update it with WCH-LinkUtility before downloading; MRVC never flashes the link firmware itself`;
    } else if (fw.state === 'no-link') {
      response['note'] = 'no WCH-Link attached — attach one and retry';
    }
    return response;
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
