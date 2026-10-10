/*
 * Tree/batch enhancement tests: file flags (MRS2-compatible
 * .mrs/preferredColor.json) and the batch toolchain modify write-back.
 * Run: node tools/enhancements-test.js
 */
const path = require('path');
const fs = require('fs');

const {
  MARK_COLORS,
  setMark,
  clearMark,
  listMarks,
  markColorByAlias,
  themeColorFor,
} = require('../out/core/colorMarks.js');
const { Cproject } = require('../out/core/cproject.js');
const { scanSources } = require('../out/core/scan.js');
const { selectToolchain } = require('../out/core/toolchain.js');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// ---------- 1. colorMarks: MRS2 file shape ----------
{
  const root = path.join(__dirname, '..', '.scratch', 'colormarks');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'SRC'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SRC', 'a.c'), 'int a;\n');

  const links = new Map(); // no linked folders here
  setMark(root, links, 'SRC/a.c', 'Green');
  setMark(root, links, 'SRC/a.c', 'Blue'); // re-flag overwrites

  const raw = JSON.parse(fs.readFileSync(path.join(root, '.mrs', 'preferredColor.json'), 'utf-8'));
  check('flag: MRS2 file shape {details:[{logic_file,color}]}', Array.isArray(raw.details) && raw.details.length === 1 && raw.details[0].logic_file === 'SRC/a.c' && raw.details[0].color === 'Blue' && raw.details[0].abs_file === undefined);

  const marks = listMarks(root, links);
  check('flag: list returns abs + logic + color', marks.length === 1 && marks[0].logicFile === 'SRC/a.c' && marks[0].color === 'Blue' && path.resolve(marks[0].absFile) === path.resolve(path.join(root, 'SRC', 'a.c')));

  clearMark(root, links, 'SRC/a.c');
  check('flag: clear removes the entry', listMarks(root, links).length === 0);
  const raw2 = JSON.parse(fs.readFileSync(path.join(root, '.mrs', 'preferredColor.json'), 'utf-8'));
  check('flag: clear persists an empty details list', Array.isArray(raw2.details) && raw2.details.length === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- 2. colorMarks: linked folder logic path + MRS2 file read-back ----------
{
  const root = path.join(__dirname, '..', '.scratch', 'colormarks-link');
  const lib = path.join(root, 'outside', 'LIB');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(lib, 'inc'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'inc', 'x.h'), '');
  fs.mkdirSync(root, { recursive: true });

  // a file written by MRS2 (logic_file only, linked path)
  fs.mkdirSync(path.join(root, '.mrs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.mrs', 'preferredColor.json'),
    JSON.stringify({ details: [{ logic_file: 'LIB/inc/x.h', color: 'Teal' }] }),
    'utf-8'
  );
  const links = new Map([['LIB', lib]]);
  const marks = listMarks(root, links);
  check('flag: MRS2-written file read back, abs resolved through the link', marks.length === 1 && marks[0].color === 'Teal' && path.resolve(marks[0].absFile) === path.resolve(path.join(lib, 'inc', 'x.h')));

  clearMark(root, links, 'LIB/inc/x.h');
  check('flag: clear works on a linked file', listMarks(root, links).length === 0);

  // color table: 20 MRS2 aliases + theme mapping total
  check('colors: 20 MRS2 aliases', MARK_COLORS.length === 20 && !!markColorByAlias('teal') && !markColorByAlias('nope'));
  check('colors: theme mapping covers all aliases', MARK_COLORS.every((c) => themeColorFor(c.alias).startsWith('terminal.ansi')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- 3. batch toolchain write-back (the command's core step) ----------
{
  const LED_PROJ = ['E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'F:/CH585/EVT/V1_2/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find((p) =>
    fs.existsSync(path.join(p, '.cproject'))
  );
  if (!LED_PROJ) {
    console.log('SKIP  3. toolchain write-back (no real LED tree found)');
  } else {
    const WS = path.join(__dirname, '..', '.scratch', 'toolchain-batch');
    fs.rmSync(WS, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
    const p1 = path.join(WS, 'p1');
    fs.cpSync(LED_PROJ, p1, { recursive: true });

    const OPT_BASE = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
    const cp = Cproject.load(p1);
    const before = cp.rvGccVersion;
    const isRiscv = /riscv/i.test(cp.toolChain.attr('superClass') ?? '');
    check('toolchain fixture: LED is RISC-V', isRiscv);
    // the exact write step of modifySolutionToolchainCmd
    const version = before === '15' ? '12' : '15'; // flip to a DIFFERENT value
    cp.setOptionValue('target.rvGcc', OPT_BASE + 'target.rvGcc.' + version);
    cp.save();
    const reloaded = Cproject.load(p1);
    check('toolchain: rvGcc rewritten and reads back', reloaded.rvGccVersion === version);
    // and the toolchain resolver follows it (the command's effect)
    const MRS2_ROOT = process.env.MRS2_HOME || 'C:/MounRiver/MounRiver_Studio2';
    const install = (() => {
      try {
        const { locateInstall } = require('../out/core/toolchain.js');
        return locateInstall(MRS2_ROOT);
      } catch {
        return null;
      }
    })();
    if (install) {
      const tc = selectToolchain(install, 'auto', reloaded.rvGccVersion, reloaded.storedPrefix);
      check('toolchain: resolver follows the new rvGcc (' + version + ')', !!tc && tc.name.toUpperCase().includes('GCC' + version));
    } else {
      console.log('SKIP  toolchain resolver probe (no MRS2 install)');
    }
    fs.rmSync(WS, { recursive: true, force: true });
  }
}

// ---------- 4. deep linked-folder scan (changelog V0.1.9 勘误的回归背书:
// "深层拆分只识别第 1 层" 系误判——MRVC 构建扫描与 MRS2 同为完整递归) ----------
{
  const base = path.join(__dirname, '..', '.scratch', 'deep-link');
  const proj = path.join(base, 'proj');
  const lib = path.join(base, 'libsrc');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(lib, 'Deep', 'USB'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'top.c'), 'int t;\n');
  fs.writeFileSync(path.join(lib, 'Deep', 'mid.c'), 'int m;\n');
  fs.writeFileSync(path.join(lib, 'Deep', 'USB', 'usb.c'), 'int u;\n');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.project'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription>\n<name>deep</name>\n<linkedResources>\n<link>\n<name>LIB</name>\n<type>2</type>\n<location>${lib}</location>\n</link>\n</linkedResources>\n</projectDescription>`
  );
  fs.writeFileSync(
    path.join(proj, '.cproject'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>`
  );
  const cp = Cproject.load(proj);
  const all = [...scanSources(cp).values()].flat().map((f) => f.logicName);
  check('deep link: L1/L2/L3 all scanned (full recursion, MRS2 parity)', all.includes('LIB/top.c') && all.includes('LIB/Deep/mid.c') && all.includes('LIB/Deep/USB/usb.c'));
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURES` : '\nall enhancement tests passed');
process.exit(failures ? 1 : 0);
