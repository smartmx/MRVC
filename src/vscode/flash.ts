/**
 * Flash (download) via OpenOCD (run as a VSCode task so output/stop come
 * for free), plus the WCH-LinkUtility GUI launcher and the MRS terminal.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectStore, MrsProject, getInstall } from './projects';
import { prepareFlash, inferFlashAddress, FlashPlan } from '../core/flash';
import { scanSources } from '../core/scan';
import { t } from '../core/i18n';

/**
 * Board cfg selection, aligned with MRS2's own rule (its debug launcher):
 * the explicit setting wins, dual-core projects need wch-dual-core.cfg
 * (core1's flash bank sits at 0x00005000), ARM toolchains need
 * wch-arm.cfg, everything else uses the stock wch-riscv.cfg. Chip series
 * never enters the choice — address differences ride on the .template.
 */
function selectBoardCfg(project: MrsProject, cfg: vscode.WorkspaceConfiguration): string {
  const install = getInstall();
  if (!install) return '';
  const override = cfg.get<string>('openocd.config');
  if (override) return override;
  const binDir = path.dirname(install.openocdCfg);
  if (project.kernel) return path.join(binDir, 'wch-dual-core.cfg');
  const tc = project.toolchain(install, cfg.get<string>('toolchain', 'auto'));
  if (tc && tc.prefix.startsWith('arm')) return path.join(binDir, 'wch-arm.cfg');
  return install.openocdCfg;
}

/** firmware: .template Target Path (MRS2 convention, covers Merge.Bin) →
 * derived hexPath → file picker */
async function pickFirmware(project: MrsProject): Promise<string | undefined> {
  const target = project.template.values['Target Path']?.trim();
  if (target) {
    const cand = path.isAbsolute(target) ? target : path.join(project.root, target);
    if (fs.existsSync(cand)) return cand;
  }
  if (fs.existsSync(project.hexPath)) return project.hexPath;
  const pick = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(project.buildDir),
    filters: { Firmware: ['hex', 'bin'] },
    title: t('selectFirmware', project.projectName),
  });
  return pick?.length ? pick[0].fsPath : undefined;
}

/** run the flash task and resolve with its exit code (undefined = no end event) */
async function executeFlashTask(task: vscode.Task): Promise<number | undefined> {
  const done = new Promise<number | undefined>((resolve) => {
    let settled = false;
    let exec: vscode.TaskExecution | undefined;
    // end events arriving before executeTask() hands us the execution are
    // buffered and matched on resolution — a same-type task ending in that
    // window must not settle this waiter with its exit code
    const early: Array<[vscode.TaskExecution, number | undefined]> = [];
    const d = vscode.tasks.onDidEndTaskProcess((e) => {
      if (settled || e.execution.task.definition.type !== 'mrvc-flash') return;
      if (!exec) {
        early.push([e.execution, e.exitCode]);
        return;
      }
      // match by execution identity: a still-running earlier flash must not
      // resolve this one with its exit code
      if (e.execution !== exec) return;
      settled = true;
      d.dispose();
      resolve(e.exitCode);
    });
    vscode.tasks.executeTask(task).then(
      (e) => {
        exec = e;
        const hit = early.find(([x]) => x === e);
        if (hit && !settled) {
          settled = true;
          d.dispose();
          resolve(hit[1]);
        }
      },
      () => {
        // task never started — release the listener, report failure
        if (settled) return;
        settled = true;
        d.dispose();
        resolve(undefined);
      }
    );
  });
  return done;
}

/** EVT trees ship without .template — derive the download address from the
 * chip-family prefix of the project's scanned sources (see inferFlashAddress) */
function inferFlashAddressFromSources(project: MrsProject): string | undefined {
  try {
    const paths: string[] = [];
    for (const files of scanSources(project.cproject).values()) {
      for (const f of files) paths.push(f.fullpath);
    }
    return inferFlashAddress(paths);
  } catch {
    return undefined;
  }
}

export async function flashProject(store: ProjectStore, proj?: MrsProject): Promise<void> {
  const project = proj ?? store.active;
  if (!project) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  try {
    await downloadProject(store, project);
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The download pipeline shared by the Download command and Build and
 * Download (the latter calls it only after a successful build). Resolves
 * false when the download failed; a firmware-picker cancellation is not a
 * failure and resolves true. The project only becomes ACTIVE once the user
 * commits to a firmware (cancelling the picker must not switch contexts).
 */
export async function downloadProject(store: ProjectStore, project: MrsProject): Promise<boolean> {
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(t('installNotFound'));
    return false;
  }

  const hex = await pickFirmware(project);
  if (!hex) return true;
  if (!fs.existsSync(hex)) {
    vscode.window.showErrorMessage(t('firmwareNotFound', hex));
    return false;
  }

  const cfg = vscode.workspace.getConfiguration('mrvc');
  const openocd = cfg.get<string>('openocd.path') || install.openocdExe;
  const boardCfg = selectBoardCfg(project, cfg);
  if (!fs.existsSync(openocd)) {
    vscode.window.showErrorMessage(t('openocdNotFound', openocd));
    return false;
  }
  if (!fs.existsSync(boardCfg)) {
    vscode.window.showErrorMessage(t('openocdCfgNotFound', boardCfg));
    return false;
  }

  // address priority: explicit setting → .template (written by MRS2/the
  // properties Chip page) → chip-family inference from source-file prefixes
  // (EVT trees ship without .template) → CH58x-style default
  const address =
    cfg.get<string>('flash.address') || project.template.values['Address'] || inferFlashAddressFromSources(project) || '0x00000000';
  // prepareFlash rejects a malformed address (an unset setting key, a .template
  // Address someone typed by hand). It must surface as an error message here:
  // callers like "Build And Download" await this after a successful build,
  // where a thrown error would vanish into an unhandled rejection and the
  // download would silently not happen.
  let plan: FlashPlan;
  try {
    plan = prepareFlash({
      buildDir: project.buildDir,
      address,
      verify: cfg.get<boolean>('flash.verify', true),
      reset: cfg.get<boolean>('flash.reset', true),
      boardCfg,
      firmware: hex,
      // .template "Erase All" checkbox (MRS2's Chip properties page): scrub
      // the whole flash before writing; dual-core cfgs expose two banks
      eraseAll: String(project.template.values['Erase All'] ?? '').trim().toLowerCase() === 'true',
      banks: project.kernel ? 2 : 1,
    });
  } catch (e) {
    vscode.window.showErrorMessage(t('flashAddressInvalid', project.projectName, e instanceof Error ? e.message : String(e)));
    return false;
  }

  store.setActive(project);
  const task = new vscode.Task(
    { type: 'mrvc-flash', task: 'flash', project: project.projectName },
    `MRVC: download - ${project.projectName}`,
    'MRVC',
    new vscode.ProcessExecution(openocd, plan.args, { cwd: project.root })
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  const code = await executeFlashTask(task);
  if (code !== 0) {
    vscode.window.showErrorMessage(t('downloadFailed', project.projectName, code ?? 'unknown'));
    return false;
  }
  return true;
}

export function openLinkUtility(): void {
  const install = getInstall();
  if (!install || !fs.existsSync(install.linkUtilityExe)) {
    vscode.window.showErrorMessage(t('linkUtilityNotFound'));
    return;
  }
  const task = new vscode.Task(
    { type: 'mrvc-tool', task: 'wch-link-utility' },
    'MRVC: WCH-LinkUtility',
    'MRVC',
    new vscode.ProcessExecution(install.linkUtilityExe, [], { cwd: path.dirname(install.linkUtilityExe) })
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Never };
  void vscode.tasks.executeTask(task);
}

export function openMrsTerminal(store: ProjectStore): void {
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(t('installNotFound'));
    return;
  }
  const toolDirs: string[] = [];
  const tc = store.active?.toolchain(install, vscode.workspace.getConfiguration('mrvc').get('toolchain', 'auto'));
  if (tc) toolDirs.push(path.join(tc.dir, 'bin'));
  const envPath = [...toolDirs, install.makeBin, path.dirname(install.openocdExe), process.env['PATH'] ?? ''].join(';');
  const terminal = vscode.window.createTerminal({
    name: 'MRS Command Line',
    env: { ...process.env, PATH: envPath },
    cwd: store.active?.root,
  });
  terminal.show();
  terminal.sendText('echo MRVC toolchain environment ready (gcc, make, openocd on PATH)');
}
