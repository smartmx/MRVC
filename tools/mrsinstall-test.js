/*
 * MRS2 / MRS3 installation selection tests (pure Node, hermetic).
 *
 * Covers: flavour probing (product.json mrsVersion / branding / launcher exe),
 * the start-up VALIDATION of the two install settings (exists / is an install /
 * right generation / ships the launcher exe), the mrvc.mrsVersion preference
 * over the valid fields (with the fallback report), and the win32-dir form of
 * a configured path. Fake install trees live in .scratch — the real
 * installations are never touched.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const {
  detectFlavor,
  locateInstall,
  checkInstallPath,
  launcherFileName,
  selectInstall,
  MRS2_DEFAULT_PATHS,
  MRS3_DEFAULT_PATHS,
} = require('../out/core/toolchain.js');

const ROOT = path.join(__dirname, '..', '.scratch', 'mrsinstall');
fs.rmSync(ROOT, { recursive: true, force: true });

/** every path this helper writes must stay inside ROOT */
function inside(root, target) {
  const resolved = path.resolve(root, target);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('refusing to write outside the scratch root: ' + target);
  }
  return resolved;
}

/** minimal fake install — locateInstall only probes the WCH manifest marker;
 *  the flavour markers are product.json / the launcher name. A usable install
 *  also ships "MounRiver Studio <N>.exe" (the start-up validation requires it). */
function fakeInstall(name, opts = {}) {
  const root = inside(ROOT, name);
  const win32 = inside(root, path.join('resources', 'app', 'resources', 'win32'));
  fs.mkdirSync(inside(win32, path.join('components', 'WCH')), { recursive: true });
  fs.writeFileSync(inside(win32, path.join('components', 'WCH', 'manifest.json')), '{}');
  if (!opts.noProduct) {
    const gen = opts.flavor === 'mrs3' ? '3' : '2';
    fs.writeFileSync(
      inside(root, path.join('resources', 'app', 'product.json')),
      JSON.stringify({ nameShort: 'MounRiver Studio ' + gen, mrsVersion: gen + '.0.0' })
    );
  }
  if (!opts.noLauncher) {
    const gen = opts.flavor === 'mrs3' ? '3' : '2';
    fs.writeFileSync(inside(root, launcherFileName(gen === '3' ? 'mrs3' : 'mrs2')), '');
  }
  if (opts.launcher) fs.writeFileSync(inside(root, opts.launcher), '');
  return { root, win32 };
}

const inst2 = fakeInstall('fake-mrs2', { flavor: 'mrs2' });
const inst3 = fakeInstall('fake-mrs3', { flavor: 'mrs3' });
const instUnknown = fakeInstall('fake-unknown', { noProduct: true, noLauncher: true });
const instNoLauncher = fakeInstall('fake-noexe', { flavor: 'mrs2', noLauncher: true });
const instLauncher = fakeInstall('fake-launcher2', { noProduct: true, launcher: 'MounRiver Studio 2.exe' });
const MISSING = path.join(ROOT, 'does-not-exist');
// hermetic defaults: the real C:\MounRiver\... paths must never leak in
const HERM = { mrs2: [], mrs3: [] };

// 1. flavour probing
{
  const f2 = detectFlavor(inst2.root);
  check('flavor: mrsVersion 2.0.0 -> mrs2 with branding label', f2.flavor === 'mrs2' && f2.label === 'MounRiver Studio 2');
  const f3 = detectFlavor(inst3.root);
  check('flavor: mrsVersion 3.0.0 -> mrs3 with branding label', f3.flavor === 'mrs3' && f3.label === 'MounRiver Studio 3');
  const fx = detectFlavor(instUnknown.root);
  check('flavor: no marker at all -> unknown, generic label', fx.flavor === 'unknown' && fx.label === 'MounRiver Studio');
  const fl = detectFlavor(instLauncher.root);
  check('flavor: launcher exe fallback -> mrs2', fl.flavor === 'mrs2' && fl.label === 'MounRiver Studio 2');
  const fm = detectFlavor(MISSING);
  check('flavor: unreadable root -> unknown (no throw)', fm.flavor === 'unknown');
}

// 2. locateInstall: layout resolution + the win32-dir form
{
  const a = locateInstall(inst2.root);
  check('locate: install root accepted, flavour attached', !!a && a.flavor === 'mrs2' && a.root === inst2.root);
  check(
    'locate: makeBin falls under the fake win32 tree',
    !!a && a.makeBin === path.join(inst2.win32, 'others', 'Build_Tools', 'Make', 'bin')
  );
  check(
    'locate: openocd + WCH-LinkUtility derived from the components dir',
    !!a && a.openocdExe.includes('OpenOCD') && a.openocdCfg.endsWith('wch-riscv.cfg') && a.linkUtilityExe.endsWith('WCH-LinkUtility.exe')
  );
  const b = locateInstall(inst2.win32);
  check('locate: the win32 dir itself accepted, root restored (4 dirname hops)', !!b && b.root === inst2.root);
  check('locate: invalid path -> null (hermetic defaults)', locateInstall(MISSING, { defaults: [] }) === null);
  const c = locateInstall([MISSING, inst3.root], { defaults: [] });
  check('locate: first VALID candidate of a list wins', !!c && c.root === inst3.root && c.flavor === 'mrs3');
  const win32Form = locateInstall(inst3.win32);
  check('locate: win32 form keeps the flavour (probe runs on the real root)', !!win32Form && win32Form.flavor === 'mrs3');
}

// 3a. checkInstallPath: the start-up criterion for ONE field
{
  const ok2 = checkInstallPath(inst2.root, 'mrs2');
  check('check: a genuine MRS2 tree passes', ok2.ok === true && ok2.install.flavor === 'mrs2');
  const ok3 = checkInstallPath(inst3.root, 'mrs3');
  check('check: a genuine MRS3 tree passes', ok3.ok === true && ok3.install.flavor === 'mrs3');

  const missing = checkInstallPath(MISSING, 'mrs2');
  check('check: a non-existent folder -> "missing"', !missing.ok && missing.problem === 'missing');
  const plainDir = checkInstallPath(ROOT, 'mrs2');
  check('check: a folder that is not an install -> "not-install"', !plainDir.ok && plainDir.problem === 'not-install');

  const wrong = checkInstallPath(inst3.root, 'mrs2');
  check(
    'check: an MRS3 tree in the MRS2 field -> "wrong-generation" + the found flavour',
    !wrong.ok && wrong.problem === 'wrong-generation' && wrong.foundFlavor === 'mrs3'
  );
  const noExe = checkInstallPath(instNoLauncher.root, 'mrs2');
  check('check: an install without the launcher exe -> "no-launcher"', !noExe.ok && noExe.problem === 'no-launcher');
  const unmarked = checkInstallPath(instUnknown.root, 'mrs2');
  check('check: an unmarked tree can not be verified -> rejected', !unmarked.ok && unmarked.problem === 'no-launcher');

  const win32Form = checkInstallPath(inst2.win32, 'mrs2');
  check('check: the win32-dir form is accepted too', win32Form.ok === true && win32Form.install.root === inst2.root);
  const padded = checkInstallPath('  ' + inst2.root + '  ', 'mrs2');
  check('check: the value is trimmed', padded.ok === true);
}

// 3b. selectInstall: validate both fields, then pick with the preference
{
  const only2 = selectInstall({ mrs2Path: inst2.root }, HERM);
  check(
    'select: a valid MRS2 path activates MRS2, nothing flagged',
    !!only2.install && only2.install.flavor === 'mrs2' && !only2.bothValid &&
      only2.failedFields.length === 0 && only2.pinnedFellBack === undefined && !only2.notConfigured
  );
  const only3 = selectInstall({ mrs3Path: inst3.root }, HERM);
  check('select: a valid MRS3 path activates MRS3', !!only3.install && only3.install.flavor === 'mrs3');

  // one field invalid, the other valid: the valid one is used and the failure
  // is reported per field (never substituted)
  const mixed = selectInstall({ mrs2Path: MISSING, mrs3Path: inst3.root }, HERM);
  check('select: valid + invalid -> the valid install is used', !!mixed.install && mixed.install.flavor === 'mrs3');
  check(
    'select: ... the failing field and its reason are reported',
    mixed.failedFields.length === 1 && mixed.failedFields[0].field === 'mrs2InstallPath' && mixed.failedFields[0].problem === 'missing'
  );
  check('select: ... and no adoption offer is made while a field resolves', mixed.detected === null);

  // the preference (mrvc.mrsVersion) over the VALID fields
  const both = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst3.root }, HERM);
  check('select: auto with both valid -> MRS3 active', !!both.install && both.install.flavor === 'mrs3');
  check('select: auto with both valid -> bothValid reported', both.bothValid === true);
  check('select: auto with both valid -> labels for the note', both.mrs2Label === 'MounRiver Studio 2' && both.mrs3Label === 'MounRiver Studio 3');
  const pinned2 = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst3.root, version: 'mrs2' }, HERM);
  check('select: version=mrs2 -> MRS2 active', !!pinned2.install && pinned2.install.flavor === 'mrs2');
  check('select: a satisfied preference never falls back', pinned2.pinnedFellBack === undefined && pinned2.bothValid === false);
  const pinned3 = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst3.root, version: 'mrs3' }, HERM);
  check('select: version=mrs3 -> MRS3 active', !!pinned3.install && pinned3.install.flavor === 'mrs3');

  // the preference is not a wall: its generation invalid -> the other VALID one
  const pref3by2 = selectInstall({ mrs2Path: inst2.root, mrs3Path: MISSING, version: 'mrs3' }, HERM);
  check('select: version=mrs3 with an invalid MRS3 value -> MRS2 used', !!pref3by2.install && pref3by2.install.flavor === 'mrs2');
  check('select: ... and the fallback is reported', pref3by2.pinnedFellBack === 'mrs3');
  check('select: ... with the invalid field still reported', pref3by2.failedFields.length === 1 && pref3by2.failedFields[0].field === 'mrs3InstallPath');
  const pref2by3 = selectInstall({ mrs2Path: MISSING, mrs3Path: inst3.root, version: 'mrs2' }, HERM);
  check('select: version=mrs2 with an invalid MRS2 value -> MRS3 used', !!pref2by3.install && pref2by3.install.flavor === 'mrs3' && pref2by3.pinnedFellBack === 'mrs2');

  // both values swapped between the fields: nothing is valid, the gate can
  // offer to exchange them
  const swapped = selectInstall({ mrs2Path: inst3.root, mrs3Path: inst2.root }, HERM);
  check('select: swapped values -> no active install', swapped.install === null);
  check('select: swapped values -> both fields flagged wrong-generation', swapped.failedFields.length === 2);
  check('select: swapped values -> swappedFields set for the swap action', swapped.swappedFields === true);
  check('select: swapped values -> path values exposed for that action', swapped.mrs2PathValue === inst3.root && swapped.mrs3PathValue === inst2.root);
  // one field holding the other generation is NOT "swapped" (nothing to swap)
  const wrongOne = selectInstall({ mrs2Path: inst3.root }, HERM);
  check('select: a single wrong-generation value is not a swap', wrongOne.swappedFields === false && wrongOne.install === null);

  // nothing valid: the conventional locations are only OFFERED
  const none = selectInstall({ mrs2Path: MISSING, mrs3Path: MISSING }, HERM);
  check('select: nothing valid -> no active install', none.install === null);
  check('select: nothing valid -> both fields reported', none.failedFields.length === 2 && none.notConfigured === false);
  check('select: nothing valid + no convention -> nothing to offer', none.detected === null);

  const offered = selectInstall({ mrs2Path: MISSING, mrs3Path: MISSING }, { mrs2: [MISSING], mrs3: [inst3.root] });
  check('select: ... the MRS3 convention is only OFFERED (detected)', offered.install === null && !!offered.detected && offered.detected.flavor === 'mrs3');
  const offered2 = selectInstall({ mrs2Path: MISSING, mrs3Path: MISSING }, { mrs2: [inst2.root], mrs3: [inst3.root] });
  check('select: ... the scan keeps MRS2 first for the offer', !!offered2.detected && offered2.detected.flavor === 'mrs2');

  const notConf = selectInstall({}, { mrs2: [inst2.root], mrs3: [] });
  check('select: empty values -> notConfigured', notConf.install === null && notConf.notConfigured === true && notConf.failedFields.length === 0);
  check('select: ... with the found install offered', !!notConf.detected && notConf.detected.root === inst2.root);

  const trimmed = selectInstall({ mrs2Path: '  ' + inst2.root + '  ' }, HERM);
  check('select: configured paths are trimmed', !!trimmed.install && trimmed.install.flavor === 'mrs2');

  // a value equal to the setting's schema default is a suggestion, not a user
  // choice: its failure is flagged (fromDefault) so the caller can stay quiet
  const byDefault = selectInstall({ mrs2Path: MISSING, mrs2Default: MISSING, mrs3Path: inst3.root }, HERM);
  check('select: a failing schema-default value is marked as such', byDefault.failedFields[0].fromDefault === true);
  const userValue = selectInstall({ mrs2Path: MISSING, mrs2Default: inst2.root, mrs3Path: inst3.root }, HERM);
  check('select: a user value that fails is not a default', userValue.failedFields[0].fromDefault === false);

  check(
    'defaults: conventional lists name Studio2 / Studio3',
    MRS2_DEFAULT_PATHS[0].includes('MounRiver_Studio2') && MRS3_DEFAULT_PATHS[0].includes('MounRiver_Studio3')
  );
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall mrsinstall tests passed');
process.exit(failures ? 1 : 0);
