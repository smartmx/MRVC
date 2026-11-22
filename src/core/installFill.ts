/**
 * Install auto-fill decision layer (0.3.6, user request): when the
 * conventional-location probe finds a valid MRS install and the
 * corresponding setting is empty, the detected root is written INTO the
 * settings — the next launch reads them directly instead of probing again.
 * When BOTH generations end up valid and the version preference is still
 * `auto`, the user is asked which generation to use.
 *
 * Pure decision layer (no vscode import) — the vscode side
 * (vscode/installAutoFill.ts) probes, writes the settings and shows the
 * prompt; tests exercise this module directly.
 */

export interface InstallFillState {
  mrs2Path: string;
  mrs3Path: string;
  /** mrvc.mrsVersion ('auto' | 'mrs2' | 'mrs3') */
  version: string;
}

/** conventionally detected roots — only generations whose setting is empty
 *  are probed by the caller */
export interface InstallFillFound {
  mrs2?: string;
  mrs3?: string;
}

/** caller-side validation of EXISTING non-empty settings (round7 P3.1): a
 *  non-empty path that fails checkInstallPath does NOT count as a valid
 *  generation for the prompt (an invalid MRS2 must not be offered as a
 *  choice just because the string is non-empty). Absent = not checked =
 *  treated as valid (backward compatibility for thin callers). */
export interface InstallFillValid {
  mrs2?: boolean;
  mrs3?: boolean;
}

export interface InstallFillPlan {
  /** the settings to write (user-level); empty strings are never written */
  writes: { mrs2Path?: string; mrs3Path?: string };
  /** both generations are valid after the fill and the preference is still
   *  `auto` → the caller prompts which generation to use (once) */
  promptGeneration: boolean;
}

/** the version preference is explicit when it names a generation */
function versionExplicit(version: string): boolean {
  const v = (version ?? '').trim().toLowerCase();
  return v === 'mrs2' || v === 'mrs3';
}

/** the effective generation validity AFTER applying the planned writes:
 *  a non-empty setting stays and counts only if the caller validated it
 *  (valid !== false); an empty one is filled by the probe — probe results
 *  are valid by construction */
function effective(
  state: InstallFillState,
  found: InstallFillFound,
  valid: InstallFillValid,
  gen: 'mrs2' | 'mrs3'
): string | undefined {
  const set = (gen === 'mrs2' ? state.mrs2Path : state.mrs3Path).trim();
  if (set) {
    const ok = gen === 'mrs2' ? valid.mrs2 : valid.mrs3;
    return ok === false ? undefined : set;
  }
  const probed = (gen === 'mrs2' ? found.mrs2 : found.mrs3)?.trim();
  return probed || undefined;
}

export function planInstallFill(
  state: InstallFillState,
  found: InstallFillFound,
  valid: InstallFillValid = {}
): InstallFillPlan {
  const writes: { mrs2Path?: string; mrs3Path?: string } = {};
  const mrs2Fill = state.mrs2Path.trim() ? undefined : (found.mrs2?.trim() || undefined);
  const mrs3Fill = state.mrs3Path.trim() ? undefined : (found.mrs3?.trim() || undefined);
  if (mrs2Fill) writes.mrs2Path = mrs2Fill;
  if (mrs3Fill) writes.mrs3Path = mrs3Fill;
  const bothValid = !!effective(state, found, valid, 'mrs2') && !!effective(state, found, valid, 'mrs3');
  return { writes, promptGeneration: bothValid && !versionExplicit(state.version) };
}
