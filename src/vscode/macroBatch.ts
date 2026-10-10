/**
 * Edit Macro Definitions Across Projects — dedicated page (NOT part of the
 * Sync Setting page: macro editing is its own workflow). Form A layout:
 *
 *   1. READ-ONLY summary grouped by project (every project's macros under
 *      its own heading, value-divergent rows highlighted, macro-name filter)
 *   2. target-macro editor — the three textareas (C / C++ / Assembler),
 *      seeded with the cross-project union
 *   3. TARGET PROJECT SELECTION — per-project checkboxes (default none)
 *
 * Write semantics: update-in-place + optional append, NEVER delete — a
 * macro the panes don't mention stays untouched. Apply writes ONLY the
 * ticked projects ("all" is one click away via Select all). Cross-pane
 * conflicts and the confirm dialog live on the HOST side (same modal
 * pattern as the properties page's save).
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ProjectStore, MrsProject, msg } from './projects';
import { Cproject } from '../core/cproject';
import { jsonForScript } from './configView';
import { t } from '../core/i18n';
import { parseMacroLines, macroNameConflicts, macroStats, mergeMacroList, MacroToken } from '../core/macroDefs';

interface PaneDef {
  key: string;
  /** .cproject list option suffix */
  suffix: string;
  label: string;
  /** C++ tool option — skipped on C projects */
  cppOnly: boolean;
}

const PANES: PaneDef[] = [
  { key: 'defs', suffix: 'c.compiler.defs', label: 'C', cppOnly: false },
  { key: 'cppdefs', suffix: 'cpp.compiler.defs', label: 'C++', cppOnly: true },
  { key: 'asmdefs', suffix: 'assembler.defs', label: 'ASM', cppOnly: false },
];

/** the macro NAME of a stored `NAME=VALUE` entry */
const entryName = (entry: string): string => {
  const eq = entry.indexOf('=');
  return eq < 0 ? entry : entry.slice(0, eq);
};

/** human-readable per-line diff between a project's stored macro list and
 * the merged result — one item line per change (update / add) */
function macroChangeLines(existing: string[], merged: string[]): string[] {
  const out: string[] = [];
  const n = Math.max(existing.length, merged.length);
  for (let i = 0; i < n; i++) {
    const before = existing[i];
    const after = merged[i];
    if (after === undefined) break; // merge never shrinks the list
    if (before === after) continue;
    out.push(before === undefined ? `+ ${after}` : `${before} ⇒ ${after}`);
  }
  return out;
}

const STYLE = `
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; }
#head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-editorWidget-border); }
#head .title { font-weight: 600; }
#head .hint { color: var(--vscode-descriptionForeground); }
#main { flex: 1; overflow: auto; padding: 10px 16px; }
.sechead { font-weight: 600; margin: 14px 0 6px; display: flex; align-items: center; gap: 10px; }
.sechead .sub { color: var(--vscode-descriptionForeground); font-weight: 400; font-size: 11.5px; }
.sechead input[type=text] { margin-left: auto; width: 220px; }
details.proj { border: 1px solid var(--vscode-editorWidget-border); border-radius: 3px; margin-bottom: 4px; }
details.proj > summary { padding: 4px 8px; cursor: pointer; font-weight: 600; list-style: none; }
details.proj > summary::before { content: '▸ '; opacity: .6; }
details.proj[open] > summary::before { content: '▾ '; }
details.proj > summary .pstat { color: var(--vscode-descriptionForeground); font-weight: 400; font-size: 11.5px; margin-left: 8px; }
.mrow { display: flex; gap: 8px; padding: 1px 8px 1px 22px; font-family: var(--vscode-editor-font-family), monospace; font-size: 12.5px; }
.mrow .mtag { flex: none; width: 32px; color: var(--vscode-descriptionForeground); font-size: 11px; padding-top: 1px; }
.mrow.div { background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, .12)); }
.mrow.div::after { content: '≠'; margin-left: auto; color: var(--vscode-descriptionForeground); }
.mempty { color: var(--vscode-descriptionForeground); padding: 2px 8px 4px 22px; font-size: 12px; }
.pane { margin-bottom: 16px; }
.panehead { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.panehead .plabel { font-weight: 600; }
.panehead .pstat { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
.panehead input[type=checkbox] { margin: 0; }
.pane textarea { width: 100%; box-sizing: border-box; min-height: 96px; resize: vertical; font-family: var(--vscode-editor-font-family), monospace; font-size: 12.5px; white-space: pre; }
#rules { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 4px 0 14px; }
.optline { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.optline input[type=checkbox] { margin: 0; }
.opthead { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.opthead button { padding: 2px 10px; font-size: 12px; }
.opthead .tcount { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
#tlist { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 14px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 3px; padding: 6px 8px; max-height: 180px; overflow: auto; }
.trow { display: flex; align-items: center; gap: 6px; padding: 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.trow input { margin: 0; }
#bar { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--vscode-editorWidget-border); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 18px; cursor: pointer; }
button.mini { padding: 3px 12px; font-size: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
#status { margin-left: auto; font-size: 12px; opacity: 0; transition: opacity .3s; }
`;

let batchCh: vscode.OutputChannel | undefined;
const batchChannel = (): vscode.OutputChannel => {
  if (!batchCh) batchCh = vscode.window.createOutputChannel('MRVC Batch Macros');
  return batchCh;
};

interface PanePayload {
  key: string;
  suffix: string;
  cppOnly: boolean;
  text: string;
}

interface ApplyMessage {
  command: string;
  panes?: PanePayload[];
  addMissing?: boolean;
  /** project roots to write — the ticked checkboxes */
  targets?: string[];
  /** true = write without the per-project review QuickPicks */
  skipReview?: boolean;
}

/** one written project's BEFORE state, captured for "undo last apply" */
interface UndoEntry {
  root: string;
  projectName: string;
  panes: Array<{ suffix: string; before: string[] }>;
}

export class MacroBatchPage {
  private panel: vscode.WebviewPanel | null = null;
  private store: ProjectStore;
  /** the BEFORE snapshot of the last successful apply — powers "undo".
   * REPLACED by each apply (not accumulated): the button promises "undo the
   * LAST apply", and accumulating would drag earlier applies' projects
   * back too when they overlap. */
  private lastUndo: UndoEntry[] | null = null;
  /** apply/undo run one at a time — the webview buttons don't disable
   * themselves and QuickPick/progress windows are long; a second message
   * arriving mid-run would interleave writes on the same files */
  private busy = false;

  constructor(store: ProjectStore) {
    this.store = store;
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      this.panel.webview.html = this.render();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('mrvc.batchMacros', 'Macro Definitions Across Projects', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel.webview.html = this.render();
  }

  private async onMessage(m: ApplyMessage): Promise<void> {
    // re-entry guard: double-clicked Apply, or Undo clicked while a write
    // is in flight, would interleave QuickPicks and load→save loops on the
    // same .cproject files (final state would depend on timing)
    if (this.busy) {
      this.panel?.webview.postMessage({ command: 'macroDone', text: t('macroBatchBusy') });
      return;
    }
    if (m.command === 'undoMacros') {
      this.busy = true;
      try {
        await this.undoLastApply();
      } finally {
        this.busy = false;
      }
      return;
    }
    if (m.command !== 'applyMacros' || !Array.isArray(m.panes) || !m.panes.length) return;
    this.busy = true;
    try {
      await this.applyMacros(m);
    } finally {
      this.busy = false;
    }
  }

  private async applyMacros(m: ApplyMessage): Promise<void> {
    if (!Array.isArray(m.panes) || !m.panes.length) return;
    const targets = Array.isArray(m.targets) ? m.targets : [];
    if (!targets.length) {
      vscode.window.showWarningMessage(t('macroBatchNoTargets'));
      return;
    }
    // resolve the ticked roots against the store (folded compare — the
    // strings made a round trip through the webview)
    const keys = new Set(targets.map((r) => ProjectStore.key(r)));
    const projects = this.store.all.filter((p) => keys.has(ProjectStore.key(p.root)));
    if (!projects.length) {
      vscode.window.showWarningMessage(t('macroBatchNoTargets'));
      return;
    }

    // cross-pane same-name different-value conflicts would silently write
    // whichever pane comes last — surface them before anything is written
    // (properties-page save runs the same check over its three fields)
    const conflicts = macroNameConflicts(m.panes.map((p) => ({ label: this.paneLabel(p.key), text: p.text })));
    if (conflicts.length) {
      const apply = await vscode.window.showWarningMessage(
        t('macroConflictTitle', conflicts.length),
        { modal: true, detail: conflicts.join('\n') },
        t('macroConflictApply'),
        t('macroConflictBack')
      );
      if (apply !== t('macroConflictApply')) return;
    }

    const ch = batchChannel();
    ch.appendLine(`\n===== Edit Macro Definitions Across Projects (${m.panes.map((p) => p.suffix.split('.')[0]).join(' + ')}${m.addMissing ? ' + add missing' : ''}, ${projects.length} target(s)) =====`);
    const start = Date.now();

    // ---- phase 1: compute per project, then review ONE BY ONE ----
    // (a fresh load per project: the review shows exactly what would be
    // written; the BEFORE list rides along for "undo last apply", and the
    // parsed TARGETS ride along so phase 2 re-merges against a fresh load
    // instead of blind-writing the phase-1 snapshot)
    interface Planned {
      p: MrsProject;
      panes: Array<{ suffix: string; targets: MacroToken[] }>;
      updated: number;
      added: number;
    }
    const planned: Planned[] = [];
    let reviewedSkipped = 0;
    let applyRest = false;
    let skipRest = false;
    let reviewCancelled = false;
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      let cp: Cproject;
      try {
        cp = Cproject.load(p.root);
      } catch (e) {
        // broken/missing .cproject on one target must not kill the whole
        // batch silently (phase 2 catches, so must phase 1)
        ch.appendLine(`[FAIL] ${p.projectName}  — ${msg(e)}`);
        continue;
      }
      const panePlans: Array<{ suffix: string; targets: MacroToken[] }> = [];
      let updated = 0;
      let added = 0;
      for (const pane of m.panes!) {
        if (pane.cppOnly && !cp.isCpp) continue;
        const targets = parseMacroLines(pane.text);
        const merged = mergeMacroList(cp.listOption(pane.suffix).values, targets, m.addMissing === true);
        if (merged.updated || merged.added) {
          panePlans.push({ suffix: pane.suffix, targets });
          updated += merged.updated;
          added += merged.added;
        }
      }
      if (!panePlans.length) {
        ch.appendLine(`[no changes] ${p.projectName}`);
        continue;
      }
      // fast mode: the "skip review" switch — everything computed goes
      // straight to the write phase (the before snapshots still ride along,
      // so Undo keeps working)
      if (m.skipReview === true) {
        planned.push({ p, panes: panePlans, updated, added });
        continue;
      }
      if (applyRest) {
        planned.push({ p, panes: panePlans, updated, added });
        continue;
      }
      if (skipRest) {
        reviewedSkipped++;
        ch.appendLine(`[SKIP] ${p.projectName} (skip-remaining)`);
        continue;
      }
      const decision = await this.reviewProject(p, cp, m, i + 1, projects.length, panePlans);
      if (decision === 'cancel') {
        reviewCancelled = true;
        break;
      }
      if (decision === 'apply' || decision === 'applyRest') {
        planned.push({ p, panes: panePlans, updated, added });
        if (decision === 'applyRest') applyRest = true;
        ch.appendLine(`[CONFIRMED] ${p.projectName} (${updated} updated, ${added} added)${decision === 'applyRest' ? ' — applying all remaining' : ''}`);
      } else {
        reviewedSkipped++;
        ch.appendLine(`[SKIP] ${p.projectName}${decision === 'skipRest' ? ' — skipping all remaining' : ''}`);
        if (decision === 'skipRest') skipRest = true;
      }
    }
    if (!planned.length) {
      const secs0 = ((Date.now() - start) / 1000).toFixed(1);
      ch.appendLine(`===== Batch macros ${reviewCancelled ? 'cancelled in review' : 'finished'}: nothing to write, ${reviewedSkipped} skipped, ${secs0}s =====`);
      ch.show(true);
      this.panel?.webview.postMessage({
        command: 'macroDone',
        text: `${reviewCancelled ? 'Cancelled' : 'Nothing to apply'}: ${reviewedSkipped} skipped`,
      });
      return;
    }

    // ---- phase 2: write the CONFIRMED projects (cancellable progress) ----
    let okCount = 0;
    let failCount = 0;
    let updatedTotal = 0;
    let addedTotal = 0;
    let cancelled = false;
    const undoEntries: UndoEntry[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('macroBatchProgress', planned.length), cancellable: true },
      async (progress, token) => {
        for (let i = 0; i < planned.length; i++) {
          const plan = planned[i];
          progress.report({ message: `(${i + 1}/${planned.length}) ${plan.p.projectName}` });
          // yield a MACRO task so Cancel clicks (IPC) are observed and the
          // progress notification repaints (same discipline as SyncPage)
          await new Promise((r) => setTimeout(r, 0));
          if (token.isCancellationRequested) {
            cancelled = true;
            break;
          }
          try {
            // re-merge on a FRESH load instead of blind-writing the phase-1
            // snapshot: a macro added externally while the review queue was
            // walked (properties page / MRS2 / hand edit) must survive —
            // setOptionList replaces the whole list, so writing the stale
            // snapshot would silently drop it and break the page's own
            // "nothing is deleted" promise
            const cp = Cproject.load(plan.p.root);
            const undoEntry: UndoEntry = { root: plan.p.root, projectName: plan.p.projectName, panes: [] };
            let changed = 0;
            for (const pane of plan.panes) {
              const before = cp.listOption(pane.suffix).values;
              const merged = mergeMacroList(before, pane.targets, m.addMissing === true);
              if (!merged.updated && !merged.added) continue; // external edits already reached the target
              cp.setOptionList(pane.suffix, merged.list);
              undoEntry.panes.push({ suffix: pane.suffix, before });
              changed++;
              updatedTotal += merged.updated;
              addedTotal += merged.added;
            }
            if (!changed) {
              // everything already agrees — don't touch the file (no mtime
              // churn, no phantom "written" entry, no pointless undo entry)
              ch.appendLine(`[no changes] ${plan.p.projectName} (already at target)`);
              continue;
            }
            cp.save();
            this.store.reloadProject(plan.p);
            okCount++;
            undoEntries.push(undoEntry);
            ch.appendLine(`[OK] ${plan.p.projectName} (written)`);
          } catch (e) {
            failCount++;
            ch.appendLine(`[FAIL] ${plan.p.projectName}  — ${msg(e)}`);
          }
        }
      }
    );
    // replaced (not accumulated): "undo the LAST apply" — an earlier apply's
    // projects must not ride along when they don't overlap
    this.lastUndo = undoEntries.length ? undoEntries : this.lastUndo;
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    ch.appendLine(
      `===== Batch macros ${cancelled ? 'cancelled' : 'finished'}: ${okCount}/${planned.length} written, ${failCount} failed, ${reviewedSkipped} skipped in review, ${updatedTotal} updated, ${addedTotal} added, ${secs}s =====`
    );
    ch.show(true);
    this.panel?.webview.postMessage({
      command: 'macroDone',
      text: `${cancelled ? 'Cancelled' : 'Applied'}: ${okCount}/${planned.length} written, ${failCount} failed, ${reviewedSkipped} skipped, ${updatedTotal} updated, ${addedTotal} added (${secs}s)`,
    });
  }

  /** restore every project the last apply WROTE back to its BEFORE macro
   * lists (one modal to confirm; undo replaces the snapshot — redo is not
   * kept, re-apply through the normal flow instead) */
  private async undoLastApply(): Promise<void> {
    if (!this.lastUndo?.length) {
      vscode.window.showInformationMessage(t('macroBatchNoUndo'));
      return;
    }
    const go = await vscode.window.showWarningMessage(
      t('macroBatchUndoConfirm', this.lastUndo.length),
      { modal: true },
      t('macroBatchUndo')
    );
    if (go !== t('macroBatchUndo')) return;
    const ch = batchChannel();
    const entries = this.lastUndo;
    const restored: boolean[] = [];
    let ok = 0;
    let i = 0;
    for (const entry of entries) {
      try {
        const cp = Cproject.load(entry.root);
        for (const pane of entry.panes) cp.setOptionList(pane.suffix, pane.before);
        cp.save();
        const p = this.store.all.find((x) => ProjectStore.key(x.root) === ProjectStore.key(entry.root));
        if (p) this.store.reloadProject(p);
        ok++;
        restored[i] = true;
        ch.appendLine(`[UNDO] ${entry.projectName} restored to pre-apply macros`);
      } catch (e) {
        restored[i] = false;
        ch.appendLine(`[FAIL] ${entry.projectName}  — ${msg(e)}`);
      }
      i++;
    }
    // keep the snapshot when something failed — those projects lose their
    // only restore path if we drop it (retry the undo after fixing the cause)
    this.lastUndo = ok === entries.length ? null : entries.filter((entry, i) => !restored[i]);
    ch.appendLine(`===== Undo finished: ${ok}/${entries.length} restored =====`);
    ch.show(true);
    this.panel?.webview.postMessage({ command: 'macroDone', text: `${t('macroBatchUndo')}: ${ok}/${entries.length}` });
  }

  /** the per-project review: before/after macro lists + change lines +
   * apply/skip actions (Esc = cancel ALL remaining). Returns the decision. */
  private async reviewProject(
    p: MrsProject,
    cp: Cproject,
    m: ApplyMessage,
    index: number,
    total: number,
    panePlans: Array<{ suffix: string; targets: MacroToken[] }>
  ): Promise<'apply' | 'skip' | 'applyRest' | 'skipRest' | 'cancel'> {
    const items: vscode.QuickPickItem[] = [];
    for (const pane of m.panes!) {
      if (pane.cppOnly && !cp.isCpp) {
        items.push({ label: `$(circle-slash) ${this.paneLabel(pane.key)} — ${t('macroBatchCppSkipRow')}` });
        continue;
      }
      const existing = cp.listOption(pane.suffix).values;
      const plan = panePlans.find((pp) => pp.suffix === pane.suffix);
      if (!plan) continue; // nothing to change in this pane
      const merged = mergeMacroList(existing, plan.targets, m.addMissing === true).list;
      items.push({ label: `$(arrow-left) ${this.paneLabel(pane.key)} · ${t('macroBatchBefore')}`, detail: existing.join('    ') || t('macroBatchEmpty') });
      items.push({ label: `$(arrow-right) ${this.paneLabel(pane.key)} · ${t('macroBatchAfter')}`, detail: merged.join('    ') || t('macroBatchEmpty') });
      for (const line of macroChangeLines(existing, merged)) items.push({ label: `   $(git-compare) ${line}` });
    }
    items.push({ label: `$(info) ${t('macroBatchKeepHint')}` });
    items.push({ label: t('macroBatchActionsSep'), kind: vscode.QuickPickItemKind.Separator });
    const act = (action: string, icon: string, key: string): vscode.QuickPickItem & { action: string } => ({
      label: `$(${icon}) ${t(key)}`,
      action,
    });
    const actions = [
      act('apply', 'check', 'macroBatchActApply'),
      act('skip', 'dash', 'macroBatchActSkip'),
      act('applyRest', 'fast-forward', 'macroBatchActApplyRest'),
      act('skipRest', 'debug-step-over', 'macroBatchActSkipRest'),
    ];
    const picked = await vscode.window.showQuickPick([...items, ...actions], {
      title: t('macroBatchReviewTitle', p.projectName, index, total),
      placeHolder: t('macroBatchReviewHint'),
      ignoreFocusOut: true,
    });
    if (!picked) return 'cancel';
    return (picked as { action?: string }).action === 'apply'
      ? 'apply'
      : (picked as { action?: string }).action === 'applyRest'
        ? 'applyRest'
        : (picked as { action?: string }).action === 'skipRest'
          ? 'skipRest'
          : 'skip';
  }

  private paneLabel(key: string): string {
    return PANES.find((p) => p.key === key)?.label ?? key;
  }

  private render(): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const nonce = crypto.randomBytes(16).toString('hex');
    const projects = this.store.all;

    // ---- 1. per-project divergence map: suffix -> name -> value set ----
    const divMap = new Map<string, Map<string, Set<string>>>();
    for (const pane of PANES) {
      const byName = new Map<string, Set<string>>();
      for (const p of projects) {
        for (const entry of p.cproject.listOption(pane.suffix).values) {
          const name = entryName(entry);
          let set = byName.get(name);
          if (!set) {
            set = new Set();
            byName.set(name, set);
          }
          set.add(entry);
        }
      }
      divMap.set(pane.suffix, byName);
    }

    // ---- 2. read-only summary grouped by project (Form A section 1) ----
    const summaryHtml = projects
      .map((p) => {
        let count = 0;
        const rows = PANES.map((pane) => {
          const values = p.cproject.listOption(pane.suffix).values;
          count += values.length;
          return values
            .map((entry) => {
              const div = (divMap.get(pane.suffix)!.get(entryName(entry))!.size > 1 ? ' div' : '');
              return `<div class="mrow${div}" data-m="${esc(entryName(entry).toLowerCase())}"><span class="mtag">${esc(pane.label)}</span><span class="mtext">${esc(entry)}</span></div>`;
            })
            .join('');
        }).join('');
        return `<details class="proj" open><summary>${esc(p.projectName)} <span class="pstat">${esc(t('macroBatchCount', count))}</span></summary>${rows || `<div class="mempty">${esc(t('macroBatchNoMacros'))}</div>`}</details>`;
      })
      .join('\n');

    // ---- 3. target-macro editor — starts EMPTY (user types the macros to
    // set; the per-pane stat and the summary above show what exists) ----
    const paneHtml = PANES.map((pane) => {
      const storedLists = projects.map((p) => p.cproject.listOption(pane.suffix).values);
      const stats = macroStats(storedLists);
      const stat = t('macroBatchStats', stats.names, stats.divergent);
      const cppNote = pane.cppOnly ? ` <span class="pstat">${esc(t('macroBatchCppOnly'))}</span>` : '';
      return `<div class="pane">
  <div class="panehead">
    <input type="checkbox" class="syncbox" data-sync="${pane.key}">
    <span class="plabel">${esc(this.paneLabel(pane.key))}</span>${cppNote}
    <span class="pstat" data-stat="${pane.key}">${esc(stat)}</span>
  </div>
  <textarea data-pane="${pane.key}" spellcheck="false"></textarea>
</div>`;
    }).join('\n');

    // ---- 4. target project selection (Form A section 3) ----
    const targetRows = projects
      .map((p) => `<label class="trow" data-name="${esc(p.projectName.toLowerCase())}"><input type="checkbox" class="tbox" data-root="${esc(p.root)}"><span title="${esc(p.root)}">${esc(p.projectName)}</span></label>`)
      .join('\n');

    const paneMeta = PANES.map((p) => ({ key: p.key, suffix: p.suffix, cppOnly: p.cppOnly }));

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>${STYLE}</style></head><body>
<div id="head">
  <span class="title">Macro Definitions Across Projects</span>
  <span class="hint">${esc(t('macroBatchHint', projects.length))}</span>
</div>
<div id="main">
  <div class="sechead">${esc(t('macroBatchSummaryHead'))}<span class="sub">${esc(t('macroBatchDivLegend'))}</span><input type="text" id="mfilter" placeholder="${esc(t('macroBatchFilterMacro'))}"></div>
  <div id="summary">${summaryHtml}</div>

  <div class="sechead">${esc(t('macroBatchEditorHead'))}</div>
  <div id="rules">${esc(t('macroBatchRules'))}</div>
  ${paneHtml}
  <div class="optline">
    <input type="checkbox" id="addmissing">
    <label for="addmissing">${esc(t('macroBatchAddMissing'))}</label>
  </div>
  <div class="optline">
    <input type="checkbox" id="skipreview">
    <label for="skipreview">${esc(t('macroBatchSkipReview'))}</label>
  </div>

  <div class="sechead">${esc(t('macroBatchTargets'))}<span class="tcount" id="tcount"></span><input type="text" id="tfilter" placeholder="${esc(t('macroBatchFilterProject'))}"></div>
  <div class="optline">
    <button type="button" id="all" class="mini">${esc(t('macroBatchSelectAll'))}</button>
    <button type="button" id="none" class="mini">${esc(t('macroBatchSelectNone'))}</button>
  </div>
  <div id="tlist">${targetRows}</div>
</div>
<div id="bar">
  <button type="button" id="apply">${esc(t('macroBatchApply'))}</button>
  <button type="button" id="undo" class="mini">${esc(t('macroBatchUndo'))}</button>
  <span id="status"></span>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const PANE_META = ${jsonForScript(paneMeta)};
// ---- macro-name filter over the per-project summary ----
document.getElementById('mfilter').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#summary .proj').forEach((d) => {
    let visible = 0;
    d.querySelectorAll('.mrow').forEach((r) => {
      const hit = !q || (r.dataset.m || '').includes(q);
      r.style.display = hit ? '' : 'none';
      if (hit) visible++;
    });
    const empty = d.querySelector('.mempty');
    if (empty) empty.style.display = (!q && visible === 0) ? '' : 'none';
    d.style.display = (visible || (!q && empty)) ? '' : 'none';
  });
});
// ---- target project selection ----
const tboxes = () => [...document.querySelectorAll('.tbox')];
function refreshCount() {
  const n = tboxes().filter((b) => b.checked).length;
  document.getElementById('tcount').textContent = n + '/' + tboxes().length;
}
document.getElementById('all').addEventListener('click', () => {
  // only the VISIBLE rows: with a project filter active, "select all"
  // must not silently target the filtered-away projects
  tboxes().forEach((b) => { b.checked = b.closest('.trow').style.display !== 'none'; });
  refreshCount();
});
document.getElementById('none').addEventListener('click', () => { tboxes().forEach((b) => { b.checked = false; }); refreshCount(); });
document.getElementById('tfilter').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#tlist .trow').forEach((r) => {
    r.style.display = !q || (r.dataset.name || '').includes(q) ? '' : 'none';
  });
});
document.getElementById('tlist').addEventListener('change', refreshCount);
refreshCount();
// ---- apply ----
document.getElementById('apply').addEventListener('click', () => {
  const checked = [...document.querySelectorAll('.syncbox')].filter((b) => b.checked);
  if (!checked.length) { setStatus(${jsonForScript(t('macroBatchNothingSelected'))}); return; }
  const targets = tboxes().filter((b) => b.checked).map((b) => b.dataset.root);
  if (!targets.length) { setStatus(${jsonForScript(t('macroBatchNoTargets'))}); return; }
  const panes = checked.map((b) => {
    const meta = PANE_META.find((p) => p.key === b.dataset.sync);
    return { key: meta.key, suffix: meta.suffix, cppOnly: meta.cppOnly, text: document.querySelector('[data-pane="' + meta.key + '"]').value };
  });
  vscode.postMessage({ command: 'applyMacros', panes: panes, addMissing: document.getElementById('addmissing').checked, skipReview: document.getElementById('skipreview').checked, targets: targets });
});
document.getElementById('undo').addEventListener('click', () => {
  vscode.postMessage({ command: 'undoMacros' });
});
window.addEventListener('message', (e) => {
  if (e.data.command === 'macroDone') setStatus(e.data.text);
});
function setStatus(text) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.style.opacity = '1';
}
</script>
</body></html>`;
  }
}
