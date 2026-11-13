/**
 * "Audit and Repair Project Configuration" command — walks the project with
 * core/audit's checks and offers the safe fixes through one modal. The
 * findings list is fully rendered BEFORE anything is written; the user sees
 * every problem and the exact repair, and only an explicit confirm writes.
 */
import * as vscode from 'vscode';
import { MrsProject, ProjectStore } from './projects';
import { auditProjectConfig, repairProjectConfig, AuditFinding } from '../core/audit';
import { t } from '../core/i18n';

function findingLine(f: AuditFinding): string {
  const text = t(`auditF_${f.code}` as never, f.detail);
  return `• [${f.file}] ${text}${f.fixable ? '' : '\n  ' + t('auditNotFixable')}`;
}

export async function auditRepairCmd(
  store: { active: MrsProject | null; setActive(project: MrsProject): void },
  item?: { project?: unknown }
): Promise<void> {
  const project = (item as { project?: MrsProject })?.project ?? store.active;
  if (!project) {
    vscode.window.showErrorMessage(t('noActiveProject'));
    return;
  }
  const { findings } = auditProjectConfig(project.root);
  if (!findings.length) {
    vscode.window.showInformationMessage(t('auditClean', project.projectName));
    return;
  }
  const fixable = findings.filter((f) => f.fixable).length;
  const detail = findings.map(findingLine).join('\n');
  const repairBtn = t('auditRepairBtn', fixable);
  const items: vscode.MessageItem[] = fixable > 0 ? [{ title: repairBtn }] : [];
  const pick = await vscode.window.showWarningMessage(
    t('auditFound', project.projectName, findings.length),
    { modal: true, detail },
    ...items
  );
  const confirmed = pick !== undefined && pick.title === repairBtn;
  if (!confirmed || fixable === 0) return;
  const { repairedFiles, backupDir } = repairProjectConfig(project.root, findings.filter((f) => f.fixable));
  project.reload();
  store.setActive(project);
  vscode.window.showInformationMessage(t('auditRepaired', repairedFiles.join(', '), backupDir), { modal: true });
}
