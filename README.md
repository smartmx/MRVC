# MRVC — 在 VSCode 中打开、配置、编译、下载 MounRiver (MRS) 工程

一个 VSCode 扩展（插件名 **MRVC**），直接打开/配置/编译/**下载烧录** WCH（南京沁恒）MRS / MounRiver 工程，
无需 MRS2 IDE 本体（仅复用其安装目录中的工具链与工具组件）。
活动栏视图名为 "Project Explorer"；命令 ID 仍使用 `mrs2.*` 历史前缀（不影响使用），设置键为 `mrvc.*`。

## 功能

| 功能 | 说明 |
|---|---|
| 打开 MRS 工程 | 与 MRS 一致：以 `工程名.wvproj` 为工程标记（发现/打开入口），`.project` 作为老工程兜底；随后解析 `.project` / `.cproject` / `.template` 获取全部配置。**Open MRS Project / Solution 为 MRS2 同款文件对话框**（右下角文件类型下拉：`.wvproj` / `.wvsln` / 全部文件），选中后在**新 VSCode 窗口**打开：选 `.wvproj`/`.project` → 打开其所在目录并自动发现；选 `.wvsln` → 生成同名 `.code-workspace` 并在新窗口加载 solution；**打开整个 EVT/EXAM 目录用 VSCode 自带的 文件 → 打开文件夹**（扩展自动递归发现全部工程：最深 4 层嵌套）。**自动修复打包残留**：EVT 工程的链接文件夹若指向打包机器的绝对路径（如 `E:/.../EXAM/SRC`），首次打开时自动按"最近祖先+尾段"定位真实目录并回写为可移植的 `PARENT-N-PROJECT_LOC` 形式（与 MRS2 的 rewriteLinkedFolders 行为一致；MRS1 风格的 `<location>` 自动转换为 `<locationURI>`） |
| Solution（工程组） | 支持 MRS 新增的 `.wvsln` 解决方案：**仅当显式打开 `.wvsln` 文件时启用**——Open MRS Project / Solution 选中该文件后，生成同名 `.code-workspace` 并在**新 VSCode 窗口**打开，激活时自动加载 solution；树中显示为 solution 节点，成员工程按 MRS2 的 `BuildOrder=` 行（缺省按文件行序）排列、每个成员都是完整工程节点。解析兼容 MRS2 的宽松语法；生成的 solution 与 MRS2 完全兼容 |
| 生成 Solution | 树标题栏 `…` 菜单 → **Generate Solution From All Projects**：把当前已发现的全部工程生成一个 solution 并立即出现在树顶，MRS2 可直接打开 |
| 工程树 | 活动栏 MRVC 容器内的 "Project Explorer"：标题栏 4 个按钮（**Open Mrs Project**（文件对话框）/ **Open Mrs Folder**（只选目录）/ 折叠全部 / **刷新**——外部改名/新增/删除的工程会被自动识别与清理）。工程 → 链接文件夹（蓝色名称）/ 实体目录 / **根级源文件** / 编译输出目录（红色）。**Workspace Files 节点**列出工程同级目录的散落源文件。**源文件自动刷新**：工作区与每个工程内的源文件新建/删除/改名即时反映到树（400ms 防抖），配置文件有专属监听 |
| 文件管理 | 树节点右键（每类节点独立菜单）：New File / New Folder / **Copy→Paste**（插件内剪贴板，同名自动 `- copy` 递增，文件夹递归复制）/ Copy Absolute Path / **Copy Project Relative Path**（`${workspace_loc:/${ProjName}/…}` 形式的 CDT 逻辑路径）/ Copy File Name / Rename / Delete（均带确认）/ Open Containing Folder。链接文件夹禁用 Rename/Delete（防误删真实目录），其内部文件操作不受限 |
| 排除 / 恢复编译 | 文件与文件夹右键 **Exclude From Build / Include From Build**（与 MRS 的 Resource Configurations → Exclude from Build 等价）：写回 `.cproject` 各配置 `sourceEntries` 的 `excluding` 列表（`|` 分隔；目录带命名 sourceEntry 时写目录内相对路径，否则写工程根相对全路径并在缺失时自动创建根 entry——与 MRS2 两种工程风格完全一致）。被排除的资源在树中显示为**灰色**（行尾 `×`）并排在最后；下次编译生效；编译输出目录不可排除 |
| 编译 / 重建 / 清理 | 每次构建前从 `.cproject` 重新生成 CDT 风格 makefile，再调 MRS 自带 `make`；错误进问题面板（`$mrvcgcc` problemMatcher）。行内 Build / Rebuild / Download 按钮 + 右键菜单；Build All / Clean All / Solution 构建批处理（单工程失败不中断、可取消带汇总）；**Pre-build / Post-build steps** 参与生成的 makefile |
| 下载烧录 | 工程行内 **Flash 按钮** / 右键 **Download**：通过 MRS2 的 OpenOCD 下载 `obj/` 产物（hex/bin，地址取自 `.template` 的 Address，双核工程自动选 `wch-dual-core.cfg`）；输出进任务终端，失败弹提示 |
| Download Settings | 属性页 → Download → Download Settings（镜像 MRS2）：**读保护状态查询 / 使能 / 解除**、**调试保护**、**Linked MCU Type 查询**、**Erase Code Flash**（By Pin NRST / By Power off）、**MCU Memory Assign**（Query/Apply）、**Operation Record** 操作日志；右侧完整编辑下载参数（MCU Type / Memory Type / Program Address / Debug Interface Mode / CLK Speed / Target File / Main Operations 八项），全部写回 `.template`（MRS2 无损打开）。硬件操作经系统 32 位 PowerShell P/Invoke 调用 MRS2 的 McuCompilerDll.dll，零新增依赖；芯片 ID 与能力开关自动来自芯片库，不支持的选项按芯片自动灰显 |
| 芯片选择器 | 属性页 → General → Chip / Target：MRS2 同款 "Target MCU Type" 选择器——系列树（RISC-V/ARM 分组）→ 型号列表 → 信息区；数据实时扫描 MRS2 的 SDK 组件目录（40+ 系列），选中后自动填充 Series / MCU / Mcu Type / Address 并写回 `.template`；SDK 缺失时回退文本编辑 |
| Build Steps / Build Artifact | 属性页 → C/C++ Build 分组：**Build Steps**（Pre/Post-build 的 Command 与 Description，进 makefile）；**Build Artifact**（Artifact Type：Executable/Static Library；Artifact name 按 MRS 变量形式显示 `${ProjName}`；Artifact extension；Output prefix——产物名前缀与自定义扩展名在生成的 makefile 中生效） |
| Switch Project Type (C/C++) | 工程右键一键切换 CDT cxx nature：C++ 属性页显隐、`.cpp` 源扫描与 makefile 生成联动（与 MRS2 判定键一致） |
| 配置修改 | "MRVC: Project Properties"（右键工程打开）——**按 MRS2 原版属性页布局复刻**：Tool Settings 分类树（Target Processor / Optimization / Warnings / Debugging / Assembler / C Compiler / C Linker / C++ Compiler / C++ Linker / Create Flash Image / Listing / Print Size 各含子页），左侧树结构、右侧页内容、底部描述区 + **Apply/Cancel**。涵盖工具链（rvGcc）、全部 ISA 扩展、17 项警告、C/C++ 编译与链接、hex/bin 双产物、objcopy/objdump 细项、WCH 专属库（`-lprintf`/`-lprintfloat`/`-lIQmath_RV32`）。**Includes 页为表格编辑器**（Add/Edit/Delete，Add 支持 Project 内复选框树浏览或 Local Folder，工程内路径自动写成 `${project}/…` 宏）。仅 C++ 工程（Switch Project Type 切换）显示 C++ 配置页 |
| 外部链接文件夹 | 右键工程 → Add Linked Folder：同时更新 `.project`（linkedResources，支持 PARENT-N-PROJECT_LOC）与 `.cproject`（include 路径 + sourceEntries） |
| WCH-LinkUtility | 命令面板 **Open WCH-LinkUtility**：直接拉起 MRS2 自带的 GUI 下载器（调试器模式切换/固件升级等深度操作） |
| MRS 命令终端 | 预置工具链/make/OpenOCD 的 PATH |
| 工具链选择 | `auto`（读 `.cproject` rvGcc/前缀）或强制 GCC8/GCC12/GCC15，均从 `sub_manifest.json` 动态解析 |

快捷键：`F7` 编译，`Shift+F7` 重建。

## 打包与安装（.vsix）

```bash
npm run compile      # 先编译（esbuild 打包出 out/extension.js）
npm run package      # 生成 mrvc-<version>.vsix（@vscode/vsce，--no-dependencies）
```

安装（三种任选）：
- VSCode 图形界面：扩展视图 → 右上角 `···`（Views and More Actions）→ **Install from VSIX...** → 选择生成的 `mrvc-0.1.2.vsix`
- 命令行：`code --install-extension mrvc-0.1.2.vsix`
- 直接把 `.vsix` 拖进扩展视图

> `.vscodeignore` 已配置只打包 `out/extension.js`(+map)、`media/*.svg`、README、package.json；
> 版本号升级后重新 `npm run package` 即可（输出文件名跟随 `package.json` 的 version）。

## 使用

> **前置条件：需要先安装 [MounRiver Studio 2（MRS2）](https://www.mounriver.com/)**。
> MRVC 不自带工具链，而是复用 MRS2 安装目录中的 RISC-V 工具链（GCC8/12/15）、make、
> OpenOCD、WCH-LinkUtility 与芯片库组件——没有 MRS2 就无法编译/下载。

1. 在设置里搜索 `mrvc`，将 **MRS2 Install Path**（`mrvc.mrs2InstallPath`）设为 MRS2 的安装路径
   （默认 `C:\MounRiver\MounRiver_Studio2`，本机按实际安装位置填写）。
2. 命令面板 `MRVC: Open MRS Project / Solution`：选 `.wvproj`/`.wvsln` 文件，或用 VSCode 自带的
   文件 → 打开文件夹 直接打开 EVT/EXAM 目录（扩展自动发现全部工程）。
3. `F7` 编译；产物在工程 `obj/`（或 .cproject 配置名对应目录）。
4. 接好 WCH-Link 后用工程行内 **Flash** 按钮或右键 **Download** 下载；
   读保护/芯片查询等深度操作在属性页 → Download → Download Settings。

## 开发

```bash
npm install
npx tsc              # 先生成 out/core/*.js 分文件产物（测试脚本依赖）
npm run compile      # 再 esbuild 打包 out/extension.js（会覆盖同名 tsc 产物）
npm run watch
npm run golden       # 金标 makefile 逐字节比对（tools/golden-check.mjs）
npm run package      # @vscode/vsce 打包 .vsix（--no-dependencies）
```

> **顺序陷阱**：`npx tsc` 与 `node esbuild.js` 都会写 `out/extension.js`——tsc 产出的是 10KB 的模块入口，
> esbuild 产出的是 235KB 的完整 bundle（发布用）。**必须先 tsc 后 esbuild**；顺序颠倒会把 bundle 覆盖成
> 小文件，打出的 vsix 缺失全部功能。打包前建议 `ls -la out/extension.js` 确认体积。

测试脚本在 `tools/`，均为纯 Node 断言，直接 `node tools/<脚本>` 运行：

- `roundtrip-test.js` — 配置回写/链接文件夹/工程重命名/C++ nature/Build Steps·Artifact 往返
- `exclude-test.js` — 排除/恢复编译语义（含 CH585 混合风格与真实工程回归）
- `rename-test.js` / `output-test.js` — 工程重命名与输出目录清理
- `solution-test.mjs` / `discover-test.mjs` — solution 解析生成 / 工程发现
- `flash-test.mjs` — 烧录 cfg 生成（地址覆盖/verify-reset 组合/非法地址）
- `wlink-test.mjs` — WCH-Link 桥（P/Invoke 脚本生成/load.wcfg/降级路径）
- `mass-test.mjs` — **TEST 全树批量回归**（解析/扫描/排除/芯片库/makefile 字节稳定性，覆盖全部工程）
- `build-test.mjs <EVT工程路径>` — 真实工具链编译单工程；`build-all.mjs` 全量批跑
- `print-menus.mjs` — 打印各类树节点右键菜单排序（开发辅助）

VSCode 调试（调试配置已配好，`esbuild` 已开 sourcemap，断点直接打在 `src/**/*.ts` 上）：

1. 用 VSCode 打开本仓库目录
2. `F5`（运行和调试 → **运行扩展 (Extension Development Host)**）——自动先编译再拉起一个加载了本插件的 VSCode 窗口
3. 在新窗口里 `文件 → 打开文件夹` 选 EVT/EXAM 目录，插件自动发现全部工程
4. 在 `src/vscode/tasks.ts` / `src/core/makefile.ts` 等处打断点，然后在扩展窗口按 `F7` 编译即可断住
5. 改代码后：开发宿主窗口里 `Ctrl+R`（或 `开发者: 重新加载窗口`）重载；若开启了 `npm: watch` 任务则无需手动编译

其他调试入口（launch 下拉菜单）：**调试核心** 系列直接在 Node 里单步调 `src/core/` 逻辑（金标比对/往返测试/
烧录脚本生成/单工程编译等，最快）；扩展窗口里 `帮助 → 切换开发人员工具` 可调试属性页 webview。

## 架构

```
src/
├── core/              # 纯 Node，无 vscode 依赖，可独立测试
│   ├── xml.ts         # 零依赖 XML DOM（.project/.cproject/.launch 读写，无损序列化）
│   ├── projectFile.ts # .project：linkedResources、PARENT-N-PROJECT_LOC、重命名联动
│   ├── cproject.ts    # .cproject 类型化模型（按 superClass 读写 option、excluding、Build Steps/Artifact）
│   ├── templateFile.ts# .template（下载配置；无损重写保留注释空行）
│   ├── macros.ts      # ${workspace_loc:/...} / ${project}/... 宏 / PARENT-N 解析
│   ├── toolchain.ts   # MRS2 安装探测 + sub_manifest.json 工具链解析
│   ├── flags.ts       # -march/-mabi/-Os/-I/-T/... 组装（移植自 MRS2 逻辑）
│   ├── scan.ts        # 源文件扫描（excluding 语义、大小写折叠、装饰映射）
│   ├── solution.ts    # .wvsln 解析 / 生成（含 BuildOrder）
│   ├── output.ts      # 输出目录清理（边界守卫）
│   ├── makefile.ts    # makefile/sources.mk/subdir.mk/objects.mk 生成器
│   ├── discover.ts    # 工程发现
│   ├── chipdb.ts      # 芯片数据库（扫描 MRS2 SDK：型号/地址/chipID/能力开关）
│   ├── wlink.ts       # WCH-Link 操作桥（32 位 PowerShell P/Invoke McuCompilerDll）
│   └── flash.ts       # OpenOCD 烧录脚本生成
└── vscode/            # 集成层
    ├── projects.ts    # 工程注册表/solution 注册表/文件监视（配置+源文件自动刷新）
    ├── tree.ts        # 工程树（solution 节点、根级文件、Workspace Files、排除置底、装饰）
    ├── tasks.ts       # 构建任务管线（Build/Clean/Rebuild All、Solution、输出清理）
    ├── flash.ts       # Download 命令（OpenOCD 引擎）与 cfg 选择
    ├── configView.ts  # 工程属性 webview（MRS2 布局复刻：芯片选择器/Includes 表格/Download Settings）
    ├── fileOps.ts     # 文件管理右键（新建/复制/粘贴/重命名/删除/路径复制）
    ├── exclude.ts     # Exclude/Include From Build 命令与装饰数据
    ├── renameProject.ts # Rename Project / Sync Project Name from Folder
    └── linkedFolders.ts
```

工具组件全部来自 MRS2 安装目录（`resources/app/resources/win32/`）：
`components/WCH/Toolchain/*`（GCC8/GCC12/GCC15）、`others/Build_Tools/Make`、
`components/WCH/OpenOCD`、`components/WCH/Others/SWDTool`（WCH-LinkUtility）、
`components/WCH/Others/CommunicationLib`（WCH-Link 操作 DLL）、`components/WCH/SDK`（芯片数据库）。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。
