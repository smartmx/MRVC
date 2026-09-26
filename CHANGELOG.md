# MRVC 更新日志

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
