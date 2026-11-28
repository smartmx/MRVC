/**
 * CDT-style makefile generator: writes makefile / sources.mk / objects.mk /
 * <dir>/subdir.mk into the build (config) directory. Byte-compatible with
 * the MounRiver Studio goldens of both generations (2.1.0 by default at
 * runtime; pass `mrs2Style: false` for the legacy 1.9.2 layout — golden
 * checks do). Also writes analysis data files when enabled.
 * Pure Node — no vscode imports.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ansiArtifactEncoding, decodeArtifact, encodeArtifact } from './platformEncoding';
import { recordWrittenFiles } from './outputHistory';
import { analysisFlags } from './analysis';
import { Cproject } from './cproject';
import { LogicDirMap, dirGroups, extGroups, scanSources, assertScannableLinkedFolders } from './scan';
import { toPosix, resolveLocationUri } from './macros';
import {
  assemblerOptions,
  cCompilerOptions,
  cppCompilerOptions,
  cLinkerOptions,
  cppLinkerOptions,
  commonOptions,
  listingOptions,
  objCopyOptions,
  flashExtensions,
  userObjects,
  userLibs,
  wchLibsOptions,
  linkerMapName,
} from './flags';
import { ToolchainInfo } from './toolchain';

const RULE = '################################################################################\n';
const HEADER = (tool: string) => RULE + `# ${tool}\n# Automatically-generated file. Do not edit!\n` + RULE;

const POSIX = (p: string) => toPosix(p);
/** escape spaces for make */
const ESC = (p: string) => toPosix(p).replace(/\$/g, '$$$$').split(' ').join('\\ ');

/**
 * Escape a literal `$` for the makefile level, leaving make-syntax tokens
 * alone. make expands `$x` sequences itself before the shell ever sees the
 * recipe line, so a user-supplied `$` (an -I/-L/-T/-D path, a macro value)
 * must be doubled for make to emit one real dollar. Tokens that are make
 * syntax rather than user text must survive verbatim:
 *   automatic variables   $@ (the .o being built), $<, $^, $*, $?
 *   variable references   $(VAR) / ${VAR} written in user option text
 * CDT's listing flag -Wa,-adhlns="$@.lst" is the case that matters: it
 * names the .lst after `$@`, and doubling it to `$$@` makes the shell see
 * an empty `$@`, so every listing silently collapses onto a bare ".lst"
 * (and the bytes stop matching MRS2's single-$ output).
 */
export function escapeMakeDollars(s: string): string {
  return s.replace(/\$(?![<@^*?({])/g, '$$$$');
}

/** join a block: "VAR += \\\n a \\\n b \n\n" (last entry loses its backslash) */
function varBlock(name: string, entries: string[], crlfValues = false): string {
  if (!entries.length) return '';
  // 2.x goldens end every line (name, values) with CRLF; 1.x uses bare LF
  // for all of it. writeMk's post-processing turns `\` + LF back into a
  // continuation (bare LF), so the name/continuation lines must carry `\n`
  // here and get their CR from writeMk's first replace — matching goldens.
  const eol = crlfValues ? '\r\n' : '\n';
  let t = `${name} += \\${eol}`;
  for (const e of entries) {
    t += `${e} \\${eol}`;
  }
  return t.slice(0, t.lastIndexOf('\\')) + eol + eol;
}

export interface GenerateResult {
  files: string[];
  dirs: string[];
  sourceCount: number;
}

/** Reject any write target that escapes the build directory. */
function assertInsideBuildDir(buildDir: string, target: string): void {
  const resolved = path.resolve(target);
  const base = path.resolve(buildDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`refusing to write outside build dir: ${resolved}`);
  }
}

export function generateMakefiles(
  cp: Cproject,
  tc: ToolchainInfo,
  opts: { headerTool?: string; analysis?: boolean; mrs2Style?: boolean; autoMathLib?: boolean; goldenSizTarget?: boolean } = {}
): GenerateResult {
  const buildDir = path.join(cp.projectRoot, cp.configName);
  fs.mkdirSync(buildDir, { recursive: true });
  // Path characters each layer can actually carry (all verified against the
  // bundled make.exe with the real sh-on-PATH build env):
  //   project root  "(" ")" ";" "%" "#": the makefile text only carries
  //     RELATIVE paths (prereqs) and QUOTED absolute flag arguments — the
  //     flag builders emit `-I"path"` / `-isystem"path"` / `-include"path"`
  //     and -T/-L go through the same quoting, so the root's own characters
  //     never reach a rule word or an unquoted argument.
  //   linked folders ";" "#" "`": linked files get PER-FILE rules whose prereqs
  //     are the ABSOLUTE target paths (MRS2 parity — the 1.9.2 goldens emit
  //     absolute prereqs for linked trees too), so the root's own ";" / "#"
  //     ride along into rule words where make breaks them (";" starts an
  //     inline recipe, "#" starts a comment) — and a backtick in a QUOTED
  //     -I argument command-substitutes inside the recipe's sh. A hostile
  //     root therefore makes EVERY linked folder under it unbuildable —
  //     rejected up front; MRS2 generates the same makefile (it even rewrites
  //     "#" to "%" — a wrong path — and still fails) with a cryptic error.
  //     Linkless projects with a hostile root are fine (relative words only).
  //   "%" is safe everywhere (literal in non-pattern rule words).
  const linkedHostile = /[;#`]/;
  // the project ROOT: a backtick cannot survive any build — it lands inside
  // the QUOTED absolute flag arguments (-I"path") and the recipe's sh
  // command-substitutes backticks within double quotes ("EOF in backquote
  // substitution"), linkless or not. ";" "#" "%" are fine for a linkless
  // root (relative words + quoted args).
  const rootHostile = /[`]/;
  const checkHostile = (p: string, linked: boolean): void => {
    if (linked && linkedHostile.test(p)) {
      throw new Error(
        `Linked folder path contains a character that a makefile rule cannot express (";", "#" or "` + '`' + `"): "${p}" — ` +
        `rename the folder or move it to a path without it (parentheses and "%" are fine).`
      );
    }
    if (!linked && rootHostile.test(p)) {
      throw new Error(
        `Project path contains a backtick: "${p}" — recipes run through the make bundle's sh, which ` +
        `command-substitutes backticks inside the quoted compiler arguments. ` +
        `Rename the folder or move the project to a path without it.`
      );
    }
  };
  checkHostile(cp.projectRoot, false);
  for (const loc of cp.linkedFolders.values()) {
    checkHostile(resolveLocationUri(cp.projectRoot, loc), true);
  }
  const headerTool = opts.headerTool ?? 'Generated by mrvc';
  // older CDT generations (MRS 1.x goldens, e.g. HarmonyOS) emit each
  // *_DEPS block right after its *_SRCS; newer ones group OBJS between
  // all SRCS and all DEPS blocks
  // mrs2Style selects the MRS2 2.x template generation and is the RUNTIME
  // DEFAULT (MRS 1.9.2 is end-of-life); it governs several
  // independent differences at once (EOL style, recipe @ prefix, DEPS
  // include order, head layout, all/main-build) — each branch documents
  // its own piece, so this single flag stays the only switch needed.
  // Pass false only to reproduce the legacy 1.9.2 layout (golden checks).
  const mrs2Style = opts.mrs2Style ?? true;
  // The forced `-lm` (see objects.mk below) appeared in MRS 2.3.0: every
  // 2.3.0/2.4.0/2.5.0 sample emits it, every 1.8.5–2.2.18 sample does not.
  // The runtime default is on (it emulates the installed 2.5.x); the golden
  // harness turns it off for goldens older than 2.3.0.
  const autoMathLib = opts.autoMathLib ?? true;
  // Historical MRS goldens emit `<target>.siz` in SECONDARY_SIZE & clean; at
  // runtime the print-size recipe prints to stdout and never creates a .siz
  // file, so using a .PHONY goal avoids deleting a user-saved `<target>.siz`
  // during `clean` / output cleanup (review round8 P1-A).
  const goldenSizTarget = opts.goldenSizTarget ?? false;

  const isCpp = cp.isCpp;
  // round18 P2-1: scanSources silently skips linked folders whose target is
  // missing — refuse up-front so a stale EVT link can never produce a
  // "successful" makefile missing an entire linked source tree (extension
  // F7 / Build All / Rebuild All parity with the MCP gate)
  assertScannableLinkedFolders(cp);
  const map: LogicDirMap = scanSources(cp);
  const dirsDesc = [...map.keys()].sort((a, b) => (a > b ? -1 : 1));
  const dirsAsc = [...map.keys()].sort((a, b) => (a > b ? 1 : -1));

  const target = cp.outputPrefix + cp.targetName;
  const compilerC = path.basename(tc.compilerC);
  const compilerCpp = path.basename(tc.compilerCpp);
  const linker = isCpp ? path.basename(tc.linkerCpp) : path.basename(tc.linkerC);
  const ar = tc.prefix + 'ar';
  const objcopy = path.basename(tc.objcopy);
  const objdump = path.basename(tc.objdump);
  const sizeTool = path.basename(tc.size);

  const style = mrs2Style ? ('2x' as const) : ('1x' as const);
  const escMakeDollars = escapeMakeDollars;
  // analysis builds add -fstack-usage (.su per function) and -fdump-rtl-expand
  // (call dumps) to every compile line. MRS2 emits the dump flag right after
  // `-fmax-errors=20` in the target-flag section — in the 2.x style it joins
  // `common` there instead of the per-tool options tail; the 1.x style keeps
  // the pre-2.x behavior of putting both flags on the per-tool tail (no 1.x
  // oracle for analysis, unchanged since 0.1.4).
  const analysisAll = opts.analysis ? analysisFlags() : [];
  const dumpFlag = analysisAll.find((f) => f.startsWith('-fdump')) ?? '';
  const tailFlags = analysisAll.filter((f) => !f.startsWith('-fdump') || style === '1x');
  // commonOptions carries the user's target/optimization/warnings/debugging
  // "other" free text — same `$`-escaping contract as the per-tool option
  // strings below (a bare `$` would be eaten by make as a variable)
  let common = escMakeDollars(commonOptions(cp, tc.name, style));
  if (dumpFlag && style === '2x') {
    common = common.replace(' -fmax-errors=20', ` -fmax-errors=20 ${dumpFlag}`);
  }
  const extra = tailFlags.length ? ` ${tailFlags.join(' ')}` : '';
  // per-tool option strings go through escMakeDollars (see its comment):
  // user `$` escaped, make tokens ($@/$(VAR)) preserved. The analysis tail
  // is appended AFTER escaping so its own text stays engine-generated.
  const cOpts = escMakeDollars(cCompilerOptions(cp, false, style)) + extra;
  const cppOpts = escMakeDollars(cppCompilerOptions(cp, false, style)) + extra;
  const asmOpts = escMakeDollars(assemblerOptions(cp, false, style)) + extra;
  const ldOpts = isCpp
    ? escMakeDollars(cppLinkerOptions(cp, style, buildDir))
    : escMakeDollars(cLinkerOptions(cp, style, buildDir));
  // A backtick cannot survive ANY recipe: the flag builders emit QUOTED
  // absolute arguments (-I"path" / -T"path" / -L"path"), and the recipe's sh
  // command-substitutes backticks even inside double quotes. Includes,
  // linker scripts, library paths and user "other" options all flow through
  // these strings, so one check here covers every external path the
  // per-root/per-link prechecks above cannot see.
  if ((common + cOpts + cppOpts + asmOpts + ldOpts).includes('`')) {
    throw new Error(
      `Compiler/linker flags contain a backtick (from an include path, linker script, library path or option) — ` +
      `recipes run through the make bundle's sh, which command-substitutes backticks inside quotes. ` +
      `Rename the folder or path to remove it.`
    );
  }
  const userObjs = userObjects(cp);
  // "Other objects" entries are absolute make words AND expand unquoted
  // inside the link recipe — so both layers constrain them: make words break
  // at ";" / "#" / backtick, and the unquoted shell expansion breaks at
  // "&" / "(" / ")" / "'" plus GLOB expansion of "[" / "]" (a "[12]" entry
  // silently matches an unrelated "ext1" directory and links the wrong
  // object). Entries carrying any of these are rejected up front (the
  // project's own objects are relative words and always safe).
  const userObjHostile = /[;#`&()'\[\]]/;
  if (userObjs.length && userObjs.some((o) => userObjHostile.test(o))) {
    throw new Error(
      `Other Objects (USER_OBJS) paths contain characters that cannot be carried through the ` +
      `makefile and its shell (";", "#", a backtick, "&", "(", ")", "'", "[", "]"): ` +
      `${userObjs.find((o) => userObjHostile.test(o))} — move the objects to a path without them.`
    );
  }
  const libs = userLibs(cp);
  // Library entries become "-l<name>" words AND expand unquoted inside the
  // link recipe ($(LIBS)) — data, not command text. A name carrying shell
  // separators (";" "&" quotes parentheses backtick "$" whitespace, ...)
  // would execute or corrupt the link command, so the accepted set is a
  // strict allowlist (letters, digits, "._+-" — covers printf/printfloat/
  // IQmath_RV32 and every conventional -l name). Paths belong in the
  // library-search-paths list, not here.
  const libBad = libs.find((l) => !/^[A-Za-z0-9._+-]+$/.test(l));
  if (libBad !== undefined) {
    throw new Error(
      `Library name "${libBad}" contains characters that cannot be carried safely through the ` +
      `makefile and its shell — library entries may use letters, digits and "._+-" only ` +
      `(library file paths belong in the library search paths list instead).`
    );
  }
  const wchLibs = wchLibsOptions(cp, tc.name);

  const written: string[] = [];
  const writtenRels: string[] = [];
  let sourceCount = 0;

  const writeMk = (rel: string, content: string) => {
    const base = path.resolve(buildDir);
    const file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) {
      throw new Error(`refusing to write outside build dir: ${file}`);
    }
    // Final safety net across EVERY channel (library names, post-build and
    // post-process options, source file names, user flags): a backtick in any
    // generated byte reaches the recipe's sh and command-substitutes even
    // inside double quotes. Legitimate makefiles never contain one — reject
    // at generation instead of executing a stranger's command during make.
    if (content.includes('`')) {
      throw new Error(
        `The generated makefile (${rel}) would contain a backtick — via a library name, build option or file name — ` +
        `and recipes run through the make bundle's sh, which command-substitutes backticks even inside double quotes. ` +
        `Rename the offending path, library or option.`
      );
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // MRS makefiles use CRLF everywhere EXCEPT backslash continuation
    // lines, which end with a bare LF. Reproduce that mix byte-for-byte.
    // 2.x additionally lowercases every drive letter (golden: "f:/..." /
    // "f:\..." everywhere) — the letter must start a token (preceded by
    // whitespace/a quote/an assignment/end of line), otherwise .PHONY: would
    // become .PHONy:. Known limitation: glued paths like `-LF:/lib` or
    // `-Wl,-Map,F:/m.map` are NOT converted (no such form in any golden);
    // if a future .cproject emits one, the 2.x byte-compare will flag it.
    const lowerDrives = (s: string): string =>
      s.replace(/(^|[\s"'=])([A-Za-z]):/g, (_m, pre: string, drv: string) => pre + drv.toLowerCase() + ':');
    const native = mrs2Style
      ? lowerDrives(content).replace(/\n/g, '\r\n')
      : content.replace(/\n/g, '\r\n').replace(/\\\r\n/g, '\\\n');
    // make/gcc read these files through the ANSI code page (GBK on Chinese
    // Windows): UTF-8 bytes in a non-ASCII project path turn to mojibake and
    // every #include fails with "No such file or directory" (MRS2 writes
    // them in the platform encoding for the same reason). GBK is an ASCII
    // superset — pure-ASCII content stays byte-identical.
    fs.writeFileSync(file, encodeArtifact(native));
    written.push(file);
    writtenRels.push(toPosix(rel));
  };

  const canonicalGroups = extGroups(isCpp);
  const recipeFor = (g: (typeof canonicalGroups)[number]): string => {
    const compiler = g.isCppFile ? compilerCpp : compilerC;
    const toolOpts = g.isAsm ? asmOpts : g.isCppFile ? cppOpts : cOpts;
    if (mrs2Style) {
      // 2.x goldens: single @ prefix and NO tail line — `common` (built in
      // the 2.x style) already carries -fmax-errors=20 and the verbatim
      // target.other spacing
      return `\t@\t${compiler}${common}${toolOpts} -MMD -MP -MF"$(@:%.o=%.d)" -MT"$(@)" -c -o "$@" "$<"\n`;
    }
    return `\t@\t@\t${compiler}${common}${toolOpts} -MMD -MP -MF"$(@:%.o=%.d)" -MT"$(@)" -c -o "$@" "$<"\n\t@\t@\n`;
  };

  // ---------------- subdir.mk per logic dir (descending order) ----------------
  for (const dir of dirsDesc) {
    const files = map.get(dir)!;
    sourceCount += files.length;
    // per-dir compile groups: canonical exts in CDT order, case-variant C++
    // suffixes as their own groups (deduped variable names) — see dirGroups
    const groups = dirGroups(files, isCpp);

    const projPosix = toPosix(cp.projectRoot);
    // a logic dir can MIX real and linked-out files (a hand-written .project
    // may link a target under the same name as a real folder — the CDT UI
    // refuses, the XML doesn't): judging by the first file only put the dir
    // on the pattern rule `dir/%.o: ../dir/%.ext`, which then targeted a
    // nonexistent ../dir for the external members (or vice versa). ANY
    // external member forces the per-file rules, which are correct for
    // every file regardless of where it lives.
    const isExternal = files.some((f) => !(path.posix.dirname(f.fullpath) + '/').startsWith(projPosix + '/'));

    let body =
      HEADER(headerTool) +
      '\n' +
      '# Add inputs and outputs from these tool invocations to the build variables \n';

    let vars = '';
    // CDT emits two block orders across its generations: newer projects
    // interleave DEPS right after each SRCS group; older ones put all
    // *_SRCS first, then OBJS, then all *_DEPS. make is indifferent, but
    // the byte-compare against the golden build is not.
    if (mrs2Style) {
      for (const g of groups) {
        const group = g.files;
        if (!group.length) continue;
        const srcs = group.map((f) => ESC(isExternal ? f.fullpath : path.posix.join('..', f.logicName)));
        vars += varBlock(`${g.variable}_SRCS`, srcs);
        vars += varBlock(
          `${g.variable}_DEPS`,
          group.map((f) => `./${ESC(stripExt(f.logicName))}.d`)
        );
      }
      vars += varBlock(
        'OBJS',
        files.map((f) => `./${ESC(stripExt(f.logicName))}.o`)
      );
    } else {
      for (const g of groups) {
        const group = g.files;
        if (!group.length) continue;
        const srcs = group.map((f) => ESC(isExternal ? f.fullpath : path.posix.join('..', f.logicName)));
        vars += varBlock(`${g.variable}_SRCS`, srcs);
      }
      vars += varBlock(
        'OBJS',
        files.map((f) => `./${ESC(stripExt(f.logicName))}.o`)
      );
      for (const g of [...groups].reverse()) {
        const group = g.files;
        if (!group.length) continue;
        vars += varBlock(
          `${g.variable}_DEPS`,
          group.map((f) => `./${ESC(stripExt(f.logicName))}.d`)
        );
      }
    }

    let rules = '';
    for (const g of groups) {
      const group = g.files;
      if (!group.length) continue;
      if (isExternal) {
        for (const f of group) {
          const base = path.posix.basename(stripExt(f.logicName));
          const obj = dir ? `${dir}/${base}.o` : `${base}.o`;
          // ESC the prereq: external linked trees may contain spaces (an
          // unescaped space splits the prerequisite list); `$` doubles to
          // keep make from reading it as a variable reference. Paths without
          // either are byte-identical to the goldens.
          rules += `${ESC(obj)}: ${ESC(f.fullpath)}\n${recipeFor(g)}`;
        }
      } else {
        const prereqDir = ESC(path.posix.normalize(path.posix.join('..', dir)));
        const pat = dir ? `${dir}/%.o: ${prereqDir}/%.${g.ext}` : `%.o: ${prereqDir}/%.${g.ext}`;
        rules += `${pat}\n${recipeFor(g)}`;
        for (const f of group) {
          if (f.logicName.includes(' ')) {
            rules += `${ESC(stripExt(f.logicName))}.o: ${ESC(path.posix.join('..', f.logicName))}\n${recipeFor(g)}`;
          }
        }
      }
    }
    if (rules.length) {
      // 1.x always separates the rules block from the file end with a blank
      // line; the 2.x golden does so only for external-source directories
      // (per-file rules — the StdPeriphDriver golden ends with a blank line
      // while every in-project subdir ends right after its recipe)
      if (!mrs2Style || isExternal) rules += '\n';
    }

    // 2.x goldens put two blank lines between the vars and the comment
    body += vars + (mrs2Style ? '\n\n' : '\n') + '# Each subdirectory must supply rules for building sources it contributes\n' + rules;
    writeMk(path.posix.join(dir, 'subdir.mk'), body);
  }

  // ---------------- objects.mk ----------------
  {
    // 2.x golden: no blank line after the header and no trailing newline —
    // the file ends right after the LIBS line
    let t = HEADER(headerTool) + (mrs2Style ? '' : '\n');
    t += 'USER_OBJS :=';
    for (const o of userObjs) {
      // unquoted: this make port mis-parses quoted absolute paths ("F:\...")
      // on the expanded target line (drive-letter colon heuristic fails)
      t += ` ${ESC(o)}`;
    }
    t += '\n\nLIBS :=';
    if (cp.artifactType === 'exe') {
      for (const lib of libs) {
        t += ` -l${lib}`;
      }
      // MRS 2.3.0+ forces the math library in: unless the configured list
      // already names "m", `-lm` is appended after it. Without it, any
      // --whole-archive archive that calls fabs/sqrt (libcjson in the
      // LiteOS example) fails with an undefined reference on chips without
      // hardware FP. The WCH helper libs (-lIQmath_RV32, -lprintf,
      // -lprintfloat) do NOT live here — MRS2 passes them on the recipe
      // right after `$(LIBS)`.
      if (autoMathLib && !libs.includes('m')) t += ' -lm';
    }
    if (!mrs2Style) t += '\n\n';
    writeMk('objects.mk', t);
  }

  // ---------------- sources.mk ----------------
  {
    const flashVar = cp.createFlash && cp.artifactType === 'exe';
    const listVar = cp.createListing && cp.artifactType === 'exe';
    const sizeVar = cp.printSize && cp.artifactType === 'exe';
    // 2.x golden declares the dep groups first, then OBJS, then the source
    // groups, then the SECONDARY markers, with no space after `:=`; 1.x
    // leads with the source groups and pads `:= ` (both goldens matched)
    const initVars = mrs2Style
      ? [
          'S_DEPS',
          'S_UPPER_DEPS',
          'ASM_DEPS',
          'ASM_UPPER_DEPS',
          'C_DEPS',
          ...(isCpp ? ['C_UPPER_DEPS', 'CPP_DEPS', 'CXX_DEPS', 'CC_DEPS', 'C++_DEPS'] : []),
          'OBJS',
          'ELF_SRCS',
          'OBJ_SRCS',
          'O_SRCS',
          'S_SRCS',
          'S_UPPER_SRCS',
          'ASM_SRCS',
          'ASM_UPPER_SRCS',
          'C_SRCS',
          ...(isCpp ? ['C_UPPER_SRCS', 'CPP_SRCS', 'CXX_SRCS', 'C++_SRCS', 'CC_SRCS'] : []),
          ...(flashVar ? ['SECONDARY_FLASH'] : []),
          ...(listVar ? ['SECONDARY_LIST'] : []),
          ...(sizeVar ? ['SECONDARY_SIZE'] : []),
        ]
      : [
          'ELF_SRCS',
          'OBJ_SRCS',
          'S_SRCS',
          'ASM_UPPER_SRCS',
          'ASM_SRCS',
          ...(isCpp ? ['C_UPPER_SRCS', 'CPP_SRCS', 'CXX_SRCS', 'C++_SRCS', 'CC_SRCS'] : []),
          'C_SRCS',
          'S_UPPER_SRCS',
          'O_SRCS',
          'ASM_UPPER_DEPS',
          'OBJS',
          ...(flashVar ? ['SECONDARY_FLASH'] : []),
          ...(listVar ? ['SECONDARY_LIST'] : []),
          ...(sizeVar ? ['SECONDARY_SIZE'] : []),
          'ASM_DEPS',
          'S_DEPS',
          'S_UPPER_DEPS',
          'C_DEPS',
          ...(isCpp ? ['C_UPPER_DEPS', 'CPP_DEPS', 'CXX_DEPS', 'CC_DEPS', 'C++_DEPS'] : []),
        ];
    let t = HEADER(headerTool) + '\n';
    for (const v of initVars) {
      t += mrs2Style ? `${v} :=\n` : `${v} := \n`;
    }
    t += '\n# Every subdirectory with source files must be described here\nSUBDIRS := \\\n';
    for (const d of dirsAsc) {
      t += `${POSIX(d)} \\\n`;
    }
    // 2.x golden ends right after the last SUBDIRS entry (no blank line)
    if (!mrs2Style) t += '\n';
    writeMk('sources.mk', t);
  }

  // ---------------- main makefile ----------------
  {
    const isExe = cp.artifactType === 'exe';
    const flashExts = flashExtensions(cp);
    const flashVar = isExe && cp.createFlash;
    const listVar = isExe && cp.createListing;
    const sizeVar = isExe && cp.printSize;
    const hasSecondaries = flashVar || listVar || sizeVar;

    // 2.x generation orders the DEPS includes S_DEPS-first; 1.x leads with
    // the assembler variants (both goldens matched respectively). The
    // canonical list below is byte-frozen for the goldens; case-variant
    // suffixes (.cp, .c++, mixed .cxx/.Cxx) get their OWN deduped variables
    // from dirGroups and are appended after it (P2-3: without the include a
    // header change never reached those objects, and without the clean entry
    // their .d files survived `make clean`).
    const baseDepVars = mrs2Style
      ? isCpp
        ? ['S_DEPS', 'S_UPPER_DEPS', 'ASM_DEPS', 'ASM_UPPER_DEPS', 'C_DEPS', 'C_UPPER_DEPS', 'CPP_DEPS', 'CXX_DEPS', 'CC_DEPS', 'C++_DEPS']
        : ['S_DEPS', 'S_UPPER_DEPS', 'ASM_DEPS', 'ASM_UPPER_DEPS', 'C_DEPS']
      : isCpp
        ? ['ASM_UPPER_DEPS', 'ASM_DEPS', 'S_DEPS', 'S_UPPER_DEPS', 'C_DEPS', 'C_UPPER_DEPS', 'CPP_DEPS', 'CXX_DEPS', 'CC_DEPS', 'C++_DEPS']
        : ['ASM_UPPER_DEPS', 'ASM_DEPS', 'S_DEPS', 'S_UPPER_DEPS', 'C_DEPS'];
    const canonicalDepVars = new Set(baseDepVars);
    const extraDepVars: string[] = [];
    for (const d of dirsDesc) {
      for (const g of dirGroups(map.get(d)!, isCpp)) {
        const v = `${g.variable}_DEPS`;
        if (!canonicalDepVars.has(v) && !extraDepVars.includes(v)) extraDepVars.push(v);
      }
    }
    const depVars = [...baseDepVars, ...extraDepVars];

    // head layout differs by generation: 1.9.2 has a blank line after the
    // header; 2.1.0 does not (the `RM :=` gap is a plain newline in both)
    const headGap = mrs2Style ? '' : '\n';
    let t =
      HEADER(headerTool) +
      headGap +
      '-include ../makefile.init\n' +
      '\n' +
      'RM := rm -rf\n' +
      '\n' +
      '# All of the sources participating in the build are defined here\n' +
      '-include sources.mk\n';
    for (const d of dirsDesc) {
      t += d ? `-include ${POSIX(d)}/subdir.mk\n` : '-include subdir.mk\n';
    }
    // the root dir ('' sorts last descending) already emitted its include
    // above — only add it when the project has no root-level sources
    if (!map.has('')) t += '-include subdir.mk\n';
    t += '-include objects.mk\n\n';
    t += 'ifneq ($(MAKECMDGOALS),clean)\n';
    for (const v of depVars) {
      t += `ifneq ($(strip $(${v})),)\n-include $(${v})\nendif\n`;
    }
    t += 'endif\n\n-include ../makefile.defs\n\n';

    if (hasSecondaries) {
      t += '# Add inputs and outputs from these tool invocations to the build variables \n';
      if (flashVar) {
        t += 'SECONDARY_FLASH += \\\n';
        for (const ext of flashExts) {
          t += `${target}.${ext} \\\n`;
        }
        t += '\n';
      }
      if (listVar) t += `SECONDARY_LIST += \\\n${target}.lst \\\n\n`;
      if (sizeVar) {
        t += goldenSizTarget ? `SECONDARY_SIZE += \\\n${target}.siz \\\n\n` : `SECONDARY_SIZE += mrvc-print-size\n\n`;
      }
    }

    // (review round6 P2) ONE primary product naming for the generator, the
    // clean rule and the MCP report: a static library archives `.a`
    // (regardless of the configured artifactExtension — the ar recipe has
    // always emitted .a), an executable uses the configured extension
    // (default .elf). Type-switch projects (elf → staticLib) previously got
    // a main-build rule naming .elf with NO recipe for it.
    const elfExt = isExe ? cp.artifactExtension || 'elf' : 'a';
    const elfTarget = `${target}.${elfExt}`;
    const pre = cp.prebuildStep.trim();
    const post = cp.postbuildStep.trim();
    if (mrs2Style) {
      // MRS 2.x generation: `all` delegates to a main-build sub-target via a
      // recursive make call (CDT's newer all/main-build template); the
      // recipe line carries a trailing space and the header blank line
      // doubles, matching the 2.1.0 goldens
      t += `\n# All Target\nall: \n\t\$(MAKE) --no-print-directory main-build \n`;
      t += `\nmain-build: ${elfTarget}${hasSecondaries ? ' secondary-outputs' : ''}\n`;
    } else {
      // MRS 1.x generation: `all` hangs directly off the elf
      t += `\n# All Target\nall: ${elfTarget}${hasSecondaries ? ' secondary-outputs' : ''}\n`;
    }
    // echo the announce the user typed on the Build Steps page (MRS2 emits
    // the same property); the CDT default applies when it's unset
    if (pre) t += `\t-@echo ${cp.prebuildAnnounce || 'Executing pre-build steps'}\n\t-${pre}\n`;
    if (post) t += `\t-@echo ${cp.postbuildAnnounce || 'Executing post-build steps'}\n\t-${post}\n`;
    t += `\n# Tool invocations\n`;

    if (isExe) {
      t += `${elfTarget}: $(OBJS) $(USER_OBJS)\n`;
      // the WCH helper libs (-lIQmath_RV32 / -lprintf / -lprintfloat) sit on
      // the recipe right after `$(LIBS)`, not inside objects.mk — MRS2 2.5.0
      // and the 1.9.2 goldens agree (e.g. `$(OBJS) $(LIBS) -lprintf`)
      if (mrs2Style) {
        // 2.x: single @ prefix, no tail line
        t += `\t@\t${linker}${common}${ldOpts} -o "${elfTarget}" $(OBJS) $(USER_OBJS) $(LIBS)${wchLibs}\n`;
      } else {
        t += `\t@\t@\t${linker}${common}${ldOpts} -o "${elfTarget}" $(OBJS) $(USER_OBJS) $(LIBS)${wchLibs}\n`;
        t += `\t@\t@\n`;
      }
      if (flashVar) {
        const copyOpts = objCopyOptions(cp);
        for (const ext of flashExts) {
          const objcopyFlag = ext === 'bin' ? '-O binary' : '-O ihex';
          t += `${target}.${ext}: ${elfTarget}\n`;
          // 1.9.2 keeps the golden's double space between the arguments;
          // 2.x emits a single one; 2.x has no tail line
          t += mrs2Style
            ? `\t@\t${objcopy} ${objcopyFlag}${copyOpts} "${elfTarget}" "${target}.${ext}"\n`
            : `\t@\t${objcopy} ${objcopyFlag}${copyOpts} "${elfTarget}"  "${target}.${ext}"\n`;
          if (!mrs2Style) t += `\t@\t@\n`;
        }
      }
      if (listVar) {
        t += `${target}.lst: ${elfTarget}\n`;
        t += `\t@\t${objdump}${listingOptions(cp)} "${elfTarget}" > "${target}.lst"\n`;
        if (!mrs2Style) t += `\t@\t@\n`;
      }
      if (sizeVar) {
        const fmt = cp.optionEnum('printsize.format') ?? 'berkeley';
        let szFlags = `--format=${fmt}`;
        if (cp.optionBool('printsize.hex')) szFlags += ' -x';
        if (cp.optionBool('printsize.totals')) szFlags += ' --totals';
        const szOther = cp.optionValue('printsize.other')?.trim();
        if (szOther) szFlags += ` ${szOther}`;
        if (goldenSizTarget) {
          t += `${target}.siz: ${elfTarget}\n`;
          if (mrs2Style) {
            // 2.x: no @ on the size line (it echoes in the build output —
            // visible in MRS2's own build records) and the tail is an empty line
            t += `\t${sizeTool} ${szFlags} "${elfTarget}"\n\n`;
          } else {
            t += `\t@\t${sizeTool} ${szFlags} "${elfTarget}"\n`;
            t += `\t@\t@\n`;
          }
        } else {
          // print-size writes to terminal stdout only, never creating a .siz file
          t += `.PHONY: mrvc-print-size\nmrvc-print-size: ${elfTarget}\n`;
          t += mrs2Style ? `\t${sizeTool} ${szFlags} "${elfTarget}"\n\n` : `\t@\t${sizeTool} ${szFlags} "${elfTarget}"\n\t@\t@\n`;
        }
      }
    } else {
      t += `${elfTarget}: $(OBJS) $(USER_OBJS)\n`;
      t += `\t@\t@\t${ar} -cr "${elfTarget}" $(OBJS) $(USER_OBJS)\n`;
      t += `\t@\t@\n`;
    }

    // C projects: byte-identical to the MRS2 golden clean line; C++ adds
    // the C++ dep-file variables the golden C order never had. The 2.x
    // golden leads with $(OBJS) and orders the dep groups S_DEPS-first.
    // Variant-suffix DEPS follow — they own .d files too (P2-3).
    const extraCleanVars = extraDepVars.map((v) => `$(${v})`).join('');
    const cleanVars =
      (isCpp
        ? mrs2Style
          ? '$(OBJS)$(SECONDARY_FLASH)$(SECONDARY_LIST)$(SECONDARY_SIZE)$(S_DEPS)$(S_UPPER_DEPS)$(ASM_DEPS)$(ASM_UPPER_DEPS)$(C_DEPS)$(C_UPPER_DEPS)$(CPP_DEPS)$(CXX_DEPS)$(CC_DEPS)$(C++_DEPS)'
          : '$(ASM_UPPER_DEPS)$(OBJS)$(SECONDARY_FLASH)$(SECONDARY_LIST)$(SECONDARY_SIZE)$(ASM_DEPS)$(S_DEPS)$(S_UPPER_DEPS)$(C_DEPS)$(C_UPPER_DEPS)$(CPP_DEPS)$(CXX_DEPS)$(CC_DEPS)$(C++_DEPS)'
        : mrs2Style
          ? '$(OBJS)$(SECONDARY_FLASH)$(SECONDARY_LIST)$(SECONDARY_SIZE)$(S_DEPS)$(S_UPPER_DEPS)$(ASM_DEPS)$(ASM_UPPER_DEPS)$(C_DEPS)'
          : '$(ASM_UPPER_DEPS)$(OBJS)$(SECONDARY_FLASH)$(SECONDARY_LIST)$(SECONDARY_SIZE)$(ASM_DEPS)$(S_DEPS)$(S_UPPER_DEPS)$(C_DEPS)') +
      extraCleanVars;
    const cleanFileVars = goldenSizTarget ? cleanVars : cleanVars.replace(/\$\(SECONDARY_SIZE\)/g, '');
    t += `# Other Targets\nclean:\n\t-$(RM) ${cleanFileVars} ${elfTarget}\n`;
    // 2.x golden: the clean tail is an empty line, not "\t-@"
    t += mrs2Style ? `\n` : `\t-@\n`;
    if (hasSecondaries) {
      const secs = [
        flashVar ? '$(SECONDARY_FLASH)' : '',
        listVar ? '$(SECONDARY_LIST)' : '',
        sizeVar ? '$(SECONDARY_SIZE)' : '',
      ].filter(Boolean);
      t += `secondary-outputs: ${secs.join(' ')}\n`;
    }
    t += `\n.PHONY: all clean dependents\n\n-include ../makefile.targets`;
    // 2.x golden ends the file right after the targets include — no newline
    if (!mrs2Style) t += '\n';
    writeMk('makefile', t);
  }

  recordWrittenFiles(cp.projectRoot, buildDir, writtenRels, ansiArtifactEncoding());
  return { files: written, dirs: dirsAsc, sourceCount };
}

function stripExt(logicName: string): string {
  const slash = logicName.lastIndexOf('/');
  const dot = logicName.lastIndexOf('.');
  if (dot > slash) return logicName.slice(0, dot);
  return logicName;
}

/** the make target that compiles ONE logic file, spelled exactly as the
 *  generated subdir.mk spells it: `<logic dir>/<basename>.o` (a root file
 *  has no dir part). In-root files compile through the `dir/%.o:
 *  ../dir/%.ext` pattern rule, external/linked files through the explicit
 *  per-file rules — both share this target name, so `make <target>` from
 *  the build dir compiles just that file with the project's real flags
 *  (0.3.4 编译单个文件). */
export function objectTargetFor(logicName: string): string {
  const posixPath = toPosix(logicName);
  const dir = path.posix.dirname(posixPath);
  const base = stripExt(path.posix.basename(posixPath));
  return (dir === '.' ? base : `${dir}/${base}`) + '.o';
}

/**
 * The flash image file names one configuration produces. The generator
 * (buildArtifact step above) writes `${outputPrefix}${targetName}.hex/.bin`
 * — the delete-output "keep hex/bin" lists MUST derive from the same naming
 * or a prefixed image (target `app`, prefix `boot_` → `boot_app.hex`) is
 * deleted while a stale prefix-less `app.hex` survives it (review P2). The
 * prefix-less legacy names stay on the keep list too: images built before
 * an output prefix was configured must not be silently destroyed either.
 */
export function imageKeepNames(targetName: string, outputPrefix: string): string[] {
  const stem = `${outputPrefix}${targetName}`;
  return [`${stem}.hex`, `${stem}.bin`, `${targetName}.hex`, `${targetName}.bin`];
}

/**
 * The flash image a configuration PRODUCES, in download-priority order:
 * the prefixed name first (what the generator writes today), then the
 * prefix-less legacy name (what earlier builds left behind). The default
 * download path shares this so a configured output prefix actually steers
 * the default target — with only the legacy name considered, a stale
 * prefix-less `app.hex` was chosen over the current `boot_app.hex`
 * (review round2 P2).
 */
export function imageCandidates(targetName: string, outputPrefix: string, flashFormat: 'binary' | 'ihex' | 'hex'): string[] {
  const ext = flashFormat === 'binary' ? 'bin' : 'hex';
  const out = [`${outputPrefix}${targetName}.${ext}`];
  if (outputPrefix) out.push(`${targetName}.${ext}`);
  return out;
}

/**
 * The produced artifacts of one configuration, by its own artifact type —
 * static-library projects archive .a (0.3.2), exe projects link elf/hex/bin.
 * The name follows the GENERATOR's: `outputPrefix + targetName` (round3 P2
 * — a bare targetName lookup reported a STALE prefix-less image, size
 * included, to the caller). A MISSING candidate is a null-size entry, NOT
 * an error: single-format images (hex-only) and custom artifact extensions
 * are legitimate, and an ENOENT here would mask the real build result
 * (review round4 P2). Used by the MCP build report AND the download target
 * resolution so both speak the same naming.
 */
/**
 * (review round6 P2) the ONE primary product naming shared by the
 * generator's main-build rule, the clean rule and the MCP product report:
 * a static library archives `.a` (the ar recipe's actual output), an
 * executable uses its configured artifactExtension (default .elf).
 */
function primaryProduct(cp: { artifactType: string; targetName: string; outputPrefix: string; artifactExtension: string }): string {
  const ext = cp.artifactType === 'staticLib' ? 'a' : cp.artifactExtension || 'elf';
  return `${cp.outputPrefix}${cp.targetName}.${ext}`;
}

export function productsFor(
  cp: {
    artifactType: 'exe' | 'staticLib';
    targetName: string;
    outputPrefix: string;
    artifactExtension: string;
    createFlash: boolean;
    createListing: boolean;
  },
  buildDir: string,
  flashExts: string[] = []
): Array<{ file: string; size: number | null }> {
  const dir = path.resolve(buildDir);
  // the SAME product set the generator emits (review round5/round6 P2): the
  // primary product with the ONE naming (staticLib archives .a, exe uses
  // the configured extension), then the secondaries the project actually
  // enables — no invented elf/hex/bin triple, no stale fallback names
  const names: string[] = [primaryProduct(cp)];
  if (cp.artifactType === 'exe') {
    if (cp.createFlash) for (const ext of flashExts) names.push(`${cp.outputPrefix}${cp.targetName}.${ext}`);
    if (cp.createListing) names.push(`${cp.outputPrefix}${cp.targetName}.lst`);
  }
  const out: Array<{ file: string; size: number | null }> = [];
  for (const cand of names) {
    const f = path.resolve(dir, cand);
    if (f !== dir && !f.startsWith(dir + path.sep)) throw new Error(`artifact path escapes the build directory: ${cand}`);
    out.push({ file: f, size: fs.existsSync(f) ? fs.statSync(f).size : null });
  }
  return out;
}

/**
 * (review round7 P1) the FILE-LEVEL claimed output set of one configuration:
 * every path (relative to the build/output directory, posix separators)
 * that the build system actually writes — the generated makefile family
 * (makefile / sources.mk / objects.mk / <dir>/subdir.mk), every object,
 * dependency and deterministic stack-usage (.su) file the compiler emits for
 * the scanned sources, the primary product (staticLib archives .a, exe links
 * its configured extension), the linker map file (-Wl,-Map), the flash
 * images / listing / size report the secondaries write, and the flash script
 * MRVC's download planning writes into the build directory (plus legacy
 * mrs2_flash.cfg).
 *
 * The delete-output commands delete ONLY paths from this set: linker inputs
 * (a vendor .a reached through USER_OBJS), stored images and any other user
 * data inside the output directory are NOT in the set and survive every
 * clear — the same distinction the clean recipe makes ($(OBJS)… are
 * removed, $(USER_OBJS) are not). The layout is golden-byte-identical to
 * MRS's own builds, so the set describes MRS-built projects too.
 *
 * Dynamic-numbered -fdump-rtl-expand dumps in the build root (whose names
 * embed varying pass counters) and post-build step outputs are deliberately
 * NOT claimed — their exact paths cannot be enumerated reliably, and keeping
 * them after a clear is the safe direction. A missing linked-folder target
 * makes scanSources skip that tree (fewer claimed objects): stale outputs
 * there are then simply kept, which is the safe direction for a DELETE
 * operation (unlike a build, where the explicit assertScannableLinkedFolders
 * gate is what refuses).
 */
export function buildOutputFiles(cp: Cproject): string[] {
  const map = scanSources(cp);
  const rels = new Set<string>(['makefile', 'sources.mk', 'objects.mk']);
  for (const [dir, files] of map) {
    rels.add(dir ? `${toPosix(dir)}/subdir.mk` : 'subdir.mk');
    for (const f of files) {
      const obj = objectTargetFor(f.logicName);
      rels.add(obj);
      rels.add(obj.slice(0, -2) + '.d');
      rels.add(obj.slice(0, -2) + '.su');
    }
  }
  const target = cp.outputPrefix + cp.targetName;
  if (cp.artifactType === 'exe') {
    if (cp.createFlash) for (const ext of flashExtensions(cp)) rels.add(`${target}.${ext}`);
    if (cp.createListing) rels.add(`${target}.lst`);
    // linker always emits -Wl,-Map,"${mapName}"; claim it when it lands in
    // the output directory so deleting build outputs never trips on .map
    const buildDir = path.resolve(cp.projectRoot, cp.configName);
    const mapAbs = path.resolve(buildDir, linkerMapName(cp));
    const mapRel = path.relative(buildDir, mapAbs);
    if (mapRel && !path.isAbsolute(mapRel) && mapRel !== '..' && !mapRel.startsWith('..' + path.sep)) {
      rels.add(toPosix(mapRel));
    }
  }
  rels.add(primaryProduct(cp));
  rels.add('mrvc_flash.cfg');
  rels.add('mrs2_flash.cfg');
  return [...rels];
}

/**
 * Legacy Print-Size makefile guard (review round8 P1-A): older MRVC-generated
 * makefiles listed `<target>.siz` in `SECONDARY_SIZE` and passed
 * `$(SECONDARY_SIZE)` to `$(RM)` inside `clean`, even though the size recipe
 * only printed to stdout. If a user upgraded MRVC and runs `clean` or `rebuild`
 * BEFORE regenerating that makefile, pass `SECONDARY_SIZE=` so a hand-saved
 * `<target>.siz` survives. Custom makefiles whose `.siz:` recipe redirects stdout
 * (`>`) or non-generated makefiles are left untouched.
 */
export function legacyPrintSizeCleanOverride(buildDir: string): string[] {
  try {
    const text = decodeArtifact(fs.readFileSync(path.join(buildDir, 'makefile')));
    if (!text.includes('Automatically-generated file. Do not edit!')) return [];
    if (!/SECONDARY_SIZE\s*\+=\s*(?:\\\r?\n)?[^\r\n]*\.siz\b/.test(text)) return [];
    const rule = text.match(/^[^\r\n#]*\.siz\s*:[^\r\n]*\r?\n([ \t]+[^\r\n]*)/m);
    if (!rule || rule[1].includes('>')) return [];
    return ['SECONDARY_SIZE='];
  } catch {
    return [];
  }
}

/** the command-line make argument for one object target. The task wrapper
 *  joins makeArgs with bare spaces, so the target must arrive as ONE shell
 *  argument — and the two wrappers speak different shells:
 *
 *  - win32: cmd.exe has no single-quote quoting, so use double quotes; inside
 *    them cmd treats `& | < > ^ ( )` literally. `%` is the exception — a
 *    batch file expands `%VAR%` even inside quotes, so it is doubled here
 *    (the wrapper writes a .cmd). A literal `"` cannot appear in a Windows
 *    file name, so it is refused defensively.
 *  - POSIX: sh single quotes expand nothing; an embedded `'` closes/reopens.
 *
 *  `$` is passed through verbatim. A makefile RULE spells a literal dollar
 *  doubled, but a command-line goal is a file name: make does not re-expand
 *  it, so `$$` would search for a file with two dollars (P2-2: the old
 *  helper reused the makefile rule escaping and broke `$` targets). */
export function singleFileMakeArg(
  target: string,
  platform: NodeJS.Platform = process.platform
): { arg?: string; error?: 'quote' } {
  if (platform === 'win32') {
    if (/["\r\n]/.test(target)) return { error: 'quote' };
    return { arg: `"${target.replace(/%/g, '%%')}"` };
  }
  if (/[\r\n]/.test(target)) return { error: 'quote' };
  return { arg: "'" + target.replace(/'/g, `'\\''`) + "'" };
}
