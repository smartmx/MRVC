/**
 * Power-off reset (掉电复位) execution channel: the WCH-Link target-rail
 * power cycle through two SHORT OpenOCD sessions (off → host delay → on),
 * plus the shared plumbing the download reuses (board-cfg selection, task
 * wait). The builders and the retry policy are pure (core/powerCycle.ts,
 * core/flash.ts transientOpenOcdFailure); this module only drives tasks.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getInstall, MrsProject } from './projects';
import { clampPowerOffDelay, freshLogPath, powerPassVerdict, preparePowerPass } from '../core/powerCycle';
import { PowerVoltage } from '../core/flash';
import { MrsInstall } from '../core/toolchain';
import { checkWCHLinkFirmware, linkSupportsPowerOutput, WlinkFirmwareCheck } from '../core/wlink';
import { t } from '../core/i18n';
import { waitTaskProcess } from './taskRunner';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readLog(logPath: string): string {
  try {
    return fs.readFileSync(logPath, 'utf-8');
  } catch {
    return '';
  }
}

/** this attempt's log file (freshLogPath in core/powerCycle.ts owns the
 * mkdir/unique-name/containment rules — it is unit-tested by power-test) */
function logPath(project: MrsProject, base: string, attempt: number): string {
  return freshLogPath(project.root, project.buildDir, base, attempt);
}

/**
 * Board cfg selection, aligned with MRS2's own rule (its debug launcher):
 * the explicit setting wins, dual-core projects need wch-dual-core.cfg
 * (core1's flash bank sits at 0x00005000), ARM toolchains need
 * wch-arm.cfg, everything else uses the stock wch-riscv.cfg. Chip series
 * never enters the choice — address differences ride on the .template.
 */
export function selectBoardCfg(project: MrsProject, cfg: vscode.WorkspaceConfiguration): string {
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

/** run the flash/power task and resolve with its exit code (undefined = no
 * end event) — both channels use the mrvc-flash task type so the dedicated
 * panel, output reveal and stop come for free. The early-event/identity
 * matching lives in taskRunner (shared with the open-with wrapper). */
export async function executeFlashTask(task: vscode.Task, token?: vscode.CancellationToken): Promise<number | undefined> {
  return waitTaskProcess(task, 'mrvc-flash', token);
}

/** the openocd binary for a download/power run: the explicit setting wins */
export function resolveOpenocd(cfg: vscode.WorkspaceConfiguration, install: MrsInstall): string {
  return cfg.get<string>('openocd.path') || install.openocdExe;
}

/**
 * The unsupported-link gate for every power-rail operation: per WCH's manuals
 * only WCH-LinkE / DAPLink / LinkW can switch the target rail — the plain
 * WCH-Link cannot, so its power-off reset would silently do nothing. Null =
 * proceed (no query result, unknown id, or bridge failure — the passes
 * themselves stay the ground truth, same tolerance as the chip guard).
 */
export function powerLinkUnsupportedNotice(fw?: WlinkFirmwareCheck): string | null {
  if (!fw || fw.linkId === undefined) return null;
  if (linkSupportsPowerOutput(fw.linkId) === false) {
    return t('powerLinkUnsupported', fw.linkName ?? 'WCH-Link');
  }
  return null;
}

/** best-effort link model query for the gate (the 0.2.8 firmware check
 * bridge already returns the linkID — no new FFI surface) */
export async function queryLinkModelForPower(install: MrsInstall): Promise<WlinkFirmwareCheck | undefined> {
  try {
    return await checkWCHLinkFirmware(install);
  } catch {
    return undefined;
  }
}

/**
 * ONE power pass (off or on) as a visible task, with the transient
 * re-enumeration retry (max 2, 500 ms backoff) from powerPassVerdict. The
 * OFF pass carries the MRVC_POWER_OFF_OK marker as its success evidence
 * (see core/powerCycle powerPassVerdict). Failure messages are shown here —
 * both callers just branch on the boolean.
 */
async function runPowerPass(opts: {
  project: MrsProject;
  openocd: string;
  boardCfg: string;
  voltage: PowerVoltage;
  state: 'off' | 'on';
  halt?: boolean;
  token?: vscode.CancellationToken;
}): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if (opts.token?.isCancellationRequested) return false;
    // per attempt: a stale log would misclassify this run — freshLogPath
    // deletes the previous file (or falls back to a unique name when it is
    // held) and makes sure the build dir exists at all
    const logPathForAttempt = logPath(opts.project, opts.state === 'off' ? 'mrvc_power_off' : 'mrvc_power_on', attempt);
    const args = preparePowerPass({ boardCfg: opts.boardCfg, voltage: opts.voltage, state: opts.state, halt: opts.halt, logPath: logPathForAttempt });
    const task = new vscode.Task(
      { type: 'mrvc-flash', task: opts.state === 'off' ? 'power-off' : 'power-on', project: opts.project.projectName, root: opts.project.root },
      `MRVC: power ${opts.state} - ${opts.project.projectName}`,
      'MRVC',
      new vscode.ProcessExecution(opts.openocd, args, { cwd: opts.project.root })
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    const code = await executeFlashTask(task, opts.token);
    if (opts.token?.isCancellationRequested) return false;
    const verdict = powerPassVerdict(opts.state, code, readLog(logPathForAttempt), attempt);
    if (verdict.action === 'done') return true;
    if (verdict.action === 'fail') {
      vscode.window.showErrorMessage(t('powerResetFailed', t(opts.state === 'off' ? 'powerStageOff' : 'powerStageOn'), String(code ?? 'unknown')));
      return false;
    }
    vscode.window.showInformationMessage(t('powerRetry', String(attempt + 1), '2'));
    await sleep(500);
  }
}

/**
 * The download-side pre-pass for mrvc.flash.resetMode=powerOff: run the OFF
 * pass, wait powerOffDelayMs, and report the rail the download script must
 * switch back ON (prepareFlash powerOn). Null = the pass failed fatally —
 * the caller aborts the download.
 */
export async function powerOffBeforeDownload(
  project: MrsProject,
  install: MrsInstall,
  cfg: vscode.WorkspaceConfiguration,
  token?: vscode.CancellationToken
): Promise<PowerVoltage | null> {
  const openocd = resolveOpenocd(cfg, install);
  if (!fs.existsSync(openocd)) {
    vscode.window.showErrorMessage(t('openocdNotFound', openocd));
    return null;
  }
  const boardCfg = selectBoardCfg(project, cfg);
  if (!fs.existsSync(boardCfg)) {
    vscode.window.showErrorMessage(t('openocdCfgNotFound', boardCfg));
    return null;
  }
  const voltage: PowerVoltage = cfg.get<string>('flash.powerOutput', '3v3') === '5v' ? '5v' : '3v3';
  if (!(await runPowerPass({ project, openocd, boardCfg, voltage, state: 'off', token }))) return null;
  await sleep(clampPowerOffDelay(cfg.get<number>('flash.powerOffDelayMs', 100)));
  if (token?.isCancellationRequested) return null;
  return voltage;
}

/**
 * The standalone 掉电复位 command: off → delay → on (no halt — the chip
 * runs again immediately). One visible task per pass in the dedicated MRVC
 * panel; the passes share the guard-free path (a reset does not need the
 * chip-family or firmware checks a download runs).
 */
export async function powerOffResetCmd(
  store: { active: MrsProject | null; setActive(project: MrsProject): void },
  item?: { project?: unknown }
): Promise<void> {
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
  // the plain WCH-Link cannot switch the rail — fail fast with the reason
  const notice = powerLinkUnsupportedNotice(await queryLinkModelForPower(install));
  if (notice) {
    await vscode.window.showWarningMessage(notice, { modal: true });
    return;
  }
  const cfg = vscode.workspace.getConfiguration('mrvc');
  const openocd = resolveOpenocd(cfg, install);
  if (!fs.existsSync(openocd)) {
    vscode.window.showErrorMessage(t('openocdNotFound', openocd));
    return;
  }
  const boardCfg = selectBoardCfg(project, cfg);
  if (!fs.existsSync(boardCfg)) {
    vscode.window.showErrorMessage(t('openocdCfgNotFound', boardCfg));
    return;
  }
  const voltage: PowerVoltage = cfg.get<string>('flash.powerOutput', '3v3') === '5v' ? '5v' : '3v3';
  store.setActive(project);
  if (!(await runPowerPass({ project, openocd, boardCfg, voltage, state: 'off' }))) return;
  await sleep(clampPowerOffDelay(cfg.get<number>('flash.powerOffDelayMs', 100)));
  if (!(await runPowerPass({ project, openocd, boardCfg, voltage, state: 'on' }))) return;
  vscode.window.showInformationMessage(t('powerResetDone', project.projectName));
}
