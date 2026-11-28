/*
 * Flash/power receipt write tests (round41 follow-up): the atomic
 * temp+rename write behind writeFlashAck/writePowerAck retries transient
 * rename failures (EPERM/EBUSY/EACCES — antivirus/indexer holding the file
 * on Windows), gives up as a BEST-EFFORT receipt (never breaks a finished
 * download), cleans its temp file, and the shared .gitignore helper keeps
 * user entries without duplicates.
 * Run: node tools/flashack-test.js
 */
const fs = require('fs');
const path = require('path');
const { writeFlashAck, writePowerAck } = require('../out/core/flashAck.js');

const scratch = path.join(path.dirname(__dirname), '.scratch', 'flashack');
let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  << ${extra ?? ''}`}`);
  if (!cond) failures++;
};

fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
fs.mkdirSync(scratch, { recursive: true });

/** residue probe: the meta dir holds only real content files (no temp or
 *  lock leftovers) after a completed or failed write */
function residue(root) {
  const dir = path.join(root, '.vscode', 'mrvc');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /\.tmp$/.test(n) || /output-history\.lock/.test(n));
}

// ---- baseline: both receipts land atomically, gitignore maintained ----
{
  const root = path.join(scratch, 'base');
  fs.mkdirSync(root, { recursive: true });
  const ack = writeFlashAck(root);
  check('receipt: writeFlashAck returns the ack (no .template -> templateHash null)', !!ack && typeof ack.time === 'string' && ack.templateHash === null && typeof ack.machine === 'string', JSON.stringify(ack));
  const written = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'mrvc', 'flash-verified.json'), 'utf-8'));
  check('receipt: flash-verified.json parses back to the same shape', written.templateHash === null && typeof written.machine === 'string', JSON.stringify(written).slice(0, 120));
  check('receipt: no temp or lock residue', residue(root).length === 0, JSON.stringify(residue(root)));

  const boardCfg = path.join(root, 'board.cfg');
  fs.writeFileSync(boardCfg, '# cfg\n');
  const pack = writePowerAck(root, { voltage: '3v3', delayMs: 100, boardCfgPath: boardCfg, boardCfgSha: null, openocdExe: 'openocd.exe' });
  check('receipt: writePowerAck lands power-verified.json', !!pack && fs.existsSync(path.join(root, '.vscode', 'mrvc', 'power-verified.json')), JSON.stringify(pack));

  const gi = fs.readFileSync(path.join(root, '.vscode', 'mrvc', '.gitignore'), 'utf-8');
  check(
    'receipt: the receipt write covers both receipt entries in .gitignore',
    gi.includes('flash-verified.json') && gi.includes('power-verified.json'),
    gi
  );
  const gi2 = (() => { writeFlashAck(root); return fs.readFileSync(path.join(root, '.vscode', 'mrvc', '.gitignore'), 'utf-8'); })();
  check('receipt: a second write adds no duplicate .gitignore entries', gi2 === gi, gi2);
  // the history side shares the SAME locked helper — a direct call appends
  // its own entries to the file the receipts created, user lines intact
  const { ensureMrvcGitignoreEntries } = require('../out/core/outputHistory.js');
  ensureMrvcGitignoreEntries(path.join(root, '.vscode', 'mrvc'), ['output-history.json', 'output-history.lock', 'output-history.lock.stale.*']);
  const gi3 = fs.readFileSync(path.join(root, '.vscode', 'mrvc', '.gitignore'), 'utf-8');
  check(
    'receipt: the history side appends through the same helper (no duplicates, receipts kept)',
    gi3.includes('output-history.json') && gi3.includes('flash-verified.json') && (gi3.match(/flash-verified\.json/g) || []).length === 1,
    gi3
  );
}

// ---- user entries survive the shared append-only helper ----
{
  const root = path.join(scratch, 'usergi');
  const meta = path.join(root, '.vscode', 'mrvc');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, '.gitignore'), '# my notes\ncustom-keep.txt\n');
  writeFlashAck(root);
  const gi = fs.readFileSync(path.join(meta, '.gitignore'), 'utf-8');
  check('receipt: pre-existing user .gitignore lines survive', gi.includes('# my notes') && gi.includes('custom-keep.txt') && gi.includes('flash-verified.json'), gi);
}

// ---- transient rename failures retry, then succeed ----
{
  const root = path.join(scratch, 'retry1');
  fs.mkdirSync(root, { recursive: true });
  const orig = fs.renameSync;
  let calls = 0;
  try {
    fs.renameSync = function (a, b) {
      calls++;
      if (calls === 1) {
        const e = new Error('EPERM (simulated)');
        e.code = 'EPERM';
        throw e;
      }
      return orig.call(fs, a, b);
    };
    const ack = writeFlashAck(root);
    check('receipt: one EPERM transient is retried and the write succeeds', !!ack && fs.existsSync(path.join(root, '.vscode', 'mrvc', 'flash-verified.json')) && calls >= 2, `calls=${calls}`);
    check('receipt: no temp residue after a retried write', residue(root).length === 0, JSON.stringify(residue(root)));
  } finally {
    fs.renameSync = orig;
  }
}
{
  const root = path.join(scratch, 'retry2');
  fs.mkdirSync(root, { recursive: true });
  const orig = fs.renameSync;
  const codes = ['EACCES', 'EPERM'];
  let calls = 0;
  try {
    fs.renameSync = function (a, b) {
      calls++;
      if (calls <= 2) {
        const e = new Error(`${codes[calls - 1]} (simulated)`);
        e.code = codes[calls - 1];
        throw e;
      }
      return orig.call(fs, a, b);
    };
    const ack = writeFlashAck(root);
    check('receipt: two transients (EACCES + EPERM) still succeed within the retry budget', !!ack && calls === 3, `calls=${calls}`);
    check('receipt: no temp residue after the double retry', residue(root).length === 0, JSON.stringify(residue(root)));
  } finally {
    fs.renameSync = orig;
  }
}

// ---- persistent failure: best-effort null, old receipt intact, temp cleaned ----
{
  const root = path.join(scratch, 'busy');
  fs.mkdirSync(root, { recursive: true });
  const ack1 = writeFlashAck(root);
  const before = fs.readFileSync(path.join(root, '.vscode', 'mrvc', 'flash-verified.json'), 'utf-8');
  const orig = fs.renameSync;
  let calls = 0;
  try {
    fs.renameSync = function () {
      calls++;
      const e = new Error('EBUSY (simulated)');
      e.code = 'EBUSY';
      throw e;
    };
    const ack2 = writeFlashAck(root, { address: '0x00000000', verify: false, reset: false, eraseAll: false, banks: 1, scriptSha: '', firmwarePath: '', firmwareSha: null, boardCfgPath: '', boardCfgSha: null, openocdExe: '', powerOn: null });
    check(
      'receipt: a persistent EBUSY gives up as best-effort null (the download itself is unaffected)',
      ack2 === null && calls === 5,
      `ack2=${JSON.stringify(ack2)} calls=${calls}`
    );
  } finally {
    fs.renameSync = orig;
  }
  check('receipt: the previous receipt survives a failed rewrite untouched', fs.readFileSync(path.join(root, '.vscode', 'mrvc', 'flash-verified.json'), 'utf-8') === before);
  check('receipt: the temp file is cleaned after the failure', residue(root).length === 0, JSON.stringify(residue(root)));
  check('receipt: sanity — the first write of this fixture did succeed', !!ack1 && !!ack1.time);
}

// ---- round11 D: locked history (unconfirmable .gitignore) refuses receipt write ----
{
  const root = path.join(scratch, 'locked_gi');
  const meta = path.join(root, '.vscode', 'mrvc');
  fs.mkdirSync(meta, { recursive: true });
  const lockPath = path.join(meta, 'output-history.lock');
  fs.writeFileSync(lockPath, `99999:${Date.now()}:active\n`, 'utf-8');
  const ackBlocked = writeFlashAck(root);
  const packBlocked = writePowerAck(root, { voltage: '3v3', delayMs: 100, boardCfgPath: path.join(root, 'board.cfg'), boardCfgSha: null, openocdExe: 'openocd.exe' });
  check(
    'round11 D: held lock prevents writing flash/power receipts without .gitignore coverage',
    ackBlocked === null &&
      packBlocked === null &&
      !fs.existsSync(path.join(meta, 'flash-verified.json')) &&
      !fs.existsSync(path.join(meta, 'power-verified.json')) &&
      !fs.existsSync(path.join(meta, '.gitignore')),
    JSON.stringify({ ackBlocked, packBlocked, files: fs.readdirSync(meta) })
  );
  fs.rmSync(lockPath, { force: true });
  const ackOk = writeFlashAck(root);
  const packOk = writePowerAck(root, { voltage: '3v3', delayMs: 100, boardCfgPath: path.join(root, 'board.cfg'), boardCfgSha: null, openocdExe: 'openocd.exe' });
  const giOk = fs.existsSync(path.join(meta, '.gitignore')) ? fs.readFileSync(path.join(meta, '.gitignore'), 'utf-8') : '';
  check(
    'round11 D: once unlocked, both receipts write alongside .gitignore entries',
    !!ackOk && !!packOk && giOk.includes('flash-verified.json') && giOk.includes('power-verified.json') && residue(root).length === 0,
    giOk
  );
}

try {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
} catch {
  // SMB share handle release lag
}
console.log(failures ? `\n${failures} FAILURES` : '\nall flashack tests passed');
process.exit(failures ? 1 : 0);
