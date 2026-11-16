# Windows Electron实施方案

本文件路径保留以维持引用。新Windows桌面采用与macOS共同的Electron＋TypeScript/React工作台、Rust App Server及独立Rust CLI/MCP；目标为Windows 11 x64，支持声明以实机验收为准。总体决定见[39](39-Electron与插件优先重构架构.md)。旧WinUI／C#／WebView2方案保留在源码历史与[备选研究](plugin/17-原生宿主与插件渲染技术方案.md)，不与Electron并行建设第二套Windows产品。

## 1. 工程与职责

| 组件 | Windows职责 | 共享范围 |
| --- | --- | --- |
| Electron主进程 | 窗口、菜单、文件选择、剪贴板、通知、受管浏览器与进程 | 共同宿主与生命周期；系统行为窄适配 |
| TypeScript/React | 工作面、布局、编辑与审阅 | 与Mac复用贡献合同、组件和状态语义 |
| 插件容器 | 固定包、隔离session、来源验证和受限SDK | 同一Web包；声明平台与实际可用性分别核验 |
| Rust App Server | JSON-RPC 2.0私有stdio、明确作品、Core调用和退出 | 同一业务与传输合同，按OS分别编译 |
| Rust CLI/MCP | 独立机器入口、稳定管理与任务引用 | 无GUI、Swift或.NET运行前提 |
| 平台适配 | 文件身份、锁、凭据、签名与启动行为 | 不复制领域规则 |

## 2. IPC与进程

使用参数数组启动安装目录中的匹配架构助手，禁止Shell拼接、PATH搜索或从作品目录加载可执行文件。stdio显式UTF-8和有界NDJSON，诊断与协议输出分开；进程退出和EOF按39的unknown恢复处理，不能以强杀保证业务撤销。

工作区路径由可信系统选择器取得；renderer、插件、网页不能提交mode、actor或任意打开目录。插件会话绑定包摘要、贡献、WorkRef与授权代次。Windows控制台、无控制台子进程、管道关闭、Ctrl+C和退出超时分别验证，不能套用POSIX信号结论。

## 3. 编辑、渲染与无障碍

使用共同Web编辑器，实测微软拼音及目标第三方输入法的组合输入、撤销／重做、候选窗口、选区、粘贴和长文。JavaScript UTF-16偏移与固定修订UTF-8 SourceRef显式转换；输入法组合期间不替换全文。

验证125%／150%／200%缩放、多屏混合DPI、系统主题、高对比、键盘焦点、Narrator和字体回退。WebContentsView按内容区域同步bounds、可见性和生命周期，避免遮盖菜单、对话框、未保存提示及无障碍焦点。画布、三维和播放器另验GPU、硬件解码与标准替代呈现。

## 4. 文件与凭据

Core与窄平台适配处理Win32文件身份、共享模式、原子替换及锁。验证实际卷的大小写行为，拒绝设备路径、盘符相对路径、备用数据流、未知reparse point及junction逃逸。工作区字符串不是授权，检查后替换竞态仍须由安全打开处理。

V1默认不支持UNC写工作区或未下载的云盘占位文件；中文、空格、长路径和CRLF用真实系统及文件验收。已有源文件字节、换行和摘要不能因换壳自动规范化。

私密凭据使用当前用户受保护存储或明确的受限文件接口；Git Token与SSH agent按既有合同接入。插件拿到的是具体能力，不是Credential Manager、任意密钥或用户目录句柄；锁屏、换用户、退出和安装升级分别验证。

## 5. 构建与分发

按Windows x64构建Electron包、匹配的Rust App Server、CLI/MCP及native依赖，清单固定源、软件/协议/合同版本、OS、架构、许可及签名后摘要。Chromium随Electron分发，普通插件渲染不额外依赖系统WebView2。ARM64与其他平台只在各自依赖和实机验收后扩展。

正式发行需要Authenticode、干净用户安装、升级、卸载、系统保护和进程加载验证。安装器方案在实际打包验证后冻结，不在文档虚构已存在MSIX或流水线。卸载不删除作者工作区，个人数据清理单独确认；独立CLI/MCP在无开发工具、Node、Swift、.NET或桌面运行进程时可用。

## 6. 验收与平台对齐

覆盖中文输入、DPI、Narrator、权限拒绝、文件占用、junction、大小写、CRLF、凭据、Git冲突、断网、崩溃、原键恢复、插件加载／撤权／停用／升级和签名安装。相同作品与插件得到相同领域结果，平台交互分别取证。

Mac上的交叉编译、TypeScript检查、浏览器截图或共用Chromium不能代替Windows旅程。Windows实施不阻塞Mac纵向闭环，但在目标功能宣称跨系统完成前必须通过；具体状态归38，验收要求归19。
