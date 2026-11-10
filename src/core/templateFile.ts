/**
 * .template — MRS download/flash settings (key=value, UTF-8, CRLF).
 *   Vendor=WCH / MCU=CH582M / Mcu Type=CH58x / Link=WCH-Link
 *   Address=0x00000000 / Target Path=obj\ADC.hex
 *   Erase All=true / Program=true / Verify=true / Reset=true / CLKSpeed=2
 *
 * The raw file layout is preserved on rewrite: comments, blank lines and
 * value whitespace stay untouched; only existing `key=` lines are updated
 * in place and new keys are appended (MRS2 itself patches single lines).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface TemplateData {
  values: Record<string, string>;
  /** first-seen key order (new keys append in this order) */
  order: string[];
  /** raw file lines — the lossless rewrite source */
  lines: string[];
}

/** key / spacing-before-equals / value — the spacing group is what keeps
 * "Vendor = WCH" spelled that way on rewrite (the old lazy key + \s* form
 * ate the spacing into the key match, making the pad below dead code) */
const KEY_RE = /^([^=\r\n]+?)(\s*)=(.*)$/;

export function readTemplate(projectRoot: string): TemplateData {
  const file = path.join(projectRoot, '.template');
  const data: TemplateData = { values: {}, order: [], lines: [] };
  if (!fs.existsSync(file)) return data;
  const raw = fs.readFileSync(file, 'utf-8');
  data.lines = raw.split(/\r?\n/);
  // a trailing empty split artifact would add a spurious line on write
  if (data.lines.length && data.lines[data.lines.length - 1] === '') data.lines.pop();
  for (const line of data.lines) {
    const m = line.match(KEY_RE);
    if (!m) continue;
    const key = m[1].trim();
    if (!(key in data.values)) data.order.push(key);
    data.values[key] = m[3].trim();
  }
  return data;
}

export function writeTemplate(projectRoot: string, data: TemplateData): void {
  const written = new Set<string>();
  const out = data.lines.map((line) => {
    const m = line.match(KEY_RE);
    if (!m) return line; // comment / blank line — preserved verbatim
    const key = m[1].trim();
    if (!(key in data.values)) return line; // key deleted from values: keep raw
    written.add(key);
    const value = data.values[key];
    // unchanged lines stay BYTE-identical (spacing, value whitespace and
    // all) — only a real value change rewrites the line, keeping the
    // original "key =" spacing style via the captured separator group
    if (m[3].trim() === value) return line;
    return `${m[1]}${m[2]}=${value}`;
  });
  for (const key of data.order) {
    if (written.has(key) || !(key in data.values)) continue;
    out.push(`${key}=${data.values[key]}`);
  }
  fs.writeFileSync(path.join(projectRoot, '.template'), out.join('\r\n') + '\r\n', 'utf-8');
}

export function templateSet(projectRoot: string, key: string, value: string): void {
  const data = readTemplate(projectRoot);
  if (!(key in data.values)) data.order.push(key);
  data.values[key] = value;
  writeTemplate(projectRoot, data);
}

/**
 * Detect a stale .template Target Path at download time (no write). EVT
 * trees ship cross-project values (CH394Q__MACRAW records
 * obj\CH394Q__TCP_SERVER.hex — another project's artifact, absent on this
 * machine); the download falls back to the project's own build artifact,
 * but the recorded value stays stale on disk. Returns the proposed rewrite
 * (old recorded value -> project's own artifact, relative to the project
 * root, platform separators — the MRS convention) when the recorded target
 * does not exist AND the own artifact does.
 *
 * A target that EXISTS is never reported even when it points at another
 * project's file — sharing an artifact (Merge.Bin workflows) is legitimate.
 * Undefined when there is nothing to fix (no value, target exists, or the
 * own artifact is missing too — the project may simply not be built).
 */
export function staleTargetPath(projectRoot: string, ownFirmware: string): { old: string; next: string } | undefined {
  const old = (readTemplate(projectRoot).values['Target Path'] ?? '').trim();
  if (!old) return undefined;
  const recorded = path.isAbsolute(old) ? old : path.join(projectRoot, old);
  if (fs.existsSync(recorded)) return undefined;
  if (!fs.existsSync(ownFirmware)) return undefined;
  const rel = path.relative(projectRoot, ownFirmware);
  const next = rel.startsWith('..') ? ownFirmware : rel;
  if (next === old) return undefined;
  return { old, next };
}

/**
 * Write the rewrite staleTargetPath() reports. Callers must ask the user
 * first (default is NOT to touch .template — the recorded value is the
 * user's to change).
 */
export function healTargetPath(projectRoot: string, ownFirmware: string): { old: string; next: string } | undefined {
  const change = staleTargetPath(projectRoot, ownFirmware);
  if (!change) return undefined;
  templateSet(projectRoot, 'Target Path', change.next);
  return change;
}
