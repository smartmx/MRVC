/**
 * Go-to-Definition provider for `mrvc-qingke` (.s/.S) assembly files
 * (0.3.8). Bridges cpptools' workspace symbols (`vscode.
 * executeWorkspaceSymbolProvider` over the .BROWSE.VC.DB cpptools already
 * built — no self-made C parser) with MRVC's own project ownership,
 * linker scripts (.ld), include paths, local labels (incl. GAS `1b`/`1f`)
 * and sibling assembly files.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ASM_LANGUAGE_ID } from './asmAssociations';
import { MrsProject, ProjectStore } from './projects';
import { foldPathOnPlatform } from '../core/cproject';
import { convertLogicToFullPath } from '../core/macros';
import { intellisenseArgs } from '../core/flags';
import { scanSources } from '../core/scan';
import {
  extractAsmCursorTarget,
  findLocalAsmDefinitions,
  findLinkerScriptSymbol,
  isInBlockComment,
  resolveIncludeFile,
  rankWorkspaceSymbolCandidates,
  WorkspaceSymbolCandidate,
} from '../core/asmNav';

/**
 * Locate the MRS project that owns `fsPath`. Ownership uses the CHEAP
 * `logicPathOf` check (path arithmetic + the linkedResources list) per
 * project — scanning EVERY project's full source tree on every F12 would
 * cost tens of milliseconds each on an EVT-sized workspace; only the owner
 * gets the one real scanSources walk (for the sibling-assembly list and the
 * project file set). A SHARED file (EVT trees link the SAME Startup/*.S into
 * dozens of examples) may match several projects — the ACTIVE one wins, so
 * F12 in project B resolves with B's file set, linker script and includes
 * and never lands on the first-registered sibling's SystemInit (review P2).
 */
function findOwningProject(store: ProjectStore, fsPath: string): { proj: MrsProject | null; files: Set<string>; asmFiles: string[] } {
  const matches: MrsProject[] = [];
  for (const p of store.all) {
    try {
      if (p.logicPathOf(fsPath)) {
        matches.push(p);
      }
    } catch {
      // an unreadable .project must not kill navigation
    }
  }
  const active = store.active;
  const owner = matches.find((p) => p === active) ?? matches[0] ?? active ?? store.all[0] ?? null;
  if (!owner) return { proj: null, files: new Set(), asmFiles: [] };
  const files = new Set<string>();
  const asmFiles: string[] = [];
  try {
    const map = scanSources(owner.cproject, { includeExcluded: true });
    for (const list of map.values()) {
      for (const f of list) {
        const abs = path.resolve(f.fullpath);
        files.add(foldPathOnPlatform(abs));
        if (/\.[sS]$/.test(abs)) asmFiles.push(abs);
      }
    }
  } catch {
    // a stale linked folder (ScanError) must degrade navigation gracefully —
    // workspace symbols, .ld and include resolution still work
  }
  return { proj: owner, files, asmFiles };
}

/** Collect existing linker script paths configured on the project's active
 * configuration (`c/cpp.linker.scriptfile`, the same chain the makefile
 * builder resolves: list values → linked-folder logic paths → on-disk) */
function projectLinkerScripts(proj: MrsProject): string[] {
  const cp = proj.cproject;
  const key = cp.isCpp ? 'cpp.linker.scriptfile' : 'c.linker.scriptfile';
  const linked = cp.linkedFolders ?? new Map<string, string>();
  const out: string[] = [];
  for (const raw of cp.listOption(key).values) {
    const unquoted = raw.replace(/^"(.*)"$/, '$1').trim();
    const abs = convertLogicToFullPath(cp.projectRoot, cp.projectName, unquoted, linked);
    if (abs && fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

/** Collect assembler + C/C++ include search directories for `#include` /
 * `.include` lookup (intellisenseArgs emits `-I<path>` / `-isystem<path>`
 * attached — same args cpptools receives). A C++-converted project mirrors
 * the makefile/intellisense families (asm + cpp + c). */
function projectIncludeDirs(proj: MrsProject): string[] {
  const dirs = new Set<string>();
  const kinds = proj.cproject.isCpp ? (['asm', 'cpp', 'c'] as const) : (['asm', 'c'] as const);
  for (const kind of kinds) {
    for (const a of intellisenseArgs(proj.cproject, kind)) {
      if (a.startsWith('-I') && a.length > 2) dirs.add(a.slice(2));
      else if (a.startsWith('-isystem') && a.length > 8) dirs.add(a.slice(8));
    }
  }
  return [...dirs];
}

/**
 * Register Go-to-Definition for `mrvc-qingke` assembly documents.
 * `ensureWorkspaceInit` is what the provider AWITS on the first F12 of an
 * empty store — the extension passes a DISCOVERY-ONLY closure
 * (`store.discoverInWorkspace()`): the heavy IntelliSense/database chain
 * stays behind the view-click memo and must never block an F12.
 */
export function registerAsmNavigation(store: ProjectStore, ensureWorkspaceInit?: () => Promise<void>): vscode.Disposable {
  const provider: vscode.DefinitionProvider = {
    async provideDefinition(document, position, token) {
      if (document.uri.scheme !== 'file') return null;
      const docText = document.getText();
      // multi-line /* */ banners (WCH startup headers) must not fire
      // workspace-symbol queries for words inside them (review M3)
      if (isInBlockComment(docText, document.offsetAt(position))) return null;
      const target = extractAsmCursorTarget(document.lineAt(position.line).text, position.character);
      if (!target) return null;

      // the workspace may never have been discovered (lazy activation via
      // onLanguage, the user opened the .S straight away): ownership, .ld
      // and include resolution mean NOTHING on an empty store, so the first
      // F12 AWAITS the lightweight discovery walk (NOT the heavy
      // ensureIntellisenseConfig chain) and then re-checks cancellation
      // (review M1); later queries with a warm store take the fast path
      if (!store.all.length && ensureWorkspaceInit) {
        try {
          await ensureWorkspaceInit();
        } catch {
          // a failed discovery degrades this query (workspace symbols and
          // local labels still work); the next try reruns it
        }
        if (token.isCancellationRequested) return null;
      }

      const fsPath = document.uri.fsPath;
      const { proj, files, asmFiles } = findOwningProject(store, fsPath);

      if (target.kind === 'include') {
        const incDirs = proj ? projectIncludeDirs(proj) : [];
        const resolved = resolveIncludeFile(target.spec, fsPath, incDirs);
        return resolved ? new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0)) : null;
      }

      const localHits = findLocalAsmDefinitions(document.getText(), target, position.line, position.character);
      if (target.kind === 'numeric-label') {
        return localHits.map((h) => new vscode.Location(document.uri, new vscode.Position(h.line, h.col)));
      }

      const locations: vscode.Location[] = [];

      const rawSymbols =
        (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          target.name
        )) ?? [];
      if (token.isCancellationRequested) return null;

      const candidates: WorkspaceSymbolCandidate[] = rawSymbols
        .filter((s) => s.location?.uri.scheme === 'file')
        .map((s) => ({
          name: s.name,
          file: s.location.uri.fsPath,
          line: s.location.range.start.line,
          col: s.location.range.start.character,
          kindTag:
            s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method
              ? 'function'
              : s.kind === vscode.SymbolKind.Variable || s.kind === vscode.SymbolKind.Constant
                ? 'variable'
                : 'other',
        }));

      const ranked = rankWorkspaceSymbolCandidates(candidates, target.name, {
        currentFile: fsPath,
        currentLine: position.line,
        projectFiles: files,
        projectRoot: proj?.root,
      });
      for (const r of ranked) {
        locations.push(new vscode.Location(vscode.Uri.file(r.file), new vscode.Position(r.line, r.col)));
      }

      if (proj) {
        for (const ld of projectLinkerScripts(proj)) {
          const hit = findLinkerScriptSymbol(ld, target.name);
          if (hit) locations.push(new vscode.Location(vscode.Uri.file(hit.file), new vscode.Position(hit.line, hit.col)));
        }
      }

      for (const h of localHits) {
        locations.push(new vscode.Location(document.uri, new vscode.Position(h.line, h.col)));
      }

      const curKey = foldPathOnPlatform(path.resolve(fsPath));
      for (const otherAsm of asmFiles) {
        if (foldPathOnPlatform(otherAsm) === curKey) continue;
        try {
          const txt = fs.readFileSync(otherAsm, 'utf-8');
          for (const h of findLocalAsmDefinitions(txt, target, -1)) {
            locations.push(new vscode.Location(vscode.Uri.file(otherAsm), new vscode.Position(h.line, h.col)));
          }
        } catch {
          // ignore unreadable sibling assembly file
        }
      }

      return locations.length ? locations : null;
    },
  };

  return vscode.languages.registerDefinitionProvider({ language: ASM_LANGUAGE_ID, scheme: 'file' }, provider);
}
