/*
 * "Export AI MCP Server" tests (0.3.7):
 *  1. the export plan — which files, per host platform (koffi is the POSIX
 *     transport of the hardware bridge only)
 *  2. the destination rules — empty folder / previous export / foreign folder
 *  3. the in-place additive write — identical files untouched, nothing deleted
 *  4. the command layer against a vscode stub (dialog, confirm, messages)
 *  5. wiring — package.json command + ... menu, NLS titles, registration
 *  6. a REAL smoke run of both server layouts: bundled in the extension and
 *     exported to a foreign folder — the copy must start and report the
 *     version the export stamped into the package.json beside it
 *
 * Run: node tools/mcpexport-test.js   (needs `npx tsc` for out/, and
 *     `node esbuild.js` for the mcp/mcp-server.js bundle of the smoke run)
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail === undefined ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const DEV = path.join(__dirname, '..');
const ROOT = path.join(DEV, '.scratch', 'mcpexport');
fs.rmSync(ROOT, { recursive: true, force: true });
const exists = (p) => fs.existsSync(p);
const text = (p) => fs.readFileSync(p, 'utf8');

/** containment guard: every fixture write goes through here */
function inside(root, rel) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, rel);
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
    throw new Error('fixture path escapes its root: ' + target);
  }
  return target;
}
const writeFile = (root, rel, body) => {
  const file = inside(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const scratch = (...names) => inside(ROOT, path.join(...names));

// ---- fixture: a fake extension root ------------------------------------------
const EXT = scratch('ext');
const BUNDLE_V1 = '// fake bundle v1\n';
writeFile(EXT, 'mcp/mcp-server.js', BUNDLE_V1);
writeFile(EXT, 'package.json', JSON.stringify({ name: 'mrvc', version: '9.8.7', contributes: {} }));
const K = 'vendor-ffi/node_modules/koffi/';
writeFile(EXT, K + 'package.json', '{"name":"koffi","version":"1.1.0"}');
writeFile(EXT, K + 'index.js', '// koffi entry');
writeFile(EXT, K + 'indirect.js', '// indirect');
writeFile(EXT, K + 'LICENSE.txt', 'MIT');
// none of these may ever enter an export
writeFile(EXT, K + 'index.d.ts', 'declare module "koffi" {}');
writeFile(EXT, K + 'README.md', '# not shipped');
writeFile(EXT, K + 'src/koffi.cc', '// source');
writeFile(EXT, K + 'doc/index.md', '# doc');
writeFile(EXT, K + 'build/koffi/linux_x64/koffi.node', 'ELF-linux');
writeFile(EXT, K + 'build/koffi/linux_x64/koffi.node.sha1', 'sidecar');
writeFile(EXT, K + 'build/koffi/darwin_arm64/koffi.node', 'MACHO-arm64');

const core = require('../out/core/mcpExport.js');
const posix = (p) => p.split(path.sep).join('/');

// ---- 1. plan -----------------------------------------------------------------
const win = core.planMcpExport(EXT, 'win32');
check(
  'plan: win32 carries the server alone (the Windows bridge is P/Invoke)',
  win.ok && win.plan.files.length === 1 && win.plan.files[0].rel === 'mcp-server.js' && win.plan.version === '9.8.7',
  JSON.stringify(win)
);
const POSIX_SET = [
  'mcp-server.js',
  'node_modules/koffi/package.json',
  'node_modules/koffi/index.js',
  'node_modules/koffi/indirect.js',
  'node_modules/koffi/LICENSE.txt',
  'node_modules/koffi/build/koffi/darwin_arm64/koffi.node',
  'node_modules/koffi/build/koffi/linux_x64/koffi.node',
];
const lin = core.planMcpExport(EXT, 'linux');
const linRels = lin.ok ? lin.plan.files.map((f) => posix(f.rel)) : [];
check('plan: linux carries the koffi runtime beside the server', JSON.stringify(linRels) === JSON.stringify(POSIX_SET), JSON.stringify(linRels));
for (const platform of ['darwin', 'freebsd']) {
  const p = core.planMcpExport(EXT, platform);
  check(`plan: ${platform} carries the same posix set`, p.ok && JSON.stringify(p.plan.files.map((f) => posix(f.rel))) === JSON.stringify(POSIX_SET));
}
check(
  'plan: types, docs, sources and checksum sidecars stay behind',
  !linRels.some((r) => r.includes('index.d.ts') || r.includes('README') || r.includes('/src/') || r.includes('/doc/') || r.includes('.sha1')),
  JSON.stringify(linRels)
);
check(
  'plan: every planned source exists inside the extension',
  lin.ok && lin.plan.files.every((f) => exists(f.src) && path.resolve(f.src).startsWith(path.resolve(EXT) + path.sep))
);
const NO_EXT = scratch('no-ext');
check(
  'plan: a missing bundle is reported, never an empty export',
  JSON.stringify(core.planMcpExport(NO_EXT, 'win32')) === '{"ok":false,"error":"no-server"}',
  JSON.stringify(core.planMcpExport(NO_EXT, 'win32'))
);
const NO_MANIFEST = scratch('no-manifest');
writeFile(NO_MANIFEST, 'mcp/mcp-server.js', BUNDLE_V1);
check('plan: a bundle without package.json is reported', JSON.stringify(core.planMcpExport(NO_MANIFEST, 'win32')) === '{"ok":false,"error":"no-manifest"}');
const BAD_VERSION = scratch('bad-version');
writeFile(BAD_VERSION, 'mcp/mcp-server.js', BUNDLE_V1);
writeFile(BAD_VERSION, 'package.json', '{"name":"mrvc"}');
check('plan: a manifest without a version string is reported', core.planMcpExport(BAD_VERSION, 'win32').error === 'no-manifest');

// ---- 2. destination rules ------------------------------------------------------
// the export ALWAYS lands in the mrvc-mcp subfolder of the picked folder
// (0.3.7, user request: one obviously-named folder, never loose files)
const D = (name) => scratch('dest', name);
const SUB = (picked) => path.join(picked, 'mrvc-mcp');
check(
  'dest: a missing picked folder gets the created mrvc-mcp subfolder',
  JSON.stringify(core.resolveMcpExportDest(D('missing'))) === JSON.stringify({ dir: SUB(D('missing')), mode: 'fresh' }),
  JSON.stringify(core.resolveMcpExportDest(D('missing')))
);
fs.mkdirSync(D('empty'), { recursive: true });
check('dest: an empty picked folder gets the mrvc-mcp subfolder', core.resolveMcpExportDest(D('empty')).mode === 'fresh' && core.resolveMcpExportDest(D('empty')).dir === SUB(D('empty')));
// picking the mrvc-mcp folder ITSELF (e.g. re-exporting at an existing
// export location) uses it directly — never nests mrvc-mcp/mrvc-mcp
fs.mkdirSync(SUB(D('self')), { recursive: true });
core.applyMcpExport(win.plan, SUB(D('self')));
const selfDest = core.resolveMcpExportDest(SUB(D('self')));
check('dest: picking the mrvc-mcp folder itself uses it directly (no nesting)', selfDest.dir === SUB(D('self')) && selfDest.mode === 'update', JSON.stringify(selfDest));
fs.mkdirSync(path.join(D('self-foreign'), 'mrvc-mcp'), { recursive: true });
fs.writeFileSync(path.join(D('self-foreign'), 'mrvc-mcp', 'other.txt'), 'other');
const selfForeign = core.resolveMcpExportDest(SUB(D('self-foreign')));
check('dest: a foreign folder named mrvc-mcp is still classified (not nested)', selfForeign.dir === SUB(D('self-foreign')) && selfForeign.mode === 'foreign', JSON.stringify(selfForeign));
fs.mkdirSync(D('ours'), { recursive: true });
core.applyMcpExport(win.plan, SUB(D('ours')));
check('dest: a previous export in the subfolder is updated in place', core.resolveMcpExportDest(D('ours')).mode === 'update' && core.resolveMcpExportDest(D('ours')).dir === SUB(D('ours')));
fs.mkdirSync(D('full'), { recursive: true });
fs.writeFileSync(path.join(D('full'), 'other.txt'), 'other');
const fullDest = core.resolveMcpExportDest(D('full'));
check(
  'dest: a foreign non-empty folder gets the mrvc-mcp subfolder — never itself',
  fullDest.mode === 'fresh' && fullDest.dir === SUB(D('full')),
  JSON.stringify(fullDest)
);
core.applyMcpExport(win.plan, fullDest.dir);
const oursAgain = core.resolveMcpExportDest(D('full'));
check('dest: ...and that subfolder is recognized as ours next time', oursAgain.mode === 'update');
// the marker carries the exported MRVC version (0.3.7, user request) — the
// caller uses it to report old→new and to catch a downgrade
check('dest: an existing export reports the version its marker stamps', oursAgain.version === '9.8.7', JSON.stringify(oursAgain));
check('dest: a fresh destination carries no version', core.resolveMcpExportDest(D('missing')).version === undefined);

// ---- version comparison (numeric per segment, never lexicographic) ----
const V = [
  [['0.3.9', '0.3.10'], -1], // the string sort would get this wrong
  [['0.3.10', '0.3.9'], 1],
  [['0.3.7', '0.3.7'], 0],
  [['1.0', '1.0.0'], 0], // missing segments count as 0
  [['1.0', '0.9.9'], 1],
  [['2', '1.9.9'], 1],
  [['10.0.0', '9.99.99'], 1],
];
for (const [[a2, b2], want] of V) {
  check(`versions: compareVersions(${a2}, ${b2}) === ${want}`, core.compareVersions(a2, b2) === want, String(core.compareVersions(a2, b2)));
}

// ---- provenance + recorded MRS install locations in the marker (0.3.7:
//      the headless copy cannot read VS Code settings, so Export carries
//      them and the server falls back to them when the conventional
//      locations hold no install) ----
const REC_DIR = D('record');
const recPlan = core.planMcpExport(EXT, 'win32', { mrs2: '  X:/custom/mrs2  ', toolchainOnly: 'X:/tc', mrs3: '   ' });
check('record: the plan keeps the non-empty locations trimmed', !!recPlan.ok && JSON.stringify(recPlan.plan.installPaths) === '{"mrs2":"X:/custom/mrs2","toolchainOnly":"X:/tc"}', JSON.stringify(recPlan.ok ? recPlan.plan.installPaths : recPlan));
check('record: the plan names the exporting extension', !!recPlan.ok && recPlan.plan.exportedFrom === EXT);
core.applyMcpExport(recPlan.plan, REC_DIR);
const recMarker = JSON.parse(text(path.join(REC_DIR, 'package.json')));
check(
  'record: the marker carries provenance + the install locations',
  recMarker.mrvc && recMarker.mrvc.exportedFrom === EXT && JSON.stringify(recMarker.mrvc.installPaths) === '{"mrs2InstallPath":"X:/custom/mrs2","toolchainOnlyPath":"X:/tc"}',
  JSON.stringify(recMarker.mrvc)
);
const recRead = core.readExportRecord(REC_DIR);
check(
  'record: readExportRecord round-trips version, provenance and locations',
  !!recRead && recRead.version === '9.8.7' && recRead.exportedFrom === EXT && recRead.installPaths.mrs2 === 'X:/custom/mrs2' && recRead.installPaths.mrs3 === undefined && recRead.installPaths.toolchainOnly === 'X:/tc',
  JSON.stringify(recRead)
);
check(
  'record: a foreign folder reads as no record; a missing folder too',
  core.readExportRecord(D('full2')) === undefined && core.readExportRecord(D('missing')) === undefined
);

// the recorded locations resolve like the exporting VS Code's settings did
// (core selectInstall: per-generation validation, auto preference)
const FAKE_MRS2 = scratch('fake-mrs2-record');
{
  const res = path.join(FAKE_MRS2, 'resources', 'app', 'resources', 'win32');
  fs.mkdirSync(path.join(res, 'components', 'WCH'), { recursive: true });
  fs.writeFileSync(path.join(res, 'components', 'WCH', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(FAKE_MRS2, 'resources', 'app', 'product.json'), JSON.stringify({ nameShort: 'MounRiver Studio 2', mrsVersion: '2.0.0' }));
  fs.writeFileSync(path.join(FAKE_MRS2, 'MounRiver Studio 2.exe'), '');
}
{
  const hit = core.installFromRecord({ installPaths: { mrs2: FAKE_MRS2 } });
  check('record: a recorded MRS2 location resolves to that install', !!hit && path.resolve(hit.root) === path.resolve(FAKE_MRS2) && hit.flavor === 'mrs2', JSON.stringify(hit && hit.root));
  const miss = core.installFromRecord({ installPaths: { mrs2: scratch('not-an-install'), mrs3: 'X:/gone', toolchainOnly: 'X:/also-gone' } });
  check('record: locations that validate to nothing resolve to null', miss === null || miss === undefined, JSON.stringify(miss));
  check('record: an all-empty record resolves to null', core.installFromRecord({ installPaths: {} }) === null);
}

// the generation pin travels with the export (0.3.7 round3 P2.1): without it
// a copy exported from an MRS2-pinned machine silently picked the MRS3
// toolchain when both installs were present
const FAKE_MRS3 = scratch('fake-mrs3-record');
{
  const res = path.join(FAKE_MRS3, 'resources', 'app', 'resources', 'win32');
  fs.mkdirSync(path.join(res, 'components', 'WCH'), { recursive: true });
  fs.writeFileSync(path.join(res, 'components', 'WCH', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(FAKE_MRS3, 'resources', 'app', 'product.json'), JSON.stringify({ nameShort: 'MounRiver Studio 3', mrsVersion: '3.0.0' }));
  fs.writeFileSync(path.join(FAKE_MRS3, 'MounRiver Studio 3.exe'), '');
}
const BOTH = { installPaths: { mrs2: FAKE_MRS2, mrs3: FAKE_MRS3 } };
const flavorOf = (inst) => (inst ? inst.flavor : String(inst));
check('pin: auto prefers the MRS3 install (IDE3 first)', flavorOf(core.installFromRecord(BOTH)) === 'mrs3', flavorOf(core.installFromRecord(BOTH)));
check('pin: mrs2 keeps the install the exporting VS Code was pinned to', flavorOf(core.installFromRecord({ ...BOTH, mrsVersion: 'mrs2' })) === 'mrs2');
check('pin: mrs3 keeps the MRS3 install', flavorOf(core.installFromRecord({ ...BOTH, mrsVersion: 'mrs3' })) === 'mrs3');
const pinPlan = core.planMcpExport(EXT, 'win32', undefined, 'mrs2');
check('pin: the plan carries a real generation pin', !!pinPlan.ok && pinPlan.plan.mrsVersion === 'mrs2');
const oddPlan = core.planMcpExport(EXT, 'win32', undefined, 'yes');
check('pin: anything but auto/mrs2/mrs3 degrades to no pin', !!oddPlan.ok && oddPlan.plan.mrsVersion === undefined);
fs.mkdirSync(D('pin'), { recursive: true });
fs.writeFileSync(path.join(D('pin'), 'package.json'), JSON.stringify({ name: 'mrvc-mcp-server', version: '1', mrvc: { mrsVersion: 'mrs2' } }));
check('pin: the marker pin reads back', core.readExportRecord(D('pin')).mrsVersion === 'mrs2');
fs.writeFileSync(path.join(D('pin'), 'package.json'), JSON.stringify({ name: 'mrvc-mcp-server', version: '1', mrvc: { mrsVersion: 'weird' } }));
check('pin: a hand-edited bogus pin reads back as auto', core.readExportRecord(D('pin')).mrsVersion === undefined);
fs.mkdirSync(path.join(D('full2'), 'mrvc-mcp'), { recursive: true });
fs.writeFileSync(path.join(D('full2'), 'other.txt'), 'other');
fs.writeFileSync(path.join(D('full2'), 'mrvc-mcp', 'keep.txt'), 'keep');
const foreignSub = core.resolveMcpExportDest(D('full2'));
check('dest: a foreign mrvc-mcp subfolder needs confirmation', foreignSub.mode === 'foreign' && foreignSub.dir === SUB(D('full2')), JSON.stringify(foreignSub));
check('dest: a foreign destination carries no version', foreignSub.version === undefined);
fs.mkdirSync(D('pkg'), { recursive: true });
fs.writeFileSync(path.join(D('pkg'), 'package.json'), '{"name":"someone-else","version":"1.0.0"}');
check(
  'dest: somebody else\'s package.json does not pass for ours',
  core.resolveMcpExportDest(D('pkg')).dir === SUB(D('pkg')),
  JSON.stringify(core.resolveMcpExportDest(D('pkg')))
);
// an unreadable package.json directly in the picked folder does not matter
// (the export always lands in the subfolder) — an unreadable one in the
// SUBFOLDER does: the subfolder reads as foreign and needs confirmation
fs.mkdirSync(D('broken-marker'), { recursive: true });
fs.writeFileSync(path.join(D('broken-marker'), 'package.json'), '{ not json');
const brokenFresh = core.resolveMcpExportDest(D('broken-marker'));
check(
  'dest: an unreadable picked package.json is ignored — the export still uses the subfolder',
  brokenFresh.dir === SUB(D('broken-marker')) && brokenFresh.mode === 'fresh',
  JSON.stringify(brokenFresh)
);
fs.mkdirSync(path.join(D('broken-marker'), 'mrvc-mcp'), { recursive: true });
fs.writeFileSync(path.join(D('broken-marker'), 'mrvc-mcp', 'package.json'), '{ not json');
fs.writeFileSync(path.join(D('broken-marker'), 'mrvc-mcp', 'x.txt'), 'x');
check('dest: ...an unreadable package.json IN the subfolder makes it foreign', core.resolveMcpExportDest(D('broken-marker')).mode === 'foreign');

// ---- 3. the write ---------------------------------------------------------------
const OUT = D('out');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'notes.txt'), 'keep me');
const first = core.applyMcpExport(lin.plan, OUT);
// payloads + README.md + the commit marker
check('apply: the first run writes payloads, README and the marker', first.written === lin.plan.files.length + 2 && first.skipped === 0, JSON.stringify(first));
const marker = JSON.parse(text(path.join(OUT, 'package.json')));
check(
  'apply: the marker names the export and stamps the version',
  marker.name === core.MCP_EXPORT_PACKAGE_NAME && marker.version === '9.8.7' && marker.private === true,
  JSON.stringify(marker)
);
check(
  'record: a plan without locations still stamps provenance (no empty block)',
  marker.mrvc && marker.mrvc.exportedFrom === EXT && marker.mrvc.installPaths === undefined,
  JSON.stringify(marker.mrvc)
);
// the README is the human-facing configuration sheet (user request: the
// folder carries "mcp-server.js and some configuration")
const readme = text(path.join(OUT, 'README.md'));
check(
  'apply: the README names the version, the client config and the source',
  readme.includes('# MRVC MCP 服务器') &&
    readme.includes(`扩展版本 ${'9.8.7'}`) &&
    readme.includes(JSON.stringify({ command: 'node', args: [path.join(OUT, 'mcp-server.js')] }, null, 2)) &&
    readme.includes('MRVC_MRS_INSTALL_PATH') &&
    readme.includes(`导出来源：${EXT}`),
  readme.slice(0, 300)
);
check('apply: the server lands at <dest>/mcp-server.js byte-identical', text(path.join(OUT, 'mcp-server.js')) === BUNDLE_V1);
const linuxNode = path.join(OUT, 'node_modules', 'koffi', 'build', 'koffi', 'linux_x64', 'koffi.node');
check(
  'apply: koffi keeps its internal layout under node_modules',
  text(linuxNode) === 'ELF-linux' && text(path.join(OUT, 'node_modules', 'koffi', 'index.js')) === '// koffi entry'
);
check('apply: nothing that was there gets deleted', text(path.join(OUT, 'notes.txt')) === 'keep me');
// the write is temp + rename: no staging file may survive a successful apply
const tmpLeft = [];
const scanTmp = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scanTmp(full);
    else if (e.name.includes('.mrvc-tmp')) tmpLeft.push(full);
  }
};
scanTmp(OUT);
check('apply: no staging (.mrvc-tmp) file survives a successful apply', tmpLeft.length === 0, JSON.stringify(tmpLeft));
const again = core.applyMcpExport(lin.plan, OUT);
check('apply: re-exporting the same build touches nothing', again.written === 0 && again.skipped === first.written, JSON.stringify(again));
writeFile(EXT, 'mcp/mcp-server.js', '// fake bundle v2\n');
writeFile(EXT, 'package.json', JSON.stringify({ name: 'mrvc', version: '9.8.8', contributes: {} }));
const v2 = core.planMcpExport(EXT, 'linux');
const upd = core.applyMcpExport(v2.plan, OUT);
// bundle + version-stamped marker + README all carry the new build
check('apply: a new build rewrites only what changed (bundle + marker + README)', upd.written === 3 && upd.skipped === first.written - 3, JSON.stringify(upd));
check('apply: the marker carries the new version', JSON.parse(text(path.join(OUT, 'package.json'))).version === '9.8.8');
check('apply: the README carries the new version too', text(path.join(OUT, 'README.md')).includes('扩展版本 9.8.8'));
check('apply: the untouched native module is still the original', text(linuxNode) === 'ELF-linux');
// a destination that cannot be created (a FILE sits where the folder must go)
// throws instead of reporting success
const AFILE = D('afile');
fs.writeFileSync(AFILE, 'x');
let threw = false;
try {
  core.applyMcpExport(win.plan, AFILE);
} catch {
  threw = true;
}
check('apply: an unwritable destination throws (no silent success)', threw);
check('apply: the failed run left the file in place', text(AFILE) === 'x');
// the failure path cleans its staging file too (no .mrvc-tmp debris anywhere)
{
  const failTmp = [];
  const scanFail = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scanFail(full);
      else if (e.name.includes('.mrvc-tmp')) failTmp.push(full);
    }
  };
  scanFail(ROOT);
  check('apply: a failed run leaves no staging (.mrvc-tmp) debris', failTmp.length === 0, JSON.stringify(failTmp));
}

// ---- 4. containment helper + client config -------------------------------------
check(
  'isInsideDir: self / child are inside; an ancestor and a sibling are not',
  core.isInsideDir(EXT, EXT) && core.isInsideDir(path.join(EXT, 'mcp'), EXT) && !core.isInsideDir(ROOT, EXT) && !core.isInsideDir(scratch('ext2'), EXT)
);
check('isInsideDir: Windows case variants fold', process.platform !== 'win32' || core.isInsideDir(EXT.toUpperCase(), EXT));
// the guard is PHYSICAL (0.3.7 round1 P3.4): a junction/symlink pointing INTO
// the installation must be recognized — and one INSIDE the installation that
// points out is physically outside, so exporting through it is legitimate
const LINK_IN = scratch('link-to-ext'); // lives outside, points at EXT
let linkMade = true;
try {
  fs.symlinkSync(EXT, LINK_IN, process.platform === 'win32' ? 'junction' : 'dir');
} catch (e) {
  linkMade = false;
  console.log('SKIP  the symlink fixture could not be created: ' + e.message);
}
if (linkMade) {
  check(
    'isInsideDir: a junction/symlink INTO the installation is inside it (also for a not-yet-existing tail)',
    core.isInsideDir(path.join(LINK_IN, 'mcp'), EXT) && core.isInsideDir(path.join(LINK_IN, 'not-yet', 'deeper'), EXT)
  );
  const OUTSIDE = scratch('outside');
  fs.mkdirSync(OUTSIDE, { recursive: true });
  const LINK_OUT = inside(EXT, 'link-out'); // lives inside EXT, points out
  fs.symlinkSync(OUTSIDE, LINK_OUT, process.platform === 'win32' ? 'junction' : 'dir');
  check(
    'isInsideDir: a link INSIDE the installation that points OUT is physically outside (not inside)',
    !core.isInsideDir(path.join(LINK_OUT, 'x'), EXT) && core.isInsideDir(path.join(LINK_OUT, 'x'), OUTSIDE)
  );
  fs.unlinkSync(LINK_OUT); // the link itself only — OUTSIDE stays
  check('isInsideDir: removing the outward link leaves its target alone', exists(OUTSIDE) && !exists(LINK_OUT));
}
const cfgPath = path.join('D:', 'mcp tools', 'mrvc-mcp', 'mcp-server.js');
const cfg = JSON.parse(core.mcpClientConfig(cfgPath));
check('client config: command node + the server path, round-trips through JSON', cfg.command === 'node' && cfg.args.length === 1 && cfg.args[0] === cfgPath, core.mcpClientConfig(cfgPath));

// ---- 5. command layer against a vscode stub -------------------------------------
const ui = { errors: [], infos: [], warnings: [], status: [] };
let dialogPick = undefined;
let dialogOpts = undefined;
let dialogCalls = 0;
let infoAction = undefined;
let warnPick = undefined;
let clipboard = '';
const executed = [];
const globalState = new Map();
let mrvcSettings = {};
const vscodeStub = {
  // the MRS install path settings the export command stamps into the marker
  // (programmable per command-layer step; reset() clears)
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in mrvcSettings ? mrvcSettings[k] : d) }) },
  window: {
    showOpenDialog: async (opts) => {
      dialogCalls++;
      dialogOpts = opts;
      return dialogPick;
    },
    showErrorMessage: (m) => ui.errors.push(String(m)),
    showInformationMessage: async (m, ...actions) => {
      ui.infos.push({ text: String(m), actions });
      return infoAction;
    },
    showWarningMessage: async (m, opts, ...actions) => {
      ui.warnings.push({ text: String(m), modal: !!(opts && opts.modal), actions });
      return warnPick;
    },
    setStatusBarMessage: (m) => ui.status.push(String(m)),
  },
  env: { clipboard: { writeText: async (s) => { clipboard = s; } } },
  Uri: { file: (p) => ({ fsPath: p }) },
  commands: { executeCommand: (cmd, arg) => { executed.push([cmd, arg && arg.fsPath]); } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain) {
  if (request === 'vscode') return 'vscode-mcpexport-stub';
  return origResolve.call(this, request, parent, isMain);
};
require.cache['vscode-mcpexport-stub'] = { id: 'vscode-mcpexport-stub', filename: 'vscode-mcpexport-stub', loaded: true, exports: vscodeStub };
const { exportMcpServerCmd } = require('../out/vscode/mcpExport.js');
const { t } = require('../out/core/i18n.js');
const ctx = (extensionPath) => ({
  extensionPath,
  globalState: {
    get: (k) => globalState.get(k),
    update: async (k, v) => {
      globalState.set(k, v);
    },
  },
});
const reset = () => {
  ui.errors.length = 0;
  ui.infos.length = 0;
  ui.warnings.length = 0;
  ui.status.length = 0;
  executed.length = 0;
  dialogOpts = undefined;
  infoAction = undefined;
  warnPick = undefined;
  clipboard = '';
  mrvcSettings = {};
};

// ---- 6. wiring -------------------------------------------------------------------
const pkg = JSON.parse(text(path.join(DEV, 'package.json')));
check('wiring: the command is contributed', pkg.contributes.commands.some((c) => c.command === 'mrvc.exportMcp'));
const menu = pkg.contributes.menus['view/title'].find((i) => i.command === 'mrvc.exportMcp');
check('wiring: the ... menu lists it for the view, with no project required', !!menu && menu.when === 'view == mrvc.projectExplorer', menu && menu.when);
const clearItem = pkg.contributes.menus['view/title'].find((i) => i.command === 'mrvc.clearIntelliSenseCache');
check(
  'wiring: it sits directly ABOVE Clear C/C++ IntelliSense Cache (user request 2026-11-24)',
  !!menu && menu.group === '5_settings@1' && !!clearItem && clearItem.group === '5_settings@2',
  menu && clearItem && `${menu.group} / ${clearItem.group}`
);
const WANT_TITLE = { 'package.nls.json': 'Export AI MCP Server', 'package.nls.zh-cn.json': '导出 AI MCP 服务器' };
for (const nls of Object.keys(WANT_TITLE)) {
  const n = JSON.parse(text(path.join(DEV, nls)));
  check(`wiring: ${nls} carries the renamed title`, n['command.mrvc.exportMcp.title'] === WANT_TITLE[nls], String(n['command.mrvc.exportMcp.title']));
}
const extSrc = text(path.join(DEV, 'src', 'extension.ts'));
const noScanAt = extSrc.indexOf('const NO_SCAN = new Set([');
const idAt = extSrc.indexOf("'mrvc.exportMcp'");
check('wiring: the command runs without the workspace scan (NO_SCAN)', noScanAt >= 0 && idAt > noScanAt && idAt < extSrc.indexOf(']);', noScanAt));
check('wiring: the command is registered', extSrc.includes("reg('mrvc.exportMcp'"));
check('wiring: the bundle carries the command id', text(path.join(DEV, 'out', 'extension.js')).includes('mrvc.exportMcp'));

// ---- 7. real smoke: both server layouts start and report their version ----------
/** spawn a server, send initialize, resolve with the response (undefined on exit/timeout) */
function handshake(serverFile, cwd) {
  return new Promise((resolve) => {
    const child = spawn('node', [serverFile], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 30000);
    child.stdout.on('data', (d) => {
      out += String(d);
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(JSON.parse(out.slice(0, nl)));
      } catch {
        finish(undefined);
      }
    });
    child.on('error', () => finish(undefined));
    child.on('exit', () => finish(undefined));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcpexport-test', version: '0' } },
      }) + '\n'
    );
  });
}
const versionOf = (msg) => (msg && msg.result && msg.result.serverInfo ? msg.result.serverInfo.version : undefined);

(async () => {
  const A = scratch('pick-a');
  fs.mkdirSync(A, { recursive: true });
  // the export ALWAYS lands in A/mrvc-mcp (user request 2026-11-24: one
  // obviously-named folder, never loose files in the picked location)
  const destA = path.join(A, 'mrvc-mcp');
  const serverA = path.join(destA, 'mcp-server.js');
  const markerAPath = path.join(destA, 'package.json');

  // a. cancelled dialog — nothing written, nothing said
  reset();
  dialogPick = undefined;
  await exportMcpServerCmd(ctx(EXT));
  check('cmd: a cancelled dialog writes nothing and says nothing', !exists(destA) && ui.infos.length === 0 && ui.errors.length === 0 && globalState.size === 0);
  check('cmd: the dialog selects exactly one folder', !!dialogOpts && dialogOpts.canSelectFolders === true && dialogOpts.canSelectFiles === false && dialogOpts.canSelectMany === false);
  check('cmd: no previous export → no default location', !!dialogOpts && dialogOpts.defaultUri === undefined);

  // b. an empty picked folder receives the export in the created mrvc-mcp folder
  reset();
  dialogPick = [{ fsPath: A }];
  await exportMcpServerCmd(ctx(EXT));
  check('cmd: the export lands in the created mrvc-mcp folder', exists(serverA) && exists(markerAPath) && exists(path.join(destA, 'README.md')));
  check('cmd: the message names the exported server file', ui.infos.length === 1 && ui.infos[0].text === t('mcpExported', serverA), ui.infos[0] && ui.infos[0].text);
  check('cmd: the message offers copy-config and open-folder', !!ui.infos[0] && ui.infos[0].actions.length === 2 && ui.infos[0].actions.includes(t('mcpExportCopyConfig')));
  check('cmd: no error, no warning on the plain path', ui.errors.length === 0 && ui.warnings.length === 0);
  check('cmd: the destination is remembered for the next export', globalState.get('mrvc.mcp.exportDest') === destA);

  // c. re-export of the same build → "already is version", nothing written
  reset();
  dialogPick = [{ fsPath: A }];
  await exportMcpServerCmd(ctx(EXT));
  check('cmd: re-exporting the same build says it already is that version', ui.infos.length === 1 && ui.infos[0].text === t('mcpExportSame', serverA, '9.8.8'), ui.infos[0] && ui.infos[0].text);
  check(
    'cmd: the dialog reopens AROUND the previous destination',
    !!dialogOpts && !!dialogOpts.defaultUri && dialogOpts.defaultUri.fsPath === path.dirname(destA),
    dialogOpts && dialogOpts.defaultUri && dialogOpts.defaultUri.fsPath
  );

  // d. a new build → the message names the old→new version step; copy-config
  writeFile(EXT, 'mcp/mcp-server.js', '// fake bundle v3\n');
  writeFile(EXT, 'package.json', JSON.stringify({ name: 'mrvc', version: '9.8.9', contributes: {} }));
  reset();
  dialogPick = [{ fsPath: A }];
  infoAction = t('mcpExportCopyConfig');
  await exportMcpServerCmd(ctx(EXT));
  check(
    'cmd: an upgrade names the version step (9.8.8 → 9.8.9) and the rewritten file count',
    ui.infos.length === 1 && ui.infos[0].text === t('mcpExportUpgrade', serverA, '9.8.8', '9.8.9', 3),
    ui.infos[0] && ui.infos[0].text
  );
  const copied = JSON.parse(clipboard);
  check('cmd: "Copy client config" puts command/args on the clipboard', copied.command === 'node' && copied.args[0] === serverA && ui.status.length === 1, clipboard);

  // d2. a DOWNGRADE — the export is NEWER than the (rolled-back) extension —
  // asks with a modal before overwriting; declining leaves the copy alone
  writeFile(EXT, 'package.json', JSON.stringify({ name: 'mrvc', version: '9.8.0', contributes: {} }));
  const downgradeServer = text(serverA);
  reset();
  dialogPick = [{ fsPath: A }];
  warnPick = undefined;
  await exportMcpServerCmd(ctx(EXT));
  check(
    'cmd: a downgrade asks with a modal naming both versions',
    ui.warnings.length === 1 && ui.warnings[0].modal === true && ui.warnings[0].text === t('mcpExportDowngrade', destA, '9.8.9', '9.8.0') && ui.infos.length === 0,
    ui.warnings[0] && ui.warnings[0].text
  );
  check('cmd: declining a downgrade writes nothing', text(serverA) === downgradeServer && JSON.parse(text(markerAPath)).version === '9.8.9');
  check('cmd: declining a downgrade does not move the last-destination memory', globalState.get('mrvc.mcp.exportDest') === destA);
  reset();
  dialogPick = [{ fsPath: A }];
  warnPick = t('overwrite');
  await exportMcpServerCmd(ctx(EXT));
  // marker + README carry the version — the bundle bytes are unchanged: two files
  check(
    'cmd: accepting the downgrade rewrites the version-bearing files and names the step',
    JSON.parse(text(markerAPath)).version === '9.8.0' && ui.infos.length === 1 && ui.infos[0].text === t('mcpExportUpgrade', serverA, '9.8.9', '9.8.0', 2),
    ui.infos[0] && ui.infos[0].text
  );
  check('cmd: the accepted downgrade ran cleanly (exactly the one modal, no error)', ui.errors.length === 0 && ui.warnings.length === 1);

  // d3. the MRS install path settings travel into the marker (the headless
  //     copy cannot read VS Code settings — 0.3.7, user request) — together
  //     with the generation pin (round3 P2.1)
  reset();
  mrvcSettings = { mrs2InstallPath: 'X:\\custom\\mrs2', mrs3InstallPath: '', toolchainOnlyPath: 'X:\\tc', mrsVersion: 'mrs2' };
  dialogPick = [{ fsPath: A }];
  await exportMcpServerCmd(ctx(EXT));
  const markerA = JSON.parse(text(markerAPath));
  check(
    'cmd: the export stamps the configured install locations into the marker',
    markerA.mrvc && markerA.mrvc.installPaths && markerA.mrvc.installPaths.mrs2InstallPath === 'X:\\custom\\mrs2' && markerA.mrvc.installPaths.mrs3InstallPath === undefined && markerA.mrvc.installPaths.toolchainOnlyPath === 'X:\\tc',
    JSON.stringify(markerA.mrvc)
  );
  check('cmd: the export stamps the generation pin into the marker', markerA.mrvc.mrsVersion === 'mrs2', JSON.stringify(markerA.mrvc));
  check('cmd: the marker also names the exporting extension', markerA.mrvc.exportedFrom === EXT);
  // same version, only the marker changed → the plain update message
  check(
    'cmd: a same-version re-export with new metadata reports the rewritten count',
    ui.infos.length === 1 && ui.infos[0].text === t('mcpExportUpdated', serverA, '9.8.0', 1),
    ui.infos[0] && ui.infos[0].text
  );
  check('cmd: the export record at A reads back through the core reader', (() => { const r = core.readExportRecord(destA); return !!r && r.installPaths.mrs2 === 'X:\\custom\\mrs2' && r.version === '9.8.0' && r.mrsVersion === 'mrs2'; })());
  mrvcSettings = {};

  // e. a foreign non-empty folder → contained in mrvc-mcp, its own files untouched
  const F = scratch('pick-full');
  fs.mkdirSync(F, { recursive: true });
  fs.writeFileSync(path.join(F, 'other.txt'), 'other');
  reset();
  dialogPick = [{ fsPath: F }];
  await exportMcpServerCmd(ctx(EXT));
  check(
    'cmd: a foreign folder gets the mrvc-mcp subfolder and keeps its own files',
    exists(path.join(F, 'mrvc-mcp', 'mcp-server.js')) && text(path.join(F, 'other.txt')) === 'other' && !exists(path.join(F, 'mcp-server.js'))
  );
  check('cmd: no modal on the contained path', ui.warnings.length === 0);

  // f. an existing FOREIGN mrvc-mcp → modal confirm; decline leaves it alone
  const F2 = scratch('pick-full2');
  fs.mkdirSync(path.join(F2, 'mrvc-mcp'), { recursive: true });
  fs.writeFileSync(path.join(F2, 'other.txt'), 'other');
  fs.writeFileSync(path.join(F2, 'mrvc-mcp', 'keep.txt'), 'keep');
  reset();
  dialogPick = [{ fsPath: F2 }];
  warnPick = undefined;
  await exportMcpServerCmd(ctx(EXT));
  check(
    'cmd: a foreign mrvc-mcp asks with a modal naming the folder',
    ui.warnings.length === 1 && ui.warnings[0].modal === true && ui.warnings[0].text === t('mcpExportForeign', SUB(F2)),
    ui.warnings[0] && ui.warnings[0].text
  );
  check('cmd: declining leaves the folder untouched', !exists(path.join(F2, 'mrvc-mcp', 'mcp-server.js')) && text(path.join(F2, 'mrvc-mcp', 'keep.txt')) === 'keep');
  reset();
  dialogPick = [{ fsPath: F2 }];
  warnPick = t('overwrite');
  await exportMcpServerCmd(ctx(EXT));
  check('cmd: accepting writes beside the foreign files', exists(path.join(F2, 'mrvc-mcp', 'mcp-server.js')) && text(path.join(F2, 'mrvc-mcp', 'keep.txt')) === 'keep');

  // g. picked inside the installation → refused, nothing written there
  reset();
  dialogPick = [{ fsPath: path.join(EXT, 'mcp') }];
  await exportMcpServerCmd(ctx(EXT));
  check(
    'cmd: exporting into the installation is refused and writes nothing there',
    ui.errors.length === 1 && ui.errors[0] === t('mcpExportInsideExt') && !exists(path.join(EXT, 'mcp', 'mrvc-mcp')) && !exists(path.join(EXT, 'mcp', 'package.json')),
    ui.errors.join(' | ')
  );

    // g2. picked THROUGH a junction/symlink that leads into the installation
    //     — the physical-location guard refuses that too (round1 P3.4)
    if (linkMade) {
      reset();
      dialogPick = [{ fsPath: path.join(LINK_IN, 'mcp') }];
      await exportMcpServerCmd(ctx(EXT));
      check(
        'cmd: a junction into the installation is refused and writes nothing there',
        ui.errors.length === 1 && ui.errors[0] === t('mcpExportInsideExt') && !exists(path.join(EXT, 'mcp', 'mrvc-mcp')) && !exists(path.join(EXT, 'mcp', 'package.json')),
        ui.errors.join(' | ')
      );
      fs.unlinkSync(LINK_IN);
    }

    // h. "Open Folder" reveals the exported server file
  reset();
  dialogPick = [{ fsPath: A }];
  infoAction = t('cmakeOpenFolder');
  await exportMcpServerCmd(ctx(EXT));
  check('cmd: "Open Folder" reveals the exported server file', executed.length === 1 && executed[0][0] === 'revealFileInOS' && executed[0][1] === serverA, JSON.stringify(executed));

  // i. an installation without the bundle — reported before any dialog
  const callsBefore = dialogCalls;
  reset();
  dialogPick = [{ fsPath: A }];
  await exportMcpServerCmd(ctx(NO_EXT));
  check('cmd: an installation without the bundle is reported and no dialog opens', ui.errors.length === 1 && ui.errors[0] === t('mcpExportNoServer') && dialogCalls === callsBefore, ui.errors.join(' | '));

  // ---- the REAL bundle: both layouts --------------------------------------
  const devPkg = JSON.parse(text(path.join(DEV, 'package.json')));
  // the server alone — the smoke is about the version lookup, not koffi
  const realPlan = core.planMcpExport(DEV, 'win32');
  check('smoke: the real extension root plans an export', realPlan.ok && realPlan.plan.version === devPkg.version, JSON.stringify(realPlan.ok ? realPlan.plan.version : realPlan));
  if (realPlan.ok) {
    const realDest = scratch('real-export');
    core.applyMcpExport(realPlan.plan, realDest);
    const bundledVersion = versionOf(await handshake(path.join(DEV, 'mcp', 'mcp-server.js'), ROOT));
    check('smoke: the bundled server (in-extension layout) reports the extension version', bundledVersion === devPkg.version, JSON.stringify(bundledVersion));
    const exported = await handshake(path.join(realDest, 'mcp-server.js'), ROOT);
    const exportedInfo = exported && exported.result && exported.result.serverInfo;
    check(
      'smoke: the EXPORTED server starts from a foreign folder and reports the stamped version',
      !!exportedInfo && exportedInfo.name === 'mrvc-mcp' && exportedInfo.version === devPkg.version,
      JSON.stringify(exportedInfo)
    );
    // the beside lookup is name-checked: somebody else's package.json next
    // to a copied bundle must not leak ITS version (no package.json above it)
    const foreign = scratch('foreign-pkg');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'package.json'), '{"name":"someone-else","version":"0.0.1"}');
    fs.copyFileSync(path.join(DEV, 'mcp', 'mcp-server.js'), path.join(foreign, 'mcp-server.js'));
    const leakVersion = versionOf(await handshake(path.join(foreign, 'mcp-server.js'), ROOT));
    check('smoke: a foreign package.json beside the bundle never leaks its version', leakVersion === '0.0.0', JSON.stringify(leakVersion));
    // ...and the same for a third-party PARENT package when the bundle sits
    // in a subdirectory of that package (round3 P3.2 — the parent lookup used
    // to be name-blind and reported the foreign package's version)
    fs.mkdirSync(path.join(foreign, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(DEV, 'mcp', 'mcp-server.js'), path.join(foreign, 'tools', 'mcp-server.js'));
    const parentLeak = versionOf(await handshake(path.join(foreign, 'tools', 'mcp-server.js'), ROOT));
    check('smoke: a third-party PARENT package.json never leaks its version either', parentLeak === '0.0.0', JSON.stringify(parentLeak));
  }

  // ---- round3 P3.1: a failed payload write must not leave a new-version
  // marker standing over an old bundle (the marker is the commit marker)
  {
    const F3 = scratch('pick-fail');
    core.applyMcpExport(core.planMcpExport(EXT, 'win32').plan, F3); // establish an OLD export first
    const oldMarker = JSON.parse(text(path.join(F3, 'package.json')));
    // sabotage: the bundle's destination path becomes a DIRECTORY
    fs.rmSync(path.join(F3, 'mcp-server.js'));
    fs.mkdirSync(path.join(F3, 'mcp-server.js'));
    writeFile(EXT, 'mcp/mcp-server.js', '// bundle that will fail to land\n');
    writeFile(EXT, 'package.json', JSON.stringify({ name: 'mrvc', version: '9.9.9', contributes: {} }));
    const failPlan = core.planMcpExport(EXT, 'win32');
    check('fail: the sabotaged plan really carries a new version', !!failPlan.ok && failPlan.plan.version === '9.9.9');
    let threw = false;
    try {
      core.applyMcpExport(failPlan.plan, F3);
    } catch {
      threw = true;
    }
    check('fail: a payload write error aborts the export with a throw', threw);
    const afterMarker = JSON.parse(text(path.join(F3, 'package.json')));
    check(
      'fail: the OLD marker survives untouched (no fake new version)',
      afterMarker.version === oldMarker.version && oldMarker.version === '9.8.0',
      `${oldMarker.version} -> ${afterMarker.version}`
    );
    check('fail: the bundle was not written (still the sabotaged directory)', fs.statSync(path.join(F3, 'mcp-server.js')).isDirectory());
    // the staging temp was created (payload pre-read succeeded) and must have
    // been cleaned when the rename failed
    const failTmp = [];
    const scanFail = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) scanFail(full);
        else if (e.name.includes('.mrvc-tmp')) failTmp.push(full);
      }
    };
    scanFail(F3);
    check('fail: no staging (.mrvc-tmp) debris survives the failed rename', failTmp.length === 0, JSON.stringify(failTmp));
    fs.rmSync(path.join(F3, 'mcp-server.js'), { recursive: true, force: true });
  }

  console.log(failures ? `mcpexport tests FAILED (${failures})` : 'all mcpexport tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
