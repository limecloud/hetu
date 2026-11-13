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

## 5. Codex 会话观察与消息交互预研（未来探索）

预研日期：2026-11-13。结论为低优先级、保留探索，不纳入当前里程碑或已支持功能。现行职责与交接流程仍以[集成设计](../27-Agent与Codex插件集成设计.md)为准；以下界面、绑定与恢复方案均需后续立项和验证。

### 5.1 使用价值与启动条件

候选场景是作者同时处理多本书、多个长任务，希望在当前作品里知道外部任务是否完成、是否等待本人处理，并按需读取最近回复或补充要求。仅减少一次窗口切换的收益不足以支撑完整会话客户端的维护成本。

当前优先完善任务交接、候选回读和作者采纳。出现反复、可复现的状态跟进需求后，先评估可选的会话关联与状态查看；读取对话、发送消息分别评估，不因为接口存在就一并建设。探索范围不包含内置模型、模型密钥托管、完整聊天客户端或自动对话循环。

### 5.2 作品与会话的明确关联

消息目标是具体 `threadId`，不是项目目录、整本书或全部 Codex 窗口。关联由作者确认，无需大模型判断书名或对话语义。

1. 作者从当前作品发起关联，只查询明确选定且可连接的 Codex 服务；工作目录用于缩小候选范围。
2. 展示候选会话的标题、目录、状态和最近消息，由作者预览并确认。标题相似、目录相同和模型判断都不能自动完成绑定。
3. 本机保存作品标识、服务连接标识和 `threadId`；一本书可有多条明确标注用途的关联。具体创作任务另外关联河图 `taskId`，会话关联不授予新的作品或任务权限。
4. 查看或发送前显示当前作品和目标会话。切换作品清理旧会话展示与未发送输入；连接失效、会话不可访问时显示原因，不自动选择其他会话或新建替代任务。

这类关联保证操作指向作者选定的会话，不保证该会话的全部上下文都属于本书。初次选择需作者核对；候选提交继续由 Core 按原任务、作品范围和基线校验，不凭 `threadId` 决定归属或授权。

### 5.3 已核对的技术路径

[OpenAI App Server 官方文档](https://developers.openai.com/codex/app-server/)提供认证、会话历史、审批和增量事件接口。SDK 负责通信与执行封装，不负责作品归属判断。所读 TypeScript SDK 封装 CLI 执行与续接；观察既有运行任务应优先评估连接其 App Server，不从 SDK 可启动任务推导其可接管任意现有 GUI／TUI 会话。

| 探索能力 | 对应接口或事件 | 限制 |
| --- | --- | --- |
| 查找会话 | `thread/list`、`thread/loaded/list` | 已加载不等于正在执行；列表属于所连接服务的可见范围 |
| 读取状态与最近回复 | `thread/read`、`thread/turns/list`、`thread/items/list` | 区分未加载、空闲、运行、系统错误及等待审批／输入；历史读取本身不代表恢复执行 |
| 观察后续变化 | `thread/resume` 后接收 `thread/status/changed`、`item/agentMessage/delta`、`turn/completed` 等 | 核对实际版本的订阅、恢复和断线语义；断开连接不能显示为任务已停止 |
| 向运行中的任务补充要求 | `turn/steer`，携带 `expectedTurnId` | 当前轮次须匹配且可接受输入；轮次已结束或不匹配时重新读取状态，由作者决定后续操作 |
| 向空闲会话继续提问 | 必要时 `thread/resume`，再 `turn/start` | 会启动新的工作，必须由作者明确发送；未知结果先查原会话，不盲目重发 |

河图必须连接现有任务所在的 App Server。另起进程、发现相同历史文件或检测到 Codex 正在运行，都不证明已连上原执行实例；GUI／TUI 仅是使用表面，具体连接入口需分别验证。默认只观察作者明确关联的会话，不扫描并展示全部无关聊天。

源码快照中，`codex_tui.read_thread` 包装历史读取，`codex_tui.send_message_to_thread` 经恢复会话后调用 `turn/start`，且以工具结果传递 Agent 委派输入，提示词上限为 1,000 UTF-8 字节。它不等同于作者直接发送的普通用户消息。河图若提供作者发送入口，应使用用户输入协议并保留身份语义，不直接照搬此工具。该版本的 `turn/start` 还可向活动轮次追加输入；针对作者已看到的运行轮次，优先评估带 `expectedTurnId` 的 `turn/steer`，避免状态竞争时悄悄启动另一轮工作。

取证使用 Codex 本地源码快照 `69231e119bfca0b14453515e97d99688ce1c47c9`；所读文件无本地改动，路径和 SHA-256 见[来源清单](sources.json)。主要入口为 Codex 仓库中的 `codex-rs/tui/src/dynamic_tools.rs`、`codex-rs/app-server/src/request_processors/turn_processor.rs`、`codex-rs/app-server-protocol/src/protocol/v2/thread.rs`、`codex-rs/app-server-protocol/src/protocol/v2/turn.rs`、`codex-rs/app-server-daemon/README.md` 和 `sdk/typescript/README.md`。该快照不证明作者已安装版本具有同样能力，也不成为河图的构建依赖。

### 5.4 实施前的准入与验证

- 先确认实际用户场景、支持的 Codex 版本与运行表面，并对照[集成设计](../27-Agent与Codex插件集成设计.md)确认产品边界；批准后再同步需求、交互、接口和验收，不将本预研视为现行功能合同。
- 使用两本演示书和多条会话验证同名、同目录、关联错误、解除关联与切书，保证未关联会话不被自动发送或作为本书成果接收。
- 验证连接的是原执行实例，并覆盖运行、空闲、等待审批／输入、已结束、断线与恢复；仅有历史记录时明确标记实时状态不可用。
- 发送使用明确用户输入；验证轮次竞争、不可追加的执行阶段、审批等待及结果未知恢复。等待审批不能用普通补充消息自动授权；不自动重发、不默认解除宿主沙箱或审批。
- 最近回复仅供观察；正式候选仍经河图既有提交、回读、作者采纳和独立定稿流程。会话状态不替代业务交付状态，发送成功不等于生成完成。

本次仅完成官方文档与源码阅读，未连接现有会话、发送消息、启动生成或进行 GUI／TUI 互操作。没有上述准入与运行证据时，继续保留现有复制任务及候选回读流程。
