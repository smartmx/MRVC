# MRVC 更新日志

## V0.3.0（2026-11-13）

### 变更

- **树单击工程行即激活（0.3.0）**：Project Explorer 里**单击工程行即设为活动工程**（选择=激活，
  Info/编译/下载随动）；挂在既有的 500ms 防抖选择处理器上，同一工程重复选择不重复触发（root
  比对防重入）。
- **工程树作用域刷新（0.3.0）**：文件监视与编译结束后的刷新**不再整树重建**——watcher 事件只记录
  "发生变化的目录"，树只重读对应节点（源文件所在目录 / 编译输出目录）；编译任务运行期间树保持
  冻结，任务结束后只刷新被触及工程的输出目录节点。链接文件夹的蓝→白→蓝整树闪烁因此消失。
  全树刷新仅保留在：手动 Refresh、工程集合变化、配置文件（.project/.cproject/.template）变更
  （后者需要重新解析工程，属于必要的工程级刷新）。
- **编译/下载进度提示与手动结束（0.3.0）**：工程行内 **Build / Rebuild / Download**（含右键
  **Build Project And Download**）运行期间弹出可取消的进度通知（正在编译 / 重新编译 / 下载
  “工程名”）。通知覆盖 makefile 生成到任务结束的整个等待期；点取消会终止当前 `make` 或
  OpenOCD 任务——重建先终止 clean 阶段并跳过后续 build，编译并下载则同时停止后续下载。
  Clean 保持原有行为，不显示进度通知。
- **SDI PRINT 监视器（读取端）**：树标题工具组新增 **SDI PRINT Monitor**（命令面板含 停止 命令）。
  勾选 **SDI Printf** 的工程在**主下载成功后**自动执行 **WCH-Link 原生“复位+使能”pass**：通过
  MRS 同款 `MRSFunc_FlashOperationExB`（flags = RESET|SDIPrintf = 0x11）在**一次 DLL 会话**内
  复位目标并写入 SDI printf 开关（MRS 官方实现即此路径；`McuCompiler_SetSDIPrn` 的参数是
  **禁能位**，0 = 使能）。此前尝试的 OpenOCD `sdi_printf enable` **不可用**：它让 Link 重新
  枚举 USB、当场杀死所在会话（真机日志停在 `SDI_PRINTF ENABLE`，没有 init/reset），也无法在
  同一次会话里完成“复位 + 使能”。pass **不再自动打开 VSCode 串口监视器**（用户可能正用
  SSCOM 等外部串口工具占用 WCH-Link 的 CDC 口，自动开会与之冲突）；要抓复位后的启动输出，
  请在**下载前手动打开 SDI PRINT Monitor**（EVT 例程 banner 只在 main 开头打印，晚开会错过）。
  pass 失败只告警，不影响已成功的下载。之后芯片的 printf 经 Link
  解码从其 CDC 串口持续输出。监视器在 VSCode 终端里实时显示该输出：串口**只认
  `VID_1A86/PID_8010`（"WCH-Link SERIAL (COMx)"）**，板载/独立 CH343/CH340 等 USB 串口绝不会
  被自动选中；多台 Link 弹选择框；`mrvc.sdiPrint.port` 可显式指定、`mrvc.sdiPrint.baud`
  为打开参数（SDI 流与波特率无关）。读取实现内置 **serialport 11**（MRS2 自带串口终端同款，
  N-API 预编译 win32-x64 / linux-x64 / darwin，随包发货）。串口打不开时终端**保留错误信息**
  （并提示可能被其他串口工具占用），不再瞬间消失。**下载成功后只执行上述原生 pass，不自动
  打开监视器**；监视器由用户按需手动启动（下载前启动即可捕获启动输出）。
- **修复：下载设置复选框保存丢失**：下载设置页的导航项 `<div class="nav-item" data-page="dlset">`
  在 DOM 中先于页面容器，收集脚本的裸 `[data-page="dlset"]` 选择器命中导航项——复选框查找全空，
  8 个布尔**恒写 false** 却仍提示"保存成功"（下拉/文本走 getElementById 不受影响）。修复=选择器
  限定 `.page[data-page="dlset"]`，并加行为级回归（提取真实 emitted collectDl 对 nav-shadow DOM
  求值，裸选择器必 FAIL）。
- **修复：属性页 Apply 会删 enumerated 选项的 value 属性（导致 MRS 打不开工程）**：CDT/MRS 给
  enumerated 选择存的是 **base 中缀形态**（`…option.base.target.rvGcc.8`），MRVC 的枚举读取只认
  `…option.target.rvGcc.` 前缀、解析不出 → 下拉框回落到第一项"Project default"→ **Apply 时把
  `value` 属性整个删除**；而 MRS 自己的解析器对 rvGcc 选项**无保护地 `value.match(...)`**——属性
  缺失即扩展崩溃，工程树挂载失败，**该工程在 MRS2/MRS3 里也打不开**。已修复：枚举读取识别 base
  形态（下拉正确显示当前值）；enumerated 选项的清除**永不删除 value 属性**（MRS 硬约束）。
  受影响工程（TCP_SERVER / MACRAW / TCP_CLIENT，属性 Apply 过即中招）的 `.cproject` 已按其
  GCC8 工具链补回 `value` 属性，可直接打开。**本轮再加一道结构性保险**：Apply 先按渲染时的
  快照逐字段比对，**只写入用户真正改动的字段**——未改动选项在 `.cproject` 里保持逐字节不变
  （回归探针：整表原值回发后文件字节相同）；下拉框不认识的既有枚举值渲染为 `(current)` 并
  原值回写，绝不被第一项覆盖；原本不存在的选项在未触碰时也不会被"顺手创建"。**写前还有结构门禁**：
  `.cproject` 的原始 XML 先过严格校验（标签栈 + 根外文本/裸标记 + 标记位置 + 字符数据/属性值
  的词法规则：裸 `&`、未声明实体、属性值裸 `<`、字符数据 `]]>`、注释 `--`、非法 XML 1.0 字符与
  非法字符引用如 `&#0;`，以及**非法 UTF-8 字节**——按 fatal 模式解码，绝不把坏字节静默替换成
  U+FFFD 再写回），不合法时直接报错并指向「检测并修复工程配置」，一个字节都不写。
- **修复：工程树 Refresh 按钮不刷新工程内的文件列表**：刷新命令只重扫工作区的"工程根集合"，
  工程集合没变时不会发出变更事件，VS Code 继续显示缓存的子节点——在工程里新增/删除文件后
  （例如删掉旧日志）点刷新毫无效果。现在刷新结束**无条件**发事件，树对每个展开的目录重新
  `readdir`。
- **检测并修复工程配置**：工程右键/命令面板新增 **Audit And Repair Project Configuration
  （检测并修复工程配置）**。体检项：①enumerated 选项缺 `value` 属性（本次 MRS 打不开事故的
  通用化——**可自动修复**：移除该选项，CDT 语义=继承默认，MRS 读者不再看到坏元素）②`.template`
  Address 非 0x 格式（**可自动修复**：清空，下载回退自动推断）③rvGcc 值形态异常④`.project`/
  `.cproject` XML 结构/语法损坏（标签栈 + **根外文本/裸标记检查** + **CDATA/DOCTYPE/XML 声明
  的位置约束** + 重复属性 + **字符数据与属性值的词法规则**：裸 `&`、未声明实体、属性值裸 `<`、
  字符数据 `]]>`、注释 `--`、**非法 XML 1.0 字符**（原始控制字符、`&#0;`/surrogate/noncharacter
  等非法码点）与**非法 UTF-8 字节**——严格 XML 解析器拒绝、而宽松解析器"能读"的形态都会被报出；
  DOCTYPE 内部子集的 `<!ENTITY>` 声明会被识别，合法文档不误报）⑤`.project` name 与文件夹名不一致（③④⑤仅报告）。修复前**逐文件
  备份**到 `.vscode/mrvc/repair-backup/<时间戳>/`，模态列出全部问题、显式确认才写入。
- **使用 MounRiver IDE 打开**：工程右键新增 **Open With MounRiver IDE（使用 MounRiver IDE 打开）**——用当前生效的 MRS 安装
  打开该工程的 **`<工程名>.wvproj`**（MRS 以 .wvproj 工程文件为打开入口，而非文件夹）；
  启动参数与 MRS 安装器注册的 Shell 右键同款：**两个独立参数 `-m` + 工程文件**
  （扩展内部自用的 `-m=` 连写形态在真机只设标题、不挂工作区——窗口空载，已实证避开）。
  **Windows 实际形态**：PowerShell `Start-Process -WorkingDirectory <工程根> -ArgumentList
  '-m','"<.wvproj 绝对路径>"'`（绝对路径**带内嵌双引号**），脚本经 `-EncodedCommand`
  （base64 UTF-16LE）送达——PS 5.1 的 -ArgumentList 不给元素加引号，内嵌引号保证含空格的
  绝对路径仍作为单个参数到达；MRS 自身要求绝对路径（相对文件名会弹 "The following file path
  is not absolute"，真机实证），`-Command` 通道会剥掉内层引号，故必须走 EncodedCommand。
  **POSIX**：`sh -c '"$1" "$2" "$3" >/dev/null 2>&1 &'` 传**绝对路径**，引号天然支持空格。
  启动器自动解析：Windows `MounRiver Studio {2,3}.exe` / Linux `mounriver-studio {2,3}`
  （根或 bin/，名字带空格） / macOS `Contents/MacOS/Electron`。启动经**分离包装**——任务瞬间
  完成，MRS 独立存活，不在任务列表留下常驻实例（GUI 与窗口同寿命，常驻任务会堆叠并弹出旧实例
  选择框）；包装任务失败（含 executeTask 拒绝/瞬间退出）经执行身份缓冲的监听器可靠上报；
  当前生效配置为纯工具链（无 IDE）或工程缺 .wvproj 时明确报错。
- **掉电复位 + 电源输出**：工程右键/命令面板新增 **Power-Off Reset（掉电复位）**——经 WCH-Link
  电源轨对目标 **断电 → 延时 → 上电**（OpenOCD `pow3v3/pow5v off|on`，本机 fork 实证；两路共用
  电源状态，只发实际供电一路）。设置 `mrvc.flash.resetMode=powerOff` 后**下载自动走断电流程**：
  断电一次 → 延时 → 上电与烧写在**同一 OpenOCD 会话**完成；`mrvc.flash.powerOutput` 选 3.3V/5V、
  `mrvc.flash.powerOffDelayMs`（0–10000，默认 100）控制断电时长。适用于 NRST 被调试接口复用的
  1/2-wire 芯片——模式切换由属性页 FFI dbgMode 完成，掉电复位使其生效。**型号门禁**：可控电源输出
  仅 WCH-LinkE / DAPLink / LinkW 支持（官方手册口径）——普通版 WCH-Link 在命令/下载前被模态明确拦截，
  不再跑两个注定失败的 OpenOCD 段；无 pow 命令的旧 fork 日志（`invalid command name`）按真失败处理。
  **成功证据**：断电/上电两段都以本次日志中的标记行（`MRVC_POWER_OFF_OK` / `MRVC_POWER_ON_OK`，
  紧跟在电源轨命令之后输出）为 done 判据，exit 0 本身不算——未编译工程没有 `obj/` 时 OpenOCD
  不写日志也会 exit 0，过去会被误判为"复位完成"而电源轨从未动过；日志目录现自动创建，日志被
  索引器/杀软占用时改用本次唯一文件名，旧日志不会污染判定。**任务未启动**（拿不到进程结束事件）
  一律判失败——即使日志里出现标记也只可能是陈旧内容。
- **下载瞬态重试**：**使能与掉电复位各内部段**经 OpenOCD `-l` 日志识别 WCH-Link 重新枚举类瞬态
  失败（`wlink open error` / `unknown wch-link` / USB 上下文的 open 失败），自动退避重试（最多
  2 次）；**主下载不带 `-l`**——`--log_output` 会把进度 echo 整体重定向进文件、任务终端只剩横幅
  （0.2.9 的"看起来没反应"回归），主下载保持终端实时进度、不重试（重枚举风险已由前置段的分类器
  与 1.2s 等待吸收）；传给 OpenOCD 的日志路径一律**正斜杠**（Jim Tcl 吃反斜杠——此前会在工程根
  落下扁平怪名日志文件）。已知边界：文件名含 "link" 的打开错误会被误判为瞬态（代价=内部段一次
  多余重试）。
- **Info 信息视图**：工程列表下方新增 **Info** 视图，四行显示 ①当前生效 MRS 配置（IDE 安装还是
  纯工具链、MRS2/MRS3、安装路径、偏好回退状态；点击行直达 MRVC 设置）②当前选中工程名
  ③该工程的工具链（名称与前缀；与构建链同源——`mrvc.customToolchains` 合并后的生效安装，
  自定义工具链也正确显示）④**SDI Printf 状态**：WCH-Link/CommunicationLib 只提供写命令
  （`McuCompiler_SetSDIPrn`）、**没有回读接口**，所以该行只反映 MRVC 本次会话下载时“复位+使能”
  步骤的结果（已使能 / 上次失败 / 本次下载未使能 / 未知；重载窗口后回到未知，打开监视器时
  若找不到 WCH-Link 串口也会重置为未知），
  点击行打开 SDI PRINT 监视器。工程切换、`mrvc.*` 配置修改后**自动刷新**。
- **编译链路零重复解析**：生效安装的解析本就按设置键缓存（不改设置不重验）；本轮再补
  工程级工具链解析 memo（同输入直接复用，`mrvc.*` 配置变更即失效），并新增计数 seam
  断言"设置不变时重复编译不再触发安装重探测"。POSIX 架构核对保持每次编译执行（警告不消失）。

## V0.2.9（2026-11-10）

### 变更

- **Erase All 下载日志补齐进度输出**：勾选 **Erase All** 的工程走手工展开的 OpenOCD 脚本，
  此前 `flash write_image` / `verify_image` 在默认日志级别下一行输出都没有——任务窗口只有
  `device id` 与 `shutdown command invoked`，看起来像"点了没反应/没下载进去"（实际已写入并校验）。
  现在脚本在该分支输出与内置 `program` 命令同构的 `** Programming Started **` /
  `** Programming Finished **` / `** Verify Started **` / `** Verified OK **` /
  `** Resetting Target **`；失败时错误行照旧可见且任务以非零退出码结束（下载失败提示不受影响）。
- **下载前目标芯片一致性校验（对齐 MRS2/MRS3）**：此前把 CH32V307 工程下载到 CH32V407 芯片上
  会照常烧写（板子自然不运行），而 MRS2/MRS3 会拒绝这种系列不匹配的下载。现在下载前用
  `MRSFunc_GetLinkedMCUID`（与 Download Settings 的 Linked MCU Type 同一查询）取 WCH-Link 上
  芯片的 flash-control id，与工程 `.template` 目标芯片的 flash-control id（MRS2 `getFlashControl`
  同一语义：SDK `<series>-flash.json` 的 `id`，含 `special` 单型号覆盖——如 CH32V203CCT 实为
  CH32V205 的 id 206——以及 `mcu.slice(0,-1)` 的 zip 名容错）比对；两者都已知且不同时弹
  **模态警告**（显示的连接型号 vs 工程目标型号），只有显式选择"仍然下载"才继续，取消/Esc 中止
  下载。查询结果**只在初始化确认完成时采信**（设备打开且 CompareVersion 返回 0；裸查询可能返回
  Link 自身 id，6 恰好与 CH32V30x 撞号——初始化失败、需升级固件、无 `wchlink.wcfg` 等情形一律按
  "未知"静默放行）。查询在任何环节不可用（SDK 芯片库缺失、无 Link、FFI 桥失败、未知 id）时同样
  不改变既有下载流程。机制说明：MRS2/MRS3 是把工程 chipId 交给
  `MRSFunc_FlashOperationExB`、由 DLL 在烧写时报 10006 "Chip type mismatch."；MRVC 的烧写走
  OpenOCD，故把同一 id 比对前置到下载之前。共享 family id 的系列（如 78 = CH32M007 与
  CH32V002/4/5/6/7）在提示里全部列出，避免显示错别名。无 `.template` 的 EVT 工程（下载地址
  由源文件前缀推导）没有可比对的目标芯片，**不会发起一次无意义的 Link 查询**。
- **下载目标修正（.template Target Path，先询问不自动改）**：EVT 工程常记录跨工程的
  Target Path（如 `CH394Q__MACRAW` 记录的是 `obj\CH394Q__TCP_SERVER.hex`，本机并不存在该文件），
  下载时虽已按回退链使用本工程产物，但 `.template` 仍留着失效值。现在**点下载时**若记录的
  Target Path 指向不存在的文件、而本工程构建产物存在，则**弹窗询问是否修改 `.template`**
  （默认不修改：取消则保留原值、按回退目标照常下载）；用户确认后回写为相对本工程的产物路径
  （MRS 惯例写法），并提示修改成功、可重新点击下载。目标文件存在的场景（包括有意共享其他产物、
  Merge.Bin 等）一律不改动；`.template` 其余行保持字节保真。
- **未编译提示**：工程从未编译、既没有 `.template` 指向的固件也没有本工程构建产物时，下载不再
  弹文件选择器，而是明确提示**先编译工程再下载**（应生成的产物路径随提示给出）。
- **Linked MCU Type 查询对齐 MRS2（0.2.9）**：Download Settings 的 **Linked MCU Type** 此前在
  LinkE 等新型号上查不到（`MRSFunc_GetLinkedMCUID` 无前置初始化时返回的是 Link 自身 id 2/6 而非
  MCU 家族号）。现按 MRS2 getChipID RPC 的顺序先做一次 OpenDevice → CompareVersion → CloseDevice
  初始化（POSIX 进程内 koffi 与 Windows PowerShell 桥同实现；Windows 侧 CompareVersion 以
  try/finally 保证关闭设备），再查询并用芯片库把 SDK 系列 id 解析成显示名（如 CH32V30x）回填；
  无 `wchlink.wcfg` 时保持旧的裸查询回退。
- **免责声明（非官方）**：README 顶部与扩展描述（package.json `description`）显式声明——MRVC 为
  个人独立开发项目，**非 WCH / MounRiver 官方开发或官方支持**，仅供开发调试使用。
- **市场图标去白边**：`resources/icon.png` 重绘为**透明圆角、黑底满铺**（此前为白底+四周留白，
  在扩展市场/扩展视图的图标块里会显示一圈白色）；图形与 0.2.8 定稿一致（黑底白图、四边引脚、
  MR/VC 方框内排布）。

## V0.2.8（2026-11-09）

### 变更

- **工程合法性收紧（三文件：`.wvproj` 打开标记 + `.project`/`.cproject` 附属文件，单一契约）**：明确
  工程语义——**MRS 工程通过「工程名.wvproj」打开（标记与入口），且 `工程名.wvproj`、`.project`
  （可解析工程描述）、`.cproject`（构建配置）三文件同时存在才进入发现树**（仅有 `.project` +
  `.cproject` 的 MRS1-era 旧目录不再进入树）。发现/加载/状态恢复/刷新/文件监听**五处共用同一判定**：
  三文件缺一的半删除/探针残留目录此前会在加载时以 ENOENT 崩出（"打开 MRS 工程失败：no such file
  or directory … .cproject"），现在发现阶段直接跳过、显式 `add()` 给出明确警告（列出实际缺失的
  文件，且目录消失/不可读也不再抛出中止整次扫描）、状态恢复同样要求三文件齐全；**已加载工程运行中
  删除任一必需文件不再留僵尸**——文件监听与 Refresh 都会把它从树里移除（此前只监控 `.project`
  删除）。Open MRS Project / Solution 的文件过滤器**只处理 `.wvproj` 与 `.wvsln`**（`.project`/
  `.cproject` 是附属文件，不是打开对象）。Solution 恢复探测（深度 0）语义随之澄清：合法工程根仍
  截停（工程目录永不含 solution），残缺目录不再算工程根——其直属 `.wvsln` 会被收集。
- **WCH-Link 固件版本检测（只读，烧录前）**：下载前对已连接的 WCH-Link 做一次**只读**固件版本
  核对（OpenDevice → CompareVersion → GetDeviceVersion → CloseDevice，零写入、零 IAP 切换，任何
  检测失败都静默放行绝不阻塞下载）——版本低于安装目录 `wchlink.wcfg` 的期望值时弹模态提示（显示
  Link 型号与当前/期望版本，语义与 MRS3 下载前的 doUpdate 检查一致），提供 **打开 WCH-LinkUtility**
  （由它完成固件升级）与 **仍要烧录** 两个选择；**只有显式点击"仍要烧录"才继续**——Esc/关闭对话框
  一律取消本次下载（与 MRS 的取消语义一致，绝不带着已知过旧的固件静默烧录）。设备版本不在有效
  10–99 区间（FFI 读到垃圾值）时静默跳过检测，绝不显示伪造版本号；Windows 检测脚本以 finally 保证
  CloseDevice（异常路径不占用 USB 设备）。版本判定依据 `wchlink.wcfg`（MRS3 安装自带，DLL
  自行解析）；MRVC **不实现固件刷写本身**——升级动作完全交给 WCH-LinkUtility。实现沿用既有
  wlink 桥（Windows PowerShell P/Invoke 新增 4 个只读声明；POSIX koffi 新增同款绑定，
  `int*` 出参以 Buffer 传递），新增只读导出与既有 8 个配置型操作互不影响。
- **懒激活（打开文件夹不再立刻扫描/建分析）**：`activationEvents` 从 `workspaceContains`（打开
  含 MRS 工程的文件夹即激活，激活后 800ms 自动扫描 + 生成编译数据库）改为 **`onView` + `onCommand`**
  ——打开文件夹后 MRVC 完全不启动、不占用扩展宿主；**点开活动栏 MRVC 视图**，或从命令面板执行
  `MRVC: Open MRS Project / Solution` 选中 `.wvproj`/`.wvsln`，才开始：扫描工程 → 生成
  `.vscode/c_cpp_properties.json` 与编译数据库 → 检查 cpptools。初始化为**一次性记忆化**
  （`ensureWorkspaceInit`），视图可见与**全部工程型命令入口**共享同一次运行——命令面板直接执行
  Build/Flash/属性页等（含快捷键与 `executeCommand` 调用）会先自动完成扫描，绝不误报"没有工程"；
  纯工具/设置/文件节点操作类命令豁免（不触发扫描）。首次扫描失败不缓存——下一次用户动作自动重试
  并报告原因。安装门禁与全部监听器随激活顺延，激活前零开销。注意：若上一次会话把 MRVC 视图留在
  展开状态，新窗口恢复布局时视图可见即视为"点击"（实现已消除创建时序竞态：注册监听器后补查
  `treeView.visible` 初始态）。
- **插件图标**：新增黑白「芯片 MRVC」图标（`resources/icon.png`，128×128）——黑色圆角底板 +
  白色 IC 封装（四边各 4 引脚）+ 框内 2×2 栅格 MR/VC，字母为手绘等线电路笔法路径（不依赖字体，
  任意分辨率不变形）；黑白配色保证深色/浅色主题下均可正常显示（暗色下白色图形承载对比、浅色下
  黑色底板承载对比）。`package.json` 增加 `icon` 字段，marketplace 与扩展列表使用。

## V0.2.7（2026-11-07）

### 变更

  - **新设置 `mrvc.intellisense.cachePath` / `mrvc.intellisense.cacheSize`（缓存位置与上限的工作区覆盖）**：
  MRVC 自动把 `C_Cpp.intelliSenseCachePath`（配置后）与 `C_Cpp.intelliSenseCacheSize`（默认即写，5120 =
  与 cpptools 通用默认一致）写进**每个工作区的 `.vscode/settings.json`**（工作区值覆盖用户级配置），让
  cpptools 的 ipch 缓存落到指定盘符并显式固定磁盘上限。写入是 JSONC 保护式的——注释、兄弟设置、尾逗号
  逐字节保留，只动这两个键；内容不变不落盘；settings.json 解析不了则原样不动并在结果中报告；
  cachePath **留空 = 不写路径键**、cacheSize **填 0 = 不写上限键**，已写入的值也不会被 MRVC 删除。
  cachePath 请填写任何已打开工程文件夹**之外**的目录（如 `F:\mrvc-cache`）。两个设置变更后**立即生效**
  （轻量写入路径，不重建编译数据库）；手工编辑 settings.json 产生的**非字符串路径 / 非数字、非整数或
  负数上限会被跳过并向用户警告**（不写该键、另一键照常、绝不让扩展宿主抛错；警告文案已本地化）——
  小数上限（如 0.5）不会被静默取整成 0，负数不会冒充"无上限"（0 = 显式不写上限键的语义保持不变）。
- **依赖项收窄**：`extensionDependencies` 从五项减为两项（**C/C++ Extension Pack** 与中文语言包）——
  书签、Hex 编辑器、Hex 悬停转换三项改为 README 推荐安装、不再随 MRVC 自动装入（已装用户不受影响）。
  卸载 MRVC 时仍不会连带卸载依赖项。
- **新命令 `MRVC: Clear C/C++ IntelliSense Cache`（清除 C/C++ IntelliSense 缓存）**：大工程文件夹下
  cpptools 的 ipch 缓存（默认上限 5120 MB）会膨胀到数 GB——本命令解析生效的 `C_Cpp.intelliSenseCachePath`
  （含 MRVC 写入工作区的覆盖值）与平台默认位置（Windows `%LOCALAPPDATA%\Microsoft\vscode-cpptools\ipch`；
  Linux `$XDG_CACHE_HOME\vscode-cpptools\ipch`（未设时 `~/.cache/...`）；macOS
  `~/Library/Caches/vscode-cpptools/ipch`——与 cpptools 官方默认一致），模态确认（逐路径列出体积与来源、
  合计 MB）后删除并报告释放空间。**自定义路径自适应识别**：cpptools 把设置值当缓存根（实际 PCH 在其下
  `ipch/`，可为 `ipch/<哈希>/<名>.ipch` 嵌套布局），MRVC 按两种读法探测、且只对**经有界扫描确认含
  `*.ipch` 内容**的目录提供删除——填错的路径永远不会成为删除目标；**安全护栏**：文件系统根、用户家
  目录本身及其**祖先**（删祖先会连带家目录）、任何工作区文件夹一律拒绝，删除前还会**再次校验**缓存
  内容（确认框停留期间目录被替换则放弃删除）；失败按**类型分级**：被运行中的 cpptools 锁住的路径
  （Windows 共享冲突 EBUSY）降级为逐路径失败并提供一键重载窗口完成剩余清理——内容校验失败、护栏
  拒绝与普通文件系统错误（EPERM 权限/ACL 等，重载无效）只显示原因、**不再误导性地提供重载按钮**，
  绝不中断其余路径；`C_Cpp.intelliSenseCachePath` 被**手工编辑成非字符串**（数字/布尔/对象/数组）时
  命令入口给出明确警告（该值已忽略、本次只尝试内置默认缓存路径）而不是静默回退，core 侧同样防御性
  丢弃、绝不让命令抛错；IntelliSense 配置链路的全部失败提示（无效缓存设置 / settings.json 与
  c_cpp_properties.json 不可读）已统一走中英文文案，且**多个问题同时存在时合并为一次多行报告**
  （不再修一个才能看到下一个）；浏览数据库（`.BROWSE.VC.DB`，本机实测可达 2 GB+）
  不在清理范围，确认框已注明。`ensureIntellisenseConfig` 的失败（如 settings.json 不可解析导致覆盖未
  生效）现在也会在激活路径上警告一次，不再静默。旧测试文件里的动态 `require(path.join(...))` 顺带改为
  静态字面量（与全库 require 约定一致）。

## V0.2.6（2026-11-06）

### 变更

- **捆绑语义 `extensionPack` → `extensionDependencies`**：五项扩展（C/C++ 扩展包、书签、中文语言包、Hex 编辑器、Hex 悬停转换）的安装行为不变（装 MRVC 时自动装齐），但**卸载 MRVC 不再连带卸载它们**——`extensionPack` 的市场语义是"套装"（卸载即整套退），与"我只想删 MRVC"的预期相反；改为 `extensionDependencies`（硬依赖）后卸载互不影响，代价是 MRVC 在装期间这些扩展不能被单独卸载（VSCode 对依赖项的规定行为）。
- **工程/Solution 自动发现的扫描深度 6 → 8 层**：有的用户会把整个大文件夹当工作区打开，工程混在其他文件里埋得更深——8 层在覆盖这类布局与避免扫整盘之间取平衡（工程根仍会截停下潜：CDT 模型不支持嵌套工程）。
- **跨平台支持（Linux / macOS）**：安装探测、启动门控与构建链路按宿主平台适配（Windows 行为零变化）。
  - **设置项**：`mrvc.mrs2InstallPath` / `mrvc.mrs3InstallPath` 的默认值改为空——VSCode 的 schema 默认值无法按平台变化，惯例位置改为运行时探测（Windows 仍是 `C:\MounRiver\MounRiver_Studio2|3`，零配置结果与 0.2.x 一致；Linux 认 .deb 的 `/usr/share/MRS3/MRS-linux-x64`，macOS 认 `/Applications/MounRiver Studio 3.app`）。新增 **`mrvc.toolchainOnlyPath`**——纯工具链根目录（`MRS_Toolchain_*` 解包内容：顶层 `Toolchain/` + `OpenOCD/`，无 IDE、无自带 make，使用系统 PATH 中的 make），可单独使用（Intel Mac 只有它可用）也可与 IDE 路径并存。`mrvc.mrsVersion` 偏好语义扩展：mrs2 → MRS2 IDE → 纯工具链 → MRS3；mrs3 → MRS3 → MRS2 → 纯工具链；auto → MRS3 → MRS2 → 纯工具链，回退照旧报告。
  - **启动器校验按平台**：Windows `MounRiver Studio N.exe`；Linux `mounriver-studio N`（根目录或 `bin/`，覆盖 tar 与 .deb 两种布局）；macOS 接受 `.app`（或其 `Contents/`），校验 `Contents/MacOS/Electron`，代次仍由 product.json 判定。启动门控文案/按钮同步三键化（`mrvc.toolchainOnlyPath` 纳入监听与"打开设置"）。
  - **架构门禁（Linux/macOS）两级判定**：启动时读各工具链 gcc 的二进制头（ELF `e_machine` / Mach-O `cputype`，universal FAT 直接通过），**只要有任一工具链与本机架构匹配即放行**；全部不匹配才 `wrong-arch` 拒绝（覆盖"arm64 专用 macOS MRS3 装在 Intel Mac"）。混合架构包（mac V2.4：GCC8=x86_64、GCC12/15=arm64）在 Apple Silicon 上不再被整包误拒——**实际选用的工具链在构建时再核一次**（`toolchainArchProblem`），选到异构的那支（如 arm64 上选 GCC8）会得到明确警告并拒绝该次构建，提示改用原生工具链；警告每次选用都会弹出（toolchain() 的调用频度即用户动作——构建/烧录/终端/属性页），不做会话去重以免后续尝试只剩误导性的"未找到工具链"。
  - **零配置语义**：所有字段为空时按平台惯例位置直接采用（fromDefault 标记，与 0.2.x 的"默认值即建议"体验等价）；字段已配置时惯例位置照旧只作 `detected` 一键采用，绝不静默顶替。
  - **构建包装 POSIX 分支**：单个 bash 脚本（`make 2>&1 | tee` 逐行实时进终端与记录；干跑 `>>` 追加只进记录——POSIX 重定向字节透明，不存在 Windows 的码页污染；`PIPESTATUS` 保退出码；开头 `mkdir -p` 重建记录目录，对临时目录清理免疫）。Windows 链的四个坑（SyncTextWriter AutoFlush、批量写延迟、Set-Location 不改子进程 cwd、cmd 按 ANSI 写记录）在 POSIX 均无对应物。任务启动 POSIX 走 `/bin/bash <script>`；make 解析改为"自带 make 或系统 PATH 的 make"（纯工具链形态没有自带 make）；两处 PATH 注入的硬编码 `;` 改 `path.delimiter`（Windows 等价）。
  - **Windows 专属能力按缺席降级**：MRS Tools 六工具与 WCH-LinkUtility 在 Linux/macOS 安装里本就不存在（MRS3 Linux/Mac 只有 CommunicationLib/Firmware_Link/IQMath/WCHAgent），沿用既有缺失降级。
  - **WCH-Link 硬件操作桥跨平台**（复审 round13-15 链路的收尾）：Download Settings 的读保护/调试保护/芯片 ID/擦除/Memory Assign 现在三平台都可用——Linux/macOS 走**进程内 koffi FFI** 调 CommunicationLib 的 `libmcuupdate.so/.dylib`（与 MRS 自家 mrs-vscode 扩展同款机制；符号表实证 61 个 `MRSFunc_*`/`McuCompiler_*` 导出与 Windows DLL 同族同名，签名表逐字共享）。koffi 作为正式依赖打包（静态 `require('koffi')`，随 vsix 带 linux_x64 + darwin_arm64 预编译件；esbuild external、`verify-vsix` 断言预编译件在包内）；首次 dlopen 失败自动预载同目录 libusb/hidapi 支持库后重试；FFI 抛错一律落为 error 结果。Windows 路径保持 0.2.x 的进程外 PowerShell P/Invoke 逐字节不变（MRS2 32 位 DLL 装不进 64 位扩展宿主）。POSIX 侧待实体机验证。
  - **新建工程向导支持 POSIX**（复审 round14 §3.1）：模板解压按平台分流——Windows 仍走 PowerShell `Expand-Archive`（行为逐字节不变）；Linux/macOS 走系统 `unzip`（macOS 自带），缺失时回退 `bsdtar`（macOS 原生 tar 能读 zip），两者都没有时给出"安装 unzip"的明确指引。解压调用一律纯参数列表，不拼 shell 串。
  - **`.wvsln` 工具链提示行按平台生成**（复审 round14 §3.2）：Windows 拼写逐字节不变（反斜杠 + `openocd.exe`）；POSIX 用正斜杠且无 `.exe` 后缀（`${eclipse_home}` 占位符保留，由读取方解析）——此前在 Linux/macOS 上生成的 solution 会写入指向不存在 Windows 路径的提示行。
  - **IntelliSense 的 `compilerPath` 改写真实文件名**（复审 round13 §4.4 / round14 §2.4）：清单里的编译器名不带 `.exe`——make 配方依赖 CreateProcess 的补全所以必须保持裸名，但 cpptools 会 stat `compilerPath`，Windows 上裸名背后没有文件。现在按平台补全真实拼写（`withRealSuffix`），POSIX 不变；编译数据库的 `command` 仍用裸名（clangd 走 PATH 解析，与 makefile 同一口径）。
  - 内部接口：`MrsInstall` 增加 `kind: 'ide' | 'toolchain'`，`resourcesWin32` 更名 `resourcesDir`（不再暗示 win32 专属）；`toolchain.ts` 增加 `setHostPlatformForTests` 测试缝。
- **测试**：`mrsinstall-test` 重写为多平台 fixture（win32/linux/darwin 三形态布局、架构门禁、独立工具链、三候选排名、零配置采用），`installgate-test` 在 linux 假宿主下隔离真机惯例路径并覆盖三键与独立工具链开局，`wrapper-test` 增加 POSIX 脚本形状断言并**经 bash 实跑**（首块 178 ms、进程 2.7 s 结束；记录内容、干跑只进记录、标签只进终端、失败退出码 7 透传全部成立）；`build-test.mjs` 的 make 调用与 PATH 注入平台化。用解包的真实 `MRS_Toolchain_Linux_X64_V240` 树验证：独立形态识别、GCC8/12/15 三工具链解析、linux 宿主架构门禁通过、IDE 字段指向工具链根正确报 `not-install`。
- **已知边界**：下载/烧录与硬件操作桥的 POSIX 通道已实现但未实测（OpenOCD 与 libmcuupdate FFI 路径都在位，USB 需真机或 usbipd 直通验证）。**POSIX 硬件桥与 MRS 自家实现有一处待真机分辨的差异**：MRS 每次目标操作前会 `SetTargetChip → doUpdate（连接/刷写器件参数）→ 操作`，MRVC 的 POSIX 桥目前只有 SetTargetChip → 操作——若真机上操作整体失败，优先对照 MRS 扩展补 doUpdate 等价导出；macOS 的 MRS3 IDE 为 arm64 专用包（Intel Mac 上无 CommunicationLib，硬件操作会得到明确的"未找到"错误）。

## V0.2.5（2026-10-23）

### 变更

- **构建输出改为实时显示**：此前构建包装脚本把 make 的全部输出重定向进"完整构建日志"
  （`%TEMP%/mrs-cache/<工程>-<md5>/buildContentRecord.txt`，供 `Show Full Build Output` 读取），
  等 make 退出后才用 `type` 整段回显——于是任务终端在整个编译期间一片空白、结束时才一次性刷出。
  现在构建任务跑的是 **.cmd 启动器 + PowerShell 脚本**：脚本用 .NET 管道逐行读取 make 的输出，
  **每行同时**写进日志与终端（终端逐行直写；`AutoFlush` 只在支持它的宿主上设置——Windows PowerShell
  5.1 的 `[Console]::Out` 是 `SyncTextWriter`，直接赋值会抛非终止错误、在终端顶部刷一条红字而构建
  照常进行；批量写也试过并弃用：读循环阻塞在 `ReadLine` 上时最后几行会被憋住，实测"首行到达"从 0.4 s
  退化到 1.6 s），`make -n -B` 干跑走同一个读取器且**只进日志**（记录里仍能回答"每个文件是怎么编译的"，
  也避免 cmd 重定向把 ANSI 字节写进 UTF-8 记录），退出码照常透传。`make clean` 路径本来就是实时的
  （无重定向），保持不变。
  实测（合成 2 万行输出）：旧实现 13,851 ms → 新实现 1,585 ms（**−89%**，约 0.7 ms/行 → 0.08 ms/行），
  记录内容逐字节相同；真实工程上"首行到达"约 0.4 s（构建期间持续滚动）。
  顺带改进：日志改写为 **UTF-8**（此前由 cmd 按系统代码页写，含中文路径的记录只能靠编辑器猜编码）；
  `.ps1` 以 UTF-8 BOM 落盘（Windows PowerShell 5.1 对无 BOM 文件按 ANSI 解码，非 ASCII 路径会读错）。
  生成逻辑抽到纯 Node 的 `src/core/taskWrapper.ts`，新增 `tools/wrapper-test.js`：既断言脚本形状
  （tee、干跑只进记录、退出码、BOM、两个相位 .cmd 的 `cd /d`、`AutoFlush` 的存在性守卫），也用
  **假 make（先输出一行、sleep 2 秒、再输出）实测"输出在进程结束前就已到达终端"**（首块 ~0.4 s、
  进程 ~2.8 s 结束），并验证记录内容、干跑不回显、标签只进终端、失败退出码 7 透传、"make 确实在
  构建目录里运行"，以及**包装脚本的 stderr 必须为空**（PowerShell 的非终止错误只出现在那里，
  正是它漏掉了 `AutoFlush` 那条红字）。
- **构建包装自给自足**：tee 脚本开头先重建记录目录（`New-Item -ItemType Directory -Force`）。
  此前若 `%TEMP%` 清理恰好落在"生成包装"与"启动"之间， StreamWriter 会因找不到路径直接抛错、
  构建以 exit 2 失败且 make 根本没跑（复审 round9 F2 实测复现）。`tools/wrapper-test.js` 钉住
  这一行为：内容断言要求 `New-Item` 出现在打开 StreamWriter 之前，功能断言则在生成包装后
  **真的删掉记录目录**再启动构建（构建照常 exit 0、记录被重建）。
- **树装饰与排除引擎同口径**（复审 round9 F3）：`exclusionFsPaths`（树装饰/灰色标记）此前仍按
  已废除的"深度无关基名"语义在链接目录里递归（深度 ≤6）找裸 token 的目标——引擎已改为严格路径
  语义后，装饰可能把**实际会编译**的文件标成灰色。现在裸 token 只解析链接根下的**直接子项**
  （CH585 的"裸文件名写在链接根"真实用法不受影响）；`taskWrapper.ts` 的模块头注释也改写为
  现状实现（逐行直写、干跑走同一读取器）。
- **工序与工具收尾**：README 写死发布工序为 `npx tsc`（测试产物）→ `node esbuild.js`（发布 bundle）→
  `npm run package` → `npm run verify`；并把"顺序陷阱"提示里过时的体积锚点（"10KB / ~978KB"，实际约
  24 KB / 近 1 MB）与仅 git-bash 可用的 `ls -la` 手工自查一并替换为 `npm run verify` 门禁（其体积哨兵
  会拦截 tsc 产物顶替 bundle 的事故）。`package.json` 新增 `verify` 脚本，指向 `tools/verify-vsix.mjs`
  （"发布前必跑"从此与文档同名）。

### 修复

- **排除匹配把"裸 token"当基名，导致整个目录被漏编译**：`excluding` 的 token 现在严格按 CDT 语义
  解析——**相对该 sourceEntry 目录的路径**（裸 token 即该目录下的直接子项）；此前的匹配器额外允许
  "任意层级的同名匹配"（`endsWith('/' + token)`），于是真实工程 `finger_11_27` 根条目里那个失效的
  token `lib` 把 `FRFXLL/src/lib`（指纹库 10 个 `.cpp`）整个排除掉了：MRS2 编译它们（其 `obj` 下有
  `FRFXLL/src/lib/*.o`），MRVC 不编译 → 链接期 `undefined reference to FRFXLLCreateFeatureSetFromRaw /
  FRFXLLExport / FRFXLLCloseHandle …`，构建失败。修掉基名匹配后：源文件 **57 → 67**，构建 **exit 0**，
  且产出的 `.hex` 与 MRS2 的构建结果**逐字节相同**（`02416e845fe9d7d4…`；`.elf` 仅因构建路径不同
  影响调试信息而略有差异）。
  回归面：对 CH585 / CH587 / CH592 / NFC_DEVELOP / DEVELOP 共 **2,650 个真实工程**做"排除决策
  前后对比"，**只有 finger_11_27 一个工程的源集合发生变化**（正是被漏编译的那个），其余零变化。
  新增 7 条断言把语义钉住：嵌套 `FRFXLL/src/lib` 不被裸 token `lib` 误伤、该目录的文件确实被扫描、
  真实存在于根目录的 `lib/` 仍被该 token 排除、带斜杠的路径 token 照常排除其文件、以及"token 命名
  的是路径而非基名"的对照。

## V0.2.4（2026-10-23）

### 变更

- **启动前校验安装路径：路径不合法则不启动插件**。两个安装路径现在都带默认值
  （`C:\MounRiver\MounRiver_Studio2` / `C:\MounRiver\MounRiver_Studio3`），启动时**逐代次**校验：
  **目录存在** → **是 MounRiver 安装**（`components/WCH/manifest.json`） → **代次正确**
  （product.json/品牌判定，且该代次的启动程序 `MounRiver Studio 2.exe` / `MounRiver Studio 3.exe`
  就在安装根目录下）。任意一个通过就启动；**两个都不通过则不启动**——不注册工程树/命令/监视器，
  弹出提示逐条列出 `字段 = 取值 —— 原因`（文件夹不存在 / 不是 MounRiver 安装 / 该目录是 MRSx 的安装 /
  缺少启动程序），并给出 **[打开设置]**、**[使用检测到的 <安装>]**（把常规位置检测到的安装一键写入对应
  字段）；两个字段的值正好填反时另给 **[交换两者]**。修正后**自动启动，无需重载窗口**。
  旧行为的缺陷（已实测复现）：路径无效会被**静默替换**成常规位置扫描到的安装——把
  `mrvc.mrs2InstallPath` 填成一个不存在的目录，插件照样用 `C:\MounRiver\MounRiver_Studio2` 开工，
  全程没有任何提示，用户不知道自己在用哪一个安装。
- **`mrvc.mrsVersion` 由"固定"改为"偏好"**：两个路径都有效时 auto 优先 MRS3，`mrs2`/`mrs3` 指定偏好；
  所偏好的代次没有有效安装时，改用另一个**有效**的安装并明确提示（此前是报错且不启动）。
- 一个字段无效、另一个有效时照常启动，并提示被忽略的字段与原因。字段值现在必须与自己的代次匹配
  （此前"值填到别的字段也能凑合用"的静默错位处理已移除）。
- `mrvc.mrs3InstallPath` 的默认值由空字符串改为 `C:\MounRiver\MounRiver_Studio3`；两个安装设置与
  `mrvc.mrsVersion` 的说明同步更新。
- **MRS3 专属的"WCH 工具集"菜单项**：MRS3 自带 `components/WCH/Others/WCHToolKit`（MRS2 **没有**
  该组件）。当**当前生效的安装是 MRS3** 时，工程视图标题栏 `…`（更多）菜单的 Tools 组末尾会多出
  **WCH 工具集（MRS3）** 一项，点击启动 `WCHToolKit.exe`；MRS2 生效时该项不出现。菜单项挂在
  `mrvc.mrs3Active` 上下文键上，随生效安装与相关设置的变更实时同步（含启动门控采用/偏好按钮触发的
  变更，无需重载窗口）。命令、中英文标题（`WCH ToolKit (MRS3)` / `WCH 工具集（MRS3）`）与测试一并接入。

## V0.2.3（2026-10-22）

### 修复

- **C++ 工程从未真正按 C++ 编译**（0.1.x 起的缺陷）：判定工程是否 C++ 用的 nature ID
  是 `org.eclipse.cdt.core.cxxnature`——该 ID 在 CDT 中不存在（真实 ID 为
  `org.eclipse.cdt.core.ccnature`），于是 C++ 工程一律按 C 工程处理，`.cpp/.cc/.cxx/.C`
  源文件被整体跳过（实测 FingerCode 工程的 `FRFXLL/src/lib` 与 `afis` 两个目录消失
  → `FRFXLL*` 符号未定义；链接器也从 g++ 退化为 gcc）。配套问题：MRVC 自己的
  「C++ 工程」开关写的也是这个假 ID（自写自读自测所以一直是绿灯，MRS2 并不认）。
  修法：以 `ccnature` 为准判定并继续接受旧假 ID（迁移），开关改写真 ID、切换时清掉
  假 ID。实测（MRS2 工具链真编译）：源文件 48 → 72，`.cpp` 走 `g++ -std=gnu++17`、
  `.c` 走 `gcc -std=gnu99`、链接走 `g++`，exit 0。
- **C/C++ 工程类型转换补全**：原开关只改 `.project` 的 C++ nature，而 C 工程的
  `.cproject` 里 C++ 选项集几乎是空的——转换后按 C++ 构建拿不到 include 路径与链接
  脚本（实测链接报 `cannot open linker script file Link.ld`：选项缺失时脚本名回退成
  了裸文件名）。现在转换会把 **C 选项整组镜像进 C++ 选项**（单值与列表都复制，缺失的
  选项按 CDT 规范创建；MRS2 对 C++ 工程读的正是这套 cpp 选项）。实测：C 版与转换后
  C++ 版的 `-T` 脚本参数逐字一致、链接走 `g++`、转换后的 LED 工程 exit 0（内存占用
  与 C 版相同）；切回 C 时镜像保留但被忽略。
- **转换镜像保留原写法（MRS2 侧兼容）**：列表选项原先经"剥引号 → 统一加引号"往返，
  会把库名 `m` 写成 `"m"`——而 MRS2 的读取器对 `libraries` / `defined_symbols` 是
  **原样进模型**（只有路径类值经过带剥引号的宏解析），引号会被带进它的模型与
  `USER_OBJS`（MRS2 自己还会再补一层引号）。现改为**逐属性原样克隆**：每个值保持
  源写法（库名不带引号、宏路径带引号），回归断言锁定"未加引号的值镜像后仍不加引号"。
- **旧版 C++ 标记自动迁移**：MRVC ≤0.2.2 转换过的工程带假 ID `cxxnature`
  （MRS2 视为 C、MRVC 视为 C++）；工程加载时现在一次性规范化为标准 `ccnature`
  并镜像 C 选项（附一次性提示），不再需要点两次"切换类型"才得到镜像。
- **转换新建选项的 MRS2 元数据保真**：新建的 C++ 选项现在从它的 C 孪生复制
  `name` / `useByScannerDiscovery` / `valueType` 与空值标记（此前是合成标签如
  `Paths`/`Libs` 加 `scan=false`），使 MRS2 打开转换后的工程时扫描索引与属性页
  标签与它自己保存的工程一致；转换到 C++ 时另补 C++ 编译器的 `<inputType>`
  （实测 MRS2 的 C++ 工程带它、固定 id `…tool.cpp.compiler.input.1079228323`，
  而 C 工程只有 assembler / c.compiler / c.linker 三个）。
- **重复转换／属性页编辑产生的空白漂移**：序列化用 `ws[i]` 保存"第 i 个子元素之前
  的空白"、用 `ws[children.length]` 保存闭合标签的缩进，而追加子元素时没有为它预留
  槽位——原先属于闭合标签的那条缩进被新子元素吃掉，于是**重复一次同样的操作**
  （再次转换，或在属性页给列表再加一条路径）会把新条目写得比同级浅一级（实测
  `listOptionValue` 9 → 8 个制表符、与父 `<option>` 齐平，`<inputType>` 比 `<option>`
  再浅一级），多出一处纯空白的 5 行 diff。修法：追加时插入空槽位，使新子元素回到
  "父级 +1"的文件层级约定、闭合标签缩进保持不变（元素顺序与属性未变，纯排版）。
  回归断言锁定"再次转换与首次转换逐字节一致"、"重复转换字节稳定"与"列表子条目缩进
  与同级一致"（含属性页路径）；负向探针确认旧行为下**两条缩进断言失败**（"字节稳定"
  那条对旧写法不敏感——旧写法每次写出的都是同一个偏浅结果，它守的是"重跑不改文件"
  这一失效模式）。
- **`.project` 建块导致的同级左移**（同一类缺陷的另外两个调用点）：对没有
  `<linkedResources>` 块的工程执行 Add Linked Folder 时，新块是用原始 `children.splice`
  插入的——没有预留空白槽位，于是**最后一个同级子元素**吃掉闭合标签的空白条目、整体
  左移一级（真实工程实测：`<filteredResources>` 由 1 个制表符变 0，而它自己的闭合标签
  仍是 1，层级写法自相矛盾）。改用同文件里早已存在的 ws 对齐入口 `insertChild()`，
  `addLinkedFolder` 与 removed-resources 建 `filteredResources` 两处都已修正（全树
  1,856 个工程中 4 个缺 `<linkedResources>`，低频但真实）。
- **`.project` 写回不再改写"显式空元素"写法**：MRS2 把空的 `<projects>` / `<comment>`
  写成跨行开闭对，而序列化器对"无内容元素"一律写自闭合——任何一次 `.project` 写入
  （加/删链接目录、排除、改名、类型切换）都会顺带改动文件里每一处这种写法（全树
  2,687 个 `.project` 中 1,485 个含此写法，示例文件 1,067 → 1,022 字节）。现在解析时
  记住源形态、写回时按原样输出，连自闭合标签里 ` />` 前的空格也一并保留（另有 8 个
  工程是这种写法）；只有"原本有子元素、被编辑清空"的元素才落到既有的 `<x/>` 形式
  （不把空块形态强加给新写入的选项）。实测口径：`F:/CH585`、`F:/CH592`、`F:/CH587`
  三棵芯片树（含各自 EXAM、NFC_DEVELOP 与"需要更新的"备份树）共 5,372 个文件——
  `.project` 2,687 与 `.cproject` 2,685 全部"解析→序列化"逐字节还原（修前
  `.project` 有 1,485 个不符），单次写回不再产生无关的空白/形态 diff。

### 内部

- **工具链前缀读取加固**：`storedPrefix` 原先只认裸 `command.prefix`。全树普查
  （CH585/CH592/CH587 共 2,685 个 `.cproject`、2,919 个前缀选项）显示真实工程
  **全部**是裸形态，因此当前无实际影响；读取现同时接受 `c.command.prefix` /
  `cpp.command.prefix`（本语言优先，其次裸形态，再次另一语言），使"没有 `rvGcc`
  选项的工程"不会因为写法不同而静默落到 GCC8 默认值。普查另确认：625 个无
  `rvGcc` 的工程前缀均为 `riscv-none-embed-`（前缀表正确映射到 GCC8），所有
  `riscv-none-elf-` 工程都带 `rvGcc`，故不存在"未知前缀 + 无 rvGcc"的落空样本。
- **同步工具加两道复制前守卫**（`tools/sync-to-mrvc.mjs`）：① FILES 清单与版本化
  vsix 必须齐全；② FILES 之外的两树差异一律拒绝（行尾差异按内容归一后比较）——
  复审发现的"清单漏掉 `cproject.ts` 会同步出半新半旧的仓库"由此闭环；另加 `--dry`
  只跑守卫不复制（**严格**：缺包即失败，打包前预检用 `--dry --allow-missing`）。
  README 源码树补 `projectType.ts`，探针用法补可选 `[cpp]`。
- **转换链的回归加固与收尾**：元数据断言改为**期望值**形式（此前"与孪生相等"的断言
  在套件先做过一次镜像后会被架空），并用负向探针确认——回退旧行为时这两条确实失败；
  切回 C 时移除转换新增的 `<inputType>`（真实 C 工程只有 assembler / c.compiler /
  c.linker 三个；镜像的 C++ 选项值按设计保留）；单配置限制与"缺 C++ 工具元素"兜底
  写入 ROADMAP 已知限制；`setProjectCpp` 的"覆盖式镜像"契约写进文档注释——并注明
  **不能**按"工程已读作 C++"短路该镜像（旧假 ID 工程正是靠它修复）；空白不变量另覆盖
  `.project` 的建块路径与"未触碰即逐字节还原"。

## V0.2.2（2026-10-21）

### 新增

- **MRS3 支持（与 MRS2 二选一）**：新增 `mrvc.mrs3InstallPath` 安装路径与
  `mrvc.mrsVersion`（auto / mrs2 / mrs3）选择器——同一时刻只有一个安装生效；
  MRS3 路径非空即使用 MRS3（路径无效自动回退 MRS2），可用选择器显式固定。
  安装代次由 `product.json` 的 `mrsVersion` 键探测。实测 MRS3 与 MRS2 同构：
  工具链 manifest（GCC8/12/15 同名同前缀）、make 包、OpenOCD、WCH-LinkUtility、
  MRS Tools 路径全部一致，make/sh/openocd/GCC12/GCC15 二进制与 MRS2 逐字节
  相同。构建输出首行打印当前生效的安装；四类安装提示按场景给出操作——「两个
  路径都有效」可一键固定其一，「两字段填反」可一键交换，「路径填错字段」仅在
  目标字段为空时提供一键改填（目标已有值时只提示、不覆盖），「MRS3 路径无效
  已回退」为纯提示。**强制代次
  （`mrvc.mrsVersion`）只认所请求代次的安装**：字段指向另一代次时跳过、
  找不到时明确报错，绝不静默改用另一代次（未标注代次的安装仍接受）。
- **wlink 桥按 DLL 位数自适配**：MRS2 的 CommunicationLib 为 32 位 DLL、MRS3
  为 64 位（导出函数 106 个完全相同），桥改用与 DLL 同位数的 Windows
  PowerShell（System32 / SysWOW64）执行 P/Invoke。

### 修复

- **Download Settings 硬件操作此前从未真正执行**（0.1.2 起的缺陷）：PowerShell
  桥的 P/Invoke 声明名（`MRSFunc_*`）与脚本体调用名（裸名）不一致，DLL 实际
  从不被调用——查芯片 ID / 读保护读写 / 禁用调试接口 / 内存类型 / 清除 Code
  Flash 全部报「找不到方法」。改用调用名声明 + `EntryPoint` 绑定真实导出后，
  MRS2（32 位）与 MRS3（64 位）均实机进入 DLL（未接芯片时返回 DLL 的
  连接失败码，措辞正确）。回归不变量：脚本中每个被调用的方法必须在同脚本内
  有声明。
- **`-lm` 强制注入（MRS 2.3.0+ 行为）**：可执行工程配置库中没有 `m` 时，
  `objects.mk` 的 `LIBS` 行自动追加 `-lm`（实证：1.8.5–2.2.18 不加，
  2.3.0/2.4.0/2.5.0 全加；LiteOS+IOTC 工程因 `libcjson` 缺 libm 链接失败即此故）。
- **WCH 助手库位置**：`-lIQmath_RV32` / `-lprintf` / `-lprintfloat` 从
  `objects.mk` 移到链接 recipe 的 `$(LIBS)` 之后（MRS 2.5.0 与 1.9.2 金标一致）。
- **工程树移除「工作区文件」节点**：树只显示扫描到的工程本身，不再列出工程
  父目录中的散落源文件。
- **解决方案窗口的路径自愈**：`.wvsln` 被改名/移动（或整个目录换机器）后，
  生成的 `.code-workspace` 里 `mrvc.solution` 的旧绝对路径此前会静默失效、
  窗口退化成普通文件夹；现窗口激活时在**工作区根目录直层**查找 `.wvsln`——
  唯一则自动接管并回写设置（有提示），多个则弹出选择，一个都没有才提示失效。
  搜索刻意不递归：静默套用无关 EVT 例程的解决方案比报告"找不到"更糟。
- **双安装提示的完整诊断**：两个路径字段都非空时，误填的字段现在照样被点名——
  例如 MRS3 路径里填了 MRS2 目录，会提示该字段填错，而不是误报"检测到两个安装"
  （字段级诊断与另一字段是否填写无关；真正的两个安装才提示二选一）；
  强制代次（`mrvc.mrsVersion`）找不到安装时的提示固定使用**所固定代次的名称**，
  不再写成字段里另一代次的名称（"固定 MRS3 却提示 MRS2"的自相矛盾已消除）。

### 内部

- 新增 `tools/mrsinstall-test.js`（安装探测与二选一策略全断言）；`wlink-test`
  增 PE 位数判定与方法声明覆盖不变量；`enhancements-test` 增 auto `-lm` 回归。
- 新增常驻探针 `tools/mrs-install-probe.mjs`：钉住指定安装（MRS2 / MRS3）
  构建工程并支持 PARENT-N 链接工程；双安装真机回归（LED / tcp_client）通过。
- 新增发布工具 `tools/sync-to-mrvc.mjs`（逐文件哈希校验的 develop→MRVC 同步；
  **仅 develop，不入发布仓库**——它操作的是 develop 同级的 MRVC 克隆）；
  `.gitattributes` 声明 `tools/enhancements-test.js` 为文本——该文件前 8 KB 中文
  占比越过 git 的二进制嗅探阈值，此前每次改动都会在 `git diff --check` 里报
  行尾空白（CR），声明后恢复与其他文件一致的 LF 索引 / CRLF 工作区处理。

## V0.2.1（2026-10-19）

### 修复

- **含括号的工程路径可编译**：路径段含 `(` / `)` 的 EVT 发布目录（例如
  `CH592EVT_V1.9_(20261016)`）此前被 makefile 前置检查误判拒绝；经真实工程 + 打包
  make 实证后放行（括号在 make 规则词与引号参数中均为字面量）。
- **路径字符支持加固**（真实工程逐字符复制 + 打包 make 实编验证）：
  - **工程根**（无链接目录）`( ) ; % #` 全支持，反引号一律拒绝；
  - **链接目录路径**（解析后绝对位置，含工程根与祖先）带 `;` / `#` / 反引号时拒绝
    ——链接文件的依赖是绝对路径，这些字符进 make 规则词不可表达（MRS2 生成同形态
    makefile 同样无法构建，其自身还会把根路径中的 `#` 误改写为 `%` 产出错误路径）；
  - **Other Objects (USER_OBJS) 路径**含 `;`/`#`/反引号/`&`/`(`/`)`/单引号/`[`/`]`
    时拒绝（无引号展开会拆命令、破引号、glob 到错误对象；工程根的 `;`/`#` 本身
    不拒绝，随对象解析路径进入则随之拒）；
  - **库（LIBS）条目**仅允许字母/数字/`._+-`（库名是数据不是命令文本，`;` 等字符
    会在链接配方 shell 中执行命令）；
  - **反引号全通道最终拒绝**：生成终检（writeMk）扫描全部生成字节——旗标路径、库名、
    后处理选项、源文件名、Build Steps 无一例外（配方经 make 自带 sh，引号内反引号
    仍会命令替换）；
  - 边界明确：**源文件名**含 `( ) ; #` 与反引号不在支持范围（EVT 全系无此命名）。
- **中文界面语言包 ID 更正**：`MS-CEINTL.vscode-language-pack-zh-hans`（0.2.0 声明的
  `...pack-zh` 是不存在的旧 ID，会导致中文界面语言包无法安装；按 MRS2 内置实物核实）。

### 内部

- `enhancements-test` 增路径字符永久回归：真实 FreeRTOS 含链接布局逐字符复制→重新
  生成→打包 make 实编的字符矩阵（第 8 节），以及 USER_OBJS / LIBS / 源文件名 / 根
  反引号的边界负向断言（第 9-12 节）；路径字符审查六轮复审闭环。

## V0.2.0（2026-10-17）

### 新增

- **extensionPack 扩充：随包安装/推荐五项扩展**——`ms-vscode.cpptools-extension-pack`
  （C/C++ 套装：元包，市场安装时自动拉取 cpptools 本体与 CMake Tools；代码跳转的必要
  消费端——MRVC 生成的 IntelliSense 数据库由 cpptools 读取）、`koalamer.labeled-bookmarks`
  （书签/注释，0.1.9 已有）、`MS-CEINTL.vscode-language-pack-zh`（中文界面语言包——MRVC
  的中文菜单跟随 VSCode 显示语言）、`ms-vscode.hexeditor`（hex 文件查看/编辑）、
  `maziac.hex-hover-converter`（悬停即进制转换）。从市场安装/升级 MRVC 时一并自动安装；
  **VSIX 侧载场景由 VSCode 弹出一次安装提示，可跳过**（不强制）。已知边界：离线机侧载
  元包 VSIX 不会自动带出 cpptools 本体——需按提示单独安装本体（win-x64 VSIX），
  MRVC 检测到 clangd 时不再提示、配置行为不变。侧载跳过后仍有运行时兜底提示
  （打开工程时，"不再提示"可永久关闭，Reset Extension Install Guidance 可重开）。

### 修复

- **构建并行度留一核**：传给 make 的并行任务数从全部逻辑核（`cpus()`）改为 `cpus - 1`，
  满核编译时 VSCode 界面不再卡顿（编译时长影响约百分之几）。

### 内部

- ROADMAP 与 MRS2 功能对照文档刷新：宏定义批量同步（0.1.8）、文件标旗与批量修改工具链、
  书签/注释推荐（0.1.9）等已落地项从"候选"清单勾销，剩余差距按 0.2.x/0.3.0 分档重排。
- `tools/print-menus.mjs` 开发辅助脚本读 NLS 文件解析 `%command.*.title%` 占位符，
  打印的菜单恢复为可读的中英文标题（中文化以来一直显示占位符原文）。

## V0.1.9（2026-10-11）

### 新增

- **Bookmark / Note（书签与注释）**：通过 `extensionPack` 推荐 MRS2 内置的同款开源扩展
  **Labeled Bookmarks**（`koalamer.labeled-bookmarks`，即 MRS2 书签/注释功能的实际来源）——
  从市场安装/升级 MRVC 时该扩展**随之自动安装**（VSIX 侧载场景则在安装后提示一次，可跳过）：
  编辑器行级书签、带文字注释的书签（Note）、分组/颜色/导航与书签树视图；不需要可在扩展页
  单独禁用/卸载。离线机器可侧载 MRS2 安装目录内置的同款扩展副本
  （`resources/app/extensions/koalamer.labeled-bookmarks-*/`）。
- **Modify Projects Toolchain（批量修改工程工具链）**（MRS2 同名命令对齐）：Solution 右键
  与命令面板入口——QuickPick 选工具链（GCC8/12/15，预选 GCC15 与 MRS2 默认一致）→ 模态确认 →
  把全部已加载 **RISC-V** 工程的 `target.rvGcc` 改写为所选值（ARM 工程跳过并计数；当前写入
  活动（第一个）配置——多配置工程的其余配置待多配置改造后再覆盖，与 MRVC 全局单配置构建
  模型一致）。工具链解析器读该选项，**在 `mrvc.toolchain=auto`（默认）时下次编译即生效**；
  显式设置 `mrvc.toolchain` 为 GCC8/12/15 者以该设置优先（既有设计）；输出频道逐工程
  `[OK]/[SKIP]/[FAIL]`。
- **文件标旗（Flag / Clear Flag）**（MRS2 "Flag" 对齐）：文件右键 → **标旗** → 20 色
  QuickPick（与 MRS2 `getSupportedColors` 全量一致：Red/Orange/Peach/Green/Teal/Olive/Blue/
  Purple/Maroon/DarkSteel/Gray + Dark×9，别名与色值逐项照抄）→ 树中该文件带
  ● 色点装饰（按旗色映射最接近的主题色）；**清除标旗**移除。存储与 MRS2 **完全互通**（工程目录
  `.mrs/preferredColor.json`，`{logic_file, color}` 列表）——同一工程在 MRS2 与 MRVC 里
  标旗互相可见（含 MRS2 用任意颜色标的旗）。排除编译的文件同样可标旗。

### 勘误

- **"链接目录深层拆分只识别第 1 层"系误判，撤销该已知限制**：经挖取 MRS2 扫描器源码
  （`getLogicDirFilesMap`，对工程根与全部链接目录走同一无深度限制的完整递归）并与 MRVC
  实证对照（三层嵌套链接目录探针：L1/L2/L3 全部扫进），MRVC 的构建扫描从头就是完整递归，
  与 MRS2 语义一致——972 工程 mass 全绿从未暴露问题与此相符。原表述混淆了**构建扫描**与
  **工程树的链接目录深层展开**两回事：若树视图存在深层展开受限，仅影响浏览不影响编译。

## V0.1.8（2026-10-10）

### 新增

- **跨工程修改宏定义**（独立功能，`mrvc.batchMacros`）：工程树 `…` 菜单新组与命令面板入口
  打开专用页面，三段式布局（按用户定稿的"形态 A"交互重做）：
  ①**按工程的只读汇总**——每个工程一个小节列出自己的全部宏（C/C++/ASM 标注），跨工程
  取值不一致的宏行高亮标注 ≠，支持按宏名过滤快速聚焦；
  ②**目标宏编辑区**——C / C++ / Assembler 三个文本框（**默认为空**，由用户输入要设置的
  宏），每行一条宏（`NAME=VALUE` 或裸 `NAME`，与属性页同规则），栏头统计显示全部工程的
  宏名数与分歧数，每栏独立勾选（默认不勾），两个全局开关：「为尚未定义这些宏的工程新增」
  与「跳过逐工程确认，直接应用」（均默认不勾）；
  ③**目标工程勾选**——逐工程 checkbox（默认全不勾，防误操作），带「全选/全不选」与工程名
  过滤，Apply 只写勾选的工程。
  **逐工程确认（写前审阅）**：Apply 后逐工程弹出 QuickPick——显示该工程每一栏**修改前/修改后**
  的完整宏列表与逐条变更明细（`旧值 ⇒ 新值` / `+ 新增`，C++ 栏对 C 工程标注跳过），键盘选择
  「应用此工程 / 跳过此工程 / 应用此工程并对其余全部应用 / 跳过此工程其余全部跳过」，Esc 取消
  其余全部。两阶段执行：先逐工程确认收集决策（无变更的工程自动跳过不询问），确认完成后一次性
  批量写入（进度可取消）；勾选「跳过逐工程确认，直接应用」则跳过确认循环直接批量写入
  （撤销快照照常记录，误操作仍可一键恢复）。
  **撤销上次应用**：写入前捕获每工程原宏列表，页面底部「撤销上次应用」一键把所有被写工程恢复
  到应用前状态（确认模态后执行；快照单次有效，可再次执行新 Apply）。
  输出频道 `MRVC Batch Macros` 逐工程 `[CONFIRMED]/[SKIP]/[no changes]/[OK]/[FAIL]/[UNDO]` +
  更新/新增计数汇总。核心解析/合并
  在 `src/core/macroDefs.ts`（纯 Node）：parseMacroLines / macroNameConflicts /
  macroStats / mergeMacroList（原位替换、保序、不删除）——新套件
  `macro-batch-test` 25 断言（含 scratch 工程端到端：改值、新增开关两态、私有宏保留、
  C 工程跳过 C++ 栏、CDT 引号存储形态），`webview-test` 增页面渲染与 applyMacros 协议
  24 断言（含选择性同步：未勾选工程零写入；逐工程确认四路决策——应用/跳过/对其余全部
  应用/Esc 取消；编辑框默认空；撤销上次应用与其快照消费；跳过确认快速模式（QuickPick
  零调用 + 撤销仍有效）；空 targets 拒绝）。
  **菜单顺序调整**：工程树 `…` 菜单中 Sync Setting Across Projects → 跨工程修改宏定义 →
  Generate Solution from All Projects 依次相邻（工具组顺序不变）。
  **新增「打开 MRVC 设置」**（`mrvc.openSettings`）：工程树 `…` 菜单末尾与命令面板入口，
  打开 VS Code 设置页并按 `@ext:<publisher>.<name>` 过滤——只显示 MRVC 贡献的选项
  （扩展 ID 动态取自 context.extension.id，publisher 变更免疫）。
  **修复 `mrvc.build.verbose` 设置无实现**（用户实测反馈：首版即声明但从未接线）：现按三档
  作用于 make 命令行——`full` = `make --trace + VERBOSE=1`（生成的 makefile 用 `@` 抑制命令
  回显，外部无法翻转；`--trace` 让每条被抑制的 recipe 照样打印，即所宣称的"逐条命令回显"）、
  `concise` = `make -s`、`normal` = 现状；构建/批量构建/Rebuild 三条链路一致（clean 永不
  加 `-j`），未知取值回落 normal。设置描述同步改为与实际行为一致。
  **发布前审查修复**（第六项独立审查：P1×0、P2×2、P3×6 全部处理）：①Apply/撤销加 busy
  重入守卫——连点 Apply 或写入进行中点撤销不再交错写同一批文件（第二趟提示"已有批量宏操作
  正在进行"）；②阶段 2 写入改为 fresh load 后**重跑合并**而非盲写阶段 1 快照——确认队列
  行走期间用户/属性页/MRS2 对目标工程的外部宏修改不再被静默丢弃（与"不删除任何宏"承诺
  一致）；③撤销语义改为严格"撤销最后一次应用"（此前连续多次应用后撤销会把更早应用的工程
  一并回退）；④撤销部分失败（如杀软锁定）不再丢弃剩余工程的恢复快照，可修复后重试；⑤阶段 1
  单工程 .cproject 损坏不再整批静默失败（记 [FAIL] 继续）；⑥页头提示文案与"编辑框默认空"
  定稿行为对齐；⑦清理 core 过期导出与注释；⑧阶段 2 重合并后已与目标一致的工程跳过写盘
  （不再产生无意义写与幻影 written 条目）；⑨「全选」只勾选过滤后**可见**的工程（过滤激活时
  不再隐式目标被隐藏的工程）；⑩端到端断言补真实"未提及宏保留"覆盖（夹具预置私有宏）。
  `webview-test` 宏段断言增至 28 条。
  **整体复审（三组并行：0.1.7 专项 / 宏功能复审 / 长尾+新代码）**：P1×0、P2×1、P3×10，
  除 publisher 事项（见 V0.1.7 段破坏性提示）外全部修复：①0.1.7 的状态键改名补**一次性真迁移**
  （activate 早期把 4 个旧 `mrs2.*` 键值搬入新键并清除——"不再提示"标记不再丢失、创建位置
  记忆可保留）；②下载前旧 `mrs2_flash.cfg` 清理改为尽力而为（文件被锁时不再中止下载）；
  ③Clean/Clean All/Rebuild 的 clean 阶段现在同样遵循 `mrvc.build.verbose`（此前 clean wrapper
  不接收该设置）；④Generate CMakeLists File（原地生成）对已存在的 CMakeLists.txt 补覆盖
  确认（与导出路径对齐）；⑤清理 5 处历史语句粘连格式。长尾 21 文件与命令/i18n 一致性
  全量复核通过（61 命令注册与声明严格 1:1、205 个 i18n 键零死键零缺失）。
  **打包核对脚本**（`tools/verify-vsix.mjs`，发布工序固定为 esbuild → package → verify）：
  解包 vsix 与仓库源逐项断言——manifest/两份 NLS/changelog/bundle 逐字节一致、版本号四处
  相等（package.json / lock / vsix 文件名 / vsixmanifest Identity）、publisher 一致、无
  docs/tools/src 泄漏；阴性验证确认能拦住"仓库内 vsix 被回退成旧二进制"这类发布产物漂移。
  复审加固（第八轮两 P3）：①脚本先自行 `node esbuild.js` 从源码**重建再比对**——`npm run
  package` 本身不跑 esbuild，"改了 src 忘重建就打包"的静默盲区（包与陈旧 out 一致、与源码
  不符）现在同样被拦（实测真实代码改动触发 FAIL、还原后回绿）；②`out/` 缺失（fresh clone、
  无 node_modules）时温和报错给出指引，不再栈溢出崩溃。③链接式 `node_modules`（junction/
  pnpm/npm link）环境下重建产物的内嵌模块路径形态不同（路径注释与 `__commonJS` 缓存键
  带 `../` 前缀）——该环境确实无法逐字节复现发布包，守卫仍判 FAIL，但失败详情会明确指出
  "node_modules 是 junction/symlink，请在真实安装上打包"而非泛泛的重建提示（诊断签名只认
  路径形态：指令头/codegen 级差异不会被误标为链接——第十轮修正，实测翻转 tsconfig strict
  不再误指）。诊断时发现另一真坑：副本缺 tsconfig.json 会让 esbuild 不按 tsconfig 降级
  class fields——这是语义级差异，与链接无关，fresh clone 不受影响。

## V0.1.7（2026-10-08）

### 修复

- **clangd 检测的扩展 ID 修复**：安装引导的"已装 clangd 则不打扰"分支此前引用了不存在的
  扩展 ID，检测永远不生效（装了 clangd 的用户仍会被提示装 cpptools）；现更正为
  `llvm-vs-code-extensions.vscode-clangd`。
- **安装引导的收尾打磨**（定版后收尾）：新增 Reset Extension Install Guidance
  命令——误点"不再提示"后有撤销入口（清除标记并立即重新评估提示）；扩展页打开失败
  （离线/市场异常）时给出手动安装指引而非无声失败；package-lock.json 的 version 字段
  对齐 package.json（0.1.5 起的漂移清零）；versionAtLeast 补 5 条单测
  （数值比较防字符串排序误判：1.9.0 实际低于 1.23.5）；清理 11 个未使用的界面文案键，
  并补 flash 旧文件名清理的回归断言。

### 变更

- **命令与视图 ID 统一为 `mrvc.*`**（原 `mrs2.*` 历史前缀退役）：59 条命令、工程树视图
  （`mrvc.projectExplorer`）、上下文键（`mrvc.hasActiveProject`/`mrvc.hasProjects`）与菜单
  分组全部迁移。**破坏性提示**：在 `keybindings.json` 自定义过 `mrs2.*` 快捷键、或从外部
  任务/脚本调用过 `mrs2.*` 命令的用户需要同步更新；**持久化状态键同步改名**
  （`mrs2.projects`/`mrs2.active`/`mrs2.lastCreateDir`/`mrs2.cpptoolsDontAsk` → `mrvc.*`）——
  升级后工程列表会自动重新发现，但活动工程选择、"上次创建位置"记忆与安装引导"不再提示"
  标记会重置一次（0.1.8 起升级自动迁移这些旧键值，不再重置）；设置键
  `mrvc.*` 与 `mrvc.mrs2InstallPath` 不变。生成文件改名：`mrs2_flash.cfg` → `mrvc_flash.cfg`，
  makefile 头部签名 "Generated by mrvc"（内部临时目录 `%TEMP%\mrs-build`/`mrs-cache` 名不变）。
  **扩展 ID 变更提示**：自 smartmx 接管发布起扩展 ID 为 `smartmx.mrvc`（此前 vsix 为
  `mrvc.mrvc`）——VS Code 按 ID 隔离存储，从旧 ID 升级需**先卸载旧版再安装新版**（两部分
  可能并存）；发布说明中的状态重置提示按 ID 变更各生效一次。

## V0.1.6（2026-10-07）

相对 V0.1.5。五轮代码审查（core 文件格式层 / core 工具进程层 / vscode 集成层 / 开发机复审 +
10-07 第四轮全量复审）发现的缺陷全部修复；编译旗标按 MRS2 生成器源码逐键对齐（浮点双键拆分）；
IntelliSense 配置改外科手术式写入并支持多根工作区。回归：18 个断言套件 + mass 全树比对
（5 棵 EVT 树 972 工程、37094 源文件）全部通过。

### 修复

- **重命名工程的写盘顺序以 `.launch` 为先**（开发机第六轮复审发现）：读入内存的原子化修复
  消除了"读/解析失败"窗口，但写盘仍是 `.project` 先落盘、`.launch` 后写——若 `.launch`
  写入失败（如杀软锁定），`.project` 已是新名而 `MAPPED_RESOURCE_PATHS` 仍旧名，重试按新名
  匹配永远无法补正。现 `.launch` 先写（最可能失败的写），`.project` 作为提交点最后写：
  前置失败整体未发生、可直接重试；后置失败重试自愈（`core/projectFile.ts`；rename-test
  全绿回归）。
- **第四轮复审遗留 P3 全量清零（18 条，逐条复核属实后修复）**：
  - `.template` 写回兑现"未改动行字节不动"承诺：原实现对**每个**可识别行重写规范形
    （`Vendor = WCH`→`Vendor=WCH`、值尾随空格丢失），"keep spacing style"的 pad 判断因正则
    懒惰分组恒为空串（死代码）。现 KEY_RE 捕获等号前空白组，未变化行原样返回、变化行保留
    原间距风格（`core/templateFile.ts`；roundtrip 新增 6 断言）。
  - `.wvsln` 写回不再把 LF 文件归一为 CRLF：按文件自身行尾写回，与"byte-identical"注释一致
    （`core/solution.ts`；solution-test 新增 2 断言）。
  - 缩进的 `BuildOrder=` 行不再失效累积：写侧探测原用原始行前缀匹配而解析侧先 trim——手写
    缩进行导致每次"设置编译顺序"都插入新行且顺序永不生效。现写侧按 trim 探测、原位重写并
    保留原缩进（`core/solution.ts`；solution-test 新增 4 断言）。
  - 重命名工程原子化 + PROGRAM_NAME 扩展名自适应：`.project` 此前先落盘，`.launch` 读取/
    解析失败后重试时旧名已被覆盖，MAPPED_RESOURCE_PATHS 永久指旧工程；PROGRAM_NAME 替换
    硬编码 `(\.elf)$`，axf 等非 elf 产物工程改名后调试配置指向旧可执行文件。现全部读入内存
    完成编辑后再统一写盘（失败即整体未发生），扩展名按实际产物保留（`core/projectFile.ts`；
    rename-test 新增 5 断言，含损坏 .launch 的回滚路径）。
  - `c.compiler.otheroptimizations` 与 `assembler.otherwarnings` 补宏解析：与 C/C++ 孪生字段
    对齐，`${ProjName}` 等宏不再原样进 makefile 被 make 吞掉（`core/flags.ts`；flags-fp-test
    新增 1 断言）。
  - 真实文件夹命名 entry 大小写错拼不再双扫：step 1.5 此前用 **entry 的拼写**当逻辑前缀，
    与根遍历的磁盘拼写差一个大小写就把同一份源文件加两遍（重复 .o → 链接期符号重定义）；现
    按磁盘真实拼写解析前缀（`core/scan.ts`；exclude-test 新增 3 断言）。
  - makefile 逻辑目录内外部判定改按"目录内任一文件"：链接名与真实目录同名的混合目录此前按
    首文件二选一，模式规则对外部成员报 No rule to make target；现含任一外部文件即走逐文件
    规则（`core/makefile.ts`）。
  - pre/post-build 回显使用 Build Steps 页填写的 Description（pre/postannouncebuildStep），
    未填时保持 CDT 默认文案（`core/makefile.ts`）。
  - `macros.ts` 的链接名查找折叠大小写：选项值首段与 .project 链接名大小写不一致时 `-I`/`-T`
    不再被静默丢弃（`core/macros.ts`）。
  - `selectToolchain` 按名匹配兑现注释宣称的大小写不敏感（设置键入 `gcc12` 可命中 `GCC12`），
    与自定义工具链合并去重的折叠规则一致（`core/toolchain.ts`）。
  - i18n 清理 19 个无引用死键（脚本全代码引用扫描核实，无动态键名构造）（`core/i18n.ts`）。
  - 任务结束监听竞态加固（5 处）：executeTask 兑现前到达的同类型结束事件此前会错配退出码/
    提前释放构建护栏——现缓冲该窗口内的事件，身份就绪后精确匹配（`vscode/tasks.ts` +
    `vscode/flash.ts`）。
  - Rebuild 的 clean 阶段可真实终止：护栏条目此阶段无执行句柄，"结束编译"静默无效——现
    executeAndWait 支持把执行句柄回写护栏条目（`vscode/tasks.ts`）。
  - 静态分析报告收集对"扫描与读取之间文件被 Clean 删除"容错，不再裸 ENOENT
    （`vscode/analysisReport.ts`）。
  - 删除确认"工程外"提示按折叠路径比较：盘符/大小写拼写差异不再误报/漏报提示行
    （`vscode/fileOps.ts`）。
  - Sync Setting 页未设置枚举改种 `(default)` 显式选项：与属性页 readEnum 及 0.1.3 变更记录
    宣称一致，Apply 选择 default 即保持未设置而非写入首选项值（`vscode/syncPage.ts`；
    webview-test 新增 2 断言）。
  - `isSafeLinkName` 拒绝尾点/尾空格（Windows 落盘剥离导致目录合并）与 DOS 保留设备名
    （CON/NUL/COM1 等，mkdir 失败会中止整个导出）（`vscode/cmakeExport.ts`；cmake-test
    新增 3 断言）。
  - removedresources-test 树过滤段异常不再静默按通过退出：树段正是该套件守护对象，异常计入
    失败并以非零退出（`tools/removedresources-test.js`）。

- **JSONC 尾逗号后的行尾注释不再被替换路径吞掉**（开发机第五轮复审发现）：数组级尾逗号被
  `stripJsonc` 抹成空格保偏移后，`arrayElements` 在剥离视图上看不到它——最后一个元素的
  span 一路吞到闭合括号，替换 MRVC 条目时把原文尾逗号与其后的行尾注释一并抹掉（JSONC
  仍可解析，但用户注释丢失）。现 `arrayElements` 把被记录的尾逗号位置同样视作元素边界，
  元素 span 精确终止于其自身容器的逗号（`vscode/intellisense.ts`；`intellisense-test`
  新增 5 断言；既有 JSONC 断言的校验器升级为完整 JSONC 口径——剥 BOM/注释/尾逗号后比对，
  与 cpptools 消费语义一致）。
- **c_cpp_properties.json 的 includePath 不再携带悬空 include 路径**（用户实测反馈）：EVT 模板
  工程自带"超集"include 列表——.cproject 引用了工程既没有链接也没有目录的路径（如
  BackupUpgrade_IAP 引用 HAL/LIB/Profile、BLE_UART 引用 APP/2g4，全树皆然）。IntelliSense
  链路的 `intellisenseArgs` 与 makefile 链路不同，没有 dropMissing 过滤，这些悬空路径进入
  compile commands 后被收进 MRVC 条目的 includePath 兜底数组，而 cpptools 会逐条校验
  includePath 并在问题面板报一条 "Cannot find"——打开 CH585EVT/EXAM 这类多工程工作区时
  报几十条。现三处 resolveList（include.paths/systempaths/include.files）与 makefile 链路
  一样补上 dropMissing 过滤，真实链接目标路径不受影响（`core/flags.ts`；`intellisense-test`
  新增 4 断言）。
- **不再写入 cpptools 架构不认识的 `cppCompilerPath` 属性**（用户实测反馈，同源问题面板噪音）：
  MRVC 条目此前附带该键，cpptools 的 c_cpp_properties schema 无此属性，逐次报
  "Property cppCompilerPath is not allowed"。现不再写入；已生成文件中的残留键在合并时显式
  清除（合并语义是保留旧键，不删除则旧值永久残留）——普通 JSON 与 JSONC 外科两条写路径
  同步处理（`vscode/intellisense.ts`；`intellisense-test` 新增 3 断言，含旧条目残留键清理）。
  已生成的 c_cpp_properties.json 在下次触发 IntelliSense 时自动重写自愈（EXAM 工作区实测：
  206 条绝对 includePath 全部存在、残留键清零）。

- **c_cpp_properties.json 嵌套尾逗号误判为数组分隔符**（第四轮审查 P1，编译产物直调复现）：
  上一轮尾逗号保护用"区间内出现过被抹除的逗号"判定，但元素对象内部的尾逗号（比数组级尾逗号
  更常见的手写形态）也会命中——向 configurations 插入 MRVC 条目时不再加分隔符，两个对象之间
  无逗号，文件当场损坏并永久触发 'unreadable' 哨兵。现 stripJsonc 记录每个尾逗号**自身容器的
  闭合括号偏移**，仅当闭合位置与目标容器一致时才省略分隔符（`intellisense.ts`；新增 6 断言，
  含数组插入/根级追加两路径）。
- **空根对象写入前导逗号**（第四轮审查 P1，复现）：`{ /* 注释 */ }` 或带 BOM 的 `{}`（BOM 被替换
  为空格后走 JSONC 外科路径）在追加 configurations 时输出 `{,`——文件不可解析且此后永不再更新。
  现根对象无属性时不加分隔符（`intellisense.ts`；新增 3 断言：纯注释/BOM/注释+BOM）。
- **属性页 Apply 不再回滚下载地址**（第四轮审查 P2）：Chip 页与 Download Settings 页的地址输入框
  写同一个 .template "Address" 键，Apply 先发 saveDl 后发 save——save 收集到的 Chip 页输入框仍是
  打开时的旧值，把刚写入的新地址静默回滚且提示"已保存"。现两个输入框 input 事件双向镜像，
  无论编辑哪一侧，两次写盘值一致（`configView.ts`）。
- **CMake 导出：链接目录目标自嵌套**（第四轮审查 P2，上轮修复的盲区）：导出目录选在链接目录
  目标内部时，链接目标的 copyTree 未跳过导出目录，递归自拷贝直到路径超长失败、在共享目录留下
  嵌套垃圾。现提取 copyLinkedFolders 助手并同样传入 skipDir（`cmakeExport.ts`；新增 3 断言）。
- **Exclude/Include From Build 写路径大小写折叠**（第四轮审查 P2）：查询/扫描侧已折叠比较，写回
  却是字面比较——token 与磁盘拼写大小写不一致的工程（CH587 USBPD 式）"恢复编译"静默无效、重复
  "排除"追加大小写变体重复 token。现 excludeResource/includeResource 按 win32 折叠匹配
  （`cproject.ts`；`exclude-test` 新增 7.5 组 5 断言）。
- **扫描器对链接目录命名 entry 的令牌查找折叠大小写**（第四轮审查 P2）：.cproject 命名 entry 名与
  .project 链接名大小写错拼时，dirTokens.get 原样键查找落空，excluding 令牌被静默丢弃（排除报告
  成功、构建照常编译——顶层文件夹修复的残余路径）。现按折叠匹配收集令牌（`scan.ts`）。
- **XML 混合内容保文本**（第四轮审查 P2）：解析把元素内文本挂到 el.text，序列化在有子元素时从不
  输出文本——`<name>My <!--note--> Proj</name>` 这类手写混合内容在任意写回后名字被清空。现有
  子元素时先输出文本（`xml.ts`；`roundtrip-test` 新增 3 断言，含纯文本文档字节不变校验）。
- **makefile 的 common 选项串过 `$` 转义**（第四轮审查 P2）：target/optimization/warnings/debugging
  四个 "other" 用户文本经 commonOptions 直通配方，而 per-tool 串已转义——同一 `$` 输入两种命运，
  make 把它当变量展开后旗标静默变错。现 common 同样过 escapeMakeDollars（`makefile.ts`；
  `makefile-dollar-test` 新增管线级 2 断言）。
- **CMake 导出补齐 include 三形态 + 静态库目标**（第四轮审查 P2）：①提取正则只认裸 `-I`，
  `-isystem`（系统路径）与 `-include`（强制包含文件）被静默丢弃（skipIncludes 已把它们从旗标串
  移除）、汇编器 include 更是从未收集——CMake 构建缺头文件路径；现三形态全收割，-I/-isystem 进
  include_directories，-include 按语言保留在 CMAKE_*_FLAGS。②isExecutable 硬编码 true，静态库
  工程走 add_executable + 链接脚本 + hex/bin 后处理，链接期必报 undefined reference to 'main'；
  现按 cp.artifactType 分支：库工程 add_library + CMAKE_AR 归档配方，跳过链接与后处理
  （`cmake.ts`；`cmake-test` 新增 10 断言）。
- **新建工程名拒绝空白字符**（第四轮审查 P2）：core 校验与 renameProject 的 `\s` 拒绝规则脱节，
  含空格名走完解压/建目录才在改名一步抛错，落成双 .wvproj 半改名态。现 core 与前端向导校验
  同步补 `\s`，第一步即拒（`core/newProject.ts` + `vscode/newProject.ts`；新增 2 断言）。
- **模板解压失败不再留下半成品目录**（第四轮审查 P2）：缺 zip 原本在建目录后才报错、坏 zip/超时/
  杀软锁定后残留半提取目录，同名重试永久 "already exists"。现 zip 校验前置到建目录之前，解压
  失败尽力清理 projectRoot 再抛错。附带修复：Windows PowerShell 5.1 对坏 zip 报**非终止错误且退出
  码为 0**，解压失败被整体吞掉、"成功"创建空工程——现 PS 命令包 try/catch + `-ErrorAction Stop`，
  失败显式 exit 1（`core/newProject.ts`；新增 4 断言）。
- **批量 Clean All / Delete Output Files 尊重构建护栏**（第四轮审查 P2）：两项批量操作不查
  building 表，make all 进行中可对同一工程并发 make clean / 删 obj/，编译期产物被抽走。现与
  run()/buildOne 共用护栏，命中跳过并在汇总中注明（`tasks.ts`；新增 i18n 键 buildBusySkip；
  `webview-test` 新增 3 断言）。
- **webview-test 不再改写真实 EVT 工程**（第四轮审查 P2，测试基建）：批量同步断言的成员列表
  原以真实 LED 工程为首成员且结束不还原——参考树 .cproject 被永久改写（本机 TEST 树 LED 的
  gcsections 被写成 false，全树 105 工程中唯一孤例，已按树内标准值还原），断言也在首跑后退化为
  恒真。现两个成员均为 .scratch 副本（`tools/webview-test.js`）。

- **打开 `.wvsln` 不再静默覆盖同名 `.code-workspace`**（复审 P2）：重复打开解决方案时，
  手工维护过的多根工作区文件（自加的文件夹/设置）此前被 4 行生成内容直接替换、不可恢复。
  现存在即弹模态确认（与 Generate Solution 同款 overwriteConfirm），取消即不动（`projects.ts`）。
- **CMake 导出三处加固**（复审 P3）：①导出目标选在工程根内时，copyTree 会把刚生成的导出树
  递归拷进自身形成嵌套垃圾副本——现跳过导出目录自身；②`.project` 链接名未校验即作导出内
  路径段，恶意工程可以 `..\` 逃逸导出目录——现按向导同款规则拒绝分隔符/Windows 非法字符/
  纯点名字；③exportAsCMakeCmd 全程无错误处理，`.cproject` 损坏时静默失败——现与 Generate
  路径同款 try/catch + 明确报错（`cmakeExport.ts`；`cmake-test` 新增 6 断言）。
- **New MounRiver Static Library 落实静态库身份**（复审 P3）：向导此前把 `artifactType='lib'`
  丢弃，产物仍是 exe 工程（链接 ELF + hex/bin 后处理）。现创建时写 `buildArtefactType=
  staticLibrary`（standalone 属性与 buildProperties 双写，MRS2 读取序兼容）并把产物扩展名
  翻转为 CDT 静态库默认 `a`——makefile 随之走 ar 归档配方、跳过 hex/bin/lst/size；翻转失败
  不阻塞创建（`core/newProject.ts`；`newproject-test` 新增 5 断言，真实 SDK 模板端到端）。
- **新建向导模板扫描容错**（复审 P3）：`scanTemplates` 三层 readdirSync 均未捕获，SDK 子目录
  ACL 拒读时整条向导链路 unhandled rejection——现逐层跳过不可读目录（与 chipdb 同款写法）。
- **新建工程名前后端校验对齐**（复审 P3）：向导输入框此前放行 `$`、反引号、引号，用户走完
  全部步骤才被 core 拒绝——现前端即拒（`vscode/newProject.ts`）。
- **`c_cpp_properties.json` 尾逗号兼容**（开发机复审发现）：用户的 configurations 数组
  （或根对象末属性）带尾逗号时，首次插入 MRVC 条目会在原文上追加多余分隔符产生 `", ,"`、
  文件此后无法解析并触发"永久不可读"哨兵——正是注释保护改造要消灭的故障模式。现
  `stripJsonc` 记录被抹除的尾逗号位置，外科拼接遇其存在则不再追加分隔符（`vscode/intellisense.ts`；
  `intellisense-test` 新增 8 条断言，含数组/根级、纯尾逗号与"尾逗号+注释"变体）。
- **BuildOrder 行不再累积重复**（Set Build Order）：`recordBuildOrder` 原实现无条件在首行后
  插入新行、循环到旧行又替换一次——对已有 `BuildOrder=` 的 solution 调用一次产生 2 行，
  每点一次"设置编译顺序"再多 1 行。现先探测已有行、原位重写并收敛历史重复行，缺失时仍按
  MRS2 惯例插在首行之后（`solution.ts`；`solution-test` 新增 8 条幂等断言）。
- **"生成汇编清单"恢复生效**：`flags.ts` 的 `-Wa,-adhlns="$@.lst"` 含 make 自动变量 `$@`，
  makefile 生成器把整条选项串的 `$` 一律翻倍成 `$$@`，make 展开后 shell 收到空 `$@`——每个
  文件的 `.lst` 静默坍缩成同一个 `.lst`，且与 MRS2 的单 `$` 字节失配。新转义函数
  `escapeMakeDollars` 只翻倍用户文本里的 `$`，`$@ $< $^ $* $? $( ${` 等 make 语法原样保留
  （`makefile.ts`；新增 `makefile-dollar-test` 11 条断言）。
- **静态调用分析的 caller 名不再携带 GCC 簿记后缀**：真实 GCC 的 RTL dump 函数头是
  `;; Function main (main, funcid=1)`，解析器此前整段取用，caller 变成
  `main (main, funcid=1)`，与 `.su` 报告和 UI 函数列表全部失配。现截断括号部分并容忍裸头；
  测试夹具从合成裸头换成真实 GCC 头（`analysis.ts`）。
- **单工程构建并发护栏**：F7 连按、行内按钮双击、或 Build All 进行中对同一工程再点 Build，
  会启动两个 `make -jN` 写同一 `obj/` 与同一构建记录文件。现按工程根（小写）登记运行中的
  任务执行——重复触发弹提示并可"结束编译"真实终止（单构建与批量成员双入口共用护栏），
  任务结束/启动失败均正确释放（`tasks.ts`）。
- **构建并下载的下载失败不再静默**：`.template` 地址非法（手填错值）时 `prepareFlash` 抛错，
  Build And Download 链路裸 `await` 使其成为 unhandled rejection——编译成功后下载没发生且
  无任何提示。现 `prepareFlash` 失败弹明确错误（`flashAddressInvalid`），调用点再兜一层
  （`downloadThrew`），独立 Download 路径不会双重弹窗（`flash.ts` + `tasks.ts`）。
- **Export As CMake 不再被旧 CMakeLists 覆盖**：导出先拷贝工程文件再生成便携版
  CMakeLists.txt，而 copyTree 不跳过 `CMakeLists.txt`——凡原地生成过 CMakeLists 的工程，
  导出产物被含本机绝对路径的旧文件静默覆盖。现调换顺序：先 copyTree 后生成
  （`cmakeExport.ts`）。
- **带命名 sourceEntry 的顶层文件夹 Exclude From Build 真实生效**（CH585 式工程）：CDT 联合
  语义下根 entry 里与目录同名的 token 只是"防双扫标记"，扫描器经命名 entry 把文件夹重新
  纳入——排除命令报告成功、构建照常编译。现排除 = 删除该命名 entry 并在根 entry 写入
  token（entry 不在时 token 即真实排除），恢复 = 重建 entry（MRS2 手写形态
  `flags="VALUE_WORKSPACE_PATH|RESOLVED"`）并清 token；扫描器三处 marker 判别统一改为
  "仅当 entry 仍存在才当标记"（`cproject.ts` + `scan.ts`；`exclude-test` 新增顶层文件夹与
  大小写变体两组用例）。entry 名与链接名大小写不一致的 EVT 文件也能正确命中（比较折叠）。
- **`c_cpp_properties.json` 不再销毁用户注释**：原实现把整个文件以纯 JSON 重写——JSONC 注释
  全丢；行尾注释更会触发"永久不可读"哨兵、此后配置不再更新。现用保偏移的 JSONC 剥离器 +
  外科手术式编辑：纯 JSON 文件维持整文件重写（字节稳定），带注释文件只替换/插入 MRVC 那
  一个 configuration 块，用户注释逐字保留（`vscode/intellisense.ts`；`intellisense-test`
  新增 8 条断言）。
- **Exclude/Include 不再用过期快照覆盖磁盘**：写路径改为先 fresh-load `.cproject` 再改再存
  （与属性页/同步页同纪律），外部编辑器或 MRS2 刚保存的修改不再被内存缓存冲掉
  （`vscode/exclude.ts`）。
- **浮点编译旗标按 MRS2 生成器逐键对齐**：真实 `.cproject` 同时携带 `target.isa.fp`
  （"Floating point"）与 `target.abi.fp`（"Floating point ABI"）两个独立选项，MRS2 构建器
  （extensions/mrs-team.mrs-vscode 源码实证）用 **isa.fp** 拼 `-march` 的 F 后缀
  （single→f、double→fd、quad→fdq）、用 **abi.fp** 拼 `-mabi` 后缀（single→f、double→d）。
  此前 MRVC 只读 abi.fp 且同一后缀两处共用——两键取值不一致的工程会拼错旗标。现
  `-march` 跟随 isa.fp（补 quad 分支）、`-mabi` 跟随 abi.fp（`flags.ts`；新增
  `flags-fp-test` 10 条断言，含 CH32V307 FPU 例程实测 `-march=rv32imafc_xw -mabi=ilp32f`；
  发售 EVT 树两键恒同值，makefile 字节不变）。

### 新增

- **多根工作区 IntelliSense**：此前只有第一个 workspace folder 拿到 `c_cpp_properties.json`，
  `.code-workspace` 多文件夹时其余 folder 的文件走 cpptools 默认配置。现每个 folder 都写入
  MRVC 配置项，次级 folder 用绝对路径指向主 folder 的 `.vscode/mrvc/cc` 编译数据库
  （`vscode/intellisense.ts`；`intellisense-test` 新增多根用例）。

### 变更

- **构建输出（products）节点不再提供"重命名"**（复审 P3）：obj 目录名由 `.cproject` 决定，
  改名会与构建配置、目录监视、`.template` Target Path 全面脱钩——右键菜单移除该项
  （`package.json`）。
- **链接目录内资源的删除确认补充位置提示**（复审 P3）：链接文件夹目标位于工程之外，
  删除会真实移除外部磁盘文件——确认弹窗 detail 追加一行明确提示（双语，`fileOps.ts`）。
- **webview CSP 收紧**：属性页与 Sync Setting 页的脚本改随机 nonce 门控（每次渲染新
  nonce），`script-src` 移除 `'unsafe-inline'`——所有插值本已转义，此变更提供第二道防线
  （`configView.ts` + `syncPage.ts`；`webview-test` 新增 nonce 断言）。
- **`mrvc.solution` 设置正式声明**：打开 `.wvsln` 时写入生成的 `.code-workspace` 的该键此前
  未在 package.json 声明，设置页显示"未知配置"警告；现声明为扩展托管项（说明勿手改）。
- **文档勘误**：README 工程发现深度实为 6 层（原写 4）；排除说明改为"活动配置（首个
  `cconfiguration`）"并写明顶层文件夹排除的新语义；`discover.ts` 注释与常量对齐。

### 测试

- 开发机终态（10-07 第四轮后复跑）：18 个断言套件全绿（第四轮新增 46 断言：嵌套尾逗号/空根
  对象 15 + 大小写写路径 5 + XML 混合内容 3 + common 转义管线 2 + CMake includes/静态库/自嵌套
  11 + 向导校验/解压清理 6 + 地址双向同步与清理护栏 4）+ mass 全树 972 工程 / 37094 源文件
  0 错误、逐工程字节稳定。
- **金标比对缺口记录在案**：真 MRS2 金标树 `.goldens/` 未随仓库/机器迁移，本机 EVT 树中
  的 `obj/makefile` 均为早期原型产物（头部 `# Generated by mrs2-vscode`），无比对裁决力。
  本轮 `$` 转义改动（`escapeMakeDollars`，新增 common 串覆盖）的字节稳定性由
  `makefile-dollar-test` 13 断言（金标路径不含 `$`、转义为 no-op）+ mass 全树逐工程字节稳定
  覆盖；待金标树恢复后 `npm run golden` 可直接复验。

## V0.1.5（2026-09-30）

相对 V0.1.4。金标回归 29/29 全绿（2.x 配方完全对齐）；运行时 makefile 生成默认切换为
现行 MRS 2.1.0 风格；命令与运行时消息全面中文化。

### 新增

- **Build Project And Download**（`mrs2.buildAndDownload`，对齐 MRS2 同名命令）：编译 + 下载
  一条龙——编译成功才下载，编译失败/取消即止，不再需要先 Build 再 Download 两步操作。
  入口：工程右键菜单（Build 项之后）与命令面板（需活动工程）。
- **依赖扩展安装引导**：检测到未安装或版本过旧（<1.23.5，双数据库机制的硬要求）的
  "C/C++" 扩展（ms-vscode.cpptools）时，加载工程后提示安装/更新，可一键打开扩展页，
  可选"不再提示"；已安装 clangd 的用户不打扰。离线机器请按提示在有网的电脑下载
  cpptools 的平台 VSIX（win-x64）后用 Install from VSIX 安装。
- **新建工程记忆上次创建位置**（对齐 MRS2 HistroyManager.lastCreateProjectPath）：新建
  工程/静态库的位置选择步骤升级为可编辑路径框——预填上次创建工程所在的目录（跨窗口记忆；
  无历史时定位到当前工作区），**可直接键入/粘贴任意新路径**（目录不存在会自动创建，与 MRS2
  向导的文本框语义一致），也可点"浏览文件夹…"打开系统对话框选择；创建成功后记录本次位置。

### 变更

- **命令菜单全面中文化**（随 VSCode 界面语言）：58 条命令标题改为 `%key%` 占位符并新增
  `package.nls.json`（英文）与 `package.nls.zh-cn.json`（中文，MRS2 同款用语），中文界面下
  全部右键菜单/命令面板显示中文。注意：菜单标题跟随 **VSCode 显示语言**（VSCode 内置机制），
  `mrvc.language` 设置继续驱动运行时消息（提示/报错等）。工程树视图头仍为 "Project Explorer"。

- **运行时 makefile 生成默认切换为 MRS 2.1.0（现行 MRS2）风格**。此前沿用最初逆向所依的
  MRS 1.9.2 布局；1.9.2 已停止维护，且 2.x 布局本版本已与 MRS2 金标字节级对齐，运行时没有
  理由继续产出旧风格。对构建结果无影响（make 语义等价），首次构建会因 makefile 再生成而
  全量重编一次；与现行 MRS2 打开同一工程时的 makefile 差异降到零。1.9.2 布局仍可通过
  `generateMakefiles(…, { mrs2Style: false })` 复现（金标比对在用）。
- **平台范围声明**（自 V0.1.4 起，README 已注明）：MRVC 当前仅支持 Windows（10/11）——
  工具链/烧录组件取自 MRS2 Windows 版，WCH-Link 桥接依赖 32 位 DLL。Linux/macOS 暂不支持。

### 修复

- **构建路径字符类系统化加固**（系统矩阵测试：空格/`&`/`+`/撇号/`^`/`$`/方括号/感叹号/波浪号/
  逗号/中文/日文假名 13 类，全部真机编译通过）：`$` 在 make 层被变量展开（编译器收不到正确
  路径）已转义；`%` 在包装脚本中被变量展开已转义；Clean All / Rebuild 的清理步骤与单工程
  Clean 同样改走零元字符包装脚本（此前仍携带含元字符的 cwd）；编码失败（如路径含 emoji，
  系统码页无法表示）由静默替换 `?` 改为明确报错；**CJK 码页对齐 MRS2**——日文(932)/韩文(949)/
  繁体(950) 系统的构建产物分别以 Shift-JIS/EUC-KR/Big5 编码（与 MRS2 的"匹配编码"行为一致，
  此前错误地写 UTF-8）。已知限制（与 MRS2 逐字节一致、无法绕过）：路径含 `( ) ; % #` 任一
  字符时 makefile 无法表达，构建会失败。
- **构建包装脚本挪出工程目录**（外部用户报 `EVT-IPV4&6` 目录启动失败）：工程路径含 cmd
  元字符（`&` 等，`IPV4&6` 是以太网例程常见命名）时，VSCode 把任务命令行未经引用地交给
  终端 shell，cmd 在 `&` 处把命令拆成多条碎片（"不是内部或外部命令"）。包装脚本现生成到
  `%TEMP%\mrs-build\<md5>.cmd`（纯 ASCII 零元字符），内部以带引号的 `cd /d "<构建目录>"`
  进入工程——引号内的 `&` 是字面量，实测含 `&` 的完整路径可正常编译。
- **新建工程路径选择的边界加固**（外部复审发现）：父目录此前直接内插进 `Expand-Archive`
  的 `-Command` 字符串，含 `$`/反引号的路径会被 PowerShell 先行展开，导致解压落点与登记
  路径不一致——现改用单引号字面量并对内层单引号转义；同时补 `normalizeParentDirInput()`，
  避免把盘根（`C:\`）裁剪成 `C:` 后 `path.resolve` 落到"该盘当前目录"（裸盘符与双分隔符
  形态一并归一为盘根）。生成 makefile 前对 `( ) ; % #` 做前置检查，命中直接报明确错误
  （不再让用户面对 make 的晦涩报错）。
- **`mrvc.build.analysis` 对 Build All / Build Solution / Rebuild All 生效**
  （外部复审发现）：此前只有单工程构建注入分析旗标，批量构建后静态栈分析报
  "no .su files found"。
- **运行时消息中文化补全**（外部复审发现）：属性页保存提示、静态分析报告提示、
  新建向导、MRS Tools 启动器、链接文件夹、文件操作对话框（移除/删除双按钮）、
  解决方案生成、批量构建进度提示等此前硬编码英文的消息全部接入 `mrvc.language`
  （复审口径 50 条字面量 → 9 处调用点，2 种通用错误转发写法）；清理 14 个随
  EVT 功能移除而失效的字典键。
- **2.x 配方完全对齐：金标回归 29/29 全绿**（此前 18 identical / 11 different）。对 MRS 2.1.0
  代次（HarmonyOS 金标）补齐全部行级模板差异：链接/objcopy/lst 配方单 `@` 前缀且不再有配方
  尾行、size 行无 `@`（构建输出可见）且尾行为空行、链接行携带 `-fmax-errors=20`、objcopy 参数
  单空格、clean 变量序（`$(OBJS)` 提前）且尾行为空行、objects.mk/sources.mk 头部布局与变量声明
  顺序（DEPS 组提前、`:=` 无尾随空格）、objects.mk 与 makefile 无文件尾换行、外链目录 subdir
  规则块保留尾空行而工程内目录不带。路径全部按 2.x 代次习惯输出：盘符小写、宏解析路径正斜杠
  （-I/-T/-L），普通相对 `-L"../"` 解析为工程目录绝对路径（原生反斜杠）。`.cproject` 的
  `target.other` 尾随空格保真拼接（金标 "…=1  -Os" 双空格是数据不是代码）。1.9.2 代次输出
  逐字节不变。

- **Show Full Build Output 现在包含每个文件的编译指令**。此前记录里只有链接/size 尾段：
  MRS 生成的 makefile 配方带 `@` 静音前缀（与 MRS2 逐字节一致），make 的输出天然不含编译
  命令行，且 Build All / Build Solution 路径此前根本不写构建记录。现在所有构建路径（单工程、
  批量、解决方案、编译并下载）统一写入 MRS2 同款记录文件，并在记录尾部追加 `make -n -B`
  干跑清单——列出每个源文件的完整编译指令及链接、objcopy 命令。Clean 不再覆盖上一次构建
  的记录；包装脚本改按系统 ANSI 码页写盘（修复中文用户名机器上 %TEMP% 路径损坏的隐患）。
- **全片擦除已实现**（.template 的 Erase All=true，MRS2 属性页 Chip 页同名勾选）：下载前
  擦除全部 flash bank（双核工程擦两个 bank），其余行为（地址双传/校验/复位）不变。注意
  OpenOCD 的 program 内建流程自带无条件 init，擦除模式改为显式展开等价步骤（init →
  reset init → erase_sector → write_image erase → verify_image → reset → shutdown）。
- **IntelliSense 加固**：单工程工具链解析失败时，其私有数据库此前会永远停留旧内容（重选
  工程也不自愈）；现在失败工程也会重写数据库为全量 canonical 回退库，切换上下文永远拿到
  当前内容。
- **Show Full Build Output 补挂输出面板右键**（对齐 MRS2 的 editor/context 挂载点）：在
  输出面板文字区右键即可打开完整构建输出，不再只有命令面板一个入口。

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
  排除等）。设置变更即提示一键重载窗口。
  覆盖范围（0.1.5 如实修订）：主要运行时消息——文件管理/重命名工程/同步
  工程名/排除恢复/同步页/树节点描述/属性页与分析报告提示/新建向导/链接
  文件夹/解决方案生成（约 18 模块 150+ 键）；命令面板标题在 0.1.5 起改由
  manifest NLS 机制提供中文（跟随 VSCode 界面语言）。个别低频路径仍为英文。
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
