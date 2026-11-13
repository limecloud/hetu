# Figma 插件与设计协作研究

资料日期：2026-11-13。研究对象为已分发的 Figma Codex 插件 2.0.20，采用 REA 6.7.0 静态分析、包内文件核验和官方资料交叉确认。研究用于确定河图洛书的设计方法及产品边界，不构成 Figma 账号、远端工具或河图洛书宿主兼容验收。

## 1. 制品与证据

| 项目 | 观察及适用范围 |
| --- | --- |
| 插件身份 | `.codex-plugin/plugin.json` 声明 `figma`、2.0.20，技能目录为 `skills/` |
| 连接 | `.mcp.json` 指向 `https://mcp.figma.com/mcp`，使用 HTTP；这是 Figma 的连接部署，不要求河图洛书使用远端服务 |
| 方法层 | 包内有设计系统、页面组装、SwiftUI、设计还原、Code Connect、图表和动效等 Skills |
| App 依赖 | `.app.json` 声明 connected app；该文件本身不证明完成 MCP Apps 资源注册与握手 |
| 版本一致性 | `plugin.lock.json` 标记 2.0.7，与当前 manifest 不一致；当前包身份采用 manifest，兼容性须另验实际加载制品 |
| UI 与自动化 | `ui/figma-workbench.html` 为无脚本静态示意；写后 hook 仅输出复核提醒，不能当作已执行的视觉检查 |
| 许可 | 包声明 Figma Developer Terms；研究采用工作方法，不向河图洛书开源仓库复制插件代码、图标或受限资源 |

REA Evidence 为 `ev_7395e5c2bbe77da41eeaa4e5998685f4d091281f36b92d58e4b9cdaa0f89eaf8`，分析根摘要为 `d2e6c18db0ee39d269ecd1eceee54344952f7c132899d30867f3b891dd4446ed`。共解析9个 JavaScript／类型声明文件，无解析失败；328项结构观察不代表漏洞数量。REA 未执行目标代码，也未观察 Figma 服务端、认证、限额或事务实现。

可复核的关键文件摘要、分析范围及来源见[证据摘要](evidence/figma-plugin-2.0.20.json)和[来源清单](sources.json)。原始分析输出保留在忽略目录 `build/research/figma-plugin/`，不随产品交付。

## 2. 对河图洛书有用的设计能力

| 能力或 Skill | 用途 | 河图洛书采用方式 |
| --- | --- | --- |
| `figma-generate-library` | 语义颜色、文字、间距与组件变体 | 先定义书库、卷章目录、状态标签、正文区、参考稿比较等共同组件，覆盖浅暗主题 |
| `figma-generate-design`＋`figma-use` | 在设计文件中复用组件、逐区组装页面 | 先完成多作品书库及单书写作台，再做建书、短剧、参考稿、设置；保留可编辑文本与布局 |
| `figma-swiftui` | 在原生代码和设计间解释控件及语义 | 以 SwiftUI/AppKit 的系统交互为约束，保留中文输入、焦点、撤销及窗口行为；网页代码仅作结构参考 |
| `figma-design-to-code` | 固定节点上下文、截图、变量和素材后实现 | 每个关键页面绑定具体设计节点、语言、主题及状态，避免仅凭整页效果图实现 |
| `figma-code-connect` | 设计组件与实际代码组件映射 | 组件稳定后评估模板映射，不引入已停止维护的框架解析器依赖 |
| `figma-generate-diagram`＋`figma-use-figjam` | 可评审的流程、时序和边界图 | 仓库 Mermaid 维护领域合同；FigJam 可作协作视图，结论须回到对应规范 |
| `figma-create-new-file` | 明确创建独立设计文件的流程 | 有实际设计任务时使用，研究本身无需新建文件 |
| `figma-use-motion`＋`figma-implement-motion` | 定义并实现交互运动 | 仅对确有反馈作用的运动评估，不阻塞编辑和无动画设置 |
| `figma-use-slides` | 演示材料制作 | 面向宣传演示，排在工作台设计及原生实现之后 |

本次会话工具目录包含设计上下文、截图、变量、组件库检索、设计写入、素材下载、Code Connect 与图表工具；官方[工具说明](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)亦区分读取、写入及 remote-only 能力。工具列出不证明账号已获权或调用可用，本次未访问私人设计或执行设计写入。

不把图像生成、生成式插件、视频或着色器工具全部引入河图洛书。封面等生成仍由作者选定的外部 Agent 完成；Figma 是研发设计工具，不是河图洛书运行依赖。

## 3. 官方核对与设计实施

Figma [MCP 概览](https://developers.figma.com/docs/figma-mcp-server/)同时提供远端与桌面服务路径，并推荐其远端服务。此选择依赖 Figma 自身产品的数据与授权体系，不能据此推导本地小说软件也需要先建设云端 MCP。

Code Connect 的 [SwiftUI 页面](https://developers.figma.com/docs/code-connect/swiftui/)明确说明框架专用解析器不再维护，持续维护方式为[模板文件](https://developers.figma.com/docs/code-connect/template-files/)。此判断依据已读取的 SwiftUI 正文；模板及迁移入口本次返回空正文，不据此声明具体模板 API 已核实。河图洛书若接入，应映射已有原生组件和属性，不把旧文档中的 Swift 解析器接入步骤作为新依赖依据。

建议采用的闭环为：用例及状态合同 → 语义 token 与原生组件 → 关键页面的可编辑设计 → 固定节点及素材 → 原生实现 → 同语言、主题、窗口尺寸与状态的截图比较 → 行为验收。书库与章节操作、中文 IME、保存恢复、采纳和独立定稿必须使用实际软件验证；截图相似不能证明业务完成。

包内复核命令覆盖布局、字体、变量、素材和交互，是可借鉴的方法；其提醒 hook 不自动执行这些检查。正式验收应记录实际设计节点、源码与制品、截图、行为结果及剩余差异，规则见[32](../32-品牌视觉与原型规范.md)。

## 4. 插件分工对河图洛书的启示

OpenAI [Plugins](https://developers.openai.com/codex/plugins/)说明插件可组合 Skills 与 MCP，并区分客户端表面及安装后的新会话。Figma 包体现了方法分发与工具连接的组合；插件本身不拥有设计业务事实，也不是通用 Agent Runtime。

河图洛书采用软件拥有作品、插件指导 Agent 的分工。本机 `hetu-mcp` 随软件分发，外部宿主按授权启动独立 stdio 进程，直接复用 Rust Core。桌面退出不必然终止该进程；反之，网页关闭、插件停用与作品授权撤销分别管理。

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview.md)定义宿主沙箱内的交互 HTML 和桥接，不要求公共 Web 服务。河图洛书可从本机 MCP 提供局部资源，并在宿主支持时用于候选选择和批注；不支持时回原生界面或文本交接。普通浏览器需要独立配对与本机可达性验证，不能从 Figma connected app 推导同等能力。

不采用通用脚本执行工具管理作品。河图洛书通过读取任务、提交候选、查询结果等窄业务动作保护范围、版本和权限，网页及插件不获得作者身份或任意文件权限。

## 5. 桌面端与服务端的次序

桌面先完成离线创作、设定、参考稿、采纳、定稿、Git 和交付，以及本机 MCP／Skills 的真实宿主闭环。官网先承担宣传、使用指南和发布入口，不要求创作账号或上传正文。

Figma 的远端服务说明其自身部署方式，不能据此推导河图洛书的服务端业务。河图洛书的服务端须有明确需求后独立确定业务归属、必要数据、身份与资源授权；远端身份不能取得本机文件权限或作者身份。本机局部交互不依赖公网服务。

规范职责矩阵见[03](../03-总体技术架构.md#8-桌面端与-web-服务端职责)，阶段门槛见[20](../20-实施路线与里程碑.md#5-服务端演进与准入顺序)。这些是河图洛书产品决定，不是从 Figma 远端实现逆向得到的内部事实。
