/**
 * Task-process plumbing shared by every short-lived MRVC task (flash/power
 * passes and the instant-completing "open with MRS" wrapper): resolve with
 * the exit code of THIS execution.
 *
 * Two races are handled here (round-11 P3-3 — the open-with wrapper used to
 * register its listener only after executeTask() resolved):
 *   - end events can arrive BEFORE executeTask() hands us the execution; they
 *     are buffered and matched by execution identity on resolution
 *   - a same-type task ending in that window must not settle this waiter with
 *     ITS exit code — matching is by identity, never by task type alone
 * A task whose executeTask() promise rejects resolves undefined (the caller
 * reports the failure).
 */
import * as vscode from 'vscode';

export function waitTaskProcess(
  task: vscode.Task,
  taskType: string,
  token?: vscode.CancellationToken
): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve) => {
    let settled = false;
    let exec: vscode.TaskExecution | undefined;
    let cancelRequested = token?.isCancellationRequested ?? false;
    let d: vscode.Disposable | undefined;
    let tokenSub: vscode.Disposable | undefined;
    const early: Array<[vscode.TaskExecution, number | undefined]> = [];
    const finish = (code: number | undefined): void => {
      if (settled) return;
      settled = true;
      d?.dispose();
      tokenSub?.dispose();
      resolve(code);
    };
    const terminate = (): void => {
      if (!exec) return; // executeTask() has not handed us the execution yet
      try {
        void Promise.resolve(exec.terminate()).catch(() => undefined);
      } catch {
        // terminate is best-effort; the process may already have exited
      }
    };
    d = vscode.tasks.onDidEndTaskProcess((e) => {
      if (settled || e.execution.task.definition.type !== taskType) return;
      if (!exec) {
        early.push([e.execution, e.exitCode]);
        return;
      }
      if (e.execution !== exec) return;
      finish(e.exitCode);
    });
    tokenSub = token?.onCancellationRequested(() => {
      cancelRequested = true;
      terminate();
    });
    vscode.tasks.executeTask(task).then(
      (e) => {
        exec = e;
        // cancellation may have been requested before executeTask resolved
        if (cancelRequested) terminate();
        const hit = early.find(([x]) => x === e);
        if (hit) finish(hit[1]);
      },
      () => {
        // task never started — release the listener, report failure
        finish(undefined);
      }
    );
  });
}
