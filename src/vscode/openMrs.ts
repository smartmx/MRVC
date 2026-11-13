/**
 * "Open with MRS" — launch the currently effective MRS IDE ON THE PROJECT's
 * .wvproj file (project context menu; user-corrected 2026-11-11: MRS opens
 * a project through its `<工程名>.wvproj` marker, not the folder). The
 * launcher binary is resolved per install flavor/generation via
 * installLauncherPath(); the .wvproj is passed as TWO `-m <file>` arguments
 * (mrsOpenProjectArgs; the extension's internal `-m=` equals-form leaves the
 * workspace empty on a real desktop). Windows passes the RELATIVE basename
 * with -WorkingDirectory = the project root (PS Start-Process does not quote
 * -ArgumentList elements — mrsWindowsLaunchArgv), POSIX passes the absolute
 * path through sh quoting (mrsLaunchSpec owns the split). The launch is
 * DETACHED through an instant-completing wrapper (PowerShell Start-Process
 * on Windows, a backgrounded sh on POSIX): an MRS process lives as long as
 * its window, so a tracked task would pile up forever-running instances and
 * surface stale ones ("Select an instance to terminate", 2026-11-12); cmd's
 * `start ""` title argument is additionally mangled by VS Code argv
 * quoting, which rules the pure-cmd form out.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getInstall, MrsProject, ProjectStore } from './projects';
import { host, installLauncherPath, mrsLaunchSpec } from '../core/toolchain';
import { waitTaskProcess } from './taskRunner';
import { t } from '../core/i18n';

/**
 * The .wvproj to hand the IDE: `<projectName>.wvproj` in the project root
 * (the exact marker MRS opens projects through; Windows path checks are
 * case-insensitive, so case variants of the stored name all match). If the
 * stored name and the file on disk ever disagree, fall back to the SINGLE
 * *.wvproj that actually exists in the root — with MULTIPLE candidates the
 * choice would be arbitrary (alphabetical), so refuse rather than open the
 * wrong project.
 */
function wvprojPath(project: MrsProject): string {
  const canonical = path.join(project.root, project.projectName + '.wvproj');
  if (fs.existsSync(canonical)) return canonical;
  try {
    const found = fs
      .readdirSync(project.root)
      .filter((f) => f.toLowerCase().endsWith('.wvproj'));
    if (found.length === 1) return path.join(project.root, found[0]);
  } catch {
    // unreadable root — the caller's not-found path handles it
  }
  return '';
}

export function openWithMrsCmd(store: ProjectStore, item?: { project?: unknown }): void {
  const project = (item as { project?: MrsProject })?.project ?? store.active;
  if (!project) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(t('installNotFound'));
    return;
  }
  if (install.kind !== 'ide') {
    vscode.window.showErrorMessage(t('openWithMrsNoIde', install.root));
    return;
  }
  const launcher = installLauncherPath(install);
  if (!launcher || !fs.existsSync(launcher)) {
    vscode.window.showErrorMessage(t('openWithMrsNotFound', install.root));
    return;
  }
  const wvproj = wvprojPath(project);
  if (!wvproj || !fs.existsSync(wvproj)) {
    vscode.window.showErrorMessage(t('openWithMrsNoWvproj', project.root));
    return;
  }
  // Detached launch: the IDE must NOT be a tracked task — an MRS process
  // lives as long as its window, so every click used to pile up a forever-
  // "running" task and VS Code surfaced stale ones ("Select an instance to
  // terminate - MRVC: MRVC: open with MRS - <old project>", 2026-11-12 user
  // report). The wrapper exits right after Start-Process / backgrounding,
  // so the task completes instantly and MRS outlives it.
  // The platform split lives in mrsLaunchSpec. Both platforms pass the
  // ABSOLUTE .wvproj: MRS rejects a relative path outright ("The following
  // file path is not absolute", 2026-11-12 user report); the Windows wrapper
  // embeds quotes so a spaced path still arrives as one argv token.
  const spec = mrsLaunchSpec(host(), launcher, wvproj, project.root);
  const task = new vscode.Task(
    { type: 'mrvc-tool', task: 'open-with-mrs', project: project.projectName },
    `open with MRS - ${project.projectName}`,
    'MRVC',
    new vscode.ProcessExecution(spec.argv[0], spec.argv.slice(1))
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Never };
  // the wrapper completes instantly; a non-zero exit means the launch itself
  // failed — never stay silent (reveal: Never would hide it). The listener
  // is registered INSIDE waitTaskProcess before executeTask(), so an instant
  // exit cannot be missed, and a rejected executeTask resolves undefined
  // (round-11 P3-3).
  void waitTaskProcess(task, 'mrvc-tool').then((code) => {
    if (code !== 0) {
      vscode.window.showErrorMessage(t('openWithMrsFailed', String(code ?? 'unknown')));
    }
  });
}
