/**
 * The flash power-output rail as far as MRVC can KNOW it — session-only
 * state, deliberately not a persisted setting.
 *
 * Requirement (user, 2026-11-18): every workspace opens at 3.3 V; only an
 * explicit manual switch may raise it to 5 V; closing the window restores
 * 3.3 V. A `mrvc.flash.powerOutput` setting can never satisfy this — it
 * persists across windows and workspaces — so the rail lives in this module
 * instead (the module instance dies with the extension host, which is the
 * window; a fresh window re-enters at 3.3 V by construction).
 *
 * The rail feeds three consumers: the power-off-reset download's re-power
 * pass, the standalone Power-Off Reset command, and the Info view's display
 * row. Switching is only possible through mrvc.powerOutputRail (the Info
 * row's QuickPick); there is no hardware read-back — like the SDI state,
 * this reflects MRVC's own session value only.
 */
export type PowerRail = '3v3' | '5v';

let current: PowerRail = '3v3';
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // a listener must never break the switcher
    }
  }
}

/** the rail the next power pass will use (3.3 V until manually switched) */
export function powerOutputRail(): PowerRail {
  return current;
}

/** the result of a manual switch (Info row QuickPick) */
export function notePowerOutputRail(rail: PowerRail): void {
  if (rail === current) return;
  current = rail;
  emit();
}

/** test seam: back to the window's opening value */
export function resetPowerOutputRail(): void {
  current = '3v3';
  emit();
}

export function onPowerOutputRailChanged(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}
