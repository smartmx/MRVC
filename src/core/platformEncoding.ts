/**
 * The byte encoding for artifacts consumed by ANSI-side toolchain programs
 * (makefiles, OpenOCD cfg): make/gcc/OpenOCD read command lines through the
 * system ANSI code page, so bytes on disk must match it (makefile.ts writeMk
 * documents the failure mode). Mirrors MRS2's getSystemANSIEncoding +
 * convertUTF8ToMatchedEncodingBuffer pair exactly:
 *   Windows, ACP 936 (Chinese) — or ACP undetectable — → GBK
 *   Windows, any other ACP (UTF-8 beta 65001, Western 1252, ...) → UTF-8
 *   non-Windows → UTF-8
 * MRS2 queries the code page through a tiny ffi-loaded native DLL
 * (GetACP); a registry read returns the same value without a native
 * dependency. The result is cached for the session (MRS2 caches too).
 */
import * as cp from 'child_process';
import * as iconv from 'iconv-lite';

export type AnsiArtifactEncoding = 'gbk' | 'utf-8';

let cached: AnsiArtifactEncoding | undefined;

/** ACP value → artifact encoding. `acp === undefined` means detection
 * failed (MRS2 falls back to GBK on Windows); non-Windows is always UTF-8. */
export function encodingForAcp(acp: string | undefined, platform: NodeJS.Platform = process.platform): AnsiArtifactEncoding {
  if (platform !== 'win32') return 'utf-8';
  return acp === '936' ? 'gbk' : acp === undefined ? 'gbk' : 'utf-8';
}

/** Detect the system ANSI code page once (registry HKLM...Nls\CodePage\ACP). */
export function ansiArtifactEncoding(): AnsiArtifactEncoding {
  if (cached) return cached;
  let acp: string | undefined;
  if (process.platform === 'win32') {
    try {
      const out = cp.execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], { encoding: 'utf-8' });
      acp = (out.match(/ACP\s+REG_SZ\s+(\S+)/) || [])[1];
    } catch {
      acp = undefined;
    }
  }
  cached = encodingForAcp(acp);
  return cached;
}

/** Encode toolchain-artifact text in the ANSI-codepage-matching bytes. */
export function encodeArtifact(text: string): Buffer {
  return ansiArtifactEncoding() === 'gbk' ? iconv.encode(text, 'gbk') : Buffer.from(text, 'utf-8');
}
