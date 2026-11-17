/**
 * Project properties webview — MRVC-style dialog: category tree on the
 * left, one settings page at a time on the right, description pane and
 * Apply/Cancel at the bottom. Edits .cproject options in place; option
 * suffixes are the canonical CDT ones so MRVC still opens the project.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ProjectStore, MrsProject, getInstall } from './projects';
import { Cproject } from '../core/cproject';
import { TemplateData, readTemplate, writeTemplate } from '../core/templateFile';
import { ADDRESS_RE, displayTargetPath } from '../core/flash';
import { resolveDownloadTarget } from './flash';
import { ChipDb, chipDbRoot, scanChipDb, chipForTemplate } from '../core/chipdb';
import { strictXmlFileError } from '../core/audit';
import { WlinkArgs, WlinkOp, describeResult, runWlinkOp } from '../core/wlink';
import { t } from '../core/i18n';

export type FieldType = 'bool' | 'enum' | 'string' | 'list';

export interface FieldDef {
  key: string;
  page: string;
  label: string;
  type: FieldType;
  /** cproject option suffix (bool/enum) */
  suffix?: string;
  /** full CDT enumeration prefix. A 'default' entry in `options` is a REAL
   *  CDT choice (align / debugging.level / debugging.format) and is written
   *  explicitly as enumBase+'default'; without such an entry 'default' means
   *  "unset" and maps to setOptionValue(undefined), which PRESERVES the
   *  attribute of an existing enumerated option (MRS's reader crashes on a
   *  missing one) */
  enumBase?: string;
  options?: Array<[string, string]>;
  /** displayed value when the option is absent or carries no value. MRS2's
   *  own EP model initialises these fields in its constructors (e.g.
   *  ECCompiler.language_standard="gnu11", EPrintSize.size_format="berkeley",
   *  ECreateFlashImage.outputFileFormat="ihex", RISCVTargetProcessor
   *  architecture/integer_ABI="default", small_data_limit=8, Tuning
   *  "default", addtools enabled=true), so its property pages show those
   *  values — not blanks — while the .cproject stores nothing */
  def?: string;
  /** string field rendered as a one-line <input> like MRS's el-input
   *  (Small data limit / Generate map); default is the tall textarea that
   *  MRS uses for the "Other ... flags" fields */
  multiline?: boolean;
  get?: (cp: Cproject) => string;
  set?: (cp: Cproject, value: string) => void;
  /** .template key (chip identity / download address) instead of .cproject */
  tplKey?: string;
  /** read-only .template display (values maintained by MRVC/MRS2 logic) */
  tplReadonly?: boolean;
}

const OPT_BASE = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';

function F(def: FieldDef): FieldDef {
  return def;
}

/** list option; `def` rows are shown when nothing is stored. Only fields whose
 *  MRS model carries a non-empty default get one (e.g. the link map filename);
 *  c.linker.flags / c.linker.paths default to [] in the MRS model, so their
 *  tables stay empty until the project stores rows. */
const list = (key: string, page: string, label: string, suffix: string, def: string[] = []): FieldDef => ({
  key,
  page,
  label,
  type: 'list',
  suffix,
  get: (cp) => {
    const v = cp.listOption(suffix).values;
    return (v.length ? v : def).join('\n');
  },
  set: (cp, v) =>
    cp.setOptionList(
      suffix,
      v
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s)
    ),
});

const bool = (key: string, page: string, label: string, suffix: string, def = false): FieldDef => ({
  key,
  page,
  label,
  type: 'bool',
  suffix,
  def: def ? 'true' : undefined,
});

const en = (
  key: string,
  page: string,
  label: string,
  suffix: string,
  options: Array<[string, string]>,
  enumBase?: string,
  def?: string
): FieldDef => ({
  key,
  page,
  label,
  type: 'enum',
  suffix,
  options,
  enumBase,
  def,
});

/** scalar string option; `def` is shown when the option is NOT stored in the
 *  .cproject — MRS2 renders the toolchain's default in that case (e.g. the
 *  Generate map field shows the default map filename even though EVT
 *  projects never persist it), while a plain empty fallback showed blank */
const str = (key: string, page: string, label: string, suffix: string, def = '', multiline = true): FieldDef => ({
  key,
  page,
  label,
  type: 'string',
  suffix,
  def,
  multiline,
  get: (cp) => cp.optionValue(suffix) ?? def,
  set: (cp, v) => cp.setOptionValue(suffix, v || undefined),
});

/** .template-backed text field (chip identity / download address) */
const tpl = (key: string, page: string, label: string, tplKey: string, readonly = false): FieldDef => ({
  key,
  page,
  label,
  type: 'string',
  tplKey,
  tplReadonly: readonly,
});

export const FIELDS: FieldDef[] = [
  // ---- Target Processor ----
  // NO 'default' choice here: enumerated options must always carry a value
  // attribute (MRS's reader crashes on a missing one — 2026-11-12), so
  // 'default' would be a silent no-op after the clear-path guard.
  en('tc', 'target', 'RISC-V Compiler (toolchain)', 'target.rvGcc', [
    ['8', 'WCH Toolchain (GCC8)'],
    ['12', 'WCH Toolchain (GCC12)'],
    ['15', 'WCH Toolchain (GCC15)'],
  ], OPT_BASE + 'target.rvGcc.'),
  en('arch', 'target', 'Architecture', 'target.isa.base', [
    ['default', 'Toolchain Default'],
    ['rv32i', 'RV32I (-march=rv32i*)'],
    ['rv64i', 'RV64I (-march=rv64i*)'],
    ['rv32e', 'RV32E (-march=rv32e*)'],
    ['rv32g', 'RV32G (-march=rv32g*)'],
    ['rv64g', 'RV64G (-march=rv64g*)'],
    ['rv32im', 'RV32IM (-march=rv32im*)'],
    ['rv32iac', 'RV32IAC (-march=rv32iac*)'],
    ['rv32imac', 'RV32IMAC (-march=rv32imac*)'],
  ], OPT_BASE + 'target.arch.'),
  bool('rvm', 'target', 'Multiply extension (RVM)', 'target.isa.multiply'),
  bool('rva', 'target', 'Atomic extension (RVA)', 'target.isa.atomic'),
  // MRS2 Target Processor order puts the F extension select right after RVA;
  // the stored spelling is `...option.isa.fp.<choice>` (the `target.` segment
  // is NOT part of the value id — EVT .cproject evidence)
  en('fp', 'target', 'Floating point', 'target.isa.fp', [
    ['none', 'None'],
    ['single', 'Single precision extension(RVF)'],
    ['double', 'Double precision extension(RVFD)'],
    ['quad', 'Quad precision extension(RVFDQ)'],
  ], OPT_BASE + 'isa.fp.', 'none'),
  bool('rvc', 'target', 'Compressed extension (RVC)', 'target.isa.compressed'),
  bool('rvxw', 'target', 'Extra Compressed extension (RVXW)', 'target.isa.xw'),
  bool('rvb', 'target', 'Bit extension (RVB)', 'target.isa.b'),
  // RVV is a CHECKBOX in MRS2, but the option is enumerated: checked stores
  // the one supported extension set after `...option.isa.rvv.`, unchecked
  // stores the empty suffix (`...option.isa.rvv.`) — never true/false
  F({
    key: 'rvv',
    page: 'target',
    label: 'Vector Cryptography extensions (RVV)',
    type: 'bool',
    suffix: 'target.isa.rvv',
    get: (cp) => {
      const raw = cp.optionValue('target.isa.rvv');
      return raw && raw !== OPT_BASE + 'isa.rvv.' ? 'true' : 'false';
    },
    set: (cp, v) => cp.setOptionValue('target.isa.rvv', v === '1' ? OPT_BASE + 'isa.rvv.zve64x_zvl64b_zvbb' : OPT_BASE + 'isa.rvv.'),
  }),
  bool('rvzmmul', 'target', 'Multiplication subset of the M extension (Zmmul)', 'target.isa.zmmul'),
  en('abi', 'target', 'Integer ABI', 'target.abi.integer', [
    ['default', 'Toolchain default'],
    ['ilp32', 'ILP32 (-mabi=ilp32*)'],
    ['ilp32e', 'ILP32E (-mabi=ilp32e*)'],
    ['lp64', 'LP64 (-mabi=lp64*)'],
  ], OPT_BASE + 'abi.integer.'),
  en('fpabi', 'target', 'Floating point ABI', 'target.abi.fp', [
    ['none', 'None'],
    ['single', 'Single precision(f)'],
    ['double', 'Double precision(d)'],
  ], OPT_BASE + 'abi.fp.'),
  en('tune', 'target', 'Tuning', 'target.tune', [
    ['default', 'Toolchain default'],
    ['rocket', 'Rocket (-mtune=rocket)'],
    ['generic', 'Generic (-mtune=generic) DEPRECATED'],
    ['size', 'Size (-mtune=size)'],
  ], OPT_BASE + 'target.tune.', 'default'),
  en('codemodel', 'target', 'Code model', 'target.codemodel', [
    ['default', 'Toolchain default'],
    ['any', 'Medium Any (-mcmodel=medany)'],
    ['low', 'Medium Low (-mcmodel=medlow)'],
  ], OPT_BASE + 'target.codemodel.'),
  en('align', 'target', 'Align', 'target.align', [
    ['default', 'Toolchain default (-mtune)'],
    ['strict', 'Strict (-mstrict-align)'],
    ['nostrict', 'Not strict (-mno-strict-align)'],
  ], OPT_BASE + 'target.align.'),
  str('sdl', 'target', 'Small data limit', 'target.smalldatalimit', '8', false),
  bool('savere', 'target', 'Small prologue/epilogue (-msave-restore)', 'target.saverestore'),
  str('targetother', 'target', 'Other target flags', 'target.other'),

  // ---- Chip / Target (.template fields; consumed by Download) ----
  tpl('series', 'chip', 'Chip series', 'Series'),
  tpl('mcu', 'chip', 'MCU', 'MCU'),
  tpl('mcutype', 'chip', 'MCU type (series, e.g. CH32V30x)', 'Mcu Type'),
  tpl('link', 'chip', 'Debug link', 'Link'),
  tpl('address', 'chip', 'Flash download address (0x hex)', 'Address'),
  tpl('targetpath', 'chip', 'Firmware target path (managed by build/rename)', 'Target Path', true),

  // ---- C/C++ Build / Build Steps ----
  F({ key: 'prebuild', page: 'buildsteps', label: 'Pre-build Command', type: 'string', get: (cp) => cp.prebuildStep, set: (cp, v) => cp.setBuildIdentity({ prebuildStep: v }) }),
  F({ key: 'prebuilddesc', page: 'buildsteps', label: 'Pre-build Description', type: 'string', get: (cp) => cp.prebuildAnnounce, set: (cp, v) => cp.setBuildIdentity({ prebuildAnnounce: v }) }),
  F({ key: 'postbuild', page: 'buildsteps', label: 'Post-build Command', type: 'string', get: (cp) => cp.postbuildStep, set: (cp, v) => cp.setBuildIdentity({ postbuildStep: v }) }),
  F({ key: 'postbuilddesc', page: 'buildsteps', label: 'Post-build Description', type: 'string', get: (cp) => cp.postbuildAnnounce, set: (cp, v) => cp.setBuildIdentity({ postbuildAnnounce: v }) }),
  // ---- C/C++ Build / Build Artifact ----
  F({ key: 'artifacttype', page: 'buildartifact', label: 'Artifact Type', type: 'enum', options: [['exe', 'Executable'], ['staticLib', 'Static Library']], get: (cp) => cp.artifactType, set: (cp, v) => cp.setBuildIdentity({ artifactType: v as 'exe' | 'staticLib' }) }),
  F({ key: 'artifactname', page: 'buildartifact', label: 'Artifact name', type: 'string', get: (cp) => cp.artifactNameRaw, set: (cp, v) => cp.setBuildIdentity({ artifactName: v || '${ProjName}' }) }),
  F({ key: 'artifactext', page: 'buildartifact', label: 'Artifact extension', type: 'string', get: (cp) => cp.artifactExtension, set: (cp, v) => cp.setBuildIdentity({ artifactExtension: v }) }),
  F({ key: 'outprefix', page: 'buildartifact', label: 'Output prefix', type: 'string', get: (cp) => cp.outputPrefix, set: (cp, v) => cp.setBuildIdentity({ outputPrefix: v }) }),

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
  list('defs', 'c.pp', 'Defined symbols (-D)', 'c.compiler.defs'),
  list('undefs', 'c.pp', 'Undefined symbols (-U)', 'c.compiler.undef'),
  // ---- C Compiler / Includes ----
  list('incs', 'c.inc', 'Include paths (-I)', 'c.compiler.include.paths'),
  list('sysincs', 'c.inc', 'Include system paths (-isystem)', 'c.compiler.include.systempaths'),
  list('fileincs', 'c.inc', 'Include files (-include)', 'c.compiler.include.files'),
  // ---- C Compiler / Optimization ----
  en('std', 'c.opt', 'Language standard', 'c.compiler.std', [
    ['default', 'Toolchain default (GNU ISO C11)'],
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
  ], OPT_BASE + 'c.compiler.std.', 'gnu11'),
  str('cotheropt', 'c.opt', 'Other optimization flags', 'c.compiler.otheroptimizations'),
  // ---- C Compiler / Warnings ----
  bool('wmissproto', 'c.warn', 'Warn if a global function has no prototype (-Wmissing-prototypes)', 'c.compiler.warning.missingprototypes'),
  bool('wstrictproto', 'c.warn', 'Warn if a function has no arg type (-Wstrict-prototypes)', 'c.compiler.warning.strictprototypes'),
  bool('wbadcast', 'c.warn', 'Warn if wrong cast (-Wbad-function-cast)', 'c.compiler.warning.badfunctioncast'),
  str('cotherwarn', 'c.warn', 'Other warning flags', 'c.compiler.otherwarnings'),
  // ---- C Compiler / Miscellaneous ----
  bool('casmlisting', 'c.misc', 'Generate assembler listing (-Wa,-adhlns="$@.lst")', 'c.compiler.asmlisting'),
  bool('csavetemps', 'c.misc', 'Save temporary files (--save-temps Use with caution!)', 'c.compiler.savetemps'),
  bool('cverbose', 'c.misc', 'Verbose (-v)', 'c.compiler.verbose'),
  str('cother', 'c.misc', 'Other compiler flags', 'c.compiler.other'),

  // ---- C++ Compiler / Preprocessor (C++ projects only) ----
  bool('cppnostdinc', 'cpp.pp', 'Do not search system directories (-nostdinc)', 'cpp.compiler.nostdinc'),
  bool('cppnostdincpp', 'cpp.pp', 'Do not search system C++ directories (-nostdinc++)', 'cpp.compiler.nostdincpp'),
  bool('cpppreonly', 'cpp.pp', 'Preprocess only (-E)', 'cpp.compiler.preprocessonly'),
  list('cppdefs', 'cpp.pp', 'Defined symbols (-D)', 'cpp.compiler.defs'),
  list('cppundefs', 'cpp.pp', 'Undefined symbols (-U)', 'cpp.compiler.undef'),
  // ---- C++ Compiler / Includes ----
  list('cppincs', 'cpp.inc', 'Include paths (-I)', 'cpp.compiler.include.paths'),
  list('cppsysincs', 'cpp.inc', 'Include system paths (-isystem)', 'cpp.compiler.include.systempaths'),
  list('cppfileincs', 'cpp.inc', 'Include files (-include)', 'cpp.compiler.include.files'),
  // ---- C++ Compiler / Optimization (MRS layout: standard + ABI + C++
  //      dialect switches + other flags; the MRS page order is kept) ----
  en('cppstd', 'cpp.opt', 'Language standard', 'cpp.compiler.std', [
    ['default', 'Toolchain default (GNU ISO 2014 C++)'],
    // real projects store `gnucpp11` explicitly; the MRS model's initial
    // value is also gnucpp11, so an absent option displays as gnu++11
    ['ansi', 'ISO 1998 C++ incl.2003 amendments (-ansi)'],
    ['gnucpp98', 'GNU ISO 1998 C++ (-std=gnu++98)'],
    ['cpp0x', 'ISO 2011 C++ (-std=c++0x,deprecated)'],
    ['cpp11', 'ISO 2011 C++ (-std=c++11)'],
    ['gnucpp0x', 'GNU ISO 2011 C++ (-std=gnu++0x,deprecated)'],
    ['gnucpp11', 'GNU ISO 2011 C++ (-std=gnu++11)'],
    ['cpp1y', 'GNU ISO 2014 C++ (-std=c++1y,deprecated)'],
    ['cpp14', 'GNU ISO 2014 C++ (-std=c++14)'],
    ['gnucpp1y', 'GNU ISO 2014 C++ (-std=gnu++1y,deprecated)'],
    ['gnucpp14', 'GNU ISO 2014 C++ (-std=gnu++14)'],
    ['cpp1z', 'ISO 2017 C++ (-std=c++1z,deprecated)'],
    ['cpp17', 'ISO 2017 C++ (-std=c++17)'],
    ['gnucpp1z', 'GNU ISO 2017 C++ (-std=gnu++1z,deprecated)'],
    ['gnucpp17', 'GNU ISO 2017 C++ (-std=gnu++17)'],
    ['cpp2a', 'Next ISO C (-std=c++2a)'],
    ['gnucpp2a', 'Next GNU ISO C (-std=gnu++2a)'],
  ], OPT_BASE + 'cpp.compiler.std.', 'gnucpp11'),
  en('cppabi', 'cpp.opt', 'ABI version', 'cpp.compiler.abiversion', [
    // MRS lists the `default` choice too; its model initialises the field to
    // "0", so an absent option displays 0 (most conforming)
    ['default', 'Toolchain default (0, most conforming)'],
    ['0', '0 (most conforming)'], ['1', '1 (from G++3.2)'], ['2', '2 (from G++3.4)'],
    ['3', '3'], ['4', '4 (from G++4.5)'], ['5', '5 (from G++4.6)'], ['6', '6 (from G++4.7)'],
    ['7', '7 (from G++4.8)'], ['8', '8 (from G++4.9)'], ['9', '9 (from G++5.2)'],
    ['10', '10 (from G++6.1)'], ['11', '11 (from G++7)'], ['12', '12 (from G++8)'],
    ['13', '13 (from G++8.2)'],
  ], OPT_BASE + 'cpp.compiler.abiversion.', '0'),
  bool('cppnoexc', 'cpp.opt', 'Do not use exceptions (-fno-exceptions)', 'cpp.compiler.noexceptions'),
  bool('cppnortti', 'cpp.opt', 'Do not use RTTI (-fno-rtti)', 'cpp.compiler.nortti'),
  bool('cppnocxa', 'cpp.opt', 'Do not use __cxa_atexit (-fno-use-cxa-atexit)', 'cpp.compiler.nousecxaatexit'),
  bool('cppnthreads', 'cpp.opt', 'Do not use thread statics (-fno-threadsafe-statics)', 'cpp.compiler.nothreadsafestatics'),
  str('cppotheropt', 'cpp.opt', 'Other optimization flags', 'cpp.compiler.otheroptimizations'),
  // ---- C++ Compiler / Warnings (MRS order / wording) ----
  bool('cppwarnabi', 'cpp.warn', 'Warn on ABI violations (-Wabi)', 'cpp.compiler.warnabi'),
  bool('cppctordtor', 'cpp.warn', 'Warn on class privacy (-Wctor-dtor-privacy)', 'cpp.compiler.warning.ctordtorprivacy'),
  bool('cppnoexcept', 'cpp.warn', 'Warn on no-except expressions (-Wnoexcept)', 'cpp.compiler.warning.noexcept'),
  bool('cppnonvdtor', 'cpp.warn', 'Warn on virtual destructors (-Wnon-virtual-dtor)', 'cpp.compiler.warning.nonvirtualdtor'),
  bool('cppstrictnull', 'cpp.warn', 'Warn on uncast NULL (-Wstrict-null-sentinel)', 'cpp.compiler.warning.strictnullsentinel'),
  bool('cppsignpromo', 'cpp.warn', 'Warn on sign promotion (-Wsign-promo)', 'cpp.compiler.warning.signpromo'),
  bool('cppwarneffc', 'cpp.warn', 'Warn about Effective C++ violations (-Weffc++)', 'cpp.compiler.warneffc'),
  str('cppotherwarn', 'cpp.warn', 'Other warning flags', 'cpp.compiler.otherwarnings'),
  // ---- C++ Compiler / Miscellaneous (MRS layout: these three + other flags;
  //      the -fno-* dialect switches live on the Optimization page) ----
  bool('cppasmlisting', 'cpp.misc', 'Generate assembler listing (-Wa,-adhlns="$@.lst")', 'cpp.compiler.asmlisting'),
  bool('cppsavetemps', 'cpp.misc', 'Save temporary files (--save-temps Use with caution!)', 'cpp.compiler.savetemps'),
  bool('cppverbose', 'cpp.misc', 'Verbose (-v)', 'cpp.compiler.verbose'),
  str('cppother', 'cpp.misc', 'Other compiler flags', 'cpp.compiler.other'),

  // ---- Assembler / Preprocessor ----
  bool('asmpp', 'asm.pp', 'Use preprocessor (-x assembler-with-cpp)', 'assembler.usepreprocessor'),
  bool('asmnostdinc', 'asm.pp', 'Do not search system directories (-nostdinc)', 'assembler.nostdinc'),
  bool('asmpreonly', 'asm.pp', 'Preprocess only (-E)', 'assembler.preprocessonly'),
  list('asmdefs', 'asm.pp', 'Defined symbols (-D)', 'assembler.defs'),
  list('asmundefs', 'asm.pp', 'Undefined symbols (-U)', 'assembler.undefs'),
  // ---- Assembler / Includes ----
  list('asmincs', 'asm.inc', 'Include paths (-I)', 'assembler.include.paths'),
  list('asmsysincs', 'asm.inc', 'Include system paths (-isystem)', 'assembler.include.systempaths'),
  list('asmfileincs', 'asm.inc', 'Include files (-include)', 'assembler.include.files'),
  // ---- Assembler / Warnings ----
  str('asmotherwarn', 'asm.warn', 'Other warning flags (-Wa,...)', 'assembler.otherwarnings'),
  // ---- Assembler / Miscellaneous ----
  bool('asmasmlisting', 'asm.misc', 'Generate assembler listing (-Wa,-adhlns="$@.lst")', 'assembler.asmlisting'),
  bool('asmsavetemps', 'asm.misc', 'Save temporary files (--save-temps Use With caution!)', 'assembler.savetemps'),
  bool('asmverbose', 'asm.misc', 'Verbose (-v)', 'assembler.verbose'),
  list('asmflags', 'asm.misc', 'Xassembler flags, one per line', 'assembler.flags'),
  str('asmother', 'asm.misc', 'Other assembler flags', 'assembler.other'),

  // ---- C Linker / General (MRS layout: script files + standard switches) ----
  list('script', 'ld.general', 'Script files (-T)', 'c.linker.scriptfile'),
  bool('nostart', 'ld.general', 'Do not use standard start files (-nostartfiles)', 'c.linker.nostart', true),
  bool('nodeflibs', 'ld.general', 'Do not use default libraries (-nodefaultlibs)', 'c.linker.nodeflibs'),
  bool('nostdlibs', 'ld.general', 'No startup or default libs (-nostdlib)', 'c.linker.nostdlibs'),
  bool('gcsec', 'ld.general', 'Remove unused sections (-Xlinker --gc-sections)', 'c.linker.gcsections', true),
  bool('printgc', 'ld.general', 'Print removed sections (-Xlinker --print-gc-sections)', 'c.linker.printgcsections'),
  bool('strip', 'ld.general', 'Omit all symbol information (-s)', 'c.linker.strip'),
  // ---- C Linker / Libraries (MRS layout: the two -l / -L lists only) ----
  list('libs', 'ld.libs', 'Libraries Name(-l)', 'c.linker.libs'),
  list('libpaths', 'ld.libs', 'Library search path (-L)', 'c.linker.paths'),
  // ---- C Linker / Miscellaneous (MRS layout: everything else lives here) ----
  list('ldflags', 'ld.misc', 'Linker flags (-Xlinker [option])', 'c.linker.flags'),
  list('otherobjs', 'ld.misc', 'Other objects', 'c.linker.otherobjs'),
  str('mapfile', 'ld.misc', 'Generate map', 'c.linker.mapfilename', '"${BuildArtifactFileBaseName}.map"', false),
  bool('cref', 'ld.misc', 'Cross reference (-Xlinker --cref)', 'c.linker.cref'),
  bool('printmap', 'ld.misc', 'Print link map (-Xlinker --print-map)', 'c.linker.printmap'),
  bool('nano', 'ld.misc', 'Use newlib-nano (--specs=nano.specs)', 'c.linker.usenewlibnano', true),
  bool('floatprintf', 'ld.misc', 'Use float with nano printf (-u _printf_float)', 'c.linker.useprintffloat'),
  bool('floatscanf', 'ld.misc', 'Use float with nano scanf (-u _scanf_float)', 'c.linker.usescanffloat'),
  bool('nosys', 'ld.misc', 'Do not use syscalls (--specs=nosys.specs)', 'c.linker.usenewlibnosys', true),
  bool('ldverbose', 'ld.misc', 'Verbose (-v)', 'c.linker.verbose'),
  bool('wchprintf', 'ld.misc', 'Use WCH optimized printf (-lprintf)', 'c.linker.printf'),
  bool('wchprintfloat', 'ld.misc', 'Use WCH optimized printf with float (-lprintfloat)', 'c.linker.printfloat'),
  bool('iqmath', 'ld.misc', 'Link IQMath library (-lIQMath_RV32)', 'c.linker.iqmath'),
  en(
    'picolibc',
    'ld.misc',
    'Use picolibc',
    'c.linker.picolibc',
    [
      ['disabled', 'Disabled'],
      ['double', 'This offers full printf functionality(-Dformat-default=double)'],
      ['integer', 'This offers integer printf functionality(-Dformat-default=integer)'],
      ['minimal', 'This offers minimal printf functionality(-Dformat-default=minimal)'],
    ],
    OPT_BASE + 'c.linker.picolibc.',
    'disabled'
  ),
  str('ldother', 'ld.misc', 'Other linker flags', 'c.linker.other'),

  // ---- C++ Linker / General (mirror of the C linker layout) ----
  list('cppscript', 'cppld.general', 'Script files (-T)', 'cpp.linker.scriptfile'),
  bool('cppnostart', 'cppld.general', 'Do not use standard start files (-nostartfiles)', 'cpp.linker.nostart'),
  bool('cppnodeflibs', 'cppld.general', 'Do not use default libraries (-nodefaultlibs)', 'cpp.linker.nodeflibs'),
  bool('cppnostdlibs', 'cppld.general', 'No startup or default libs (-nostdlib)', 'cpp.linker.nostdlibs'),
  bool('cppgcsec', 'cppld.general', 'Remove unused sections (-Xlinker --gc-sections)', 'cpp.linker.gcsections'),
  bool('cppprintgc', 'cppld.general', 'Print removed sections (-Xlinker --print-gc-sections)', 'cpp.linker.printgcsections'),
  bool('cppstrip', 'cppld.general', 'Omit all symbol information (-s)', 'cpp.linker.strip'),
  // ---- C++ Linker / Libraries ----
  list('cpplibs', 'cppld.libs', 'Libraries Name(-l)', 'cpp.linker.libs'),
  list('cpplibpaths', 'cppld.libs', 'Library search path (-L)', 'cpp.linker.paths'),
  // ---- C++ Linker / Miscellaneous ----
  list('cppldflags', 'cppld.misc', 'Linker flags (-Xlinker [option])', 'cpp.linker.flags'),
  list('cppotherobjs', 'cppld.misc', 'Other objects', 'cpp.linker.otherobjs'),
  str('cppmapfile', 'cppld.misc', 'Generate map', 'cpp.linker.mapfilename', '"${BuildArtifactFileBaseName}.map"', false),
  bool('cppcref', 'cppld.misc', 'Cross reference (-Xlinker --cref)', 'cpp.linker.cref'),
  bool('cppprintmap', 'cppld.misc', 'Print link map (-Xlinker --print-map)', 'cpp.linker.printmap'),
  bool('cppnano', 'cppld.misc', 'Use newlib-nano (--specs=nano.specs)', 'cpp.linker.usenewlibnano'),
  bool('cppfloatprintf', 'cppld.misc', 'Use float with nano printf (-u _printf_float)', 'cpp.linker.useprintffloat'),
  bool('cppfloatscanf', 'cppld.misc', 'Use float with nano scanf (-u _scanf_float)', 'cpp.linker.usescanffloat'),
  bool('cppnosys', 'cppld.misc', 'Do not use syscalls (--specs=nosys.specs)', 'cpp.linker.usenewlibnosys'),
  bool('cppldverbose', 'cppld.misc', 'Verbose (-v)', 'cpp.linker.verbose'),
  bool('cppwchprintf', 'cppld.misc', 'Use WCH optimized printf (-lprintf)', 'cpp.linker.printf'),
  bool('cppwchprintfloat', 'cppld.misc', 'Use WCH printf with float (-lprintfloat)', 'cpp.linker.printfloat'),
  bool('cppiqmath', 'cppld.misc', 'Link IQMath library (-lIQMath_RV32)', 'cpp.linker.iqmath'),
  en(
    'cpppicolibc',
    'cppld.misc',
    'Use picolibc',
    'cpp.linker.picolibc',
    [
      ['disabled', 'Disabled'],
      ['double', 'This offers full printf functionality(-Dformat-default=double)'],
      ['integer', 'This offers integer printf functionality(-Dformat-default=integer)'],
      ['minimal', 'This offers minimal printf functionality(-Dformat-default=minimal)'],
    ],
    OPT_BASE + 'cpp.linker.picolibc.',
    'disabled'
  ),
  str('cppldother', 'cppld.misc', 'Other linker flags', 'cpp.linker.other'),

  // ---- Create Flash Image / General ----
  bool('flash', 'createflash', 'Create flash image', 'addtools.createflash', true),
  en('flashfmt', 'createflash', 'Output file format (-O)', 'createflash.choice', [
    ['ihex', 'Intel HEX (.hex)'],
    ['binary', 'Binary (.bin)'],
    ['ihexAndbinary', 'Intel HEX + Binary (.hex + .bin)'],
  ], OPT_BASE + 'createflash.choice.', 'ihex'),
  bool('flashtext', 'createflash', 'Copy only .text section (-j .text)', 'createflash.textsection'),
  bool('flashdata', 'createflash', 'Copy only .data section (-j .data)', 'createflash.datasection'),
  list('flashsections', 'createflash', 'Copy only named sections (-j), one per line', 'createflash.othersection'),
  str('flashother', 'createflash', 'Other objcopy flags', 'createflash.other'),
  // ---- Create Flash Listing / General ----
  bool('lst', 'createlisting', 'Create extended listing', 'addtools.createlisting', true),
  bool('lstsource', 'createlisting', 'Display source (--source|-S)', 'createlisting.source'),
  bool('lstallheaders', 'createlisting', 'Display all headers (--all-headers|-x)', 'createlisting.allheaders'),
  bool('lstdemangle', 'createlisting', 'Demangle names (--demangle|-C)', 'createlisting.demangle'),
  bool('lstdebug', 'createlisting', 'Display debugging info (--debugging|-g)', 'createlisting.debugging'),
  bool('lstdisassemble', 'createlisting', 'Disassemble (--disassemble|-d)', 'createlisting.disassemble'),
  bool('lstfileheaders', 'createlisting', 'Display file headers (--file-headers|-f)', 'createlisting.fileheaders'),
  bool('lstlinenumbers', 'createlisting', 'Display line numbers (--line-numbers|-l)', 'createlisting.linenumbers'),
  bool('lstreloc', 'createlisting', 'Display relocation info (--reloc|-r)', 'createlisting.reloc'),
  bool('lstsymbols', 'createlisting', 'Display symbols (--syms|-t)', 'createlisting.symbols'),
  bool('lstwide', 'createlisting', 'Wide lines (--wide|-w)', 'createlisting.wide'),
  str('lstother', 'createlisting', 'Other flags', 'createlisting.other'),
  // ---- Print Size / General ----
  bool('size', 'printsize', 'Create print size', 'addtools.printsize', true),
  en('sizefmt', 'printsize', 'Size format', 'printsize.format', [
    ['berkeley', 'Berkeley'],
    ['sysv', 'SysV'],
  ], OPT_BASE + 'printsize.format.', 'berkeley'),
  bool('sizehex', 'printsize', 'Hex', 'printsize.hex'),
  bool('sizetotals', 'printsize', 'Show totals', 'printsize.totals'),
  str('sizeother', 'printsize', 'Other flags', 'printsize.other'),
];

export interface PageDef {
  key: string;
  /** nav label; group headers have no key of their own */
  title: string;
  group?: string;
  description: string;
}

export const PAGES: PageDef[] = [
  { key: 'chip', title: 'Chip / Target', group: 'General', description: 'Chip identity and download settings stored in the project .template (MRS2-compatible). The address is passed to OpenOCD by Download — keep it matching the chip series (0x00000000 for CH58x, 0x08000000 for CH32V3xx/CH32H417).' },
  { key: 'buildsteps', title: 'Build Steps', group: 'C/C++ Build', description: 'Pre-build and post-build commands executed around the main build.' },
  { key: 'buildartifact', title: 'Build Artifact', group: 'C/C++ Build', description: 'Artifact type, name, extension and output prefix.' },
  { key: 'dlset', title: 'Download Settings', group: 'Download', description: 'Detailed download parameters and WCH-Link operations (read protection, chip query, erase) — mirrors the MRS2 Download Settings page.' },
  { key: 'target', title: 'Target Processor', description: 'RISC-V compiler toolchain and target processor settings: architecture, extensions, ABI, code model.' },
  { key: 'opt', title: 'Optimization', description: 'Global optimization option settings, which can change the optimization level and individual optimization parameters.' },
  { key: 'warn', title: 'Warnings', description: 'Global warning options emitted for all compile steps.' },
  { key: 'dbg', title: 'Debugging', description: 'Debug information level and format for the produced ELF.' },
  { key: 'asm.pp', title: 'Preprocessor', group: 'GNU RISC-V Cross Assembler', description: 'Assembler preprocessor options (-x assembler-with-cpp, -nostdinc, -E, defines).' },
  { key: 'asm.inc', title: 'Includes', group: 'GNU RISC-V Cross Assembler', description: 'Assembler include search paths (-I / -isystem / -include).' },
  { key: 'asm.warn', title: 'Warnings', group: 'GNU RISC-V Cross Assembler', description: 'Assembler warning flags passed with -Wa.' },
  { key: 'asm.misc', title: 'Miscellaneous', group: 'GNU RISC-V Cross Assembler', description: 'Assembler listing, temp files, verbose and other options.' },
  { key: 'c.pp', title: 'Preprocessor', group: 'GNU RISC-V Cross C Compiler', description: 'C preprocessor defined/undefined symbols (-D / -U).' },
  { key: 'c.inc', title: 'Includes', group: 'GNU RISC-V Cross C Compiler', description: 'C include search paths (-I / -isystem / -include).' },
  { key: 'c.opt', title: 'Optimization', group: 'GNU RISC-V Cross C Compiler', description: 'C language standard (-std).' },
  { key: 'c.warn', title: 'Warnings', group: 'GNU RISC-V Cross C Compiler', description: 'C-only warning options.' },
  { key: 'c.misc', title: 'Miscellaneous', group: 'GNU RISC-V Cross C Compiler', description: 'Other C compiler options.' },
  { key: 'ld.general', title: 'General', group: 'GNU RISC-V Cross C Linker', description: 'Overall options such as specifying link script files.' },
  { key: 'ld.libs', title: 'Libraries', group: 'GNU RISC-V Cross C Linker', description: "Settings for importing libraries: '-L library_path' '-l library_name'." },
  { key: 'ld.misc', title: 'Miscellaneous', group: 'GNU RISC-V Cross C Linker', description: 'Other settings include runtime libraries, MRS built-in simplified libraries, calculations, etc.' },
  { key: 'cpp.pp', title: 'Preprocessor', group: 'GNU RISC-V Cross C++ Compiler', description: 'C++ preprocessor: system directory search (-nostdinc/-nostdinc++), preprocess only (-E), defined/undefined symbols.' },
  { key: 'cpp.inc', title: 'Includes', group: 'GNU RISC-V Cross C++ Compiler', description: 'C++ include search paths (-I).' },
  { key: 'cpp.opt', title: 'Optimization', group: 'GNU RISC-V Cross C++ Compiler', description: 'C++ language standard (-std).' },
  { key: 'cpp.warn', title: 'Warnings', group: 'GNU RISC-V Cross C++ Compiler', description: 'C++-specific warning options.' },
  { key: 'cpp.misc', title: 'Miscellaneous', group: 'GNU RISC-V Cross C++ Compiler', description: 'Exceptions, RTTI, ABI version and other C++ compiler options.' },
  { key: 'cppld.general', title: 'General', group: 'GNU RISC-V Cross C++ Linker', description: 'C++ linker script and standard files/sections switches.' },
  { key: 'cppld.libs', title: 'Libraries', group: 'GNU RISC-V Cross C++ Linker', description: 'C++ libraries (-l) and library search paths (-L).' },
  { key: 'cppld.misc', title: 'Miscellaneous', group: 'GNU RISC-V Cross C++ Linker', description: 'Other C++ linker flags.' },
  { key: 'createflash', title: 'General', group: 'GNU RISC-V Cross Create Flash Image', description: 'Flash image generation: hex / bin (or both) and section copy options.' },
  { key: 'createlisting', title: 'General', group: 'GNU RISC-V Cross Create Flash Listing', description: 'Disassembly file settings.' },
  { key: 'printsize', title: 'General', group: 'GNU RISC-V Cross Print Size', description: 'Print size information (.siz) settings.' },
];

/** JSON for inline <script> blocks: escape < so a crafted project name
 * (or SDK string) cannot close the script tag early */
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003C');
}

/**
 * Cross-page macro conflicts in the preprocessor defines: the same macro
 * name defined with different values in the C / C++ / Assembler pages.
 * Values compare as strings; a bare name counts as an empty value.
 */
export function macroConflicts(values: Record<string, string>): string[] {
  const lists: Array<[string, string]> = [
    ['C Compiler', values['defs'] ?? ''],
    ['C++ Compiler', values['cppdefs'] ?? ''],
    ['Assembler', values['asmdefs'] ?? ''],
  ];
  const seen = new Map<string, { value: string; page: string }>();
  const conflicts: string[] = [];
  for (const [page, text] of lists) {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      const name = (eq < 0 ? t : t.slice(0, eq)).trim();
      const value = eq < 0 ? '' : t.slice(eq + 1).trim();
      const prev = seen.get(name);
      if (prev && prev.value !== value) {
        conflicts.push(`${name}: ${prev.page} = "${prev.value || '(no value)'}"  vs  ${page} = "${value || '(no value)'}"`);
      } else if (!prev) {
        seen.set(name, { value, page });
      }
    }
  }
  return conflicts;
}

/** Macros MRS2/Eclipse expands inside list paths. Anything else is almost
 *  always a typo that would silently break the build, so Apply asks first. */
const KNOWN_PATH_MACROS = new Set(['workspace_loc', 'ProjName', 'project', 'workspace_parent', 'build_type', 'config_name']);
const PARENT_LOC_MACRO = /^PARENT-\d+-PROJECT_LOC$/;

export interface PathIssues {
  /** unbalanced ${...} or an invalid macro name — hard error, nothing written */
  malformed: string[];
  /** syntactically valid but unknown macro name — confirm before writing */
  unknown: string[];
  /** the resolved file/folder does not exist right now — confirm before writing */
  missing: string[];
}

/** Scan one list entry for `${...}` macro expressions.
 *  Nested forms such as `${workspace_loc:/${ProjName}/inc}` are legal; every
 *  macro's leading name (before ':') must be a plain identifier. Returns the
 *  macro names even when the syntax is fine (the caller checks them against
 *  the known list). */
export function pathSyntaxProblem(value: string): { problem?: string; names: string[] } {
  const names: string[] = [];
  const stack: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '$' && value[i + 1] === '{') {
      stack.push(i);
      i++;
      continue;
    }
    if (value[i] === '}') {
      if (!stack.length) return { problem: 'unexpected "}"', names };
      const start = stack.pop()!;
      const body = value.slice(start + 2, i);
      const name = body.split(':', 1)[0];
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
        return { problem: `invalid macro name "${body}"`, names };
      }
      if (name === 'workspace_loc' && !body.includes(':')) {
        return { problem: 'workspace_loc needs a path after ":"', names };
      }
      names.push(name);
    }
  }
  if (stack.length) return { problem: 'unclosed "${"', names };
  return { names };
}

/** Resolve one list entry against the project root for the existence check.
 *  `checkable: false` means a macro we cannot expand here (another project's
 *  workspace path) — syntax was already validated, existence is skipped. */
function resolvePathEntry(root: string, raw: string): { path: string; checkable: boolean } {
  // stored listOptions may be wrapped in quotes by CDT; the option getter
  // usually strips them, but a manually typed quoted value should still check
  const t = raw.trim().replace(/^"|"$/g, '');
  const wsPrefix = '${workspace_loc:/${ProjName}/';
  if (t.startsWith(wsPrefix) && t.endsWith('}')) {
    return { path: path.join(root, t.slice(wsPrefix.length, -1)), checkable: true };
  }
  if (t === '${ProjName}' || t === '${workspace_loc:/${ProjName}}') return { path: root, checkable: true };
  for (const prefix of ['${project}/', '${ProjName}/']) {
    if (t.startsWith(prefix)) return { path: path.join(root, t.slice(prefix.length)), checkable: true };
  }
  const parentMatch = t.match(/^\$\{PARENT-(\d+)-PROJECT_LOC\}\/(.+)$/);
  if (parentMatch) {
    let base = root;
    for (let i = 0; i < Number(parentMatch[1]); i++) base = path.dirname(base);
    return { path: path.join(base, parentMatch[2]), checkable: true };
  }
  if (t.includes('${')) return { path: '', checkable: false };
  // Windows drive paths are absolute even where path.isAbsolute disagrees
  // (e.g. "C:foo" is drive-relative — treat a drive letter as absolute)
  if (path.isAbsolute(t) || /^[A-Za-z]:[\\/]/.test(t)) return { path: t, checkable: true };
  return { path: path.join(root, t), checkable: true };
}

/**
 * Validate the path-like list entries that Apply is about to WRITE (new rows
 * only — pre-existing rows keep whatever state the project already had).
 * MRS2 checks existence when adding an include/lib path and asks whether to
 * continue; this mirrors that, aggregated into one prompt per Apply.
 */
export function checkPathEntries(
  values: Record<string, string>,
  initial: Map<string, string>,
  root: string
): PathIssues {
  const issues: PathIssues = { malformed: [], unknown: [], missing: [] };
  const pathModes = new Set(['dir', 'file', 'ldfile']);
  for (const f of FIELDS) {
    const mode = LIST_MODES[f.key];
    if (f.type !== 'list' || !mode || !pathModes.has(mode)) continue;
    const before = new Set(
      (initial.get(f.key) ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s)
    );
    const rows = (values[f.key] ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s);
    for (const entry of rows) {
      if (before.has(entry)) continue;
      const syntax = pathSyntaxProblem(entry);
      if (syntax.problem) {
        issues.malformed.push(`${f.label}: ${entry} — ${syntax.problem}`);
        continue;
      }
      for (const name of syntax.names) {
        if (!KNOWN_PATH_MACROS.has(name) && !PARENT_LOC_MACRO.test(name)) {
          issues.unknown.push(`${f.label}: ${entry} (${name})`);
        }
      }
      const resolved = resolvePathEntry(root, entry);
      if (!resolved.checkable) continue;
      let ok = false;
      try {
        const stat = fs.statSync(resolved.path);
        ok = mode === 'dir' ? stat.isDirectory() : stat.isFile();
      } catch {
        ok = false;
      }
      if (!ok) issues.missing.push(`${f.label}: ${entry}`);
    }
  }
  return issues;
}

/** Shared enum decode (properties page render AND the Sync page seeding):
 *  absent -> the field's model default (`f.def`), value ids strip the normal
 *  enumBase prefix AND the CDT/MRS base-infix form ("...option.base.<suffix>
 *  <choice>"), and a completely unknown id is returned verbatim (the caller
 *  renders a synthetic "(current)" entry). `verbatim` marks that third case:
 *  only a VERBATIM full foreign id must be written back raw — an unknown
 *  suffix under a KNOWN enumBase still needs the prefix on write (round-45
 *  P2). Exported so the Sync page can never drift from this logic again
 *  (round-43 P2-1: its old private copy missed the base form and seeded the
 *  dropdown's first entry, silently changing the toolchain choice on Apply). */
export function readEnumInfo(cp: Cproject, f: FieldDef): { value: string; verbatim: boolean } {
  if (!f.suffix) return { value: '', verbatim: false };
  const raw = cp.optionValue(f.suffix);
  // absent / value-less options fall back to the MRS model's constructor
  // default where it is not the generic unset marker (see FieldDef.def)
  if (raw === undefined || raw === '') return { value: f.def ?? 'default', verbatim: false };
  if (f.enumBase && raw.startsWith(f.enumBase)) {
    return { value: raw.slice(f.enumBase.length), verbatim: false };
  }
  // CDT/MRS store an enumerated CHOICE as the BASE option id —
  // "...option.base.<suffix><choice>" (one `base.` segment inserted).
  // Without this recognition the dropdown falls back to its first entry
  // ('default') and an innocent Apply DELETED the stored value attribute —
  // MRS's own reader does value.match() unguarded on rvGcc and refused to
  // open the project at all (TCP_SERVER/MACRAW/TCP_CLIENT, 2026-11-12).
  if (f.enumBase) {
    const baseForm = f.enumBase.replace(/\.option\./, '.option.base.');
    if (baseForm !== f.enumBase && raw.startsWith(baseForm)) {
      return { value: raw.slice(baseForm.length), verbatim: false };
    }
  }
  return { value: raw, verbatim: true };
}

export function readEnum(cp: Cproject, f: FieldDef): string {
  return readEnumInfo(cp, f).value;
}

/** list fields rendered as an MRS2-style Add/Edit/Delete table, keyed to the
 *  add/edit dialog mode: 'dir'/'file' browse the project tree or the OS
 *  picker, 'ldfile' is 'file' filtered to linker scripts, 'text' is a plain
 *  input box (library names / raw linker flags — MRS2 gives those an input
 *  dialog, not a file chooser). Keys not in the map stay plain textareas. */
const LIST_MODES: Record<string, 'dir' | 'file' | 'ldfile' | 'text'> = {
  // preprocessor symbol lists (C / C++ / assembler) — MRS gives these the
  // same Add/Edit/Delete table + plain input dialog as libraries/flags
  defs: 'text',
  undefs: 'text',
  cppdefs: 'text',
  cppundefs: 'text',
  asmdefs: 'text',
  asmundefs: 'text',
  // include search paths / include files (C / C++ / assembler)
  incs: 'dir',
  sysincs: 'dir',
  fileincs: 'file',
  cppincs: 'dir',
  cppsysincs: 'dir',
  cppfileincs: 'file',
  asmincs: 'dir',
  asmsysincs: 'dir',
  asmfileincs: 'file',
  // linker: script files, library lists, search paths, extra objects, flags
  script: 'ldfile',
  cppscript: 'ldfile',
  libs: 'text',
  cpplibs: 'text',
  libpaths: 'dir',
  cpplibpaths: 'dir',
  otherobjs: 'file',
  cppotherobjs: 'file',
  ldflags: 'text',
  cppldflags: 'text',
};

export class ConfigView {
  private panel: vscode.WebviewPanel | null = null;
  private project: MrsProject | null = null;
  /** the chip db of the project's install — the Download Settings page needs
   *  it to resolve SDK series ids (queryMcuId result) to display names */
  private dlChipDb: ChipDb | undefined;
  /** Apply's diff baseline: for every control, the value the page rendered.
   *  Apply posts ALL controls back; only fields whose posted value differs
   *  from this snapshot are written, so untouched options stay byte-identical
   *  (and a value our dropdown cannot represent is echoed back, not replaced
   *  by the browser's first-entry fallback). */
  private initial = new Map<string, string>();

  constructor(
    private store: ProjectStore,
    private context: vscode.ExtensionContext
  ) {}

  async show(proj?: MrsProject): Promise<void> {
    const project = proj ?? this.store.active;
    if (!project) {
      vscode.window.showErrorMessage(t('noActiveProject'));
      return;
    }
    this.project = project;
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel('mrvc.config', `Properties - ${project.projectName}`, vscode.ViewColumn.Active, {
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

  private async onMessage(m: {
    command: string;
    values?: Record<string, string>;
    mode?: 'dir' | 'file' | 'ldfile';
    path?: string;
    op?: string;
    chipId?: number;
    clkSpeed?: number;
    dbgMode?: number;
    eraseMode?: number;
    memVal?: number;
  }): Promise<void> {
    const project = this.project;
    if (!project || !this.panel) return;
    if (m.command === 'close') {
      this.panel.dispose();
      return;
    }
    if (m.command === 'saveDl' && m.values) {
      try {
        const tpl = readTemplate(project.root);
        const set = (k: string, v: string): void => {
          if (!(k in tpl.values)) tpl.order.push(k);
          tpl.values[k] = v;
        };
        const addr = (m.values['Address'] ?? '').trim();
        if (addr && !ADDRESS_RE.test(addr)) {
          throw new Error(`Invalid flash address "${addr}" (expected form 0x00000000)`);
        }
        set('Address', addr);
        set('Flash Type', m.values['Flash Type'] ?? 'Internal');
        // empty = the chip has no interface-mode selector — keep .template as-is
        const dbg = (m.values['DebugInterfaceMode'] ?? '').trim();
        if (dbg) set('DebugInterfaceMode', dbg);
        set('CLKSpeed', m.values['CLKSpeed'] ?? '1');
        set('Target Path', m.values['Target Path'] ?? '');
        for (const [key, name] of [
          ['eraseAll', 'Erase All'],
          ['program', 'Program'],
          ['verify', 'Verify'],
          ['reset', 'Reset'],
          ['sdiPrintf', 'SDIPrintf'],
          ['disableCodeProtect', 'Disable Code-Protect'],
          ['clearCodeFlash', 'Clear CodeFlash'],
          ['disablePower', 'Disable Power Output'],
        ] as const) {
          set(name, m.values[key] === 'true' ? 'true' : 'false');
        }
        writeTemplate(project.root, tpl);
        project.reload();
        this.panel.webview.postMessage({ command: 'saved' });
        vscode.window.showInformationMessage(t('downloadSettingsSaved', path.basename(project.root)));
      } catch (e) {
        vscode.window.showErrorMessage(t('downloadSettingsSaveFailed', e instanceof Error ? e.message : String(e)));
      }
      return;
    }
    if (m.command === 'dlOp' && m.op) {
      const install = getInstall();
      if (!install) {
        this.panel.webview.postMessage({ command: 'dlLog', text: t('installNotFound') });
        return;
      }
      const op = m.op as WlinkOp;
      const args: WlinkArgs = {
        chipId: m.chipId ?? 0,
        clkSpeed: m.clkSpeed ?? 1,
        dbgMode: m.dbgMode ?? 0,
        eraseMode: m.eraseMode,
        memVal: m.memVal,
      };
      if (op !== 'queryMcuId' && (!args.chipId || args.chipId <= 0)) {
        this.panel.webview.postMessage({ command: 'dlLog', text: 'Unknown chip series — pick the chip in the Chip / Target page first.' });
        return;
      }
      void runWlinkOp(install, op, args).then((r) => {
        let text = describeResult(op, r);
        let mcuType: string | undefined;
        // the queryMcuId result is an SDK SERIES id — resolve the MRS-parity
        // display name (flash.json type, e.g. 6 -> CH32V30x) from the chip db
        // (round: remote panel showed the raw id while MRS2 showed CH32V30x)
        if (op === 'queryMcuId' && r.result !== undefined) {
          mcuType = this.dlChipDb?.series.find((s2) => s2.id === r.result)?.mcuType;
          if (mcuType) text = `Linked MCU type: ${mcuType} (family id ${r.result})`;
        }
        this.panel?.webview.postMessage({ command: 'dlLog', text, op, result: r.result, mcuType });
      });
      return;
    }
    if (m.command === 'pickTarget') {
      void vscode.window
        .showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          filters: { Firmware: ['hex', 'bin'] },
          defaultUri: vscode.Uri.file(project.buildDir),
          title: 'Select firmware target file',
        })
        .then((pick) => {
          if (pick?.length && this.panel) this.panel.webview.postMessage({ command: 'pickedTarget', path: pick[0].fsPath });
        });
      return;
    }
    if (m.command === 'listDir') {
      const parent = typeof m.path === 'string' ? m.path : '';
      const buildDirName = path.basename(project.buildDir);
      this.panel.webview.postMessage({
        command: 'dirTree',
        path: parent,
        dirs: this.listImmediate(project.root, parent, 'dir', buildDirName),
        files: m.mode === 'file' ? this.listImmediate(project.root, parent, 'file', buildDirName) : [],
      });
      return;
    }
    if (m.command === 'pickFolder') {
      // dialog mode comes from the webview's per-key LIST_MODES entry:
      // 'dir' folders, 'ldfile' linker scripts, anything else plain files
      const mode = m.mode === 'dir' ? 'dir' : m.mode === 'ldfile' ? 'ldfile' : 'file';
      void vscode.window
        .showOpenDialog({
          canSelectFolders: mode === 'dir',
          canSelectFiles: mode !== 'dir',
          canSelectMany: false,
          defaultUri: vscode.Uri.file(project.root),
          filters: mode === 'ldfile' ? { 'Linker script': ['ld'] } : undefined,
          title: mode === 'ldfile' ? 'Select linker script file' : mode === 'file' ? 'Select file' : 'Select directory',
        })
        .then((pick) => {
          if (pick?.length && this.panel) this.panel.webview.postMessage({ command: 'pickedPath', path: pick[0].fsPath });
        });
      return;
    }
    if (m.command === 'save' && m.values) {
      // cross-page macro conflict check: the same -D macro defined with
      // DIFFERENT values in the C / C++ / Assembler preprocessor pages —
      // legal per-compiler but almost always a mistake. Second-confirm.
      const conflicts = macroConflicts(m.values);
      if (conflicts.length) {
        const apply = await vscode.window.showWarningMessage(
          t('macroConflictTitle', conflicts.length),
          { modal: true, detail: conflicts.join('\n') },
          t('macroConflictApply'),
          t('macroConflictBack')
        );
        if (apply !== t('macroConflictApply')) return;
      }
      // path-entry gate: new rows in include/linker path lists must at least
      // be well-formed (hard error), and unknown macros / missing targets get
      // an MRS2-style "continue anyway?" prompt BEFORE anything is written
      const pathIssues = checkPathEntries(m.values, this.initial, project.root);
      if (pathIssues.malformed.length) {
        vscode.window.showErrorMessage(t('propertiesPathMalformed', '\n' + pathIssues.malformed.join('\n')));
        return;
      }
      for (const [list, titleKey] of [
        [pathIssues.unknown, 'propertiesPathUnknown'],
        [pathIssues.missing, 'propertiesPathMissing'],
      ] as const) {
        if (!list.length) continue;
        const go = await vscode.window.showWarningMessage(
          t(titleKey, list.length),
          { modal: true, detail: list.join('\n') },
          t('propertiesPathContinue'),
          t('propertiesPathBack')
        );
        if (go !== t('propertiesPathContinue')) return;
      }
      try {
        // PRE-WRITE gate: Apply only ever rewrites a .cproject whose RAW
        // structure a strict parser accepts (MRS/Eclipse would refuse a file
        // our lenient parser merely tolerates — and rewriting it would
        // cement the damage). Audit owns the repair; Apply refuses.
        const cprojectFile = path.join(project.root, '.cproject');
        const structureError = strictXmlFileError(cprojectFile, 'cproject');
        if (structureError) throw new Error(t('propertiesXmlInvalid', structureError));
        // .template fields first (chip identity / download address), batched
        // into one read-modify-write; the address is validated like the flash
        // code does, so a bad value aborts the whole save before any write
        const tplData = readTemplate(project.root);
        let tplDirty = false;
        for (const f of FIELDS) {
          if (!f.tplKey || f.tplReadonly) continue;
          const v = (m.values[f.key] ?? '').trim();
          // untouched = still shows what the page rendered: skip (an external
          // edit made meanwhile stays in place)
          const initialTpl = this.initial.get(f.key);
          if (initialTpl !== undefined && v === initialTpl.trim()) continue;
          if (v === (tplData.values[f.tplKey] ?? '')) continue;
          if (f.tplKey === 'Address' && v && !ADDRESS_RE.test(v)) {
            throw new Error(`Invalid flash address "${v}" (expected form 0x00000000)`);
          }
          if (!(f.tplKey in tplData.values)) tplData.order.push(f.tplKey);
          tplData.values[f.tplKey] = v;
          tplDirty = true;
        }
        if (tplDirty) writeTemplate(project.root, tplData);
        const cp = Cproject.load(project.root);
        for (const f of FIELDS) {
          if (f.tplKey) continue;
          const v = m.values[f.key];
          if (v === undefined) continue;
          // Apply posts EVERY control's displayed value; only a field whose
          // posted value differs from the render-time snapshot was actually
          // edited. Untouched options therefore stay byte-identical — the "I
          // changed one setting, did everything else survive?" guarantee. A
          // stored enum choice our list does not know is echoed back by the
          // synthetic "(current)" option, so it lands here as unchanged too.
          const initial = this.initial.get(f.key);
          if (initial !== undefined && v === initial) continue;
          if (f.type === 'bool') {
            if (f.set) {
              // non-boolean storage rendered as a checkbox (RVV is an
              // enumerated option: `...isa.rvv.<set>` / `...isa.rvv.`)
              f.set(cp, v);
            } else if (f.suffix) {
              // create=true: options absent from .cproject must be created on check
              cp.setOptionBool(f.suffix, v === '1', true);
            }
          } else if (f.type === 'enum') {
            if (f.set) {
              f.set(cp, v);
            } else if (f.suffix) {
              if (f.enumBase) {
                // an ABSENT option renders as 'default', while the <select>
                // can only display its first entry — posting that entry back
                // is the browser fallback, not a user decision: leave the
                // option absent instead of materialising it
                const first = (f.options ?? [])[0]?.[0];
                if (initial === 'default' && !cp.option(f.suffix) && v === first) continue;
                // 'default' is a REAL CDT enumerated choice for align /
                // debugging.level / debugging.format — it must be WRITTEN
                // explicitly: setOptionValue(undefined) never removes an
                // enumerated value attribute (P1 guard), so mapping it to
                // "clear" left a stored non-default choice in place (silent
                // no-op, round-11 P3-2). Fields without a 'default' choice
                // never post it (the select falls back to its first entry).
                const defaultChoice = (f.options ?? []).some(([k]) => k === 'default');
                cp.setOptionValue(f.suffix, v === 'default' && !defaultChoice ? undefined : f.enumBase + v);
              } else {
                cp.setOptionValue(f.suffix, v === 'default' ? undefined : v);
              }
            }
          } else if (f.type === 'list' || f.type === 'string') {
            f.set?.(cp, v);
          }
        }
        cp.save();
        // the page and the disk agree now — re-baseline so a second Apply
        // with no further edits writes nothing
        for (const f of FIELDS) {
          const v = m.values[f.key];
          if (v === undefined) continue;
          this.initial.set(f.key, f.tplKey ? v.trim() : v);
        }
        project.reload();
        this.panel.webview.postMessage({ command: 'saved' });
        vscode.window.showInformationMessage(t('propertiesSaved', path.basename(project.root)));
      } catch (e) {
        vscode.window.showErrorMessage(t('propertiesSaveFailed', e instanceof Error ? e.message : String(e)));
      }
    }
  }

  /** immediate children of one project folder for the lazy "Folder
   * selection" tree — linked folders are real directories on disk and come
   * for free; the build output directory (obj/) is excluded at the root;
   * `rel` must stay inside the project root (defence in depth) */
  private listImmediate(root: string, rel: string, kind: 'dir' | 'file', buildDirName: string): Array<{ name: string; rel: string }> {
    const SKIP = new Set(['.settings', '.vscode', '.mrs', 'CMakeFiles']);
    // normalise and contain: no ../ escapes out of the project root
    const safeRel = path.normalize(rel || '').replace(/^([/\\])+/, '');
    if (safeRel === '..' || safeRel.startsWith(`..${path.sep}`)) return [];
    const abs = path.resolve(root, safeRel);
    if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => {
        if (kind === 'dir' ? !e.isDirectory() : !e.isFile()) return false;
        if (e.name.startsWith('.') || SKIP.has(e.name)) return false;
        // the build output dir is never a selectable resource
        if (!safeRel && e.isDirectory() && e.name === buildDirName) return false;
        return true;
      })
      .map((e) => ({ name: e.name, rel: safeRel ? `${safeRel}/${e.name}` : e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Download Settings page (MRS2 mirror): Operations (WCH-Link hardware
   * actions through the 32-bit PowerShell bridge) + Download Parameters
   * (persisted to .template, MRS2-compatible keys) */
  private dlSettingsHtml(project: MrsProject, chipDb: ChipDb, nonce: string): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tpl = project.template.values;
    // the Target File field shows the RESOLVED download target (what a
    // download will actually flash) — EVT packages ship cross-project Target
    // Paths (MACRAW's template pointing at TCP_SERVER's hex), and displaying
    // the stale raw value would contradict the real download. An UNRESOLVED
    // raw value (project not built) is shown verbatim — path.relative() on
    // it would fold in the process cwd (review round2 §2).
    const displayTarget = (resolved: string): string => displayTargetPath(project.root, resolved) || (tpl['Target Path'] ?? '');
    // MRS2's own fallback chain (Series -> Mcu Type -> MCU) plus the
    // flash.json per-model "special" override — shared with the download
    // target-chip guard in src/vscode/flash.ts. The hard-ware controls use the
    // EFFECTIVE flash control (id/type/support), exactly what MRS2 passes to
    // MRSFunc_* for this project (CH32V203CCT runs on CH32V205's control).
    const chip = chipForTemplate(chipDb, tpl) ?? null;
    const series = chip?.series ?? null;
    const sup = chip?.support;
    const has = (k?: boolean) => (k === true ? '' : ' disabled');
    const chk = (v: string | undefined) => (v === 'true' ? ' checked' : '');
    const rptOn = sup?.readProtectOpts === true;
    const ctx = {
      chipId: chip?.id ?? 0,
      series: series?.name ?? '',
      sdkOk: chipDb.available,
    };
    return `
<div class="dlwrap">
  <fieldset class="dlops"><legend>Operations</legend>
    <div class="dlbtns">
      <button type="button" data-dlop="queryRpt"${has(rptOn)} title="Query read protection status">🛡 Query</button>
      <button type="button" data-dlop="enableRpt"${has(rptOn)} title="Enable read protection">🔒 Enable</button>
      <button type="button" data-dlop="disableRpt"${has(rptOn)} title="Disable read protection">🔓 Disable</button>
      <button type="button" data-dlop="disableDbg"${has(rptOn ? false : true)} title="Disable debug interface (unsupported on chips with read protection)">🐛 Disable Debug</button>
    </div>
    <div class="dlrow"><label>Linked MCU Type:</label><input type="text" id="dl-mcuid" readonly><button type="button" data-dlop="queryMcuId">Query</button></div>
    <div class="dlrow"><label>Debugger Target Mode:</label><select id="dl-tgtmode"><option value="0">RISC-V</option><option value="1">ARM</option></select><button type="button" data-dlquery="linktype">Query</button><button type="button" data-dlop="applyLinkType">Apply</button></div>
    <div class="dlrow"><label>MCU Memory Assign:</label><select id="dl-mem"></select><button type="button" data-dlop="getMemType"${has(sup?.memoryAssign)}>Query</button><button type="button" data-dlop="setMemType"${has(sup?.memoryAssign)}>Apply</button></div>
    <div class="dlrow"><label>Erase Code Flash:</label><select id="dl-erase"><option value="0">By Pin NRST</option><option value="1">By Power off</option></select><button type="button" data-dlop="clearCodeFlash"${has(sup?.eraseCodeFlash)}>Apply</button></div>
    <div class="dlrow"><label>Operation Record:</label></div>
    <textarea id="dl-log" readonly rows="7"></textarea>
  </fieldset>
  <fieldset class="dlparams"><legend>Download Parameters</legend>
    <div class="dlrow"><label>MCU Type:</label><input type="text" id="dl-mcutype" value="${esc(tpl['Mcu Type'] ?? '')}" readonly></div>
    <div class="dlrow"><label>Memory Type:</label><select id="dl-memtype" data-dlkey="Flash Type"><option value="Internal"${tpl['Flash Type'] === 'External' ? '' : ' selected'}>Internal</option><option value="External"${tpl['Flash Type'] === 'External' ? ' selected' : ''}>External</option></select></div>
    <div class="dlrow"><label>Program Address:</label><input type="text" id="dl-address" data-dlkey="Address" value="${esc(tpl['Address'] ?? '')}" spellcheck="false"></div>
    <div class="dlrow"><label>Debug Interface Mode:</label><select id="dl-dbgif" data-dlkey="DebugInterfaceMode"><option value="0"${tpl['DebugInterfaceMode'] !== '1' ? ' selected' : ''}>1-wire serial</option><option value="1"${tpl['DebugInterfaceMode'] === '1' ? ' selected' : ''}>2-wires serial</option></select></div>
    <div class="dlrow"><label>CLK Speed:</label><select id="dl-clk" data-dlkey="CLKSpeed"><option value="1"${tpl['CLKSpeed'] === '1' ? ' selected' : ''}>High</option><option value="2"${tpl['CLKSpeed'] === '2' ? ' selected' : ''}>Middle</option><option value="3"${tpl['CLKSpeed'] === '3' ? ' selected' : ''}>Low</option></select></div>
    <div class="dlrow"><label>Target File:</label><input type="text" id="dl-target" data-dlkey="Target Path" value="${esc(displayTarget(resolveDownloadTarget(project)))}" spellcheck="false"><button type="button" id="dl-targetbtn">…</button></div>
    <div class="dlchk"><span>Main Operations:</span>
      <label><input type="checkbox" data-dlkey="eraseAll"${chk(tpl['Erase All'])}> Erase All</label>
      <label><input type="checkbox" data-dlkey="program"${chk(tpl['Program'])}> Program</label>
      <label><input type="checkbox" data-dlkey="verify"${chk(tpl['Verify'])}> Verify</label>
      <label><input type="checkbox" data-dlkey="reset"${chk(tpl['Reset'])}> Reset and Run</label>
      <label><input type="checkbox" data-dlkey="sdiPrintf"${has(sup?.spiPrintf)}${chk(tpl['SDIPrintf'])}> Enable SDI Printf</label>
      <label><input type="checkbox" data-dlkey="disableCodeProtect"${has(rptOn)}${chk(tpl['Disable Code-Protect'])}> Disable Code-Protect</label>
      <label><input type="checkbox" data-dlkey="clearCodeFlash"${has(sup?.eraseCodeFlash)}${chk(tpl['Clear CodeFlash'])}> Clear CodeFlash</label>
      <label><input type="checkbox" data-dlkey="disablePower"${has(sup?.eraseCodeFlash)}${chk(tpl['Disable Power Output'])}> Disable Power Output</label>
    </div>
  </fieldset>
</div>
<script nonce="${nonce}">const DL_CTX = ${jsonForScript(ctx)};</script>`;
  }

  private fieldHtml(cp: Cproject, f: FieldDef, tplData?: TemplateData): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    if (f.tplKey) {
      const value = tplData?.values[f.tplKey] ?? '';
      this.initial.set(f.key, value);
      const ro = f.tplReadonly ? ' readonly style="opacity:.75"' : ' spellcheck="false"';
      return `<div class="fld"><label>${esc(f.label)}</label><input type="text" data-key="${f.key}" value="${esc(value)}"${ro}></div>`;
    }
    let value: string;
    if (f.get) {
      value = f.get(cp);
    } else {
      value = f.type === 'bool' || f.type === 'enum' ? readEnum(cp, f) : '';
    }
    // diff baseline for Apply (bool normalized to the checkbox's 1/0)
    this.initial.set(f.key, f.type === 'bool' ? (value === 'true' ? '1' : '0') : value);
    if (f.type === 'bool') {
      return `<label class="check"><input type="checkbox" data-key="${f.key}" ${value === 'true' ? 'checked' : ''}><span>${esc(f.label)}</span></label>`;
    }
    if (f.type === 'enum') {
      // an EXISTING option storing a choice our list does not know (newer MRS
      // spelling / hand edit) must stay selected and echo its own value back:
      // without the synthetic entry the <select> falls back to its first
      // choice and Apply would overwrite the stored value
      const known = (f.options ?? []).some(([v]) => v === value);
      const extra =
        !known && value !== '' && value !== 'default' && f.suffix && cp.option(f.suffix)
          ? `<option value="${esc(value)}" selected>(current) ${esc(value.slice(0, 60))}</option>`
          : '';
      const opts = extra + (f.options ?? [])
        .map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`)
        .join('');
      return `<div class="fld"><label>${esc(f.label)}</label><select data-key="${f.key}">${opts}</select></div>`;
    }
    if (f.type === 'list') {
      if (LIST_MODES[f.key]) {
        const rows = value
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s)
          .map((s) => `<div class="listrow">${esc(s)}</div>`)
          .join('');
        return `<div class="listblk"><div class="listhead"><span>${esc(f.label)}</span><span class="lbtns"><button type="button" class="lb-add" data-lkey="${f.key}">＋ Add</button><button type="button" class="lb-edit" data-lkey="${f.key}" disabled>Edit</button><button type="button" class="lb-del" data-lkey="${f.key}" disabled>Delete</button></span></div><div class="listrows" data-key="${f.key}" tabindex="0">${rows || '<div class="lsempty">No Data</div>'}</div></div>`;
      }
      return `<div class="fld"><label>${esc(f.label)}</label><textarea data-key="${f.key}" rows="4" spellcheck="false">${esc(value)}</textarea></div>`;
    }
    // string options: MRS's el-input is a ONE-LINE box for Small data limit /
    // Generate map, while the "Other ... flags" fields get a tall textarea
    // (Shift+Enter wraps). Same split here.
    if (f.multiline === false) {
      return `<div class="fld"><label>${esc(f.label)}</label><input type="text" data-key="${f.key}" data-stype="string" spellcheck="false" value="${esc(value)}"></div>`;
    }
    return `<div class="fld"><label>${esc(f.label)}</label><textarea data-key="${f.key}" data-stype="string" rows="4" spellcheck="false" style="resize:vertical">${esc(value)}</textarea></div>`;
  }

  private render(project: MrsProject): string {
    const cp = project.cproject;
    this.initial.clear();
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // fresh nonce per render: only <script nonce="..."> blocks may run, so a
    // future escaping slip cannot hand crafted script full acquireVsCodeApi
    // powers (CSP as a second line of defense, per VSCode webview guidance)
    const nonce = crypto.randomBytes(16).toString('hex');

    // C++ pages exist only for C++ projects (CDT cxx nature) — like MRS2
    const pageDefs = project.cproject.isCpp ? PAGES : PAGES.filter((p) => !p.key.startsWith('cpp'));

    // group pages by their MRVC group
    const groups: Array<{ group: string; pages: PageDef[] }> = [];
    for (const p of pageDefs) {
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

    const chipDb: ChipDb = (() => {
      const install = getInstall();
      if (!install) return { available: false, series: [] };
      return scanChipDb(chipDbRoot(install.resourcesDir));
    })();

    const pages = pageDefs.map((p, i) => {
      const fields = FIELDS.filter((f) => f.page === p.key)
        .map((f) => this.fieldHtml(cp, f, project.template))
        .join('\n');
      let body = fields;
      if (p.key === 'chip' && chipDb.available) body = this.chipPickerHtml() + body;
      if (p.key === 'dlset') {
        this.dlChipDb = chipDb;
        body = this.dlSettingsHtml(project, chipDb, nonce);
      }
      return `<div class="page" data-page="${p.key}" data-title="${esc(p.title)}" data-desc="${esc(p.description)}" style="display:${i === 0 ? 'block' : 'none'}">${body}</div>`;
    }).join('\n');

    const descDefault = PAGES[0];

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
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
.listblk { margin-bottom: 12px; border: 1px solid var(--vscode-editorWidget-border); }
.listhead { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; font-weight: 600; background: var(--vscode-sideBar-background); }
.lbtns button { padding: 2px 10px; font-size: 12px; margin-left: 6px; }
.lbtns button:disabled { opacity: .45; cursor: default; }
.listrows { max-height: 170px; overflow: auto; }
.listrow { padding: 4px 10px; cursor: pointer; }
.listrow:hover { background: var(--vscode-list-hoverBackground); }
.listrow.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.lsempty { color: var(--vscode-descriptionForeground); text-align: center; padding: 18px 0; }
#modal { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 10; }
#modal[hidden] { display: none; }
.mbox { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); width: 500px; padding: 14px 16px; }
.mhead { font-weight: 600; margin-bottom: 8px; }
.mrow { margin: 10px 0; display: flex; gap: 10px; align-items: center; }
.mrow input[type=text] { flex: 1; }
#mtree { max-height: 260px; min-height: 200px; overflow: auto; border: 1px solid var(--vscode-input-border); margin-top: 8px; }
.mtrow { display: flex; align-items: center; gap: 4px; padding-top: 3px; padding-bottom: 3px; cursor: default; white-space: nowrap; }
.mtrow:hover { background: var(--vscode-list-hoverBackground); }
.tarrow { width: 12px; flex: none; cursor: pointer; font-size: 10px; text-align: center; }
.tarrow.tleaf { visibility: hidden; }
.tcb { flex: none; margin: 0; }
.ticon { flex: none; font-size: 12px; }
.tlabel { overflow: hidden; text-overflow: ellipsis; }
.mbtns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.dlwrap { display: flex; gap: 14px; align-items: flex-start; }
.dlops, .dlparams { flex: 1; border: 1px solid var(--vscode-editorWidget-border); padding: 10px 12px; margin: 0; min-width: 0; }
.dlops legend, .dlparams legend { font-weight: 600; padding: 0 6px; }
.dlbtns { display: flex; gap: 8px; margin-bottom: 12px; }
.dlbtns button { flex: 1; }
.dlrow { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.dlrow > label:first-child { width: 150px; flex: none; }
.dlrow select, .dlrow input[type=text] { flex: 1; min-width: 0; }
.dlrow button { flex: none; }
#dl-log { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); font-size: 12px; }
.dlchk { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.dlchk > span { width: 100%; font-weight: 600; }
.dlchk label { display: flex; align-items: center; gap: 5px; }
.dlchk label:has(input:disabled) { opacity: .45; }
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
<div id="modal" hidden>
  <div class="mbox">
    <div class="mhead" id="mtitle">Add directory path</div>
    <div class="mrow" id="msrcrow">Open the <span id="mkind">directory</span> from: <label><input type="radio" name="msrc" value="project" checked> Project</label><label><input type="radio" name="msrc" value="local"> Local Folder</label></div>
    <div class="mrow"><input type="text" id="mpath" spellcheck="false"><button type="button" id="mbrowse">Browse</button></div>
    <div id="mtree" hidden></div>
    <div class="mbtns"><button type="button" id="mok">Confirm</button><button type="button" id="mcancel">Cancel</button></div>
  </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const PROJ_ROOT = ${jsonForScript(project.root)};
const PROJ_NAME = ${jsonForScript(project.projectName)};
const LIST_MODES = ${jsonForScript(LIST_MODES)};
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
// The Chip page address field and the Download Settings "Program Address"
// field both write the SAME .template "Address" key, and Apply posts both
// messages (saveDl first, then save). Without this lockstep the twin input
// still holds the value from render time — the second write rolls the
// first one back while the page reports "Saved".
(function () {
  const chipAddr = document.querySelector('[data-key="address"]');
  const dlAddr = document.getElementById('dl-address');
  if (!chipAddr || !dlAddr) return;
  const mirror = (from, to) => from.addEventListener('input', () => { to.value = from.value; });
  mirror(chipAddr, dlAddr);
  mirror(dlAddr, chipAddr);
})();
document.getElementById('apply').addEventListener('click', () => {
  const values = {};
  document.querySelectorAll('[data-key]').forEach((el) => {
    if (el.classList.contains('listrows')) {
      values[el.dataset.key] = [...el.querySelectorAll('.listrow')].map((r) => r.textContent).join('\\n');
    } else {
      values[el.dataset.key] =
        el.type === 'checkbox'
          ? el.checked
            ? '1'
            : '0'
          : el.dataset.stype === 'string'
          ? el.value.replace(/\\s*\\r?\\n\\s*/g, ' ').trim() // single-line option values
          : el.value;
    }
  });
  // the Download Settings page uses data-dlkey controls, collected separately
  const dl = collectDl();
  if (dl) vscode.postMessage({ command: 'saveDl', values: dl });
  vscode.postMessage({ command: 'save', values });
});
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ command: 'close' }));
window.addEventListener('message', (e) => {
  if (e.data.command === 'saved') {
    const s = document.getElementById('status');
    s.style.opacity = '1';
    setTimeout(() => (s.style.opacity = '0'), 1600);
  }
  if (e.data.command === 'dirTree') fillTreeLevel(e.data.path ?? '', e.data.dirs ?? [], e.data.files ?? []);
  if (e.data.command === 'pickedPath') document.getElementById('mpath').value = e.data.path;
  if (e.data.command === 'dlLog') {
    dlLog(e.data.text);
    // Memory Assign: the DLL encodes group (tens, 1-6 -> A-F) and option
    // (units) in one value — fill the dropdown from the embedded tables
    if (e.data.op === 'getMemType' && e.data.result >= 10 && e.data.result < 100) {
      const group = Math.floor(e.data.result / 10);
      const idx = e.data.result % 10;
      const opts = MEM_GROUPS[group] ?? [];
      const sel = dlEl('dl-mem');
      if (sel) {
        sel.innerHTML = opts.map((o) => '<option>' + o + '</option>').join('');
        sel.selectedIndex = idx < opts.length ? idx : 0;
      }
    }
    // Linked MCU Type: the query result is an SDK series id — the extension
    // resolves the flash.json type name (CH32V30x) and fills the field
    // (MRS2 parity: the field shows the type, not the raw family id)
    if (e.data.op === 'queryMcuId') {
      const f = document.getElementById('dl-mcuid');
      if (f) f.value = e.data.mcuType ?? '';
    }
  }
  if (e.data.command === 'pickedTarget') {
    const t = document.getElementById('dl-target');
    if (t) t.value = e.data.path;
  }
});

// ---- Download Settings page ----
const MEM_GROUPS = {
  1: ['192K ROM + 128K RAM', '224K ROM + 96K RAM', '256K ROM + 64K RAM', '288K ROM + 32K RAM'],
  2: ['128K ROM + 64K RAM', '144K ROM + 48K RAM', '160K ROM + 32K RAM'],
  3: ['192K ROM + 128K RAM', '224K ROM + 96K RAM'],
  4: ['192K ROM + 128K RAM', '224K ROM + 96K RAM', '256K ROM + 64K RAM', '288K ROM + 32K RAM', '128K ROM + 192K RAM'],
  5: ['192K ROM + 128K RAM', '224K ROM + 96K RAM', '128K ROM + 192K RAM'],
  6: ['512 ROM + 200K RAM', '576 ROM + 136K RAM'],
};
function dlEl(id) { return document.getElementById(id); }
function dlLog(text) {
  const box = dlEl('dl-log');
  if (!box) return;
  box.value += (box.value ? '\\n' : '') + new Date().toLocaleTimeString() + '  ' + text + '\\n';
  box.scrollTop = box.scrollHeight;
}
document.querySelectorAll('[data-dlop]').forEach((b) => b.addEventListener('click', () => {
  if (typeof DL_CTX === 'undefined' || !DL_CTX.sdkOk) { dlLog('MRS2 SDK component not found — WCH-Link operations unavailable.'); return; }
  if (!DL_CTX.chipId) { dlLog('Unknown chip series — pick the chip in the Chip / Target page first.'); return; }
  const op = b.dataset.dlop;
  if (op === 'applyLinkType') { dlLog('Debugger target mode switching is handled by WCH-LinkUtility (it flashes a different link firmware).'); return; }
  vscode.postMessage({
    command: 'dlOp', op,
    chipId: DL_CTX.chipId,
    clkSpeed: Number(dlEl('dl-clk')?.value ?? '1'),
    dbgMode: Number(dlEl('dl-dbgif')?.value ?? '0'),
    eraseMode: Number(dlEl('dl-erase')?.value ?? '0'),
    memVal: (dlEl('dl-mem')?.selectedIndex ?? -1) >= 0 ? dlEl('dl-mem').selectedIndex : undefined,
  });
}));
document.querySelectorAll('[data-dlquery]').forEach((b) => b.addEventListener('click', () => dlLog('Debugger target mode query is handled by WCH-LinkUtility.')));
const tgtBtn = dlEl('dl-targetbtn');
if (tgtBtn) tgtBtn.addEventListener('click', () => vscode.postMessage({ command: 'pickTarget' }));
function collectDl() {
  // '.page'-qualified on purpose: the nav items ALSO carry data-page and the
  // nav comes first in the document — the bare selector used to resolve to
  // the nav item, every lookup missed and Apply saved all checkboxes as
  // false while reporting "Saved" (user report 2026-11-12)
  const wrap = document.querySelector('.page[data-page="dlset"]');
  if (!wrap) return null;
  const v = (id) => dlEl(id)?.value ?? '';
  const c = (k) => (wrap.querySelector('[data-dlkey="' + k + '"]')?.checked ? 'true' : 'false');
  return {
    'Flash Type': v('dl-memtype'),
    Address: v('dl-address'),
    DebugInterfaceMode: v('dl-dbgif'),
    CLKSpeed: v('dl-clk'),
    'Target Path': v('dl-target'),
    eraseAll: c('eraseAll'),
    program: c('program'),
    verify: c('verify'),
    reset: c('reset'),
    sdiPrintf: c('sdiPrintf'),
    disableCodeProtect: c('disableCodeProtect'),
    clearCodeFlash: c('clearCodeFlash'),
    disablePower: c('disablePower'),
  };
}

// ---- "Folder selection" tree (MRS2-style): project-name root, lazy
// expansion to any depth, checkbox pick — linked folders and obj included
const listMode = (k) => LIST_MODES[k] || 'dir';
// dialog noun per key ('directory path' / 'include file' as mode defaults)
const MODAL_NOUNS = {
  // symbol lists (plain input dialogs) — without these the title fell back
  // to "include file" for -D / -U entries
  defs: 'defined symbol',
  undefs: 'undefined symbol',
  cppdefs: 'defined symbol',
  cppundefs: 'undefined symbol',
  asmdefs: 'defined symbol',
  asmundefs: 'undefined symbol',
  // include search paths / include files
  incs: 'include path',
  sysincs: 'system include path',
  cppincs: 'include path',
  cppsysincs: 'system include path',
  asmincs: 'include path',
  asmsysincs: 'system include path',
  // linker entries
  script: 'linker script file',
  cppscript: 'linker script file',
  libs: 'library name',
  cpplibs: 'library name',
  libpaths: 'library path',
  cpplibpaths: 'library path',
  ldflags: 'linker flag',
  cppldflags: 'linker flag',
  otherobjs: 'other object',
  cppotherobjs: 'other object',
};
const rowsOf = (key) => document.querySelector('.listrows[data-key="' + key + '"]');
function refreshBtns(key) {
  const has = !!rowsOf(key).querySelector('.listrow.sel');
  const eb = document.querySelector('.lb-edit[data-lkey="' + key + '"]');
  const db = document.querySelector('.lb-del[data-lkey="' + key + '"]');
  if (eb) eb.disabled = !has;
  if (db) db.disabled = !has;
}
document.querySelectorAll('.listrows').forEach((box) => {
  box.addEventListener('click', (e) => {
    const row = e.target.closest('.listrow');
    if (!row) return;
    box.querySelectorAll('.listrow.sel').forEach((r) => r.classList.remove('sel'));
    row.classList.add('sel');
    refreshBtns(box.dataset.key);
  });
  box.addEventListener('dblclick', (e) => {
    if (e.target.closest('.listrow')) openModal(box.dataset.key, 'edit');
  });
});
document.querySelectorAll('.lb-add').forEach((b) => b.addEventListener('click', () => openModal(b.dataset.lkey, 'add')));
document.querySelectorAll('.lb-edit').forEach((b) => b.addEventListener('click', () => openModal(b.dataset.lkey, 'edit')));
document.querySelectorAll('.lb-del').forEach((b) => b.addEventListener('click', () => {
  const box = rowsOf(b.dataset.lkey);
  const sel = box.querySelector('.listrow.sel');
  if (sel) {
    sel.remove();
    if (!box.querySelector('.listrow')) box.innerHTML = '<div class="lsempty">No Data</div>';
  }
  refreshBtns(b.dataset.lkey);
}));

let mctx = null;
const modal = document.getElementById('modal');
const mpath = document.getElementById('mpath');
const mtree = document.getElementById('mtree');
let treeSel = null;
let treeMode = 'dir';
const treeLoaded = new Set();
const treeOpen = new Set();
function nodeHtml(name, rel, isDir, depth) {
  const escA = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const escT = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const arrow = isDir
    ? '<span class="tarrow" data-rel="' + escA(rel) + '">' + (treeOpen.has(rel) ? '▼' : '▶') + '</span>'
    : '<span class="tarrow tleaf"></span>';
  return '<div class="mtrow" style="padding-left:' + (4 + depth * 16) + 'px">' + arrow
    + '<input type="checkbox" class="tcb" data-rel="' + escA(rel) + '"' + (treeSel === rel ? ' checked' : '') + '>'
    + '<span class="ticon">' + (isDir ? '📁' : '📄') + '</span><span class="tlabel">' + escT(name) + '</span></div>'
    + (isDir ? '<div class="mtkids" data-parent="' + escA(rel) + '"' + (treeOpen.has(rel) ? '' : ' hidden') + '></div>' : '');
}
function resetTree() {
  treeSel = null;
  treeMode = listMode(mctx.key) === 'dir' ? 'dir' : 'file';
  treeLoaded.clear();
  treeLoaded.add('');
  treeOpen.clear();
  treeOpen.add('');
  mtree.innerHTML = nodeHtml(PROJ_NAME, '', true, 0);
  vscode.postMessage({ command: 'listDir', path: '', mode: treeMode });
}
function fillTreeLevel(parent, dirs, files) {
  const kids = mtree.querySelector('.mtkids[data-parent="' + parent + '"]');
  if (!kids) return;
  const depth = parent ? parent.split('/').length : 0;
  kids.innerHTML = dirs.map((d) => nodeHtml(d.name, d.rel, true, depth)).join('')
    + files.map((f) => nodeHtml(f.name, f.rel, false, depth)).join('');
}
mtree.addEventListener('click', (e) => {
  const ar = e.target.closest('.tarrow');
  if (ar && !ar.classList.contains('tleaf')) {
    const rel = ar.dataset.rel;
    const kids = mtree.querySelector('.mtkids[data-parent="' + rel + '"]');
    if (!kids) return;
    if (kids.hidden) {
      kids.hidden = false;
      treeOpen.add(rel);
      ar.textContent = '▼';
      if (!treeLoaded.has(rel)) {
        treeLoaded.add(rel);
        vscode.postMessage({ command: 'listDir', path: rel, mode: treeMode });
      }
    } else {
      kids.hidden = true;
      treeOpen.delete(rel);
      ar.textContent = '▶';
    }
  }
});
mtree.addEventListener('change', (e) => {
  const cb = e.target.closest('.tcb');
  if (!cb) return;
  mtree.querySelectorAll('.tcb').forEach((c) => { if (c !== cb) c.checked = false; });
  treeSel = cb.dataset.rel;
  mpath.value = treeSel;
});
function addRow(box, v) {
  const r = document.createElement('div');
  r.className = 'listrow';
  r.textContent = v;
  box.appendChild(r);
  refreshBtns(box.dataset.key);
}
function openModal(key, op) {
  mctx = { key, op };
  const mode = listMode(key);
  const noun = MODAL_NOUNS[key] || (mode === 'dir' ? 'directory path' : 'include file');
  document.getElementById('mtitle').textContent = (op === 'add' ? 'Add ' : 'Edit ') + noun;
  document.getElementById('mkind').textContent = mode === 'dir' ? 'directory' : 'file';
  // text mode (library names / raw linker flags) is a plain input dialog —
  // no project tree, no OS picker, MRS2-style
  document.getElementById('msrcrow').style.display = mode === 'text' ? 'none' : '';
  document.getElementById('mbrowse').style.display = mode === 'text' ? 'none' : '';
  mpath.value = op === 'edit' ? rowsOf(key).querySelector('.listrow.sel')?.textContent ?? '' : '';
  if (mode === 'text') mtree.hidden = true;
  else resetTree();
  modal.hidden = false;
  mpath.focus();
}
function closeModal() {
  modal.hidden = true;
  mctx = null;
}
document.getElementById('mcancel').addEventListener('click', closeModal);
document.getElementById('mbrowse').addEventListener('click', () => {
  const mode = listMode(mctx.key);
  if (mode === 'text') return;
  const src = document.querySelector('input[name=msrc]:checked').value;
  if (src === 'project') {
    mtree.hidden = false;
    if (!treeLoaded.has('')) resetTree();
  } else {
    mtree.hidden = true;
    vscode.postMessage({ command: 'pickFolder', mode });
  }
});
document.getElementById('mok').addEventListener('click', () => {
  if (!mctx) return;
  let v = mpath.value.trim();
  if (v) {
    // text mode keeps the raw value; path modes convert a project-source pick
    // to MRS2's stored workspace_loc spelling (escaped so the render template
    // does not interpolate it)
    if (listMode(mctx.key) !== 'text') {
      const src = document.querySelector('input[name=msrc]:checked').value;
      if (src === 'project') {
        if (/^[a-zA-Z]:[\\\\/]/.test(v)) {
          // absolute path inside the project root -> MRS2 workspace_loc form
          const norm = v.replace(/\\\\/g, '/');
          const rootN = PROJ_ROOT.replace(/\\\\/g, '/').replace(/\\/$/, '');
          if (norm.toLowerCase().startsWith(rootN.toLowerCase() + '/')) {
            v = '\${workspace_loc:/\${ProjName}/' + norm.slice(rootN.length + 1) + '}';
          }
        } else if (!v.startsWith('$')) {
          v = '\${workspace_loc:/\${ProjName}/' + v.replace(/^[\\/]+/, '') + '}';
        }
      }
    }
    const box = rowsOf(mctx.key);
    const empty = box.querySelector('.lsempty');
    if (empty) empty.remove();
    if (mctx.op === 'edit') {
      const sel = box.querySelector('.listrow.sel');
      if (sel) sel.textContent = v;
      else addRow(box, v);
    } else addRow(box, v);
  }
  closeModal();
});
</script>
${chipDb.available ? this.chipPickerScript(chipDb, nonce) : ''}
</body></html>`;
  }

  /** MRS2-style "Target MCU Type" picker: series tree + model list + info,
   * fed by a live scan of the MRS2 SDK component. Picking a model fills the
   * .template fields below; Apply persists them as before. */
  private chipPickerHtml(): string {
    return `<div class="fld"><label>Target chip picker — selecting a model fills the fields below (library scanned from the MRS2 SDK component)</label>
<div style="display:flex;gap:10px;align-items:stretch">
<select id="chip-series" size="10" style="flex:1;min-width:150px;height:230px"></select>
<select id="chip-model" size="10" style="flex:1;min-width:150px;height:230px"></select>
<div id="chip-info" style="flex:1.4;border:1px solid var(--vscode-input-border);padding:8px;font-size:12.5px;color:var(--vscode-descriptionForeground);overflow:auto;height:230px;box-sizing:border-box;line-height:1.5"></div>
</div></div>`;
  }

  private chipPickerScript(db: ChipDb, nonce: string): string {
    return `<script nonce="${nonce}">
const CHIP_DB = ${jsonForScript(db)};
(function () {
  const seriesSel = document.getElementById('chip-series');
  const modelSel = document.getElementById('chip-model');
  const info = document.getElementById('chip-info');
  if (!seriesSel || !modelSel || !info) return;
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const find = (n) => CHIP_DB.series.find((s) => s.name === n);
  const setField = (k, v) => { const el = document.querySelector('[data-key="' + k + '"]'); if (el) el.value = v; };
  const groups = {};
  CHIP_DB.series.forEach((s) => { (groups[s.arch] = groups[s.arch] || []).push(s); });
  seriesSel.innerHTML = Object.keys(groups).sort().map((a) =>
    '<optgroup label="' + esc(a) + '">' + groups[a].map((s) => '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>').join('') + '</optgroup>'
  ).join('');
  function fillModels() {
    const s = find(seriesSel.value);
    modelSel.innerHTML = (s ? s.chips : []).map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
  }
  function fillInfo(apply) {
    const s = find(seriesSel.value);
    if (!s) return;
    const mcu = modelSel.value;
    info.innerHTML = 'Series: <b>' + esc(s.name) + '</b> [' + esc(s.arch) + ']'
      + '<br>MCU type: <b>' + esc(s.mcuType) + '</b>'
      + '<br>Download address: <b>' + esc(s.flashAddress || 'from .template') + '</b>'
      + '<br><span style="opacity:.7">Applying writes Series / MCU / MCU type'
      + (s.flashAddress ? ' / Address' : '') + ' into the .template fields below.</span>';
    if (!apply) return;
    setField('series', s.name);
    setField('mcutype', s.mcuType);
    if (mcu) setField('mcu', mcu);
    if (s.flashAddress) setField('address', s.flashAddress);
  }
  seriesSel.addEventListener('change', () => { fillModels(); fillInfo(false); });
  modelSel.addEventListener('change', () => fillInfo(true));
  // locate the project's current chip: exact model match, then series/mcu
  // type match; on a miss just show the first series without touching fields
  const cur = (document.querySelector('[data-key="mcu"]') || {}).value || '';
  let sel = CHIP_DB.series.find((s) => s.chips.includes(cur))
    || CHIP_DB.series.find((s) => s.mcuType === cur)
    || CHIP_DB.series.find((s) => cur.startsWith(s.name));
  if (!sel) sel = CHIP_DB.series[0];
  seriesSel.value = sel.name;
  fillModels();
  if (sel.chips.includes(cur)) modelSel.value = cur;
  fillInfo(false);
})();
</script>`;
  }
}
