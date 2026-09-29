# MRVC 更新日志

## V0.1.4（2026-09-29）

相对 V0.1.3。IntelliSense 分类模型按引用计数重做；修复 CH32 系列下载失败。

### 新增

- **构建后静态分析**（开源方案替代 MRS2 的闭源解析器）：设置
  `mrvc.build.analysis` 开启后，构建自动注入 `-fstack-usage`（每个函数
  一个 .su 栈帧文件）与 `-fdump-rtl-expand`（调用关系转储）；工程右键
  **Static Stack Usage / Function Call Analysis** 汇总生成 Markdown 报告
  （按栈帧大小排序、动态栈帧告警、调用边列表）。MRS2 的静态栈分析依赖
  闭源 static-stack-usage.exe、调用图依赖 perl/egypt——MRVC 方案仅用
  GCC 自带能力，无外部依赖
- **自定义工具链**（`mrvc.customToolchains` 设置）：name/path(/prefix)
  数组，构建/IntelliSense/烧录/CMake 全链路生效——同名（大小写不敏感）
  覆盖 MRS2 安装的工具链，prefix 可从 bin/ 自动探测（含 .exe 感知）。
  对齐 MRS2 的 Local Toolchain 功能（其存储为 toolchain_local.json +
  `${Local:Toolchain:名}` 标记），MRVC 用设置承载、按名匹配
- **逻辑移除与恢复**（对齐 MRS2 Remove 命令语义，补齐其缺失的恢复入口）：
  树右键 **Delete** 弹窗改为双按钮——**Remove**（逻辑移除：从树和编译中
  隐藏，文件留在磁盘，存储写入 `.project` 的 `filteredResources`（Eclipse
  标准 multiFilter 结构，与 MRS2 Remove 完全互读））/**Delete**（真删磁盘，
  原行为）；新增 **Restore Removed Resources** 命令（工程右键 +
  命令面板，多选恢复——MRS2 无恢复入口，只能重新添加同名文件间接触发）。
  被移除资源对构建扫描/IntelliSense/树三层同时生效；外部 Eclipse 过滤器
  原样保留；恢复后扫描器立即可见
- **新建工程向导**（对齐 MRS2 createProject / createStaticLib 初步能力）：
  树标题栏 `…` 菜单新增 **New MounRiver Project / New MounRiver Static
  Library**——三步 QuickPick 选芯片（系列 → RTOS → 器件模板，扫 MRS2 SDK
  的 `<SDK>/<架构>/<系列>/<RTOS>/<芯片>.zip` 模板库，本机 202 个模板），
  输入工程名并选位置后生成完整可编译工程：解压模板（自带
  .project/.cproject/.launch/.template + 全部源码）→ 写空 `<名>.wvproj`
  标记 → 按 MRS2 renameProject 语义改名（.template Target Path/.launch/
  .wvproj 全套联动，目录不动）→ 自动载入树并设为活动工程。同名目录/非法名/
  路径穿越拒绝；改名失败降级为模板名（工程仍可用）
- **界面语言设置 `mrvc.language`**（`auto`/`en`/`zh-cn`，默认 auto 跟随
  VSCode 显示语言，重载窗口生效）：运行时消息、输入框提示、树描述的
  中英文切换；译文参考 MRS2 的中文用语（请选择文件夹/确定/取消/已从编译中
  排除等）。命令面板标题保持英文（与 MRS2 英文标题一致，便于搜索），
  package.json 静态清单无法运行时切换。设置变更即提示一键重载窗口。
  覆盖全部运行时消息：文件管理/重命名工程/同步工程名/排除恢复/同步页/
  树节点描述（含 14 个模块约 100 键）
- **Show Full Build Output**（对齐 MRS2 showFullBuildOutput）：单工程构建的
  完整 make 输出同步写入 MRS2 同款位置
  （`%TEMP%/mrs-cache/<工程名>-<md5(工程路径)>/buildContentRecord.txt`），
  命令面板/输出面板菜单随时在编辑器打开该完整日志（此前问题面板只收错误，
  完整编译命令行无处可查）。实现：构建经生成的 `mrs2-build.cmd` 包装脚本
  执行（重定向 + `type` 回显 + `exit /b %errorlevel%` 传播退出码）——
  包装文件引号固定，规避 ShellExecution 字符串在 cmd 下的嵌套引号断裂
  （"文件名、目录名或卷标语法不正确"）；进程级重定向才能捕获 `-jN` 下
  编译器子进程的 stderr；`$mrvcgcc` problemMatcher 解析 `type` 回显，
  问题面板不受影响
- **CMake 导出**（工程右键，对齐 MRS2 的 generateCMakeList/exportAsCMake）：
  **Generate CMakeLists File** 在工程根生成 `CMakeLists.txt` 并打开——双语
  使用说明（MRS2 原文）、工具链 set 块（GCC/OBJCOPY/OBJDUMP/SIZE/AR，
  `CMAKE_*_COMPILER_WORKS=TRUE` 跳过编译器探测）、相对路径源清单与
  include_directories（链接文件夹内容以 `<链接名>/<相对路径>` 呈现——与导出
  目录的"链接目标拷入同名子目录"布局一致，跨机器可构建）、C/C++/ASM 旗标取自
  与 makefile 同一套选项模型（-march/-D/-T 完全一致）、POST_BUILD 产物步骤
  （hex/bin 按 createflash 配置、lst、size）；**Export As CMake Project**
  把工程拷贝到用户选定目录（跳过 obj/.git/.vscode 等）+ 链接目标拷入同名
  子目录 + 可移植 CMakeLists——纯 cmake 环境即可构建（Linux CI 友好）
- **Solution 生命周期补全**（对齐 MRS2 的 addProjectToSolution(ByBatch) /
  setBuildOrder / closeSolution）：solution 节点右键新增四项——
  **Add MRS Project to Solution**（选择任意 .wvproj/.project 追加为成员，
  现有文件内容逐字节保留、重复成员自动跳过）、**Batch Import of Projects**
  （选一个目录，其下发现的全部工程批量追加）、**Identify Build Order**
  （QuickPick 逐轮选出编译顺序，仅重写 `BuildOrder=` 行——其余行逐字节保留、
  行位置与 MRS2 相同=首行之后；Build Solution / Clean Solution 立即按新序执行）、
  **Close Solution**（关闭当前窗口，MRS2 closeExplorer 同款）。
  MRS2 的拖拽排序对话框在 VSCode 扩展语境下以多轮 QuickPick 等价实现
- **Change Linked Location**（链接文件夹右键，对齐 MRS2 的
  changelinkedFolderPath）：把已链接的外部文件夹重新指向新目录——**链接名与
  `.cproject` 中以它为键的全部引用（include 路径、logic 路径、sourceEntries）
  一律不动**，构建配置无缝重定向；InputBox 预填旧位置，支持尚未创建的目标目录
  （树中以未折叠节点渲染），MRS1 式 `<location>` 元素自动升级为 `<locationURI>`
  可移植形式。链接节点右键第 3 项（`mrs2link@3`）

### 修复

- **CH32 系列下载失败**（日志特征：`no flash bank found for address 0x00000000` +
  `checksum mismatch / Verify Failed`，实际一个字节未写入）：OpenOCD 的
  `wlink_set_address` 设定的是 flash bank 基址，而 `program` 的镜像偏移需单独
  传入——旧配置只设 bank 基址不带偏移，WCH hex（链接在 0x00000000）的段落在
  bank 之外，写入被静默跳过后校验必然失败（CH58x 地址为 0，偏移 0 恰好等价，
  因此未暴露）。现在 `mrs2_flash.cfg` 双传地址：
  `wlink_set_address <addr>` + `program "<固件>" <addr> verify reset exit`
- **非 0 ORIGIN 链接脚本的固件**：`program` 偏移按"下载地址 − hex 自身基址"
  计算（解析 Intel HEX 数据记录取最低装载地址）——hex 已链接在物理基址时偏移
  归 0，不再被二次平移抛出 bank；bin 固件与基址为 0 的 hex 行为不变
- **配置变更后当前上下文参数滞后**：修改宏/包含路径（Apply、同步页批量写入）
  后，当前工程的 context 类条目在 `_active.json` 里沿用旧值直到手动切换工程。
  现在配置重算完成后自动把当前上下文工程的再生数据库刷入 `_active.json`
  （switchContext 内容门控：无变化零写入、不重启 IntelliSense）；工程被移除时
  自动清除上下文
- **非 0 ORIGIN 组合的 bank 窗口加固**：下载地址低于 hex 自身基址时（如受芯片
  别名机制启发把模板 Address 写 0 而 ld 用 0x08000000），`wlink_set_address`
  自动上移到镜像基址、偏移归 0——下载地址在 WCH 驱动里纯属 OpenOCD 查表簿记
  （物理落点 = chipiaddr + R − hexBase，与它无关），移窗后四种组合全通
- **中文路径工程编译失败**（日志特征：所有 `-I` 头文件报
  `No such file or directory`，同一工程在英文路径机器正常）：makefile 产物
  此前以 UTF-8 写盘，而 make/gcc 经系统 ANSI 码页（中文 Windows = GBK）读取，
  路径含中文时命令行字节变乱码。现 makefile 与 `mrs2_flash.cfg` 按**系统 ANSI
  码页写盘，完整对齐 MRS2 的 `getSystemANSIEncoding` 条件分支**：
  ACP 936（中文）→ GBK；其它码页（含 UTF-8 Beta 65001、西文 1252）→ UTF-8；
  非 Windows → UTF-8；检测失败回退 GBK（同 MRS2 兜底）。检测经注册表
  `HKLM\...\Nls\CodePage\ACP`（MRS2 用原生 DLL 调 GetACP，此处无原生依赖）。
  ASCII 内容字节不变（金标比对基线不变）。实验证据：同一份中文路径 makefile，
  UTF-8 编译失败 / GBK 编译成功（真 make + GCC8）。引入首个运行时依赖
  iconv-lite（esbuild 已打入 bundle）
- **金标比对 FreeRTOS 未通过**（外部审查发现）：EVT 工程的 include 列表可含
  磁盘上不存在的目录（FreeRTOS 的 APP 条目），MRS 金标生成器会丢弃该条目
  （8 条 -I 只输出 7 条），MRVC 此前全量输出导致逐字节比对失败。现 include
  类路径（C/C++/ASM 的 include.paths）对解析成功但磁盘不存在的目录按 MRS
  行为丢弃；FreeRTOS 金标恢复逐字节一致（18 identical，比基线多 5 个文件）
- **HarmonyOS 2.1.0 模板对齐**（外部审查发现）：CDT 不同代次的 subdir.mk
  变量块顺序不同——MRS 1.9.2 金标为 SRCS → OBJS → DEPS 分组，MRS 2.1.0
  金标为每个 SRCS 后紧跟 DEPS。makefile 生成器新增 `blocksFirst` 模式，
  golden-check 按金标 header 的 MRS Version 选择（1.x=分组式 / 2.x=交错式）。
  同轮按金标逐行比对将 2.1.0 代次的头部布局（header 后无空行、`RM :=` 前
  单空行）、`all:` → `main-build` 递归目标、配方单 `@` 前缀、
  `-fmax-errors=20` 位置、SECONDARY 块行尾一并对齐——HarmonyOS 剩余差异
  为 2.x 模板的行级细节（配方尾行、`size` 前缀、`objects.mk` 空行、
  `sources.mk` 声明顺序）与两处命令内空格，选项序列本身已一致。
  工具修复：golden-check 工具链前缀改为从金标文本推断（消除固定前缀假象）、
  `--loose` 计数改互斥三计数；mass-test 零工程时 `SKIPPED` + exit 2
- **删除 obj 后 MRVC 树不刷新**：obj 节点此前无论目录是否存在都无条件渲染，
  删除（MRVC 右键删除或批量命令）后即使重扫仍显示。现在：obj 节点仅在目录
  存在时渲染；溢出菜单 Delete Output Files / Delete Output Directories 批量
  完成后显式刷新树（输出目录不在任何文件监听覆盖内）；单工程 Clean 任务
  （mrvc-clean）结束补入树刷新名单；每个工程新增**输出目录监听**
  （`{obj,obj/**}`，与源码变更同用 400ms 防抖）——在 VSCode 资源管理器或系统
  里直接删除/新建 obj 及其内容也会自动刷新，陈旧节点点击报"找不到文件"的
  场景消除（编译期间的文件风暴折叠为一次刷新）

### 变更

- **浏览兜底**：MRVC 配置补 `includePath`（`${workspaceFolder}/**` 递归通配 +
  全部工程引用的绝对 include 目录并集）——不在编译数据库里的文件（被排除、
  未挂接工程）降级浏览时头文件可解析、符号可跳转（cpptools 的降级提示无法
  关闭，但不再裸奔；`C_Cpp.mergeConfigurations` 保持默认 false 不混入精确条目）
- **下载地址来源链**：设置 → 工程 `.template` 的 Address →
  **按源文件名芯片前缀推导**（EVT 树不带 .template；规则取自 MRS2 SDK 各系列
  flash.json：CH5xx 无线家族 = 0x00000000，其余 ch32*/CH564/CH64x = 0x08000000）→
  兜底 0x00000000
- **IntelliSense 分类重做（引用计数模型）**：`_shared.json` 改为收纳**仅被一个
  工程编译的文件**（参数确定，任何上下文都能正确解析）；被多个工程引用、参数
  可能不同的文件（共享 SRC/HAL/LIB 树）归入各工程私有库（本工程条目 + canonical
  回退补齐整个 context 类），随工程切换进入 `_active.json`。任何时刻
  `_shared ∪ _active` 覆盖全部源文件——切换上下文不会出现
  "在 compile_commands.json 中找不到"。compileCommands 保持两项
  `[_shared.json, _active.json]`

## V0.1.3（2026-09-27）

相对 V0.1.2。核心新增：静态分析配置注入、批量设置同步页面、MRS Tools 工具集；
定版审查修复 1 高 + 4 中问题（含一个 0.1.2 就存在的 Windows 烧录路径致命 bug）。

### 新增

- **IntelliSense 配置注入 + 按工程切换上下文**（修复"c 文件解析报错"）：
  为每个工程生成独立的**私有**编译数据库
  `.vscode/mrvc/cc/<工程名>-<路径哈希>.json`（工程根下每个源文件一条真实编译命令：工程自己的
  -D 宏、解析为绝对路径的 -I/-isystem/-include、-std；编译器为工具链 gcc 绝对路径；
  工程名重复用路径哈希消歧）；全部工程链接的共享文件（SRC 树）归并为
  `.vscode/mrvc/cc/_shared.json`（define/include 并集，头文件守卫保证安全）。
  `c_cpp_properties.json` 的 `MRVC` configuration 以 **compileCommands 数组**同时指向
  `_shared.json` 与 `_active.json`（cpptools ≥1.23.5 多数据库；不触碰用户其他配置；
  JSONC 解析失败时绝不覆写）。**在工程树中点选工程时，该工程的私有库自动复制为
  `_active.json`**——cpptools 检测文件变化重新解析，c 文件的宏/头文件上下文切换为
  选中工程的。触发：工程发现完成后 / 配置变更后（1s 防抖）/ 构建结束后 /
  手动命令 **Update IntelliSense Configuration**；全部写入经内容哈希门控——
  纯源文件保存不重写、不重启 IntelliSense 索引
- **Sync Setting Across Projects 页面**（`…` 菜单）：Properties 同款两级导航树，
  123 个可同步编译开关（bool/enum）逐行带同步选择框（默认不勾）与值控件（值取自
  活动工程）；勾选后 Apply 批量写入全部工程（C++ 选项自动跳过 C 工程并计数、可取消、
  输出频道逐工程 [OK/FAIL] 汇总）；enum 未设置项种子为 default（与属性页一致）
- **MRS Tools 工具集**（`…` 菜单 → Tools 组，对齐 MRS2 Tools 菜单）：一键拉起
  WCH-LinkUtility / WCH In-System Programmer (WchIspStudio) / WCH Touchkey Calibrate
  Tool / WCHGUIDesigner / HexBin Studio / Serial Port Debug Tool (COMTransmit)——
  路径复刻 MRS2 的组件/固定两层布局，分离进程启动
- **宏定义冲突检测**：属性页三处 Preprocessor（C/C++/Assembler）的 -D 宏在 Apply 时
  跨页比对，同名不同值弹出模态警告（列出冲突双方页面与值），Apply anyway / Go back
- **F8 下载快捷键**（与 MRS 一致；会覆盖 VSCode 默认的 Go to Next Problem，
  仅在有活动工程时生效）
- 行内按钮顺序调整为 **Download（蓝色箭头，MRS2 同色）→ Build → Rebuild**

### 修复（定版审查）

- **[P1] Windows 烧录路径**：OpenOCD cfg 的 `program` 路径正斜杠化——Jim Tcl 在双引号
  内吞反斜杠，`E:\x\y.hex` 会变成 `E:xy.hex`（0.1.2 起即存在，Windows 烧录实际从未
  通过此路径成功过）；空格保护（引号）保留。测试补反斜杠 fixture 锁定
- **[高] c_cpp_properties.json 数据保护**：按 JSONC 解析（剥注释/尾逗号/BOM），
  仍失败时完全不触碰用户文件（原实现会以仅含 MRVC 条目的内容整体覆写）
- **[中] Sync 批量循环让出事件循环**：取消按钮真正可响应、进度条重绘、扩展宿主
  不再阻塞；取消后文案如实显示 Cancelled；C++ 跳过逐工程计数并体现在 [OK] 行
- **[中] enum 种子值**：未设置的枚举选项种子为 default 而非首选项（同步不再把
  "未设置"写成显式值）
- **[中] IntelliSense 空工程早退**：未解析出任何工程时不写 .vscode（避免污染泛
  Eclipse 工作区）；cStandard 仅输出 cpptools 合法值（ansi/iso9899 回退 gnu11）
- **[中] IntelliSense 汇编参数组**：`-x assembler-with-cpp` 死三元修正——
  usepreprocessor=false 的工程 IntelliSense 与 makefile 一致使用 `-x assembler`
- 清理：mrs2.nop 死注册移除；Sync 输出频道复用（不再每次 Apply 泄漏同名频道）

### 已知限制（记录在案）

- 共享 SRC 文件的 IntelliSense 上下文跟随**工程树点选**或**正在编辑的文件所属工程**
  （MRS2 同款归属模型：文件位于工程根或其链接文件夹内即归属）
- 宏冲突检测不剥离 `-D` 前缀/引号形式（该输入本身会破坏构建）
- F8 覆盖 VSCode 默认 Go to Next Problem（有活动工程时）

### 测试

- 新增 `tools/intellisense-test.js`（18 断言：条目/宏/路径/哈希门控/用户配置保留/
  配置变更再生）、`tools/mrstools-test.js`（8 断言：六工具真实路径/缺失降级）、
  webview-test 扩至 28 断言（Sync 页面渲染/注入探针/双工程批量写回/宏冲突边界）、
  flash-test 扩至 29（反斜杠 fixture）
- 12 套件全绿；mass-test 972 工程无回归；真实工具链编译 CH585 / CH32H417 双核通过

## V0.1.2（2026-09-26）

相对 V0.1.1 的全部变更。核心改进：新增下载/烧录能力、属性页对齐 MRS2、全代码审查修复（11 个 P1、35 个 P2）、
972 个真实工程回归验证与三个芯片族真实工具链编译通过。

### 新增

- **Download Settings 页**（属性页 → Download → Download Settings，镜像 MRS2 布局）：
  - Operations 区：读保护状态查询 / 使能 / 解除、调试保护、Linked MCU Type 查询、
    Erase Code Flash（By Pin NRST / By Power off）、MCU Memory Assign（Query/Apply，A-F 组容量选项自动填充）、
    Operation Record 操作日志
  - Download Parameters 区：MCU Type、Memory Type、Program Address、Debug Interface Mode、
    CLK Speed、Target File（文件选择）、Main Operations 八个勾选项——全部写回 `.template`，MRS2 可无损打开
  - 硬件操作通过系统自带 32 位 PowerShell（SysWOW64）P/Invoke 调用 MRS2 的 McuCompilerDll.dll，
    零新增依赖；芯片 ID 与能力开关自动来自芯片库
  - 绑定 **F8** 快捷键（与 MRS 一致）
- **Chip / Target 页**：MRS2 同款"Target MCU Type"芯片选择器——系列树（按 RISC-V/ARM 分组）→
  型号列表 → 信息区，数据实时扫描 MRS2 的 SDK 组件目录（40+ 系列），选中后自动填充
  Series / MCU / Mcu Type / Address 并写入 `.template`；SDK 缺失时回退文本编辑
- **Build Steps 页**：Pre-build / Post-build 的 Command 与 Description
  （CDT 属性名 `prebuildStep`/`preannouncebuildStep` 等与 MRS2 完全一致），命令进入生成的 makefile
- **Build Artifact 页**：Artifact Type（Executable / Static Library，makefile 同步切换链接/归档规则）、
  Artifact name（按 MRS 变量形式显示 `${ProjName}`）、Artifact extension、Output prefix（产物名前缀生效）
- **Switch Project Type (C/C++)** 工程右键命令：切换 CDT cxx nature——C++ 属性页显隐、
  `.cpp` 扫描与 makefile 生成联动（与 MRS2 的判定键完全一致）
- **Workspace Files 树节点**：工程同级目录的散落源文件（`.c/.h/...`）列出并可编辑，随文件系统自动刷新
- **工程根级文件显示**：`11.c` 这类根级源文件出现在工程节点中（管理文件 `.wvproj/.template/.launch` 保持隐藏）
- **属性页 Includes 页表格编辑器**：Include paths / system paths / files 三组均为
  Add / Edit / Delete 表格；Add 弹出 Project（工程内复选框树，任意深度懒加载，链接目录与 obj 外
  一切可选，排除输出目录）/ Local Folder 双模式浏览，工程内路径自动写成 `${project}/…` 短宏
- **属性页字符串选项大文本框**：Other flags 等单行输入升级为可拖拽调整的多行编辑框（Apply 时折叠换行）

### 改进

- **属性页结构对齐 MRS2**：Target Processor / Optimization / Warnings / Debugging 为顶层页；
  Assembler 补 Warnings 子页与 `-nostdinc`/`-E` 开关；Create Flash Image / Listing / Print Size 拆为独立页；
  C++ Compiler / C++ Linker 重组为分组子页并补 `-nostdinc++`、C++ 特有警告等选项；仅 C++ 工程（cxx nature）
  显示 C++ 页
- **树**：每类节点（工程/文件/文件夹/链接目录/输出目录/产物文件/解决方案）右键菜单独立声明，
  顺序按工程操作 → 文件操作 → Add Linked Folder → Properties 重排；工程行内按钮为 Build / Rebuild / Download
- **自动刷新**：工作区级 + 每工程源文件 watcher（400ms 防抖）——新建/删除/改名源文件即时反映到树，
  无需手动刷新；Build All / Clean All / Download 结束同样刷新
- **芯片数据库**（`chipdb`）：运行时扫描 MRS2 SDK 目录得到 40+ 系列的型号表、下载地址、
  WCH-Link chipID 与能力开关，MRS2 更新 SDK 后自动同步
- 菜单 ID 与设置键沿用 `mrs2.*` / `mrvc.*`；task definitions 补全 `mrvc-flash` / `mrvc-clean-all`

### 修复

- **MRS2 兼容性（P1）**：
  - Build Artifact / configName 等属性的读写宿主元素修正（真实文件在内层 `<configuration>`，此前读写外层包装）
  - Pre/Post-build 描述属性名改为 CDT 真实的 `preannouncebuildStep` / `postannouncebuildStep`
  - outputPrefix 读写移至 C/C++ Linker `<tool>` 元素（MRS2 的真实位置）
  - 切换 Artifact Type 时同步 `buildArtefactType` 独立属性（MRS2 读取优先）
  - 新建 `<sourceEntries>` 挂到正确父元素（内层 configuration）
  - 修复打包残留链接时把 PARENT URI 写进 `<location>`（现转换为 `<locationURI>`，MRS2 不再显示坏链）
- **稳定性（P1）**：
  - 工程重复发现时复用实例，`active` 工程不再被孤儿化（烧录/属性页读到陈旧数据）
  - 批量构建中任务启动失败不再挂死进度条与互斥锁
- **其他（P2 摘要）**：
  - 烧录 `program` 路径加 Tcl 引号（含空格工程名不再失败）
  - XML 序列化无损化：文档级空白/CRLF 缩进/新建节点格式/闭合标签容错/CDATA/十六进制实体；
    `.template` 重写保留注释与空行
  - makefile：根目录源文件时 subdir.mk 不再重复 include；clean 目标对 C++ 工程包含全部依赖变量
    （C 工程保持金标逐字节一致）；configName 路径逃逸净化
  - 属性页 webview：内联 JSON 全部转义 + CSP（防工程名注入）；路径浏览加工程根包含校验
  - 并发任务按 execution 身份匹配退出码（批量构建/烧录不再互相错配）；烧录监听器失败路径释放
  - Exclude 状态查询与扫描器大小写折叠一致化；裸 token 排除装饰覆盖链接目录深层
  - 自粘贴守卫大小写折叠；重命名校验空格；reveal 产物不存在时定位目录；跨盘链接生成 `file:/` URI；
    toolchain 的 win32 目录直配修复；`repairLinkedResources` 不再丢子路径
  - WCH-Link 桥脚本加 UTF-8 BOM（中文安装路径）、整片擦除超时放宽至 120s、ok 语义纯净化

### 定版前第二轮复审修复（同日）

- **XML 序列化 P1 回归修复**：上一轮 #doc 空白修复引入"声明前多一个换行"（prolog 违例，MRS2 可能拒开）——
  根因是 flushWs 紧凑数组与序列化索引失配，改为无条件压栈对齐（`ws[i]` 严格等于 children[i] 前导空白）；
  补记文件尾换行。**1946 个真实 XML 文件往返复测：1773 个逐字节一致**，余 173 个为空元素折叠/属性规整
  （0.1.1 已存在的语义等价形态）
- 属性值换行回写为 `&#xD;/&#xA;/&#x9;` 实体（重写 .launch 不再破坏 GDB 多行命令）
- `.launch` MAPPED_RESOURCE_PATHS 兼容 bare 形态（真实文件无前导 `/`，上一轮修复实际不生效）
- macros 跨盘 `file:/` URI 分支从死分支转为可达，resolveLocationUri 补 file:/ 逆解析
- 属性页目录树节点名/路径 HTML 转义（nodeHtml）；粘贴守卫前缀比较折叠大小写
- 新增 `tools/webview-test.js`：stub vscode 真实渲染属性页，对浏览器实际收到的全部脚本块做语法与注入校验
- **构建顺序陷阱修复**：确认 `npx tsc` 会以 10KB 模块产物覆盖 esbuild 的 235KB bundle——
  正确顺序为 tsc 在前 esbuild 在后（README 已警示）

### 测试与工具

- `tools/mass-test.mjs`：TEST 全树 972 工程（五棵 EVT）批量回归——解析/扫描/排除/芯片库/
  makefile 双次生成字节稳定性/.template 地址与系列默认值核对
- `tools/wlink-test.mjs`：PowerShell 桥脚本生成、load.wcfg 解析、真实 DLL 存在性、降级路径
- `tools/flash-test.mjs`：cfg 内容/地址覆盖/verify-reset 组合/非法地址/真实模板形态
- `tools/print-menus.mjs`：按节点类型打印右键菜单排序（开发辅助）
- 既有测试全部更新并通过；真实工具链编译验证覆盖 CH585 / CH32V307 / CH32H417 双核
