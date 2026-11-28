/**
 * .cproject (Eclipse CDT managed build, GNU MCU Eclipse RISC-V flavour)
 * typed model with read AND write access over the underlying XML DOM.
 *
 * Options are addressed by the last segment of their superClass, e.g.
 *   ilg.gnumcueclipse.managedbuild.cross.riscv.option.optimization.level
 * -> "optimization.level"
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { XElement, parseXml, serializeXml } from './xml';
import { readProjectFile, linkedFolderMap } from './projectFile';

const OPT_BASE = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
const TOOL_BASE = 'ilg.gnumcueclipse.managedbuild.cross.riscv.tool.';

/** Path/name identity fold: Windows (NTFS) compares case-insensitively,
 * POSIX does not — /work/Foo and /work/foo are different projects there.
 * Use this instead of an unconditional toLowerCase() in identity keys. */
export function foldPathOnPlatform(s: string): string {
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** Windows path/Name comparison folds case (NTFS is case-insensitive):
 * EVT files sometimes spell exclusion tokens, sourceEntry names or link
 * names with different case than the .project/.cproject counterpart —
 * matching must fold, or "Restore include" silently no-ops and "Exclude"
 * appends a duplicate token. Mirrors scan.ts's fold. */
function foldName(s: string): string {
  return foldPathOnPlatform(s);
}

export interface SourceEntry {
  name: string; // "" = project root
  excluding: string[];
  element: XElement;
}

/**
 * WHY a configuration name needs this gate: the name becomes a DIRECTORY
 * under the project root AND rides into watcher brace-globs, so everything
 * that could escape or break that contract is refused:
 *   - path separators and everything Windows forbids in a path segment
 *     (`< > : " | ? *`), NUL / control characters;
 *   - glob metacharacters `[ ] { } , !` — the output-dir watcher pattern
 *     embeds every configuration name in one brace glob;
 *   - a trailing dot or space (Windows folds both away);
 *   - Windows RESERVED DEVICE NAMES (`CON PRN AUX NUL COM1-9 LPT1-9`,
 *     case-insensitive, also with an extension: `CON.txt` is `CON`) —
 *     the build wrapper's `cd /d` and `fs.mkdirSync` both fail on them
 *     (round6 P2: the name was accepted, the build then died in the shell);
 *     SUPERSCRIPT digits (`COM¹ LPT¹`, U+00B9/B2/B3, U+2070-2079) are
 *     deliberately NOT in this list — round7 P3-1 probed them three ways
 *     (NT GetFileAttributes resolves real dirs named COM¹ fine; a
 *     CP936-encoded wrapper `cd /d` into an encodable non-ASCII digit
 *     lookalike `COM１` lands; the failure seen in review was a probe
 *     artifact: a UTF-8 .cmd read back through the ANSI code page).
 *     On ACP-936 machines these chars simply have no GBK bytes at all, so
 *     the build fails loudly at wrapper WRITE time via encodeArtifact —
 *     the same locale bound MRS2 itself is under.
 *   - names longer than 255 UTF-16 units or 255 UTF-8 bytes — one is the
 *     Windows segment limit, the other ext4's; beyond either, mkdir fails
 *     with EINVAL/ENAMETOOLONG instead of an actionable message.
 * A LEADING `-` is allowed on purpose (round5 P2): MRS's own dialog accepts
 * it, and the configuration directory never becomes a make ARGUMENT — it is
 * the wrapper's `cd` target, so no `-foo/...` option parsing can happen.
 * Everything MRS's own dialog can produce — letters, digits, CJK, `_`, `-` —
 * passes, so the write side (configSwitch's CONFIG_NAME_RE) and this read
 * side agree on every name the UI can write. Real EVT corpus (1445
 * .cproject): only obj / dbg / obj1 occur.
 */
export function configNameProblem(raw: string): string | undefined {
  if (!raw || raw === '.' || raw === '..') return 'must not be empty, "." or ".."';
  if (/[/\\]/.test(raw)) return 'must not contain path separators';
  if (/[<>:"|?*[\]{}!,]/.test(raw)) return 'must not contain path or glob characters';
  if (/[\x00-\x1f\x7f]/.test(raw)) return 'must not contain control characters';
  if (/[. ]$/.test(raw)) return 'must not end with a dot or space (Windows folds them away)';
  const dot = raw.indexOf('.');
  const stem = (dot === -1 ? raw : raw.slice(0, dot)).toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return 'is a reserved Windows device name';
  if (raw.length > 255 || Buffer.byteLength(raw, 'utf8') > 255) return 'is too long for a directory name (max 255 bytes)';
  return undefined;
}

export function isValidConfigName(raw: string): boolean {
  return configNameProblem(raw) === undefined;
}

/**
 * Configuration names that occur more than once (0.3.7, user request B).
 * A configuration's name IS its output directory, so two configurations
 * sharing a name share ONE directory: "ReBuild Project All Configurations"
 * regenerates the makefiles of the second configuration over the first one
 * in the same folder (MRS behaves identically — it loops by index and uses
 * the name as the path). That is not an error, but the user should know why
 * the two configurations do not produce two outputs. Returns each duplicated
 * name once, in first-seen order (first-seen spelling); empty when every
 * name is unique.
 *
 * Two names are "the same" when they land in ONE output directory: on
 * Windows that is case-insensitive — `obj` and `OBJ` share a folder, the
 * same pair MRVC's own assertUnique refuses — so the comparison folds case
 * there (0.3.7 round1 P3.3). On Linux/macOS the two are distinct folders and
 * stay distinct names. `fold` is the test seam for the host platform.
 */
export function duplicateConfigNames(names: readonly string[], fold: (s: string) => string = foldPathOnPlatform): string[] {
  const firstByKey = new Map<string, string>();
  const dupes: string[] = [];
  for (const n of names) {
    const key = fold(n);
    const first = firstByKey.get(key);
    if (first === undefined) {
      firstByKey.set(key, n);
      continue;
    }
    if (!dupes.includes(first)) dupes.push(first);
  }
  return dupes;
}

/**
 * A configuration's name — CDT keeps it on the inner <configuration
 * name="obj">, the outer <cconfiguration> wrapper only carries the id.
 * The name becomes a directory under the project root, so it must pass
 * {@link isValidConfigName}; an UNSAFE name is a parse error (loudly
 * unloadable project instead of a silent build-directory escape). Only a
 * nameless inner <configuration> (synthetic fixtures) falls back to CDT's
 * default 'obj'.
 */
export function configurationName(cfg: XElement): string {
  const raw = cfg.find((e) => e.name === 'configuration')?.attr('name') ?? cfg.attr('name');
  if (raw === undefined) return 'obj';
  const problem = configNameProblem(raw);
  if (problem) {
    throw new Error(`.cproject: unsafe configuration name "${raw}" — ${problem}`);
  }
  return raw;
}

export interface ListOption {
  values: string[];
  elements: XElement[];
  option: XElement | undefined;
}

export class Cproject {
  root: XElement;
  file: string;
  projectRoot: string;
  /** first (active) configuration */
  config: XElement;
  configName: string;
  toolChain: XElement;
  /** linked-folder logic name -> absolute target dir (from .project) */
  linkedFolders: Map<string, string> = new Map();
  /** true when the project carries the CDT C++ nature */
  cppProject = false;
  /** .project display name — MRS2's ${ProjName} (may differ from the dir) */
  private projectDisplayName = '';
  private suffixIndex: Map<string, XElement[]> = new Map();
  /** the configuration element SOURCE ENTRIES are read from. MRS2's
   * rebuild-all builds every configuration with the ACTIVE configuration's
   * exclusion table (preBuild.ts isExluded() hardcodes configurations[0]),
   * so a non-first-configuration model still reads entries from index 0. */
  private entriesConfig: XElement;

  constructor(file: string, configIndex = 0, opts?: { repairProject?: boolean }) {
    this.file = file;
    this.projectRoot = path.dirname(file);
    try {
      // repairProject defaults to TRUE (the extension's first-open auto-repair
      // of stale EVT links rides on this load); MCP read-only tools pass
      // false — a query must never rewrite the project (round14 P3.1)
      const proj = readProjectFile(this.projectRoot, { repair: opts?.repairProject });
      this.projectDisplayName = proj.name ?? '';
      this.linkedFolders = linkedFolderMap(proj);
      // CDT's C++ nature id is org.eclipse.cdt.core.ccnature — checking only
      // "cxxnature" (not a real id) treated EVERY C++ project as a C one and
      // silently dropped its .cpp/.cc/.cxx sources from the build (MRVC <=
      // 0.2.2). The legacy spelling stays accepted: MRVC's own C++ toggle
      // wrote it until the same fix.
      this.cppProject =
        proj.natures.includes('org.eclipse.cdt.core.ccnature') ||
        proj.natures.includes('org.eclipse.cdt.core.cxxnature');
    } catch {
      // no/broken .project: proceed with macro-only resolution
    }
    const raw = fs.readFileSync(file, 'utf-8');
    this.root = parseXml(raw);
    const cconfigs = this.root.findAll((e) => e.name === 'cconfiguration');
    const cfg = cconfigs[configIndex] ?? cconfigs[0] ?? this.root.find((e) => e.name === 'configuration');
    if (!cfg) {
      throw new Error('.cproject: no <cconfiguration> found');
    }
    this.config = cfg;
    // the name lives on the inner <configuration> in real files (the
    // cconfiguration wrapper carries no name)
    this.configName = configurationName(cfg);
    const tc = cfg.find((e) => e.name === 'toolChain');
    if (!tc) {
      throw new Error('.cproject: no <toolChain> found');
    }
    this.toolChain = tc;
    // exclusion table always comes from the FIRST configuration (MRS parity,
    // see the field comment) — for the active configuration this is the same
    // element as this.config
    this.entriesConfig = cconfigs[0] ?? cfg;
    // index every option element by superClass suffix
    for (const opt of cfg.findAll((e) => e.name === 'option' && !!e.attr('superClass'))) {
      const sc = opt.attr('superClass')!;
      const suffix = sc.startsWith(OPT_BASE) ? sc.slice(OPT_BASE.length) : sc;
      const list = this.suffixIndex.get(suffix) ?? [];
      list.push(opt);
      this.suffixIndex.set(suffix, list);
    }
    this.resolveImplicitLinkedFolders();
  }

  /**
   * Some newer EVT projects keep shared folders (Startup/Core/Ld/…) only in
   * the MRS2 model (`.wvproj`); their legacy .project has no
   * linkedResources for them, yet sourceEntries still reference the names.
   * Resolve such names against the siblings of known linked folders and the
   * project ancestors so scanning and ${ProjName}/<name> includes work.
   */
  private resolveImplicitLinkedFolders(): void {
    for (const entry of this.sourceEntries) {
      const name = entry.name;
      // case-folded link match (win32): an .cproject entry may spell the
      // .project link name with different case (round20 P2-1)
      if (!name || [...this.linkedFolders.keys()].some((k) => foldName(k) === foldName(name))) continue;
      if (fs.existsSync(path.join(this.projectRoot, name))) continue; // real dir
      let resolved: string | null = null;
      for (const t of this.linkedFolders.values()) {
        const cand = path.join(path.dirname(t), name);
        if (fs.existsSync(cand)) {
          resolved = cand;
          break;
        }
      }
      for (let level = 0; level <= 6 && !resolved; level++) {
        let base = this.projectRoot;
        for (let i = 0; i < level; i++) base = path.dirname(base);
        for (const cand of [path.join(base, name), path.join(base, 'SRC', name)]) {
          if (fs.existsSync(cand)) {
            resolved = path.normalize(cand);
            break;
          }
        }
      }
      if (resolved) {
        this.linkedFolders.set(name, resolved);
      }
    }
  }

  static load(projectRoot: string, opts?: { repairProject?: boolean }): Cproject {
    return new Cproject(path.join(projectRoot, '.cproject'), 0, opts);
  }

  /** a configuration-scoped model: index 0 is the ACTIVE configuration (the
   * default); 1..n are the remaining ones, used only for read-only builds
   * ("ReBuild Project All Configurations"). Options/target name/build dir
   * follow the chosen configuration; the exclusion table still comes from
   * index 0 (MRS parity — see entriesConfig). */
  static loadConfigAt(projectRoot: string, index: number, opts?: { repairProject?: boolean }): Cproject {
    return new Cproject(path.join(projectRoot, '.cproject'), index, opts);
  }

  get isCpp(): boolean {
    return this.cppProject;
  }

  /** every <cconfiguration> in file order — index 0 is the ACTIVE one
   * (MRS2 stores "active" as array position, never as a flag) */
  get configurationElements(): XElement[] {
    return this.root.findAll((e) => e.name === 'cconfiguration');
  }

  /** configuration names in file order (same strings as MRS2's list) */
  get configurationNames(): string[] {
    return this.configurationElements.map((el) => configurationName(el));
  }

  /** stable identity of the ACTIVE configuration — the cconfiguration
   *  element's id attribute. An EXTERNAL switch (MRS / MCP) reorders the
   *  file, so index 0 can be a different configuration by the time a
   *  consumer acts: comparing this id catches the swap even when both
   *  configurations share a name (review P2 — a stale Properties panel must
   *  not write its drafts into the new active configuration). */
  get activeConfigurationId(): string | undefined {
    return this.configurationElements[0]?.attr('id');
  }

  /**
   * CONTENT fingerprint of the active configuration — SHA-256 over a
   * WHITESPACE-CANONICAL shape of the <cconfiguration> subtree (tags,
   * sorted attributes, decoded text; inter-tag whitespace ignored). Raw
   * serialization is NOT round-trip stable for a mutated tree (an appended
   * option's recorded indent differs from the re-parsed file's), so the
   * fingerprint must ignore layout. This still distinguishes configurations
   * whose ids are MISSING (hand-imported projects) or DUPLICATED (a clone
   * whose non-standard ids our rewriter could not touch, review round2 P2).
   * Two configurations with identical canonical content are semantically
   * the same config, so a swap between them is undetectable AND harmless.
   */
  activeConfigurationFingerprint(): string {
    return createHash('sha256').update(canonicalShape(this.configurationElements[0])).digest('hex');
  }

  /** content fingerprints of EVERY configuration, in file order — the
   *  Manage-dialog staleness resolver matches a rendered row against this
   *  list (see configView resolveRowIndex). */
  configurationFingerprints(): string[] {
    return this.configurationElements.map((el) => createHash('sha256').update(canonicalShape(el)).digest('hex'));
  }

  /** configuration names used by more than one configuration — each once,
   * first-seen order; empty when unique. Duplicate names SHARE one output
   * directory (see duplicateConfigNames) */
  get duplicateConfigurationNames(): string[] {
    return duplicateConfigNames(this.configurationNames);
  }

  get artifactName(): string {
    const cfgAttr = this.buildConfigEl.attr('artifactName') ?? '${ProjName}';
    return cfgAttr === '${ProjName}' ? this.projectName : cfgAttr;
  }

  get projectName(): string {
    // MRS2's ${ProjName}: the .project DISPLAY name, not the directory name.
    // A project folder may be renamed/copied independently of its display
    // name ("I2C copy" holding project "I2C") — make targets cannot carry
    // the directory's spaces, and MRS2 builds such projects cleanly under
    // the display name.
    return this.projectDisplayName || path.basename(this.projectRoot);
  }

  /**
   * The inner <configuration> element carrying the build identity
   * attributes (artifactName / buildArtefactType / buildProperties / name).
   * Real CDT files nest it under <storageModule moduleId="cdtBuildSystem">;
   * synthetic fixtures may put the attributes straight on <cconfiguration>.
   */
  private get buildConfigEl(): XElement {
    return this.config.find((e) => e.name === 'configuration') ?? this.config;
  }

  get artifactType(): 'exe' | 'staticLib' {
    const bc = this.buildConfigEl;
    // MRS writes the standalone buildArtefactType attribute and mirrors it
    // into the buildProperties comma list; read both (some files carry only
    // one). CDT's id is `staticLib` — the substring test also matches the
    // older `staticLibrary` spelling some tools wrote.
    const kind = `${bc.attr('buildArtefactType') ?? ''},${bc.attr('buildProperties') ?? ''}`;
    return kind.includes('buildArtefactType.staticLib') ? 'staticLib' : 'exe';
  }

  /** artifact extension (inner configuration attribute, default "elf") */
  get artifactExtension(): string {
    return this.buildConfigEl.attr('artifactExtension') ?? 'elf';
  }

  /** C/C++ linker <tool> elements — where MRS2 stores outputPrefix */
  private linkerToolEls(): XElement[] {
    if (!this.toolChain) return [];
    return this.toolChain.childrenNamed('tool').filter((t) => {
      const sc = t.attr('superClass') ?? '';
      return sc.endsWith('.tool.c.linker') || sc.endsWith('.tool.cpp.linker');
    });
  }

  /** artifact output prefix (linker tool attribute, default empty) */
  get outputPrefix(): string {
    const linkers = this.linkerToolEls();
    for (const t of linkers) {
      const v = t.attr('outputPrefix');
      if (v !== undefined) return v;
    }
    return '';
  }

  /** pre/post build steps live as attributes on the <builder> element */
  private get builderEl(): XElement | undefined {
    return this.toolChain?.child('builder');
  }

  get prebuildStep(): string {
    return this.builderEl?.attr('prebuildStep') ?? '';
  }

  get prebuildAnnounce(): string {
    return this.builderEl?.attr('preannouncebuildStep') ?? '';
  }

  get postbuildStep(): string {
    return this.builderEl?.attr('postbuildStep') ?? '';
  }

  get postbuildAnnounce(): string {
    return this.builderEl?.attr('postannouncebuildStep') ?? '';
  }

  /** batched write for the Build Steps / Build Artifact pages */
  setBuildIdentity(v: {
    prebuildStep?: string;
    prebuildAnnounce?: string;
    postbuildStep?: string;
    postbuildAnnounce?: string;
    artifactName?: string;
    artifactExtension?: string;
    outputPrefix?: string;
    artifactType?: 'exe' | 'staticLib';
  }): void {
    const b = this.builderEl;
    const setB = (name: string, value?: string): void => {
      if (value === undefined) return;
      if (!b) throw new Error('.cproject: <builder> not found');
      b.setAttr(name, value);
    };
    // CDT property names: preannouncebuildStep/postannouncebuildStep
    setB('prebuildStep', v.prebuildStep);
    setB('preannouncebuildStep', v.prebuildAnnounce);
    setB('postbuildStep', v.postbuildStep);
    setB('postannouncebuildStep', v.postbuildAnnounce);
    const bc = this.buildConfigEl;
    if (v.artifactName !== undefined) bc.setAttr('artifactName', v.artifactName);
    if (v.artifactExtension !== undefined) bc.setAttr('artifactExtension', v.artifactExtension);
    if (v.outputPrefix !== undefined) {
      for (const t of this.linkerToolEls()) t.setAttr('outputPrefix', v.outputPrefix);
      delete bc.attrs['outputPrefix']; // never leave it on the configuration
    }
    if (v.artifactType !== undefined) {
      // CDT's own id (and the one MRS writes) is `staticLib`, not
      // `staticLibrary` — MRS reads the standalone attribute first, so a
      // wrong spelling would make it treat the project as an executable.
      const kind = v.artifactType === 'staticLib' ? 'staticLib' : 'exe';
      // MRS2 reads the standalone buildArtefactType attribute FIRST — keep
      // it in sync with the buildProperties comma list
      bc.setAttr('buildArtefactType', `org.eclipse.cdt.build.core.buildArtefactType.${kind}`);
      const target = `org.eclipse.cdt.build.core.buildArtefactType=org.eclipse.cdt.build.core.buildArtefactType.${kind}`;
      const cur = bc.attr('buildProperties') ?? '';
      const parts = cur.split(',').filter((p) => p && !p.startsWith('org.eclipse.cdt.build.core.buildArtefactType='));
      parts.unshift(target);
      bc.setAttr('buildProperties', parts.join(','));
    }
  }

  /** artifact base name without extension, e.g. "LED" */
  get targetName(): string {
    return this.artifactName;
  }

  /** the raw stored artifact name (${ProjName} stays symbolic) — for the
   * Build Artifact page, which must show variables the MRS way */
  get artifactNameRaw(): string {
    return this.buildConfigEl.attr('artifactName') ?? '${ProjName}';
  }

  /** raw command prefix stored in .cproject (informational only) */
  /**
   * Toolchain prefix from the `command.prefix` option. Real MRS projects
   * store the BARE form (verified: 2919/2919 options across 2685 .cproject
   * files in the CH585/CH592/CH587 trees), but the option is a CDT command
   * option that other writers spell per language — accept every form, the
   * project's own language first, so a read never silently falls back to the
   * GCC8 default just because of a spelling.
   */
  get storedPrefix(): string {
    const own = this.isCpp ? 'cpp' : 'c';
    const other = this.isCpp ? 'c' : 'cpp';
    for (const suffix of [`${own}.command.prefix`, 'command.prefix', `${other}.command.prefix`]) {
      const value = this.optionValue(suffix);
      if (value) return value;
    }
    return 'riscv-none-embed-';
  }

  /** rvGcc enumeration value suffix: "8" | "12" | "15" | undefined */
  get rvGccVersion(): string | undefined {
    const v = this.optionValue('target.rvGcc');
    if (!v) return undefined;
    const m = v.match(/rvGcc\.?(\d+)$/);
    return m ? m[1] : undefined;
  }

  option(suffix: string): XElement | undefined {
    const list = this.suffixIndex.get(suffix);
    return list && list.length ? list[0] : undefined;
  }

  /** scalar value of an option (boolean -> "true"/"false", enumerated -> raw enum value) */
  optionValue(suffix: string): string | undefined {
    const opt = this.option(suffix);
    if (!opt) return undefined;
    return opt.attr('value');
  }

  optionBool(suffix: string, fallback = false): boolean {
    const v = this.optionValue(suffix);
    if (v === undefined) return fallback;
    return v === 'true';
  }

  /** enumerated value reduced to its last path segment: "...arch.rv32i" -> "rv32i" */
  optionEnum(suffix: string): string | undefined {
    const v = this.optionValue(suffix);
    if (v === undefined) return undefined;
    const segs = v.split('.');
    return segs[segs.length - 1];
  }

  listOption(suffix: string): ListOption {
    const opt = this.option(suffix);
    if (!opt) return { values: [], elements: [], option: undefined };
    const elements = opt.childrenNamed('listOptionValue');
    return {
      values: elements.map((e) => (e.attr('value') ?? '').replace(/^"(.*)"$/, '$1')),
      elements,
      option: opt,
    };
  }

  /** ---- typed views ---- */

  get optimizationLevel(): string {
    return this.optionEnum('optimization.level') ?? 'size';
  }

  get languageStandard(): string {
    return this.optionEnum('c.compiler.std') ?? 'gnu99';
  }

  get debugLevel(): string | undefined {
    return this.optionEnum('debugging.level');
  }

  get flashFormat(): 'ihex' | 'binary' {
    const v = this.optionEnum('createflash.choice');
    return v === 'binary' ? 'binary' : 'ihex';
  }

  get createFlash(): boolean {
    return this.optionBool('addtools.createflash', true);
  }

  get createListing(): boolean {
    return this.optionBool('addtools.createlisting', false);
  }

  get printSize(): boolean {
    return this.optionBool('addtools.printsize', false);
  }

  get sourceEntries(): SourceEntry[] {
    // entriesConfig, NOT this.config: even a later configuration's model
    // reads the ACTIVE configuration's exclusion table (MRS rebuild-all
    // parity — preBuild.ts isExluced() hardcodes configurations[0])
    const entries = this.entriesConfig.findAll((e) => e.name === 'entry' && e.attr('kind') === 'sourcePath');
    return entries.map((element) => ({
      name: element.attr('name') ?? '',
      excluding: (element.attr('excluding') ?? '')
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      element,
    }));
  }

  /** ---- write accessors ---- */

  /**
   * Exclude a resource (project-root-relative logic path) from the build.
   * Writes the token where MRS2 itself writes it: folder-relative into the
   * named sourceEntry of the top-level folder when one exists (CH585 style),
   * else as the full logic path into the root entry (CH587 style), creating
   * that entry if the project has none.
   *
   * A top-level folder that carries its own named sourceEntry is special:
   * CDT union semantics make the entry re-include the folder, so a root-entry
   * token alone is a "don't double-scan" marker the scanner ignores — the
   * exclusion that actually works is REMOVING the entry (and writing the
   * token, which becomes a real exclusion precisely because the entry is
   * gone; includeResource rebuilds it).
   */
  excludeResource(logicPath: string): void {
    if (!logicPath.includes('/')) {
      const named = this.namedEntryEl(logicPath);
      if (named) {
        named.parent?.removeChild(named);
        const root = this.rootEntryEl(true)!;
        const cur = splitExcluding(root);
        if (!cur.some((tk) => foldName(tk) === foldName(logicPath))) {
          cur.push(logicPath);
          setExcludingAttr(root, cur.join('|'));
        }
        return;
      }
    }
    const { entry, token } = this.exclusionTarget(logicPath);
    const cur = splitExcluding(entry);
    if (cur.some((tk) => foldName(tk) === foldName(token))) return;
    cur.push(token);
    setExcludingAttr(entry, cur.join('|'));
  }

  /**
   * Re-include a previously excluded resource: strip the token (full-path
   * and folder-relative, with and without trailing slash) from the root
   * entry and from the top folder's named entry. An emptied list keeps the
   * attribute as excluding="" (MRS2 style). A top-level folder whose entry
   * excludeResource removed gets that entry BACK — MRS2 files pair such
   * folders with their own sourceEntry, and without it the leftover root
   * token would keep reading as a real exclusion.
   */
  includeResource(logicPath: string): void {
    const top = logicPath.includes('/') ? logicPath.slice(0, logicPath.indexOf('/')) : '';
    const rel = logicPath.includes('/') ? logicPath.slice(logicPath.indexOf('/') + 1) : logicPath;
    // folded compare (win32): the on-disk token may spell the path with a
    // different case than the logic path (MRS2 hand-written files do) —
    // literal matching left those tokens in place and "restore include"
    // reported success while the file stayed excluded
    const variants = new Set([logicPath, logicPath + '/', rel, rel + '/'].map(foldName));
    const isVariant = (t: string): boolean => variants.has(foldName(t));
    const rootEl = this.rootEntryEl(false);
    const wasTopExcluded = !top && !!rootEl && splitExcluding(rootEl).some((tk) => foldName(tk) === foldName(logicPath) || foldName(tk) === foldName(logicPath + '/'));
    const targets = [this.namedEntryEl(top), rootEl];
    for (const entry of targets) {
      if (!entry) continue;
      const cur = splitExcluding(entry);
      const next = cur.filter((t) => !isVariant(t));
      if (next.length !== cur.length) {
        setExcludingAttr(entry, next.join('|'));
      }
    }
    if (wasTopExcluded && !this.namedEntryEl(logicPath)) {
      const wrap = this.sourceEntriesWrap(true)!;
      const el = new XElement('entry');
      // the exact shape MRS2 writes for a plain included folder (no
      // excluding attribute at all)
      el.setAttr('flags', 'VALUE_WORKSPACE_PATH|RESOLVED');
      el.setAttr('kind', 'sourcePath');
      el.setAttr('name', logicPath);
      wrap.append(el);
    }
  }

  /** named sourceEntry of the top-level folder, else the root entry */
  private exclusionTarget(logicPath: string): { entry: XElement; token: string } {
    const top = logicPath.includes('/') ? logicPath.slice(0, logicPath.indexOf('/')) : '';
    const named = top ? this.namedEntryEl(top) : undefined;
    if (named) {
      return { entry: named, token: logicPath.slice(top.length + 1) };
    }
    return { entry: this.rootEntryEl(true)!, token: logicPath };
  }

  /** first <entry kind="sourcePath" name=""> element, optionally created */
  private rootEntryEl(create: boolean): XElement | undefined {
    const existing = this.config.findAll(
      (e) => e.name === 'entry' && e.attr('kind') === 'sourcePath' && (e.attr('name') ?? '') === ''
    );
    if (existing.length) return existing[0];
    if (!create) return undefined;
    const wrap = this.sourceEntriesWrap(true)!;
    const el = new XElement('entry');
    el.setAttr('flags', 'VALUE_WORKSPACE_PATH');
    el.setAttr('kind', 'sourcePath');
    el.setAttr('name', '');
    wrap.append(el);
    return el;
  }

  /** the <sourceEntries> wrapper, optionally created where real CDT files
   * keep it: a sibling of <folderInfo>, i.e. a child of the inner
   * <configuration> (the toolChain's grandparent); synthetic fixtures nest
   * it under <cconfiguration> */
  private sourceEntriesWrap(create: boolean): XElement | undefined {
    const wrap = this.config.find((e) => e.name === 'sourceEntries');
    if (wrap || !create) return wrap;
    const el = new XElement('sourceEntries');
    (this.toolChain?.parent?.parent ?? this.config).append(el);
    return el;
  }

  private namedEntryEl(name: string): XElement | undefined {
    if (!name) return undefined;
    // folded compare on Windows: EVT files sometimes spell a sourceEntry
    // name with different case than the .project link name — the scanner's
    // marker logic folds too, so exclude/include must find the same element
    return this.config.findAll(
      (e) => e.name === 'entry' && e.attr('kind') === 'sourcePath' && foldName(e.attr('name') ?? '') === foldName(name)
    )[0];
  }

  setOptionValue(suffix: string, value: string | undefined): void {
    const opt = this.option(suffix);
    if (!opt) {
      if (value === undefined) return;
      this.createOption(suffix, value, undefined);
      return;
    }
    if (value === undefined) {
      // an ENUMERATED option keeps its value attribute: CDT/MRS always store
      // one and MRS's reader does value.match(...) UNGUARDED — a missing
      // attribute crashed its extension host and made the project unopenable
      // in MRS itself (rvGcc, TCP_SERVER/MACRAW/TCP_CLIENT, 2026-11-12).
      // Legacy "project default" therefore only clears LIST values here.
      const enumerated = opt.attr('valueType') === 'enumerated';
      opt.childrenNamed('listOptionValue').forEach((c) => opt.removeChild(c));
      if (!enumerated) {
        opt.attrs['value'] = '';
        delete opt.attrs['value'];
      }
      return;
    }
    opt.setAttr('value', value);
  }

  setOptionBool(suffix: string, value: boolean, create = false): void {
    const opt = this.option(suffix);
    if (!opt) {
      // create materializes the EXPLICIT choice, false included: several
      // linker bools default ON when the option is absent (c.linker.gcsections
      // / nostart — MRS2's CLinker model, mirrored in flags.ts) — skipping the
      // write on false left such an option silently ON while every UI showed
      // it off (v0.3.8 review H3)
      if (create) this.createOption(suffix, value ? 'true' : 'false', 'boolean');
      return;
    }
    opt.setAttr('value', value ? 'true' : 'false');
  }

  /**
   * Mirror every C option into its C++ twin, creating the twin when missing —
   * the .cproject half of the C -> C++ project-type conversion. A C project's
   * .cproject carries only a handful of cpp.* options, so a nature-only toggle
   * builds C++ with an empty option set: no include paths, no linker script
   * (measured — the link then dies on a bare "Link.ld"). MRS2 reads the cpp.*
   * set for a C++ project, so the values must live there.
   * Returns the number of C options mirrored.
   */
  ensureCppOptionsFromC(): number {
    const prefix = OPT_BASE + 'c.';
    let mirrored = 0;
    for (const opt of this.config.findAll((e) => e.name === 'option')) {
      const sc = opt.attr('superClass') ?? '';
      if (!sc.startsWith(prefix)) continue;
      const suffix = sc.slice(OPT_BASE.length); // c.<tool>.<option…>
      const twin = 'cpp.' + suffix.slice(2); // cpp.<tool>.<option…>
      const lists = opt.childrenNamed('listOptionValue');
      const single = opt.attr('value');
      if (lists.length) {
        this.mirrorListOption(suffix, twin);
      } else if (single !== undefined) {
        this.setOptionValue(twin, single);
      } else {
        // mirror "no value" (clears a stale twin; never creates one)
        this.setOptionValue(twin, undefined);
      }
      mirrored++;
    }
    return mirrored;
  }

  /**
   * Copy a list option's entries into its twin attribute-for-attribute.
   * MRS2 stores every valueType in its own native spelling — library names,
   * symbols and other objects unquoted, macro paths as `"${workspace_loc:…}"` —
   * and its reader strips the quotes only for the path-ish fields
   * (`EPMacroStrResolve`); `libraries` / `defined_symbols` reach its model
   * verbatim. Re-quoting everything through setOptionList() would re-spell a
   * library name as `"m"` and carry those quotes into MRS2's model (and into
   * `USER_OBJS`, which MRS2 quotes by itself), so the spelling is preserved.
   */
  private mirrorListOption(source: string, twin: string): void {
    const src = this.option(source);
    if (!src) return;
    let dst = this.option(twin);
    if (!dst) dst = this.createOption(twin, '', guessValueType(twin));
    for (const c of dst.childrenNamed('listOptionValue')) {
      dst.removeChild(c);
    }
    for (const el of src.childrenNamed('listOptionValue')) {
      const copy = new XElement('listOptionValue');
      for (const [k, v] of Object.entries(el.attrs)) copy.setAttr(k, v);
      dst.append(copy);
    }
    for (const marker of ['IS_BUILTIN_EMPTY', 'IS_VALUE_EMPTY']) {
      const v = src.attr(marker);
      if (v !== undefined) dst.setAttr(marker, v);
    }
  }

  /** replace the whole list of a list-valued option */
  setOptionList(suffix: string, values: string[]): void {
    let opt = this.option(suffix);
    if (!opt) {
      opt = this.createOption(suffix, '', guessValueType(suffix));
    }
    for (const c of opt!.childrenNamed('listOptionValue')) {
      opt!.removeChild(c);
    }
    // a rewritten list is no longer empty — clear the CDT emptiness markers
    delete opt!.attrs['IS_VALUE_EMPTY'];
    delete opt!.attrs['IS_BUILTIN_EMPTY'];
    // quoting policy follows the MRS2 model (see mirrorListOption's comment):
    // library names and USER_OBJS reach MRS2's model VERBATIM — re-quoting
    // them would carry literal quote characters into its reader (and into the
    // link line), so only the path-ish lists get the quoted spelling
    const quote = !(suffix.endsWith('.libs') || suffix.endsWith('.otherobjs'));
    for (const v of values) {
      const e = new XElement('listOptionValue');
      e.setAttr('builtIn', 'false');
      e.setAttr('value', quote ? `"${v}"` : v);
      opt!.append(e);
    }
  }

  /** add one value to a list-valued option; no-op when already present */
  addToListOption(suffix: string, value: string, valueType = 'includePath'): void {
    let opt = this.option(suffix);
    if (!opt) {
      opt = this.createOption(suffix, '', valueType);
    }
    const existing = this.listOption(suffix).values;
    if (existing.includes(value)) return;
    const e = new XElement('listOptionValue');
    e.setAttr('builtIn', 'false');
    e.setAttr('value', `"${value}"`);
    opt!.append(e);
    if (opt!.attrs['IS_VALUE_EMPTY'] === 'true') {
      delete opt!.attrs['IS_VALUE_EMPTY'];
    }
  }

  removeFromListOption(suffix: string, value: string): void {
    const opt = this.option(suffix);
    if (!opt) return;
    const target = `"${value}"`;
    for (const c of opt.childrenNamed('listOptionValue')) {
      if ((c.attr('value') ?? '') === target || c.attr('value') === value) {
        opt.removeChild(c);
        break;
      }
    }
  }

  /** every option suffix present in the active configuration (index order) */
  optionSuffixes(): string[] {
    return [...this.suffixIndex.keys()];
  }

  /**
   * MRS2's C++ projects carry an <inputType> under the C++ compiler tool — both
   * real C++ projects inspected (FingerCode, LiteOS) use the very id from
   * MRS2's own template (...tool.cpp.compiler.input.1079228323, not a random
   * one), while C projects have it for assembler / c.compiler / c.linker only.
   * A project converted to C++ must gain it too; returns true when added.
   */
  ensureCppCompilerInputType(): boolean {
    const tool = this.toolChain?.childrenNamed('tool').find((t) => t.attr('name') === 'GNU RISC-V Cross C++ Compiler');
    if (!tool || tool.childrenNamed('inputType').length) return false;
    const el = new XElement('inputType');
    el.setAttr('id', TOOL_BASE + 'cpp.compiler.input.1079228323');
    el.setAttr('superClass', TOOL_BASE + 'cpp.compiler.input');
    tool.append(el);
    return true;
  }

  /** remove the C++ compiler's <inputType> — switching back to C must restore
   *  MRS2's native C shape (its own C projects carry input types for
   *  assembler / c.compiler / c.linker only); returns true when removed */
  removeCppCompilerInputType(): boolean {
    const tool = this.toolChain?.childrenNamed('tool').find((t) => t.attr('name') === 'GNU RISC-V Cross C++ Compiler');
    const el = tool
      ?.childrenNamed('inputType')
      .find((e) => (e.attr('superClass') ?? '').endsWith('.tool.cpp.compiler.input'));
    if (!tool || !el) return false;
    tool.removeChild(el);
    return true;
  }

  /** the same option in the other language (c.<x> <-> cpp.<x>), when present */
  private siblingOption(suffix: string): XElement | undefined {
    const lang = suffix.startsWith('cpp.') ? 'cpp' : suffix.startsWith('c.') ? 'c' : '';
    if (!lang) return undefined;
    const rest = suffix.slice(lang.length + 1);
    return this.option((lang === 'c' ? 'cpp' : 'c') + '.' + rest);
  }

  /**
   * Create an option element under the appropriate tool, generating an id that
   * CDT accepts. The metadata MRS2 keys per option — display name, scanner
   * discovery flag, value type, emptiness markers — is copied from the
   * option's SIBLING in the other language when one exists: a converted
   * project's new `cpp.*` option must look exactly like its `c.*` twin (so
   * MRS2's scanner discovery indexes the same include paths / defines). With
   * no sibling the name stays empty, the form real MRS2 files use — a
   * synthesized "Paths"/"Libs" label is not MRS2's.
   */
  private createOption(suffix: string, value: string, valueType?: string): XElement {
    const superClass = OPT_BASE + suffix;
    const donor = this.siblingOption(suffix);
    const tool = this.toolForOption(suffix);
    const opt = new XElement('option');
    opt.setAttr('id', superClass + '.' + optionIdCounter());
    opt.setAttr('name', donor?.attr('name') ?? '');
    opt.setAttr('superClass', superClass);
    opt.setAttr('valueType', valueType ?? donor?.attr('valueType') ?? guessValueType(suffix));
    if (value !== '') {
      opt.setAttr('value', value);
    }
    opt.setAttr('useByScannerDiscovery', donor?.attr('useByScannerDiscovery') ?? 'false');
    for (const marker of ['IS_BUILTIN_EMPTY', 'IS_VALUE_EMPTY']) {
      const v = donor?.attr(marker);
      if (v !== undefined) opt.setAttr(marker, v);
    }
    tool.append(opt);
    const list = this.suffixIndex.get(suffix) ?? [];
    list.push(opt);
    this.suffixIndex.set(suffix, list);
    return opt;
  }

  private toolForOption(suffix: string): XElement {
    const map: Array<[RegExp, string]> = [
      [/^assembler/, 'GNU RISC-V Cross Assembler'],
      [/^c\.compiler/, 'GNU RISC-V Cross C Compiler'],
      [/^cpp\.compiler/, 'GNU RISC-V Cross C++ Compiler'],
      [/^c\.linker/, 'GNU RISC-V Cross C Linker'],
      [/^cpp\.linker/, 'GNU RISC-V Cross C++ Linker'],
      [/^createflash/, 'GNU RISC-V Cross Create Flash Image'],
      [/^createlisting/, 'GNU RISC-V Cross Create Listing'],
      [/^printsize/, 'GNU RISC-V Cross Print Size'],
    ];
    for (const [re, toolName] of map) {
      if (re.test(suffix)) {
        const tool = this.toolChain.childrenNamed('tool').find((t) => t.attr('name') === toolName);
        if (tool) return tool;
      }
    }
    return this.toolChain;
  }

  save(): void {
    fs.writeFileSync(this.file, serializeXml(this.root), 'utf-8');
  }
}

/**
 * Layout-insensitive structural identity of an element subtree: tags in
 * order, attributes sorted by name, decoded text content — inter-tag
 * whitespace (the round-trip metadata `ws`/`emptyPairInSource`) ignored.
 * Stable across save → re-parse even for a mutated tree, which raw
 * serialization is NOT (an appended node's recorded indent differs from
 * the written file's) — this is what the configuration fingerprints hash.
 */
function canonicalShape(el: XElement): string {
  const attrs = Object.keys(el.attrs)
    .sort()
    .map((k) => `${k}="${el.attrs[k]}"`)
    .join(' ');
  let out = `<${el.name}${attrs ? ' ' + attrs : ''}>`;
  if (el.text) out += el.text;
  for (const c of el.children) out += canonicalShape(c);
  return out + `</${el.name}>`;
}

function splitExcluding(entry: XElement): string[] {
  return (entry.attr('excluding') ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Set the excluding attribute; on a previously token-less entry MRS2 writes
 * `excluding` as the FIRST attribute, so preserve that placement.
 */
function setExcludingAttr(entry: XElement, value: string): void {
  if (entry.attr('excluding') === undefined) {
    const old = { ...entry.attrs };
    entry.attrs = {};
    entry.setAttr('excluding', value);
    for (const [k, v] of Object.entries(old)) {
      entry.attrs[k] = v;
    }
  } else {
    entry.setAttr('excluding', value);
  }
}

let optionIdSeq = 0;
function optionIdCounter(): string {
  optionIdSeq++;
  return (Date.now() % 1000000000).toString() + optionIdSeq;
}

function guessValueType(suffix: string): string {
  if (/include\.paths|include\.files|include\.system/.test(suffix)) return 'includePath';
  if (/defs|symbols/.test(suffix)) return 'definedSymbols';
  if (/libs$/.test(suffix)) return 'libs';
  if (/paths$/.test(suffix) && /linker/.test(suffix)) return 'libPaths';
  if (/scriptfile/.test(suffix)) return 'stringList';
  if (/flags$/.test(suffix) && /linker/.test(suffix)) return 'stringList';
  if (/otherobjs/.test(suffix)) return 'userObjs';
  if (
    /^(optimization\.level|c\.compiler\.std|cpp\.compiler\.(std|abiversion)|target\.(isa|abi|codemodel|rvGcc|align)|debugging\.(level|format)|createflash\.choice)/.test(
      suffix
    )
  ) {
    return 'enumerated';
  }
  return 'boolean';
}
