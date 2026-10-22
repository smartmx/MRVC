/* Round-trip tests for config write-back and linked folders (scratch copies). */
const path = require('path');
const fs = require('fs');
const { Cproject } = require('../out/core/cproject.js');
const { addLinkedFolder, removeLinkedFolder, readProjectFile, setCppNature, hasLegacyCppNature } = require('../out/core/projectFile.js');
const { setProjectCpp, migrateLegacyCppNature } = require('../out/core/projectType.js');

const scratch = path.join(__dirname, '..', '.scratch', 'roundtrip');
// real EVT tree: prefer the local TEST copy, fall back to the F:/ layout
const LED_PROJ = ['E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'F:/CH585/EVT/V1_2/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find((r) => fs.existsSync(r));
if (!LED_PROJ) {
  console.log('SKIP: LED project not found (no real EVT tree)');
  process.exit(0);
}
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
for (const f of ['.project', '.cproject', '.template']) {
  fs.copyFileSync(path.join(LED_PROJ, f), path.join(scratch, f));
}
// a minimal source tree so makefile generation has something to scan
fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'src', 'main.c'), 'int main(void){return 0;}\n');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// --- config round trip ---
let cp = Cproject.load(scratch);
const before = cp.optimizationLevel;
cp.setOptionValue('optimization.level', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.optimization.level.most');
cp.setOptionBool('warnings.allwarn', true, true);
cp.addToListOption('c.compiler.defs', 'TEST_MACRO=1');
cp.save();

cp = Cproject.load(scratch);
check('optimization level written', cp.optionEnum('optimization.level') === 'most');
check('was not most before', before !== 'most');
check('warning -Wall written', cp.optionBool('warnings.allwarn') === true);
check('define appended', cp.listOption('c.compiler.defs').values.includes('TEST_MACRO=1'));
check('original define kept', cp.listOption('c.compiler.defs').values.includes('DEBUG=0'));
check('still valid XML', Cproject.load(scratch) !== undefined);
const raw = fs.readFileSync(path.join(scratch, '.cproject'), 'utf-8');
check('declaration preserved (leading blank lines kept as in the source)', /^\s*<\?xml/.test(raw));
check('list values quoted', raw.includes('&quot;TEST_MACRO=1&quot;'));

// --- linked folder round trip ---
const target = path.join(path.dirname(LED_PROJ), 'SRC', 'RVMSIS');
const link = addLinkedFolder(scratch, 'TestLink', target);
check('link created', !!link);
const pf = readProjectFile(scratch);
check('link parses back', pf.linkedResources.some((l) => l.name === 'TestLink' && l.location === path.normalize(target)));
check('URI uses PARENT form', pf.linkedResources.find((l) => l.name === 'TestLink').locationUri.startsWith('PARENT-'));

removeLinkedFolder(scratch, 'TestLink');
check('link removed', !readProjectFile(scratch).linkedResources.some((l) => l.name === 'TestLink'));

// --- C++ nature toggle (the "C++ project" switch behind the C++ pages) ---
setCppNature(scratch, true);
check('cpp nature added', readProjectFile(scratch).natures.includes('org.eclipse.cdt.core.ccnature'));
check('cpp nature sits right after cnature', readProjectFile(scratch).natures.indexOf('org.eclipse.cdt.core.ccnature') === readProjectFile(scratch).natures.indexOf('org.eclipse.cdt.core.cnature') + 1);
setCppNature(scratch, true);
check('cpp nature toggle idempotent', readProjectFile(scratch).natures.filter((n) => n === 'org.eclipse.cdt.core.ccnature').length === 1);
// a project carrying the id MRVC <= 0.2.2 wrote is normalized on the next
// toggle (the mis-spelled id is not a real CDT nature — MRS2 never saw it)
{
  const projFile = path.join(scratch, '.project');
  const raw = fs.readFileSync(projFile, 'utf-8');
  fs.writeFileSync(projFile, raw.replace(/org\.eclipse\.cdt\.core\.ccnature/g, 'org.eclipse.cdt.core.cxxnature'), 'utf-8');
  check('legacy cpp nature injected for the migration case', readProjectFile(scratch).natures.includes('org.eclipse.cdt.core.cxxnature'));
  setCppNature(scratch, true);
  const natures = readProjectFile(scratch).natures;
  check('legacy cpp nature replaced by the real id', natures.includes('org.eclipse.cdt.core.ccnature') && !natures.includes('org.eclipse.cdt.core.cxxnature'));
  check('migration keeps a single cpp nature', natures.filter((n) => n === 'org.eclipse.cdt.core.ccnature').length === 1);
  setCppNature(scratch, false);
  check('switching off removes either spelling', !readProjectFile(scratch).natures.some((n) => n.includes('ccnature') || n === 'org.eclipse.cdt.core.cxxnature'));

  // the load-time migration (projects.ts add -> migrateLegacyCppNature): a
  // project converted by MRVC <= 0.2.2 is repaired in ONE step — real nature id
  // plus the mirrored C options — instead of needing the type switch twice
  {
    const raw2 = fs.readFileSync(projFile, 'utf-8');
    fs.writeFileSync(
      projFile,
      raw2.replace(
        '<nature>org.eclipse.cdt.core.cnature</nature>',
        '<nature>org.eclipse.cdt.core.cnature</nature>\r\n\t\t<nature>org.eclipse.cdt.core.cxxnature</nature>'
      ),
      'utf-8'
    );
    check('legacy project detected before load', hasLegacyCppNature(scratch) === true);
    const res2 = migrateLegacyCppNature(scratch);
    check('legacy migration reports the repair', res2 === true);
    const migrated = Cproject.load(scratch);
    const natures2 = readProjectFile(scratch).natures;
    check('legacy migration lands on the real id only', natures2.includes('org.eclipse.cdt.core.ccnature') && !natures2.includes('org.eclipse.cdt.core.cxxnature'));
    check(
      'legacy migration mirrors the C options into the cpp set',
      JSON.stringify(migrated.listOption('cpp.linker.scriptfile').values) === JSON.stringify(migrated.listOption('c.linker.scriptfile').values)
    );
    check('legacy migration is a no-op on a clean project', migrateLegacyCppNature(scratch) === false);
    setProjectCpp(scratch, false);
    check('scratch left as C for the later blocks', Cproject.load(scratch).isCpp === false);
  }
}
check('.project still parses after nature toggling', !!readProjectFile(scratch).name);

// --- P1 fields round trip (canonical CDT suffixes) ---
const { generateMakefiles } = require('../out/core/makefile.js');
const tcStub = {
  name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
  linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
  objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size',
  prefix: 'riscv-wch-elf-',
};

cp = Cproject.load(scratch);
cp.setOptionValue('target.rvGcc', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.rvGcc.15');
cp.setOptionBool('c.linker.printf', true, true);
cp.setOptionBool('c.linker.printfloat', true, true);
cp.setOptionBool('c.linker.iqmath', true, true);
cp.setOptionValue('debugging.level', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.debugging.level.none');
cp.setOptionBool('target.isa.zmmul', true, true);
cp.setOptionValue('cpp.compiler.std', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.cpp.compiler.std.cpp17');
cp.save();

cp = Cproject.load(scratch);
check('rvGcc = 15', cp.rvGccVersion === '15');
check('wch printf stored', cp.optionBool('c.linker.printf'));
check('debugging level = none', cp.optionEnum('debugging.level') === 'none');
check('zmmul stored', cp.optionBool('target.isa.zmmul'));
check('cpp std = cpp17', cp.optionEnum('cpp.compiler.std') === 'cpp17');

// wch libs ride the link recipe after $(LIBS) (MRS2 parity: objects.mk ends
// with the configured libs plus the forced -lm, the -lprintf/-lIQmath_RV32
// family sits on the recipe); -march must gain _zmmul; debug none drops -g
const gen = generateMakefiles(cp, tcStub);
const objectsMk = fs.readFileSync(path.join(scratch, 'obj', 'objects.mk'), 'utf-8');
const makeMk = fs.readFileSync(path.join(scratch, 'obj', 'makefile'), 'utf-8');
const srcSubdir = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
check('user lib ISP585 kept', objectsMk.includes('-lISP585'));
check('objects.mk appends the forced -lm', objectsMk.includes('-lISP585 -lm'));
check('objects.mk keeps wch libs out', !objectsMk.includes('-lprintf') && !objectsMk.includes('-lIQmath_RV32'));
check('recipe has wch libs after $(LIBS)', /\$\(LIBS\) -lIQmath_RV32 -lprintf -lprintfloat/.test(makeMk));
check('-march gains _zmmul', srcSubdir.includes('_zba_zbb_zbc_zbs_zmmul_xw'));
check('debug level none removes -g', !srcSubdir.includes(' -g '));

// --- C -> C++ conversion mirrors the option set (.cproject half) ---
// A nature-only toggle used to build C++ with an empty option set: no include
// paths, no linker script (real build evidence: the link died on a bare
// "Link.ld"). The conversion must carry the C settings into the C++ twins.
{
  const before = Cproject.load(scratch);
  check('conversion precondition: scratch project is C', before.isCpp === false);
  const cScripts = before.listOption('c.linker.scriptfile').values;
  const cIncludes = before.listOption('c.compiler.include.paths').values;
  // MRS2 keeps each valueType in its native spelling (library names unquoted,
  // macro paths quoted) and reads `libraries`/`defined_symbols` VERBATIM into
  // its model — only path-ish lists pass a quote-stripping resolve. Give the
  // source list one unquoted entry so the mirror's spelling fidelity is
  // actually testable: re-quoting it would carry `"m"` into MRS2's model (and
  // into USER_OBJS, which MRS2 quotes by itself).
  before.setOptionList('c.linker.libs', [...before.listOption('c.linker.libs').values, 'm']);
  before.save();
  {
    const projFile = path.join(scratch, '.cproject');
    const rawXml = fs.readFileSync(projFile, 'utf-8');
    fs.writeFileSync(projFile, rawXml.replace(/value="&quot;m&quot;"/g, 'value="m"'), 'utf-8');
  }
  const rawList = (cp, suffix) => {
    const opt = cp.listOption(suffix).option;
    return opt ? opt.childrenNamed('listOptionValue').map((e) => e.attr('value')) : [];
  };
  // the C build's linker-script argument, for a byte-level comparison below
  generateMakefiles(before, tcStub);
  const cMk = fs.readFileSync(path.join(scratch, 'obj', 'makefile'), 'utf-8');
  const cScriptArg = (cMk.match(/-T "[^"]*"/) ?? [''])[0];

  const res = setProjectCpp(scratch, true);
  const after = Cproject.load(scratch);
  check('conversion switches the project type', after.isCpp === true);
  check('conversion mirrored the C options', res.mirrored > 5);
  check(
    'conversion mirrored the script-file list',
    cScripts.length > 0 && JSON.stringify(after.listOption('cpp.linker.scriptfile').values) === JSON.stringify(cScripts)
  );
  check(
    'conversion mirrored the include-path list',
    cIncludes.length > 0 && JSON.stringify(after.listOption('cpp.compiler.include.paths').values) === JSON.stringify(cIncludes)
  );
  check(
    'conversion preserves each value spelling verbatim (unquoted stays unquoted)',
    JSON.stringify(rawList(after, 'cpp.linker.libs')) === JSON.stringify(rawList(Cproject.load(scratch), 'c.linker.libs')) &&
      rawList(after, 'cpp.linker.libs').includes('m')
  );
  // options the conversion CREATED must carry MRS2's own metadata, copied from
  // their C twin (display name / scanner-discovery flag / value type): MRS2's
  // scanner discovery and property pages key on those, and a synthesized
  // "Paths"/"Libs" label is not what its files contain
  {
    const beforeSuffixes = new Set(before.optionSuffixes());
    const createdTwins = after.optionSuffixes().filter((s) => s.startsWith('cpp.') && !beforeSuffixes.has(s));
    const optAttr = (cp, suffix, attr) => {
      const opt = cp.listOption(suffix).option;
      return opt ? opt.attr(attr) ?? '' : '';
    };
    const badMeta = createdTwins.filter((t) => {
      const src = 'c.' + t.slice(4);
      if (!after.optionSuffixes().includes(src)) return false;
      return ['name', 'useByScannerDiscovery', 'valueType'].some((a) => optAttr(after, t, a) !== optAttr(after, src, a));
    });
    check('conversion created the missing cpp options', createdTwins.length > 0);
    check('created cpp options copy the C twin metadata (name/scan/type)', badMeta.length === 0);
    // The two assertions above are order-sensitive: an earlier step of this
    // suite also mirrors options, which would shrink the "created" set and make
    // the donor comparison vacuous for the important twins. These assert the
    // EXPECTED MRS2 metadata instead, so the pre-donation behaviour (synthetic
    // "Paths"/"Libs" name, scan=false) fails them no matter who created them.
    check(
      'cpp include-paths option carries MRS2 metadata',
      optAttr(after, 'cpp.compiler.include.paths', 'name') === 'Include paths (-I)' &&
        optAttr(after, 'cpp.compiler.include.paths', 'useByScannerDiscovery') === 'true' &&
        optAttr(after, 'cpp.compiler.include.paths', 'valueType') === 'includePath'
    );
    check(
      'cpp defines/libs options carry MRS2 metadata',
      optAttr(after, 'cpp.compiler.defs', 'name') === 'Defined symbols (-D)' &&
        optAttr(after, 'cpp.compiler.defs', 'useByScannerDiscovery') === 'true' &&
        optAttr(after, 'cpp.linker.libs', 'name') === 'Libraries (-l)' &&
        optAttr(after, 'cpp.linker.libs', 'valueType') === 'libs'
    );
    check(
      'conversion adds the C++ compiler <inputType> with MRS2\'s id',
      fs.readFileSync(path.join(scratch, '.cproject'), 'utf-8').includes('tool.cpp.compiler.input.1079228323')
    );
  }
  generateMakefiles(after, tcStub);
  const cppMk = fs.readFileSync(path.join(scratch, 'obj', 'makefile'), 'utf-8');
  const cppScriptArg = (cppMk.match(/-T "[^"]*"/) ?? [''])[0];
  check('converted makefile links with the C++ driver', cppMk.includes('riscv-wch-elf-g++'));
  check('converted makefile keeps the C linker script (not a bare "Link.ld")', !!cScriptArg && cppScriptArg === cScriptArg);
  // --- whitespace invariant of programmatic appends (round4 O1) -------------
  // `ws[i]` is the whitespace BEFORE child i, `ws[children.length]` the
  // close-tag indent. Appending used to leave the stale close-tag entry at the
  // newcomer's index, so every REWRITE of a list (a second conversion here, or
  // adding a path from the config page below) wrote the new entries one level
  // too shallow — a spurious whitespace-only diff on an otherwise identical
  // operation. Both paths are pinned here.
  const cprojFile = path.join(scratch, '.cproject');
  const bytes1 = fs.readFileSync(cprojFile, 'utf-8');
  setProjectCpp(scratch, true); // identical re-run: must change nothing
  const bytes2 = fs.readFileSync(cprojFile, 'utf-8');
  check('re-running the conversion is byte-stable (no whitespace drift)', bytes1 === bytes2);
  const optBlock = (text, suffix) => {
    const at = text.indexOf(suffix);
    if (at < 0) return '';
    const open = text.lastIndexOf('<option', at);
    const close = text.indexOf('</option>', at);
    return open < 0 || close < 0 ? '' : text.slice(open, close);
  };
  const childIndents = (text, suffix) => [...optBlock(text, suffix).matchAll(/\r\n(\t*)</g)].map((m) => m[1].length);
  const optionIndent = (text, suffix) => {
    const m = text.match(new RegExp('\\r\\n(\\t*)<option[^>]*' + suffix.replace(/\./g, '\\.')));
    return m ? m[1].length : -1;
  };
  {
    const libsIndent = optionIndent(bytes2, 'cpp.linker.libs');
    const indents = childIndents(bytes2, 'cpp.linker.libs');
    check(
      'rewritten list values keep their siblings\' indentation (one level in)',
      libsIndent > 0 && indents.length >= 2 && new Set(indents).size === 1 && indents[0] === libsIndent + 1
    );
    // inputType is a child of the C++ COMPILER <tool>, so compare it with an
    // option of that same tool (the linker's would only be valid because the
    // two tools happen to sit at the same depth)
    const input = bytes2.match(/\r\n(\t*)<inputType/);
    check(
      'the conversion\'s <inputType> is indented like the tool\'s children',
      !!input && input[1].length === optionIndent(bytes2, 'cpp.compiler.include.paths')
    );
  }
  // the form round4 measured as non-convergent: converting a SECOND time used to
  // rewrite the first conversion's own output one level shallower (toC++#1 != #2)
  setProjectCpp(scratch, false);
  setProjectCpp(scratch, true);
  check(
    'converting again after a round trip reproduces the first conversion byte for byte',
    fs.readFileSync(cprojFile, 'utf-8') === bytes1
  );
  {
    // the config page's path (Cproject.addToListOption on an existing list)
    const cp3 = Cproject.load(scratch);
    cp3.addToListOption('c.compiler.include.paths', 'probe/extra');
    cp3.save();
    const text = fs.readFileSync(cprojFile, 'utf-8');
    const indents = childIndents(text, 'c.compiler.include.paths');
    check(
      'config-page list addition matches the existing entries\' indentation',
      /value="(&quot;)?probe\/extra(&quot;)?"/.test(text) && indents.length >= 2 && new Set(indents).size === 1 &&
        indents[0] === optionIndent(text, 'c.compiler.include.paths') + 1
    );
  }
  {
    // --- .project side of the same whitespace invariant ---------------------
    // A project WITHOUT <linkedResources> (4 of 1,856 real EVT projects) takes
    // the insert path in projectFile.ts; a raw children.splice there left the
    // last child eating the close-tag entry, shifting it one level left.
    const projPath = path.join(scratch, '.project');
    const stripped = fs.readFileSync(projPath, 'utf-8').replace(/\r?\n\t<linkedResources>[\s\S]*?<\/linkedResources>/, '');
    fs.writeFileSync(projPath, stripped, 'utf-8');
    check('fixture: <linkedResources> block removed', !fs.readFileSync(projPath, 'utf-8').includes('<linkedResources>'));
    addLinkedFolder(scratch, 'IndentProbe', target);
    const projText = fs.readFileSync(projPath, 'utf-8');
    // every direct child of projectDescription must stay at exactly one tab;
    // a 0-tab start is the symptom of eating the close-tag whitespace entry
    check(
      'creating <linkedResources> keeps the projectDescription children aligned',
      ['name', 'comment', 'projects', 'buildSpec', 'natures', 'linkedResources', 'filteredResources']
        .every((t) => projText.includes('\r\n\t<' + t))
    );
    removeLinkedFolder(scratch, 'IndentProbe');
    check('removeLinkedFolder drops the block again', !fs.readFileSync(projPath, 'utf-8').includes('<linkedResources>'));

    // --- N2: empty elements keep the spelling the source used ---------------
    const { parseXml, serializeXml } = require('../out/core/xml.js');
    const pairs = '\t<projects>\r\n\t</projects>\r\n\t<comment>\r\n\t</comment>\r\n\t<arguments>\r\n\t\t</arguments>\r\n';
    const spaced = '\t<linkedResources />\r\n';
    const doc = '<?xml version="1.0" encoding="UTF-8"?>\r\n<projectDescription>\r\n' + pairs + spaced + '\t<name>X</name>\r\n</projectDescription>\r\n';
    check('empty open/close pairs survive a rewrite byte-identically', serializeXml(parseXml(doc)) === doc);
    // an element that HAD children and was emptied by an edit is not a source
    // pair: it keeps the established <x/> output
    const holder = parseXml('<a>\r\n\t<b>x</b>\r\n</a>').child('a');
    holder.removeChild(holder.child('b'));
    check('an element emptied by an edit still writes self-closing', serializeXml(holder) === '<a/>');
    // N2's real guard: a file MRS2 wrote and MRVC never touched. The scratch
    // copy cannot serve here — by now MRVC has rewritten it, so re-serializing
    // MRVC's own output would pass even without the shape preservation (review
    // round6 O3 measured exactly that).
    const pristine = fs.readFileSync(path.join(LED_PROJ, '.project'), 'utf-8');
    check(
      'a pristine MRS2 .project carries the explicit empty pairs this guards',
      /<projects>\r\n\t<\/projects>/.test(pristine)
    );
    check('a pristine MRS2 .project round-trips byte-identically', serializeXml(parseXml(pristine)) === pristine);
    // weaker, but still worth pinning: MRVC's own output stays re-serializable
    const realProj = fs.readFileSync(projPath, 'utf-8');
    check('MRVC-written .project output is re-serialization stable', serializeXml(parseXml(realProj)) === realProj);
  }
  setProjectCpp(scratch, false);
  check('switching back to C keeps the mirrored cpp set but ignores it', Cproject.load(scratch).isCpp === false);
  // ... but the <inputType> the conversion added is removed again: MRS2's own
  // C projects carry it for assembler / c.compiler / c.linker only
  check(
    'switching back to C removes the added C++ compiler <inputType>',
    !fs.readFileSync(path.join(scratch, '.cproject'), 'utf-8').includes('tool.cpp.compiler.input')
  );
}

// --- toolchain prefix read: bare / own-language / other-language forms ---
// Real MRS files store the BARE `command.prefix` (2919/2919 across the EVT
// trees), but the read must not depend on that spelling: every form resolves,
// and the project's own language wins when several are present.
{
  // the LED scratch still carries its C-language prefix option
  const cp = Cproject.load(scratch);
  const bare = cp.optionValue('command.prefix');
  check('prefix: C project reads its own bare prefix', !!bare && cp.storedPrefix === bare);
  cp.setOptionValue('c.command.prefix', 'riscv-wch-elf-');
  cp.save();
  check('prefix: own-language form is read', Cproject.load(scratch).storedPrefix === 'riscv-wch-elf-');
  cp.setOptionValue('command.prefix', 'riscv-none-embed-');
  cp.save();
  check('prefix: own-language wins over the bare form', Cproject.load(scratch).storedPrefix === 'riscv-wch-elf-');
  cp.setOptionValue('c.command.prefix', undefined);
  cp.save();
  check('prefix: bare form is the fallback', Cproject.load(scratch).storedPrefix === 'riscv-none-embed-');
  cp.setOptionValue('cpp.command.prefix', 'riscv32-wch-elf-');
  cp.setOptionValue('command.prefix', undefined);
  cp.save();
  check('prefix: other-language form is the last resort', Cproject.load(scratch).storedPrefix === 'riscv32-wch-elf-');
  cp.setOptionValue('cpp.command.prefix', undefined);
  cp.save();
  check('prefix: nothing stored -> the GCC8 default', Cproject.load(scratch).storedPrefix === 'riscv-none-embed-');
}

// --- tune/align stored as full CDT enums (other-chip projects) ---
const TUNE_PREFIX = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.tune.';
cp = Cproject.load(scratch);
cp.setOptionValue('target.tune', TUNE_PREFIX + 'default');
cp.save();
cp = Cproject.load(scratch);
let srcMk = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
check('tune enum default -> no -mtune at all', !srcMk.includes('-mtune='));

cp = Cproject.load(scratch);
cp.setOptionValue('target.tune', TUNE_PREFIX + 'rv32imac');
cp.save();
cp = Cproject.load(scratch);
generateMakefiles(cp, tcStub);
srcMk = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
check('tune enum rv32imac -> -mtune=rv32imac', srcMk.includes('-mtune=rv32imac'));

cp = Cproject.load(scratch);
cp.setOptionValue('target.align', 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.align.strict');
cp.save();
cp = Cproject.load(scratch);
generateMakefiles(cp, tcStub);
srcMk = fs.readFileSync(path.join(scratch, 'obj', 'src', 'subdir.mk'), 'utf-8');
check('align enum strict -> -mstrict-align', srcMk.includes('-mstrict-align'));

// --- Build Steps / Build Artifact (builder attrs + config attrs + makefile) ---
// kept last: it flips artifactType, which changes what the earlier makefile
// assertions below/above expect from the same scratch project
const { generateMakefiles: genMakefiles2 } = require('../out/core/makefile.js');
const tcStub2 = {
  name: 'GCC12', dir: '', compilerC: 'riscv-wch-elf-gcc', compilerCpp: 'riscv-wch-elf-g++',
  linkerC: 'riscv-wch-elf-gcc', linkerCpp: 'riscv-wch-elf-g++', debugger: 'riscv-wch-elf-gdb',
  objcopy: 'riscv-wch-elf-objcopy', objdump: 'riscv-wch-elf-objdump', size: 'riscv-wch-elf-size',
  prefix: 'riscv-wch-elf-',
};
cp = Cproject.load(scratch);
check('default artifact extension is elf', cp.artifactExtension === 'elf');
check('default prebuild is empty', cp.prebuildStep === '');
cp.setBuildIdentity({ prebuildStep: 'echo hello', prebuildAnnounce: 'pre note', postbuildStep: 'python post.py', artifactExtension: 'axf', outputPrefix: 'out_' });
cp.save();
const rawBuild = fs.readFileSync(path.join(scratch, '.cproject'), 'utf8');
check('announce property uses the CDT name preannouncebuildStep', rawBuild.includes('preannouncebuildStep="pre note"'));
check('outputPrefix lives on the linker tool, not the configuration', /<tool [^>]*tool\.c\.linker[^>]*outputPrefix="out_"/.test(rawBuild) && !/<configuration[^>]*outputPrefix=/.test(rawBuild));
cp = Cproject.load(scratch);
check('outputPrefix read back from the linker tool', cp.outputPrefix === 'out_');
check('prebuild survives reload', cp.prebuildStep === 'echo hello');
check('artifactExtension survives reload', cp.artifactExtension === 'axf');
genMakefiles2(cp, tcStub2);
let mk = fs.readFileSync(path.join(scratch, 'obj', 'makefile'), 'utf8');
check('makefile runs pre-build command', mk.includes('-echo hello'));
check('makefile runs post-build command', mk.includes('-python post.py'));
check('makefile honours output prefix + custom extension', mk.includes('out_LED.axf') && !mk.includes('LED.elf'));
cp.setBuildIdentity({ artifactType: 'staticLib' });
cp.save();
const rawLib = fs.readFileSync(path.join(scratch, '.cproject'), 'utf8');
check('buildArtefactType standalone attribute synced', /buildArtefactType="org\.eclipse\.cdt\.build\.core\.buildArtefactType\.staticLibrary"/.test(rawLib));
cp = Cproject.load(scratch);
check('artifactType staticLib survives reload', cp.artifactType === 'staticLib');
genMakefiles2(cp, tcStub2);
mk = fs.readFileSync(path.join(scratch, 'obj', 'makefile'), 'utf8');
check('makefile switches to static-lib rule', mk.includes('out_LED.a: $(OBJS)'));

// --- mixed content: text + element children (hand-written XML comment
// inside a text element) must keep its text across a rewrite ---
{
  const { parseXml, serializeXml } = require('../out/core/xml.js');
  const src = '<?xml version="1.0" encoding="UTF-8"?>\r\n<projectDescription>\r\n\t<name>My <!--note--> Proj</name>\r\n</projectDescription>';
  const out = serializeXml(parseXml(src));
  check('mixed content: text survives rewrite', out.includes('My') && out.includes('Proj') && out.includes('<!--note-->'));
  const nameEl = parseXml(out).findAll((e) => e.name === 'name')[0];
  check('mixed content: text intact after round trip', (nameEl.text || '').includes('My') && (nameEl.text || '').includes('Proj'));
  // plain CDT documents (text-only or children-only elements) stay byte-stable
  const plain = '<?xml version="1.0" encoding="UTF-8"?>\r\n<projectDescription>\r\n\t<name>LED</name>\r\n</projectDescription>';
  check('plain document unchanged', serializeXml(parseXml(plain)) === plain);
}

// --- .template byte-fidelity: unchanged lines stay BYTE-identical (spacing,
// value whitespace); a changed line keeps the original "key = value" style ---
{
  const { readTemplate, writeTemplate } = require('../out/core/templateFile.js');
  const tplDir = path.join(scratch, '..', 'roundtrip-tpl');
  fs.rmSync(tplDir, { recursive: true, force: true });
  fs.mkdirSync(tplDir, { recursive: true });
  const original = ['# header comment', '', 'Vendor = WCH', 'Address=0x00000000 ', 'MCU=CH582M', ''].join('\r\n');
  fs.writeFileSync(path.join(tplDir, '.template'), original, 'utf-8');
  const tpl = readTemplate(tplDir);
  check('template: values read with spacing variants', tpl.values['Vendor'] === 'WCH' && tpl.values['Address'] === '0x00000000');
  tpl.values['Address'] = '0x08000000';
  writeTemplate(tplDir, tpl);
  const after = fs.readFileSync(path.join(tplDir, '.template'), 'utf-8');
  const lines = after.split('\r\n');
  check('template: untouched line keeps "key = value" spacing byte-identical', lines.includes('Vendor = WCH'));
  check('template: comment and blank lines preserved', lines[0] === '# header comment' && lines[1] === '');
  check('template: changed line rewritten with its own spacing style', lines.includes('Address=0x08000000') && !lines.includes('Address=0x00000000 '));
  check('template: trailing whitespace of a CHANGED line not resurrected', !after.includes('0x00000000'));
  const reread = readTemplate(tplDir);
  check('template: changed value reads back', reread.values['Address'] === '0x08000000' && reread.values['Vendor'] === 'WCH');
  fs.rmSync(tplDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURES` : '\nall round-trip checks passed');
process.exit(failures ? 1 : 0);
