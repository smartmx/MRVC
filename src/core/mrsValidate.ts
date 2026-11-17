/**
 * MRS session-log verdict contract (0.3.1 deep project check).
 *
 * MRS2/MRS3 are VSCode OSS forks: when their silent workbench action runs,
 * the build progress of the run lands in the session main.log (the on-disk
 * verbose channel), and any project-loading crash lands in the session
 * window1/exthost/exthost.log. This module holds the pure verdict contract
 * over those two log files, distilled from probes on real MRS2/MRS3
 * (2026-11-14; the launcher invocation itself and its isolated data dir
 * live in the vscode layer next to the task construction). Pure Node only
 * — unit testable without a VS Code host.
 *
 * Empirical outcome contract (three probe cases + live runs):
 *   - accepted project: the session main.log carries the Build Finished
 *     marker (or its Chinese form).
 *   - project MRS cannot load (broken XML, the rvGcc-missing-value crash
 *     shape): the session window1/exthost/exthost.log records the crash
 *     (a TypeError reading "match" / an XML attribute error / ...) while
 *     main.log stays without markers. Timeout + terminate is mandatory;
 *     the verdict then comes from those error lines.
 *   - a project MRS parses but whose CODE fails to compile puts the Build
 *     Failed marker / make error output into main.log — MRS accepted it
 *     (legality ok, code bad).
 */
import * as fs from 'fs';
import * as path from 'path';

/** a make run happened (its error output is unambiguous) */
export function hasMakeFailure(text: string): boolean {
  return (
    text.indexOf('***') >= 0 &&
    (text.indexOf('Error 1') >= 0 ||
      text.indexOf('Error 2') >= 0 ||
      text.indexOf('Error 127') >= 0 ||
      text.indexOf('Error ') >= 0 ||
      text.indexOf('错误') >= 0)
  );
}

const PASS_MARKERS = ['Build Finished', '编译完成'];
const PARSE_FAIL_MARKERS = ['Build Failed', '编译失败'];

export type MRSValidateVerdict = 'built' | 'parsed' | 'rejected' | 'inconclusive';

export interface MRSValidateOutcome {
  verdict: MRSValidateVerdict;
  /** first crash signature (rejected) / failure hint (parsed) */
  detail?: string;
  /** killed after the timeout — set on inconclusive to steer the user message */
  timedOut?: boolean;
}

/**
 * Unrelated extension-host log noise that appears in EVERY session
 * (probed: the bundled vim extension's missing .registers file). Must never
 * contribute to a rejection verdict.
 */
export function noiseError(line: string): boolean {
  return (
    line.indexOf('globalStorage') >= 0 ||
    line.indexOf('vscodevim') >= 0 ||
    line.indexOf('.registers') >= 0
  );
}

/**
 * Extract the message lines of error entries from an exthost.log, with the
 * noise filtered. Entry format on disk: a timestamp-prefixed line ending
 * with the bracketed severity tag and the message, followed by multi-line
 * stack/frame lines that do NOT carry the tag — only the first message line
 * of each entry is kept, deduplicated, order preserved.
 */
export function errorLinesFromExthost(logText: string): string[] {
  const tag = '[error]';
  const out: string[] = [];
  for (const raw of logText.split(/\r?\n/)) {
    const at = raw.indexOf(tag);
    if (at < 0) continue; // stack continuation or non-error line
    const message = raw.slice(at + tag.length).trim();
    if (!message || noiseError(message)) continue;
    if (!out.includes(message)) out.push(message);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * The verdict contract from the probe:
 *   1. main.log carries a build-finished marker → MRS accepted the project
 *      AND built it ('built').
 *   2. main.log carries a build-failed marker → MRS parsed and accepted the
 *      project; the failure is in user code ('parsed') — legality OK, code
 *      bad; the surfaced message must make that clear.
 *   3. otherwise, non-noise exthost error lines → MRS crashed on / rejected
 *      the project ('rejected', detail = first signature).
 *   4. anything else (killed on timeout with no signature) → 'inconclusive'
 *      — the build may simply be slower than the timeout.
 */
export function mrsValidateVerdict(input: {
  mainLog: string;
  exthostLog?: string;
  timedOut?: boolean;
}): MRSValidateOutcome {
  const main = input.mainLog ?? '';
  for (const m of PASS_MARKERS) {
    if (main.indexOf(m) >= 0) return { verdict: 'built' };
  }
  for (const m of PARSE_FAIL_MARKERS) {
    if (main.indexOf(m) >= 0) return { verdict: 'parsed' };
  }
  if (hasMakeFailure(main)) return { verdict: 'parsed' };
  const errors = input.exthostLog ? errorLinesFromExthost(input.exthostLog) : [];
  if (errors.length) return { verdict: 'rejected', detail: errors[0], timedOut: input.timedOut };
  return { verdict: 'inconclusive', timedOut: input.timedOut };
}

// ---- build-with-MRS semantics (0.3.1) ---------------------------------------

/** what a Build/Rebuild/Clean With MRS IDE run means to the USER */
export type MrsBuildStatus = 'ok' | 'compile-failed' | 'rejected' | 'no-result';
/** the silent actions this feature drives */
export type MrsSilentAction = 'build' | 'rebuild' | 'clean';

/**
 * Re-interpret a validation verdict in BUILD semantics. The deep check only
 * asks "did MRS accept the project", so 'parsed' (accepted, code failed)
 * passes; a real build must fail there. Clean is marker-less by design
 * (probed + competitor parity): a clean that exited without a crash and
 * without timing out is 'ok' even with no Build Finished marker.
 */
export function mrsBuildResult(action: MrsSilentAction, o: MRSValidateOutcome): MrsBuildStatus {
  if (o.verdict === 'built') return 'ok';
  if (o.verdict === 'parsed') return action === 'clean' ? 'ok' : 'compile-failed';
  if (o.verdict === 'rejected') return 'rejected';
  // inconclusive: a clean that simply exited is fine; everything else is
  // suspicious (a build/rebuild without any marker is the no-result case the
  // competitor also reports as an error)
  if (action === 'clean' && !o.timedOut) return 'ok';
  return 'no-result';
}

// ---- environment for the spawned MRS ----------------------------------------

/**
 * Environment for an MRS silent task started FROM the VSCode extension host.
 * The extension host carries ELECTRON_RUN_AS_NODE / VSCODE_* variables that
 * poison a spawned VSCode-fork: ELECTRON_RUN_AS_NODE turns the MRS exe into
 * a plain Node process (its workbench never boots — the run hangs forever)
 * and VSCODE_IPC_HOOK points at THIS VSCode, which the fork may try to talk
 * to. Copy the base env, drop those two families, then point the fork at
 * the isolated data dir.
 */
export function mrsTaskEnv(base: NodeJS.ProcessEnv, portableDir: string): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const key of Object.keys(base)) {
    if (key.startsWith('ELECTRON_') || key.startsWith('VSCODE_')) continue;
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  env.VSCODE_PORTABLE = portableDir;
  return env;
}

// ---- session-log discovery (fs helpers for the runner) ----------------------

/** session dirs (timestamp-named) currently under the portable user-data logs */
export function knownSessionDirs(logsRoot: string): Set<string> {
  try {
    return new Set(fs.readdirSync(logsRoot));
  } catch {
    return new Set();
  }
}

/** newest session dirs NOT in the before-set (i.e. created by this run) */
export function newSessionDirs(logsRoot: string, before: Set<string>): string[] {
  try {
    return fs
      .readdirSync(logsRoot)
      .filter((d) => !before.has(d))
      .sort()
      .reverse(); // timestamp-named: newest first
  } catch {
    return [];
  }
}

/** the window1 exthost.log of one session dir, '' when absent/unreadable */
export function sessionExthostLog(logsRoot: string, sessionDir: string): string {
  const p = path.join(logsRoot, sessionDir, 'window1', 'exthost', 'exthost.log');
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

/** the session main.log (the on-disk verbose channel), '' when absent */
export function sessionMainLog(logsRoot: string, sessionDir: string): string {
  const p = path.join(logsRoot, sessionDir, 'main.log');
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}
