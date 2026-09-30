/**
 * Flash script builder (pure Node). Produces the OpenOCD cfg used for
 * downloading and the argv for the openocd invocation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { encodeArtifact } from './platformEncoding';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{1,8}$/;

/**
 * Infer the flash download address from the project's source-file names —
 * EVT trees ship WITHOUT .template, and the SDK's per-series flash.json
 * rule is: only the CH5xx wireless families (CH56x/57x/58x/59x, minus
 * CH564) download at 0x00000000, every other series (ch32*, CH564,
 * CH641/643) at 0x08000000. Sources carry the family as a filename prefix
 * (ch32v30x_gpio.c, startup_ch32h417_v3f.S, CH58x_uart0.c, startup_CH585.S).
 * Returns undefined when no chip prefix is found — the caller falls back.
 */
export function inferFlashAddress(sourcePaths: string[]): string | undefined {
  for (const p of sourcePaths) {
    const base = p.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
    const m = base.match(/^startup_(ch[0-9a-z]+?)[_.]/) ?? base.match(/^(ch[0-9]+[a-z0-9]*?)_/);
    if (!m) continue;
    const chip = m[1];
    if (chip.startsWith('ch564')) return '0x08000000'; // CH564 differs from CH56x
    if (/^ch5[6-9]/.test(chip)) return '0x00000000'; // CH5xx wireless families
    if (/^ch(3|6)/.test(chip)) return '0x08000000'; // ch32*/CH64x families
  }
  return undefined;
}

/**
 * Lowest address an Intel HEX data record loads at (extended-linear-address
 * segments folded in); undefined when the content holds no data records.
 * WCH EVT hex images link at 0x00000000; a user linker script with a
 * non-zero ORIGIN produces a hex whose own addresses already sit at the
 * physical base — those must not be shifted by the download address again.
 */
export function hexBaseAddress(content: string): number | undefined {
  let upper = 0;
  let base: number | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(':')) continue;
    if (line.length < 11) continue;
    const type = parseInt(line.slice(7, 9), 16);
    if (type === 0x01) break; // EOF
    if (type === 0x04) {
      upper = parseInt(line.slice(9, 13), 16) << 16;
    } else if (type === 0x00) {
      const addr = upper + parseInt(line.slice(3, 7), 16);
      if (base === undefined || addr < base) base = addr;
    }
  }
  return base;
}

export interface FlashOptions {
  /** project build dir (obj/) — the generated script lands here */
  buildDir: string;
  address: string;
  verify: boolean;
  reset: boolean;
  boardCfg: string;
  firmware: string;
  /** .template "Erase All=true" — scrub every flash bank before writing
   * (write_image erase only clears the sectors the image occupies) */
  eraseAll?: boolean;
  /** how many flash banks to scrub in eraseAll mode — dual-core board cfgs
   * expose two (core1's bank sits at 0x00005000); default 1 */
  banks?: number;
}

export interface FlashPlan {
  scriptPath: string;
  args: string[];
}

/**
 * Build (and write) the OpenOCD flash script; returns the argv to run.
 * The script is loaded after the board cfg so `wlink_set_address` overrides
 * the cfg's default (CH58x boots at 0x00000000, CH32V3xx/CH32H417 at
 * 0x08000000 — the address comes from the project's .template or chip
 * inference).
 *
 * The address must reach OpenOCD TWICE (WCH driver semantics, verified
 * against the 2026-07 openocd snapshot): `wlink_set_address` becomes the
 * flash BANK base (ch32vx_probe sets bank->base = wlink_address), while
 * `program <file> <offset>` passes it as write_image's offset — WCH hex
 * images link at 0x00000000, so without the offset the image sections
 * fall outside a non-zero bank ("no flash bank found for address
 * 0x00000000") and NOTHING is written.
 *
 * For hex firmware the offset is the address MINUS the hex's own base
 * address (write_image adds the offset to the image's record addresses):
 * base 0 keeps the full address as the offset, a hex already linked at the
 * physical base (non-zero ORIGIN linker script) gets offset 0 instead of
 * being shifted out of the bank. Bin firmware has no addresses — the full
 * address is the offset.
 *
 * WCH driver semantics make the download address pure OpenOCD lookup
 * bookkeeping: the probe programs at chipiaddr + (target - bank->base), so
 * with the offset compensation the physical placement is chipiaddr + R -
 * hexBase regardless of the address. When the hex is linked ABOVE the
 * configured address (A < hexBase — e.g. a 0x08000000 ORIGIN ld in a
 * 0-addressed project, both run fine on the aliased chip), the bank window
 * is simply moved up onto the image instead of failing the lookup.
 */
export function prepareFlash(opts: FlashOptions): FlashPlan {
  if (!ADDRESS_RE.test(opts.address)) {
    throw new Error(`Invalid flash address "${opts.address}" (expected form 0x00000000)`);
  }
  let bank = opts.address;
  let offset = opts.address;
  if (/\.hex$/i.test(opts.firmware)) {
    try {
      const base = hexBaseAddress(fs.readFileSync(opts.firmware, 'utf-8'));
      const addr = parseInt(opts.address, 16);
      if (base !== undefined && base > 0) {
        if (addr >= base) {
          offset = '0x' + (addr - base).toString(16);
        } else {
          bank = '0x' + base.toString(16);
          offset = '0x0';
        }
      }
    } catch {
      // unreadable firmware — keep the raw address as the offset
    }
  }
  // Firmware path: forward slashes (Jim Tcl eats backslashes inside double
  // quotes — "E:\x\y" becomes E:xy) + quotes to keep spaces one argument
  const fwPosix = opts.firmware.replace(/\\/g, '/');
  const steps: string[] = [];
  if (opts.eraseAll) {
    // explicit expansion of OpenOCD's program proc (extracted verbatim from
    // openocd.exe — its unconditional `init` means we cannot prepend an
    // erase to a `program` call) with the full-chip erase inserted between
    // reset init and the write. wlink_set_address stays first: the WCH
    // driver captures the bank base at probe time, i.e. during init.
    steps.push(`wlink_set_address ${bank}`);
    steps.push('init');
    steps.push('reset init');
    const nBanks = Math.max(1, opts.banks ?? 1);
    for (let b = 0; b < nBanks; b++) steps.push(`flash erase_sector ${b} 0 last`);
    steps.push(`flash write_image erase "${fwPosix}" ${offset}`);
    if (opts.verify) steps.push(`verify_image "${fwPosix}" ${offset}`);
    if (opts.reset) steps.push('poll off', 'reset run');
    steps.push('shutdown');
  } else {
    steps.push(`wlink_set_address ${bank}`);
    const prog = ['program', `"${fwPosix}"`, offset];
    if (opts.verify) prog.push('verify');
    if (opts.reset) prog.push('reset');
    prog.push('exit');
    steps.push(prog.join(' '));
  }

  const scriptPath = path.join(opts.buildDir, 'mrs2_flash.cfg');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  // same ANSI-codepage reasoning as the makefiles (makefile.ts): OpenOCD's
  // Jim Tcl reads these bytes on the system code page — a UTF-8 firmware
  // path with Chinese characters would not open. ASCII content is
  // byte-identical in GBK.
  fs.writeFileSync(scriptPath, encodeArtifact(steps.join('\n') + '\n'));
  return { scriptPath, args: ['-f', opts.boardCfg, '-f', scriptPath] };
}
