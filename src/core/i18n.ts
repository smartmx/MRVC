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
    en: 'No RISC-V toolchain found. Check the "mrvc.mrs2InstallPath" setting — it must point to your MRS2 (MounRiver Studio 2) installation folder.',
    'zh-cn': '未找到 RISC-V 工具链。请检查 "mrvc.mrs2InstallPath" 设置——它必须指向您的 MRS2（MounRiver Studio 2）安装文件夹。',
  },

  // batch progress titles (notification popups)
  progressBuildAll: { en: 'MRVC: Build All', 'zh-cn': 'MRVC：构建全部工程' },
  progressBuildSolution: { en: 'MRVC: Build Solution - {0}', 'zh-cn': 'MRVC：构建解决方案 - {0}' },
  progressRebuildAll: { en: 'MRVC: Rebuild All', 'zh-cn': 'MRVC：重新构建全部工程' },
  progressDeleteKeep: { en: 'MRVC: Delete Output Files (Keep hex/bin)', 'zh-cn': 'MRVC：删除输出文件（保留 hex/bin）' },
  progressDeleteDirs: { en: 'MRVC: Delete Output Directories', 'zh-cn': 'MRVC：删除输出目录' },
  progressCleanAll: { en: 'MRVC: Clean All', 'zh-cn': 'MRVC：清理全部工程' },
  progressCleanSolution: { en: 'MRVC: Clean Solution - {0}', 'zh-cn': 'MRVC：清理解决方案 - {0}' },

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
    en: 'MRS2 (MounRiver Studio 2) installation not found — set "mrvc.mrs2InstallPath" to your MRS2 install folder.',
    'zh-cn': '未找到 MRS2（MounRiver Studio 2）安装目录——请在设置 "mrvc.mrs2InstallPath" 中指定 MRS2 安装文件夹。',
  },
  makeNotFound: { en: 'make.exe not found under the MounRiver installation ({0})', 'zh-cn': '在 MounRiver 安装目录下未找到 make.exe（{0}）' },
  makefileGenFailed: { en: 'Makefile generation failed: {0}', 'zh-cn': 'Makefile 生成失败：{0}' },
  neverBuilt: { en: 'MRVC: "{0}" has never been built — nothing to clean.', 'zh-cn': 'MRVC：" {0} " 尚未编译过——没有可清理的内容。' },
  rebuildCleanFailed: { en: 'MRVC: rebuild aborted — clean failed (exit {0}).', 'zh-cn': 'MRVC：重建中止——清理失败（退出码 {0}）。' },
  nothingToClean: { en: 'nothing to clean', 'zh-cn': '无可清理内容' },
  noOutputDir: { en: 'no output directory', 'zh-cn': '无输出目录' },
  outputDirRemoved: { en: 'output directory removed', 'zh-cn': '输出目录已删除' },
  entriesRemoved: { en: '{0} entries removed', 'zh-cn': '已删除 {0} 项' },

  // tree
  noMrsProjectNode: { en: 'No MRS project', 'zh-cn': '无 MRS 工程' },
  workspaceFiles: { en: 'Workspace Files', 'zh-cn': '工作区文件' },

  // open project / folder

  // solution lifecycle
  needSolution: { en: 'To add a project, open a solution first!', 'zh-cn': '请先打开解决方案，然后才能添加工程！' },
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
  cmakeNoToolchain: { en: 'No RISC-V toolchain found — check "mrvc.mrs2InstallPath".', 'zh-cn': '未找到 RISC-V 工具链——请检查 "mrvc.mrs2InstallPath"。' },
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
  firmwareNotFound: { en: 'Firmware file not found: {0}', 'zh-cn': '未找到固件文件：{0}' },
  selectFirmware: { en: 'Select firmware to download ({0})', 'zh-cn': '选择要下载的固件（{0}）' },
  openocdNotFound: { en: 'openocd.exe not found: {0}', 'zh-cn': '未找到 openocd.exe：{0}' },
  openocdCfgNotFound: { en: 'OpenOCD config not found: {0}', 'zh-cn': '未找到 OpenOCD 配置：{0}' },
  linkUtilityNotFound: { en: 'WCH-LinkUtility.exe not found under the MounRiver installation.', 'zh-cn': '在 MounRiver 安装目录下未找到 WCH-LinkUtility.exe。' },

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
  downloadThrew: {
    en: 'MRVC: download did not run for "{0}" — {1}',
    'zh-cn': 'MRVC：" {0} " 的下载未执行——{1}',
  },
  downloadFailed: {
    en: 'MRVC: download failed for "{0}" (exit code {1}) — see the task output.',
    'zh-cn': 'MRVC：" {0} "下载失败（退出码 {1}）——请查看任务输出。',
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
    en: 'MRVC: cannot start {0} — MRS2 installation not found (set mrvc.mrs2InstallPath).',
    'zh-cn': 'MRVC：无法启动 {0}——未找到 MRS2 安装（请设置 mrvc.mrs2InstallPath）。',
  },
  mrsToolsNotFound: {
    en: 'MRVC: {0} not found under the MRS2 installation ({1}).',
    'zh-cn': 'MRVC：在 MRS2 安装目录下未找到 {0}（{1}）。',
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
  wvprojOnlySkipped: {
    en: 'Skipped "{0}": found a .wvproj marker but no .project (MRVC-only project cannot be parsed).',
    'zh-cn': '已跳过" {0} "：发现了 .wvproj 标记但没有 .project（无法解析该工程）。',
  },
  openProjectFailed: { en: 'Failed to open MRS project: {0}', 'zh-cn': '打开 MRS 工程失败：{0}' },
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
