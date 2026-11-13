/**
 * WCH-Link serial port discovery for the SDI PRINT monitor (pure Node,
 * testable without a link attached).
 *
 * Which port is the link's read side — registry-verified on 2026-11-11:
 *   WCH-Link / WCH-LinkE = composite USB device VID_1A86/PID_8010;
 *   its MI_01 interface is the CDC serial ("WCH-Link SERIAL (COM5)" —
 *   this machine's link; MI_00 is the WCH-LinkRV debug HID, not serial).
 * A CH343 (PID_55D3, e.g. "USB-SERIAL CH343 (COM3)") is the EVB board's own
 * standalone USB-serial chip — NOT the link, and must never be picked by
 * the automatic path. The filter therefore matches PID_8010 ONLY.
 */
/** the bits of SerialPort.list() the filter consumes (hex strings, no 0x) */
export interface SerialPortInfo {
  path: string;
  friendlyName?: string;
  vendorId?: string;
  productId?: string;
}

export interface WchLinkPort {
  /** the port path to open (COM5, /dev/ttyACM0, ...) */
  path: string;
  /** display label — the OS friendly name when available, else the path */
  label: string;
}

/** the serialport API surface the monitor consumes (serialport 11, N-API) */
export interface SerialPortLike {
  isOpen: boolean;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'open', cb: () => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  close(): void;
}

export interface SerialPortCtor {
  new (opts: { path: string; baudRate: number; autoOpen?: boolean }): SerialPortLike;
  list(): Promise<SerialPortInfo[]>;
}

export interface SerialportModule {
  SerialPort: SerialPortCtor;
}

/**
 * Resolve the serialport module: the dev repo resolves it from node_modules,
 * the installed extension from the shipped vendor copy (vsce cannot
 * re-include a negated node_modules subtree — the same two-literal pattern
 * as the koffi require in wlink.ts). `injected` is the test seam.
 */
export function resolveSerialPortModule(injected?: SerialportModule | null): SerialportModule | null {
  if (injected !== undefined) return injected;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('serialport') as SerialportModule;
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../vendor-serial/node_modules/serialport') as SerialportModule;
    } catch {
      return null;
    }
  }
}

/**
 * Filter a SerialPort.list() result down to WCH-Link CDC ports and give
 * them stable labels. Deterministic order (by path); the OS friendly name
 * ("WCH-Link SERIAL (COM5)") wins as the label when present, falling back
 * to the path (the usual POSIX shape).
 */
export function listWchLinkSerialPorts(list: SerialPortInfo[]): WchLinkPort[] {
  return list
    .filter((p) => (p.vendorId ?? '').toLowerCase() === '1a86' && (p.productId ?? '').toLowerCase() === '8010')
    .map((p) => ({ path: p.path, label: (p.friendlyName ?? '').trim() || p.path })
    )
    .sort((a, b) => a.path.localeCompare(b.path));
}
