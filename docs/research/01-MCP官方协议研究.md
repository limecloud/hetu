# MCP 官网协议研究

资料版本日期：2026-11-13。入口为[官网 llms.txt](https://modelcontextprotocol.io/llms.txt)，定位后读取所列正文。协议基线 `2026-07-28`；来源摘要见 [sources.json](sources.json)。

## 规范来源

| 来源 | 核对事实 |
| --- | --- |
| [规范首页](https://modelcontextprotocol.io/specification/2026-07-28/index.md) | Host、Client、Server；JSON-RPC 与每请求能力 |
| [变更记录](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md) | 与2025-11-25相比移除初始化、引入 server/discover、订阅及会话变化 |
| [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md) | 逐行 JSON-RPC、stdout 纯净、取消、关闭及 legacy 探测 |
| [工具](https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md) | Schema、结构化结果、人类可拒绝与错误层次 |
| [资源](https://modelcontextprotocol.io/specification/2026-07-28/server/resources.md) | 应用驱动的上下文读取与资源引用 |
| [发现](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md) | 必需 server/discover、版本列表、private 缓存与每请求元数据 |
| [SDK 索引](https://modelcontextprotocol.io/docs/2026-07-28/sdk.md) | Rust Tier 1、Swift Tier 3；各 SDK 规范采用时间需逐版本核对 |
| [授权](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index.md) | HTTP 授权框架与 stdio 本机授权分开 |
| [版本协商](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md) | 每请求版本、modern／legacy 识别与降级规则 |
| [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview.md) | UI 资源、受限渲染、桥接、工具与上下文更新 |

## 采纳结论

1. 采用标准 MCP 承载 Hetu 八工具，业务权限、文件 CAS 与原操作持久化由 Core 实现。
2. V1 先做本机 stdio，不以 HTTP／OAuth 作为作者离线工作区前置条件。
3. 新版协议元数据包含 `io.modelcontextprotocol/protocolVersion` 与 `io.modelcontextprotocol/clientCapabilities`；不能混用旧 initialize 示例。
4. Apps 的 `_meta.ui.resourceUri` 关联 `ui://` 资源，宿主控制沙箱与桥接；资源可预载，业务输入／结果是另外的更新。
5. Server 进程与协议请求可中断，业务状态和 unknown 必须独立恢复。传输重试的新 JSON-RPC request ID 不得变成新的领域幂等键。
6. Rust 官方 SDK 已列为 Tier 1；SDK 的存在不等于覆盖目标协议版本、宿主与平台。河图洛书仍需固定 crate、核对协议差距并完成宿主互操作，Swift CLI 的 Windows 分发另行验收。

## 符合性边界

实现固定官方 Rust SDK `rmcp 3.9.0`（2026-11-05 发布，MSRV 1.88，Apache-2.0），匹配工程 Rust 1.93.1。关闭默认 feature，仅启用 `server`、`transport-io`；SDK 自带的历史版本不会自动进入河图洛书的支持列表。依赖版本与供应链摘要由 `Cargo.lock` 固定。

协议测试采用[官方 Schema 固定修订](https://github.com/modelcontextprotocol/specification/blob/38353251fab3bdeead03dd8283b9e66076ce1a7f/schema/2026-07-28/schema.json)，文件保存于 `tests/mcp/schema-2026-07-28.json`，原始许可随附。真实 stdio 子进程响应同时经 SDK 类型和 Schema 校验，包含 discover、工具、资源和协议错误；不能据此推导所有宿主兼容。

协议研究说明规范要求；符合性由固定 Server、SDK 与宿主版本的互操作测试证明。Apps 人类审批、业务授权与签名分发分别验收，不能从 SDK 列名推导全部平台或协议能力。

stdio 不套用 HTTP OAuth 流程；本机工作区范围与作者批准仍由河图洛书管理。启用 HTTP 传输时必须另行满足官方授权、安全与版本合同，不能把监听本地端口视为已授权。
