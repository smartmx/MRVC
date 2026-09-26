/**
 * Compiler/linker flag assembly, ported from the MRS2 extension's
 * getCommonOptions / getCCompilerOptions / getCppCompilerOptions /
 * getAssemblerOptions / getCLinkerOptions / getCLinkerOptionsAsLibs.
 * Option suffixes are the canonical CDT ones (verified against the MRS2
 * parser), so .cproject files we write stay readable by MRS2.
 * Pure Node — no vscode imports.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Cproject } from './cproject';
import { convertLogicToFullPath, toNative } from './macros';

export interface TargetProcessorOpts {
  archBase: string; // rv32i ...
  integerAbi: string; // ilp32 ...
  fpAbi: 'none' | 'single' | 'double';
  rvm: boolean;
  rva: boolean;
  rvc: boolean;
  rvb: boolean;
  rvxw: boolean;
  rvzmmul: boolean;
  codemodel: string; // any | low | ...
  smallDataLimit: string;
  saveRestore: boolean;
  tuning: string; // '' = default
  align: string; // '' | strict | nostrict
  toolchainName: string; // GCC8 | GCC12 | GCC15
}

const TUNE_ENUM_PREFIX = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.target.tune.';

/**
 * `target.tune` may be stored as a full CDT enum value
 * ("...option.target.tune.default") or a plain cpu name. Reduce to the
 * actual -mtune argument; "default"/empty -> no flag at all.
 */
export function resolveTune(cp: Cproject): string {
  const raw = cp.optionValue('target.tune');
  if (!raw) return '';
  const v = (raw.startsWith(TUNE_ENUM_PREFIX) ? raw.slice(TUNE_ENUM_PREFIX.length) : raw.includes('.') ? raw.split('.').pop()! : raw).trim();
  if (!v || /^default$/i.test(v) || /\s/.test(v)) return '';
  return v;
}

/** `target.align` may be a plain "strict"/"nostrict" or a full enum value. */
export function resolveAlign(cp: Cproject): '' | 'strict' | 'nostrict' {
  const raw = cp.optionValue('target.align');
  if (!raw) return '';
  const v = (raw.includes('.') ? raw.split('.').pop()! : raw).trim().toLowerCase();
  return v === 'strict' ? 'strict' : v === 'nostrict' ? 'nostrict' : '';
}

export function readTargetProcessor(cp: Cproject, toolchainName: string): TargetProcessorOpts {
  return {
    archBase: cp.optionEnum('target.isa.base') ?? 'rv32i',
    integerAbi: cp.optionEnum('target.abi.integer') ?? 'ilp32',
    fpAbi: ((): 'none' | 'single' | 'double' => {
      const v = cp.optionEnum('target.abi.fp') ?? 'none';
      return v.endsWith('single') ? 'single' : v.endsWith('double') ? 'double' : 'none';
    })(),
    rvm: cp.optionBool('target.isa.multiply'),
    rva: cp.optionBool('target.isa.atomic'),
    rvc: cp.optionBool('target.isa.compressed'),
    rvb: cp.optionBool('target.isa.b'),
    rvxw: cp.optionBool('target.isa.xw'),
    rvzmmul: cp.optionBool('target.isa.zmmul'),
    codemodel: cp.optionEnum('target.codemodel') ?? 'any',
    smallDataLimit: cp.optionValue('target.smalldatalimit') ?? '8',
    saveRestore: cp.optionBool('target.saverestore', false),
    tuning: resolveTune(cp),
    align: resolveAlign(cp),
    toolchainName,
  };
}

function isWchGcc(name: string): boolean {
  return name === 'GCC8' || name === 'GCC12' || name === 'GCC15';
}

/** -march=... (from getArchParams) */
function marchFlags(tp: TargetProcessorOpts): string {
  let t = ` -march=${tp.archBase}`;
  if (tp.archBase !== 'rv32g' && tp.archBase !== 'rv64g') {
    if (tp.rvm) t += 'm';
    if (tp.rva) t += 'a';
    switch (tp.fpAbi) {
      case 'single':
        t += 'f';
        break;
      case 'double':
        t += 'fd';
        break;
      default:
        break;
    }
    if (tp.rvc) t += 'c';
    if (isWchGcc(tp.toolchainName)) {
      if (tp.toolchainName === 'GCC12' || tp.toolchainName === 'GCC15') {
        if (tp.rvb) t += '_zba_zbb_zbc_zbs';
        if (tp.rvzmmul) t += '_zmmul';
        if (tp.rvxw) t += '_xw';
      } else if (tp.rvxw) {
        t += 'xw';
      }
    } else if (tp.rvxw) {
      t += 'xw';
    }
  }
  return t;
}

function mabiFlags(tp: TargetProcessorOpts): string {
  let t = ` -mabi=${tp.integerAbi}`;
  switch (tp.fpAbi) {
    case 'single':
      t += 'f';
      break;
    case 'double':
      t += 'd';
      break;
    default:
      break;
  }
  return t;
}

/** optimization options (order matches MRS/MRS2) */
function optimizationFlags(cp: Cproject, toolchainName: string): string {
  let t = '';
  switch (cp.optimizationLevel) {
    case 'none':
      t += ' -O0';
      break;
    case 'optimize':
      t += ' -O1';
      break;
    case 'more':
      t += ' -O2';
      break;
    case 'most':
      t += ' -O3';
      break;
    case 'fast':
      t += ' -Ofast';
      break;
    case 'debug':
      t += ' -Og';
      break;
    case 'z':
      t += ' -Oz';
      break;
    default:
      t += ' -Os';
      break;
  }
  if (cp.optionBool('optimization.messagelength')) t += ' -fmessage-length=0';
  if (cp.optionBool('optimization.signedchar')) t += ' -fsigned-char';
  if (cp.optionBool('optimization.functionsections')) t += ' -ffunction-sections';
  if (cp.optionBool('optimization.datasections')) t += ' -fdata-sections';
  if (cp.optionBool('optimization.nocommon')) t += ' -fno-common';
  if (cp.optionBool('optimization.noinlinefunctions')) t += ' -fno-inline-functions';
  if (cp.optionBool('optimization.freestanding')) t += ' -ffreestanding';
  if (cp.optionBool('optimization.nobuiltin')) t += ' -fno-builtin';
  if (cp.optionBool('optimization.spconstant')) t += ' -fsingle-precision-constant';
  if (cp.optionBool('optimization.PIC')) t += ' -fPIC';
  if (cp.optionBool('optimization.lto')) t += ' -flto';
  if (cp.optionBool('optimization.nomoveloopinvariants')) t += ' -fno-move-loop-invariants';
  if (isWchGcc(toolchainName)) {
    if (cp.optionBool('optimization.mrs.highcode')) t += ' --param=highcode-gen-section-name=1';
    if (cp.optionBool('optimization.mrs.asmsoftlib')) t += ' -Xassembler -wchsoftlib';
    if (cp.optionBool('optimization.mrs.pipe')) t += ' -pipe';
    if (cp.optionBool('optimization.mrs.caret')) t += ' -fno-diagnostics-show-caret';
    if (toolchainName === 'GCC15' && cp.optionBool('optimization.mrs.ccv')) t += ' --param=ccv-abi=1';
  }
  const other = cp.optionValue('optimization.other');
  if (other) t += ` ${resolveOutputMacros(cp, other)}`;
  return t;
}

function warningFlags(cp: Cproject): string {
  let t = '';
  if (cp.optionBool('warnings.syntaxonly')) t += ' -fsyntax-only';
  if (cp.optionBool('warnings.pedantic')) t += ' -pedantic';
  if (cp.optionBool('warnings.pedanticerrors')) t += ' -pedantic-errors';
  if (cp.optionBool('warnings.nowarn')) t += ' -w';
  if (cp.optionBool('warnings.toerrors')) t += ' -Werror';
  if (cp.optionBool('warnings.unused')) t += ' -Wunused';
  if (cp.optionBool('warnings.uninitialized')) t += ' -Wuninitialized';
  if (cp.optionBool('warnings.allwarn')) t += ' -Wall';
  if (cp.optionBool('warnings.extrawarn')) t += ' -Wextra';
  if (cp.optionBool('warnings.missingdeclaration')) t += ' -Wmissing-declarations';
  if (cp.optionBool('warnings.conversion')) t += ' -Wconversion';
  if (cp.optionBool('warnings.pointerarith')) t += ' -Wpointer-arith';
  if (cp.optionBool('warnings.padded')) t += ' -Wpadded';
  if (cp.optionBool('warnings.shadow')) t += ' -Wshadow';
  if (cp.optionBool('warnings.logicalop')) t += ' -Wlogical-op';
  if (cp.optionBool('warnings.agreggatereturn')) t += ' -Waggregate-return';
  if (cp.optionBool('warnings.floatequal')) t += ' -Wfloat-equal';
  const other = cp.optionValue('warnings.other');
  if (other) t += ` ${resolveOutputMacros(cp, other)}`;
  return t;
}

function debugFlags(cp: Cproject): string {
  let t = '';
  const level = cp.debugLevel ?? 'default';
  let skipFormat = false;
  switch (level) {
    case 'none':
      skipFormat = true;
      break;
    case 'minimal':
      t += ' -g1';
      break;
    case 'max':
      t += ' -g3';
      break;
    default:
      t += ' -g';
      break;
  }
  if (!skipFormat) {
    const format = cp.optionEnum('debugging.format');
    switch (format) {
      case 'gdb':
        t += ' -ggdb';
        break;
      case 'stabs':
        t += ' -gstabs';
        break;
      case 'stabsplus':
        t += ' -gstab+';
        break;
      case 'dwarf2':
        t += ' -gdwarf-2';
        break;
      case 'dwarf3':
        t += ' -gdwarf-3';
        break;
      case 'dwarf4':
        t += ' -gdwarf-4';
        break;
      case 'dwarf5':
        t += ' -gdwarf-5';
        break;
      default:
        break;
    }
  }
  const other = cp.optionValue('debugging.other');
  if (other) t += ` ${resolveOutputMacros(cp, other)}`;
  if (cp.optionBool('debugging.prof')) t += ' -p';
  if (cp.optionBool('debugging.gprof')) t += ' -pg';
  return t;
}

/** getCommonOptions: -march/-mabi/-mcmodel/... + optimization + warnings + debug.
 *  Sections are joined with a space each (MRS emits a placeholder space for
 *  empty sections, e.g. "...=1  -g" when no warning flags are set). */
export function commonOptions(cp: Cproject, toolchainName: string): string {
  const tp = readTargetProcessor(cp, toolchainName);
  let target = marchFlags(tp) + mabiFlags(tp);
  if (tp.tuning) target += ` -mtune=${tp.tuning}`;
  if (tp.codemodel !== 'default') target += ` -mcmodel=med${tp.codemodel}`;
  target += ` -msmall-data-limit=${tp.smallDataLimit}`;
  if (tp.align === 'strict') target += ' -mstrict-align';
  else if (tp.align === 'nostrict') target += ' -mno-strict-align';
  target += tp.saveRestore ? ' -msave-restore' : ' -mno-save-restore';
  const otherTarget = cp.optionValue('target.other');
  if (otherTarget) target += ` ${resolveOutputMacros(cp, otherTarget)}`;
  const opt = optimizationFlags(cp, toolchainName);
  const warn = warningFlags(cp);
  const dbg = debugFlags(cp);
  return ' ' + [target, opt, warn, dbg].map((s) => s.trim()).join(' ');
}

interface ResolveChoice {
  /** drop entries whose unresolvable `${macro}` would leak into the flags */
  dropUnresolved: boolean;
}

function resolveList(cp: Cproject, suffix: string, quotedKeep: (raw: string) => string, choice: ResolveChoice = { dropUnresolved: false }): string[] {
  const linked = cp.linkedFolders ?? new Map<string, string>();
  const out: string[] = [];
  for (const raw of cp.listOption(suffix).values) {
    const abs = convertLogicToFullPath(cp.projectRoot, cp.projectName, raw, linked);
    if (abs) {
      // a resolved path wins even when not on disk: MRS2 emits such -I/-T
      // entries and gcc tolerates/errs on them far better than a raw
      // unresolved ${workspace_loc} string ever would
      out.push(quotedKeep(toNative(abs)));
      continue;
    }
    if (path.isAbsolute(raw)) {
      out.push(quotedKeep(toNative(path.normalize(raw))));
      continue;
    }
    // plain relative paths (e.g. "../") always survive; unresolved macros
    // are dropped when the caller asked for it (MRS2 behaviour for -L/-I)
    if (!choice.dropUnresolved || !raw.includes('${')) {
      out.push(quotedKeep(raw));
    }
  }
  return out;
}

function languageStdFlag(cp: Cproject): string {
  switch (cp.languageStandard) {
    case 'ansi':
      return ' -ansi';
    case 'iso9899.1994090':
      return ' -std=iso9899:199409';
    case 'gnu90':
      return ' -std=gnu90';
    case 'c99':
      return ' -std=c99';
    case 'c11':
      return ' -std=c11';
    case 'c17':
      return ' -std=c17';
    case 'gnu17':
      return ' -std=gnu17';
    case 'c2x':
      return ' -std=c2x';
    case 'gnu2x':
      return ' -std=gnu2x';
    case 'gnu99':
      return ' -std=gnu99';
    default:
      return ' -std=gnu11';
  }
}

/** -D/-U/-I/... for the C compiler (getCCompilerOptions) */
export function cCompilerOptions(cp: Cproject, skipIncludes = false): string {
  let t = '';
  if (cp.optionBool('c.compiler.nostdinc')) t += ' -nostdinc';
  if (cp.optionBool('c.compiler.preprocessonly')) t += ' -E';
  for (const d of cp.listOption('c.compiler.defs').values) {
    if (d) t += ` -D${d}`;
  }
  for (const u of cp.listOption('c.compiler.undef').values) {
    if (u) t += ` -U${u}`;
  }
  if (!skipIncludes) {
    for (const i of resolveList(cp, 'c.compiler.include.paths', (v) => v, { dropUnresolved: true })) {
      t += ` -I"${i}"`;
    }
    for (const i of resolveList(cp, 'c.compiler.include.systempaths', (v) => v, { dropUnresolved: true })) {
      t += ` -isystem"${i}"`;
    }
    for (const i of resolveList(cp, 'c.compiler.include.files', (v) => v, { dropUnresolved: true })) {
      t += ` -include"${i}"`;
    }
  }
  t += languageStdFlag(cp);
  const cOtherOpt = cp.optionValue('c.compiler.otheroptimizations');
  if (cOtherOpt) t += ` ${cOtherOpt}`;
  if (cp.optionBool('c.compiler.warning.missingprototypes')) t += ' -Wmissing-prototypes';
  if (cp.optionBool('c.compiler.warning.strictprototypes')) t += ' -Wstrict-prototypes';
  if (cp.optionBool('c.compiler.warning.badfunctioncast')) t += ' -Wbad-function-cast';
  const cOtherWarn = cp.optionValue('c.compiler.otherwarnings');
  if (cOtherWarn) t += ` ${resolveOutputMacros(cp, cOtherWarn)}`;
  if (cp.optionBool('c.compiler.asmlisting')) t += ' -Wa,-adhlns="$@.lst"';
  if (cp.optionBool('c.compiler.savetemps')) t += ' --save-temps';
  if (cp.optionBool('c.compiler.verbose')) t += ' -v';
  const cOther = cp.optionValue('c.compiler.other');
  if (cOther) t += ` ${resolveOutputMacros(cp, cOther)}`;
  return t;
}

const CPP_STD_FLAGS: Record<string, string> = {
  ansi: ' -ansi',
  gnucpp98: ' -std=gnu++98',
  cpp0x: ' -std=c++0x',
  cpp11: ' -std=c++11',
  gnucpp0x: ' -std=gnu++0x',
  cpp1y: ' -std=c++1y',
  cpp14: ' -std=c++14',
  gnucpp1y: ' -std=gnu++1y',
  gnucpp14: ' -std=gnu++14',
  cpp1z: ' -std=c++1z',
  cpp17: ' -std=c++17',
  gnucpp1z: ' -std=gnu++1z',
  gnucpp17: ' -std=gnu++17',
  cpp2a: ' -std=c++2a',
  gnucpp2a: ' -std=gnu++2a',
};

/** -D/-I/... for the C++ compiler (getCppCompilerOptions) */
export function cppCompilerOptions(cp: Cproject, skipIncludes = false): string {
  let t = '';
  if (cp.optionBool('cpp.compiler.nostdinc')) t += ' -nostdinc';
  if (cp.optionBool('cpp.compiler.nostdincpp')) t += ' -nostdinc++';
  if (cp.optionBool('cpp.compiler.preprocessonly')) t += ' -E';
  for (const d of cp.listOption('cpp.compiler.defs').values) {
    if (d) t += ` -D${d}`;
  }
  for (const u of cp.listOption('cpp.compiler.undef').values) {
    if (u) t += ` -U${u}`;
  }
  if (!skipIncludes) {
    for (const i of resolveList(cp, 'cpp.compiler.include.paths', (v) => v, { dropUnresolved: true })) {
      t += ` -I"${i}"`;
    }
    for (const i of resolveList(cp, 'cpp.compiler.include.systempaths', (v) => v, { dropUnresolved: true })) {
      t += ` -isystem"${i}"`;
    }
    for (const i of resolveList(cp, 'cpp.compiler.include.files', (v) => v, { dropUnresolved: true })) {
      t += ` -include"${i}"`;
    }
  }
  const std = cp.optionEnum('cpp.compiler.std') ?? 'gnucpp11';
  t += CPP_STD_FLAGS[std] ?? ' -std=gnu++11';
  const abi = cp.optionEnum('cpp.compiler.abiversion') ?? 'default';
  if (abi !== 'default') t += ` -fabi-version=${abi}`;
  if (cp.optionBool('cpp.compiler.noexceptions')) t += ' -fno-exceptions';
  if (cp.optionBool('cpp.compiler.nortti')) t += ' -fno-rtti';
  if (cp.optionBool('cpp.compiler.nousecxaatexit')) t += ' -fno-use-cxa-atexit';
  if (cp.optionBool('cpp.compiler.nothreadsafestatics')) t += ' -fno-threadsafe-statics';
  const otherOpt = cp.optionValue('cpp.compiler.otheroptimizations');
  if (otherOpt) t += ` ${resolveOutputMacros(cp, otherOpt)}`;
  if (cp.optionBool('cpp.compiler.warnabi')) t += ' -Wabi';
  if (cp.optionBool('cpp.compiler.warning.ctordtorprivacy')) t += ' -Wctor-dtor-privacy';
  if (cp.optionBool('cpp.compiler.warning.noexcept')) t += ' -Wnoexcept';
  if (cp.optionBool('cpp.compiler.warning.nonvirtualdtor')) t += ' -Wnon-virtual-dtor';
  if (cp.optionBool('cpp.compiler.warning.strictnullsentinel')) t += ' -Wstrict-null-sentinel';
  if (cp.optionBool('cpp.compiler.warning.signpromo')) t += ' -Wsign-promo';
  if (cp.optionBool('cpp.compiler.warneffc')) t += ' -Weffc++';
  const otherWarn = cp.optionValue('cpp.compiler.otherwarnings');
  if (otherWarn) t += ` ${resolveOutputMacros(cp, otherWarn)}`;
  if (cp.optionBool('cpp.compiler.asmlisting')) t += ' -Wa,-adhlns="$@.lst"';
  if (cp.optionBool('cpp.compiler.savetemps')) t += ' --save-temps';
  if (cp.optionBool('cpp.compiler.verbose')) t += ' -v';
  const other = cp.optionValue('cpp.compiler.other');
  if (other) t += ` ${resolveOutputMacros(cp, other)}`;
  return t;
}

/** assembler options (getAssemblerOptions) */
export function assemblerOptions(cp: Cproject, skipIncludes = false): string {
  let t = '';
  t += cp.optionBool('assembler.usepreprocessor', true) ? ' -x assembler-with-cpp' : ' -x assembler';
  if (cp.optionBool('assembler.nostdinc')) t += ' -nostdinc';
  if (cp.optionBool('assembler.preprocessonly')) t += ' -E';
  for (const d of cp.listOption('assembler.defs').values) {
    if (d) t += ` -D${d}`;
  }
  for (const u of cp.listOption('assembler.undefs').values) {
    if (u) t += ` -U${u}`;
  }
  if (!skipIncludes) {
    for (const i of resolveList(cp, 'assembler.include.paths', (v) => v, { dropUnresolved: true })) {
      t += ` -I"${i}"`;
    }
    for (const i of resolveList(cp, 'assembler.include.systempaths', (v) => v, { dropUnresolved: true })) {
      t += ` -isystem"${i}"`;
    }
    for (const i of resolveList(cp, 'assembler.include.files', (v) => v, { dropUnresolved: true })) {
      t += ` -include"${i}"`;
    }
  }
  const otherWarn = cp.optionValue('assembler.otherwarnings');
  if (otherWarn) t += ` ${otherWarn}`;
  for (const f of cp.listOption('assembler.flags').values) {
    if (f) t += ` -Xassembler${f}`;
  }
  if (cp.optionBool('assembler.asmlisting')) t += ' -Wa,-adhlns="$@.lst"';
  if (cp.optionBool('assembler.savetemps')) t += ' --save-temps';
  if (cp.optionBool('assembler.verbose')) t += ' -v';
  const other = cp.optionValue('assembler.other');
  if (other) t += ` ${resolveOutputMacros(cp, other)}`;
  return t;
}

/** Resolve the free-text macros MRS2 supports in flag strings. */
function resolveOutputMacros(cp: Cproject, s: string): string {
  return s.split('${BuildArtifactFileBaseName}').join(cp.targetName).split('${ProjName}').join(cp.projectName);
}

function linkerOptionsFor(cp: Cproject, p: 'c' | 'cpp'): string {
  let t = '';
  for (const s of resolveList(cp, `${p}.linker.scriptfile`, (v) => v)) {
    t += ` -T "${s}"`;
  }
  if (cp.optionBool(`${p}.linker.nostart`)) t += ' -nostartfiles';
  if (cp.optionBool(`${p}.linker.nodeflibs`)) t += ' -nodefaultlibs';
  if (cp.optionBool(`${p}.linker.nostdlibs`)) t += ' -nostdlib';
  if (cp.optionBool(`${p}.linker.gcsections`)) t += ' -Xlinker --gc-sections';
  if (cp.optionBool(`${p}.linker.printgcsections`)) t += ' -Xlinker --print-gc-sections';
  if (cp.optionBool(`${p}.linker.strip`)) t += ' -s';
  // like MRS2, -L entries that cannot be resolved are dropped entirely:
  // an emitted raw `${workspace_loc:...}` would expand to -L"" under make
  // and this ld then fails to find subsequent libraries
  for (const l of resolveList(cp, `${p}.linker.paths`, (v) => v, { dropUnresolved: true })) {
    t += ` -L"${l}"`;
  }
  for (const f of cp.listOption(`${p}.linker.flags`).values) {
    if (f) t += ` -Xlinker ${resolveOutputMacros(cp, f)}`;
  }
  // map file name: .cproject may store macros like ${BuildArtifactFileBaseName}.map
  const rawMap = cp.optionValue(`${p}.linker.mapfilename`);
  let mapName: string;
  if (!rawMap) {
    mapName = `${cp.targetName}.map`;
  } else {
    const unquoted = rawMap.replace(/^"(.*)"$/, '$1').trim();
    const linked = cp.linkedFolders ?? new Map<string, string>();
    const abs = convertLogicToFullPath(cp.projectRoot, cp.projectName, unquoted, linked);
    mapName = abs ?? resolveOutputMacros(cp, unquoted);
    if (!/\.map$/i.test(mapName)) mapName += '.map';
  }
  t += ` -Wl,-Map,"${mapName}"`;
  if (cp.optionBool(`${p}.linker.cref`)) t += ' -Xlinker --cref';
  if (cp.optionBool(`${p}.linker.printmap`)) t += ' -Xlinker --print-map';
  if (cp.optionBool(`${p}.linker.usenewlibnano`)) t += ' --specs=nano.specs';
  if (cp.optionBool(`${p}.linker.useprintffloat`)) t += ' -u _printf_float';
  if (cp.optionBool(`${p}.linker.usescanffloat`)) t += ' -u _scanf_float';
  if (cp.optionBool(`${p}.linker.usenewlibnosys`)) t += ' --specs=nosys.specs';
  if (cp.optionBool(`${p}.linker.verbose`)) t += ' -v';
  const other = cp.optionValue(`${p}.linker.other`);
  if (other) t += ` ${resolveOutputMacros(cp, other)}`;
  return t;
}

/** linker options (getCLinkerOptions) */
export function cLinkerOptions(cp: Cproject): string {
  return linkerOptionsFor(cp, 'c');
}

/** C++ linker options (getCppLinkerOptions) */
export function cppLinkerOptions(cp: Cproject): string {
  return linkerOptionsFor(cp, 'cpp');
}

/**
 * WCH-specific link libraries (getCLinkerOptionsAsLibs):
 *   IQMath      -> -lIQmath_RV32
 *   wch printf  -> -lprintf      (when picolibc is disabled/absent)
 *   wch printf. -> -lprintfloat
 */
export function wchLibsOptions(cp: Cproject, toolchainName: string): string {
  let t = '';
  if (!isWchGcc(toolchainName)) return t;
  if (cp.optionBool(`${cp.isCpp ? 'cpp' : 'c'}.linker.iqmath`)) t += ' -lIQmath_RV32';
  const picolibc = cp.optionEnum(`${cp.isCpp ? 'cpp' : 'c'}.linker.picolibc`) ?? 'disabled';
  if (picolibc === 'disabled') {
    if (cp.optionBool(`${cp.isCpp ? 'cpp' : 'c'}.linker.printf`)) t += ' -lprintf';
    if (cp.optionBool(`${cp.isCpp ? 'cpp' : 'c'}.linker.printfloat`)) t += ' -lprintfloat';
  }
  return t;
}

/** USER_OBJS entries (other objects) — absolute paths, native separators.
 *  Like MRS2, entries that cannot be resolved to an existing absolute file
 *  are silently skipped (an unresolved `${workspace_loc:...}` macro would
 *  otherwise inject a colon into the link rule line and break make). */
export function userObjects(cp: Cproject): string[] {
  const prefix = cp.isCpp ? 'cpp' : 'c';
  const linked = cp.linkedFolders ?? new Map<string, string>();
  const out: string[] = [];
  for (const raw of cp.listOption(`${prefix}.linker.otherobjs`).values) {
    const abs = convertLogicToFullPath(cp.projectRoot, cp.projectName, raw, linked);
    if (abs && fs.existsSync(abs)) {
      out.push(toNative(abs));
    } else if (path.isAbsolute(raw) && fs.existsSync(raw)) {
      out.push(toNative(path.normalize(raw)));
    }
  }
  return out;
}

/** user libraries (-l), from the cpp or c linker depending on project type */
export function userLibs(cp: Cproject): string[] {
  const prefix = cp.isCpp ? 'cpp' : 'c';
  return cp
    .listOption(`${prefix}.linker.libs`)
    .values.filter((v) => v.trim().length > 0);
}

/** objdump flags for the .lst rule, derived from createlisting options */
export function listingOptions(cp: Cproject): string {
  let t = '';
  if (cp.optionBool('createlisting.source')) t += ' --source';
  if (cp.optionBool('createlisting.allheaders')) t += ' --all-headers';
  if (cp.optionBool('createlisting.demangle')) t += ' --demangle';
  if (cp.optionBool('createlisting.debugging')) t += ' --debugging';
  if (cp.optionBool('createlisting.disassemble')) t += ' --disassemble';
  if (cp.optionBool('createlisting.linenumbers')) t += ' --line-numbers';
  if (cp.optionBool('createlisting.fileheaders')) t += ' --file-headers';
  if (cp.optionBool('createlisting.reloc')) t += ' --reloc';
  if (cp.optionBool('createlisting.symbols')) t += ' --syms';
  if (cp.optionBool('createlisting.wide')) t += ' --wide';
  const other = cp.optionValue('createlisting.other');
  if (other) t += ` ${resolveOutputMacros(cp, other)}`;
  const tp = readTargetProcessor(cp, 'GCC12');
  if (tp.rvxw) t += ' -M xw';
  return t;
}

/**
 * Flash image extensions to generate (getObjCopyExtName):
 *   ihex -> ['.hex'], binary -> ['.bin'], ihexAndbinary -> ['.bin', '.hex']
 */
export function flashExtensions(cp: Cproject): string[] {
  switch (cp.optionEnum('createflash.choice')) {
    case 'binary':
      return ['bin'];
    case 'ihexAndbinary':
      return ['bin', 'hex'];
    default:
      return ['hex'];
  }
}

/** objcopy section/extra flags (createflash.textsection/datasection/othersection/other) */
export function objCopyOptions(cp: Cproject): string {
  let t = '';
  if (cp.optionBool('createflash.textsection')) t += ' -j .text';
  if (cp.optionBool('createflash.datasection')) t += ' -j .data';
  for (const s of cp.listOption('createflash.othersection').values) {
    if (s) t += ` -j${s}`;
  }
  const other = cp.optionValue('createflash.other');
  if (other) t += ` ${resolveOutputMacros(cp, other)}`;
  return t;
}
