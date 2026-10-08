/**
 * Sync Setting Across Projects — page version.
 *
 * A dedicated webview that looks like the Properties page: the left tree
 * groups every syncable compile switch (bool/enum options) by properties
 * page; each row carries a SYNC checkbox (default off) plus the option's
 * value control (checkbox / dropdown seeded from the active project).
 * Checked rows are applied to ALL loaded projects on Apply.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ProjectStore, MrsProject, msg } from './projects';
import { Cproject } from '../core/cproject';
import { FIELDS, PAGES, FieldDef, jsonForScript } from './configView';
import { t } from '../core/i18n';

interface SyncFieldRow {
  field: FieldDef;
  /** unique page key (configView page id) */
  page: string;
  /** full breadcrumb, e.g. "GNU RISC-V Cross C Compiler › Preprocessor" */
  crumb: string;
  /** display value seeded from the base project */
  value: string;
  cppOnly: boolean;
}

/** bool/enum option-backed fields only (compile switches) */
function syncableRows(base: MrsProject | undefined): SyncFieldRow[] {
  const pageInfo = new Map(PAGES.map((p) => [p.key, p]));
  const rows: SyncFieldRow[] = [];
  for (const f of FIELDS) {
    if (f.type !== 'bool' && f.type !== 'enum') continue;
    if (!f.suffix || f.get || f.set || f.tplKey) continue;
    const pg = pageInfo.get(f.page);
    const crumb = pg ? (pg.group ? `${pg.group} › ${pg.title}` : pg.title) : f.page;
    let value: string;
    if (f.type === 'enum') {
      const raw = base?.cproject.optionValue(f.suffix) ?? '';
      // unset enums seed 'default' — same as the properties page's readEnum
      // (seeding the first option made the Sync page display -Os etc. for
      // projects that never set the option, and Apply then wrote that
      // explicit value into all of them)
      value = f.enumBase && raw.startsWith(f.enumBase) ? raw.slice(f.enumBase.length) : raw || 'default';
    } else {
      value = base?.cproject.optionBool(f.suffix) ? '1' : '0';
    }
    rows.push({ field: f, page: f.page, crumb, value, cppOnly: f.suffix.startsWith('cpp.') });
  }
  return rows;
}

const STYLE = `
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; }
#head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-editorWidget-border); }
#head .title { font-weight: 600; }
#head .hint { color: var(--vscode-descriptionForeground); }
#head button { margin-left: auto; }
#main { flex: 1; display: flex; min-height: 0; }
#nav { width: 225px; flex: none; overflow: auto; border-right: 1px solid var(--vscode-editorWidget-border); padding: 6px 0; }
#nav summary { padding: 4px 10px; cursor: pointer; font-weight: 600; list-style: none; }
#nav summary::before { content: '▸ '; opacity: .6; }
#nav details[open] summary::before { content: '▾ '; }
#nav .nav-item { padding: 3px 10px 3px 24px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#nav .nav-item:hover { background: var(--vscode-list-hoverBackground); }
#nav .nav-item.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
#content { flex: 1; overflow: auto; padding: 10px 16px; }
.syncrow { display: flex; align-items: center; gap: 8px; padding: 4px 2px; border-bottom: 1px solid var(--vscode-editorWidget-border); }
.syncrow input[type=checkbox] { margin: 0; }
.syncrow .slabel { flex: 1; }
.pghead { font-weight: 600; margin: 2px 0 10px; }
.pghead .sub { color: var(--vscode-descriptionForeground); font-weight: 400; font-size: 11.5px; }
.syncrow.cpponly .slabel::after { content: ' (C++ only)'; color: var(--vscode-descriptionForeground); font-size: 11px; }
.syncrow select, .syncrow input[type=checkbox].valbox { width: 190px; flex: none; }
#bar { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--vscode-editorWidget-border); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 18px; cursor: pointer; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
#status { margin-left: auto; font-size: 12px; opacity: 0; transition: opacity .3s; }
`;

let syncCh: vscode.OutputChannel | undefined;
const syncChannel = (): vscode.OutputChannel => {
  if (!syncCh) syncCh = vscode.window.createOutputChannel('MRVC Sync Settings');
  return syncCh;
};

export class SyncPage {
  private panel: vscode.WebviewPanel | null = null;
  private store: ProjectStore;

  constructor(store: ProjectStore) {
    this.store = store;
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      this.panel.webview.html = this.render();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('mrvc.sync', 'Sync Setting Across Projects', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel.webview.html = this.render();
  }

  private async onMessage(m: { command: string; items?: Array<{ suffix: string; type: 'bool' | 'enum'; value: string; enumBase?: string }> }): Promise<void> {
    if (m.command !== 'applySync' || !Array.isArray(m.items) || !m.items.length) return;
    const projects = this.store.all;
    if (!projects.length) return;
    const ch = syncChannel();
    ch.appendLine(`\n===== Sync Setting Across Projects (${m.items.length} setting(s)) =====`);
    const start = Date.now();
    let okCount = 0;
    let failCount = 0;
    let skipCount = 0;
    let cancelled = false;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('syncingSettings', m.items.length), cancellable: true },
      async (progress, token) => {
        for (let i = 0; i < projects.length; i++) {
          const p = projects[i];
          progress.report({ message: `(${i + 1}/${projects.length}) ${p.projectName}` });
          // yield a MACRO task so Cancel clicks (IPC) are observed and the
          // progress notification repaints — Promise.resolve() would only
          // drain microtasks and never reach the event loop
          await new Promise((r) => setTimeout(r, 0));
          if (token.isCancellationRequested) {
            cancelled = true;
            break;
          }
          try {
            const cp = Cproject.load(p.root);
            let applied = 0;
            for (const item of m.items!) {
              if (item.suffix.startsWith('cpp.') && !cp.isCpp) {
                skipCount++;
                continue; // C project: C++-only option
              }
              if (item.type === 'bool') cp.setOptionBool(item.suffix, item.value === '1', true);
              else cp.setOptionValue(item.suffix, item.value === 'default' ? undefined : (item.enumBase ?? '') + item.value);
              applied++;
            }
            if (applied) cp.save();
            this.store.reloadProject(p);
            okCount++;
            ch.appendLine(`[OK] ${p.projectName}${applied < m.items!.length ? ` (${m.items!.length - applied} skipped: C project)` : ''}`);
          } catch (e) {
            failCount++;
            ch.appendLine(`[FAIL] ${p.projectName}  — ${msg(e)}`);
          }
        }
      }
    );
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    ch.appendLine(`===== Sync ${cancelled ? 'cancelled' : 'finished'}: ${okCount}/${projects.length} OK, ${failCount} failed${skipCount ? `, ${skipCount} skipped` : ''}, ${secs}s =====`);
    ch.show(true);
    this.panel?.webview.postMessage({
      command: 'syncDone',
      text: `${cancelled ? 'Cancelled' : 'Applied'}: ${okCount}/${projects.length} OK, ${failCount} failed${skipCount ? `, ${skipCount} skipped (C)` : ''} (${secs}s)`,
    });
  }

  private render(): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // nonce-gated scripts (same policy as the properties page)
    const nonce = crypto.randomBytes(16).toString('hex');
    const base = this.store.active ?? this.store.all[0];
    const rows = syncableRows(base);
    const cppCount = rows.filter((r) => r.cppOnly).length;

    // group by properties page (MRS2 order preserved); keyed by the unique
    // page id because several pages share a title ("Preprocessor" x3)
    const byPage = new Map<string, { crumb: string; rows: SyncFieldRow[] }>();
    for (const r of rows) {
      let entry = byPage.get(r.page);
      if (!entry) {
        entry = { crumb: r.crumb, rows: [] };
        byPage.set(r.page, entry);
      }
      entry.rows.push(r);
    }

    // two-level navigation like Properties: group (details) -> page item
    const groups = new Map<string, Array<{ key: string; title: string }>>();
    for (const [key, e] of byPage.entries()) {
      const group = e.crumb.includes(' › ') ? e.crumb.split(' › ')[0] : e.crumb;
      const title = e.crumb.includes(' › ') ? e.crumb.split(' › ').slice(1).join(' › ') : e.crumb;
      let arr = groups.get(group);
      if (!arr) {
        arr = [];
        groups.set(group, arr);
      }
      arr.push({ key, title });
    }
    const nav = [...groups.entries()]
      .map(([group, pages]) => {
        if (pages.length === 1 && pages[0].title === group) {
          return `<div class="nav-item" data-page="${esc(pages[0].key)}">${esc(group)}</div>`;
        }
        const items = pages.map((pg) => `<div class="nav-item" data-page="${esc(pg.key)}">${esc(pg.title)}</div>`).join('');
        return `<details open><summary>${esc(group)}</summary>${items}</details>`;
      })
      .join('');

    const content = [...byPage.entries()]
      .map(([key, e]) => {
        const rowsHtml = e.rows
          .map((r) => {
            let control: string;
            if (r.field.type === 'enum') {
              // expose the unset state as an explicit choice: selecting it
              // makes Apply leave the option unset (write path maps
              // 'default' to no value) instead of writing the first option
              const opts: Array<[string, string]> = [...(r.field.options ?? [])];
              if (r.value === 'default' && !opts.some(([v]) => v === 'default')) opts.unshift(['default', '(default)']);
              control = `<select class="valbox" data-val="${esc(r.field.key)}">${opts
                .map(([v, l]) => `<option value="${esc(v)}"${v === r.value ? ' selected' : ''}>${esc(l)}</option>`)
                .join('')}</select>`;
            } else {
              control = `<input type="checkbox" class="valbox" data-val="${esc(r.field.key)}"${r.value === '1' ? ' checked' : ''}>`;
            }
            return `<div class="syncrow${r.cppOnly ? ' cpponly' : ''}"><input type="checkbox" class="syncbox" data-sync="${esc(r.field.key)}"><span class="slabel">${esc(r.field.label)}</span>${control}</div>`;
          })
          .join('');
        const head = e.crumb.includes(' › ')
          ? `<div class="pghead">${esc(e.crumb.split(' › ')[0])} <span class="sub">› ${esc(e.crumb.split(' › ').slice(1).join(' › '))}</span></div>`
          : `<div class="pghead">${esc(e.crumb)}</div>`;
        return `<div class="page" data-page="${esc(key)}" style="display:none">${head}${rowsHtml}</div>`;
      })
      .join('');

    const meta = {
      projectCount: this.store.all.length,
      baseProject: base?.projectName ?? '',
      cppOnlyNote: cppCount ? `${cppCount} option(s) apply to C++ projects only` : '',
    };
    // field metadata for the collector: key -> {suffix, type, enumBase}
    const fieldMeta: Record<string, { suffix: string; type: string; enumBase?: string }> = {};
    for (const r of rows) {
      fieldMeta[r.field.key] = { suffix: r.field.suffix as string, type: r.field.type, enumBase: r.field.enumBase };
    }

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>${STYLE}</style></head><body>
<div id="head">
  <span class="title">Sync Setting Across Projects</span>
  <span class="hint">${meta.projectCount} project(s) will receive the checked values (values seeded from <b>${esc(meta.baseProject)}</b>)${meta.cppOnlyNote ? ' — ' + esc(meta.cppOnlyNote) : ''}</span>
  <button type="button" id="clear" class="secondary">Clear selections</button>
</div>
<div id="main">
  <div id="nav">${nav}</div>
  <div id="content">${content}</div>
</div>
<div id="bar">
  <button type="button" id="apply">Apply to All Projects</button>
  <span id="status"></span>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const FIELD_META = ${jsonForScript(fieldMeta)};
let currentPage = null;
function showPage(key) {
  currentPage = key;
  document.querySelectorAll('.page').forEach((p) => { p.style.display = p.dataset.page === key ? 'block' : 'none'; });
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('sel', n.dataset.page === key));
}
document.querySelectorAll('.nav-item').forEach((n) => n.addEventListener('click', () => showPage(n.dataset.page)));
const pages = document.querySelectorAll('.page');
if (pages.length) showPage(pages[0].dataset.page);
document.getElementById('clear').addEventListener('click', () => {
  document.querySelectorAll('.syncbox').forEach((b) => { b.checked = false; });
});
document.getElementById('apply').addEventListener('click', () => {
  const checked = [...document.querySelectorAll('.syncbox')].filter((b) => b.checked);
  if (!checked.length) { setStatus('Nothing selected — tick the checkboxes of the settings to sync.'); return; }
  const items = checked.map((b) => {
    const key = b.dataset.sync;
    const meta = FIELD_META[key];
    const valEl = document.querySelector('[data-val="' + key + '"]');
    return { suffix: meta.suffix, type: meta.type, enumBase: meta.enumBase, value: meta.type === 'bool' ? (valEl.checked ? '1' : '0') : valEl.value };
  });
  vscode.postMessage({ command: 'applySync', items });
});
function setStatus(text) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.style.opacity = '1';
}
window.addEventListener('message', (e) => {
  if (e.data.command === 'syncDone') setStatus(e.data.text);
});
</script>
</body></html>`;
  }
}
