/**
 * Flash (download) via OpenOCD (run as a VSCode task so output/stop come
 * for free), plus the WCH-LinkUtility GUI launcher and the MRS terminal.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectStore, MrsProject, getInstall } from './projects';
import { prepareFlash, inferFlashAddress, FlashPlan, PowerVoltage } from '../core/flash';
import { healTargetPath, staleTargetPath } from '../core/templateFile';
import { scanSources } from '../core/scan';
import { checkWCHLinkFirmware, formatLinkVersion, runWlinkOp, wchlinkFirmwareCfgPath, WlinkFirmwareCheck } from '../core/wlink';
import { MrsInstall } from '../core/toolchain';
import { chipDbRoot, scanChipDb, chipForTemplate, guardLinkedChip } from '../core/chipdb';
import { executeFlashTask, powerLinkUnsupportedNotice, powerOffBeforeDownload, selectBoardCfg } from './powerCycle';
import { noteSdiPrintfEnabled, noteSdiPrintfFailed, noteSdiPrintfNotRequested } from '../core/sdiState';
import { t } from '../core/i18n';

/**
 * What a download will actually flash for this project — the .template
 * Target Path when it exists on disk, else the project's own obj artifact
 * (EVT packages ship cross-project Target Paths: CH394Q__MACRAW's template
 * points at obj\CH394Q__TCP_SERVER.hex, another project's artifact — the
 * display must show the resolved target, not the stale raw value).
 * Falls back to the recorded raw value when nothing exists; callers check
 * existence before flashing (and offer the compile step).
 */
export function resolveDownloadTarget(project: MrsProject): string {
  const target = project.template.values['Target Path']?.trim();
  if (target) {
    const cand = path.isAbsolute(target) ? target : path.join(project.root, target);
    if (fs.existsSync(cand)) return cand;
  }
  if (fs.existsSync(project.hexPath)) return project.hexPath;
  return target ?? '';
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

/**
 * Target-chip guard (MRS2/MRS3 parity): MRS refuses a download whose project
 * chip family differs from the chip on the link — with MRVC a CH32V307
 * project flashed into a CH32V407 board goes through and the board never
 * runs. Both sides resolve to the SDK flash-control id: the project through
 * MRS2's own chain (.template → SDK chip db, including the per-model
 * "special" override in flash.json), the link through GetLinkedMCUID — the
 * same query MRS uses to report the current chip model, and the same id
 * space MRS passes to MRSFunc_FlashOperationExB (whose DLL-side check
 * answers "Chip type mismatch." 10006). MRVC flashes through OpenOCD, so the
 * comparison has to happen before the spawn instead.
 *
 * The comparison itself lives in chipTargetMismatch() (pure, tested); this
 * wrapper only supplies the environment. The query result is passed as
 * trusted ONLY when its init sequence completed ('ok') — a raw GetLinkedMCUID
 * answers the LINK's own id, and 6 is both LinkE's id and CH32V30x's family
 * id, which would silently pass a real mismatch. Every other failure mode
 * (no SDK, no wchlink.wcfg, no link, no FFI bridge, upgrade-needed, unknown
 * id) also resolves to "unknown" and lets the download proceed unchanged.
 */
async function chipFamilyMismatch(
  install: MrsInstall,
  project: MrsProject
): Promise<{ connected: string; expected: string } | undefined> {
  if (!fs.existsSync(wchlinkFirmwareCfgPath(install))) return undefined;
  const db = scanChipDb(chipDbRoot(install.resourcesDir));
  if (!db.available) return undefined;
  // guardLinkedChip resolves the project target BEFORE querying: a
  // .template-less EVT project has no target chip to compare against, so the
  // link query (a PowerShell round trip on Windows) is skipped entirely
  return guardLinkedChip(db, project.template.values, async () => {
    try {
      const r = await runWlinkOp(install, 'queryMcuId', { chipId: 0, clkSpeed: 1, dbgMode: 0 });
      return { result: r.result, initState: r.initState };
    } catch {
      return {};
    }
  });
}

export async function flashProject(store: ProjectStore, proj?: MrsProject): Promise<void> {
  const project = proj ?? store.active;
  if (!project) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('progressDownloadProject', project.projectName), cancellable: true },
      (_progress, token) => downloadProject(store, project, token)
    );
  } catch (e) {
    vscode.window.showErrorMessage(`MRVC: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The download pipeline shared by the Download command and Build and
 * Download (the latter calls it only after a successful build). Resolves
 * false when the download failed; a cancelled stale-target fix or "compile
 * first" stop is NOT a failure and resolves true.
 */
export async function downloadProject(
  store: ProjectStore,
  project: MrsProject,
  token?: vscode.CancellationToken
): Promise<boolean> {
  const cancelled = (): false => {
    vscode.window.showInformationMessage(t('downloadCancelled', project.projectName));
    return false;
  };
  const isCancelled = (): boolean => token?.isCancellationRequested === true;
  if (isCancelled()) return cancelled();
  const install = getInstall();
  if (!install) {
    vscode.window.showErrorMessage(t('installNotFound'));
    return false;
  }

  // Stale .template Target Path (EVT trees record another project's
  // artifact, e.g. CH394Q__MACRAW -> obj\CH394Q__TCP_SERVER.hex, absent on
  // this machine): the download falls back to the project's own artifact,
  // but .template still records a file that does not exist. Ask FIRST — the
  // recorded value is the user's to change. On confirm the key is rewritten
  // and the user is told to download again; on decline the value stays and
  // the download proceeds with the fallback resolution as before.
  const stale = staleTargetPath(project.root, project.hexPath);
  if (stale) {
    const fix = t('templateTargetFix');
    const pick = await vscode.window.showWarningMessage(
      t('templateTargetStalePrompt', stale.old, stale.next),
      { modal: true },
      fix,
      t('templateTargetKeep')
    );
    if (pick === fix) {
      healTargetPath(project.root, project.hexPath);
      project.reload();
      // modal, not a toast: the confirmation must be seen — a plain
      // notification right after the dialog can be missed or suppressed by
      // Do Not Disturb (reported as "no message after choosing Modify")
      await vscode.window.showInformationMessage(t('templateTargetHealed', stale.old, stale.next), { modal: true });
      return true;
    }
  }
  if (isCancelled()) return cancelled();

  // Nothing to flash: neither the recorded target nor the project's own
  // artifact exists (project never built). Point the user at the compile
  // step — the .template Target Path is the MRS-side way to aim elsewhere.
  const hex = resolveDownloadTarget(project);
  if (!hex || !fs.existsSync(hex)) {
    // modal like the stale-target prompt — the "build first" guidance must
    // not be missable as a fading toast. NOT a failure: the pipeline stopped
    // on a user-actionable prerequisite without attempting a download, so it
    // resolves true (the same contract as the cancelled stale-target fix).
    await vscode.window.showWarningMessage(t('projectNotBuilt', project.hexPath), { modal: true });
    return true;
  }
  if (isCancelled()) return cancelled();

  const cfg = vscode.workspace.getConfiguration('mrvc');
  const openocd = cfg.get<string>('openocd.path') || install.openocdExe;
  const boardCfg = selectBoardCfg(project, cfg);
  // power-off-reset download: de-energise before the session, the script
  // brings the rail back up (prepareFlash powerOn as its FIRST step)
  const powerOff = cfg.get<string>('flash.resetMode', 'nrst') === 'powerOff';
  const powerOn: PowerVoltage | undefined = powerOff ? (cfg.get<string>('flash.powerOutput', '3v3') === '5v' ? '5v' : '3v3') : undefined;
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
      powerOn,
    });
  } catch (e) {
    vscode.window.showErrorMessage(t('flashAddressInvalid', project.projectName, e instanceof Error ? e.message : String(e)));
    return false;
  }

  // Target-chip guard BEFORE the OpenOCD spawn (MRS2/MRS3 behave the same):
  // a project built for one chip family must not be flashed into another.
  // Only an explicit "download anyway" gets past the dialog — Esc/closing it
  // cancels, and a cancelled download is reported as not completed (same as
  // declining the firmware-upgrade prompt below).
  const mismatch = await chipFamilyMismatch(install, project);
  if (isCancelled()) return cancelled();
  if (mismatch) {
    const proceed = t('chipMismatchContinue');
    const pick = await vscode.window.showWarningMessage(
      t('chipMismatchPrompt', mismatch.connected, mismatch.expected),
      { modal: true },
      proceed,
      t('chipMismatchCancel')
    );
    if (pick !== proceed) return false;
  }

  // WCH-Link firmware check (0.2.8, READ-ONLY — detect only): an out-of-date
  // link firmware misbehaves during flashing. Best-effort and silent on any
  // check failure; an upgrade-needed result offers the WCH-LinkUtility route
  // instead of MRVC flashing the link itself (parity with MRS's pre-download
  // doUpdate check). Runs before the OpenOCD spawn so the USB device is free.
  // The result also feeds the power-off gate below (link model — no second
  // bridge round trip for it).
  let fwCheck: WlinkFirmwareCheck | undefined;
  try {
    fwCheck = await checkWCHLinkFirmware(install);
    const fw = fwCheck;
    if (fw.state === 'upgrade-needed') {
      const openUtil = t('wchLinkFwOpenUtility');
      const continueBtn = t('wchLinkFwContinue');
      const pick = await vscode.window.showWarningMessage(
        t('wchLinkFwUpdateNeeded', fw.linkName ?? 'WCH-Link', formatLinkVersion(fw.currentVersion), formatLinkVersion(fw.expectedVersion)),
        { modal: true },
        openUtil,
        continueBtn
      );
      // ONLY an explicit "flash anyway" proceeds — Esc/closing the dialog
      // (undefined) cancels the download, matching MRS's doUpdate where a
      // dismissed confirmation aborts instead of flashing with a known-bad
      // link firmware (round2 §5)
      if (pick === continueBtn) {
        // fall through to the download
      } else {
        if (pick === openUtil) openLinkUtility();
        return false;
      }
    }
  } catch {
    // the firmware check must never block or crash a download
  }
  if (isCancelled()) return cancelled();

  // SDI Printf (.template SDIPrintf=true). MRS's own mechanism is NOT
  // OpenOCD's `sdi_printf` (that re-enumerates the link and kills the
  // session); it is MRSFunc_FlashOperationExB with flags RESET|SDIPrintf.
  // The vendor sequence resets the target and enables the link's SDI
  // forwarder in one DLL session — verified on a CH394Q EVT: the boot banner
  // appears on the WCH-Link CDC port. The pass runs AFTER the OpenOCD
  // download so the flash itself stays on the tested OpenOCD path.
  const sdiPrintf = String(project.template.values['SDIPrintf'] ?? '').trim().toLowerCase() === 'true';
  let sdiChipId = 0;
  let sdiClk = 1;
  let sdiDbg = 0;
  let sdiAddr = 0;
  if (sdiPrintf) {
    const db = scanChipDb(chipDbRoot(install.resourcesDir));
    const control = db.available ? chipForTemplate(db, project.template.values) : undefined;
    sdiChipId = control && control.id > 0 ? control.id : 0;
    const clk = Number((project.template.values['CLKSpeed'] ?? '1').trim());
    sdiClk = clk === 2 || clk === 3 ? clk : 1;
    sdiDbg = (project.template.values['DebugInterfaceMode'] ?? '0').trim() === '1' ? 1 : 0;
    const parsed = /^0x/i.test(address) ? parseInt(address.slice(2), 16) : parseInt(address, 10);
    sdiAddr = Number.isFinite(parsed) ? parsed : 0;
  }

  // Power-off-reset download (mrvc.flash.resetMode=powerOff): de-energise
  // the target with a short OpenOCD pass, wait the configured delay, and let
  // the main session bring the rail back up (the script's first powerOn
  // step) — the "one power-down, power-up and download in ONE OpenOCD
  // session" flow. Runs AFTER the guard and firmware checks so the USB
  // device is exclusively ours, like every other link access. The plain
  // WCH-Link cannot switch the rail at all (WCH docs: LinkE/DAPLink/LinkW
  // only) — the known linkId from the firmware check gates that case with
  // an explicit modal instead of two OpenOCD passes that cannot work.
  if (powerOff) {
    const notice = powerLinkUnsupportedNotice(fwCheck);
    if (notice) {
      await vscode.window.showWarningMessage(notice, { modal: true });
      return false;
    }
    if (!(await powerOffBeforeDownload(project, install, cfg, token))) return isCancelled() ? cancelled() : false;
  }
  if (isCancelled()) return cancelled();

  store.setActive(project);
  const task = new vscode.Task(
    { type: 'mrvc-flash', task: 'flash', project: project.projectName, root: project.root },
    `MRVC: download - ${project.projectName}`,
    'MRVC',
    new vscode.ProcessExecution(openocd, plan.args, { cwd: project.root })
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  // NO -l on the main download (progress belongs in the terminal); the
  // power-off pass has its own log classifier.
  const code = await executeFlashTask(task, token);
  if (isCancelled()) return cancelled();
  if (code !== 0) {
    vscode.window.showErrorMessage(t('downloadFailed', project.projectName, code ?? 'unknown'));
    return false;
  }
  // SDI Printf: MRS's native reset+enable pass (see core/wlink `sdiPrint`).
  // The VSCode SDI PRINT monitor is deliberately NOT opened here — the user
  // may keep their own serial tool (e.g. SSCOM) on the WCH-Link CDC port, and
  // an automatic open would collide with it. To capture the boot banner, open
  // MRVC's monitor manually BEFORE the download: this pass is the reset that
  // produces it. A failure is reported but never turns the (already
  // successful) download into a failure.
  if (sdiPrintf) {
    if (sdiChipId > 0) {
      try {
        const r = await runWlinkOp(install, 'sdiPrint', {
          chipId: sdiChipId,
          clkSpeed: sdiClk,
          dbgMode: sdiDbg,
          flashAddress: sdiAddr,
          flashPath: hex,
        });
        if (!r.ok) {
          noteSdiPrintfFailed(r.error ?? `code ${r.result ?? '?'}`);
          await vscode.window.showWarningMessage(t('sdiPrintfPassFailed', project.projectName, r.error ?? `code ${r.result ?? '?'}`));
        } else {
          noteSdiPrintfEnabled();
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        noteSdiPrintfFailed(detail);
        await vscode.window.showWarningMessage(t('sdiPrintfPassFailed', project.projectName, detail));
      }
    } else {
      // The download requested SDI Printf but the chip db gave no control id,
      // so the reset+enable pass cannot run. Record it as a failed attempt:
      // otherwise a stale `enabled`/`notRequested` from an earlier download
      // would claim this download succeeded when it never touched the link.
      const detail = t('sdiPrintfNoChipId', project.projectName);
      noteSdiPrintfFailed(detail);
      await vscode.window.showWarningMessage(detail);
    }
  } else {
    // a plain download never disables the link's sticky SDI switch, but the
    // row should at least show that THIS download did not request it
    noteSdiPrintfNotRequested();
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
  const envPath = [...toolDirs, install.makeBin, path.dirname(install.openocdExe), process.env['PATH'] ?? '']
    .filter(Boolean)
    .join(path.delimiter);
  const terminal = vscode.window.createTerminal({
    name: 'MRS Command Line',
    env: { ...process.env, PATH: envPath },
    cwd: store.active?.root,
  });
  terminal.show();
  terminal.sendText('echo MRVC toolchain environment ready (gcc, make, openocd on PATH)');
}
