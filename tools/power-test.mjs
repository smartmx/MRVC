/*
 * Power-off reset builder tests (pure Node, no filesystem at all — the
 * builders emit argv and decisions only). Covers: the off/on pass shapes
 * (port disables, rail switch, init/halt ordering, shutdown, -l tail), the
 * 3v3/5v rail mapping, the delay clamp, and the pass verdicts (transient
 * retry vs the expected init failure of the OFF pass vs real ON failures).
 */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEVELOP_DIR = path.dirname(here);
const { preparePowerPass, clampPowerOffDelay, powerPassVerdict, freshLogPath } = require(path.join(DEVELOP_DIR, 'out', 'core', 'powerCycle.js'));
const { openocdLogArgs } = require(path.join(DEVELOP_DIR, 'out', 'core', 'flash.js'));
const { linkSupportsPowerOutput } = require(path.join(DEVELOP_DIR, 'out', 'core', 'wlink.js'));

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const CFG = 'C:/MRS/bin/wch-riscv.cfg';
const LOG = 'E:/prj/obj/mrvc_power_off.log';

// 1. the OFF pass: ports disabled, rail down, explicit success marker, init
// (expected to fail after the chip loses power), shutdown — plus the -l tail
{
  const args = preparePowerPass({ boardCfg: CFG, voltage: '3v3', state: 'off', logPath: LOG });
  check(
    'off pass: exact argv shape (marker after the rail switch, round-10 P2-1)',
    JSON.stringify(args) ===
      JSON.stringify([
        '-f', CFG,
        '-c', 'gdb_port disabled', '-c', 'telnet_port disabled', '-c', 'tcl_port disabled',
        '-c', 'pow3v3 off',
        '-c', 'echo MRVC_POWER_OFF_OK',
        '-c', 'init',
        '-c', 'shutdown',
        ...openocdLogArgs(LOG),
      ])
  );
  check('off pass: no halt ever', !args.includes('halt'));
}

// 2. the ON pass: rail up + its own marker, init, optional halt, shutdown
{
  const plain = preparePowerPass({ boardCfg: CFG, voltage: '3v3', state: 'on', logPath: LOG.replace('_off', '_on') });
  check('on pass: rail up then init, no halt by default', plain.includes('-c') && plain[plain.indexOf('pow3v3 on') - 1] === '-c' && !plain.includes('halt'));
  check(
    'on pass: MRVC_POWER_ON_OK marker after the rail switch (round-11 P2-1)',
    plain.indexOf('echo MRVC_POWER_ON_OK') > plain.indexOf('pow3v3 on') && plain.indexOf('echo MRVC_POWER_ON_OK') < plain.indexOf('init')
  );
  const halted = preparePowerPass({ boardCfg: CFG, voltage: '5v', state: 'on', halt: true, logPath: LOG.replace('_off', '_on') });
  check('on pass: 5v rail mapped to pow5v', halted.includes('pow5v on'));
  check(
    'on pass: halt right after init, before shutdown',
    halted.indexOf('halt') > halted.indexOf('init') && halted.indexOf('halt') < halted.indexOf('shutdown')
  );
}

// 3. the delay clamp: schema range 0-10000, non-finite falls back to 100
{
  check('clamp: default shape unchanged', clampPowerOffDelay(100) === 100);
  check('clamp: negative to 0', clampPowerOffDelay(-5) === 0);
  check('clamp: above maximum to 10000', clampPowerOffDelay(20000) === 10000);
  check('clamp: NaN to 100', clampPowerOffDelay(Number.NaN) === 100);
  check('clamp: Infinity to 100', clampPowerOffDelay(Number.POSITIVE_INFINITY) === 100);
  check('clamp: fractional rounds', clampPowerOffDelay(150.6) === 151);
}

// 4. verdicts (round-10 P2-1 + round-11 P2-1: the pass's own MARKER is the
// only success evidence — unknown failures, never-started tasks AND a clean
// exit 0 with no log at all must NOT masquerade as success)
{
  const TRANSIENT = 'Error: wlink open error!';
  const REAL = 'Error: target examination failed';
  const MARK = 'MRVC_POWER_OFF_OK';
  const MARK_ON = 'MRVC_POWER_ON_OK';
  check(
    'verdict: marker present (either state, even with the post-switch init failure) -> done',
    powerPassVerdict('off', 1, MARK + '\n' + REAL, 0).action === 'done' &&
      powerPassVerdict('on', 1, MARK_ON + '\n' + REAL, 0).action === 'done'
  );
  check(
    'verdict: clean exit 0 WITHOUT a log/marker -> fail (missing build dir, round-11 P2-1)',
    powerPassVerdict('off', 0, '', 0).action === 'fail' && powerPassVerdict('on', 0, '', 0).action === 'fail'
  );
  check(
    "verdict: the other pass's marker is not evidence",
    powerPassVerdict('off', 0, MARK_ON, 0).action === 'fail' && powerPassVerdict('on', 0, MARK, 0).action === 'fail'
  );
  check(
    'verdict: transient retries then fails (attempts 0,1 retry / 2 fail)',
    powerPassVerdict('on', 1, TRANSIENT, 0).action === 'retry' &&
      powerPassVerdict('on', 1, TRANSIENT, 1).action === 'retry' &&
      powerPassVerdict('on', 1, TRANSIENT, 2).action === 'fail'
  );
  check('verdict: OFF pass WITHOUT the marker + unknown error -> fail (round-10 P2-1)', powerPassVerdict('off', 1, REAL, 0).action === 'fail');
  check('verdict: ON pass WITHOUT the marker + unknown error -> fail', powerPassVerdict('on', 1, REAL, 0).action === 'fail');
  check('verdict: a pass that never started (undefined) -> fail, either state', powerPassVerdict('off', undefined, '', 0).action === 'fail' && powerPassVerdict('on', undefined, '', 0).action === 'fail');
  check(
    'verdict: undefined + marker -> fail (never started; a marker could only be stale, round-12 P3-1)',
    powerPassVerdict('off', undefined, MARK, 0).action === 'fail' && powerPassVerdict('on', undefined, MARK_ON, 0).action === 'fail'
  );
}

// 5. the unsupported-link gate inputs (WCH manuals: rail control is
// LinkE/DAPLink/LinkW ONLY — the plain WCH-Link must be rejected BEFORE the
// passes run, and unknown ids are never guessed)
{
  check('gate: plain WCH-Link (0/1) has NO rail control', linkSupportsPowerOutput(0) === false && linkSupportsPowerOutput(1) === false);
  check('gate: LinkE (2/18) supported', linkSupportsPowerOutput(2) === true && linkSupportsPowerOutput(18) === true);
  check('gate: DAPLink (4) supported', linkSupportsPowerOutput(4) === true);
  check('gate: LinkW (5/133) supported', linkSupportsPowerOutput(5) === true && linkSupportsPowerOutput(133) === true);
  check('gate: unknown id / no query result -> undefined (never guessed)', linkSupportsPowerOutput(99) === undefined && linkSupportsPowerOutput(undefined) === undefined);
}

// 6. the OFF-pass tolerance must NOT swallow a missing pow command: an old
// OpenOCD fork (or a build without the rail commands) reports
// "invalid command name" — that is a real failure on BOTH passes, never the
// expected init failure of the power-down
{
  check('verdict: invalid command name fails the OFF pass', powerPassVerdict('off', 1, 'invalid command name "pow3v3"', 0).action === 'fail');
  check('verdict: invalid command name fails the ON pass', powerPassVerdict('on', 1, 'invalid command name "pow5v"', 0).action === 'fail');
}

// 7. freshLogPath (round-12 P3-2): the two failure modes round 11 fixed must
// stay fixed — build-dir creation, and the unique-name fallback when the old
// log cannot be deleted. A private temp dir per run; nothing outside it is
// touched.
{
  const ROOT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mrvc-power-'));
  try {
    const buildDir = path.join(ROOT2, 'obj');
    const p1 = freshLogPath(ROOT2, buildDir, 'mrvc_power_off', 0);
    check(
      'fresh log: missing build dir is created, primary name returned',
      fs.existsSync(buildDir) && p1 === path.join(buildDir, 'mrvc_power_off.log')
    );
    // deterministic stand-in for an indexer/AV lock: a DIRECTORY at the
    // primary log name makes rmSync(force) throw, exactly like a held file
    const primary = path.join(buildDir, 'mrvc_power_on.log');
    fs.mkdirSync(primary);
    const p2 = freshLogPath(ROOT2, buildDir, 'mrvc_power_on', 1);
    check(
      'fresh log: held primary falls back to a unique name in the same dir',
      p2 !== primary && path.dirname(p2) === buildDir && path.basename(p2).startsWith('mrvc_power_on.') && fs.statSync(primary).isDirectory()
    );
    let escaped = false;
    try {
      freshLogPath(ROOT2, path.join(ROOT2, '..', 'outside-the-root'), 'mrvc_power_off', 0);
    } catch {
      escaped = true;
    }
    check('fresh log: a build dir outside the project root is rejected', escaped);
  } finally {
    fs.rmSync(ROOT2, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nall power-cycle tests passed');
process.exit(failures ? 1 : 0);
