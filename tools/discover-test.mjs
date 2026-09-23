/**
 * Discovery coverage test: replicate the plugin's project-discovery walk
 * against a tree and diff against the full .cproject enumeration.
 * Usage: node tools/discover-test.mjs [root] [depth]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { findProjectRoots } = require(path.join(here, '..', 'out', 'core', 'discover.js'));

const root = process.argv[2] ?? 'F:/CH585/EVT/V1_2/EXAM';
const depth = Number(process.argv[3] ?? 6);

// ground truth: every dir with a .wvproj (MRS marker) or .project
const truth = [];
let noProject = 0;
(function walk(dir, d) {
  if (d > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const hasWvproj = entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.wvproj'));
  const hasProject = entries.some((e) => e.isFile() && e.name === '.project');
  if (hasWvproj || hasProject) {
    truth.push(path.normalize(dir).toLowerCase());
    if (!hasProject) noProject++;
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), d + 1);
  }
})(root, 0);

const found = findProjectRoots(root, depth).map((p) => path.normalize(p).toLowerCase());
const truthSet = new Set(truth);
const foundSet = new Set(found);
const missed = truth.filter((t) => !foundSet.has(t));
const extra = found.filter((f) => !truthSet.has(f));

console.log(`[discover] depth=${depth}: found ${found.length}, truth ${truth.length} (${noProject} without .project), missed ${missed.length}, extra ${extra.length}`);
for (const m of missed) console.log('  MISSED:', path.relative(root, m).replace(/\\/g, '/'));
for (const e of extra) console.log('  EXTRA :', path.relative(root, e).replace(/\\/g, '/'));
