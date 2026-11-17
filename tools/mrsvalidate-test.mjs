/**
 * MRS deep-check verdict contract (out/core/mrsValidate.js) — pure Node, no
 * vscode stub. Every positive/negative sample below is the REAL text shape
 * captured by the 2026-11-14 probes on live MRS2 (see the module doc):
 *   - built: main.log "Build Finished. (took 14s687ms)" (+ Chinese form)
 *   - parsed: Build Failed markers / make error output (legality OK, code bad)
 *   - rejected: exthost.log crash signatures — the rvGcc-missing-value
 *     TypeError and the truncated-XML "Invalid attribute name", WITH the
 *     every-session vim .registers ENOENT noise present (must be ignored)
 *   - inconclusive: killed at the timeout with no signature at all
 * Plus the session-log discovery helpers against a temp tree.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { hasMakeFailure, noiseError, errorLinesFromExthost, mrsValidateVerdict, mrsBuildResult, mrsTaskEnv, knownSessionDirs, newSessionDirs, sessionMainLog, sessionExthostLog } = require_(
  path.join(here, '..', 'out', 'core', 'mrsValidate.js')
);

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// ---- probe-captured exthost logs (real shapes) -----------------------------
const EXTHOST_B = [
  `2026-11-14 10:43:35.577 [error] TypeError: Cannot read properties of undefined (reading 'match')`,
  `2026-11-14 10:43:35.578 [error] TypeError: Cannot read properties of undefined (reading 'match')`,
  `2026-11-14 10:43:36.312 [error] Error: ENOENT: no such file or directory, open 'c:\\\\Users\\\\OWNER\\\\AppData\\\\Local\\\\Temp\\\\mrs-validate-probe\\\\portable-mrs2\\\\user-data\\\\User\\\\globalStorage\\\\vscodevim.vim\\\\.registers'`,
].join('\n');

const EXTHOST_C = [
  `2026-11-14 10:49:02.861 [error] Error: Invalid attribute name`,
  `Line: 116`,
  `Column: 227`,
  `Char: <`,
  `	at O (c:\\\\MounRiver\\\\MounRiver_Studio2\\\\resources\\\\app\\\\extensions\\\\mrs-team.mrs-vscode\\\\out\\\\extension.js:2:802444)`,
  `2026-11-14 10:49:03.192 [error] Error: Invalid attribute name`,
  `Line: 116`,
  `2026-11-14 10:49:04.078 [error] Error: ENOENT: no such file or directory, open '...\\\\vscodevim.vim\\\\.registers'`,
].join('\n');

const MAIN_BUILT = `[10:43:07] Build Finished. (took 14s687ms)`;
const MAIN_BUILT_ZH = `[10:43:07] 编译完成。（用时 14 秒）`;
const MAIN_MAKE_FAIL = `make: *** [User/main.o] Error 1`;
const MAIN_MAKE_FAIL_ZH = `mingw32-make: *** [obj/User/main.o] 错误 1`;

// ---- 1. noise filter --------------------------------------------------------
check('noise: vim .registers ENOENT filtered', noiseError(`Error: ENOENT: no such file or directory, open '...globalStorage\\vscodevim.vim\\.registers'`));
check('noise: a project crash signature is NOT noise', !noiseError(`TypeError: Cannot read properties of undefined (reading 'match')`));
check('noise: an XML parse error is NOT noise', !noiseError(`Error: Invalid attribute name`));

// ---- 2. error-line extraction ----------------------------------------------
{
  const lines = errorLinesFromExthost(EXTHOST_B);
  check('extract B: exactly the deduped TypeError (vim noise dropped)', lines.length === 1 && lines[0].includes(`reading 'match'`));
  const linesC = errorLinesFromExthost(EXTHOST_C);
  check('extract C: the XML error message survives, stack frames dropped', linesC.length === 1 && linesC[0] === 'Error: Invalid attribute name');
  check('extract: empty log → no lines', errorLinesFromExthost('').length === 0);
  const many = Array.from({ length: 20 }, (_, i) => `2026-01-01 00:00:0${i % 10}.000 [error] E${i}`).join('\n');
  check('extract: capped at 10 entries', errorLinesFromExthost(many).length === 10);
}

// ---- 3. verdict matrix -------------------------------------------------------
check('verdict: Build Finished → built', mrsValidateVerdict({ mainLog: MAIN_BUILT }).verdict === 'built');
check('verdict: Chinese finish marker → built', mrsValidateVerdict({ mainLog: MAIN_BUILT_ZH }).verdict === 'built');
check('verdict: built wins over incidental exthost errors', mrsValidateVerdict({ mainLog: MAIN_BUILT, exthostLog: EXTHOST_B }).verdict === 'built');
check('verdict: Build Failed → parsed (legality OK, code bad)', mrsValidateVerdict({ mainLog: `Build Failed. (took 3s)` }).verdict === 'parsed');
check('verdict: Chinese fail marker → parsed', mrsValidateVerdict({ mainLog: MAIN_MAKE_FAIL_ZH }).verdict === 'parsed');
check('verdict: make error output → parsed', mrsValidateVerdict({ mainLog: MAIN_MAKE_FAIL }).verdict === 'parsed');
{
  const r = mrsValidateVerdict({ mainLog: '', exthostLog: EXTHOST_B, timedOut: true });
  check('verdict: probe B (rvGcc crash) → rejected with the TypeError', r.verdict === 'rejected' && r.detail.includes(`reading 'match'`) && r.timedOut === true);
  const rc = mrsValidateVerdict({ mainLog: '', exthostLog: EXTHOST_C, timedOut: true });
  check('verdict: probe C (broken XML) → rejected with Invalid attribute name', rc.verdict === 'rejected' && rc.detail === 'Error: Invalid attribute name');
}
{
  const r = mrsValidateVerdict({ mainLog: '', exthostLog: `... [error] Error: ENOENT ... vscodevim.vim ...`, timedOut: true });
  check('verdict: noise-only exthost + timeout → inconclusive', r.verdict === 'inconclusive' && r.timedOut === true);
}
check('verdict: no evidence at all → inconclusive', mrsValidateVerdict({ mainLog: '' }).verdict === 'inconclusive');
check('verdict: empty input safe', mrsValidateVerdict({}).verdict === 'inconclusive');

// ---- 5. build-with-MRS semantics (probe 2026-11-15) ------------------------
// compile-failure sample: Build Failed + make errors + gcc diagnostics all
// land in main.log (and stdout); exit code is 0 and carries no meaning
const MAIN_COMPILE_FAIL = [
  `[06:47:33] **** Incremental Build of configuration obj for project X ****`,
  `../User/main.c:98:32: error: expected ')' before '{' token`,
  `make[1]: *** [User/subdir.mk:34: User/main.o] Error 1`,
  `make: *** [makefile:53: all] Error 2`,
  `[06:47:34] Build Failed.`,
].join('\n');

{
  const built = mrsValidateVerdict({ mainLog: MAIN_BUILT });
  const failed = mrsValidateVerdict({ mainLog: MAIN_COMPILE_FAIL });
  const rejected = mrsValidateVerdict({ mainLog: '', exthostLog: EXTHOST_B, timedOut: true });
  const timeout = mrsValidateVerdict({ mainLog: '', timedOut: true });
  const cleanExit = mrsValidateVerdict({ mainLog: '' }); // exited, no marker

  check('build semantics: probe success sample classifies as built', built.verdict === 'built');
  check('build semantics: probe compile-failure sample classifies as parsed', failed.verdict === 'parsed');
  check('build: built → ok', mrsBuildResult('build', built) === 'ok');
  check('build: parsed (code failed) → compile-failed', mrsBuildResult('build', failed) === 'compile-failed');
  check('rebuild: parsed → compile-failed too', mrsBuildResult('rebuild', failed) === 'compile-failed');
  check('build: rejected stays rejected', mrsBuildResult('build', rejected) === 'rejected');
  check('build: timeout without a signature → no-result', mrsBuildResult('build', timeout) === 'no-result');
  check('build: quick exit without any marker → no-result (no-result error, competitor parity)', mrsBuildResult('build', cleanExit) === 'no-result');
  check('clean: marker-less clean that exited → ok (competitor parity)', mrsBuildResult('clean', cleanExit) === 'ok');
  check('clean: timed-out clean → no-result', mrsBuildResult('clean', timeout) === 'no-result');
  check('clean: Build Finished marker → ok', mrsBuildResult('clean', built) === 'ok');
  check('clean: rejected stays rejected', mrsBuildResult('clean', rejected) === 'rejected');
  // validation semantics unchanged: the same compile-failure sample PASSES
  // the legality question (parsed = accepted, code bad)
  check('validate semantics: compile-failure still passes legality (parsed)', failed.verdict === 'parsed');
}

// ---- 4. session-log discovery helpers ---------------------------------------
{
  const root = path.join(os.tmpdir(), 'mrvc-mrsvalidate-test');
  fs.rmSync(root, { recursive: true, force: true });
  check('discovery: missing logs root → empty known set', knownSessionDirs(root).size === 0);
  check('discovery: missing logs root → no new dirs', newSessionDirs(root, new Set()).length === 0);
  fs.mkdirSync(path.join(root, '20261114T104235', 'window1', 'exthost'), { recursive: true });
  fs.writeFileSync(path.join(root, '20261114T104235', 'main.log'), MAIN_BUILT);
  fs.writeFileSync(path.join(root, '20261114T104235', 'window1', 'exthost', 'exthost.log'), EXTHOST_B);
  const before = knownSessionDirs(root);
  check('discovery: the session dir is known', before.has('20261114T104235'));
  fs.mkdirSync(path.join(root, '20261114T105000'), { recursive: true });
  const fresh = newSessionDirs(root, before);
  check('discovery: only the new session is reported, newest first', fresh.length === 1 && fresh[0] === '20261114T105000');
  check('discovery: main.log read back', sessionMainLog(root, '20261114T104235') === MAIN_BUILT);
  check('discovery: exthost.log read back', sessionExthostLog(root, '20261114T104235') === EXTHOST_B);
  check('discovery: absent session → empty strings', sessionMainLog(root, 'nope') === '' && sessionExthostLog(root, 'nope') === '');
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 6. task environment scrubbing (in-product hang fix, 2026-11-15) -------
{
  const hostEnv = {
    PATH: 'C:/Windows',
    ELECTRON_RUN_AS_NODE: '1', // the hang: MRS exe would boot as plain Node
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    VSCODE_IPC_HOOK: '\\\\.\\pipe\\host-sock',
    VSCODE_PID: '1234',
    VSCODE_PORTABLE: 'C:/old-should-be-overwritten',
    SYSTEMROOT: 'C:/Windows',
  };
  const env = mrsTaskEnv(hostEnv, '/home/u/.mrvc/mrs-validate/mrs2');
  check('env: ELECTRON_* family stripped', !('ELECTRON_RUN_AS_NODE' in env) && !('ELECTRON_NO_ATTACH_CONSOLE' in env));
  check('env: VSCODE_* family stripped', !('VSCODE_IPC_HOOK' in env) && !('VSCODE_PID' in env));
  check('env: host variables survive', env.PATH === 'C:/Windows' && env.SYSTEMROOT === 'C:/Windows');
  check('env: portable dir set (host override replaced)', env.VSCODE_PORTABLE === '/home/u/.mrvc/mrs-validate/mrs2');
  check('env: empty base still yields the portable dir', mrsTaskEnv({}, '/p').VSCODE_PORTABLE === '/p');
}

process.exit(failures ? 1 : 0);
