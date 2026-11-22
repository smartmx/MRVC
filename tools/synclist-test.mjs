/*
 * Pins the release-sync list lessons (tools/sync-to-mrvc.mjs FILES): files
 * that once caused a failed dry-run or an unreproducible release are
 * asserted here, so dropping them from FILES fails a suite instead of a
 * release day.
 *
 *   - src/vscode/exclude.ts + src/vscode/logicPath.ts (0.3.5 round1 P2: the
 *     dry gate caught exclude.ts missing on its first-ever change)
 *   - src/core/output.ts + tools/output-test.js (0.3.6: output.ts was an
 *     old file whose first change came years after the list was written)
 *   - tsconfig.json (0.3.6 round1 P2: esbuild reads it from the working
 *     directory — without it a clean MRVC checkout builds a DIFFERENT
 *     bundle and verify-vsix's byte-equality check fails; it stays out of
 *     the VSIX itself via .vscodeignore)
 *
 * Run: node tools/synclist-test.mjs
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'sync-to-mrvc.mjs'), 'utf8');
let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail === undefined ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

// every file that was once missing from the payload list
for (const f of [
  'tsconfig.json',
  'src/vscode/exclude.ts',
  'src/vscode/logicPath.ts',
  'src/core/output.ts',
  'tools/output-test.js',
]) {
  check(`FILES carries ${f}`, src.includes(`'${f}'`));
}
check('DEVELOP_ONLY only holds the sync tool itself', src.includes("const DEVELOP_ONLY = new Set(['tools/sync-to-mrvc.mjs']);"));

// guard 1 in test form: every FILES entry exists in develop — a renamed or
// deleted file must update the list, and a suite failure is cheaper to see
// than a release-day dry-run refusal
const list = src.match(/const FILES = \[([\s\S]*?)\];/);
// strip line comments first — apostrophes in comment prose must not open a
// "string" for the extractor
const entriesSrc = list ? list[1].replace(/\/\/[^\n]*/g, '') : '';
const entries = [...entriesSrc.matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('FILES block was found', entries.length > 100, String(entries.length));
const missing = entries.filter((rel) => !fs.existsSync(path.join(here, '..', rel)));
check(`all ${entries.length} FILES entries exist in develop`, missing.length === 0, JSON.stringify(missing));

// tsconfig must never enter the VSIX (source-repo-only config)
check('.vscodeignore excludes **/tsconfig.json', fs.readFileSync(path.join(here, '..', '.vscodeignore'), 'utf8').includes('**/tsconfig.json'));

// round10 P3 / round11 P3: the two repo variants' .gitignore files must
// BOTH ignore the build-output directories (out/ and the MCP server's mcp/)
// — a synced/rebuilt MRVC tree must never show ?? mcp/mcp-server.js.
// Portability (round11 P3): the release checkout may live in ANY sibling
// directory name — the variant is recognized by CONTENT (!mrvc-*.vsix
// re-include vs plain *.vsix), never by the folder name, and a missing
// sibling checkout skips the variant checks instead of crashing.
{
  const devGi = fs.readFileSync(path.join(here, '..', '.gitignore'), 'utf8');
  // the CURRENT checkout (develop or the synced MRVC — this test ships to
  // both) must ignore the extension bundle output; mcp/ is variant-aware:
  // develop ignores it (local build output), MRVC TRACKS the self-contained
  // bundle so AI clients can run it straight from a clone
  check('gitignore(current): ignores out/', /^out\/$/m.test(devGi));
  const currentIsDevelop = /^\*\.vsix$/m.test(devGi);
  if (currentIsDevelop) {
    check('gitignore(develop): ignores mcp/ (build output)', /^mcp\/$/m.test(devGi));
    check('gitignore(develop): ignores *.vsix (release assets live in MRVC only)', true);
  } else {
    check('gitignore(MRVC): does NOT ignore mcp/ (the bundle is tracked)', /^mcp\/$/m.test(devGi) === false);
    check('gitignore(MRVC): keeps the !mrvc-*.vsix release re-include', /^!mrvc-\*\.vsix$/m.test(devGi));
  }
  // the sibling release checkout, when present next to develop
  const mrvcGiPath = path.join(here, '..', '..', 'MRVC', '.gitignore');
  if (fs.existsSync(mrvcGiPath)) {
    const mrvcGi = fs.readFileSync(mrvcGiPath, 'utf8');
    check('gitignore(MRVC sibling): ignores out/', /^out\/$/m.test(mrvcGi));
    check('gitignore(MRVC sibling): ignores *.vsix (never two release assets)', /^\*\.vsix$/m.test(mrvcGi) === false && /^\!mrvc-\*\.vsix$/m.test(mrvcGi));
    // round11 follow-up: the BUILT MCP bundle is TRACKED in MRVC (self-
    // contained; AI clients run it straight from a clone) — mcp/ must NOT
    // be ignored there, unlike develop where it is build output
    check('gitignore(MRVC sibling): does NOT ignore mcp/ (bundle is tracked)', /^mcp\/$/m.test(mrvcGi) === false);
  } else {
    check('gitignore: no sibling MRVC checkout — variant checks skipped', true);
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nall sync-list tests passed');
process.exit(failures ? 1 : 0);
