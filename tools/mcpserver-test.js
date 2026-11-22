/*
 * MRVC MCP server end-to-end tests (0.3.6): spawn mcp/mcp-server.js, speak
 * the stdio JSON-RPC transport (newline-delimited), and assert the protocol
 * surface (initialize / tools/list / ping / parse errors / unknown methods)
 * plus the TEN tools against a HERMETIC fixture — a fake MRS install tree
 * (the mrsinstall-test recipe), a minimal legal project, and the
 * env-steering contract (MRVC_MRS_INSTALL_PATH inherited by the child). The
 * real install is only exercised tolerantly (get_install_info without
 * arguments must return a parseable result either way); the build tool's
 * make stage depends on the machine's PATH, so its assertion accepts the
 * structured no-make error. Hardware gates: flash requires a receipt with a
 * matching FlashPlan fingerprint; power requires its own marker-verified
 * power receipt.
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
        'main: tools/list carries the ten tools',
        JSON.stringify(names) ===
          JSON.stringify([
            'mrvc_discover_projects',
            'mrvc_get_install_info',
            'mrvc_get_project_config',
            'mrvc_audit_project',
            'mrvc_build',
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
        'main: build exposes timeoutSec; flash/power expose openocdPath',
        !!schemaByName.mrvc_build.properties.timeoutSec &&
          !!schemaByName.mrvc_flash.properties.openocdPath &&
          !!schemaByName.mrvc_power_off_reset.properties.openocdPath
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
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  console.log(failures ? '\n' + failures + ' FAILURES' : '\nall mcp server tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('mcpserver-test crashed:', e);
  process.exit(1);
});
