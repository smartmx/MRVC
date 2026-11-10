> ⚠️ **免责声明 / Disclaimer**
>
> **MRVC 是个人独立开发的开源项目，非 WCH（南京沁恒微电子）或 MounRiver 官方开发、官方支持或官方认可的项目**，与二者无隶属或合作关系；"MounRiver / MRS / WCH / WCH-Link" 等名称与商标归其各自所有者。本扩展**仅供开发与调试使用**——请自行评估风险，因使用本扩展造成的任何直接或间接损失由使用者自行承担。
>
> MRVC is an independent, unofficial project. It is **not developed, endorsed, or supported by WCH or MounRiver**. Names and trademarks belong to their respective owners. Intended for development and debugging use only; use at your own risk.

# MRVC — 在 VSCode 中打开、配置、编译、下载 MounRiver (MRS) 工程

一个 VSCode 扩展（插件名 **MRVC**），直接打开/配置/编译/**下载烧录** WCH（南京沁恒）MRS / MounRiver 工程，
无需 MRS2 IDE 本体（仅复用其安装目录中的工具链与工具组件）。
**三平台可用：Windows / Linux / macOS**（0.2.6 起；边界：POSIX 的下载/烧录与硬件操作通道已实现但未实测——OpenOCD 与 libmcuupdate FFI 路径都在位，需实体机验证）。
活动栏视图名为 "Project Explorer"；命令 ID 与设置键统一为 `mrvc.*`（V0.1.7 起，原 `mrs2.*` 历史前缀已退役——自定义快捷键需同步更新）。
扩展 ID 自 V0.1.7 起为 `smartmx.mrvc`（publisher 由 `mrvc` 更名为 `smartmx`）：装过旧 `mrvc.mrvc` 的用户升级时需**先卸载旧扩展**再安装新版——两者是相互独立、不会自动互相覆盖的扩展。
**懒激活（0.2.8 起）**：打开文件夹后 MRVC 不自动工作——**点开活动栏 MRVC 视图**，或从**命令面板执行 `MRVC: Open MRS Project / Solution`** 选中 `.wvproj`/`.wvsln`，才开始扫描工程、建立 IntelliSense 分析；此前激活为零开销。工程型命令（Build/Flash/属性页等）也会自动完成首次扫描——不会因"先命令后视图"而误报无工程。

## 功能

| 功能 | 说明 |
|---|---|
| 打开 MRS 工程 | 与 MRS 一致：**明确通过 `工程名.wvproj` 打开工程**（这是工程的标记与入口）。**合法性三文件**：`工程名.wvproj` + `.project`（可解析工程描述）+ `.cproject`（构建配置）**三者同时存在才进入发现树**——任一缺失的残缺目录（半删除/拷贝残留）会在发现阶段直接跳过；仅有 `.project` + `.cproject` 的 MRS1-era 旧目录不再进入树。**Open MRS Project / Solution 的文件过滤器只处理 `.wvproj` 与 `.wvsln`**（`.project`/`.cproject` 是附属文件，不是打开对象）；选中后在**新 VSCode 窗口**打开：选 `.wvproj` → 打开其所在目录并自动发现；选 `.wvsln` → 生成同名 `.code-workspace` 并在新窗口加载 solution；**打开整个 EVT/EXAM 目录用 VSCode 自带的 文件 → 打开文件夹**（扩展自动递归发现全部工程：最深 8 层嵌套）。**自动修复打包残留**：EVT 工程的链接文件夹若指向打包机器的绝对路径（如 `E:/.../EXAM/SRC`），首次打开时自动按"最近祖先+尾段"定位真实目录并回写为可移植的 `PARENT-N-PROJECT_LOC` 形式（与 MRS2 的 rewriteLinkedFolders 行为一致；MRS1 风格的 `<location>` 自动转换为 `<locationURI>`） |
| Solution（工程组） | 支持 MRS 新增的 `.wvsln` 解决方案：**仅当显式打开 `.wvsln` 文件时启用**——Open MRS Project / Solution 选中该文件后，生成同名 `.code-workspace` 并在**新 VSCode 窗口**打开，打开 MRVC 视图时自动加载 solution；树中显示为 solution 节点，成员工程按 MRS2 的 `BuildOrder=` 行（缺省按文件行序）排列、每个成员都是完整工程节点。解析兼容 MRS2 的宽松语法；生成的 solution 与 MRS2 完全兼容 |
| 生成 Solution | 树标题栏 `…` 菜单 → **Generate Solution From All Projects**：把当前已发现的全部工程生成一个 solution 并立即出现在树顶，MRS2 可直接打开 |
| 工程树 | 活动栏 MRVC 容器内的 "Project Explorer"：标题栏 4 个按钮（**Open Mrs Project**（文件对话框）/ **Open Mrs Folder**（只选目录）/ 折叠全部 / **刷新**——外部改名/新增/删除的工程会被自动识别与清理）。工程 → 链接文件夹（蓝色名称）/ 实体目录 / **根级源文件** / 编译输出目录（红色）。树只显示扫描到的工程本身，不列工程目录之外的散落文件。**源文件自动刷新**：工作区与每个工程内的源文件新建/删除/改名即时反映到树（400ms 防抖），配置文件有专属监听 |
| 文件管理 | 树节点右键（每类节点独立菜单）：New File / New Folder / **Copy→Paste**（插件内剪贴板，同名自动 `- copy` 递增，文件夹递归复制）/ Copy Absolute Path / **Copy Project Relative Path**（`${workspace_loc:/${ProjName}/…}` 形式的 CDT 逻辑路径）/ Copy File Name / Rename / Delete（均带确认）/ Open Containing Folder。链接文件夹禁用 Rename/Delete（防误删真实目录），其内部文件操作不受限 |
| 排除 / 恢复编译 | 文件与文件夹右键 **Exclude From Build / Include From Build**（与 MRS 的 Resource Configurations → Exclude from Build 等价）：写回 `.cproject` 活动配置（首个 `cconfiguration`）`sourceEntries` 的 `excluding` 列表（`|` 分隔；目录带命名 sourceEntry 时写目录内相对路径，否则写工程根相对全路径并在缺失时自动创建根 entry——与 MRS2 两种工程风格完全一致；**排除带命名 entry 的顶层文件夹 = 移除该 entry 并在根 entry 写入 token**，恢复时重建 entry）。被排除的资源在树中显示为**灰色**（行尾 `×`）并排在最后；下次编译生效；编译输出目录不可排除 |
| 编译 / 重建 / 清理 | 每次构建前从 `.cproject` 重新生成 CDT 风格 makefile（**默认按当前 MounRiver 2.3+/2.5 风格**——含强制 `-lm`、WCH 助手库走链接 recipe；1.9.2/2.1.0 布局保留为显式复现模式，golden 29/29 逐字节一致），再调 MRS 自带 `make`；错误进问题面板（`$mrvcgcc` problemMatcher）。行内 Build / Rebuild / Download 按钮 + 右键菜单；Build All / Clean All / Solution 构建批处理（单工程失败不中断、可取消带汇总）；**Pre-build / Post-build steps** 参与生成的 makefile |
| **Build Project And Download** | 工程右键 / 命令面板 **构建工程并下载**：编译 + 下载一条龙，编译成功才下载（与 MRS2 同名命令语义一致） |
| **Show Full Build Output** | 命令面板 / 输出面板右键打开上次构建的完整输出（MRS2 同款 buildContentRecord.txt 位置），单工程与批量构建均记录，尾部附**全量编译指令清单**（每个源文件的完整命令行） |
| **静态栈分析** | 设置 `mrvc.build.analysis` 开启后构建自动注入 `-fstack-usage` / `-fdump-rtl-expand`；**Static Stack Usage** / **Function Call Analysis** 命令生成分析报告（开源方案替代 MRS2 闭源解析器） |
| **C/C++ 缓存治理** | 命令面板 **MRVC: Clear C/C++ IntelliSense Cache**：一键清除 cpptools 的 ipch 缓存（模态确认、逐路径体积、安全护栏、锁定路径降级；浏览数据库 `.BROWSE.VC.DB` 不在范围）。设置 `mrvc.intellisense.cachePath` 自动把 `C_Cpp.intelliSenseCachePath` 写进各工作区 `.vscode/settings.json`（工作区覆盖用户级），把缓存引到指定盘符而非撑满 C 盘——留空则不写路径键；设置 `mrvc.intellisense.cacheSize`（MB，默认 5120 与 cpptools 一致，0 = 不管理）自动写入 `C_Cpp.intelliSenseCacheSize` 显式固定上限 |
| 新建工程向导 | `…` 菜单 → **新建 MounRiver 工程 / 静态库**：扫描 MRS2 SDK 模板（系列 → RTOS → 器件三步选择）→ 工程名 → **位置（可键入任意新路径自动创建，或点浏览按钮选择；默认上次创建目录）**，创建完成提示可一键在新窗口打开；renameProject 全套联动，MRS2 无损打开 |
| 下载烧录 | 工程行内 **Flash 按钮** / 右键 **Download**：通过 MRS2 的 OpenOCD 下载 `obj/` 产物（hex/bin，地址取自 `.template` 的 Address，双核工程自动选 `wch-dual-core.cfg`；`.template` 勾选 **Erase All** 时下载前全片擦除）；输出进任务终端，失败弹提示。**下载目标修正（0.2.9）**：`.template` 的 Target Path 指向的文件不存在、而本工程构建产物存在时（EVT 常跨工程引用，如 MACRAW 记录的是 TCP_SERVER 的 hex），下载**先弹窗询问是否修改 `.template`**——确认后回写为本工程产物（相对路径）并提示重新下载；选择"不修改"则保留原值、按回退目标照常下载；目标存在（含有意共享的产物）一律不动。工程从未编译（无任何构建产物）时提示**先编译工程**。**目标芯片一致性校验（0.2.9，与 MRS2/MRS3 一致）**：下载前用 `MRSFunc_GetLinkedMCUID` 查询 WCH-Link 上芯片的 flash-control id，与工程 `.template` 目标芯片的 flash-control id（MRS2 `getFlashControl` 同一语义：SDK `<series>-flash.json` 的 `id`，含 `special` 单型号覆盖与 zip 名容错）比对——两者都已知且不同时（如 CH32V307 工程接在 CH32V407 芯片上）模态警告，只有显式选择"仍然下载"才继续；**查询只在初始化完成（设备打开且 CompareVersion=0）时采信**，芯片库缺失、无 `wchlink.wcfg`、无 Link、初始化失败/需升级固件、未知 id 时一律按未知静默放行（不阻塞既有流程）。**WCH-Link 固件版本检测（0.2.8，只读）**：下载前核对已连接 WCH-Link 的固件版本与 MRS 安装 `wchlink.wcfg` 的期望值——过低时模态提示改用 **WCH-LinkUtility** 升级（MRVC 不刷写 Link 固件本身），检测失败静默放行 |
| Download Settings | 属性页 → Download → Download Settings（镜像 MRS2）：**读保护状态查询 / 使能 / 解除**、**调试保护**、**Linked MCU Type 查询（0.2.9：按 MRS2 同序 OpenDevice→CompareVersion→CloseDevice 初始化后查询，显示名按 SDK 系列解析回填）**、**Erase Code Flash**（By Pin NRST / By Power off）、**MCU Memory Assign**（Query/Apply）、**Operation Record** 操作日志；右侧完整编辑下载参数（MCU Type / Memory Type / Program Address / Debug Interface Mode / CLK Speed / Target File / Main Operations 八项），全部写回 `.template`（MRS2 无损打开）。硬件操作桥：Windows 走系统 32 位 PowerShell P/Invoke 调 McuCompilerDll.dll（MRS2 的 DLL 是 32 位，须进程外桥接）；Linux/macOS 进程内 koffi FFI 调 CommunicationLib 的 `libmcuupdate.so/.dylib`——与 MRS 自家扩展同款机制、同族 `MRSFunc_*` 导出；芯片 ID 与能力开关自动来自芯片库；**Debug Interface Mode 与 MRS2 一致恒可编辑**（`support_debugInterfaceMode=false` 的芯片——CH32V30x/CH5xx 等——照常显示，写回由驱动侧处理），其余不支持的选项按芯片自动灰显 |
| 芯片选择器 | 属性页 → General → Chip / Target：MRS2 同款 "Target MCU Type" 选择器——系列树（RISC-V/ARM 分组）→ 型号列表 → 信息区；数据实时扫描 MRS2 的 SDK 组件目录（40+ 系列），选中后自动填充 Series / MCU / Mcu Type / Address 并写回 `.template`；SDK 缺失时回退文本编辑 |
| Build Steps / Build Artifact | 属性页 → C/C++ Build 分组：**Build Steps**（Pre/Post-build 的 Command 与 Description，进 makefile）；**Build Artifact**（Artifact Type：Executable/Static Library；Artifact name 按 MRS 变量形式显示 `${ProjName}`；Artifact extension；Output prefix——产物名前缀与自定义扩展名在生成的 makefile 中生效） |
| Switch Project Type (C/C++) | 工程右键一键切换工程类型：写 `.project` 的 CDT C++ nature（`org.eclipse.cdt.core.ccnature`——与 MRS2 的判定键一致；旧版 MRVC 写入的假 ID 会在工程加载时自动规范化），**切到 C++ 时同时把 C 选项整组镜像进 C++ 选项集**（值/列表按原写法逐项复制、元数据按 CDT/MRS2 原生形态补齐，另补 C++ 编译器的 `<inputType>`），因此 C++ 属性页显隐、`.cpp` 源扫描、makefile 生成与 MRS2 打开后的构建都联动正确。**范围**：只处理 `.cproject` 的第一个配置（多配置工程的其余配置不镜像）；切回 C 会移除转换新增的 `<inputType>`，镜像的 C++ 选项值保留（与 MRS2 的 C++ 工程两套选项并存的形态一致） |
| 配置修改 | "MRVC: Project Properties"（右键工程打开）——**按 MRS2 原版属性页布局复刻**：Tool Settings 分类树（Target Processor / Optimization / Warnings / Debugging / Assembler / C Compiler / C Linker / C++ Compiler / C++ Linker / Create Flash Image / Listing / Print Size 各含子页），左侧树结构、右侧页内容、底部描述区 + **Apply/Cancel**。涵盖工具链（rvGcc）、全部 ISA 扩展、17 项警告、C/C++ 编译与链接、hex/bin 双产物、objcopy/objdump 细项、WCH 专属库（`-lprintf`/`-lprintfloat`/`-lIQmath_RV32`）。**Includes 页为表格编辑器**（Add/Edit/Delete，Add 支持 Project 内复选框树浏览或 Local Folder，工程内路径自动写成 `${project}/…` 宏）。仅 C++ 工程（Switch Project Type 切换）显示 C++ 配置页 |
| 外部链接文件夹 | 右键工程 → Add Linked Folder：同时更新 `.project`（linkedResources，支持 PARENT-N-PROJECT_LOC）与 `.cproject`（include 路径 + sourceEntries） |
| **Sync Setting Across Projects** | 树标题栏 `…` 菜单打开专用页面（Properties 同款两级导航树）：123 个可同步编译开关（bool/enum）逐行带**同步选择框**（默认不勾）与值控件（值取自活动工程）；勾选后 Apply 批量写入全部工程（C++ 选项自动跳过 C 工程并计数、可取消、输出频道逐工程 [OK/FAIL] 汇总） |
| **IntelliSense 自动配置** | 自动生成每个工程的编译数据库（`.vscode/mrvc/cc/`）并维护 `c_cpp_properties.json`——c 文件的宏定义/头文件路径随工程精确解析，无需手动配置 includePath；**工程树点选工程即切换分析上下文**（cpptools 多数据库数组，≥1.23.5） |
| MRS Tools 工具集 | **（仅 Windows 安装提供——Linux/macOS 的 MRS 不带这些 GUI 工具）** 树标题栏 `…` 菜单 → Tools 组（对齐 MRS2 Tools 菜单）：一键拉起 WCH-LinkUtility / WCH In-System Programmer (WchIspStudio) / WCH Touchkey Calibrate Tool / WCHGUIDesigner / HexBin Studio / Serial Port Debug Tool (COMTransmit)，分离进程启动；**当前生效的安装是 MRS3 时**（MRS2 没有该组件）额外多一项 **WCH 工具集（MRS3）** = WCHToolKit.exe |
| WCH-LinkUtility | **（仅 Windows 安装提供）** 命令面板 **Open WCH-LinkUtility**：直接拉起 MRS2 自带的 GUI 下载器（调试器模式切换/固件升级等深度操作）；也已归入 `…` 菜单 Tools 组 |
| MRS 命令终端 | 预置工具链/make/OpenOCD 的 PATH |
| 工具链选择 | `auto`（读 `.cproject` rvGcc/前缀）或强制 GCC8/GCC12/GCC15，均从 `sub_manifest.json` 动态解析 |

快捷键：`F7` 编译，`Shift+F7` 重建，`F8` 下载（与 MRS 一致）。

**推荐配套扩展**（随 MRVC 自动安装，也可在扩展市场单独安装）：
- **C/C++ Extension Pack**（`ms-vscode.cpptools-extension-pack`）——MRVC 的 IntelliSense（代码提示/跳转）由它消费；
- **Chinese (Simplified) Language Pack**（`MS-CEINTL.vscode-language-pack-zh-hans`）——中文界面。

**可选推荐**（按需手动安装）：`koalamer.labeled-bookmarks`（MRS2 同款书签/注释）、
`ms-vscode.hexeditor`（hex 文件查看/编辑）、`maziac.hex-hover-converter`（悬停即进制转换）。

**界面语言**：命令菜单跟随 VSCode 显示语言自动中英文切换（内置双语资源）；提示/报错等
运行时消息由 `mrvc.language` 设置驱动（`auto`/`en`/`zh-cn`，默认 auto）。

## 打包与安装（.vsix）

```bash
npm run compile      # 先编译（esbuild 打包出 out/extension.js）
npm run package      # 生成 mrvc-<version>.vsix（@vscode/vsce，--no-dependencies）
```

安装（三种任选）：
- VSCode 图形界面：扩展视图 → 右上角 `···`（Views and More Actions）→ **Install from VSIX...** → 选择生成的 `mrvc-<version>.vsix`（文件名跟随 package.json 的 version）
- 命令行：`code --install-extension mrvc-X.Y.Z.vsix`（X.Y.Z 换成实际版本号；不要写 `<version>`，尖括号在 cmd 里是重定向符）
- 直接把 `.vsix` 拖进扩展视图

> `.vscodeignore` 已配置只打包 `out/extension.js`(+map)、`media/*.svg`、README、package.json；
> 版本号升级后重新 `npm run package` 即可（输出文件名跟随 `package.json` 的 version）。

## 使用

> **前置条件：一个 MounRiver 安装或一份纯工具链**（[mounriver.com](https://www.mounriver.com/)）。
> MRVC 不自带工具链，而是复用 MounRiver 的 RISC-V 工具链（GCC8/12/15）、make、OpenOCD 与芯片库组件。
> **Windows**：MRS2 / MRS3 IDE（装在 `C:\MounRiver\...` 可零配置自动探测）；**Linux**：MRS3 IDE
> （.deb 装到 `/usr/share/MRS3/MRS-linux-x64` 自动探测；tar.xz 解包后手动指定）或纯工具链；**macOS**：
> MRS3 `.app`（放入 `/Applications` 自动探测；arm64 专用）或纯工具链（Intel Mac 的唯一形态）。

1. 三个设置键，启动时**逐个校验**（目录存在、是 MounRiver 安装、代次/启动程序/架构正确），
   **至少一个通过才启动**；全部失败则**扩展不启动**，弹出提示逐条列出失败字段与原因
   （不存在／不是安装／代次不符／缺启动程序／架构不匹配），可用 **[打开设置]**、
   **[使用检测到的 <安装>]** 一键修正（两个 IDE 路径填反了会给 **[交换两者]**）——
   修正后**自动启动，无需重载窗口**。
   - **MRS2 Install Path** / **MRS3 Install Path**：IDE 安装根。启动程序按平台识别：
     Windows `MounRiver Studio N.exe`；Linux `mounriver-studio N`（根目录或 `bin/`，tar 与 .deb 都认）；
     macOS 指到 `.app`（或其 `Contents/`），代次由 product.json 判定。
   - **Toolchain Only Path**：纯工具链根——`MRS_Toolchain_*` 解包内容（顶层 `Toolchain/` + `OpenOCD/`，
     无 IDE、无自带 make，使用系统 PATH 里的 make）。可单独使用，也可与 IDE 路径并存。
   - 留空 = 按平台探测惯例位置（Windows 零配置行为与 0.2.x 一致）；Linux/macOS 额外校验
     工具链二进制的 CPU 架构：**任一工具链与本机一致即通过**（全部不匹配才拒绝，如 Intel Mac
     装 arm64 专用的 macOS MRS3）；混合架构包（mac V2.4）按**实际选用的工具链**判定——选到
     异构那支会拒绝该次构建并提示改用原生工具链。
   - 多个安装并存时用 `mrvc.mrsVersion` 选偏好：auto 依次 MRS3 IDE → MRS2 IDE → 纯工具链
     （mrs2/mrs3 固定各有次序），回退一定明确提示。构建输出首行打印当前生效的安装。
2. 命令面板 `MRVC: Open MRS Project / Solution`：选 `.wvproj`/`.wvsln` 文件，或用 VSCode 自带的
   文件 → 打开文件夹 直接打开 EVT/EXAM 目录（扩展自动发现全部工程）。
3. `F7` 编译；产物在工程 `obj/`（或 .cproject 配置名对应目录）。
4. 接好 WCH-Link 后用工程行内 **Flash** 按钮或右键 **Download** 下载（Linux 需先装 MRS3 包内
   `beforeinstall/` 的 udev 规则；POSIX 通道未实测）；读保护/芯片查询等深度操作在属性页 →
   Download → Download Settings（POSIX 走 koffi FFI，未实测）。

## 开发

```bash
npm install
npx tsc              # 生成 out/** 分文件产物（测试脚本依赖其中的 out/core/*.js）
npm run compile      # 再 esbuild 打包 out/extension.js（会覆盖同名 tsc 产物）
npm run watch
npm run golden       # 金标 makefile 逐字节比对（tools/golden-check.mjs）
npm run package      # @vscode/vsce 打包 .vsix（--no-dependencies）
```

> **顺序陷阱**：`npx tsc` 与 `node esbuild.js` 都会写 `out/extension.js`——tsc 写的是几十 KB 的模块入口，
> esbuild 写的是近 1 MB 的完整 bundle（发布用）。**必须先 tsc 后 esbuild**；顺序颠倒会把 bundle 覆盖成小文件，
> 打出的 vsix 缺失全部功能——`npm run verify` 的体积哨兵能拦下这种顶替，打包后必跑（见下）。

发布工序固定为：**`npx tsc`**（生成测试用的分文件产物）→ **`node esbuild.js`**（生成发布 bundle）→
**`npm run package`** → **`npm run verify`**（`tools/verify-vsix.mjs`，核对包内 bundle 与清单）；发布同步再跑
`node tools/sync-to-mrvc.mjs`。esbuild 之后不要再跑 tsc——那会把发布 bundle 覆盖回小文件。

测试脚本在 `tools/`，均为纯 Node 断言，直接 `node tools/<脚本>` 运行：

- `roundtrip-test.js` — 配置回写/链接文件夹/工程重命名/C++ nature/Build Steps·Artifact 往返
- `exclude-test.js` — 排除/恢复编译语义（含 CH585 混合风格与真实工程回归）
- `rename-test.js` / `output-test.js` — 工程重命名与输出目录清理
- `solution-test.mjs` / `discover-test.mjs` — solution 解析生成 / 工程发现
- `flash-test.mjs` — 烧录 cfg 生成（地址覆盖/verify-reset 组合/非法地址）
- `wlink-test.mjs` — WCH-Link 桥（P/Invoke 脚本生成/load.wcfg/降级路径）
- `intellisense-test.js` — IntelliSense 双库生成/切换/JSONC 保护/哈希门控
- `mrstools-test.js` — MRS Tools 六工具路径解析与缺失降级
- `webview-test.js` — 属性页/Sync 页真实渲染（脚本语法、注入探针、批量写回）
- `mass-test.mjs` — **TEST 全树批量回归**（解析/扫描/排除/芯片库/makefile 字节稳定性，覆盖全部工程）
- `makefile-dollar-test.js` — makefile `$` 转义回归（用户 `$` 翻倍，`$@`/`$(VAR)` 等 make 语法原样保留；守护“生成汇编清单”的 `.lst` 开关）
- `build-test.mjs <EVT工程路径>` — 真实工具链编译单工程；`build-all.mjs` 全量批跑——**⚠ 仅限隔离副本：它会生成并覆写真实工程的 `obj/`**（round5 曾以此覆写过 EVT 金标，恢复工具见 `restore-goldens.mjs`）；且其工程枚举只看 `.cproject`，是**底层工具链批测工具，不是插件三文件发现的模拟**（插件发现口径以 `discover-test.mjs` 为准）。**请勿对真实 EVT 树直接运行，常规回归用只读套件**（discover/config-audit/golden）
- `print-menus.mjs` — 打印各类树节点右键菜单排序（开发辅助）
- `verify-vsix.mjs` — 打包产物核对：自动先从 src 重建 bundle，再与 vsix 逐字节断言（manifest/NLS/changelog/bundle/版本号/泄漏）——改源码忘 esbuild、或包被旧产物顶替都会被拦，发布前必跑
- `mrsinstall-test.js` — 安装选择策略（win32/linux/darwin 三平台布局 / MRS2·MRS3 IDE + 纯工具链三候选 / 架构门禁 / 零配置采用 / 字段误填与填反 / 回退；经 `setHostPlatformForTests` 在任意宿主上测全平台）
- `mrs-install-probe.mjs <安装根> <工程> [cpp]` — 钉住指定安装（MRS2 / MRS3）真实构建工程，支持 PARENT-N 链接工程；加 `cpp` 则先做 C→C++ 类型转换再构建（转换功能回归）
- `sync-to-mrvc.mjs` — develop→MRVC 发布同步（按清单复制 + 逐文件哈希校验；**仅 develop，不入发布仓库**，它操作的是同级 MRVC 克隆）

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
│   ├── projectFile.ts # .project：linkedResources、PARENT-N-PROJECT_LOC、重命名联动、C/C++ nature
│   ├── projectType.ts # C/C++ 类型转换（nature 规范化 + C 选项镜像进 C++ 集，含旧假 ID 迁移）
│   ├── cproject.ts    # .cproject 类型化模型（按 superClass 读写 option、excluding、Build Steps/Artifact）
│   ├── templateFile.ts# .template（下载配置；无损重写保留注释空行）
│   ├── macros.ts      # ${workspace_loc:/...} / ${project}/... 宏 / PARENT-N 解析
│   ├── toolchain.ts   # MounRiver 安装探测（MRS2/MRS3 IDE + 纯工具链三候选、Linux/macOS 布局与架构门禁）+ sub_manifest.json 工具链解析
│   ├── flags.ts       # -march/-mabi/-Os/-I/-T/... 组装（移植自 MRS2 逻辑）
│   ├── scan.ts        # 源文件扫描（excluding 语义、大小写折叠、装饰映射）
│   ├── solution.ts    # .wvsln 解析 / 生成（含 BuildOrder）
│   ├── output.ts      # 输出目录清理（边界守卫）
│   ├── makefile.ts    # makefile/sources.mk/subdir.mk/objects.mk 生成器
│   ├── discover.ts    # 工程发现
│   ├── chipdb.ts      # 芯片数据库（扫描 MRS2 SDK：型号/地址/chipID/能力开关）
│   ├── wlink.ts       # WCH-Link 操作桥（按 DLL 位数选 32/64 位 PowerShell P/Invoke McuCompilerDll）
│   ├── intellisense.ts# compile_commands 条目构建（private/shared 拆分与归并）
│   ├── mrsTools.ts    # MRS2 Tools 六工具路径解析
│   └── flash.ts       # OpenOCD 烧录脚本生成
└── vscode/            # 集成层
    ├── projects.ts    # 工程注册表/solution 注册表/文件监视（配置+源文件自动刷新）
    ├── tree.ts        # 工程树（solution 节点、根级文件、排除置底、装饰）
    ├── tasks.ts       # 构建任务管线（Build/Clean/Rebuild All、Solution、输出清理）
    ├── flash.ts       # Download 命令（OpenOCD 引擎）与 cfg 选择
    ├── configView.ts  # 工程属性 webview（MRS2 布局复刻：芯片选择器/Includes 表格/Download Settings）
    ├── intellisense.ts# .vscode 双库写入与工程上下文切换（cpptools 多数据库）
    ├── syncPage.ts    # Sync Setting Across Projects 页面（批量同步编译开关）
    ├── mrsTools.ts    # MRS2 Tools 工具启动器
    ├── fileOps.ts     # 文件管理右键（新建/复制/粘贴/重命名/删除/路径复制）
    ├── exclude.ts     # Exclude/Include From Build 命令与装饰数据
    ├── renameProject.ts # Rename Project / Sync Project Name from Folder
    └── linkedFolders.ts
```

工具组件全部来自 MounRiver 安装目录（`resources/app/resources/win32/`，MRS2 与 MRS3 布局相同）：
`components/WCH/Toolchain/*`（GCC8/GCC12/GCC15）、`others/Build_Tools/Make`、
`components/WCH/OpenOCD`、`components/WCH/Others/SWDTool`（WCH-LinkUtility）、
`components/WCH/Others/CommunicationLib`（WCH-Link 操作 DLL）、`components/WCH/SDK`（芯片数据库）。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。
