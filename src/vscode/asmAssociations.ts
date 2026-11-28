/**
 * The opt-in language-mode association writer (0.3.8, user-directed design):
 * MRVC does NOT claim file extensions globally via the languages
 * contribution — that would hijack the extensions for every folder and race
 * whatever extensions the user installed. Instead, once MRVC is enabled
 * (the extension started behind the install gate AND the folder actually
 * carries an MRS project), the workspace's .vscode/settings.json gets
 * files.associations entries for THREE independent families:
 *
 *   *.s / *.S  → mrvc-qingke       (MRS assembly sources — all-or-nothing
 *                                   pair: a user value on either glob means
 *                                   hands off both)
 *   *.lst      → mrvc-objdump-lst  (objdump / GAS -adhlns listings)
 *   *.map      → mrvc-ld-map       (linker maps)
 *
 * A glob is only written when it has NO value (user settings, workspace
 * settings or an earlier MRVC write all count: the user may re-point it at
 * any other mode and MRVC never fights). An earlier build scoped the map
 * family to per-project output dirs (`adc/adc_x/obj/*.map`, one glob per
 * project — user feedback 2026-11-26: an EVT-style tree exploded that into
 * dozens of lines), so THIS build additionally PRUNES those generated
 * per-dir globs back out when their value is still MRVC's own
 * mrvc-ld-map — the plain `*.map` replaces them (user-repointed entries are
 * never touched).
 *
 * Workspace folders WITHOUT a loaded MRS project are never touched (a
 * multi-root workspace can mix MRS projects with documentation or other
 * repositories). Purely a settings write — re-pointing a glob at another
 * language (or removing MRVC) restores the previous behavior; deleting the
 * lines while MRVC stays enabled re-applies the default on the next
 * activation.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { stripJsonc } from '../core/jsonc';
import { foldPathOnPlatform } from '../core/cproject';
import { isOutsideRelPath } from '../core/macros';
import { assertContainedMetaFile, resolveContainedMetaDir } from '../core/outputHistory';
import { writeWorkspaceCacheSettings } from './intellisense';

/** the language modes MRVC provides */
export const ASM_LANGUAGE_ID = 'mrvc-qingke';
export const LST_LANGUAGE_ID = 'mrvc-objdump-lst';
export const MAP_LANGUAGE_ID = 'mrvc-ld-map';

/** the assembler pair is checked as ONE family (see module doc) */
const ASM_GROUP_GLOBS = ['*.s', '*.S'] as const;
const LST_GROUP_GLOBS = ['*.lst'] as const;
const MAP_GROUP_GLOBS = ['*.map'] as const;
/** the per-output-dir globs the previous build generated — pruned when they
 * still point at MRVC's own map language (`<dirs>/*.map` shape only, so a
 * user's own `something/*.map` entry with another language survives) */
const PRUNED_PER_DIR_MAP_GLOB = /\/\*\.map$/;

export interface AsmAssociationsResult {
  /** workspace folders where at least one family was written */
  written: string[];
  /** workspace folders where nothing was written — every glob already has a
   * value (user choice) or no family applies */
  skipped: string[];
  /** workspace folders whose settings.json could not be parsed */
  unreadable: string[];
  /** workspace folders MRVC does not manage (no MRS project inside, or not
   * a file-scheme folder) — left alone on purpose */
  noProjects: string[];
}

/** does this glob still need its association written? Only "no value"
 * qualifies — ANY existing value (MRVC's own or the user's) means hands
 * off; the written entry can always be re-pointed by hand */
function needsAssociationWrite(v: unknown): boolean {
  return v === undefined || v === null;
}

/** is `target` the folder itself or somewhere below it (case-folded on
 * Windows, cross-drive returns an absolute relative path = outside) */
function isInsideFolder(folder: string, target: string): boolean {
  const rel = path.relative(foldPathOnPlatform(folder), foldPathOnPlatform(target));
  return rel === '' || !isOutsideRelPath(rel);
}

/**
 * One pass over every workspace folder: write the managed associations
 * where the globs have no value yet (checked against the MERGED
 * configuration, so a user-level setting also counts, and against the file
 * on disk, so a stale configuration cache cannot make us overwrite a fresh
 * hand edit). Idempotent — a second run sees its own entries and skips.
 *
 * `projectRoots` are the legal MRS project roots the store knows; only
 * folders containing at least one of them are managed.
 */
export function applyAsmAssociations(projectRoots: readonly string[] = []): AsmAssociationsResult {
  const written: string[] = [];
  const skipped: string[] = [];
  const unreadable: string[] = [];
  const noProjects: string[] = [];
  for (const wf of vscode.workspace.workspaceFolders ?? []) {
    try {
      if (wf.uri.scheme !== 'file') {
        // remote/virtual folders have no local .vscode/settings.json
        noProjects.push(wf.name);
        continue;
      }
      if (!projectRoots.some((root) => isInsideFolder(wf.uri.fsPath, root))) {
        noProjects.push(wf.name);
        continue;
      }
      // `files.associations: null` (or a hand-edited array) comes back as-is
      // from getConfiguration — defaultValue only covers `undefined`; coerce
      // instead of indexing it blindly
      const mergedRaw = vscode.workspace.getConfiguration('files', wf.uri).get<unknown>('associations', {});
      const merged =
        mergedRaw !== null && typeof mergedRaw === 'object' && !Array.isArray(mergedRaw) ? (mergedRaw as Record<string, unknown>) : {};
      const readVscodeDir = resolveContainedMetaDir(wf.uri.fsPath, ['.vscode'], false);
      const readSettingsInfo = readVscodeDir ? assertContainedMetaFile(readVscodeDir, 'settings.json', true) : undefined;
      let raw = '';
      try {
        if (readSettingsInfo?.exists) raw = fs.readFileSync(readSettingsInfo.path, 'utf-8');
      } catch {
        raw = ''; // absent — created fresh by the writer below
      }
      let existingAssoc: Record<string, string> = {};
      // plain JSON (or an absent file) can take key REMOVALS; a JSONC file
      // cannot (surgical deletion would need comma/comment reconstruction),
      // so the per-dir migration below must not count its prunes toward the
      // write decision there — otherwise every store change would rebuild
      // the removal plan and hit the writer for a guaranteed 'unchanged'
      // (review M3)
      const trailingCommas = new Map<number, number>();
      const stripped = stripJsonc(raw, trailingCommas);
      const isPlainJson = raw === '' || raw === stripped;
      if (raw !== '') {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(stripped) as Record<string, unknown>;
        } catch {
          unreadable.push(wf.name);
          continue;
        }
        const a = parsed['files.associations'];
        if (a !== undefined && a !== null && (typeof a !== 'object' || Array.isArray(a))) {
          // a hand edit turned the key into something unrecognizable — never
          // touch what we do not understand
          unreadable.push(wf.name);
          continue;
        }
        if (a && typeof a === 'object') {
          existingAssoc = a as Record<string, string>;
        }
      }
      // merge every family into ONE desired value; the assembler pair is
      // all-or-nothing, .lst and .map are judged independently
      const desired: Record<string, string> = { ...existingAssoc };
      let pending = 0;
      const consider = (globs: readonly string[], languageId: string, allOrNothing: boolean): void => {
        if (allOrNothing && globs.some((g) => !needsAssociationWrite(merged[g]) || !needsAssociationWrite(existingAssoc[g]))) {
          return; // the assembler pair is the user's — no mixed pair
        }
        for (const g of globs) {
          if (!needsAssociationWrite(merged[g]) || !needsAssociationWrite(existingAssoc[g])) continue;
          if (desired[g] !== languageId) {
            desired[g] = languageId;
            pending++;
          }
        }
      };
      consider(ASM_GROUP_GLOBS, ASM_LANGUAGE_ID, true);
      consider(LST_GROUP_GLOBS, LST_LANGUAGE_ID, false);
      consider(MAP_GROUP_GLOBS, MAP_LANGUAGE_ID, false);
      // migration: the previous build wrote one glob PER PROJECT OUTPUT DIR
      // — prune them back out wherever they still carry MRVC's own map
      // language (user-repointed entries survive untouched). PLAIN-JSON
      // files only: a JSONC file cannot take surgical removals, so its old
      // keys stay (still functional — they point at mrvc-ld-map)
      const removeKeys: string[] = [];
      if (isPlainJson) {
        for (const k of Object.keys(desired)) {
          if (PRUNED_PER_DIR_MAP_GLOB.test(k) && desired[k] === MAP_LANGUAGE_ID) {
            delete desired[k];
            removeKeys.push(k);
            pending++;
          }
        }
      }
      if (!pending) {
        skipped.push(wf.name);
        continue;
      }
      const wfVscode = resolveContainedMetaDir(wf.uri.fsPath, ['.vscode'], true)!;
      const settingsInfo = assertContainedMetaFile(wfVscode, 'settings.json', true);
      const r = writeWorkspaceCacheSettings(settingsInfo.path, [
        { key: 'files.associations', value: desired, kind: 'object', removeKeys },
      ]);
      if (r === 'unreadable') unreadable.push(wf.name);
      else if (r === 'unchanged') skipped.push(wf.name); // nothing to write — the disk already carries the entries
      else written.push(wf.name);
    } catch {
      unreadable.push(wf.name);
    }
  }
  return { written, skipped, unreadable, noProjects };
}
