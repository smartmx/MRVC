/**
 * Task wrapper generation (pure Node) — the files the build / clean tasks run.
 *
 * Why files at all: VSCode hands a task's command line to the terminal shell
 * UNQUOTED, and the project path is user-controlled (`EVT-IPV4&6` is a common
 * EVT folder name) — cmd splits such a command at every `&`. Every file here
 * lives under %TEMP%/mrs-build/<md5>…: pure-ASCII hash names carrying no
 * metacharacters, and the build directory is entered *inside* them, quoted.
 *
 * Build = launcher (.cmd) → PowerShell script (.ps1):
 *   phase 1  runs `<hash>-build.cmd` (make, stderr merged) and reads it through
 *            a .NET pipe line by line, writing EVERY line to both sinks: the
 *            MRS2 full-output record (%TEMP%/mrs-cache/<project>-<md5>/
 *            buildContentRecord.txt, UTF-8, read by "Show Full Build Output")
 *            and the terminal. Terminal writes are PER LINE and prompt
 *            ([Console]::Out flushes per line; the AutoFlush assignment is
 *            guarded because PS 5.1's Console.Out has no settable AutoFlush).
 *            A batched variant was tried and dropped: the reader blocks in
 *            ReadLine(), so the last lines waited for the next one to arrive
 *            (first output drifted from ~0.4 s to ~1.6 s).
 *   phase 2  appends the `make -n -B` dry run (every command the makefile
 *            drives; record only, never echoed) through `<hash>-dry.cmd` on the
 *            SAME .NET reader — plain cmd redirection instead would write the
 *            child's ANSI bytes into the UTF-8 record.
 *   The tee script (re-)creates the record's directory first: a %TEMP% cleanup
 *   landing between wrapper generation and launch would otherwise kill the
 *   build before make even starts.
 *
 * The record is MRS2's full-output location (%TEMP%/mrs-cache/<project>-<md5>/
 * buildContentRecord.txt, read by "Show Full Build Output") and is written
 * UTF-8; make's exit code propagates through every layer (a make that cannot
 * launch exits 9009, never a fake success).
 *
 * POSIX (Linux/macOS) twin: a SINGLE bash script per task. `make 2>&1 | tee`
 * streams every line to the terminal and the record natively per line — the
 * four Windows hazards (SyncTextWriter AutoFlush, batched-write latency, the
 * Set-Location cwd trap, cmd's ANSI code-page record) have no POSIX
 * equivalent — the dry run appends byte-transparently through the same
 * redirection, and PIPESTATUS carries make's exit code across the pipe.
 * tasks.ts launches it as `/bin/bash <script>`.
 *
 * Clean: a plain .cmd / .sh (no record to preserve, make's output stays live).
 */
import * as fs from 'fs';
import { buildWrapperFile, buildTeeScriptFile, buildMakeCmdFile, buildDryRunCmdFile, buildPosixWrapperFile } from './buildLog';
import { encodeArtifact, encodePowerShellScript } from './platformEncoding';

/** escape a `%` for cmd (`%VAR%` expansion must not eat paths) */
export function pct(s: string): string {
  return s.replace(/%/g, '%%');
}

/** the install label the build wrapper echoes ("MRS: MounRiver Studio 3") —
 *  the label comes from the install's product.json, so keep it to characters
 *  every shell treats literally */
export function echoSafeLabel(label: string): string {
  return label
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** a PowerShell single-quoted literal (the only quoting that expands nothing) */
export function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** a POSIX shell single-quoted literal (embedded ' becomes '"'"') */
export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

export interface BuildWrapperSpec {
  /** the makefile config directory the build runs in */
  buildDir: string;
  /** absolute path to make.exe */
  makeExe: string;
  /** make arguments (e.g. ['-j5', 'all']) */
  makeArgs: string[];
  /** the full-output record to write */
  recordFile: string;
  /** active install label for the "MRS: …" line (optional) */
  label?: string;
}

/** phase 1: make with stderr merged into one stream (the tee reads this).
 *  The `cd /d` is load-bearing: PowerShell's Set-Location does NOT change the
 *  process working directory .NET hands to the child, so a make started without
 *  it runs wherever PowerShell itself began ("No rule to make target 'all'").
 *  (`$psi.WorkingDirectory` is set too — belt and braces, and it keeps the
 *  child's cwd correct even if this file is ever run on its own.) */
export function buildMakeCmdScript(spec: BuildWrapperSpec): string {
  return (
    `@echo off\r\n` +
    `setlocal DisableDelayedExpansion\r\n` +
    `cd /d "${pct(spec.buildDir)}"\r\n` +
    `"${pct(spec.makeExe)}" ${spec.makeArgs.join(' ')} 2>&1\r\n` +
    `exit /b %errorlevel%\r\n`
  );
}

/** phase 2: the dry run (`make -n -B all`) with stderr merged, like phase 1 —
 *  read by the tee script without echoing it. It must NOT use cmd append
 *  redirection: cmd writes the child's bytes in the system code page, which
 *  would leave the record's tail in ANSI while its head is UTF-8. */
export function buildDryRunCmdScript(spec: BuildWrapperSpec): string {
  return (
    `@echo off\r\n` +
    `setlocal DisableDelayedExpansion\r\n` +
    `cd /d "${pct(spec.buildDir)}"\r\n` +
    `"${pct(spec.makeExe)}" -n -B all 2>&1\r\n` +
    `exit /b %errorlevel%\r\n`
  );
}

/** the PowerShell script that tees phase 1 and appends phase 2 */
export function buildTeeScript(spec: BuildWrapperSpec, buildCmd: string, dryCmd: string): string {
  const label = echoSafeLabel(spec.label ?? '');
  return (
    `$ErrorActionPreference = 'Continue'\n` +
    // (re-)create the record's directory: a %TEMP% cleanup landing between
    // wrapper generation and launch would otherwise kill the build with
    // "could not find a part of the path" before make even starts
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psQuote(spec.recordFile)}) | Out-Null\n` +
    // which installation this build uses (mrvc.mrs2InstallPath /
    // mrvc.mrs3InstallPath are either-or — show the active one)
    (label ? `Write-Host ${psQuote('MRS: ' + label)}\n` : '') +
    // Windows PowerShell 5.1 (.NET Framework) exposes [Console]::Out as a
    // SyncTextWriter WITHOUT a settable AutoFlush — assigning it throws a
    // non-terminating "property not found" error into the task terminal while
    // the build carries on. Console.Out already flushes per line there; set the
    // property only where it exists (PowerShell 7 / .NET Core) so per-line
    // writes stay prompt there too.
    `$out = [Console]::Out\n` +
    `if ($null -ne $out.PSObject.Properties['AutoFlush']) { $out.AutoFlush = $true }\n` +
    `$writer = New-Object System.IO.StreamWriter(${psQuote(spec.recordFile)}, $false, (New-Object System.Text.UTF8Encoding($false)))\n` +
    // One reader for both phases: .NET pipes (not the PowerShell object
    // pipeline, which wraps every line in an object and costs ~0.7 ms/line)
    // and every echoed line is written straight through — batching was tried
    // and held the last lines back until the next one arrived, which is worse
    // than the per-line cost it saved. `$echo` off = the dry run, record only.
    `function Invoke-Make([string]$cmd, [bool]$echo) {\n` +
    `  $psi = New-Object System.Diagnostics.ProcessStartInfo\n` +
    `  $psi.FileName = $env:ComSpec\n` +
    `  $psi.Arguments = '/d /c "' + $cmd + '"'\n` +
    // Set-Location would NOT change the process working directory the child
    // inherits — WorkingDirectory is the one that does (the phase .cmd also
    // `cd /d`s; this keeps its cwd right even if it is ever run on its own)
    `  $psi.WorkingDirectory = ${psQuote(spec.buildDir)}\n` +
    `  $psi.UseShellExecute = $false\n` +
    `  $psi.RedirectStandardOutput = $true\n` +
    `  $psi.CreateNoWindow = $true\n` +
    `  $proc = [System.Diagnostics.Process]::Start($psi)\n` +
    `  $reader = $proc.StandardOutput\n` +
    `  while ($null -ne ($line = $reader.ReadLine())) {\n` +
    `    $writer.WriteLine($line)\n` +
    `    if ($echo) { [Console]::Out.WriteLine($line) }\n` +
    `  }\n` +
    `  $writer.Flush()\n` +
    `  $proc.WaitForExit()\n` +
    `  return $proc.ExitCode\n` +
    `}\n` +
    // the record ends with every command the makefile drives — record only
    `$code = Invoke-Make ${psQuote(buildCmd)} $true\n` +
    `$writer.WriteLine('')\n` +
    `$writer.WriteLine('===== All Build Commands (dry run: make -n -B) =====')\n` +
    `[void](Invoke-Make ${psQuote(dryCmd)} $false)\n` +
    `$writer.Flush()\n` +
    `$writer.Close()\n` +
    `exit $code\n`
  );
}

/** the .cmd launcher: find PowerShell, run the tee script, pass its exit code on */
export function buildLauncherScript(teeScriptPath: string): string {
  return (
    `@echo off\r\n` +
    // `!` is only safe with delayed expansion off — a parent environment can
    // turn it on (AutoRun / /v:on), which would eat `!` in the build path
    `setlocal DisableDelayedExpansion\r\n` +
    `set "PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"\r\n` +
    `if not exist "%PS%" echo MRVC: Windows PowerShell not found - cannot run the build & exit /b 9009\r\n` +
    `"%PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${pct(teeScriptPath)}"\r\n` +
    `exit /b %errorlevel%\r\n`
  );
}

/** the POSIX build script: one bash file does everything the three Windows
 *  files do. `make 2>&1 | tee record` streams every line to the terminal AND
 *  the record natively per line (no AutoFlush/SyncTextWriter concerns — and
 *  no code page can mistranslate the bytes); the dry run appends through the
 *  same redirection (byte-transparent), and PIPESTATUS keeps make's exit
 *  code alive across the pipe. The record directory is (re-)created first:
 *  same %TEMP%-cleanup immunity as the Windows tee script. */
export function buildPosixBuildScript(spec: BuildWrapperSpec): string {
  const label = echoSafeLabel(spec.label ?? '');
  const make = shQuote(spec.makeExe);
  return (
    `#!/usr/bin/env bash\n` +
    `# MRVC build wrapper (POSIX): live per-line output + full record; the dry\n` +
    `# run goes into the record only. Exit code = make's (PIPESTATUS).\n` +
    `record=${shQuote(spec.recordFile)}\n` +
    `cd ${shQuote(spec.buildDir)} || exit 1\n` +
    // (re-)create the record directory — a temp cleanup landing between
    // wrapper generation and launch must not kill the build
    `mkdir -p "$(dirname "$record")"\n` +
    (label ? `echo ${shQuote('MRS: ' + label)}\n` : '') +
    `rm -f "$record"\n` +
    `${make} ${spec.makeArgs.join(' ')} 2>&1 | tee "$record"\n` +
    `code=\${PIPESTATUS[0]}\n` +
    // the record ends with every command the makefile drives — record only
    `{\n` +
    `  echo ''\n` +
    `  echo '===== All Build Commands (dry run: make -n -B) ====='\n` +
    `  ${make} -n -B all 2>&1\n` +
    `} >> "$record"\n` +
    `exit $code\n`
  );
}

/** the POSIX clean script: make's output stays live, no record to preserve */
export function buildPosixCleanScript(spec: { buildDir: string; makeExe: string; args: string[]; label?: string }): string {
  const label = echoSafeLabel(spec.label ?? '');
  return (
    `#!/usr/bin/env bash\n` +
    `# MRVC clean wrapper (POSIX): live output, no record writes.\n` +
    `cd ${shQuote(spec.buildDir)} || exit 1\n` +
    (label ? `echo ${shQuote('MRS: ' + label)}\n` : '') +
    `${shQuote(spec.makeExe)} ${spec.args.join(' ')}\n` +
    `exit $?\n`
  );
}

/** the plain .cmd used by every clean path (make's output stays live) */
export function cleanWrapperScript(spec: { buildDir: string; makeExe: string; args: string[]; label?: string }): string {
  const label = echoSafeLabel(spec.label ?? '');
  return (
    `@echo off\r\n` +
    `setlocal DisableDelayedExpansion\r\n` +
    (label ? 'echo MRS: ' + label + '\r\n' : '') +
    `cd /d "${pct(spec.buildDir)}"\r\n` +
    `"${pct(spec.makeExe)}" ${spec.args.join(' ')}\r\n` +
    `exit /b %errorlevel%\r\n`
  );
}

/** write the build wrapper (Windows: launcher + tee script + phase .cmds;
 *  POSIX: a single bash script); returns the launcher to execute */
export function writeBuildTaskWrapper(projectRoot: string, spec: BuildWrapperSpec): string {
  if (process.platform !== 'win32') {
    const script = buildPosixWrapperFile(projectRoot);
    fs.writeFileSync(script, Buffer.from(buildPosixBuildScript(spec), 'utf-8'));
    try {
      fs.chmodSync(script, 0o755);
    } catch {
      // launched via `bash <script>` anyway — the exec bit is a convenience
    }
    return script;
  }
  const launcher = buildWrapperFile(projectRoot);
  const buildCmd = buildMakeCmdFile(projectRoot);
  const dryCmd = buildDryRunCmdFile(projectRoot);
  const script = buildTeeScriptFile(projectRoot);
  fs.writeFileSync(buildCmd, encodeArtifact(buildMakeCmdScript(spec)));
  fs.writeFileSync(dryCmd, encodeArtifact(buildDryRunCmdScript(spec)));
  fs.writeFileSync(script, encodePowerShellScript(buildTeeScript(spec, buildCmd, dryCmd)));
  fs.writeFileSync(launcher, encodeArtifact(buildLauncherScript(script)));
  return launcher;
}

/** write the clean wrapper; returns the launcher */
export function writeCleanTaskWrapper(
  projectRoot: string,
  spec: { buildDir: string; makeExe: string; args: string[]; label?: string }
): string {
  if (process.platform !== 'win32') {
    const script = buildPosixWrapperFile(projectRoot, 'clean');
    fs.writeFileSync(script, Buffer.from(buildPosixCleanScript(spec), 'utf-8'));
    try {
      fs.chmodSync(script, 0o755);
    } catch {
      // launched via `bash <script>` anyway — the exec bit is a convenience
    }
    return script;
  }
  const launcher = buildWrapperFile(projectRoot, 'clean');
  fs.writeFileSync(launcher, encodeArtifact(cleanWrapperScript(spec)));
  return launcher;
}
