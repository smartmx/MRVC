/*
 * Flash script builder tests (pure Node, synthetic fixture — no real tree).
 * Covers: cfg content and address override line, verify/reset combinations,
 * invalid-address rejection, script placement in the build dir.
 */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEVELOP_DIR = path.dirname(here); // .../develop
const { prepareFlash, ADDRESS_RE, transientOpenOcdFailure, openocdLogArgs } = require(path.join(DEVELOP_DIR, 'out', 'core', 'flash.js'));
const { preparePowerPass, clampPowerOffDelay, powerPassVerdict } = require(path.join(DEVELOP_DIR, 'out', 'core', 'powerCycle.js'));
const { scanChipDb, chipDbRoot, seriesForTemplate, chipForTemplate, chipTargetMismatch, guardLinkedChip } = require(path.join(DEVELOP_DIR, 'out', 'core', 'chipdb.js'));
const { inferFlashAddress, hexBaseAddress, displayTargetPath } = require('../out/core/flash.js');
const { encodingForAcp } = require('../out/core/platformEncoding.js');
const { Cproject } = require('../out/core/cproject.js');
const { scanSources } = require('../out/core/scan.js');

// a per-run temp dir, not the shared .scratch tree — concurrent suite runs
// (and any golden-check copy) must never see each other's fixtures
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mrvc-flash-test-'));

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};
const readCfg = (dir) => fs.readFileSync(path.join(dir, 'mrvc_flash.cfg'), 'utf-8');

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

const base = { buildDir: scratch, address: '0x00000000', verify: true, reset: true, boardCfg: 'C:/MRS/wch-riscv.cfg', firmware: 'E:/prj/obj/LED.hex' };
const bsBase = { ...base, firmware: 'E:' + String.raw`\prj\obj with space\LED.hex` }; // Windows backslashes + a space

// 1. default plan (verify + reset)
{
  const plan = prepareFlash(base);
  check(
    'args: board cfg first, script second (NO -l — the main download keeps its terminal progress)',
    JSON.stringify(plan.args) === JSON.stringify(['-f', 'C:/MRS/wch-riscv.cfg', '-f', plan.scriptPath])
  );
  check('script written into the build dir', path.dirname(plan.scriptPath) === path.resolve(scratch));
  const cfg = readCfg(scratch);
  const lines = cfg.split('\n').filter((l) => l.trim());
  check('cfg has exactly two lines', lines.length === 2);
  check('address override line first', lines[0] === 'wlink_set_address 0x00000000');
  check('program line is Tcl-quoted with address+verify+reset+exit', lines[1] === 'program "E:/prj/obj/LED.hex" 0x00000000 verify reset exit');
}

// 1.5 Windows backslash path: Jim Tcl eats backslashes in double quotes —
// the cfg must carry forward slashes (spaces still quoted)
{
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash(bsBase);
  const cfg = readCfg(scratch);
  check('backslash firmware path emitted as forward slashes', cfg.includes('program "E:/prj/obj with space/LED.hex"'));
  check('no backslash remains in the program line', !/program "[^"]*\\/.test(cfg));
  check('backslash case still carries the address offset', cfg.includes('0x00000000 verify reset exit'));
}

// 1.2 SDI Printf (0.3.0): the switch is NOT part of the flash script. MRS's
// own mechanism is the native DLL reset+enable pass
// (MRSFunc_FlashOperationExB with flags RESET|SDIPrintf = 0x11), run after
// the OpenOCD download; OpenOCD's `sdi_printf` re-enumerates the link and
// kills its session (real hardware 2026-11-12). The cfg must never contain
// the line.
{
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash({ ...base, sdiPrintf: true });
  check('sdi: plain branch cfg has no sdi_printf line', !readCfg(scratch).includes('sdi_printf'));
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash({ ...base, sdiPrintf: true, eraseAll: true });
  check('sdi: eraseAll branch cfg has no sdi_printf line', !readCfg(scratch).includes('sdi_printf'));
}

// 1.3 Power-off-reset download (0.3.0): the powerOn option puts the rail
// switch back up as the FIRST script step of BOTH branches — config-time
// execution, before wlink_set_address/init, so the chip is up when the
// session opens (the off pass + delay de-energised it)
{
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash({ ...base, powerOn: '3v3' });
  let lines = readCfg(scratch).split('\n').filter((l) => l.trim());
  check('power: rail-ON line first in the plain branch', lines[0] === 'pow3v3 on' && lines[1] === 'wlink_set_address 0x00000000');
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash({ ...base, powerOn: '5v', eraseAll: true });
  lines = readCfg(scratch).split('\n').filter((l) => l.trim());
  check('power: 5v rail-ON line first in the eraseAll branch', lines[0] === 'pow5v on' && lines[1] === 'wlink_set_address 0x00000000');
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash(base);
  check('power: no rail line without the option', !readCfg(scratch).includes('pow3v3') && !readCfg(scratch).includes('pow5v'));
}

// 1.4 transient link-open failure classifier (0.3.0): the strings a
// re-enumerating WCH-Link produces are retryable; script/target errors are
// NOT (a download writes flash — blind retries on real errors are wrong)
{
  check('transient: wlink open error', transientOpenOcdFailure('Error: wlink open error!\n'));
  check('transient: unknown wch-link', transientOpenOcdFailure('Info : unknown wch-link device found'));
  check('transient: unable to open the USB device', transientOpenOcdFailure('Error: unable to open USB device'));
  check('transient: case-insensitive WCH-Link', transientOpenOcdFailure('Couldn\u0027t open the WCH-Link'));
  // tightened (round-10 P3-4): generic open verbs WITHOUT wch/usb/link context
  // are deterministic file errors — never retried
  check('not transient: config file open error', !transientOpenOcdFailure("couldn't open mrvc_flash.cfg"));
  check('not transient: firmware file open error', !transientOpenOcdFailure('Could not open file missing.hex'));
  check('not transient: target examination failure', !transientOpenOcdFailure('Error: target examination failed'));
  // NOTE: an rvGcc-style over-broad classification is gone; the remaining
  // known false-positive shape is a file whose NAME contains "link" —
  // accepted (cost: ONE wasted retry on the internal passes).
  check('not transient: invalid flash address', !transientOpenOcdFailure('Error: invalid address 0x00000000 for bank'));
  check('not transient: empty log', !transientOpenOcdFailure(''));
}

// 2. verify/reset combinations
{
  fs.rmSync(scratch, { recursive: true, force: true });
  const p = prepareFlash({ ...base, verify: true, reset: false });
  check('verify only', readCfg(scratch).includes('program "E:/prj/obj/LED.hex" 0x00000000 verify exit'));
  fs.rmSync(scratch, { recursive: true, force: true });
  const q = prepareFlash({ ...base, verify: false, reset: true });
  check('reset only', readCfg(scratch).includes('program "E:/prj/obj/LED.hex" 0x00000000 reset exit'));
  fs.rmSync(scratch, { recursive: true, force: true });
  const r = prepareFlash({ ...base, verify: false, reset: false });
  check('neither', readCfg(scratch).includes('program "E:/prj/obj/LED.hex" 0x00000000 exit'));
  void p; void q; void r;
}

// 3. CH32-series address rides on BOTH lines (CH32V3xx/H417 = 0x08000000):
// bank base via wlink_set_address, image offset via program's address arg
{
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash({ ...base, address: '0x08000000' });
  check('non-zero address override (CH32V3xx/H417)', readCfg(scratch).startsWith('wlink_set_address 0x08000000'));
  check('program carries the same address as write offset', readCfg(scratch).includes('program "E:/prj/obj/LED.hex" 0x08000000 verify reset exit'));
}

// 4. invalid addresses are rejected before any file is written
{
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const bad of ['08000000', '0x', '0xG000', 'hello', '']) {
    let threw = false;
    try {
      prepareFlash({ ...base, address: bad });
    } catch {
      threw = true;
    }
    check(`invalid address rejected: "${bad}"`, threw);
  }
  check('no script written for invalid address', !fs.existsSync(path.join(scratch, 'mrvc_flash.cfg')));
  // an earlier section's rmSync may have removed it
  fs.mkdirSync(scratch, { recursive: true });
  // legacy filename from before the mrvc rename is cleaned up on every write
  fs.writeFileSync(path.join(scratch, 'mrs2_flash.cfg'), 'legacy');
  prepareFlash(base);
  check('legacy mrs2_flash.cfg cleaned up', !fs.existsSync(path.join(scratch, 'mrs2_flash.cfg')));
}

// 5. address regex shape (single guard shared with the properties page)
check('regex accepts 8-digit hex', ADDRESS_RE.test('0x08000000'));
check('regex accepts 1-digit hex', ADDRESS_RE.test('0x0'));
check('regex rejects bare hex and overflow', !ADDRESS_RE.test('0x00G00000') && !ADDRESS_RE.test('0x008000000'));

// 6. CH585 real-project shape regression (present-only guard)
{
  const REAL = 'F:/CH585/EVT/V1_2/EXAM/LED';
  if (fs.existsSync(path.join(REAL, '.template'))) {
    const tpl = {};
    for (const line of fs.readFileSync(path.join(REAL, '.template'), 'utf-8').split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0) tpl[line.slice(0, eq)] = line.slice(eq + 1);
    }
    check('real CH585 template: address is 0x-form', ADDRESS_RE.test(tpl['Address'] || ''));
    const dir = path.join(scratch, 'host_iap');
    const plan = prepareFlash({ ...base, buildDir: dir, address: tpl['Address'] || '0x00000000' });
    check('real CH585 address lands in the override line', readCfg(dir).startsWith(`wlink_set_address ${tpl['Address']}`));
    void plan;
  } else {
    console.log('SKIP  real CH585 template (tree not present)');
  }
}

// 7. chip database scan (MRS2 SDK component, present-only guard)
{
  const MRS2_ROOT =
    process.env.MRS2_HOME ||
    ['C:/MounRiver/MounRiver_Studio2', 'D:/MounRiver/MounRiver_Studio2'].find((r) =>
      fs.existsSync(path.join(r, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'manifest.json'))
    );
  const SDK = MRS2_ROOT
    ? `${MRS2_ROOT}/resources/app/resources/win32/components/WCH/SDK/default`
    : 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/components/WCH/SDK/default';
  if (fs.existsSync(SDK)) {
    const db = scanChipDb(SDK);
    check('chipdb: available', db.available === true);
    const h417 = db.series.find((s) => s.name === 'CH32H417');
    check('chipdb: CH32H417 series under RISC-V', !!h417 && h417.arch === 'RISC-V');
    check('chipdb: mcuType/address from flash.json', h417?.mcuType === 'CH32H417' && h417?.flashAddress === '0x08000000');
    check('chipdb: CH32H415REU model listed', !!h417?.chips.includes('CH32H415REU'));
    check('chipdb: ARM series present', db.series.some((s) => s.arch === 'ARM'));
    check('chipdb: chipDbRoot joins resourcesWin32', chipDbRoot('C:/MRS/res').endsWith('components' + path.sep + 'WCH' + path.sep + 'SDK' + path.sep + 'default'));
    check('chipdb: missing dir -> unavailable', scanChipDb(path.join(DEVELOP_DIR, '.scratch', 'no-such-sdk')).available === false);
    // the download target-chip guard compares these family ids: a V307
    // project (V30x) must not pass for a V4X7 board and vice versa
    const v30x = db.series.find((s) => s.mcuType === 'CH32V30x');
    const v4x7 = db.series.find((s) => s.mcuType === 'CH32V4X7');
    check('chipdb: V30x/V4X7 family ids both known and different', !!v30x && !!v4x7 && v30x.id > 0 && v4x7.id > 0 && v30x.id !== v4x7.id);
    // MRS2 swaps the whole flash control for a flash.json "special" model
    // (CH32V203CCT -> CH32V205, id 206) — the guard must not treat that
    // board as mismatched
    const v203 = db.series.find((s) => s.name === 'CH32V203');
    check('chipdb: CH32V203 special parsed', v203?.special?.mcu === 'CH32V203CCT' && v203?.special?.id === 206 && v203?.special?.mcuType === 'CH32V205');
    check('chipdb: special applies only to its model', chipForTemplate(db, { Series: 'CH32V203', MCU: 'CH32V203CCT' })?.id === 206);
    check('chipdb: special also matches the full part number', chipForTemplate(db, { Series: 'CH32V203', MCU: 'CH32V203CCT6' })?.id === 206);
    check('chipdb: other CH32V203 models keep the series id', chipForTemplate(db, { Series: 'CH32V203', MCU: 'CH32V203C8T6' })?.id === v203?.id);
  } else {
    console.log('SKIP  chipdb scan (MRS2 SDK not present)');
  }
}

// 7b. project .template -> series resolution (shared by the properties page
// and the download target-chip guard): MRS2's fallback chain Series ->
// Mcu Type -> MCU model, with trimming; unknown values resolve to nothing
// (the guard then skips instead of blocking).
{
  const db = {
    available: true,
    series: [
      { name: 'CH32V307', arch: 'RISC-V', mcuType: 'CH32V30x', flashAddress: '0x08000000', chips: ['CH32V307VCT6'], id: 6, support: {} },
      { name: 'CH32V4X7', arch: 'RISC-V', mcuType: 'CH32V4X7', flashAddress: '0x08000000', chips: ['CH32V407VET6'], id: 166, support: {} },
      { name: 'CH32V20x', arch: 'RISC-V', mcuType: 'CH32V20x', flashAddress: '0x08000000', chips: ['CH32V203C8T6', 'CH32V203CCT'], id: 8, support: {}, special: { mcu: 'CH32V203CCT', mcuType: 'CH32V205', id: 206, support: {} } },
    ],
  };
  check('seriesForTemplate: Series wins over Mcu Type/MCU', seriesForTemplate(db, { Series: 'CH32V4X7', 'Mcu Type': 'CH32V30x', MCU: 'CH32V203C8T6' })?.id === 166);
  check('seriesForTemplate: falls back to Mcu Type', seriesForTemplate(db, { 'Mcu Type': 'CH32V30x' })?.id === 6);
  check('seriesForTemplate: trims and falls back to the MCU model', seriesForTemplate(db, { MCU: ' CH32V203C8T6 ' })?.id === 8);
  check('seriesForTemplate: MRS2 slice fallback (MCU part number vs zip name)', seriesForTemplate(db, { MCU: 'CH32V203CCT6' })?.id === 8);
  check('seriesForTemplate: unknown project values -> undefined', seriesForTemplate(db, { Series: 'CH32X999', MCU: 'CH32X999' }) === undefined);
  check('seriesForTemplate: empty template -> undefined', seriesForTemplate(db, {}) === undefined);
  check('chipForTemplate: special override applies to its model', chipForTemplate(db, { Series: 'CH32V20x', MCU: 'CH32V203CCT6' })?.id === 206);
  check('chipForTemplate: other models keep the series control', chipForTemplate(db, { Series: 'CH32V20x', MCU: 'CH32V203C8T6' })?.id === 8);
  check('chipForTemplate: non-special series unaffected', chipForTemplate(db, { Series: 'CH32V307', MCU: 'CH32V307VCT6' })?.mcuType === 'CH32V30x');
  check('chipForTemplate: unknown project -> undefined', chipForTemplate(db, {}) === undefined);
}

// 7c. download target-chip decision (round5 P3): the pure comparison the
// download pipeline runs after GetLinkedMCUID — trusted-only, skip on every
// unknown, and report every series that shares the linked family id
{
  const db = {
    available: true,
    series: [
      { name: 'CH32V307', arch: 'RISC-V', mcuType: 'CH32V30x', flashAddress: '0x08000000', chips: ['CH32V307VCT6'], id: 6, support: {} },
      { name: 'CH32V4X7', arch: 'RISC-V', mcuType: 'CH32V4X7', flashAddress: '0x08000000', chips: ['CH32V407VET6'], id: 166, support: {} },
      { name: 'CH32M007', arch: 'RISC-V', mcuType: 'CH32M007', flashAddress: '0x08000000', chips: ['CH32M007A'], id: 78, support: {} },
      { name: 'CH32V002', arch: 'RISC-V', mcuType: 'CH32V002/4/5/6/7', flashAddress: '0x08000000', chips: ['CH32V006A'], id: 78, support: {} },
    ],
  };
  const v307 = { Series: 'CH32V307', MCU: 'CH32V307VCT6' };
  const v407 = { Series: 'CH32V4X7', MCU: 'CH32V407VET6' };
  const m = chipTargetMismatch(db, v307, 166, true);
  check('chipTargetMismatch: trusted different ids -> warning (connected/expected names)', m?.connected === 'CH32V4X7' && m?.expected === 'CH32V307VCT6');
  check('chipTargetMismatch: reverse direction warns too', chipTargetMismatch(db, v407, 6, true)?.connected === 'CH32V30x');
  check('chipTargetMismatch: same family id -> no warning', chipTargetMismatch(db, v307, 6, true) === undefined);
  check('chipTargetMismatch: untrusted raw 6 with V30x project -> skipped (no false pass)', chipTargetMismatch(db, v307, 6, false) === undefined);
  check('chipTargetMismatch: untrusted raw 6 with V4X7 project -> skipped (no false warning)', chipTargetMismatch(db, v407, 6, false) === undefined);
  check('chipTargetMismatch: linked 0/undefined -> skipped', chipTargetMismatch(db, v307, 0, true) === undefined && chipTargetMismatch(db, v307, undefined, true) === undefined);
  check('chipTargetMismatch: id outside the SDK -> skipped', chipTargetMismatch(db, v307, 999, true) === undefined);
  check('chipTargetMismatch: unknown project target -> skipped', chipTargetMismatch(db, { Series: 'CH32X999' }, 166, true) === undefined);
  check('chipTargetMismatch: unavailable db -> skipped', chipTargetMismatch({ available: false, series: db.series }, v307, 166, true) === undefined);
  const dup = chipTargetMismatch(db, v307, 78, true)?.connected || '';
  check('chipTargetMismatch: shared family id lists every candidate', dup === 'CH32M007 / CH32V002/4/5/6/7');

  // round6 P3: the guard resolves the project target BEFORE touching the
  // link — a .template-less EVT project must not pay a needless query
  let calls = 0;
  const noTarget = await guardLinkedChip(db, {}, async () => {
    calls++;
    return { result: 166, initState: 'ok' };
  });
  check('guardLinkedChip: unknown target -> zero link queries', noTarget === undefined && calls === 0);
  calls = 0;
  const warn = await guardLinkedChip(db, v307, async () => {
    calls++;
    return { result: 166, initState: 'ok' };
  });
  check('guardLinkedChip: known target queries once and warns', warn?.connected === 'CH32V4X7' && calls === 1);
  calls = 0;
  const same = await guardLinkedChip(db, v307, async () => {
    calls++;
    return { result: 6, initState: 'ok' };
  });
  check('guardLinkedChip: known target, same family -> no warning', same === undefined && calls === 1);
  calls = 0;
  const untrusted = await guardLinkedChip(db, v307, async () => {
    calls++;
    return { result: 166, initState: 'failed' };
  });
  check('guardLinkedChip: untrusted result -> no warning', untrusted === undefined && calls === 1);
}

// 8. chip-family address inference (EVT trees ship without .template)
{
  check('infer: ch32v30x driver file -> 0x08000000', inferFlashAddress(['F:/x/SRC/ch32v30x_gpio.c']) === '0x08000000');
  check('infer: ch32v30x startup -> 0x08000000', inferFlashAddress(['F:/x/SRC/Startup/startup_ch32v30x_D8.S']) === '0x08000000');
  check('infer: CH58x driver file -> 0x00000000', inferFlashAddress(['F:/x/SRC/CH58x_uart0.c']) === '0x00000000');
  check('infer: CH585 startup -> 0x00000000', inferFlashAddress(['F:/x/SRC/Startup/startup_CH585.S']) === '0x00000000');
  check('infer: ch32h417 startup -> 0x08000000', inferFlashAddress(['F:/x/Startup/startup_ch32h417_v3f.S']) === '0x08000000');
  check('infer: CH564 differs from CH56x', inferFlashAddress(['F:/x/ch564_usb.c']) === '0x08000000' && inferFlashAddress(['F:/x/ch56x_usb.c']) === '0x00000000');
  check('infer: plain names -> undefined', inferFlashAddress(['F:/x/Main.c', 'F:/x/User/app.c']) === undefined && inferFlashAddress([]) === undefined);
  check('infer: backslash paths', inferFlashAddress(['F:\\x\\SRC\\ch32v30x_gpio.c']) === '0x08000000');
}

// 9. real-tree inference through the actual scanner (present-only guard):
// template-less V307/H417 EVT projects must infer 0x08000000, CH585 -> 0x00000000
{
  const cases = [
    ['F:/CH32V307/EVT/V2_9/EXAM/ETH/UDPServer', '0x08000000'],
    ['F:/CH585/EVT/V1_2/EXAM/LED', '0x00000000'],
    ['F:/CH32H417/EVT/V1_0/EXAM/ADC/ADC_DMA/V3F', '0x08000000'],
  ];
  for (const [root, want] of cases) {
    if (!fs.existsSync(path.join(root, '.cproject'))) {
      console.log(`SKIP  real infer (${path.basename(root)} tree not present)`);
      continue;
    }
    const cp = Cproject.load(root);
    const paths = [];
    for (const files of scanSources(cp).values()) for (const f of files) paths.push(f.fullpath);
    check(`real infer: ${path.basename(root)} -> ${want}`, inferFlashAddress(paths) === want);
  }
}

// 10. hex base detection: the program offset compensates a non-zero ORIGIN
// (a hex already linked at the physical base must not be shifted again)
{
  const fwBase0 = path.join(scratch, 'fw0.hex');
  const fwBase8 = path.join(scratch, 'fw8.hex');
  fs.mkdirSync(scratch, { recursive: true }); // an earlier section's rmSync may have removed it
  fs.writeFileSync(fwBase0, ':100000006F00407613000000130000001300000092\n:00000001FF\n', 'utf-8');
  fs.writeFileSync(fwBase8, ':020000040800F2\n:100000006F00407613000000130000001300000092\n:00000001FF\n', 'utf-8');
  check('hexBase: base-0 hex -> 0', hexBaseAddress(fs.readFileSync(fwBase0, 'utf-8')) === 0);
  check('hexBase: 0x08000000-ELA hex -> 0x08000000', hexBaseAddress(fs.readFileSync(fwBase8, 'utf-8')) === 0x08000000);
  check('hexBase: no data records -> undefined', hexBaseAddress('hello\n:00000001FF\n') === undefined);
  prepareFlash({ ...base, firmware: fwBase8, address: '0x08000000' });
  const cfg8 = readCfg(scratch);
  check('offset: hex already at the base -> offset 0x0', cfg8.includes(' 0x0 verify reset exit'));
  check('offset: bank base still the full address', cfg8.startsWith('wlink_set_address 0x08000000'));
  prepareFlash({ ...base, firmware: fwBase0, address: '0x08000000' });
  check('offset: base-0 hex keeps the full address as offset', readCfg(scratch).includes(' 0x08000000 verify reset exit'));
  prepareFlash({ ...base, firmware: fwBase8, address: '0x00000000' });
  const cfgMoved = readCfg(scratch);
  check('window: A < hexBase -> bank window moves onto the image', cfgMoved.startsWith('wlink_set_address 0x8000000'));
  check('window: moved mode programs with offset 0', cfgMoved.includes(' 0x0 verify reset exit'));
}

// 11. ANSI-artifact encoding selection, aligned with MRS2's
// getSystemANSIEncoding (ACP 936 -> GBK, detection failure -> GBK,
// CJK ACPs -> the matched double-byte charset, everything else incl.
// UTF-8 beta 65001 and non-Windows -> UTF-8)
{
  check('acp: 936 (Chinese) -> gbk', encodingForAcp('936') === 'gbk');
  check('acp: 65001 (UTF-8 beta) -> utf-8', encodingForAcp('65001') === 'utf-8');
  check('acp: 1252 (Western) -> utf-8', encodingForAcp('1252') === 'utf-8');
  check('acp: undetectable -> gbk (MRS2 fallback)', encodingForAcp(undefined) === 'gbk');
  check('acp: non-Windows always utf-8', encodingForAcp('936', 'linux') === 'utf-8' && encodingForAcp(undefined, 'darwin') === 'utf-8');
  check('acp: 932 (Japanese) -> shift-jis (MRS2 matched encoding)', encodingForAcp('932') === 'shift-jis');
  check('acp: 949 (Korean) -> euc-kr', encodingForAcp('949') === 'euc-kr');
  check('acp: 950 (Trad. Chinese) -> big5', encodingForAcp('950') === 'big5');
}

// 12. Erase All (.template flag): the OpenOCD program proc expanded with a
// full-bank scrub inserted between reset init and the write - the proc's
// own unconditional `init` forbids prepending an erase to a `program` call
{
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash({ ...base, eraseAll: true });
  const lines = readCfg(scratch).split('\n').filter((l) => l.trim());
  check('eraseAll: address override stays first (bank base at probe time)', lines[0] === 'wlink_set_address 0x00000000');
  check('eraseAll: init once, then reset init', lines[1] === 'init' && lines[2] === 'reset init');
  check('eraseAll: single bank scrubbed to last sector', lines[3] === 'flash erase_sector 0 0 last');
  check(
    'eraseAll: progress echo + write_image erase keeps the offset',
    lines[4] === 'echo "** Programming Started **"' && lines[5] === 'flash write_image erase "E:/prj/obj/LED.hex" 0x00000000' && lines[6] === 'echo "** Programming Finished **"'
  );
  check(
    'eraseAll: verify/reset/shutdown mirror the program proc',
    lines[7] === 'echo "** Verify Started **"' &&
      lines[8] === 'verify_image "E:/prj/obj/LED.hex" 0x00000000' &&
      lines[9] === 'echo "** Verified OK **"' &&
      lines[10] === 'poll off' &&
      lines[11] === 'echo "** Resetting Target **"' &&
      lines[12] === 'reset run' &&
      lines[13] === 'shutdown'
  );
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash({ ...base, eraseAll: true, banks: 2 });
  const dual = readCfg(scratch);
  check('eraseAll dual-core: banks 0 and 1 both scrubbed', dual.includes('flash erase_sector 0 0 last') && dual.includes('flash erase_sector 1 0 last'));
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash({ ...base, eraseAll: true, verify: false, reset: false });
  const bare = readCfg(scratch);
  check('eraseAll: verify/reset omitted when disabled', !bare.includes('verify_image') && !bare.includes('reset run') && bare.trimEnd().endsWith('shutdown'));
}

// 13. Download Settings display form of the resolved target (review round2
// §2): only ABSOLUTE paths may go through path.relative; an unresolved raw
// value (recorded Target Path of an unbuilt project) must be shown verbatim —
// running path.relative() on it folds in the process cwd and shows garbage.
{
  const root = path.resolve('E:/prj');
  const inside = path.join(root, 'obj', 'LED.hex');
  check('display: absolute under the root -> relative', displayTargetPath(root, inside) === path.join('obj', 'LED.hex'));
  const outside = path.join(path.dirname(root), 'other', 'LED.hex');
  check('display: absolute outside the root stays absolute', displayTargetPath(root, outside) === outside);
  check('display: unresolved raw relative value shown verbatim', displayTargetPath(root, 'obj/LiteOS_m.hex') === 'obj/LiteOS_m.hex');
  check('display: empty value stays empty', displayTargetPath(root, '') === '');
}

// drop the per-run fixture dir
fs.rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILURES` : '\nall flash tests passed');
process.exit(failures ? 1 : 0);
