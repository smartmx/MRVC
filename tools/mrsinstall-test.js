/*
 * MRS2 / MRS3 installation selection tests (pure Node, hermetic).
 *
 * Covers: flavour probing (product.json mrsVersion / branding / launcher exe),
 * the two install settings (mrvc.mrs2InstallPath / mrvc.mrs3InstallPath)
 * combining into ONE active install under the mrvc.mrsVersion policy, the
 * win32-dir form of a configured path, and the "dead MRS3 path falls back to
 * MRS2" / "path sits in the wrong field" reports. Fake install trees live in
 * .scratch — the real installations are never touched.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const { detectFlavor, locateInstall, selectInstall, MRS2_DEFAULT_PATHS, MRS3_DEFAULT_PATHS } = require('../out/core/toolchain.js');

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
 *  the flavour markers are product.json / the launcher name */
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
  if (opts.launcher) fs.writeFileSync(inside(root, opts.launcher), '');
  return { root, win32 };
}

const inst2 = fakeInstall('fake-mrs2', { flavor: 'mrs2' });
const inst3 = fakeInstall('fake-mrs3', { flavor: 'mrs3' });
const instUnknown = fakeInstall('fake-unknown', { noProduct: true });
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

// 3. selectInstall: the either-or policy over the two settings
{
  const only2 = selectInstall({ mrs2Path: inst2.root }, HERM);
  check('select: mrs2 only -> mrs2 active, nothing flagged', !!only2.install && only2.install.flavor === 'mrs2' && !only2.bothValid && !only2.fellBackFromMrs3);

  const both = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst3.root }, HERM);
  check('select: both set (auto) -> MRS3 active', !!both.install && both.install.flavor === 'mrs3');
  check('select: both set (auto) -> bothValid reported', both.bothValid === true);
  check('select: both set (auto) -> labels for the note', both.mrs2Label === 'MounRiver Studio 2' && both.mrs3Label === 'MounRiver Studio 3');

  const pinned2 = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst3.root, version: 'mrs2' }, HERM);
  check('select: version=mrs2 ignores a valid MRS3 path', !!pinned2.install && pinned2.install.flavor === 'mrs2' && !pinned2.bothValid);

  const pinned3 = selectInstall({ mrs2Path: inst2.root, version: 'mrs3' }, { mrs2: [], mrs3: [inst3.root] });
  check('select: version=mrs3 uses the MRS3 convention when its field is empty', !!pinned3.install && pinned3.install.flavor === 'mrs3');
  check('select: a satisfied pin reports nothing missing', pinned3.forcedFlavorMissing === undefined && pinned3.forcedFlavorMissingLabel === undefined);

  const fallback = selectInstall({ mrs2Path: inst2.root, mrs3Path: MISSING }, HERM);
  check('select: dead MRS3 path falls back to MRS2', !!fallback.install && fallback.install.flavor === 'mrs2');
  check('select: the fallback is reported, not "both valid"', fallback.fellBackFromMrs3 === true && fallback.bothValid === false);

  const mismatch = selectInstall({ mrs2Path: inst3.root }, HERM);
  check('select: an MRS3 dir in the MRS2 field still resolves (flavour wins)', !!mismatch.install && mismatch.install.flavor === 'mrs3');
  check('select: ... and reports the mismatched field', mismatch.mismatchedFields.join() === 'mrs2InstallPath');

  const mismatch2 = selectInstall({ mrs3Path: inst2.root }, HERM);
  check('select: an MRS2 dir in the MRS3 field -> mrs3InstallPath flagged', mismatch2.mismatchedFields.join() === 'mrs3InstallPath');

  // round-9 P3: the diagnosis must fire even when BOTH fields are filled —
  // "two installations present" would be wrong (both point at MRS2)
  const misFilled = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst2.root }, HERM);
  check('select: MRS2 value in the MRS3 field -> mismatched even while both filled', misFilled.mismatchedFields.join() === 'mrs3InstallPath');
  check('select: ... and the misleading "two installations" note is suppressed', misFilled.bothValid === false);
  check('select: ... the active install is still the MRS2 one', !!misFilled.install && misFilled.install.flavor === 'mrs2');

  // values swapped between the two fields (a plausible mis-edit): the pin and
  // auto must follow the RESOLVED FLAVOUR, not the field slot (round-8 P2)
  const swapped = selectInstall({ mrs2Path: inst3.root, mrs3Path: inst2.root }, HERM);
  check('select: swapped fields -> both flagged, swap reported', swapped.swappedFields === true && swapped.mismatchedFields.length === 2);
  check('select: swapped fields -> no "two installations" note', swapped.bothValid === false);
  check('select: swapped fields (auto) -> MRS3 flavour active', !!swapped.install && swapped.install.flavor === 'mrs3');
  const swappedPin2 = selectInstall({ mrs2Path: inst3.root, mrs3Path: inst2.root, version: 'mrs2' }, HERM);
  check('select: swapped + version=mrs2 -> MRS2 installation (flavour, not slot)', !!swappedPin2.install && swappedPin2.install.flavor === 'mrs2');
  const swappedPin3 = selectInstall({ mrs2Path: inst3.root, mrs3Path: inst2.root, version: 'mrs3' }, HERM);
  check(
    'select: swapped + version=mrs3 -> MRS3 installation, nothing missing',
    !!swappedPin3.install && swappedPin3.install.flavor === 'mrs3' && swappedPin3.forcedFlavorMissing === undefined
  );

  // forced generation must NEVER come from the other generation's install
  // (round-8 follow-up: mrsVersion=mrs3 + an MRS2 value in the MRS3 field)
  const forcedWrong3 = selectInstall({ mrs3Path: inst2.root, version: 'mrs3' }, HERM);
  check('select: version=mrs3 with only an MRS2 path -> NO install (never silent)', forcedWrong3.install === null);
  check('select: ... forcedFlavorMissing reported', forcedWrong3.forcedFlavorMissing === 'mrs3');
  check('select: ... the field flavour is still reported for the note', forcedWrong3.mrs3FieldFlavor === 'mrs2');
  // round-9 P3: the note must name the PINNED generation — the field's own
  // label here is "MounRiver Studio 2" and contradicted the pinned MRS3
  check(
    'select: ... the note names the pinned generation, not the field value',
    forcedWrong3.forcedFlavorMissingLabel === 'MounRiver Studio 3'
  );

  const forcedWrong2 = selectInstall({ mrs2Path: inst3.root, version: 'mrs2' }, HERM);
  check(
    'select: version=mrs2 with only an MRS3 path -> NO install',
    forcedWrong2.install === null && forcedWrong2.forcedFlavorMissing === 'mrs2'
  );
  check(
    'select: ... pinned label is MRS2 even though the field points at MRS3',
    forcedWrong2.forcedFlavorMissingLabel === 'MounRiver Studio 2'
  );

  // the pinned generation may still be rescued by its own CONVENTIONAL location
  const forcedRescued = selectInstall({ mrs2Path: inst3.root, version: 'mrs2' }, { mrs2: [inst2.root], mrs3: [] });
  check('select: version=mrs2 skips the MRS3 value and uses the MRS2 convention', !!forcedRescued.install && forcedRescued.install.flavor === 'mrs2');
  check('select: ... with nothing reported missing', forcedRescued.forcedFlavorMissing === undefined);

  // an unmarked install can not be disproven -> a pinned generation accepts it
  const forcedUnknown = selectInstall({ mrs2Path: instUnknown.root, version: 'mrs2' }, HERM);
  check('select: version=mrs2 accepts an unmarked install in its own field', !!forcedUnknown.install && forcedUnknown.install.flavor === 'unknown');

  // auto stays permissive: it reports what it picked, it does not error out
  const autoWrong = selectInstall({ mrs3Path: inst2.root }, HERM);
  check('select: auto with an MRS2 value in the MRS3 field uses it (no pin, no error)', !!autoWrong.install && autoWrong.install.flavor === 'mrs2' && autoWrong.forcedFlavorMissing === undefined);
  check('select: swapped -> path values exposed for the swap action', swapped.mrs2PathValue === inst3.root && swapped.mrs3PathValue === inst2.root);

  const normal = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst3.root }, HERM);
  check('select: normal both-filled -> no swap, no mismatch', normal.swappedFields === false && normal.mismatchedFields.length === 0);
  check('select: normal both-filled -> two installations note allowed', normal.bothValid === true);
  check('select: field flavours reported for diagnostics', normal.mrs2FieldFlavor === 'mrs2' && normal.mrs3FieldFlavor === 'mrs3');

  // pinned generation finds a misplaced value even when its own field is empty
  const pinnedFromOtherField = selectInstall({ mrs3Path: inst2.root, version: 'mrs2' }, HERM);
  check('select: version=mrs2 finds an MRS2 value sitting in the MRS3 field', !!pinnedFromOtherField.install && pinnedFromOtherField.install.flavor === 'mrs2');

  const none = selectInstall({ mrs2Path: MISSING, mrs3Path: MISSING }, HERM);
  check('select: nothing valid -> no active install', none.install === null);

  const defaulted = selectInstall({}, { mrs2: [MISSING], mrs3: [inst3.root] });
  check('select: conventional MRS3 location found when nothing is configured', !!defaulted.install && defaulted.install.flavor === 'mrs3');

  const mrs2First = selectInstall({}, { mrs2: [inst2.root], mrs3: [inst3.root] });
  check('select: auto keeps MRS2 when nothing is configured (no silent switch)', !!mrs2First.install && mrs2First.install.flavor === 'mrs2');

  const trimmed = selectInstall({ mrs2Path: '  ' + inst2.root + '  ' }, HERM);
  check('select: configured paths are trimmed', !!trimmed.install && trimmed.install.flavor === 'mrs2');

  check(
    'defaults: conventional lists name Studio2 / Studio3',
    MRS2_DEFAULT_PATHS[0].includes('MounRiver_Studio2') && MRS3_DEFAULT_PATHS[0].includes('MounRiver_Studio3')
  );
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall mrsinstall tests passed');
process.exit(failures ? 1 : 0);
