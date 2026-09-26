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

// 1. default plan (verify + reset)
{
  const plan = prepareFlash(base);
  check('args: board cfg first, script second', JSON.stringify(plan.args) === JSON.stringify(['-f', 'C:/MRS/wch-riscv.cfg', '-f', plan.scriptPath]));
  check('script written into the build dir', path.dirname(plan.scriptPath) === path.resolve(scratch));
  const cfg = readCfg(scratch);
  const lines = cfg.split('\n').filter((l) => l.trim());
  check('cfg has exactly two lines', lines.length === 2);
  check('address override line first', lines[0] === 'wlink_set_address 0x00000000');
  check('program line is Tcl-quoted with verify+reset+exit', lines[1] === 'program "E:/prj/obj/LED.hex" verify reset exit');
}

// 2. verify/reset combinations
{
  fs.rmSync(scratch, { recursive: true, force: true });
  const p = prepareFlash({ ...base, verify: true, reset: false });
  check('verify only', readCfg(scratch).includes('program "E:/prj/obj/LED.hex" verify exit'));
  fs.rmSync(scratch, { recursive: true, force: true });
  const q = prepareFlash({ ...base, verify: false, reset: true });
  check('reset only', readCfg(scratch).includes('program "E:/prj/obj/LED.hex" reset exit'));
  fs.rmSync(scratch, { recursive: true, force: true });
  const r = prepareFlash({ ...base, verify: false, reset: false });
  check('neither', readCfg(scratch).includes('program "E:/prj/obj/LED.hex" exit'));
  void p; void q; void r;
}

// 3. CH32-series address rides on the override line (CH32V3xx/H417 = 0x08000000)
{
  fs.rmSync(scratch, { recursive: true, force: true });
  prepareFlash({ ...base, address: '0x08000000' });
  check('non-zero address override (CH32V3xx/H417)', readCfg(scratch).startsWith('wlink_set_address 0x08000000'));
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
  const HOST_IAP = 'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/USB/USBHS/HOST_IAP/HOST_IAP';
  if (fs.existsSync(path.join(HOST_IAP, '.template'))) {
    const tpl = {};
    for (const line of fs.readFileSync(path.join(HOST_IAP, '.template'), 'utf-8').split(/\r?\n/)) {
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
  const SDK = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32/components/WCH/SDK/default';
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

console.log(failures ? `\n${failures} FAILURES` : '\nall flash tests passed');
process.exit(failures ? 1 : 0);
