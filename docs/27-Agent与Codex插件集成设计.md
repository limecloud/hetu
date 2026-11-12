# Agent 与 Codex 插件集成设计

本章定义 Hetu Core、MCP、AXI、Codex 插件和 MCP Apps 的集成边界。外部规范与来源见[研究资料](research/README.md)。

## 1. 组合架构

| 层 | 采用来源 | 河图中的职责 |
| --- | --- | --- |
| 业务事实与最终授权 | Hetu Core | 设定集、草稿、规则、审核、版本和文件事务 |
| 任务与结果语义 | 本地 AXI 0.2.1 草案 | 有界发现、上下文、CAS、原键恢复与清楚回执 |
| 连接协议 | MCP 官方规范 | 工具、资源、协议版本、传输与错误包装 |
| 方法与连接分发 | OpenAI／Agent Plugins 合同 | 安装 skills、连接定义和按需引导 |
| 人工检查面板 | MCP Apps 与可选 OpenAI 扩展 | 草稿、差异与审核意图的受管 UI |
| 创作能力 | 用户自己的外部 Agent | 理解与生成，不内置于河图 |

AXI 不取代 MCP，Codex 插件不等于浏览器扩展，MCP Apps 不是内容数据库，安装插件也不等于授予文件或 Git 全权限。

## 2. MCP 协议适配

协议基线为 `2026-07-28`。该版 JSON-RPC 采用无状态、每请求版本和能力元数据，移除 `initialize`／`notifications/initialized`；要求 `server/discover`，并改变订阅机制。实现不能沿用旧教程后仍自称符合新版。

首版选择 stdio：逐行 JSON-RPC、stdout 不混入日志，宿主负责启动与关闭 native Server。取消 RPC、宿主退出或视图关闭不证明领域写入未发生；持久操作记录独立于协议生命周期。

工具以 inputSchema／outputSchema 和 structuredContent 表达业务；资源提供固定修订、报告与原操作观察。annotations 只作提示，不能替代内核权限。新版与 legacy 的选择按目标宿主版本验证，不预设所有 Agent 支持所有能力。

C++ Server 的协议依赖必须满足基线版本、双端构建、维护与许可要求；替换 Server 语言或 SDK 须更新 ADR，并重新执行宿主兼容测试。SDK 的发布范围见[协议研究](research/01-MCP官方协议研究.md)。

## 3. Codex 插件设计

可移植包以根 `plugin.json`、`mcp.json`、`skills/` 组织；OpenAI 设置放 `extensions.com.openai`。`.codex-plugin/plugin.json` 为兼容 fallback，内联 OpenAI 对象存在时不与旧 overlay 合并。旧 `.mcp.json` 不能只改名就宣称新包有效。

集成目录：

```text
integrations/codex/hetu/
  plugin.json
  mcp.json
  skills/
    setup/SKILL.md
    blueprint-guided-draft/SKILL.md
    novel-to-drama/SKILL.md
    draft-review/SKILL.md
    bundle-delivery/SKILL.md
  assets/
```

setup 优先使用已知 IP 与原操作；缺 native 组件时说明安装缺口，不静默安装、登录或改全局配置。Skill 只指导调用真实工具与作者审核，不复制动态设定集、凭据或运行状态。

插件可连接已安装的 native `hetu-mcp`，也可在获支持的渠道打包平台组件；两种方式分别验证。不将本机绝对路径硬编码进公开包，不假定安装器会生成可写 IP 工作区。

默认不添加 hooks、浏览器权限或任意 Shell 工具。安装、连接、授权、运行、新会话发现、禁用与卸载分别验收。IDE、CLI、桌面、云端和公共目录资格不能相互推导。

## 4. AXI 采用映射

采用 AXI 0.2.1 的规范与 Schema，复用有界发现、回执和恢复语义。AXI 不承担河图的存储、协议服务或插件运行；其来源与适用边界见[AXI 研究](research/03-AXI采用研究.md)。

| AXI 概念 | Hetu 映射 |
| --- | --- |
| provider／scope | `hetu` 提供方与 workspace ID |
| resource／revision | 文档、草稿、设定集、骨架及不可变修订 |
| catalog／action | CLI capabilities 与 MCP 工具／资源的精确合同投影 |
| effect | read、draft、submit 等，按真实副作用声明 |
| result／page | CLI JSON 与 MCP structuredContent／分页 |
| operation | 原键、规范化输入摘要、ID 与恢复动作 |
| recovery | 重授权后先查原操作，再决定首次执行 |

公开结果采用 AXI 封装时保持核心字段闭合，领域字段放 `data` 或正式命名空间扩展。AXI spec_version、动作 contract_revision、MCP protocol version、内容 schema_version 和 native ABI 分别管理。

基础八工具对应稳定动作：`hetu.blueprints.get`、`hetu.drafts.submit`、`hetu.plot.extract`、`hetu.drama.build_skeleton`、`hetu.validation.run`、`hetu.git.snapshot`、`hetu.bundles.export`、`hetu.workspaces.list`。额外只读观察动作通过 CLI／资源实现；若目标宿主无法以资源观察，再增加窄查询工具并修订目录，不退化成万能 execute。

## 5. 审核 UI 与模型恢复

优先 MCP Apps `_meta.ui.resourceUri`、`ui://` 资源、受管桥接、`ui/initialize` 和输入／结果通知。`ui/initialize` 是 App 桥接握手，与新版 MCP 移除的 Server 初始化不同。

OpenAI 专有模式、文件桥接、会话面板等按功能检测逐项增强，不按品牌或 userAgent 猜能力。App 的选择和 widgetState 不替代业务记录、作者身份或事务。数据只含获权的最小范围。

审核保存、请求后续消息、Agent 实际继续运行是三个步骤。只有用户明确请求且宿主支持时才请求后续消息；Agent 随后回读原草稿和操作，不能凭 UI 文案判断业务完成。

## 6. 集成验收

| 集成面 | 验收范围 |
| --- | --- |
| AXI | 适用要求 ID、Schema、正负例、动作修订与制品摘要 |
| MCP | server/discover、每请求元数据、工具、资源、取消与原操作恢复 |
| legacy MCP 适配 | 独立的协议适配与宿主版本矩阵，不能混用消息语义 |
| Codex 插件 | manifest、native 组件、安装缓存、新会话、禁用与卸载 |
| MCP Apps | CSP、权限、资源版本、降级与可信作者决定 |
| WorkBuddy 等宿主 | 分别验证具体版本的工具、资源、任务与 UI 能力 |

公共目录发布与本地安装分别管理。带本地 stdio MCP 的 Desktop only 插件按 OpenAI 渠道资格和审核要求发布，不能从本机安装结果推导上架资格。

源码构建不依赖相邻 AXI checkout。引入规范时固定版本和 Schema 摘要，按许可保留归属；兼容声明只覆盖验收通过的版本、能力与宿主组合。
