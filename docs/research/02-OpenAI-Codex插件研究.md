# OpenAI Codex 插件研究

资料版本日期：2026-11-16；使用 OpenAI Docs 官方资料。原 Codex 页面发生跳转时，以最终取得正文为依据。

## 官方来源

| 来源 | 结论 |
| --- | --- |
| [使用插件](https://learn.chatgpt.com/docs/plugins) | 插件可包含 skills、MCP、浏览器能力或 hooks；安装后新会话发现；运行表面有区别 |
| [MCP 接入](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | Codex host 支持 stdio 与 Streamable HTTP；连接配置和实际授权分别管理 |
| [插件构建](https://developers.openai.com/plugins/build/plugins.md) | 根 plugin.json、mcp.json、skills；OpenAI 扩展与兼容 overlay；分发渠道和 hooks 限制 |
| [插件 UI](https://developers.openai.com/plugins/build/chatgpt-ui.md) | 优先 MCP Apps 标准字段，OpenAI 扩展需功能检测；UI 资源 MIME 为 text/html;profile=mcp-app |
| [Desktop only 发布](https://developers.openai.com/plugins/deploy/desktop-only.md) | 本地执行插件的渠道要求；本地 MCP 提交受合作伙伴资格限制 |
| [构建 Skills](https://learn.chatgpt.com/docs/build-skills) | 可复用方法与宿主工具能力分开，具体 workflow 仍需服务端校验 |

## 对河图洛书的采用

Codex接入包负责“交接任务引用 → 打开获权任务 → 按需读取固定上下文 → 在Codex讨论与创作 → 连续保存参考稿 → 提交候选 → 作者反馈后接续”的专用方法。本文2026-11-16的取证以外部客户端接入为范围；2026-11-19采纳的双入口允许河图桌面托管所选引擎会话，当前采用边界以[27第1.1节](../27-Agent与Codex插件集成设计.md#11-双入口协作)和[39第4.3节](../39-Electron与插件优先重构架构.md#43-agent-会话宿主)为准。Core不自建推理，创作指令由作者明确发送；宿主消息能力、参考稿采纳和独立定稿分别核验。

插件与河图洛书软件、MCP 协议、AXI 合同及 UI 资源分别版本化，安装缓存中的实际制品才是运行依据。开发目录修改不证明已安装插件或旧会话已更新。

官方可移植插件清单与某些 Codex 直接配置仍可能使用不同连接文件字段；河图洛书将它们视为不同适配目标，不复制 `.mcp.json` 示例冒充根 `mcp.json` 的正式结构。

默认不打包 hooks，不要求任意浏览器／Computer Use 权限。用于本机文件的插件能否进入公共目录还受 Desktop only 资格、渠道和审核约束，本地安装成功不能推导出可以公开上架。

## 本机 CLI 的兼容清单核对

2026-11-16 重新核对[插件构建正文](https://developers.openai.com/plugins/build/plugins.md)：官方推荐根 `plugin.json` 的可移植格式，同时保留 `.codex-plugin/plugin.json` 兼容布局；生成器仍可生成兼容清单。可移植包默认从根 `skills/` 发现方法，兼容清单可用 `skills: "./skills/"` 明确路径。若根清单具有 `extensions.com.openai`，该字段取代兼容 overlay，而非与其合并。

本机 `codex-cli 0.142.4` 的隔离安装实测：仅提供根清单时，CLI 补写不含版本的兼容清单，`plugin list --json` 返回 `local`，且缓存文件与原包不一致。由同一生成源提供名称、版本、说明一致的兼容清单后，官方回读保留确切版本，完整缓存与来源逐文件摘要一致。河图据此同时分发两种入口并检查身份一致性，不放宽安装后的版本与整包核验；此结果不表示所有 Codex 版本都要求兼容清单，也不证明当前宿主会话重新加载了插件。

官方 Plugins 正文区分 Codex 桌面、CLI 和 IDE 表面；桌面插件入口与 CLI 的 `/plugins` 不能推导为 IDE 也支持同一插件安装。安装后需在新会话核对实际 Skills 和工具；本地文件连接不能自动用于无法访问用户设备的云端执行环境。局部 UI 和浏览器能力独立检测，详见[跨宿主研究](07-外部Agent与局部交互研究.md)。

## 验证计划

固定宿主版本与插件摘要，核验 manifest、native 二进制、授权目录、stdio、八工具、只读恢复、新会话与卸载。Apps 按桥接能力协商测试，无支持时原生审核继续。公共目录发布须独立满足渠道资格与审核，本机安装不构成上架资格。

## 持续协作的官方依据与产品选择

| 核对内容 | 官方依据 | 河图洛书的设计选择 |
| --- | --- | --- |
| MCP 配置 | Codex MCP 正文说明共享 `config.toml`，支持用户级与受信项目级配置 | 稳定本机入口一次接入；通用 `mcpServers` JSON、可移植插件的 `mcp.json` 与 Codex 手工配置分别适配，不靠改文件名互换 |
| 会话加载 | Plugins 正文要求安装后新会话；IDE 不支持同样的插件安装，但可使用独立 Skills 与 MCP | 包文件、启用配置、当前会话发现和任务实际调用分开取证；不把缓存版本视为已加载版本 |
| 工作指引 | MCP 正文建议 server instructions 前512字符自包含，表达跨工具流程与约束 | 入口先讲精确任务、已有成果、按需上下文、保存、提交及反馈恢复，再引用详细合同 |
| 方法加载 | Build skills 正文采用渐进披露，发现元数据后按需加载正文及引用 | 按原创小说、原创剧本、改编、资料素材组织入口，共用小型方法；模型资料按需读取，不重复安装多套相同工作流 |
| 本机执行 | MCP 正文支持通过命令启动 stdio，插件可分发方法和连接 | 本机助手由河图提供，连接与任务授权分离；不要求云服务、桌面常驻或在插件内复制业务服务 |

稳定 task_id、请求修订、工作副本 CAS、公开反馈与精确授权是河图洛书的业务设计，不能写成 Codex 或 MCP 自带的小说管理能力。规范可行不代表当前包已经携带连接声明，更不代表本机新会话已能调用；真实接入与创作旅程按[19第3.3节](../19-测试策略与验收矩阵.md#33-真实-agent-协作验收)验证。
