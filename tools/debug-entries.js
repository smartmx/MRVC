/* Debug helper: dump sourceEntries + linked folders of a project dir. */
const path = require('path');
const { Cproject } = require('../out/core/cproject.js');
const cp = new Cproject(path.join(process.argv[2], '.cproject'));
console.log('linkedFolders:', [...cp.linkedFolders]);
for (const e of cp.sourceEntries) {
  console.log('entry', JSON.stringify(e.name), 'excluding', e.excluding.length ? e.excluding.slice(0, 6).join(',') + ` (+${Math.max(0, e.excluding.length - 6)})` : '-');
}
const { scanSources } = require('../out/core/scan.js');
const map = scanSources(cp);
for (const [k, v] of map) console.log('dir', JSON.stringify(k), v.length, 'files');
