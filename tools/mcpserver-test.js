/*
 * MRVC MCP server end-to-end tests (0.3.7): spawn mcp/mcp-server.js, speak
 * the stdio JSON-RPC transport (newline-delimited), and assert the protocol
 * surface (initialize / tools/list / ping / parse errors / unknown methods)
 * plus the EIGHTEEN tools against a HERMETIC fixture — a fake MRS install tree
 * (the mrsinstall-test recipe), a minimal legal project, and the
 * env-steering contract (MRVC_MRS_INSTALL_PATH inherited by the child). The
 * real install is only exercised tolerantly (get_install_info without
 * arguments must return a parseable result either way); the build tool's
 * make stage depends on the machine's PATH, so its assertion accepts the
 * structured no-make error. Hardware gates: flash requires a receipt with a
 * matching FlashPlan fingerprint; power requires its own marker-verified
 * power receipt. Config-write tools (0.3.7 batch 5) run through the guarded
 * shell: backup into .vscode/mrvc/mcp-backup/, mutation, re-parse.
 *
 * Run: node tools/mcpserver-test.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail === undefined ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const SERVER = path.join(__dirname, '..', 'mcp', 'mcp-server.js');
const ROOT = path.join(__dirname, '..', '.scratch', 'mcp');

/** recursive rm with a short backoff — Windows keeps the scratch dir busy
 *  for a moment after the server child (and its spawned grandchildren) exit,
 *  and an immediate rm intermittently EPERMs the whole suite (round20 P3-2) */
function rmSyncRetry(dir, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1));
    }
  }
}

fs.rmSync(ROOT, { recursive: true, force: true });

/** containment guard: every fixture write goes through here */
function inside(root, rel) {
  const target = path.resolve(root, rel);
  const r = path.resolve(root);
  if (target !== r && !target.startsWith(r + path.sep)) {
    throw new Error('fixture path escapes the scratch root: ' + target);
  }
  return target;
}

// ---- fixtures ---------------------------------------------------------------

// minimal ELF with e_machine set (x64) — passes binary-arch validation
function elfBytes(arch) {
  const b = Buffer.alloc(64, 0);
  b.write('\x7fELF', 0, 'binary');
  b.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18);
  return b;
}

/** fake MRS2 IDE tree (the mrsinstall-test recipe, win32 layout) */
function makeFakeInstall(name) {
  const root = inside(ROOT, name);
  const appDir = inside(root, 'resources/app');
  const res = inside(appDir, 'resources/win32');
  fs.mkdirSync(inside(res, 'components/WCH'), { recursive: true });
  fs.writeFileSync(inside(res, 'components/WCH/manifest.json'), '{}');
  fs.writeFileSync(
    inside(appDir, 'product.json'),
    JSON.stringify({ nameShort: 'MounRiver Studio 2', mrsVersion: '2.0.0' })
  );
  fs.writeFileSync(inside(root, 'MounRiver Studio 2.exe'), '');
  // the openocd binary slot (an EMPTY file: existence checks pass, nothing
  // ever executes) — the cfg is deliberately absent so the flash/power
  // handlers stop at the deterministic 'board cfg not found' error
  fs.mkdirSync(inside(res, 'components/WCH/OpenOCD/OpenOCD/bin'), { recursive: true });
  fs.writeFileSync(inside(res, 'components/WCH/OpenOCD/OpenOCD/bin/openocd.exe'), '');
  const bin = inside(res, 'components/WCH/Toolchain/RISC-V Embedded GCC12/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(inside(bin, 'riscv-wch-elf-gcc'), elfBytes('x64'));
  fs.writeFileSync(
    inside(res, 'components/WCH/Toolchain/sub_manifest.json'),
    JSON.stringify({
      details: [
        {
          name: 'GCC12',
          type: 'RISC-V',
          path: './RISC-V Embedded GCC12',
          compiler_c_executable: { folder: './bin', name: 'riscv-wch-elf-gcc' },
        },
      ],
    })
  );
  return root;
}

/** minimal legal project: *.wvproj + .project + .cproject + sources */
function makeProject(name) {
  const proj = inside(ROOT, 'ws/' + name);
  fs.mkdirSync(inside(proj, 'src'), { recursive: true });
  fs.writeFileSync(inside(proj, 'main.c'), 'int main(){return 0;}\n');
  fs.writeFileSync(inside(proj, 'src/keep.c'), 'int k(){return 1;}\n');
  fs.writeFileSync(inside(proj, name + '.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(
    inside(proj, '.project'),
    '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>' + name + '</name></projectDescription>'
  );
  fs.writeFileSync(
    inside(proj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n' +
      '<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n' +
      '</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  return proj;
}

const WS = inside(ROOT, 'ws');
const PROJ = makeProject('proj');
const FAKE = makeFakeInstall('fake-mrs2');

// ---- server harness ---------------------------------------------------------

function startServer() {
  // NOTE: no env option — the child inherits this process's environment, so
  // the env-steering test simply sets MRVC_MRS_INSTALL_PATH here first
  const child = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  const stray = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else {
        stray.push(msg);
      }
    }
  });
  const stderrLines = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const l of chunk.split(/\r?\n/)) if (l.trim()) stderrLines.push(l);
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('timeout waiting for response to ' + method + ' #' + id));
        }
      }, 30000);
    });
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n');
  };
  return { child, rpc, notify, stray, stderrLines };
}

/** parse the text content of a tools/call result */
function resultJson(msg) {
  const content = msg.result && msg.result.content;
  if (!Array.isArray(content) || !content.length || typeof content[0].text !== 'string') return null;
  try {
    return JSON.parse(content[0].text);
  } catch {
    return null;
  }
}

async function withServer(label, fn) {
  const server = startServer();
  try {
    const init = await server.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcpserver-test', version: '0' },
    });
    check(label + ': initialize returns mrvc-mcp serverInfo + tools capability', !!init.result && init.result.serverInfo.name === 'mrvc-mcp' && !!init.result.capabilities.tools, JSON.stringify(init.result));
    await fn(server);
  } finally {
    server.child.kill();
  }
}

// ---- tests ------------------------------------------------------------------

(async () => {
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'MRVC_MRS_INSTALL_PATH');
  const savedEnv = process.env['MRVC_MRS_INSTALL_PATH'];
  if (hadEnv) delete process.env['MRVC_MRS_INSTALL_PATH'];

  try {
    await withServer('main', async (server) => {
      // notification stays silent; the ping right after it is the ONLY reply
      server.notify('notifications/initialized');
      const ping = await server.rpc('ping');
      check('main: ping answers {} and the notification stayed silent', JSON.stringify(ping.result) === '{}' && server.stray.length === 0, JSON.stringify(ping.result));

      const list = await server.rpc('tools/list');
      const names = list.result.tools.map((t) => t.name);
      check(
        'main: tools/list carries the eighteen tools',
        JSON.stringify(names) ===
          JSON.stringify([
            'mrvc_discover_projects',
            'mrvc_get_install_info',
            'mrvc_get_project_config',
            'mrvc_audit_project',
            'mrvc_check_preprocessor',
            'mrvc_set_config_option',
            'mrvc_manage_configurations',
            'mrvc_list_linked_folders',
            'mrvc_add_linked_folder',
            'mrvc_remove_linked_folder',
            'mrvc_build',
            'mrvc_stack_usage',
            'mrvc_call_analysis',
            'mrvc_get_build_log',
            'mrvc_export_cmake',
            'mrvc_generate_intellisense_db',
            'mrvc_flash',
            'mrvc_power_off_reset',
          ]),
        names.join(',')
      );
      check('main: every tool has a description and an object schema', list.result.tools.every((t) => typeof t.description === 'string' && t.description.length > 0 && t.inputSchema && t.inputSchema.type === 'object'));
      const schemaByName = Object.fromEntries(list.result.tools.map((t) => [t.name, t.inputSchema]));
      check(
        'main: build exposes timeoutSec/configs/rebuild/analysis; flash/power expose openocdPath',
        !!schemaByName.mrvc_build.properties.timeoutSec &&
          !!schemaByName.mrvc_build.properties.configs &&
          !!schemaByName.mrvc_build.properties.analysis &&
          JSON.stringify(schemaByName.mrvc_build.properties.target.enum) === JSON.stringify(['build', 'clean', 'rebuild']) &&
          !!schemaByName.mrvc_flash.properties.openocdPath &&
          !!schemaByName.mrvc_power_off_reset.properties.openocdPath
      );
      check(
        'main: write tools expose field/action enums (0.3.7 batch 5)',
        JSON.stringify(schemaByName.mrvc_set_config_option.properties.field.enum) === JSON.stringify(['includePaths', 'defines', 'optimizationLevel', 'linkerScript']) &&
          JSON.stringify(schemaByName.mrvc_set_config_option.properties.language.enum) === JSON.stringify(['both', 'c', 'cpp', 'asm']) &&
          JSON.stringify(schemaByName.mrvc_manage_configurations.properties.action.enum) === JSON.stringify(['list', 'add', 'rename', 'delete', 'setActive']) &&
          !!schemaByName.mrvc_add_linked_folder.properties.location &&
          !!schemaByName.mrvc_remove_linked_folder.properties.name,
        JSON.stringify(Object.keys(schemaByName))
      );

      const disc = await server.rpc('tools/call', { name: 'mrvc_discover_projects', arguments: { root: WS } });
      const discJson = resultJson(disc);
      check('main: discover finds the fixture project', !!discJson && discJson.count === 1 && discJson.projects[0].name === 'proj', JSON.stringify(discJson));
      check('main: discover summary carries configs/target', !!discJson && discJson.projects[0].activeConfig === 'obj' && JSON.stringify(discJson.projects[0].configurations) === '["obj"]' && discJson.projects[0].targetName === 'proj');

      const cfg = await server.rpc('tools/call', { name: 'mrvc_get_project_config', arguments: { root: PROJ } });
      const cfgJson = resultJson(cfg);
      check('main: project config summary', !!cfgJson && cfgJson.name === 'proj' && cfgJson.isCpp === false && cfgJson.targetName === 'proj', JSON.stringify(cfgJson));
      check('main: sampleCommand resolves a gcc command line', !!cfgJson && typeof cfgJson.sampleCommand === 'string' && cfgJson.sampleCommand.includes('gcc'), !!cfgJson ? cfgJson.sampleCommand : 'null');

      const info = await server.rpc('tools/call', { name: 'mrvc_get_install_info', arguments: {} });
      const infoJson = resultJson(info);
      check('main: get_install_info returns a parseable result (real machine: ok or structured error)', !!infoJson && (infoJson.ok === true || typeof infoJson.error === 'string'), JSON.stringify(infoJson).slice(0, 160));

      const infoFake = await server.rpc('tools/call', { name: 'mrvc_get_install_info', arguments: { mrsInstallPath: FAKE } });
      const infoFakeJson = resultJson(infoFake);
      check(
        'main: explicit fake install resolves as mrs2 with GCC12',
        !!infoFakeJson && infoFakeJson.ok === true && infoFakeJson.generation === 'mrs2' && infoFakeJson.toolchains.includes('GCC12'),
        JSON.stringify(infoFakeJson)
      );

      const infoBad = await server.rpc('tools/call', { name: 'mrvc_get_install_info', arguments: { mrsInstallPath: path.join(ROOT, 'nope') } });
      const infoBadJson = resultJson(infoBad);
      check('main: a bogus install path is a structured error, not a crash', !!infoBadJson && infoBadJson.ok === false, JSON.stringify(infoBadJson));

      const audit = await server.rpc('tools/call', { name: 'mrvc_audit_project', arguments: { root: PROJ } });
      const auditJson = resultJson(audit);
      check('main: audit on the clean fixture reports zero findings', !!auditJson && auditJson.ok === true && auditJson.findingCount === 0, JSON.stringify(auditJson));

      const log = await server.rpc('tools/call', { name: 'mrvc_get_build_log', arguments: { root: PROJ } });
      const logJson = resultJson(log);
      check('main: build log absent on a never-built project', !!logJson && logJson.exists === false, JSON.stringify(logJson));

      const cmake = await server.rpc('tools/call', { name: 'mrvc_export_cmake', arguments: { root: PROJ, mrsInstallPath: FAKE } });
      const cmakeJson = resultJson(cmake);
      check('main: export_cmake writes CMakeLists.txt', !!cmakeJson && cmakeJson.ok === true && fs.existsSync(path.join(PROJ, 'CMakeLists.txt')), JSON.stringify(cmakeJson));
      const cmakeBody = fs.readFileSync(path.join(PROJ, 'CMakeLists.txt'), 'utf8');
      check('main: CMakeLists content carries the project name and sources', cmakeBody.includes('proj') && cmakeBody.includes('main.c'), cmakeBody.slice(0, 120));

      const cmakeDup = await server.rpc('tools/call', { name: 'mrvc_export_cmake', arguments: { root: PROJ, mrsInstallPath: FAKE } });
      check('main: second export without overwrite refuses (hand-maintained guard)', cmakeDup.result.isError === true && resultJson(cmakeDup).error.includes('already exists'), JSON.stringify(resultJson(cmakeDup)));

      const cmakeOver = await server.rpc('tools/call', { name: 'mrvc_export_cmake', arguments: { root: PROJ, mrsInstallPath: FAKE, overwrite: true } });
      check('main: overwrite:true replaces CMakeLists.txt', cmakeOver.result.isError !== true && resultJson(cmakeOver).ok === true);

      const db = await server.rpc('tools/call', { name: 'mrvc_generate_intellisense_db', arguments: { root: PROJ, mrsInstallPath: FAKE } });
      const dbJson = resultJson(db);
      const dbFile = path.join(PROJ, '.vscode', 'compile_commands.json');
      check('main: intellisense db written with both sources', !!dbJson && dbJson.ok === true && fs.existsSync(dbFile), JSON.stringify(dbJson));
      const entries = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : [];
      check(
        'main: db entries use the standard arguments form with gcc',
        Array.isArray(entries) && entries.length >= 2 && entries.every((e) => typeof e.directory === 'string' && Array.isArray(e.arguments) && e.arguments.join(' ').includes('gcc')),
        JSON.stringify(entries).slice(0, 160)
      );

      // ---- 0.3.7 batch 2: read-only analysis tools ----

      // preprocessor consistency: clean project agrees; a divergent fixture
      // (same macro, different value in two lists) is reported
      const ppClean = await server.rpc('tools/call', { name: 'mrvc_check_preprocessor', arguments: { root: PROJ } });
      const ppCleanJson = resultJson(ppClean);
      check('main: pp check on the clean fixture agrees', !!ppCleanJson && ppCleanJson.ok === true && ppCleanJson.divergenceCount === 0, JSON.stringify(ppCleanJson));

      const ppProj = makeProject('projpp');
      const { Cproject: CprojectCore } = require('../out/core/cproject.js');
      const cpPp = CprojectCore.load(ppProj);
      cpPp.setOptionList('c.compiler.defs', ['FOO=1']);
      cpPp.setOptionList('cpp.compiler.defs', ['FOO=2', 'ONLY_CPP']);
      cpPp.save();
      const ppDiv = await server.rpc('tools/call', { name: 'mrvc_check_preprocessor', arguments: { root: ppProj } });
      const ppDivJson = resultJson(ppDiv);
      check(
        'main: pp check reports FOO defined differently in c vs cpp lists',
        !!ppDivJson && ppDivJson.ok === false && ppDivJson.divergenceCount === 1 && ppDivJson.divergences[0].name === 'FOO' && ppDivJson.divergences[0].occurrences.length === 2,
        JSON.stringify(ppDivJson)
      );

      // stack usage / call analysis: structured error on a project without
      // analysis output, then parse real fixture files from the build dir
      const suEmpty = await server.rpc('tools/call', { name: 'mrvc_stack_usage', arguments: { root: ppProj } });
      check('main: stack usage without .su files is a structured analysis hint', suEmpty.result.isError === true && resultJson(suEmpty).error.includes('.su files') && resultJson(suEmpty).error.includes('analysis'), JSON.stringify(resultJson(suEmpty)));
      const caEmpty = await server.rpc('tools/call', { name: 'mrvc_call_analysis', arguments: { root: ppProj } });
      check('main: call analysis without dumps is a structured analysis hint', caEmpty.result.isError === true && resultJson(caEmpty).error.includes('expand'), JSON.stringify(resultJson(caEmpty)));

      const objDir2 = path.join(PROJ, 'obj');
      fs.mkdirSync(objDir2, { recursive: true });
      fs.writeFileSync(
        path.join(objDir2, 'main.c.su'),
        'main.c:3:5:main\t16\tstatic\nutil.c:10:1:foo\t256\tdynamic\nworker.c:1:1:worker\t48\tstatic\n'
      );
      const su = await server.rpc('tools/call', { name: 'mrvc_stack_usage', arguments: { root: PROJ } });
      const suJson = resultJson(su);
      check(
        'main: stack usage parses the .su fixture (320 total, foo dynamic, sorted top)',
        !!suJson && suJson.ok === true && suJson.functionCount === 3 && suJson.totalOwnStack === 320 && JSON.stringify(suJson.dynamicFrames) === '["foo"]' && suJson.top[0].name === 'foo' && suJson.top[0].size === 256,
        JSON.stringify(suJson).slice(0, 240)
      );
      fs.writeFileSync(
        path.join(objDir2, 'main.c.123r.expand'),
        ';; Function main\n  (call (mem: (symbol_ref:SI ("helper"))))\n;; Function helper\n  (call (mem: (symbol_ref:SI ("delay_ns"))))\n'
      );
      const ca = await server.rpc('tools/call', { name: 'mrvc_call_analysis', arguments: { root: PROJ } });
      const caJson = resultJson(ca);
      check(
        'main: call analysis parses the expand dump (main→helper→delay_ns)',
        !!caJson && caJson.ok === true && caJson.edgeCount === 2 && caJson.edges[0].caller === 'main' && caJson.edges[0].callee === 'helper' && caJson.edges[1].callee === 'delay_ns',
        JSON.stringify(caJson).slice(0, 240)
      );
      // C++ translation units name their dumps by the source's OWN suffix
      // (0.3.7 round1 P2.2: the old `\.c\.` matcher ignored every one of
      // them, so a C++ project always got "no -fdump-rtl-expand dumps")
      const cppDumps = [
        ['main.cpp.191r.expand', 'cpp_main'],
        ['util.cc.205r.expand', 'cc_util'],
        ['driver.Cxx.250r.expand', 'cxx_driver'],
      ];
      for (const [dump, fn] of cppDumps) {
        fs.writeFileSync(path.join(objDir2, dump), `;; Function ${fn}\n  (call (mem: (symbol_ref:SI ("delay_ns"))))\n`);
      }
      const caCpp = await server.rpc('tools/call', { name: 'mrvc_call_analysis', arguments: { root: PROJ } });
      const caCppJson = resultJson(caCpp);
      check(
        'main: call analysis sees C++ dumps whatever the suffix spelling (cpp / cc / Cxx)',
        !!caCppJson &&
          caCppJson.ok === true &&
          caCppJson.edgeCount === 5 &&
          ['cpp_main', 'cc_util', 'cxx_driver'].every((fn) => caCppJson.edges.some((e) => e.caller === fn && e.callee === 'delay_ns')),
        JSON.stringify(caCppJson).slice(0, 260)
      );

      // ---- 0.3.7 batch 2: configs:"all" orchestration ----
      // a two-configuration project (obj active, dbg second) — the fixture
      // .cproject carries both <cconfiguration> elements in order
      const proj2 = makeProject('proj2');
      fs.writeFileSync(
        path.join(proj2, '.cproject'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n' +
          '<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n' +
          '</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n' +
          '<cconfiguration id="y" name="dbg">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n' +
          '<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n' +
          '</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
      );
      const cfg2 = await server.rpc('tools/call', { name: 'mrvc_get_project_config', arguments: { root: proj2 } });
      const cfg2Json = resultJson(cfg2);
      check(
        'main: two-config project reports both names with obj active',
        !!cfg2Json && cfg2Json.activeConfig === 'obj' && JSON.stringify(cfg2Json.configurations) === '["obj","dbg"]',
        JSON.stringify(cfg2Json).slice(0, 200)
      );
      // clean-all on a never-built project: deterministic no-op WITHOUT make
      const allClean = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: proj2, configs: 'all', target: 'clean', mrsInstallPath: FAKE } });
      const allCleanJson = resultJson(allClean);
      check(
        'main: clean-all on a never-built project is a deterministic no-op',
        !!allCleanJson && allCleanJson.ok === true && allCleanJson.mode === 'all' && Array.isArray(allCleanJson.configs) && allCleanJson.configs.length === 0 && (allCleanJson.note || '').includes('nothing to clean'),
        JSON.stringify(allCleanJson)
      );
      // with makefiles present the loop runs — the fake install has no make,
      // so the outcome is the structured no-make error or a real per-config run
      fs.mkdirSync(path.join(proj2, 'obj'), { recursive: true });
      fs.mkdirSync(path.join(proj2, 'dbg'), { recursive: true });
      fs.writeFileSync(path.join(proj2, 'obj', 'makefile'), '');
      fs.writeFileSync(path.join(proj2, 'dbg', 'makefile'), '');
      const allClean2 = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: proj2, configs: 'all', target: 'clean', mrsInstallPath: FAKE } });
      const allClean2Json = resultJson(allClean2);
      check(
        'main: clean-all with makefiles is well-formed (no-make error or per-config results)',
        !!allClean2Json && (allClean2Json.error !== undefined || (allClean2Json.configs.length === 2 && allClean2Json.configs.every((c) => typeof c.exitCode === 'number'))),
        JSON.stringify(allClean2Json).slice(0, 240)
      );
      // build-all needs make up-front: same tolerant shape
      const allBuild = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: proj2, configs: 'all', target: 'build', mrsInstallPath: FAKE } });
      const allBuildJson = resultJson(allBuild);
      check(
        'main: build-all is well-formed (structured error or per-config build entries)',
        !!allBuildJson && (allBuildJson.error !== undefined || (Array.isArray(allBuildJson.configs) && allBuildJson.configs.every((c) => c.phase === 'build'))),
        JSON.stringify(allBuildJson).slice(0, 240)
      );

      // ---- 0.3.7 batch 5: guarded config-write tools ----

      const projCfg = makeProject('projcfg');
      // include paths: an absolute path INSIDE the project normalizes to the
      // MRS workspace_loc spelling; an outside absolute passes through; the
      // C and C++ twins are written together (language defaults to both)
      const linkedTarget = path.join(ROOT, 'linked-target');
      fs.mkdirSync(linkedTarget, { recursive: true });
      const setInc = await server.rpc('tools/call', {
        name: 'mrvc_set_config_option',
        arguments: { root: projCfg, field: 'includePaths', value: [path.join(projCfg, 'inc'), linkedTarget] },
      });
      const setIncJson = resultJson(setInc);
      const incExpected = ['${workspace_loc:/${ProjName}/inc}', linkedTarget];
      check(
        'main: set_config_option includePaths normalizes inside-project paths (workspace_loc)',
        !!setIncJson && setIncJson.ok === true && JSON.stringify(setIncJson.after) === JSON.stringify(incExpected),
        JSON.stringify(setIncJson)
      );
      check(
        'main: the write guard backs up the project files (real <name>.wvproj marker) and reports the backup dir',
        !!setIncJson && typeof setIncJson.backupDir === 'string' && setIncJson.backupDir.includes(path.join('.vscode', 'mrvc', 'mcp-backup')) &&
          fs.existsSync(setIncJson.backupDir) && setIncJson.backedUp.includes('.cproject') && setIncJson.backedUp.includes('.project') &&
          setIncJson.backedUp.includes('projcfg.wvproj'),
        JSON.stringify(setIncJson && setIncJson.backedUp)
      );
      const cpInc = CprojectCore.load(projCfg);
      check(
        'main: include paths stored on BOTH language twins (default language both)',
        JSON.stringify(cpInc.listOption('c.compiler.include.paths').values) === JSON.stringify(incExpected) &&
          JSON.stringify(cpInc.listOption('cpp.compiler.include.paths').values) === JSON.stringify(incExpected),
        JSON.stringify([cpInc.listOption('c.compiler.include.paths').values, cpInc.listOption('cpp.compiler.include.paths').values])
      );

      // defines: raw macros, no path normalization, one surrounding quote pair
      // stripped (the extension list round-trip), c/cpp mirrored
      const setDefs = await server.rpc('tools/call', {
        name: 'mrvc_set_config_option',
        arguments: { root: projCfg, field: 'defines', value: ['DEBUG=1', '"FOO=2"'] },
      });
      const setDefsJson = resultJson(setDefs);
      check(
        'main: set_config_option defines strips quotes and mirrors both twins',
        !!setDefsJson && setDefsJson.ok === true && JSON.stringify(setDefsJson.after) === JSON.stringify(['DEBUG=1', 'FOO=2']),
        JSON.stringify(setDefsJson)
      );

      // single-language write: cpp only leaves the c list untouched
      const setCppOnly = await server.rpc('tools/call', {
        name: 'mrvc_set_config_option',
        arguments: { root: projCfg, field: 'defines', value: ['CPP_ONLY'], language: 'cpp' },
      });
      const setCppOnlyJson = resultJson(setCppOnly);
      const cpCppOnly = CprojectCore.load(projCfg);
      check(
        'main: language cpp writes the twin only (c list untouched)',
        !!setCppOnlyJson && setCppOnlyJson.ok === true && JSON.stringify(setCppOnlyJson.before.cpp) === JSON.stringify(['DEBUG=1', 'FOO=2']) && !('c' in setCppOnlyJson.before) &&
          JSON.stringify(cpCppOnly.listOption('c.compiler.defs').values) === JSON.stringify(['DEBUG=1', 'FOO=2']) &&
          JSON.stringify(cpCppOnly.listOption('cpp.compiler.defs').values) === JSON.stringify(['CPP_ONLY']),
        JSON.stringify([setCppOnlyJson && setCppOnlyJson.before, cpCppOnly.listOption('c.compiler.defs').values, cpCppOnly.listOption('cpp.compiler.defs').values])
      );

      // optimization level: enumerated MRS spelling; invalid values are
      // refused with the full valid table BEFORE any backup is taken
      const setOpt = await server.rpc('tools/call', {
        name: 'mrvc_set_config_option',
        arguments: { root: projCfg, field: 'optimizationLevel', value: 'more' },
      });
      const setOptJson = resultJson(setOpt);
      const cpOpt = CprojectCore.load(projCfg);
      check(
        'main: optimization level writes the enumerated id (before size → after more)',
        !!setOptJson && setOptJson.ok === true && setOptJson.before === 'size' && setOptJson.after === 'more' && cpOpt.optimizationLevel === 'more',
        JSON.stringify(setOptJson)
      );
      const setOptBad = await server.rpc('tools/call', {
        name: 'mrvc_set_config_option',
        arguments: { root: projCfg, field: 'optimizationLevel', value: 'turbo' },
      });
      const cpOptBad = CprojectCore.load(projCfg);
      check(
        'main: an unknown optimization level is refused with the valid table (project unchanged)',
        setOptBad.result.isError === true && (resultJson(setOptBad).error || '').includes('valid:') && (resultJson(setOptBad).error || '').includes('most') && cpOptBad.optimizationLevel === 'more',
        JSON.stringify(resultJson(setOptBad))
      );
      const setIdxBad = await server.rpc('tools/call', {
        name: 'mrvc_set_config_option',
        arguments: { root: projCfg, field: 'defines', value: ['X'], configIndex: 5 },
      });
      check(
        'main: an out-of-range configIndex is a structured error',
        setIdxBad.result.isError === true && (resultJson(setIdxBad).error || '').includes('out of range'),
        JSON.stringify(resultJson(setIdxBad))
      );
      // round13 P3.1: invalid values must be REFUSED, not silently treated as
      // "the active configuration" (1.5 / -1 / "1" all used to fall back to 0)
      const setIdxFloat = await server.rpc('tools/call', {
        name: 'mrvc_set_config_option',
        arguments: { root: projCfg, field: 'defines', value: ['X'], configIndex: 1.5 },
      });
      check(
        'main: a fractional configIndex is refused (no silent fallback to the active config)',
        setIdxFloat.result.isError === true && (resultJson(setIdxFloat).error || '').includes('non-negative integer'),
        JSON.stringify(resultJson(setIdxFloat))
      );
      const setLangBad = await server.rpc('tools/call', {
        name: 'mrvc_set_config_option',
        arguments: { root: projCfg, field: 'defines', value: ['X'], language: 'xx' },
      });
      check(
        'main: an unknown language value is refused (no silent both-twins write)',
        setLangBad.result.isError === true && (resultJson(setLangBad).error || '').includes('valid: both, c, cpp, asm'),
        JSON.stringify(resultJson(setLangBad))
      );

      // configuration management: a fixture in the REAL MRS shape (the name
      // lives on the inner <configuration> — renameConfigBlock walks the
      // inner form; the outer-attr fallback of the minimal fixtures above
      // would make a clone inherit its source's name)
      const projMgmt = makeProject('projmgmt');
      const cfgBody = (name, id) =>
        `<cconfiguration id="${id}">\n<configuration name="${name}">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n` +
        '<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</configuration>\n</cconfiguration>';
      fs.writeFileSync(
        path.join(projMgmt, '.cproject'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n' + cfgBody('obj', 'x') + '\n' + cfgBody('dbg', 'y') + '\n</cproject>'
      );
      const mgmtList = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'list' } });
      const mgmtListJson = resultJson(mgmtList);
      check(
        'main: manage_configurations list reports names with obj active',
        !!mgmtListJson && mgmtListJson.ok === true && JSON.stringify(mgmtListJson.names) === JSON.stringify(['obj', 'dbg']) && mgmtListJson.active === 'obj',
        JSON.stringify(mgmtListJson)
      );
      const mgmtAdd = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'add', name: 'rel', copyFrom: 'obj' } });
      const mgmtAddJson = resultJson(mgmtAdd);
      check(
        'main: manage_configurations add deep-copies a configuration',
        !!mgmtAddJson && mgmtAddJson.ok === true && JSON.stringify(mgmtAddJson.names) === JSON.stringify(['obj', 'dbg', 'rel']),
        JSON.stringify(mgmtAddJson)
      );
      const mgmtDup = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'add', name: 'obj' } });
      check(
        'main: a duplicate configuration name is refused',
        mgmtDup.result.isError === true && (resultJson(mgmtDup).error || '').includes('already exists'),
        JSON.stringify(resultJson(mgmtDup))
      );
      const mgmtRename = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'rename', name: 'rel', newName: 'release' } });
      const mgmtRenameJson = resultJson(mgmtRename);
      check(
        'main: manage_configurations rename rewrites the row',
        !!mgmtRenameJson && mgmtRenameJson.ok === true && JSON.stringify(mgmtRenameJson.names) === JSON.stringify(['obj', 'dbg', 'release']),
        JSON.stringify(mgmtRenameJson)
      );
      const mgmtDel = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'delete', name: 'release' } });
      const mgmtDelJson = resultJson(mgmtDel);
      check(
        'main: manage_configurations delete removes the row',
        !!mgmtDelJson && mgmtDelJson.ok === true && JSON.stringify(mgmtDelJson.names) === JSON.stringify(['obj', 'dbg']),
        JSON.stringify(mgmtDelJson)
      );
      const mgmtDelActive = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'delete', name: 'obj' } });
      check(
        'main: deleting the ACTIVE configuration is refused (MRS semantics)',
        mgmtDelActive.result.isError === true && (resultJson(mgmtDelActive).error || '').includes('cannot delete the active'),
        JSON.stringify(resultJson(mgmtDelActive))
      );
      // round13 P3.2: setActive closes the loop — switch to a non-active
      // configuration (MRS Save semantics: the block MOVES to index 0),
      // then switch back; re-selecting the active one is a no-op
      const mgmtAct = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'setActive', name: 'dbg' } });
      const mgmtActJson = resultJson(mgmtAct);
      check(
        'main: setActive moves the chosen configuration to index 0 (C,A,B order)',
        !!mgmtActJson && mgmtActJson.ok === true && mgmtActJson.changed === true && mgmtActJson.active === 'dbg' && JSON.stringify(mgmtActJson.names) === JSON.stringify(['dbg', 'obj']),
        JSON.stringify(mgmtActJson)
      );
      const mgmtActNoop = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'setActive', name: 'dbg' } });
      check(
        'main: setActive on the already-active configuration is a no-op',
        !!resultJson(mgmtActNoop) && resultJson(mgmtActNoop).ok === true && resultJson(mgmtActNoop).changed === false,
        JSON.stringify(resultJson(mgmtActNoop))
      );
      const mgmtActBack = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'setActive', name: 'obj' } });
      check(
        'main: setActive back restores obj as active',
        !!resultJson(mgmtActBack) && resultJson(mgmtActBack).active === 'obj' && JSON.stringify(resultJson(mgmtActBack).names) === JSON.stringify(['obj', 'dbg']),
        JSON.stringify(resultJson(mgmtActBack))
      );
      // renaming the ACTIVE configuration with a .template present: the
      // Target Path follows (and the transaction covers marker + .template)
      fs.writeFileSync(path.join(projMgmt, '.template'), 'Target Path = obj/projmgmt.hex\n');
      const mgmtRenameActive = await server.rpc('tools/call', { name: 'mrvc_manage_configurations', arguments: { root: projMgmt, action: 'rename', name: 'obj', newName: 'obj2' } });
      const mgmtRenameActiveJson = resultJson(mgmtRenameActive);
      const tplAfter = fs.existsSync(path.join(projMgmt, '.template')) ? fs.readFileSync(path.join(projMgmt, '.template'), 'utf8') : '';
      check(
        'main: renaming the ACTIVE config rewrites the .template Target Path inside the transaction',
        !!mgmtRenameActiveJson && mgmtRenameActiveJson.ok === true && mgmtRenameActiveJson.targetPath === 'obj2/projmgmt.hex' &&
          JSON.stringify(mgmtRenameActiveJson.names) === JSON.stringify(['obj2', 'dbg']) &&
          tplAfter.includes('obj2/projmgmt.hex') &&
          mgmtRenameActiveJson.backedUp.includes('projmgmt.wvproj') && mgmtRenameActiveJson.backedUp.includes('.template'),
        JSON.stringify([mgmtRenameActiveJson, tplAfter])
      );

      // linked folders: macro-form storage, existence flags, refusal paths,
      // and the .cproject build integration (round13 P2.2/P3.3)
      const lfAdd = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: 'SharedLib', location: linkedTarget },
      });
      const lfAddJson = resultJson(lfAdd);
      check(
        'main: add_linked_folder stores the PARENT-N-PROJECT_LOC macro form',
        !!lfAddJson && lfAddJson.ok === true && lfAddJson.locationUri.startsWith('PARENT-') && lfAddJson.locationUri.includes('linked-target'),
        JSON.stringify(lfAddJson)
      );
      const cpL = CprojectCore.load(projCfg);
      const logicEntry = '${workspace_loc:/${ProjName}/SharedLib}';
      const seAfterAdd = cpL.sourceEntries;
      check(
        'main: add_linked_folder wires the build (include paths C+asm, root-scan excluding token, named sourceEntry)',
        cpL.listOption('c.compiler.include.paths').values.includes(logicEntry) &&
          cpL.listOption('assembler.include.paths').values.includes(logicEntry) &&
          seAfterAdd.some((e) => e.name === 'SharedLib') &&
          (seAfterAdd.find((e) => e.name === '')?.excluding ?? []).includes('SharedLib'),
        JSON.stringify([cpL.listOption('c.compiler.include.paths').values, seAfterAdd.map((e) => ({ name: e.name, excluding: e.excluding }))])
      );
      const lfDup = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: 'SharedLib', location: linkedTarget },
      });
      check(
        'main: a duplicate link name is refused',
        lfDup.result.isError === true && (resultJson(lfDup).error || '').includes('already exists'),
        JSON.stringify(resultJson(lfDup))
      );
      // round21 P2-1: a CASE-VARIANT duplicate folds to the same NTFS
      // directory — two links over it would race one object file
      const lfCaseDup = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: 'sharedlib', location: linkedTarget },
      });
      check(
        'main: a case-variant duplicate link name is refused',
        lfCaseDup.result.isError === true && (resultJson(lfCaseDup).error || '').includes('already exists'),
        JSON.stringify(resultJson(lfCaseDup))
      );
      // round21 P3-2: the full core safe-name rule, not just the old charset
      const lfDevice = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: 'CON.txt', location: linkedTarget },
      });
      check(
        'main: a device name with an extension is refused (core safe-name rule)',
        lfDevice.result.isError === true && (resultJson(lfDevice).error || '').includes('is not safe'),
        JSON.stringify(resultJson(lfDevice))
      );
      const lfSelf = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: 'SelfRoot', location: projCfg },
      });
      check(
        'main: linking the project root itself is refused before any backup',
        lfSelf.result.isError === true && (resultJson(lfSelf).error || '').includes('must not be or contain the project root'),
        JSON.stringify(resultJson(lfSelf))
      );
      // round23 P3-3: a trailing space must not be silently trimmed away —
      // the caller sent "Trail " and gets a refusal, no link is written
      const lfTrail = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: 'Trail ', location: linkedTarget },
      });
      const trailCount = require('../out/core/projectFile.js').readProjectFile(projCfg).linkedResources.filter((l) => l.name === 'Trail').length;
      check(
        'main: a trailing-space link name is refused (no silent trim)',
        lfTrail.result.isError === true && (resultJson(lfTrail).error || '').includes('leading/trailing spaces') && trailCount === 0,
        JSON.stringify(resultJson(lfTrail))
      );
      const lfMissing = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: 'Ghost', location: path.join(ROOT, 'no-such-dir') },
      });
      check(
        'main: a location that is not an existing directory is refused',
        lfMissing.result.isError === true && (resultJson(lfMissing).error || '').includes('not an existing directory'),
        JSON.stringify(resultJson(lfMissing))
      );
      // round13 P3.3: relative locations and illegal link names are refused
      const lfRel = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: 'Rel', location: 'some/relative/path' },
      });
      check(
        'main: a relative location is refused (no silent resolve against the server cwd)',
        lfRel.result.isError === true && (resultJson(lfRel).error || '').includes('ABSOLUTE'),
        JSON.stringify(resultJson(lfRel))
      );
      const lfBadName = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: 'bad/name', location: linkedTarget },
      });
      check(
        'main: a link name with path separators is refused (core safe-name rule)',
        lfBadName.result.isError === true && (resultJson(lfBadName).error || '').includes('is not safe'),
        JSON.stringify(resultJson(lfBadName))
      );
      // round18 P2-4: the core addLinkedFolder enforces the FULL safe-name
      // rule (dot-only / trailing dot / reserved devices beyond the charset)
      const lfDotDot = await server.rpc('tools/call', {
        name: 'mrvc_add_linked_folder',
        arguments: { root: projCfg, name: '..', location: linkedTarget },
      });
      check(
        'main: a dot-only link name is refused by the core safe-name rule',
        lfDotDot.result.isError === true && (resultJson(lfDotDot).error || '').includes('not safe'),
        JSON.stringify(resultJson(lfDotDot))
      );
      const lfList = await server.rpc('tools/call', { name: 'mrvc_list_linked_folders', arguments: { root: projCfg } });
      const lfListJson = resultJson(lfList);
      check(
        'main: list_linked_folders reports the link with its resolved location and exists flag',
        !!lfListJson && lfListJson.ok === true && lfListJson.count === 1 && lfListJson.folders[0].name === 'SharedLib' && lfListJson.folders[0].exists === true,
        JSON.stringify(lfListJson)
      );
      const lfRmGhost = await server.rpc('tools/call', { name: 'mrvc_remove_linked_folder', arguments: { root: projCfg, name: 'Ghost' } });
      check(
        'main: removing an unknown link name is refused with the present names',
        lfRmGhost.result.isError === true && (resultJson(lfRmGhost).error || '').includes('no linked folder named') && (resultJson(lfRmGhost).error || '').includes('SharedLib'),
        JSON.stringify(resultJson(lfRmGhost))
      );
      const lfRm = await server.rpc('tools/call', { name: 'mrvc_remove_linked_folder', arguments: { root: projCfg, name: 'SharedLib' } });
      const lfRmJson = resultJson(lfRm);
      const cpAfterRm = CprojectCore.load(projCfg);
      const seAfterRm = cpAfterRm.sourceEntries;
      const lfAfter = resultJson(await server.rpc('tools/call', { name: 'mrvc_list_linked_folders', arguments: { root: projCfg } }));
      check(
        'main: remove_linked_folder drops the link AND cleans the .cproject references',
        !!lfRmJson && lfRmJson.ok === true && lfRmJson.removed.name === 'SharedLib' && lfAfter.count === 0 &&
          !cpAfterRm.listOption('c.compiler.include.paths').values.includes(logicEntry) &&
          !cpAfterRm.listOption('assembler.include.paths').values.includes(logicEntry) &&
          !seAfterRm.some((e) => e.name === 'SharedLib') &&
          !(seAfterRm.find((e) => e.name === '')?.excluding ?? []).includes('SharedLib'),
        JSON.stringify([lfRmJson, cpAfterRm.listOption('c.compiler.include.paths').values, seAfterRm.map((e) => ({ name: e.name, excluding: e.excluding }))])
      );

      // round14 P3.1: a stale link must NOT be auto-repaired by read-only
      // tools — before the fix, the Cproject.load inside requireCproject
      // rewrote .project (stale absolute → PARENT-N form) on first open
      const sharedLib = path.join(WS, 'shared', 'lib');
      fs.mkdirSync(sharedLib, { recursive: true });
      const projStale = makeProject('projstale');
      fs.writeFileSync(
        path.join(projStale, '.project'),
        '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projstale</name>' +
          '<linkedResources><link><name>OldLink</name><type>2</type><locationURI>C:/build-machine/work/shared/lib</locationURI></link></linkedResources></projectDescription>'
      );
      const staleBefore = fs.readFileSync(path.join(projStale, '.project'), 'utf8');
      const staleList = resultJson(await server.rpc('tools/call', { name: 'mrvc_list_linked_folders', arguments: { root: projStale } }));
      const staleCfg = resultJson(await server.rpc('tools/call', { name: 'mrvc_get_project_config', arguments: { root: projStale } }));
      const staleAfter = fs.readFileSync(path.join(projStale, '.project'), 'utf8');
      check(
        'main: read-only tools leave a stale link byte-identical (no auto-repair)',
        !!staleList && staleList.ok === true && staleList.folders[0].name === 'OldLink' && staleList.folders[0].exists === false &&
          !!staleCfg && staleCfg.name === 'projstale' && staleAfter === staleBefore,
        JSON.stringify([staleList, staleAfter !== staleBefore])
      );

      // round15 P2.1: build/rebuild and the export tools REFUSE on stale
      // links (the scan would silently skip the missing directory), with the
      // would-be repair spelled out; clean is not gated (never scans);
      // after the link actually resolves the gate opens
      const staleBuild = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: projStale, target: 'build', mrsInstallPath: FAKE } });
      check(
        'main: build refuses on stale linked folders (no silent missing-source build)',
        staleBuild.result.isError === true &&
          (resultJson(staleBuild).error || '').includes('stale linked folder') &&
          (resultJson(staleBuild).error || '').includes('repairable to') &&
          (resultJson(staleBuild).error || '').includes('PARENT-1-PROJECT_LOC/shared/lib'),
        JSON.stringify(resultJson(staleBuild)).slice(0, 300)
      );
      const staleRebuild = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: projStale, target: 'rebuild', mrsInstallPath: FAKE } });
      check(
        'main: rebuild refuses on stale linked folders too',
        staleRebuild.result.isError === true && (resultJson(staleRebuild).error || '').includes('stale linked folder'),
        JSON.stringify(resultJson(staleRebuild))
      );
      const staleClean = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: projStale, target: 'clean', mrsInstallPath: FAKE } });
      check(
        'main: clean is NOT gated by stale links (never scans sources)',
        !!resultJson(staleClean) && resultJson(staleClean).ok === true && !(resultJson(staleClean).error || '').includes('stale linked folder'),
        JSON.stringify(resultJson(staleClean))
      );
      const staleCmake = await server.rpc('tools/call', { name: 'mrvc_export_cmake', arguments: { root: projStale, mrsInstallPath: FAKE } });
      check(
        'main: cmake export refuses on stale linked folders',
        staleCmake.result.isError === true && (resultJson(staleCmake).error || '').includes('stale linked folder'),
        JSON.stringify(resultJson(staleCmake))
      );
      const staleDb = await server.rpc('tools/call', { name: 'mrvc_generate_intellisense_db', arguments: { root: projStale, mrsInstallPath: FAKE } });
      check(
        'main: intellisense db refuses on stale linked folders',
        staleDb.result.isError === true && (resultJson(staleDb).error || '').includes('stale linked folder'),
        JSON.stringify(resultJson(staleDb))
      );
      // after the link resolves (simulating the extension's first-open repair)
      // the gate opens and the export proceeds
      fs.writeFileSync(
        path.join(projStale, '.project'),
        '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projstale</name>' +
          '<linkedResources><link><name>OldLink</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/shared/lib</locationURI></link></linkedResources></projectDescription>'
      );
      const fixedCmake = await server.rpc('tools/call', { name: 'mrvc_export_cmake', arguments: { root: projStale, mrsInstallPath: FAKE } });
      check(
        'main: the gate opens once the linked target resolves (cmake export proceeds)',
        !!resultJson(fixedCmake) && resultJson(fixedCmake).ok === true && fs.existsSync(path.join(projStale, 'CMakeLists.txt')),
        JSON.stringify(resultJson(fixedCmake)).slice(0, 240)
      );

      // user ruling 2026-11-25: a DANGLING named source entry (no dir, no
      // link) is a HINT, not a refusal — MRS compiles the EVT V1_2 BLE
      // projects whose shipped .cproject carries a leftover `Profile` entry.
      // get_project_config notes the entry and no scanNote fires; contrast
      // with the stale LINK above, which still refuses the build tools.
      const projDangling = makeProject('projdangling');
      fs.writeFileSync(
        path.join(projDangling, '.cproject'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n' +
          '<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n' +
          '<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="GhostEntry"/>\n' +
          '</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
      );
      const danglingCfg = resultJson(await server.rpc('tools/call', { name: 'mrvc_get_project_config', arguments: { root: projDangling } }));
      check(
        'main: get_project_config notes a dangling source entry (hint, not refusal)',
        !!danglingCfg && danglingCfg.name === 'projdangling' && Array.isArray(danglingCfg.danglingSourceEntries) &&
          danglingCfg.danglingSourceEntries.length === 1 && danglingCfg.danglingSourceEntries[0].includes('GhostEntry'),
        JSON.stringify(danglingCfg).slice(0, 300)
      );


      // review F3: active-config clean on a never-built project is a
      // deterministic no-op — no make spawn, no toolchain needed
      const projClean = makeProject('projclean');
      const cleanNoop = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: projClean, target: 'clean', mrsInstallPath: FAKE } });
      const cleanNoopJson = resultJson(cleanNoop);
      check(
        'main: active clean on a never-built project is a deterministic no-op',
        !!cleanNoopJson && cleanNoopJson.ok === true && cleanNoopJson.skipped === true && (cleanNoopJson.note || '').includes('nothing to clean'),
        JSON.stringify(cleanNoopJson)
      );
      // review F1: rebuild on a never-built project skips the clean phase and
      // goes straight to generate+build (needs make — tolerant shape)
      const rebuildNoop = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: projClean, target: 'rebuild', mrsInstallPath: FAKE } });
      const rebuildNoopJson = resultJson(rebuildNoop);
      check(
        'main: rebuild on a never-built project reaches the build phase (clean skipped)',
        !!rebuildNoopJson && (rebuildNoopJson.error !== undefined || rebuildNoopJson.cleanSkipped === true || rebuildNoopJson.ok !== undefined),
        JSON.stringify(rebuildNoopJson).slice(0, 200)
      );

      const buildNoRoot = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: path.join(ROOT, 'missing') } });
      check('main: build on a non-project dir is a structured three-file-contract error', buildNoRoot.result.isError === true && resultJson(buildNoRoot).error.includes('not a legal MRS project'), JSON.stringify(resultJson(buildNoRoot)));

      // poisoned metadata: a config name with path separators must be refused
      // before any path is composed from it (L2 review hardening)
      const badProj = makeProject('projbad');
      fs.writeFileSync(
        path.join(badProj, '.cproject'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj/../../evil">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n' +
          '<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n' +
          '</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
      );
      const buildBad = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: badProj, mrsInstallPath: FAKE } });
      check('main: a traversal config name is refused by the core loader before path composition', buildBad.result.isError === true && resultJson(buildBad).error.includes('unsafe configuration name'), JSON.stringify(resultJson(buildBad)));

      const buildFake = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: PROJ, mrsInstallPath: FAKE, target: 'build' } });
      const buildFakeJson = resultJson(buildFake);
      // the fake install has no bundled make: the deterministic outcome is the
      // structured no-make error; a machine with make on PATH gets a real
      // (failing gcc) run — both are well-formed tool results
      check(
        'main: build with the fake install is well-formed (structured error or a real exit code)',
        !!buildFakeJson && (buildFakeJson.error !== undefined || typeof buildFakeJson.exitCode === 'number'),
        JSON.stringify(buildFakeJson).slice(0, 200)
      );

      const unknown = await server.rpc('tools/call', { name: 'mrvc_not_a_tool', arguments: {} });
      check('main: unknown tool is a protocol-level error', !!unknown.error && unknown.error.message.includes('unknown tool'), JSON.stringify(unknown.error));

      // ---- hardware tools: the flash-verification receipt gate ----
      const { writeFlashAck } = require('../out/core/flashAck.js');
      const flashNoAck = await server.rpc('tools/call', { name: 'mrvc_flash', arguments: { root: PROJ, mrsInstallPath: FAKE } });
      check('main: flash refuses without a verified manual download', flashNoAck.result.isError === true && resultJson(flashNoAck).error.includes('flash parameters not verified'), JSON.stringify(resultJson(flashNoAck)));
      const powerNoAck = await server.rpc('tools/call', { name: 'mrvc_power_off_reset', arguments: { root: PROJ, mrsInstallPath: FAKE } });
      check('main: power-off-reset refuses without its own verified power receipt', powerNoAck.result.isError === true && resultJson(powerNoAck).error.includes('power sequence not verified'), JSON.stringify(resultJson(powerNoAck)));

      // a verified download receipts the CURRENT .template (none here -> null hash)
      check('main: receipt written by the extension-side helper', !!writeFlashAck(PROJ), 'writeFlashAck returned null');
      // the user edits the parameters afterwards -> receipt goes stale
      fs.writeFileSync(path.join(PROJ, '.template'), 'Address = 0x08000000\n');
      const flashStale = await server.rpc('tools/call', { name: 'mrvc_flash', arguments: { root: PROJ, mrsInstallPath: FAKE } });
      check('main: flash refuses after the parameters changed (stale receipt)', flashStale.result.isError === true && resultJson(flashStale).error.includes('changed after the last verified download'), JSON.stringify(resultJson(flashStale)));
      // parameters restored to the verified state -> the gate opens; the flow
      // then stops at the deterministic missing-firmware error (never built)
      fs.rmSync(path.join(PROJ, '.template'), { force: true });
      const cfgFile = path.join(ROOT, 'board-cfg', 'wch-riscv.cfg');
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
      fs.writeFileSync(cfgFile, '# test board cfg\n');
      const openocdExe = path.join(FAKE, 'resources', 'app', 'resources', 'win32', 'components', 'WCH', 'OpenOCD', 'OpenOCD', 'bin', 'openocd.exe');
      const flashFresh = await server.rpc('tools/call', { name: 'mrvc_flash', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      check('main: fresh receipt opens the gate; flow stops at missing firmware', flashFresh.result.isError === true && resultJson(flashFresh).error.includes('nothing to flash'), JSON.stringify(resultJson(flashFresh)));
      const powerFresh = await server.rpc('tools/call', { name: 'mrvc_power_off_reset', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      check(
        'main: power with only a FLASH receipt is refused (its own gate)',
        powerFresh.result.isError === true && resultJson(powerFresh).error.includes('power sequence not verified'),
        JSON.stringify(resultJson(powerFresh))
      );

      // ---- round5 P1: the power tool has its OWN receipt, written by a
      // marker-verified manual Power-Off Reset in the extension; the flash
      // receipt alone does NOT authorize rail switches ----
      const { fingerprintPowerPlan, writePowerAck } = require('../out/core/flashAck.js');
      // matching receipt (3v3 / 100ms / fixture cfg / the fake openocd) ->
      // gates open and execution is reached (the empty openocd.exe cannot
      // run, so the call ends in a spawn error, NOT a gate refusal)
      const powerMatch = await server.rpc('tools/call', { name: 'mrvc_power_off_reset', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      const pmJson = resultJson(powerMatch);
      const pmErr = (pmJson && pmJson.error) || '';
      check(
        'main: power without its own receipt still refuses (flash receipt does not carry over)',
        powerMatch.result.isError === true && pmErr.includes('power sequence not verified'),
        pmErr.slice(0, 200)
      );
      writePowerAck(PROJ, fingerprintPowerPlan({ voltage: '3v3', delayMs: 100, boardCfg: cfgFile, openocdExe }));
      const powerMatch2 = await server.rpc('tools/call', { name: 'mrvc_power_off_reset', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      const pm2Json = resultJson(powerMatch2);
      const pm2Err = (pm2Json && pm2Json.error) || '';
      check(
        'main: a matching power fingerprint passes the gate and reaches execution',
        powerMatch2.result.isError === true && !pm2Err.includes('power sequence not verified') && !pm2Err.includes('differs from the verified'),
        pm2Err.slice(0, 200)
      );
      // any deviation (here: the rail voltage) is refused with the recorded
      // plan quoted
      const powerDiff = await server.rpc('tools/call', { name: 'mrvc_power_off_reset', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile, voltage: '5v' } });
      const pdJson = resultJson(powerDiff);
      check(
        'main: a deviating rail voltage is refused with the recorded plan quoted',
        powerDiff.result.isError === true && (pdJson.error || '').includes('differs from the verified') && (pdJson.error || '').includes('recorded plan') && (pdJson.error || '').includes('voltage=3v3'),
        (pdJson.error || '').slice(0, 240)
      );

      // ---- round4 P1: the receipt must carry the FINGERPRINT of the plan
      // that ran, and the MCP plan must match it exactly ----
      const { prepareFlash } = require('../out/core/flash.js');
      const { fingerprintFlashPlan } = require('../out/core/flashAck.js');
      const objDir = path.join(PROJ, 'obj');
      fs.mkdirSync(objDir, { recursive: true });
      const hexPath = path.join(objDir, 'proj.hex');
      fs.writeFileSync(hexPath, 'not-a-real-hex\n');
      // legacy receipt (no plan) -> refusal before anything executes
      const flashLegacy = await server.rpc('tools/call', { name: 'mrvc_flash', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      check('main: a legacy receipt without a plan fingerprint is refused', flashLegacy.result.isError === true && resultJson(flashLegacy).error.includes('lacks a plan fingerprint'), JSON.stringify(resultJson(flashLegacy)));
      const plan = prepareFlash({ buildDir: objDir, address: '0x00000000', verify: true, reset: true, boardCfg: cfgFile, firmware: hexPath, eraseAll: false, banks: 1 });
      const fp = fingerprintFlashPlan({
        scriptPath: plan.scriptPath,
        firmware: hexPath,
        boardCfg: cfgFile,
        openocdExe,
        address: '0x00000000',
        verify: true,
        reset: true,
        eraseAll: false,
        banks: 1,
        powerOn: null,
      });
      writeFlashAck(PROJ, fp);
      // identical plan -> the gate opens and execution is reached (the empty
      // openocd.exe cannot run, so the call ends in a spawn error, NOT a
      // gate refusal)
      const flashMatch = await server.rpc('tools/call', { name: 'mrvc_flash', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      const fmJson = resultJson(flashMatch);
      const fmErr = (fmJson && fmJson.error) || '';
      check(
        'main: a matching plan fingerprint passes the gate and reaches execution',
        flashMatch.result.isError === true && !fmErr.includes('differs from the verified') && !fmErr.includes('not verified') && !fmErr.includes('lacks a plan fingerprint'),
        fmErr.slice(0, 200)
      );
      // any deviation (here: the address) is refused with the recorded plan quoted
      const flashDiff = await server.rpc('tools/call', { name: 'mrvc_flash', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile, address: '0x08000000' } });
      const fdJson = resultJson(flashDiff);
      check(
        'main: a deviating address is refused with the recorded plan quoted',
        flashDiff.result.isError === true && (fdJson.error || '').includes('differs from the verified') && (fdJson.error || '').includes('recorded plan'),
        (fdJson.error || '').slice(0, 240)
      );

      // ---- round6: corrupt receipts and machine binding ----
      const receiptPath = path.join(PROJ, '.vscode', 'mrvc', 'flash-verified.json');
      fs.writeFileSync(receiptPath, JSON.stringify({ time: 'now', templateHash: null, plan: {} }), 'utf-8');
      const flashCorrupt = await server.rpc('tools/call', { name: 'mrvc_flash', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      check(
        'main: a corrupt flash receipt reports corruption (not an internal error)',
        flashCorrupt.result.isError === true && resultJson(flashCorrupt).error.includes('corrupt or from an incompatible version'),
        JSON.stringify(resultJson(flashCorrupt))
      );
      // machine binding: a receipt copied with the project is unverified here
      writeFlashAck(PROJ, fp);
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      receipt.machine = 'deadbeef-not-this-machine';
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 1), 'utf-8');
      const flashForeign = await server.rpc('tools/call', { name: 'mrvc_flash', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      check(
        'main: a receipt from another machine is refused',
        flashForeign.result.isError === true && resultJson(flashForeign).error.includes('another machine'),
        JSON.stringify(resultJson(flashForeign))
      );
      // restore the local receipt (fingerprint tests continue below unaffected)
      writeFlashAck(PROJ, fp);
      const giPath = path.join(PROJ, '.vscode', 'mrvc', '.gitignore');
      check('main: receipt writes maintain the local .gitignore (never committed)', fs.existsSync(giPath), '');
      const giNow = fs.readFileSync(giPath, 'utf8');
      check('main: gitignore lists both receipt names', giNow.includes('flash-verified.json') && giNow.includes('power-verified.json'), giNow);
      // round7 P3.2: an existing user entry SURVIVES and missing entries are
      // appended without duplicates
      fs.writeFileSync(giPath, 'user-entry.txt\n', 'utf-8');
      writeFlashAck(PROJ, fp);
      const giAfter = fs.readFileSync(giPath, 'utf8');
      const giLines = giAfter
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l);
      check(
        'main: gitignore append preserves user entries and adds both names',
        giLines.includes('user-entry.txt') && giLines.includes('flash-verified.json') && giLines.includes('power-verified.json') && giLines.filter((l) => l === 'flash-verified.json').length === 1,
        giAfter
      );
      // a corrupt POWER receipt reports corruption through its own gate
      fs.writeFileSync(
        path.join(PROJ, '.vscode', 'mrvc', 'power-verified.json'),
        JSON.stringify({ time: 'now', plan: { voltage: '3v3' } }),
        'utf-8'
      );
      const powerCorrupt2 = await server.rpc('tools/call', { name: 'mrvc_power_off_reset', arguments: { root: PROJ, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      check(
        'main: a corrupt power receipt reports corruption (not an internal error)',
        powerCorrupt2.result.isError === true && resultJson(powerCorrupt2).error.includes('corrupt or from an incompatible version'),
        JSON.stringify(resultJson(powerCorrupt2))
      );

      const noName = await server.rpc('tools/call', { arguments: {} });
      check('main: tools/call without a name is invalid params', !!noName.error && noName.error.message.includes('tool name'));

      // raw garbage line: parse error with id null, then the server carries on
      const parseErr = await new Promise((resolve) => {
        const before = server.stray.length;
        server.child.stdin.write('this is not json\n');
        server.rpc('ping').then((m) => {
          const found = server.stray.slice(before).find((x) => x.error && x.id === null && x.error.code === -32700);
          resolve({ ping: m, parseErr: found ?? null });
        });
      });
      check('main: garbage line yields a parse error and the server carries on', parseErr.ping.result && !!parseErr.parseErr, JSON.stringify(parseErr.parseErr));
    });

    // env steering: the var is set on THIS process; the child inherits it
    process.env['MRVC_MRS_INSTALL_PATH'] = FAKE;
    await withServer('env', async (server) => {
      server.notify('notifications/initialized');
      const info = await server.rpc('tools/call', { name: 'mrvc_get_install_info', arguments: {} });
      const infoJson = resultJson(info);
      check(
        'env: MRVC_MRS_INSTALL_PATH steers install resolution',
        !!infoJson && infoJson.ok === true && path.resolve(infoJson.root) === path.resolve(FAKE),
        JSON.stringify(infoJson).slice(0, 160)
      );
    });
  } finally {
    if (hadEnv) {
      process.env['MRVC_MRS_INSTALL_PATH'] = savedEnv;
    } else {
      delete process.env['MRVC_MRS_INSTALL_PATH'];
    }
    rmSyncRetry(ROOT);
  }

  // docs/tool-count drift guard (0.3.7 round3 P3.3, batch 5: 13 → 18): the
  // README's tool roster must match the TOOL_NAMES source list — a new tool
  // or a doc edit that drops the count fails here instead of drifting silently
  {
    const rootDir = path.join(__dirname, '..');
    const toolsSrc = fs.readFileSync(path.join(rootDir, 'src', 'mcp', 'tools.ts'), 'utf8');
    const m = toolsSrc.match(/export const TOOL_NAMES = \[([\s\S]*?)\] as const;/);
    const names = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
    check('docs: TOOL_NAMES declares eighteen tools', names.length === 18, String(names.length));
    // the mrvc-ai ZCode plugin wrapper's package.json is its bundle's version
    // source — the round3 strict name check knocked it down to 0.0.0; the
    // parent allowlist in server.ts must keep carrying both family names
    const serverSrc = fs.readFileSync(path.join(rootDir, 'src', 'mcp', 'server.ts'), 'utf8');
    check('docs: server version allowlist covers mrvc and the mrvc-ai wrapper', serverSrc.includes("'mrvc-ai'") && serverSrc.includes("MRVC_FAMILY_PACKAGE_NAMES"), '');
    const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
    check('docs: README names the eighteen tools', readme.includes('十八个工具'));
    check('docs: README no longer claims eight tools', !readme.includes('八工具包装'));
    check('docs: README lists the batch-5 write tools', readme.includes('mrvc_set_config_option') && readme.includes('mrvc_manage_configurations') && readme.includes('mrvc_add_linked_folder'), '');
    // the header comment drifted once already (round4 P3.1: still said
    // "TEN tools" at thirteen) — pin it to the same count
    const header = fs.readFileSync(__filename, 'utf8').slice(0, 800);
    check('docs: this test file header names the eighteen tools', /EIGHTEEN tools/.test(header) && !/THIRTEEN tools/.test(header) && !/TEN tools/.test(header));
  }

  console.log(failures ? '\n' + failures + ' FAILURES' : '\nall mcp server tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('mcpserver-test crashed:', e);
  process.exit(1);
});
