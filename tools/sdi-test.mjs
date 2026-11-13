/**
 * SDI PRINT monitor core (out/core/serial.js): the WCH-Link port filter and
 * the vendor fallback chain. The fixture mirrors the registry-verified
 * shapes from this machine (2026-11-11): the link's CDC is the composite
 * VID_1A86/PID_8010 MI_01 interface ("WCH-Link SERIAL (COM5)"); the EVB's
 * own CH343 ("USB-SERIAL CH343 (COM3)", PID_55D3) is NOT the link and must
 * never be auto-picked.
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEVELOP_DIR = path.join(here, '..');
const { resolveSerialPortModule, listWchLinkSerialPorts } = require_(path.join(DEVELOP_DIR, 'out', 'core', 'serial.js'));

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// registry-real port shapes (this machine, 2026-11-11)
const LIST = [
  { path: 'COM1', friendlyName: '通信端口 (COM1)', vendorId: undefined, productId: undefined },
  { path: 'COM3', friendlyName: 'USB-SERIAL CH343 (COM3)', vendorId: '1a86', productId: '55d3' },
  { path: 'COM5', friendlyName: 'WCH-Link SERIAL (COM5)', vendorId: '1a86', productId: '8010' },
];
{
  const ports = listWchLinkSerialPorts(LIST);
  check('filter: only the link CDC survives (EVB CH343/COM3 excluded)', ports.length === 1 && ports[0].path === 'COM5');
  check('filter: label is the OS friendly name', ports[0].label === 'WCH-Link SERIAL (COM5)');

  // this machine saw a second link historically (COM4) — both must come back
  const two = listWchLinkSerialPorts([
    ...LIST,
    { path: 'COM4', friendlyName: 'WCH-Link SERIAL (COM4)', vendorId: '1A86', productId: '8010' },
  ]);
  check('filter: multiple links all returned in stable path order', two.length === 2 && two[0].path === 'COM4' && two[1].path === 'COM5');

  check(
    'filter: other WCH chips (CH340 7523) and non-WCH (CP210x) never qualify',
    listWchLinkSerialPorts([
      { path: 'COM7', vendorId: '10c4', productId: 'ea60' },
      { path: 'COM8', vendorId: '1a86', productId: '7523' },
    ]).length === 0
  );

  check(
    'filter: missing friendlyName falls back to the path (POSIX shape)',
    listWchLinkSerialPorts([{ path: '/dev/ttyACM0', vendorId: '1a86', productId: '8010' }])[0].label === '/dev/ttyACM0'
  );

  check('filter: empty list -> empty result', listWchLinkSerialPorts([]).length === 0);
}

{
  // the injection seam passes values through untouched (test-only branch)
  const mod = { SerialPort: class {} };
  check('resolve: injected module passes through', resolveSerialPortModule(mod) === mod);
  check('resolve: explicit null passes through', resolveSerialPortModule(null) === null);
  // dev resolution: node_modules OR the vendored copy — either way it must
  // be a module with a SerialPort constructor, or null (never a throw)
  const real = resolveSerialPortModule();
  check('resolve: real resolution is a module or null, never a throw', real === null || typeof real.SerialPort === 'function');
  // the vendored copy itself must load on this Node (what the shipped vsix
  // will require) — N-API prebuilds, no install step
  const vendored = require_(path.join(DEVELOP_DIR, 'vendor-serial', 'node_modules', 'serialport'));
  check('resolve: the vendored serialport loads (N-API prebuild)', typeof vendored.SerialPort === 'function');
}

{
  // session-scoped SDI state: WCH exposes no getter, so the Info row can only
  // mirror MRVC's own last write. Default is unknown; writes flip it; unplug
  // (monitor with no link) resets it; listeners drive the Info refresh.
  const {
    sdiPrintfStatus,
    noteSdiPrintfEnabled,
    noteSdiPrintfFailed,
    noteSdiPrintfNotRequested,
    resetSdiPrintfStatus,
    onSdiPrintfStatusChanged,
  } = require_(path.join(DEVELOP_DIR, 'out', 'core', 'sdiState.js'));
  let events = 0;
  const sub = onSdiPrintfStatusChanged(() => events++);
  check('state: default is unknown', sdiPrintfStatus().state === 'unknown');
  noteSdiPrintfEnabled(1700000000000);
  check('state: enable is remembered with its timestamp', sdiPrintfStatus().state === 'enabled' && sdiPrintfStatus().at === 1700000000000);
  noteSdiPrintfFailed('open failed');
  check('state: failure keeps its detail', sdiPrintfStatus().state === 'failed' && sdiPrintfStatus().detail === 'open failed');
  noteSdiPrintfNotRequested(1700000001000);
  check(
    'state: a download without SDIPrintf is recorded separately',
    sdiPrintfStatus().state === 'notRequested' && sdiPrintfStatus().at === 1700000001000
  );
  resetSdiPrintfStatus();
  check('state: reset returns to unknown', sdiPrintfStatus().state === 'unknown');
  check('state: each transition notified listeners', events === 4);
  sub.dispose();
  noteSdiPrintfEnabled();
  check('state: a disposed listener is not called', events === 4);
}

process.exit(failures ? 1 : 0);
