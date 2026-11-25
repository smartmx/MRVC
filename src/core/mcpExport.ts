/**
 * MCP server export — the pure decision + file layer (0.3.7, user request).
 *
 * The bundled server lives at <extension>/mcp/mcp-server.js, and VS Code
 * installs every extension version in its OWN folder — an MCP client
 * configured with that path stops finding the server on the next upgrade.
 * "Export AI MCP Server" copies the server to a folder the user owns, in the
 * layout the bundle resolves from at run time:
 *
 *   <dest>/mcp-server.js
 *   <dest>/package.json             marker: name mrvc-mcp-server + version +
 *                                   provenance + install paths + gen pin
 *   <dest>/README.md               client config + upgrade guide (Chinese)
 *   <dest>/node_modules/koffi/...   POSIX only — the FFI runtime of the
 *                                   hardware bridge (Windows drives the WCH
 *                                   library through P/Invoke and needs none)
 *
 * The bundle reads its version from the package.json BESIDE it and loads
 * koffi through the bare require('koffi'); both resolve inside <dest>.
 *
 * Writes use temp + rename and are additive: a byte-identical file is
 * skipped, so a re-export over a running client neither observes a
 * half-written file nor leaves the folder half-deleted. Nothing is ever
 * deleted. The marker is written LAST — it is the commit marker: a failed
 * export never leaves a new-version marker over an old bundle.
 */
import * as fs from 'fs';
import * as path from 'path';
import { foldPathOnPlatform } from './cproject';
import { MrsInstall, selectInstall } from './toolchain';

/** package name of the marker the export writes (and the server looks for) */
export const MCP_EXPORT_PACKAGE_NAME = 'mrvc-mcp-server';
/** the subfolder ALWAYS created under the picked folder (user request: one
 *  obviously-named folder for the export, never loose files). Picking a
 *  folder that is itself named mrvc-mcp uses it directly — no nesting. */
export const MCP_EXPORT_SUBDIR = 'mrvc-mcp';
export const MCP_SERVER_FILE = 'mcp-server.js';

/** koffi files an export carries besides the prebuilds: the JS entry, its
 *  loader, the package manifest and the licence (the .d.ts is compile-time
 *  only and stays behind) */
const KOFFI_FILES = ['package.json', 'index.js', 'indirect.js', 'LICENSE.txt'];

export interface McpExportFile {
  /** absolute source path inside the extension */
  src: string;
  /** path relative to the export folder (native separators) */
  rel: string;
}

export interface McpExportPlan {
  files: McpExportFile[];
  /** extension version stamped into the marker */
  version: string;
  /** the extension installation this export came from (traceability) */
  exportedFrom: string;
  /** the MRS install locations the exporting VS Code had configured — the
   *  headless copy cannot read VS Code settings, so the marker carries them
   *  and the server falls back to them when the conventional locations hold
   *  no install (explicit paths stay strict) */
  installPaths?: McpExportInstallPaths;
  /** the exporting VS Code's `mrvc.mrsVersion` generation pin ('auto' |
   *  'mrs2' | 'mrs3') — without it a copy exported from an MRS2-pinned
   *  machine silently builds with the MRS3 toolchain when both installs are
   *  present (0.3.7 round3 P2.1) */
  mrsVersion?: McpExportVersionPin;
}

export type McpExportVersionPin = 'auto' | 'mrs2' | 'mrs3';

/** the MRS install locations, as the exporting VS Code's settings held them */
export interface McpExportInstallPaths {
  mrs2?: string;
  mrs3?: string;
  toolchainOnly?: string;
}

export type McpExportPlanResult = { ok: true; plan: McpExportPlan } | { ok: false; error: 'no-server' | 'no-manifest' };

/**
 * Collect what an export of this extension carries. `platform` is the host
 * the exported server will run on (a seam: tests pass other values);
 * `installPaths` are the MRS install locations configured in the exporting
 * VS Code (the headless copy cannot read those settings itself).
 */
export function planMcpExport(
  extRoot: string,
  platform: NodeJS.Platform = process.platform,
  installPaths?: McpExportInstallPaths,
  mrsVersion?: string
): McpExportPlanResult {
  const server = path.join(extRoot, 'mcp', MCP_SERVER_FILE);
  if (!fs.existsSync(server)) return { ok: false, error: 'no-server' };
  let version = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extRoot, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch {
    // reported below — the marker must carry a version
  }
  if (!version) return { ok: false, error: 'no-manifest' };

  const files: McpExportFile[] = [{ src: server, rel: MCP_SERVER_FILE }];
  // koffi is the POSIX transport of the hardware bridge only — the Windows
  // bridge is P/Invoke and the vsix ships no win32 prebuild at all
  if (platform !== 'win32') {
    const koffiRoot = path.join(extRoot, 'vendor-ffi', 'node_modules', 'koffi');
    const add = (rel: string): void => {
      const src = path.join(koffiRoot, rel);
      if (fs.existsSync(src)) files.push({ src, rel: path.join('node_modules', 'koffi', rel) });
    };
    for (const f of KOFFI_FILES) add(f);
    // every prebuild present: an installed extension holds exactly the set
    // the vsix ships, so the export mirrors it without a hard-coded list
    const prebuilds = path.join(koffiRoot, 'build', 'koffi');
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(prebuilds, { withFileTypes: true });
    } catch {
      // no prebuilds in this installation — nothing to add
    }
    for (const e of entries) {
      if (e.isDirectory()) add(path.join('build', 'koffi', e.name, 'koffi.node'));
    }
  }
  const clean: McpExportInstallPaths = {};
  for (const [k, v] of Object.entries(installPaths ?? {})) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) clean[k as keyof McpExportInstallPaths] = s;
  }
  const hasPaths = Object.keys(clean).length > 0;
  // only a real generation pin travels — anything else means 'auto'
  const pin: McpExportVersionPin | undefined =
    mrsVersion === 'mrs2' || mrsVersion === 'mrs3' || mrsVersion === 'auto' ? mrsVersion : undefined;
  return {
    ok: true,
    plan: {
      files,
      version,
      exportedFrom: extRoot,
      ...(hasPaths ? { installPaths: clean } : {}),
      ...(pin ? { mrsVersion: pin } : {}),
    },
  };
}

export type McpExportDestMode = 'fresh' | 'update' | 'foreign';

export interface McpExportDest {
  dir: string;
  mode: McpExportDestMode;
  /** version the EXISTING export at dir carries (its marker package.json) —
   *  set only in 'update' mode; the caller uses it to report old→new and to
   *  catch a downgrade (0.3.7: version carried per export, user request) */
  version?: string;
}

/** the export's own marker package.json in dir, when present (the whole
 *  parsed document, name-checked; undefined when absent/unparsable) */
function readMarker(dir: string): (Record<string, unknown> & { version?: string }) | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (!pkg || pkg.name !== MCP_EXPORT_PACKAGE_NAME) return undefined;
    return { ...pkg, version: typeof pkg.version === 'string' ? pkg.version : undefined };
  } catch {
    return undefined;
  }
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function classify(dir: string): McpExportDest {
  const marker = readMarker(dir);
  if (marker) return { dir, mode: 'update', version: marker.version };
  // a missing directory (the dialog only returns existing folders, but the
  // picked path may vanish before the write) behaves like an empty one
  if (!fs.existsSync(dir) || isEmptyDir(dir)) return { dir, mode: 'fresh' };
  return { dir, mode: 'foreign' };
}

/**
 * Where the files land for the folder the user picked — ALWAYS the mrvc-mcp
 * subfolder of it (0.3.7, user request: the export is one obviously-named
 * folder, never loose files beside the user's own content; the client config
 * points there and stays stable across re-exports to the same place). That
 * subfolder is classified in turn, so a previous export is updated in place
 * and a foreign one comes back as 'foreign' for the caller to confirm.
 *
 * Exception: picking a folder that is ITSELF called mrvc-mcp (case-folded on
 * Windows) uses it directly — otherwise re-exporting at an existing export
 * location (or at any previous version's folder with that name) would nest
 * a second mrvc-mcp inside it.
 */
export function resolveMcpExportDest(picked: string): McpExportDest {
  if (foldPathOnPlatform(path.basename(picked)) === MCP_EXPORT_SUBDIR) return classify(picked);
  return classify(path.join(picked, MCP_EXPORT_SUBDIR));
}

/** compare two dotted versions numerically per segment ('0.3.9' < '0.3.10').
 *  Missing segments count as 0, so '1.0' === '1.0.0'; non-numeric segments
 *  count as 0 too — the marker only ever carries the extension's own
 *  numeric version, this exists to catch a DOWNGRADE (round: user request). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((p) => parseInt(p, 10));
  const pb = b.split('.').map((p) => parseInt(p, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** physical location of a path that may not exist yet: the nearest EXISTING
 *  ancestor is resolved through symlinks/junctions and the missing tail is
 *  re-appended (an export destination usually does not exist yet) */
function physicalPath(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** true when `child` is `parent` itself or lies underneath it — by PHYSICAL
 *  location (symlinks/junctions resolved on both sides: a junction that
 *  points into the installation must not slip the export past the guard —
 *  0.3.7 round1 P3.4), case-folded on Windows */
export function isInsideDir(child: string, parent: string): boolean {
  const c = foldPathOnPlatform(physicalPath(child));
  const p = foldPathOnPlatform(physicalPath(parent));
  return c === p || c.startsWith(p + path.sep);
}

export interface McpExportApplyResult {
  /** files created or rewritten */
  written: number;
  /** files already byte-identical (untouched) */
  skipped: number;
}

/** true when the file on disk holds exactly these bytes */
function sameBytes(file: string, bytes: Buffer): boolean {
  try {
    if (fs.statSync(file).size !== bytes.length) return false;
    return fs.readFileSync(file).equals(bytes);
  } catch {
    return false;
  }
}

/**
 * Write the export into destDir. Temp + rename and additive — see the header.
 * Throws on the first file that cannot be written (a locked native module,
 * a read-only folder); whatever was written before stays, and nothing is
 * removed, so the folder never ends up emptier than it started.
 */
export function applyMcpExport(plan: McpExportPlan, destDir: string): McpExportApplyResult {
  fs.mkdirSync(destDir, { recursive: true });
  const marker = JSON.stringify(
    {
      name: MCP_EXPORT_PACKAGE_NAME,
      version: plan.version,
      private: true,
      description: 'MRVC MCP server, exported by the MRVC VS Code extension. Re-export after upgrading the extension (Project Explorer ... > Export AI MCP Server).',
      // provenance + the MRS install locations configured in the exporting
      // VS Code (the headless copy cannot read VS Code settings; tools.ts
      // falls back to installPaths when the conventional locations miss).
      // Keys mirror the settings names — a human reading the marker sees
      // exactly what the extension's settings page holds. mrsVersion is the
      // generation pin: without it a copy exported from an MRS2-pinned
      // machine would auto-pick MRS3 when both installs are present.
      mrvc: {
        exportedFrom: plan.exportedFrom,
        ...(plan.installPaths
          ? {
              installPaths: {
                ...(plan.installPaths.mrs2 ? { mrs2InstallPath: plan.installPaths.mrs2 } : {}),
                ...(plan.installPaths.mrs3 ? { mrs3InstallPath: plan.installPaths.mrs3 } : {}),
                ...(plan.installPaths.toolchainOnly ? { toolchainOnlyPath: plan.installPaths.toolchainOnly } : {}),
              },
            }
          : {}),
        ...(plan.mrsVersion ? { mrsVersion: plan.mrsVersion } : {}),
      },
    },
    null,
    2
  ) + '\n';
  let written = 0;
  let skipped = 0;
  const put = (target: string, bytes: Buffer): void => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && sameBytes(target, bytes)) {
      skipped++;
      return;
    }
    // temp + rename, never an in-place write: the rename swaps the directory
    // entry atomically, so a reader (the exported server running under an
    // MCP client) can never observe a half-written file — and on POSIX an
    // in-place write over a MAPPED native module (koffi.node loaded by a
    // running client) could corrupt the mapped image. Windows rename over an
    // OPEN file throws instead — the export then reports failure rather than
    // half-updating a running copy.
    const temp = `${target}.${process.pid}.mrvc-tmp`;
    try {
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, target);
    } catch (e) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // the temp was never created — nothing to clean
      }
      throw e;
    }
    written++;
  };
  // payload FIRST, marker LAST — the marker is the commit marker: a failed
  // export must never leave a new-version marker standing over an old or
  // missing bundle (0.3.7 round3 P3.1). All payloads are read before the
  // first write, so an unreadable source throws without touching the
  // destination at all.
  const payloads = plan.files.map((f) => ({ target: path.join(destDir, f.rel), bytes: fs.readFileSync(f.src) }));
  for (const p of payloads) put(p.target, p.bytes);
  // a small README (0.3.7, user request: the folder carries "some
  // configuration" too): what this folder is, the client config for THIS
  // server, the env vars, and how upgrades work. Content-only — it changes
  // with the version/provenance and is written BEFORE the commit marker.
  const readme = [
    '# MRVC MCP 服务器',
    '',
    `本目录由 MRVC 扩展的「导出 AI MCP 服务器」命令生成（扩展版本 ${plan.version}）。`,
    '',
    '## MCP 客户端配置',
    '',
    '```json',
    JSON.stringify({ command: 'node', args: [path.join(destDir, MCP_SERVER_FILE)] }, null, 2),
    '```',
    '',
    '## 可选环境变量',
    '',
    '- `MRVC_MRS_INSTALL_PATH` — MRS 安装根（未设置时依次尝试惯例位置与本目录 package.json 记录的路径）',
    '- `MRVC_MCP_DEFAULT_ROOT` — `mrvc_discover_projects` 的默认扫描根',
    '',
    '## 升级',
    '',
    'MRVC 扩展更新后，在 Project Explorer 的 `…` 菜单重新执行「导出 AI MCP 服务器」并选择同一位置即可更新本目录（只重写有变化的文件，从不删除）。',
    '',
    `导出来源：${plan.exportedFrom}`,
    '',
  ].join('\n');
  put(path.join(destDir, 'README.md'), Buffer.from(readme, 'utf8'));
  put(path.join(destDir, 'package.json'), Buffer.from(marker, 'utf8'));
  return { written, skipped };
}

/** the stdio server entry every MCP client config embeds under a name of
 *  its own — a plain object, JSON-escaped (Windows backslashes included) */
export function mcpClientConfig(serverPath: string): string {
  return JSON.stringify({ command: 'node', args: [serverPath] }, null, 2);
}

export interface McpExportRecord {
  /** the version the export was made from */
  version?: string;
  /** the extension installation the export came from */
  exportedFrom?: string;
  /** MRS install locations recorded at export time (trimmed; empty strings dropped) */
  installPaths: McpExportInstallPaths;
  /** the exporting VS Code's generation pin ('auto' | 'mrs2' | 'mrs3';
   *  undefined = auto) */
  mrsVersion?: McpExportVersionPin;
}

/** read a folder's export marker (name-checked) as a record: version,
 *  provenance, the recorded MRS install locations and the generation pin.
 *  Undefined for a foreign or missing marker. */
export function readExportRecord(dir: string): McpExportRecord | undefined {
  const marker = readMarker(dir);
  if (!marker) return undefined;
  const block = marker.mrvc;
  const obj = block && typeof block === 'object' ? (block as Record<string, unknown>) : undefined;
  const ip = obj && typeof obj.installPaths === 'object' && obj.installPaths !== null ? (obj.installPaths as Record<string, unknown>) : undefined;
  const pick = (key: string): string | undefined => {
    const v = ip?.[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const rawPin = obj?.mrsVersion;
  return {
    version: marker.version,
    exportedFrom: typeof obj?.exportedFrom === 'string' ? obj.exportedFrom : undefined,
    installPaths: { mrs2: pick('mrs2InstallPath'), mrs3: pick('mrs3InstallPath'), toolchainOnly: pick('toolchainOnlyPath') },
    mrsVersion: rawPin === 'mrs2' || rawPin === 'mrs3' || rawPin === 'auto' ? rawPin : undefined,
  };
}

/**
 * The MRS install the RECORDED locations resolve to — the same policy the
 * exporting VS Code applied to its settings (per-generation validation, the
 * SAME `mrvc.mrsVersion` pin, auto preference IDE3 → IDE2 → standalone), so
 * the exported copy behaves like the extension on the machine it was made
 * on. Null when no recorded location validates.
 */
export function installFromRecord(rec: McpExportRecord): MrsInstall | null {
  const ip = rec.installPaths;
  if (!ip.mrs2 && !ip.mrs3 && !ip.toolchainOnly) return null;
  return selectInstall({ mrs2Path: ip.mrs2, mrs3Path: ip.mrs3, toolchainPath: ip.toolchainOnly, version: rec.mrsVersion }).install ?? null;
}
