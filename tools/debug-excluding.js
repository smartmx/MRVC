/* Debug helper: check excluding semantics for a project. */
const path = require('path');
const { Cproject } = require('../out/core/cproject.js');
const { scanSources } = require('../out/core/scan.js');
const cp = new Cproject(path.join(process.argv[2], '.cproject'));
for (const e of cp.sourceEntries) {
  console.log('entry', JSON.stringify(e.name), 'excluding:', JSON.stringify(e.excluding));
}
const map = scanSources(cp);
const needle = process.argv[3];
for (const [k, v] of map) {
  if (v.some((f) => f.logicName.includes(needle))) {
    console.log(`dir ${JSON.stringify(k)} includes:`, v.filter((f) => f.logicName.includes(needle)).map((f) => f.logicName));
  }
}
