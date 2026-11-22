/**
 * Scoped text search from the project tree (0.3.3, user request): right-click
 * a project or a folder → open the workbench Search view with "files to
 * include" already limited to that directory. VSCode's own search stays the
 * engine — MRVC only pre-scopes it, so regex/case/replace and the results
 * panel behave exactly like a manual search with the include box filled.
 *
 * No `query` and no `triggerSearch` are passed: an empty query with
 * triggerSearch would sweep the whole scope, so the user simply types into
 * the (focused) query box and presses Enter.
 *
 * 0.3.6 adds the tree title-bar "Search in All Projects": every loaded
 * project's scope (root + linked folders) flattened into one include list
 * (allProjectsScope).
 */
import * as path from 'path';
import * as vscode from 'vscode';

/** make one filesystem path survive the REAL VS Code search pipeline
 *  (verified against the installed Insiders workbench bundle, round56 P2):
 *
 *  1. QueryBuilder.handleIncludeExclude runs Oyi: every backslash becomes
 *     a forward slash — so we emit forward slashes ourselves and backslash
 *     "escapes" are dead on arrival (they would only mangle the path);
 *  2. the include string is split on commas by a GLOB-AWARE splitter that
 *     leaves commas inside `[…]` or `{…}` alone — so a literal comma in a
 *     path is written as the character class `[,]`;
 *  3. entries containing glob metacharacters are parsed as GLOBS — `* ? [ ]
 *     ( ) { }` in a path are written as character classes (`[*]`, `[?]`,
 *     `[[]`, `[]]`, `[(]`, `[)]`, `[{]`, `[}]`), the exact idiom VS Code
 *     itself uses to turn literal fsPaths into glob-safe patterns
 *     (QueryBuilder's own Kwo wraps `[?*[\]]` in brackets); the glob
 *     compiler implements the POSIX `[]]` = literal `]` rule, and `!` needs
 *     no treatment (it is only special as the FIRST char of a class, which
 *     our insertions never produce).
 *
 *  Plain paths are byte-identical to the previous behavior (nothing to
 *  escape — class inserts only touch metacharacters). */
export function escapeIncludeEntry(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/([*?[\](){}])/g, '[$1]')
    .replace(/,/g, '[,]');
}

/** open the Search view scoped to these directories (the include box takes a
 *  comma-separated list — one entry per project root plus each linked
 *  folder's resolved physical directory). Every entry is escaped first:
 *  commas would split the list mid-path and glob metacharacters would turn
 *  a literal directory into a pattern. */
export function searchInScope(roots: string[]): void {
  void vscode.commands.executeCommand('workbench.action.findInFiles', {
    filesToInclude: roots.map(escapeIncludeEntry).join(','),
  });
}

/** the tree item a context-menu command receives: project nodes carry
 *  { project }, folder/file nodes carry { fsPath } */
export interface SearchItem {
  project?: { root?: unknown };
  fsPath?: unknown;
}

/** the directory a FOLDER-node search must be scoped to: its own path; with
 *  no item (command palette) the active project's root is used. Undefined =
 *  nothing to scope to. */
export function searchRootFrom(item: SearchItem | undefined, activeRoot: string | undefined): string | undefined {
  const fsPath = item?.fsPath;
  if (typeof fsPath === 'string' && fsPath) return fsPath;
  return activeRoot;
}

/** dedupe key for scope entries (Windows: case- and slash-folded) — shared
 *  by projectSearchScope and allProjectsScope so neither can drift */
const normKey = (p: string) =>
  process.platform === 'win32' ? p.replace(/\//g, path.sep).toLowerCase() : path.normalize(p);

/** MRS projects span MORE than their root: linked folders (the blue tree
 *  entries — HAL/LIB/StdPeriphDriver-style trees kept outside the project
 *  directory) are part of the project's sources. The project search scope is
 *  therefore the root FIRST, then every linked folder's resolved physical
 *  directory, deduped, with anything already inside the root (or a duplicate
 *  of an earlier entry) dropped — the include box is a flat list and double
 *  entries would only bloat it. */
export function projectSearchScope(root: string, linkedDirs: Iterable<string>): string[] {
  const rootN = normKey(root);
  const covered = (p: string) => {
    const pN = normKey(p);
    return pN === rootN || pN.startsWith(rootN + path.sep);
  };
  const out = [root];
  for (const dir of linkedDirs) {
    if (!dir) continue;
    if (covered(dir)) continue;
    if (out.some((r) => normKey(r) === normKey(dir))) continue;
    out.push(dir);
  }
  return out;
}

/** The include list for a search across ALL loaded projects (0.3.6, tree
 *  title-bar menu): every project's own scope flattened, entries already
 *  covered by an EARLIER entry dropped (a project nested inside another
 *  project's root, two links resolving to the same directory) — the include
 *  box is a comma list and redundant globs only slow the search down. */
export function allProjectsScope(projects: Array<{ root: string; linkedDirs: Iterable<string> }>): string[] {
  const out: string[] = [];
  const coveredBy = (dir: string): boolean =>
    out.some((r) => {
      const rN = normKey(r);
      const dN = normKey(dir);
      return dN === rN || dN.startsWith(rN + path.sep);
    });
  for (const proj of projects) {
    for (const dir of projectSearchScope(proj.root, proj.linkedDirs)) {
      if (!coveredBy(dir)) out.push(dir);
    }
  }
  return out;
}
