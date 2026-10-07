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
import { Cproject } from './cproject';
import { ToolchainInfo } from './toolchain';
import { scanSources } from './scan';
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
  const key = path.resolve(p).toLowerCase();
  for (const [name, target] of cp.linkedFolders) {
    const root = path.resolve(target).toLowerCase();
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
  const isExecutable = cp.artifactType !== 'staticLib';
  const prefix = tc.prefix;

  // --- sources: every scanned file, relative to the project root; linked
  // folder files per the in-place/export convention above ---
  const sources: string[] = [];
  for (const files of scanSources(cp).values()) {
    for (const f of files) {
      const rel = path.relative(cp.projectRoot, f.fullpath);
      if (!rel.startsWith('..')) {
        sources.push('"' + toPosix(rel) + '"');
        continue;
      }
      const link = linkOf(cp, f.fullpath);
      if (!link) continue; // outside any known link — unrepresentable
      if (forExport) {
        sources.push('"' + toPosix(link[1] ? path.join(link[0], link[1]) : link[0]) + '"');
      } else {
        sources.push('"' + toPosix(rel) + '"');
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
    if (!rel.startsWith('..')) return toPosix(rel);
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
        // forced include file — stays in the flags of its own language
        if (lang) forced[lang].push(`-include"${toCmakeInc(incPath)}"`);
        continue;
      }
      includes.push('"' + toCmakeInc(incPath) + '"');
    }
  };
  collectIncludes(cCompilerOptions(cp), 'c');
  collectIncludes(cppCompilerOptions(cp), 'cpp');
  collectIncludes(assemblerOptions(cp), 'asm');
  const uniqIncludes = [...new Set(includes)];

  const esc = (s: string): string => s.replace(/\\/g, '/').replace(/"/g, '\\"');

  let body = '';
  body += manual();

  body += '# Set CMake minimum require\r\ncmake_minimum_required(VERSION 3.16)\r\n\r\n';
  body += '# Set CMake system name\r\nset(CMAKE_SYSTEM_NAME Generic)\r\n\r\n';
  // static-library guard (MRS2 emits it for non-executable artifact types)
  body += setLine('CMAKE_TRY_COMPILE_TARGET_TYPE', 'STATIC_LIBRARY') + '\r\n';

  // toolchain block (MRS2 resolveExecutableExtname: .exe suffix on Windows)
  const exe = process.platform === 'win32' ? '.exe' : '';
  body += '# Use MRS toolchain to compile\r\n';
  body += setLine('TOOLCHAIN_FOLDER', `"${esc(tc.dir)}"`);
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

  body += setLine('PROJECT_NAME', `"${cp.projectName}"`);
  body += setLine('TARGET_ARTIFACT', `"${cp.targetName}"`);
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

    const libs = userLibs(cp).map((l) => `"${l}"`);
    body += libs.length
      ? `target_link_libraries(\r\n"\${TARGET_ARTIFACT}" \r\n${libs.join('\r\n')}\r\n)\r\n\r\n`
      : 'target_link_libraries("${TARGET_ARTIFACT}" )\r\n\r\n';

    // post-build: hex/bin (per createflash.choice) + lst (createList) + size
    const post: string[] = [];
    const exts = flashExtensions(cp);
    const objcopyFlags = objCopyOptions(cp);
    for (const ext of exts) {
      const kind = ext === 'bin' ? 'binary' : 'ihex';
      post.push(`COMMAND-PLACEHOLDER-OBJCOPY ARGS -O ${kind}${objcopyFlags} "$<TARGET_FILE:\${TARGET_ARTIFACT}>" "\${TARGET_ARTIFACT}.${ext}"`);
    }
    if (cp.createListing) {
      post.push(`COMMAND-PLACEHOLDER-OBJDUMP ARGS ${listingOptions(cp)} "$<TARGET_FILE:\${TARGET_ARTIFACT}>" > "\${TARGET_ARTIFACT}.lst"`);
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
