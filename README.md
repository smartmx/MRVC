# MRVC — 在 VSCode 中打开、配置、编译、烧录 MounRiver (MRS) 工程

一个 VSCode 扩展（插件名 **MRVC**），直接打开/配置/编译/烧录 WCH（南京沁恒）MRS / MounRiver 工程，
无需 MRS2 IDE 本体（仅复用其安装目录中的工具链与工具组件）。
活动栏视图名为 "Project Explorer"；命令 ID 仍使用 `mrs2.*` 历史前缀（不影响使用），设置键为 `mrvc.*`。

## 功能（当前里程碑 M1：编译闭环）

| 功能 | 说明 |
|---|---|
| 打开 MRS 工程 | 与 MRS 一致：以 `工程名.wvproj` 为工程标记（发现/打开入口），`.project` 作为老工程兜底；随后解析 `.project` / `.cproject` / `.template` 获取全部配置。打开 EVT/EXAM 这类多工程目录时自动递归发现全部工程（CH585 96/96、CH587 95/95，最深 4 层嵌套）。**自动修复打包残留**：EVT 工程的链接文件夹若指向打包机器的绝对路径（如 `E:/.../EXAM/SRC`），首次打开时自动按"最近祖先+尾段"定位真实目录并回写为可移植的 `PARENT-N-PROJECT_LOC` 形式（与 MRS2 的 rewriteLinkedFolders 行为一致） |
| 工程树 | 活动栏 MRVC 容器内的 "Project Explorer"：工程 → 链接文件夹（**蓝色名称**，悬停显示真实路径）/ 实体目录 / 编译输出目录（`obj (output)`，**整行红色**，颜色可在主题中覆盖 `mrvc.outputDirectory`）。文件与文件夹图标由**当前文件图标主题**渲染（.c/.h/.ld 等按扩展名显示主题图标，与资源管理器一致）。链接文件夹右键可移除链接 |
| 文件管理 | 树节点右键：New File / New Folder / **Copy→Paste**（插件内剪贴板，同名自动 `- copy` 递增，文件夹递归复制）/ Copy Absolute Path / **Copy Project Relative Path**（复制 `${workspace_loc:/${ProjName}/Ld/Link.ld}` 形式的 CDT 逻辑路径，可直接粘进属性页的包含路径/链接脚本列表；链接文件夹子文件输出 `链接名/...` 形式）/ Copy File Name / Rename / Delete（均带确认）/ Open Containing Folder（系统文件管理器定位）。链接文件夹禁用 Rename/Delete（防止误删真实目录），链接目录内部的文件操作不受限 |
| 编译 / 重建 / 清理 | 每次构建前从 `.cproject` 重新生成 CDT 风格 makefile，再调 MRS 自带 `make`；错误进问题面板（`$mrvcgcc` problemMatcher） |
| 编译所有工程 | "MRVC: Build All Projects"（工程树标题栏按钮）：顺序编译全部已发现工程，**单工程失败不中断**，每个工程都会被编译；进度条 + `MRVC Build All` 输出频道汇总 OK/FAIL，失败项进问题面板 |
| 清理所有工程 | "MRVC: Clean All Projects"（Build All 旁的按钮）：对全部工程执行 `make clean`（从未编译的工程自动跳过），同样失败不中断、可取消、带汇总 |
| 编译 / 重建 / 清理（单工程） | 行内 Build/Rebuild 小按钮 + 右键菜单：Rebuild 先走可见的 clean 任务再全量重编。编译/全部编译/重建按钮使用 MRS2 原版工具栏图标（`media/build_project.svg` 等取自 MRS2 安装目录，仅限内部使用勿公开分发） |
| 配置修改 | "MRVC: Project Properties"（右键工程打开）——**按 MRS2 原版属性页布局复刻**：左侧 Tool Settings 分类树（Target Processor / Optimization / Warnings / Debugging / Assembler / C Compiler / C Linker 各含 Preprocessor·Includes·Libraries 等子页 / C++ 编译·链接 / Create Flash Image），右侧仅显示选中页，底部描述区 + **Apply/Cancel**；控件风格与 MRS2 一致（标签在上、下拉全宽、勾选项蓝色高亮），顶部显示编译配置名。涵盖工具链（rvGcc）、全部 ISA 扩展、17 项警告、C/C++ 编译与链接、hex/bin 双产物、objcopy/objdump 细项、WCH 专属库（`-lprintf`/`-lprintfloat`/`-lIQmath_RV32`）。直接写回 `.cproject`（CDT 规范选项名，MRS2 仍可打开同一工程） |
| 外部链接文件夹 | 右键工程 → Add Linked Folder：同时更新 `.project`（linkedResources，支持 PARENT-N-PROJECT_LOC）与 `.cproject`（include 路径 + sourceEntries） |
| 烧录 | OpenOCD `program`（WCH-Link，wch-riscv.cfg），参数读自 `.template` + `mrvc.flash.*` 设置；也可一键打开 WCH-LinkUtility GUI |
| MRS 命令终端 | 预置工具链/make/OpenOCD 的 PATH |
| 工具链选择 | `auto`（读 `.cproject` rvGcc/前缀）或强制 GCC8/GCC12/GCC15，均从 `sub_manifest.json` 动态解析 |

快捷键：`F7` 编译，`Shift+F7` 重建，`F8` 烧录。

## 打包与安装（.vsix）

```bash
npm run compile      # 先编译（esbuild 打包出 out/extension.js）
npm run package      # 生成 mrvc-<version>.vsix（@vscode/vsce，--no-dependencies）
```

安装（三种任选）：
- VSCode 图形界面：扩展视图 → 右上角 `···`（Views and More Actions）→ **Install from VSIX...** → 选择生成的 `mrvc-0.1.0.vsix`
- 命令行：`code --install-extension mrvc-0.1.0.vsix`
- 直接把 `.vsix` 拖进扩展视图

> `.vscodeignore` 已配置只打包 `out/extension.js`(+map)、`media/*.svg`、README 和 package.json；
> 版本号升级后重新 `npm run package` 即可（输出文件名跟随 `package.json` 的 version）。

## 使用

> **前置条件：需要先安装 [MounRiver Studio 2（MRS2）](https://www.mounriver.com/)**。
> MRVC 不自带工具链，而是复用 MRS2 安装目录中的 RISC-V 工具链（GCC8/12/15）、make、
> OpenOCD 与 WCH-LinkUtility 组件——没有 MRS2 就无法编译和烧录。

1. 在设置里搜索 `mrvc`，将 **MRS2 Install Path**（`mrvc.mrs2InstallPath`）设为 MRS2 的安装路径
   （默认 `C:\MounRiver\MounRiver_Studio2`，本机按实际安装位置填写）。
2. 命令面板 `MRVC: Open MRS Project`，选择工程目录（或直接打开含多个工程的 EVT/EXAM 文件夹，扩展会自动发现）。
3. `F7` 编译；产物在工程 `obj/`（或 .cproject 配置名对应目录）。

## 开发

```bash
npm install
npm run compile      # esbuild 打包到 out/extension.js
npm run watch
npm run golden       # 金标 makefile 逐字节比对（见下）
node tools/build-test.mjs F:/CH585/EVT/V1_2/EXAM/LED    # 命令行真实编译
node tools/build-all.mjs         # 全量 96 工程批跑（并发 3）
node tools/config-audit.mjs      # 配置项覆盖审计
node tools/roundtrip-test.js     # 配置回写/链接文件夹往返测试
```

VSCode 调试（调试配置已配好，`esbuild` 已开 sourcemap，断点直接打在 `src/**/*.ts` 上）：

1. 用 VSCode 打开本 `develop/` 目录
2. `F5`（运行和调试 → **运行扩展 (Extension Development Host)**）——自动先编译再拉起一个加载了本插件的 VSCode 窗口
3. 在新窗口里 `文件 → 打开文件夹` 选 `F:\CH585\EVT\V1_2\EXAM`，插件自动发现 96 个工程
4. 在 `src/vscode/tasks.ts` / `src/core/makefile.ts` 等处打断点，然后在扩展窗口按 `F7` 编译即可断住
5. 改代码后：开发宿主窗口里 `Ctrl+R`（或 `开发者: 重新加载窗口`）重载；若开启了 `npm: watch` 任务则无需手动编译

其他调试入口（launch 下拉菜单）：
- **调试核心: 金标比对 / 往返测试 / 单工程编译** —— 不启动 VSCode，直接在 Node 里单步调 `src/core/` 逻辑（最快）
- 扩展窗口里 `帮助 → 切换开发人员工具` 可调试属性页 webview（Console 看 `console.log`、审查 DOM）

## 验证

- **金标比对**（`npm run golden`）：把参考工程复制到 `.scratch/`，用相同的工具链前缀重新生成
  makefile，与 EXAM 里 MRS 1.9.2 生成的金标**逐字节比对**。
  当前结果：MifareClassic 9 个文件全部 `IDENTICAL`；FreeRTOS 通过；
  HarmonyOS 语义一致（其金标是 MRS 2.1.0 生成的，变量块顺序/换行风格是另一代格式）。
  已复刻的细节：`-I` 顺序来自 `.cproject` 各 tool 的列表、链接目录用逐文件显式规则、
  局部目录用模式规则、SRCS→OBJS→DEPS 块顺序、DEPS 逆序、续行 LF / 其余 CRLF 的混合换行、
  空 warnings 段的双空格等。
- **配置项审计**（`tools/config-audit.mjs`）：解析全测试树 96 个工程的 `.cproject`，共
  98 个不同选项后缀，逐一对照本插件读取的集合；未覆盖项已全部补齐
  （`createflash.choice.ihexAndbinary` 双产物、objcopy 的 `-j .text/.data/自定义段`、
  objdump 的 `--debugging/--file-headers/--reloc/--syms`、`target.tune/saverestore/zmmul`、
  `c.linker.printf/printfloat/iqmath` 等）。
- **全量真实编译**（`tools/build-all.mjs`，并发跑 `build-test.mjs`）：
  **CH585 EXAM 95/96**、**CH587 EVT V1.0 EXAM 95/95**（exit 0，产出 elf/hex/lst/siz），覆盖 BLE 全系
  （含 MESH/IAP）、USB HOST/DEVICE、FreeRTOS、RT-Thread、HarmonyOS、NFCA 多级链接目录等。
  唯一失败 `CH585/NFCA/PICC/PICC_T2T` 为 **EVT V1.2 样例自身缺陷**：
  `wch_nfca_picc_t2t.c` 使用了全 EVT 树中不存在的宏 `ISO14443A_UID0_CT`（在 MRS2 中同样无法编译）。

## 架构

```
src/
├── core/          # 纯 Node，无 vscode 依赖，可独立测试
│   ├── xml.ts         # 零依赖 XML DOM（.project/.cproject 读写）
│   ├── projectFile.ts # .project：linkedResources、PARENT-N-PROJECT_LOC
│   ├── cproject.ts    # .cproject 类型化模型（按 superClass 读写 option）
│   ├── templateFile.ts# .template（下载配置）
│   ├── macros.ts      # ${workspace_loc:/...} 宏 / 链接目录路径解析
│   ├── toolchain.ts   # MRS2 安装探测 + sub_manifest.json 工具链解析
│   ├── flags.ts       # -march/-mabi/-Os/-I/-T/... 组装（移植自 MRS2 逻辑）
│   ├── scan.ts        # 源文件扫描（sourceEntries/excluding/链接目录）
│   ├── makefile.ts    # makefile/sources.mk/subdir.mk/objects.mk 生成器
│   └── flash.ts       # OpenOCD 烧录脚本生成
└── vscode/        # 集成层
    ├── projects.ts    # 工程注册表/活动工程/文件监视
    ├── tree.ts        # 工程树
    ├── tasks.ts       # 编译任务（ProcessExecution + problemMatcher）
    ├── flash.ts       # 烧录任务 / WCH-LinkUtility / MRS 终端
    ├── configView.ts  # 工程属性 webview
    └── linkedFolders.ts
```

工具组件全部来自 MRS2 安装目录（`resources/app/resources/win32/`）：
`components/WCH/Toolchain/*`（GCC8/GCC12/GCC15）、`others/Build_Tools/Make`、
`components/WCH/OpenOCD`、`components/WCH/Others/SWDTool`（WCH-LinkUtility）。

## 后续路线（对应 docs/vscode-plugin.md 里程碑）

- M2 调试闭环：cortex-debug 接入 + SVD 外设视图 + launch.json 生成
- M3 下载增强：WCH-Link 专属选项（读保护、DBus 速度等）
- M4 工程管理：新建工程向导（targetProcessor.json 模板）、Keil 转换、导出 CMake
