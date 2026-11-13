# OpenAI Codex 插件研究

资料版本日期：2026-11-13；使用 OpenAI Docs 官方资料。原 Codex 页面发生跳转时，以最终取得正文为依据。

## 官方来源

| 来源 | 结论 |
| --- | --- |
| [使用插件](https://learn.chatgpt.com/docs/plugins) | 插件可包含 skills、MCP、浏览器能力或 hooks；安装后新会话发现；运行表面有区别 |
| [MCP 接入](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | Codex host 支持 stdio 与 Streamable HTTP；连接配置和实际授权分别管理 |
| [插件构建](https://developers.openai.com/plugins/build/plugins.md) | 根 plugin.json、mcp.json、skills；OpenAI 扩展与兼容 overlay；分发渠道和 hooks 限制 |
| [插件 UI](https://developers.openai.com/plugins/build/chatgpt-ui.md) | 优先 MCP Apps 标准字段，OpenAI 扩展需功能检测；UI 资源 MIME 为 text/html;profile=mcp-app |
| [Desktop only 发布](https://developers.openai.com/plugins/deploy/desktop-only.md) | 本地执行插件的渠道要求；本地 MCP 提交受合作伙伴资格限制 |
| [构建 Skills](https://learn.chatgpt.com/docs/build-skills) | 可复用方法与宿主工具能力分开，具体 workflow 仍需服务端校验 |

## 对河图的采用

Codex 接入包负责“从河图复制任务 → 读取单项筹备或作品上下文 → 在 Codex 对话与生成 → 提交候选 → 局部交互与原操作回读”的专用方法。河图提供软件入口及对应安装引导，不内置 Codex、模型或 Agent Runtime，不自动发送提示词。参考稿采纳和独立定稿由作者分别决定。

插件与河图软件、MCP 协议、AXI 合同及 UI 资源分别版本化，安装缓存中的实际制品才是运行依据。开发目录修改不证明已安装插件或旧会话已更新。

官方可移植插件清单与某些 Codex 直接配置仍可能使用不同连接文件字段；河图将它们视为不同适配目标，不复制 `.mcp.json` 示例冒充根 `mcp.json` 的正式结构。

默认不打包 hooks，不要求任意浏览器／Computer Use 权限。用于本机文件的插件能否进入公共目录还受 Desktop only 资格、渠道和审核约束，本地安装成功不能推导出可以公开上架。

官方 Plugins 正文区分 Codex 桌面、CLI 和 IDE 表面；桌面插件入口与 CLI 的 `/plugins` 不能推导为 IDE 也支持同一插件安装。安装后需在新会话核对实际 Skills 和工具；本地文件连接不能自动用于无法访问用户设备的云端执行环境。局部 UI 和浏览器能力独立检测，详见[跨宿主研究](07-外部Agent与局部交互研究.md)。

## 验证计划

固定宿主版本与插件摘要，核验 manifest、native 二进制、授权目录、stdio、八工具、只读恢复、新会话与卸载。Apps 按桥接能力协商测试，无支持时原生审核继续。公共目录发布须独立满足渠道资格与审核，本机安装不构成上架资格。
