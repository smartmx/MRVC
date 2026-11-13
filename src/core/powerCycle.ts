/**
 * Power-off reset (掉电复位) builder — pure Node. Two SHORT OpenOCD sessions
 * (off → host-side delay → on) switch the WCH-Link's target power rail via
 * the fork's pow3v3/pow5v commands — the only reset path for chips whose
 * NRST pin is repurposed by the 1/2-wire debug interface. Everything here is
 * verified against the MRS2 OpenOCD fork (0.11.0+dev 2026-08-25): the two
 * rail commands exist, are registered once wch-riscv.cfg loads the wlink
 * driver, and BOTH rails share one power state — only the actually-fed rail
 * is commanded, mirroring wch-vscode's implementation of the same feature.
 *
 * The debug-mode commands (dbgtool / two_wires) are deliberately NOT used:
 * their signatures are unverified, and MRVC already switches the debug mode
 * through the properties-page FFI (dbgMode passthrough) — the power cycle is
 * the companion action that makes the new mode effective.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PowerVoltage, openocdLogArgs, transientOpenOcdFailure } from './flash';

export interface PowerPassOptions {
  boardCfg: string;
  voltage: PowerVoltage;
  state: 'off' | 'on';
  /** halt the target after a power-ON pass (only a pre-debug reset wants
   * this; a plain reset lets the chip run immediately) */
  halt?: boolean;
  /** the -l log target of this pass (the verdict classifier reads it) */
  logPath: string;
}

/**
 * One pass's argv. Shape per pass (config-time commands execute in order,
 * BEFORE any target interaction):
 *   board cfg → three debug-port disables → rail switch → init → [halt] →
 *   shutdown. init on the OFF pass usually fails (the chip is de-energised
 * by then) — expected and tolerated by powerPassVerdict; the rail switch
 * itself has already happened.
 */
export function preparePowerPass(opts: PowerPassOptions): string[] {
  const rail = opts.voltage === '5v' ? 'pow5v' : 'pow3v3';
  const args = [
    '-f', opts.boardCfg,
    '-c', 'gdb_port disabled',
    '-c', 'telnet_port disabled',
    '-c', 'tcl_port disabled',
    '-c', `${rail} ${opts.state}`,
  ];
  // BOTH passes write explicit success evidence: the rail command ran and did
  // not abort the script (an unknown `-c` command aborts it before the echo).
  // powerPassVerdict keys "done" on THIS marker, never on exit 0 alone — a
  // missing -l directory (never-compiled project) makes OpenOCD exit 0 with
  // no log at all, which used to read as a successful power cycle while the
  // rail was never touched (round-10 P2-1 + round-11 P2-1). The OFF marker
  // additionally anchors the expected "init after power-down fails" tolerance.
  args.push('-c', opts.state === 'off' ? 'echo MRVC_POWER_OFF_OK' : 'echo MRVC_POWER_ON_OK');
  args.push('-c', 'init');
  if (opts.state === 'on' && opts.halt) args.push('-c', 'halt');
  args.push('-c', 'shutdown', ...openocdLogArgs(opts.logPath));
  return args;
}

/** mrvc.flash.powerOffDelayMs, clamped to its schema range (0–10000, the
 * setting UI enforces the same bounds); non-finite input falls back to the
 * 100 ms default rather than poisoning the wait */
export function clampPowerOffDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 100;
  return Math.min(10000, Math.max(0, Math.round(ms)));
}

/**
 * This attempt's `-l` target inside a build directory. Two real-world hazards
 * are handled here (round-11 P2-1 fix, extracted for direct FS testing in
 * round 12):
 *   - a never-compiled project has no build dir at all, and OpenOCD neither
 *     creates it nor fails — it exits 0 with NO log, so the pass would carry
 *     no evidence and the marker-based verdict reports failure. mkdir fixes it
 *     (an unwritable dir is tolerated: the missing log then fails the pass
 *     instead of crashing the command).
 *   - if the previous log cannot be deleted (indexer/AV holds the file), a
 *     per-attempt UNIQUE name is used instead — a STALE log must never
 *     classify a fresh attempt.
 * Containment: the resolved build dir must stay inside the project root (both
 * operands are code constants today; the check keeps future callers honest).
 */
export function freshLogPath(root: string, buildDir: string, base: string, attempt: number): string {
  const rootAbs = path.resolve(root);
  const dir = path.resolve(buildDir);
  if (dir !== rootAbs && !dir.startsWith(rootAbs + path.sep)) throw new Error('power log path escaped the project root');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // unwritable build dir: the session then writes no log and the marker
    // evidence fails the pass — never crash the command here
  }
  const primary = path.join(dir, `${base}.log`);
  try {
    fs.rmSync(primary, { force: true });
    return primary;
  } catch {
    return path.join(dir, `${base}.${process.pid}-${attempt}-${Date.now().toString(36)}.log`);
  }
}

/** what to do after one power pass ended with `exitCode` (undefined = the
 *  task never started) and `logText` on attempt `attempt` (0-based).
 *  "Started" is the precondition for ANY evidence (round-12 P3-1): a task
 *  whose executeTask() rejected resolves undefined, and a marker in the log
 *  could then only be stale — so undefined fails before the marker is
 *  consulted. Past that:
 *   - marker "MRVC_POWER_OFF_OK" / "MRVC_POWER_ON_OK" seen → done (the rail
 *     switch ran; on the OFF pass the subsequent init failure is the feature
 *     working, on the ON pass the power is restored). The marker is the ONLY
 *     success evidence — OpenOCD exits 0 without writing any log when the -l
 *     directory is missing (round-11 P2-1), so exit 0 alone means nothing
 *   - "invalid command name" in the log         → fail on BOTH passes (an
 *     OpenOCD fork without the pow commands would otherwise look like the
 *     expected OFF-pass init failure — silently "succeeding" without ever
 *     touching the rail)
 *   - transient link-open failure in the log    → retry (max 2 retries, the
 *     backoff lives in the caller), then fail
 *   - anything else, INCLUDING a clean exit 0 without the marker → fail (no
 *     evidence the rail moved) */
export function powerPassVerdict(
  state: 'off' | 'on',
  exitCode: number | undefined,
  logText: string,
  attempt: number
): { action: 'done' | 'retry' | 'fail' } {
  if (exitCode === undefined) return { action: 'fail' };
  if (logText.includes(state === 'off' ? 'MRVC_POWER_OFF_OK' : 'MRVC_POWER_ON_OK')) return { action: 'done' };
  if (/invalid command name/i.test(logText)) return { action: 'fail' };
  if (transientOpenOcdFailure(logText)) return { action: attempt < 2 ? 'retry' : 'fail' };
  return { action: 'fail' };
}
