/**
 * The byte encoding for artifacts consumed by ANSI-side toolchain programs
 * (makefiles, OpenOCD cfg): make/gcc/OpenOCD read command lines through the
 * system ANSI code page, so bytes on disk must match it (makefile.ts writeMk
 * documents the failure mode). Mirrors MRS2's getSystemANSIEncoding +
 * convertUTF8ToMatchedEncodingBuffer pair:
 *   Windows, CJK ACP → the matching double-byte charset (936 中文→GBK,
 *     932 日本語→Shift-JIS, 949 한국어→EUC-KR, 950 繁體→Big5) — MRS2 converts
 *     to "the matched encoding", not just GBK
 *   Windows, ACP undetectable → GBK (MRS2's fallback)
 *   Windows, any other ACP (UTF-8 beta 65001, Western 1252, ...) → UTF-8
 *   non-Windows → UTF-8
 * MRS2 queries the code page through a tiny ffi-loaded native DLL
 * (GetACP); a registry read returns the same value without a native
 * dependency. The result is cached for the session (MRS2 caches too).
 */
import * as cp from 'child_process';
import * as iconv from 'iconv-lite';

export type AnsiArtifactEncoding = 'gbk' | 'shift-jis' | 'euc-kr' | 'big5' | 'utf-8';

let cached: AnsiArtifactEncoding | undefined;

/** ACP value → artifact encoding. `acp === undefined` means detection
 * failed (MRS2 falls back to GBK on Windows); non-Windows is always UTF-8. */
export function encodingForAcp(acp: string | undefined, platform: NodeJS.Platform = process.platform): AnsiArtifactEncoding {
  if (platform !== 'win32') return 'utf-8';
  if (acp === undefined) return 'gbk';
  switch (acp) {
    case '936': return 'gbk';
    case '932': return 'shift-jis';
    case '949': return 'euc-kr';
    case '950': return 'big5';
    default: return 'utf-8';
  }
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

/**
 * Encode toolchain-artifact text in the ANSI-codepage-matching bytes.
 * Throws when the text contains characters the encoding cannot represent
 * (e.g. emoji or non-CJK Unicode on a CJK system): iconv-lite would
 * silently replace them with '?', corrupting every path in the artifact —
 * a loud error beats a build that cannot find its own files.
 */
export function encodeArtifact(text: string): Buffer {
  const enc = ansiArtifactEncoding();
  const buf = enc === 'utf-8' ? Buffer.from(text, 'utf-8') : iconv.encode(text, enc);
  if (enc !== 'utf-8' && iconv.decode(buf, enc) !== text) {
    throw new Error(
      `Path or content contains characters that cannot be represented in the system code page (${enc}) — ` +
      `rename them using characters available in this Windows locale.`
    );
  }
  return buf;
}
