# MCP 与 Agent 接入

MCP 与 CLI 承担全软件的主要业务执行，Skills 提供方法；桌面端首先供作者review、审核和决定，其次供手动编辑。能力范围包括筹备、新建、作品结构、资料、创作候选、检查、版本与交付准备，不能只允许“读一个已由 GUI 创建的任务”。每页交接规则见[10第2.1节](10-原生客户端与交互设计.md#21-每页的-ai-操作入口)，用例及权限见[30第25节](30-应用API详细设计.md#25-全软件联动与操作提案合同)。普通业务不依赖 Computer Use。

基础工具对应 FR-13；创作任务和局部交互对应 FR-14／22～25／31～34。作者从河图洛书选择客户端、安装扩展并复制 Prompt，在外部 Agent 对话和生成。河图洛书不实现 Agent；可选模型工具使用作者配置的自定义渠道或经 website 服务端接入 Cloud，内容与费用由作者逐计划批准；显式反馈可经有能力的宿主请求继续当前对话。设计合同与当前可调用目录分别管理。

## 1. 传输、生命周期与授权

采用独立原生 stdio Server，由宿主显式启动 `hetu-mcp` 的稳定本机入口。启动配置使用安装器生成的受管路径与经过验收的参数，客户端配置一次；任务调用显式给 `task_ref`，有限新建管理调用显式给 `management_ref`。新书和返工不要求重新配置 MCP。stdout 只承载 MCP 协议，脱敏日志写 stderr；不默认打开 TCP／HTTP 监听。

该 Server 随桌面软件分发，直接复用本机 Rust Core；宿主持有进程，原生窗口不必常驻。MCP Apps 资源可由本机 Server 提供，不依赖官网或公共后端。未来远端 MCP 具有独立云端资源和授权范围，不将本机连接转为公网代理；分工见[03第8节](03-总体技术架构.md#8-桌面端与-web-服务端职责)。

平台模型连接缺失或过期时，Agent 可运行 `hetu model-service status`，需要登录时运行 `hetu model-service login`，在当前对话提供返回的验证链接和验证码。作者在浏览器核验并完成连接后，以 `hetu model-service poll` 查询原连接并继续原任务；已完成的 poll 本地回读，不再创建登录。自定义渠道仍由作者在本机设置，不向 Agent 提供密钥；登录不代替内容与费用授权。

建书协作支持独立 creation_project scope；没有正式作品时不要求伪造 workspace，也不将作品工具开放给筹备会话。本机私有授权将精确任务或管理引用映射到批准范围，不接受 Agent 自行指定任意目录或未批准任务。无任务时可以开始隔离筹备，有限新建只允许返回的全新受管目录；创建成功返回独立的作品管理引用，准备任务再派生同客户端 TaskGrant。旧任务不自动扩权，也不返回其他书库或作品内容。

官方研究基线为 `2026-07-28`：使用 `server/discover` 声明版本／能力，并按该版要求在每请求 `_meta` 携带协议版本和客户端能力。当前 Codex stdio 使用的 `2025-06-18` 通过官方 SDK 独立的 `initialize` → `notifications/initialized` 生命周期接入，无需新版请求元数据；响应按协商版本编码，不混写两版消息。其他协议版本不声明兼容。

Rust Server 使用官方 `rmcp =3.9.0`，关闭默认 feature，启用 Server、stdio 传输与 elicitation。稳定入口和绑定作品入口均声明 `2026-07-28`、`2025-06-18`。依赖由 `Cargo.lock` 固定；MCP 传输不启用 HTTP、OAuth 或采样；任务内模型工具通过 Core 调用河图网站或作者配置的 HTTPS 模型渠道，不暴露 Cloud 或供应商凭据。SDK 支持范围与来源见[27](27-Agent与Codex插件集成设计.md)。

稳定入口的客户端适配与任务授权分开；每请求在 Core 校验本机授权、任务、请求版本、动作和预算。`client_adapter` 区分接入配置与授权登记，不是密码，也不能证明请求来自某一品牌的真实进程；同一系统用户的隔离边界见[18](18-安全与隐私.md#1-信任边界)。交接引用不是秘密，不以全局 activeTask 切换权限。现有单工作区／单任务隔离 profile 的参数和能力由构建自身公布，不能用它替代稳定接入验收或要求作者反复贴配置。自报 Agent 名称、MCP clientInfo、roots 与工具 annotations 均不是权限凭据。MCP 的筹备、新建与管理用例使用明确范围授权，不接受通用作者模式参数。当前实现与准入顺序见[20](20-实施路线与里程碑.md#7-全软件-agent-联动的实施准入)。

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

稳定 profile 的从零入口为 `hetu_begin_creation`，后续使用能力目录实际返回的筹备保存、创建小说／剧本、空章节／分集和任务准备工具。管理工具只接受新建范围的 `management_ref`；旧工作区及单任务 profile 不因此开放作者动作。空章节创建拒绝非空正文，实际起草继续使用参考稿工具；目录选择必须等于本次预留的 `target_path`。外部任意目录需要另外的精确授权，不能用路径或自报批准替代。

模型费用授权在 Agent 对话完成。`hetu_authorize_model_usage` / `hetu.model_tasks.authorize_usage` 根据作者在当前对话中的实际授权登记固定任务、渠道集合及请求数／Credits 上限；明确完全授权使用 `unrestricted: true`。登记记录 Agent 来源与授权说明，不冒充原生作者签名。额度内连续生成，Core 将预留与提交意图原子落盘，重放不重复预留或发送。达到上限才在当前对话追加确认；新授权键不重发已提交计划。作品、任务、类型、账号和渠道身份继续约束授权，软件不是费用批准的必经入口。

稳定 profile 在 `2025-06-18` 宿主声明 form elicitation（包含该版本的空 `elicitation: {}`）时另外公布 `hetu_request_model_confirmation`，辅助当前对话中缺失的单次／任务额度确认。仅真实用户 `accept` 且 `confirm: true` 时保存；取消、拒绝、300 秒超时不批准，不持有入口或作品写锁，不执行生成。Agent 不得代答用户。充分授权时直接登记使用范围，避免重复询问。

余额不足使用独立错误 `hetu.credits_insufficient`，Agent 在当前对话提示充值。充值后先查询原计划；明确未扣费余额失败可通过 prepare 的 `resume_from_plan_id` 建立唯一关联恢复计划，复用原任务授权，原记录返回 `replacement_plan_id`。未扣费失败释放授权预留，响应未知仍保留预留且只查询。充值不修改对话授权额度，也不能证明原未知请求未执行。

基础目录以 `workspace` 与 `task` profile 分别投影。上表八项属于明确授予的单作品高级范围，不是稳定接入后的默认权限。以下四项为基础任务工具；持续协作按第9节扩展，不同时开放通用正文保存、设定修改、采纳、定稿或 Git 工具：

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

单任务隔离 profile 使用资源根 `hetu://task/{scope_kind}/{scope_id}/{task_id}/`，`scope_kind` 为 `workspace` 或 `creation_project`。基础资源提供 `capabilities`、`request`、`view`、`operations/{operation_id}` 与 `operations/by-key{?action,key}`，不开放普通工作区资源根。稳定 profile 不据此枚举任务资源：获权任务通过显式引用打开，原操作通过 `hetu_read_task_operation` 查询；上下文、工作副本及反馈沿该任务实际返回的窄工具或资源引用读取。未登记的 URI 不因符合路径格式而获得读取权。

历史内容使用确切修订与摘要，不静默跳到 head。工具投影及交互扩展见[30第19节](30-应用API详细设计.md#19-mcp-工具投影与兼容)与[第23节](30-应用API详细设计.md#23-持续协作与任务接续合同)。不借资源 URI 扫描书库，不返回应用私有凭据。

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

任务连接按每次请求的 `io.modelcontextprotocol/ui` 扩展声明检查 `mimeTypes`。支持 `text/html;profile=mcp-app` 时，工具关联 `ui://hetu/task-view/1`，`resources/list` 登记资源，`resources/read` 返回同一 MIME 的 HTML 和空外部域名 CSP；普通工作区连接不开放任务面板。稳定 profile 可在未打开任务时提供不含作品数据的静态面板代码；代码可读不代表任务可读。任务数据、预览及交互动作始终重新核验授权；关闭或撤权后，旧面板不能继续获取数据或保存，已显示内容须清理。

面板源码位于 `apps/task-view/`，使用官方 `@modelcontextprotocol/ext-apps =2.0.4`，离线产物内嵌于 Rust 二进制；普通工具结果保留结构化数据和可读文本。中文优先，英文可切换；参考内容按纯文本展示，不执行候选中的 HTML。Core 为本任务图片生成最长边不超过512像素、单图不超过256 KiB的 JPEG 预览，不放大原图、不修改源文件；原始字节摘要、类型及解码核验失败时不返回预览。

保存绑定完整 task_ref、固定候选和 `expected`；嵌套成果引用保留同一请求摘要，不能由面板重建为只含任务 ID 的引用。结果未确认时保留原参数和操作键：稳定 profile 通过 `hetu_read_task_operation`，单任务隔离 profile 通过其已公布资源查询原操作。只有明确未找到原操作时才允许沿原键重试，查询失败或未知不等于未保存。收到新结果不会覆盖未保存意见，旧修订提交由 Core 拒绝。面板关闭不撤销已保存偏好，不授予定稿权限。构建与集成测试入口见[任务面板说明](../apps/task-view/README.md)。

局部选择和意见通过受限动作记录 InteractionDecision；页面保存不自动成为创建作品、改正典、采纳正文、选用正式封面或定稿的执行授权。Agent 可以把选择整理为完整操作提案，Core 按具体用例判断是否需要作者确认；实际通过可信通道确认后，机器继续执行，不要求作者重填资料。未具备该确认合同的 Apps 只定位原生审阅页。模型调用或自动化点击不能冒充可信人类批准。动作可见性、只读 annotations 和宿主私有 UI 字段均不承担最终授权。

不支持 Apps 时返回可读摘要、资源引用与原生任务入口。必要时作者启动单任务 Node.js 页面并在系统浏览器或可达本机的外部客户端中配合，配对及安全见[27](27-Agent与Codex插件集成设计.md)与[18](18-安全与隐私.md)。该页面服务不是 HTTP MCP。“按此修改”先保存公开反馈，再按宿主真实消息能力请求继续当前对话；普通网页或无能力的宿主提供复制继续提示词。保存、消息受理和后续成果分别显示，不自动循环生成。

## 7. 宿主兼容矩阵

Codex、WorkBuddy、Claude Code 及其他宿主按具体版本及运行表面分别验证：扩展安装、Skills 发现、stdio、协议、工具、分页、资源、取消、原操作恢复、Apps、浏览器本机可达性和图像能力。仅公布通过验证的组合，不从 Claude Desktop 的 Apps 支持推导 Claude Code 支持。Apps 不可用不能影响已登记工具的语义和原生验收。


## 8. 资料与短剧的一等 Agent 入口

工作区读取与协作候选维护属于核心协作能力，不把原生 GUI 自动化作为 Agent 操作前提。项目、分集、资料、设计、候选、使用位置及模型档案的新增动作按[30第20～21节](30-应用API详细设计.md#20-短剧项目与语义编辑合同)发布；能力目录仅投影当前已实现并经权限测试的动作。

窄发现 → 摘要与分页 → 固定引用读取 → 获权候选 CAS 更新或提交 → 原键回读构成基础路径。已有任务直接继续，不重新挑作品或创建任务；任务连接的范围可以包含明确获权的资料与制作对象，但不能据此开放所有正文保存或作者动作。历史任务四项工具投影不能自动授予新动作，新范围与合同须显式发布。

媒体通过固定 inbox 与受管预览交接，MCP 不以大段 base64 传整组原图或完整视频。Apps 显示当前任务的图文比较、版本选择偏好与返工意见；正式资料采用、素材选用和定稿始终由可信作者入口确认。不支持 Apps 时使用相同任务的数据与原生回退，无需公网服务器。

## 9. 稳定任务入口与持续工作

稳定入口提供不含内容的接入检查和获权任务 open，再以显式 task_ref 调用窄能力：目录／摘要／检索／原文片段、工作副本保存与提交、公开反馈及缺材料请求。精确动作和输入输出由[30第23节](30-应用API详细设计.md#23-持续协作与任务接续合同)拥有，MCP 工具和 CLI 均从同一动作合同投影，不另造一份状态机。新增动作进入实际目录前，必须同步 Schema、输出预算、Skill 方法及越权负例。

| 稳定入口工具 | 应用动作 | 调用边界 |
| --- | --- | --- |
| `hetu_inspect_collaboration` | `hetu.collaboration.inspect` | 只检查助手、合同和能力；不发现书库或自动建立授权 |
| `hetu_begin_creation` | `hetu.creation_projects.create` | 无作品或任务时建立独立筹备；只预留全新受管目录，保留返回的管理引用及目标路径 |
| `hetu_open_collaboration_task` | `hetu.collaboration.open` | 以作者交接的 TaskLocator 打开已获权任务，取得确切 TaskRef；不创建任务或扩大范围 |
| `hetu_read_task_operation` | `hetu.operations.get` | 携带完整 TaskRef 查询本任务的原操作；撤权和关闭先于历史回执读取 |

这些工具只在构建实际登记的 profile 中调用。`inspect` 声明支持某项动作，不等于当前任务获准执行；`open` 返回的允许动作还须与该任务范围取交集，每次业务请求重新检查。工具存在、任务可读、成果可保存和作者已验收是分别可核验的事实。

任务 get 返回目标、已确定事实引用、已有成果及反馈摘要，不一次内联全部上下文。正文读取固定修订，检索只在已批准集合内执行；缺材料由作者决定是否补充。参考稿连续保存使用工作副本 CAS，正式提交固定不可变候选；修改作者正文仍只能交合法补丁供作者采纳。

Server instructions 的开头先说明“用精确任务引用打开 → 读取目标／已有成果 → 按需上下文 → 保存工作副本 → 提交并回读 → 等待或接续公开反馈”，保持前512字符可独立理解，细节通过能力及资源按需读取。提示文字不取代 Core 授权。真实 Codex 新会话的工具发现、任务读写、反馈接续和恢复是独立验收面，插件文件存在或协议驱动通过不算完成。

## 10. 视频制作与局部观看

MCP与CLI对等提供[30第26节](30-应用API详细设计.md#26-独立创作对象与视频用例合同)用例，工具名及Schema以实际发现为准。连接不固定全局小说，小说／剧本／视频逐请求定位并核验对象与任务授权，来源链接不能扩权。正常筹备、整理、预演、生成和返工无需GUI自动化。

Apps可对当前获权固定媒体展示局部播放、区间／画面位置意见及版本比较；大视图按需用同任务本地页面，缺能力回原生端或复制精确继续引用。`updateModelContext`不自动启动回复，消息受理不等于返工完成；宿主能力必须实测，不由协议或SDK推定当前Codex Apps可用。技术来源见[research/13](research/13-短剧预演视频与人工审阅研究.md)。

原视频、声音及工程不以大段base64塞进工具结果；资源读取使用受管预览、流量预算和固定摘要，网页不能读取任意路径、供应商URL或密钥。任务状态、固定媒体、作者意见和继续回执共用Core记录，不保存第二套制作事实。

## 会话内整书原稿导入

`hetu_register_import_authorization` 对应 `hetu.import_authorizations.register`，接收确切管理引用、小说身份、目录基线、固定原稿和阅读摘要、连续范围、逐篇标题／分卷／摘要以及实际用户指令 `authorization_note`。作者已明确要求导入时直接登记；没有明确指令时只在当前会话询问必要决定。登记不提前写正文，不创建作者身份。

`hetu_execute_management_operation` 可携带 `import_authorization_ref`，由 Core 验证分卷方案或下一组原稿批次。范围内连续执行，不要求开启桌面窗口或逐批批准。`hetu_get_import_authorization` 回读固定范围和游标，`hetu_revoke_import_authorization` 停止后续执行并保留历史。管理撤权、重授、过期、外部目录修改、错误顺序或内容摘要不符均拒绝；未知结果沿同一授权、方案与操作键恢复。

该合同沿用模型任务的 `agent_conversation` 登记方式：外部 Agent 对真实用户指令的提取负责，Core 不声称鉴别自然语言说话者；Core 负责确定性范围、摘要、版本与事务校验。伪造 `approved` 或作者模式无效。授权只覆盖本次原稿导入，不覆盖其他正文修改、AI 候选采纳、定稿、模型费用或网络动作。

## 全软件能力地图与会话操作

[40机器能力地图](40-机器能力地图与Review清单.md)面向产品Review，`contracts/capability-map.json`面向AI导航；两者从动作合同、MCP映射、权限路由和Skill源生成。源码连线、安装发现及专项实测分别取证。MCP执行时以当前tools/list与实际返回的Schema为准。

`hetu_list_management_actions`发现领域动作；prepare固定结果，`hetu_record_management_decision`如实记录当前会话对确切摘要及状态版本的决定，再执行并回读。设置、插件、模型渠道和文稿版本各有独立工具，名称及范围从地图与实际发现取得。既有任务不因管理能力增加而获得正文采纳或定稿权；必要作者决定在当前对话完成，桌面审阅为可选入口。

河图专业插件使用稳定 `hetu_plugins_inspect`、`hetu_plugin_access_capabilities` 和 `hetu_plugin_access_invoke`；新增包只改变河图返回的安装与能力投影，不为每包增加MCP工具或客户端插件。同一连接按需查询新Schema，调用重验当前安装、WorkRef、原管理授权、插件grant、包与能力摘要。MCP工具列表变更通知不是热插拔前提；Agent仍需主动发现才能得知后台安装变化。格式、时序与HP验收边界由[插件21](plugin/21-核心格式与动态能力发现.md)拥有。
