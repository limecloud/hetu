# 外部 Agent 与局部交互研究

资料日期：2026-11-13。资料依据为官方正文与 AXI 0.2.1 的分层设计；来源、表示方式及摘要见[sources.json](sources.json)。本章说明可据以设计的能力及边界，不构成特定宿主运行验收。

## 1. 官方资料与采用

| 来源 | 正文确认的能力 | 河图洛书的采用及限制 |
| --- | --- | --- |
| [OpenAI Plugins](https://learn.chatgpt.com/docs/plugins.md) | 插件组合 Skills 与 MCP；Codex CLI 有插件浏览入口，安装后新会话使用；IDE 插件支持范围不同 | 软件按客户端及运行表面给引导，不能统一给所有 Codex 表面同一安装承诺 |
| [OpenAI Build skills](https://learn.chatgpt.com/docs/build-skills.md) | SKILL.md 元数据发现、按需加载、显式与隐式调用 | 为建书、资料、大纲、封面、文本和短剧提供专用方法，Prompt 指明任务及匹配 Skill |
| [OpenAI Package your plugin](https://developers.openai.com/plugins/build/plugins.md) | 可移植根 plugin.json、mcp.json、skills；OpenAI 设置及兼容清单有独立规则 | Codex 用 Plugin 分发；本地源码、安装缓存、当前会话发现与公共目录发布分别验收 |
| [Claude Code Skills](https://code.claude.com/docs/en/skills.md) | 支持 Agent Skills、SKILL.md 及其原生调用方式，额外元数据属宿主扩展 | 复用共同方法正文，适配安装位置和命名空间，不照搬 Codex 的调用语法 |
| [Claude Code MCP](https://code.claude.com/docs/en/mcp.md) | MCP 服务接入、transport 及范围配置 | 按明确版本配置连接，不从 Claude Desktop 的功能推导 Claude Code 的 Apps 支持 |
| [WorkBuddy Skills](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) | 技能安装、上传、启用和卸载；当前会话可能保留已加载技能 | 包启用与当前任务实际加载分别核对，不用开关状态代替验收 |
| [WorkBuddy 连接器](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector) | MCP＋CLI 与 Skill＋CLI 形态、自定义 MCP、按需连接与重新授权 | 提供 Skills＋MCP 引导；保留原操作键处理宿主重试，不把授权失败与网络失败混用 |
| [WorkBuddy Agent Browser](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/WorkBuddy-Zero-Cost-Skill-Top-10/Agent-Browser) | 浏览器 Skill 可打开网页、滚动、点击、截图及读取 | 可作为局部网页交互载体；不能据此推断可达本机、支持 WebMCP 或与 Codex 浏览器 API 相同 |

## 2. MCP Apps 与普通网页

[MCP Apps 概览](https://modelcontextprotocol.io/extensions/apps/overview.md)将交互 UI 定义为工具描述关联的 HTML 资源：`_meta.ui.resourceUri` 指向 `ui://` 资源，宿主沙箱渲染，App 与宿主经 postMessage 上的协议交互。它支持工具代理、结果更新与上下文协作，具体能力由宿主控制。

[构建指南](https://modelcontextprotocol.io/extensions/apps/build.md)给出 Node.js／TypeScript、资源打包及 `@modelcontextprotocol/ext-apps` 的示例。这是可选实现路线，不要求河图洛书把 Rust MCP Server 改写为 Node.js，也不证明普通浏览器页面自带 Apps 桥接。

官方明确 Apps 是 MCP 扩展、客户端支持不同。河图洛书据此把 Apps 用于当前任务的书名选择、大纲比较、封面预览及批注，并为不支持的宿主保留结构化结果和原生入口。页面保存不等于作者定稿；模型或自动化都可能调用同一工具，服务端仍须控制最终权限。

补充核对[官方扩展规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)与[发布包2.0.4](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps/v/2.0.4)：工具使用嵌套 `_meta.ui.resourceUri`，资源为 `ui://` 和 `text/html;profile=mcp-app`；旧的扁平 `ui/resourceUri` 已标为弃用。宿主按声明构造 CSP，App 与宿主通过 `ui/initialize` 和工具结果通知交互。SDK 提供可离线打包的 `app-with-deps` 入口与宿主侧 AppBridge；不要求把原生 Server 改为网页服务。

本机实现采用固定版本 SDK、源码与产物摘要、无外部域名的资源和服务端重新授权；实现入口及自动化验收见[14](../14-MCP与Agent接入.md)。规范中的 legacy MCP 初始化示例不替代本项目 `2026-07-28` 的 Server 发现流程，UI 桥接版本独立协商。官方桥接测试与真实 stdio 回读不构成第三方客户端实机兼容声明。

TypeScript Client `2.4.0` 的 `ClientOptions.versionNegotiation` 声明默认 `legacy`；与本机固定版本 Server 互通需显式使用 `{mode:{pin:"2026-07-28"}}`，由 SDK 执行 `server/discover` 并附加每请求元数据。不能从安装了较新 SDK 推断默认连接流程已使用新协议，也不能据此推断任一第三方宿主已启用该选项。

## 3. AXI 参考与独立设计

阅读的 AXI 资料包括 `content/ecosystem/codex/plugins.md`、`interfaces.md`、`mcp-apps.md`，以及 Claude Code、WorkBuddy 适配章节。采纳其方法／连接／交互分层、同任务持久化、原对象回读、CAS、未知结果恢复及按宿主验证的要求。

AXI 是设计草案，未提供可直接复用的河图洛书 Apps 或 Node.js 页面运行时。河图洛书按业务需要设计“用户复制提示词”和按需本地页面：Node.js 只服务局部 UI，经受限 IPC 消费 Rust 用例，回环绑定、原生配对、Origin／CSRF 与单任务会话属于河图洛书自身的安全合同。

## 4. 证据边界

本章没有安装第三方客户端、修改用户扩展配置、启动付费生成或完成 Apps 宿主互操作。因此只能支持文档设计依据，不能据此显示连接成功或宣称某版本已兼容。实际发行须按[19](../19-测试策略与验收矩阵.md)验证客户端、运行表面、扩展与 UI 版本、MCP 协议、浏览器本机可达性、权限、恢复及无增强能力的回退。
