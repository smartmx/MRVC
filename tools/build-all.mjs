/**
 * Batch build every EXAM project with the current generator + real toolchain.
 * Runs tools/build-test.mjs per project (concurrency-limited) and reports.
 *
 * Usage: node tools/build-all.mjs [rootDir] [concurrency]
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

const root = process.argv[2] ?? 'F:/CH585/EVT/V1_2/EXAM';
const concurrency = Number(process.argv[3] ?? 3);

const projects = [];
(function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === '.cproject')) {
    projects.push(dir);
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  }
})(root, 0);

console.log(`[build-all] ${projects.length} projects under ${root}, concurrency ${concurrency}`);

const results = [];
let index = 0;

function runOne(dir) {
  const r = spawnSync(process.execPath, [path.join(here, 'build-test.mjs'), dir], {
    encoding: 'utf-8',
    timeout: 300000,
  });
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).split(/\r?\n/);
  const elf = out.find((l) => l.startsWith('[product]') && l.includes('.elf')) ?? '';
  const err = out.find((l) => /rror/i.test(l)) ?? out.filter((l) => l.trim()).slice(-2).join(' | ');
  return { dir, code: r.status ?? -1, elf, err: r.status === 0 ? '' : err.slice(0, 300) };
}

async function worker() {
  while (index < projects.length) {
    const dir = projects[index++];
    const res = runOne(dir);
    results.push(res);
    console.log(`${res.code === 0 ? 'OK  ' : 'FAIL'} ${path.relative(root, dir).replace(/\\/g, '/')}  ${res.code === 0 ? res.elf.replace('[product] ', '') : res.err}`);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const failed = results.filter((r) => r.code !== 0);
console.log(`\n[build-all] ${results.length - failed.length}/${results.length} projects built OK`);
if (failed.length) {
  console.log('[build-all] failures:');
  for (const f of failed) console.log(`  ${path.relative(root, f.dir)} -> ${f.err}`);
}
fs.mkdirSync(path.join(here, '..', '.scratch'), { recursive: true });
fs.writeFileSync(path.join(here, '..', '.scratch', 'build-all-report.json'), JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
