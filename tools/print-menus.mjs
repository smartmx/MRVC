/* dev helper: print the tree context menus per node type in VSCode's order */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const items = pkg.contributes.menus['view/item/context'];
// titles are NLS placeholders since menu localization — resolve them against
// both language files so the printed menu shows real text (en by default,
// zh with `node tools/print-menus.mjs zh`)
const lang = process.argv[2] === 'zh' ? 'zh-cn' : 'en';
const nlsFile = lang === 'zh-cn' ? 'package.nls.zh-cn.json' : 'package.nls.json';
const nls = JSON.parse(fs.readFileSync(path.join(here, '..', nlsFile), 'utf8'));
const resolveTitle = (title) =>
  title.replace(/%([^%]+)%/g, (_, k) => nls[k] ?? title);
const cmds = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, resolveTitle(c.title)]));
console.log(`(titles: ${nlsFile})`);

/** node types a menu `when` applies to (explicit viewItem == X, ||-joined,
 * plus the legacy regex form for completeness) */
function appliesTo(when, node) {
  const eq = [...when.matchAll(/viewItem == ([\w.]+)/g)].map((m) => m[1]);
  if (eq.length) return eq.includes(node);
  const rx = when.match(/viewItem =~ \/\^\((.*?)\)\$\//);
  // alternation members may carry regex escapes (`file\.src`) — strip them so
  // the comparison is against the plain context-value names
  if (rx) return rx[1].split('|').map((s) => s.replace(/\\(.)/g, '$1')).includes(node);
  return false;
}

const gkey = (g) => {
  const m = g.match(/^([^@]+)@(\d+)$/);
  return m ? [m[1], Number(m[2])] : [g, 0];
};

// submenu entry labels (a menu item may be { submenu } instead of { command })
const subLabels = Object.fromEntries((pkg.contributes.submenus || []).map((s) => [s.id, resolveTitle(s.label)]));
const labelOf = (i) => (i.command ? cmds[i.command] : '『' + (subLabels[i.submenu] ?? i.submenu) + '』');
const refOf = (i) => (i.command ? i.command : 'submenu ' + i.submenu);

const NODES = ['project', 'file.src', 'file.src.excluded', 'file', 'file.excluded', 'folder', 'folder.excluded', 'linkedFolder', 'products', 'outputFolder', 'outputFile', 'solution'];
for (const node of NODES) {
  const list = items
    .filter((i) => appliesTo(i.when, node) && !i.group.startsWith('inline'))
    .sort((a, b) => {
      const [ga, na] = gkey(a.group);
      const [gb, nb] = gkey(b.group);
      return ga.localeCompare(gb) || na - nb;
    });
  const inline = items.filter((i) => appliesTo(i.when, node) && i.group.startsWith('inline'));
  if (!list.length && !inline.length) continue;
  console.log(`===== ${node} =====`);
  inline.forEach((i) => console.log('  [行内按钮] ' + labelOf(i)));
  list.forEach((i) => console.log('  ' + i.group.padEnd(12) + ' ' + labelOf(i) + '  (' + refOf(i) + ')'));
  console.log();
}

// the submenus referenced by the tree menu, in contribution order
for (const sub of pkg.contributes.submenus || []) {
  const entries = pkg.contributes.menus[sub.id] || [];
  if (!entries.length) continue;
  console.log(`===== submenu: ${subLabels[sub.id] ?? sub.id} =====`);
  entries
    .slice()
    .sort((a, b) => {
      const [ga, na] = gkey(a.group);
      const [gb, nb] = gkey(b.group);
      return ga.localeCompare(gb) || na - nb;
    })
    .forEach((i) => console.log('  ' + i.group.padEnd(12) + ' ' + labelOf(i) + '  (' + refOf(i) + ')'));
  console.log();
}
