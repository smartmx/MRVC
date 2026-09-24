/*
 * Exclude/Include From Build tests (scratch copies + read-only real trees).
 * Covers: state query (named-entry + root-entry styles), token write
 * placement (MRS2 conventions), root-entry creation, persistence across
 * save/reload, scan + makefile effects, and token removal.
 */
const path = require('path');
const fs = require('fs');
const { Cproject } = require('../out/core/cproject.js');
const { scanSources, isLogicExcluded, exclusionFsPaths } = require('../out/core/scan.js');
const { generateMakefiles } = require('../out/core/makefile.js');

const BLE_UART = 'F:/CH585/EVT/V1_2/EXAM/BLE/BLE_UART';
const DEVELOP_DIR = path.dirname(__dirname); // .../develop
const scratch = path.join(DEVELOP_DIR, '.scratch', 'exclude');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// ---------- 1. query semantics on the untouched real tree ----------
{
  const cp = Cproject.load(BLE_UART);
  // real folder APP with its own named entry, folder-relative tokens
  check('named real-dir file excluded (APP)', isLogicExcluded(cp, 'APP/ble_uart_service/ble_uart_service.c') === true);
  check('named real-dir nested file not excluded (APP)', isLogicExcluded(cp, 'APP/peripheral_main.c') === false);
  // linked folder HAL, folder-relative tokens in named entry
  check('named linked file excluded (HAL/KEY.c)', isLogicExcluded(cp, 'HAL/KEY.c') === true);
  check('named linked file not excluded (HAL/other.c)', isLogicExcluded(cp, 'HAL/other.c') === false);
  // linked StdPeriphDriver named entry
  check('named linked file excluded (usbdev)', isLogicExcluded(cp, 'StdPeriphDriver/CH59x_usbdev.c') === true);
  check('named linked file not excluded (timer0)', isLogicExcluded(cp, 'StdPeriphDriver/CH59x_timer0.c') === false);
  // the top-level Profile link is NOT excluded even though 'Profile' is a
  // token inside the HAL entry (cross-folder marker, applies inside HAL only)
  check('top-level link not marked by foreign token (Profile)', isLogicExcluded(cp, 'Profile') === false);
  check('HAL subfolder marker applies inside HAL (Profile)', isLogicExcluded(cp, 'HAL/Profile/anything.c') === true);
}

// ---------- 2. root-entry style (CH32V307 HOST_IAP) query ----------
{
  const host = findProjectWith('F:/CH32V307/EVT/V2_9/EXAM', 'usb_host_iap_0.c');
  check('root-entry style project found', !!host);
  if (host) {
    const cp = Cproject.load(host);
    check('root entry full-path token excluded', isLogicExcluded(cp, 'User/usb_host_iap_0.c') === true);
    check('root entry full-path header token excluded', isLogicExcluded(cp, 'User/usb_host_iap_0.h') === true);
    check('root entry non-excluded file', isLogicExcluded(cp, 'User/ch32v30x_it.c') === false);
  }
}

// ---------- 2.5 case-insensitive token matching (Windows fs semantics) ----------
// USBPD excludes 'StdPeriphDriver/ch58x_led.c' (lowercase) while the file on
// disk is 'CH58x_led.c' (uppercase) — same file on a case-insensitive fs.
{
  const usbpd = Cproject.load('F:/CH587/EVT/V1_0/EXAM/USBPD');
  const expect = process.platform === 'win32';
  check('case-mismatched token excluded (led .c)', isLogicExcluded(usbpd, 'StdPeriphDriver/CH58x_led.c') === expect);
  check('case-mismatched token excluded (led .h)', isLogicExcluded(usbpd, 'StdPeriphDriver/inc/CH58x_led.h') === expect);
  check('case-mismatch still excludes exact case', isLogicExcluded(usbpd, 'StdPeriphDriver/ch58x_led.c') === expect);
}

// ---------- 3. write path on a scratch copy ----------
fs.rmSync(scratch, { recursive: true, force: true });
fs.cpSync(BLE_UART, scratch, { recursive: true });
// link targets point outside the project and are gone in the scratch copy —
// the write path only manipulates XML, scans use the real APP/ tree
const cp = Cproject.load(scratch);
const appOrig = cp.sourceEntries.find((e) => e.name === 'APP').excluding.slice();
const spdOrig = cp.sourceEntries.find((e) => e.name === 'StdPeriphDriver').excluding.slice();

// 3a. real folder with named entry -> folder-relative token into APP entry
cp.excludeResource('APP/foo.c');
let app = cp.sourceEntries.find((e) => e.name === 'APP');
check('APP token appended', app.excluding.join('|') === [...appOrig, 'foo.c'].join('|'));
check('other entries untouched (StdPeriphDriver)', cp.sourceEntries.find((e) => e.name === 'StdPeriphDriver').excluding.join('|') === spdOrig.join('|'));
check('no root entry created when named entry covers it', cp.sourceEntries.filter((e) => e.name === '').length === 0);

// 3b. idempotent
cp.excludeResource('APP/foo.c');
check('duplicate exclude is a no-op', cp.sourceEntries.find((e) => e.name === 'APP').excluding.length === appOrig.length + 1);

// 3c. linked content -> named entry of the link
cp.excludeResource('StdPeriphDriver/CH59x_new.c');
check('link content token into StdPeriphDriver entry', cp.sourceEntries.find((e) => e.name === 'StdPeriphDriver').excluding.join('|') === [...spdOrig, 'CH59x_new.c'].join('|'));

// 3d. resource without named entry -> root entry created, excluding first attr
cp.excludeResource('User/deep/x.c');
const rootEntries = cp.sourceEntries.filter((e) => e.name === '');
check('root entry created', rootEntries.length === 1 && rootEntries[0].excluding.join('|') === 'User/deep/x.c');

// ---------- 4. persistence + scan + makefile effect ----------
cp.save();
const cp2 = Cproject.load(scratch);
check('exclusion survives save/reload (APP/foo.c)', isLogicExcluded(cp2, 'APP/foo.c') === true);
check('exclusion survives save/reload (link content)', isLogicExcluded(cp2, 'StdPeriphDriver/CH59x_new.c') === true);
check('exclusion survives save/reload (root entry)', isLogicExcluded(cp2, 'User/deep/x.c') === true);
check('untouched files still included after reload', isLogicExcluded(cp2, 'StdPeriphDriver/CH59x_timer0.c') === false);

// scan + generated makefile honour the exclusion (real file in scratch APP/)
fs.writeFileSync(path.join(scratch, 'APP', 'foo.c'), 'int foo(void){return 1;}\n');
const appScan = scanSources(cp2).get('APP') ?? [];
check('scan drops excluded APP/foo.c', appScan.some((f) => f.logicName === 'APP/foo.c') === false);
generateMakefiles(cp2, goldenTc());
check('generated makefiles have no foo.o while excluded', !mkText(cp2).includes('foo.o'));

cp2.includeResource('APP/foo.c');
cp2.save();
const cp3 = Cproject.load(scratch);
check('include restores scan', (scanSources(cp3).get('APP') ?? []).some((f) => f.logicName === 'APP/foo.c') === true);
generateMakefiles(cp3, goldenTc());
check('generated makefiles have foo.o again', mkText(cp3).includes('foo.o'));
app = cp3.sourceEntries.find((e) => e.name === 'APP');
check('APP entry back to original tokens', app.excluding.join('|') === appOrig.join('|'));

// ---------- 5. emptied lists keep excluding="" (MRS2 style) ----------
for (const t of appOrig) cp3.includeResource('APP/' + t);
const appEl = cp3.sourceEntries.find((e) => e.name === 'APP').element;
check('emptied APP entry keeps excluding attr as empty string', appEl.attr('excluding') === '');
// original tokens must all be removable by includeResource
check('all original APP tokens removed', cp3.sourceEntries.find((e) => e.name === 'APP').excluding.length === 0);

// ---------- 6. serialized XML sanity ----------
cp3.save();
const raw = fs.readFileSync(path.join(scratch, '.cproject'), 'utf-8');
check('serialized .cproject still has all named entries', (raw.match(/kind="sourcePath"/g) || []).length >= 8);
check('new root entry written with excluding as first attribute', /<entry excluding="User\/deep\/x\.c" flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""\/>/.test(raw));

// ---------- 7. case-variant link-name marker must not exclude the link ----------
// root entry marker `stdperiphdriver` (lowercase) vs link name `StdPeriphDriver`:
// with folded matching the marker must still be recognized and NOT nuke the
// whole linked folder
{
  const base = path.join(DEVELOP_DIR, '.scratch', 'excl-marker');
  const proj = path.join(base, 'proj');
  const libs = path.join(base, 'libs', 'StdPeriphDriver');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(libs, 'inc'), { recursive: true });
  fs.writeFileSync(path.join(libs, 'keep.c'), 'int keep(void){return 1;}\n');
  fs.writeFileSync(path.join(libs, 'inc', 'keep.h'), '');
  fs.writeFileSync(
    path.join(proj, '.project'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription>\n<name>marker</name>\n<linkedResources>\n<link>\n<name>StdPeriphDriver</name>\n<type>2</type>\n<location>${libs}</location>\n</link>\n</linkedResources>\n</projectDescription>`
  );
  fs.writeFileSync(
    path.join(proj, '.cproject'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry excluding="stdperiphdriver" flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>`
  );
  const cp = Cproject.load(proj);
  const files = (scanSources(cp).get('StdPeriphDriver') ?? []).map((f) => f.logicName);
  check('case-variant marker: linked .c still scanned', files.includes('StdPeriphDriver/keep.c'));
  check('case-variant marker: query says not excluded', isLogicExcluded(cp, 'StdPeriphDriver/keep.c') === false);
  const mapped = exclusionFsPaths(cp, proj);
  check('case-variant marker: skipped by decoration mapping', mapped.length === 0);
}

// ---------- 8. bare-name root tokens resolve into linked folders (CH585) ----------
{
  const host = findProjectWith('F:/CH585/EVT/V1_2/EXAM', 'CH58x_usbhostClass.c');
  check('bare-token CH585 project found', !!host);
  if (host) {
    const cp = Cproject.load(host);
    const mapped = exclusionFsPaths(cp, host);
    const hits = mapped.filter((p) => /ch58x_usbhostclass\.c$/i.test(p));
    check(`bare token maps into a linked folder (hits: ${hits.length})`, hits.length > 0);
    const links = [...cp.linkedFolders.values()];
    check('mapped path lives under one of the project links', hits.every((p) => links.some((l) => p.startsWith(l))));
    check('mapping stays consistent with the scanner', isLogicExcluded(cp, 'StdPeriphDriver/CH58x_usbhostClass.c') === true);
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nall exclude tests passed');
process.exit(failures ? 1 : 0);

// ---------- helpers ----------
/** concatenated text of every generated .mk file under the build dir */
function mkText(cp) {
  const out = [];
  const buildRoot = path.resolve(scratch, cp.configName);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.resolve(dir, e.name);
      if (!full.startsWith(buildRoot + path.sep)) continue; // stay inside build dir
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.mk') || e.name === 'makefile') out.push(fs.readFileSync(full, 'utf-8'));
    }
  };
  walk(buildRoot);
  return out.join('\n');
}

function findProjectWith(root, needle) {
  const rootAbs = path.resolve(root);
  const stack = [rootAbs];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.resolve(dir, e.name);
      if (!full.startsWith(rootAbs + path.sep)) continue; // stay inside scan root
      if (fs.existsSync(path.join(full, '.cproject'))) {
        if (fs.readFileSync(path.join(full, '.cproject'), 'utf-8').includes(needle)) return full;
      }
      stack.push(full);
    }
  }
  return undefined;
}

function goldenTc() {
  return {
    name: 'GCC8',
    dir: '',
    compilerC: 'riscv-none-embed-gcc',
    compilerCpp: 'riscv-none-embed-g++',
    linkerC: 'riscv-none-embed-gcc',
    linkerCpp: 'riscv-none-embed-g++',
    debugger: 'riscv-none-embed-gdb',
    objcopy: 'riscv-none-embed-objcopy',
    objdump: 'riscv-none-embed-objdump',
    size: 'riscv-none-embed-size',
    prefix: 'riscv-none-embed-',
  };
}
