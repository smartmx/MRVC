/**
 * Persistent per-directory build write history for safe output cleanup (review
 * round8 P2-B). Stored OUTSIDE any build output directory at
 * `<projectRoot>/.vscode/mrvc/output-history.json`, keyed by canonical
 * platform-folded real directory path so shared multi-config output dirs and
 * renamed/removed source files retain verifiable ownership records.
 *
 * Only files genuinely written by `generateMakefiles` or modified/created
 * during a `make` invocation (verified via pre/post build snapshots) are
 * recorded — untouched pre-existing inputs (e.g. a vendor .o) are never
 * claimed. Every file deletion verifies regular-file status + SHA-256 match
 * via `mayReclaim` and prunes the history entry once unlinked.
 *
 * Pure Node — no vscode imports.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { AnsiArtifactEncoding } from './platformEncoding';

const CASE_FOLD = process.platform === 'win32';
const fold = (s: string): string => (CASE_FOLD ? s.toLowerCase() : s);
const toPosix = (s: string): string => s.split(path.sep).join('/');

export type WrittenFile = { rel: string; sha256: string };

export interface DirHistory {
  files: Map<string, string>;
  encoding?: AnsiArtifactEncoding;
}

export type PreBuildSnapshot = Map<string, { mtimeMs: number; size: number; sha256: string }>;

interface HistoryEntryJson {
  files: Record<string, string>;
  encoding?: AnsiArtifactEncoding;
}

interface HistoryFileJson {
  version: number;
  dirs: Record<string, HistoryEntryJson>;
}

export function outputHistoryPath(projectRoot: string): string {
  return path.join(projectRoot, '.vscode', 'mrvc', 'output-history.json');
}

/** Merge newly written files into an existing history map without dropping
 *  prior entries (supports renamed sources and multi-config shared dirs). */
export function updateHistory(previous: ReadonlyMap<string, string>, writes: readonly WrittenFile[]): Map<string, string> {
  const next = new Map<string, string>(previous);
  for (const { rel, sha256 } of writes) {
    next.set(fold(rel), sha256);
  }
  return next;
}

/** True only when `rel` has a recorded hash matching the current file on disk. */
export function mayReclaim(rel: string, currentSha: string, history: ReadonlyMap<string, string>): boolean {
  return history.get(fold(rel)) === currentSha;
}

/** SHA-256 of a regular non-symlink file, or undefined if missing/link/dir. */
export function sha256File(absPath: string): string | undefined {
  try {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink() || !st.isFile()) return undefined;
    return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return undefined;
  }
}

function resolveSafeChildDir(parentReal: string, childName: string, create: boolean): string | undefined {
  const target = path.join(parentReal, childName);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      if (!create) return undefined;
      fs.mkdirSync(target);
      st = fs.lstatSync(target);
    } else {
      throw e;
    }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing to use linked or non-directory metadata path: ${target}`);
  }
  const realTarget = fs.realpathSync.native(target);
  const parentPrefix = parentReal.endsWith(path.sep) ? parentReal : parentReal + path.sep;
  if (fold(realTarget) === fold(parentReal) || !fold(realTarget).startsWith(fold(parentPrefix))) {
    throw new Error(`refusing to use metadata path outside project root: ${target} -> ${realTarget}`);
  }
  return realTarget;
}

/** Validate and optionally create a nested metadata directory chain under `root`,
 *  refusing symlinks/junctions or paths that resolve outside `root`. */
export function resolveContainedMetaDir(root: string, segments: readonly string[], create: boolean): string | undefined {
  const absRoot = path.resolve(root);
  let curReal: string;
  try {
    curReal = fs.realpathSync.native(absRoot);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      if (!create) return undefined;
      fs.mkdirSync(absRoot, { recursive: true });
      curReal = fs.realpathSync.native(absRoot);
    } else {
      throw e;
    }
  }
  for (const seg of segments) {
    const next = resolveSafeChildDir(curReal, seg, create);
    if (!next) return undefined;
    curReal = next;
  }
  return curReal;
}

/** Validate a regular metadata file directly inside a containment-checked `realDir`. */
export function assertContainedMetaFile(
  realDir: string,
  fileName: string,
  allowMissing = true
): { path: string; exists: boolean } {
  const p = path.join(realDir, fileName);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' && allowMissing) {
      return { path: p, exists: false };
    }
    throw e;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`refusing to access linked or non-regular metadata file: ${p}`);
  }
  const realFile = fs.realpathSync.native(p);
  const dirPrefix = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
  if (!fold(realFile).startsWith(fold(dirPrefix))) {
    throw new Error(`refusing to access metadata file outside history directory: ${p} -> ${realFile}`);
  }
  return { path: p, exists: true };
}

function resolveSafeHistoryDir(projectRoot: string, create: boolean): string | undefined {
  return resolveContainedMetaDir(projectRoot, ['.vscode', 'mrvc'], create);
}

const HISTORY_LOCK_NAME = 'output-history.lock';
const HISTORY_LOCK_STALE_MS = 15_000;
const HISTORY_IGNORE_ENTRIES = ['output-history.json', HISTORY_LOCK_NAME, `${HISTORY_LOCK_NAME}.stale.*`] as const;
const LOCK_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(LOCK_SLEEP_BUF, 0, 0, ms);
}

/** Cross-process owner-safe lock around output-history read-modify-write sequences
 *  (review round36 P3 / round37 P3): uses `wx` lockfile creation with a unique
 *  owner token, atomic rename claim for stale-lock recovery (never bare unlink),
 *  and token-verified unlock so one process never removes another's live lock. */
export function withHistoryLock<T>(realMrvcDir: string, fn: () => T, timeoutMs = 1000): T {
  const lockPath = path.join(realMrvcDir, HISTORY_LOCK_NAME);
  const ownerToken = `${process.pid}:${Date.now()}:${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${ownerToken}\n`, 'utf-8');
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      try {
        const st = fs.lstatSync(lockPath);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new Error(`refusing linked or non-regular lock file: ${lockPath}`);
        }
        if (Date.now() - st.mtimeMs > HISTORY_LOCK_STALE_MS) {
          const claimPath = path.join(realMrvcDir, `${HISTORY_LOCK_NAME}.stale.${process.pid}.${randomBytes(4).toString('hex')}`);
          let claimed = false;
          try {
            fs.renameSync(lockPath, claimPath);
            claimed = true;
          } catch (renErr) {
            const code = (renErr as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') continue;
            if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY') throw renErr;
          }
          if (claimed) {
            try {
              const claimSt = fs.lstatSync(claimPath);
              if (!claimSt.isSymbolicLink() && claimSt.isFile() && Date.now() - claimSt.mtimeMs > HISTORY_LOCK_STALE_MS) {
                fs.unlinkSync(claimPath);
                continue;
              }
              // Non-replace restore (review round38 P3): linkSync fails with
              // EEXIST if another process acquired a fresh lock meanwhile, so
              // an un-stale claim never overwrites an active lock.
              try {
                fs.linkSync(claimPath, lockPath);
              } catch {
                // lockPath appeared or link unsupported — safe to drop claim
              }
            } finally {
              try {
                fs.unlinkSync(claimPath);
              } catch {
                // ignore stale claim cleanup failure
              }
            }
          }
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw statErr;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for output-history lock: ${lockPath}`);
      }
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      const info = assertContainedMetaFile(realMrvcDir, HISTORY_LOCK_NAME, true);
      if (info.exists && fs.readFileSync(info.path, 'utf-8').trim() === ownerToken) {
        fs.unlinkSync(info.path);
      }
    } catch {
      // ignore unlock error or foreign takeover
    }
  }
}

function validateHistoryStore(raw: unknown, file: string): HistoryFileJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`corrupted output history "${file}": expected a JSON object — inspect or remove it and rebuild`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`unsupported output history version in "${file}": ${String(obj.version)} — inspect or remove it and rebuild`);
  }
  if (!obj.dirs || typeof obj.dirs !== 'object' || Array.isArray(obj.dirs)) {
    throw new Error(`corrupted output history "${file}": missing "dirs" object — inspect or remove it and rebuild`);
  }
  const dirs: Record<string, HistoryEntryJson> = {};
  for (const [k, v] of Object.entries(obj.dirs as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`corrupted output history "${file}": invalid directory entry for "${k}"`);
    }
    const entry = v as Record<string, unknown>;
    if (!entry.files || typeof entry.files !== 'object' || Array.isArray(entry.files)) {
      throw new Error(`corrupted output history "${file}": invalid files map for "${k}"`);
    }
    if (entry.encoding !== undefined && typeof entry.encoding !== 'string') {
      throw new Error(`corrupted output history "${file}": invalid encoding for "${k}"`);
    }
    const cleanFiles: Record<string, string> = {};
    for (const [fk, fv] of Object.entries(entry.files as Record<string, unknown>)) {
      if (typeof fv !== 'string' || !fv) {
        throw new Error(`corrupted output history "${file}": invalid hash entry "${fk}" for "${k}"`);
      }
      cleanFiles[fk] = fv;
    }
    dirs[k] = {
      files: cleanFiles,
      ...(typeof entry.encoding === 'string' ? { encoding: entry.encoding as AnsiArtifactEncoding } : {}),
    };
  }
  return { version: 1, dirs };
}

function readHistoryStore(projectRoot: string): HistoryFileJson {
  const realMrvcDir = resolveSafeHistoryDir(projectRoot, false);
  if (!realMrvcDir) return { version: 1, dirs: {} };
  const fileInfo = assertContainedMetaFile(realMrvcDir, 'output-history.json', true);
  if (!fileInfo.exists) return { version: 1, dirs: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(fileInfo.path, 'utf-8'));
  } catch (e) {
    throw new Error(
      `unreadable or corrupted output history "${fileInfo.path}" (${e instanceof Error ? e.message : String(e)}) — refusing unverified deletion; inspect or remove the file and rebuild`
    );
  }
  return validateHistoryStore(parsed, fileInfo.path);
}

function appendGitignoreEntriesUnlocked(realMrvcDir: string, entries: readonly string[]): void {
  const info = assertContainedMetaFile(realMrvcDir, '.gitignore', true);
  if (!info.exists) {
    fs.writeFileSync(info.path, entries.join('\n') + '\n', { encoding: 'utf-8', flag: 'wx' });
    return;
  }
  const raw = fs.readFileSync(info.path, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const existing = new Set(lines.map((l) => l.trim()).filter((l) => l.length > 0));
  const missing = entries.filter((e) => !existing.has(e) && !existing.has('/' + e));
  if (!missing.length) return;
  const prefix = raw.length === 0 || raw.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(info.path, `${prefix}${missing.join('\n')}\n`, 'utf-8');
}

/** Shared locked append-only maintenance for `<projectRoot>/.vscode/mrvc/.gitignore`
 *  (review round39 P3 / round11 D): serializes receipt and history writers
 *  through the cross-process history lock and verifies every entry is present on
 *  disk afterwards before returning `true`. */
export function ensureMrvcGitignoreEntries(
  mrvcDir: string,
  entries: readonly string[],
  opts?: { alreadyLocked?: boolean }
): boolean {
  try {
    if (!entries.length) return true;
    const realMrvcDir = fs.realpathSync.native(mrvcDir);
    if (opts?.alreadyLocked) {
      appendGitignoreEntriesUnlocked(realMrvcDir, entries);
    } else {
      withHistoryLock(realMrvcDir, () => appendGitignoreEntriesUnlocked(realMrvcDir, entries));
    }
    const info = assertContainedMetaFile(realMrvcDir, '.gitignore', true);
    if (!info.exists) return false;
    const lines = fs.readFileSync(info.path, 'utf-8').split(/\r?\n/).map((l) => l.trim());
    return entries.every((e) => lines.includes(e) || lines.includes('/' + e));
  } catch {
    return false;
  }
}

function ensureHistoryIgnore(realMrvcDir: string): boolean {
  return ensureMrvcGitignoreEntries(realMrvcDir, HISTORY_IGNORE_ENTRIES, { alreadyLocked: true });
}

function writeHistoryStore(projectRoot: string, store: HistoryFileJson): void {
  const realMrvcDir = resolveSafeHistoryDir(projectRoot, true)!;
  const fileInfo = assertContainedMetaFile(realMrvcDir, 'output-history.json', true);
  if (!ensureHistoryIgnore(realMrvcDir)) {
    throw new Error('refusing to write output-history.json: .gitignore entries could not be confirmed');
  }
  const tmp = path.join(realMrvcDir, `output-history.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
    assertContainedMetaFile(realMrvcDir, 'output-history.json', true);
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, fileInfo.path);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (attempt < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          sleepSync(10);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore temp cleanup failure
    }
    throw e;
  }
}

function resolveContainedRealDir(projectRoot: string, buildDir: string): string | undefined {
  const root = path.resolve(projectRoot);
  const d = path.resolve(root, buildDir);
  try {
    const lst = fs.lstatSync(d);
    if (lst.isSymbolicLink() || !lst.isDirectory()) return undefined;
    const realR = fs.realpathSync.native(root);
    const realD = fs.realpathSync.native(d);
    const realPrefix = realR.endsWith(path.sep) ? realR : realR + path.sep;
    if (fold(realD) === fold(realR) || !fold(realD).startsWith(fold(realPrefix))) return undefined;
    return realD;
  } catch {
    return undefined;
  }
}

function safeChildPath(realDir: string, rel: string): { normRel: string; abs: string } | undefined {
  const normRel = toPosix(rel).replace(/^\/+/, '');
  if (!normRel || normRel === '.' || normRel === '..' || normRel.startsWith('../')) return undefined;
  const abs = path.resolve(realDir, normRel);
  const prefix = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
  if (!fold(abs).startsWith(fold(prefix))) return undefined;
  return { normRel, abs };
}

/** Load recorded write history for one physical output directory (`realDir`). */
export function loadDirHistory(projectRoot: string, realDir: string): DirHistory {
  const store = readHistoryStore(projectRoot);
  const entry = store.dirs[fold(realDir)];
  if (!entry) return { files: new Map() };
  return {
    files: new Map<string, string>(Object.entries(entry.files)),
    encoding: entry.encoding,
  };
}

/**
 * Record specific relative files genuinely written inside `buildDir` (e.g. from
 * `generateMakefiles`). Never scans arbitrary directory contents.
 */
export function recordWrittenFiles(
  projectRoot: string,
  buildDir: string,
  relPaths: readonly string[],
  encoding?: AnsiArtifactEncoding
): void {
  try {
    const realD = resolveContainedRealDir(projectRoot, buildDir);
    if (!realD) return;
    const writes: WrittenFile[] = [];
    for (const rawRel of relPaths) {
      const target = safeChildPath(realD, rawRel);
      if (!target) continue;
      const sha256 = sha256File(target.abs);
      if (sha256) writes.push({ rel: target.normRel, sha256 });
    }
    if (!writes.length && !encoding) return;
    const realMrvcDir = resolveSafeHistoryDir(projectRoot, true)!;
    withHistoryLock(realMrvcDir, () => {
      const store = readHistoryStore(projectRoot);
      const dirKey = fold(realD);
      const prevEntry = store.dirs[dirKey];
      const prevMap = new Map<string, string>(prevEntry ? Object.entries(prevEntry.files) : []);
      const nextMap = updateHistory(prevMap, writes);
      const filesObj: Record<string, string> = {};
      for (const [k, v] of nextMap) filesObj[k] = v;
      store.dirs[dirKey] = {
        files: filesObj,
        encoding: encoding ?? prevEntry?.encoding,
      };
      writeHistoryStore(projectRoot, store);
    });
  } catch {
    // history recording is best-effort; never fail a build/generate
  }
}

/** Snapshot candidate output files right BEFORE `make` runs so post-build
 *  recording can tell which files `make` actually created or updated. */
export function snapshotExistingOutputs(buildDir: string, relPaths: readonly string[]): PreBuildSnapshot {
  const snap: PreBuildSnapshot = new Map();
  try {
    const lstDir = fs.lstatSync(buildDir);
    if (lstDir.isSymbolicLink() || !lstDir.isDirectory()) return snap;
    const realD = fs.realpathSync.native(buildDir);
    for (const rawRel of relPaths) {
      const target = safeChildPath(realD, rawRel);
      if (!target) continue;
      try {
        const st = fs.lstatSync(target.abs);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        const sha256 = createHash('sha256').update(fs.readFileSync(target.abs)).digest('hex');
        snap.set(fold(target.normRel), { mtimeMs: st.mtimeMs, size: st.size, sha256 });
      } catch {
        // absent or unreadable — omitted from pre-build snapshot
      }
    }
  } catch {
    // best-effort
  }
  return snap;
}

/** Record candidate outputs that were created or modified during `make`.
 *  Pre-existing untouched files are never claimed. */
export function recordBuildOutputs(
  projectRoot: string,
  buildDir: string,
  relPaths: readonly string[],
  before: PreBuildSnapshot
): void {
  try {
    const realD = resolveContainedRealDir(projectRoot, buildDir);
    if (!realD) return;
    const touched: string[] = [];
    for (const rawRel of relPaths) {
      const target = safeChildPath(realD, rawRel);
      if (!target) continue;
      try {
        const st = fs.lstatSync(target.abs);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        const prev = before.get(fold(target.normRel));
        if (!prev) {
          touched.push(target.normRel);
          continue;
        }
        const sha = createHash('sha256').update(fs.readFileSync(target.abs)).digest('hex');
        if (st.mtimeMs !== prev.mtimeMs || st.size !== prev.size || sha !== prev.sha256) {
          touched.push(target.normRel);
        }
      } catch {
        // absent
      }
    }
    if (touched.length) recordWrittenFiles(projectRoot, buildDir, touched);
  } catch {
    // best-effort
  }
}

/** Remove deleted file entries from `realDir`'s history after successful unlink. */
export function pruneDeletedHistory(projectRoot: string, realDir: string, deletedRels: readonly string[]): void {
  if (!deletedRels.length) return;
  try {
    const realMrvcDir = resolveSafeHistoryDir(projectRoot, false);
    if (!realMrvcDir) return;
    withHistoryLock(realMrvcDir, () => {
      const store = readHistoryStore(projectRoot);
      const dirKey = fold(realDir);
      const entry = store.dirs[dirKey];
      if (!entry) return;
      let changed = false;
      for (const rel of deletedRels) {
        const k = fold(rel);
        if (k in entry.files) {
          delete entry.files[k];
          changed = true;
        }
      }
      if (!changed) return;
      if (Object.keys(entry.files).length === 0) {
        delete store.dirs[dirKey];
      }
      writeHistoryStore(projectRoot, store);
    });
  } catch {
    // best-effort
  }
}
