// Packaged-artifact guard: the repo's .vsix must be exactly what the current
// source produces. Run AFTER `node esbuild.js` && `npm run package`:
//
//   node tools/verify-vsix.mjs
//
// Checks (any failure → exit 1):
//   0. rebuild out/extension.js from src (node esbuild.js) FIRST — `npm run
//      package` does not run esbuild, so "edited src, forgot to rebuild" must
//      be caught here, otherwise a stale out/ would package and verify green
//   1. version coherence: package.json == package-lock.json == vsix filename
//   2. vsix extension/package.json deep-equals the repo package.json
//   3. vsix NLS files byte-equal the repo package.nls*.json
//   4. vsix changelog.md byte-equals CHANGELOG.md
//   5. out/extension.js is the esbuild bundle, not an 18KB tsc emit
//   6. vsix out/extension.js byte-equals the freshly rebuilt bundle
//   7. extension.vsixmanifest Identity Version/Publisher/Id match package.json
//   8. no source/docs/tools/node_modules entries leaked into the package
//
// The vsix is read with a minimal ZIP central-directory parser (zlib inflateRaw)
// so this script stays dependency-free.
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};

// ---- minimal ZIP reader ----------------------------------------------------
function readZipEntries(buf) {
  // End Of Central Directory: scan the last 64KB for the 0x06054b50 signature
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    // local header: skip its own name/extra lengths to find the data
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---- load inputs ------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const vsixPath = path.join(root, `mrvc-${pkg.version}.vsix`);
if (!fs.existsSync(vsixPath)) {
  console.log(`FAIL  mrvc-${pkg.version}.vsix not found — run: npm run package`);
  process.exit(1);
}
const zip = readZipEntries(fs.readFileSync(vsixPath));
const file = (name) => (zip.has(name) ? zip.get(name) : null);

// 1. version coherence
check(lock.version === pkg.version, 'package.json version == lock version', `${pkg.version} vs ${lock.version}`);
check(lock.packages[''].version === pkg.version, 'lock packages[""] version == pkg version');
check(fs.existsSync(vsixPath), `vsix named after version`, path.basename(vsixPath));

// 2. manifest deep-equality (vsce may keep formatting; compare parsed JSON)
let pkgOk = false;
try {
  const inPkg = JSON.parse(file('extension/package.json').toString('utf8'));
  pkgOk = JSON.stringify(inPkg) === JSON.stringify(pkg);
} catch { /* fall through */ }
check(pkgOk, 'vsix package.json deep-equals repo package.json');
if (pkgOk) {
  const inPkg = JSON.parse(file('extension/package.json').toString('utf8'));
  check((inPkg.contributes?.commands ?? []).length === (pkg.contributes?.commands ?? []).length,
    'command count matches', `${(pkg.contributes?.commands ?? []).length}`);
}

// 3. NLS byte-equality
for (const nls of ['package.nls.json', 'package.nls.zh-cn.json']) {
  const inZip = file(`extension/${nls}`);
  const onDisk = fs.readFileSync(path.join(root, nls));
  check(!!inZip && inZip.equals(onDisk), `vsix ${nls} byte-equals repo`);
}

// 4. changelog byte-equality
const chlog = file('extension/changelog.md');
check(!!chlog && chlog.equals(fs.readFileSync(path.join(root, 'CHANGELOG.md'))),
  'vsix changelog.md byte-equals repo CHANGELOG.md');

// 5-6. rebuild from source, then compare (graceful FAIL if out/ can't be
//      produced — e.g. fresh clone without node_modules — never crash)
const outPath = path.join(root, 'out', 'extension.js');
const rebuild = spawnSync(process.execPath, [path.join(root, 'esbuild.js')], { stdio: 'pipe', cwd: root });
if (rebuild.status !== 0 || !fs.existsSync(outPath)) {
  const errLines = String(rebuild.stderr).trim().split(/\r?\n/).filter(Boolean);
  const errTail = errLines.find((l) => /error|cannot|not found/i.test(l)) ?? errLines[errLines.length - 1] ?? '';
  check(false, 'esbuild rebuild from src (node esbuild.js)', errTail || `exit ${rebuild.status}`);
}
const bundleInZip = file('extension/out/extension.js');
const outBundle = fs.existsSync(outPath) ? fs.readFileSync(outPath) : Buffer.alloc(0);
check(outBundle.length > 500 * 1024, 'out/extension.js is the esbuild bundle (not tsc emit)', `${outBundle.length} B`);
// Raw byte equality is the gate (rebuilds on a real install are byte-stable).
// When it fails, tell the two failure shapes apart: if the difference vanishes
// after normalizing the embedded module-path forms, the tree's node_modules is
// a junction/symlink (esbuild bakes in "../<elsewhere>/node_modules/..." spellings)
// — that path-form signature is the ONLY junction tell, so nothing else is
// normalized here. Path-form-equivalent builds are still NOT certified: the
// gate above stays raw-equality, this only picks the failure message.
const bundleShape = (b) => b.toString('latin1')
  .replace(/(?:\.\.\/)+[^"'`\s]*\/node_modules\//g, 'node_modules/');
const rawEqual = !!bundleInZip && bundleInZip.equals(outBundle);
check(rawEqual,
  'vsix bundle byte-equals freshly rebuilt out/extension.js (if this fails: node esbuild.js && npm run package)',
  !bundleInZip ? 'no bundle in vsix' : `${bundleInZip.length} B vs rebuilt ${outBundle.length} B`
    + (!rawEqual && !!bundleInZip && bundleShape(bundleInZip) === bundleShape(outBundle)
      ? ' — differs only in embedded module-path form: node_modules looks like a junction/symlink, package on a real install'
      : ''));

// 6. vsixmanifest identity (attribute order varies — parse, don't regex-order)
const manifest = file('extension.vsixmanifest')?.toString('utf8') ?? '';
const identity = manifest.match(/<Identity\b[^>]*>/i)?.[0] ?? '';
const attr = (name) => identity.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1] ?? '';
check(attr('Version') === pkg.version && attr('Publisher') === pkg.publisher,
  'vsixmanifest Identity Version/Publisher match',
  identity ? `v=${attr('Version')} pub=${attr('Publisher')}` : 'Identity element not found');
check(attr('Id') === pkg.name, 'vsixmanifest Identity Id == package name', attr('Id') || '?');

// 7. leak check
const leaks = [...zip.keys()].filter((n) =>
  /^extension\/(docs|tools|src|chatgpt|node_modules|\.scratch|buildlogs)\//.test(n));
check(leaks.length === 0, 'no source/docs/tools entries leaked', leaks.length ? leaks.join(', ') : `${zip.size} entries`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall vsix verification checks passed');
process.exit(failed ? 1 : 0);
