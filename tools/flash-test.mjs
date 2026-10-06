/*
 * Flash script builder tests (pure Node, synthetic fixture — no real tree).
 * Covers: cfg content and address override line, verify/reset combinations,
 * invalid-address rejection, script placement in the build dir.
 */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEVELOP_DIR = path.dirname(here); // .../develop
const { prepareFlash, ADDRESS_RE } = require(path.join(DEVELOP_DIR, 'out', 'core', 'flash.js'));
const { scanChipDb, chipDbRoot } = require(path.join(DEVELOP_DIR, 'out', 'core', 'chipdb.js'));
const { inferFlashAddress, hexBaseAddress } = require('../out/core/flash.js');
const { encodingForAcp } = require('../out/core/platformEncoding.js');
const { Cproject } = require('../out/core/cproject.js');
const { scanSources } = require('../out/core/scan.js');

const scratch = path.join(DEVELOP_DIR, '.scratch', 'flash');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};
const readCfg = (dir) => fs.readFileSync(path.join(dir, 'mrs2_flash.cfg'), 'utf-8');

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

const base = { buildDir: scratch, address: '0x00000000', verify: true, reset: true, boardCfg: 'C:/MRS/wch-riscv.cfg', firmware: 'E:/prj/obj/LED.hex' };
const bsBase = { ...base, firmware: 'E:' + String.raw`\prj\obj with space\LED.hex` }; // Windows backslashes + a space

// 1. default plan (verify + reset)
{
  const plan = prepareFlash(base);
  check('args: board cfg first, script second', JSON.stringify(plan.args) === JSON.stringify(['-f', 'C:/MRS/wch-riscv.cfg', '-f', plan.scriptPath]));
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
  check('no script written for invalid address', !fs.existsSync(path.join(scratch, 'mrs2_flash.cfg')));
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
  } else {
    console.log('SKIP  chipdb scan (MRS2 SDK not present)');
  }
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
  check('eraseAll: write_image erase keeps the offset', lines[4] === 'flash write_image erase "E:/prj/obj/LED.hex" 0x00000000');
  check(
    'eraseAll: verify/reset/shutdown mirror the program proc',
    lines[5] === 'verify_image "E:/prj/obj/LED.hex" 0x00000000' && lines[6] === 'poll off' && lines[7] === 'reset run' && lines[8] === 'shutdown'
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

console.log(failures ? `\n${failures} FAILURES` : '\nall flash tests passed');
process.exit(failures ? 1 : 0);
