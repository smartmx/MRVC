/**
 * Project properties webview — MRVC-style dialog: category tree on the
 * left, one settings page at a time on the right, description pane and
 * Apply/Cancel at the bottom. Edits .cproject options in place; option
 * suffixes are the canonical CDT ones so MRVC still opens the project.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectStore, MrsProject } from './projects';
import { Cproject } from '../core/cproject';

type FieldType = 'bool' | 'enum' | 'string' | 'list';

interface FieldDef {
  key: string;
  page: string;
  label: string;
  type: FieldType;
  /** cproject option suffix (bool/enum) */
  suffix?: string;
  /** full CDT enumeration prefix; 'default' short value clears the option */
  enumBase?: string;
  options?: Array<[string, string]>;
  get?: (cp: Cproject) => string;
  set?: (cp: Cproject, value: string) => void;
}

const OPT_BASE = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';

function F(def: FieldDef): FieldDef {
  return def;
}

const list = (key: string, page: string, label: string, suffix: string): FieldDef => ({
  key,
  page,
  label,
  type: 'list',
  get: (cp) => cp.listOption(suffix).values.join('\n'),
  set: (cp, v) =>
    cp.setOptionList(
      suffix,
      v
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s)
    ),
});

const bool = (key: string, page: string, label: string, suffix: string): FieldDef => ({
  key,
  page,
  label,
  type: 'bool',
  suffix,
});

const en = (key: string, page: string, label: string, suffix: string, options: Array<[string, string]>, enumBase?: string): FieldDef => ({
  key,
  page,
  label,
  type: 'enum',
  suffix,
  options,
  enumBase,
});

const str = (key: string, page: string, label: string, suffix: string): FieldDef => ({
  key,
  page,
  label,
  type: 'string',
  get: (cp) => cp.optionValue(suffix) ?? '',
  set: (cp, v) => cp.setOptionValue(suffix, v || undefined),
});

const FIELDS: FieldDef[] = [
  // ---- Target Processor ----
  en('tc', 'target', 'RISC-V Compiler (toolchain)', 'target.rvGcc', [
    ['default', 'Project default (legacy)'],
    ['8', 'WCH Toolchain (GCC8)'],
    ['12', 'WCH Toolchain (GCC12)'],
    ['15', 'WCH Toolchain (GCC15)'],
  ], OPT_BASE + 'target.rvGcc.'),
  en('arch', 'target', 'Architecture', 'target.isa.base', [
    ['rv32i', 'RV32I (-march=rv32i*)'],
    ['rv32e', 'RV32E'],
    ['rv32im', 'RV32IM'],
    ['rv32iac', 'RV32IAC'],
    ['rv32imac', 'RV32IMAC'],
    ['rv32g', 'RV32G'],
    ['rv64i', 'RV64I'],
    ['rv64g', 'RV64G'],
  ], OPT_BASE + 'target.arch.'),
  bool('rvm', 'target', 'Multiply extension (RVM)', 'target.isa.multiply'),
  bool('rva', 'target', 'Atomic extension (RVA)', 'target.isa.atomic'),
  bool('rvc', 'target', 'Compressed extension (RVC)', 'target.isa.compressed'),
  bool('rvxw', 'target', 'Extra Compressed extension (RVXW)', 'target.isa.xw'),
  bool('rvb', 'target', 'Bit extension (RVB)', 'target.isa.b'),
  bool('rvzmmul', 'target', 'Multiplication subset of the M extension (Zmmul)', 'target.isa.zmmul'),
  en('abi', 'target', 'Integer ABI', 'target.abi.integer', [
    ['ilp32', 'ILP32 (-mabi=ilp32*)'],
    ['ilp32e', 'ILP32E'],
    ['lp64', 'LP64'],
  ], OPT_BASE + 'abi.integer.'),
  en('fpabi', 'target', 'Floating point ABI', 'target.abi.fp', [
    ['none', 'None'],
    ['single', 'Single'],
    ['double', 'Double'],
  ], OPT_BASE + 'abi.fp.'),
  en('codemodel', 'target', 'Code model', 'target.codemodel', [
    ['any', 'MedAny'],
    ['low', 'MedLow'],
    ['medium', 'MedMedium'],
  ], OPT_BASE + 'target.codemodel.'),
  F({
    key: 'tune',
    page: 'target',
    label: 'Tuning (-mtune, empty = toolchain default)',
    type: 'string',
    // stored value may be a full CDT enum ("...target.tune.default"): show
    // the short name and write back a clean plain value (or clear it)
    get: (cp) => {
      const raw = cp.optionValue('target.tune');
      if (!raw) return '';
      const s = raw.includes('.') ? raw.split('.').pop()! : raw;
      return /^default$/i.test(s.trim()) ? '' : s.trim();
    },
    set: (cp, v) => {
      const t = v.trim();
      cp.setOptionValue('target.tune', !t || /^default$/i.test(t) ? undefined : t);
    },
  }),
  en('align', 'target', 'Align', 'target.align', [
    ['default', 'Default'],
    ['strict', '-mstrict-align'],
    ['nostrict', '-mno-strict-align'],
  ]),
  str('sdl', 'target', 'Small data limit', 'target.smalldatalimit'),
  bool('savere', 'target', 'Save restore (-msave-restore)', 'target.saverestore'),
  str('targetother', 'target', 'Other target flags', 'target.other'),

  // ---- Optimization ----
  en('optlevel', 'opt', 'Optimization Level', 'optimization.level', [
    ['size', 'Optimize size (-Os)'],
    ['none', 'None (-O0)'],
    ['optimize', 'Optimize (-O1)'],
    ['more', 'Optimize more (-O2)'],
    ['most', 'Optimize most (-O3)'],
    ['fast', 'Optimize fast (-Ofast)'],
    ['debug', 'Optimize for debug (-Og)'],
    ['z', 'Optimize aggressively for size (-Oz)'],
  ], OPT_BASE + 'optimization.level.'),
  bool('msglen', 'opt', 'Message length (-fmessage-length=0)', 'optimization.messagelength'),
  bool('signedchar', 'opt', "'char' is signed (-fsigned-char)", 'optimization.signedchar'),
  bool('funcsec', 'opt', 'Function sections (-ffunction-sections)', 'optimization.functionsections'),
  bool('datasec', 'opt', 'Data sections (-fdata-sections)', 'optimization.datasections'),
  bool('nocommon', 'opt', 'No common unitialized (-fno-common)', 'optimization.nocommon'),
  bool('noinline', 'opt', 'Do not inline functions (-fno-inline-functions)', 'optimization.noinlinefunctions'),
  bool('freestanding', 'opt', 'Assume freestanding environment (-ffreestanding)', 'optimization.freestanding'),
  bool('nobuiltin', 'opt', 'Disable builtin (-fno-builtin)', 'optimization.nobuiltin'),
  bool('spconst', 'opt', 'Single precision constants (-fsingle-precision-constant)', 'optimization.spconstant'),
  bool('pic', 'opt', 'Position independent code (-fPIC)', 'optimization.PIC'),
  bool('lto', 'opt', 'Link-time optimizer (-flto)', 'optimization.lto'),
  bool('nomoveloop', 'opt', 'Disable loop invariant move (-fno-move-loop-invariants)', 'optimization.nomoveloopinvariants'),
  bool('highcode', 'opt', 'Optimize unused sections declared as high code (--param=highcode-gen-section-name=1)', 'optimization.mrs.highcode'),
  bool('asmsoftlib', 'opt', 'Use wchsoftlib when generate library (-Xassembler -wchsoftlib)', 'optimization.mrs.asmsoftlib'),
  bool('pipe', 'opt', 'Use pipeline to replace temporary files (-pipe)', 'optimization.mrs.pipe'),
  bool('caret', 'opt', 'Show caret indicating the column (-fno-diagnostics-show-caret)', 'optimization.mrs.caret'),
  bool('ccv', 'opt', 'Calling convention variant (--param=ccv-abi=1, GCC15)', 'optimization.mrs.ccv'),
  str('otheropt', 'opt', 'Other optimization flags', 'optimization.other'),

  // ---- Warnings ----
  bool('wsyntaxonly', 'warn', 'Check syntax only (-fsyntax-only)', 'warnings.syntaxonly'),
  bool('wpedantic', 'warn', 'Pedantic (-pedantic)', 'warnings.pedantic'),
  bool('wpedanticerr', 'warn', 'Pedantic warnings as errors (-pedantic-errors)', 'warnings.pedanticerrors'),
  bool('wnowarn', 'warn', 'Inhibit all warnings (-w)', 'warnings.nowarn'),
  bool('wtoerrors', 'warn', 'Generate errors instead of warnings (-Werror)', 'warnings.toerrors'),
  bool('wunused', 'warn', 'Warn on various unused elements (-Wunused)', 'warnings.unused'),
  bool('wuninit', 'warn', 'Warn on uninitialized variables (-Wuninitialized)', 'warnings.uninitialized'),
  bool('wall', 'warn', 'Enable all common warnings (-Wall)', 'warnings.allwarn'),
  bool('wextra', 'warn', 'Enable extra warnings (-Wextra)', 'warnings.extrawarn'),
  bool('wmissingdecl', 'warn', 'Warn on undeclared global function (-Wmissing-declarations)', 'warnings.missingdeclaration'),
  bool('wconversion', 'warn', 'Warn on implicit conversions (-Wconversion)', 'warnings.conversion'),
  bool('wpointerarith', 'warn', 'Warn if pointer arithmetic (-Wpointer-arith)', 'warnings.pointerarith'),
  bool('wpadded', 'warn', 'Warn if padding is included (-Wpadded)', 'warnings.padded'),
  bool('wshadow', 'warn', 'Warn if shadowed variable (-Wshadow)', 'warnings.shadow'),
  bool('wlogicalop', 'warn', 'Warn if suspicious logical ops (-Wlogical-op)', 'warnings.logicalop'),
  bool('waggregatereturn', 'warn', 'Warn if struct is returned (-Waggregate-return)', 'warnings.agreggatereturn'),
  bool('wfloatequal', 'warn', 'Warn if floats are compared as equal (-Wfloat-equal)', 'warnings.floatequal'),
  str('warnother', 'warn', 'Other warning flags', 'warnings.other'),

  // ---- Debugging ----
  en('dbglevel', 'dbg', 'Debug level', 'debugging.level', [
    ['default', 'Default (-g)'],
    ['none', 'None'],
    ['minimal', 'Minimal (-g1)'],
    ['max', 'Maximum (-g3)'],
  ], OPT_BASE + 'debugging.level.'),
  en('dbgformat', 'dbg', 'Debug format', 'debugging.format', [
    ['default', 'Default'],
    ['gdb', 'gdb (-ggdb)'],
    ['stabs', 'stabs'],
    ['stabsplus', 'stabs+'],
    ['dwarf2', 'DWARF-2'],
    ['dwarf3', 'DWARF-3'],
    ['dwarf4', 'DWARF-4'],
    ['dwarf5', 'DWARF-5'],
  ], OPT_BASE + 'debugging.format.'),
  bool('prof', 'dbg', 'Generate prof information (-p)', 'debugging.prof'),
  bool('gprof', 'dbg', 'Generate gprof information (-pg)', 'debugging.gprof'),
  str('dbgother', 'dbg', 'Other debugging flags', 'debugging.other'),

  // ---- C Compiler / Preprocessor ----
  list('defs', 'c.pp', 'Defined symbols (-D), one per line', 'c.compiler.defs'),
  list('undefs', 'c.pp', 'Undefined symbols (-U), one per line', 'c.compiler.undef'),
  // ---- C Compiler / Includes ----
  list('incs', 'c.inc', 'Include paths (-I), one per line', 'c.compiler.include.paths'),
  list('sysincs', 'c.inc', 'Include system paths (-isystem), one per line', 'c.compiler.include.systempaths'),
  list('fileincs', 'c.inc', 'Include files (-include), one per line', 'c.compiler.include.files'),
  // ---- C Compiler / Optimization ----
  en('std', 'c.opt', 'Language standard', 'c.compiler.std', [
    ['gnu99', 'gnu99'],
    ['c99', 'c99'],
    ['gnu11', 'gnu11'],
    ['c11', 'c11'],
    ['gnu17', 'gnu17'],
    ['c17', 'c17'],
    ['gnu90', 'gnu90'],
    ['iso9899.1994090', 'iso9899:199409'],
    ['c2x', 'c2x'],
    ['gnu2x', 'gnu2x'],
    ['ansi', 'ansi'],
  ], OPT_BASE + 'c.compiler.std.'),
  str('cotheropt', 'c.opt', 'Other optimization flags', 'c.compiler.otheroptimizations'),
  // ---- C Compiler / Warnings ----
  bool('wmissproto', 'c.warn', 'Warn if a global function has no prototype (-Wmissing-prototypes)', 'c.compiler.warning.missingprototypes'),
  bool('wstrictproto', 'c.warn', 'Warn if a function has no arg type (-Wstrict-prototypes)', 'c.compiler.warning.strictprototypes'),
  bool('wbadcast', 'c.warn', 'Warn if wrong cast (-Wbad-function-cast)', 'c.compiler.warning.badfunctioncast'),
  str('cotherwarn', 'c.warn', 'Other warning flags', 'c.compiler.otherwarnings'),
  // ---- C Compiler / Miscellaneous ----
  bool('casmlisting', 'c.misc', 'Generate assembler listing (-Wa,-adhlns="$@.lst")', 'c.compiler.asmlisting'),
  bool('csavetemps', 'c.misc', 'Save temporary files (--save-temps)', 'c.compiler.savetemps'),
  bool('cverbose', 'c.misc', 'Verbose (-v)', 'c.compiler.verbose'),
  str('cother', 'c.misc', 'Other compiler flags', 'c.compiler.other'),

  // ---- C++ Compiler ----
  en('cppstd', 'cppc', 'C++ language standard', 'cpp.compiler.std', [
    ['default', 'gnu++11 (default)'],
    ['gnucpp98', 'gnu++98'],
    ['cpp11', 'c++11'],
    ['cpp14', 'c++14'],
    ['gnucpp14', 'gnu++14'],
    ['cpp17', 'c++17'],
    ['gnucpp17', 'gnu++17'],
    ['cpp2a', 'c++2a'],
    ['gnucpp2a', 'gnu++2a'],
    ['ansi', 'ansi'],
  ], OPT_BASE + 'cpp.compiler.std.'),
  list('cppdefs', 'cppc', 'Defined symbols (-D), one per line', 'cpp.compiler.defs'),
  list('cppundefs', 'cppc', 'Undefined symbols (-U), one per line', 'cpp.compiler.undef'),
  list('cppincs', 'cppc', 'Include paths (-I), one per line', 'cpp.compiler.include.paths'),
  bool('cppnoexc', 'cppc', 'Do not use exceptions (-fno-exceptions)', 'cpp.compiler.noexceptions'),
  bool('cppnortti', 'cppc', 'Do not use RTTI (-fno-rtti)', 'cpp.compiler.nortti'),
  bool('cppnocxa', 'cppc', 'Do not use __cxa_atexit (-fno-use-cxa-atexit)', 'cpp.compiler.nousecxaatexit'),
  bool('cppnthreads', 'cppc', 'Do not use thread-safe statics (-fno-threadsafe-statics)', 'cpp.compiler.nothreadsafestatics'),
  en('cppabi', 'cppc', 'ABI version (-fabi-version=)', 'cpp.compiler.abiversion', [
    ['default', 'Default (0)'],
    ['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'],
    ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'], ['10', '10'], ['11', '11'], ['12', '12'], ['13', '13'],
  ], OPT_BASE + 'cpp.compiler.abiversion.'),
  str('cppotheropt', 'cppc', 'Other optimization flags', 'cpp.compiler.otheroptimizations'),
  str('cppotherwarn', 'cppc', 'Other warning flags', 'cpp.compiler.otherwarnings'),
  str('cppother', 'cppc', 'Other compiler flags', 'cpp.compiler.other'),

  // ---- Assembler / Preprocessor ----
  bool('asmpp', 'asm.pp', 'Use preprocessor (-x assembler-with-cpp)', 'assembler.usepreprocessor'),
  list('asmdefs', 'asm.pp', 'Defined symbols (-D), one per line', 'assembler.defs'),
  list('asmundefs', 'asm.pp', 'Undefined symbols (-U), one per line', 'assembler.undefs'),
  // ---- Assembler / Includes ----
  list('asmincs', 'asm.inc', 'Include paths (-I), one per line', 'assembler.include.paths'),
  // ---- Assembler / Miscellaneous ----
  list('asmflags', 'asm.misc', 'Xassembler flags, one per line', 'assembler.flags'),
  str('asmother', 'asm.misc', 'Other assembler flags', 'assembler.other'),

  // ---- C Linker / General ----
  list('script', 'ld.general', 'Script files (-T), one per line', 'c.linker.scriptfile'),
  bool('nostart', 'ld.general', 'Do not use standard start files (-nostartfiles)', 'c.linker.nostart'),
  bool('nodeflibs', 'ld.general', 'Do not use default libraries (-nodefaultlibs)', 'c.linker.nodeflibs'),
  bool('nostdlibs', 'ld.general', 'No startup or default libs (-nostdlib)', 'c.linker.nostdlibs'),
  bool('gcsec', 'ld.general', 'Remove unused sections (-Xlinker --gc-sections)', 'c.linker.gcsections'),
  bool('printgc', 'ld.general', 'Print removed sections (-Xlinker --print-gc-sections)', 'c.linker.printgcsections'),
  bool('strip', 'ld.general', 'Omit all symbol information (-s)', 'c.linker.strip'),
  bool('nano', 'ld.general', 'Use newlib-nano (--specs=nano.specs)', 'c.linker.usenewlibnano'),
  bool('nosys', 'ld.general', 'Do not use syscalls (--specs=nosys.specs)', 'c.linker.usenewlibnosys'),
  bool('floatprintf', 'ld.general', 'Use float with nano printf (-u _printf_float)', 'c.linker.useprintffloat'),
  bool('floatscanf', 'ld.general', 'Use float with nano scanf (-u _scanf_float)', 'c.linker.usescanffloat'),
  str('mapfile', 'ld.general', 'Map file name (empty = <target>.map)', 'c.linker.mapfilename'),
  bool('cref', 'ld.general', 'Cross reference (-Xlinker --cref)', 'c.linker.cref'),
  bool('printmap', 'ld.general', 'Print link map (-Xlinker --print-map)', 'c.linker.printmap'),
  bool('ldverbose', 'ld.general', 'Verbose (-v)', 'c.linker.verbose'),
  str('ldother', 'ld.general', 'Other linker flags', 'c.linker.other'),
  // ---- C Linker / Libraries ----
  list('libs', 'ld.libs', 'Libraries (-l), one per line (no lib prefix / .a suffix)', 'c.linker.libs'),
  list('libpaths', 'ld.libs', 'Library search path (-L), one per line', 'c.linker.paths'),
  list('otherobjs', 'ld.libs', 'Other objects (extra .o/.a), one per line', 'c.linker.otherobjs'),
  bool('wchprintf', 'ld.libs', 'Use WCH optimized printf (-lprintf)', 'c.linker.printf'),
  bool('wchprintfloat', 'ld.libs', 'Use WCH optimized printf with float (-lprintfloat)', 'c.linker.printfloat'),
  bool('iqmath', 'ld.libs', 'Link IQMath library (-lIQmath_RV32)', 'c.linker.iqmath'),
  // ---- C Linker / Miscellaneous ----
  list('ldflags', 'ld.misc', 'Xlinker flags, one per line', 'c.linker.flags'),

  // ---- C++ Linker ----
  list('cppscript', 'cppld', 'Script files (-T), one per line', 'cpp.linker.scriptfile'),
  bool('cppgcsec', 'cppld', 'Remove unused sections (-Xlinker --gc-sections)', 'cpp.linker.gcsections'),
  list('cpplibs', 'cppld', 'Libraries (-l), one per line', 'cpp.linker.libs'),
  list('cpplibpaths', 'cppld', 'Library search path (-L), one per line', 'cpp.linker.paths'),
  list('cppotherobjs', 'cppld', 'Other objects, one per line', 'cpp.linker.otherobjs'),
  bool('cppnano', 'cppld', 'Use newlib-nano (--specs=nano.specs)', 'cpp.linker.usenewlibnano'),
  bool('cppnosys', 'cppld', 'Do not use syscalls (--specs=nosys.specs)', 'cpp.linker.usenewlibnosys'),
  bool('cppwchprintf', 'cppld', 'Use WCH optimized printf (-lprintf)', 'cpp.linker.printf'),
  bool('cppwchprintfloat', 'cppld', 'Use WCH printf with float (-lprintfloat)', 'cpp.linker.printfloat'),
  bool('cppiqmath', 'cppld', 'Link IQMath library (-lIQmath_RV32)', 'cpp.linker.iqmath'),

  // ---- Create Flash Image / General ----
  bool('flash', 'artifact', 'Create flash image', 'addtools.createflash'),
  en('flashfmt', 'artifact', 'Output file format (-O)', 'createflash.choice', [
    ['ihex', 'Intel HEX (.hex)'],
    ['binary', 'Binary (.bin)'],
    ['ihexAndbinary', 'Intel HEX + Binary (.hex + .bin)'],
  ], OPT_BASE + 'createflash.choice.'),
  bool('flashtext', 'artifact', 'Copy only .text section (-j .text)', 'createflash.textsection'),
  bool('flashdata', 'artifact', 'Copy only .data section (-j .data)', 'createflash.datasection'),
  list('flashsections', 'artifact', 'Copy only named sections (-j), one per line', 'createflash.othersection'),
  str('flashother', 'artifact', 'Other objcopy flags', 'createflash.other'),
  bool('lst', 'artifact', 'Create extended listing (.lst)', 'addtools.createlisting'),
  bool('lstdebug', 'artifact', 'Listing: display debug info (--debugging)', 'createlisting.debugging'),
  bool('lstfileheaders', 'artifact', 'Listing: display file headers (-f)', 'createlisting.fileheaders'),
  bool('lstreloc', 'artifact', 'Listing: display relocation info (-r)', 'createlisting.reloc'),
  bool('lstsymbols', 'artifact', 'Listing: display symbols (--syms)', 'createlisting.symbols'),
  bool('size', 'artifact', 'Print size (.siz)', 'addtools.printsize'),
];

interface PageDef {
  key: string;
  /** nav label; group headers have no key of their own */
  title: string;
  group?: string;
  description: string;
}

const PAGES: PageDef[] = [
  { key: 'target', title: 'Target Processor', group: 'Tool Settings', description: 'RISC-V compiler toolchain and target processor settings: architecture, extensions, ABI, code model.' },
  { key: 'opt', title: 'Optimization', group: 'Tool Settings', description: 'Global optimization option settings, which can change the optimization level and individual optimization parameters.' },
  { key: 'warn', title: 'Warnings', group: 'Tool Settings', description: 'Global warning options emitted for all compile steps.' },
  { key: 'dbg', title: 'Debugging', group: 'Tool Settings', description: 'Debug information level and format for the produced ELF.' },
  { key: 'asm.pp', title: 'Preprocessor', group: 'GNU RISC-V Cross Assembler', description: 'Assembler preprocessor options (-x assembler-with-cpp, defines).' },
  { key: 'asm.inc', title: 'Includes', group: 'GNU RISC-V Cross Assembler', description: 'Assembler include search paths (-I).' },
  { key: 'asm.misc', title: 'Miscellaneous', group: 'GNU RISC-V Cross Assembler', description: 'Other assembler options (-Xassembler flags etc.).' },
  { key: 'c.pp', title: 'Preprocessor', group: 'GNU RISC-V Cross C Compiler', description: 'C preprocessor defined/undefined symbols (-D / -U).' },
  { key: 'c.inc', title: 'Includes', group: 'GNU RISC-V Cross C Compiler', description: 'C include search paths (-I / -isystem / -include).' },
  { key: 'c.opt', title: 'Optimization', group: 'GNU RISC-V Cross C Compiler', description: 'C language standard (-std).' },
  { key: 'c.warn', title: 'Warnings', group: 'GNU RISC-V Cross C Compiler', description: 'C-only warning options.' },
  { key: 'c.misc', title: 'Miscellaneous', group: 'GNU RISC-V Cross C Compiler', description: 'Other C compiler options.' },
  { key: 'cppc', title: 'GNU RISC-V Cross C++ Compiler', description: 'C++ language standard, defines, includes and C++-specific switches.' },
  { key: 'ld.general', title: 'General', group: 'GNU RISC-V Cross C Linker', description: 'Linker script, standard files/libs switches, specs and map file options.' },
  { key: 'ld.libs', title: 'Libraries', group: 'GNU RISC-V Cross C Linker', description: 'Libraries (-l, without lib prefix and .a suffix), search paths (-L), extra objects, and WCH libraries (printf / IQMath).' },
  { key: 'ld.misc', title: 'Miscellaneous', group: 'GNU RISC-V Cross C Linker', description: 'Xlinker flags passed before the map option.' },
  { key: 'cppld', title: 'GNU RISC-V Cross C++ Linker', description: 'C++ linker: script, libraries, search paths and WCH libraries.' },
  { key: 'artifact', title: 'GNU RISC-V Cross Create Flash Image', description: 'Flash image generation: hex / bin (or both), section copy options, listing and size report.' },
];

function readEnum(cp: Cproject, f: FieldDef): string {
  if (!f.suffix) return '';
  const raw = cp.optionValue(f.suffix);
  if (raw === undefined || raw === '') return 'default';
  if (f.enumBase && raw.startsWith(f.enumBase)) {
    return raw.slice(f.enumBase.length);
  }
  return raw;
}

export class ConfigView {
  private panel: vscode.WebviewPanel | null = null;
  private project: MrsProject | null = null;

  constructor(
    private store: ProjectStore,
    private context: vscode.ExtensionContext
  ) {}

  async show(proj?: MrsProject): Promise<void> {
    const project = proj ?? this.store.active;
    if (!project) {
      vscode.window.showErrorMessage('No active MRS project.');
      return;
    }
    this.project = project;
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel('mrs2.config', `Properties - ${project.projectName}`, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    }
    this.panel.title = `Properties - ${project.projectName}`;
    this.panel.webview.html = this.render(project);
  }

  private onMessage(m: { command: string; values?: Record<string, string> }): void {
    const project = this.project;
    if (!project || !this.panel) return;
    if (m.command === 'close') {
      this.panel.dispose();
      return;
    }
    if (m.command === 'save' && m.values) {
      try {
        const cp = Cproject.load(project.root);
        for (const f of FIELDS) {
          const v = m.values[f.key];
          if (v === undefined) continue;
          if (f.type === 'bool') {
            // create=true: options absent from .cproject must be created on check
            if (f.suffix) cp.setOptionBool(f.suffix, v === '1', true);
          } else if (f.type === 'enum') {
            if (!f.suffix) continue;
            if (f.enumBase) {
              cp.setOptionValue(f.suffix, v === 'default' ? undefined : f.enumBase + v);
            } else {
              cp.setOptionValue(f.suffix, v === 'default' ? undefined : v);
            }
          } else if (f.type === 'list' || f.type === 'string') {
            f.set?.(cp, v);
          }
        }
        cp.save();
        project.reload();
        this.panel.webview.postMessage({ command: 'saved' });
        vscode.window.showInformationMessage(`MRVC: saved ${path.basename(project.root)}/.cproject`);
      } catch (e) {
        vscode.window.showErrorMessage(`MRVC: failed to save configuration (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }

  private fieldHtml(cp: Cproject, f: FieldDef): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const value = f.type === 'bool' || f.type === 'enum' ? readEnum(cp, f) : (f.get?.(cp) ?? '');
    if (f.type === 'bool') {
      return `<label class="check"><input type="checkbox" data-key="${f.key}" ${value === 'true' ? 'checked' : ''}><span>${esc(f.label)}</span></label>`;
    }
    if (f.type === 'enum') {
      const opts = (f.options ?? [])
        .map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`)
        .join('');
      return `<div class="fld"><label>${esc(f.label)}</label><select data-key="${f.key}">${opts}</select></div>`;
    }
    if (f.type === 'list') {
      return `<div class="fld"><label>${esc(f.label)}</label><textarea data-key="${f.key}" rows="4" spellcheck="false">${esc(value)}</textarea></div>`;
    }
    return `<div class="fld"><label>${esc(f.label)}</label><input type="text" data-key="${f.key}" value="${esc(value)}" spellcheck="false"></div>`;
  }

  private render(project: MrsProject): string {
    const cp = project.cproject;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // group pages by their MRVC group
    const groups: Array<{ group: string; pages: PageDef[] }> = [];
    for (const p of PAGES) {
      const g = groups.find((x) => x.group === (p.group ?? p.title));
      if (g) g.pages.push(p);
      else groups.push({ group: p.group ?? p.title, pages: p.group ? [p] : [{ ...p, title: p.title }] });
    }

    const nav = groups
      .map((g) => {
        if (g.pages.length === 1 && g.pages[0].title === g.group) {
          const key = g.pages[0].key;
          return `<div class="nav-item" data-page="${key}">${esc(g.group)}</div>`;
        }
        const items = g.pages
          .map((p) => `<div class="nav-item sub" data-page="${p.key}">${esc(p.title)}</div>`)
          .join('');
        return `<details open><summary>${esc(g.group)}</summary>${items}</details>`;
      })
      .join('');

    const pages = PAGES.map((p, i) => {
      const fields = FIELDS.filter((f) => f.page === p.key)
        .map((f) => this.fieldHtml(cp, f))
        .join('\n');
      return `<div class="page" data-page="${p.key}" data-title="${esc(p.title)}" data-desc="${esc(p.description)}" style="display:${i === 0 ? 'block' : 'none'}">${fields}</div>`;
    }).join('\n');

    const descDefault = PAGES[0];

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; }
#head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-editorWidget-border); }
#head .title { font-weight: 600; }
#head .cfg { display: flex; align-items: center; gap: 6px; margin-left: auto; color: var(--vscode-descriptionForeground); }
#head input { width: 90px; }
#main { flex: 1; display: flex; min-height: 0; }
#nav { width: 235px; flex: none; overflow: auto; border-right: 1px solid var(--vscode-editorWidget-border); padding: 6px 0; }
#nav details { margin: 0; }
#nav summary { padding: 4px 10px; cursor: pointer; font-weight: 600; list-style: none; }
#nav summary::before { content: '▸ '; opacity: .6; }
#nav details[open] summary::before { content: '▾ '; }
#nav .nav-item { padding: 4px 10px 4px 24px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#nav .nav-item:hover { background: var(--vscode-list-hoverBackground); }
#nav .nav-item.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
#content { flex: 1; overflow: auto; padding: 12px 18px; }
.fld { margin-bottom: 12px; }
.fld > label { display: block; margin-bottom: 4px; }
.fld select, .fld input[type=text] { width: 100%; box-sizing: border-box; }
.fld textarea { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); font-size: 12.5px; }
input[type=text], select, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 6px; font-family: var(--vscode-font-family); font-size: 13px; }
textarea { resize: vertical; }
.check { display: flex; align-items: center; gap: 7px; margin: 7px 0; }
.check input { margin: 0; }
.check input:checked + span { color: var(--vscode-charts-blue); }
#desc { flex: none; border-top: 1px solid var(--vscode-editorWidget-border); padding: 8px 12px; min-height: 52px; }
#desc .t { font-weight: 600; }
#desc .d { color: var(--vscode-descriptionForeground); }
#bar { flex: none; display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--vscode-editorWidget-border); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 18px; cursor: pointer; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
#status { margin-right: auto; align-self: center; font-size: 12px; opacity: 0; transition: opacity .3s; }
</style></head><body>
<div id="head">
  <span class="title">${esc(project.projectName)} — Project Properties</span>
  <span class="cfg">Configuration <input type="text" value="${esc(cp.configName)}" readonly></span>
</div>
<div id="main">
  <div id="nav">${nav}</div>
  <div id="content">${pages}</div>
</div>
<div id="desc"><div class="t">${esc(descDefault.title)}</div><div class="d">${esc(descDefault.description)}</div></div>
<div id="bar">
  <span id="status">Saved ✓</span>
  <button id="apply">Apply</button>
  <button id="cancel" class="secondary">Cancel</button>
</div>
<script>
const vscode = acquireVsCodeApi();
const desc = document.getElementById('desc');
function showPage(key) {
  document.querySelectorAll('.page').forEach((p) => {
    p.style.display = p.dataset.page === key ? 'block' : 'none';
    if (p.dataset.page === key) {
      desc.querySelector('.t').textContent = p.dataset.title;
      desc.querySelector('.d').textContent = p.dataset.desc;
    }
  });
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('sel', n.dataset.page === key));
}
document.querySelectorAll('.nav-item').forEach((n) => n.addEventListener('click', () => showPage(n.dataset.page)));
showPage('target');
document.getElementById('apply').addEventListener('click', () => {
  const values = {};
  document.querySelectorAll('[data-key]').forEach((el) => {
    values[el.dataset.key] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
  });
  vscode.postMessage({ command: 'save', values });
});
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ command: 'close' }));
window.addEventListener('message', (e) => {
  if (e.data.command === 'saved') {
    const s = document.getElementById('status');
    s.style.opacity = '1';
    setTimeout(() => (s.style.opacity = '0'), 1600);
  }
});
</script>
</body></html>`;
  }
}
