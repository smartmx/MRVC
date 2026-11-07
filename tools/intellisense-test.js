/*
 * IntelliSense config tests: stub vscode, point the workspace at a temp
 * folder with the real LED project loaded, and verify the generated
 * .vscode/compile_commands.json + c_cpp_properties.json (entry content,
 * user-config preservation, hash-gated no-op writes).
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const WS = path.join(__dirname, '..', '.scratch', 'intellisense-ws');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
// real LED tree: the dev-machine TEST copy, the F:/ layout, or the local
// E:/WORK EVT tree — first existing wins
const PROJ = ['F:/CH585/EVT/V1_2/EXAM/LED', 'E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find((p) => fs.existsSync(path.join(p, '.cproject')));

// the extension requires a CONFIGURED, valid installation before it does any
// work, so the stub models mrvc.mrs2InstallPath the way a real settings.json
// would (a global value `inspect` reports) — the first existing install wins
const MRS2_HOME = [process.env.MRS2_HOME, 'C:\\MounRiver\\MounRiver_Studio2', 'D:\\MounRiver\\MounRiver_Studio2'].find(
  (c) => c && fs.existsSync(path.join(c, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'manifest.json'))
);
const vscodeStub = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: WS }, name: 'ws', index: 0 }],
    getConfiguration: (section) => ({
      get: (k, d) =>
        section === 'mrvc' && k === 'intellisense.cachePath'
          ? cachePathSetting
          : section === 'mrvc' && k === 'intellisense.cacheSize'
            ? cacheSizeSetting
            : k === 'mrs2InstallPath' && MRS2_HOME
              ? MRS2_HOME
              : d,
      inspect: (k) => ({
        key: 'mrvc.' + k,
        globalValue: k === 'mrs2InstallPath' ? MRS2_HOME : undefined,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
      }),
      update: async () => {},
    }),
  },
  window: {},
  Uri: { file: (f) => ({ fsPath: f }) },
};
/** the mrvc.intellisense.cachePath / cacheSize settings the stub serves */
let cachePathSetting = '';
let cacheSizeSetting = 0;
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return orig.call(this, request, ...args);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// core-level checks run regardless of the real LED tree
const { Cproject } = require('../out/core/cproject.js');
const { scanSources } = require('../out/core/scan.js');
const { buildCompileEntries } = require('../out/core/intellisense.js');
const { cppCacheCandidates, defaultCppCachePath, isSafeCachePath, dirSizeBytes, clearCppIntelliSenseCache, classifyDeleteError } = require('../out/core/cppCache.js');

const { partitionByReference, contextDatabases, versionAtLeast } = require('../out/core/intellisense.js');
const { readProjectFile, addLinkedFolder, removeLinkedFolder } = require('../out/core/projectFile.js');

// pure classification checks (synthetic data, no project needed)
{
  const mk = (file, tag) => ({ directory: 'F:/x', file, arguments: [tag] });
  const s1 = [mk('F:/x/A.c', 'a1'), mk('F:/common/S.c', 'a1')];
  const s2 = [mk('F:/y/B.c', 'a2'), mk('F:/common/S.c', 'a2')];
  const s3 = [mk('F:/z/C.c', 'a3')];
  const ps = partitionByReference([s1, s2, s3]);
  check('partition: single-ref files -> shared class', ps.sharedEntries.length === 3 && ['F:/x/A.c', 'F:/y/B.c', 'F:/z/C.c'].every((f) => ps.sharedEntries.some((e) => e.file === f)));
  check('partition: multi-ref entries kept per project', ps.contextEntries.length === 3 && ps.contextEntries[0].length === 1 && ps.contextEntries[1].length === 1 && ps.contextEntries[2].length === 0);
  const dbs = contextDatabases(ps.contextEntries, ['F:/y/root2', 'F:/x/root1', 'F:/z/root3']);
  check('contextDatabases: referencing projects keep their own entries', dbs[0].length === 1 && dbs[1].length === 1);
  check('contextDatabases: non-referencing project gets canonical fallback (lowest root wins)', dbs[2].length === 1 && dbs[2][0].file === 'F:/common/S.c' && dbs[2][0].arguments[0] === 'a2');
}

const HAS_LED = !!PROJ;

if (HAS_LED) {
  const cp = Cproject.load(PROJ);
  const tc = {
    name: 'GCC8', dir: 'C:/tc', compilerC: 'C:/tc/bin/riscv-none-embed-gcc.exe', compilerCpp: 'C:/tc/bin/riscv-none-embed-g++.exe',
    linkerC: 'gcc', linkerCpp: 'g++', debugger: 'gdb', objcopy: 'o', objdump: 'o', size: 's', prefix: 'riscv-none-embed-',
  };
  const entries = buildCompileEntries(cp, tc);
  const srcCount = [...scanSources(cp).values()].reduce((n, v) => n + v.length, 0);
  check(`one entry per source (${entries.length}/${srcCount})`, entries.length === srcCount && srcCount > 0);
  const c1 = entries.find((e) => e.file.endsWith('.c'));
  check('entry carries the real project define', c1.arguments.includes('-DDEBUG=0'));
  check('entry carries resolved absolute -I paths', c1.arguments.some((a) => a.startsWith('-I') && /[A-Z]:[\\/]/.test(a)));
  check('entry keeps the C standard', c1.arguments.some((a) => a.startsWith('-std=')));
  check('compiler first, file last', c1.arguments[0] === path.resolve(tc.compilerC) && c1.arguments[c1.arguments.length - 1] === c1.file);
  check('no target/codegen flags leaked', !entries.some((e) => e.arguments.some((a) => /^(-m|-f|-O|-g|--specs|-MMD|-Wa)/.test(a))));
  const asm = entries.find((e) => /\.S$/i.test(e.file));
  check('assembly files use the assembler arg set', asm && asm.arguments.includes('assembler-with-cpp'));
  check('directory is the project root', c1.directory === path.resolve(PROJ));

  // vscode-level: write files into the temp workspace
  const { ensureIntellisenseConfig, dbDir, dbFileName, activeCcFile, sharedDbFile, switchContext, resolveProjectForFile } = require(path.join(__dirname, '..', 'out', 'vscode', 'intellisense.js'));
  const store = {
    all: [
      {
        root: PROJ,
        projectName: 'LED',
        cproject: cp,
        toolchain: () => tc,
      },
    ],
  };
  const r1 = ensureIntellisenseConfig(store);
  check('config generated without error', !r1.error && r1.updated === true);
  check('result counts sane', r1.projects === 1 && r1.entries === entries.length);
  const dbFile = path.join(dbDir(WS), dbFileName(PROJ, 'LED'));
  check('per-project database written (name+path hash)', fs.existsSync(dbFile));
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
  const sharedDb = JSON.parse(fs.readFileSync(sharedDbFile(WS), 'utf-8'));
  check('single project: no multi-referenced files -> empty context database', db.length === 0);
  check('single project: every source file lands in _shared (deterministic params)', sharedDb.length === entries.length);
  const cc = JSON.parse(fs.readFileSync(activeCcFile(WS), 'utf-8'));
  check('active slot seeded from the context database', Array.isArray(cc) && cc.length === db.length);
  const props = JSON.parse(fs.readFileSync(path.join(WS, '.vscode', 'c_cpp_properties.json'), 'utf-8'));
  const mine = props.configurations.find((c) => c.name === 'MRVC');
  check('c_cpp_properties has the MRVC configuration', !!mine);
  check('MRVC config compileCommands is the two-database array', Array.isArray(mine.compileCommands) && mine.compileCommands.length === 2 && mine.compileCommands[1].endsWith('_active.json'));
  check('MRVC config carries the toolchain compiler', mine.compilerPath === tc.compilerC);
  check('MRVC config has the wildcard browse fallback', Array.isArray(mine.includePath) && mine.includePath[0] === '${workspaceFolder}/**');
  check('browse fallback lists the project absolute include dirs', Array.isArray(mine.includePath) && mine.includePath.slice(1).some((p) => /[A-Za-z]:[\\/]/.test(p) && p.includes('SRC')));

  // hash gate: identical content must not rewrite
  const r2 = ensureIntellisenseConfig(store);
  check('hash gate: no-op when nothing changed', r2.updated === false);

  // user configs preserved: add a foreign configuration, regenerate
  props.configurations.push({ name: 'UserCustom', defines: ['KEEP_ME'] });
  fs.writeFileSync(path.join(WS, '.vscode', 'c_cpp_properties.json'), JSON.stringify(props, null, 2) + '\n', 'utf-8');
  cp.setOptionBool('warnings.allwarn', true, true); // config change -> new hash
  ensureIntellisenseConfig(store);
  const props2 = JSON.parse(fs.readFileSync(path.join(WS, '.vscode', 'c_cpp_properties.json'), 'utf-8'));
  check('user configuration preserved on regeneration', props2.configurations.some((c) => c.name === 'UserCustom' && c.defines.includes('KEEP_ME')));
  check('MRVC configuration still present', props2.configurations.some((c) => c.name === 'MRVC'));
  const cc2 = JSON.parse(fs.readFileSync(activeCcFile(WS), 'utf-8'));
  check('active slot regenerated after a config change', cc2.length === db.length);

  // ---- JSONC preservation: comments (incl. LINE-END ones, which the old
  // whole-file rewriter destroyed or choked on) must survive our update;
  // only the MRVC entry is spliced, everything else stays byte-for-byte ----
  {
    const propsFile = path.join(WS, '.vscode', 'c_cpp_properties.json');
    fs.writeFileSync(
      propsFile,
      [
        '{',
        '  // user header comment',
        '  "version": 4, /* version pinned */',
        '  "configurations": [',
        '    {',
        '      "name": "UserCustom", // line-end comment',
        '      "defines": ["KEEP_ME"]',
        '    }',
        '  ]',
        '}',
      ].join('\n'),
      'utf-8'
    );
    const rJ = ensureIntellisenseConfig(store);
    check('jsonc: update succeeds without error', !rJ.error);
    const after = fs.readFileSync(propsFile, 'utf-8');
    check('jsonc: header comment survives', after.includes('// user header comment'));
    check('jsonc: line-end comment survives', after.includes('"name": "UserCustom", // line-end comment'));
    check('jsonc: block comment survives', after.includes('/* version pinned */'));
    const parsedJ = JSON.parse(after.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    check('jsonc: MRVC entry added', parsedJ.configurations.some((c) => c.name === 'MRVC'));
    check('jsonc: user entry still parses next to it', parsedJ.configurations.some((c) => c.name === 'UserCustom' && c.defines.includes('KEEP_ME')));
    // a stale MRVC entry must be refreshed in place — surgically again
    fs.writeFileSync(propsFile, after.replace('"intelliSenseMode": "gcc-x64"', '"intelliSenseMode": "stale"'), 'utf-8');
    ensureIntellisenseConfig(store);
    const after3 = fs.readFileSync(propsFile, 'utf-8');
    check('jsonc: stale MRVC entry refreshed', !after3.includes('"stale"'));
    check('jsonc: comments survive the refresh', after3.includes('// user header comment') && after3.includes('// line-end comment'));
    check('jsonc: exactly one MRVC entry after two updates', (after3.match(/"name": "MRVC"/g) || []).length === 1);
  }

  // ---- JSONC preservation: TRAILING COMMA + insert — the raw file keeps
  // the user's comma; adding our separator after it would produce ", ,"
  // and an unparsable file that then trips the 'unreadable' sentinel ----
  {
    const propsFile = path.join(WS, '.vscode', 'c_cpp_properties.json');
    // JSONC-semantics view for plain JSON.parse: strip BOM, comments and
    // trailing commas — everything cpptools' JSONC reader accepts
    const stripComments = (t) =>
      t
        .replace(/^\uFEFF/, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,(\s*[}\]])/g, '$1');
    fs.writeFileSync(
      propsFile,
      [
        '{',
        '  "version": 4,',
        '  "configurations": [',
        '    { "name": "UserCustom", "defines": ["KEEP_ME"] }, // trailing comma',
        '  ]',
        '}',
      ].join('\n'),
      'utf-8'
    );
    const rT = ensureIntellisenseConfig(store);
    check('jsonc trailing comma: update succeeds', !rT.error);
    const afterT = fs.readFileSync(propsFile, 'utf-8');
    let parsedT;
    try { parsedT = JSON.parse(stripComments(afterT)); } catch { parsedT = undefined; }
    check('jsonc trailing comma: result still parses (no ", ,")', parsedT !== undefined);
    check('jsonc trailing comma: MRVC entry added', parsedT?.configurations?.some((c) => c.name === 'MRVC'));
    check('jsonc trailing comma: user entry + comment survive', parsedT?.configurations?.some((c) => c.name === 'UserCustom') && afterT.includes('// trailing comma'));
    // root-level trailing comma with NO configurations property
    fs.writeFileSync(propsFile, '{\n  "env": { "X": "1" }, // env for cpptools\n}', 'utf-8');
    const rT2 = ensureIntellisenseConfig(store);
    check('jsonc root trailing comma: update succeeds', !rT2.error);
    const afterT2 = fs.readFileSync(propsFile, 'utf-8');
    let parsedT2;
    try { parsedT2 = JSON.parse(stripComments(afterT2)); } catch { parsedT2 = undefined; }
    check('jsonc root trailing comma: result still parses', parsedT2 !== undefined);
    check('jsonc root trailing comma: configurations created with MRVC', parsedT2?.configurations?.some((c) => c.name === 'MRVC'));
    check('jsonc root trailing comma: user env + comment survive', parsedT2?.env?.X === '1' && afterT2.includes('// env for cpptools'));
    // REPLACE path with an array-level trailing comma + line-end comment
    // behind the MRVC entry: the blanked comma must terminate the element's
    // span, or the splice wipes the raw comma AND the comment with it
    fs.writeFileSync(
      propsFile,
      [
        '{',
        '  "configurations": [',
        '    { "name": "MRVC", "compileCommands": ["OLD"], "cppCompilerPath": "residue" }, // keep me',
        '  ]',
        '}',
      ].join('\n'),
      'utf-8'
    );
    const rT3 = ensureIntellisenseConfig(store);
    check('jsonc trailing comma replace: update succeeds', !rT3.error);
    const afterT3 = fs.readFileSync(propsFile, 'utf-8');
    let parsedT3;
    try { parsedT3 = JSON.parse(stripComments(afterT3)); } catch { parsedT3 = undefined; }
    check('jsonc trailing comma replace: result parses', parsedT3 !== undefined);
    check('jsonc trailing comma replace: entry refreshed', parsedT3?.configurations?.[0]?.compileCommands?.[0] !== 'OLD');
    check('jsonc trailing comma replace: residue key removed', parsedT3?.configurations?.[0]?.cppCompilerPath === undefined);
    check('jsonc trailing comma replace: line-end comment survives', afterT3.includes('// keep me'));
  }

  // ---- NESTED trailing commas must NOT act as the container's separator:
  // the first fix keyed on "any comma inside the range" and broke exactly
  // these files (a comma inside an element object is that object's own
  // trailing comma — the array still needs ours between its entries) ----
  {
    const propsFile = path.join(WS, '.vscode', 'c_cpp_properties.json');
    // JSONC validator: BOM- and trailing-comma-aware (the element's own
    // trailing comma legitimately SURVIVES in the output — it is the
    // array-level comma whose suppression/insertion matters)
    const stripJsonc = (t) =>
      t
        .replace(/^\uFEFF/, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,(\s*[}\]])/g, '$1');
    const attempt = (name, content) => {
      fs.writeFileSync(propsFile, content, 'utf-8');
      const r = ensureIntellisenseConfig(store);
      const after = fs.readFileSync(propsFile, 'utf-8');
      let parsed;
      try { parsed = JSON.parse(stripJsonc(after)); } catch { parsed = undefined; }
      check(`${name}: update succeeds`, !r.error && r !== 'unreadable');
      check(`${name}: result still parses`, parsed !== undefined);
      check(`${name}: MRVC entry added`, !!parsed?.configurations?.some((c) => c.name === 'MRVC'));
    };
    // trailing comma INSIDE the element object; the array itself has none
    attempt(
      'nested trailing comma (element object)',
      ['{', '  "version": 4,', '  "configurations": [', '    {', '      "name": "UserCustom",', '      "compilerPath": "C:/tc/bin/gcc.exe",', '    }', '  ]', '}'].join('\n')
    );
    // root-append path: nested comma inside an env object, root has a property
    attempt('nested trailing comma (root append)', ['{', '  "env": {', '    "X": "1",', '  }', '}'].join('\n'));
  }

  // ---- EMPTY root object with JSONC features: BOM/comments force the
  // surgical path where an empty object must not receive a leading comma
  // (`{,` — parse failure + permanent 'unreadable' sentinel) ----
  {
    const propsFile = path.join(WS, '.vscode', 'c_cpp_properties.json');
    const stripJsonc = (t) =>
      t
        .replace(/^\uFEFF/, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,(\s*[}\]])/g, '$1');
    const attempt = (name, content) => {
      fs.writeFileSync(propsFile, content, 'utf-8');
      const r = ensureIntellisenseConfig(store);
      const after = fs.readFileSync(propsFile, 'utf-8');
      let parsed;
      try { parsed = JSON.parse(stripJsonc(after)); } catch { parsed = undefined; }
      check(`${name}: update succeeds`, !r.error && r !== 'unreadable');
      check(`${name}: result still parses`, parsed !== undefined);
      check(`${name}: configurations created with MRVC`, !!parsed?.configurations?.some((c) => c.name === 'MRVC'));
    };
    attempt('comment-only empty root', '{ /* add configurations here */ }');
    attempt('BOM-prefixed empty root', '﻿{}');
    attempt('BOM + comment empty root', '﻿{ /* none yet */ }');
  }

  // ---- multi-root: every workspace folder gets its own c_cpp_properties;
  // secondary folders point at the PRIMARY folder's databases absolutely ----
  {
    const WS2 = path.join(__dirname, '..', '.scratch', 'intellisense-ws2');
    fs.rmSync(WS2, { recursive: true, force: true });
    vscodeStub.workspace.workspaceFolders.push({ uri: { fsPath: WS2 }, name: 'ws2', index: 1 });
    ensureIntellisenseConfig(store);
    const p2 = JSON.parse(fs.readFileSync(path.join(WS2, '.vscode', 'c_cpp_properties.json'), 'utf-8'));
    const mine2 = p2.configurations.find((c) => c.name === 'MRVC');
    check('multi-root: secondary folder configured', !!mine2);
    check(
      'multi-root: secondary entry uses absolute paths into the primary cc dir',
      Array.isArray(mine2.compileCommands) && mine2.compileCommands.length === 2 && mine2.compileCommands.every((c) => /[A-Za-z]:[\\/]/.test(c) && c.includes(path.join(WS, '.vscode', 'mrvc', 'cc')))
    );
    vscodeStub.workspace.workspaceFolders.pop();
    fs.rmSync(WS2, { recursive: true, force: true });
  }

  // ---- dangling include paths (EVT templates ship superset include lists:
  // e.g. BackupUpgrade_IAP references HAL/LIB/Profile it never links) used
  // to reach the compile args AND the includePath browse fallback — cpptools
  // validates includePath and reported one "Cannot find" per dangling path
  // (same criterion as the makefile pipeline's dropMissing) ----
  {
    const propsFile = path.join(WS, '.vscode', 'c_cpp_properties.json');
    // plain-JSON fixture (the BOM scenarios above left a BOM+comment file)
    fs.writeFileSync(propsFile, '{}', 'utf-8');
    const origInc = cp.listOption('c.compiler.include.paths').values.slice();
    cp.addToListOption('c.compiler.include.paths', 'Z:/mrvc-dangling/absent');
    cp.addToListOption('c.compiler.include.paths', '${workspace_loc:/${ProjName}/ghost_dir}');
    const rD = ensureIntellisenseConfig(store);
    check('dangling includes: regeneration succeeds', !rD.error);
    const sharedD = JSON.parse(fs.readFileSync(sharedDbFile(WS), 'utf-8'));
    const activeD = JSON.parse(fs.readFileSync(activeCcFile(WS), 'utf-8'));
    const argsD = [...sharedD, ...activeD].map((e) => e.arguments.join(' ')).join(' ');
    check('dangling absolute include dropped from compile args', !argsD.includes('mrvc-dangling'));
    check('dangling workspace_loc include dropped from compile args', !argsD.includes('ghost_dir'));
    const propsD = JSON.parse(fs.readFileSync(propsFile, 'utf-8'));
    const mineD = propsD.configurations.find((c) => c.name === 'MRVC');
    check('dangling includes absent from includePath fallback', !(mineD.includePath || []).some((p) => p.includes('mrvc-dangling') || p.includes('ghost_dir')));
    check('real includes still listed in includePath fallback', (mineD.includePath || []).some((p) => /[A-Za-z]:[\\/]/.test(p) && p.includes('SRC')));
    // restore in-memory state so later sections see the untouched project
    cp.setOptionList('c.compiler.include.paths', origInc);
    ensureIntellisenseConfig(store);
  }

  // ---- cppCompilerPath is not a property in cpptools' c_cpp_properties
  // schema ("Property cppCompilerPath is not allowed") ----
  {
    const propsFile = path.join(WS, '.vscode', 'c_cpp_properties.json');
    // an entry written by an older version carries the retired key — the
    // merge must retire it instead of preserving it forever
    const stale = JSON.parse(fs.readFileSync(propsFile, 'utf-8'));
    stale.configurations.find((c) => c.name === 'MRVC').cppCompilerPath = 'C:/tc/bin/old-g++.exe';
    fs.writeFileSync(propsFile, JSON.stringify(stale, null, 2) + '\n', 'utf-8');
    ensureIntellisenseConfig(store);
    const propsP = JSON.parse(fs.readFileSync(propsFile, 'utf-8'));
    const mineP = propsP.configurations.find((c) => c.name === 'MRVC');
    check('cppCompilerPath not written (cpptools schema rejects it)', mineP.cppCompilerPath === undefined);
    check('retired key removed from a pre-existing entry (merge cleanup)', !('cppCompilerPath' in mineP));
    check('compilerPath still present', typeof mineP.compilerPath === 'string' && mineP.compilerPath.length > 0);
  }

  // stale _active.json whose file set no longer matches the context class
  // (older MRVC layouts wrote private/shared compositions) must be re-seeded
  {
    fs.writeFileSync(activeCcFile(WS), JSON.stringify([...db, ...sharedDb], null, 2), 'utf-8');
    ensureIntellisenseConfig(store);
    const reseeded = JSON.parse(fs.readFileSync(activeCcFile(WS), 'utf-8'));
    check('stale merged _active re-seeded to the context-class shape', reseeded.length === db.length);
  }

  // ---- context switching (tree selection model) ----
  // build a second project with a DIFFERENT define referencing the SAME
  // linked folders (repoint the copied links at LED's real targets) so the
  // linked files become multi-referenced and each root stays single-ref
  const proj2 = path.join(WS, 'proj2');
  fs.cpSync(PROJ, proj2, { recursive: true });
  for (const l of readProjectFile(proj2).linkedResources) {
    const target = cp.linkedFolders.get(l.name);
    if (!target) continue;
    removeLinkedFolder(proj2, l.name);
    addLinkedFolder(proj2, l.name, target);
  }
  const cp2 = Cproject.load(proj2);
  cp2.addToListOption('c.compiler.defs', 'PROJ2=1');
  cp2.save();
  const store2 = {
    all: [
      { root: PROJ, projectName: 'LED', cproject: cp, toolchain: () => tc },
      { root: proj2, projectName: 'proj2', cproject: cp2, toolchain: () => tc },
    ],
  };
  ensureIntellisenseConfig(store2);
  const dbA = path.join(dbDir(WS), dbFileName(PROJ, 'LED'));
  const dbB = path.join(dbDir(WS), dbFileName(proj2, 'proj2'));
  check('switch: two databases written', fs.existsSync(dbA) && fs.existsSync(dbB) && dbA !== dbB);
  const entriesA = JSON.parse(fs.readFileSync(dbA, 'utf-8'));
  const entriesB = JSON.parse(fs.readFileSync(dbB, 'utf-8'));
  const shared2 = JSON.parse(fs.readFileSync(sharedDbFile(WS), 'utf-8'));
  check('multi-ref: linked files classified context, not shared', entriesA.length > 0 && entriesA.every((e) => !e.file.startsWith(path.resolve(PROJ))) && shared2.every((e) => e.file.startsWith(path.resolve(PROJ)) || e.file.startsWith(path.resolve(proj2))));
  check('multi-ref: both databases cover the same context file set', entriesA.length === entriesB.length && entriesA.every((e, i) => e.file === entriesB[i].file));
  check('multi-ref: each database keeps its own define', entriesB.some((e) => e.arguments.includes('-DPROJ2=1')) && entriesA.some((e) => !e.arguments.includes('-DPROJ2=1')));
  check('multi-ref: single-ref root files of both projects in _shared', shared2.some((e) => e.file.startsWith(path.resolve(PROJ))) && shared2.some((e) => e.file.startsWith(path.resolve(proj2))));
  const sharedBefore = fs.readFileSync(sharedDbFile(WS), 'utf-8');
  const switched = switchContext(WS, proj2, 'proj2');
  check('switch: context file rewritten', switched === true);
  const after = JSON.parse(fs.readFileSync(activeCcFile(WS), 'utf-8'));
  check('switch: active cc now carries PROJ2 define', after.some((e) => e.arguments.includes('-DPROJ2=1')));
  check('switch: shared block unchanged by switching', fs.readFileSync(sharedDbFile(WS), 'utf-8') === sharedBefore);
  check('switch: re-selecting the same project is a no-op', switchContext(WS, proj2, 'proj2') === false);
  switchContext(WS, PROJ, 'LED');
  const back = JSON.parse(fs.readFileSync(activeCcFile(WS), 'utf-8'));
  check('switch: first project context is pure (no PROJ2)', back.every((e) => !e.arguments.includes('-DPROJ2=1')));
  check('switch: unknown project refused', switchContext(WS, 'Z:/no/where', 'ghost') === false);

  // ---- fallback coverage: a project that references NONE of the context
  // files still gets canonical fallback entries, so _active.json never
  // misses a multi-referenced file under any context ----
  const proj3 = path.join(WS, 'proj3');
  fs.cpSync(PROJ, proj3, { recursive: true });
  for (const l of readProjectFile(proj3).linkedResources) {
    removeLinkedFolder(proj3, l.name);
  }
  const cp3 = Cproject.load(proj3);
  const store3 = {
    all: [
      { root: PROJ, projectName: 'LED', cproject: cp, toolchain: () => tc },
      { root: proj2, projectName: 'proj2', cproject: cp2, toolchain: () => tc },
      { root: proj3, projectName: 'proj3', cproject: cp3, toolchain: () => tc },
    ],
  };
  ensureIntellisenseConfig(store3);
  const dbC = JSON.parse(fs.readFileSync(path.join(dbDir(WS), dbFileName(proj3, 'proj3')), 'utf-8'));
  check('fallback: non-referencing project covers the whole context class', dbC.length === entriesA.length && dbC.every((e, i) => e.file === entriesA[i].file));
  check('fallback: entries from the canonical owner (no PROJ2 define)', dbC.every((e) => !e.arguments.includes('-DPROJ2=1')));
  const allFiles = new Set(store3.all.flatMap((p) => buildCompileEntries(p.cproject, tc).map((e) => e.file)));
  const coveredFiles = new Set([...JSON.parse(fs.readFileSync(sharedDbFile(WS), 'utf-8')).map((e) => e.file), ...dbC.map((e) => e.file)]);
  check('coverage: _shared + one database cover every source file', allFiles.size > 0 && [...allFiles].every((f) => coveredFiles.has(f)));

  // ---- failed toolchain: the project's database must not stay stale ----
  // (the old path skipped the project entirely, leaving its previous
  // database on disk forever — switchContext copies that stale file on
  // every selection and nothing ever regenerates it)
  {
    const ccDir = dbDir(WS);
    const dbFailed = path.join(ccDir, dbFileName(proj3, 'proj3'));
    if (!dbFailed.startsWith(ccDir + path.sep)) throw new Error('containment');
    fs.writeFileSync(dbFailed, '[{"file":"Z:/stale/leftover.c","arguments":["stale"]}]', 'utf-8');
    const storeFail = {
      all: [
        { root: PROJ, projectName: 'LED', cproject: cp, toolchain: () => tc },
        { root: proj2, projectName: 'proj2', cproject: cp2, toolchain: () => tc },
        { root: proj3, projectName: 'proj3', cproject: cp3, toolchain: () => null },
      ],
    };
    ensureIntellisenseConfig(storeFail);
    const dbF = JSON.parse(fs.readFileSync(dbFailed, 'utf-8'));
    check('failed toolchain: stale database rewritten, not left behind', Array.isArray(dbF) && dbF.length === entriesA.length);
    check('failed toolchain: content is the full canonical fallback', dbF.length > 0 && dbF.every((e, i) => e.file === entriesA[i].file));
    const storeAllFail = {
      all: [{ root: PROJ, projectName: 'LED', cproject: cp, toolchain: () => null }],
    };
    const rFail = ensureIntellisenseConfig(storeAllFail);
    check('failed toolchain: all-projects-failed does not crash', !rFail.error);
    check('failed toolchain: all-failed rewrites an (empty) database', JSON.parse(fs.readFileSync(dbFile, 'utf-8')).length === 0);
  }

  // ---- file -> project ownership (editor-open switching) ----
  const owners = store2.all.map((p) => ({
    root: p.root,
    projectName: p.projectName,
    isOwner: (fsPath) => {
      try {
        return !!p.cproject && !!p.logicPathOf ? !!p.logicPathOf(fsPath) : false;
      } catch {
        return false;
      }
    },
  }));
  // store2's stub projects lack logicPathOf — build real ones from Cproject
  // ownership mirrors MrsProject.logicPathOf: file under the project root
  // or under one of its linked folders resolves; everything else does not
  const pathOwner = (root, linkedDirs) => (fsPath) => {
    const norm = path.resolve(fsPath);
    if (norm.startsWith(path.resolve(root) + path.sep)) return true;
    return (linkedDirs || []).some((d) => norm.startsWith(path.resolve(d) + path.sep));
  };
  const realOwners = [
    { root: PROJ, projectName: 'LED', isOwner: pathOwner(PROJ, [path.join(path.dirname(PROJ), 'SRC')]) },
    { root: proj2, projectName: 'proj2', isOwner: (f) => f.startsWith(path.resolve(proj2) + path.sep) },
  ];
  const own = (f) => resolveProjectForFile(realOwners.map((x) => ({ root: x.root, projectName: x.projectName, isOwner: x.isOwner })), f);
  const inside = path.join(PROJ, 'src', 'Main.c');
  const owner1 = own(inside);
  check('ownership: file inside project root resolved', !!owner1 && owner1.projectName === 'LED');
  const sharedSrc = path.join(path.dirname(PROJ), 'SRC', 'Startup', 'startup_CH585.S');
  const outside = own('Z:/elsewhere/foo.c');
  check('ownership: unrelated file unresolved', outside === undefined);
  void sharedSrc;
} else {
  console.log('SKIP  intellisense (LED project not present)');
}

// ---- cpptools guidance gate: numeric semver compare (1.9.0 sorts ABOVE
// 1.23.5 as a string). Pure function, no fixtures — unconditional, outside
// the HAS_LED block (the guidance must be verified on every machine).
{
  check('versionAtLeast: 1.24.5 >= 1.23.5', versionAtLeast('1.24.5', [1, 23, 5]));
  check('versionAtLeast: numeric compare (1.9.0 < 1.23.5)', !versionAtLeast('1.9.0', [1, 23, 5]));
  check('versionAtLeast: equal passes', versionAtLeast('1.23.5', [1, 23, 5]));
  check('versionAtLeast: missing patch tolerated', versionAtLeast('1.24', [1, 23, 5]));
  check('versionAtLeast: older rejected', !versionAtLeast('1.22.9', [1, 23, 5]));
}

// ---- cppCache: cpptools ipch cache resolution, guards and clearing ----
{
  const CSC = path.join(WS, 'cppcache');
  const inside = (rel) => {
    const r = path.resolve(CSC, rel);
    if (r !== path.resolve(CSC) && !r.startsWith(path.resolve(CSC) + path.sep)) throw new Error('outside scratch');
    return r;
  };

  // 1. candidate resolution: configured first (ADAPTIVE — cpptools reads the
  //    setting value as the cache ROOT and appends ipch), default second
  {
    const winDefault = defaultCppCachePath('win32');
    const darwinDefault = defaultCppCachePath('darwin');
    check('cache: darwin default under ~/Library/Caches/vscode-cpptools/ipch', darwinDefault.replace(/\\/g, '/').includes('/Library/Caches/vscode-cpptools/ipch'));
    const savedXdg = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = '/xdg-custom';
    const xdgDefault = defaultCppCachePath('linux');
    if (savedXdg === undefined) delete process.env['XDG_CACHE_HOME'];
    else process.env['XDG_CACHE_HOME'] = savedXdg;
    check('cache: linux honors XDG_CACHE_HOME', xdgDefault.replace(/\\/g, '/').startsWith('/xdg-custom/vscode-cpptools/ipch'));
    const one = cppCacheCandidates(undefined, 'win32');
    check('cache: no configured value -> only the default', one.length === 1 && one[0].source === 'default' && one[0].requireCacheShape === true);
    // parent reading: configured value holds a child ipch -> the CHILD is the cache
    fs.mkdirSync(inside('myown/ipch'), { recursive: true });
    fs.writeFileSync(inside('myown/ipch/a.ipch'), 'x');
    const parent = cppCacheCandidates(inside('myown'), 'win32');
    check('cache: configured parent resolves to its ipch child (cpptools root semantics)', parent.length === 2 && parent[0].path === inside('myown/ipch') && parent[0].requireCacheShape === false);
    // direct reading: the configured value itself holds PCH files — flat AND
    // the real hashed layout (ipch/<hash>/<name>.ipch, round22 §5.4)
    fs.mkdirSync(inside('direct'), { recursive: true });
    fs.writeFileSync(inside('direct/b.ipch'), 'y');
    const direct = cppCacheCandidates(inside('direct'), 'win32');
    check('cache: a configured dir that itself holds .ipch files is offered directly', direct.length === 2 && direct[0].path === inside('direct'));
    fs.mkdirSync(inside('hashed/ipch/0123456789abcdef'), { recursive: true });
    fs.writeFileSync(inside('hashed/ipch/0123456789abcdef/abc.ipch'), 'z');
    const hashed = cppCacheCandidates(inside('hashed/ipch'), 'win32');
    check('cache: the real hashed layout (ipch/<hash>/x.ipch) is recognized', hashed.length === 2 && hashed[0].path === inside('hashed/ipch'));
    // P1 probe A: an ipch-named dir WITHOUT any .ipch content is never offered
    fs.mkdirSync(inside('cache-root/ipch'), { recursive: true });
    fs.writeFileSync(inside('cache-root/ipch/important-user-notes.txt'), 'keep me');
    const emptyish = cppCacheCandidates(inside('cache-root'), 'win32');
    check('cache: an ipch-named dir WITHOUT PCH content is not offered', emptyish.every((c) => c.path !== inside('cache-root/ipch')));
    // a typo'd configured path (exists, but no cache content) is NEVER offered
    fs.mkdirSync(inside('not-a-cache'), { recursive: true });
    check('cache: a configured path without cache content is not offered', cppCacheCandidates(inside('not-a-cache'), 'win32').every((c) => c.source === 'default'));
    // round29 §3.1/§3.4: a hand-edited MALFORMED configured value (get<T> is
    // compile-time only — a number, boolean, object, array or null can sit in
    // settings.json) must not throw inside the resolver and must degrade to
    // the default path alone; the vscode layer warns, the core just drops it
    const malformed = [42, true, { p: 'x' }, ['x'], null];
    check('cache: malformed (non-string) configured values are dropped, not crashed on',
      malformed.every((v) => {
        const c = cppCacheCandidates(v, 'win32');
        return c.length === 1 && c[0].source === 'default';
      }));
    check('cache: a whitespace-only configured value is treated as unset', (() => {
      const c = cppCacheCandidates('   ', 'win32');
      return c.length === 1 && c[0].source === 'default';
    })());
    const dup = cppCacheCandidates(winDefault.replace(/ipch$/, ''), 'win32');
    check('cache: the doc-default parent dedupes into the real ipch dir', dup.length === 1 && dup[0].path === winDefault);
  }

  // 2. the safety guard: only recognizable cpptools caches, no collisions
  {
    check('guard: an ipch-basename path passes', isSafeCachePath(inside('ipch'), []));
    check('guard: a path under vscode-cpptools passes', isSafeCachePath(inside('vscode-cpptools/ipch-2'), []));
    check('guard: a non-cache path is refused', !isSafeCachePath(inside('my-project'), []));
    check('guard: a filesystem root is refused', !isSafeCachePath('F:\\', []));
    const home = require('os').homedir();
    check('guard: the home directory itself is refused', !isSafeCachePath(home, []));
    // P1 probe B (round23 §5.6 isolation): an ANCESTOR of the home directory
    // must be refused — deleting it would take the home with it. Verified
    // against an ISOLATED fake home (monkey-patched os.homedir), never the
    // real user profile.
    const osMod = require('os');
    const fakeHomeRoot = inside('fake-home-root');
    const fakeHome = inside('fake-home-root/Users/owner');
    fs.mkdirSync(fakeHome, { recursive: true });
    const origHomedir = osMod.homedir;
    osMod.homedir = () => fakeHome;
    try {
      check('guard: the (fake) home directory itself is refused', !isSafeCachePath(fakeHome, [], false));
      check('guard: a home ANCESTOR is refused (would destroy the home)', !isSafeCachePath(fakeHomeRoot, [], false));
      // the ancestor holds a stray .ipch — content does not buy it an exception
      fs.writeFileSync(inside('fake-home-root/stray.ipch'), 'x');
      check('guard: a home ancestor with a stray .ipch is still refused', !isSafeCachePath(fakeHomeRoot, [], false));
      // end-to-end: clearCppIntelliSenseCache refuses and leaves everything
      const rAnc = clearCppIntelliSenseCache([{ path: fakeHomeRoot, source: 'configured', requireCacheShape: false }], []);
      check('guard: the clear call refuses a home ancestor and deletes nothing', rAnc.failed.length === 1 && fs.existsSync(fakeHome) && fs.existsSync(fakeHomeRoot));
    } finally {
      osMod.homedir = origHomedir;
    }
    const wsRoot = inside('workspace');
    check('guard: deleting a dir EQUAL to a workspace folder is refused', !isSafeCachePath(wsRoot, [wsRoot]));
    fs.mkdirSync(inside('workspace/.vscode/ipch'), { recursive: true });
    check('guard: a cache configured INSIDE a workspace folder is refused', !isSafeCachePath(inside('workspace/.vscode/ipch'), [wsRoot]));
    check('guard: the default cache UNDER the home dir passes (home only blocks itself and ancestors)', isSafeCachePath(defaultCppCachePath('linux'), []));
    // P4 §5.7: case folding is Windows-only — POSIX spellings that differ in
    // case are DISTINCT directories (shape precondition off: this tests the
    // collision logic, not the cache-shape allowlist)
    const posixLower = isSafeCachePath('/home/x/ws', ['/home/X/ws'], false, 'linux');
    const posixSelf = !isSafeCachePath('/home/x/ws', ['/home/x/ws'], false, 'linux');
    check('guard: POSIX fold — case-differing forbidden dir does not collide', posixLower);
    check('guard: POSIX fold — exact forbidden dir still collides', posixSelf);
  }

  // 3. dirSizeBytes + real clearing (incl. a locked file -> partial failure)
  {
    const ipch = inside('ipch');
    fs.mkdirSync(inside('ipch/a/b'), { recursive: true });
    fs.writeFileSync(inside('ipch/a/x.pch'), 'x'.repeat(1024));
    fs.writeFileSync(inside('ipch/a/b/y.pch'), 'y'.repeat(2048));
    check('cache: dirSizeBytes sums the whole subtree', dirSizeBytes(ipch) === 3072);
    const r = clearCppIntelliSenseCache([{ path: ipch, source: 'default', requireCacheShape: true }, { path: inside('nope'), source: 'default', requireCacheShape: true }], []);
    check('cache: clearing removes the tree, reports bytes, skips nonexistent', r.cleared.length === 1 && r.cleared[0].bytes === 3072 && r.failed.length === 0 && !fs.existsSync(ipch));
    // a content-verified CONFIGURED candidate skips the shape precondition
    // (its folder may be named anything — the explicit setting is the intent)
    fs.mkdirSync(inside('myown-cleared'), { recursive: true });
    fs.writeFileSync(inside('myown-cleared/c.ipch'), 'z');
    const rOwn = clearCppIntelliSenseCache([{ path: inside('myown-cleared'), source: 'configured', requireCacheShape: false }], []);
    check('cache: a configured non-ipch-named dir clears (content-verified intent)', rOwn.cleared.length === 1 && !fs.existsSync(inside('myown-cleared')));
    // a locked file: platforms differ (Windows/libuv ignores the read-only
    // attribute, POSIX honours it) — either way the SIBLING must still clear
    const locked = inside('vscode-cpptools/ipch-locked');
    const keep = inside('vscode-cpptools/ipch-locked/keep.pch');
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.writeFileSync(keep, 'z');
    fs.chmodSync(keep, 0o444);
    const other = inside('vscode-cpptools/ipch-other');
    fs.mkdirSync(other, { recursive: true });
    const r2 = clearCppIntelliSenseCache([{ path: locked, source: 'default', requireCacheShape: true }, { path: other, source: 'default', requireCacheShape: true }], []);
    // whether the read-only variant fails at all is platform-dependent
    // (Windows/libuv removes read-only files; round30 §4.2 dropped EPERM
    // from the 'locked' class, so its kind is not asserted here either)
    check(
      'cache: a locked path degrades gracefully, the sibling still clears',
      !fs.existsSync(other) && r2.cleared.some((c) => c.path === other) &&
        (r2.failed.length === 0 || r2.failed.every((f) => f.path === locked))
    );
    // round30 §4.2: the delete-failure classifier — ONLY a sharing violation
    // (EBUSY) is 'locked' (the reload-worthy case); EPERM is ambiguous on
    // Windows (ACL/attribute denial — and cpptools' real lock shape, a
    // memory-mapped PCH, deletes with EPERM too) and a plain permission
    // error on POSIX, so it stays 'error' with its reason shown. Kept a
    // pure mapping: modern libuv deletes open-fd files fine (POSIX-delete
    // semantics), so no OS lock simulation is reliable enough to assert on.
    check('cache: classifyDeleteError — EBUSY is locked', classifyDeleteError('EBUSY') === 'locked');
    check('cache: classifyDeleteError — EPERM is a plain error', classifyDeleteError('EPERM') === 'error');
    check('cache: classifyDeleteError — EACCES/unknown are plain errors', classifyDeleteError('EACCES') === 'error' && classifyDeleteError(undefined) === 'error');
    try {
      fs.chmodSync(keep, 0o666);
    } catch {
      // already gone on filesystems that ignore the read-only flag
    }
    check('cache: a guard-refused path lands in failed without deletion', (() => {
      const wsRoot = inside('workspace2');
      const cacheInWs = inside('workspace2/.vscode/ipch');
      fs.mkdirSync(cacheInWs, { recursive: true });
      const r3 = clearCppIntelliSenseCache([{ path: cacheInWs, source: 'configured', requireCacheShape: false }], [wsRoot]);
      // even with the shape precondition relaxed (configured intent), the
      // workspace collision still refuses — and nothing is deleted
      return r3.failed.length === 1 && r3.failed[0].error.includes('safety guard') && r3.failed[0].kind === 'guard' && fs.existsSync(cacheInWs);
    })());
    // round29 §3.2/§3.4: the TOCTOU re-verification (round23 §5.2) reports a
    // relaxed-shape candidate that lost its PCH content between resolution
    // and deletion as kind 'content' — and leaves the directory untouched
    fs.mkdirSync(inside('toctou-gone'), { recursive: true });
    fs.writeFileSync(inside('toctou-gone/notes.txt'), 'no pch here');
    const rT = clearCppIntelliSenseCache([{ path: inside('toctou-gone'), source: 'configured', requireCacheShape: false }], []);
    check('cache: a TOCTOU content-miss is reported as kind content, dir untouched',
      rT.failed.length === 1 && rT.failed[0].kind === 'content' && fs.existsSync(inside('toctou-gone')));
  }

  fs.rmSync(CSC, { recursive: true, force: true });
}

// ---- workspace cache-path override: MRVC writes C_Cpp.intelliSenseCachePath
// into .vscode/settings.json when mrvc.intellisense.cachePath is configured
if (HAS_LED) {
  const { ensureIntellisenseConfig } = require('../out/vscode/intellisense.js');
  const cp2 = Cproject.load(PROJ);
  const tc2 = {
    name: 'GCC8', dir: 'C:/tc', compilerC: 'C:/tc/bin/riscv-none-embed-gcc.exe', compilerCpp: 'C:/tc/bin/riscv-none-embed-g++.exe',
    linkerC: 'gcc', linkerCpp: 'g++', debugger: 'gdb', objcopy: 'o', objdump: 'o', size: 's', prefix: 'riscv-none-embed-',
  };
  const store2 = { all: [{ root: PROJ, projectName: 'LED', cproject: cp2, toolchain: () => tc2 }] };
  const settingsFile = path.join(WS, '.vscode', 'settings.json');
  const read = () => { try { return fs.readFileSync(settingsFile, 'utf-8'); } catch { return null; } };

  // 1. DEFAULTS (path empty, size 5120 = the schema default): a fresh
  //    workspace gets the size cap written explicitly, and no path key
  cachePathSetting = '';
  cacheSizeSetting = 5120;
  ensureIntellisenseConfig(store2);
  const s0 = read();
  check(
    'cacheSize default: fresh settings.json pins the 5120 cap (no path key)',
    s0 !== null && parseJsoncSafe(s0)['C_Cpp.intelliSenseCacheSize'] === 5120 && !('C_Cpp.intelliSenseCachePath' in parseJsoncSafe(s0))
  );

  // 2. path ON: both keys land, and a second run is a no-op
  cachePathSetting = 'F:/mrvc-cache/ipch';
  ensureIntellisenseConfig(store2);
  const s1 = read();
  check('cachePath override: settings.json created with the key', s1 !== null && JSON.parse(s1)['C_Cpp.intelliSenseCachePath'] === 'F:/mrvc-cache/ipch');
  check('cacheSize override: the 5120 cap rides along', JSON.parse(s1)['C_Cpp.intelliSenseCacheSize'] === 5120);
  ensureIntellisenseConfig(store2);
  check('cachePath override: unchanged content is not rewritten (idempotent)', read() === s1);

  // 3. JSONC preservation: user comments and sibling settings survive, and an
  //    existing key's value is spliced in place (path AND size keys together)
  cacheSizeSetting = 2048;
  fs.writeFileSync(
    settingsFile,
    [
      '// my precious tuning',
      '{',
      '  // keep this comment',
      '  "editor.tabSize": 2, // trailing note',
      '  "C_Cpp.intelliSenseCachePath": "C:/old/place",',
      '  "files.exclude": { "**/*.o": true },',
      '}',
      '',
    ].join('\n')
  );
  ensureIntellisenseConfig(store2);
  const s2 = read();
  // string-aware JSONC strip for assertions (inline // comments + trailing commas)
  const parseJsonc = (t) => JSON.parse(t.replace(/("(?:[^"\\]|\\.)*")|\/\/.*/g, '$1').replace(/,(\s*[}\]])/g, '$1'));
  check('cachePath override: JSONC comments and siblings survive the splice', s2 !== null && s2.includes('// my precious tuning') && s2.includes('// keep this comment') && s2.includes('// trailing note') && parseJsonc(s2)['files.exclude']['**/*.o'] === true);
  check('cachePath override: the key value is updated in place', parseJsonc(s2)['C_Cpp.intelliSenseCachePath'] === 'F:/mrvc-cache/ipch');
  check('cacheSize override: the size key lands next to it (number, not string)', parseJsonc(s2)['C_Cpp.intelliSenseCacheSize'] === 2048);

  // 4. both OFF (path empty, size 0 = the "never touch this key" escape):
  //    the written values STAY (MRVC never deletes what it did not create)
  cachePathSetting = '';
  cacheSizeSetting = 0;
  ensureIntellisenseConfig(store2);
  check('cachePath override: settings off leaves the workspace file alone', read() === s2);
}

// ---- cacheSize alone: the path setting off, size 2048 -> only the size key ----
if (HAS_LED) {
  const { ensureIntellisenseConfig } = require('../out/vscode/intellisense.js');
  const cp3 = Cproject.load(PROJ);
  const tc3 = {
    name: 'GCC8', dir: 'C:/tc', compilerC: 'C:/tc/bin/riscv-none-embed-gcc.exe', compilerCpp: 'C:/tc/bin/riscv-none-embed-g++.exe',
    linkerC: 'gcc', linkerCpp: 'g++', debugger: 'gdb', objcopy: 'o', objdump: 'o', size: 's', prefix: 'riscv-none-embed-',
  };
  const store3 = { all: [{ root: PROJ, projectName: 'LED', cproject: cp3, toolchain: () => tc3 }] };
  const settingsFile = path.join(WS, '.vscode', 'settings.json');
  const read = () => { try { return fs.readFileSync(settingsFile, 'utf-8'); } catch { return null; } };
  fs.rmSync(settingsFile, { force: true });
  cachePathSetting = '';
  cacheSizeSetting = 2048;
  ensureIntellisenseConfig(store3);
  const s = read();
  check('cacheSize only: the size key is written without touching the path key', s !== null && parseJsoncSafe(s)['C_Cpp.intelliSenseCacheSize'] === 2048 && !('C_Cpp.intelliSenseCachePath' in parseJsoncSafe(s)));
  // a hand edit that turned the size key into a string is respected (never touch)
  fs.writeFileSync(settingsFile, '{\n  "C_Cpp.intelliSenseCacheSize": "big"\n}');
  ensureIntellisenseConfig(store3);
  check('cacheSize only: a string-typed hand edit is left untouched (unreadable)', read() === '{\n  "C_Cpp.intelliSenseCacheSize": "big"\n}');
  cacheSizeSetting = 0;
}

// ---- applyCacheOverrides: runtime type protection (round24 §5.1) ----
// the stub serves hand-edited setting values; the command must skip them
// instead of throwing inside the configuration listener
if (HAS_LED) {
  const { applyCacheOverrides } = require('../out/vscode/intellisense.js');
  const settingsFile = path.join(WS, '.vscode', 'settings.json');
  const read = () => { try { return fs.readFileSync(settingsFile, 'utf-8'); } catch { return null; } };
  fs.rmSync(settingsFile, { force: true }); // fresh file: earlier sections left one behind
  cachePathSetting = 12345; // a hand-edited number where a string belongs
  cacheSizeSetting = 2048;
  const rType = applyCacheOverrides();
  check(
    'cache overrides: a non-string path value is skipped (size still written)',
    rType.invalidSettings.length === 1 && rType.unreadable.length === 0 && JSON.parse(read())['C_Cpp.intelliSenseCachePath'] === undefined && JSON.parse(read())['C_Cpp.intelliSenseCacheSize'] === 2048
  );
  cacheSizeSetting = 'not-a-number';
  cachePathSetting = 'F:/mrvc-cache/ipch';
  const rSize = applyCacheOverrides();
  // the size key from the PREVIOUS write stays (MRVC never deletes) — the
  // new non-number value is simply not written
  check(
    'cache overrides: a non-number size value is skipped (path still written)',
    JSON.parse(read())['C_Cpp.intelliSenseCacheSize'] === 2048 && JSON.parse(read())['C_Cpp.intelliSenseCachePath'] === 'F:/mrvc-cache/ipch' && rSize.invalidSettings.length === 1
  );
  // round26 §4.1: a fractional MB must not floor to 0 (0 = "no cap" for
  // cpptools) — it is reported and skipped instead
  cacheSizeSetting = 0.5;
  const rFrac = applyCacheOverrides();
  check(
    'cache overrides: a fractional MB is rejected, not floored to a silent 0',
    rFrac.invalidSettings.length === 1 && rFrac.invalidSettings[0].includes('0.5') && JSON.parse(read())['C_Cpp.intelliSenseCacheSize'] === 2048
  );
  // round28 §3.2: a NEGATIVE value is reported too (0 stays the silent opt-out)
  cacheSizeSetting = -1;
  const rNeg = applyCacheOverrides();
  check(
    'cache overrides: a negative MB is reported, not silently skipped',
    rNeg.invalidSettings.length === 1 && rNeg.invalidSettings[0].includes('-1') && JSON.parse(read())['C_Cpp.intelliSenseCacheSize'] === 2048
  );
  // 0 remains the documented opt-out: silently skipped, no error
  cacheSizeSetting = 0;
  cachePathSetting = 12345;
  fs.rmSync(path.join(WS, '.vscode', 'settings.json'), { force: true });
  const rZero = applyCacheOverrides();
  check(
    'cache overrides: 0 stays the silent opt-out (no size key, file not created)',
    rZero.invalidSettings.length === 1 && rZero.invalidSettings[0].includes('cachePath') && read() === null
  );
  cachePathSetting = '';
  cacheSizeSetting = 0;
}

// ---- round31 §3.3: MULTIPLE config problems are reported TOGETHER ----
// a corrupt c_cpp_properties.json AND a corrupt settings.json surface in ONE
// multi-line error — the user must not have to fix one and re-run to find
// the next (runs last, right before the scratch cleanup, so the corruption
// cannot reach any other section)
if (HAS_LED) {
  const { ensureIntellisenseConfig } = require('../out/vscode/intellisense.js');
  const cpM = Cproject.load(PROJ);
  const tcM = {
    name: 'GCC8', dir: 'C:/tc', compilerC: 'C:/tc/bin/riscv-none-embed-gcc.exe', compilerCpp: 'C:/tc/bin/riscv-none-embed-g++.exe',
    linkerC: 'gcc', linkerCpp: 'g++', debugger: 'gdb', objcopy: 'o', objdump: 'o', size: 's', prefix: 'riscv-none-embed-',
  };
  const storeM = { all: [{ root: PROJ, projectName: 'LED', cproject: cpM, toolchain: () => tcM }] };
  cachePathSetting = '';
  cacheSizeSetting = 2048; // a size write is pending, so the unreadable settings.json is probed
  fs.writeFileSync(path.join(WS, '.vscode', 'c_cpp_properties.json'), '{ broken props');
  fs.writeFileSync(path.join(WS, '.vscode', 'settings.json'), '{{{ broken settings');
  const rM = ensureIntellisenseConfig(storeM);
  check(
    'cache: multiple config problems are reported together in one multi-line error',
    typeof rM.error === 'string' && rM.error.includes('c_cpp_properties.json') && rM.error.includes('settings.json') && rM.error.includes('\n')
  );
  cacheSizeSetting = 0;
}

function parseJsoncSafe(t) {
  return JSON.parse(t.replace(/("(?:[^"\\]|\\.)*")|\/\/.*/g, '$1').replace(/,(\s*[}\]])/g, '$1'));
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall intellisense tests passed');
process.exit(failures ? 1 : 0);
