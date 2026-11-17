/**
 * "Open with MRS" — launch the currently effective MRS IDE ON THE PROJECT's
 * .wvproj file (project context menu; user-corrected 2026-11-11: MRS opens
 * a project through its `<工程名>.wvproj` marker, not the folder). The
 * launcher binary is resolved per install flavor/generation via
 * installLauncherPath(); the .wvproj is passed as TWO `-m <file>` arguments
 * (mrsOpenProjectArgs; the extension's internal `-m=` equals-form leaves the
 * workspace empty on a real desktop). Windows passes the ABSOLUTE path
 * through a detached PowerShell wrapper (see mrsWindowsLaunchArgv), POSIX
 * passes it through sh quoting (mrsLaunchSpec owns the split; the task
 * process IS the IDE and its environment is the full desktop session minus
 * the ELECTRON_* / VSCODE_* poison prefixes — the round-42 form).
 *
 * Platform split, 2026-11-17: Windows stays DETACHED through an
 * instant-completing PowerShell wrapper (Start-Process) — an MRS process
 * lives as long as its window, so a tracked task would pile up
 * forever-running instances and surface stale ones ("Select an instance to
 * terminate", 2026-11-12). POSIX instead goes FOREGROUND (five detached
 * wrapper forms — nohup/setsid/env -i variants — all died silently inside
 * the task while the identical command from a desktop terminal opened the
 * IDE, see mrsLaunchSpec): the task process IS the IDE, so the task lives
 * exactly as long as the MRS window and closes when the window closes. The
 * task terminal streams the IDE's own output (free diagnostics on failure).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getInstall, MrsProject, ProjectStore } from './projects';
import { host, installLauncherPath, mrsGuiEnv, mrsLaunchSpec } from '../core/toolchain';
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
export function wvprojPath(project: MrsProject): string {
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
  // Platform split lives in mrsLaunchSpec (see its header for the 2026-11-17
  // evidence): Windows detached via PowerShell, POSIX FOREGROUND — the task
  // process IS the IDE, so the task runs while the MRS window is open and
  // completes when it closes (no detached pile-up possible on that branch).
  // Both platforms pass the ABSOLUTE .wvproj: MRS rejects a relative path
  // outright ("The following file path is not absolute", 2026-11-12 user
  // report); the Windows wrapper embeds quotes so a spaced path still
  // arrives as one argv token. mrsGuiEnv stays as the options.env belt for
  // the Windows branch; on POSIX the poison ELECTRON_*/VSCODE_* variables
  // are unset BY PREFIX inside the launch script itself (task-env options
  // merge additively and cannot remove them — see mrsLaunchSpec).
  const spec = mrsLaunchSpec(host(), launcher, wvproj, project.root);
  const task = new vscode.Task(
    { type: 'mrvc-tool', task: 'open-with-mrs', project: project.projectName },
    `open with MRS - ${project.projectName}`,
    'MRVC',
    new vscode.ProcessExecution(spec.argv[0], spec.argv.slice(1), { env: mrsGuiEnv(process.env), cwd: spec.cwd })
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Never };
  // a non-zero exit means the launch itself failed (or the IDE crashed) —
  // never stay silent (reveal: Never would hide it). The listener is
  // registered INSIDE waitTaskProcess before executeTask(), so an instant
  // exit cannot be missed, and a rejected executeTask resolves undefined
  // (round-11 P3-3). On POSIX a normal "window closed" ends with exit 0.
  void waitTaskProcess(task, 'mrvc-tool').then((code) => {
    if (code !== 0) {
      vscode.window.showErrorMessage(t('openWithMrsFailed', String(code ?? 'unknown')));
    }
  });
}
