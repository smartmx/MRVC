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
const PROJ = 'F:/CH585/EVT/V1_2/EXAM/LED';
const HAS_LED = fs.existsSync(path.join(PROJ, '.cproject'));

const vscodeStub = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: WS }, name: 'ws', index: 0 }],
    getConfiguration: () => ({ get: (_k, d) => d }),
  },
  window: {},
  Uri: { file: (f) => ({ fsPath: f }) },
};
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
const { Cproject } = require(path.join(__dirname, '..', 'out', 'core', 'cproject.js'));
const { scanSources } = require(path.join(__dirname, '..', 'out', 'core', 'scan.js'));
const { buildCompileEntries } = require(path.join(__dirname, '..', 'out', 'core', 'intellisense.js'));

const { partitionByReference, contextDatabases } = require('../out/core/intellisense.js');
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

fs.rmSync(WS, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall intellisense tests passed');
process.exit(failures ? 1 : 0);
