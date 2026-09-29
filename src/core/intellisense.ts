/**
 * compile_commands.json entry builders (pure Node) — feed IntelliSense
 * (cpptools / clangd) with each project's real macros and include paths,
 * taken from the exact same option model the makefile generator uses.
 *
 * Entries are classified by CROSS-PROJECT REFERENCE COUNT (absolute file):
 *   shared  — compiled by exactly ONE loaded project: its parse parameters
 *             are deterministic, so the entry goes to _shared.json and the
 *             file browses correctly under any project context
 *   context — compiled by SEVERAL projects whose parameters may differ
 *             (the shared SRC tree with per-project -D/-I): each project
 *             keeps its own variant; the active project's variants are
 *             exposed through _active.json and swap on context switch
 * Every per-project database covers the WHOLE context class (own entries
 * plus deterministic fallback entries), so _shared ∪ _active contains every
 * source file at all times — browsing can never hit a "not found in
 * compile_commands.json" state.
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

/** win32-stable file identity (case-insensitive absolute path) */
function fileKey(file: string): string {
  return path.resolve(file).toLowerCase();
}

/**
 * One entry per scanned source file — ALL files the project compiles,
 * regardless of where they physically live (project root or linked
 * folder); classification happens later, across projects.
 */
export function buildCompileEntries(cp: Cproject, tc: ToolchainInfo): CompileCommandEntry[] {
  const map = scanSources(cp);
  const out: CompileCommandEntry[] = [];
  for (const [, files] of map.entries()) {
    for (const f of files) {
      out.push(makeEntry(cp, tc, kindOf(f.logicName), f.fullpath));
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

export interface ReferenceSplit {
  /** files referenced by exactly one project — their sole entry */
  sharedEntries: CompileCommandEntry[];
  /** aligned with the input order: each project's entries for the files
   * that several projects reference (the context-sensitive class) */
  contextEntries: CompileCommandEntry[][];
}

/**
 * Split every project's entries by how many projects reference each file:
 * a file compiled by one project only has deterministic parameters and is
 * always parseable (shared); a file compiled by several projects may need
 * different parameters per project (context — switched via _active.json).
 */
export function partitionByReference(perProject: CompileCommandEntry[][]): ReferenceSplit {
  const perProjectMaps = perProject.map((list) => {
    const m = new Map<string, CompileCommandEntry>();
    for (const e of list) if (!m.has(fileKey(e.file))) m.set(fileKey(e.file), e);
    return m;
  });
  const refCount = new Map<string, number>();
  for (const m of perProjectMaps) for (const k of m.keys()) refCount.set(k, (refCount.get(k) ?? 0) + 1);

  const sharedEntries: CompileCommandEntry[] = [];
  for (const m of perProjectMaps) {
    for (const [k, e] of m) if ((refCount.get(k) ?? 0) === 1) sharedEntries.push(e);
  }
  sharedEntries.sort((a, b) => a.file.localeCompare(b.file));

  const contextEntries = perProjectMaps.map((m) => {
    const list: CompileCommandEntry[] = [];
    for (const [k, e] of m) if ((refCount.get(k) ?? 0) > 1) list.push(e);
    list.sort((a, b) => a.file.localeCompare(b.file));
    return list;
  });
  return { sharedEntries, contextEntries };
}

/**
 * Turn the per-project context entries into self-sufficient databases:
 * project i's database = its own context entries PLUS canonical fallback
 * entries (from the referencing project with the lowest root path) for
 * every context-class file project i does not compile itself. Each
 * database therefore covers the entire context class, so copying ANY of
 * them over _active.json keeps every multi-referenced file resolvable.
 */
export function contextDatabases(contextEntries: CompileCommandEntry[][], roots: string[]): CompileCommandEntry[][] {
  // canonical entry per context-class file: first project in sorted-root order
  const order = contextEntries.map((_, i) => i).sort((a, b) => roots[a].toLowerCase().localeCompare(roots[b].toLowerCase()));
  const canonical = new Map<string, CompileCommandEntry>();
  for (const i of order) {
    for (const e of contextEntries[i]) {
      const k = fileKey(e.file);
      if (!canonical.has(k)) canonical.set(k, e);
    }
  }
  return contextEntries.map((own) => {
    const ownKeys = new Set(own.map((e) => fileKey(e.file)));
    const out = [...own];
    for (const [k, e] of canonical) if (!ownKeys.has(k)) out.push(e);
    out.sort((a, b) => a.file.localeCompare(b.file));
    return out;
  });
}
