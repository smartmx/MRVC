> ⚠️ **免责声明 / Disclaimer**
>
> **MRVC 是个人独立开发的开源项目，非 WCH（南京沁恒微电子）或 MounRiver 官方开发、官方支持或官方认可的项目**，与二者无隶属或合作关系；"MounRiver / MRS / WCH / WCH-Link" 等名称与商标归其各自所有者。本扩展**仅供开发与调试使用**——请自行评估风险，因使用本扩展造成的任何直接或间接损失由使用者自行承担。
>
> MRVC is an independent, unofficial project. It is **not developed, endorsed, or supported by WCH or MounRiver**. Names and trademarks belong to their respective owners. Intended for development and debugging use only; use at your own risk.

# MRVC — 在 VSCode 中打开、配置、编译、下载 MounRiver (MRS) 工程

一个 VSCode 扩展（插件名 **MRVC**），直接打开/配置/编译/**下载烧录** WCH（南京沁恒）MRS / MounRiver 工程，无需 MRS2/MRS3 IDE 本体（仅复用其安装目录中的工具链与工具组件）。

**三平台可用：Windows / Linux / macOS**（0.2.6 起；边界：POSIX 的下载/烧录与硬件操作通道已实现但未实测——OpenOCD 与 libmcuupdate FFI 路径都在位，需实体机验证）。

**懒激活（0.2.8 起）**：打开文件夹后 MRVC 不自动工作——**点开活动栏 MRVC 视图**，或从**命令面板执行 `MRVC: Open MRS Project / Solution`** 选中 `.wvproj`/`.wvsln`，才开始扫描工程、建立 IntelliSense 分析；此前激活为零开销。工程型命令（Build/Flash/属性页等）也会自动完成首次扫描——不会因"先命令后视图"而误报无工程。

## 功能

| 功能 | 说明 |
|---|---|
| 打开 MRS 工程 | 与 MRS 一致：**明确通过 `工程名.wvproj` 打开工程**（这是工程的标记与入口）。**合法性三文件**：`工程名.wvproj` + `.project`（可解析工程描述）+ `.cproject`（构建配置）**三者同时存在才进入发现树**——任一缺失的残缺目录（半删除/拷贝残留）会在发现阶段直接跳过；仅有 `.project` + `.cproject` 的 MRS1-era 旧目录不再进入树。**Open MRS Project / Solution 的文件过滤器只处理 `.wvproj` 与 `.wvsln`**（`.project`/`.cproject` 是附属文件，不是打开对象）；选中后在**新 VSCode 窗口**打开：选 `.wvproj` → 打开其所在目录并自动发现；选 `.wvsln` → 生成同名 `.code-workspace` 并在新窗口加载 solution；**打开整个 EVT/EXAM 目录用 VSCode 自带的 文件 → 打开文件夹**（扩展自动递归发现全部工程：最深 8 层嵌套）。**自动修复打包残留**：EVT 工程的链接文件夹若指向打包机器的绝对路径，首次打开时自动按"最近祖先+尾段"定位真实目录并回写为可移植的 `PARENT-N-PROJECT_LOC` 形式（与 MRS2 的 rewriteLinkedFolders 行为一致；MRS1 风格的 `<location>` 自动转换为 `<locationURI>`） |
| Solution（工程组） | 支持 MRS 新增的 `.wvsln` 解决方案：**仅当显式打开 `.wvsln` 文件时启用**——Open MRS Project / Solution 选中该文件后，生成同名 `.code-workspace` 并在**新 VSCode 窗口**打开，打开 MRVC 视图时自动加载 solution；树中显示为 solution 节点，成员工程按 MRS2 的 `BuildOrder=` 行（缺省按文件行序）排列、每个成员都是完整工程节点。解析兼容 MRS2 的宽松语法；生成的 solution 与 MRS2 完全兼容 |
| 生成 Solution | 树标题栏 `…` 菜单 → **Generate Solution From All Projects**：把当前已发现的全部工程生成一个 solution 并立即出现在树顶，MRS2 可直接打开 |
| 工程树 | 活动栏 MRVC 容器内的 "Project Explorer"：标题栏 4 个按钮（**Open Mrs Project**（文件对话框）/ **Open Mrs Folder**（只选目录）/ 折叠全部 / **刷新**——外部改名/新增/删除的工程会被自动识别与清理）。工程 → 链接文件夹（蓝色名称）/ 实体目录 / **根级源文件** / 编译输出目录（红色）。编译输出目录**按磁盘原样展开（0.3.7）**——顶层文件与各源码目录的镜像子目录（`.o` / `.d` / `subdir.mk`）全部显示，递归、不过滤（目录在前、文件在后）；子目录行沿用输出目录行的通用文件操作，不出现编译配置类菜单；**非活动配置的输出目录同样按输出目录显示**（递归列出、同样的菜单），其内部不会再出现「从构建中排除」或单文件编译。树只显示扫描到的工程本身，不列工程目录之外的散落文件。**源文件自动刷新**：工作区与每个工程内的源文件新建/删除即时反映到树（400ms 防抖），**外部链接文件夹同样受监视（0.3.3）**——工程根之外的链接目录里增删源文件也会即时刷新（链接目录增删/改目标后自动重对齐监视），配置文件有专属监听。**作用域刷新（0.3.0）**：文件新增/删除只重读所在目录的节点、编译结束后只刷新输出目录节点（编译期间树冻结）——不再整树重绘导致链接文件夹蓝↔白闪烁；配置文件变更仍触发工程重解析与全树刷新。**单击工程行即激活（0.3.0）**：选择即设为活动工程，Info/编译/下载随动 |
| 文件管理 | 树节点右键（每类节点独立菜单）：New File / New Folder / **Copy→Paste**（插件内剪贴板，同名自动 `- copy` 递增，文件夹递归复制）/ Copy Absolute Path / **Copy Project Relative Path**（`${workspace_loc:/${ProjName}/…}` 形式的 CDT 逻辑路径）/ Copy File Name / Rename / Delete（均带确认）/ Open Containing Folder。链接文件夹禁用 Rename/Delete（防误删真实目录），其内部文件操作不受限。**树右键搜索（0.3.3）**：工程/文件夹/链接文件夹右键 **Search in Project / Search in Folder**——VSCode 搜索面板预填 filesToInclude（工程范围 = 工程根 + 全部链接文件夹，路径逗号/通配符按 VSCode 管线实证转义），不预填查询词；**`…` 菜单 Search in All Projects（在所有工程中搜索，0.3.6）**把全部已加载工程展平成一个范围列表（嵌套工程根与重复链接跨工程去重）——0.3.8 起菜单项移至 **Build All Projects** 之上，快捷键 **Ctrl+Shift+H**（与 Search in Project 的 Ctrl+H 同门控：活动工程存在时生效） |
| 排除 / 恢复编译 | 文件、文件夹与**蓝色链接文件夹行（0.3.5）**右键 **Exclude From Build / Include From Build**（与 MRS 的 Resource Configurations → Exclude from Build 等价；**整条链接的排除/纳入按 MRS 同款存储：移除该链接的命名 sourceEntry（如存在）并在根 entry 写入链接名 token，扫描器随构建跳过/恢复整条链接，恢复时重建 entry**）：写回 `.cproject` 活动配置（首个 `cconfiguration`）`sourceEntries` 的 `excluding` 列表（`|` 分隔；目录带命名 sourceEntry 时写目录内相对路径，否则写工程根相对全路径并在缺失时自动创建根 entry——与 MRS2 两种工程风格完全一致；**排除带命名 entry 的顶层文件夹 = 移除该 entry 并在根 entry 写入 token**，恢复时重建 entry）。被排除的资源在树中显示为**灰色**（行尾 `×`）并排在最后；下次编译生效；编译输出目录不可排除 |
| 编译 / 重建 / 清理 | 每次构建前从 `.cproject` 重新生成 CDT 风格 makefile（**默认按当前 MounRiver 2.3+/2.5 风格**——含强制 `-lm`、WCH 助手库走链接 recipe；1.9.2/2.1.0 布局保留为显式复现模式，golden 29/29 逐字节一致），再调 MRS 自带 `make`；错误进问题面板（`$mrvcgcc` problemMatcher）。行内 Build / Rebuild / Download 按钮 + 右键菜单；Build All / Clean All / Solution 构建批处理（单工程失败不中断、可取消带汇总）；多配置工程右键另有 **ReBuild Project All Configurations**（0.3.4，与 MRS 同名菜单——先把全部配置逐一 `make clean`，再逐配置现生成 makefile 并 `make all`，各配置用自己的编译选项/工具链/目标名，排除表恒取活动配置（MRS 同款），首个编译失败中止其余配置，全程不切换活动配置、完整构建记录只写活动配置）与 **Clean Project All Configurations**（0.3.4，MRVC 独有——全部配置的输出目录逐一 `make clean`，未编译过的自动跳过，单个失败不中止其余，静默无弹窗）；`…` 菜单四项批量清理（0.3.6）：**删除输出目录 / 删除输出文件（保留 hex/bin）**（仅各工程活动配置）+ 其下的 **删除所有配置输出目录 / 删除所有配置输出目录（保留hex/bin）**（0.3.6 新增，遍历每个工程的全部配置输出目录：前者整目录删除，后者清空目录内容但按**各配置自己的目标名**保留 `*.hex`/`*.bin`；从未编译的配置跳过、编译进行中的工程自动跳过；**删除清单按构建模型逐文件清点（0.3.8）**——只删除该配置构建确实写出的文件（makefile 家族/目标文件与依赖及栈用量/主产物/链接器映射/镜像/烧录脚本），目录归属由生成器 makefile（自动生成头+目标名整词引用）证明；USER_OBJS 引入的链接输入库、手工存放的镜像等非构建文件一律保留，同名共享输出目录按目录分组合并后一次清理（各配置镜像都保留），`make` 规则在首次编译或重新生成后即在输出目录外建立持久化的 `.vscode/mrvc/output-history.json` 构建写入历史（记录本扩展生成的 makefile 与 `make` 实际写入/修改产物的 SHA-256 摘要及编码，并通过跨进程锁与同目录 `.gitignore` 忽略 `output-history.json`、`output-history.lock` 及其 `output-history.lock.stale.*` 陈旧认领残件，若 `.gitignore` 写入确认失败则 fail-closed 拒绝落盘未受保护的 `output-history.json`）；删除阶段若发现文件存在记录且磁盘内容被用户外部修改过（SHA-256 不匹配），keep-clear 会保留该文件、整目录删除会拒绝且不触动任何文件，并在读取校验前后与 `unlinkSync` 前即时复核目录与中间路径非链接、无逃逸且内容未变化（TOCTOU；受限于纯 Node 路径 API 无原生 `unlinkat(dirfd)` 句柄级删文件，极端并发下紧邻 `unlinkSync` 系统调用前的本机目录替换属残余安全边界）。若 `output-history.json` 自身损坏、版本不受支持或无法读取，清理会安全拒绝（fail closed）而非盲删——请人工检查或删除工程下的 `.vscode/mrvc/output-history.json` 后重新构建工程即可恢复；**Pre-build / Post-build steps** 参与生成的 makefile |
| **编译单个文件（0.3.4）** | `.c/.cpp/.cc/.cxx/.s/.S` 源文件（**含多字符 C++ 后缀的任意大小写变体，如 `.Cxx`/`.Cc`/`.CC`/`.CPP`**）右键 **Compile Single File（编译单个文件）**（与 MRS 同名功能对应）：按当前工程配置**重新生成 makefile** 后，在 obj/ 里对**该文件的目标**（`<逻辑目录>/<文件名>.o`，工程根文件无目录部分）跑一次 `make`——编译选项与整工程构建**逐字节一致**（工程根外链接目录文件同样支持，走显式规则）。被 Exclude From Build 的文件菜单不出现；产物与依赖文件落在 obj/ 常规位置，**不写构建记录**（不覆盖上次整构建的记录，下载目标解析不受影响）；成功后在任务终端打印完成行并弹提示，失败带 make 退出码。与工程构建共用"同一工程一次一个 make"互斥；命令面板无文件上下文时回落活动工程（无则报错） |
| **C++ 后缀大小写变体识别（0.3.4）** | `.cxx/.cc/.cpp/.cp/.c++` 的**任意大小写组合**（`.Cxx`/`.Cc`/`.CC`/`.CPP` 等）全平台识别为 C++ 源文件：进整工程构建（makefile 按实际后缀拼写生成专属模式规则，g++ 对任何后缀按 C++ 编译）、单文件编译、IntelliSense、源文件监视器；同目录混用拼写时 make 变量名自动去重（两组对象都进链接）。单字母 `.c`/`.C`、`.s`/`.S` 保持大小写敏感——大小写本身就是语言判定（C↔C++、汇编↔带预处理汇编，GCC 规则） |
| **汇编语法高亮（0.3.8）** | `.s/.S` 内置 **MRVC 自研 RISC-V 汇编 TextMate 语法**（`syntaxes/qingke-risc-v.tmLanguage`，随包无任何第三方代码与许可文件；指令/寄存器/CSR 数据依据开放的 RISC-V ISA 手册与沁恒青稞 V2–V5 内核手册整理）：按 ISA 扩展族逐条枚举指令（基础/A/M/F/D/C + privileged + Zicsr/Zifencei/Zicntr + Zba/Zbb/Zbc/Zbs/Zbkb/Zbkx 位操作 + Zicbom/oz/op + Zicond/Zawrs/Zfa/Zfh + 标量加密 AES/SHA/SM 全集 + **RVV 1.0 向量族**：配置/访存/整型与浮点运算/掩码/归约/转换逐族规则）、CSR 标准名（machine/supervisor/hypervisor/user/debug/PMP/性能计数）、寄存器（通用/ABI/浮点/向量）、GNU 伪指令（.section/.option/.word/.attribute…）、重定位 `%hi/%lo/%pcrel_*`、标签/数字/字符串/注释（`#` 与 `//` 与 `/* */`）/C 预处理器行、汇编伪指令（la/li/mv/…）；**WCH（青稞）块**——XW 自扩展压缩指令 c.lbusp/c.lhusp/c.sbsp/c.shsp（c.lbu/c.lhu/c.sb/c.sh 由 C 规则覆盖）、**V3B 自有指令 mcpy/mrsl/mrslu/wexti**（块内存拷贝与移位乘法/64bit 提取——助记符出自 WCH SDK 头文件内联汇编，手册未记载）与 17 个 WCH 自定义 CSR 名（gintenr/intsyscr/inestcr/corecfgr/cstrcr/cache_strtg_ctlr/cpmpocr/cache_pmp_ovr/cmcr/opcache_ctlr/cinfor/meminfo/hw_popdm_addr/memary_cfgr/tcm_rrduty_cfgr/dbgmcu_0/mcount_inhibit，出自青稞手册寄存器表）。**语言模式名 `mrvc-qingke`（显示名 MRVC QingKe），按文件夹选择启用（opt-in）**：语言贡献**不带 extensions 全局占用**，语法作用域为独立命名空间 `source.mrvc-qingke`（不与其它 RISC-V 扩展抢 TextMate 注册表）——MRVC 使能且该文件夹内含 MRS 工程时，向工作区 `.vscode/settings.json` 写入 `files.associations`（`*.s`/`*.S` → mrvc-qingke），**`*.s`/`*.S` 已有任意关联值（用户级/工作区/先前写入）则完全不写**，用户可自行改指其它模式、MRVC 永不回写；不含工程的文件夹（多根工作区里的文档/其它架构仓库）一律不碰。按 VSCode 规则，**工作区显式关联的优先级高于任何扩展经 `languages` contribution 声明的默认文件映射**——MRVC 写入前只能检测显式关联值、检测不到其它扩展的默认映射，一旦写入即接管这些扩展名的打开模式，这是 opt-in 按文件夹启用的设计边界。纯声明式语法 + 一次性关联写入，零激活开销。已装其它 RISC-V 高亮扩展的机器互不影响（语言 id 与 scopeName 都不同、无竞速） |
| **构建产物语法高亮（0.3.8）** | `.lst`（objdump 反汇编 / GAS `-Wa,-adhlns` 编译清单）与 GNU ld `-Map` 链接映射表内置两份 **MRVC 自研 TextMate 语法**（`syntaxes/qingke-objdump-lst.tmLanguage.json` / `syntaxes/gnu-ld-map.tmLanguage.json`，clean-room、无第三方归属）：`.lst` 着色文件横幅/区块标题、入口地址、机器码、目标标注 `<symbol+offset>`、重定位表、符号表、`...` 零块省略行，**指令列直接复用 `source.mrvc-qingke` 语法**（青稞 XW/V3B 指令、WCH CSR、RVV 与标准 RISC-V 全集零重复维护），GAS 清单的 C 源码穿插行只着注释/字符串/数字；`.map` 着色区块标题、内存区域（FLASH/RAM）、输出/输入 section（含跨行续行格式）、`*fill*`、PROVIDE/ASSERT/ALIGN 等脚本函数、`Discarded input sections` 整块弱化、目标文件路径（含 `lib.a(member.o)` 静态库成员）。语言模式 **MRVC Disassembly Listing / MRVC GNU LD Map**，与汇编同样 **opt-in**（无 extensions 全局占用）：使能后按**文件类型独立分组**写入 `files.associations`——`*.s`/`*.S` 成对（任一有用户值则整对不写）、`*.lst` 与 `*.map` 各自独立（用户反馈后定案：**裸 `*.map`**——按工程目录逐条生成会在 EVT 式多工程树里爆炸成几十行，且早期版本写入的按目录条目会在本版自动清理回收）；任一 glob 已有任意关联值则该 glob 不写、用户可自行改指其它模式、MRVC 永不回写。纯声明式语法，零激活开销 |
| **汇编符号跳转 Go-to-Definition（0.3.8）** | 在 `.s`/`.S`（mrvc-qingke 模式）里按 **F12 / Ctrl+Click** 可跳转：**C/C++ 函数与全局变量**（桥接 cpptools 已建好的 Workspace Symbols 库——cpptools 只对 c/cpp 注册定义跳转、从不覆盖汇编模式，MRVC 不自研 C 解析器；本工程定义加权优先，EVT 式几十个例程工程重复定义 `main`/`SystemInit`/中断服务不再串跳）、**链接脚本符号**（活动工程 `.cproject` 的 `.ld` 里 `_eusrstack`/`PROVIDE(...)`/`__global_pointer$` 等赋值行，块注释自动跳过）、**头文件**（`#include`/`.include` 按当前目录 + 工程 assembler/C `-I`/`-isystem` 解析）、**本地标签**（含 GAS 数字标签 `1b` 向上/`1f` 向下、`.equ`/`.set`/`#define`）与**同工程其它汇编文件**的全局标签。注释/寄存器/助记符/立即数光标不触发查询；cpptools 未装或建库中时 `.ld`/头文件/本地标签照常可用，查询为空静默无跳转。`package.json` 增 `onLanguage:mrvc-qingke` 懒激活——该模式只存在于 MRVC 写入关联的 MRS 文件夹，打开 `.S` 即激活，无需先点开 MRVC 视图 |
| **Build Project And Download** | 工程右键 / 命令面板 **构建工程并下载**：编译 + 下载一条龙，编译成功才下载（与 MRS2 同名命令语义一致） |
| **编译/下载进度与手动结束（0.3.0）** | 工程行内 **Build / Rebuild / Download**（以及 **Build Project And Download**）运行期间弹出**可取消的进度通知**：正在编译 / 重新编译 / 下载“工程名”；点通知上的取消按钮会**终止当前 make/OpenOCD 任务**（重建会先终止 clean 阶段并停止后续 build；编译并下载时取消会同时停止后续下载）。进度覆盖 makefile 生成与整个任务等待期；`Clean` 仍保持无进度提示 |
| **Show Full Build Output** | 命令面板 / 输出面板右键打开上次构建的完整输出（MRS2 同款 buildContentRecord.txt 位置），单工程与批量构建均记录，尾部附**全量编译指令清单**（每个源文件的完整命令行） |
| **静态栈分析** | 设置 `mrvc.build.analysis` 开启后构建自动注入 `-fstack-usage` / `-fdump-rtl-expand`；**Static Stack Usage** / **Function Call Analysis** 命令生成分析报告（开源方案替代 MRS2 闭源解析器） |
| **C/C++ 缓存治理** | 命令面板 **MRVC: Clear C/C++ IntelliSense Cache**：一键清除 cpptools 的 ipch 缓存（模态确认、逐路径体积、安全护栏、锁定路径降级；浏览数据库 `.BROWSE.VC.DB` 不在范围）。设置 `mrvc.intellisense.cachePath` 自动把 `C_Cpp.intelliSenseCachePath` 写进各工作区 `.vscode/settings.json`（工作区覆盖用户级），把缓存引到指定盘符而非撑满 C 盘——**留空则两个缓存键都不写**（`cacheSize` 仅在 `cachePath` 设置后随路径一起写入）；设置 `mrvc.intellisense.cacheSize`（MB，默认 5120 与 cpptools 一致，0 = 不管理）后自动写入 `C_Cpp.intelliSenseCacheSize` 显式固定上限 |
| 新建工程向导 | `…` 菜单 → **新建 MounRiver 工程 / 静态库**：扫描 MRS2 SDK 模板（系列 → RTOS → 器件三步选择）→ 工程名 → **位置（可键入任意新路径自动创建，或点浏览按钮选择；默认上次创建目录）**，创建完成提示可一键在新窗口打开；renameProject 全套联动，MRS2 无损打开 |
| 下载烧录 | 工程行内 **Flash 按钮** / 右键 **Download**：通过 MRS2 的 OpenOCD 下载 `obj/` 产物（hex/bin，地址取自 `.template` 的 Address，双核工程自动选 `wch-dual-core.cfg`；`.template` 勾选 **Erase All** 时下载前全片擦除）；输出进任务终端，失败弹提示。**下载目标修正（0.2.9）**：`.template` 的 Target Path 指向的文件不存在、而本工程构建产物存在时（EVT 常跨工程引用，如记录的是同工作区内另一工程的 hex），下载**先弹窗询问是否修改 `.template`**——确认后回写为本工程产物（相对路径）并提示重新下载；选择"不修改"则保留原值、按回退目标照常下载；目标存在（含有意共享的产物）一律不动。工程从未编译（无任何构建产物）时提示**先编译工程**。**目标芯片一致性校验（0.2.9，与 MRS2/MRS3 一致）**：下载前用 `MRSFunc_GetLinkedMCUID` 查询 WCH-Link 上芯片的 flash-control id，与工程 `.template` 目标芯片的 flash-control id（MRS2 `getFlashControl` 同一语义：SDK `<series>-flash.json` 的 `id`，含 `special` 单型号覆盖与 zip 名容错）比对——两者都已知且不同时（如 CH32V307 工程接在 CH32V407 芯片上）模态警告，只有显式选择"仍然下载"才继续；**查询只在初始化完成（设备打开且 CompareVersion=0）时采信**，芯片库缺失、无 `wchlink.wcfg`、无 Link、初始化失败/需升级固件、未知 id 时一律按未知静默放行（不阻塞既有流程）。**WCH-Link 固件版本检测（0.2.8，只读）**：下载前核对已连接 WCH-Link 的固件版本与 MRS 安装 `wchlink.wcfg` 的期望值——过低时模态提示改用 **WCH-LinkUtility** 升级（MRVC 不刷写 Link 固件本身），检测失败静默放行。**SDI Printf 使能（0.3.0，MRS 同源）**：勾选 **SDI Printf** 的工程在**主下载成功后**自动执行 WCH-Link 原生“复位+使能”pass——`MRSFunc_FlashOperationExB`（flags = RESET|SDIPrintf = 0x11）在**一次 DLL 会话**内复位目标并写入 SDI printf 开关（OpenOCD 的 `sdi_printf enable` 会重新枚举 Link、杀死所在会话，不可用）；**不自动打开 VSCode 串口监视器**（避免与 SSCOM 等外部工具争抢 WCH-Link CDC 口），要抓复位后的启动输出请在**下载前手动打开 SDI PRINT Monitor**；pass 失败只告警、不影响已成功的下载。只开不关，输出读取见 **SDI PRINT 监视器** |
| Download Settings | 属性页 → Download → Download Settings（镜像 MRS2）：**读保护状态查询 / 使能 / 解除**、**调试保护**、**Linked MCU Type 查询（0.2.9：按 MRS2 同序 OpenDevice→CompareVersion→CloseDevice 初始化后查询，显示名按 SDK 系列解析回填）**、**Erase Code Flash**（By Pin NRST / By Power off）、**MCU Memory Assign**（Query/Apply）、**Operation Record** 操作日志；右侧完整编辑下载参数（MCU Type / Memory Type / Program Address / Debug Interface Mode / CLK Speed / Target File / Main Operations 八项），全部写回 `.template`（MRS2 无损打开）。硬件操作桥：Windows 走系统 32 位 PowerShell P/Invoke 调 McuCompilerDll.dll（MRS2 的 DLL 是 32 位，须进程外桥接）；Linux/macOS 进程内 koffi FFI 调 CommunicationLib 的 `libmcuupdate.so/.dylib`——与 MRS 自家扩展同款机制、同族 `MRSFunc_*` 导出；芯片 ID 与能力开关自动来自芯片库；**Debug Interface Mode 与 MRS2 一致恒可编辑**（`support_debugInterfaceMode=false` 的芯片——CH32V30x/CH5xx 等——照常显示，写回由驱动侧处理），其余不支持的选项按芯片自动灰显 |
| 芯片选择器 | 属性页 → General → Chip / Target：MRS2 同款 "Target MCU Type" 选择器——系列树（RISC-V/ARM 分组）→ 型号列表 → 信息区；数据实时扫描 MRS2 的 SDK 组件目录（40+ 系列），选中后自动填充 Series / MCU / Mcu Type / Address 并写回 `.template`；SDK 缺失时回退文本编辑 |
| Build Steps / Build Artifact | 属性页 → C/C++ Build 分组：**Build Steps**（Pre/Post-build 的 Command 与 Description，进 makefile）；**Build Artifact**（Artifact Type：Executable/Static Library；Artifact name 按 MRS 变量形式显示 `${ProjName}`；Artifact extension；Output prefix——产物名前缀与自定义扩展名在生成的 makefile 中生效） |
| Switch Project Type (C/C++) | 工程右键一键切换工程类型：写 `.project` 的 CDT C++ nature（`org.eclipse.cdt.core.ccnature`——与 MRS2 的判定键一致；旧版 MRVC 写入的假 ID 会在工程加载时自动规范化），**切到 C++ 时同时把 C 选项整组镜像进 C++ 选项集**（值/列表按原写法逐项复制、元数据按 CDT/MRS2 原生形态补齐，另补 C++ 编译器的 `<inputType>`），因此 C++ 属性页显隐、`.cpp` 源扫描、makefile 生成与 MRS2 打开后的构建都联动正确。**范围**：`.project` 的 nature 是工程级——C++ 选项镜像与 `<inputType>` 增删对**每个 `<cconfiguration>` 逐一执行**（0.3.8 起，多配置工程整体转换，此前只转首个配置）；切回 C 会对全部配置移除转换新增的 `<inputType>`，镜像的 C++ 选项值保留（与 MRS2 的 C++ 工程两套选项并存的形态一致） |
| 配置修改 | "MRVC: Project Properties"（右键工程打开）——**按 MRS2 原版属性页布局复刻**：Tool Settings 分类树（Target Processor / Optimization / Warnings / Debugging / Assembler / C Compiler / C Linker / C++ Compiler / C++ Linker / Create Flash Image / Listing / Print Size 各含子页），左侧树结构、右侧页内容、底部描述区 + **Apply/Cancel**。**多工程并行（0.3.8）**：每个工程拥有独立的 Properties 标签页（互不覆盖、可拖入分栏并排对比）；Apply 的 Diff 基准逐面板隔离；同工程再次打开只聚焦原面板不重绘（未保存编辑与当前页签保留）；工程重命名/移除时标题联动、孤儿面板自动关闭；WCH-Link 硬件操作（查询/擦除等）跨面板互斥；同工程重名（EVT 式多工程）标签标题自动附目录区分提示；**多配置工程（0.3.4）**：右上角 Configuration 为下拉选择，旁边 **Manage…** 打开配置管理对话框（与 MRS2「配置管理」对应）——列出全部配置与 Active 状态，Add（深拷贝选定源配置）/ Rename selected（重命名活动配置时 Target Path 一并跟随）/ Delete selected（活动配置拒绝删除，与 MRS 同规）/ Set as Active；名称只允许字母/数字/中文/`_`/`-`、上限 10 个、重名（含大小写不同）拒绝；**切换活动配置**=把目标配置移到 `.cproject` 首位（MRS「活动配置=第一个配置」语义），Target Path 同步改写并整页重载，页面有未 Apply 修改时先确认、构建进行中拒绝。涵盖工具链（rvGcc）、全部 ISA 扩展、17 项警告、C/C++ 编译与链接、hex/bin 双产物、objcopy/objdump 细项、WCH 专属库（`-lprintf`/`-lprintfloat`/`-lIQmath_RV32`）。**Includes 页为表格编辑器**（Add/Edit/Delete，Add 支持 Project 内复选框树浏览或 Local Folder，工程内路径自动写成 MRS2 实际使用的 `${workspace_loc:/${ProjName}/…}` 宏）。仅 C++ 工程（Switch Project Type 切换）显示 C++ 配置页。**Apply 只写改动项**：按渲染时快照逐字段比对，用户未改动的选项在 `.cproject` 中保持**逐字节不变**（整表原值回发后文件字节相同）；既有但下拉表未收录的枚举值会显示为 `(current)` 并原值回写，不会被第一项覆盖；`.cproject` 严格结构与语法（标签栈/标记位置/实体/属性值/字符数据/XML 1.0 字符范围/严格 UTF-8 解码）校验不通过（严格 XML 解析器会拒绝）时 Apply **直接报错、不写任何字节**。**同名编译配置（0.3.7，真实工程实测）**：从 EVT/MRS 导入的工程可能有两个配置同名（如 `["dbg","dbg"]`）——构建/清理与 MRS 语义完全一致（按配置**下标**逐配置执行、配置名即输出目录，同名配置共享一个输出目录即 MRS 原生行为，不改）；Manage… 对话框**按行下标**识别配置（Set as Active / Rename / Delete / Copy from 均不会串到同名的另一行，名字有歧义又未带下标的操作明确报错拒绝），对话框顶部对同名配置发警示条，**ReBuild / Clean All Configurations** 执行前也会警告目录共享；MRVC 自己的 Add/Rename 仍拒绝重名（含大小写不同），不会制造新的同名配置 |
| 外部链接文件夹 | 右键工程 → Add Linked Folder：同时更新 `.project`（linkedResources，支持 PARENT-N-PROJECT_LOC）与 `.cproject`（include 路径 + sourceEntries） |
| **Sync Setting Across Projects** | 树标题栏 `…` 菜单打开专用页面（Properties 同款两级导航树）：140 个可同步编译开关（bool/enum，0.3.1 补齐 C++ 编译器/链接器与 picolibc 后）逐行带**同步选择框**（默认不勾）与值控件（值取自活动工程）；勾选后 Apply 批量写入全部工程（C++ 选项自动跳过 C 工程并计数、可取消、输出频道逐工程 [OK/FAIL] 汇总） |
| **检测预处理宏一致性（0.3.3）** | 两个入口，同一检测：① 工程右键 Properties 属性页 **Apply** 保存成功后自动检测；② 工程右键 **Check Preprocessor Macros（检测预处理宏一致性）**手动检测（读盘上最新 .cproject，无发散明确报一致）。检测内容：C / C++ / 汇编三份 Defined symbols (-D) 列表里**同一个宏名被定义成不同值**时逐宏弹出统一流程（比较口径与原保存门禁一致：裸 `FOO` ≠ `FOO=1`；同列表同名重复项按 GCC 语义取最后一条）；Apply 路径三份一致则完全静默。统一流程：先选定要写入的值（每个取值旁标注当前哪些预处理器在用，可跳过该宏），再勾选写入哪些列表（默认三项全选，缺失的列表补齐追加、在场列表原地改写），每个宏确认即落盘并刷新工程，明细汇入 **MRVC Preprocessor** 输出面板；未提及的宏永不改动。原属性页保存前的冲突二次确认模态已移除（同一发散由统一流程处理） |
| **IntelliSense 自动配置** | 自动生成每个工程的编译数据库（`.vscode/mrvc/cc/`）并维护 `c_cpp_properties.json`——c 文件的宏定义/头文件路径随工程精确解析，无需手动配置 includePath；**工程树点选工程即切换分析上下文**（cpptools 多数据库数组，≥1.23.5） |
| MRS Tools 工具集 | **（仅 Windows 安装提供——Linux/macOS 的 MRS 不带这些 GUI 工具，发行包清单级实证 0 命中）** 树标题栏 `…` 菜单 → Tools 组（对齐 MRS2 Tools 菜单）：一键拉起 WCH-LinkUtility / WCH In-System Programmer (WchIspStudio) / WCH Touchkey Calibrate Tool / WCHGUIDesigner / HexBin Studio / Serial Port Debug Tool (COMTransmit)，分离进程启动；**菜单按当前生效安装的实际磁盘探测自动显隐（0.3.7）**——每个菜单项各自探测自己的 .exe（逐工具上下文键 `mrvc.tool.*`）：Linux/macOS 安装或纯工具链根目录下这些 .exe 不存在时整组自动隐藏，个别组件缺失时只隐藏缺失的那一项；不再显示点了只会报"找不到"的死菜单；**当前生效的安装是 MRS3 时**（MRS2 没有该组件）额外多一项 **WCH 工具集（MRS3）** = WCHToolKit.exe |
| WCH-LinkUtility | **（仅 Windows 安装提供）** 命令面板 **Open WCH-LinkUtility**：直接拉起 MRS2 自带的 GUI 下载器（调试器模式切换/固件升级等深度操作）；也已归入 `…` 菜单 Tools 组 |
| MRS 命令终端 | 预置工具链/make/OpenOCD 的 PATH |
| 工具链选择 | `auto`（读 `.cproject` rvGcc/前缀）或强制 GCC8/GCC12/GCC15，均从 `sub_manifest.json` 动态解析；生效安装按设置键缓存、工具链解析带 memo（0.3.0）——不改设置不重复探测 |
| **使用 MounRiver IDE 打开（0.3.0，2026-11-17 前台化重构）** | 工程右键 **Open With MounRiver IDE（使用 MounRiver IDE 打开）**：用当前生效的 MRS 安装打开该工程的 **`<工程名>.wvproj`** 工程文件，启动参数为 MRS 安装器注册的 Shell 右键同款形态（**两个独立参数 `-m` + 工程文件**；扩展内部自用的 `-m=` 连写形态已实证会开空工作区，勿用）。**Windows 实际形态**：PowerShell `Start-Process -WorkingDirectory <工程根> -ArgumentList '-m','"<.wvproj 绝对路径>"'` 分离启动，脚本经 `-EncodedCommand` 送达——PS 5.1 的 -ArgumentList 不给元素加引号，内嵌引号保证含空格的绝对路径仍作为单个参数到达；MRS 自身要求**绝对路径**（相对文件名会报 "The following file path is not absolute"）。**POSIX（Linux/macOS）为前台运行**：`sh -c 'exec "$1" "$2" "$3" "$4"'`，任务进程即 IDE 本体——**任务存活期 = MRS 窗口存活期，关闭窗口任务即结束**；启动前先**按前缀卸载扩展宿主注入的全部 `ELECTRON_*` / `VSCODE_*` 变量**（任务 env 只能合并不能删除，`ELECTRON_RUN_AS_NODE` 会把 GUI 启动器变成纯 Node 进程、窗口永不出现），桌面会话其余环境（XAUTHORITY / WAYLAND_DISPLAY / TMPDIR / XDG_* / DBUS）原样保留；cwd=$HOME；Linux 追加 `--no-sandbox`（官方 .desktop → load.sh 同款），macOS 不加；IDE 自身输出直接流入任务终端。启动器自动解析：Windows `MounRiver Studio {2,3}.exe` / Linux `mounriver-studio {2,3}`（根或 bin/） / macOS `Contents/MacOS/Electron`；当前生效配置为纯工具链（无 IDE）或缺 .wvproj 时明确报错 |
| **MRS 深度校验（0.3.1）** | 工程右键 **Validate Project With MRS（使用 MRS 校验工程）** / 命令面板 **Validate All Projects With MRS（使用 MRS 校验全部工程）**：**让 MounRiver 本体静默完整解析并构建一次工程**，以 MRS 自己的接受与否作为工程合法性的最终判据（静态三文件契约 + XML 门禁之上的第三层；能查出"MRS 读 rvGcc 崩溃"这类静态检查查不出的形态）。机制：MRS2/MRS3 原生静默模式（`--mrsSilentType=build` + .wvproj 位置参数，实测仅此形态触发静默构建）+ 独立持久化数据目录 `~/.mrvc/mrs-validate/<代次>`（首次约 45s 组件初始化一次性付清，之后增量构建；实测不改 .project/.cproject/.template）。判定读会话日志：`Build Finished/编译完成` = 合法且构建成功；`Build Failed/编译失败/make 错误` = 工程合法、代码问题；exthost 崩溃签名（如 `TypeError reading 'match'`）= **MRS 拒绝该工程**；超时无签名 = 无结论（`mrvc.mrsValidate.timeoutSec` 默认 180s，可调大）。批量顺序跑全部工程、可取消，汇总进 "MRVC MRS Validate" 输出面板。边界：无 parse-only 动作（校验即真实构建）；**POSIX**：静态实证可用（MRS3 Linux/mac 安装包核心 bundle 含同一套 mrsSilentType 处理器、VSCODE_PORTABLE 隔离与 mrs-team 静默命令，启动器解析 Linux 根 ELF / mac Electron 均为 GUI 本体），真机未跑；MRS2 代 Linux/mac 为纯工具链无 IDE，功能自动隐藏 |
| **Build / Rebuild / Clean With MRS IDE（0.3.1）** | 工程右键三个**独立**的 MRS 侧构建入口（**使用 MRS IDE 编译 / 重新编译 / 清理**）——与 MRVC 自身 make 构建管线（F7 等）完全并存、互不影响，等于“在 MRS IDE 里点编译”的精确通道。同一静默机制 + 同一隔离目录，但**编译日志实时流入专用的 `MRVC MRS <动作> - <工程>` 终端标签页**（gcc 诊断直接可见；少量 MRS 启动噪声如 jump_list/env dump 已过滤）。判读（探针实证）：`Build Finished`=成功；`Build Failed/make/gcc error`=**编译失败**（看该终端）；exthost 崩溃签名=MRS 拒绝工程；clean 无标记即成功。取消/超时终止进程（三时机实测零 MRS/make 残留）；`mrvc.mrsBuild.timeoutSec` 默认 600。与校验共用互斥锁（同一隔离目录同时只能一个 MRS 静默任务）。边界：不产生 MRVC 构建记录；需完整 IDE 安装（菜单在纯工具链配置下自动隐藏） |
| **Info 信息视图（0.3.0）** | 工程列表下方 **Info** 视图（固定尺寸、恒在底部）：①当前生效 MRS 配置（IDE 安装还是纯工具链、MRS2/MRS3、安装路径、偏好回退状态，点击行直达 MRVC 设置）②当前选中工程名 ③**SDI Printf 状态**——WCH-Link/CommunicationLib **没有回读接口**（只有 `McuCompiler_SetSDIPrn` 写命令），因此只显示 MRVC 本次会话下载“复位+使能”步骤的结果（已使能 / 上次失败 / 本次下载未使能 / 未知；重载窗口后回到未知，打开监视器时若找不到 WCH-Link 串口也会重置为未知），点击行打开 SDI PRINT 监视器 ④**Flash 电源输出行（0.3.2）**——显示当前电源轨（3.3 V / 5 V，会话级状态：每个窗口打开时都是 3.3 V，点击行手动切换才会到 5 V，关闭窗口恢复 3.3 V；显示值为**下一次**操作将使用的电压，下载/电源操作进行中切换被拒绝），点击行弹切换选择框 ⑤**Power-Off Reset 行（0.3.1，点击即执行掉电复位）**——工程切换与 `mrvc.*` 配置修改后自动刷新 |
| **SDI PRINT 监视器（0.3.0）** | 树标题栏 `…` 菜单 Tools 组 / 命令面板（含**停止**命令）：把 WCH-Link 解码的芯片 SDI printf 输出实时显示在终端（一行式只读监视）。串口只自动识别 **`VID_1A86/PID_8010` 的 "WCH-Link SERIAL (COMx)"**——板载/独立 CH343/CH340 等 USB 串口绝不误选，多台 Link 弹选择框；`mrvc.sdiPrint.port` 显式指定、`mrvc.sdiPrint.baud` 为打开参数（SDI 流与波特率无关）。跨平台（serialport 11 N-API 预编译随包发货） |
| **掉电复位 + 电源输出（0.3.0）** | **Info 视图 Power-Off Reset 行（点击即执行）/ 命令面板 **Power-Off Reset（掉电复位）****：经 WCH-Link 电源轨 **断电→延时→上电**（`pow3v3/pow5v off\|on`）；电源轨电压为**会话级状态**（0.3.2：每个窗口打开默认 3.3 V，Info 视图电源输出行/命令面板 **Flash Power Output** 手动切换才到 5 V，关闭窗口恢复 3.3 V——不持久化；`mrvc.flash.powerOffDelayMs`（0–10000）控制断电时长）；`mrvc.flash.resetMode=powerOff` 后**下载自动走断电流程**（断电一次，上电+烧写同一 OpenOCD 会话）。适用于 NRST 被调试接口复用的 1/2-wire 芯片（模式切换用属性页 FFI dbgMode，掉电复位使其生效）。掉电段识别 WCH-Link 重新枚举类瞬态失败并自动退避重试（主下载保持终端实时进度、不重试）；**仅 WCH-LinkE / DAPLink / LinkW 支持电源输出**（官方手册口径）——普通版 WCH-Link 在命令/下载前被模态拦截；**SDIPrintf 工程下载成功后只做原生复位+使能，不自动打开 SDI PRINT 监视器**（需在下载前手动打开以抓启动输出） |
| **检测并修复工程配置（0.3.0）** | 工程右键/命令面板 **Audit And Repair Project Configuration（检测并修复工程配置）**：体检 enumerated 选项缺 value（**可修复**=移除选项继承默认，正是"MRS 打不开工程"事故的通用化）、`.template` Address 非 0x 格式（**可修复**=清空回退推断）、rvGcc 值形态异常、XML 结构损坏、`.project` name 与文件夹不一致（后三项仅报告）；修复前逐文件备份到 `.vscode/mrvc/repair-backup/<时间戳>/`，模态列出全部问题、显式确认才写入 |

快捷键：`F7` 编译，`Shift+F7` 重建，`F8` 下载，`Ctrl+H` 在工程中搜索，`Ctrl+Shift+H` 在所有工程中搜索（0.3.8，工程树 `…` 菜单 Build All Projects 之上）。**窗口内全局生效，条件=插件已激活且有活动工程**（`mrvc.hasActiveProject` 门控；无活动工程的窗口按键回到原生行为）。注意 `Ctrl+H`/`Ctrl+Shift+H` 会**接管编辑器内的原生查找/替换**（有活动工程期间；`Ctrl+Shift+H` 原生对应 Replace in Files）——原生替换仍可从编辑器查找控件的切换按钮/命令面板使用；在键盘快捷方式 UI 里可自行改键。

**推荐配套扩展**（随 MRVC 自动安装，也可在扩展市场单独安装）：
- **C/C++ Extension Pack**（`ms-vscode.cpptools-extension-pack`）——MRVC 的 IntelliSense（代码提示/跳转）由它消费；
- **Chinese (Simplified) Language Pack**（`MS-CEINTL.vscode-language-pack-zh-hans`）——中文界面。

**可选推荐**（按需手动安装）：`koalamer.labeled-bookmarks`（MRS2 同款书签/注释）、
`ms-vscode.hexeditor`（hex 文件查看/编辑）、`maziac.hex-hover-converter`（悬停即进制转换）。

**界面语言**：命令菜单跟随 VSCode 显示语言自动中英文切换（内置双语资源）；提示/报错等
运行时消息由 `mrvc.language` 设置驱动（`auto`/`en`/`zh-cn`，默认 auto）。

| **AI / MCP Server（0.3.6）** | 插件**随包附带一个独立的 stdio MCP 服务器**（`<扩展安装目录>/mcp/mcp-server.js`，零 vscode 依赖、零额外发布物）——任何 MCP 客户端（ZCode / Claude / OpenCode / Cursor 等）都能驱动 MRVC 的工程能力，**不需要打开 VSCode**。客户端配置：`{"command": "node", "args": ["<扩展安装目录>/mcp/mcp-server.js"]}`。**导出 AI MCP 服务器（0.3.7）**：VS Code 把每个版本的扩展装在各自的目录里，客户端配置直接指向安装目录会在插件升级后失效——树标题栏 `…` 菜单 → **Export AI MCP Server** 把服务器复制到用户选择的位置，客户端配置改指 `<导出位置>/mrvc-mcp/mcp-server.js` 即可跨升级保持有效。目标规则：选择位置后**在该位置创建 `mrvc-mcp` 文件夹**并在其中导出（mcp-server.js + README 配置说明 + 标记 package.json，Linux/macOS 另带 koffi）；重复导出到同一位置 = 原地更新该文件夹（只重写有变化的文件）；该文件夹已存在且非 MRVC 导出的需模态确认；选到扩展安装目录内部会被拒绝（按真实路径判定，经 junction/symlink 指进去的同样拒绝）。写入是**就地增量 + 临时文件原子改名**的：内容相同的文件不碰、从不删除，副本正在被 MCP 客户端运行时重新导出也不会观察到半写文件。**副本不依赖插件安装目录**（Windows 只有 mcp-server.js + 标记 package.json + README 配置说明；Linux/macOS 另带 koffi 运行时；版本、MRS 安装路径全部记录在标记里）——插件更新甚至卸载都不影响已导出的副本，唯一要做的是更新后重新导出一次以同步新版本。**每次导出都携带版本**（写入标记 package.json，副本启动时也从它读版本号）：重新导出时消息显示「从 A 更新到 B（重写 N 个文件）」——插件升级后看这条消息就知道副本是否已同步；相同版本且无变化时提示「已是该版本」；导出位置的副本比当前扩展更新（如回退了扩展）时先模态确认再覆盖。标记同时记录**来源**（导出它的扩展安装目录）与导出时的 **MRS 安装路径设置**（mrvc.mrs2InstallPath / mrs3InstallPath / toolchainOnlyPath 与代次偏好 mrvc.mrsVersion——无头副本读不到 VS Code 设置；不携带代次偏好时，双安装机器上导出的副本会按默认顺序选代次）：副本在惯例位置探测不到安装时回退到记录的路径（显式参数与 MRVC_MRS_INSTALL_PATH 仍最优先、严格校验不变，改了设置重新导出一次即可）。导出后消息提供「复制客户端配置」（command/args 的 JSON，直接粘进客户端）与「打开文件夹」；**插件升级后重新导出一次**即可把副本更新到新版本（对话框默认回到上次的位置，选中同一个文件夹即可）。Windows 上导出只有 `mcp-server.js`、标记用的 `package.json` 与 `README.md` 配置说明；Linux/macOS 另带硬件桥用的 koffi 运行时（Windows 桥走 P/Invoke，不需要）。可选环境变量 `MRVC_MRS_INSTALL_PATH`（显式 MRS 安装根，无效路径报错不静默回退）与 `MRVC_MCP_DEFAULT_ROOT`（工程扫描默认根，缺省为 server 工作目录）。**二十七个工具**：`mrvc_discover_projects`（目录扫描发现工程）/ `mrvc_get_install_info` / `mrvc_get_project_config`（配置摘要 + 真实 -I/-D 示例命令行）/ `mrvc_audit_project`（体检，不修复）/ **`mrvc_repair_project`**（**体检修复执行，0.3.8**：enum 缺 value 的选项删除（MRS 读取崩溃项）、.template Address 异常清空（下载回退推断）；`includeStaleLinks:true` 时**陈旧链接一并修复**——原目标在就近祖先层级找得到即改写为 PARENT-N-PROJECT_LOC 宏形态，找不到的原样回列不臆造；这正是 build 陈旧链接拒绝的 AI 自服务闭环：修复后重试 mrvc_build）/ `mrvc_check_preprocessor`（三预处理宏列表一致性检查，只读报告不修复，0.3.7）/ **`mrvc_set_config_option`**（**配置写工具，0.3.7 批五**：include 路径/宏定义/优化等级/链接脚本四类字段的**整表替换**写入——先读回再全量写回，空表=清空；工程内绝对路径与裸相对路径自动转 MRS `${workspace_loc:/${ProjName}/rel}` 存储拼写；C/C++ 双列表默认成对写入（language=both）防两语言分叉，可单选 c/cpp（include 另可 asm）；优化等级接受 MRS 枚举拼写 size/none/optimize/more/most/fast/debug/z，非法值拒绝并回列合法表）/ **`mrvc_manage_configurations`**（配置管理：list / add（深拷贝既有配置，默认活动配置，copyFrom/copyFromIndex 指定拷贝源与同名行）/ rename（活动配置改名同步改写 .template Target Path）/ delete（活动配置拒绝删除、至少保留一个）/ **setActive**（把所选配置移到下标 0——MRS 保存语义 A,B,C→C,A,B，同步改写 .template Target Path 并重排标记快照，已是活动配置则空跑）；index 消歧同名行；重名拒绝——Windows 大小写不敏感，配置名即输出目录）/ **`mrvc_set_build_exclusion`**（**Exclude/Include From Build 写工具，0.3.8**：按 CDT sourceEntries 排除表写——与工程树 Exclude/Include From Build 完全同语义；path 为**逻辑路径**（工程相对或 `链接名/子路径`）；排除带命名 sourceEntry 的顶层目录会**移除该命名 entry**（root token + 命名 entry 并存只是 CDT re-include 标记，entry 不除排除不生效），include 反向补 token 与重建命名 entry；`action=check` 只读回排除态+排除表；写活动配置（MRS 语义））/ **`mrvc_rename_project`**（**工程重命名，0.3.8**：.project 显示名、调试 launch 配置（改写并改名 `<新名>.launch`）、`<新名>.wvproj` 标记（旧标记删除）、.template Target Path 文件名段；.cproject 不动；非法名拒绝）/ **`mrvc_switch_project_type`**（**C↔C++ 转换，0.3.8**：切 C++ 时写 ccnature + C 选项全覆盖镜像到 cpp 孪生 + 加 C++ 编译器 inputType（只切 nature 会缺 include/链接脚本）；切回 C 移除 inputType（镜像值保留，扩展同款）；同态调用空跑）/ **`mrvc_list_linked_folders`**（链接目录全量清单：链接名/宏形态 locationURI/解析绝对路径/磁盘存在性；**严格只读**——不做首开自动修复、零写入）/ **`mrvc_add_linked_folder`**（新增链接目录并**按扩展 Add 命令同款语义接入构建**：.cproject 增加 C/汇编 include 项、根扫描排除标记、命名 sourceEntry；location 必须是**绝对路径**且磁盘存在的目录，工程外目标存 PARENT-N-PROJECT_LOC 宏形态保持工程可移植；重名拒绝，链接名拒绝 `\ / : * ? " < > |`——与扩展输入框同校验）/ **`mrvc_change_linked_folder_target`**（**链接目录改目标，0.3.8**：改写 .project locationURI 为 PARENT-N-PROJECT_LOC 宏形态；链接名不动（.cproject 引用按名继续有效）；指向工程根本身/祖先/经链接解析回工程根的目标拒绝；目标可不存在但不可读会在响应带 warning（构建会拒，`mrvc_repair_project includeStaleLinks` 可再修）；大小写变体链接名折叠匹配到正名；未知名拒绝）/ **`mrvc_remove_linked_folder`**（按链接名删除并同步清理 .cproject 引用（include 项、命名 sourceEntry、根扫描排除标记）——与扩展 Remove 命令同款；构建按名引用链接，删除仍被源引用的链接会改变编译范围，删后建议跑 audit；未知名拒绝）。**九个写工具共用同一写保护壳**：涉及的 `.cproject`/`.project`/**`<工程名>.wvproj` 真实标记**/**`.template`**/**`*.launch`** 先备份到 `.vscode/mrvc/mcp-backup/<时间戳>/`，经核心层全新加载修改，写后重新解析（.template 亦做可解析检查）——解析失败自动还原备份并报错，不留半写状态；返回体带 before/after 与备份目录供 AI 自查 / `mrvc_build`（target=build/rebuild 现生成 makefile + MRS make；**build/rebuild 前置陈旧链接门禁**：链接目录目标不存在即拒绝并逐项回列可修复目标——拷贝来的 EVT 工程不再静默少编译整个链接目录，在扩展中打开一次（首开自动修复）后重试；clean 不门禁（从不扫描源文件）；clean 对齐扩展——用既有 makefile 跑 `make clean`、未构建工程确定性空跑不生成；rebuild=扩展同序先旧 makefile 清（失败中止）再生成再编，`configs=active|all` 多配置编排——all 语义与扩展 ReBuild/Clean-All 一致：build 逐配置首败即停、clean 跳过未构建配置且失败不停、rebuild 先清阶段后编各配置（MRS 同款两段式）；`analysis=true` 生成 -fstack-usage/-fdump-rtl-expand 埋点 makefile；`timeoutSec` 硬超时默认 600s / `MRVC_MCP_BUILD_TIMEOUT_SEC`（每次 make 调用独立计时），返回退出码+输出尾部+产物大小（静态库工程报 .a）；**MCP 构建日志只在返回值中、不写扩展构建记录**——记录承担下载目标解析与完整指令清单职责）/ **`mrvc_compile_file`**（**编译单个文件，0.3.8**：现生成 makefile + make 单目标——扩展 Compile Single File 的无头形态；file 为逻辑路径；已排除文件/未知后缀/纯 C 工程给 C++ 文件/陈旧链接工程全部拒绝；结果只在返回值、不写扩展构建记录）/ **`mrvc_delete_output`**（**删除输出目录，0.3.8**：扩展四个删除命令合为一具——scope=active/all（配置名即目录名），keepImages=true 只留 `<target>.hex/.bin` 其余全清，否则整目录删除；删除清单按构建模型逐文件清点（0.3.8）——只删该配置构建写出的文件（含链接器映射与栈用量 .su），链接输入库等非构建文件保留并回列 `survivors`，整目录删除遇非构建文件明确拒绝；从不触碰 `<工程>/<配置>/` 之外，符号链接输出目录拒绝；无需 make 与工具链）/ `mrvc_stack_usage`（活动配置构建目录的 GCC .su 栈用量汇总：函数数/总自用栈/动态帧函数/Top N，0.3.7）/ `mrvc_call_analysis`（-fdump-rtl-expand 调用图边表 caller→callee，C/C++ 源文件的任意后缀拼写均识别，0.3.7）/ `mrvc_get_build_log` / `mrvc_export_cmake`（已存在的 CMakeLists.txt 拒绝覆盖，需显式 overwrite；陈旧链接门禁同 build）/ `mrvc_generate_intellisense_db`（生成 `.vscode/compile_commands.json`，含被排除文件的精确编译参数；陈旧链接门禁同 build）/ **`mrvc_flash`**（OpenOCD 下载，跟随 .template Target Path/Address/Erase All，双核自动 wch-dual-core.cfg）与 **`mrvc_power_off_reset`**（掉电复位 pow 段 off→延时→on，仅 LinkE/DAPLink/LinkW，普通 WCH-Link 拒绝）/ **`mrvc_set_power_output`**（**电源轨立即切换，0.3.8**：off→延时→按请求轨 on，每段 marker 验证；门禁=扩展手动 Power-Off Reset 凭据（轨操作以人工放行为锚）+ 链接型号门（普通 WCH-Link 拒绝）；**语义=立即生效**，不做会话 latch——mrvc_flash 电源步跟随其自身已验证计划）/ **`mrvc_check_wchlink_firmware`**（**WCH-Link 固件只读检测，0.3.8**：FFI OpenDevice/GetDeviceVersion 探测，返回型号与当前/期望版本对；upgrade-needed 附指引（WCH-LinkUtility 升级——IDE 按此门禁下载，MRVC 从不写链接固件））。**硬件硬门禁（两类操作各挂独立凭据）**：① 扩展在每次**手动下载成功后**写入 `.vscode/mrvc/flash-verified.json`，内含 ① .template 内容 SHA-256（改参数未重新手动下载即失效）② **实际执行的 FlashPlan 指纹**（脚本 SHA + 固件路径 + 地址 + verify/reset/eraseAll/banks + board cfg 路径与内容哈希 + openocd 路径 + powerOn 轨）——`mrvc_flash` 的**计划指纹必须与凭据逐字段一致**（来自扩展设置、MCP 读不到的地址/verify/cfg 由拒绝消息原文回列，AI 按回列参数精确传参即可对齐；power-off 轨流程 MCP 不复刻，单独提示）② **`mrvc_power_off_reset` 用独立电源凭据**：扩展里**手动 Power-Off Reset 成功**（Info 视图行/命令面板）后写入 `power-verified.json`（电压/延时/board cfg 路径与哈希/openocd 指纹），请求计划不一致同样**回列已验证序列**拒绝——烧录凭据不为电源轨操作背书。两工具均接受 `openocdPath` 显式参数（对齐扩展的 `mrvc.openocd.path` 自定义安装）。**凭据本机绑定**（hostname+user 哈希；工程被复制到别的机器即读作未验证，须在本机重新手动验证）且 `.vscode/mrvc/` 下**自动维护 .gitignore** 防凭据入库（若 `.gitignore` 写入确认失败则 fail-closed 拒绝落盘凭据并给出非阻塞警告提示，不影响已完成的下载/掉电复位操作）；损坏/旧格式凭据报 **corrupt** 并引导重新手动执行，不以内部错误泛化。③ 硬件工具与构建走**进程内互斥**（流水线客户端不会同时开两个 link 会话），server 退出时终止存活子进程并**等待真实 close**（POSIX 杀整组进程树；Windows 杀直接子进程为已知限制）。固件**内容**哈希只记录不比对（重编译→同路径重烧是本门禁要放行的核心 AI 工作流；参数才是用户确认的对象）。**其余边界（有意为之）**：配置写工具只碰配置字段（0.3.8 批六扩至：include/宏/优化等级/链接脚本、警告开关、调试级别、C/C++ 方言、USER_OBJS/库/库搜索路径、产物名/输出前缀等构建身份）与配置/链接目录/排除表/工程名/工程类型结构（且全部走写保护壳），其余工程内容不写；无头下载不含芯片不匹配对话/SDI printf/固件升级提示（由手动验证下载覆盖）；**With-MRS 构建三态与 mrsValidate 深度校验暂无 MCP 面**（需新写无头 MRS 会话模块，0.3.8 裁决缓议）；协议为手工实现的 MCP stdio JSON-RPC（无新依赖） |

## 打包与安装（.vsix）

```bash
npm run compile      # 先编译（esbuild 打包出 out/extension.js）
npm run package      # 生成 mrvc-<version>.vsix（@vscode/vsce，--no-dependencies）
```

安装（三种任选）：
- VSCode 图形界面：扩展视图 → 右上角 `···`（Views and More Actions）→ **Install from VSIX...** → 选择生成的 `mrvc-<version>.vsix`（文件名跟随 package.json 的 version）
- 命令行：`code --install-extension mrvc-X.Y.Z.vsix`（X.Y.Z 换成实际版本号；不要写 `<version>`，尖括号在 cmd 里是重定向符）
- 直接把 `.vsix` 拖进扩展视图

**安装路径自动探测（0.3.6）**：设置留空时激活即探测惯例位置（Windows `C:\` / `D:\MounRiver\MounRiver_Studio2|3`；Linux/macOS 各自惯例根），**命中的根路径自动写入用户级设置**（`mrvc.mrs2InstallPath` / `mrvc.mrs3InstallPath`，下次启动不再探测；以提示告知）；**两代并存且 `mrvc.mrsVersion` 仍为 auto 时弹一次代次选择**（使用 MRS3 / 使用 MRS2 / 保持自动，globalState 只弹一次）；用户显式设置的路径永不被探测覆盖，探测不到时走原启动门禁引导。

> `.vscodeignore` 打包清单（以 `tools/verify-vsix.mjs` 的白名单为权威校验）：`out/extension.js`(+map) + `mcp/mcp-server.js`、
> `package.json` + `package.nls.json` + `package.nls.zh-cn.json`、README、`media/*.svg`、`resources/icon.png`、
> **vendor 运行时两棵树**——`vendor-ffi/node_modules/koffi`（wlink 桥 FFI：JS + 各平台 prebuild + 许可证）与
> `vendor-serial/node_modules`（SDI 串口监视器 serialport 运行时 + N-API prebuild）。
> 版本号升级后重新 `npm run package` 即可（输出文件名跟随 `package.json` 的 version），打包后跑 `npm run verify`。

## 使用

> **首次激活会弹出免责声明**（每次安装仅一次）：MRVC 是**非官方独立项目**，并非由 WCH 或 MounRiver 开发或
> 提供支持；它直接打开、配置和构建面向 WCH MCU 的 MounRiver（MRS）工程，仅供开发与调试使用。
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
- `exclude-test.js` — 排除/恢复编译语义（含混合风格与真实工程回归）
- `rename-test.js` / `output-test.js` — 工程重命名与输出目录清理
- `solution-test.mjs` / `discover-test.mjs` — solution 解析生成 / 工程发现
- `flash-test.mjs` — 烧录 cfg 生成（地址覆盖/verify-reset 组合/非法地址）
- `taskrunner-test.mjs` — 任务等待器取消竞态（executeTask 解析前/后、已取消 token、identity 匹配）
- `treescope-test.js` — 工程树**作用域刷新**（节点 identity 缓存、build/source 目录事件只 fire 对应节点、目录消失时联动父节点、store 防抖/挂起折叠）与**输出目录按磁盘显示**（子目录递归、`.o/.d/subdir.mk` 行、删除镜像目录后的刷新与剪枝、子目录行与输出目录行的菜单对等）
- `buildmanager-test.mjs` — 单工程构建 guard 生命周期（rebuild clean 失败/取消/wrapper 异常后再次构建不被锁死）
- `wlink-test.mjs` — WCH-Link 桥（P/Invoke 脚本生成/load.wcfg/降级路径）
- `intellisense-test.js` — IntelliSense 双库生成/切换/JSONC 保护/哈希门控
- `mrstools-test.js` — MRS Tools 六工具路径解析与缺失降级
- `mcpexport-test.js` — 「导出 AI MCP 服务器」：导出计划（按宿主平台决定是否带 koffi）、目标文件夹判定（空/自己的/他人的）、就地增量写入与不删除、命令层（对话框/模态确认/消息/剪贴板）、接线，以及**扩展内与导出后两种布局的真实启动冒烟**（导出副本必须能独立启动并回报导出时写入的版本号）
- `webview-test.js` — 属性页/Sync 页真实渲染（脚本语法、注入探针、批量写回）
- `mass-test.mjs` — **本地测试全树批量回归**（解析/扫描/排除/芯片库/makefile 字节稳定性，覆盖全部工程）
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
│   ├── output.ts      # 输出目录清理（边界守卫与执行期复核）
│   ├── outputHistory.ts # 持久化构建写入历史（SHA-256 所有权验证、跨进程锁与包含性约束）
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
    ├── ppCheck.ts     # 预处理宏一致性检测与统一流程（工程右键/打开提醒）
    ├── mrsTools.ts    # MRS2 Tools 工具启动器
    ├── fileOps.ts     # 文件管理右键（新建/复制/粘贴/重命名/删除/路径复制）
    ├── exclude.ts     # Exclude/Include From Build 命令与装饰数据
    ├── renameProject.ts # Rename Project / Sync Project Name from Folder
    └── linkedFolders.ts
└── mcp/               # 独立 stdio MCP 服务器（0.3.6，零 vscode 依赖，esbuild 第二入口）
    ├── server.ts      # MCP stdio JSON-RPC 协议层（手工实现，无新依赖）
    └── tools.ts       # 二十七工具包装 core（发现/安装/配置读改/配置管理/排除表/重命名/类型切换/链接目录/审计修复/宏一致性/构建/单文件编译/清输出/栈用量/调用图/记录/CMake/IntelliSense/烧录/电源控制/固件检测）
```

工具组件全部来自 MounRiver 安装目录（`resources/app/resources/win32/`，MRS2 与 MRS3 布局相同）：
`components/WCH/Toolchain/*`（GCC8/GCC12/GCC15）、`others/Build_Tools/Make`、
`components/WCH/OpenOCD`、`components/WCH/Others/SWDTool`（WCH-LinkUtility）、
`components/WCH/Others/CommunicationLib`（WCH-Link 操作 DLL）、`components/WCH/SDK`（芯片数据库）。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。
