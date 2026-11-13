/**
 * SDI PRINT monitor — reads the WCH-Link's CDC serial port into a terminal
 * (requirement 0.3.0-A). The link decodes the chip's SDI printf stream and
 * spits it out of its serial interface once the one-time enable is written
 * (MRVC replicates MRS's native path AFTER the download: core/wlink's
 * `sdiPrint` op calls MRSFunc_FlashOperationExB with RESET|SDIPrintf, which
 * resets the target and flips the switch in one DLL session; OpenOCD's
 * `sdi_printf` re-enumerates the link and kills the session it rides in).
 * Read side is one-way only.
 *
 * Port selection never guesses: only VID_1A86/PID_8010 CDC ports (the
 * link's own serial interface — "WCH-Link SERIAL (COM5)") qualify; the
 * board-level CH343 (PID_55D3) and any other USB-serial chip are excluded,
 * and multiple links raise a quick pick. `mrvc.sdiPrint.port` overrides the
 * automatic detection outright.
 */
import * as vscode from 'vscode';
import { listWchLinkSerialPorts, resolveSerialPortModule, SerialPortLike, SerialportModule } from '../core/serial';
import { resetSdiPrintfStatus } from '../core/sdiState';
import { t } from '../core/i18n';

/** the one live monitor terminal (a second start replaces it) */
let terminal: vscode.Terminal | undefined;
let pty: SdiPrintPty | undefined;

/** pty wrapper: bridges serialport's events into terminal writes */
class SdiPrintPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<number | undefined>();
  readonly onDidClose = this.closeEmitter.event;
  private port: SerialPortLike | undefined;

  constructor(
    private readonly mod: SerialportModule,
    readonly portPath: string,
    private readonly baud: number
  ) {}

  open(): void {
    let port: SerialPortLike;
    try {
      port = new this.mod.SerialPort({ path: this.portPath, baudRate: this.baud, autoOpen: true });
    } catch (e) {
      this.fail(t('sdiOpenError', e instanceof Error ? e.message : String(e)));
      return;
    }
    this.port = port;
    port.on('open', () => {
      this.writeEmitter.fire(`[MRVC] ${this.portPath} @ ${this.baud} — ${t('sdiConnected')}\r\n\r\n`);
    });
    port.on('data', (chunk: Buffer) => {
      // SDI printf payload is text; CR-terminate for the terminal surface.
      // latin1 keeps every byte visible if the firmware sends binary noise.
      this.writeEmitter.fire(chunk.toString('latin1').replace(/\r?\n/g, '\r\n'));
    });
    port.on('error', (err: Error) => {
      this.fail(t('sdiOpenError', err.message));
    });
    port.on('close', () => {
      this.writeEmitter.fire(`\r\n[MRVC] ${t('sdiClosed')}\r\n`);
    });
  }

  /** report a failure WITHOUT closing the terminal: firing close here would
   *  dispose the terminal and hide the reason (held port / unplugged link)
   *  before the user could read it — the user closes the tab or retries */
  private fail(message: string): void {
    this.writeEmitter.fire(`\r\n[MRVC] ${message}\r\n`);
    if (/denied|busy|占用/i.test(message)) this.writeEmitter.fire(`[MRVC] ${t('sdiPortBusyHint')}\r\n`);
  }

  /** user "kill" / Stop command / window close — release the port */
  close(): void {
    try {
      if (this.port?.isOpen) this.port.close();
    } catch {
      // the OS reclaims the handle even if close() races the driver
    }
  }

  dispose(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

function settleTerminal(): void {
  pty = undefined;
  terminal = undefined;
}

export function initSdiMonitor(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) settleTerminal();
    })
  );
}

/** start (or focus) the SDI PRINT monitor terminal */
export async function sdiPrintMonitorCmd(): Promise<void> {
  if (terminal) {
    terminal.show(true);
    return;
  }
  const mod = resolveSerialPortModule();
  if (!mod) {
    vscode.window.showErrorMessage(t('sdiSerialMissing'));
    return;
  }
  const cfg = vscode.workspace.getConfiguration('mrvc');
  let portPath = cfg.get<string>('sdiPrint.port', '').trim();
  let label = portPath;
  if (!portPath) {
    let ports;
    try {
      ports = listWchLinkSerialPorts(await mod.SerialPort.list());
    } catch (e) {
      vscode.window.showErrorMessage(t('sdiListError', e instanceof Error ? e.message : String(e)));
      return;
    }
    if (!ports.length) {
      // no link present: any remembered "enabled" state is no longer current
      // (an unplug clears the link's SDI switch), so the Info row degrades
      // to unknown instead of lying
      resetSdiPrintfStatus();
      vscode.window.showErrorMessage(t('sdiNoPort'));
      return;
    }
    let chosen = ports[0];
    if (ports.length > 1) {
      const pick = await vscode.window.showQuickPick(
        ports.map((p) => ({ label: p.label, description: p.path, port: p })),
        { title: t('sdiPickTitle') }
      );
      if (!pick) return;
      chosen = pick.port;
    }
    portPath = chosen.path;
    label = chosen.label;
  }
  const baud = cfg.get<number>('sdiPrint.baud', 115200);
  pty = new SdiPrintPty(mod, portPath, baud);
  pty.onDidClose(() => {
    // port closed by the OS/driver/unplug — retire the terminal entry
    terminal?.dispose();
    settleTerminal();
  });
  terminal = vscode.window.createTerminal({
    name: `SDI PRINT - ${label}`,
    pty,
  });
  terminal.show(true);
}

/** stop the running monitor (the terminal entry disappears with it) */
export function sdiPrintStopCmd(): void {
  if (!terminal) {
    vscode.window.showInformationMessage(t('sdiStopNone'));
    return;
  }
  terminal.dispose();
  settleTerminal();
}
