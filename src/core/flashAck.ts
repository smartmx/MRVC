/**
 * Flash/Power verification receipts (0.3.6) — the gates that let the MCP
 * server touch hardware.
 *
 *  - flash: the extension writes <root>/.vscode/mrvc/flash-verified.json
 *    after every successful manual download, recording the SHA-256 of the
 *    project's .template (null when the project has none) AND the
 *    FINGERPRINT of the flash plan that actually ran (round4 P1): script
 *    body SHA (binds address/verify/reset/eraseAll/banks and the firmware
 *    path), firmware path, board cfg path AND content, the openocd binary
 *    and the power-on rail. The MCP server computes the same fingerprint for
 *    the plan it is about to run and refuses unless it matches EXACTLY.
 *  - power: a marker-verified MANUAL Power-Off Reset (round5 P1) writes
 *    <root>/.vscode/mrvc/power-verified.json with its own sequence
 *    fingerprint (voltage/delay/board cfg/openocd) — the flash receipt does
 *    NOT authorize rail switches.
 *
 * Locality + machine binding (round6 P3.2): every receipt records a machine
 * id (hostname+user hash) and the write path maintains a .gitignore in
 * .vscode/mrvc/ so the receipts never leave the machine through a commit.
 * A receipt copied with the project fails the machine check and reads as
 * unverified on the receiving machine.
 *
 * Receipt shape validation (round6 P3.3): a hand-edited or incompatible
 * receipt (plan fields missing/mistyped) is reported as CORRUPT with a
 * "re-run the manual step" message instead of surfacing as a generic
 * internal error.
 *
 * The firmware CONTENT is deliberately recorded but NOT compared: rebuilding
 * the project produces a new binary at the same path, and "rebuild then
 * re-flash" is the core AI workflow the receipt gate exists to enable — the
 * parameters are what the user verified, not the binary bytes.
 *
 * Pure Node (crypto/os are builtins) — shared by the extension (writes) and
 * the MCP server (reads + compares).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { foldPathOnPlatform } from './cproject';
import type { PowerVoltage } from './flash';

export interface FlashPlanFingerprint {
  address: string;
  verify: boolean;
  reset: boolean;
  eraseAll: boolean;
  banks: number;
  /** sha256 of the generated flash script body — binds the address,
   *  verify/reset, eraseAll/banks expansion and the firmware path inside it */
  scriptSha: string;
  firmwarePath: string;
  /** informational only (see module header): NOT part of the comparison */
  firmwareSha: string | null;
  boardCfgPath: string;
  boardCfgSha: string | null;
  openocdExe: string;
  /** the rail the plan powers back up (power-off-reset downloads); the MCP
   *  never produces this, so a recorded powerOn refuses the flash with a
   *  dedicated hint instead of a bare mismatch */
  powerOn: PowerVoltage | null;
}

export interface FlashAck {
  /** ISO timestamp of the verified download */
  time: string;
  /** sha256 of the raw .template bytes; null when the project has no .template */
  templateHash: string | null;
  /** the fingerprint of the plan that actually ran — null in legacy receipts */
  plan: FlashPlanFingerprint | null;
  /** machine binding (round6 P3.2) — receipts do not survive project copies */
  machine?: string;
  /** set by readFlashAck when the parsed receipt exists but its shape is
   *  unusable (hand-edited / incompatible version) */
  corrupt?: boolean;
}

export function flashAckPath(root: string): string {
  return path.join(root, '.vscode', 'mrvc', 'flash-verified.json');
}

function templatePath(root: string): string {
  return path.join(root, '.template');
}

/** sha256 of the raw .template bytes — null when the project has none */
export function templateHashOf(root: string): string | null {
  const file = templatePath(root);
  if (!fs.existsSync(file)) return null;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256File(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** forward slashes + Windows case folding — the two spellings a receipt and
 *  a later MCP run may legitimately differ in */
function normPath(p: string): string {
  return foldPathOnPlatform(path.resolve(p)).replace(/\\/g, '/');
}

/** stable per-machine id: hostname + user (receipts must not travel with
 *  the project — round6 P3.2). Best-effort: hostname alone on failure. */
export function machineId(): string {
  try {
    return createHash('sha256')
      .update(os.hostname() + '\n' + (os.userInfo().username ?? ''))
      .digest('hex')
      .slice(0, 32);
  } catch {
    return createHash('sha256').update(os.hostname()).digest('hex').slice(0, 32);
  }
}

/** keep the receipts out of version control — a nested .gitignore covers
 *  both files without touching the project's own .gitignore (round6 P3.2).
 *  round7 P3.2: an EXISTING ignore file is read and only the missing
 *  receipt entries are APPENDED — user entries are preserved, no duplicates. */
const RECEIPT_IGNORE_ENTRIES = ['flash-verified.json', 'power-verified.json'];

function ensureLocalIgnore(root: string): void {
  try {
    const dir = path.join(root, '.vscode', 'mrvc');
    fs.mkdirSync(dir, { recursive: true });
    const gi = path.join(dir, '.gitignore');
    let existing: string[] = [];
    if (fs.existsSync(gi)) {
      existing = fs
        .readFileSync(gi, 'utf-8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    }
    const missing = RECEIPT_IGNORE_ENTRIES.filter((e) => !existing.includes(e));
    if (!missing.length) return; // fully covered (file exists or was complete)
    fs.writeFileSync(gi, [...existing, ...missing].join('\n') + '\n', 'utf-8');
  } catch {
    // ignore maintenance is best-effort
  }
}

/**
 * Fingerprint the plan that ACTUALLY ran (or the one the caller is about to
 * run — the same core data feeds both sides). `scriptPath` must be the
 * written flash script (prepareFlash's plan.scriptPath).
 */
export function fingerprintFlashPlan(o: {
  scriptPath: string;
  firmware: string;
  boardCfg: string;
  openocdExe: string;
  address: string;
  verify: boolean;
  reset: boolean;
  eraseAll: boolean;
  banks: number;
  powerOn: PowerVoltage | null;
}): FlashPlanFingerprint {
  return {
    address: o.address.toLowerCase(),
    verify: o.verify,
    reset: o.reset,
    eraseAll: o.eraseAll,
    banks: o.banks,
    scriptSha: sha256File(o.scriptPath) ?? '',
    firmwarePath: normPath(o.firmware),
    firmwareSha: sha256File(o.firmware),
    boardCfgPath: normPath(o.boardCfg),
    boardCfgSha: sha256File(o.boardCfg),
    openocdExe: normPath(o.openocdExe),
    powerOn: o.powerOn ?? null,
  };
}

/** exact-match comparison over the bound fields (firmware content sha is
 *  informational — see the module header) */
export function samePlanFingerprint(a: FlashPlanFingerprint, b: FlashPlanFingerprint): boolean {
  return (
    a.address === b.address &&
    a.verify === b.verify &&
    a.reset === b.reset &&
    a.eraseAll === b.eraseAll &&
    a.banks === b.banks &&
    a.scriptSha === b.scriptSha &&
    normPath(a.firmwarePath) === normPath(b.firmwarePath) &&
    normPath(a.boardCfgPath) === normPath(b.boardCfgPath) &&
    a.boardCfgSha === b.boardCfgSha &&
    normPath(a.openocdExe) === normPath(b.openocdExe) &&
    a.powerOn === b.powerOn
  );
}

/** one readable line describing a recorded plan — refusal messages embed it
 *  so the AI can align its arguments to the verified plan exactly */
export function describePlanFingerprint(f: FlashPlanFingerprint): string {
  return (
    `address=${f.address} verify=${f.verify} reset=${f.reset} eraseAll=${f.eraseAll} banks=${f.banks} ` +
    `firmware="${f.firmwarePath}" boardCfg="${f.boardCfgPath}" openocd="${f.openocdExe}"` +
    (f.powerOn ? ` powerOn=${f.powerOn}` : '')
  );
}

/** record a verified download (the extension calls this after OpenOCD
 *  exited 0, with the fingerprint of the plan that ran; never throws — a
 *  receipt is an enhancement, not a requirement the download should fail
 *  over) */
export function writeFlashAck(root: string, plan?: FlashPlanFingerprint): FlashAck | null {
  try {
    ensureLocalIgnore(root);
    const ack: FlashAck = {
      time: new Date().toISOString(),
      templateHash: templateHashOf(root),
      plan: plan ?? null,
      machine: machineId(),
    };
    fs.writeFileSync(flashAckPath(root), JSON.stringify(ack, null, 1), 'utf-8');
    return ack;
  } catch {
    return null;
  }
}

/** runtime shape check for a parsed flash plan (round6 P3.3) */
function validFlashPlan(p: unknown): p is FlashPlanFingerprint {
  if (!p || typeof p !== 'object') return false;
  const f = p as FlashPlanFingerprint;
  return (
    typeof f.address === 'string' &&
    typeof f.verify === 'boolean' &&
    typeof f.reset === 'boolean' &&
    typeof f.eraseAll === 'boolean' &&
    typeof f.banks === 'number' &&
    typeof f.scriptSha === 'string' &&
    typeof f.firmwarePath === 'string' &&
    typeof f.boardCfgPath === 'string' &&
    typeof f.openocdExe === 'string' &&
    (f.powerOn === null || f.powerOn === '3v3' || f.powerOn === '5v')
  );
}

export function readFlashAck(root: string): FlashAck | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(flashAckPath(root), 'utf-8')) as FlashAck;
    if (typeof parsed.time !== 'string') return null;
    // shape check: a present-but-malformed plan is CORRUPT (distinct from
    // legacy) so the caller reports "re-run the manual step", never a
    // generic internal error
    const corrupt = parsed.plan !== null && parsed.plan !== undefined && !validFlashPlan(parsed.plan);
    return {
      time: parsed.time,
      templateHash: parsed.templateHash ?? null,
      plan: corrupt || parsed.plan === undefined ? null : parsed.plan,
      machine: typeof parsed.machine === 'string' ? parsed.machine : undefined,
      corrupt: corrupt || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * The parameter-freshness + locality half of the flash gate: the .template
 * hash must still match AND the receipt must have been created on THIS
 * machine (a project copied elsewhere reads as unverified). The
 * plan-fingerprint half lives in the MCP flash handler.
 */
export function checkFlashAck(root: string): { ok: true; ack: FlashAck } | { ok: false; reason: 'missing' | 'stale'; message: string } {
  const ack = readFlashAck(root);
  if (!ack) {
    return {
      ok: false,
      reason: 'missing',
      message:
        `flash parameters not verified for this project yet (no ${flashAckPath(root)}). ` +
        'Ask the user to run Download in the MRVC extension once with the current settings ' +
        '(project right-click → Download) — MRVC records the receipt after a successful download, ' +
        'and this tool refuses to touch hardware before that.',
    };
  }
  if (ack.corrupt) {
    return {
      ok: false,
      reason: 'stale',
      message:
        'the flash receipt is corrupt or from an incompatible version — ask the user to run Download in the MRVC extension once; MRVC rewrites the receipt in the new format.',
    };
  }
  if (ack.machine !== machineId()) {
    return {
      ok: false,
      reason: 'stale',
      message:
        'the flash receipt was created on another machine (the project was copied or moved?) — run Download once in the MRVC extension on THIS machine to verify the hardware setup here.',
    };
  }
  const current = templateHashOf(root);
  if (ack.templateHash !== current) {
    return {
      ok: false,
      reason: 'stale',
      message:
        'the .template flash parameters changed after the last verified download — ask the user to run Download in the MRVC extension again with the current parameters before using this tool.',
    };
  }
  return { ok: true, ack };
}

// ----------------------------------------------------------------- power --

export interface PowerPlanFingerprint {
  voltage: PowerVoltage;
  delayMs: number;
  boardCfgPath: string;
  boardCfgSha: string | null;
  openocdExe: string;
}

export interface PowerAck {
  time: string;
  plan: PowerPlanFingerprint;
  machine?: string;
  /** set by readPowerAck when the parsed receipt exists but its shape is
   *  unusable (hand-edited / incompatible version) */
  corrupt?: boolean;
}

export function powerAckPath(root: string): string {
  return path.join(root, '.vscode', 'mrvc', 'power-verified.json');
}

/** fingerprint the power sequence that ACTUALLY ran (or the one about to —
 *  the same fields feed both sides) */
export function fingerprintPowerPlan(o: {
  voltage: PowerVoltage;
  delayMs: number;
  boardCfg: string;
  openocdExe: string;
}): PowerPlanFingerprint {
  return {
    voltage: o.voltage,
    delayMs: o.delayMs,
    boardCfgPath: normPath(o.boardCfg),
    boardCfgSha: sha256File(o.boardCfg),
    openocdExe: normPath(o.openocdExe),
  };
}

export function samePowerFingerprint(a: PowerPlanFingerprint, b: PowerPlanFingerprint): boolean {
  return (
    a.voltage === b.voltage &&
    a.delayMs === b.delayMs &&
    normPath(a.boardCfgPath) === normPath(b.boardCfgPath) &&
    a.boardCfgSha === b.boardCfgSha &&
    normPath(a.openocdExe) === normPath(b.openocdExe)
  );
}

/** one readable line describing a verified power sequence */
export function describePowerFingerprint(f: PowerPlanFingerprint): string {
  return `voltage=${f.voltage} delayMs=${f.delayMs} boardCfg="${f.boardCfgPath}" openocd="${f.openocdExe}"`;
}

/** record a marker-verified manual Power-Off Reset (the extension's reset
 *  command calls this after both passes passed the verdict) */
export function writePowerAck(root: string, plan: PowerPlanFingerprint): PowerAck | null {
  try {
    ensureLocalIgnore(root);
    const ack: PowerAck = { time: new Date().toISOString(), plan, machine: machineId() };
    fs.writeFileSync(powerAckPath(root), JSON.stringify(ack, null, 1), 'utf-8');
    return ack;
  } catch {
    return null;
  }
}

/** runtime shape check for a parsed power plan (round6 P3.3) */
function validPowerPlan(p: unknown): p is PowerPlanFingerprint {
  if (!p || typeof p !== 'object') return false;
  const f = p as PowerPlanFingerprint;
  return (
    (f.voltage === '3v3' || f.voltage === '5v') &&
    typeof f.delayMs === 'number' &&
    typeof f.boardCfgPath === 'string' &&
    typeof f.openocdExe === 'string'
  );
}

export function readPowerAck(root: string): PowerAck | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(powerAckPath(root), 'utf-8')) as PowerAck;
    if (typeof parsed.time !== 'string' || !parsed.plan) return null;
    const corrupt = !validPowerPlan(parsed.plan);
    return {
      time: parsed.time,
      plan: corrupt ? ({ voltage: '3v3', delayMs: 0, boardCfgPath: '', boardCfgSha: null, openocdExe: '' } as PowerPlanFingerprint) : parsed.plan,
      machine: typeof parsed.machine === 'string' ? parsed.machine : undefined,
      corrupt: corrupt || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * The power gate's receipt half: a marker-verified manual Power-Off Reset
 * must exist, be well-formed and belong to THIS machine. The plan-fingerprint
 * comparison against the requested sequence lives in the MCP handler.
 */
export function checkPowerAck(root: string): { ok: true; ack: PowerAck } | { ok: false; message: string } {
  const ack = readPowerAck(root);
  if (!ack || ack.corrupt) {
    return {
      ok: false,
      message: ack?.corrupt
        ? 'the power receipt is corrupt or from an incompatible version — ask the user to run Power-Off Reset in the MRVC extension once; MRVC rewrites the receipt in the new format.'
        : `power sequence not verified for this project yet (no ${powerAckPath(root)}). Ask the user to run Power-Off Reset in the MRVC extension once (Info view row / command palette) with the desired rail — MRVC records the receipt after a marker-verified sequence, and this tool refuses before that.`,
    };
  }
  if (ack.machine !== machineId()) {
    return {
      ok: false,
      message:
        'the power receipt was created on another machine (the project was copied or moved?) — run Power-Off Reset once in the MRVC extension on THIS machine to verify the hardware setup here.',
    };
  }
  return { ok: true, ack };
}
