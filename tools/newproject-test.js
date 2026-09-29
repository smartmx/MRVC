/*
 * New-project wizard tests (pure Node): template scanning against the real
 * MRS2 SDK, creation from a real template zip (extract -> empty wvproj ->
 * renameProject), and failure paths. Writes only into .scratch.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const { sdkRoot, scanTemplates, createProjectFromTemplate } = require('../out/core/newProject.js');
const { chipDbRoot } = require('../out/core/chipdb.js');
const { Cproject } = require('../out/core/cproject.js');
const { scanSources } = require('../out/core/scan.js');

const RES = 'C:/MounRiver/MounRiver_Studio2/resources/app/resources/win32';
check('sdkRoot joins resourcesWin32', sdkRoot(RES).endsWith(path.join('components', 'WCH', 'SDK', 'default')));
check('chipDbRoot agrees on SDK location', path.basename(chipDbRoot(RES)) === 'default');

if (!fs.existsSync(sdkRoot(RES))) {
  console.log('SKIP  new-project (MRS2 SDK not present)');
  process.exit(0);
}

// 1. template scan
const db = scanTemplates(RES);
const v307 = db.series.get('CH32V307');
check('scan: CH32V307 series found', !!v307);
check('scan: NoneOS os family', !!v307?.get('NoneOS'));
const rct = v307?.get('NoneOS')?.find((c) => c.chip === 'CH32V307RCT');
check('scan: CH32V307RCT template found', !!rct);
check('scan: metadata jsons excluded', !v307?.get('NoneOS')?.some((c) => c.chip.endsWith('-flash') || c.chip.endsWith('-targetProcessor')));
const total = [...db.series.values()].reduce((n, m) => n + [...m.values()].reduce((k, l) => k + l.length, 0), 0);
console.log(`       templates discovered: ${total} across ${db.series.size} series`);
check('scan: large template set', total > 200);

// 2. create from a real template into scratch
const WS = path.join(__dirname, '..', '.scratch', 'newproject-ws');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

const created = createProjectFromTemplate(rct, { projectName: 'MyApp', parentDir: WS, artifactType: 'exe' });
check('create: project folder created', fs.existsSync(path.join(WS, 'MyApp')));
check('create: final name applied', created.finalName === 'MyApp');
check('create: empty wvproj marker', fs.existsSync(path.join(WS, 'MyApp', 'MyApp.wvproj')));
check('create: old wvproj gone', !fs.existsSync(path.join(WS, 'MyApp', 'CH32V307RCT6.wvproj')));

// 3. the created project is a working MRS project: loads, scans, renamed
const cp = Cproject.load(path.join(WS, 'MyApp'));
check('create: .cproject loads, display name renamed', cp.projectName === 'MyApp');
const files = [...scanSources(cp).values()].flat();
check('create: sources scanned from template', files.length > 5);
check('create: .template Target Path renamed', (() => {
  const raw = fs.readFileSync(path.join(WS, 'MyApp', '.template'), 'utf-8');
  return raw.includes('MyApp.hex');
})());
check('create: .launch renamed', fs.existsSync(path.join(WS, 'MyApp', 'MyApp.launch')));

// 4. failure paths
let threw = '';
try {
  createProjectFromTemplate(rct, { projectName: 'MyApp', parentDir: WS, artifactType: 'exe' });
} catch (e) {
  threw = String(e.message || e);
}
check('create: existing folder refused', threw.includes('already exists'));
threw = '';
try {
  createProjectFromTemplate(rct, { projectName: '../escape', parentDir: WS, artifactType: 'exe' });
} catch (e) {
  threw = String(e.message || e);
}
check('create: path traversal refused', threw.includes('Invalid project name'));
check('create: nothing written outside', !fs.existsSync(path.join(WS, 'escape')));
threw = '';
try {
  createProjectFromTemplate(rct, { projectName: 'My$Project', parentDir: WS, artifactType: 'exe' });
} catch (e) {
  threw = String(e.message || e);
}
check('create: PowerShell metacharacters refused ($)', threw.includes('Invalid project name'));
threw = '';
try {
  createProjectFromTemplate(rct, { projectName: "O'Brien", parentDir: WS, artifactType: 'exe' });
} catch (e) {
  threw = String(e.message || e);
}
check("create: single quote refused (O'Brien)", threw.includes('Invalid project name'));

// 5. static-lib flag runs the same pipeline (wizard difference is template family)
const lib = createProjectFromTemplate(rct, { projectName: 'MyLib', parentDir: WS, artifactType: 'lib' });
check('create: lib artifact project created', fs.existsSync(path.join(WS, 'MyLib', 'MyLib.wvproj')));
void lib;

fs.rmSync(WS, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall newproject tests passed');
process.exit(failures ? 1 : 0);
