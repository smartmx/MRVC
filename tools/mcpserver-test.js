/*
 * MRVC MCP server end-to-end tests (0.3.7 → 0.3.8): spawn mcp/mcp-server.js,
 * speak the stdio JSON-RPC transport (newline-delimited), and assert the
 * protocol surface (initialize / tools/list / ping / parse errors / unknown
 * methods) plus the TWENTY-SEVEN tools against a HERMETIC fixture — a fake
 * MRS install tree (the mrsinstall-test recipe), a minimal legal project, and
 * the env-steering contract (MRVC_MRS_INSTALL_PATH inherited by the child).
 * The real install is only exercised tolerantly (get_install_info without
 * arguments must return a parseable result either way); the build tool's
 * make stage depends on the machine's PATH, so its assertion accepts the
 * structured no-make error. Hardware gates: flash requires a receipt with a
 * matching FlashPlan fingerprint; power requires its own marker-verified
 * power receipt. Config-write tools (0.3.7 batch 5) run through the guarded
 * shell: backup into .vscode/mrvc/mcp-backup/, mutation, re-parse. Batch 6
 * (0.3.8) adds the exclusion table, linked-target change, audit repair,
 * rename, C/C++ switch, the extended option fields, single-file compile
 * gates, output-dir cleanup and the two hardware helpers.
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
        'main: tools/list carries the twenty-seven tools',
        JSON.stringify(names) ===
          JSON.stringify([
            'mrvc_discover_projects',
            'mrvc_get_install_info',
            'mrvc_get_project_config',
            'mrvc_audit_project',
            'mrvc_repair_project',
            'mrvc_check_preprocessor',
            'mrvc_set_config_option',
            'mrvc_manage_configurations',
            'mrvc_set_build_exclusion',
            'mrvc_rename_project',
            'mrvc_switch_project_type',
            'mrvc_list_linked_folders',
            'mrvc_add_linked_folder',
            'mrvc_change_linked_folder_target',
            'mrvc_remove_linked_folder',
            'mrvc_build',
            'mrvc_compile_file',
            'mrvc_delete_output',
            'mrvc_stack_usage',
            'mrvc_call_analysis',
            'mrvc_get_build_log',
            'mrvc_export_cmake',
            'mrvc_generate_intellisense_db',
            'mrvc_flash',
            'mrvc_power_off_reset',
            'mrvc_set_power_output',
            'mrvc_check_wchlink_firmware',
          ]),
        names.join(',')
      );
      check('main: every tool has a description and an object schema', list.result.tools.every((t) => typeof t.description === 'string' && t.description.length > 0 && t.inputSchema && t.inputSchema.type === 'object'));
      const schemaByName = Object.fromEntries(list.result.tools.map((t) => [t.name, t.inputSchema]));
      const fieldEnum = schemaByName.mrvc_set_config_option?.properties?.field?.enum;
      check(
        'main: set_config_option schema field enum matches the handler tables (18 fields)',
        Array.isArray(fieldEnum) && fieldEnum.length === 18 && fieldEnum.includes('artifactName') && fieldEnum.includes('gcSections') && fieldEnum.includes('cppDialect'),
        JSON.stringify(fieldEnum)
      );
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
        'main: write tools expose field/action enums (0.3.7 batch 5 + 0.3.8 batch 6)',
        Array.isArray(schemaByName.mrvc_set_config_option.properties.field.enum) && schemaByName.mrvc_set_config_option.properties.field.enum.length === 18 &&
          JSON.stringify(schemaByName.mrvc_set_config_option.properties.language.enum) === JSON.stringify(['both', 'c', 'cpp', 'asm']) &&
          JSON.stringify(schemaByName.mrvc_manage_configurations.properties.action.enum) === JSON.stringify(['list', 'add', 'rename', 'delete', 'setActive']) &&
          JSON.stringify(schemaByName.mrvc_set_build_exclusion.properties.action.enum) === JSON.stringify(['exclude', 'include', 'check']) &&
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
      // v0.3.8 review M7: the refusal offers the headless self-service repair
      check('main: the stale refusal offers mrvc_repair_project', (resultJson(staleBuild).error || '').includes('mrvc_repair_project'), '');
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
      // v0.3.8 review M7: requireLinkedTargets exempts EXCLUDED links (root
      // token, no paired named entry) — their missing targets must not block,
      // same semantics as the scan gate
      fs.writeFileSync(
        path.join(projStale, '.project'),
        '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projstale</name><linkedResources><link><name>OldLink</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/gone-lib</locationURI></link></linkedResources></projectDescription>'
      );
      fs.writeFileSync(
        path.join(projStale, '.cproject'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry excluding="OldLink" flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
      );
      const staleExempt = await server.rpc('tools/call', { name: 'mrvc_build', arguments: { root: projStale, target: 'build', mrsInstallPath: FAKE } });
      check(
        'main: an EXCLUDED stale link does not block the MCP build (exemption parity with the scan gate)',
        !(resultJson(staleExempt).error || '').includes('stale linked folder'),
        JSON.stringify(resultJson(staleExempt)).slice(0, 220)
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
      check('main: fresh receipt opens the gate; flow stops at the missing-firmware gate', flashFresh.result.isError === true && /firmware image not found/.test(resultJson(flashFresh).error || ''), JSON.stringify(resultJson(flashFresh)));
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

      // ---- v0.3.8 review H2: mrvc_set_power_output binds to the receipt's
      // OWN rail (a 3.3V receipt never authorizes 5V) and to the receipt's
      // openocd binary + board cfg ----
      const rail5v = await server.rpc('tools/call', { name: 'mrvc_set_power_output', arguments: { root: PROJ, rail: '5v', mrsInstallPath: FAKE } });
      check(
        'power-rail: a 3.3V receipt never authorizes a 5V switch',
        rail5v.result.isError === true && /recorded at 3v3/.test(resultJson(rail5v).error || ''),
        JSON.stringify(resultJson(rail5v)).slice(0, 220)
      );
      const railBin = await server.rpc('tools/call', {
        name: 'mrvc_set_power_output',
        arguments: { root: PROJ, rail: '3v3', mrsInstallPath: FAKE, openocdPath: path.join(ROOT, 'evil-openocd.exe') },
      });
      check(
        'power-rail: a deviating openocdPath is refused (bound to the verified plan)',
        railBin.result.isError === true && /differs from the verified one/.test(resultJson(railBin).error || ''),
        JSON.stringify(resultJson(railBin)).slice(0, 220)
      );
      const railOk = await server.rpc('tools/call', { name: 'mrvc_set_power_output', arguments: { root: PROJ, rail: '3v3', mrsInstallPath: FAKE, openocdCfg: cfgFile } });
      // gate passes at the recorded rail → execution reached → the empty fake
      // openocd cannot run — the error is a spawn failure, NOT a gate refusal
      check(
        'power-rail: the recorded rail passes the gate (execution error, not a refusal)',
        railOk.result.isError === true && !/recorded at|differs from the verified/.test(resultJson(railOk).error || ''),
        JSON.stringify(resultJson(railOk)).slice(0, 220)
      );
      // re-review #1: the board cfg CONTENT is hashed too — a .cfg tampered
      // after the manual verification is caught by the rail tool as well
      fs.writeFileSync(cfgFile, '# tampered\n');
      const railTampered = await server.rpc('tools/call', {
        name: 'mrvc_set_power_output',
        arguments: { root: PROJ, rail: '3v3', mrsInstallPath: FAKE, openocdCfg: cfgFile },
      });
      check(
        'power-rail: a board cfg tampered after verification is refused (content hash)',
        railTampered.result.isError === true && /differs from the verified one/.test(resultJson(railTampered).error || ''),
        JSON.stringify(resultJson(railTampered)).slice(0, 220)
      );
      fs.writeFileSync(cfgFile, '# test board cfg\n');

      // ---- round4 P1: the receipt must carry the FINGERPRINT of the plan
      // that ran, and the MCP plan must match it exactly ----
      const { prepareFlash } = require('../out/core/flash.js');
      const { fingerprintFlashPlan } = require('../out/core/flashAck.js');
      const objDir = path.join(PROJ, 'obj');
      fs.mkdirSync(objDir, { recursive: true });
      const hexPath = path.join(objDir, 'proj.hex');
      // a VALID minimal Intel HEX record + EOF — the shared prepareFlash
      // gate (round3) verifies records and checksums for both entries
      fs.writeFileSync(hexPath, ':0400000021436587AC\n:00000001FF\n');
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

      // -- round2 P2: the DEFAULT firmware follows the PREFIXED image --
      // with outputPrefix `boot_` on the linker tool and BOTH images on
      // disk, the resolved firmware must be the prefixed one (the current
      // build's output), not the stale prefix-less file beside it
      {
        const projFix = inside(ROOT, 'ws/projfix');
        fs.mkdirSync(path.join(projFix, 'src'), { recursive: true });
        fs.writeFileSync(path.join(projFix, 'src', 'main.c'), 'int main(){return 0;}\n');
        fs.writeFileSync(path.join(projFix, 'projfix.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
        fs.writeFileSync(path.join(projFix, '.project'), '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projfix</name></projectDescription>');
        fs.writeFileSync(
          path.join(projFix, '.cproject'),
          '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n' +
            '<tool superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.tool.c.linker" outputPrefix="boot_"/>\n' +
            '<sourceEntries>\n<entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
        );
        // no .template: the default-candidate order engages only without an
        // explicit Target Path
        const fixObj = path.join(projFix, 'obj');
        fs.mkdirSync(fixObj, { recursive: true });
        fs.writeFileSync(path.join(fixObj, 'boot_projfix.hex'), ':0400000021436587AC\n:00000001FF\n');
        fs.writeFileSync(path.join(fixObj, 'projfix.hex'), 'stale-legacy\n');
        const planFix = prepareFlash({ buildDir: fixObj, address: '0x00000000', verify: true, reset: true, boardCfg: cfgFile, firmware: path.join(fixObj, 'boot_projfix.hex'), eraseAll: false, banks: 1 });
        const fpFix = fingerprintFlashPlan({
          scriptPath: planFix.scriptPath,
          firmware: path.join(fixObj, 'boot_projfix.hex'),
          boardCfg: cfgFile,
          openocdExe,
          address: '0x00000000',
          verify: true,
          reset: true,
          eraseAll: false,
          banks: 1,
          powerOn: null,
        });
        writeFlashAck(projFix, fpFix);
        const flashFix = await server.rpc('tools/call', { name: 'mrvc_flash', arguments: { root: projFix, mrsInstallPath: FAKE, openocdCfg: cfgFile } });
        const fixJson = resultJson(flashFix);
        // the discriminator: resolving the PREFIXED image reproduces the
        // recorded fingerprint (gate opens, execution reached — the empty
        // openocd.exe cannot run, hence the spawn error); resolving the
        // STALE legacy file would have produced the fingerprint refusal
        check(
          'main: default firmware resolves to the PREFIXED image (not the stale legacy file)',
          flashFix.result.isError === true && /^spawn /.test(fixJson.error || '') && !(fixJson.error || '').includes('differs from the verified'),
          JSON.stringify(fixJson).slice(0, 300)
        );
        // -- round4/round5 P2: products follow the GENERATOR's set — the
        // configured main extension plus the enabled secondaries; single-
        // format images are legitimate and missing entries are null-size,
        // never ENOENT. productsFor lives in core (shared with the
        // generator's naming) — assert it directly.
        fs.writeFileSync(path.join(fixObj, 'boot_projfix.elf'), 'elf\n');
        const { productsFor } = require('../out/core/makefile.js');
        const prods = productsFor(
          { artifactType: 'exe', targetName: 'projfix', outputPrefix: 'boot_', artifactExtension: 'elf', createFlash: true, createListing: false },
          fixObj,
          ['hex']
        );
        const pNames = prods.map((p) => ({ f: path.basename(p.file), s: p.size }));
        check(
          'main: products follow the generator set (main ext + enabled secondaries), null size for missing — never ENOENT',
          pNames.some((p) => p.f === 'boot_projfix.elf' && p.s === 4) &&
            pNames.some((p) => p.f === 'boot_projfix.hex' && p.s !== null && p.s > 0) &&
            pNames.length === 2 &&
            !pNames.some((p) => p.f === 'boot_projfix.bin' || p.f === 'projfix.hex' || p.f === 'projfix.elf' || p.f === 'projfix.bin'),
          JSON.stringify(pNames)
        );
        // custom artifact extension (round5 P2): the main product follows it
        const prodsAxf = productsFor(
          { artifactType: 'exe', targetName: 'projfix', outputPrefix: 'boot_', artifactExtension: 'axf', createFlash: true, createListing: false },
          fixObj,
          ['hex']
        ).map((p) => ({ f: path.basename(p.file), s: p.size }));
        check(
          'main: a custom artifactExtension names the main product (boot_projfix.axf)',
          prodsAxf.some((p) => p.f === 'boot_projfix.axf' && p.s === null) && prodsAxf.length === 2,
          JSON.stringify(prodsAxf)
        );
        // round6 P2: a staticLib archives .a REGARDLESS of artifactExtension
        // (the ar recipe's actual output — type-switch projects previously
        // got a main-build rule naming .elf with no recipe for it)
        const prodsLib = productsFor(
          { artifactType: 'staticLib', targetName: 'projfix', outputPrefix: 'boot_', artifactExtension: 'elf', createFlash: false, createListing: false },
          fixObj,
          []
        ).map((p) => ({ f: path.basename(p.file), s: p.size }));
        check(
          'main: a staticLib product is named .a even when artifactExtension says elf',
          prodsLib.length === 1 && prodsLib[0].f === 'boot_projfix.a' && prodsLib[0].s === null,
          JSON.stringify(prodsLib)
        );
      }

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

    // ================= 0.3.8 batch 6: nine new tools =================

    // -- mrvc_set_build_exclusion --
    const projExcl = makeProject('projexcl');
    const exclCheck0 = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projExcl, path: 'src/keep.c', action: 'check' } }));
    check(
      'excl: check on a fresh project reports not-excluded with an empty table',
      !!exclCheck0 && exclCheck0.ok === true && exclCheck0.excluded === false && Array.isArray(exclCheck0.rootTokens) && exclCheck0.rootTokens.length === 0,
      JSON.stringify(exclCheck0).slice(0, 200)
    );
    const exclDo = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projExcl, path: 'src/keep.c', action: 'exclude' } }));
    const exclDoTxt = fs.readFileSync(path.join(projExcl, '.cproject'), 'utf8');
    check(
      'excl: excluding a file writes its logic path as the root token',
      !!exclDo && exclDo.ok === true && exclDo.excludedNow === true && exclDoTxt.includes('excluding="src/keep.c"'),
      JSON.stringify(exclDo).slice(0, 160) + ' | ' + exclDoTxt.slice(0, 160)
    );
    const exclInc = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projExcl, path: 'src/keep.c', action: 'include' } }));
    const exclIncTxt = fs.readFileSync(path.join(projExcl, '.cproject'), 'utf8');
    check(
      'excl: including strips the token (emptied list stays, MRS style)',
      !!exclInc && exclInc.ok === true && exclInc.excludedNow === false && exclIncTxt.includes('excluding=""'),
      JSON.stringify(exclInc).slice(0, 160) + ' | ' + exclIncTxt.slice(0, 160)
    );
    // linked-folder marker semantics: root token + named entry = the CDT
    // re-include marker; excluding must REMOVE the named entry, include must
    // re-create it
    const projExcl2 = makeProject('projexcl2');
    fs.mkdirSync(path.join(ROOT, 'ws', 'excl-target'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'ws', 'excl-target', 'x.c'), 'int x(){return 1;}\n');
    fs.writeFileSync(
      path.join(projExcl2, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projexcl2</name><linkedResources><link><name>SharedX</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/excl-target</locationURI></link></linkedResources></projectDescription>'
    );
    fs.writeFileSync(
      path.join(projExcl2, '.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n<sourceEntries>\n<entry excluding="SharedX" flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/>\n<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="SharedX"/>\n</sourceEntries>\n</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
    );
    const exclLink = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projExcl2, path: 'SharedX', action: 'exclude' } }));
    const exclLinkTxt = fs.readFileSync(path.join(projExcl2, '.cproject'), 'utf8');
    check(
      'excl: excluding a linked folder removes its named entry (marker becomes a real exclusion)',
      !!exclLink && exclLink.ok === true && exclLink.excludedNow === true && !exclLinkTxt.includes('kind="sourcePath" name="SharedX"') && exclLinkTxt.includes('excluding="SharedX"'),
      JSON.stringify(exclLink).slice(0, 160) + ' | ' + exclLinkTxt.slice(0, 240)
    );
    const inclLink = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projExcl2, path: 'SharedX', action: 'include' } }));
    const inclLinkTxt = fs.readFileSync(path.join(projExcl2, '.cproject'), 'utf8');
    check(
      'excl: re-including re-creates the named sourceEntry',
      !!inclLink && inclLink.ok === true && inclLink.excludedNow === false && inclLinkTxt.includes('kind="sourcePath" name="SharedX"'),
      JSON.stringify(inclLink).slice(0, 160) + ' | ' + inclLinkTxt.slice(0, 240)
    );
    const exclBad1 = await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projExcl, path: '../outside.c', action: 'exclude' } });
    check('excl: a .. escape is refused', exclBad1.result.isError === true && (resultJson(exclBad1).error || '').includes('project-relative'), JSON.stringify(resultJson(exclBad1)));
    const exclBad2 = await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projExcl, path: 'ghost/nope.c', action: 'exclude' } });
    check('excl: a path that exists nowhere is refused', exclBad2.result.isError === true && (resultJson(exclBad2).error || '').includes('no such file'), JSON.stringify(resultJson(exclBad2)));

    // -- mrvc_change_linked_folder_target --
    const projChg = makeProject('projchg');
    fs.mkdirSync(path.join(ROOT, 'ws', 'chg-a'), { recursive: true });
    fs.mkdirSync(path.join(ROOT, 'ws', 'chg-b'), { recursive: true });
    fs.writeFileSync(path.join(projChg, '.project'), '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projchg</name><linkedResources><link><name>ChgLink</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/chg-a</locationURI></link></linkedResources></projectDescription>');
    const chgDo = resultJson(
      await server.rpc('tools/call', { name: 'mrvc_change_linked_folder_target', arguments: { root: projChg, name: 'ChgLink', newTarget: path.join(ROOT, 'ws', 'chg-b') } })
    );
    const chgTxt = fs.readFileSync(path.join(projChg, '.project'), 'utf8');
    check(
      'chg: re-targeting rewrites the locationURI in the PARENT-N form',
      !!chgDo && chgDo.ok === true && chgDo.locationUri === 'PARENT-1-PROJECT_LOC/chg-b' && chgTxt.includes('PARENT-1-PROJECT_LOC/chg-b'),
      JSON.stringify(chgDo).slice(0, 200) + ' | ' + chgTxt.slice(0, 200)
    );
    const chgCase = resultJson(
      await server.rpc('tools/call', { name: 'mrvc_change_linked_folder_target', arguments: { root: projChg, name: 'chglink', newTarget: path.join(ROOT, 'ws', 'chg-a') } })
    );
    check(
      'chg: a case-variant link name resolves to the canonical one',
      !!chgCase && chgCase.ok === true && chgCase.name === 'ChgLink',
      JSON.stringify(chgCase).slice(0, 160)
    );
    const chgUnknown = await server.rpc('tools/call', { name: 'mrvc_change_linked_folder_target', arguments: { root: projChg, name: 'Nope', newTarget: path.join(ROOT, 'ws', 'chg-b') } });
    check('chg: an unknown link name is refused', chgUnknown.result.isError === true && (resultJson(chgUnknown).error || '').includes('no linked folder'), JSON.stringify(resultJson(chgUnknown)));
    const chgSelf = await server.rpc('tools/call', { name: 'mrvc_change_linked_folder_target', arguments: { root: projChg, name: 'ChgLink', newTarget: projChg } });
    check('chg: a target at the project root is refused (safe-target)', chgSelf.result.isError === true && /project root/i.test(resultJson(chgSelf).error || ''), JSON.stringify(resultJson(chgSelf)));

    // -- mrvc_repair_project --
    const projFix = makeProject('projfix');
    // the repair candidate sits OUTSIDE the project so the fixed URI takes the
    // PARENT-N-PROJECT_LOC macro form (an in-project candidate would store a
    // plain relative URI)
    fs.mkdirSync(path.join(ROOT, 'ws', 'fix-shared', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(projFix, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projfix</name><linkedResources>' +
        '<link><name>OldLink</name><type>2</type><locationURI>C:/build-machine/work/fix-shared/lib</locationURI></link>' +
        '<link><name>Ghost</name><type>2</type><locationURI>C:/build-machine/work/never/nobody</locationURI></link>' +
        '</linkedResources></projectDescription>'
    );
    fs.writeFileSync(
      path.join(projFix, '.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n' +
        '<option id="ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.rvGcc.42" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.rvGcc" valueType="enumerated"/>\n' +
        '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries>\n' +
        '</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
    );
    const fixBefore = resultJson(await server.rpc('tools/call', { name: 'mrvc_audit_project', arguments: { root: projFix } }));
    check('fix: audit sees the fixable enum finding first', !!fixBefore && fixBefore.fixableCount >= 1 && fixBefore.findings.some((f) => f.code === 'enum-value-missing'), JSON.stringify(fixBefore).slice(0, 220));
    const fixDo = resultJson(await server.rpc('tools/call', { name: 'mrvc_repair_project', arguments: { root: projFix, includeStaleLinks: true } }));
    const fixTxt = fs.readFileSync(path.join(projFix, '.cproject'), 'utf8');
    const fixProjTxt = fs.readFileSync(path.join(projFix, '.project'), 'utf8');
    check(
      'fix: the value-less enum option is removed and the resolvable stale link re-pointed',
      !!fixDo && fixDo.ok === true && fixDo.repaired.length >= 1 && !fixTxt.includes('rvGcc.42') && fixDo.staleLinksRepaired === 1 && fixProjTxt.includes('PARENT-1-PROJECT_LOC/fix-shared/lib'),
      JSON.stringify(fixDo).slice(0, 900) + ' | ' + fixProjTxt.slice(0, 160)
    );
    check(
      'fix: the unresolvable stale link is reported, not invented',
      Array.isArray(fixDo.staleLinksRemaining) && fixDo.staleLinksRemaining.length === 1 && fixDo.staleLinksRemaining[0].name === 'Ghost',
      JSON.stringify(fixDo.staleLinksRemaining)
    );
    // v0.3.8 review H4: a no-op repair must not leave a backup directory
    const projFixNone = makeProject('projfixnone');
    const fixNoop = resultJson(await server.rpc('tools/call', { name: 'mrvc_repair_project', arguments: { root: projFixNone } }));
    check(
      'fix: a no-op repair takes no backup',
      !!fixNoop && fixNoop.ok === true && fixNoop.fixableCount === 0 && typeof fixNoop.note === 'string' && fixNoop.note.includes('no backup') && fixNoop.backupDir === undefined,
      JSON.stringify(fixNoop).slice(0, 220)
    );
    // re-review #3: only-UNRESOLVABLE stale links stay reported, also without
    // a backup (the planner reports them, it never invents candidates)
    const projFixGhost = makeProject('projfixghost');
    fs.writeFileSync(
      path.join(projFixGhost, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projfixghost</name><linkedResources><link><name>Ghost</name><type>2</type><locationURI>C:/build-machine/work/never/nobody</locationURI></link></linkedResources></projectDescription>'
    );
    const fixGhost = resultJson(await server.rpc('tools/call', { name: 'mrvc_repair_project', arguments: { root: projFixGhost, includeStaleLinks: true } }));
    check(
      'fix: only-unresolvable stale links stay reported without a backup',
      !!fixGhost && fixGhost.ok === true && fixGhost.backupDir === undefined && typeof fixGhost.note === 'string' && fixGhost.note.includes('no backup') && Array.isArray(fixGhost.staleLinksRemaining) && fixGhost.staleLinksRemaining.length === 1 && fixGhost.staleLinksRemaining[0].name === 'Ghost',
      JSON.stringify(fixGhost).slice(0, 220)
    );

    // -- mrvc_rename_project --
    const projRen = makeProject('projren');
    fs.writeFileSync(
      path.join(projRen, 'projren.launch'),
      '<launchConfiguration type="cdt.launch.application"><stringAttribute key="org.eclipse.cdt.launch.PROGRAM_NAME" value="projren.elf"/>' +
        '<stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="projren"/>' +
        '<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_PATHS"><listEntry value="/projren/src/keep.c"/></listAttribute></launchConfiguration>'
    );
    const renDo = resultJson(await server.rpc('tools/call', { name: 'mrvc_rename_project', arguments: { root: projRen, newName: 'projren2' } }));
    const renLaunch = fs.existsSync(path.join(projRen, 'projren2.launch')) ? fs.readFileSync(path.join(projRen, 'projren2.launch'), 'utf8') : '';
    check(
      'ren: .project, .wvproj marker and .launch all follow the new name',
      !!renDo && renDo.ok === true && renDo.oldName === 'projren' && fs.existsSync(path.join(projRen, 'projren2.wvproj')) &&
        !fs.existsSync(path.join(projRen, 'projren.wvproj')) && !!renLaunch && renLaunch.includes('value="projren2.elf"') && renLaunch.includes('/projren2/src/keep.c'),
      JSON.stringify(renDo).slice(0, 200) + ' | ' + renLaunch.slice(0, 200)
    );
    const renProjTxt = fs.readFileSync(path.join(projRen, '.project'), 'utf8');
    check('ren: the .project display name is the new one', renProjTxt.includes('<name>projren2</name>'), renProjTxt.slice(0, 160));
    const renBad = await server.rpc('tools/call', { name: 'mrvc_rename_project', arguments: { root: projRen, newName: 'a/b' } });
    check('ren: a name with a separator is refused', renBad.result.isError === true && (resultJson(renBad).error || '').includes('single safe path segment'), JSON.stringify(resultJson(renBad)));
    const renSame = resultJson(await server.rpc('tools/call', { name: 'mrvc_rename_project', arguments: { root: projRen, newName: 'projren2' } }));
    check('ren: renaming to the SAME name is a no-op', !!renSame && renSame.ok === true && renSame.changed === false, JSON.stringify(renSame).slice(0, 160));
    const renDev = await server.rpc('tools/call', { name: 'mrvc_rename_project', arguments: { root: projRen, newName: 'CON' } });
    check('ren: a Windows device name is refused', renDev.result.isError === true && /single safe path segment/.test(resultJson(renDev).error || ''), JSON.stringify(resultJson(renDev)));

    // -- round27 P2-3: EVERY .launch migrates, non-project-named launches keep
    //    their filename --
    const projRen3 = makeProject('projren3');
    const launchXmlFor = (n) =>
      '<launchConfiguration type="cdt.launch.application"><stringAttribute key="org.eclipse.cdt.launch.PROGRAM_NAME" value="obj/' + n + '.elf"/>' +
      '<stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="projren3"/>' +
      '<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_PATHS"><listEntry value="/projren3/src/keep.c"/></listAttribute></launchConfiguration>';
    fs.writeFileSync(path.join(projRen3, 'projren3.launch'), launchXmlFor('projren3'));
    fs.writeFileSync(path.join(projRen3, 'Debug.launch'), launchXmlFor('projren3'));
    const renDo3 = resultJson(await server.rpc('tools/call', { name: 'mrvc_rename_project', arguments: { root: projRen3, newName: 'projren4' } }));
    const named3 = fs.existsSync(path.join(projRen3, 'projren4.launch')) ? fs.readFileSync(path.join(projRen3, 'projren4.launch'), 'utf8') : '';
    const debug3 = fs.existsSync(path.join(projRen3, 'Debug.launch')) ? fs.readFileSync(path.join(projRen3, 'Debug.launch'), 'utf8') : '';
    check(
      'ren: both .launch files migrate — project-named follows the rename, the other keeps its filename',
      !!renDo3 && renDo3.ok === true && !!named3 && named3.includes('value="projren4"') && named3.includes('obj/projren4.elf') &&
        fs.existsSync(path.join(projRen3, 'Debug.launch')) && debug3.includes('value="projren4"') && debug3.includes('obj/projren4.elf') &&
        !debug3.includes('projren3'),
      JSON.stringify(renDo3).slice(0, 160) + ' | debug:' + debug3.slice(0, 200)
    );

    // -- round28 P2-1: a custom-launch-ONLY project (no <oldName>.launch)
    //    renames fine — no New.launch is demanded, attrs still migrate --
    const projRen5 = makeProject('projren5');
    const customXml = (marker) =>
      '<launchConfiguration type="cdt.launch.application"><stringAttribute key="org.eclipse.cdt.launch.PROGRAM_NAME" value="obj/' + marker + '.elf"/>' +
      '<stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="projren5"/>' +
      '<stringAttribute key="marker" value="' + marker + '"/>' +
      '<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_PATHS"><listEntry value="/projren5/src/keep.c"/></listAttribute></launchConfiguration>';
    fs.writeFileSync(path.join(projRen5, 'a.launch'), customXml('A'));
    fs.writeFileSync(path.join(projRen5, 'b.launch'), customXml('B'));
    const renDo5 = resultJson(await server.rpc('tools/call', { name: 'mrvc_rename_project', arguments: { root: projRen5, newName: 'projren6' } }));
    const a5 = fs.readFileSync(path.join(projRen5, 'a.launch'), 'utf8');
    const b5 = fs.readFileSync(path.join(projRen5, 'b.launch'), 'utf8');
    check(
      'ren: custom-launch-only project renames WITHOUT a false New.launch failure (round28 P2-1)',
      !!renDo5 && renDo5.ok === true && renDo5.oldName === 'projren5' &&
        a5.includes('value="projren6"') && a5.includes('obj/projren6.elf') &&
        b5.includes('value="projren6"') && b5.includes('marker') && b5.includes('B'),
      JSON.stringify(renDo5).slice(0, 160) + ' | a:' + a5.slice(0, 120) + ' | b:' + b5.slice(0, 120)
    );
    check(
      'ren: no phantom <newName>.launch is invented for custom-launch projects',
      !fs.existsSync(path.join(projRen5, 'projren6.launch')),
      'a launch file was invented'
    );

    // -- round29 P2: a launch already carrying the NEW name must never be
    //    silently overwritten — the MCP transaction refuses with ZERO writes
    //    (the core precheck throws before any write; backups restore as-is)
    const projRen7 = makeProject('projren7');
    const collXml = (marker) =>
      '<launchConfiguration type="cdt.launch.application"><stringAttribute key="org.eclipse.cdt.launch.PROGRAM_NAME" value="obj/' + marker + '.elf"/>' +
      '<stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="projren7"/>' +
      '<stringAttribute key="marker" value="' + marker + '"/>' +
      '<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_PATHS"><listEntry value="/projren7/src/keep.c"/></listAttribute></launchConfiguration>';
    fs.writeFileSync(path.join(projRen7, 'projren7.launch'), collXml('OLD'));
    fs.writeFileSync(path.join(projRen7, 'projren8.launch'), collXml('USER_NEW'));
    const before7 = {
      old: fs.readFileSync(path.join(projRen7, 'projren7.launch')),
      user: fs.readFileSync(path.join(projRen7, 'projren8.launch')),
      project: fs.readFileSync(path.join(projRen7, '.project')),
    };
    const renColl = await server.rpc('tools/call', { name: 'mrvc_rename_project', arguments: { root: projRen7, newName: 'projren8' } });
    check(
      'ren: target launch already exists -> refused, no overwrite (round29 P2)',
      renColl.result.isError === true && /already exists/.test(resultJson(renColl).error || ''),
      JSON.stringify(resultJson(renColl)).slice(0, 200)
    );
    check(
      'ren: collision refusal left every file byte-identical',
      fs.readFileSync(path.join(projRen7, 'projren7.launch')).equals(before7.old) &&
        fs.readFileSync(path.join(projRen7, 'projren8.launch')).equals(before7.user) &&
        fs.readFileSync(path.join(projRen7, '.project')).equals(before7.project) &&
        !fs.existsSync(path.join(projRen7, 'projren8.wvproj')) &&
        fs.existsSync(path.join(projRen7, 'projren7.wvproj')),
      'a file was modified by the refused rename'
    );

    // -- round27 P2-1: a write tool must NOT auto-repair an UNRELATED stale
    //    linked folder (that is mrvc_repair_project's explicit job) --
    const projPure = makeProject('projpure');
    fs.mkdirSync(path.join(ROOT, 'Shared'), { recursive: true }); // the stale fix target EXISTS
    fs.mkdirSync(path.join(ROOT, 'ws', 'othera'), { recursive: true });
    fs.writeFileSync(
      path.join(projPure, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projpure</name><linkedResources>' +
        '<link><name>Stale</name><type>2</type><location>Z:/old/EXAM/Shared</location></link>' +
        '<link><name>Other</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/othera</locationURI></link>' +
        '</linkedResources></projectDescription>'
    );
    const pureChg = resultJson(
      await server.rpc('tools/call', { name: 'mrvc_change_linked_folder_target', arguments: { root: projPure, name: 'Other', newTarget: path.join(ROOT, 'ws', 'otherb') } })
    );
    fs.mkdirSync(path.join(ROOT, 'ws', 'otherb'), { recursive: true });
    const pureTxt = fs.readFileSync(path.join(projPure, '.project'), 'utf8');
    check(
      'pure: re-pointing Other leaves the fixable stale link untouched (no rider repair)',
      !!pureChg && pureChg.ok === true && pureTxt.includes('Z:/old/EXAM/Shared') && !pureTxt.includes('PARENT-1-PROJECT_LOC/Shared') && pureTxt.includes('otherb'),
      JSON.stringify(pureChg).slice(0, 160) + ' | ' + pureTxt.slice(0, 260)
    );

    // -- mrvc_switch_project_type --
    const projType = makeProject('projtype');
    // the nature toggle needs a <natures> block, and the C++ inputType lands
    // under the NAMED "GNU RISC-V Cross C++ Compiler" tool — real EVT projects
    // carry both
    fs.writeFileSync(
      path.join(projType, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projtype</name><natures><nature>org.eclipse.cdt.core.cnature</nature></natures></projectDescription>'
    );
    fs.writeFileSync(
      path.join(projType, '.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n' +
        '<tool name="GNU RISC-V Cross C++ Compiler" id="ilg.gnumcueclipse.managedbuild.cross.riscv.tool.cpp.compiler.1" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.tool.cpp.compiler"/>\n' +
        '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries>\n' +
        '</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
    );
    const typeOn = resultJson(await server.rpc('tools/call', { name: 'mrvc_switch_project_type', arguments: { root: projType, cpp: true } }));
    const typeProjTxt = fs.readFileSync(path.join(projType, '.project'), 'utf8');
    const typeCTxt = fs.readFileSync(path.join(projType, '.cproject'), 'utf8');
    check(
      'type: to C++ writes the ccnature and the cpp compiler inputType',
      !!typeOn && typeOn.ok === true && typeOn.changed === true && typeProjTxt.includes('org.eclipse.cdt.core.ccnature') && typeCTxt.includes('cpp.compiler.input'),
      JSON.stringify(typeOn).slice(0, 160) + ' | natures:' + typeProjTxt.slice(0, 120)
    );
    const typeAgain = resultJson(await server.rpc('tools/call', { name: 'mrvc_switch_project_type', arguments: { root: projType, cpp: true } }));
    check('type: a same-mode call is a no-op', !!typeAgain && typeAgain.ok === true && typeAgain.changed === false, JSON.stringify(typeAgain));
    const typeOff = resultJson(await server.rpc('tools/call', { name: 'mrvc_switch_project_type', arguments: { root: projType, cpp: false } }));
    const typeOffProj = fs.readFileSync(path.join(projType, '.project'), 'utf8');
    const typeOffC = fs.readFileSync(path.join(projType, '.cproject'), 'utf8');
    check(
      'type: back to C removes the nature and the cpp inputType',
      !!typeOff && typeOff.ok === true && typeOff.changed === true && !typeOffProj.includes('ccnature') && !typeOffC.includes('cpp.compiler.input'),
      JSON.stringify(typeOff).slice(0, 160)
    );

    // -- round27 P2-2: the conversion covers EVERY configuration --
    const projType2 = makeProject('projtype2');
    const OPT = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
    const cfgBlock = (n, inc) =>
      '<cconfiguration id="c' + n + '" name="' + n + '"><folderInfo><toolChain>' +
      '<option id="inc' + n + '" superClass="' + OPT + 'c.compiler.include.paths" valueType="includePath">' +
      '<listOptionValue builtIn="false" value="&quot;${workspace_loc:/${ProjName}/inc' + n + '}&quot;"/></option>' +
      '<tool name="GNU RISC-V Cross C++ Compiler" id="cpp' + n + '" superClass="' + OPT + 'tool.cpp.compiler"/>' +
      '</toolChain></folderInfo></cconfiguration>';
    fs.writeFileSync(
      path.join(projType2, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projtype2</name><natures><nature>org.eclipse.cdt.core.cnature</nature></natures></projectDescription>'
    );
    fs.writeFileSync(
      path.join(projType2, '.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n' + cfgBlock('obj', 'inc0') + cfgBlock('dbg', 'inc1') + '\n</cproject>'
    );
    const type2 = resultJson(await server.rpc('tools/call', { name: 'mrvc_switch_project_type', arguments: { root: projType2, cpp: true } }));
    const type2Txt = fs.readFileSync(path.join(projType2, '.cproject'), 'utf8');
    const blocks2 = type2Txt.split('<cconfiguration').slice(1);
    check(
      'type: BOTH configurations mirror the cpp include paths (mirrored = 2)',
      !!type2 && type2.ok === true && type2.mirrored === 2 && blocks2.every((b) => b.includes('cpp.compiler.include.paths')),
      JSON.stringify(type2).slice(0, 160) + ' | twins:' + (type2Txt.match(/cpp\.compiler\.include\.paths/g) || []).length
    );
    check(
      'type: BOTH configurations gain the cpp compiler inputType',
      blocks2.length === 2 && blocks2.every((b) => b.includes('cpp.compiler.input')),
      'blocks with inputType: ' + blocks2.filter((b) => b.includes('cpp.compiler.input')).length
    );
    const type2Off = resultJson(await server.rpc('tools/call', { name: 'mrvc_switch_project_type', arguments: { root: projType2, cpp: false } }));
    const type2OffTxt = fs.readFileSync(path.join(projType2, '.cproject'), 'utf8');
    const blocks2Off = type2OffTxt.split('<cconfiguration').slice(1);
    check(
      'type: back to C removes the inputType from BOTH configurations',
      !!type2Off && type2Off.ok === true && type2Off.changed === true && blocks2Off.every((b) => !b.includes('cpp.compiler.input')),
      JSON.stringify(type2Off).slice(0, 160)
    );

    // -- mrvc_set_config_option: the extended fields --
    const projField = makeProject('projfield');
    const warnDo = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'warningsAll', value: true } }));
    const warnTxt = fs.readFileSync(path.join(projField, '.cproject'), 'utf8');
    check(
      'field: warningsAll creates the option with value true',
      !!warnDo && warnDo.ok === true && warnDo.before['warnings.allwarn'] === false && warnDo.after['warnings.allwarn'] === true && warnTxt.includes('option.warnings.allwarn') && warnTxt.includes('value="true"'),
      JSON.stringify(warnDo).slice(0, 200)
    );
    const dbgDo = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'debugInfoLevel', value: 'max' } }));
    // v0.3.8 review H3: gcSections defaults ON when absent (MRS C-linker
    // model) — the false write must materialize value="false" AND the reads
    // must report the default, not a silent false
    const gcDo = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'gcSections', value: false } }));
    const gcTxt = fs.readFileSync(path.join(projField, '.cproject'), 'utf8');
    check(
      'field: gcSections false is materialized (model-default-on option really turns off)',
      !!gcDo && gcDo.ok === true && gcDo.before['c.linker.gcsections'] === true && gcDo.after['c.linker.gcsections'] === false && /gcsections[\s\S]{0,240}?value="false"/.test(gcTxt),
      JSON.stringify(gcDo).slice(0, 220) + ' | option:' + gcTxt.includes('gcsections')
    );
    const dbgTxt = fs.readFileSync(path.join(projField, '.cproject'), 'utf8');
    check(
      'field: debugInfoLevel composes the full enum id',
      !!dbgDo && dbgDo.ok === true && dbgDo.after === 'max' && dbgTxt.includes('option.debugging.level.max'),
      JSON.stringify(dbgDo).slice(0, 200) + ' | ' + dbgTxt.slice(0, 160)
    );
    const dbgDef = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'debugInfoLevel', value: 'default' } }));
    check('field: debugInfoLevel accepts "default" (a real CDT choice)', !!dbgDef && dbgDef.ok === true && dbgDef.after === 'default', JSON.stringify(dbgDef).slice(0, 160));
    const stdDo = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'cDialect', value: 'c11' } }));
    const stdTxt = fs.readFileSync(path.join(projField, '.cproject'), 'utf8');
    check(
      'field: cDialect stores the c.compiler.std enum id',
      !!stdDo && stdDo.ok === true && stdDo.after === 'c11' && stdTxt.includes('option.c.compiler.std.c11'),
      JSON.stringify(stdDo).slice(0, 200)
    );
    const stdBad = await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'cDialect', value: 'default' } });
    check('field: cDialect refuses "default" (clearing is a guarded no-op)', stdBad.result.isError === true && /default" is not accepted/.test(resultJson(stdBad).error || ''), JSON.stringify(resultJson(stdBad)));
    const langBad = await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'cDialect', value: 'c99', language: 'cpp' } });
    check('field: cDialect with language "cpp" is refused', langBad.result.isError === true && /does not apply/.test(resultJson(langBad).error || ''), JSON.stringify(resultJson(langBad)));
    const userObj = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'userObjects', value: ['libtest.a'] } }));
    const fieldReload = require('../out/core/cproject.js').Cproject.load(projField, { repairProject: false });
    const userObjTxt = fs.readFileSync(path.join(projField, '.cproject'), 'utf8');
    check(
      'field: userObjects writes both linker twins UNQUOTED (MRS2 model takes them verbatim)',
      !!userObj && userObj.ok === true && userObj.after.length === 1 && JSON.stringify(fieldReload.listOption('c.linker.otherobjs').values) === '["libtest.a"]' && JSON.stringify(fieldReload.listOption('cpp.linker.otherobjs').values) === '["libtest.a"]' && userObjTxt.includes('value="libtest.a"') && !userObjTxt.includes('&quot;libtest.a'),
      JSON.stringify(userObj).slice(0, 200) + ' | raw:' + userObjTxt.includes('value="libtest.a"')
    );
    const libPath = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'libSearchPaths', value: ['inc'] } }));
    const libPathTxt = fs.readFileSync(path.join(projField, '.cproject'), 'utf8');
    check(
      'field: libSearchPaths stores in-project paths in the workspace_loc spelling',
      !!libPath && libPath.ok === true && libPath.after[0] === '${workspace_loc:/${ProjName}/inc}' && libPathTxt.includes('${workspace_loc:/${ProjName}/inc}'),
      JSON.stringify(libPath).slice(0, 220)
    );
    const artDo = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'artifactName', value: 'MyFw' } }));
    const artTxt = fs.readFileSync(path.join(projField, '.cproject'), 'utf8');
    check(
      'field: artifactName lands on the build configuration identity',
      !!artDo && artDo.ok === true && artDo.after.targetName === 'MyFw' && artTxt.includes('artifactName="MyFw"') && typeof artDo.note === 'string' && artDo.note.includes('Target Path'),
      JSON.stringify(artDo).slice(0, 220)
    );
    const artBad = await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'artifactName', value: 'a/b' } });
    check('field: artifactName refuses path separators', artBad.result.isError === true && /path separators/.test(resultJson(artBad).error || ''), JSON.stringify(resultJson(artBad)));
    // outputPrefix lives on the C/C++ linker <tool> elements — give the
    // fixture a real toolchain block first (a minimal .cproject carries none,
    // and the tool must refuse rather than silently no-op)
    fs.writeFileSync(
      path.join(projField, '.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n' +
        '<tool id="ilg.gnumcueclipse.managedbuild.cross.riscv.tool.c.linker.1" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.tool.c.linker"/>\n' +
        '<tool id="ilg.gnumcueclipse.managedbuild.cross.riscv.tool.cpp.linker.1" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.tool.cpp.linker"/>\n' +
        '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries>\n' +
        '</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
    );
    const prefixDo = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'outputPrefix', value: 'out' } }));
    const prefixTxt = fs.readFileSync(path.join(projField, '.cproject'), 'utf8');
    check(
      'field: outputPrefix lands on the linker tool attribute',
      !!prefixDo && prefixDo.ok === true && prefixDo.after.outputPrefix === 'out' && prefixTxt.includes('outputPrefix="out"'),
      JSON.stringify(prefixDo).slice(0, 200) + ' | ' + prefixTxt.slice(0, 120)
    );
    const prefixBad = await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'outputPrefix', value: 'out/' } });
    check(
      'field: outputPrefix refuses path separators/shell metacharacters (the makefile never mkdirs a prefix subdir)',
      prefixBad.result.isError === true && /plain name segment/.test(resultJson(prefixBad).error || ''),
      JSON.stringify(resultJson(prefixBad))
    );
    const unknownField = await server.rpc('tools/call', { name: 'mrvc_set_config_option', arguments: { root: projField, field: 'nope', value: 1 } });
    check('field: an unknown field names the valid set', unknownField.result.isError === true && (resultJson(unknownField).error || '').includes('warningsAll'), JSON.stringify(resultJson(unknownField)));

    // -- mrvc_compile_file (gates only — the real make run needs a machine) --
    const projCf = makeProject('projcf');
    const cfUnknown = await server.rpc('tools/call', { name: 'mrvc_compile_file', arguments: { root: projCf, file: 'ghost/nope.c' } });
    check('cf: an unknown file is refused', cfUnknown.result.isError === true && (resultJson(cfUnknown).error || '').includes('no such file'), JSON.stringify(resultJson(cfUnknown)));
    const cfExcl = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projCf, path: 'src/keep.c', action: 'exclude' } }));
    const cfExcluded = await server.rpc('tools/call', { name: 'mrvc_compile_file', arguments: { root: projCf, file: 'src/keep.c' } });
    check(
      'cf: an excluded file is refused with the re-include hint',
      !!cfExcl && cfExcl.ok === true && cfExcluded.result.isError === true && (resultJson(cfExcluded).error || '').includes('excluded from the build'),
      JSON.stringify(resultJson(cfExcluded))
    );
    const cfBadIndex = await server.rpc('tools/call', { name: 'mrvc_compile_file', arguments: { root: projCf, file: 'main.c', configIndex: 5 } });
    check('cf: an out-of-range configIndex is refused', cfBadIndex.result.isError === true && /out of range/.test(resultJson(cfBadIndex).error || ''), JSON.stringify(resultJson(cfBadIndex)));
    // v0.3.8 review M7: the three-file contract, directories and
    // filteredResources-removed files are refused with reasons
    const projCf2 = makeProject('projcf2');
    fs.rmSync(path.join(projCf2, '.project'));
    const cfContract = await server.rpc('tools/call', { name: 'mrvc_compile_file', arguments: { root: projCf2, file: 'main.c' } });
    check('cf: the three-file contract is enforced', cfContract.result.isError === true && /not a legal MRS project/.test(resultJson(cfContract).error || ''), JSON.stringify(resultJson(cfContract)).slice(0, 200));
    const cfDir = await server.rpc('tools/call', { name: 'mrvc_compile_file', arguments: { root: projCf, file: 'src' } });
    check('cf: a directory is refused', cfDir.result.isError === true && /is a directory/.test(resultJson(cfDir).error || ''), JSON.stringify(resultJson(cfDir)));
    fs.writeFileSync(
      path.join(projCf, '.project'),
      '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>projcf</name><filteredResources><filter><name>src</name><type>6</type><matcher><id>org.eclipse.ui.ide.multiFilter</id><arguments>1.0-name-matches-false-false-keep.c</arguments></matcher></filter></filteredResources></projectDescription>'
    );
    const cfRemoved = await server.rpc('tools/call', { name: 'mrvc_compile_file', arguments: { root: projCf, file: 'src/keep.c' } });
    check(
      'cf: a logically removed file is refused (it would never reach the makefiles)',
      cfRemoved.result.isError === true && /logically removed/.test(resultJson(cfRemoved).error || ''),
      JSON.stringify(resultJson(cfRemoved))
    );
    fs.mkdirSync(path.join(projCf, 'obj'), { recursive: true });
    fs.writeFileSync(path.join(projCf, 'obj', 'gen.c'), 'int g(void){return 0;}\n');
    const cfOutDir = await server.rpc('tools/call', { name: 'mrvc_compile_file', arguments: { root: projCf, file: 'obj/gen.c' } });
    check(
      'cf: files inside an output directory are refused at entry',
      cfOutDir.result.isError === true && /output directory/.test(resultJson(cfOutDir).error || ''),
      JSON.stringify(resultJson(cfOutDir))
    );
    const exclOutCheck = resultJson(await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projCf, path: 'obj/gen.c', action: 'check' } }));
    const exclOutMut = await server.rpc('tools/call', { name: 'mrvc_set_build_exclusion', arguments: { root: projCf, path: 'obj/gen.c', action: 'include' } });
    check(
      'excl: output directory is reported excluded and cannot be toggled',
      !!exclOutCheck && exclOutCheck.excluded === true && exclOutCheck.outputDirectory === true && exclOutMut.result.isError === true && /output directory/.test(resultJson(exclOutMut).error || ''),
      JSON.stringify({ exclOutCheck, exclOutMut: resultJson(exclOutMut) })
    );

    // -- mrvc_delete_output --
    const projDel = makeProject('projdel');
    fs.mkdirSync(path.join(projDel, 'obj', 'sub'), { recursive: true });
    // a GENERATED makefile (CDT header + target mention) is the ownership
    // anchor (round5 P1); the claimed output set (round7 P1) decides WHAT is
    // deleted: the orphan obj/sub/keep.o (no matching source) and the
    // non-configured .bin (this config builds hex only) are unclaimed
    fs.writeFileSync(path.join(projDel, 'obj', 'makefile'), '# Automatically-generated file. Do not edit!\nall: projdel.elf\nprojdel.elf: main.o\n');
    fs.writeFileSync(path.join(projDel, 'obj', 'projdel.hex'), 'x');
    fs.writeFileSync(path.join(projDel, 'obj', 'projdel.bin'), 'x');
    fs.writeFileSync(path.join(projDel, 'obj', 'sub', 'keep.o'), 'x');
    const delKeep = resultJson(await server.rpc('tools/call', { name: 'mrvc_delete_output', arguments: { root: projDel, scope: 'active', keepImages: true } }));
    check(
      'del: keepImages clears the claimed makefile, spares the images AND the unclaimed survivors',
      !!delKeep &&
        delKeep.ok === true &&
        delKeep.filesCleared === 1 &&
        fs.existsSync(path.join(projDel, 'obj', 'projdel.hex')) &&
        fs.existsSync(path.join(projDel, 'obj', 'projdel.bin')) &&
        fs.existsSync(path.join(projDel, 'obj', 'sub', 'keep.o')) &&
        Array.isArray(delKeep.survivors) &&
        delKeep.survivors.includes('projdel.bin') &&
        delKeep.survivors.includes('sub/keep.o'),
      JSON.stringify(delKeep).slice(0, 240)
    );
    // (round3/round7) an images-plus-data directory refuses the whole-dir
    // delete while files the build does not own are inside
    const delWipe = await server.rpc('tools/call', { name: 'mrvc_delete_output', arguments: { root: projDel, scope: 'active' } });
    check(
      'del: the whole-dir delete refuses while unclaimed files are inside',
      delWipe.result.isError === true && /not written by this build/.test(resultJson(delWipe).error || '') && fs.existsSync(path.join(projDel, 'obj', 'projdel.hex')),
      JSON.stringify(resultJson(delWipe)).slice(0, 200)
    );
    // removing the survivors lets the whole-dir delete through (the keep-clear
    // took the generated makefile with it — a rebuild re-writes it first)
    fs.writeFileSync(path.join(projDel, 'obj', 'makefile'), '# Automatically-generated file. Do not edit!\nall: projdel.elf\nprojdel.elf: main.o\n');
    fs.rmSync(path.join(projDel, 'obj', 'sub', 'keep.o'), { force: true });
    fs.rmSync(path.join(projDel, 'obj', 'projdel.bin'), { force: true });
    const delWipe2 = resultJson(await server.rpc('tools/call', { name: 'mrvc_delete_output', arguments: { root: projDel, scope: 'active' } }));
    check(
      'del: without keepImages the whole output directory goes (once unclaimed files are gone)',
      !!delWipe2 && delWipe2.ok === true && delWipe2.removedDir === 'obj' && !fs.existsSync(path.join(projDel, 'obj')),
      JSON.stringify(delWipe2).slice(0, 200)
    );
    // (review round7 P1) the claimed output set IS the build model: makefile
    // family, objects+deps for every scanned source, product, image, flash
    // script — and nothing the build does not write
    const { buildOutputFiles: bof } = require('../out/core/makefile.js');
    const claimedSet = bof(require('../out/core/cproject.js').Cproject.load(projDel, { repairProject: false }));
    check(
      'del: buildOutputFiles claims the makefile family, objects, deps, su, map, product, image and flash scripts',
      ['makefile', 'sources.mk', 'objects.mk', 'subdir.mk', 'src/subdir.mk', 'main.o', 'main.d', 'main.su', 'src/keep.o', 'src/keep.d', 'src/keep.su', 'projdel.elf', 'projdel.hex', 'projdel.map', 'mrvc_flash.cfg', 'mrs2_flash.cfg'].every((f) => claimedSet.includes(f)) &&
        !claimedSet.includes('projdel.bin') &&
        !claimedSet.includes('sub/keep.o'),
      JSON.stringify(claimedSet).slice(0, 300)
    );
    const delSkip = resultJson(await server.rpc('tools/call', { name: 'mrvc_delete_output', arguments: { root: projDel, scope: 'active' } }));
    check('del: a never-built output dir is a skipped no-op', !!delSkip && delSkip.ok === true && delSkip.skipped === true, JSON.stringify(delSkip));
    const delBad = await server.rpc('tools/call', { name: 'mrvc_delete_output', arguments: { root: projDel, scope: 'nope' } });
    check('del: an unknown scope is refused', delBad.result.isError === true && /scope must be/.test(resultJson(delBad).error || ''), JSON.stringify(resultJson(delBad)));

    // -- mrvc_set_power_output (gate) / mrvc_check_wchlink_firmware (tolerant) --
    const pwNo = await server.rpc('tools/call', { name: 'mrvc_set_power_output', arguments: { root: projDel, rail: '5v' } });
    check(
      'power: no verified Power-Off Reset receipt is refused',
      pwNo.result.isError === true && /Power-Off Reset|power-verified/i.test(resultJson(pwNo).error || ''),
      JSON.stringify(resultJson(pwNo))
    );
    const fwChk = resultJson(await server.rpc('tools/call', { name: 'mrvc_check_wchlink_firmware', arguments: { mrsInstallPath: FAKE } }));
    check(
      'firmware: the read-only probe returns a graceful state',
      !!fwChk && typeof fwChk.state === 'string' && typeof fwChk.ok === 'boolean' && ['no-link', 'up-to-date', 'upgrade-needed', 'error'].includes(fwChk.state),
      JSON.stringify(fwChk).slice(0, 200)
    );
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
    check('docs: TOOL_NAMES declares twenty-seven tools', names.length === 27, String(names.length));
    // the mrvc-ai ZCode plugin wrapper's package.json is its bundle's version
    // source — the round3 strict name check knocked it down to 0.0.0; the
    // parent allowlist in server.ts must keep carrying both family names
    const serverSrc = fs.readFileSync(path.join(rootDir, 'src', 'mcp', 'server.ts'), 'utf8');
    check('docs: server version allowlist covers mrvc and the mrvc-ai wrapper', serverSrc.includes("'mrvc-ai'") && serverSrc.includes("MRVC_FAMILY_PACKAGE_NAMES"), '');
    const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
    check('docs: README names the twenty-seven tools', readme.includes('二十七个工具'));
    check('docs: README no longer claims eight tools', !readme.includes('八工具包装'));
    check('docs: README lists the batch-5 write tools', readme.includes('mrvc_set_config_option') && readme.includes('mrvc_manage_configurations') && readme.includes('mrvc_add_linked_folder'), '');
    check(
      'docs: README lists the batch-6 tools',
      ['mrvc_repair_project', 'mrvc_set_build_exclusion', 'mrvc_change_linked_folder_target', 'mrvc_rename_project', 'mrvc_switch_project_type', 'mrvc_compile_file', 'mrvc_delete_output', 'mrvc_set_power_output', 'mrvc_check_wchlink_firmware'].every((n) => readme.includes(n)),
      ''
    );
    // the header comment drifted once already (round4 P3.1: still said
    // "TEN tools" at thirteen) — pin it to the same count
    const header = fs.readFileSync(__filename, 'utf8').slice(0, 800);
    check(
      'docs: this test file header names the twenty-seven tools',
      /TWENTY-SEVEN tools/.test(header) && !/EIGHTEEN tools/.test(header) && !/THIRTEEN tools/.test(header) && !/TEN tools/.test(header)
    );
  }

  console.log(failures ? '\n' + failures + ' FAILURES' : '\nall mcp server tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('mcpserver-test crashed:', e);
  process.exit(1);
});
