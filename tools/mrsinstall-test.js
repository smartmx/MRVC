/*
 * Installation selection tests (pure Node, hermetic).
 *
 * Covers: flavour probing (product.json mrsVersion / branding / launcher),
 * the per-OS IDE layouts (win32 / linux / darwin, driven through
 * setHostPlatformForTests so every layout runs on any host), the start-up
 * VALIDATION of the three install settings (exists / is an install / right
 * generation / ships the launcher / arch matches), the standalone-toolchain
 * shape (MRS_Toolchain_* packages), and the mrvc.mrsVersion preference over
 * the valid candidates (with the fallback report). Fake trees live in
 * .scratch — the real installations are never touched.
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
  checkToolchainPath,
  checkBinaryArch,
  toolchainArchProblem,
  launcherFileNames,
  conventionalInstalls,
  selectInstall,
  setHostPlatformForTests,
  MRS2_DEFAULT_PATHS,
  MRS3_DEFAULT_PATHS,
  STANDALONE_LABEL,
} = require('../out/core/toolchain.js');

const REAL_HOST = process.platform;
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

/** a minimal ELF header claiming the given arch ('x64' | 'arm64') */
function elfBytes(arch) {
  const b = Buffer.alloc(24);
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46; // \x7fELF
  b.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18); // e_machine
  return b;
}

const HOST_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const OTHER_ARCH = HOST_ARCH === 'arm64' ? 'x64' : 'arm64';

/**
 * Fake IDE tree for the given host platform:
 *   win32  <root>/resources/app/resources/win32 + "MounRiver Studio <N>.exe"
 *   linux  <root>/resources/app/resources/linux + "mounriver-studio <n>"
 *   darwin <name>.app/Contents/Resources/app/resources/darwin + Contents/MacOS/Electron
 * opts: { host, flavor ('mrs2'|'mrs3'|'none'), noProduct, noLauncher,
 *         launcherInBin (linux), gcc (undefined | arch | 'plain') }
 * Returns { root, res }.
 */
function fakeIde(name, opts = {}) {
  const hostPlatform = opts.host || 'win32';
  const gen = opts.flavor === 'mrs3' ? '3' : '2';
  let root = inside(ROOT, hostPlatform === 'darwin' ? name + '.app' : name);
  const appDir =
    hostPlatform === 'darwin'
      ? inside(root, path.join('Contents', 'Resources', 'app'))
      : inside(root, path.join('resources', 'app'));
  const layer = { win32: 'win32', linux: 'linux', darwin: 'darwin' }[hostPlatform];
  const res = inside(appDir, path.join('resources', layer));
  fs.mkdirSync(inside(res, path.join('components', 'WCH')), { recursive: true });
  fs.writeFileSync(inside(res, path.join('components', 'WCH', 'manifest.json')), '{}');
  if (!opts.noProduct) {
    fs.writeFileSync(
      inside(appDir, 'product.json'),
      JSON.stringify({ nameShort: 'MounRiver Studio ' + gen, mrsVersion: gen + '.0.0' })
    );
  }
  if (!opts.noLauncher) {
    if (hostPlatform === 'darwin') {
      fs.mkdirSync(inside(root, path.join('Contents', 'MacOS')), { recursive: true });
      fs.writeFileSync(inside(root, path.join('Contents', 'MacOS', 'Electron')), '');
    } else if (hostPlatform === 'linux') {
      const dir = opts.launcherInBin ? inside(root, 'bin') : root;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(inside(dir, `mounriver-studio ${gen}`), '');
    } else {
      fs.writeFileSync(inside(root, `MounRiver Studio ${gen}.exe`), '');
    }
  }
  if (opts.gcc) {
    const bin = inside(res, path.join('components', 'WCH', 'Toolchain', 'RISC-V Embedded GCC12', 'bin'));
    fs.mkdirSync(bin, { recursive: true });
    const details = [
      {
        name: 'GCC12',
        type: 'RISC-V',
        path: './RISC-V Embedded GCC12',
        compiler_c_executable: { folder: './bin', name: 'riscv-wch-elf-gcc' },
      },
    ];
    fs.writeFileSync(inside(bin, 'riscv-wch-elf-gcc'), opts.gcc === 'plain' ? '' : elfBytes(opts.gcc));
    // a SECOND toolchain with its own arch — the mixed-arch package shape
    // (mac V2.4: GCC8 x86_64 + GCC12/15 arm64 in one install)
    if (opts.gcc2) {
      const bin2 = inside(res, path.join('components', 'WCH', 'Toolchain', 'RISC-V Embedded GCC', 'bin'));
      fs.mkdirSync(bin2, { recursive: true });
      details.push({
        name: 'GCC8',
        type: 'RISC-V',
        path: './RISC-V Embedded GCC',
        compiler_c_executable: { folder: './bin', name: 'riscv-none-embed-gcc' },
      });
      fs.writeFileSync(inside(bin2, 'riscv-none-embed-gcc'), opts.gcc2 === 'plain' ? '' : elfBytes(opts.gcc2));
    }
    fs.writeFileSync(
      inside(res, path.join('components', 'WCH', 'Toolchain', 'sub_manifest.json')),
      JSON.stringify({ details })
    );
  }
  return { root, res };
}

/** fake standalone toolchain root: Toolchain/sub_manifest.json + OpenOCD/ +
 *  a gcc binary (opts.gcc: undefined | arch | 'plain'; opts.exe: Windows
 *  spelling — binaries carry .exe like a real Windows toolchain package) */
function fakeStandalone(name, opts = {}) {
  const root = inside(ROOT, name);
  const suffix = opts.exe ? '.exe' : '';
  const bin = inside(root, path.join('Toolchain', 'RISC-V Embedded GCC', 'bin'));
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    inside(root, path.join('Toolchain', 'sub_manifest.json')),
    JSON.stringify({
      details: [
        {
          name: 'GCC8',
          type: 'RISC-V',
          path: './RISC-V Embedded GCC',
          compiler_c_executable: { folder: './bin', name: 'riscv-none-embed-gcc' },
        },
      ],
    })
  );
  fs.writeFileSync(inside(bin, 'riscv-none-embed-gcc' + suffix), opts.gcc === undefined ? '' : opts.gcc === 'plain' ? '' : elfBytes(opts.gcc));
  fs.mkdirSync(inside(root, path.join('OpenOCD', 'OpenOCD', 'bin')), { recursive: true });
  fs.writeFileSync(inside(root, path.join('OpenOCD', 'OpenOCD', 'bin', 'openocd' + suffix)), '');
  return root;
}

const MISSING = path.join(ROOT, 'does-not-exist');
// hermetic conventions: the real C:\MounRiver\... (or /usr/share, /Applications)
// paths must never leak into the selection
const HERM = { mrs2: [], mrs3: [] };

try {
  // ============ Windows host layouts (the 0.2.x behaviour, unchanged) ============
  setHostPlatformForTests('win32');
  const inst2 = fakeIde('fake-mrs2', { host: 'win32', flavor: 'mrs2' });
  const inst3 = fakeIde('fake-mrs3', { host: 'win32', flavor: 'mrs3' });
  const instUnknown = fakeIde('fake-unknown', { host: 'win32', flavor: 'mrs2', noProduct: true, noLauncher: true });
  const instNoLauncher = fakeIde('fake-noexe', { host: 'win32', flavor: 'mrs2', noLauncher: true });
  const instLauncher = fakeIde('fake-launcher2', { host: 'win32', flavor: 'mrs2', noProduct: true, noLauncher: true, launcherName: null });

  // 1. flavour probing (win)
  {
    const f2 = detectFlavor(inst2.root);
    check('flavor: mrsVersion 2.0.0 -> mrs2 with branding label', f2.flavor === 'mrs2' && f2.label === 'MounRiver Studio 2');
    const f3 = detectFlavor(inst3.root);
    check('flavor: mrsVersion 3.0.0 -> mrs3 with branding label', f3.flavor === 'mrs3' && f3.label === 'MounRiver Studio 3');
    const fx = detectFlavor(instUnknown.root);
    check('flavor: no marker at all -> unknown, generic label', fx.flavor === 'unknown' && fx.label === 'MounRiver Studio');
    const fm = detectFlavor(MISSING);
    check('flavor: unreadable root -> unknown (no throw)', fm.flavor === 'unknown');
    check(
      'launcher names: win form',
      launcherFileNames('mrs2')[0] === 'MounRiver Studio 2.exe' && launcherFileNames('mrs3')[0] === 'MounRiver Studio 3.exe'
    );
  }

  // 2. locateInstall (win)
  {
    const a = locateInstall(inst2.root, { defaults: [] });
    check('locate: install root accepted, flavour attached', !!a && a.flavor === 'mrs2' && a.root === inst2.root);
    check('locate: resourcesDir is the platform layer dir', !!a && a.resourcesDir === inst2.res && a.kind === 'ide');
    check(
      'locate: makeBin falls under the fake win32 tree',
      !!a && a.makeBin === path.join(inst2.res, 'others', 'Build_Tools', 'Make', 'bin')
    );
    check(
      'locate: openocd + WCH-LinkUtility derived from the components dir (win suffixes)',
      !!a && a.openocdExe.endsWith('openocd.exe') && a.openocdCfg.endsWith('wch-riscv.cfg') && a.linkUtilityExe.endsWith('WCH-LinkUtility.exe')
    );
    const b = locateInstall(inst2.res, { defaults: [] });
    check('locate: the win32 dir itself accepted, root restored (4 dirname hops)', !!b && b.root === inst2.root);
    check('locate: invalid path -> null (hermetic defaults)', locateInstall(MISSING, { defaults: [] }) === null);
    const c = locateInstall([MISSING, inst3.root], { defaults: [] });
    check('locate: first VALID candidate of a list wins', !!c && c.root === inst3.root && c.flavor === 'mrs3');
  }

  // 3. checkInstallPath (win)
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
    const padded = checkInstallPath('  ' + inst2.root + '  ', 'mrs2');
    check('check: the value is trimmed', padded.ok === true);
    const archSkip = checkBinaryArch(__filename);
    check('arch: a non-binary file is "unknown" (never rejects)', archSkip.verdict === 'unknown');
  }

  // 3b. standalone on the Windows host: the .exe spelling real Windows
  // toolchain packages ship (round13 §4.2 — bare manifest names resolve to
  // foo.exe on disk through CreateProcess, so existence checks must too)
  {
    const tcWin = fakeStandalone('fake-tc-win', { exe: true });
    const okWin = checkToolchainPath(tcWin);
    check('standalone(win): the .exe-spelled package passes', okWin.ok === true && okWin.install.kind === 'toolchain');
    check(
      'standalone(win): the manifest gcc exists only as .exe on disk',
      okWin.ok === true &&
        fs.existsSync(path.join(tcWin, 'Toolchain', 'RISC-V Embedded GCC', 'bin', 'riscv-none-embed-gcc.exe')) &&
        !fs.existsSync(path.join(tcWin, 'Toolchain', 'RISC-V Embedded GCC', 'bin', 'riscv-none-embed-gcc'))
    );
    const bareOnWin = fakeStandalone('fake-tc-win-bare');
    check('standalone(win): POSIX-spelled binaries on Windows -> "not-toolchain"', checkToolchainPath(bareOnWin).ok === false);
  }

  // ============ Linux host layouts ============
  setHostPlatformForTests('linux');
  {
    const lin3 = fakeIde('fake-lin3', { host: 'linux', flavor: 'mrs3' });
    const f = detectFlavor(lin3.root);
    check('linux flavor: product.json decides', f.flavor === 'mrs3' && f.label === 'MounRiver Studio 3');
    check('linux launcher names: mounriver-studio <n>', launcherFileNames('mrs3')[0] === 'mounriver-studio 3');
    const ok = checkInstallPath(lin3.root, 'mrs3');
    check('linux check: a genuine MRS3 tree passes', ok.ok === true && ok.install.kind === 'ide');
    check(
      'linux build: openocd carries NO suffix and the link utility is absent',
      ok.ok && ok.install.openocdExe.endsWith('openocd') && ok.install.linkUtilityExe === ''
    );
    const binForm = fakeIde('fake-lin3-bin', { host: 'linux', flavor: 'mrs3', launcherInBin: true });
    const okBin = checkInstallPath(binForm.root, 'mrs3');
    check('linux check: the bin/ launcher form passes too (deb layout)', okBin.ok === true);
    const noLauncher = fakeIde('fake-lin3-nolaunch', { host: 'linux', flavor: 'mrs3', noLauncher: true });
    const miss = checkInstallPath(noLauncher.root, 'mrs3');
    check('linux check: no launcher -> "no-launcher" (named mounriver-studio 3)', !miss.ok && miss.problem === 'no-launcher');
    const winTreeOnLinux = inst2; // a win32-layer tree is not a Linux install
    const foreign = checkInstallPath(winTreeOnLinux.root, 'mrs2');
    check('linux check: a Windows-layer tree is "not-install" here', !foreign.ok && foreign.problem === 'not-install');
    check(
      'conventional: linux mrs3 is the .deb prefix, mrs2 has none',
      conventionalInstalls().mrs3[0] === '/usr/share/MRS3/MRS-linux-x64' && conventionalInstalls().mrs2.length === 0
    );

    // arch gate (linux): a gcc claiming another CPU rejects the install
    const badArch = fakeIde('fake-lin-badarch', { host: 'linux', flavor: 'mrs3', gcc: OTHER_ARCH });
    const rejected = checkInstallPath(badArch.root, 'mrs3');
    check(
      'linux arch: binaries for another CPU -> "wrong-arch" + the found arch',
      !rejected.ok && rejected.problem === 'wrong-arch' && rejected.foundArch === OTHER_ARCH
    );
    const goodArch = fakeIde('fake-lin-goodarch', { host: 'linux', flavor: 'mrs3', gcc: HOST_ARCH });
    const accepted = checkInstallPath(goodArch.root, 'mrs3');
    check('linux arch: matching binaries pass', accepted.ok === true);
    // MIXED-ARCH package (mac V2.4 shape: GCC8 x86_64 + GCC12/15 arm64): the
    // startup gate passes when AT LEAST ONE toolchain matches, in any order
    const mixedA = fakeIde('fake-lin-mixed-a', { host: 'linux', flavor: 'mrs3', gcc: OTHER_ARCH, gcc2: HOST_ARCH });
    check('mixed: passes when the SECOND toolchain matches (order-independent)', checkInstallPath(mixedA.root, 'mrs3').ok === true);
    const mixedB = fakeIde('fake-lin-mixed-b', { host: 'linux', flavor: 'mrs3', gcc: HOST_ARCH, gcc2: OTHER_ARCH });
    check('mixed: passes when the FIRST toolchain matches', checkInstallPath(mixedB.root, 'mrs3').ok === true);
  }

  // ============ macOS host layouts ============
  setHostPlatformForTests('darwin');
  {
    const mac3 = fakeIde('fake-mac3', { host: 'darwin', flavor: 'mrs3' });
    const f = detectFlavor(mac3.root);
    check('darwin flavor: product.json inside Contents decides', f.flavor === 'mrs3' && f.label === 'MounRiver Studio 3');
    const ok = checkInstallPath(mac3.root, 'mrs3');
    check('darwin check: the .app bundle passes', ok.ok === true && ok.install.root === mac3.root);
    const contentsForm = checkInstallPath(path.join(mac3.root, 'Contents'), 'mrs3');
    check('darwin check: the Contents dir is accepted too', contentsForm.ok === true);
    check(
      'darwin build: no .exe suffix anywhere, link utility absent',
      ok.ok && ok.install.openocdExe.endsWith('openocd') && ok.install.linkUtilityExe === '' && ok.install.makeBin.endsWith('bin')
    );
    const wrongGen = checkInstallPath(mac3.root, 'mrs2');
    check('darwin check: wrong generation still detected (product.json)', !wrongGen.ok && wrongGen.problem === 'wrong-generation');
    check(
      'conventional: darwin mrs3 is /Applications, mrs2 has none',
      conventionalInstalls().mrs3[0] === '/Applications/MounRiver Studio 3.app' && conventionalInstalls().mrs2.length === 0
    );
    // the arch story of the Intel Mac: the arm64-only macOS IDE must reject
    const badArch = fakeIde('fake-mac-badarch', { host: 'darwin', flavor: 'mrs3', gcc: OTHER_ARCH });
    const rejected = checkInstallPath(badArch.root, 'mrs3');
    check(
      'darwin arch: an arm64 IDE on an x64 host -> "wrong-arch"',
      !rejected.ok && rejected.problem === 'wrong-arch' && rejected.foundArch === OTHER_ARCH
    );
    const goodArch = fakeIde('fake-mac-goodarch', { host: 'darwin', flavor: 'mrs3', gcc: HOST_ARCH });
    check('darwin arch: matching binaries pass', checkInstallPath(goodArch.root, 'mrs3').ok === true);
    // the mac V2.4 mixed-arch shape on Apple Silicon: startup passes (GCC12/15
    // are native), and ALL-mismatch still rejects (an Intel-only tree on arm64)
    const mixed = fakeIde('fake-mac-mixed', { host: 'darwin', flavor: 'mrs3', gcc: OTHER_ARCH, gcc2: HOST_ARCH });
    check('mixed(darwin): the mac-V2.4 shape passes startup on Apple Silicon', checkInstallPath(mixed.root, 'mrs3').ok === true);
    const allBad = fakeIde('fake-mac-allbad', { host: 'darwin', flavor: 'mrs3', gcc: OTHER_ARCH, gcc2: OTHER_ARCH });
    const allBadCheck = checkInstallPath(allBad.root, 'mrs3');
    check('mixed(darwin): ALL toolchains mismatching still rejects', !allBadCheck.ok && allBadCheck.problem === 'wrong-arch');
  }

  // selection-time gate: the toolchain the project ACTUALLY selects is judged
  // per toolchain (toolchainArchProblem) — mixed packages pass startup via
  // their native toolchains; a mismatched selection fails at build time
  {
    setHostPlatformForTests('linux'); // the fixtures below are linux-shaped
    const good = fakeIde('fake-lin-archsel-good', { host: 'linux', flavor: 'mrs3', gcc: HOST_ARCH });
    const tcGood = checkInstallPath(good.root, 'mrs3').install.toolchains[0];
    check('archsel: a matching toolchain passes the selection gate', toolchainArchProblem(tcGood, 'linux') === null);
    const bad = fakeIde('fake-lin-archsel-bad', { host: 'linux', flavor: 'mrs3', gcc: OTHER_ARCH, gcc2: HOST_ARCH });
    // the MIXED package passes startup; toolchains[0] (GCC12) is the mismatched
    // one — exactly the selection the gate exists to catch
    const tcBad = checkInstallPath(bad.root, 'mrs3').install.toolchains[0];
    const p = toolchainArchProblem(tcBad, 'linux');
    check(
      'archsel: a mismatched selection reports toolchain / found arch / host arch',
      !!p && p.toolchain === 'GCC12' && p.foundArch === OTHER_ARCH && p.hostArch === process.arch
    );
    check('archsel: the selection gate is a no-op on win32', toolchainArchProblem(tcBad, 'win32') === null);
  }

  // ============ standalone toolchain roots ============
  setHostPlatformForTests('linux');
  {
    const tcRoot = fakeStandalone('fake-tc', { gcc: HOST_ARCH });
    const ok = checkToolchainPath(tcRoot);
    check('standalone: a genuine toolchain root passes', ok.ok === true && ok.install.kind === 'toolchain');
    check('standalone: flavour is mrs2-generation with the standalone label', ok.ok && ok.install.flavor === 'mrs2' && ok.install.label === STANDALONE_LABEL);
    check(
      'standalone: openocd from OpenOCD/OpenOCD/bin, makeBin empty, resourcesDir = root',
      ok.ok && ok.install.openocdExe.endsWith('openocd') && ok.install.makeBin === '' && ok.install.resourcesDir === tcRoot
    );
    check(
      'standalone: the manifest resolves the gcc (no .exe suffix)',
      ok.ok && ok.install.toolchains.length === 1 && ok.install.toolchains[0].compilerC.endsWith('riscv-none-embed-gcc')
    );
    const noTc = checkToolchainPath(path.join(tcRoot, 'OpenOCD'));
    check('standalone: a random dir -> "not-toolchain"', !noTc.ok && noTc.problem === 'not-toolchain');
    const missing = checkToolchainPath(MISSING);
    check('standalone: missing -> "missing"', !missing.ok && missing.problem === 'missing');
    const badArch = fakeStandalone('fake-tc-badarch', { gcc: OTHER_ARCH });
    const rejected = checkToolchainPath(badArch);
    check('standalone: wrong-CPU binaries -> "wrong-arch"', !rejected.ok && rejected.problem === 'wrong-arch' && rejected.foundArch === OTHER_ARCH);
    const noGcc = fakeStandalone('fake-tc-nogcc');
    fs.rmSync(path.join(noGcc, 'Toolchain', 'RISC-V Embedded GCC', 'bin', 'riscv-none-embed-gcc'));
    const empty = checkToolchainPath(noGcc);
    check('standalone: manifest with no resolvable RISC-V gcc -> "not-toolchain"', !empty.ok && empty.problem === 'not-toolchain');
  }

  // ============ selectInstall: the three-candidate policy ============
  setHostPlatformForTests('win32');
  // exe: true — this host is win32, where only the .exe spelling is executable
  const tcWin = fakeStandalone('fake-tc-sel', { exe: true, gcc: HOST_ARCH });
  {
    const only2 = selectInstall({ mrs2Path: inst2.root }, HERM);
    check(
      'select: a valid MRS2 path activates MRS2, nothing flagged',
      !!only2.install && only2.install.flavor === 'mrs2' && !only2.bothValid &&
        only2.failedFields.length === 0 && only2.pinnedFellBack === undefined && !only2.notConfigured
    );
    const only3 = selectInstall({ mrs3Path: inst3.root }, HERM);
    check('select: a valid MRS3 path activates MRS3', !!only3.install && only3.install.flavor === 'mrs3');
    const onlyTc = selectInstall({ toolchainPath: tcWin }, HERM);
    check('select: a standalone root alone activates the toolchain', !!onlyTc.install && onlyTc.install.kind === 'toolchain');
    check('select: ... its check is named toolchainOnlyPath', onlyTc.checks[0].field === 'toolchainOnlyPath');

    const mixed = selectInstall({ mrs2Path: MISSING, mrs3Path: inst3.root }, HERM);
    check('select: valid + invalid -> the valid install is used', !!mixed.install && mixed.install.flavor === 'mrs3');
    check(
      'select: ... the failing field and its reason are reported',
      mixed.failedFields.length === 1 && mixed.failedFields[0].field === 'mrs2InstallPath' && mixed.failedFields[0].problem === 'missing'
    );
    check('select: ... and no adoption offer is made while a field resolves', mixed.detected === null);

    const both = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst3.root }, HERM);
    check('select: auto with both valid -> MRS3 active', !!both.install && both.install.flavor === 'mrs3');
    check('select: auto with both valid -> bothValid reported', both.bothValid === true);
    check('select: auto with both valid -> labels for the note', both.mrs2Label === 'MounRiver Studio 2' && both.mrs3Label === 'MounRiver Studio 3');
    const pinned2 = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst3.root, version: 'mrs2' }, HERM);
    check('select: version=mrs2 -> MRS2 active', !!pinned2.install && pinned2.install.flavor === 'mrs2');
    check('select: a satisfied preference never falls back', pinned2.pinnedFellBack === undefined && pinned2.bothValid === false);
    const pinned3 = selectInstall({ mrs2Path: inst2.root, mrs3Path: inst3.root, version: 'mrs3' }, HERM);
    check('select: version=mrs3 -> MRS3 active', !!pinned3.install && pinned3.install.flavor === 'mrs3');

    // the ranking with the standalone candidate
    const autoTc = selectInstall({ toolchainPath: tcWin, mrs2Path: inst2.root }, HERM);
    check('select: auto -> MRS2 IDE over the standalone toolchain', !!autoTc.install && autoTc.install.flavor === 'mrs2');
    const pin2Tc = selectInstall({ toolchainPath: tcWin, mrs3Path: inst3.root, version: 'mrs2' }, HERM);
    check('select: mrs2 pin -> the standalone toolchain over MRS3', !!pin2Tc.install && pin2Tc.install.kind === 'toolchain');
    check('select: ... and the fallback is reported', pin2Tc.pinnedFellBack === 'mrs2');
    const pin3Tc = selectInstall({ toolchainPath: tcWin, mrs2Path: inst2.root, version: 'mrs3' }, HERM);
    check('select: mrs3 pin -> MRS2 IDE (next in rank) over the toolchain', !!pin3Tc.install && pin3Tc.install.flavor === 'mrs2' && pin3Tc.pinnedFellBack === 'mrs3');

    const pref3by2 = selectInstall({ mrs2Path: inst2.root, mrs3Path: MISSING, version: 'mrs3' }, HERM);
    check('select: version=mrs3 with an invalid MRS3 value -> MRS2 used', !!pref3by2.install && pref3by2.install.flavor === 'mrs2');
    check('select: ... and the fallback is reported', pref3by2.pinnedFellBack === 'mrs3');
    check('select: ... with the invalid field still reported', pref3by2.failedFields.length === 1 && pref3by2.failedFields[0].field === 'mrs3InstallPath');
    const pref2by3 = selectInstall({ mrs2Path: MISSING, mrs3Path: inst3.root, version: 'mrs2' }, HERM);
    check('select: version=mrs2 with an invalid MRS2 value -> MRS3 used', !!pref2by3.install && pref2by3.install.flavor === 'mrs3' && pref2by3.pinnedFellBack === 'mrs2');

    const swapped = selectInstall({ mrs2Path: inst3.root, mrs3Path: inst2.root }, HERM);
    check('select: swapped values -> no active install', swapped.install === null);
    check('select: swapped values -> both fields flagged wrong-generation', swapped.failedFields.length === 2);
    check('select: swapped values -> swappedFields set for the swap action', swapped.swappedFields === true);
    check('select: swapped values -> path values exposed for that action', swapped.mrs2PathValue === inst3.root && swapped.mrs3PathValue === inst2.root);
    const wrongOne = selectInstall({ mrs2Path: inst3.root }, HERM);
    check('select: a single wrong-generation value is not a swap', wrongOne.swappedFields === false && wrongOne.install === null);

    const none = selectInstall({ mrs2Path: MISSING, mrs3Path: MISSING }, HERM);
    check('select: nothing valid -> no active install', none.install === null);
    check('select: nothing valid -> both fields reported', none.failedFields.length === 2 && none.notConfigured === false);
    check('select: nothing valid + no convention -> nothing to offer', none.detected === null);

    const offered = selectInstall({ mrs2Path: MISSING, mrs3Path: MISSING }, { mrs2: [MISSING], mrs3: [inst3.root] });
    check('select: ... the MRS3 convention is only OFFERED (detected)', offered.install === null && !!offered.detected && offered.detected.flavor === 'mrs3');
    const offered2 = selectInstall({ mrs2Path: MISSING, mrs3Path: MISSING }, { mrs2: [inst2.root], mrs3: [inst3.root] });
    check('select: ... the scan keeps MRS2 first for the offer', !!offered2.detected && offered2.detected.flavor === 'mrs2');

    // ZERO-CONFIG: with every field empty the conventional locations are
    // validated and ADOPTED directly (marked fromDefault — not a user choice)
    const zero = selectInstall({}, { mrs2: [inst2.root], mrs3: [inst3.root] });
    check(
      'select: zero-config adopts the conventional installs (no detected limbo)',
      !!zero.install && zero.install.flavor === 'mrs3' && zero.notConfigured === false && zero.bothValid === true
    );
    check(
      'select: ... the adopted candidates are marked fromDefault',
      zero.checks.length === 2 && zero.checks.every((c) => c.fromDefault === true && c.ok)
    );
    const zeroEmpty = selectInstall({}, HERM);
    check('select: zero-config with nothing anywhere -> notConfigured', zeroEmpty.install === null && zeroEmpty.notConfigured === true && zeroEmpty.failedFields.length === 0);

    const trimmed = selectInstall({ mrs2Path: '  ' + inst2.root + '  ' }, HERM);
    check('select: configured paths are trimmed', !!trimmed.install && trimmed.install.flavor === 'mrs2');

    const byDefault = selectInstall({ mrs2Path: MISSING, mrs2Default: MISSING, mrs3Path: inst3.root }, HERM);
    check('select: a failing schema-default value is marked as such', byDefault.failedFields[0].fromDefault === true);
    const userValue = selectInstall({ mrs2Path: MISSING, mrs2Default: inst2.root, mrs3Path: inst3.root }, HERM);
    check('select: a user value that fails is not a default', userValue.failedFields[0].fromDefault === false);

    check(
      'defaults: the Windows conventional lists are unchanged',
      MRS2_DEFAULT_PATHS[0].includes('MounRiver_Studio2') && MRS3_DEFAULT_PATHS[0].includes('MounRiver_Studio3')
    );
  }
} finally {
  setHostPlatformForTests(REAL_HOST);
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall mrsinstall tests passed');
process.exit(failures ? 1 : 0);
