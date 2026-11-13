/**
 * Minimal i18n for MRVC's runtime UI strings (messages, prompts, tree
 * descriptions). English is the source; `zh` translations follow MRS2's
 * wording where its lang/i18n.js and NLS titles cover the same concept
 * (构建工程/重新加载工程/请选择文件夹/...).
 *
 * package.json titles (commands/menus) are static manifests and stay
 * English — matching MRS2's English titles; only runtime strings switch.
 * Selection: mrvc.language setting ('auto' follows VSCode's UI language,
 * 'en' / 'zh-cn' force one), read once at activation.
 */
let current: 'en' | 'zh-cn' = 'en';

export type Lang = 'en' | 'zh-cn';

/** apply the effective language (called once at activation) */
export function setLanguage(lang: Lang): void {
  current = lang;
}

export function getLanguage(): Lang {
  return current;
}

/** true when VSCode's UI language is Chinese (for mrvc.language=auto) */
export function vscodeLanguageIsChinese(envLanguage: string | undefined): boolean {
  return !!envLanguage && /^zh/i.test(envLanguage);
}

const strings: Record<string, { en: string; 'zh-cn': string }> = {
  // generic
  overwrite: { en: 'Overwrite', 'zh-cn': '覆盖' },
  relPathNoProject: {
    en: 'MRVC: "{0}" is outside the project and not under any linked folder — no project-relative path exists.',
    'zh-cn': 'MRVC：" {0} "在工程之外且不在任何链接文件夹下——不存在工程相对路径。',
  },
  noToolchainFound: {
    en: 'No RISC-V toolchain found. Check the "mrvc.mrs2InstallPath" / "mrvc.mrs3InstallPath" setting — it must point to your MounRiver Studio installation folder.',
    'zh-cn': '未找到 RISC-V 工具链。请检查 "mrvc.mrs2InstallPath" / "mrvc.mrs3InstallPath" 设置——它必须指向您的 MounRiver Studio 安装文件夹。',
  },
  toolchainArchMismatch: {
    en: 'Toolchain "{0}" is built for {1}, but this machine runs {2} — select a native toolchain instead (e.g. GCC12/GCC15 on Apple Silicon with the mac V2.4 package).',
    'zh-cn': '工具链 "{0}" 是 {1} 架构，本机是 {2}——请改用本机原生的工具链（如 Apple Silicon 上使用 mac V2.4 包时选 GCC12/GCC15）。',
  },
  cacheClearNone: {
    en: 'No C/C++ IntelliSense cache directories found — nothing to clear.',
    'zh-cn': '未找到 C/C++ IntelliSense 缓存目录——无需清理。',
  },
  cacheClearAllGuarded: {
    en: 'Cache directories were found, but every one of them was refused by the safety guard (home/workspace collision):\n{0}',
    'zh-cn': '找到了缓存目录，但全部被安全护栏拒绝（与家目录/工作区冲突）：\n{0}',
  },
  cacheClearGuardedNote: {
    en: 'Note: these discovered directories are NOT part of this cleanup — the safety guard refused them:\n{0}',
    'zh-cn': '注意：以下发现的目录被安全护栏拒绝，不在本次清理范围：\n{0}',
  },
  cacheClearConfirm: { en: 'Clear', 'zh-cn': '清除' },
  cacheClearConfirmDetail: {
    en: 'Delete the C/C++ IntelliSense cache? cpptools regenerates it on demand.\n{0}\nTotal: {1} MB\nNote: the browse database (.BROWSE.VC.DB) is not part of this cleanup.',
    'zh-cn': '删除 C/C++ IntelliSense 缓存？cpptools 会在需要时自动重建。\n{0}\n合计：{1} MB\n注意：浏览数据库（.BROWSE.VC.DB）不在本次清理范围。',
  },
  cacheClearProgress: {
    en: 'Clearing the C/C++ IntelliSense cache…',
    'zh-cn': '正在清除 C/C++ IntelliSense 缓存…',
  },
  cacheClearDone: {
    en: 'C/C++ IntelliSense cache cleared — {0} MB freed.',
    'zh-cn': 'C/C++ IntelliSense 缓存已清除——释放 {0} MB。',
  },
  cacheClearPartial: {
    en: 'The cache was partially cleared — these directories could not be removed:\n{0}',
    'zh-cn': '缓存已部分清除——以下目录未能删除：\n{0}',
  },
  wchLinkFwUpdateNeeded: {
    en: 'The connected {0} firmware is {1}, but the MounRiver installation expects {2} — an old link firmware can misbehave during flashing. Upgrade it with WCH-LinkUtility (Firmware → Upgrade).',
    'zh-cn': '已连接的 {0} 固件为 {1}，而 MounRiver 安装期望 {2}——旧固件可能导致烧录异常。请使用 WCH-LinkUtility 升级固件（固件 → 升级）。',
  },
  wchLinkFwOpenUtility: {
    en: 'Open WCH-LinkUtility',
    'zh-cn': '打开 WCH-LinkUtility',
  },
  wchLinkFwContinue: {
    en: 'Flash anyway',
    'zh-cn': '仍要烧录',
  },
  cacheClearMalformedPath: {
    en: 'C_Cpp.intelliSenseCachePath is a {0}, not a string — it has been ignored; this cleanup will only offer the built-in default cache location. Fix the value in your settings to have it cleared too.',
    'zh-cn': 'C_Cpp.intelliSenseCachePath 的值是 {0}，不是字符串——已忽略该配置，本次清理只尝试内置默认缓存路径。修正设置中的值后才会一并清理。',
  },
  invalidCacheSettings: {
    en: 'Invalid MRVC cache settings — skipped: {0}',
    'zh-cn': '无效的 MRVC 缓存设置——已跳过：{0}',
  },
  cacheSettingsUnreadable: {
    en: 'settings.json unreadable in: {0} — left untouched',
    'zh-cn': '以下位置的 settings.json 无法读取：{0}——未做修改',
  },
  cppPropertiesUnreadable: {
    en: 'c_cpp_properties.json unreadable in: {0} — left untouched',
    'zh-cn': '以下位置的 c_cpp_properties.json 无法读取：{0}——未做修改',
  },

  // batch progress titles (notification popups)
  progressBuildAll: { en: 'MRVC: Build All', 'zh-cn': 'MRVC：构建全部工程' },
  progressBuildSolution: { en: 'MRVC: Build Solution - {0}', 'zh-cn': 'MRVC：构建解决方案 - {0}' },
  progressRebuildAll: { en: 'MRVC: Rebuild All', 'zh-cn': 'MRVC：重新构建全部工程' },
  progressDeleteKeep: { en: 'MRVC: Delete Output Files (Keep hex/bin)', 'zh-cn': 'MRVC：删除输出文件（保留 hex/bin）' },
  progressDeleteDirs: { en: 'MRVC: Delete Output Directories', 'zh-cn': 'MRVC：删除输出目录' },
  progressCleanAll: { en: 'MRVC: Clean All', 'zh-cn': 'MRVC：清理全部工程' },
  progressCleanSolution: { en: 'MRVC: Clean Solution - {0}', 'zh-cn': 'MRVC：清理解决方案 - {0}' },
  // one-project progress (project list inline Build / Rebuild / Download)
  progressBuildProject: { en: 'MRVC: Compiling "{0}"', 'zh-cn': 'MRVC：正在编译“{0}”' },
  progressRebuildProject: { en: 'MRVC: Rebuilding "{0}"', 'zh-cn': 'MRVC：正在重新编译“{0}”' },
  progressBuildDownloadProject: {
    en: 'MRVC: Compiling and downloading "{0}"',
    'zh-cn': 'MRVC：正在编译并下载“{0}”',
  },
  progressDownloadProject: { en: 'MRVC: Downloading "{0}"', 'zh-cn': 'MRVC：正在下载“{0}”' },

  // wizard prompts / placeholders
  wizardSeries: { en: 'New MounRiver Project — chip series (1/3)', 'zh-cn': '新建 MounRiver 工程——芯片系列（1/3）' },
  wizardRtos: { en: 'New MounRiver Project — RTOS (2/3)', 'zh-cn': '新建 MounRiver 工程——RTOS（2/3）' },
  wizardChip: { en: 'New MounRiver Project — device template (3/3)', 'zh-cn': '新建 MounRiver 工程——器件模板（3/3）' },
  wizardLocationTitle: { en: 'Parent folder for the new project', 'zh-cn': '新工程的父文件夹' },
  wizardLocationPlaceholder: {
    en: 'Type or paste the full folder path (it will be created), or pick Browse',
    'zh-cn': '键入或粘贴完整的文件夹路径（不存在会自动创建），或选择浏览',
  },
  wizardBrowse: { en: 'Browse for folder…', 'zh-cn': '浏览文件夹…' },
  wizardCreateHere: { en: 'Create here', 'zh-cn': '在此创建' },
  solutionSaveAs: { en: 'Save solution as (in {0})', 'zh-cn': '解决方案另存为（位于 {0}）' },
  solutionFileName: { en: 'solution file name', 'zh-cn': '解决方案文件名' },
  invalidFileName: { en: 'Invalid file name', 'zh-cn': '文件名无效' },
  remove: { en: 'Remove', 'zh-cn': '移除' },
  delete: { en: 'Delete', 'zh-cn': '删除' },

  // projects / store
  noActiveProject: { en: 'No active MRS project.', 'zh-cn': '没有活动 MRS 工程。' },
  pickProject: { en: 'Select project', 'zh-cn': '选择工程' },
  installNotFound: {
    en: 'No MounRiver installation found — point "mrvc.mrs2InstallPath" (MRS2 IDE), "mrvc.mrs3InstallPath" (MRS3 IDE) or "mrvc.toolchainOnlyPath" (standalone toolchain) at your folder.',
    'zh-cn': '未找到 MounRiver 安装——请在 "mrvc.mrs2InstallPath"（MRS2 IDE）、"mrvc.mrs3InstallPath"（MRS3 IDE）或 "mrvc.toolchainOnlyPath"（纯工具链）中指定文件夹。',
  },
  installSwappedFields: {
    en: 'The two install paths look swapped — "mrvc.mrs2InstallPath" points at {0} and "mrvc.mrs3InstallPath" at {1}.',
    'zh-cn': '两个安装路径看起来填反了："mrvc.mrs2InstallPath" 指向 {0}，"mrvc.mrs3InstallPath" 指向 {1}。',
  },
  installSwapValues: { en: 'Swap them', 'zh-cn': '交换两者' },
  installGateNotConfigured: {
    en: 'MRVC did not start: no MounRiver installation path is configured. Set "mrvc.mrs2InstallPath" (MRS2 IDE), "mrvc.mrs3InstallPath" (MRS3 IDE) or "mrvc.toolchainOnlyPath" (standalone toolchain) to a valid folder.',
    'zh-cn':
      'MRVC 未启动：尚未配置 MounRiver 安装路径。请把 "mrvc.mrs2InstallPath"（MRS2 IDE）、"mrvc.mrs3InstallPath"（MRS3 IDE）或 "mrvc.toolchainOnlyPath"（纯工具链）设置为有效的文件夹。',
  },
  installGateNoInstall: {
    en: 'MRVC did not start: no valid MounRiver installation was found. {0} Configure a correct folder in "mrvc.mrs2InstallPath" (MRS2 IDE), "mrvc.mrs3InstallPath" (MRS3 IDE) or "mrvc.toolchainOnlyPath" (standalone toolchain).',
    'zh-cn':
      'MRVC 未启动：没有检测到有效的 MounRiver 安装。{0} 请把 "mrvc.mrs2InstallPath"（MRS2 IDE）、"mrvc.mrs3InstallPath"（MRS3 IDE）或 "mrvc.toolchainOnlyPath"（纯工具链）配置为正确的文件夹。',
  },
  installReasonMissing: { en: 'the folder does not exist', 'zh-cn': '文件夹不存在' },
  installReasonNotInstall: { en: 'not a MounRiver Studio installation', 'zh-cn': '不是 MounRiver 安装目录' },
  installReasonNotToolchain: {
    en: 'not a standalone MRS toolchain root (needs Toolchain/ + OpenOCD/ with a RISC-V gcc)',
    'zh-cn': '不是纯工具链根目录（需要顶层 Toolchain/ 与 OpenOCD/，且能解析出 RISC-V gcc）',
  },
  installReasonWrongGeneration: { en: 'it is a {0} installation', 'zh-cn': '该目录是 {0} 的安装' },
  installReasonNoLauncher: {
    en: 'the launcher program "{0}" is missing there',
    'zh-cn': '该目录缺少启动程序 "{0}"',
  },
  installReasonWrongArch: {
    en: 'its toolchain binaries are built for {0}, but this machine runs {1}',
    'zh-cn': '其工具链二进制是 {0} 架构，本机是 {1}',
  },
  installOpenSettings: { en: 'Open settings', 'zh-cn': '打开设置' },
  installUseDetected: { en: 'Use detected {0}', 'zh-cn': '使用检测到的 {0}' },
  installGateStarted: {
    en: 'Installation paths are valid now — MRVC started.',
    'zh-cn': '安装路径已修正，MRVC 已启动。',
  },
  installFieldIgnored: {
    en: '"{0}" = {1} is unusable ({2}) — ignored, the other installation is used.',
    'zh-cn': '"{0}" = {1} 不可用（{2}），已忽略（改用另一个有效安装）。',
  },
  installPinnedFallbackFrom: {
    en: '"mrvc.mrsVersion" prefers {0}, but no valid {0} installation exists — using {1} instead.',
    'zh-cn': '"mrvc.mrsVersion" 偏好 {0}，但没有有效的 {0} 安装——已改用 {1}。',
  },
  installBothValid: {
    en: 'Two MounRiver installations are present — active: {0}. Pin one with "mrvc.mrsVersion".',
    'zh-cn': '检测到两个 MounRiver 安装，当前生效：{0}。可用 "mrvc.mrsVersion" 固定其一。',
  },
  installPinMRS2: { en: 'Use MRS2', 'zh-cn': '改用 MRS2' },
  installPinMRS3: { en: 'Use MRS3', 'zh-cn': '改用 MRS3' },
  makeNotFound: {
    en: 'make not found — looked for the bundled make under {0} and for a system make on PATH',
    'zh-cn': '未找到 make——已查找 {0} 下的自带 make 与 PATH 中的系统 make',
  },
  makefileGenFailed: { en: 'Makefile generation failed: {0}', 'zh-cn': 'Makefile 生成失败：{0}' },
  neverBuilt: { en: 'MRVC: "{0}" has never been built — nothing to clean.', 'zh-cn': 'MRVC：" {0} " 尚未编译过——没有可清理的内容。' },
  rebuildCleanFailed: { en: 'MRVC: rebuild aborted — clean failed (exit {0}).', 'zh-cn': 'MRVC：重建中止——清理失败（退出码 {0}）。' },
  nothingToClean: { en: 'nothing to clean', 'zh-cn': '无可清理内容' },
  noOutputDir: { en: 'no output directory', 'zh-cn': '无输出目录' },
  outputDirRemoved: { en: 'output directory removed', 'zh-cn': '输出目录已删除' },
  entriesRemoved: { en: '{0} entries removed', 'zh-cn': '已删除 {0} 项' },

  // tree
  noMrsProjectNode: { en: 'No MRS project', 'zh-cn': '无 MRS 工程' },

  // open project / folder

  // solution lifecycle
  cppNatureMigrated: {
    en: 'MRVC: "{0}" used the legacy C++ marker — normalized to the standard CDT nature and mirrored its C options into the C++ set.',
    'zh-cn': 'MRVC："{0}" 使用了旧版 MRVC 的 C++ 标记——已规范化为标准 CDT nature，并把 C 选项镜像进 C++ 选项集。',
  },
  needSolution: { en: 'To add a project, open a solution first!', 'zh-cn': '请先打开解决方案，然后才能添加工程！' },
  solutionRecovered: {
    en: 'The solution was moved or renamed — this window now uses "{0}".',
    'zh-cn': '解决方案已被移动或改名——本窗口已切换为"{0}"。',
  },
  solutionPickOne: {
    en: 'Several solutions are in this folder — pick the one this window uses',
    'zh-cn': '该文件夹下有多个解决方案——请选择本窗口使用的那个',
  },
  solutionPathStale: {
    en: 'The solution this window was opened for no longer exists: {0}',
    'zh-cn': '本窗口原先打开的解决方案已不存在：{0}',
  },
  needSolutionOrder: { en: 'To set the build order, open a solution first!', 'zh-cn': '请先打开解决方案，然后才能设置编译顺序！' },
  alreadyMember: { en: 'MRVC: those projects are already solution members.', 'zh-cn': 'MRVC：这些工程已经是解决方案成员。' },
  addedToSolution: { en: 'MRVC: {0} project(s) added to "{1}".', 'zh-cn': 'MRVC：已将 {0} 个工程添加到" {1} "。' },
  orderNeedTwo: { en: 'MRVC: a build order needs at least two members.', 'zh-cn': 'MRVC：设置编译顺序至少需要两个成员工程。' },
  orderPick: { en: 'Build order — pick #{0} ({1} left; press Escape to finish with the current order)', 'zh-cn': '编译顺序——选择第 {0} 个（剩 {1} 个；按 Esc 以当前顺序结束）' },
  orderUnchanged: { en: 'MRVC: build order unchanged.', 'zh-cn': 'MRVC：编译顺序未变化。' },
  orderRecorded: { en: 'MRVC: build order recorded — {0}', 'zh-cn': 'MRVC：编译顺序已记录——{0}' },
  orderRecordFailed: { en: 'MRVC: recording build order failed — {0}', 'zh-cn': 'MRVC：记录编译顺序失败——{0}' },
  addFailed: { en: 'MRVC: adding to solution failed — {0}', 'zh-cn': 'MRVC：添加到解决方案失败——{0}' },
  openProject: { en: 'Open Project', 'zh-cn': '打开工程' },
  openFolderTitle: { en: 'Open Folder', 'zh-cn': '打开文件夹' },
  searchProjects: { en: 'MRVC: searching projects…', 'zh-cn': 'MRVC：正在搜索工程…' },

  // cmake
  cmakeNoToolchain: { en: 'No RISC-V toolchain found — check "mrvc.mrs2InstallPath" / "mrvc.mrs3InstallPath".', 'zh-cn': '未找到 RISC-V 工具链——请检查 "mrvc.mrs2InstallPath" / "mrvc.mrs3InstallPath"。' },
  cmakeGenerated: { en: 'MRVC: CMakeLists.txt generated ({0} sources, {1} include dirs).', 'zh-cn': 'MRVC：CMakeLists.txt 已生成（{0} 个源文件，{1} 个包含目录）。' },
  cmakeGenFailed: { en: 'MRVC: CMake generation failed — {0}', 'zh-cn': 'MRVC：CMake 生成失败——{0}' },
  cmakeExportTitle: { en: 'Export folder for "{0}" (a subfolder is created)', 'zh-cn': '为" {0} "选择导出位置（将创建子文件夹）' },
  cmakeExportHere: { en: 'Export here', 'zh-cn': '在此导出' },
  cmakeExists: { en: '"{0}" already exists. Overwrite?', 'zh-cn': " {0} 已存在。是否覆盖？" },
  cmakeExported: { en: 'MRVC: exported to {0} — builds with cmake -B build -G "Unix Makefiles".', 'zh-cn': 'MRVC：已导出到 {0}——使用 cmake -B build -G "Unix Makefiles" 构建。' },
  cmakeOpenFolder: { en: 'Open Folder', 'zh-cn': '打开文件夹' },
  cmakeProgress: { en: 'MRVC: exporting {0} as CMake project…', 'zh-cn': 'MRVC：正在将 {0} 导出为 CMake 工程…' },

  // linked folders
  linkedAdded: { en: 'MRVC: linked folder "{0}" added ({1})', 'zh-cn': 'MRVC：链接文件夹" {0} "已添加（{1}）' },
  linkedSelectRemove: { en: 'Select linked folder to remove', 'zh-cn': '选择要移除的链接文件夹' },
  linkedSelectChange: { en: 'Select linked folder to change', 'zh-cn': '选择要修改的链接文件夹' },
  linkedNone: { en: 'This project has no linked folders.', 'zh-cn': '该工程没有链接文件夹。' },
  linkedRemoveConfirm: {
    en: 'Remove linked folder "{0}" from {1}? (files on disk are not deleted)',
    'zh-cn': '从 {1} 移除链接文件夹" {0} "？（不会删除磁盘上的文件）',
  },
  linkedChanged: { en: 'MRVC: linked folder "{0}" re-pointed to {1}', 'zh-cn': 'MRVC：链接文件夹" {0} "已重新指向 {1}' },
  linkedNotFound: { en: 'MRVC: linked folder "{0}" not found in {1}.', 'zh-cn': 'MRVC：在 {1} 中未找到链接文件夹" {0} "。' },
  linkedPrompt: {
    en: 'New location for linked folder "{0}" — the name (and build references to it) stays unchanged',
    'zh-cn': '链接文件夹" {0} "的新位置——名称（及其构建引用）保持不变',
  },
  cannotLinkSelf: { en: 'Cannot link the project folder itself.', 'zh-cn': '不能链接工程文件夹本身。' },
  linkFolderName: { en: 'Folder name as shown (and referenced) inside the project', 'zh-cn': '工程内显示（及引用）的文件夹名称' },
  invalidName: { en: 'Invalid folder name', 'zh-cn': '文件夹名称无效' },
  addExternalLinked: { en: 'Add external linked folder', 'zh-cn': '添加外部链接文件夹' },
  linkFolder: { en: 'Link folder', 'zh-cn': '链接文件夹' },

  // file ops
  nameExists: { en: '"{0}" already exists.', 'zh-cn': '" {0} " 已存在。' },
  enterName: { en: 'Enter a name', 'zh-cn': '请输入名称' },

  // exclude

  // rename project
  syncFolderSpaces: {
    en: 'The folder name contains spaces — rename the folder first (spaces break make targets).',
    'zh-cn': '文件夹名称包含空格——请先重命名文件夹（空格会破坏 make 目标）。',
  },
  syncAlreadySame: { en: 'MRVC: project name already matches the folder name.', 'zh-cn': 'MRVC：工程名已与文件夹名一致。' },

  // flash
  templateTargetStalePrompt: {
    en: "The .template Target Path points at a file that does not exist ({0}), while this project's build artifact exists ({1}). Modify the .template file?",
    'zh-cn': '工程的 .template 中 Target Path 指向的文件不存在（{0}），而本工程的构建产物存在（{1}）。是否修改 .template 文件？',
  },
  templateTargetFix: { en: 'Modify', 'zh-cn': '修改' },
  templateTargetKeep: { en: 'Keep as is', 'zh-cn': '不修改' },
  templateTargetHealed: {
    en: 'MRVC: the .template was updated successfully ({0} → {1}). You can click Download again.',
    'zh-cn': 'MRVC：.template 已修改成功（{0} → {1}）。请重新点击下载。',
  },
  projectNotBuilt: {
    en: 'No firmware found — the project has not been built yet (expected {0}). Build the project first, then download.',
    'zh-cn': '未找到固件——当前工程尚未编译（应生成 {0}）。请先编译工程，再点击下载。',
  },
  chipMismatchPrompt: {
    en: 'The chip on the WCH-Link ({0}) does not match the project target chip ({1}). MRS refuses such a download; flashing another chip family may result in a board that does not run. Download anyway?',
    'zh-cn': 'WCH-Link 连接的芯片（{0}）与工程的目标芯片（{1}）不一致。MRS 会拒绝此类下载；烧写不匹配的芯片可能导致程序无法运行。是否仍要下载？',
  },
  chipMismatchContinue: { en: 'Download anyway', 'zh-cn': '仍然下载' },
  chipMismatchCancel: { en: 'Cancel download', 'zh-cn': '取消下载' },
  openocdNotFound: { en: 'openocd.exe not found: {0}', 'zh-cn': '未找到 openocd.exe：{0}' },
  openocdCfgNotFound: { en: 'OpenOCD config not found: {0}', 'zh-cn': '未找到 OpenOCD 配置：{0}' },
  linkUtilityNotFound: { en: 'WCH-LinkUtility.exe not found under the MounRiver installation.', 'zh-cn': '在 MounRiver 安装目录下未找到 WCH-LinkUtility.exe。' },

  // open with MRS
  openWithMrsNoIde: {
    en: 'The effective configuration is a standalone toolchain (no IDE to open): {0}',
    'zh-cn': '当前生效配置为纯工具链（无 IDE 可打开）：{0}',
  },
  openWithMrsNotFound: {
    en: 'MRS IDE launcher not found under: {0}',
    'zh-cn': '未找到 MRS IDE 启动器：{0}',
  },
  openWithMrsNoWvproj: {
    en: 'No .wvproj project file found in: {0}',
    'zh-cn': '该目录下未找到 .wvproj 工程文件：{0}',
  },
  openWithMrsFailed: { en: 'MRVC: failed to launch the MRS IDE ({0}).', 'zh-cn': 'MRVC：启动 MRS IDE 失败（{0}）。' },

  // info view
  infoNone: { en: '—', 'zh-cn': '—' },
  infoNoConfig: { en: 'No effective MRS configuration', 'zh-cn': '无生效 MRS 配置' },
  infoKindToolchain: { en: 'Standalone toolchain', 'zh-cn': '纯工具链' },
  infoPinFallback: { en: ' preference fell back', 'zh-cn': '（偏好未满足，已回退）' },
  infoOpenSettings: { en: 'Open MRVC Settings', 'zh-cn': '打开 MRVC 设置' },
  infoProjectCat: { en: 'Active project', 'zh-cn': '当前工程' },
  infoToolchainCat: { en: 'Toolchain', 'zh-cn': '工具链' },
  infoSdiCat: { en: 'SDI Printf', 'zh-cn': 'SDI Printf' },
  infoSdiEnabled: {
    en: 'SDI print enabled',
    'zh-cn': 'SDI print 已使能',
  },
  infoSdiFailed: { en: 'Last enable attempt failed', 'zh-cn': '上次使能失败' },
  infoSdiUnknown: {
    en: 'Unknown — WCH-Link cannot be read back',
    'zh-cn': '未知——WCH-Link 不支持回读',
  },
  infoSdiNotRequested: {
    en: 'SDI print not enabled by this download',
    'zh-cn': '本次下载未使能 SDI print',
  },
  infoSdiTooltip: {
    en:
      'WCH-Link/CommunicationLib offers only the SDI set command (McuCompiler_SetSDIPrn), no getter. ' +
      'This row reflects only MRVC\'s own write in this session; it returns to Unknown after a window reload, or when the monitor starts and finds no WCH-Link port. ' +
      'Click to open the SDI PRINT monitor.',
    'zh-cn':
      'WCH-Link/CommunicationLib 只提供 SDI 写命令（McuCompiler_SetSDIPrn），没有读取接口。' +
      '此处只反映 MRVC 本次会话自己的写入；重载窗口后回到未知，打开监视器时若找不到 WCH-Link 串口也会重置为未知。点击打开 SDI PRINT 监视器。',
  },
  infoSdiTooltipNotRequested: {
    en:
      'This download did not request SDI Printf (the .template checkbox is off), so MRVC did not touch the link switch. ' +
      'The switch is sticky — the DLL never disables it on a plain download, so a Link enabled earlier may still be enabled. ' +
      'Only a link power-cycle or an external tool (WCH-LinkUtility) clears it.',
    'zh-cn':
      '本次下载未勾选 SDI Printf，MRVC 没有动 WCH-Link 的开关。' +
      '该开关是粘滞的——DLL 在普通下载时不会关闭它，所以之前使能过的 Link 可能仍处于使能状态；' +
      '只有 Link 重新上电或使用 WCH-LinkUtility 等外部工具才会清除。',
  },
  infoSdiOpenMonitor: { en: 'Open SDI PRINT Monitor', 'zh-cn': '打开 SDI PRINT 监视器' },

  // SDI PRINT monitor
  sdiNoPort: {
    en: 'No WCH-Link serial port found. Connect the WCH-Link (its port is "WCH-Link SERIAL (COMx)") — a board-level CH343/CH340 USB-serial port is not the link.',
    'zh-cn': '未找到 WCH-Link 串口。请连接 WCH-Link（其串口显示为 "WCH-Link SERIAL (COMx)"）——板载 CH343/CH340 等 USB 串口不是 WCH-Link。',
  },
  sdiPickTitle: { en: 'Select the WCH-Link serial port', 'zh-cn': '选择 WCH-Link 串口' },
  sdiStopNone: { en: 'MRVC: the SDI PRINT monitor is not running.', 'zh-cn': 'MRVC：SDI PRINT 监视器未在运行。' },
  sdiOpenError: { en: 'serial port error: {0}', 'zh-cn': '串口错误：{0}' },
  sdiListError: { en: 'failed to list serial ports: {0}', 'zh-cn': '枚举串口失败：{0}' },
  sdiSerialMissing: {
    en: 'MRVC: the serialport module is missing from this installation.',
    'zh-cn': 'MRVC：本安装缺少 serialport 模块。',
  },
  sdiConnected: { en: 'connected — waiting for SDI printf output', 'zh-cn': '已连接——等待 SDI printf 输出' },
  sdiClosed: { en: 'serial port closed', 'zh-cn': '串口已关闭' },
  sdiPortBusyHint: {
    en: 'if another serial tool (or a previous monitor) holds this port, close it and start the monitor again.',
    'zh-cn': '若有其他串口工具（或上一个监视器）正占用该端口，请先关闭后再启动监视器。',
  },

  // build output
  noBuildRecord: {
    en: 'MRVC: no build output recorded for "{0}" yet — build the project first.',
    'zh-cn': 'MRVC：" {0} " 还没有构建输出记录——请先编译该工程。',
  },

  // intellisense
  intellisenseOk: { en: 'MRVC: IntelliSense configuration updated ({0} files from {1} projects).', 'zh-cn': 'MRVC：IntelliSense 配置已更新（来自 {1} 个工程的 {0} 个文件）。' },
  intellisenseFail: { en: 'MRVC: IntelliSense configuration failed — {0}', 'zh-cn': 'MRVC：IntelliSense 配置失败——{0}' },
  cpptoolsMissing: {
    en: 'MRVC: code navigation (Go to Definition) needs the "C/C++" extension (ms-vscode.cpptools) — install it from the Extensions view.',
    'zh-cn': 'MRVC：代码跳转需要 "C/C++" 扩展（ms-vscode.cpptools）——请在扩展面板安装。',
  },
  cpptoolsTooOld: {
    en: 'MRVC: the "C/C++" extension (ms-vscode.cpptools) is version {0} — code navigation needs 1.23.5 or later. Please update it.',
    'zh-cn': 'MRVC："C/C++" 扩展（ms-vscode.cpptools）当前版本 {0}——代码跳转需要 1.23.5 或更高版本，请更新。',
  },
  installCpptools: { en: 'Open "C/C++"', 'zh-cn': '打开 "C/C++"' },
  cpptoolsDontAsk: { en: "Don't ask again", 'zh-cn': '不再提示' },
  cpptoolsOpenFailed: {
    en: 'MRVC: could not open the extension page — install "ms-vscode.cpptools" (win-x64 VSIX) manually from the Extensions view.',
    'zh-cn': 'MRVC：无法打开扩展页面——请在扩展面板手动安装 "ms-vscode.cpptools"（win-x64 VSIX）。',
  },
  guidanceReset: { en: 'MRVC: install guidance prompt re-enabled.', 'zh-cn': 'MRVC：安装引导提示已重新启用。' },
  // build / batch
  solutionNoMembers: { en: 'MRVC: solution "{0}" has no loadable projects.', 'zh-cn': 'MRVC：解决方案" {0} "没有可加载的工程。' },
  batchRunning: { en: 'MRVC: another batch operation is already running.', 'zh-cn': 'MRVC：已有批量操作在执行中。' },
  batchCancelled: { en: 'MRVC: {0} cancelled — {1}/{2} OK, {3} failed.', 'zh-cn': 'MRVC：{0} 已取消——{1}/{2} 成功，{3} 失败。' },
  batchFinishedFailed: {
    en: 'MRVC: {0} finished — {1}/{2} OK, {3} failed ({4}). See Problems panel and "MRVC Build All" output.',
    'zh-cn': 'MRVC：{0} 已完成——{1}/{2} 成功，{3} 失败（{4}）。请查看问题面板和"MRVC Build All"输出。',
  },
  batchFinishedAll: { en: 'MRVC: {0} finished — all {1} projects OK ({2}s).', 'zh-cn': 'MRVC：{0} 已完成——全部 {1} 个工程成功（{2} 秒）。' },
  noProjectsLoaded: {
    en: 'No MRS project loaded. Use "MRVC: Open MRS Project" first.',
    'zh-cn': '尚未加载任何 MRS 工程。请先使用"MRVC: Open MRS Project"。',
  },
  flashAddressInvalid: {
    en: 'MRVC: download aborted for "{0}" — {1}',
    'zh-cn': 'MRVC：" {0} " 的下载已中止——{1}',
  },
  buildAlreadyRunning: {
    en: 'MRVC: "{0}" is already building — wait for it to finish or terminate the running task.',
    'zh-cn': 'MRVC：" {0} " 正在编译中——请等待完成，或结束正在运行的任务。',
  },
  buildBusySkip: {
    en: 'skipped — the project is building right now',
    'zh-cn': '已跳过——该工程正在编译中',
  },
  terminateBuild: { en: 'Terminate Build', 'zh-cn': '结束编译' },
  buildCancelled: {
    en: 'MRVC: build of "{0}" was cancelled.',
    'zh-cn': 'MRVC：已取消编译“{0}”。',
  },
  downloadCancelled: {
    en: 'MRVC: download of "{0}" was cancelled.',
    'zh-cn': 'MRVC：已取消下载“{0}”。',
  },
  downloadThrew: {
    en: 'MRVC: download did not run for "{0}" — {1}',
    'zh-cn': 'MRVC：" {0} " 的下载未执行——{1}',
  },
  downloadFailed: {
    en: 'MRVC: download failed for "{0}" (exit code {1}) — see the task output.',
    'zh-cn': 'MRVC：" {0} "下载失败（退出码 {1}）——请查看任务输出。',
  },

  // power-off reset (掉电复位) + transient link-open retry
  powerStageOff: {
    en: 'power-off',
    'zh-cn': '断电',
  },
  powerStageOn: {
    en: 'power-on',
    'zh-cn': '上电',
  },
  powerResetDone: {
    en: 'MRVC: power-off reset completed ({0}).',
    'zh-cn': 'MRVC：掉电复位完成（{0}）。',
  },
  powerResetFailed: {
    en: 'MRVC: power-off reset failed — the {0} pass exited with {1}.',
    'zh-cn': 'MRVC：掉电复位失败——{0} 阶段退出码 {1}。',
  },
  powerRetry: {
    en: 'MRVC: WCH-Link re-enumerating — retrying ({0}/{1})…',
    'zh-cn': 'MRVC：WCH-Link 重新枚举中，正在重试（{0}/{1}）…',
  },
  powerLinkUnsupported: {
    en: 'MRVC: {0} has no power-output control — the power-off reset needs WCH-LinkE / WCH-DAPLink / WCH-LinkW (per WCH\'s manuals the plain WCH-Link cannot switch its target rail).',
    'zh-cn': 'MRVC：{0} 不支持电源输出控制——掉电复位需要 WCH-LinkE / WCH-DAPLink / WCH-LinkW（官方手册：普通版 WCH-Link 无法开关目标供电）。',
  },
  sdiPrintfPassFailed: {
    en: 'MRVC: download of "{0}" succeeded, but the SDI Printf reset pass failed ({1}) — the monitor may stay empty.',
    'zh-cn': 'MRVC：" {0} " 下载成功，但 SDI Printf 复位使能失败（{1}）——监视器可能没有输出。',
  },
  sdiPrintfNoChipId: {
    en: 'MRVC: download of "{0}" succeeded, but the chip id is unknown — skipped the SDI Printf reset pass.',
    'zh-cn': 'MRVC：" {0} " 下载成功，但无法确定芯片 ID——已跳过 SDI Printf 复位使能。',
  },

  // project-configuration audit & repair
  auditClean: {
    en: 'MRVC: project configuration of "{0}" looks healthy — no issues found.',
    'zh-cn': 'MRVC：" {0} " 的工程配置检查通过，未发现问题。',
  },
  auditFound: {
    en: 'MRVC: {1} configuration issue(s) found in "{0}".',
    'zh-cn': 'MRVC：" {0} " 发现 {1} 项配置问题。',
  },
  auditRepairBtn: {
    en: 'Repair {0} item(s)',
    'zh-cn': '修复 {0} 项',
  },
  auditRepaired: {
    en: 'MRVC: repaired {0}. Pre-repair backups: {1}',
    'zh-cn': 'MRVC：已修复 {0}。修复前备份：{1}',
  },
  auditNotFixable: {
    en: '(report only — no automatic fix)',
    'zh-cn': '（仅报告，不自动修复）',
  },
  'auditF_enum-value-missing': {
    en: 'Enumerated option "{0}" has no value attribute — MRS\'s reader crashes on it (project unopenable). Fix: remove the option (inherits the default).',
    'zh-cn': 'enumerated 选项 " {0} " 缺少 value 属性——MRS 解析会崩溃（工程打不开）。修复：移除该选项（继承默认值）。',
  },
  'auditF_rvgcc-form': {
    en: 'rvGcc option value is in an unknown form: {0}',
    'zh-cn': 'rvGcc 选项的 value 形态无法识别：{0}',
  },
  'auditF_project-xml': {
    en: 'XML not parseable: {0}',
    'zh-cn': 'XML 无法解析：{0}',
  },
  'auditF_project-name': {
    en: '.project name "{0}" differs from the folder name.',
    'zh-cn': '.project 的 name " {0} " 与文件夹名不一致。',
  },
  'auditF_template-address': {
    en: '.template Address "{0}" is not 0x-formatted. Fix: clear it (download falls back to inference).',
    'zh-cn': '.template 的 Address " {0} " 不是 0x 格式。修复：清空（下载回退为自动推断）。',
  },
  buildFailedNoDownload: {
    en: 'MRVC: build failed for "{0}" (exit code {1}) — download skipped.',
    'zh-cn': 'MRVC：" {0} " 编译失败（退出码 {1}）——已跳过下载。',
  },

  // remove / restore (filteredResources)
  removedHidden: {
    en: 'MRVC: "{0}" removed from the project (restorable via Restore Removed Resources).',
    'zh-cn': 'MRVC：" {0} " 已从工程中移除（可通过"恢复已移除的资源"找回）。',
  },
  nothingRemoved: { en: 'MRVC: "{0}" has no removed resources.', 'zh-cn': 'MRVC：" {0} " 没有已移除的资源。' },
  restorePick: { en: 'Select removed resources of "{0}" to restore (multi-select)', 'zh-cn': '选择要恢复的" {0} "已移除资源（可多选）' },
  restoredCount: { en: 'MRVC: {0} resource(s) restored.', 'zh-cn': 'MRVC：已恢复 {0} 个资源。' },
  renameKeyRestore: { en: 'Rename "{0}"', 'zh-cn': '重命名" {0} "' },

  // file ops
  copied: { en: 'MRVC: copied "{0}" (use Paste on a folder)', 'zh-cn': 'MRVC：已复制" {0} "（在文件夹上使用粘贴）' },
  pasted: { en: 'MRVC: pasted {0}', 'zh-cn': 'MRVC：已粘贴 {0}' },
  pasteFailed: { en: 'MRVC: paste failed — {0}', 'zh-cn': 'MRVC：粘贴失败——{0}' },
  newFileIn: { en: 'New file in {0}', 'zh-cn': '在 {0} 中新建文件' },
  newFolderIn: { en: 'New folder in {0}', 'zh-cn': '在 {0} 中新建文件夹' },
  fileNameHint: { en: 'file name (e.g. main.c)', 'zh-cn': '文件名（如 main.c）' },
  folderName: { en: 'folder name', 'zh-cn': '文件夹名称' },
  invalidNameKey: { en: 'Invalid name', 'zh-cn': '名称无效' },
  deletedMsg: { en: 'MRVC: deleted {0}', 'zh-cn': 'MRVC：已删除 {0}' },
  newProjectName: { en: 'new project name', 'zh-cn': '新工程名称' },
  invalidProjectName: {
    en: "Invalid project name (no spaces or \\ / : * ? \" < > |)",
    'zh-cn': "工程名称无效（不能含空格或 \\ / : * ? \" < > |）",
  },

  // analysis reports
  analysisNoBuildDir: {
    en: 'MRVC: no build directory yet — build with "mrvc.build.analysis" enabled first.',
    'zh-cn': 'MRVC：尚无构建目录——请先开启 "mrvc.build.analysis" 构建一次。',
  },
  analysisNoSu: {
    en: 'MRVC: no .su files found — enable "mrvc.build.analysis" and rebuild.',
    'zh-cn': 'MRVC：未发现 .su 文件——请开启 "mrvc.build.analysis" 并重新构建。',
  },
  analysisNoRecords: { en: 'MRVC: .su files found but no usable records.', 'zh-cn': 'MRVC：已找到 .su 文件，但没有可用记录。' },
  analysisNoDumps: {
    en: 'MRVC: no expand dumps found — enable "mrvc.build.analysis" and rebuild.',
    'zh-cn': 'MRVC：未发现调用图转储文件——请开启 "mrvc.build.analysis" 并重新构建。',
  },
  analysisNoCalls: { en: 'MRVC: expand dumps found but no call edges extracted.', 'zh-cn': 'MRVC：已找到调用图转储文件，但未能提取调用关系。' },

  // MRS Tools launchers
  mrsToolsNoInstallStart: {
    en: 'MRVC: cannot start {0} — MounRiver installation not found (set mrvc.mrs2InstallPath or mrvc.mrs3InstallPath).',
    'zh-cn': 'MRVC：无法启动 {0}——未找到 MounRiver 安装（请设置 mrvc.mrs2InstallPath 或 mrvc.mrs3InstallPath）。',
  },
  mrsToolsNotFound: {
    en: 'MRVC: {0} not found under the MounRiver installation ({1}).',
    'zh-cn': 'MRVC：在 MounRiver 安装目录下未找到 {0}（{1}）。',
  },
  mrsToolsStartFailed: { en: 'MRVC: failed to start {0} — {1}', 'zh-cn': 'MRVC：启动 {0} 失败——{1}' },

  // new project wizard
  newProjectScanning: { en: 'MRVC: scanning project templates…', 'zh-cn': 'MRVC：正在扫描工程模板…' },
  newProjectNamePrompt: {
    en: 'Project name (folder created inside the chosen location) — template: {0}',
    'zh-cn': '工程名称（将在所选位置创建文件夹）——模板：{0}',
  },
  newProjectCreated: {
    en: 'MRVC: project "{0}" created at "{1}" from {2} ({3} / {4}).',
    'zh-cn': 'MRVC：已从 {2}（{3} / {4}）在" {1} "创建工程" {0} "。',
  },
  openInNewWindow: { en: 'Open in New Window', 'zh-cn': '在新窗口打开' },
  // store / solution misc
  noProjectInFolder: {
    en: 'No .project found in the selected folder (not an MRS project?).',
    'zh-cn': '所选文件夹中没有 .project（不是 MRS 工程？）。',
  },
  wsFileWriteFailed: { en: 'MRVC: cannot write workspace file — {0}', 'zh-cn': 'MRVC：无法写入工作区文件——{0}' },
  openProjectFailed: { en: 'Failed to open MRS project: {0}', 'zh-cn': '打开 MRS 工程失败：{0}' },
  cprojectMissingSkipped: {
    en: '{0} is not a valid MRS project — missing {1}; skipped. A project opens through its 工程名.wvproj marker, and the companion files .project and .cproject must all be present.',
    'zh-cn': '{0} 不是合法的 MRS 工程——缺少 {1}，已跳过。工程以「工程名.wvproj」打开，附属文件 .project 与 .cproject 必须全部存在。',
  },
  openFolderFirst: {
    en: 'MRVC: open a workspace folder first — the solution is saved in it.',
    'zh-cn': 'MRVC：请先打开一个工作区文件夹——解决方案将保存在其中。',
  },
  solutionWriteFailed: { en: 'MRVC: writing solution failed — {0}', 'zh-cn': 'MRVC：写入解决方案失败——{0}' },
  solutionCreated: {
    en: 'MRVC: solution "{0}" created with {1} projects.',
    'zh-cn': 'MRVC：解决方案" {0} "已创建，共 {1} 个工程。',
  },
  switchTypeFailed: { en: 'MRVC: switching project type failed — {0}', 'zh-cn': 'MRVC：切换工程类型失败——{0}' },
  languageReload: {
    en: 'MRVC: the UI language setting changed — reload the window to apply it.',
    'zh-cn': 'MRVC：界面语言设置已更改——请重载窗口以生效。',
  },
  reloadWindow: { en: 'Reload Window', 'zh-cn': '重载窗口' },

  // properties / download settings pages
  downloadSettingsSaved: { en: 'MRVC: download settings saved ({0})', 'zh-cn': 'MRVC：下载设置已保存（{0}）' },
  downloadSettingsSaveFailed: { en: 'MRVC: failed to save download settings ({0})', 'zh-cn': 'MRVC：保存下载设置失败（{0}）' },
  macroConflictTitle: { en: 'Macro definition conflict ({0}):', 'zh-cn': '宏定义冲突（{0} 个）：' },
  macroConflictApply: { en: 'Apply anyway', 'zh-cn': '仍然保存' },
  macroConflictBack: { en: 'Go back', 'zh-cn': '返回修改' },
  propertiesSaved: { en: 'MRVC: project properties saved ({0})', 'zh-cn': 'MRVC：工程属性已保存（{0}）' },
  propertiesSaveFailed: { en: 'MRVC: failed to save configuration ({0})', 'zh-cn': 'MRVC：保存配置失败（{0}）' },
  propertiesXmlInvalid: {
    en: 'MRVC: the .cproject XML is damaged ({0}) — nothing was written. Run "Audit And Repair Project Configuration" first.',
    'zh-cn': 'MRVC：.cproject XML 结构已损坏（{0}），未写入任何内容。请先运行「检测并修复工程配置」。',
  },

  // linked folders
  linkedCpUpdateFailed: {
    en: 'MRVC: linked folder added to .project, but .cproject update failed: {0}',
    'zh-cn': 'MRVC：链接文件夹已写入 .project，但 .cproject 更新失败：{0}',
  },
  linkedRemoved: { en: 'MRVC: linked folder "{0}" removed', 'zh-cn': 'MRVC：链接文件夹" {0} "已移除' },

  // file ops leftovers
  clipboardEmpty: {
    en: 'MRVC: clipboard is empty — use "Copy" on a file or folder first.',
    'zh-cn': 'MRVC：剪贴板为空——请先对文件或文件夹使用"复制"。',
  },
  pasteIntoSelf: { en: 'MRVC: cannot paste a folder into itself.', 'zh-cn': 'MRVC：无法将文件夹粘贴到其自身内部。' },
  nodeNotInProject: { en: 'MRVC: node is not attached to a project.', 'zh-cn': 'MRVC：该节点未挂接到任何工程。' },
  removeOrDeletePrompt: { en: 'Remove or delete "{0}"?', 'zh-cn': '移除还是删除" {0} "？' },
  removeOrDeleteDirDetail: {
    en: 'Remove hides it from the project (files stay on disk, restorable). Delete removes the files from disk.',
    'zh-cn': '移除会将其从工程中隐藏（文件保留在磁盘上，可恢复）；删除会从磁盘上移除这些文件。',
  },
  removeOrDeleteFileDetail: {
    en: 'Remove hides it from the project (the file stays on disk, restorable). Delete removes the file from disk.',
    'zh-cn': '移除会将其从工程中隐藏（文件保留在磁盘上，可恢复）；删除会从磁盘上移除该文件。',
  },
  removeOrDeleteOutsideHint: {
    en: 'Note: this item lives OUTSIDE the project folder (linked-folder target) — Delete removes the real files on disk.',
    'zh-cn': '注意：该项位于工程文件夹之外（链接文件夹目标）——删除将真实移除磁盘上的文件。',
  },
  overwriteConfirm: { en: '"{0}" already exists. Overwrite?', 'zh-cn': '" {0} "已存在。是否覆盖？' },

  // rename project
  renameProjectTitle: { en: 'Rename project "{0}"', 'zh-cn': '重命名工程" {0} "' },
  renameFailed: { en: 'MRVC: rename failed — {0}', 'zh-cn': 'MRVC：重命名失败——{0}' },
  projectRenamed: { en: 'MRVC: project "{0}" renamed to "{1}".', 'zh-cn': 'MRVC：工程" {0} "已重命名为" {1} "。' },
  folderNameInvalid: { en: 'MRVC: the folder name "{0}" contains characters not allowed in a project name.', 'zh-cn': 'MRVC：文件夹名称" {0} "包含工程名不允许的字符。' },
  syncFailed: { en: 'MRVC: sync failed — {0}', 'zh-cn': 'MRVC：同步失败——{0}' },
  syncDone: { en: 'MRVC: project name synced to folder name ("{0}").', 'zh-cn': 'MRVC：工程名已同步为文件夹名（" {0} "）。' },

  // exclude / include
  excludeApplies: {
    en: 'MRVC: Exclude From Build applies to source files and folders in a project.',
    'zh-cn': 'MRVC：Exclude From Build 仅适用于工程内的源文件和文件夹。',
  },
  includeApplies: {
    en: 'MRVC: Include From Build applies to excluded files and folders.',
    'zh-cn': 'MRVC：Include From Build 仅适用于已排除的文件和文件夹。',
  },
  alreadyExcluded: { en: 'MRVC: "{0}" is already excluded from build.', 'zh-cn': 'MRVC：" {0} " 已从编译中排除。' },
  excludeFailed: { en: 'MRVC: exclude failed — {0}', 'zh-cn': 'MRVC：排除失败——{0}' },
  notExcluded: { en: 'MRVC: "{0}" is not excluded from build.', 'zh-cn': 'MRVC：" {0} " 不在编译排除清单中。' },
  includeFailed: { en: 'MRVC: include failed — {0}', 'zh-cn': 'MRVC：恢复编译失败——{0}' },

  // sync page
  syncingSettings: { en: 'MRVC: syncing {0} setting(s)', 'zh-cn': 'MRVC：正在同步 {0} 项设置' },

  // macro batch page
  macroBatchHint: {
    en: '{0} project(s) loaded — type the macros to set below; the stats show what every project currently defines',
    'zh-cn': '已加载 {0} 个工程——在下方输入要设置的宏；统计信息展示各工程当前的宏定义情况',
  },
  macroBatchRules: {
    en: 'One macro per line (NAME=VALUE or bare NAME). Only macros WRITTEN here are touched: same-name entries are updated in place, everything a project already has that is not listed stays untouched — nothing is deleted.',
    'zh-cn': '每行一条宏（NAME=VALUE 或裸 NAME）。只会修改此处写出的宏：同名宏原位更新，工程中已有但此处未列出的宏保持原样——不会删除任何宏。',
  },
  macroBatchStats: {
    en: '{0} macro name(s), {1} with differing values across projects',
    'zh-cn': '{0} 个宏名，{1} 个跨工程取值不一致',
  },
  macroBatchCppOnly: { en: '(C++ projects only)', 'zh-cn': '（仅 C++ 工程）' },
  macroBatchAddMissing: {
    en: 'Add these macros to projects that do not define them yet',
    'zh-cn': '为尚未定义这些宏的工程新增',
  },
  macroBatchSkipReview: {
    en: 'Skip the per-project review and apply directly',
    'zh-cn': '跳过逐工程确认，直接应用',
  },
  macroBatchNothingSelected: {
    en: 'Nothing selected — tick the checkbox of the panes to apply.',
    'zh-cn': '未选择任何栏——请勾选要应用的编译器栏。',
  },
  macroBatchApply: { en: 'Apply to Selected Projects', 'zh-cn': '应用到勾选的工程' },
  macroBatchProgress: { en: 'MRVC: applying macros to {0} project(s)', 'zh-cn': 'MRVC：正在将宏应用到 {0} 个工程' },
  macroBatchSummaryHead: { en: 'Macro definitions by project', 'zh-cn': '按工程的宏定义汇总' },
  macroBatchEditorHead: { en: 'Target macros', 'zh-cn': '目标宏定义' },
  macroBatchDivLegend: {
    en: 'highlighted rows differ in value across projects',
    'zh-cn': '高亮行 = 该宏跨工程取值不一致',
  },
  macroBatchFilterMacro: { en: 'Filter by macro name…', 'zh-cn': '按宏名过滤…' },
  macroBatchNoMacros: { en: '(no macros defined)', 'zh-cn': '（无宏定义）' },
  macroBatchCount: { en: '{0} macro(s)', 'zh-cn': '{0} 条宏' },
  macroBatchTargets: { en: 'Target projects', 'zh-cn': '目标工程' },
  macroBatchSelectAll: { en: 'Select all', 'zh-cn': '全选' },
  macroBatchSelectNone: { en: 'Select none', 'zh-cn': '全不选' },
  macroBatchFilterProject: { en: 'Filter projects…', 'zh-cn': '过滤工程…' },
  macroBatchNoTargets: {
    en: 'No target project selected — tick at least one project.',
    'zh-cn': '未选择目标工程——请至少勾选一个工程。',
  },
  macroBatchUndo: { en: 'Undo last apply', 'zh-cn': '撤销上次应用' },
  macroBatchUndoConfirm: {
    en: 'Restore {0} project(s) to their pre-apply macro definitions?',
    'zh-cn': '将 {0} 个工程恢复到上次应用前的宏定义？',
  },
  macroBatchNoUndo: {
    en: 'MRVC: nothing to undo — no batch macro apply has been made in this window.',
    'zh-cn': 'MRVC：没有可撤销的操作——本窗口尚未执行过批量宏应用。',
  },
  macroBatchBusy: {
    en: 'MRVC: a batch macro operation is already running — wait for it to finish.',
    'zh-cn': 'MRVC：已有批量宏操作正在进行——请等待其完成。',
  },
  // per-project review (QuickPick before writing)
  macroBatchReviewTitle: {
    en: '"{0}" — review macro changes ({1}/{2})',
    'zh-cn': '“ {0} ”——确认宏修改（{1}/{2}）',
  },
  macroBatchReviewHint: {
    en: 'Compare macros before/after, then choose. Esc cancels ALL remaining projects.',
    'zh-cn': '对比修改前后的宏定义后选择。Esc 取消其余全部工程。',
  },
  macroBatchBefore: { en: 'Before', 'zh-cn': '修改前' },
  macroBatchAfter: { en: 'After', 'zh-cn': '修改后' },
  macroBatchEmpty: { en: '(empty)', 'zh-cn': '（空）' },
  macroBatchCppSkipRow: { en: 'C++ pane — skipped (C project)', 'zh-cn': 'C++ 栏——C 工程跳过' },
  macroBatchKeepHint: { en: 'macros not listed in the editor stay untouched', 'zh-cn': '编辑区未提及的宏保持不变' },
  macroBatchActionsSep: { en: 'Actions', 'zh-cn': '操作' },
  macroBatchActApply: { en: 'Apply this project', 'zh-cn': '应用此工程' },
  macroBatchActSkip: { en: 'Skip this project', 'zh-cn': '跳过此工程' },
  macroBatchActApplyRest: { en: 'Apply this and ALL remaining', 'zh-cn': '应用此工程，其余全部应用' },
  macroBatchActSkipRest: { en: 'Skip this and ALL remaining', 'zh-cn': '跳过此工程，其余全部跳过' },

  // batch toolchain (solution menu) + file flags
  toolchainPick: { en: 'Select the toolchain for ALL projects (RISC-V only)', 'zh-cn': '选择全部工程（仅 RISC-V）使用的工具链' },
  toolchainConfirm: {
    en: 'Set the toolchain of {0} project(s) to {1}? Takes effect on the next build.',
    'zh-cn': '将 {0} 个工程的工具链设置为 {1}？下次编译时生效。',
  },
  toolchainGo: { en: 'Modify', 'zh-cn': '修改' },
  flagPickColor: { en: 'Select a flag color', 'zh-cn': '选择标旗颜色' },
  flagApplied: { en: 'MRVC: "{0}" flagged ({1})', 'zh-cn': 'MRVC：已标旗“{0}”（{1}）' },
  flagNotInProject: {
    en: 'MRVC: this file does not belong to a loaded project.',
    'zh-cn': 'MRVC：该文件不属于任何已加载的工程。',
  },
};

/** translate a key with optional {0}/{1} substitution */
export function t(key: string, ...args: (string | number)[]): string {
  const entry = strings[key];
  let text = entry ? entry[current] : key;
  args.forEach((a, i) => {
    text = text.replace(`{${i}}`, String(a));
  });
  return text;
}
