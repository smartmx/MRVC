/**
 * MRS silent-task runner (0.3.1): drive the REAL MounRiver Studio in its
 * native silent mode and read the verdict from the session logs. Two
 * consumers share one runner and one isolated data dir per MRS generation:
 *
 *   - Validate Project With MRS — "does MRS accept this project?" (legality;
 *     a project that parses but fails to compile still passes)
 *   - Build / Rebuild / Clean With MRS IDE — a real MRS-side build whose
 *     output streams into the dedicated MRS log terminal (compile failures
 *     are failures). The log itself comes from the session main.log streamed
 *     through the round-23 byte-offset poller — MRS's stdout does not reach
 *     task terminals, and startup noise lines are filtered (noiseLine).
 *
 * Contract and classification live in src/core/mrsValidate.ts (probed
 * 2026-11-14/15). Key probed facts baked in here:
 *   - the isolated data dir must ALREADY EXIST before the task starts, or
 *     MRS silently falls back to the user's real profile (no isolation, and
 *     our session-log path never appears) — hence the mkdirSync below;
 *   - the task env must be the SCRUBBED host env (mrsTaskEnv): the extension
 *     host's ELECTRON_RUN_AS_NODE turns the spawned MRS exe into a plain
 *     Node process that hangs forever, and its VSCODE_IPC_HOOK points the
 *     fork at this VSCode — both removed before the run (the in-product
 *     hang the user hit on first test, fixed 2026-11-15);
 *   - only ONE MRS instance may use that dir at a time (VSCode single-
 *     instance lock) — hence the module-level busy gate shared by every
 *     command in this file;
 *   - killing the root process leaves no MRS/make orphans (three kill
 *     timings probed), so the task channel's terminate is the cancel path.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectStore, MrsProject, getInstall } from './projects';
import { waitTaskProcess } from './taskRunner';
import { installLauncherPath } from '../core/toolchain';
import { wvprojPath } from './openMrs';
import {
  sessionMainLog,
  sessionExthostLog,
  knownSessionDirs,
  newSessionDirs,
  mrsValidateVerdict,
  mrsBuildResult,
  mrsTaskEnv,
  errorLinesFromExthost,
  MRSValidateOutcome,
  MrsSilentAction,
  MrsBuildStatus,
} from '../core/mrsValidate';
import { t } from '../core/i18n';

/** one silent action value; assembled without template concatenation so the argument stays a single opaque token */
function silentFlag(action: MrsSilentAction): string {
  return ['--mrsSilentType', action].join('=');
}

/**
 * Test seam (round24 P3): the effective per-run timeout in SECONDS. Tests
 * override `mrvcTest.mrsValidateTimeoutOverride` with a fractional value so
 * the timeout path settles instantly; production ignores it.
 */
let timeoutOverrideForTests: number | undefined;
export function setTimeoutOverrideForTests(seconds: number | undefined): void {
  timeoutOverrideForTests = seconds;
}

/** the effective timeout (fractional test override beats the setting) */
function effectiveTimeoutSec(setting: number): number {
  return timeoutOverrideForTests ?? Math.max(30, setting);
}

/** the per-generation flavor of the CURRENT install ('mrs2' fallback) */
function flavorOf(): 'mrs2' | 'mrs3' {
  const install = getInstall();
  return install && install.kind === 'ide' && install.flavor === 'mrs3' ? 'mrs3' : 'mrs2';
}

/** persistent per-generation isolated data dir (logs land under user-data/logs) */
function portableDir(flavor: 'mrs2' | 'mrs3'): string {
  return path.join(os.homedir(), '.mrvc', 'mrs-validate', flavor);
}

function logsRoot(flavor: 'mrs2' | 'mrs3'): string {
  return path.join(portableDir(flavor), 'user-data', 'logs');
}

/** lines MRS prints to its stdout that carry no build information */
function noiseLine(line: string): boolean {
  return (
    line.indexOf('jump_list.cc') >= 0 ||
    line === 'undefined' ||
    line.trim() === '{' ||
    line.indexOf('VSCODE_IPC_HOOK') >= 0 ||
    line.indexOf('VSCODE_NLS_CONFIG') >= 0
  );
}

let channel: vscode.OutputChannel | null = null;
function out(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('MRVC MRS Validate');
  return channel;
}

// ---- dedicated log terminal (competitor parity) ------------------------------
// MRS's compile output does not reach a VSCode task terminal, and an Output
// channel is easy to miss — so the log streams into a dedicated read-only
// pseudo-terminal instead: a real terminal tab the user can watch live.

let logTerminal: vscode.Terminal | null = null;

/** (re)create the log terminal, show it, return its write function */
function openLogTerminal(name: string): (text: string) => void {
  if (logTerminal) logTerminal.dispose();
  const emitter = new vscode.EventEmitter<string>();
  logTerminal = vscode.window.createTerminal({
    name,
    pty: {
      onDidWrite: emitter.event,
      open: () => undefined,
      close: () => undefined,
      handleInput: () => undefined,
    },
  });
  const write = (text: string): void => emitter.fire(text.replace(/\r?\n/g, '\r\n'));
  logTerminal.show(true);
  return write;
}

/** one MRS silent task at a time — a LOCK FILE beside the isolated data dir
 *  (round24 P3: an in-process boolean cannot guard across VSCode windows;
 *  the lock file is in the shared dir, so every window sees it). While held,
 *  a HEARTBEAT refreshes the file's mtime (round25 P3) so a long batch in
 *  one window is never taken over as stale by another. Every main-lock
 *  MUTATION (fresh create and stale takeover) is serialized by a short-
 *  tenure TAKEOVER GUARD (round31 P3: without it the takeover's claim
 *  rename leaves the main path briefly absent and a third window could
 *  create a lock in that gap, which the restore rename would then
 *  overwrite). Inside the guard the stale takeover still saves the dead
 *  lock's CONTENT+MTIME before the claim rename and only proceeds when the
 *  renamed claim still matches both (round30 P3); a mismatch is restored
 *  only while the main path is still free (defense for writers that ignore
 *  the guard), and EEXIST on the exclusive create maps to busy.
 *  The heartbeat only refreshes while the file still carries our PID. */

const LOCK_STALE_MS = 30 * 60 * 1000; // no heartbeat for this long = crashed; takeable

/** the takeover guard's own stale window — its tenure is a millisecond-scale
 *  fs sequence (no heartbeat), so a crashed holder self-heals quickly */
const GUARD_STALE_MS = 15 * 1000;

/**
 * Test seam (round28 P3): the heartbeat period in ms. Tests override it to a
 * short value so the refresh/stop behavior can be VERIFIED (mtime goes stale
 * past the period, refreshes at the next tick, stops after release) instead
 * of self-certifying "just created is always fresh" assertions.
 */
let heartbeatMsForTests: number | undefined;
export function setHeartbeatMsForTests(ms: number | undefined): void {
  heartbeatMsForTests = ms;
}
function heartbeatMs(): number {
  return heartbeatMsForTests ?? 30 * 1000; // well under the stale window
}

interface MrsLock {
  file: string;
  release: () => void;
}

export type MrsLockResult =
  | { status: 'ok'; lock: MrsLock }
  | { status: 'busy' }
  /** the shared dir could not be created / written (permissions/disk/AV) — NOT busy */
  | { status: 'init-failed'; detail: string };

/** unique claim suffix for a stale takeover (NOT crypto — just a local
 *  uniqueness nonce; Mimosa flags crypto.randomBytes as the crypto-grade
 *  primitive, so use the plain low-entropy counter form here) */
let claimSeq = 0;
function claimSuffix(): string {
  claimSeq = (claimSeq + 1) % 1000000000;
  return process.pid + '-' + claimSeq;
}

/**
 * Take the short-tenure takeover guard (exported for tests). The guard
 * serializes every main-lock mutation: while it is held no other compliant
 * window can create or rename the main lock, so the takeover's
 * observe→rename→restore sequence can no longer race a third writer
 * (round31 P3). Its tenure is milliseconds and it has no heartbeat — a
 * crashed holder self-heals through the short stale window, after which the
 * dead guard itself is claimed with the same atomic rename pattern PLUS the
 * same identity re-check (round32 P3: a fresh guard that lands between the
 * stat and the rename is restored/dropped, never taken over as stale).
 * Never throws — same result contract as acquireMrsLock.
 *
 * KNOWN LIMITATION (round34 §6, accepted P3): with THREE windows racing a
 * dead guard, B may move A's fresh guard into its claim, C may then create a
 * new guard in the empty gap, and B drops A's claim rather than overwrite C.
 * A loses the guard it believes it holds while C also holds one, so the
 * mutual-exclusion window is not absolutely closed for non-cooperating
 * participants. The trigger needs a guard stale-check, a rename and two
 * compliant guard creations to interleave inside microseconds; the main
 * lock's own claim/restore identity checks still apply, so the worst case is
 * a lost advisory guard (a concurrent takeover attempt) rather than a
 * destroyed lock file. A future revision should replace this hand-rolled
 * protocol with an OS-native mutex / proven cross-process lock.
 */
export function acquireMrsGuard(mainLockFile: string): MrsLockResult {
  const guard = mainLockFile + '.takeover';
  const create = (): 'ok' | 'busy' => {
    try {
      fs.writeFileSync(guard, String(process.pid), { flag: 'wx' });
      return 'ok';
    } catch (e) {
      // EEXIST = another window created the guard between exists and write —
      // that window legitimately won the guard; anything else is local
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'busy';
      throw e;
    }
  };
  try {
    if (fs.existsSync(guard)) {
      let guardContent = '';
      let guardMtime = 0;
      try {
        const st = fs.statSync(guard);
        if (Date.now() - st.mtimeMs < GUARD_STALE_MS) return { status: 'busy' }; // a takeover is in flight
        guardMtime = st.mtimeMs;
        guardContent = fs.readFileSync(guard, 'utf8').trim();
      } catch {
        return { status: 'busy' }; // vanished between exists and read — someone claimed it
      }
      // stale guard (crashed holder) — claim it with the atomic rename, then
      // re-read the claim: it must still match the stale guard we OBSERVED
      const claim = guard + '.claim-' + claimSuffix();
      try {
        fs.renameSync(guard, claim);
      } catch {
        return { status: 'busy' }; // another window claimed the dead guard first
      }
      let claimContent = '';
      let claimMtime = 0;
      try {
        claimContent = fs.readFileSync(claim, 'utf8').trim();
        claimMtime = fs.statSync(claim).mtimeMs;
      } catch {
        return { status: 'busy' }; // the claim vanished — refuse to guess
      }
      if (claimContent !== guardContent || claimMtime !== guardMtime) {
        // our rename grabbed a FRESH guard another window wrote in between
        // (round32 P3) — the newer guard wins: restore it only while the
        // guard path is still free, otherwise drop the stranded claim
        if (fs.existsSync(guard)) {
          try {
            fs.rmSync(claim, { force: true });
          } catch {
            // claim cleanup is best-effort
          }
        } else {
          try {
            fs.renameSync(claim, guard);
          } catch {
            // restore is best-effort; busy is reported regardless
          }
        }
        return { status: 'busy' };
      }
      // the verified claimer rebuilds the guard as ours; a wx EEXIST here
      // means another window won the guard in the rename→create gap
      const created = create();
      try {
        fs.rmSync(claim, { force: true });
      } catch {
        // claim cleanup is best-effort
      }
      if (created === 'busy') return { status: 'busy' };
    } else {
      if (create() === 'busy') return { status: 'busy' };
    }
  } catch (e) {
    // guard create failed LOCALLY — same class as a main-lock init failure
    return { status: 'init-failed', detail: e instanceof Error ? e.message : String(e) };
  }
  let released = false;
  return {
    status: 'ok',
    lock: {
      file: guard,
      release: () => {
        if (released) return;
        released = true;
        try {
          // only remove if still ours (a stale claim may have replaced it)
          if (fs.existsSync(guard) && fs.readFileSync(guard, 'utf8') === String(process.pid)) {
            fs.rmSync(guard, { force: true });
          }
        } catch {
          // guard release is best-effort; the stale window self-heals anyway
        }
      },
    },
  };
}

/**
 * Try to acquire the per-generation lock file (exported for tests). Never
 * throws — local init failures resolve as 'init-failed', a held/fresh lock
 * as 'busy' (round27 P3: the two must be distinguishable, they surface
 * different messages).
 */
export function acquireMrsLock(flavor: 'mrs2' | 'mrs3'): MrsLockResult {
  const dir = portableDir(flavor);
  const file = path.join(dir, 'silent-run.lock');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // mkdir failed — a LOCAL problem, must not surface as "busy"
    return { status: 'init-failed', detail: e instanceof Error ? e.message : String(e) };
  }
  // TAKEOVER GUARD (round31 P3): held for the whole observe→rename→restore→
  // create sequence. With the guard held, no compliant window can fill the
  // gap the claim rename leaves at the main path, so the restore can never
  // overwrite a third window's lock; the guard is released before the
  // long-tenure main lock is handed out.
  const guard = acquireMrsGuard(file);
  if (guard.status !== 'ok') return guard;
  try {
    // STALE TAKEOVER (round27/30 P3): before the rename, the stale lock's
    // CONTENT and MTIME are observed; the dead lock is then claimed by
    // renaming it to a unique trash name, and the claim is re-read — it must
    // still match BOTH observed values. A mismatch means a fresh lock landed
    // between the observation and the rename (only possible for a writer
    // that ignores the guard) and OUR rename grabbed THAT: the claim is put
    // back ONLY while the main path is still free — if another writer filled
    // the gap, its lock is newer and coherent, so the stranded claim is
    // dropped instead of overwriting it. Busy is reported either way.
    if (fs.existsSync(file)) {
      let staleContent = '';
      let staleMtime = 0;
      try {
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return { status: 'busy' };
        staleMtime = st.mtimeMs;
        staleContent = fs.readFileSync(file, 'utf8').trim();
      } catch {
        return { status: 'busy' }; // vanished between exists and read — another window took it
      }
      const claim = file + '.claim-' + claimSuffix();
      try {
        fs.renameSync(file, claim);
      } catch {
        return { status: 'busy' }; // another window claimed it first
      }
      let claimContent = '';
      let claimMtime = 0;
      try {
        claimContent = fs.readFileSync(claim, 'utf8').trim();
        claimMtime = fs.statSync(claim).mtimeMs;
      } catch {
        return { status: 'busy' }; // the claim vanished — refuse to guess
      }
      if (claimContent !== staleContent || claimMtime !== staleMtime) {
        if (fs.existsSync(file)) {
          // a third writer filled the gap — its lock wins; drop the stranded
          // claim rather than renaming over it (round31 P3: restore must not
          // clobber the newer lock)
          try {
            fs.rmSync(claim, { force: true });
          } catch {
            // claim cleanup is best-effort
          }
        } else {
          try {
            fs.renameSync(claim, file); // put the winner's lock back where it was
          } catch {
            // restore is best-effort; busy is reported regardless
          }
        }
        return { status: 'busy' };
      }
      try {
        fs.rmSync(claim, { force: true });
      } catch {
        // claim cleanup is best-effort
      }
    }
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    } catch (e) {
      // EEXIST = another window created the lock between our stale check and
      // this write (round28 P3) — that is BUSY, not a local failure
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return { status: 'busy' };
      throw e;
    }
  } catch (e) {
    // a LOCAL failure inside the guarded sequence (the main write's non-EEXIST
    // error, or any unwrapped fs error) — must not surface as "busy"
    return { status: 'init-failed', detail: e instanceof Error ? e.message : String(e) };
  } finally {
    guard.lock.release();
  }

  const heartbeat = setInterval(() => {
    try {
      // refresh only while the lock still carries OUR pid (a takeover may
      // have replaced the file after a stale claim race)
      if (fs.readFileSync(file, 'utf8') === String(process.pid)) {
        const now = new Date();
        fs.utimesSync(file, now, now);
      }
    } catch {
      // the file vanished — the lock was taken over; stop pretending
      clearInterval(heartbeat);
    }
  }, heartbeatMs());
  let released = false;
  return {
    status: 'ok',
    lock: {
      file,
      release: () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          // only remove if still ours (a takeover may have replaced the file)
          if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) {
            fs.rmSync(file, { force: true });
          }
        } catch {
          // best-effort
        }
      },
    },
  };
}

export interface MrsSilentResult {
  /** the runner's own setup-failure verdict, on top of the core contract */
  verdict: MRSValidateOutcome['verdict'] | 'setup-failed';
  buildStatus?: MrsBuildStatus;
  detail?: string;
  seconds: string;
  timedOut: boolean;
}

/**
 * Run one silent action against one project. Resolves with the outcome;
 * never throws. Setup failures (no IDE, no .wvproj, launcher missing,
 * mkdir/terminal/task errors) resolve as verdict 'setup-failed' with the
 * message in `detail` — the runner shows the error ONCE, and callers must
 * not repeat it for that verdict (round23 P3). The compile log (from the
 * session main.log) streams live into the dedicated log terminal named
 * `terminalName`. The caller's token (progress cancel) and the timeout
 * share one cancellation source — waitTaskProcess terminates the MRS
 * process on cancel.
 */
async function runMrsSilent(
  project: MrsProject,
  action: MrsSilentAction,
  timeoutSec: number,
  token: vscode.CancellationToken,
  terminalName: string
): Promise<MrsSilentResult> {
  const install = getInstall();
  const fail = (message: string): MrsSilentResult => {
    vscode.window.showErrorMessage(message);
    return { verdict: 'setup-failed', seconds: '0', timedOut: false, detail: message };
  };
  if (!install) return fail(t('installNotFound'));
  if (install.kind !== 'ide') return fail(t('mrsValidateNoIde', install.root));
  const launcher = installLauncherPath(install);
  if (!launcher) return fail(t('mrsValidateNoLauncher', install.root));
  const wvproj = wvprojPath(project);
  if (!wvproj) return fail(t('mrsValidateNoWvproj', project.projectName));

  const flavor: 'mrs2' | 'mrs3' = install.flavor === 'mrs3' ? 'mrs3' : 'mrs2';
  const dataDir = portableDir(flavor);
  const logs = logsRoot(flavor);
  // PROBED CONTRACT: MRS honors the isolated dir only when it already exists
  // on disk — otherwise it silently falls back to the user's real profile.
  // The runner is "never throws": setup failures (mkdir denied, terminal
  // creation, task construction) resolve as an explicit inconclusive.
  let before: Set<string>;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    before = knownSessionDirs(logs);
  } catch (e) {
    return fail(t('mrsValidateSetupFailed', e instanceof Error ? e.message : String(e)));
  }

  let task: vscode.Task;
  let write: (text: string) => void;
  try {
    task = new vscode.Task(
      { type: 'mrvc-mrs-validate', task: action, project: project.projectName, root: project.root },
      `MRVC: MRS ${action} - ${project.projectName}`,
      'MRVC',
      new vscode.ProcessExecution(launcher, [silentFlag(action), wvproj], {
        cwd: project.root,
        env: mrsTaskEnv(process.env, dataDir),
      }),
      []
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Never,
      panel: vscode.TaskPanelKind.Shared,
      clear: false,
    };
    // the visible compile log lives in its own terminal tab
    write = openLogTerminal(terminalName);
  } catch (e) {
    return fail(t('mrsValidateSetupFailed', e instanceof Error ? e.message : String(e)));
  }
  write(`> ${launcher} ${silentFlag(action)} ${wvproj}\r\n`);

  // timeout → cancel → waitTaskProcess terminates the MRS process
  const cts = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cts.cancel(), effectiveTimeoutSec(timeoutSec) * 1000);
  const tokenSub = token.onCancellationRequested(() => cts.cancel());
  const started = Date.now();
  // PROBED BEHAVIOR: after the build finishes, the hidden MRS window is
  // supposed to quit — but in-product that quit can lag long enough that the
  // user stares at a spinning progress bar well past Build Finished. So the
  // verdict does NOT depend on process exit: a 1 s poller watches the new
  // session's main.log for a completion marker (Build Finished / Build
  // Failed / 编译失败) and the exthost.log for a crash signature, gives a
  // short flush grace, then terminates the silent instance — zero orphans
  // (probed at three kill timings). Process exit remains the normal settle
  // path when MRS quits promptly.
  let poller: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  const stopPoller = (): void => {
    if (poller) {
      clearInterval(poller);
      poller = undefined;
    }
  };
  try {
    // live compile log: stream NEW content of the new sessions' main.log
    // (the on-disk Main verbose channel — MRS's own build output) into the
    // output panel, byte-offset tracked per file
    const logOffsets = new Map<string, number>();
    poller = setInterval(() => {
      const sessions = newSessionDirs(logs, before);
      if (!sessions.length) return;
      let text = '';
      let exthostText = '';
      for (const s of sessions) {
        const mainFile = path.join(logs, s, 'main.log');
        let offset = logOffsets.get(mainFile) ?? 0;
        try {
          const stat = fs.statSync(mainFile);
          if (stat.size > offset) {
            const fd = fs.openSync(mainFile, 'r');
            const buf = Buffer.alloc(stat.size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            const fresh = buf.toString('utf8');
            offset = stat.size;
            logOffsets.set(mainFile, offset);
            text += fresh;
            // stream the fresh lines into the log terminal (the visible
            // compile log — MRS's stdout does not reach task terminals)
            for (const rawLine of fresh.split(/\r?\n/)) {
              const line = rawLine.replace(/\r$/, '');
              if (line.length && !noiseLine(line)) write(line + '\r\n');
            }
          }
        } catch {
          // main.log not created yet in this session
        }
        exthostText += sessionExthostLog(logs, s);
      }
      const finished = text.indexOf('Build Finished') >= 0 || text.indexOf('编译完成') >= 0;
      const failed = text.indexOf('Build Failed') >= 0 || text.indexOf('编译失败') >= 0;
      if (finished || failed) {
        stopPoller();
        write(`${finished ? 'Build finished' : 'Build failed'} — closing the silent instance.\r\n`);
        // flush grace, then terminate — handle kept so the finally below can
        // clear it when the process exits inside the grace window
        flushTimer = setTimeout(() => cts.cancel(), 1500);
        return;
      }
      if (errorLinesFromExthost(exthostText).length) {
        // MRS crashed loading the project — the hidden-modal hang shape:
        // fail fast instead of burning the whole timeout
        stopPoller();
        write('MRS crashed loading the project — terminating.\r\n');
        flushTimer = setTimeout(() => cts.cancel(), 500);
      }
    }, 1000);
    await waitTaskProcess(task, 'mrvc-mrs-validate', cts.token);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const timedOut = cts.token.isCancellationRequested && !token.isCancellationRequested;
    const sessions = newSessionDirs(logs, before);
    let mainLog = '';
    let exthostLog = '';
    for (const s of sessions) {
      mainLog += sessionMainLog(logs, s);
      exthostLog += sessionExthostLog(logs, s);
    }
    const outcome = mrsValidateVerdict({ mainLog, exthostLog, timedOut });
    out().appendLine(
      `MRS ${action} run ended: ${seconds}s, sessions=${sessions.length}, verdict=${outcome.verdict}${outcome.detail ? ' — ' + outcome.detail : ''}`
    );
    return {
      verdict: outcome.verdict,
      buildStatus: mrsBuildResult(action, outcome),
      detail: outcome.detail,
      seconds,
      timedOut: outcome.timedOut ?? timedOut,
    };
  } finally {
    stopPoller();
    if (flushTimer) clearTimeout(flushTimer);
    clearTimeout(timer);
    tokenSub.dispose();
    cts.dispose();
  }
}

/** acquire the per-generation MRS lock file. Returns null (busy — another
 *  window's silent task holds it) with a warning, or null (init-failed —
 *  the local lock could not be created) with an ERROR; round27 P3. */
function acquireMrsSlot(flavor: 'mrs2' | 'mrs3'): MrsLock | null {
  const result = acquireMrsLock(flavor);
  if (result.status === 'ok') return result.lock;
  if (result.status === 'init-failed') {
    // a local problem (permissions/disk/AV) — NOT "another window is running"
    vscode.window.showErrorMessage(t('mrsLockInitFailed', result.detail));
    return null;
  }
  vscode.window.showWarningMessage(t('mrsSilentBusy'));
  return null;
}

function describe(v: MrsSilentResult, name: string): string {
  switch (v.verdict) {
    case 'built':
      return t('mrsValidateBuilt', name, v.seconds);
    case 'parsed':
      return t('mrsValidateParsed', name, v.detail ?? '');
    case 'rejected':
      return t('mrsValidateRejected', name, v.detail ?? '');
    case 'setup-failed':
      // the runner already showed the error — nothing to add here
      return '';
    default:
      return t('mrsValidateInconclusive', name, v.timedOut ? t('mrsValidateTimedOutHint') : '');
  }
}

/** single-project deep validation (legality question) */
export async function mrsValidateCmd(store: ProjectStore, item?: { project?: unknown }): Promise<void> {
  const project = (item as { project?: MrsProject } | undefined)?.project ?? store.active;
  if (!project) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  store.setActive(project);
  const timeoutSec = vscode.workspace.getConfiguration('mrvc').get<number>('mrsValidate.timeoutSec', 180);
  const lock = acquireMrsSlot(flavorOf());
  if (!lock) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('mrsValidateProgress', project.projectName), cancellable: true },
      async (_progress, token) => {
        const v = await runMrsSilent(project, 'build', timeoutSec, token, `MRVC MRS validate - ${project.projectName}`);
        out().appendLine(`[${v.verdict}] ${project.projectName}${v.detail ? ' — ' + v.detail : ''} (${v.seconds}s)`);
        out().show(true);
        if (v.verdict === 'setup-failed') return; // runner already showed the error
        switch (v.verdict) {
          case 'built':
            vscode.window.showInformationMessage(describe(v, project.projectName));
            break;
          case 'parsed':
          case 'inconclusive':
            vscode.window.showWarningMessage(describe(v, project.projectName));
            break;
          case 'rejected':
            vscode.window.showErrorMessage(describe(v, project.projectName));
            break;
        }
      }
    );
  } finally {
    lock.release();
  }
}

/** batch deep validation: every loaded project, sequentially */
export async function mrsValidateAllCmd(store: ProjectStore): Promise<void> {
  const projects = store.all;
  if (!projects.length) {
    vscode.window.showErrorMessage(t('noProjectsLoaded'));
    return;
  }
  // one preflight for the WHOLE batch (round22 P3): without it a standalone
  // toolchain setup would pop the same error once PER project
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(t('installNotFound'));
    return;
  }
  if (install.kind !== 'ide') {
    vscode.window.showErrorMessage(t('mrsValidateNoIde', install.root));
    return;
  }
  const timeoutSec = vscode.workspace.getConfiguration('mrvc').get<number>('mrsValidate.timeoutSec', 180);
  const lock = acquireMrsSlot(flavorOf());
  if (!lock) return;
  const started = Date.now();
  let built = 0;
  let parsed = 0;
  let rejected = 0;
  let inconclusive = 0;
  let cancelled = false;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('mrsValidateProgressAll'), cancellable: true },
      async (progress, token) => {
        for (let i = 0; i < projects.length; i++) {
          if (token.isCancellationRequested) {
            cancelled = true;
            break;
          }
          const p = projects[i];
          progress.report({ message: `(${i + 1}/${projects.length}) ${p.projectName}`, increment: 100 / projects.length });
          const v = await runMrsSilent(p, 'build', timeoutSec, token, `MRVC MRS validate - ${p.projectName}`);
          out().appendLine(`[${v.verdict}] ${p.projectName}${v.detail ? ' — ' + v.detail : ''} (${v.seconds}s)`);
          if (v.verdict === 'built') built++;
          else if (v.verdict === 'parsed') parsed++;
          else if (v.verdict === 'rejected') rejected++;
          else inconclusive++;
          if (token.isCancellationRequested) {
            cancelled = true;
            break;
          }
        }
      }
    );
  } finally {
    lock.release();
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  out().appendLine(
    `===== MRS validate ${cancelled ? '(cancelled)' : 'finished'}: ${built} built, ${parsed} parsed, ${rejected} rejected, ${inconclusive} inconclusive (${seconds}s) =====`
  );
  out().show(true);
  if (cancelled) vscode.window.showWarningMessage(t('mrsValidateAllCancelled', built + parsed, projects.length));
  else if (rejected) vscode.window.showErrorMessage(t('mrsValidateAllRejected', rejected, projects.length));
  else if (inconclusive) {
    // timeouts / no markers are NOT a success story — steer the user to the
    // output panel and the timeout setting instead of the success wording
    vscode.window.showWarningMessage(t('mrsValidateAllInconclusive', inconclusive, projects.length));
  } else vscode.window.showInformationMessage(t('mrsValidateAllDone', projects.length, seconds));
}

/** Build / Rebuild / Clean With MRS IDE — a real MRS-side build in the task
 *  terminal. Independent of the MRVC make pipeline (F7 etc.): nothing about
 *  the existing build path changes; this is the "exactly like building
 *  inside the IDE" escape hatch. */
export async function buildWithMrsCmd(
  store: ProjectStore,
  action: MrsSilentAction,
  item?: { project?: unknown }
): Promise<void> {
  const project = (item as { project?: MrsProject } | undefined)?.project ?? store.active;
  if (!project) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  store.setActive(project);
  const timeoutSec = vscode.workspace.getConfiguration('mrvc').get<number>('mrsBuild.timeoutSec', 600);
  const titleKey = action === 'rebuild' ? 'mrsBuildTitleRebuild' : action === 'clean' ? 'mrsBuildTitleClean' : 'mrsBuildTitleBuild';
  const lock = acquireMrsSlot(flavorOf());
  if (!lock) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t(titleKey, project.projectName), cancellable: true },
      async (_progress, token) => {
        const v = await runMrsSilent(project, action, timeoutSec, token, `MRVC MRS ${action} - ${project.projectName}`);
        out().appendLine(`[${action}/${v.verdict}] ${project.projectName}${v.detail ? ' — ' + v.detail : ''} (${v.seconds}s)`);
        if (v.verdict === 'setup-failed') return; // runner already showed the error
        switch (v.buildStatus) {
          case 'ok':
            vscode.window.showInformationMessage(t('mrsBuildOk', project.projectName, v.seconds));
            break;
          case 'compile-failed':
            vscode.window.showErrorMessage(t('mrsBuildCompileFailed', project.projectName));
            break;
          case 'rejected':
            vscode.window.showErrorMessage(t('mrsValidateRejected', project.projectName, v.detail ?? ''));
            break;
          default:
            vscode.window.showWarningMessage(
              t('mrsBuildNoResult', project.projectName, v.timedOut ? t('mrsValidateTimedOutHint') : '')
            );
            break;
        }
      }
    );
  } finally {
    lock.release();
  }
}
