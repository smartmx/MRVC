/**
 * Install auto-fill (0.3.6, user request): run the conventional-location
 * probe ONCE at activation; every generation whose setting is empty and
 * whose probe succeeds gets the detected root WRITTEN into the user-level
 * settings — the next launch reads them directly instead of probing again.
 * When both generations end up valid and mrvc.mrsVersion is still `auto`,
 * the user is asked which generation to use (once per installation,
 * globalState-marked — declining keeps `auto` without re-nagging).
 *
 * Runs BEFORE the startup gate: a successful fill makes the gate pass on
 * the first activation instead of showing the "no install" error once and
 * re-gating through the settings-change listener.
 */
import * as vscode from 'vscode';
import { conventionalInstalls, checkInstallPath } from '../core/toolchain';
import { planInstallFill, type InstallFillFound, type InstallFillState } from '../core/installFill';
import { t } from '../core/i18n';

const PROMPTED_KEY = 'mrvc.installGenerationPrompted';

/** first valid conventional root for a generation, or undefined */
function probeGeneration(gen: 'mrs2' | 'mrs3', roots: string[]): string | undefined {
  for (const p of roots) {
    const check = checkInstallPath(p, gen);
    if (check.ok && check.install) return check.install.root;
  }
  return undefined;
}

/** one readable entry per filled setting */
function filledLabel(gen: 'mrs2' | 'mrs3', root: string): string {
  const flavor = gen === 'mrs3' ? 'MRS3' : 'MRS2';
  return `${flavor}: ${root}`;
}

export async function autoFillInstalls(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('mrvc');
  const state: InstallFillState = {
    mrs2Path: cfg.get<string>('mrs2InstallPath', ''),
    mrs3Path: cfg.get<string>('mrs3InstallPath', ''),
    version: cfg.get<string>('mrsVersion', 'auto'),
  };
  const conv = conventionalInstalls();
  const found: InstallFillFound = {};
  // only generations with an EMPTY setting are probed — a user-set path is
  // never overridden by the probe (invalid values go through the startup
  // gate instead)
  if (!state.mrs2Path.trim()) found.mrs2 = probeGeneration('mrs2', conv.mrs2);
  if (!state.mrs3Path.trim()) found.mrs3 = probeGeneration('mrs3', conv.mrs3);
  // round7 P3.1: EXISTING non-empty paths are validated too — a generation
  // whose setting points at a non-install does not count as "both valid"
  // for the choice prompt
  const valid: { mrs2?: boolean; mrs3?: boolean } = {};
  if (state.mrs2Path.trim()) valid.mrs2 = checkInstallPath(state.mrs2Path.trim(), 'mrs2').ok;
  if (state.mrs3Path.trim()) valid.mrs3 = checkInstallPath(state.mrs3Path.trim(), 'mrs3').ok;
  const plan = planInstallFill(state, found, valid);

  const filled: string[] = [];
  if (plan.writes.mrs2Path) {
    await cfg.update('mrs2InstallPath', plan.writes.mrs2Path, vscode.ConfigurationTarget.Global);
    filled.push(filledLabel('mrs2', plan.writes.mrs2Path));
  }
  if (plan.writes.mrs3Path) {
    await cfg.update('mrs3InstallPath', plan.writes.mrs3Path, vscode.ConfigurationTarget.Global);
    filled.push(filledLabel('mrs3', plan.writes.mrs3Path));
  }
  if (filled.length) {
    void vscode.window.showInformationMessage(t('installAutoFilled', filled.join('  ')));
  }

  // the generation-choice prompt: both generations valid afterwards and the
  // preference still `auto` — once per installation (globalState), declining
  // keeps `auto` without re-nagging
  if (plan.promptGeneration && !context.globalState.get<boolean>(PROMPTED_KEY)) {
    context.globalState.update(PROMPTED_KEY, true);
    void vscode.window
      .showInformationMessage(t('installChooseGeneration'), t('installUseMRS3'), t('installUseMRS2'), t('installKeepAuto'))
      .then((pick) => {
        if (pick === t('installUseMRS3')) {
          void vscode.workspace
            .getConfiguration('mrvc')
            .update('mrsVersion', 'mrs3', vscode.ConfigurationTarget.Global);
        } else if (pick === t('installUseMRS2')) {
          void vscode.workspace
            .getConfiguration('mrvc')
            .update('mrsVersion', 'mrs2', vscode.ConfigurationTarget.Global);
        }
        // keep-auto: nothing to write
      });
  }
}
