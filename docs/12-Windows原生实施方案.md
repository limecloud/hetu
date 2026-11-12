# Windows 原生实施方案

V1 支持 Windows 11 x64，与 macOS 具有相同的核心业务范围。ARM64 按独立的桥接、依赖和实机验收要求扩展。

## 1. 工程与职责

采用 WinUI 3／Windows App SDK、C# MVVM Presentation 和共享 C++ 内核。.NET 采用 10 LTS；Windows App SDK、.NET SDK、最低系统 Build 与 MSVC 的精确组合记录在构建锁定清单。

```text
apps/windows/
  src/
    Hetu.Windows.App/          # WinUI XAML、窗口与组装
    Hetu.Windows.Presentation/ # 视图模型、状态与命令
    Hetu.Windows.Bridge/       # P/Invoke、SafeHandle、UTF-8 转换
    Hetu.Windows.Platform/     # 系统选择器、凭据与系统行为
  tests/
```

领域逻辑只在 C++ Core，不再建平行 C# 规则引擎。Presentation 避免直接引用 WinUI，便于独立检查状态；依赖 Dispatcher 的处理留在 App 或小型调度接口。

## 2. C ABI 互操作

固定 `cdecl` 调用约定、显式结构尺寸与 ABI 版本；句柄由 `SafeHandle` 持有。文本显式 UTF-8 编码与长度，不默认使用 Windows ANSI 或把 `wchar_t` 当跨端类型。

所有 Core 返回缓冲由 Core 提供的释放函数释放；不能混用 CLR 和 C++ 分配器。回调 delegate 在任务完成前保持强引用，异常只在桥接层映射，不跨 native 边界传播；任务完成后取消注册再释放上下文。

win-x64 与 win-arm64 使用匹配的内核 DLL 和依赖，启动检查架构、ABI、库签名及加载位置；只从安装目录加载，不搜索工作区 DLL。内核是普通用户权限运行，不以管理员身份启动整个编辑器。

## 3. 编辑器与系统体验

使用原生文本控件并验证 Markdown／Fountain 长文编辑、IME、撤销、查找和高亮。优先对 WinUI 文本控件做原型，必要时使用受支持的原生编辑组件；不得以嵌入浏览器代替 V1 核心编辑器而仍宣称完整原生。

输入法组合期间不重设全文，选区与诊断定位在 UTF-16 和修订绑定的 UTF-8 SourceRef 间转换。支持系统文件选择、拖放文件、快捷键、焦点可视与 Narrator。拖入目录只显示导入预览，不自动扩大授权根。

## 4. 文件与凭据

Platform 处理 Win32 文件身份、共享模式、原子替换和锁；Core 保持跨平台逻辑路径策略。必须核对实际卷的大小写行为，拒绝路径穿越、设备路径、盘符相对路径、备用数据流、未知 reparse point 以及 junction 逃逸。

V1 默认不支持 UNC 写工作区或云盘未下载占位文件。保留中文、空格、长路径的输入；能否写入由实际系统 API 和支持矩阵判断，不能在 macOS 模拟路径测试后宣称 Windows 通过。

Git Token 使用 Credential Manager 或当前用户保护的系统凭据接口；SSH 使用已授权系统 agent。换用户、凭据缺失、锁屏／退出及安装升级分别验证，不把密钥序列化到 `.heturc.json`。

## 5. 构建、打包与更新

CMake 产出各架构 native DLL 和 C++ MCP，SwiftPM 构建同一套 Swift CLI；Windows App 与 CLI 消费相同 ABI 版本的固定内核产物。CLI 不依赖 WinUI 或 .NET，打包所需 Swift runtime 与 native 依赖并在未安装 Swift 工具链的系统验收。开发可先提供未签名内部包，正式发行需 Authenticode、固定依赖、干净用户安装与卸载验证。MSIX／受控安装器方案在 M0 原型后冻结。

.NET 自包含不等于 Windows App SDK 已自包含，需分别验证。WinUI、COM、互操作和依赖加载通过前，不启用 Native AOT、激进裁剪或单文件发布。卸载默认保留作者工作区，删除个人数据必须独立确认。

## 6. 验收与平台对齐

Windows 原生验收覆盖中文输入法、125%／150%／200% 缩放、高对比、Narrator、文件占用、权限拒绝、junction、大小写、CRLF、凭据、Git 冲突、断网、崩溃恢复及安装升级。

跨端对齐按需求 ID 记录实现、未实现、刻意差异及证据：同一设定集、草稿和节点夹具应得到同一业务结果；系统授权 UI、路径身份和编辑器行为分别取证。macOS 上 C# 编译、C++ 交叉编译或窗口启动均不能代替 Windows 完整用户旅程。
