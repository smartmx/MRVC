/**
 * SDI Printf state as far as it can be KNOWN — this is deliberately not a
 * hardware read-back.
 *
 * WCH's CommunicationLib exposes only the setter `McuCompiler_SetSDIPrn`
 * (argument 0 = enable, 1 = disable; proven by WCH-LinkUtility's disassembly)
 * and no getter. The Link protocol has a single SDI command with a
 * write payload — WCH-LinkUtility, MRS and OpenOCD all only ever write it.
 * The flag is therefore not readable, so the Info view can only report what
 * MRVC itself last wrote in this extension-host session:
 *
 *   unknown  nothing written by MRVC since the window started (a Link that
 *            was enabled by MRS/WCH-LinkUtility also shows as unknown)
 *   enabled  the download's native reset+enable pass returned success
 *   failed   the native pass ran and failed
 *   notRequested  the last successful download did NOT ask for SDI Printf.
 *            The link switch is sticky — the DLL only calls SetSDIPrn(0)
 *            when bit16 is set and never disables on a plain download — so
 *            this says what the download requested, not that the link is off.
 *
 * Window reload starts from unknown; the monitor resets it explicitly when it
 * finds no WCH-Link port (there is no USB attach/detach listener).
 */
export type SdiPrintfState = 'unknown' | 'enabled' | 'failed' | 'notRequested';

export interface SdiPrintfStatus {
  state: SdiPrintfState;
  /** epoch ms of the last state change (enable success / non-SDI download) */
  at?: number;
  /** failure detail of the last MRVC attempt */
  detail?: string;
}

let current: SdiPrintfStatus = { state: 'unknown' };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // a listener must never break the writer (flash flow)
    }
  }
}

export function sdiPrintfStatus(): SdiPrintfStatus {
  return current;
}

export function noteSdiPrintfEnabled(at: number = Date.now()): void {
  current = { state: 'enabled', at };
  emit();
}

export function noteSdiPrintfFailed(detail: string): void {
  current = { state: 'failed', detail };
  emit();
}

/** a successful download whose .template did not request SDI Printf */
export function noteSdiPrintfNotRequested(at: number = Date.now()): void {
  current = { state: 'notRequested', at };
  emit();
}

export function resetSdiPrintfStatus(): void {
  current = { state: 'unknown' };
  emit();
}

export function onSdiPrintfStatusChanged(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}
