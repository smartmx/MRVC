/**
 * Build-log location (pure Node) — mirrors MRS2's layout exactly so the two
 * tools read the same file: %TEMP%/mrs-cache/<projectName>-<md5(root)>/
 * with buildContentRecord.txt holding the full make output (writeProject-
 * BuildHistoryToTemp / showFullBuildOutput pair in MRS2).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

/** MRS2 getClangdWorkDir: %TEMP%/mrs-cache/<basename>-<md5(root)> */
export function buildWorkDir(projectRoot: string): string {
  const tmp = path.join(os.tmpdir(), 'mrs-cache');
  fs.mkdirSync(tmp, { recursive: true });
  const hash = crypto.createHash('md5').update(projectRoot).digest('hex');
  const dir = path.join(tmp, `${path.basename(projectRoot)}-${hash}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Location of the generated build wrapper. It must NOT live
 * in the build directory: the project path is user-controlled and may contain
 * cmd metacharacters (`EVT-IPV4&6` is a common EVT folder name) — VSCode hands
 * the command line to the terminal shell unquoted, and cmd splits the command
 * at every `&` ("...EVT-IPV4 is not recognized as an internal or external
 * command"). A hash-named file under %TEMP% is pure ASCII with no
 * metacharacters; the wrapper itself `cd /d "<buildDir>"` with quoting.
 */
export function buildWrapperFile(projectRoot: string, kind: 'build' | 'clean' = 'build'): string {
  const dir = path.join(os.tmpdir(), 'mrs-build');
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('md5').update(projectRoot).digest('hex');
  return path.join(dir, `${hash}${kind === 'clean' ? '-clean' : ''}.cmd`);
}

/** full-output record for a project (MRS2 buildContentRecord.txt) */
export function buildRecordFile(projectRoot: string): string {
  return path.join(buildWorkDir(projectRoot), 'buildContentRecord.txt');
}
