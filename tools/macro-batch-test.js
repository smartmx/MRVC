/*
 * Batch macro-definition editing tests: pure-Node core (parse / conflicts /
 * union / merge) plus an end-to-end apply over SCRATCH copies of the real
 * LED project — the batch write must never touch a real EVT tree.
 * Run: node tools/macro-batch-test.js
 */
const path = require('path');
const fs = require('fs');

const { parseMacroLines, macroListToText, macroNameConflicts, unionMacroLists, macroStats, mergeMacroList } = require('../out/core/macroDefs.js');
const { Cproject } = require('../out/core/cproject.js');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// ---------- 1. parseMacroLines (properties-page macroConflicts rules) ----------
{
  const r = parseMacroLines('DEBUG=0\r\nFOO\n  BAR = x=y  \n\n   \nQUOTED="a b"');
  check('parse: CRLF/blank/space-tolerant', r.length === 4);
  check('parse: NAME=VALUE split on FIRST =', r[0].name === 'DEBUG' && r[0].value === '0');
  check('parse: bare name -> empty value', r[1].name === 'FOO' && r[1].value === '');
  check('parse: value keeps inner/extra =', r[2].name === 'BAR' && r[2].value === 'x=y');
  check('parse: value keeps quotes verbatim', r[3].value === '"a b"');
  check('parse: empty text -> no tokens', parseMacroLines('').length === 0);
}

// ---------- 2. macroNameConflicts across panes ----------
{
  const c1 = macroNameConflicts([
    { label: 'C Compiler', text: 'DEBUG=0\nFOO' },
    { label: 'C++ Compiler', text: 'DEBUG=0\nBAR' },
    { label: 'Assembler', text: 'DEBUG=1' },
  ]);
  check('conflicts: cross-pane value deviation reported once', c1.length === 1 && c1[0].includes('DEBUG') && c1[0].includes('C Compiler') && c1[0].includes('Assembler'));
  const c2 = macroNameConflicts([
    { label: 'C', text: 'A=1' },
    { label: 'C++', text: 'A=1' },
  ]);
  check('conflicts: same value = none', c2.length === 0);
  const c3 = macroNameConflicts([
    { label: 'C', text: 'abc=1' },
    { label: 'C++', text: 'ABC=2' },
  ]);
  check('conflicts: case-sensitive names = none', c3.length === 0);
}

// ---------- 3. union + stats (initial page content) ----------
{
  const union = unionMacroLists([['DEBUG=0', 'BOARD=X'], ['DEBUG=1'], ['DEBUG=1', 'EXTRA']]);
  check('union: whole-string dedupe, first-seen order', JSON.stringify(union) === JSON.stringify(['DEBUG=0', 'BOARD=X', 'DEBUG=1', 'EXTRA']));
  const st = macroStats([['DEBUG=0'], ['DEBUG=1'], ['DEBUG=1']]);
  check('stats: 1 name, 1 divergent', st.names === 1 && st.divergent === 1);
  const st2 = macroStats([['A=1', 'B=2'], ['A=1', 'B=2']]);
  check('stats: agree everywhere -> 0 divergent', st2.names === 2 && st2.divergent === 0);
}

// ---------- 4. mergeMacroList (the write semantics) ----------
{
  // update in place, keep order, keep unmentioned
  const m1 = mergeMacroList(['DEBUG=0', 'PRIVATE', 'BOARD=X'], parseMacroLines('DEBUG=1\nBOARD=Y'), false);
  check('merge: in-place update, order kept', JSON.stringify(m1.list) === JSON.stringify(['DEBUG=1', 'PRIVATE', 'BOARD=Y']));
  check('merge: counts 2 updated', m1.updated === 2 && m1.added === 0);
  // no add: missing targets ignored
  const m2 = mergeMacroList(['DEBUG=0'], parseMacroLines('DEBUG=0\nNEW=1'), false);
  check('merge: addMissing off -> nothing appended', JSON.stringify(m2.list) === JSON.stringify(['DEBUG=0']) && m2.updated === 0 && m2.added === 0);
  // add on
  const m3 = mergeMacroList(['DEBUG=0'], parseMacroLines('DEBUG=0\nNEW=1\nBARE'), true);
  check('merge: addMissing on -> appended at tail (bare + valued)', JSON.stringify(m3.list) === JSON.stringify(['DEBUG=0', 'NEW=1', 'BARE']) && m3.added === 2);
  // bare <-> valued transition counts as an update
  const m4 = mergeMacroList(['FOO'], parseMacroLines('FOO=1'), false);
  check('merge: bare -> valued is an update', JSON.stringify(m4.list) === JSON.stringify(['FOO=1']) && m4.updated === 1);
  // identical content -> zero counts (page reports "nothing to change")
  const m5 = mergeMacroList(['DEBUG=0', 'X'], parseMacroLines('DEBUG=0'), false);
  check('merge: no-op content -> 0/0', m5.updated === 0 && m5.added === 0 && JSON.stringify(m5.list) === JSON.stringify(['DEBUG=0', 'X']));
  // duplicates in existing: every occurrence of the name is rewritten
  const m6 = mergeMacroList(['DEBUG=0', 'DEBUG=1'], parseMacroLines('DEBUG=2'), false);
  check('merge: duplicate names all rewritten', JSON.stringify(m6.list) === JSON.stringify(['DEBUG=2', 'DEBUG=2']) && m6.updated === 2);
}

// ---------- 5. end-to-end apply over SCRATCH copies ----------
const LED_PROJ = ['E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM/LED', 'F:/CH585/EVT/V1_2/EXAM/LED', 'E:/WORK/CH585/V1_7/EXAM/LED'].find((p) =>
  fs.existsSync(path.join(p, '.cproject'))
);
if (!LED_PROJ) {
  console.log('SKIP  5. end-to-end (no real LED tree found)');
} else {
  const WS = path.join(__dirname, '..', '.scratch', 'macro-batch');
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  const scratch1 = path.join(WS, 'p1');
  const scratch2 = path.join(WS, 'p2');
  fs.cpSync(LED_PROJ, scratch1, { recursive: true });
  fs.cpSync(LED_PROJ, scratch2, { recursive: true });

  // p1: real EVT baseline DEBUG=0 (the properties-page shape). Give p2 a
  // different DEBUG value and a private macro so both semantics are visible.
  const cp1 = Cproject.load(scratch1);
  const before1 = cp1.listOption('c.compiler.defs').values.slice();
  check('fixture: LED project defines DEBUG=0', before1.includes('DEBUG=0'));
  const cp2 = Cproject.load(scratch2);
  cp2.setOptionList('c.compiler.defs', [...before1, 'DEBUG=1', 'PRIVATE_MACRO']);
  cp2.save();
  cp2.reload ? cp2.reload() : void 0;

  // emulate the page's applyMacros host loop (the exact code path of
  // MacroBatchPage.onMessage, minus vscode progress)
  const applyBatch = (panes, addMissing) => {
    for (const root of [scratch1, scratch2]) {
      const cp = Cproject.load(root);
      let applied = 0;
      for (const pane of panes) {
        if (pane.cppOnly && !cp.isCpp) continue;
        const merged = mergeMacroList(cp.listOption(pane.suffix).values, parseMacroLines(pane.text), addMissing);
        if (!merged.updated && !merged.added) continue;
        cp.setOptionList(pane.suffix, merged.list);
        applied++;
      }
      if (applied) cp.save();
    }
  };

  // cross-project union (the same data the page's summary/stats build on)
  const unionText = unionMacroLists([Cproject.load(scratch1).listOption('c.compiler.defs').values, Cproject.load(scratch2).listOption('c.compiler.defs').values]).join('\n');
  check('union: shows both DEBUG values as parallel entries', unionText.includes('DEBUG=0') && unionText.includes('DEBUG=1'));

  // apply: unify DEBUG to 1, add a new macro — WITHOUT addMissing
  applyBatch([{ key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'DEBUG=1\nNEW_MACRO=42\n' + unionText.split('\n').filter((l) => l && !l.startsWith('DEBUG=') && l !== 'NEW_MACRO=42').join('\n') }], false);
  const after1 = Cproject.load(scratch1).listOption('c.compiler.defs').values;
  const after2 = Cproject.load(scratch2).listOption('c.compiler.defs').values;
  check('e2e: p1 DEBUG updated in place (add off)', after1.includes('DEBUG=1') && !after1.includes('DEBUG=0'));
  check('e2e: p1 NEW_MACRO NOT added (add off)', !after1.includes('NEW_MACRO=42'));
  check('e2e: p2 DEBUG entries unified (fixture carried both spellings)', after2.some((v) => v === 'DEBUG=1') && !after2.includes('DEBUG=0') && after2.every((v) => v !== 'DEBUG=0'));
  check('e2e: p2 private macro survives (never delete)', after2.includes('PRIVATE_MACRO'));

  // apply with addMissing: NEW_MACRO lands everywhere, private still kept
  applyBatch([{ key: 'defs', suffix: 'c.compiler.defs', cppOnly: false, text: 'DEBUG=1\nNEW_MACRO=42' }], true);
  const after3 = Cproject.load(scratch1).listOption('c.compiler.defs').values;
  const after4 = Cproject.load(scratch2).listOption('c.compiler.defs').values;
  check('e2e: addMissing appends NEW_MACRO to p1', after3.includes('NEW_MACRO=42'));
  check('e2e: addMissing appends NEW_MACRO to p2 (deduped)', after4.includes('NEW_MACRO=42') && after4.filter((v) => v === 'NEW_MACRO=42').length === 1);
  check('e2e: unmentioned macros untouched by second apply', after4.includes('PRIVATE_MACRO') && after3.includes('BOARD=X') === after1.includes('BOARD=X'));

  // C++ pane on a C project: skipped (LED has no cxx nature)
  const isCpp1 = Cproject.load(scratch1).isCpp;
  applyBatch([{ key: 'cppdefs', suffix: 'cpp.compiler.defs', cppOnly: true, text: 'SHOULD_NOT_LAND=1' }], true);
  check('e2e: C project skips the C++ pane', !isCpp1 && !Cproject.load(scratch1).listOption('cpp.compiler.defs').values.includes('SHOULD_NOT_LAND=1'));

  // roundtrip through the properties-page model: reload + setOptionList shape
  // (attribute values escape their quotes as &quot;)
  const raw = fs.readFileSync(path.join(scratch1, '.cproject'), 'utf-8');
  check('e2e: stored as quoted listOptionValue (CDT shape)', raw.includes('&quot;DEBUG=1&quot;') && raw.includes('&quot;NEW_MACRO=42&quot;'));

  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURES` : '\nall macro batch tests passed');
process.exit(failures ? 1 : 0);
