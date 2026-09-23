/**
 * .template — MRS download/flash settings (key=value, UTF-8, CRLF).
 *   Vendor=WCH / MCU=CH582M / Mcu Type=CH58x / Link=WCH-Link
 *   Address=0x00000000 / Target Path=obj\ADC.hex
 *   Erase All=true / Program=true / Verify=true / Reset=true / CLKSpeed=2
 */
import * as fs from 'fs';
import * as path from 'path';

export interface TemplateData {
  values: Record<string, string>;
  order: string[];
}

export function readTemplate(projectRoot: string): TemplateData {
  const file = path.join(projectRoot, '.template');
  const data: TemplateData = { values: {}, order: [] };
  if (!fs.existsSync(file)) return data;
  const raw = fs.readFileSync(file, 'utf-8');
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!(key in data.values)) data.order.push(key);
    data.values[key] = value;
  }
  return data;
}

export function writeTemplate(projectRoot: string, data: TemplateData): void {
  const lines = data.order.map((k) => `${k}=${data.values[k] ?? ''}`);
  fs.writeFileSync(path.join(projectRoot, '.template'), lines.join('\r\n') + '\r\n', 'utf-8');
}

export function templateSet(projectRoot: string, key: string, value: string): void {
  const data = readTemplate(projectRoot);
  if (!(key in data.values)) data.order.push(key);
  data.values[key] = value;
  writeTemplate(projectRoot, data);
}
