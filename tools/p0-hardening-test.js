/*
 * P0 hardening tests (0.3.7 code_review_report.md round): the five fixes the
 * full-project review's P0 subset broke down into —
 *   H5  JSONC trailing commas: objectProps must terminate the last
 *       property's value span at the blanked comma, not at the container
 *       close (a splice over the un-terminated span corrupted
 *       settings.json: erased the comma/comment, and a same-pass insert
 *       then produced a file that no longer parses)
 *   H2  OpenOCD Jim Tcl: firmware paths get [ ] $ " \ escaped inside the
 *       double-quoted script argument and line breaks refused outright
 *   H1  PowerShell bridge: numeric arguments must be real integers, paths
 *       must not carry the curly-quote characters PS 5.1 treats as string
 *       delimiters (''-doubling does not cover them)
 *   H3① output.ts: containment folds case on win32, junction/symlink output
 *       directories are refused (clearing entries would follow the link and
 *       wipe the target outside the project)
 *   H3② cmake export: PROJECT_NAME / TARGET_ARTIFACT / user libs go through
 *       the same esc() as the flag blocks (a quote in a .project display
 *       name used to close the string and inject CMake commands)
 *
 * Run: node tools/p0-hardening-test.js
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail === undefined ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const ROOT = path.join(__dirname, '..', '.scratch', 'p0');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

/** containment guard: every fixture write goes through here */
function inside(root, rel) {
  const target = path.resolve(root, rel);
  const r = path.resolve(root);
  if (target !== r && !target.startsWith(r + path.sep)) {
    throw new Error('fixture path escapes the scratch root: ' + target);
  }
  return target;
}

// ---- H5: JSONC trailing commas ---------------------------------------------

const jsonc = require('../out/core/jsonc.js');
{
  // the map records the blanked comma with its OWN container closer
  const map = new Map();
  const stripped = jsonc.stripJsonc('{\n  "a": 1,\n  "b": 2, // trailing note\n}', map);
  check('jsonc: trailing comma recorded with its container closer', map.size === 1 && [...map.values()][0] === stripped.indexOf('}'), JSON.stringify([...map]));

  // BUG REPRODUCTION: without the map the last property's span runs to the
  // root close — a splice over it would erase the comma and the comment
  const without = jsonc.objectProps(stripped);
  const lastWithout = without[without.length - 1].value;
  check('jsonc: objectProps WITHOUT the map swallows up to the close (the old bug)', lastWithout.end === jsonc.matchBracket(stripped, 0), String(lastWithout.end));

  // FIX: with the map the span stops at the value
  const props = jsonc.objectProps(stripped, map);
  const v = props.find((p) => p.key === 'b').value;
  check('jsonc: objectProps WITH the map terminates the span at the value', stripped.slice(v.start, v.end) === '2', JSON.stringify(stripped.slice(v.start, v.end)));

  // the full H5 corruption scenario: MODIFY the last value AND insert a new
  // key in one pass — the result must re-parse cleanly
  const raw = '{\n  "a": 1, // trailing note\n}';
  const m2 = new Map();
  const s2 = jsonc.stripJsonc(raw, m2);
  const props2 = jsonc.objectProps(s2, m2);
  const rootClose = jsonc.matchBracket(s2, jsonc.skipWs(s2, 0));
  const a = props2.find((p) => p.key === 'a').value;
  const edits = [{ start: a.start, end: a.end, text: '"22"' }];
  const sep = props2.length === 0 || jsonc.hadTrailingCommaFn(m2, rootClose) ? '' : ',';
  const indent = jsonc.indentOf(s2, rootClose) + '  ';
  edits.push({ start: rootClose, end: rootClose, text: `${sep}\n${indent}"b": 3` });
  let out = raw;
  edits.sort((x, y) => y.start - x.start || y.end - x.end);
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  let reparsed = null;
  try {
    reparsed = JSON.parse(jsonc.stripJsonc(out));
  } catch {
    reparsed = null;
  }
  check(
    'jsonc: modify + insert over a trailing-comma file re-parses (the settings.json corruption)',
    !!reparsed && reparsed.a === '22' && reparsed.b === 3,
    out
  );
  check('jsonc: the user comment behind the comma survives the splice', out.includes('// trailing note'), out);

  // arrays keep their own fix
  const m3 = new Map();
  const s3 = jsonc.stripJsonc('{"x": [1, 2,]}', m3);
  const root = jsonc.objectProps(s3, m3)[0].value;
  const spans = jsonc.arrayElements(s3, root.start, m3);
  check(
    'jsonc: arrayElements terminates the last span at the blanked comma',
    !!spans && spans.length === 2 && s3.slice(spans[1].start, spans[1].end) === '2',
    JSON.stringify(spans)
  );

  // a NESTED trailing comma must not suppress the ROOT separator
  const m4 = new Map();
  const s4 = jsonc.stripJsonc('{"x": [1,], "a": 1}', m4);
  const close4 = jsonc.matchBracket(s4, 0);
  check(
    'jsonc: a nested trailing comma does not suppress the root separator',
    !jsonc.hadTrailingCommaFn(m4, close4),
    JSON.stringify([...m4])
  );
}

// ---- H2: OpenOCD Jim Tcl escaping ------------------------------------------

const { prepareFlash } = require('../out/core/flash.js');
{
  const dir = inside(ROOT, 'tcl');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = inside(dir, 'board.cfg');
  fs.writeFileSync(cfg, '# cfg\n');

  // bracketed path: the metacharacters must land escaped
  const plan = prepareFlash({
    buildDir: dir,
    address: '0x00000000',
    verify: true,
    reset: true,
    boardCfg: cfg,
    firmware: path.join(dir, 'CH32[v2]$x', 'app.hex'),
    eraseAll: false,
    banks: 1,
  });
  const script = fs.readFileSync(plan.scriptPath, 'utf8');
  const fwFragment = script.split('\n').find((l) => l.includes('app.hex'));
  // every [ and $ in the path must carry its own backslash PREFIX (the
  // escape) — a raw bracket/dollar inside the quoted argument would be
  // evaluated by Jim Tcl
  const pathPart = fwFragment.split('"')[1] || '';
  check(
    'tcl: bracketed/dollar firmware path lands escaped (no raw [ or $)',
    /(?<!\\)\[/.test(pathPart) === false && /(?<!\\)\$/.test(pathPart) === false && pathPart.includes('\\[v2\\]') && pathPart.includes('\\$x'),
    fwFragment
  );

  // normal path: byte-stable (plain quoted, forward slashes)
  const plan2 = prepareFlash({
    buildDir: dir,
    address: '0x00000000',
    verify: true,
    reset: true,
    boardCfg: cfg,
    firmware: 'C:/Work/app.hex',
    eraseAll: false,
    banks: 1,
  });
  const script2 = fs.readFileSync(plan2.scriptPath, 'utf8');
  check('tcl: a normal path stays byte-stable (plain quoted)', script2.includes('"C:/Work/app.hex"'), script2.split('\n').find((l) => l.includes('app.hex')));

  // line breaks are refused outright
  let threw = false;
  try {
    prepareFlash({
      buildDir: dir,
      address: '0x00000000',
      verify: true,
      reset: true,
      boardCfg: cfg,
      firmware: 'C:/x\nos.cmd\ny.hex',
      eraseAll: false,
      banks: 1,
    });
  } catch (e) {
    threw = /line break/.test(e instanceof Error ? e.message : String(e));
  }
  check('tcl: a firmware path with a line break is refused', threw);
}

// ---- H1: PowerShell bridge argument validation ------------------------------

const { buildPsScript, buildPsFirmwareCheckScript } = require('../out/core/wlink.js');
{
  const commLib = { dir: 'C:/MRS/bin', mcuDll: 'McuCompilerDll.dll', usbDll: 'x.dll' };
  const base = { chipId: 6, clkSpeed: 24, dbgMode: 0 };

  const okScript = buildPsScript(commLib, 'queryMcuId', { ...base, wcfgPath: 'C:/x/y.wcfg' });
  check('ps: valid integers and plain paths build the script', typeof okScript === 'string' && okScript.includes("'C:/MRS/bin'"), '');

  const throwsWith = (name, fn, re) => {
    try {
      fn();
      check(name, false, 'did not throw');
    } catch (e) {
      check(name, re.test(e instanceof Error ? e.message : String(e)), e instanceof Error ? e.message : String(e));
    }
  };
  throwsWith('ps: a string chipId is refused', () => buildPsScript(commLib, 'queryRpt', { ...base, chipId: '6' }), /chipId must be an integer/);
  throwsWith('ps: a fractional clkSpeed is refused', () => buildPsScript(commLib, 'queryRpt', { ...base, clkSpeed: 1.5 }), /clkSpeed must be an integer/);
  throwsWith('ps: a non-integer memVal is refused', () => buildPsScript(commLib, 'setMemType', { ...base, memVal: { a: 1 } }), /memVal must be an integer/);
  throwsWith(
    'ps: a curly quote in the library dir is refused',
    () => buildPsScript({ dir: 'C:/\u2018x', mcuDll: 'd', usbDll: 'u' }, 'queryMcuId', { ...base }),
    /string delimiter/
  );
  throwsWith(
    'ps: a curly quote in the wcfg path is refused',
    () => buildPsScript(commLib, 'queryMcuId', { ...base, wcfgPath: 'C:/x\u2019y.wcfg' }),
    /string delimiter/
  );
  throwsWith('ps: an unknown op throws before anything runs', () => buildPsScript(commLib, 'notAnOp', { ...base }), /unknown wlink op/);

  // follow-up review: the FIRMWARE CHECK script must enforce the same hygiene
  throwsWith(
    'ps: firmwareCheck refuses a curly quote in the wcfg path',
    () => buildPsFirmwareCheckScript(commLib, 'C:/x\u2019y.wcfg'),
    /string delimiter/
  );
  throwsWith(
    'ps: firmwareCheck refuses a curly quote in the library dir',
    () => buildPsFirmwareCheckScript({ dir: 'C:/\u2018x', mcuDll: 'd', usbDll: 'u' }, 'C:/x.wcfg'),
    /string delimiter/
  );
  const fwScript = buildPsFirmwareCheckScript(commLib, "C:/x'y.wcfg");
  check('ps: firmwareCheck still escapes ASCII apostrophes', fwScript.includes("'C:/x''y.wcfg'"), fwScript.slice(0, 120));

  // the ASCII escape still works (an apostrophe in an install path doubles)
  const esc = buildPsScript({ dir: "C:/O'MRS/bin", mcuDll: 'd', usbDll: 'u' }, 'queryMcuId', { ...base });
  check("ps: an ASCII apostrophe in a path is doubled ('' escape)", esc.includes("'C:/O''MRS/bin'"), esc.slice(0, 200));
}

// ---- H3①: output directory containment --------------------------------------

const out = require('../out/core/output.js');
{
  const proj = inside(ROOT, 'ws/proj');
  fs.mkdirSync(inside(proj, 'obj'), { recursive: true });
  fs.writeFileSync(inside(proj, 'obj/keep.hex'), 'x');
  fs.writeFileSync(inside(proj, 'obj/gone.o'), 'x');

  const cleared = out.clearOutputDir(proj, path.join(proj, 'obj'), ['keep.hex']);
  check('output: a normal directory still clears (keep list honoured)', cleared === 1 && fs.existsSync(inside(proj, 'obj/keep.hex')), String(cleared));

  // case-mismatched spelling must not read as "outside the project" (win32)
  if (process.platform === 'win32') {
    const upper = path.join(path.dirname(proj), path.basename(proj).toUpperCase(), 'obj');
    let caseOk = false;
    try {
      out.clearOutputDir(proj, upper);
      caseOk = true;
    } catch (e) {
      caseOk = false;
    }
    check('output: a case-mismatched path stays inside the project (win32 fold)', caseOk);
  }

  // outside the project is still refused
  let refused = false;
  try {
    out.clearOutputDir(proj, path.join(ROOT, 'elsewhere'));
  } catch (e) {
    refused = /outside the project root/.test(e instanceof Error ? e.message : String(e));
  }
  check('output: a directory outside the project is still refused', refused);

  // junction/symlink output dir: refuse (clearing entries would follow the link)
  const realDir = inside(ROOT, 'real-target');
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(inside(ROOT, 'real-target/precious.txt'), 'do not delete');
  const linkDir = inside(proj, 'linked-obj');
  let made = false;
  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(realDir, linkDir, 'junction');
      made = true;
    } else {
      fs.symlinkSync(realDir, linkDir, 'dir');
      made = true;
    }
  } catch {
    made = false; // symlink privilege unavailable — skip the case
  }
  if (made) {
    let linkRefused = false;
    try {
      out.clearOutputDir(proj, linkDir);
    } catch (e) {
      // the leaf junction can be caught by either guard: the real-path
      // re-verification ("resolves outside ... through a link") fires first,
      // refuseLinkedDir's own message is the fallback
      linkRefused = /junction\/symlink|outside the project root/.test(e instanceof Error ? e.message : String(e));
    }
    check('output: a junction/symlink output directory is refused', linkRefused);
    check('output: the junction target survived untouched', fs.existsSync(inside(ROOT, 'real-target/precious.txt')));

    // follow-up review: an ANCESTOR link (proj/sub → outside, clear sub/obj)
    // must be caught by the real-path re-verification, not just the leaf check
    const subReal = inside(ROOT, 'real-target2');
    fs.mkdirSync(subReal, { recursive: true });
    fs.mkdirSync(inside(subReal, 'obj'), { recursive: true });
    fs.writeFileSync(inside(subReal, 'obj/inside.txt'), 'x');
    const subLink = inside(proj, 'sub');
    try {
      if (process.platform === 'win32') {
        fs.symlinkSync(subReal, subLink, 'junction');
        made = true;
      } else {
        fs.symlinkSync(subReal, subLink, 'dir');
        made = true;
      }
    } catch {
      made = false;
    }
    if (made) {
      let ancestorRefused = false;
      try {
        out.clearOutputDir(proj, path.join(subLink, 'obj'));
      } catch (e) {
        ancestorRefused = /outside the project root/.test(e instanceof Error ? e.message : String(e));
      }
      check('output: a junctioned ANCESTOR directory is refused (real-path re-check)', ancestorRefused);
      check('output: the ancestor-junction target survived untouched', fs.existsSync(inside(subReal, 'obj/inside.txt')));

      // review follow-up: a link that resolves back TO the project root
      // itself (sub → parent, dir = sub/proj) must be refused too — the
      // first cut of the real-path check had this condition inverted and
      // would have let clearOutputDir wipe the whole project
      const backLink = inside(proj, 'sub');
      try {
        if (process.platform === 'win32') {
          fs.rmSync(backLink, { force: true });
          fs.symlinkSync(path.dirname(proj), backLink, 'junction');
        } else {
          fs.rmSync(backLink, { force: true });
          fs.symlinkSync(path.dirname(proj), backLink, 'dir');
        }
        let selfRefused = false;
        // a sentinel inside the project root: the bug shape would clear the
        // whole root through the link, taking the sentinel with it
        const sentinel = inside(proj, 'self-survival.txt');
        fs.writeFileSync(sentinel, 'x');
        try {
          out.clearOutputDir(proj, path.join(backLink, path.basename(proj)));
        } catch (e) {
          selfRefused = /outside the project root/.test(e instanceof Error ? e.message : String(e));
        }
        check('output: a path resolving TO the project root itself is refused', selfRefused);
        check('output: the project root survived the self-resolving link', fs.existsSync(sentinel));
      } catch {
        console.log('SKIP  output: self-resolving link fixture unavailable');
      }
    }
  } else {
    console.log('SKIP  output: symlink fixture unavailable on this account (privilege)');
  }

  // follow-up review: a RELATIVE dir resolves against the PROJECT, not cwd
  fs.mkdirSync(inside(proj, 'rel/obj'), { recursive: true });
  fs.writeFileSync(inside(proj, 'rel/obj/a.o'), 'x');
  const relCleared = out.clearOutputDir(proj, path.join('rel', 'obj'));
  check('output: a relative dir resolves against the project root (not cwd)', relCleared === 1, String(relCleared));
}

// ---- H3②: cmake export escaping ---------------------------------------------

const { Cproject } = require('../out/core/cproject.js');
const { buildCMakeContent } = require('../out/core/cmake.js');
const { isSafeLinkName } = require('../out/core/projectFile.js');
{
  const proj = inside(ROOT, 'ws/cmproj');
  fs.mkdirSync(inside(proj, 'src'), { recursive: true });
  fs.writeFileSync(inside(proj, 'main.c'), 'int main(){return 0;}\n');
  // hostile DISPLAY name (.project names are free text — the config-name
  // traversal guard does not apply here)
  fs.writeFileSync(
    inside(proj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>proj");inject()</name></projectDescription>'
  );
  fs.writeFileSync(
    inside(proj, 'cmproj.wvproj'),
    '<?xml version="1.0" encoding="UTF-8"?><project/>'
  );
  fs.writeFileSync(
    inside(proj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  const cp = Cproject.load(proj);
  const tc = { name: 'GCC12', dir: 'C:/tc', prefix: 'riscv-wch-elf-', compilerC: 'gcc', compilerCpp: 'g++', compilerAsm: 'gcc' };
  const cmakeFile = path.join(proj, 'CMakeLists.txt');
  buildCMakeContent(cp, tc, cmakeFile);
  const content = fs.readFileSync(cmakeFile, 'utf8');
  check(
    'cmake: a quote in the project name cannot close the CMake string (injection)',
    content.includes('proj\\")\\;inject()'),
    content.split('\n').find((l) => l.includes('inject'))
  );
  // an UNESCAPED closing quote inside the value (i.e. the injection shape
  // `set(PROJECT_NAME "proj");inject()`) must not exist — every interior
  // quote has to carry its backslash escape
  check('cmake: no unescaped closing quote in the PROJECT_NAME value', !/set\(PROJECT_NAME "[^\\]*"\)/.test(content), content.split('\n').find((l) => l.includes('PROJECT_NAME')));

  // a normal name stays byte-identical to the plain form
  fs.writeFileSync(
    inside(proj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>cmproj</name></projectDescription>'
  );
  const cp2 = Cproject.load(proj);
  buildCMakeContent(cp2, tc, cmakeFile);
  const normalContent = fs.readFileSync(cmakeFile, 'utf8');
  check('cmake: a normal project name is exported unchanged', normalContent.includes('set(PROJECT_NAME "cmproj")'), normalContent.split('\n').find((l) => l.includes('PROJECT_NAME')));

  // follow-up review: objCopy option text with a line break or quote must
  // not break the generated add_custom_command (objCopyOptions reads
  // createflash.other verbatim)
  const cp3 = Cproject.load(proj);
  cp3.setOptionValue('createflash.other', 'a"b\nc"d');
  cp3.save();
  buildCMakeContent(Cproject.load(proj), tc, cmakeFile);
  const hostileContent = fs.readFileSync(cmakeFile, 'utf8');
  const objcopyLine = hostileContent.split('\n').find((l) => l.includes('CMAKE_OBJCOPY') && l.includes('a'));
  check(
    'cmake: objcopy options with quotes/line breaks are escaped and flattened',
    !!objcopyLine && objcopyLine.includes('a\\"b c\\"d'),
    objcopyLine
  );

  // round22: forced -include paths must be escaped ONCE — the inner esc at
  // harvest time + the outer flags-block esc double-escaped $/;/\ and broke
  // the header lookup
  const cp4 = Cproject.load(proj);
  cp4.setOptionValue('c.compiler.other', '-include"a$b.h"');
  cp4.save();
  buildCMakeContent(Cproject.load(proj), tc, cmakeFile);
  const forcedContent = fs.readFileSync(cmakeFile, 'utf8');
  const cFlagsLine = forcedContent.split('\n').find((l) => l.startsWith('set(CMAKE_C_FLAGS'));
  check(
    'cmake: forced include path is escaped exactly once (no double backslash before $)',
    !!cFlagsLine && cFlagsLine.includes('-include\\"a\\$b.h\\"') && !cFlagsLine.includes('a\\\\$b.h'),
    cFlagsLine
  );

  // round18 P2-4: forExport refuses a hostile LINK NAME (the export tree
  // names directories after links; copyLinkedFolders skips the unsafe one,
  // so generating anyway would point outside the export). In-place
  // generation does NOT throw — existing EVT trees keep building.
  const hostileProj = inside(ROOT, 'ws/hostilelink');
  fs.mkdirSync(inside(hostileProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(hostileProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(hostileProj, 'hostilelink.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(hostileProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>hostilelink</name>' +
      '<linkedResources><link><name>..\\evil</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/shared/lib</locationURI></link></linkedResources></projectDescription>'
  );
  fs.writeFileSync(
    inside(hostileProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  fs.mkdirSync(inside(ROOT, 'ws/shared/lib'), { recursive: true });
  const cpHostile = Cproject.load(hostileProj);
  let hostileThrew = false;
  try {
    buildCMakeContent(cpHostile, tc, inside(hostileProj, 'CMakeLists.txt'), { forExport: true });
  } catch (e) {
    hostileThrew = /not safe as an export directory name/.test(e instanceof Error ? e.message : String(e));
  }
  check('cmake: forExport refuses a hostile link name (no escaping export)', hostileThrew);
  let inPlaceOk = false;
  try {
    buildCMakeContent(cpHostile, tc, inside(hostileProj, 'CMakeLists.txt'));
    inPlaceOk = true;
  } catch {
    inPlaceOk = false;
  }
  check('cmake: in-place generation tolerates the legacy link name', inPlaceOk);

  // round18 P2-1 (extension side): generateMakefiles refuses stale linked
  // folders up-front — the gate is the FIRST statement, so the throw happens
  // before any toolchain data is touched
  const staleProj = inside(ROOT, 'ws/stalemake');
  fs.mkdirSync(inside(staleProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(staleProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(staleProj, 'stalemake.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(staleProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>stalemake</name>' +
      '<linkedResources><link><name>Gone</name><type>2</type><locationURI>C:/build-machine/gone</locationURI></link></linkedResources></projectDescription>'
  );
  fs.writeFileSync(
    inside(staleProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  const cpStale = Cproject.load(staleProj);
  let genThrew = false;
  try {
    const { generateMakefiles } = require('../out/core/makefile.js');
    generateMakefiles(cpStale, tc);
  } catch (e) {
    genThrew = /stale source trees/.test(e instanceof Error ? e.message : String(e));
  }
  check('makefile: generateMakefiles refuses stale linked folders (extension F7 parity)', genThrew);

  // round19 P2-2, RELAXED by user ruling 2026-11-25: a NAMED source entry
  // resolving to nothing (no dir, no link, not implicitly resolvable) no
  // longer refuses the build — MRS compiles the EVT V1_2 BLE projects whose
  // shipped .cproject carries a leftover dangling `Profile` entry from an
  // older layout, so MRVC proceeds at MRS parity and surfaces the dangling
  // entries as HINTS (danglingSourceEntries / audit finding) instead
  const implicitProj = inside(ROOT, 'ws/implicit');
  fs.mkdirSync(inside(implicitProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(implicitProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(implicitProj, 'implicit.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(implicitProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>implicit</name></projectDescription>'
  );
  fs.writeFileSync(
    inside(implicitProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="GhostTree"/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  const cpImplicit = Cproject.load(implicitProj);
  let implicitMsg = '(no throw)';
  try {
    const { generateMakefiles: gen2 } = require('../out/core/makefile.js');
    // FULL toolchain: the build now reaches the makefile writer (the old
    // refusal fired before it), so the cmake-oriented partial `tc` above is
    // not enough — linker/objcopy/objdump/size are required fields
    gen2(cpImplicit, {
      name: 'GCC12',
      dir: 'C:/tc',
      prefix: 'riscv-wch-elf-',
      compilerC: 'riscv-wch-elf-gcc',
      compilerCpp: 'riscv-wch-elf-g++',
      linkerC: 'riscv-wch-elf-gcc',
      linkerCpp: 'riscv-wch-elf-g++',
      debugger: 'riscv-wch-elf-gdb',
      objcopy: 'riscv-wch-elf-objcopy',
      objdump: 'riscv-wch-elf-objdump',
      size: 'riscv-wch-elf-size',
    });
  } catch (e) {
    implicitMsg = e instanceof Error ? e.message : String(e);
  }
  check(
    'makefile: a dangling named source entry no longer blocks the build (MRS parity)',
    implicitMsg === '(no throw)',
    implicitMsg.slice(0, 200)
  );
  const { danglingSourceEntries } = require('../out/core/scan.js');
  const dangling = danglingSourceEntries(cpImplicit);
  check(
    'scan: the same dangling entry is reported as a hint (danglingSourceEntries)',
    dangling.length === 1 && dangling[0].name === 'GhostTree',
    JSON.stringify(dangling)
  );
  const auditRes = require('../out/core/audit.js').auditProjectConfig(implicitProj);
  check(
    'audit: the dangling entry surfaces as a report-only finding',
    auditRes.findings.some((f) => f.code === 'dangling-entry' && f.detail.includes('GhostTree') && !f.fixable),
    JSON.stringify(auditRes.findings.filter((f) => f.code === 'dangling-entry'))
  );

  // round19 P3-1: an intentionally EXCLUDED stale link / named entry must
  // NOT block the build (root entry names it, no paired named entry)
  const excludedProj = inside(ROOT, 'ws/excluded-stale');
  fs.mkdirSync(inside(excludedProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(excludedProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(excludedProj, 'excludedstale.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(excludedProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>excludedstale</name>' +
      '<linkedResources><link><name>Gone</name><type>2</type><locationURI>C:/build-machine/gone</locationURI></link></linkedResources></projectDescription>'
  );
  fs.writeFileSync(
    inside(excludedProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry excluding="Gone" flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  const cpExcluded = Cproject.load(excludedProj);
  // fixture isolation (round20 P3-1): the excluded-stale coverage needs a
  // link target that is genuinely missing — assert NO implicit resolution
  // pulled a sibling dir in behind our back (only the declared Gone link)
  check(
    'fixture: the excluded-stale fixture carries no implicit link resolution',
    JSON.stringify([...cpExcluded.linkedFolders.keys()]) === '["Gone"]',
    JSON.stringify([...cpExcluded.linkedFolders])
  );
  const { assertScannableLinkedFolders } = require('../out/core/scan.js');
  // Gone is root-token-excluded with NO paired named entry = a real
  // exclusion (round19 P3-1) — the gate must not block on it
  let excludedOk = false;
  try {
    assertScannableLinkedFolders(cpExcluded);
    excludedOk = true;
  } catch {
    excludedOk = false;
  }
  check('scan: intentionally excluded stale links do not block the build', excludedOk);
  // the CONTRAST proves the exclusion is what let it pass: with the token
  // removed the same stale link must be refused
  fs.writeFileSync(
    inside(excludedProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  let unexcludedThrew = false;
  try {
    assertScannableLinkedFolders(Cproject.load(excludedProj));
  } catch (e) {
    unexcludedThrew = /stale source trees/.test(e instanceof Error ? e.message : String(e));
  }
  check('scan: the same stale link WITHOUT the exclude token is refused', unexcludedThrew);

  // round20 P2-2: root exclude token + named entry = CDT re-include MARKER,
  // not an exclusion — a missing directory must still be refused. The name
  // is deliberately unique: a common name (e.g. "Core") can be implicitly
  // resolved by the SRC-sibling climb (case-insensitively onto the plugin's
  // own source tree when the fixture lives under it), which would mask the
  // missing-directory case this test exists to pin.
  const reincName = 'R20CoreMissing';
  const reincProj = inside(ROOT, 'ws/reinclude');
  fs.mkdirSync(inside(reincProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(reincProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(reincProj, 'reinclude.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(reincProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>reinclude</name></projectDescription>'
  );
  fs.writeFileSync(
    inside(reincProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry excluding="' + reincName + '" flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="' + reincName + '"/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  const cpReinc = Cproject.load(reincProj);
  // same isolation guard: the marker entry must NOT have been implicitly resolved
  check(
    'fixture: the re-include entry stays unresolved (no implicit link resolution)',
    !cpReinc.linkedFolders.has(reincName) && ![...cpReinc.linkedFolders.keys()].some((k) => k.toLowerCase() === reincName.toLowerCase()),
    JSON.stringify([...cpReinc.linkedFolders])
  );
  // user ruling 2026-11-25: a re-include marker over a MISSING directory is
  // skipped by MRS too — the gate no longer refuses it; the hint channel
  // reports it instead
  let reincMsg = '(no throw)';
  try {
    assertScannableLinkedFolders(cpReinc);
  } catch (e) {
    reincMsg = e instanceof Error ? e.message : String(e);
  }
  check(
    'scan: root exclude + named entry over a missing dir passes the gate (hinted, not refused)',
    reincMsg === '(no throw)',
    reincMsg.slice(0, 160)
  );
  const reincDangling = danglingSourceEntries(cpReinc);
  check(
    'scan: the re-include marker over a missing dir is reported as a hint',
    reincDangling.length === 1 && reincDangling[0].name === reincName,
    JSON.stringify(reincDangling)
  );

  // round19 P3-3: the safe-name rule covers empty / control chars / device
  // names with extensions
  check(
    'linkname: empty, control chars and device names with extensions refused',
    !isSafeLinkName('') && !isSafeLinkName('bad\nname') && !isSafeLinkName('CON.txt') && !isSafeLinkName('NUL.foo') && !isSafeLinkName('LPT1.bar'),
    ''
  );
  check('linkname: extension names with a safe stem still fine', isSafeLinkName('Library.v2') && isSafeLinkName('my.lib'), '');

  // round19 P2-1 + P3-2: the outside-path predicate sees absolute rels and
  // keeps two-dot names inside
  const { isOutsideRelPath } = require('../out/core/macros.js');
  check(
    'path: isOutsideRelPath treats absolute rels as outside and ..names as inside',
    isOutsideRelPath('C:/x/y') === true && isOutsideRelPath('..dot.c') === false && isOutsideRelPath('../x') === true,
    JSON.stringify([isOutsideRelPath('C:/x/y'), isOutsideRelPath('..dot.c'), isOutsideRelPath('../x')])
  );

  // round19 P2-1: a CROSS-DRIVE linked folder must go through the link
  // mapping in forExport (Shared/...), never the original-machine absolute
  // path. Fixture: link points at the OS temp dir — only exercisable when
  // the temp drive differs from the scratch drive
  const tmp = require('os').tmpdir();
  const crossDrive = path.parse(tmp).root.toUpperCase() !== path.parse(ROOT).root.toUpperCase();
  if (crossDrive) {
    const tmpLinkDir = path.join(tmp, 'mrvc-r19', 'lib');
    fs.mkdirSync(tmpLinkDir, { recursive: true });
    fs.writeFileSync(path.join(tmpLinkDir, 'ext.c'), 'int ext(){return 6;}\n');
    const crossProj = inside(ROOT, 'ws/crossdrive');
    fs.mkdirSync(inside(crossProj, 'src'), { recursive: true });
    fs.writeFileSync(inside(crossProj, 'main.c'), 'int main(){return 0;}\n');
    fs.writeFileSync(inside(crossProj, 'crossdrive.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
    fs.writeFileSync(
      inside(crossProj, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>crossdrive</name>' +
        '<linkedResources><link><name>Shared</name><type>2</type><locationURI>' + tmpLinkDir.replace(/\\/g, '/') + '</locationURI></link></linkedResources></projectDescription>'
    );
    fs.writeFileSync(
      inside(crossProj, '.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
    );
    const cpCross = Cproject.load(crossProj);
    buildCMakeContent(cpCross, tc, inside(crossProj, 'CMakeLists.txt'), { forExport: true });
    const crossContent = fs.readFileSync(inside(crossProj, 'CMakeLists.txt'), 'utf8');
    const crossSrc = crossContent.split('\n').find((l) => l.includes('ext.c'));
    check(
      'cmake: a cross-drive linked source exports as Shared/... (no original-machine path)',
      !!crossSrc && crossSrc.includes('"Shared/ext.c"') && !crossSrc.toLowerCase().includes(tmp.slice(0, 3).toLowerCase()),
      crossSrc
    );
    fs.rmSync(path.join(tmp, 'mrvc-r19'), { recursive: true, force: true });
  } else {
    console.log('SKIP  cmake: cross-drive fixture unavailable (temp shares the scratch drive)');
  }

  // round18 P3-1: a link target that EXISTS but is a plain FILE counts as
  // unscannable (the old existsSync check let it through and the scan
  // silently skipped it)
  const fileTarget = inside(ROOT, 'plain-file-target.txt');
  fs.writeFileSync(fileTarget, 'x');
  const { staleLinkedFolders } = require('../out/core/projectFile.js');
  const fileLinkProj = inside(ROOT, 'ws/filelink');
  fs.mkdirSync(inside(fileLinkProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(fileLinkProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(fileLinkProj, 'filelink.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(fileLinkProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>filelink</name>' +
      '<linkedResources><link><name>NotADir</name><type>2</type><locationURI>PARENT-2-PROJECT_LOC/plain-file-target.txt</locationURI></link></linkedResources></projectDescription>'
  );
  fs.writeFileSync(
    inside(fileLinkProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  const fileStale = staleLinkedFolders(fileLinkProj);
  check(
    'projectFile: a link target that is a plain FILE counts as unscannable',
    fileStale.length === 1 && fileStale[0].name === 'NotADir',
    JSON.stringify(fileStale)
  );

  // round23 P3-2: a raw .project with EXACT duplicate link names over
  // different targets — the Map collapses one silently; the gate reports it
  const dupNameProj = inside(ROOT, 'ws/dupname');
  fs.mkdirSync(inside(dupNameProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(dupNameProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(dupNameProj, 'dupname.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.mkdirSync(inside(ROOT, 'ws/ta'), { recursive: true });
  fs.mkdirSync(inside(ROOT, 'ws/tb'), { recursive: true });
  fs.writeFileSync(path.join(inside(ROOT, 'ws/ta'), 'one.c'), 'int o(){return 9;}\n');
  fs.writeFileSync(path.join(inside(ROOT, 'ws/tb'), 'two.c'), 'int t(){return 10;}\n');
  fs.writeFileSync(
    inside(dupNameProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>dupname</name>' +
      '<linkedResources><link><name>Same</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/ta</locationURI></link>' +
      '<link><name>Same</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/tb</locationURI></link></linkedResources></projectDescription>'
  );
  fs.writeFileSync(
    inside(dupNameProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  // round23 P3-2 (kept, round24 refinement): exact duplicate link names over
  // DIFFERENT targets are still reported — neither link is excluded here
  let dupNameMsg = '(no throw)';
  try {
    assertScannableLinkedFolders(Cproject.load(dupNameProj));
  } catch (e) {
    dupNameMsg = e instanceof Error ? e.message : String(e);
  }
  check('scan: exact duplicate link names over different targets are reported', /duplicate link name/.test(dupNameMsg), dupNameMsg.slice(0, 220));

  // round24 P2-1: an in-project link with a DIFFERENT name than the physical
  // directory (Lib -> proj/src) must not double-compile — the linked walk
  // replaces the root-walk entry under the link logic name
  const addLinkedFolderEarly = require('../out/core/projectFile.js').addLinkedFolder;
  const inProj = inside(ROOT, 'ws/inprojlink');
  fs.mkdirSync(inside(inProj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(inside(inProj, 'src'), 'a.c'), 'int a(){return 1;}\n');
  fs.writeFileSync(inside(inProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(inProj, 'inprojlink.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(inProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>inprojlink</name></projectDescription>'
  );
  fs.writeFileSync(
    inside(inProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  addLinkedFolderEarly(inProj, 'Lib', inside(inProj, 'src'));
  const inProjFiles = [...require('../out/core/scan.js').scanSources(Cproject.load(inProj)).values()].flat().map((f) => f.logicName);
  check(
    'scan: an in-project link dedupes physically (one a.c, link logic name wins)',
    inProjFiles.filter((f) => f.endsWith('a.c')).length === 1 && inProjFiles.some((f) => f === 'Lib/a.c'),
    JSON.stringify(inProjFiles)
  );

  // round24 P3-1: two links over the SAME target — when the second link is
  // intentionally excluded (root token, no paired named entry) the
  // duplicate-target report must NOT fire
  const exclDupProj = inside(ROOT, 'ws/excldup');
  fs.mkdirSync(inside(exclDupProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(exclDupProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(exclDupProj, 'excldup.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  const dupTarget = inside(ROOT, 'dup-target');
  fs.mkdirSync(dupTarget, { recursive: true });
  fs.writeFileSync(
    inside(exclDupProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>excldup</name>' +
      '<linkedResources><link><name>A</name><type>2</type><locationURI>PARENT-2-PROJECT_LOC/dup-target</locationURI></link>' +
      '<link><name>B</name><type>2</type><locationURI>PARENT-2-PROJECT_LOC/dup-target</locationURI></link></linkedResources></projectDescription>'
  );
  fs.writeFileSync(
    inside(exclDupProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry excluding="B" flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  const { assertScannableLinkedFolders: assertGate2 } = require('../out/core/scan.js');
  // message-recording form: a throw must FAIL this check — the old
  // `exclDupOk = /…/.test(msg)` inside the catch set true exactly when the
  // gate regressed into re-raising the duplicate report (round26 Low)
  let exclDupMsg = '(no throw)';
  try {
    assertGate2(Cproject.load(exclDupProj));
  } catch (e) {
    exclDupMsg = e instanceof Error ? e.message : String(e);
  }
  check(
    'scan: a root-excluded alias over the same target does not trip the duplicate report',
    exclDupMsg === '(no throw)',
    exclDupMsg.slice(0, 160)
  );
  // contrast: WITHOUT the exclusion token the same-target aliases are refused
  fs.writeFileSync(
    inside(exclDupProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  let unexclDupThrew = false;
  try {
    assertGate2(Cproject.load(exclDupProj));
  } catch (e) {
    unexclDupThrew = /point at the same directory/.test(e instanceof Error ? e.message : String(e));
  }
  check('scan: same-target aliases WITHOUT exclusion are refused', unexclDupThrew);

  // round26 Medium: a project WITHOUT .project (only .cproject/.wvproj) must
  // pass the gate AND the scan — the head-of-function listRemovedResources
  // used to throw ENOENT from both entry points before the round25 High
  // try/catch (which only shielded the gate's own raw-link read) could run
  const noProjProj = inside(ROOT, 'ws/noproject');
  fs.mkdirSync(inside(noProjProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(noProjProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(path.join(noProjProj, 'src', 'lib.c'), 'int l(){return 1;}\n');
  fs.writeFileSync(inside(noProjProj, 'noproject.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(noProjProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  let noProjMsg = '(no throw)';
  try {
    require('../out/core/projectFile.js').listRemovedResources(noProjProj);
    assertGate2(Cproject.load(noProjProj));
    const noProjFiles = [
      ...require('../out/core/scan.js')
        .scanSources(Cproject.load(noProjProj))
        .values(),
    ]
      .flat()
      .map((f) => f.logicName);
    if (!noProjFiles.includes('main.c') || !noProjFiles.includes('src/lib.c')) {
      noProjMsg = 'sources lost: ' + noProjFiles.join(',');
    }
  } catch (e) {
    noProjMsg = e instanceof Error ? e.message : String(e);
  }
  check(
    'scan: a project without .project passes listRemovedResources, the gate and the scan',
    noProjMsg === '(no throw)',
    noProjMsg.slice(0, 160)
  );

  // round26 Low: a link logically REMOVED from the tree (filteredResources)
  // whose target has since been deleted must not trip the stale gate — the
  // raw-links loop already skipped removals, the stale/named-entry loops
  // above it did not
  const remDelProj = inside(ROOT, 'ws/remdel');
  fs.mkdirSync(inside(remDelProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(remDelProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(remDelProj, 'remdel.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  const remDelProject = (withFilter) =>
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>remdel</name>' +
    '<linkedResources><link><name>Gone</name><type>2</type><locationURI>PARENT-2-PROJECT_LOC/dead-target</locationURI></link></linkedResources>' +
    (withFilter
      ? '<filteredResources><filter><name></name><type>10</type><matcher><id>org.eclipse.ui.ide.multiFilter</id><arguments>1.0-name-matches-false-false-Gone</arguments></matcher></filter></filteredResources>'
      : '') +
    '</projectDescription>';
  fs.writeFileSync(inside(remDelProj, '.project'), remDelProject(true));
  fs.writeFileSync(
    inside(remDelProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  let remDelMsg = '(no throw)';
  try {
    assertGate2(Cproject.load(remDelProj));
  } catch (e) {
    remDelMsg = e instanceof Error ? e.message : String(e);
  }
  check(
    'scan: a tree-Removed link whose target was deleted does not trip the stale gate',
    remDelMsg === '(no throw)',
    remDelMsg.slice(0, 160)
  );
  // contrast: the same dead target WITHOUT the removal record still blocks
  // (repair cannot help — no candidate directory ends with dead-target)
  fs.writeFileSync(inside(remDelProj, '.project'), remDelProject(false));
  let remDelContrast = false;
  try {
    assertGate2(Cproject.load(remDelProj));
  } catch (e) {
    remDelContrast = /stale source trees/.test(e instanceof Error ? e.message : String(e));
  }
  check('scan: the same dead target without the removal record still blocks the build', remDelContrast);

  // round26 Low: the walk must not descend into a logically REMOVED subtree —
  // an unreadable directory under it used to surface as a ScanError even
  // though every file under the removed folder is dropped from the build
  const remUnreadProj = inside(ROOT, 'ws/remunread');
  fs.mkdirSync(inside(remUnreadProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(remUnreadProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(remUnreadProj, 'remunread.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  const remUnreadFilters =
    '<filteredResources>' +
    '<filter><name></name><type>10</type><matcher><id>org.eclipse.ui.ide.multiFilter</id><arguments>1.0-name-matches-false-false-GoneDir</arguments></matcher></filter>' +
    '<filter><name></name><type>10</type><matcher><id>org.eclipse.ui.ide.multiFilter</id><arguments>1.0-name-matches-false-false-GoneNamed</arguments></matcher></filter>' +
    '</filteredResources>';
  fs.writeFileSync(
    inside(remUnreadProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>remunread</name>' + remUnreadFilters + '</projectDescription>'
  );
  // root walk: token 'GoneNamed' keeps the root walk OUT so the contrast can
  // only reach the locked dir through the step-1.5 named-entry walk (token +
  // named entry = re-include marker)
  fs.writeFileSync(
    inside(remUnreadProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry excluding="GoneNamed" flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="GoneNamed"/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  // GoneDir exercises the ROOT walk's removal skip; GoneNamed (removed +
  // named entry) exercises the step-1.5 named-entry walk's removal skip
  fs.mkdirSync(path.join(remUnreadProj, 'GoneDir'), { recursive: true });
  fs.writeFileSync(path.join(remUnreadProj, 'GoneDir', 'hidden.c'), 'int h(){return 7;}\n');
  fs.mkdirSync(path.join(remUnreadProj, 'GoneNamed', 'locked'), { recursive: true });
  fs.writeFileSync(path.join(remUnreadProj, 'GoneNamed', 'locked', 'hidden.c'), 'int h(){return 7;}\n');
  const realReaddir2 = fs.readdirSync;
  fs.readdirSync = function (p, opts) {
    if (String(p).includes('locked')) {
      const err = new Error("EACCES: permission denied, scandir '" + p + "'");
      err.code = 'EACCES';
      throw err;
    }
    return realReaddir2.call(fs, p, opts);
  };
  const scanMod26 = require('../out/core/scan.js');
  try {
    let remUnreadMsg = '(no throw)';
    try {
      const ru = [...scanMod26.scanSources(Cproject.load(remUnreadProj)).values()].flat().map((f) => f.logicName);
      if (!ru.includes('main.c')) remUnreadMsg = 'root sources lost: ' + ru.join(',');
    } catch (e) {
      remUnreadMsg = e instanceof Error ? e.message : String(e);
    }
    check(
      'scan: unreadable dirs under REMOVED subtrees do not fail the scan (root + named-entry walks skip removed trees)',
      remUnreadMsg === '(no throw)',
      remUnreadMsg.slice(0, 160)
    );
    // contrast: without the removal record the same EACCES must fail the scan
    fs.writeFileSync(
      inside(remUnreadProj, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>remunread</name></projectDescription>'
    );
    let remUnreadContrast = false;
    try {
      scanMod26.scanSources(Cproject.load(remUnreadProj));
    } catch (e) {
      remUnreadContrast = e instanceof scanMod26.ScanError;
    }
    check('scan: the same unreadable dir WITHOUT the removal record still fails the scan (via the named-entry walk)', remUnreadContrast);
  } finally {
    fs.readdirSync = realReaddir2;
  }

  // round23 P3-2: a raw .project with an existing SELF-link (predating the
  // write guards) is refused by the gate
  const selfRawProj = inside(ROOT, 'ws/selfraw');
  fs.mkdirSync(inside(selfRawProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(selfRawProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(selfRawProj, 'selfraw.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(selfRawProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>selfraw</name>' +
      '<linkedResources><link><name>Old</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC</locationURI></link></linkedResources></projectDescription>'
  );
  fs.writeFileSync(
    inside(selfRawProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  let selfRawThrew = false;
  try {
    assertScannableLinkedFolders(Cproject.load(selfRawProj));
  } catch (e) {
    selfRawThrew = /project root/.test(e instanceof Error ? e.message : String(e));
  }
  check('scan: a raw .project SELF-link (target = project root) is refused by the gate', selfRawThrew);

  // round23 P3-1: a nested UNREADABLE directory inside a linked folder must
  // surface as a ScanError — walk() used to swallow nested readdir failures
  // and silently drop the whole subtree
  const scan = require('../out/core/scan.js');
  const CprojectScan = require('../out/core/cproject.js').Cproject;
  const realReaddir = fs.readdirSync;
  fs.readdirSync = function (p, opts) {
    if (String(p).includes('locked')) {
      const err = new Error("EACCES: permission denied, scandir '" + p + "'");
      err.code = 'EACCES';
      throw err;
    }
    return realReaddir.call(fs, p, opts);
  };
  try {
    const lockedProj = inside(ROOT, 'ws/lockedscan');
    fs.mkdirSync(inside(lockedProj, 'src'), { recursive: true });
    fs.writeFileSync(inside(lockedProj, 'main.c'), 'int main(){return 0;}\n');
    fs.writeFileSync(inside(lockedProj, 'lockedscan.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
    fs.writeFileSync(
      inside(lockedProj, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>lockedscan</name>' +
        '<linkedResources><link><name>Locked</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/locked-target</locationURI></link></linkedResources></projectDescription>'
    );
    fs.writeFileSync(
      inside(lockedProj, '.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
    );
    const lockedBase = inside(ROOT, 'locked-target');
    fs.mkdirSync(path.join(lockedBase, 'locked'), { recursive: true });
    fs.writeFileSync(path.join(lockedBase, 'hidden.c'), 'int h(){return 7;}\n');
    fs.writeFileSync(path.join(lockedBase, 'locked', 'hidden.c'), 'int h(){return 7;}\n');
    let scanThrew = false;
    try {
      scan.scanSources(CprojectScan.load(lockedProj));
    } catch (e) {
      scanThrew = e instanceof scan.ScanError && e.unreadable.some((u) => u.dir.includes('locked'));
    }
    check('scan: a nested unreadable directory surfaces as a ScanError (no silent loss)', scanThrew);
  } finally {
    fs.readdirSync = realReaddir;
  }

  // round21 P2-1: case-variant duplicate link names are one physical
  // directory on NTFS — the second add must be refused, and an EXISTING
  // .project carrying both variants must be refused by the gate
  const dupProj = inside(ROOT, 'ws/casedup');
  fs.mkdirSync(inside(dupProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(dupProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(dupProj, 'casedup.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(dupProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>casedup</name>' +
      '<linkedResources><link><name>Shared</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/case-real</locationURI></link>' +
      '<link><name>shared</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/case-real</locationURI></link></linkedResources></projectDescription>'
  );
  fs.writeFileSync(
    inside(dupProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  let dupAddMsg = '(no throw)';
  const { addLinkedFolder } = require('../out/core/projectFile.js');
  // unique name: a plausible name (case-real) would be latched onto by the
  // first-open auto-repair when the gate loads before this dir exists
  const caseReal = inside(ROOT, 'case-real-refusal');
  fs.mkdirSync(caseReal, { recursive: true });
  try {
    addLinkedFolder(dupProj, 'SHARED', caseReal);
  } catch (e) {
    dupAddMsg = e instanceof Error ? e.message : String(e);
  }
  check('projectFile: a case-variant duplicate link name is refused', /already exists/.test(dupAddMsg), dupAddMsg.slice(0, 160));
  // the alias target is materialized BEFORE the gate runs — the previous
  // order let the gate throw a stale error and the pass-assertion went
  // vacuously green (round25 Medium-3)
  const caseRealDir = inside(ROOT, 'ws/case-real');
  fs.mkdirSync(caseRealDir, { recursive: true });
  fs.writeFileSync(path.join(caseRealDir, 'same.c'), 'int s(){return 8;}\n');
  let dupGateMsg = '(no throw)';
  try {
    const { assertScannableLinkedFolders: assertGate } = require('../out/core/scan.js');
    assertGate(Cproject.load(dupProj));
  } catch (e) {
    dupGateMsg = e instanceof Error ? e.message : String(e);
  }
  check(
    'scan: case-variant duplicate link aliases pass the gate but the scan dedupes physically (round23 P2-1)',
    dupGateMsg === '(no throw)',
    dupGateMsg.slice(0, 160)
  );
  const { scanSources: scanDup } = require('../out/core/scan.js');
  const cpDupScan = Cproject.load(dupProj);
  const dupFiles = [...scanDup(cpDupScan).values()].flat().map((f) => f.logicName);
  check(
    'scan: a file reachable via case-variant aliases appears exactly once',
    dupFiles.filter((f) => f.endsWith('same.c')).length === 1,
    JSON.stringify(dupFiles) + ' | linked=' + JSON.stringify([...cpDupScan.linkedFolders])
  );

  // round21 P2-2: a link pointing at (or above) the project root itself
  // re-scans the whole tree under the link name — refused on add, on
  // change-target and physically (through a junction)
  const selfProj = inside(ROOT, 'ws/selflink');
  fs.mkdirSync(inside(selfProj, 'src'), { recursive: true });
  fs.writeFileSync(inside(selfProj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(selfProj, 'selflink.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(selfProj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>selflink</name></projectDescription>'
  );
  fs.writeFileSync(
    inside(selfProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  let selfAddMsg = '(no throw)';
  try {
    addLinkedFolder(selfProj, 'Self', selfProj);
  } catch (e) {
    selfAddMsg = e instanceof Error ? e.message : String(e);
  }
  check('projectFile: linking the project root itself is refused', /must not be or contain the project root/.test(selfAddMsg), selfAddMsg.slice(0, 160));
  let ancestorMsg = '(no throw)';
  try {
    addLinkedFolder(selfProj, 'Up', path.dirname(selfProj));
  } catch (e) {
    ancestorMsg = e instanceof Error ? e.message : String(e);
  }
  check('projectFile: linking a directory CONTAINING the project root is refused', /must not be or contain the project root/.test(ancestorMsg), ancestorMsg.slice(0, 160));
  // round22: a DRIVE ROOT target ends with its separator — the prefix
  // compare must not double it (D:\ + \ = D:\\) and let the whole drive through
  const driveRoot = path.parse(ROOT).root;
  let driveRootMsg = '(no throw)';
  try {
    addLinkedFolder(selfProj, 'WholeDrive', driveRoot);
  } catch (e) {
    driveRootMsg = e instanceof Error ? e.message : String(e);
  }
  check('projectFile: a drive-root link target is refused (prefix not double-separated)', /must not be or contain the project root/.test(driveRootMsg), driveRootMsg.slice(0, 160));
  // change-target path refuses too (MRS2 changelinkedFolderPath parity)
  const { changeLinkedFolderTarget } = require('../out/core/projectFile.js');
  fs.mkdirSync(inside(ROOT, 'linked-target2'), { recursive: true });
  addLinkedFolder(selfProj, 'Real', inside(ROOT, 'linked-target2'));
  let changeThrew = false;
  try {
    changeLinkedFolderTarget(selfProj, 'Real', selfProj);
  } catch (e) {
    changeThrew = /must not be or contain the project root/.test(e instanceof Error ? e.message : String(e));
  }
  check('projectFile: changeLinkedFolderTarget refuses the project root', changeThrew);

  // round16 P3: a hostile SOURCE filename (POSIX-legal quotes) must not close
  // the quoted SRC_FILES argument. A file named we"ird.c cannot EXIST on
  // Windows (illegal character) — this case is exercisable on POSIX only;
  // on win32 the esc() contract itself is covered by the objcopy case above.
  if (process.platform !== 'win32') {
    fs.writeFileSync(inside(proj, 'we"ird.c'), 'int w(){return 2;}\n');
    buildCMakeContent(Cproject.load(proj), tc, cmakeFile);
    const sourcesContent = fs.readFileSync(cmakeFile, 'utf8');
    const srcLine = sourcesContent.split('\n').find((l) => l.includes('we'));
    check(
      'cmake: a quote in a source filename is escaped inside SRC_FILES',
      !!srcLine && srcLine.includes('we\\"ird.c') && !/[^\\]"ird\.c/.test(srcLine),
      srcLine
    );
  } else {
    console.log('SKIP  cmake: hostile source filename is a POSIX-only fixture (win32 forbids quotes in names)');
  }

  // round17 P3: `$` in a filename is legal on Windows — CMake would expand
  // ${X} inside the quoted argument and collapse a${X}.c to a.c
  fs.writeFileSync(inside(proj, 'a${X}.c'), 'int d(){return 3;}\n');
  buildCMakeContent(Cproject.load(proj), tc, cmakeFile);
  const dollarContent = fs.readFileSync(cmakeFile, 'utf8');
  const dollarLine = dollarContent.split('\n').find((l) => l.includes('a${X}.c') || l.includes('a\\${X}.c'));
  check(
    'cmake: ${X} in a source filename is escaped (no CMake variable expansion)',
    !!dollarLine && dollarLine.includes('a\\${X}.c') && !/[^\\]\$\{X\}/.test(dollarLine),
    dollarLine
  );

  // round18 P2-2: a project-internal name starting with two dots is a REAL
  // file — the old startsWith('..') dropped it from SRC_FILES
  fs.writeFileSync(inside(proj, '..dotdot.c'), 'int dd(){return 4;}\n');
  buildCMakeContent(Cproject.load(proj), tc, cmakeFile);
  const dotdotContent = fs.readFileSync(cmakeFile, 'utf8');
  check(
    'cmake: a source named ..dotdot.c stays in SRC_FILES (path-segment outside check)',
    dotdotContent.includes('"..dotdot.c"'),
    dotdotContent.split('\n').find((l) => l.includes('dotdot'))
  );

  // round18 P2-3: ';' in a filename must not split the ${SRC_FILES} list
  fs.writeFileSync(inside(proj, 'semi;colon.c'), 'int s(){return 5;}\n');
  buildCMakeContent(Cproject.load(proj), tc, cmakeFile);
  const semiContent = fs.readFileSync(cmakeFile, 'utf8');
  const semiLine = semiContent.split('\n').find((l) => l.includes('colon.c'));
  check(
    'cmake: a semicolon in a source filename is escaped (list stays one item)',
    !!semiLine && semiLine.includes('semi\\;colon.c'),
    semiLine
  );
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failures ? '\n' + failures + ' FAILURES' : '\nall p0 hardening tests passed');
process.exit(failures ? 1 : 0);
