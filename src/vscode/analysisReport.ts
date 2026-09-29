/**
 * Show Static Stack Usage / Function Call Analysis — open the analysis
 * reports generated from the last build. Requires mrvc.build.analysis
 * (the build then emits -fstack-usage .su files and -fdump-rtl-expand
 * dumps into the build directory).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectStore, MrsProject } from './projects';
import { parseStackUsage, parseDumpCalls, stackReport, callReport } from '../core/analysis';

function activeOrPick(store: ProjectStore, node?: unknown): MrsProject | undefined {
  const proj = (node as { project?: MrsProject } | undefined)?.project;
  if (proj) return proj;
  return store.active ?? undefined;
}

function writeAndShow(buildDir: string, name: string, content: string): void {
  // containment: both report names are constants, but prove it anyway —
  // the write must stay inside the build directory
  const target = path.resolve(buildDir, name);
  const root = path.resolve(buildDir);
  if (target !== root && !target.startsWith(root + path.sep)) return;
  fs.writeFileSync(target, content, 'utf-8');
  void vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
}

function collectFiles(buildDir: string, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (test(e.name)) out.push(fs.readFileSync(p, 'utf-8'));
    }
  };
  walk(buildDir);
  return out;
}

export async function showStackUsageCmd(store: ProjectStore, node?: unknown): Promise<void> {
  const project = activeOrPick(store, node);
  if (!project) {
    vscode.window.showErrorMessage('MRVC: no active MRS project.');
    return;
  }
  const buildDir = project.buildDir;
  if (!fs.existsSync(buildDir)) {
    vscode.window.showInformationMessage(
      'MRVC: no build directory yet — build with "mrvc.build.analysis" enabled first.'
    );
    return;
  }
  const contents = collectFiles(buildDir, (n) => n.endsWith('.su'));
  if (!contents.length) {
    vscode.window.showInformationMessage(
      'MRVC: no .su files found — enable "mrvc.build.analysis" and rebuild.'
    );
    return;
  }
  const records = parseStackUsage(contents);
  if (!records.length) {
    vscode.window.showInformationMessage('MRVC: .su files found but no usable records.');
    return;
  }
  writeAndShow(buildDir, 'stack-usage.md', stackReport(records));
}

export async function showCallAnalysisCmd(store: ProjectStore, node?: unknown): Promise<void> {
  const project = activeOrPick(store, node);
  if (!project) {
    vscode.window.showErrorMessage('MRVC: no active MRS project.');
    return;
  }
  const buildDir = project.buildDir;
  if (!fs.existsSync(buildDir)) {
    vscode.window.showInformationMessage(
      'MRVC: no build directory yet — build with "mrvc.build.analysis" enabled first.'
    );
    return;
  }
  const dumps = collectFiles(buildDir, (n) => /\.c\.\d+r\.expand$/i.test(n));
  if (!dumps.length) {
    vscode.window.showInformationMessage(
      'MRVC: no expand dumps found — enable "mrvc.build.analysis" and rebuild.'
    );
    return;
  }
  const calls = dumps.flatMap((d) => parseDumpCalls(d));
  if (!calls.length) {
    vscode.window.showInformationMessage('MRVC: expand dumps found but no call edges extracted.');
    return;
  }
  writeAndShow(buildDir, 'call-analysis.md', callReport(calls));
}
