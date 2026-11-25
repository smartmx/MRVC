/*
 * Active build configuration switching.
 *
 * MRS2 has no "active" flag: the active configuration is the FIRST
 * <cconfiguration> in .cproject (its settings page reorders the array on
 * Apply, then regenerates the property files). MRVC's switch is therefore a
 * reorder of that file, plus the .template Target Path (MRS's own
 * chooseOutType rule: keep the file name, replace the directory) and a
 * best-effort sync of the generated .wvproj snapshot.
 *
 * These assertions pin: byte-exact minimal edit of .cproject (only the two
 * blocks swap places), round-trip when switching back, .template/.wvproj
 * follow, and the no-op/unknown/missing-file edges.
 */
const fs = require('fs');
const path = require('path');
const { Cproject } = require('../out/core/cproject.js');
const {
  listConfigurations,
  switchConfiguration,
  addConfiguration,
  renameConfiguration,
  deleteConfiguration,
} = require('../out/core/configSwitch.js');

const crypto = require('crypto');
/** MRS derives configuration ids as the first 8 sha1 hex digits as an int */
const idSuffixOf = (n) => String(parseInt(crypto.createHash('sha1').update(n).digest('hex').slice(0, 8), 16));

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const scratch = path.join(__dirname, '..', '.scratch', 'configswitch');
fs.rmSync(scratch, { recursive: true, force: true });

const PROJECT = 'Demo';
const cpXml = (names, entries) => {
  const blocks = names.map((n, i) => {
    const cfgId = `ilg.gnumcueclipse.managedbuild.cross.riscv.config.elf.release.${idSuffixOf(n)}`;
    const tcId = `ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release.${idSuffixOf(n)}`;
    // optional per-config sourceEntries: entries[i] = the ROOT entry's
    // excluding token ("" = no entry). Real dual configs differ only in
    // compile options, but the exclusion-table quirk needs distinguishable
    // per-config values to pin.
    const srcEntries = entries && entries[i]
      ? `\n\t\t\t\t\t<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="" excluding="${entries[i]}"/></sourceEntries>`
      : '';
    return `\t\t<cconfiguration id="${cfgId}">
\t\t\t<storageModule buildSystemId="org.eclipse.cdt.managedbuilder.core.configurationDataProvider" id="${cfgId}" moduleId="org.eclipse.cdt.core.settings" name="${n}"/>
\t\t\t<storageModule moduleId="cdtBuildSystem" version="4.0.0">
\t\t\t\t<configuration id="${cfgId}" artifactName="\${ProjName}" artifactExtension="elf" buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" name="${n}">
\t\t\t\t\t<toolChain id="${tcId}" name="RISC-V Cross GCC" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">
\t\t\t\t\t\t<option id="o${i}" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.optimization.level" value="level.${i === 0 ? 'none' : 'size'}" valueType="enumerated"/>
\t\t\t\t\t</toolChain>${srcEntries}
\t\t\t\t</configuration>
\t\t\t</storageModule>
\t\t</cconfiguration>
`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?fileVersion 4.0.0?><cproject storage_type_id="org.eclipse.cdt.core.XmlProjectDescriptionStorage">
\t<storageModule moduleId="org.eclipse.cdt.core.settings">
${blocks.join('')}\t</storageModule>
</cproject>
`;
};

const template = (target) =>
  ['Vendor=WCH', 'MCU=CH585M', `Target Path=${target}`, 'Address=0x00000000', ''].join('\r\n');

const wvproj = (a, b, target) =>
  JSON.stringify(
    {
      version: '1.0',
      hasAllParsed: true,
      isNormalMRSProject: true,
      basic: { projectName: PROJECT },
      buildConfig: { configurations: [{ name: a, x: 1 }, { name: b, x: 2 }] },
      flashConfig: { target_path: target },
    },
    null,
    '\t'
  );

const makeProject = (dir, names, opts = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.cproject'), cpXml(names), 'utf-8');
  if (opts.template !== false) {
    fs.writeFileSync(path.join(dir, '.template'), template(opts.target ?? `${names[0]}/Foo.hex`), 'utf-8');
  }
  if (opts.wvproj !== false) {
    fs.writeFileSync(
      path.join(dir, `${PROJECT}.wvproj`),
      wvproj(names[0], names[1] ?? names[0], opts.target ?? `${names[0]}/Foo.hex`),
      'utf-8'
    );
  }
  return dir;
};

const blockRe = /<cconfiguration\b[\s\S]*?<\/cconfiguration>/g;
const blocksOf = (s) => [...s.matchAll(blockRe)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));

// --- 1. list + switch to the second configuration
const p1 = makeProject(path.join(scratch, 'p1'), ['obj1', 'obj']);
const base = fs.readFileSync(path.join(p1, '.cproject'), 'utf-8');
const tplBefore = fs.readFileSync(path.join(p1, '.template'), 'utf-8');
check('listConfigurations: file order', JSON.stringify(listConfigurations(p1)) === '["obj1","obj"]', listConfigurations(p1).join(','));

const r1 = switchConfiguration(p1, 'obj');
const after = fs.readFileSync(path.join(p1, '.cproject'), 'utf-8');
const b0 = blocksOf(base);
const b1 = blocksOf(after);
check('switch: changed/active', r1.changed === true && r1.active === 'obj', `${r1.changed}/${r1.active}`);
check('switch: names reordered', JSON.stringify(r1.names) === '["obj","obj1"]', r1.names.join(','));
check('switch: targetPath follows config', r1.targetPath === 'obj/Foo.hex', r1.targetPath);
check('switch: wvproj updated', r1.wvproj === 'updated', r1.wvproj);
check('switch: Cproject sees obj as active', Cproject.load(p1).configName === 'obj', Cproject.load(p1).configName);

const expected = base.slice(0, b0[0].start) + b0[1].text + base.slice(b0[0].end, b0[1].start) + b0[0].text + base.slice(b0[1].end);
check('switch: .cproject bytes = blocks swapped, nothing else', after === expected);
check('switch: block contents untouched', b1.length === 2 && b1[0].text === b0[1].text && b1[1].text === b0[0].text);

const tplAfter = fs.readFileSync(path.join(p1, '.template'), 'utf-8');
check('switch: .template Target Path', tplAfter.includes('Target Path=obj/Foo.hex'), tplAfter.replace(/\r?\n/g, '|'));
check(
  'switch: .template other lines untouched',
  tplAfter.split(/\r?\n/).filter((l) => !l.startsWith('Target Path=')).join('|') ===
    tplBefore.split(/\r?\n/).filter((l) => !l.startsWith('Target Path=')).join('|')
);

const wv1 = JSON.parse(fs.readFileSync(path.join(p1, `${PROJECT}.wvproj`), 'utf-8'));
check('switch: .wvproj order', JSON.stringify(wv1.buildConfig.configurations.map((c) => c.name)) === '["obj","obj1"]');
check('switch: .wvproj flashConfig.target_path', wv1.flashConfig.target_path === 'obj/Foo.hex');
check(
  'switch: .wvproj formatting matches MRS writer',
  fs.readFileSync(path.join(p1, `${PROJECT}.wvproj`), 'utf-8') === JSON.stringify(wv1, null, '\t')
);

// --- 2. switch back: exact original bytes
const r2 = switchConfiguration(p1, 'obj1');
check('switch back: changed', r2.changed === true, String(r2.changed));
check('switch back: .cproject is byte-identical to the original', fs.readFileSync(path.join(p1, '.cproject'), 'utf-8') === base);
check(
  'switch back: .template restored',
  fs.readFileSync(path.join(p1, '.template'), 'utf-8').includes('Target Path=obj1/Foo.hex')
);
check(
  'switch back: .wvproj order restored',
  JSON.stringify(JSON.parse(fs.readFileSync(path.join(p1, `${PROJECT}.wvproj`), 'utf-8')).buildConfig.configurations.map((c) => c.name)) ===
    '["obj1","obj"]'
);

// --- 2b. THREE configurations: target moves to the front, every other
// configuration keeps its relative order (MRS2 GetNewSettingData semantics).
// A,B,C -> B must be B,A,C — swapping with the old first block would give
// B,C,A and desynchronise .cproject from .wvproj / the returned list.
const threeProject = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const names = ['A', 'B', 'C'];
  fs.writeFileSync(path.join(dir, '.cproject'), cpXml(names), 'utf-8');
  fs.writeFileSync(path.join(dir, '.template'), template('A/Foo.hex'), 'utf-8');
  fs.writeFileSync(
    path.join(dir, `${PROJECT}.wvproj`),
    JSON.stringify(
      {
        version: '1.0',
        buildConfig: { configurations: names.map((n, i) => ({ name: n, x: i })) },
        flashConfig: { target_path: 'A/Foo.hex' },
      },
      null,
      '\t'
    ),
    'utf-8'
  );
  return dir;
};
const orderOf = (dir) => Cproject.load(dir).configurationNames;
const wvOrderOf = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, `${PROJECT}.wvproj`), 'utf-8')).buildConfig.configurations.map((c) => c.name);

const p3b = threeProject(path.join(scratch, 'p3b'));
const base3 = fs.readFileSync(path.join(p3b, '.cproject'), 'utf-8');
const rMid = switchConfiguration(p3b, 'B');
check('3cfg mid: returned names keep relative order', JSON.stringify(rMid.names) === '["B","A","C"]', rMid.names.join(','));
check('3cfg mid: .cproject order B,A,C', JSON.stringify(orderOf(p3b)) === '["B","A","C"]', orderOf(p3b).join(','));
check('3cfg mid: .wvproj order B,A,C', JSON.stringify(wvOrderOf(p3b)) === '["B","A","C"]', wvOrderOf(p3b).join(','));
const rBack = switchConfiguration(p3b, 'A');
check('3cfg back: order A,B,C', JSON.stringify(orderOf(p3b)) === '["A","B","C"]', orderOf(p3b).join(','));
check('3cfg back: .cproject is byte-identical to the original', fs.readFileSync(path.join(p3b, '.cproject'), 'utf-8') === base3);
check('3cfg back: .wvproj order A,B,C', JSON.stringify(wvOrderOf(p3b)) === '["A","B","C"]', wvOrderOf(p3b).join(','));

const p3c = threeProject(path.join(scratch, 'p3c'));
const rEnd = switchConfiguration(p3c, 'C');
check('3cfg end: returned names keep relative order', JSON.stringify(rEnd.names) === '["C","A","B"]', rEnd.names.join(','));
check('3cfg end: .cproject order C,A,B (not C,B,A)', JSON.stringify(orderOf(p3c)) === '["C","A","B"]', orderOf(p3c).join(','));
check('3cfg end: .wvproj order C,A,B', JSON.stringify(wvOrderOf(p3c)) === '["C","A","B"]', wvOrderOf(p3c).join(','));
check('3cfg end: targetPath follows config', rEnd.targetPath === 'C/Foo.hex', rEnd.targetPath);
const rNext = switchConfiguration(p3c, 'A');
check('3cfg next: A,C,B (only the target moves)', JSON.stringify(orderOf(p3c)) === '["A","C","B"]', orderOf(p3c).join(','));
check('3cfg next: .wvproj agrees with .cproject', JSON.stringify(wvOrderOf(p3c)) === '["A","C","B"]', wvOrderOf(p3c).join(','));
check('3cfg next: returned names agree with both', JSON.stringify(rNext.names) === '["A","C","B"]', rNext.names.join(','));

// --- 2c. configuration-scoped Cproject models (rebuild-all reads config[i]) ---
// Options/target name/build dir follow the CHOSEN configuration; the
// exclusion table always comes from index 0 (MRS parity — its isExluced()
// hardcodes configurations[0]).
{
  const pScope = path.join(scratch, 'pscope');
  fs.mkdirSync(pScope, { recursive: true });
  fs.writeFileSync(path.join(pScope, '.cproject'), cpXml(['obj', 'dbg'], ['a.c', 'b.c']), 'utf-8');
  const cp1 = Cproject.load(pScope);
  const cp2 = Cproject.loadConfigAt(pScope, 1);
  check('scope: config[0] unchanged', cp1.configName === 'obj' && cp1.optimizationLevel === 'none', `${cp1.configName}/${cp1.optimizationLevel}`);
  check('scope: config[1] name follows the chosen block', cp2.configName === 'dbg', cp2.configName);
  check('scope: config[1] options follow the chosen block', cp2.optimizationLevel === 'size', cp2.optimizationLevel);
  const plain = (cp) => cp.sourceEntries.map((e) => ({ name: e.name, excluding: e.excluding }));
  check(
    'scope: config[1] exclusion table comes from config[0] (MRS quirk)',
    JSON.stringify(plain(cp2)) === '[{"name":"","excluding":["a.c"]}]',
    JSON.stringify(plain(cp2))
  );
  check('scope: names list identical on both models', JSON.stringify(cp1.configurationNames) === JSON.stringify(cp2.configurationNames));
  check('scope: out-of-range index falls back to the active config', Cproject.loadConfigAt(pScope, 9).configName === 'obj');
}

// --- 2d. configuration-name safety (round4 P1/P2-1) ---
// The name becomes a directory under the project root: `..` used to pass the
// old `[\w .-]` whitelist and path.join(projectRoot, '..') wrote makefiles
// into the project's PARENT. Now an unsafe name is a parse error — the
// project refuses to load instead of building outside its root.
{
  const hostiles = ['..', '.', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a|b', 'a[b', 'a]b', 'a{b', 'a}b', 'a,b', 'a!b', 'x.', 'x '];
  const unsafeDir = path.join(scratch, 'unsafe');
  const sentinel = path.join(scratch, 'sentinel-makefile');
  fs.writeFileSync(sentinel, 'SENTINEL\n', 'utf-8');
  for (const raw of hostiles) {
    fs.rmSync(unsafeDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(unsafeDir, 'proj'), { recursive: true });
    const proj = path.join(unsafeDir, 'proj');
    fs.writeFileSync(path.join(proj, '.cproject'), cpXml(['obj']).split('name="obj"').join(`name="${raw}"`), 'utf-8');
    let err = '';
    try {
      Cproject.load(proj);
    } catch (e) {
      err = String(e && e.message);
    }
    check(`unsafe name ${JSON.stringify(raw)}: load refuses`, err.includes('unsafe configuration name'), err);
    check(`unsafe name ${JSON.stringify(raw)}: parent sentinel untouched`, fs.readFileSync(sentinel, 'utf-8') === 'SENTINEL\n');
  }
  fs.rmSync(unsafeDir, { recursive: true, force: true });
  fs.rmSync(sentinel, { force: true });
}

// --- 2e. Chinese configuration names round-trip through the REAL parser
// (round4 P2-1: the read side used ASCII \w and folded 中文配置 back to obj,
// desynchronising the switch/manage UI from the file) ---
{
  const pCjk = makeProject(path.join(scratch, 'cjk'), ['obj', '中文配置']);
  check('cjk: list reads the Chinese name back', JSON.stringify(listConfigurations(pCjk)) === '["obj","中文配置"]', listConfigurations(pCjk).join(','));
  const rCjk = switchConfiguration(pCjk, '中文配置');
  check('cjk: switch to the Chinese name works', rCjk.active === '中文配置' && JSON.stringify(rCjk.names) === '["中文配置","obj"]', JSON.stringify(rCjk.names));
  check('cjk: targetPath follows the Chinese directory', rCjk.targetPath === '中文配置/Foo.hex', rCjk.targetPath);
  check('cjk: .wvproj order follows', JSON.stringify(wvOrderOf(pCjk)) === '["中文配置","obj"]', wvOrderOf(pCjk).join(','));
  check('cjk: switching back restores byte-identical order state', switchConfiguration(pCjk, 'obj').active === 'obj');
  const added = addConfiguration(pCjk, '配置二', '中文配置');
  check('cjk: add with a Chinese name is distinct', JSON.stringify(added.names) === '["obj","中文配置","配置二"]', added.names.join(','));
  const deleted = deleteConfiguration(pCjk, '配置二');
  check('cjk: delete of the Chinese-named config works', JSON.stringify(deleted.names) === '["obj","中文配置"]', deleted.names.join(','));
}

// --- 2f. cross-configuration source scan (round4 P2-2, real scanSources) ---
// Each configuration's output dir must be skipped when scanning: another
// config's generated .c must never enter this config's build.
{
  const { scanSources } = require('../out/core/scan.js');
  const { generateMakefiles } = require('../out/core/makefile.js');
  const rootAbs = path.resolve(path.join(scratch, 'scanmulti'));
  const safe = (rel) => {
    const p = path.resolve(rootAbs, rel);
    if (p !== rootAbs && !p.startsWith(rootAbs + path.sep)) throw new Error('fixture path escapes root');
    return p;
  };
  fs.rmSync(rootAbs, { recursive: true, force: true });
  for (const d of ['obj1', 'obj2', 'src']) fs.mkdirSync(safe(d), { recursive: true });
  fs.writeFileSync(safe('obj1/generated.c'), 'int g1(void){return 1;}\n');
  fs.writeFileSync(safe('obj2/generated.c'), 'int g2(void){return 2;}\n');
  fs.writeFileSync(safe('src/main.c'), 'int main(void){return 0;}\n');
  fs.writeFileSync(
    safe('.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>ScanMulti</name></projectDescription>',
    'utf-8'
  );
  fs.writeFileSync(path.join(rootAbs, '.cproject'), cpXml(['obj1', 'obj2']), 'utf-8');
  const dirsOf = (cp) => [...scanSources(cp).keys()];
  check('scan: config[0] scan skips the OTHER config dir', JSON.stringify(dirsOf(Cproject.load(rootAbs))) === '["src"]', JSON.stringify(dirsOf(Cproject.load(rootAbs))));
  check('scan: config[1] scan skips the OTHER config dir', JSON.stringify(dirsOf(Cproject.loadConfigAt(rootAbs, 1))) === '["src"]', JSON.stringify(dirsOf(Cproject.loadConfigAt(rootAbs, 1))));
  const tc = {
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
  generateMakefiles(Cproject.load(rootAbs), tc);
  generateMakefiles(Cproject.loadConfigAt(rootAbs, 1), tc);
  check('scan: no cross-config subdir.mk after generation', !fs.existsSync(safe('obj1/obj2/subdir.mk')) && !fs.existsSync(safe('obj2/obj1/subdir.mk')));
  // Windows folds directory-name case: a differently-cased dir must be
  // skipped too (config obj2 vs on-disk OBJ2)
  if (process.platform === 'win32') {
    const caseRoot = path.resolve(path.join(scratch, 'scanmulti-case'));
    // same containment rule as the main fixture: every write resolves under
    // the scratch case directory
    const safeCase = (rel) => {
      const p = path.resolve(caseRoot, rel);
      if (p !== caseRoot && !p.startsWith(caseRoot + path.sep)) throw new Error('fixture path escapes root');
      return p;
    };
    fs.rmSync(caseRoot, { recursive: true, force: true });
    fs.mkdirSync(safeCase('obj1'), { recursive: true });
    fs.mkdirSync(safeCase('OBJ2'), { recursive: true });
    fs.writeFileSync(safeCase('OBJ2/generated.c'), 'int g(void){return 2;}\n');
    fs.writeFileSync(
      safeCase('.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>ScanCase</name></projectDescription>',
      'utf-8'
    );
    fs.writeFileSync(safeCase('.cproject'), cpXml(['obj1', 'obj2']), 'utf-8');
    // BOTH config dirs are skipped — OBJ2 (case variant of config obj2)
    // included — so the scan finds no sources at all
    check('scan: a case-variant output dir is skipped (win32)', JSON.stringify(dirsOf(Cproject.load(caseRoot))) === '[]', JSON.stringify(dirsOf(Cproject.load(caseRoot))));
  }
}

// --- 2g. leading '-' is MRS-legal (round5 P2): the config dir is the
// wrapper's `cd` target, never a make argument, so no `-foo/...` option
// parsing can happen — read side and write side both accept it ---
{
  const pDash = makeProject(path.join(scratch, 'dash'), ['-x', 'obj']);
  check('dash: load accepts a leading-\\- name', JSON.stringify(listConfigurations(pDash)) === '["-x","obj"]', listConfigurations(pDash).join(','));
  check('dash: the dash-named config IS the active build dir', Cproject.load(pDash).configName === '-x', Cproject.load(pDash).configName);
  // '-x' already active → no-op; switch away and back to exercise Target Path
  check('dash: no-op when already active', switchConfiguration(pDash, '-x').changed === false);
  const rDash = switchConfiguration(pDash, 'obj');
  check('dash: switch away rewrites Target Path', rDash.targetPath === 'obj/Foo.hex', rDash.targetPath);
  const rBack = switchConfiguration(pDash, '-x');
  check('dash: switch onto the dash-named config works', rBack.active === '-x' && rBack.targetPath === '-x/Foo.hex', `${rBack.active}/${rBack.targetPath}`);
  const added = addConfiguration(pDash, '-y', '-x');
  check('dash: addConfiguration accepts a dash name (UI rule parity)', JSON.stringify(added.names) === '["-x","obj","-y"]', added.names.join(','));
  const deleted = deleteConfiguration(pDash, '-y');
  check('dash: delete of a dash-named config works', JSON.stringify(deleted.names) === '["-x","obj"]', deleted.names.join(','));
}

// --- 2h. Windows reserved device names & segment length (round6 P2) ---
// The name WAS accepted but the build wrapper could never `cd` into CON/NUL
// and mkdir died on >255-segment names — both are refused at validation now,
// with an actionable reason instead of a shell error.
{
  const { configNameProblem } = require('../out/core/cproject.js');
  for (const raw of ['CON', 'con', 'NUL', 'Com1', 'COM9', 'LPT9', 'LPT9.log', 'CON.txt', 'NUL.foo']) {
    check(`reserved: ${raw} — concrete reason`, (configNameProblem(raw) || '').includes('reserved Windows device name'), configNameProblem(raw));
  }
  const resDir = path.join(scratch, 'reserved-probe');
  fs.rmSync(resDir, { recursive: true, force: true });
  fs.mkdirSync(resDir, { recursive: true });
  const resXml = cpXml(['obj']).split('name="obj"').join('name="NUL.foo"');
  fs.writeFileSync(path.join(resDir, '.cproject'), resXml, 'utf-8');
  let err = '';
  try {
    Cproject.load(resDir);
  } catch (e) {
    err = String(e && e.message);
  }
  check('reserved: load refuses NUL.foo with the reason', err.includes('unsafe configuration name') && err.includes('reserved Windows device name'), err);
  // zero-write guards watch the PROJECT the calls act on (round7 P3-2: the old
  // assertion compared resDir, which add/rename never touch — it proved nothing)
  const p1Before = fs.readFileSync(path.join(p1, '.cproject'), 'utf-8');
  let errAdd = '';
  try {
    addConfiguration(p1, 'COM1');
  } catch (e) {
    errAdd = String(e && e.message);
  }
  check('reserved: addConfiguration refuses COM1 with the reason', errAdd.includes('reserved Windows device name'), errAdd);
  let errRen = '';
  try {
    renameConfiguration(p1, 'obj1', 'PRN');
  } catch (e) {
    errRen = String(e && e.message);
  }
  check('reserved: renameConfiguration refuses PRN with the reason', errRen.includes('reserved Windows device name'), errRen);
  check(
    'reserved: refusals left p1 byte-identical',
    fs.readFileSync(path.join(p1, '.cproject'), 'utf-8') === p1Before,
    ''
  );
  check('reserved: resDir probe untouched', fs.readFileSync(path.join(resDir, '.cproject'), 'utf-8') === resXml, '');
  check('length: 256 chars rejected', (configNameProblem('x'.repeat(256)) || '').includes('too long'));
  check('length: 255 chars accepted', configNameProblem('x'.repeat(255)) === undefined);
  // 86 CJK chars = 258 UTF-8 bytes (ext4 segment limit) but only 86 UTF-16
  // units — the byte check must catch it
  check('length: CJK beyond 255 UTF-8 bytes rejected', (configNameProblem('中'.repeat(86)) || '').includes('too long'));
  check('safe baselines unaffected', configNameProblem('obj') === undefined && configNameProblem('中文配置') === undefined && configNameProblem('-debug') === undefined);
}

// --- 3. already active = no-op, zero writes
const before3 = fs.readFileSync(path.join(p1, '.cproject'), 'utf-8');
const r3 = switchConfiguration(p1, 'obj1');
check('no-op: changed=false', r3.changed === false && r3.active === 'obj1', `${r3.changed}/${r3.active}`);
check('no-op: .cproject untouched', fs.readFileSync(path.join(p1, '.cproject'), 'utf-8') === before3);

// --- 4. unknown name: throws before writing
const snap = ['.cproject', '.template', `${PROJECT}.wvproj`].map((f) =>
  fs.readFileSync(path.join(p1, f), 'utf-8')
);
let threw = '';
try {
  switchConfiguration(p1, 'nope');
} catch (e) {
  threw = String(e && e.message);
}
check('unknown: throws', threw.includes('unknown configuration'), threw);
check(
  'unknown: zero writes',
  ['.cproject', '.template', `${PROJECT}.wvproj`].every(
    (f, i) => fs.readFileSync(path.join(p1, f), 'utf-8') === snap[i]
  )
);

// --- 5. single configuration: nothing to switch
const p5 = makeProject(path.join(scratch, 'p5'), ['obj']);
const r5 = switchConfiguration(p5, 'obj');
check('single config: changed=false', r5.changed === false && r5.names.length === 1, `${r5.changed}/${r5.names.length}`);

// --- 6. no .wvproj: works, reports absent
const p6 = makeProject(path.join(scratch, 'p6'), ['obj1', 'obj'], { wvproj: false });
const r6 = switchConfiguration(p6, 'obj');
check('no .wvproj: switch succeeds', r6.changed === true && r6.wvproj === 'absent', r6.wvproj);
check('no .wvproj: .cproject still reordered', Cproject.load(p6).configName === 'obj');

// --- 7. no .template: switch succeeds, nothing invents a Target Path
const p7 = makeProject(path.join(scratch, 'p7'), ['obj1', 'obj'], { template: false });
const r7 = switchConfiguration(p7, 'obj');
check('no .template: targetPath undefined', r7.changed === true && r7.targetPath === undefined, String(r7.targetPath));
check('no .template: .template not created', !fs.existsSync(path.join(p7, '.template')));
check('no .template: .wvproj still synced', r7.wvproj === 'updated', r7.wvproj);

// --- 8. manage: add / rename / delete (MRS 配置管理 semantics)
const readProject = (dir) =>
  ['.cproject', '.template', `${PROJECT}.wvproj`].map((f) => fs.readFileSync(path.join(dir, f), 'utf-8')).join('\u0000');
const readWvproj = (dir) => JSON.parse(fs.readFileSync(path.join(dir, `${PROJECT}.wvproj`), 'utf-8'));

const p9 = makeProject(path.join(scratch, 'p9'), ['obj1', 'obj']);
const addRes = addConfiguration(p9, 'dbg');
check('manage add: appends the name', JSON.stringify(addRes.names) === '["obj1","obj","dbg"]', addRes.names.join(','));
check('manage add: active unchanged', Cproject.load(p9).configName === 'obj1');
const raw9 = fs.readFileSync(path.join(p9, '.cproject'), 'utf-8');
check('manage add: config ids derive from sha1(name)', raw9.includes('riscv.config.elf.release.' + idSuffixOf('dbg')));
check(
  'manage add: .wvproj gained the configuration',
  readWvproj(p9).buildConfig.configurations.map((c) => c.name).join(',') === 'obj1,obj,dbg'
);

const snap9 = readProject(p9);
for (const [label, fn] of [
  ['duplicate (case-insensitive)', () => addConfiguration(p9, 'OBJ')],
  ['space in name', () => addConfiguration(p9, 'bad name')],
  ['path characters', () => addConfiguration(p9, '../x')],
]) {
  let err = '';
  try {
    fn();
  } catch (e) {
    err = String(e && e.message);
  }
  check(`manage add: ${label} refused`, err.length > 0, err);
}
check('manage add: refusals write nothing', readProject(p9) === snap9);

// copy source: a non-active configuration is copied, not the active one
const p11 = makeProject(path.join(scratch, 'p11'), ['obj1', 'obj']);
addConfiguration(p11, 'snap', 'obj');
check(
  'manage add: copy source options are copied',
  blocksOf(fs.readFileSync(path.join(p11, '.cproject'), 'utf-8'))[2].text.includes('value="level.size"')
);

// limit: MRS allows at most 10 configurations
const p10 = makeProject(path.join(scratch, 'p10'), ['obj1']);
for (let i = 2; i <= 10; i++) addConfiguration(p10, 'c' + i);
let limitErr = '';
try {
  addConfiguration(p10, 'c11');
} catch (e) {
  limitErr = String(e && e.message);
}
check('manage add: 11th configuration refused', /at most 10/.test(limitErr), limitErr);

// rename the ACTIVE configuration: ids + Target Path follow
const rn = renameConfiguration(p9, 'obj1', 'release');
check('manage rename: names', rn.names.join(',') === 'release,obj,dbg', rn.names.join(','));
check('manage rename: target path follows', fs.readFileSync(path.join(p9, '.template'), 'utf-8').includes('Target Path=release/Foo.hex'));
const rawRenamed = fs.readFileSync(path.join(p9, '.cproject'), 'utf-8');
check(
  'manage rename: ids retargeted from the new name',
  rawRenamed.includes('riscv.config.elf.release.' + idSuffixOf('release')) &&
    !rawRenamed.includes('riscv.config.elf.release.' + idSuffixOf('obj1'))
);
check(
  'manage rename: .wvproj follows',
  readWvproj(p9).buildConfig.configurations[0].name === 'release' &&
    readWvproj(p9).flashConfig.target_path === 'release/Foo.hex'
);

// rename a NON-active configuration: the download target must not move
renameConfiguration(p9, 'dbg', 'debug');
check(
  'manage rename: inactive rename keeps Target Path',
  fs.readFileSync(path.join(p9, '.template'), 'utf-8').includes('Target Path=release/Foo.hex')
);
const snapRename = readProject(p9);
let dupRenameErr = '';
try {
  renameConfiguration(p9, 'obj', 'debug');
} catch (e) {
  dupRenameErr = String(e && e.message);
}
check('manage rename: existing name refused', dupRenameErr.length > 0, dupRenameErr);
check('manage rename: refusal writes nothing', readProject(p9) === snapRename);

// delete: active refused, inactive removes exactly one block
let delActiveErr = '';
try {
  deleteConfiguration(p9, 'release');
} catch (e) {
  delActiveErr = String(e && e.message);
}
check('manage delete: active configuration refused', /active configuration/.test(delActiveErr), delActiveErr);
const blocksBeforeDelete = blocksOf(fs.readFileSync(path.join(p9, '.cproject'), 'utf-8'));
deleteConfiguration(p9, 'debug');
const blocksAfterDelete = blocksOf(fs.readFileSync(path.join(p9, '.cproject'), 'utf-8'));
check(
  'manage delete: removes exactly the chosen block',
  blocksAfterDelete.length === 2 &&
    blocksAfterDelete[0].text === blocksBeforeDelete[0].text &&
    blocksAfterDelete[1].text === blocksBeforeDelete[1].text
);
check('manage delete: active remains first', Cproject.load(p9).configName === 'release');
check(
  'manage delete: .wvproj entry removed',
  readWvproj(p9).buildConfig.configurations.map((c) => c.name).join(',') === 'release,obj'
);

// --- 9. damaged XML: refused before any write (same gate as Apply)
const p8 = path.join(scratch, 'p8');
fs.mkdirSync(p8, { recursive: true });
const damaged = cpXml(['obj1', 'obj']).replace('name="obj1"', 'name="obj1&x"');
fs.writeFileSync(path.join(p8, '.cproject'), damaged, 'utf-8');
let damagedErr = '';
try {
  switchConfiguration(p8, 'obj');
} catch (e) {
  damagedErr = String(e && e.message);
}
check('damaged XML: refused', /XML is invalid/.test(damagedErr), damagedErr);
check('damaged XML: file untouched', fs.readFileSync(path.join(p8, '.cproject'), 'utf-8') === damaged);

// --- 8. optional: a REAL multi-config project on this machine (skipped when
// absent; copied into .scratch so the source tree is never touched). Pins the
// reorder on a genuine MRS2 file with 200+ options per configuration.
const realSrc = [path.join(__dirname, '..', '..', 'TEST', 'BLE_NFC_PCD')].find((p) =>
  fs.existsSync(path.join(p, '.cproject'))
);
if (!realSrc) {
  console.log('SKIP  real-project check (no multi-config test project)');
} else if (listConfigurations(realSrc).length < 2) {
  console.log('SKIP  real-project check (single configuration)');
} else {
  const realDir = path.join(scratch, 'real');
  fs.mkdirSync(realDir, { recursive: true });
  const copies = fs
    .readdirSync(realSrc)
    .filter((n) => n === '.cproject' || n === '.template' || n.toLowerCase().endsWith('.wvproj'));
  for (const n of copies) {
    if (path.basename(n) !== n) continue;
    fs.copyFileSync(path.join(realSrc, n), path.join(realDir, n));
  }
  const rd = (n) => fs.readFileSync(path.join(realDir, n), 'utf-8');
  const wvName = copies.find((n) => n.toLowerCase().endsWith('.wvproj'));
  const first = listConfigurations(realDir)[0];
  const second = listConfigurations(realDir)[1];
  const beforeCp = rd('.cproject');
  const beforeTpl = rd('.template');
  const beforeWv = wvName ? rd(wvName) : '';

  switchConfiguration(realDir, second);
  const rb = blocksOf(beforeCp);
  const ra = blocksOf(rd('.cproject'));
  check(
    'real project: blocks swapped byte-exactly',
    ra.length === 2 && ra[0].text === rb[1].text && ra[1].text === rb[0].text
  );
  check('real project: active follows the new order', Cproject.load(realDir).configName === second);
  check('real project: .template target follows', rd('.template').includes(`Target Path=${second}/`));

  switchConfiguration(realDir, first);
  check('real project: .cproject round-trip byte-identical', rd('.cproject') === beforeCp);
  // .template rewriting keeps every line byte-identical but always ends the
  // file with CRLF (writeTemplate's existing contract) — a source file that
  // lacked the trailing newline gains it once, then stays stable
  check(
    'real project: .template round-trip (modulo trailing EOL)',
    rd('.template').replace(/\r?\n$/, '') === beforeTpl.replace(/\r?\n$/, '')
  );
  if (wvName) check('real project: .wvproj round-trip byte-identical', rd(wvName) === beforeWv);
}

// --- duplicate configuration names (0.3.7): only imported projects have
// them (MRVC's own Add/Rename refuse duplicates). The name IS the output
// directory, so operations address rows by INDEX — a name lookup always hit
// the first row (switch became a no-op, delete refused "active", rename
// renamed the WRONG configuration).
{
  const dupDir = path.join(scratch, 'dup');
  fs.mkdirSync(dupDir, { recursive: true });
  // generate with a distinct placeholder name so the ids stay unique, then
  // rename ONLY the second block to "dbg" — the real EVT shape
  const raw = cpXml(['dbg', 'tmp']);
  const dupXml = raw.replace('name="tmp"', 'name="dbg"').replace(/name="tmp"/g, 'name="dbg"');
  fs.writeFileSync(path.join(dupDir, '.cproject'), dupXml, 'utf-8');
  fs.writeFileSync(path.join(dupDir, '.template'), template('dbg/Foo.hex'), 'utf-8');
  fs.writeFileSync(
    path.join(dupDir, `${PROJECT}.wvproj`),
    JSON.stringify(
      {
        version: '1.0',
        basic: { projectName: PROJECT },
        buildConfig: { configurations: [{ name: 'dbg', x: 1 }, { name: 'dbg', x: 2 }] },
        flashConfig: { target_path: 'dbg/Foo.hex' },
      },
      null,
      '\t'
    ),
    'utf-8'
  );
  const rdD = () => fs.readFileSync(path.join(dupDir, '.cproject'), 'utf-8');
  const blocksD = () => blocksOf(rdD());
  const dupCp = Cproject.load(dupDir);
  check('dup: two configurations share the name', JSON.stringify(dupCp.configurationNames) === JSON.stringify(['dbg', 'dbg']));
  check('dup: duplicateConfigurationNames reports it once', JSON.stringify(dupCp.duplicateConfigurationNames) === JSON.stringify(['dbg']));
  // per-row option values really differ — the rows are NOT interchangeable
  check(
    'dup: the two rows keep their own option sets',
    Cproject.loadConfigAt(dupDir, 0).configurationNames.length === 2 &&
      /level\.none/.test(blocksD()[0].text) &&
      /level\.size/.test(blocksD()[1].text)
  );

  const before = rdD();
  const beforeBlocks = blocksD();
  // an ambiguous name without an index is an ERROR, never a silent first-row hit
  let amb = '';
  try {
    switchConfiguration(dupDir, 'dbg');
  } catch (e) {
    amb = String(e.message);
  }
  check('dup: switching by an ambiguous name is refused', /more than one configuration/.test(amb), amb);
  check('dup: the refused switch wrote nothing', rdD() === before);
  // index-addressed switch: swaps the rows, active = the former SECOND row
  const sw = switchConfiguration(dupDir, 'dbg', 1);
  check('dup: switch by index reorders the rows', sw.changed === true && sw.active === 'dbg');
  check(
    'dup: the SECOND block became the first (index-addressed)',
    blocksD()[0].text === beforeBlocks[1].text && blocksD()[1].text === beforeBlocks[0].text
  );
  switchConfiguration(dupDir, 'dbg', 1);
  check('dup: switching back by index round-trips byte-identically', rdD() === before);

  amb = '';
  try {
    renameConfiguration(dupDir, 'dbg', 'dbg2');
  } catch (e) {
    amb = String(e.message);
  }
  check('dup: renaming by an ambiguous name is refused', /more than one configuration/.test(amb), amb);
  // renaming row 1 (the second) must touch the SECOND block, not the active one
  const re = renameConfiguration(dupDir, 'dbg', 'dbg2', 1);
  check('dup: rename by index names the second row', JSON.stringify(re.names) === JSON.stringify(['dbg', 'dbg2']));
  check('dup: only the second <configuration> was renamed', blocksD()[0].text.includes('name="dbg"') && blocksD()[1].text.includes('name="dbg2"'));
  const dupWv = JSON.parse(fs.readFileSync(path.join(dupDir, `${PROJECT}.wvproj`), 'utf-8'));
  check('dup: the .wvproj snapshot renamed the SAME row', dupWv.buildConfig.configurations[1].name === 'dbg2');

  // delete: a FRESH duplicate fixture (the one above no longer has a
  // duplicate after the rename)
  const delDir = path.join(scratch, 'dup-del');
  fs.mkdirSync(delDir, { recursive: true });
  fs.writeFileSync(path.join(delDir, '.cproject'), dupXml, 'utf-8');
  fs.writeFileSync(path.join(delDir, '.template'), template('dbg/Foo.hex'), 'utf-8');
  fs.writeFileSync(
    path.join(delDir, `${PROJECT}.wvproj`),
    JSON.stringify(
      {
        version: '1.0',
        basic: { projectName: PROJECT },
        buildConfig: { configurations: [{ name: 'dbg', x: 1 }, { name: 'dbg', x: 2 }] },
        flashConfig: { target_path: 'dbg/Foo.hex' },
      },
      null,
      '\t'
    ),
    'utf-8'
  );
  const delBlocks = () => blocksOf(fs.readFileSync(path.join(delDir, '.cproject'), 'utf-8'));
  amb = '';
  try {
    deleteConfiguration(delDir, 'dbg');
  } catch (e) {
    amb = String(e.message);
  }
  check('dup: deleting by an ambiguous name is refused', /more than one configuration/.test(amb), amb);
  amb = '';
  try {
    deleteConfiguration(delDir, 'dbg', 0);
  } catch (e) {
    amb = String(e.message);
  }
  check('dup: deleting the ACTIVE row is still refused', /cannot delete the active/.test(amb), amb);
  const del = deleteConfiguration(delDir, 'dbg', 1);
  check('dup: deleting row 1 removes the second block only', JSON.stringify(del.names) === JSON.stringify(['dbg']) && delBlocks().length === 1);
  check('dup: the surviving row is the ACTIVE one', delBlocks()[0].text.includes('name="dbg"'));

  // Copy-from by index: the source row's OWN option set must be cloned
  const add2 = makeProject(path.join(scratch, 'dup-add'), ['dbg', 'tmp']);
  const raw2 = fs.readFileSync(path.join(add2, '.cproject'), 'utf-8').replace(/name="tmp"/g, 'name="dbg"');
  fs.writeFileSync(path.join(add2, '.cproject'), raw2, 'utf-8');
  addConfiguration(add2, 'copy2', 'dbg', 1);
  const addBlocks = blocksOf(fs.readFileSync(path.join(add2, '.cproject'), 'utf-8'));
  check('dup: add with copyFromIndex clones the SECOND row', /copy2/.test(addBlocks[2].text) && /level\.size/.test(addBlocks[2].text));

  // Copy-from: the .wvproj snapshot row must be the SAME positional row
  // (0.3.7 round1 P3.2 — the name lookup copied the FIRST of two same-named
  // rows even when the SECOND one was picked)
  const snapDir = path.join(scratch, 'dup-snap');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, '.cproject'), dupXml, 'utf-8');
  fs.writeFileSync(path.join(snapDir, '.template'), template('dbg/Foo.hex'), 'utf-8');
  const wvDoc = (rows) => JSON.stringify({ version: '1.0', basic: { projectName: PROJECT }, buildConfig: { configurations: rows }, flashConfig: { target_path: 'dbg/Foo.hex' } }, null, '\t');
  fs.writeFileSync(path.join(snapDir, `${PROJECT}.wvproj`), wvDoc([{ name: 'dbg', x: 1 }, { name: 'dbg', x: 2 }]), 'utf-8');
  addConfiguration(snapDir, 'copy3', 'dbg', 1);
  const snapRows = JSON.parse(fs.readFileSync(path.join(snapDir, `${PROJECT}.wvproj`), 'utf-8')).buildConfig.configurations;
  check(
    'dup: Copy from the SECOND row clones the SECOND snapshot row',
    JSON.stringify(snapRows) === JSON.stringify([{ name: 'dbg', x: 1 }, { name: 'dbg', x: 2 }, { name: 'copy3', x: 2 }]),
    JSON.stringify(snapRows)
  );
  // a snapshot that drifted from .cproject AND carries an ambiguous name:
  // no row is guessed — the snapshot is left exactly as it was
  const driftDir = path.join(scratch, 'dup-drift');
  fs.mkdirSync(driftDir, { recursive: true });
  fs.writeFileSync(path.join(driftDir, '.cproject'), dupXml, 'utf-8');
  fs.writeFileSync(path.join(driftDir, '.template'), template('dbg/Foo.hex'), 'utf-8');
  const drifted = wvDoc([{ name: 'dbg', x: 1 }, { name: 'dbg', x: 2 }, { name: 'stray' }]);
  fs.writeFileSync(path.join(driftDir, `${PROJECT}.wvproj`), drifted, 'utf-8');
  addConfiguration(driftDir, 'copy4', 'dbg', 1);
  check('dup: an ambiguous name in a DRIFTED snapshot is skipped, never guessed', fs.readFileSync(path.join(driftDir, `${PROJECT}.wvproj`), 'utf-8') === drifted);
  check('dup: ...the .cproject itself was still written', blocksOf(fs.readFileSync(path.join(driftDir, '.cproject'), 'utf-8')).length === 3);
  // rename / delete / switch share the same snapshot row lookup: on a
  // drifted ambiguous snapshot they leave the snapshot alone too (the
  // .cproject operation itself still happens). One fixture per operation,
  // each with the same drifted three-row snapshot.
  const driftRename = path.join(scratch, 'dup-drift2');
  fs.mkdirSync(driftRename, { recursive: true });
  fs.writeFileSync(path.join(driftRename, '.cproject'), dupXml, 'utf-8');
  fs.writeFileSync(path.join(driftRename, '.template'), template('dbg/Foo.hex'), 'utf-8');
  fs.writeFileSync(path.join(driftRename, `${PROJECT}.wvproj`), drifted, 'utf-8');
  renameConfiguration(driftRename, 'dbg', 'dbg9', 1);
  check('dup: rename by index leaves a drifted ambiguous snapshot untouched', fs.readFileSync(path.join(driftRename, `${PROJECT}.wvproj`), 'utf-8') === drifted);
  check('dup: ...and still renamed the .cproject row', /name="dbg9"/.test(fs.readFileSync(path.join(driftRename, '.cproject'), 'utf-8')));

  const driftDelete = path.join(scratch, 'dup-drift3');
  fs.mkdirSync(driftDelete, { recursive: true });
  fs.writeFileSync(path.join(driftDelete, '.cproject'), dupXml, 'utf-8');
  fs.writeFileSync(path.join(driftDelete, '.template'), template('dbg/Foo.hex'), 'utf-8');
  fs.writeFileSync(path.join(driftDelete, `${PROJECT}.wvproj`), drifted, 'utf-8');
  const delDrift = deleteConfiguration(driftDelete, 'dbg', 1);
  check(
    'dup: delete by index leaves a drifted ambiguous snapshot untouched',
    fs.readFileSync(path.join(driftDelete, `${PROJECT}.wvproj`), 'utf-8') === drifted && JSON.stringify(delDrift.names) === '["dbg"]'
  );

  const driftSwitch = path.join(scratch, 'dup-drift4');
  fs.mkdirSync(driftSwitch, { recursive: true });
  fs.writeFileSync(path.join(driftSwitch, '.cproject'), dupXml, 'utf-8');
  fs.writeFileSync(path.join(driftSwitch, '.template'), template('dbg/Foo.hex'), 'utf-8');
  fs.writeFileSync(path.join(driftSwitch, `${PROJECT}.wvproj`), drifted, 'utf-8');
  switchConfiguration(driftSwitch, 'dbg', 1);
  check('dup: switch by index leaves a drifted ambiguous snapshot untouched', fs.readFileSync(path.join(driftSwitch, `${PROJECT}.wvproj`), 'utf-8') === drifted);

  // case-folded duplicates (0.3.7 round1 P3.3): on Windows `obj` and `OBJ`
  // share ONE output directory — the very pair MRVC's own Add refuses — so
  // the duplicate notice must fire there; on Linux/macOS they are two dirs
  const { duplicateConfigNames } = require('../out/core/cproject.js');
  const lower = (s) => s.toLowerCase();
  const same = (s) => s;
  check('dup: obj/OBJ is a duplicate on a case-insensitive host', JSON.stringify(duplicateConfigNames(['obj', 'OBJ'], lower)) === '["obj"]');
  check('dup: obj/OBJ stays distinct on a case-sensitive host', JSON.stringify(duplicateConfigNames(['obj', 'OBJ'], same)) === '[]');
  check('dup: the fold reports the first-seen spelling once', JSON.stringify(duplicateConfigNames(['OBJ', 'obj', 'Obj'], lower)) === '["OBJ"]');
  check('dup: three spellings on a case-sensitive host stay all distinct', JSON.stringify(duplicateConfigNames(['OBJ', 'obj', 'Obj'], same)) === '[]');
  check(
    'dup: the default fold follows the host platform',
    JSON.stringify(duplicateConfigNames(['obj', 'OBJ'])) === (process.platform === 'win32' ? '["obj"]' : '[]')
  );
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nall configuration-switch assertions passed');
