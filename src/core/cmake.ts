/**
 * CMakeLists.txt generator (pure Node) — the MRS2 exportAsCMake /
 * generateCMakeList equivalent, built from the same option model as the
 * makefile generator (flags.ts) so cmake and make compile alike.
 *
 * Produced file shape mirrors MRS2's buildCMakeContent: bilingual usage
 * manual; toolchain set() block (folder/prefix per compiler/objcopy/
 * objdump/size/ar with CMAKE_*_COMPILER_WORKS skips); project declaration,
 * include directories, source list, per-language flags; executable target
 * with link flags and libraries; post-build objcopy (hex/bin), objdump
 * (lst) and size steps.
 *
 * Sources and include dirs are relative POSIX paths. Paths inside a linked
 * folder are written as "<linkName>/<relative-under-link>": the export
 * command copies every link target into a same-named subfolder, so the
 * generated tree builds unchanged on any machine; the in-place generation
 * follows the same convention (MRS2's resolveLinkFoldersFiles layout).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Cproject, foldPathOnPlatform } from './cproject';
import { isSafeLinkName } from './projectFile';
import { ToolchainInfo } from './toolchain';
import { scanSources, assertScannableLinkedFolders } from './scan';
import { isOutsideRelPath } from './macros';
import {
  commonOptions,
  assemblerOptions,
  cCompilerOptions,
  cppCompilerOptions,
  cLinkerOptions,
  cppLinkerOptions,
  userLibs,
  listingOptions,
  objCopyOptions,
  flashExtensions,
} from './flags';

/** one `set(NAME "value")` line, CRLF like MRS2's output */
const setLine = (name: string, value: string | number): string => `set(${name} ${value})\r\n`;

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** locate the linked folder a path lives in (or IS): returns
 * [linkName, path-under-target] with '' meaning the link root itself */
function linkOf(cp: Cproject, p: string): [string, string] | undefined {
  const key = foldPathOnPlatform(path.resolve(p));
  for (const [name, target] of cp.linkedFolders) {
    const root = foldPathOnPlatform(path.resolve(target));
    if (key === root) return [name, ''];
    if (key.startsWith(root + path.sep)) return [name, path.relative(path.resolve(target), path.resolve(p))];
  }
  return undefined;
}

/** manual header — verbatim MRS2 wording (both language blocks) */
function manual(): string {
  const generator = ['cmake', '-B', 'build', '-G'].join(' ');
  const zh = [
    '#############################################################[Chinese Manual]###################################################################',
    '# *****本文件由 MounRiver 自动生成，用于 CMake 构建*****',
    '# 使用前请确认本机已安装 MRS 工具链（下例以 Linux 为例，路径 "/path/to/toolchain/RISC-V Embedded GCC12"，前缀 "riscv-wch-elf-"）',
    '# 第一步: 确认工具链路径，并修改下方 set(TOOLCHAIN_FOLDER "/path/to/toolchain/RISC-V Embedded GCC12")',
    '# 第二步: 确认工具链前缀，并修改下方 set(TOOLCHAIN_PREFIX "riscv-wch-elf-")',
    '# 第三步: cd your/path/of/project',
    '# 第四步: ' + generator + ' "Unix Makefiles"',
    '# 第五步: ' + ['cmake', '--build', 'build'].join(' '),
    '# 提示: Windows 下 a.安装 GNU MAKE 并把 bin 目录加入 PATH，用 ' + generator + ' "Unix Makefiles"（推荐）；b.或安装 MinGW 后用 -G "MinGW Makefiles"',
    '# 如有问题请联系 support@mounriver.com',
    '#################################################################################################################################################',
    '',
    '',
  ];
  const en = [
    '#############################################################[English Manual]###################################################################',
    '# Step 1: Confirm that the MRS toolchain has been installed on the machine. Assuming the current platform is Linux, ',
    '#         the toolchain path is "/path/to/toolchain/RISC-V Embedded GCC12", and the toolchain-related prefix is "riscv-wch-elf-"',
    '# Step 2: Set the toolchain path, for example, modify and replace the following "set (TOOLCHAIN_FOLDER "/path/to/toolchain/RISC-V Embedded GCC12")"',
    '# Step 3: Set the prefix of the executable files in the toolchain,for example, modify and replace the following "set(TOOLCHAIN_PREFIX "riscv-wch-elf-")"',
    '# Step 4: Call "cd your/path/of/project"',
    '# Step 5: Call "' + generator + ' "Unix Makefiles""',
    '# Step 6: Call "cmake --build build"',
    '# Note:   To run on Windows, you need: a. Install GNU MAKE and add its path (the bin directory) to the system environment PATH. ',
    '#         Then call the execution of "' + generator + ' "Unix Makefiles""(Recommanded).',
    '#         or b. Install MinGW and add its path (the bin directory) to the system environment PATH. ',
    '#         Then call the execution of "' + generator + ' "MinGW Makefiles"".',
    '# If you have any questions, please contact us at support@mounriver.com',
    '#################################################################################################################################################',
    '',
    '',
  ];
  return [...zh, ...en].join('\r\n');
}

export interface CmakeBuild {
  /** absolute path of the written CMakeLists.txt */
  file: string;
  sourceCount: number;
  includeCount: number;
  isExecutable: boolean;
}

/**
 * Path identity for the export self-copy guard: Windows folds case (an
 * `EXPORT` spelling and the real `export` directory are the same folder);
 * a symlink/junction alias is caught by the realpath fallback.
 */
export function samePathOnDisk(a: string, b: string): boolean {
  const ra = foldPathOnPlatform(path.resolve(a));
  const rb = foldPathOnPlatform(path.resolve(b));
  if (ra === rb) return true;
  try {
    return foldPathOnPlatform(fs.realpathSync.native(a)) === foldPathOnPlatform(fs.realpathSync.native(b));
  } catch {
    return false;
  }
}

/**
 * The export subfolder derives from the .project display name, and a
 * third-party/hand-edited .project is untrusted input: a name like
 * "../victim" would escape the folder the user picked, and `..` plus
 * reserved characters can make the overwrite path (fs.rmSync) touch an
 * unrelated tree. Returns undefined when the name is not usable as a folder.
 */
export function safeExportDirName(name: string): string | undefined {
  const v = name.trim();
  if (!v || v === '.' || v === '..') return undefined;
  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    if (v.includes(ch)) return undefined;
  }
  for (let i = 0; i < v.length; i++) {
    if (v.charCodeAt(i) < 0x20) return undefined;
  }
  // Windows silently strips a trailing dot/space, so "LED." and "LED" would
  // address the same folder — refuse it rather than export to a surprise name
  if (v.endsWith('.') || v.endsWith(' ')) return undefined;
  return v;
}

export interface CmakeOptions {
  /**
   * false (MRS2 considerPack:false — in-place Generate CMakeLists File):
   * linked files/includes appear as project-root-relative paths that climb
   * out with `..` (they resolve inside the real EVT tree, so the project
   * builds in place). true (considerPack:true — Export As CMake Project):
   * linked files/includes appear as "<linkName>/<relative-under-link>",
   * matching the exported layout where every link target is copied into a
   * same-named subfolder.
   */
  forExport?: boolean;
}

/**
 * Generate CMakeLists.txt at `file` for the project — flags come from the
 * same resolvers the makefile uses, so -I/-D/-T stay consistent.
 */
export function buildCMakeContent(cp: Cproject, tc: ToolchainInfo, file: string, opts: CmakeOptions = {}): CmakeBuild {
  const forExport = opts.forExport === true;
  // round18 P2-1: refuse stale linked folders before scanning (the extension
  // Export As CMake Project parity with the MCP gate)
  assertScannableLinkedFolders(cp);
  // round18 P2-4: a hostile LINK NAME would become an export directory path —
  // copyLinkedFolders skips unsafe names, so generating anyway would produce
  // a CMakeLists pointing outside the export folder. Throw an actionable
  // error instead of emitting a half-broken export. In-place generation does
  // NOT throw: existing EVT trees keep building.
  if (forExport) {
    for (const name of cp.linkedFolders.keys()) {
      if (!isSafeLinkName(name)) {
        throw new Error(
          `linked folder name "${name}" is not safe as an export directory name — rename the link in the project tree before exporting`
        );
      }
    }
  }
  const isExecutable = cp.artifactType !== 'staticLib';
  const prefix = tc.prefix;

  // CMake double-quoted argument escaping, used by EVERY interpolated path
  // below (sources / includes / names / flags): backslash encoded as `\\`
  // (literal preservation — a POSIX filename like a\b.c must not turn into
  // a/b.c; PATH-LIKE values are toPosix-normalized at their own sites
  // before esc), quotes escaped, line breaks flattened, `$` escaped as
  // `\$` (a${X}.c must not collapse via variable expansion), `;` escaped
  // as `\;` (an unescaped semicolon splits the ${SRC_FILES} list into
  // phantom entries — round18 P2-3). Only VALUES are escaped; the
  // template's own ${TARGET_ARTIFACT}/${SRC_FILES} references never pass
  // through here.
  const esc = (s: string): string =>
    s
      .replace(/\\/g, () => '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, ' ')
      .replace(/\$/g, () => '\\$')
      .replace(/;/g, () => '\\;');

  // --- sources: every scanned file, relative to the project root; linked
  // folder files per the in-place/export convention above. Entries go
  // through esc(): POSIX filenames may legally carry quotes/backslashes
  // that would close the quoted CMake argument (round16 P3) ---
  const sources: string[] = [];
  for (const files of scanSources(cp).values()) {
    for (const f of files) {
      const rel = path.relative(cp.projectRoot, f.fullpath);
      if (!isOutsideRelPath(rel)) {
        sources.push('"' + esc(toPosix(rel)) + '"');
        continue;
      }
      const link = linkOf(cp, f.fullpath);
      if (!link) continue; // outside any known link — unrepresentable
      if (forExport) {
        sources.push('"' + esc(toPosix(link[1] ? path.join(link[0], link[1]) : link[0])) + '"');
      } else {
        sources.push('"' + esc(toPosix(rel)) + '"');
      }
    }
  }
  sources.sort((a, b) => a.localeCompare(b));

  // --- includes: same in-place/export convention. -I/-isystem are search
  // paths and become include_directories entries; -include FILES are forced
  // includes, NOT search paths — they must stay in the per-language flags
  // (MRS2 keeps them there too). Assembler includes are harvested as well:
  // they were previously dropped entirely, so a CMake build missed every
  // assembler include path. ---
  const toCmakeInc = (incPath: string): string => {
    const rel = path.relative(cp.projectRoot, incPath);
    if (!isOutsideRelPath(rel)) return toPosix(rel);
    const link = linkOf(cp, incPath);
    if (forExport) return link ? (link[1] ? toPosix(path.join(link[0], link[1])) : link[0]) : toPosix(incPath);
    return toPosix(rel);
  };
  const includes: string[] = [];
  const forced: Record<'c' | 'cpp' | 'asm', string[]> = { c: [], cpp: [], asm: [] };
  const collectIncludes = (opts: string, lang?: 'c' | 'cpp' | 'asm'): void => {
    const re = /-I ?"([^"]+)"|-isystem ?"([^"]+)"|-include ?"([^"]+)"|-I ?(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(opts))) {
      const incPath = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (incPath === undefined) continue;
      if (m[3] !== undefined) {
        // forced include file — stays in the flags of its own language.
        // NO esc() here: the flags block below escapes the whole assembled
        // string, and escaping twice turns a$b.h into a\\$b.h (CMake then
        // resolves a literal backslash and the compiler cannot find the
        // header — round22 follow-up)
        if (lang) forced[lang].push(`-include"${toCmakeInc(incPath)}"`);
        continue;
      }
      includes.push('"' + esc(toCmakeInc(incPath)) + '"');
    }
  };
  collectIncludes(cCompilerOptions(cp), 'c');
  collectIncludes(cppCompilerOptions(cp), 'cpp');
  collectIncludes(assemblerOptions(cp), 'asm');
  const uniqIncludes = [...new Set(includes)];

  let body = '';
  body += manual();

  body += '# Set CMake minimum require\r\ncmake_minimum_required(VERSION 3.16)\r\n\r\n';
  body += '# Set CMake system name\r\nset(CMAKE_SYSTEM_NAME Generic)\r\n\r\n';
  // static-library guard (MRS2 emits it for non-executable artifact types)
  body += setLine('CMAKE_TRY_COMPILE_TARGET_TYPE', 'STATIC_LIBRARY') + '\r\n';

  // toolchain block (MRS2 resolveExecutableExtname: .exe suffix on Windows)
  const exe = process.platform === 'win32' ? '.exe' : '';
  body += '# Use MRS toolchain to compile\r\n';
  // a platform path: normalize separators BEFORE escaping (esc preserves
  // backslashes literally since round18 P3-2)
  body += setLine('TOOLCHAIN_FOLDER', `"${esc(toPosix(tc.dir))}"`);
  body += setLine('TOOLCHAIN_PREFIX', `"${prefix}"`);
  body += setLine('CMAKE_C_COMPILER', `"${'${TOOLCHAIN_FOLDER}/bin/'}${path.basename(tc.compilerC)}${exe}"`);
  body += setLine('CMAKE_CXX_COMPILER', `"${'${TOOLCHAIN_FOLDER}/bin/'}${path.basename(tc.compilerCpp)}${exe}"`);
  body += setLine('CMAKE_ASM_COMPILER', `"${'${TOOLCHAIN_FOLDER}/bin/'}${path.basename(tc.compilerC)}${exe}"`);
  body += setLine('CMAKE_OBJCOPY', `"${'${TOOLCHAIN_FOLDER}/bin/'}${prefix}objcopy${exe}"`);
  body += setLine('CMAKE_OBJDUMP', `"${'${TOOLCHAIN_FOLDER}/bin/'}${prefix}objdump${exe}"`);
  body += setLine('CMAKE_SIZE', `"${'${TOOLCHAIN_FOLDER}/bin/'}${prefix}size${exe}"`);
  body += setLine('CMAKE_AR', `"${'${TOOLCHAIN_FOLDER}/bin/'}${prefix}ar${exe}"`);
  body += '\r\n# Skipping compiler detection and use custom toolchain\r\n';
  body += 'SET(CMAKE_C_COMPILER_WORKS TRUE)\r\n';
  body += 'SET(CMAKE_CXX_COMPILER_WORKS TRUE)\r\n';
  body += 'SET(CMAKE_ASM_COMPILER_WORKS TRUE)\r\n\r\n';

  // names/paths interpolated into double-quoted CMake arguments go through
  // esc() like every flag block below: a quote in a .project display name
  // would otherwise close the string and inject commands (code-review H3)
  body += setLine('PROJECT_NAME', `"${esc(cp.projectName)}"`);
  body += setLine('TARGET_ARTIFACT', `"${esc(cp.targetName)}"`);
  body += '\r\n';
  body += setLine('CMAKE_C_OUTPUT_EXTENSION', '.o');
  body += setLine('CMAKE_CXX_OUTPUT_EXTENSION', '.o');
  body += '\r\n';
  body += 'project("${PROJECT_NAME}" LANGUAGES C ASM CXX)\r\n\r\n';
  body += '\r\n# Use relative path\r\n';
  body += 'add_compile_options(-fmacro-prefix-map=${CMAKE_SOURCE_DIR}=..)\r\n\r\n';

  if (uniqIncludes.length) {
    body += `include_directories(${uniqIncludes.join('\r\n')}\r\n)\r\n\r\n`;
  }
  body += `set(SRC_FILES \r\n${sources.join('\r\n')}\r\n)\r\n\r\n`;

  // flags: common (march/abi/opt/warn/debug) + per-language (skips includes,
  // which went to include_directories) — backslashes/quotes escaped. The
  // harvested forced-include files return here per language.
  const forcedFlags = (arr: string[]): string => (arr.length ? ' ' + arr.join(' ') : '');
  const common = commonOptions(cp, tc.name);
  body += setLine('CMAKE_C_FLAGS', `"${esc(common + ' ' + cCompilerOptions(cp, true) + forcedFlags(forced.c))}"`);
  body += setLine('CMAKE_CXX_FLAGS', `"${esc(common + ' ' + cppCompilerOptions(cp, true) + forcedFlags(forced.cpp))}"`);
  body += setLine('CMAKE_ASM_FLAGS', `"${esc(common + ' ' + assemblerOptions(cp, true) + forcedFlags(forced.asm))}"`);
  body += '\r\n';

  if (isExecutable) {
    body += 'add_executable("${TARGET_ARTIFACT}" ${SRC_FILES})\r\n\r\n';
    const link = cLinkerOptions(cp);
    body += `set_target_properties("\${TARGET_ARTIFACT}" PROPERTIES LINK_FLAGS "${esc(link)}")\r\n\r\n`;

    const libs = userLibs(cp).map((l) => `"${esc(l)}"`);
    body += libs.length
      ? `target_link_libraries(\r\n"\${TARGET_ARTIFACT}" \r\n${libs.join('\r\n')}\r\n)\r\n\r\n`
      : 'target_link_libraries("${TARGET_ARTIFACT}" )\r\n\r\n';

    // post-build: hex/bin (per createflash.choice) + lst (createList) + size
    const post: string[] = [];
    const exts = flashExtensions(cp);
    const objcopyFlags = objCopyOptions(cp);
    for (const ext of exts) {
      const kind = ext === 'bin' ? 'binary' : 'ihex';
      post.push(`COMMAND-PLACEHOLDER-OBJCOPY ARGS -O ${kind}${esc(objcopyFlags)} "$<TARGET_FILE:\${TARGET_ARTIFACT}>" "\${TARGET_ARTIFACT}.${ext}"`);
    }
    if (cp.createListing) {
      post.push(`COMMAND-PLACEHOLDER-OBJDUMP ARGS ${esc(listingOptions(cp))} "$<TARGET_FILE:\${TARGET_ARTIFACT}>" > "\${TARGET_ARTIFACT}.lst"`);
    }
    if (cp.printSize) {
      post.push(`COMMAND-PLACEHOLDER-SIZE ARGS "$<TARGET_FILE:\${TARGET_ARTIFACT}>"`);
    }
    if (post.length) {
      // tool expansions must be quoted: ${CMAKE_OBJCOPY} contains spaces
      const quoted = post.map((c) =>
        c.replace('COMMAND-PLACEHOLDER-OBJCOPY', 'COMMAND "${CMAKE_OBJCOPY}"')
          .replace('COMMAND-PLACEHOLDER-OBJDUMP', 'COMMAND "${CMAKE_OBJDUMP}"')
          .replace('COMMAND-PLACEHOLDER-SIZE', 'COMMAND "${CMAKE_SIZE}"')
      );
      body += `add_custom_command(TARGET "\${TARGET_ARTIFACT}" \r\nPOST_BUILD \r\n${quoted.join('\r\n')}\r\n)\r\n`;
    }
  } else {
    // static library (MRS2 createStaticLib): archive via CMAKE_AR — no link
    // stage, no hex/bin/lst/size post-build (mirrors the makefile
    // generator's ar recipe; without this the lib's sources hit the
    // executable link path and fail on undefined `main`)
    body += 'add_library("${TARGET_ARTIFACT}" ${SRC_FILES})\r\n\r\n';
    for (const lang of ['C', 'CXX', 'ASM']) {
      body += setLine(`CMAKE_${lang}_ARCHIVE_CREATE`, '"<CMAKE_AR> crs <TARGET> <LINK_FLAGS> <OBJECTS>"');
      body += setLine(`CMAKE_${lang}_ARCHIVE_FINISH`, '""');
    }
    body += setLine('CMAKE_STATIC_LIBRARY_PREFIX', '""');
    body += setLine('CMAKE_STATIC_LIBRARY_SUFFIX', '".a"');
  }

  fs.writeFileSync(file, body, 'utf-8');
  return { file, sourceCount: sources.length, includeCount: uniqIncludes.length, isExecutable };
}
