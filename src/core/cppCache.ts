/**
 * C/C++ IntelliSense (cpptools) cache maintenance (pure Node) — resolve and
 * clear the precompiled-header (ipch) cache that grows to gigabytes on large
 * multi-project workspaces (an EVT mega-folder's tag-parser browse plus the
 * 5120 MB default IPCH cap add up fast).
 *
 * Cache locations, in probe order:
 *   configured — the user's `C_Cpp.intelliSenseCachePath` setting (handed in
 *                by the vscode layer; core never reads vscode config)
 *   default    — Windows: %LOCALAPPDATA%\Microsoft\vscode-cpptools\ipch
 *                Linux:   $XDG_CACHE_HOME\vscode-cpptools\ipch, else
 *                         ~/.cache/vscode-cpptools/ipch
 *                macOS:   ~/Library/Caches/vscode-cpptools/ipch
 *                (per cpptools' own NLS strings, round22 §5.3)
 *
 * Configured values are ADAPTIVE about what the setting means (round21
 * §5.1): cpptools' docs define the default as `.../vscode-cpptools` while
 * the real PCH files sit in `.../vscode-cpptools/ipch` — i.e. the value is
 * the cache ROOT and cpptools appends `ipch`. MRVC therefore probes both
 * readings and only offers directories that verifiably hold PCH content —
 * VERIFIED BY BOUNDED SCAN (round22 §5.1/§5.4): a bare `<value>/ipch` that
 * exists but holds no `.ipch` file (flat or in one hash-subdir level) is
 * NOT offered, so a typo'd or repurposed directory can never become a
 * delete target.
 *
 * Safety: the delete set is guarded — a candidate is refused unless its
 * basename is `ipch` or it sits somewhere under a `vscode-cpptools`
 * directory — EXCEPT content-verified configured candidates (the explicit
 * setting IS the intent; their shape may be any folder). Independently of
 * the shape, protected directories are checked BOTH ways: the target must
 * not BE the user's home or a forbidden (workspace) directory, and must not
 * CONTAIN the home or a forbidden directory — deleting a home ANCESTOR
 * would take the home with it (round22 §5.1 probe B). Path comparisons fold
 * case only on Windows (round22 §5.7 — POSIX filesystems are
 * case-sensitive). Best-effort deletion: one locked file (a running
 * cpptools holding a PCH open on Windows) degrades to a per-path failure
 * instead of aborting the remaining paths.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CppCacheCandidate {
  path: string;
  /** where this candidate came from — the UI shows it so a stale default
   *  (GBs left behind before a custom path was configured) is not confused
   *  with the live one */
  source: 'configured' | 'default';
  /** whether the "looks like a cpptools cache" shape precondition applies —
   *  false for configured candidates, which are content-verified instead */
  requireCacheShape: boolean;
}

/** the platform's built-in ipch location (the `C_Cpp.intelliSenseCachePath`
 *  setting did not exist before cpptools 2019-03, so old installs may still
 *  hold gigabytes here even after a custom path is configured) */
export function defaultCppCachePath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Microsoft', 'vscode-cpptools', 'ipch');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'vscode-cpptools', 'ipch');
  }
  // Linux: $XDG_CACHE_HOME wins when set (cpptools NLS parity)
  const xdg = process.env['XDG_CACHE_HOME']?.trim();
  const base = xdg || path.join(os.homedir(), '.cache');
  return path.join(base, 'vscode-cpptools', 'ipch');
}

/** case-handling for path comparisons: fold on Windows (case-insensitive
 *  filesystem), keep spelling on POSIX (round22 §5.7) */
function foldKey(p: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(p.trim());
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** does the directory hold at least one PCH file (`*.ipch`) — bounded scan:
 *  the dir itself plus ONE subdir level, which covers both cpptools layouts
 *  (flat `ipch/a.ipch` and hashed `ipch/<hash>/a.ipch`) without unbounded
 *  recursion (round22 §5.4) */
function hasIpchContent(dir: string, maxDepth: number): boolean {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.ipch')) return true;
      if (e.isDirectory() && maxDepth > 0 && hasIpchContent(path.join(dir, e.name), maxDepth - 1)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ordered, de-duplicated probe list. The configured value is adaptive
 * (see the file header): `<value>/ipch` wins when it verifiably holds PCH
 * content, else the value itself when IT does; a configured path with no
 * cache content is NOT offered (a typo must not become a delete target).
 * The built-in default is always probed last — an old default can still
 * hold gigabytes after a custom path was configured. Dedupe folds case only
 * on Windows.
 */
export function cppCacheCandidates(configured?: string, platform: NodeJS.Platform = process.platform): CppCacheCandidate[] {
  const out: CppCacheCandidate[] = [];
  const seen = new Set<string>();
  const push = (p: string, source: CppCacheCandidate['source'], requireCacheShape: boolean): void => {
    if (typeof p !== 'string') return; // defensive: a hand-edited setting value (round28 §3.1)
    const t = p.trim();
    if (!t) return;
    const key = foldKey(t, platform);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: t, source, requireCacheShape });
  };
  // defensive normalization of the configured value itself: a non-string
  // (number/object from a hand-edited settings.json) is dropped, not crashed on
  const configuredText = typeof configured === 'string' ? configured : undefined;
  if (configuredText?.trim()) {
    const v = configuredText.trim();
    const child = path.join(v, 'ipch');
    if (isDir(child) && hasIpchContent(child, 2)) push(child, 'configured', false);
    else if (isDir(v) && hasIpchContent(v, 2)) push(v, 'configured', false);
  }
  push(defaultCppCachePath(platform), 'default', true);
  return out;
}

/**
 * Delete-guard: the target must not collide with a protected directory —
 * neither identical to, nor CONTAINING, nor INSIDE the user's home or a
 * forbidden (workspace) directory; deleting a home ANCESTOR would take the
 * home with it (round22 §5.1 probe B). When `requireCacheShape` is set, the
 * target must ALSO look like a cpptools cache (basename `ipch` or somewhere
 * under a `vscode-cpptools` directory); configured candidates skip that
 * check because their cache content is verified by the resolver instead.
 * Case folding applies on Windows only (round22 §5.7).
 */
export function isSafeCachePath(
  target: string,
  forbidden: string[],
  requireCacheShape = true,
  platform: NodeJS.Platform = process.platform
): boolean {
  const resolved = path.resolve(target.trim());
  const norm = foldKey(resolved, platform);
  if (path.dirname(resolved) === resolved) return false; // a filesystem root
  if (requireCacheShape) {
    const base = path.basename(resolved).toLowerCase();
    if (base !== 'ipch' && !norm.toLowerCase().includes('vscode-cpptools')) return false;
  }
  const home = foldKey(os.homedir(), platform);
  if (norm === home) return false; // the user's home itself
  if (home.startsWith(norm + path.sep) || home.startsWith(norm + '/')) return false; // target CONTAINS home
  for (const raw of forbidden) {
    if (!raw || !raw.trim()) continue;
    const nt = foldKey(raw, platform);
    if (norm === nt) return false;
    if (nt.startsWith(norm + path.sep) || nt.startsWith(norm + '/')) return false; // would be destroyed
    if (norm.startsWith(nt + path.sep) || norm.startsWith(nt + '/')) return false; // inside a workspace
  }
  return true;
}

/** best-effort directory size (an unreadable subtree counts as 0 — the
 *  number feeds a confirmation dialog, not an invoice) */
export function dirSizeBytes(p: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) total += dirSizeBytes(full);
      else if (e.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // raced with a delete — skip
        }
      }
    }
  } catch {
    // unreadable subtree counts as 0
  }
  return total;
}

export interface ClearedCache {
  path: string;
  bytes: number;
}
export interface FailedCache {
  path: string;
  error: string;
  /** why it failed — the UI offers "Reload Window" ONLY for `locked` (a
   *  running cpptools holding a PCH open: the extension-host restart
   *  releases the handle and the leftovers clear). `content` = the TOCTOU
   *  re-verification found no PCH left, `guard` = the safety guard refused
   *  and `error` = a plain filesystem error (permissions, read-only) —
   *  a reload changes nothing for those (round29 §3.2) */
  kind: 'locked' | 'content' | 'guard' | 'error';
}

/**
 * Delete-failure classification (round30 §4.2): ONLY a sharing violation
 * (EBUSY — a file handle held without FILE_SHARE_DELETE) counts as
 * `locked`, the one case a window reload actually finishes the cleanup
 * (the extension-host restart releases the handle). Everything else is a
 * plain `error` with its reason shown: EPERM on Windows is ambiguous (an
 * ACL or attribute denial — and note a MEMORY-MAPPED PCH, cpptools' real
 * lock shape, deletes with EPERM too), on POSIX it is a plain permission
 * error; a reload fixes none of those. Modern libuv deletes open-fd files
 * fine (POSIX-delete semantics), so the classifier stays a pure, testable
 * mapping instead of relying on OS behavior.
 */
export function classifyDeleteError(code: string | undefined): FailedCache['kind'] {
  return code === 'EBUSY' ? 'locked' : 'error';
}

/**
 * Best-effort deletion of the given cache candidates. Existing, guard-
 * passed paths are removed recursively (rmSync retries ride over transient
 * locks); anything that fails — a locked PCH a running cpptools still holds
 * open — is reported per path instead of aborting the rest. Nonexistent
 * paths are skipped silently (already clear).
 *
 * TOCTOU re-verification (round23 §5.2): the resolver proved cache content
 * WHEN THE USER CONFIRMED, but the user may have sat in the modal dialog
 * while cpptools cleaned/rebuilt the directory — before deleting, a
 * configured candidate (relaxed shape) must STILL hold `.ipch` content, or
 * it lands in `failed` with its directory untouched.
 */
export function clearCppIntelliSenseCache(
  candidates: CppCacheCandidate[],
  forbidden: string[] = []
): { cleared: ClearedCache[]; failed: FailedCache[] } {
  const cleared: ClearedCache[] = [];
  const failed: FailedCache[] = [];
  for (const c of candidates) {
    if (!fs.existsSync(c.path)) continue;
    if (!isSafeCachePath(c.path, forbidden, c.requireCacheShape)) {
      failed.push({ path: c.path, kind: 'guard', error: 'refused by the safety guard (collides with a protected directory)' });
      continue;
    }
    // re-prove cache content for the relaxed-shape candidates (TOCTOU window
    // between resolution/confirmation and this delete)
    if (!c.requireCacheShape && !hasIpchContent(c.path, 2)) {
      failed.push({ path: c.path, kind: 'content', error: 'no .ipch content found at deletion time — the directory was left untouched' });
      continue;
    }
    const bytes = dirSizeBytes(c.path);
    try {
      fs.rmSync(c.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      cleared.push({ path: c.path, bytes });
    } catch (e) {
      // see classifyDeleteError — only a sharing violation is 'locked'
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      failed.push({
        path: c.path,
        kind: classifyDeleteError(code),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { cleared, failed };
}
