# MRVC — 在 VSCode 中打开、配置、编译 MounRiver (MRS) 工程

一个 VSCode 扩展（插件名 **MRVC**），直接打开/配置/编译 WCH（南京沁恒）MRS / MounRiver 工程，
无需 MRS2 IDE 本体（仅复用其安装目录中的工具链与工具组件）。
活动栏视图名为 "Project Explorer"；命令 ID 仍使用 `mrs2.*` 历史前缀（不影响使用），设置键为 `mrvc.*`。

## 功能

| 功能 | 说明 |
|---|---|
| 打开 MRS 工程 | 与 MRS 一致：以 `工程名.wvproj` 为工程标记（发现/打开入口），`.project` 作为老工程兜底；随后解析 `.project` / `.cproject` / `.template` 获取全部配置。**Open MRS Project / Solution 为 MRS2 同款文件对话框**（右下角文件类型下拉：`.wvproj` / `.wvsln` / 全部文件），选中后在**新 VSCode 窗口**打开：选 `.wvproj`/`.project` → 打开其所在目录并自动发现；选 `.wvsln` → 生成同名 `.code-workspace` 并在新窗口加载 solution；**打开整个 EVT/EXAM 目录用 VSCode 自带的 文件 → 打开文件夹**（扩展自动递归发现全部工程：最深 4 层嵌套）。**自动修复打包残留**：EVT 工程的链接文件夹若指向打包机器的绝对路径（如 `E:/.../EXAM/SRC`），首次打开时自动按"最近祖先+尾段"定位真实目录并回写为可移植的 `PARENT-N-PROJECT_LOC` 形式（与 MRS2 的 rewriteLinkedFolders 行为一致） |
| Solution（工程组） | 支持 MRS 新增的 `.wvsln` 解决方案（CH32H417 EVT 多核工程组织方式）：**仅当显式打开 `.wvsln` 文件时启用**——Open MRS Project / Solution 选中该文件后，生成同名 `.code-workspace`（引用该 solution）并在**新 VSCode 窗口**打开，激活时自动加载 solution；打开普通文件夹时只按常规方式扫描工程，不会自动加载其中的 .wvsln。树中显示为 solution 节点（`layers` 图标），成员工程按 MRS2 的 `BuildOrder=` 行（缺省按文件行序）排列、每个成员都是完整工程节点（配置/编译/排除全功能）。解析兼容 MRS2 的宽松语法：`-键:值` 工具链行、`<路径>.wvsln:` 导出头行、相对路径**以 .wvsln 文件为基准**（MRS2 同款约定，因此成员行都以 `..\` 开头）、绝对/相对混用、陈旧绝对路径自动丢弃并在节点悬停提示数量。成员工程带 `.kernel` 多核角色时悬停显示 `kernel V3F (master) · mate ../V5F`。右键 solution 节点 → **Build Solution / Clean Solution**（BuildOrder 顺序、单工程失败不中断、可取消带汇总） |
| 生成 Solution | 树标题栏 `…` 菜单第三组 → **Generate Solution From All Projects**（命令面板同名命令）：输入 solution 文件名（默认 `<工作区文件夹名>.wvsln`，保存在工作区根目录，同名询问覆盖），把当前已发现的**全部工程**生成一个 solution 并立即出现在树顶——平铺的多工程目录一眼收拢成单节点。生成的文件与 MRS2 完全兼容（标准工具链行 + `..\` 相对成员路径 + CRLF），MRS2 可直接打开 |
| 工程树 | 活动栏 MRVC 容器内的 "Project Explorer"：标题栏 4 个按钮（**Open Mrs Project**（文件对话框，类型下拉选 `.wvproj`/`.wvsln`）/ **Open Mrs Folder**（只选目录）/ 折叠全部 / **刷新**——重新扫描工作文件夹：外部改名/新增/删除的工程会被自动识别与清理）。两种打开均在**新 VSCode 窗口**进行；其余批量操作在 `…` 菜单（分组间有分割线：构建类 → 删除类 → 生成类）。工程 → 链接文件夹（**蓝色名称**，悬停显示真实路径）/ 实体目录 / 编译输出目录（**整行红色**，颜色可在主题中覆盖 `mrvc.outputDirectory`）。文件与文件夹图标由**当前文件图标主题**渲染（.c/.h/.ld 等按扩展名显示主题图标，与资源管理器一致）。链接文件夹右键可移除链接；工程右键 **Rename Project** 可重命名（MRS2 同款语义：改 `.project` 显示名并同步 `.wvproj`/`.launch`/`.template` 的 Target Path，**不移动目录**——.wvsln 引用与链接相对路径不受影响，产物名跟随新名）；**Sync Project Name from Folder** 把文件夹名同步为工程名（文件夹名含空格时提示先改文件夹名） |
| 文件管理 | 树节点右键：New File / New Folder / **Copy→Paste**（插件内剪贴板，同名自动 `- copy` 递增，文件夹递归复制）/ Copy Absolute Path / **Copy Project Relative Path**（复制 `${workspace_loc:/${ProjName}/Ld/Link.ld}` 形式的 CDT 逻辑路径，可直接粘进属性页的包含路径/链接脚本列表；链接文件夹子文件输出 `链接名/...` 形式）/ Copy File Name / Rename / Delete（均带确认）/ Open Containing Folder（系统文件管理器定位）。链接文件夹禁用 Rename/Delete（防止误删真实目录），链接目录内部的文件操作不受限 |
| 排除 / 恢复编译 | 文件与文件夹右键 **Exclude From Build / Include From Build**（与 MRS 的 Resource Configurations → Exclude from Build 等价）：写回 `.cproject` 各配置 `sourceEntries` 的 `excluding` 列表（`|` 分隔；目录带命名 sourceEntry 时写目录内相对路径，否则写工程根相对全路径并在缺失时自动创建根 entry——与 MRS2 两种工程风格完全一致，MRS2 可无损打开同一工程）。被排除的资源在树中显示为**灰色**（主题色 `mrvc.excludedFromBuild`，悬停 "Excluded from build"，行尾 `×` 标记），并在所在目录列表中**排在最后**；下次编译重新生成 makefile 时生效；编译输出目录（obj）不可排除 |
| 编译 / 重建 / 清理 | 每次构建前从 `.cproject` 重新生成 CDT 风格 makefile，再调 MRS 自带 `make`；错误进问题面板（`$mrvcgcc` problemMatcher） |
| 编译所有工程 | "MRVC: Build All Projects"（标题栏 `…` 菜单第一组）：顺序编译全部已发现工程，**单工程失败不中断**，每个工程都会被编译；进度条 + `MRVC Build All` 输出频道汇总 OK/FAIL，失败项进问题面板 |
| 重建所有工程 | "MRVC: Rebuild All Projects"（`…` 菜单第一组）：每个工程先 `make clean` 再重新编译（逐工程 clean→build，clean 失败记为该工程失败），失败不中断、可取消带汇总 |
| 删除输出文件 | 标题栏 `…` 菜单第二组 → **Delete Output Files (Keep hex/bin)**：清空每个工程输出目录，仅保留 `工程名.hex` / `工程名.bin`（Windows 上大小写不敏感），.o/.d/elf/map/makefile 及子目录全部删除；下次构建自动重新生成 makefile |
| 删除输出目录 | 标题栏 `…` 菜单第二组 → **Delete Output Directories**：把每个工程的整个输出目录（含 makefile）删掉；下次构建自动重建。两个删除操作均带工程根边界守卫（绝不越出工程根目录），输出目录不存在时记为跳过 |
| 清理所有工程 | "MRVC: Clean All Projects"（`…` 菜单第一组）：对全部工程执行 `make clean`（从未编译的工程自动跳过），同样失败不中断、可取消、带汇总 |
| 编译 / 重建 / 清理（单工程） | 行内 Build/Rebuild 小按钮 + 右键菜单：Rebuild 先走可见的 clean 任务再全量重编。编译/全部编译/重建按钮使用 MRS2 原版工具栏图标（`media/build_project.svg` 等取自 MRS2 安装目录，仅限内部使用勿公开分发） |
| 配置修改 | "MRVC: Project Properties"（右键工程打开）——**按 MRS2 原版属性页布局复刻**：左侧 Tool Settings 分类树（Target Processor / Optimization / Warnings / Debugging / Assembler / C Compiler / C Linker 各含 Preprocessor·Includes·Libraries 等子页 / C++ 编译·链接 / Create Flash Image），右侧仅显示选中页，底部描述区 + **Apply/Cancel**；控件风格与 MRS2 一致（标签在上、下拉全宽、勾选项蓝色高亮），顶部显示编译配置名。涵盖工具链（rvGcc）、全部 ISA 扩展、17 项警告、C/C++ 编译与链接、hex/bin 双产物、objcopy/objdump 细项、WCH 专属库（`-lprintf`/`-lprintfloat`/`-lIQmath_RV32`）。直接写回 `.cproject`（CDT 规范选项名，MRS2 仍可打开同一工程） |
| 外部链接文件夹 | 右键工程 → Add Linked Folder：同时更新 `.project`（linkedResources，支持 PARENT-N-PROJECT_LOC）与 `.cproject`（include 路径 + sourceEntries） |
| WCH-LinkUtility | 命令面板 **Open WCH-LinkUtility**：直接拉起 MRS2 自带的 GUI 下载器（OpenOCD 烧录命令规划于 M3 里程碑） |
| MRS 命令终端 | 预置工具链/make/OpenOCD 的 PATH |
| 工具链选择 | `auto`（读 `.cproject` rvGcc/前缀）或强制 GCC8/GCC12/GCC15，均从 `sub_manifest.json` 动态解析 |

快捷键：`F7` 编译，`Shift+F7` 重建。

## 打包与安装（.vsix）

```bash
npm run compile      # 先编译（esbuild 打包出 out/extension.js）
npm run package      # 生成 mrvc-<version>.vsix（@vscode/vsce，--no-dependencies）
```

安装（三种任选）：
- VSCode 图形界面：扩展视图 → 右上角 `···`（Views and More Actions）→ **Install from VSIX...** → 选择生成的 `mrvc-0.1.1.vsix`
- 命令行：`code --install-extension mrvc-0.1.1.vsix`
- 直接把 `.vsix` 拖进扩展视图

> `.vscodeignore` 已配置只打包 `out/extension.js`(+map)、`media/*.svg`、README 和 package.json；
> 版本号升级后重新 `npm run package` 即可（输出文件名跟随 `package.json` 的 version）。

## 使用

> **前置条件：需要先安装 [MounRiver Studio 2（MRS2）](https://www.mounriver.com/)**。
> MRVC 不自带工具链，而是复用 MRS2 安装目录中的 RISC-V 工具链（GCC8/12/15）、make、
> OpenOCD 与 WCH-LinkUtility 组件——没有 MRS2 就无法编译。

1. 在设置里搜索 `mrvc`，将 **MRS2 Install Path**（`mrvc.mrs2InstallPath`）设为 MRS2 的安装路径
   （默认 `C:\MounRiver\MounRiver_Studio2`，本机按实际安装位置填写）。
2. 命令面板 `MRVC: Open MRS Project / Solution`：选 `.wvproj`/`.wvsln` 文件，或用 VSCode 自带的
   文件 → 打开文件夹 直接打开 EVT/EXAM 目录（扩展自动发现全部工程）。
3. `F7` 编译；产物在工程 `obj/`（或 .cproject 配置名对应目录）。

## 开发

```bash
npm install
npm run compile      # esbuild 打包到 out/extension.js
npm run watch
npm run golden       # 金标 makefile 逐字节比对（见下）
node tools/build-test.mjs F:/CH585/EVT/V1_2/EXAM/LED    # 命令行真实编译
node tools/build-all.mjs         # 全量批跑（并发 3）
node tools/config-audit.mjs      # 配置项覆盖审计
node tools/roundtrip-test.js     # 配置回写/链接文件夹往返测试
node tools/exclude-test.js       # 排除/恢复编译语义测试（40 断言）
node tools/rename-test.js        # 工程重命名语义测试（18 断言）
node tools/output-test.js        # 输出目录清理测试（9 断言）
node tools/solution-test.mjs     # solution 解析/生成全量断言
```

VSCode 调试（调试配置已配好，`esbuild` 已开 sourcemap，断点直接打在 `src/**/*.ts` 上）：

1. 用 VSCode 打开本仓库目录
2. `F5`（运行和调试 → **运行扩展 (Extension Development Host)**）——自动先编译再拉起一个加载了本插件的 VSCode 窗口
3. 在新窗口里 `文件 → 打开文件夹` 选 `F:\CH585\EVT\V1_2\EXAM`，插件自动发现 96 个工程
4. 在 `src/vscode/tasks.ts` / `src/core/makefile.ts` 等处打断点，然后在扩展窗口按 `F7` 编译即可断住
5. 改代码后：开发宿主窗口里 `Ctrl+R`（或 `开发者: 重新加载窗口`）重载；若开启了 `npm: watch` 任务则无需手动编译

其他调试入口（launch 下拉菜单）：
- **调试核心: 金标比对 / 往返测试 / 单工程编译** —— 不启动 VSCode，直接在 Node 里单步调 `src/core/` 逻辑（最快）
- 扩展窗口里 `帮助 → 切换开发人员工具` 可调试属性页 webview（Console 看 `console.log`、审查 DOM）

## 架构

```
src/
├── core/              # 纯 Node，无 vscode 依赖，可独立测试
│   ├── xml.ts         # 零依赖 XML DOM（.project/.cproject/.launch 读写）
│   ├── projectFile.ts # .project：linkedResources、PARENT-N-PROJECT_LOC、重命名联动
│   ├── cproject.ts    # .cproject 类型化模型（按 superClass 读写 option、excluding）
│   ├── templateFile.ts# .template（下载配置）
│   ├── macros.ts      # ${workspace_loc:/...} 宏 / 链接目录路径解析
│   ├── toolchain.ts   # MRS2 安装探测 + sub_manifest.json 工具链解析
│   ├── flags.ts       # -march/-mabi/-Os/-I/-T/... 组装（移植自 MRS2 逻辑）
│   ├── scan.ts        # 源文件扫描（excluding 语义、大小写折叠、装饰映射）
│   ├── solution.ts    # .wvsln 解析 / 生成
│   ├── output.ts      # 输出目录清理（边界守卫）
│   ├── makefile.ts    # makefile/sources.mk/subdir.mk/objects.mk 生成器
│   └── flash.ts       # OpenOCD 烧录脚本生成（烧录命令规划于 M3，先保留实现）
└── vscode/            # 集成层
    ├── projects.ts    # 工程注册表/solution 注册表/文件监视/打开流程
    ├── tree.ts        # 工程树（solution 节点、排除置底、装饰）
    ├── tasks.ts       # 批量构建管线（Build/Clean/Rebuild All、Solution、输出清理）
    ├── flash.ts       # WCH-LinkUtility / MRS 终端（烧录任务预留）
    ├── configView.ts  # 工程属性 webview
    ├── fileOps.ts     # 文件管理右键（新建/复制/粘贴/重命名/删除/路径复制）
    ├── exclude.ts     # Exclude/Include From Build 命令与装饰数据
    ├── renameProject.ts # Rename Project / Sync Project Name from Folder
    └── linkedFolders.ts
```

工具组件全部来自 MRS2 安装目录（`resources/app/resources/win32/`）：
`components/WCH/Toolchain/*`（GCC8/GCC12/GCC15）、`others/Build_Tools/Make`、
`components/WCH/OpenOCD`、`components/WCH/Others/SWDTool`（WCH-LinkUtility）。
