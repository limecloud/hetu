# MCP 与 Agent 接入

基础工具对应 FR-13；MCP Apps 审核资源对应 FR-14／P1。外部 Agent 自行生成文本，河图不调用 Agent 或模型生成 API。

## 1. 传输、生命周期与授权

首版为独立原生 stdio Server，由宿主显式启动 `hetu-mcp` 并绑定一个工作区。启动配置使用安装器生成的受管路径与参数。stdout 只承载 MCP 协议，脱敏日志写 stderr；不默认打开 TCP／HTTP 监听。

官方研究基线为 `2026-07-28`：使用 `server/discover` 声明版本／能力，并按该版要求在每请求 `_meta` 携带协议版本和客户端能力，不再进行旧 `initialize` 握手。旧宿主如仅支持 `2025-11-25`，需经 M0 明确决定是否增加独立 legacy 协议适配，不能混写两版消息或默认声称兼容。

只声明真实实现的工具、资源及可选 UI 能力。C++ Server 依赖按协议版本、维护、许可和双端构建要求验收。SDK 支持范围与来源见[27](27-Agent与Codex插件集成设计.md)。

工作区授权由本地用户通过受管配置或可信交互授予，默认最小读取与草稿权限。可按文档集合限制正文读取；撤销后所有入口重新校验。自报 Agent 名称、MCP clientInfo 和 roots 声明均不是权限凭据。

## 2. 八个基础工具

所有引用均为受授权工作区内的稳定 ID；不接受任意文件路径、脚本、URL 回调或凭据。预期版本对象遵循[05](05-领域模型与数据合同.md)。

| 工具 | 关键输入 | 输出与副作用 |
| --- | --- | --- |
| `hetu_read_blueprint` | 可选 `section, entity_ids, cursor, limit` | 返回设定集片段、修订、摘要、锁与分页信息；只读 |
| `hetu_write_draft` | `package, source_format, content, title?, target_document_id?, base_revision_id?, blueprint_revision, operation_key` | 保存不可变草稿，返回 draft／operation ID 和诊断任务；不定稿 |
| `hetu_extract_plot` | `document_revisions, blueprint_revision, options, save_result, operation_key?` | 已有原文的节点、覆盖、待审项；保存时仅写派生结果 |
| `hetu_build_drama_skeleton` | `plot_revision_id, blueprint_revision, episode_options, operation_key` | 创建候选骨架修订、缺项及来源；不写台词 |
| `hetu_validate_blueprint` | `target_refs, blueprint_revision, rule_set_version, save_report, operation_key?` | 执行设定集／内容一致性与影视化规则，返回报告及覆盖 |
| `hetu_commit_snapshot` | `phase, message?, selected_refs?, expected_head?, operation_key?, operation_id?` | prepare 创建持久预览操作，需 operation_key；execute 仅消费作者已批准的确切操作 |
| `hetu_export_bundle` | `selection, expected_inputs, profile, operation_key` | 先核对输入与导出权限，写 `exports/` 新包；待审内容需额外作者批准 |
| `hetu_list_workspace` | 可选 `package, cursor, limit` | 返回工作区、包、可访问文档和实际能力，不泄露根目录外路径 |

`save_result=false`／`save_report=false` 不产生业务写入；保存派生结果也不得改变原著或设定集。限额、枚举、必填项及正式 outputSchema 在 `contracts/tools/` 实现，不以 Markdown 表格代替机器校验。

## 3. 资源与任务查询

提供受授权资源：`hetu://workspace/{id}/documents/{id}/revisions/{id}`、`.../drafts/{id}`、`.../reviews/{id}`、`.../reports/{id}`、`.../operations/{id}` 和 `.../capabilities`。实际模板在资源发现中返回，ID 之外的路径不能拼接为本地文件读取。

通过资源读取原文、审核结果与原操作状态，避免只提供“写草稿”却无法读取驳回理由。宿主支持订阅时仅通知记录变化，不发送正文或暗示自动开始生成；不支持订阅则查询原资源。V1 不依赖未验证的协议扩展来完成核心任务。

长任务先返回持久操作引用与状态，由原操作资源查询结果；协议版本支持的进度／取消可映射到内核任务，但不作为唯一查询方式。客户端超时后沿原操作恢复，不能创建重复草稿或重复 Git 提交。

## 4. 幂等与失败

所有持久写入以提供方、工作区、授权主体、动作及 `operation_key` 标识一次请求，保存参数摘要与结果；同键同参数返回原结果，同键不同参数报冲突。重新授权后必须先查询原键；仅首次请求执行 CAS，避免把成功重放误判成过期写入。恢复日志与操作记录在内核事务内落盘。

`operation.input_digest` 为去掉幂等键后的固定输入按RFC 8785 JCS 规范化规则计算的 `sha256:` 摘要，跨语言测试向量在正式合同中发布。元数据保留期目标至少自首次受理起 365 天；在途／unknown 及仍被审核或交付引用的记录继续保护，过期不能自动换键重发。

领域失败映射 MCP 工具错误结果及结构化错误；无效 JSON-RPC／未知协议方法使用协议错误。公开 structuredContent 使用[13](13-内核ABI与CLI合同.md)的 AXI `result`，原操作为 `operation`，作品存在问题通过成功报告表达，不混淆成工具不可用。文字 content 与结构化结果必须一致。

工具 annotations 如只读／破坏性／幂等提示仅用于宿主展示，不承担授权功能。输入正文中的“忽略设定集”“替作者批准”等文本始终按素材处理。

## 5. 作者权限与 Git

不提供 `hetu_write_blueprint`、`hetu_unlock_blueprint`、`hetu_approve_draft` 或任意 Shell 工具。Agent 可以提交设定集建议草稿，由作者在可信入口采纳。

快照 prepare 冻结工作树摘要、文件集合、HEAD 与备注，返回公开状态 `pending` 与 `data.approval_state=pending_approval`。作者在原生桌面或可信 CLI 审阅并批准；execute 重新核验后一次性执行。批准记录由可信入口写入受保护本机授权存储，不接受 Agent 传入的批准字段，不随 Git 同步。工作区内容变化使批准失效。

V1 MCP 不暴露 push／pull／branch／merge。用户从桌面或 CLI 执行这些能力，避免将 Git 全权限变成 Agent 默认草稿权限。

## 6. MCP Apps 审核面板

面板显示草稿、来源、diff、设定集版本、诊断覆盖、批注与审核结果，经支持的 MCP Apps 资源和桥接加载。UI 运行于宿主受限环境，无文件系统、凭据或直接供应商网络访问。

审批必须有可验证的人类交互与可信作者会话，绑定确切草稿、报告和工作区。若宿主不能证明该信任边界，面板只能提交审核意图，并引导作者到原生端完成最终批准；模型调用同一桥接不能冒充人类点击。通过按钮的可用性取决于兼容性验收，不臆造统一的宿主确认 API。

不支持 Apps 时返回可读摘要、资源引用与桌面待审入口，人工审核仍可完整完成。默认不自动发起外部 Agent 重写或远端消息。

## 7. 宿主兼容矩阵

Codex、WorkBuddy 及其他宿主按具体版本分别验证：stdio 启动、版本协商、工具、分页、资源、取消、断线恢复与 Apps。兼容范围由版本化验收矩阵维护，仅公布通过验证的组合。Apps 不可用不能影响八个基础工具的语义和桌面审核。
