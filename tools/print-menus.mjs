/* dev helper: print the tree context menus per node type in VSCode's order */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const items = pkg.contributes.menus['view/item/context'];
const cmds = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));

/** node types a menu `when` applies to (explicit viewItem == X, ||-joined,
 * plus the legacy regex form for completeness) */
function appliesTo(when, node) {
  const eq = [...when.matchAll(/viewItem == ([\w.]+)/g)].map((m) => m[1]);
  if (eq.length) return eq.includes(node);
  const rx = when.match(/viewItem =~ \/\^\((.*?)\)\$\//);
  if (rx) return rx[1].split('|').includes(node);
  return false;
}

const gkey = (g) => {
  const m = g.match(/^([^@]+)@(\d+)$/);
  return m ? [m[1], Number(m[2])] : [g, 0];
};

const NODES = ['project', 'file', 'file.excluded', 'folder', 'folder.excluded', 'linkedFolder', 'products', 'outputFile', 'solution'];
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
  inline.forEach((i) => console.log('  [行内按钮] ' + cmds[i.command]));
  list.forEach((i) => console.log('  ' + i.group.padEnd(12) + ' ' + cmds[i.command] + '  (' + i.command + ')'));
  console.log();
}
