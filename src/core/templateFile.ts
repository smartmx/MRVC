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
