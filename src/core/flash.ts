/**
 * Flash script builder (pure Node). Produces the OpenOCD cfg used for
 * downloading and the argv for the openocd invocation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MrsProject } from '../vscode/projects';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{1,8}$/;

export interface FlashOptions {
  address: string;
  verify: boolean;
  reset: boolean;
  boardCfg: string;
  firmware: string;
}

export interface FlashPlan {
  scriptPath: string;
  args: string[];
}

/** Build (and write) the OpenOCD flash script; returns the argv to run. */
export function prepareFlash(project: MrsProject, opts: FlashOptions): FlashPlan {
  if (!ADDRESS_RE.test(opts.address)) {
    throw new Error(`Invalid flash address "${opts.address}" (expected form 0x00000000)`);
  }
  const steps = [`wlink_set_address ${opts.address}`];
  const prog = ['program', opts.firmware];
  if (opts.verify) prog.push('verify');
  if (opts.reset) prog.push('reset');
  prog.push('exit');
  steps.push(prog.join(' '));

  const scriptPath = path.join(project.buildDir, 'mrs2_flash.cfg');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, steps.join('\n') + '\n', 'utf-8');
  return { scriptPath, args: ['-f', opts.boardCfg, '-f', scriptPath] };
}
