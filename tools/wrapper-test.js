/*
 * Build-task wrapper: the generated .cmd launcher and the PowerShell tee script
 * it runs.
 *
 * Content assertions pin the shape (make's output goes through a pipeline that
 * writes the record AND the terminal; the `make -n -B` dry run is record-only;
 * exit codes propagate; the script carries the UTF-8 BOM). The functional part
 * runs the wrapper with a FAKE make that sleeps between its lines: the first
 * line must reach the terminal long before the process exits (the old shape
 * redirected make into the record and `type`-d it at the end — nothing until
 * the build had finished), the record must hold the same lines plus the dry-run
 * appendix, and a failing make must fail the task.
 *
 * Windows-only (cmd + PowerShell); skips elsewhere.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const { buildTeeScript, buildLauncherScript, cleanWrapperScript, writeBuildTaskWrapper } = require('../out/core/taskWrapper.js');
const { encodePowerShellScript } = require('../out/core/platformEncoding.js');
const { buildRecordFile, buildWrapperFile, buildTeeScriptFile, buildMakeCmdFile, buildDryRunCmdFile } = require('../out/core/buildLog.js');
const { buildMakeCmdScript, buildDryRunCmdScript } = require('../out/core/taskWrapper.js');

// --- content assertions (platform-independent) ---
{
  const spec = {
    buildDir: 'C:\\some dir\\obj',
    makeExe: 'C:\\mrs\\make.exe',
    makeArgs: ['-j5', 'all'],
    recordFile: 'C:\\tmp\\rec.txt',
    label: 'MounRiver Studio 2',
  };
  const ps = buildTeeScript(spec, 'C:\\temp\\x-build.cmd', 'C:\\temp\\x-dry.cmd');
  check(
    'tee: reads make through .NET pipes, not the PowerShell object pipeline',
    /\[System\.Diagnostics\.Process\]::Start\(\$psi\)/.test(ps) && /\.StandardOutput/.test(ps) && !/ForEach-Object/.test(ps)
  );
  check(
    'tee: (re-)creates the record directory before opening the writer',
    /New-Item -ItemType Directory -Force -Path \(Split-Path -Parent '[^']+'\)/.test(ps) &&
      ps.indexOf('New-Item -ItemType Directory') < ps.indexOf('New-Object System.IO.StreamWriter')
  );
  check('tee: every line reaches the record', /\$writer\.WriteLine\(\$line\)/.test(ps));
  check(
    'tee: echoed lines are written straight through; AutoFlush set only where it exists',
    /if \(\$null -ne \$out\.PSObject\.Properties\['AutoFlush'\]\) \{ \$out\.AutoFlush = \$true \}/.test(ps) &&
      /if \(\$echo\) \{ \[Console\]::Out\.WriteLine\(\$line\) \}/.test(ps) &&
      !/StringBuilder/.test(ps) &&
      // a bare assignment would throw "property not found" on PowerShell 5.1
      !/^\[Console\]::Out\.AutoFlush/m.test(ps)
  );
  check(
    'tee: the record is UTF-8 and flushed before the dry run',
    /UTF8Encoding/.test(ps) &&
      ps.indexOf('$writer.Flush()') > 0 &&
      ps.indexOf('$writer.Flush()') < ps.indexOf("Invoke-Make 'C:\\temp\\x-dry.cmd'") &&
      /\$writer\.Close\(\)/.test(ps)
  );
  check(
    'tee: both phases run through the same reader; only phase 1 echoes',
    /\$code = Invoke-Make 'C:\\temp\\x-build\.cmd' \$true/.test(ps) && /\[void\]\(Invoke-Make 'C:\\temp\\x-dry\.cmd' \$false\)/.test(ps)
  );
  check(
    'tee: the dry run follows its record header and never reaches the terminal',
    ps.indexOf("$writer.WriteLine('===== All Build Commands (dry run: make -n -B) =====')") < ps.indexOf("Invoke-Make 'C:\\temp\\x-dry.cmd'") &&
      !/Write-Host[^\n]*dry run/.test(ps) &&
      /if \(\$echo\) \{/.test(ps)
  );
  check(
    'tee: the exit code is the build phase\'s, propagated last',
    /return \$proc\.ExitCode/.test(ps) && /exit \$code\b/.test(ps) && ps.lastIndexOf('exit $code') > ps.indexOf("Invoke-Make 'C:\\temp\\x-dry.cmd'")
  );
  check('tee: the install label is printed before the build starts', ps.indexOf("Write-Host 'MRS: MounRiver Studio 2'") >= 0 && ps.indexOf("Write-Host 'MRS:") < ps.indexOf('$writer ='));
  check(
    'tee: the child gets its working directory explicitly (no Set-Location trap)',
    /\$psi\.WorkingDirectory = 'C:\\some dir\\obj'/.test(ps) && !/Set-Location/.test(ps)
  );

  const buildCmd = buildMakeCmdScript(spec);
  check(
    'phase 1: cd into the build dir, make with stderr merged, exit code kept',
    /cd \/d "C:\\some dir\\obj"/.test(buildCmd) && /make\.exe" -j5 all 2>&1/.test(buildCmd) && /exit \/b %errorlevel%/.test(buildCmd)
  );
  const dryCmd = buildDryRunCmdScript(spec);
  check(
    'phase 2: cd + dry run with stderr merged, NO cmd redirection (would write ANSI bytes into a UTF-8 record)',
    /cd \/d "C:\\some dir\\obj"/.test(dryCmd) && /make\.exe" -n -B all 2>&1/.test(dryCmd) && !/>>/.test(dryCmd)
  );

  const launcher = buildLauncherScript('C:\\temp\\x-tee.ps1');
  check(
    'launcher: resolves the system PowerShell explicitly',
    /set "PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"/.test(launcher)
  );
  check(
    'launcher: runs PowerShell (no profile, bypass) on the tee script',
    /"%PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\temp\\x-tee\.ps1"/.test(launcher)
  );
  check('launcher: propagates the exit code', /exit \/b %errorlevel%/.test(launcher));
  check('launcher: a missing PowerShell fails loudly', /if not exist "%PS%"[\s\S]*exit \/b 9009/.test(launcher));
  check('launcher: expands no user-controlled metacharacters', !/[&<>|]/.test(launcher.split('\r\n').filter((l) => !l.startsWith('if not exist')).join('\r\n')));

  const clean = cleanWrapperScript({ buildDir: 'C:\\proj\\obj', makeExe: 'C:\\mrs\\make.exe', args: ['-s', 'clean'], label: 'MounRiver Studio 3' });
  check('clean: stays a live plain cmd run (no record, no `type`)', /make\.exe" -s clean/.test(clean) && !/buildContentRecord|type "/.test(clean));
  check('clean: keeps the label line and the exit code', /echo MRS: MounRiver Studio 3/.test(clean) && /exit \/b %errorlevel%/.test(clean));

  const bom = encodePowerShellScript("Write-Host '指纹'");
  check('script encoding: UTF-8 BOM + the text survives', bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf && bom.subarray(3).toString('utf8') === "Write-Host '指纹'");
}

if (process.platform !== 'win32') {
  console.log('SKIP  functional wrapper run (cmd + PowerShell: Windows only)');
  console.log(failures ? `\n${failures} FAILURES` : '\nall wrapper tests passed');
  process.exit(failures ? 1 : 0);
}

// --- functional run with a fake make ---
const ROOT = path.join(__dirname, '..', '.scratch', 'wrapper');
fs.rmSync(ROOT, { recursive: true, force: true });
const proj = path.join(ROOT, 'proj');
fs.mkdirSync(path.join(proj, 'obj'), { recursive: true });

const { encodeArtifact } = require('../out/core/platformEncoding.js');
const fakeMake = path.join(ROOT, 'fake-make.cmd');
fs.writeFileSync(
  fakeMake,
  encodeArtifact(
    '@echo off\r\n' +
      'echo cwd=%CD%\r\n' +
      'if "%1"=="-n" goto dry\r\n' +
      'echo compiling ../src/main.c\r\n' +
      'ping -n 3 127.0.0.1 > nul\r\n' + // ~2 s: the first line must arrive long before the end
      'echo linking val:7.0.0\r\n' +
      'if "%3"=="fail" exit /b 7\r\n' +
      'exit /b 0\r\n' +
      ':dry\r\n' +
      'echo DRYRUN-COMMAND-ONLY-IN-RECORD\r\n' +
      'exit /b 0\r\n'
  )
);

const run = (extra, done) => {
  const spec = {
    buildDir: path.join(proj, 'obj'),
    makeExe: fakeMake,
    makeArgs: ['-j5', 'all', ...extra],
    recordFile: buildRecordFile(proj),
    label: 'MounRiver Studio 2',
  };
  const launcher = writeBuildTaskWrapper(proj, spec);
  check('wrapper: the tee script is written with the UTF-8 BOM', fs.readFileSync(buildTeeScriptFile(proj))[0] === 0xef);
  check('wrapper: the launcher is the file VSCode runs', launcher === buildWrapperFile(proj) && fs.existsSync(launcher));
  // the wrapper must be self-sufficient: a %TEMP% cleanup landing between
  // wrapper generation and launch must not kill the build (round9 F2)
  fs.rmSync(path.dirname(spec.recordFile), { recursive: true, force: true });
  const { spawn } = require('child_process');
  const t0 = Date.now();
  let firstAt = 0;
  let out = '';
  let err = '';
  const p = spawn('cmd.exe', ['/c', launcher], { windowsHide: true });
  p.stdout.on('data', (d) => {
    if (!firstAt) firstAt = Date.now() - t0;
    out += d.toString();
  });
  p.stderr.on('data', (d) => {
    err += d.toString();
  });
  p.on('close', (code) => done({ code, elapsed: Date.now() - t0, firstAt, out, err, record: buildRecordFile(proj) }));
};

run([], (r) => {
  check('functional: the wrapper exits 0 for a successful make', r.code === 0);
  check('functional: make output reaches the terminal', r.out.includes('compiling ../src/main.c') && r.out.includes('linking val:7.0.0'));
  // a PowerShell error that does not stop the script (e.g. a property that does
  // not exist on PS 5.1) lands on the wrapper's stderr and ONLY there — the
  // build still succeeds, so this is the assertion that catches it
  check(`functional: the wrapper prints no PowerShell errors (stderr: ${JSON.stringify(r.err.slice(0, 120))})`, r.err.trim() === '');
  check(
    `functional: output arrives WHILE the build runs (first chunk ${r.firstAt} ms, exited ${r.elapsed} ms)`,
    r.firstAt > 0 && r.elapsed - r.firstAt > 700
  );
  const record = fs.readFileSync(r.record, 'utf8');
  check('functional: the record holds the make output', record.includes('compiling ../src/main.c') && record.includes('linking val:7.0.0'));
  check(
    'functional: make runs in the build directory (the phase .cmd cd /d)',
    record.includes('cwd=' + path.join(proj, 'obj')) || r.out.includes('cwd=' + path.join(proj, 'obj'))
  );
  check('functional: the record ends with the dry-run appendix', /===== All Build Commands \(dry run: make -n -B\) =====[\s\S]*DRYRUN-COMMAND-ONLY-IN-RECORD/.test(record));
  check('functional: the dry run is NOT echoed into the terminal', !r.out.includes('DRYRUN-COMMAND-ONLY-IN-RECORD'));
  check('functional: the label is terminal-only, not part of the record', r.out.includes('MRS: MounRiver Studio 2') && !record.includes('MRS:'));

  run(['fail'], (r2) => {
    check('functional: a failing make fails the wrapper (exit code 7)', r2.code === 7);
    check('functional: the record is still written for a failed build', fs.readFileSync(r2.record, 'utf8').includes('compiling ../src/main.c'));
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILURES` : '\nall wrapper tests passed');
    process.exit(failures ? 1 : 0);
  });
});
