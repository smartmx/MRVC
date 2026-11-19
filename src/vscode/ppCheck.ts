/**
 * Preprocessor consistency — detect + unify flow (0.3.3, user request).
 *
 * Two triggers (user decision 2026-11-19):
 *  - the properties page's Apply: after a successful save the
 *    freshly-written .cproject is checked; any divergence goes straight
 *    into the per-macro unify flow, a consistent state is completely
 *    silent (Apply runs constantly and must not nag);
 *  - project right-click "Check Preprocessor Macros": the same check on
 *    demand, but an all-clear is reported.
 *
 * The old pre-save macroConflicts modal is gone: this check covers the
 * same divergence with an actionable fix instead of a go-back-and-edit
 * dead end.
 *
 * Unify write semantics per macro: pick one of the stored values, pick the
 * target lists (all three pre-checked = true unification; unchecking a
 * list skips it), then update-in-place via mergeMacroList + append to
 * lists the macro was absent from — never delete, untouched macros stay
 * verbatim. Each macro's edits are saved as they are confirmed, so a flow
 * abandoned mid-way keeps the earlier unifications.
 */
import * as vscode from 'vscode';
import { MrsProject, ProjectStore, msg } from './projects';
import { Cproject } from '../core/cproject';
import { PP_DEFINE_SUFFIXES, PpDivergence, PpTool, ppDivergences } from '../core/ppConsistency';
import { mergeMacroList } from '../core/macroDefs';
import { t } from '../core/i18n';

let ppCh: vscode.OutputChannel | undefined;
const ppChannel = (): vscode.OutputChannel => {
  if (!ppCh) ppCh = vscode.window.createOutputChannel('MRVC Preprocessor');
  return ppCh;
};

function toolLabel(tool: PpTool): string {
  return tool === 'c' ? t('ppToolC') : tool === 'cpp' ? t('ppToolCpp') : t('ppToolAsm');
}

/** "C=1, C++=2" — one entry per list the macro appears in */
function occurrenceSummary(d: PpDivergence): string {
  return d.occurrences
    .map((o) => `${toolLabel(o.tool)}=${o.value || t('ppValueEmpty')}`)
    .join(', ');
}

/**
 * Post-Apply check: silent when the three define lists agree; otherwise
 * logs the divergences to the MRVC Preprocessor channel and opens the
 * unify flow. Errors never surface as unhandled rejections (this runs
 * fire-and-forget from the save handler).
 */
export async function ppCheckAfterApply(store: ProjectStore, project: MrsProject): Promise<void> {
  try {
    let divergences: PpDivergence[];
    try {
      divergences = ppDivergences(project.cproject);
    } catch {
      return; // never let the check break the save path
    }
    if (!divergences.length) return;
    if (ppFlowOpen) return; // the open flow is already driving these fixes
    await ppUnifyFlow(store, project, divergences);
  } catch (e) {
    vscode.window.showErrorMessage(t('ppCheckFailed', msg(e)));
  }
}

/**
 * Manual trigger (project right-click, user addition 2026-11-19): the same
 * check on a FRESHLY-loaded .cproject, but an all-clear is REPORTED — the
 * Apply path stays silent when consistent, while an explicit check must
 * answer.
 */
export async function ppCheckCommand(store: ProjectStore, project: MrsProject): Promise<void> {
  try {
    const divergences = ppDivergences(Cproject.load(project.root));
    if (!divergences.length) {
      vscode.window.showInformationMessage(t('ppAllConsistent', project.projectName));
      return;
    }
    if (ppFlowOpen) {
      vscode.window.showWarningMessage(t('ppFlowBusy'));
      return;
    }
    await ppUnifyFlow(store, project, divergences);
  } catch (e) {
    vscode.window.showErrorMessage(t('ppCheckFailed', msg(e)));
  }
}

/**
 * Per-divergence unify: one QuickPick for the value to keep (every DISTINCT
 * stored value, labelled with the lists holding it) and one multi-select
 * for the lists to write (all pre-checked; unchecking skips a list —
 * including one the macro is absent from, so nothing is appended behind
 * the user's back). Each macro's edits are saved as they are confirmed, so
 * a flow abandoned mid-way keeps the earlier unifications.
 *
 * The .cproject is loaded FRESH after both picks, and everything from that
 * load to cp.save() is synchronous: an external edit (MRS / another window
 * / another editor) made while the QuickPicks were open is picked up
 * instead of being clobbered by a stale model (round53 P2). One flow at a
 * time — the caller checks `ppFlowOpen` first.
 */
/** one unify flow at a time: two overlapping flows would hold QuickPicks
 *  open for the same file and interleave their writes (round53 P2) */
let ppFlowOpen = false;

/** guard + bookkeeping around the interactive flow */
async function ppUnifyFlow(store: ProjectStore, project: MrsProject, divergences: PpDivergence[]): Promise<void> {
  ppFlowOpen = true;
  try {
    await ppUnifyFlowInner(store, project, divergences);
  } finally {
    ppFlowOpen = false;
  }
}

async function ppUnifyFlowInner(store: ProjectStore, project: MrsProject, divergences: PpDivergence[]): Promise<void> {
  const ch = ppChannel();
  ch.appendLine(`\n===== Preprocessor check — ${project.projectName} =====`);
  for (const d of divergences) ch.appendLine(`[DIVERGENT] ${d.name}: ${occurrenceSummary(d)}`);
  let changed = 0;
  for (const d of divergences) {
    // distinct value -> the representative entry written verbatim + holders
    const byValue = new Map<string, { raw: string; tools: PpTool[] }>();
    for (const o of d.occurrences) {
      const hit = byValue.get(o.value);
      if (hit) hit.tools.push(o.tool);
      else byValue.set(o.value, { raw: o.raw, tools: [o.tool] });
    }
    const valueItems = [...byValue.entries()].map(([value, info]) => ({
      label: info.raw,
      description: `${info.tools.map(toolLabel).join(', ')}`,
      value,
    }));
    const skipItem = { label: t('ppFixSkip'), skip: true };
    const picked = await vscode.window.showQuickPick([...valueItems, skipItem], {
      title: t('ppPickValueTitle', d.name),
      placeHolder: `${t('ppPickValuePh')}  ${occurrenceSummary(d)}`,
      canPickMany: false,
    });
    if (!picked || 'skip' in picked) continue;
    // lists to write: all three pre-checked — a list the macro is absent
    // from gets it appended (only when the user keeps it checked)
    const toolItems = PP_DEFINE_SUFFIXES.map(([tool]) => ({ label: toolLabel(tool), tool, picked: true }));
    const targets = await vscode.window.showQuickPick(toolItems, {
      title: t('ppPickToolsTitle', d.name),
      placeHolder: t('ppPickToolsPh'),
      canPickMany: true,
    });
    if (!targets || !targets.length) continue;
    // FRESH load after the last await — see the doc comment (round53 P2)
    const cp = Cproject.load(project.root);
    let updated = 0;
    let added = 0;
    for (const item of targets) {
      const suffix = PP_DEFINE_SUFFIXES.find(([tool]) => tool === item.tool)?.[1];
      if (!suffix) continue;
      const merged = mergeMacroList(cp.listOption(suffix).values, [{ name: d.name, value: picked.value }], true);
      cp.setOptionList(suffix, merged.list);
      updated += merged.updated;
      added += merged.added;
    }
    cp.save();
    store.reloadProject(project);
    changed++;
    ch.appendLine(`[UNIFIED] ${d.name} -> "${picked.label}" (${updated} updated, ${added} appended)`);
  }
  if (!changed) {
    vscode.window.showInformationMessage(t('ppNoChange'));
    return;
  }
  ch.appendLine('===== done =====');
  ch.show(true);
  vscode.window.showInformationMessage(t('ppUnified', changed, project.projectName));
}
