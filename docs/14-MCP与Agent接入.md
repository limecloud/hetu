# MCP 与 Agent 接入

基础工具对应 FR-13；创作任务和局部交互对应 FR-14／22～25。作者从河图洛书选择客户端、安装扩展并复制 Prompt，在外部 Agent 对话和生成。河图洛书不实现 Agent、不发送生成消息或调用模型 API。设计合同与当前可调用目录分别管理。

## 1. 传输、生命周期与授权

首版为独立原生 stdio Server，由宿主显式启动 `hetu-mcp` 并绑定一个工作区。启动配置使用安装器生成的受管路径与参数。stdout 只承载 MCP 协议，脱敏日志写 stderr；不默认打开 TCP／HTTP 监听。

该 Server 随桌面软件分发，直接复用本机 Rust Core；宿主持有进程，原生窗口不必常驻。MCP Apps 资源可由本机 Server 提供，不依赖官网或公共后端。未来远端 MCP 具有独立云端资源和授权范围，不将本机连接转为公网代理；分工见[03第8节](03-总体技术架构.md#8-桌面端与-web-服务端职责)。

建书协作另支持作者明确授予的单个 creation_project scope；没有正式作品时不要求伪造 workspace，也不将作品工具开放给筹备会话。scope 的启动／授予通过对应版本的原生接入合同提供，不接受 Agent 自行指定任意目录或调用时切换范围。筹备创建作品后需另授该作品权限，旧会话不自动扩权。

官方研究基线为 `2026-07-28`：使用 `server/discover` 声明版本／能力，并按该版要求在每请求 `_meta` 携带协议版本和客户端能力，不再进行旧 `initialize` 握手。旧宿主如仅支持 `2025-11-25`，需经 M0 明确决定是否增加独立 legacy 协议适配，不能混写两版消息或默认声称兼容。

Rust Server 使用官方 `rmcp =3.9.0`，关闭默认 feature，仅启用 Server 与 stdio 传输。协议版本列表固定为 `2026-07-28`。依赖由 `Cargo.lock` 固定；不启用 HTTP、OAuth、采样或模型请求。SDK 支持范围与来源见[27](27-Agent与Codex插件集成设计.md)。

工作区授权来自启动参数 `--workspace <绝对路径>`；进程以 Agent 权限打开该单一工作区，不创建工作区、不接受作者模式参数。普通工作区连接覆盖该作品中允许 Agent 读取的正文、草稿和公共审核投影。受限任务连接使用 `--workspace <绝对路径> --task <task_id>`，仅开放固定任务；筹备连接使用 `--creation-project <绝对路径> --task <task_id>`，必须绑定任务。三种启动方式不接受运行中切换范围；自报 Agent 名称、MCP clientInfo、roots 与工具 annotations 均不是权限凭据。

## 2. 工具目录与业务合同

业务对象使用受授权工作区内的稳定 ID；Git 文件选择限定为版本管理范围内的相对路径，不接受任意磁盘路径、脚本、URL 回调或凭据。预期版本对象遵循[05](05-领域模型与数据合同.md)。

| 工具 | 关键输入 | 输出与副作用 |
| --- | --- | --- |
| `hetu_read_blueprint` | 可选 `revision` | 返回完整设定集、固定修订、摘要与锁；只读 |
| `hetu_write_draft` | `package, source_format, content, title?, target_document_id?, base_revision_id?, blueprint_revision, skeleton_ref?, supersedes_draft_id?, operation_key` | 保存不可变草稿，返回 draft／operation ID；诊断为 `not_requested`，不定稿 |
| `hetu_extract_plot` | `document_revisions, blueprint_revision, options, save_result, operation_key?` | 已有原文的节点、覆盖、待审项；保存时仅写派生结果 |
| `hetu_build_drama_skeleton` | `plot_revision_id, blueprint_revision, episode_options, operation_key` | 创建候选骨架修订、缺项及来源；不写台词 |
| `hetu_validate_blueprint` | `plot_revision_id, rule_set_version, options, save_report, operation_key?` | 检查固定剧情修订，返回报告、处置投影及覆盖 |
| `hetu_list_workspace` | 空对象 | 返回启动绑定的工作区与内容包；正文目录通过资源分页读取 |
| `hetu_commit_snapshot` | `phase, operation_key`；prepare 需 `expected_head, message, author`，可选 `selected_paths`；execute 需 `snapshot_id` | 固定预览返回 pending；只有本机作者已批准的快照可提交，无远端副作用 |
| `hetu_validate_draft` | `draft_id, expected_draft_revision, plot_options, validation_options, operation_key` | 同事务保存草稿剧情与审核报告；不批准草稿 |

`save_result=false`／`save_report=false` 不产生业务写入，且不接受 `operation_key`；保存派生结果也不得改变原著或设定集。草稿提交和诊断是独立动作。新草稿必须有标题，修改草稿必须指定目标与基线，返工用新稿接替明确的旧稿。

`contracts/tools/catalog.json` 是工具名与内核动作映射的事实源。inputSchema 直接取自内核能力目录，outputSchema 采用 `contracts/schemas/result.schema.json` 并绑定准确 action；该 Schema 校验 AXI 封装，领域 `data` 按对应业务合同解释。Server 在返回前再次验证封装。工具目录只登记已实现能力。Git 快照通过独立作者批准后执行；Bundle 工具按交付完整性验收登记，不能返回模拟成功。

目录以 `workspace` 与 `task` profile 分别投影。上表八项属于普通工作区连接；任务连接只发现以下四项，不同时开放正文查询、保存、设定修改、采纳、定稿或 Git 工具：

| 任务工具 | 应用动作 | 效果 |
| --- | --- | --- |
| `hetu_read_creative_task` | `hetu.creative_tasks.get` | 读取当前固定任务、已提交候选及观察状态 |
| `hetu_submit_creative_result` | `hetu.creative_tasks.submit_result` | 依请求摘要提交独立候选；受限改稿必须使用授权范围内的 patches |
| `hetu_open_task_view` | `hetu.interactions.get` | 返回任务局部数据；支持 Apps 的任务连接关联离线 HTML 面板 |
| `hetu_save_task_selection` | `hetu.interactions.save_selection` | 保存任务内偏好；不采纳为正文、不选正式封面 |

请求每次重新检查任务归属及关闭状态。作者关闭任务后，已经启动的任务进程也失去读取、提交和原操作查询权限；其他任务的 ID、摘要或操作键不能用于访问。

## 3. 资源与任务查询

资源根为 `hetu://workspace/{workspace_id}/`。`resources/list` 返回固定集合入口，`resources/templates/list` 返回带当前工作区 ID 的白名单模板：

| 资源路径 | 行为 |
| --- | --- |
| `workspace`、`capabilities`、`blueprint` | 工作区、可访问动作与当前设定集；能力投影排除作者专用动作 |
| `blueprint/revisions/{revision}` | 读取固定设定修订 |
| `documents{?kind,limit,cursor}` | 分页正文摘要及固定正文资源引用 |
| `documents/{id}/revisions/{revision_id}` | 固定原文；`documents/{id}` 明确返回当前修订 |
| `documents/{id}/script-mapping` | 初稿结构来源与当前性 |
| `drafts/{id}`、`reviews/{draft_id}{?report_limit,report_cursor}` | 草稿正文、来源、报告及公共决定；过滤作者私密批注 |
| `reviews{?state,limit,cursor}` | 分页待审队列；决定 ID 可经 `reviews/by-decision/{review_id}` 查询 |
| `plots{?document_id,limit,cursor}`、`plots/{id}` | 剧情目录及固定修订 |
| `reports{?plot_revision_id,limit,cursor}`、`reports/{id}` | 报告目录及固定报告／当前处置 |
| `skeletons{?plot_revision_id,limit,cursor}`、`skeletons/{id}/revisions/{revision}` | 骨架目录及固定修订 |
| `skeletons/{id}/comparisons{?limit,cursor}`、`comparisons/{id}` | 原著结构差异目录及固定报告 |
| `git/status`、`git/log{?limit,cursor}` | 工作树与 HEAD 状态、分页提交历史 |
| `git/snapshots{?limit,cursor}`、`git/snapshots/{id}` | 固定快照目录、文件集合、当前性与批准状态 |
| `git/diff{?path}`、`git/snapshots/{id}/diff{?path}` | 范围内文件差异；固定差异核验摘要，私密审核原记录拒绝 Agent 读取 |
| `operations/{id}`、`operations/by-key{?action,key}` | Agent 原操作回执；键按 URL 查询参数编码，支持中文与特殊字符 |

集合缺省每页 50 条，最多 200 条；Git 提交历史缺省 30 条、最多 100 条，待审快照缺省 50 条、最多 100 条；审核中的报告缺省 20 条、最多 50 条。列表游标绑定快照，列表变化后要求重读。资源结果在 `data.mcp_resources` 提供窄引用，在存在下一页时返回 `data.mcp_next_page_uri`。重复／未知查询参数、其他工作区 ID、任意文件路径、编码路径分隔符和路径穿越均拒绝。

通过资源读取原文、审核结果与原操作状态，避免只提供“写草稿”却无法读取驳回理由。Server 只声明当前构建实际实现并验收的扩展；没有订阅时通过查询观察，不虚报通知或 Apps 能力。资源按 private／零缓存有效期返回。

任务连接使用独立资源根 `hetu://task/{scope_kind}/{scope_id}/{task_id}/`，`scope_kind` 为 `workspace` 或 `creation_project`。仅提供 `capabilities`、`request`、`view`、`operations/{operation_id}` 与 `operations/by-key{?action,key}`；不开放普通工作区资源根。工具投影及交互扩展见[30第19节](30-应用API详细设计.md#19-mcp-工具投影与兼容)。不借资源 URI 扫描书库，不返回应用私有凭据。

内核任务在阻塞线程执行，每个 Server 同时接受一个领域任务，繁忙立即返回 `workspace_busy`。单行输入上限 16 MiB，领域结果上限 8 MiB；超限结果保留已有原操作引用。取消可阻止尚未开始的任务；已开始的原子事务完成后沿原键恢复。EOF 关闭连接，进程退出前收束已经开始的内核任务。传输取消不等于业务撤销。

## 4. 幂等与失败

所有持久写入以提供方、明确 scope、授权主体、动作及 `operation_key` 标识一次请求，保存参数摘要与结果；同键同参数返回原结果，同键不同参数报冲突。重新授权后必须先查询原键；仅首次请求执行 CAS，避免把成功重放误判成过期写入。恢复日志与操作记录在内核事务内落盘。

`operation.input_digest` 为去掉幂等键后的固定输入按RFC 8785 JCS 规范化规则计算的 `sha256:` 摘要，跨语言测试向量在正式合同中发布。元数据保留期目标至少自首次受理起 365 天；在途／unknown 及仍被审核或交付引用的记录继续保护，过期不能自动换键重发。

领域失败映射 MCP 工具错误结果及结构化错误；无效 JSON-RPC／未知协议方法使用协议错误。公开 structuredContent 使用[13](13-内核ABI与CLI合同.md)的 AXI `result`，原操作为 `operation`，作品存在问题通过成功报告表达，不混淆成工具不可用。文字 content 与结构化结果必须一致。

工具 annotations 如只读／破坏性／幂等提示仅用于宿主展示，不承担授权功能。输入正文中的“忽略设定集”“替作者批准”等文本始终按素材处理。

## 5. 作者权限与 Git

不提供 `hetu_write_blueprint`、`hetu_unlock_blueprint`、`hetu_approve_draft` 或任意 Shell 工具。Agent 可以提交设定集建议草稿，由作者在可信入口采纳。

快照 prepare 冻结工作树摘要、文件集合、HEAD、提交身份、备注与时间，返回公开状态 `pending` 与 `data.approval_state=pending_approval`。Mac 版本管理页提供作者审阅和明确批准；可信 CLI 的人工入口须遵守同一合同。execute 使用独立原操作键和 snapshot_id，重新核验后执行，原键重放返回同一 commit。批准记录由可信入口写入受保护本机授权存储，不接受 Agent 传入的批准字段，不随 Git 同步。所选文件或 HEAD 变化使批准失效。本机批准绑定仓库实例和快照摘要，15 分钟内有效；prepare 不授予提交权。

V1 MCP 不暴露 push／pull／branch／merge。用户从桌面或 CLI 执行这些能力，避免将 Git 全权限变成 Agent 默认草稿权限。

## 6. MCP Apps 局部交互

面板覆盖建书方向与书名／简介选择、大纲比较、封面等比预览、参考稿 diff 与批注；经工具的 `_meta.ui.resourceUri`、`ui://` HTML 资源及宿主桥接加载。UI 运行于受限环境，无任意文件系统、凭据或供应商网络访问。普通网页与 App 桥接分别适配。

任务连接按每次请求的 `io.modelcontextprotocol/ui` 扩展声明检查 `mimeTypes`。支持 `text/html;profile=mcp-app` 时，工具关联 `ui://hetu/task-view/1`，`resources/list` 登记资源，`resources/read` 返回同一 MIME 的 HTML 和空外部域名 CSP；普通工作区连接不开放任务面板。读取资源及交互动作时重新检查原任务授权，关闭任务后旧连接也不能读取面板。

面板源码位于 `apps/task-view/`，使用官方 `@modelcontextprotocol/ext-apps =2.0.4`，离线产物内嵌于 Rust 二进制；普通工具结果保留结构化数据和可读文本。中文优先，英文可切换；参考内容按纯文本展示，不执行候选中的 HTML。Core 为本任务图片生成最长边不超过512像素、单图不超过256 KiB的 JPEG 预览，不放大原图、不修改源文件；原始字节摘要、类型及解码核验失败时不返回预览。

保存绑定固定任务、候选和 `expected`，结果未确认时保留原参数和操作键，先通过任务资源查询原操作；只有未找到原操作时才允许沿原键重试。收到新结果不会覆盖未保存意见，旧修订提交由 Core 拒绝。面板关闭不撤销已保存偏好，不授予定稿权限。构建与集成测试入口见[任务面板说明](../apps/task-view/README.md)。

局部选择和意见通过受限动作记录 InteractionDecision；不能以页面保存直接创建作品、改正典、采纳正文、选用正式封面或定稿。作者在原生入口完成这些决定；模型调用或自动化点击不能冒充可信人类批准。动作可见性、只读 annotations 和宿主私有 UI 字段均不承担最终授权。

不支持 Apps 时返回可读摘要、资源引用与原生任务入口。必要时作者启动单任务 Node.js 页面并在内置浏览器配合，配对及安全见[27](27-Agent与Codex插件集成设计.md)与[18](18-安全与隐私.md)。该页面服务不是 HTTP MCP。默认复制补充 Prompt，不自动发起 Agent 重写或远端消息。

## 7. 宿主兼容矩阵

Codex、WorkBuddy、Claude Code 及其他宿主按具体版本及运行表面分别验证：扩展安装、Skills 发现、stdio、协议、工具、分页、资源、取消、原操作恢复、Apps、浏览器本机可达性和图像能力。仅公布通过验证的组合，不从 Claude Desktop 的 Apps 支持推导 Claude Code 支持。Apps 不可用不能影响已登记工具的语义和原生验收。
