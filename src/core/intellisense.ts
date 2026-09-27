/**
 * compile_commands.json entry builders (pure Node) — feed IntelliSense
 * (cpptools / clangd) with each project's real macros and include paths,
 * taken from the exact same option model the makefile generator uses.
 *
 * Entries are SPLIT by origin:
 *   private — files physically inside the project root (Main.c, User/, ...)
 *   shared  — files reached through linked folders (the shared SRC tree)
 * The active compile_commands.json = the selected project's private entries
 * + the merged shared entries; switching projects only swaps the private
 * part, the shared part stays stable.
 */
import * as path from 'path';
import { Cproject } from './cproject';
import { ToolchainInfo } from './toolchain';
import { scanSources } from './scan';
import { intellisenseArgs } from './flags';

export interface CompileCommandEntry {
  directory: string;
  file: string;
  arguments: string[];
}

export interface SplitEntries {
  privateEntries: CompileCommandEntry[];
  sharedEntries: CompileCommandEntry[];
}

const ASM_EXTS = new Set(['s', 'S']);
const CPP_EXTS = new Set(['cpp', 'C', 'cc', 'cxx']);

function makeEntry(cp: Cproject, tc: ToolchainInfo, kind: 'c' | 'cpp' | 'asm', file: string): CompileCommandEntry {
  const compiler = kind === 'cpp' ? tc.compilerCpp : tc.compilerC;
  return {
    directory: cp.projectRoot,
    file: path.resolve(file),
    arguments: [path.resolve(compiler), ...intellisenseArgs(cp, kind), path.resolve(file)],
  };
}

function kindOf(logicName: string): 'c' | 'cpp' | 'asm' {
  const ext = logicName.slice(logicName.lastIndexOf('.') + 1);
  return ASM_EXTS.has(ext) ? 'asm' : CPP_EXTS.has(ext) ? 'cpp' : 'c';
}

/**
 * One entry per scanned source file, split by origin: files under the
 * project root are PRIVATE, files under any linked folder are SHARED.
 */
export function buildCompileEntries(cp: Cproject, tc: ToolchainInfo): SplitEntries {
  const map = scanSources(cp);
  const out: SplitEntries = { privateEntries: [], sharedEntries: [] };
  for (const [dir, files] of map.entries()) {
    const isShared = dir !== '' && cp.linkedFolders.has(dir);
    for (const f of files) {
      const e = makeEntry(cp, tc, kindOf(f.logicName), f.fullpath);
      (isShared ? out.sharedEntries : out.privateEntries).push(e);
    }
  }
  out.privateEntries.sort((a, b) => a.file.localeCompare(b.file));
  out.sharedEntries.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/**
 * Merge shared entries from many projects: dedupe by file; for files that
 * several projects share, merge their argument sets (define/include union)
 * so the shared file parses correctly in every project's context — header
 * guards make the superset safe.
 */
export function mergeSharedEntries(perProject: CompileCommandEntry[][]): CompileCommandEntry[] {
  const byFile = new Map<string, CompileCommandEntry>();
  for (const list of perProject) {
    for (const e of list) {
      const prev = byFile.get(e.file);
      if (!prev) {
        byFile.set(e.file, { ...e, arguments: [...e.arguments] });
        continue;
      }
      // union of arguments (order-insensitive flags; keep first order then append new)
      const set = new Set(prev.arguments);
      for (const a of e.arguments) if (!set.has(a)) prev.arguments.push(a);
    }
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}
