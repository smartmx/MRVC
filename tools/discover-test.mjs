/**
 * Discovery coverage test: replicate the plugin's project-discovery walk
 * against a tree and diff against the full .cproject enumeration.
 * Ground truth walks ONE level deeper than the engine under test, so a tree
 * whose projects sit below the tested depth trips "missed" — that is the
 * regression signal for the default depth being too small. Exits non-zero
 * on any missed/extra difference.
 * Usage: node tools/discover-test.mjs [root] [depth]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { findProjectRoots, DEFAULT_DISCOVERY_DEPTH } = require(path.join(here, '..', 'out', 'core', 'discover.js'));

const root = process.argv[2] ?? ['E:/Projects/MRS_VSCODE/TEST/CH585EVT/EXAM', 'F:/CH585/EVT/V1_2/EXAM'].find((r) => fs.existsSync(r));
const depth = Number(process.argv[3] ?? DEFAULT_DISCOVERY_DEPTH);

// ground truth: every LEGAL project dir — 工程名.wvproj (the open marker)
// AND companions .project + .cproject (0.2.8 final contract, round5 §1:
// the truth function must agree with isLegalProjectRoot's three-file rule)
// — one level beyond the engine's reach
const truth = [];
let nonLegalMarkerDirs = 0; // dirs with some marker/companion files but not the full legal triple — debris
(function walk(dir, d) {
  if (d > depth + 1) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const hasWvproj = entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.wvproj'));
  const hasProject = entries.some((e) => e.isFile() && e.name === '.project');
  const hasCproject = entries.some((e) => e.isFile() && e.name === '.cproject');
  if (hasWvproj && hasProject && hasCproject) {
    truth.push(path.normalize(dir).toLowerCase());
    return;
  }
  if (hasWvproj || hasProject || hasCproject) nonLegalMarkerDirs++;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), d + 1);
  }
})(root, 0);

const found = findProjectRoots(root, depth).map((p) => path.normalize(p).toLowerCase());
const truthSet = new Set(truth);
const foundSet = new Set(found);
const missed = truth.filter((t) => !foundSet.has(t));
const extra = found.filter((f) => !truthSet.has(f));

console.log(`[discover] depth=${depth}: found ${found.length}, truth ${truth.length} (${nonLegalMarkerDirs} non-legal marker dirs), missed ${missed.length}, extra ${extra.length}`);
for (const m of missed) console.log('  MISSED:', path.relative(root, m).replace(/\\/g, '/'));
for (const e of extra) console.log('  EXTRA :', path.relative(root, e).replace(/\\/g, '/'));
if (missed.length || extra.length) process.exit(1);

// ---- legality unit checks (0.2.8 final contract, round5 §1: the legal
// root carries 工程名.wvproj + companions .project + .cproject — all three;
// any subset is debris) — a scratch tree exercising every combination
// against findProjectRoots
import * as os from 'os';
{
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-legal-'));
  const mk = (name, files) => {
    fs.mkdirSync(path.join(S, name), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(S, name, f), 'x');
  };
  mk('wvproj-only', ['Proj.wvproj']);                        // debris — the reported case shape
  mk('project-only', ['.project']);                          // debris — no marker, no .cproject
  mk('wvproj-cproject', ['Proj.wvproj', '.cproject']);       // debris — missing the .project companion
  mk('project-cproject', ['.project', '.cproject']);         // debris (round5) — missing the .wvproj marker
  mk('wvproj-project', ['Proj.wvproj', '.project']);         // debris — missing the .cproject companion
  mk('full', ['Proj.wvproj', '.project', '.cproject']);      // legal (marker + both companions)
  mk('plain-src', ['main.c']);                               // never a project

  const found = findProjectRoots(S, 4).map((p) => path.basename(p)).sort();
  const expect = ['full'];
  const ok =
    found.length === 1 &&
    JSON.stringify(found) === JSON.stringify(expect) &&
    // solutions never appear as project roots
    findProjectRoots(path.join(S, 'wvproj-only'), 2).length === 0;
  console.log(ok ? '[discover] legality: wvproj+.project+.cproject triple contract enforced (1 legal, 6 debris skipped)' : `[discover] legality FAILED: found=${JSON.stringify(found)}`);
  fs.rmSync(S, { recursive: true, force: true });
  if (!ok) process.exit(1);
}
