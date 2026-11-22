/*
 * Scoped search from the project tree (0.3.3, user request): right-click a
 * project / folder → open the workbench Search view with "files to include"
 * pre-set. MRVC only pre-scopes VSCode's own search — the command is
 * workbench.action.findInFiles with filesToInclude and NO query and NO
 * triggerSearch (an empty query with triggerSearch would sweep the whole
 * scope).
 *
 * A PROJECT spans its root AND its linked folders (EVT trees keep HAL/LIB/
 * StdPeriphDriver-style trees outside the project directory as links) — the
 * scope list is root first, then each linked folder's resolved physical
 * directory, deduped, with anything already inside the root dropped.
 * Pure Node with the vscode module stubbed.
 */
const Module = require('module');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const calls = [];
const vscodeStub = {
  commands: {
    executeCommand: async (id, args) => {
      calls.push({ id, args });
      return undefined;
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.apply(this, arguments);
};

try {
  const { searchInScope, searchRootFrom, projectSearchScope } = require('../out/vscode/search.js');

  // 1. searchInScope opens findInFiles with the include list
  calls.length = 0;
  searchInScope(['C:/work/Demo']);
  check('search: opens the workbench findInFiles command', calls.length === 1 && calls[0].id === 'workbench.action.findInFiles');
  check('search: filesToInclude is the given directory', calls[0].args.filesToInclude === 'C:/work/Demo');

  // 2. no query and no triggerSearch — an empty query must never sweep the scope
  check('search: no query is passed (the user types it)', !('query' in calls[0].args));
  check('search: no triggerSearch is passed', !('triggerSearch' in calls[0].args));

  // 3. project scope = root + linked folders, deduped, root-covered dropped
  const scope = projectSearchScope('C:\\work\\Demo', [
    'C:\\work\\LIB\\HAL',
    'C:\\work\\Demo\\inc', // inside the root — the root already covers it
    'C:\\work\\LIB\\HAL', // exact duplicate of an earlier entry
    '',
    'E:\\shared\\StdPeriphDriver',
  ]);
  check(
    'scope: root first, linked dirs appended, root-covered and duplicates dropped',
    JSON.stringify(scope) === JSON.stringify(['C:\\work\\Demo', 'C:\\work\\LIB\\HAL', 'E:\\shared\\StdPeriphDriver'])
  );
  const joined = searchInScope(projectSearchScope('C:\\work\\Demo', ['C:\\work\\LIB\\HAL']));
  check('scope: the include list is comma-joined (the box accepts several paths)', calls[calls.length - 1].args.filesToInclude === 'C:/work/Demo,C:/work/LIB/HAL');
  check('scope: no links -> exactly the root', JSON.stringify(projectSearchScope('C:\\r', [])) === JSON.stringify(['C:\\r']));

  // 4. folder node → its own path (wins over the active project)
  const folderItem = { fsPath: 'C:/work/Demo/Core' };
  check('search: a folder node resolves to its own path', searchRootFrom(folderItem, 'C:/work/Demo') === 'C:/work/Demo/Core');

  // 5. no item (command palette) → the active project's root
  check('search: no item falls back to the active project root', searchRootFrom(undefined, 'C:/work/Demo') === 'C:/work/Demo');

  // 6. nothing to scope to → undefined (the caller reports it)
  check('search: no item and no active project -> undefined', searchRootFrom(undefined, undefined) === undefined);
  check('search: junk item fields are ignored', searchRootFrom({ fsPath: 7 }, undefined) === undefined);

  // 7. round56 P2: the escaping must survive the REAL VS Code pipeline.
  // Verified against the installed Insiders workbench bundle:
  //  1. handleIncludeExclude runs Oyi FIRST: backslashes -> forward slashes
  //     (so backslash escapes are dead on arrival, and we emit slashes);
  //  2. Zts/XR splits the include string on commas with a GLOB-AWARE
  //     splitter: commas inside `[…]` / `{…}` are NOT split points;
  //  3. entries with glob metacharacters are parsed as globs (Xts splits
  //     at the first metachar into folder + pattern), and VS Code's own
  //     QueryBuilder (Kwo) turns literal fsPaths glob-safe by wrapping
  //     [?*[\]] in character classes — the same idiom we emit; the glob
  //     compiler implements POSIX `[]]` = literal `]`.
  // The test reimplements the pipeline steps and asserts that after
  // normalize -> split -> de-class, every scope path comes back WHOLE.
  const { escapeIncludeEntry } = require('../out/vscode/search.js');
  // Oyi (extracted verbatim from the bundle: replace backslashes)
  const oyi = (s) => s.replace(/\\/g, '/');
  // XR (extracted verbatim from the bundle: brace/bracket-aware comma split)
  const xr = (s, token) => {
    if (!s) return [];
    const out = [];
    let inBrace = false;
    let inBracket = false;
    let cur = '';
    for (const ch of s) {
      if (ch === token && !inBrace && !inBracket) {
        out.push(cur);
        cur = '';
        continue;
      }
      if (ch === '{') inBrace = true;
      else if (ch === '}') inBrace = false;
      else if (ch === '[') inBracket = true;
      else if (ch === ']') inBracket = false;
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  // the glob compiler's class semantics: [x] -> x, POSIX []] -> ] (both
  // traced through the bundle's Qpo: a `]` as the FIRST class char becomes
  // a member, so `[]]` is a one-char class of `]`)
  const deClass = (s) =>
    s
      .replace(/\[\]\]/g, ']')
      .replace(/\[([^\]]*)\]/g, '$1');
  const pipelineSegments = (joined) => xr(oyi(joined), ',');
  const CASES = [
    ['C:\\work\\Demo', 'plain path'],
    ['C:\\EVT\\A,B', 'comma in path'],
    ['C:\\EVT\\LIB[1]', 'brackets in path'],
    ['C:\\EVT\\A{B}C', 'braces in path'],
    ['C:\\EVT\\A*B?C', 'star/question in path'],
    ['C:\\EVT\\A(x)B', 'parens in path'],
    ['C:\\EVT\\A!B', 'exclamation in path'],
    ['E:\\shared\\StdPeriphDriver', 'real linked-dir style'],
  ];
  for (const [p, label] of CASES) {
    const segments = pipelineSegments(escapeIncludeEntry(p));
    check(`pipeline: ${label} survives normalize->split as ONE segment`, segments.length === 1, JSON.stringify(segments));
    check(`pipeline: ${label} de-globs back to the original path`, deClass(segments[0]) === oyi(p), `${segments[0]} vs ${oyi(p)}`);
  }
  // several scopes joined: every path stays its own segment (no mid-path split)
  const joinedScopes = escapeIncludeEntry('C:\\EVT\\A,B') + ',' + escapeIncludeEntry('C:\\EVT\\LIB[1]') + ',' + escapeIncludeEntry('E:\\shared\\StdPeriphDriver');
  const joinedSegments = pipelineSegments(joinedScopes);
  check('pipeline: a 3-scope join produces exactly 3 segments', joinedSegments.length === 3, JSON.stringify(joinedSegments));
  check(
    'pipeline: every joined scope de-globs to its original path',
    joinedSegments.map(deClass).join('|') === ['C:/EVT/A,B', 'C:/EVT/LIB[1]', 'E:/shared/StdPeriphDriver'].join('|'),
    joinedSegments.map(deClass).join('|')
  );
  // plain paths keep the old behavior byte-for-byte (no class inserts)
  check('escape: plain path untouched', escapeIncludeEntry('C:\\work\\Demo') === 'C:/work/Demo');
  const specialScope = searchInScope(projectSearchScope('C:\\EVT\\A,B', ['C:\\EVT\\LIB[1]']));
  check('escape: searchInScope emits forward slashes + class forms joined by bare commas', calls[calls.length - 1].args.filesToInclude === 'C:/EVT/A[,]B,C:/EVT/LIB[[]1[]]');
  void specialScope;

  // 8. round54 P3-1/P3-2 wiring: palette fallback + linkedFolder menu entry
  const fs = require('fs');
  const nodePath = require('path');
  const extSrc = fs.readFileSync(nodePath.join(__dirname, '..', 'out', 'extension.js'), 'utf-8');
  check('wiring: searchInFolder falls back to the active project root (not undefined)', /searchRootFrom\([^)]*store\.active/.test(extSrc) && !extSrc.includes('searchRootFrom(item, undefined)'));
  const pkg = JSON.parse(fs.readFileSync(nodePath.join(__dirname, '..', 'package.json'), 'utf-8'));
  const sf = pkg.contributes.menus['view/item/context'].find((m) => m.command === 'mrvc.searchInFolder');
  check('wiring: Search in Folder also covers linkedFolder nodes', !!sf && sf.when.includes('viewItem == linkedFolder'));
  // round55 P3: no item AND no active project must ERROR, not die silently
  {
    // the DEFINITION also matches 'searchRootFrom(item' — take the call site
    const i = extSrc.indexOf('searchRootFrom(item, (_a');
    const body = extSrc.slice(i, i + 400);
    check('wiring: searchInFolder errors when nothing can be scoped', body.includes('showErrorMessage'));
  }

  // 9. allProjectsScope (0.3.6, tree title-bar menu): every loaded project's
  //    scope flattened; entries covered by an EARLIER entry dropped (nested
  //    project roots, duplicate project roots, the same link in two projects)
  const { allProjectsScope } = require('../out/vscode/search.js');
  const all = allProjectsScope([
    { root: 'C:\\work\\Demo', linkedDirs: ['C:\\work\\LIB\\HAL'] },
    { root: 'C:\\work\\Demo', linkedDirs: [] }, // duplicate project root
    { root: 'C:\\work\\Demo\\Sub', linkedDirs: [] }, // nested inside Demo
    { root: 'E:\\proj\\B', linkedDirs: ['C:\\work\\LIB\\HAL', 'E:\\shared\\STD'] }, // HAL seen already
  ]);
  check(
    'all: Demo root, HAL, B root, STD — covered entries dropped',
    JSON.stringify(all) === JSON.stringify(['C:\\work\\Demo', 'C:\\work\\LIB\\HAL', 'E:\\proj\\B', 'E:\\shared\\STD']),
    JSON.stringify(all)
  );
  const folded = allProjectsScope([
    { root: 'C:\\work\\Demo', linkedDirs: [] },
    { root: 'c:\\WORK\\DEMO', linkedDirs: [] }, // case/slash spelling of the same root
  ]);
  const wantFolded = process.platform === 'win32' ? 1 : 2;
  check(`all: duplicate roots fold on win32 (got ${folded.length})`, folded.length === wantFolded);
  const empty = allProjectsScope([]);
  check('all: no projects -> empty list (caller reports)', empty.length === 0);

  // 10. wiring: the title-bar command exists, is gated on hasProjects and
  //     goes through the shared flattener
  const cmdAll = pkg.contributes.commands.find((c) => c.command === 'mrvc.searchInAllProjects');
  check('wiring: searchInAllProjects command registered', !!cmdAll);
  const menuAll = pkg.contributes.menus['view/title'].find((m) => m.command === 'mrvc.searchInAllProjects');
  check(
    'wiring: title-bar entry gated on mrvc.hasProjects in its own group',
    !!menuAll && menuAll.when.includes('mrvc.hasProjects') && menuAll.group.startsWith('3_search'),
    JSON.stringify(menuAll)
  );
  check('wiring: the bundle flattens through allProjectsScope', extSrc.includes('allProjectsScope('));
  check('wiring: empty store errors instead of searching nothing', /searchInAllProjects[\s\S]{0,600}showErrorMessage\(t\(["']noProjectsLoaded["']\)\)/.test(extSrc));

  // 11. built-in keybindings (0.3.6): F7/Shift+F7/F8 + Ctrl+H are gated on
  //     `mrvc.hasActiveProject` ONLY — global once the extension is
  //     activated with an active project (user ruling 2026-11-21 after the
  //     view-focus experiments: a `<viewId>.focus` context key does NOT
  //     exist — it is a command id — and the workbench-own `focusedView`
  //     gate did not fire on the real machine either, so the whole
  //     focus-scoping idea was dropped; Ctrl+H intentionally SHADOWS the
  //     editor's native find/replace while a project is active).
  const kbs = pkg.contributes.keybindings ?? [];
  check('keybindings: four built-in keys', kbs.length === 4, JSON.stringify(kbs));
  const kbByKey = Object.fromEntries(kbs.map((k) => [k.key, k]));
  check('keybindings: ctrl+h opens Search in Project', kbByKey['ctrl+h']?.command === 'mrvc.searchInProject');
  for (const kb of kbs) {
    check(
      `keybindings: ${kb.key} -> ${kb.command} gated on mrvc.hasActiveProject only`,
      kb.when === 'mrvc.hasActiveProject',
      kb.when
    );
  }
} finally {
  Module._load = originalLoad;
}

console.log(failures ? `\n${failures} FAILURES` : '\nall search tests passed');
process.exit(failures ? 1 : 0);
