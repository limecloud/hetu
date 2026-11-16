# 进程通信、内核ABI与CLI合同

新桌面采用JSON-RPC 2.0私有stdio连接Rust App Server，初始化、消息预算、错误和退出合同由[39第5节](39-Electron与插件优先重构架构.md#5-json-rpc-的准确口径)拥有。Rust CLI和MCP独立复用Core，公开命令、JSON、退出码、权限与恢复语义保持兼容。

领域 Schema 为 `1.0.0`；CLI／MCP 公开结果采用 AXI `0.2.1` 及逐动作合同修订。应用动作与签名见[30](30-应用API详细设计.md)。

## 1. 共享应用边界

Rust Core以library供App Server、CLI、MCP和插件CLI静态复用。桌面通过私有stdio传递固定JSON请求；不提供Swift桥接、C ABI、裸指针或动态Core加载入口。公开动作由 `contracts/actions.json` 和对应Schema维护。

工作区写入锁只排斥其他写入者，不阻止打开与查询。读请求通过发布保护读取完整已提交状态；多文件事务发布与恢复期间短暂等待。实际保存仍检查授权、固定修订、CAS和原操作键。临时进程请求标识不充当持久恢复引用，未知结果通过原操作回读。

## 2. 用例请求与结果

请求由版本、方法、参数、预期输入修订与操作键构成。身份由可信入口组装，不从业务 JSON 接收 `is_author=true` 或 `approved=true`。CLI JSON 与 MCP structuredContent 采用同一 AXI 结果投影；内核内部错误类型不直接泄漏为第二套公开封装。

```json
{
  "spec_version": "0.2.1",
  "kind": "result",
  "action": "hetu.drafts.submit",
  "contract_revision": "1",
  "status": "blocked",
  "context": {
    "scope_id": "workspace_33333333-3333-4333-8333-333333333333"
  },
  "error": {
    "code": "revision_conflict",
    "message": "输入版本已变化，请读取当前版本后比较。",
    "resolution": {"kind": "read", "action": "hetu.documents.get"}
  }
}
```

公开状态为 `succeeded|pending|blocked|failed|partial|cancelled|unknown`；“待作者批准”放在 `data.approval_state`，不新增 AXI 顶层枚举。异步任务身份放在 `data.task_id`，原操作放在 `operation`。Git 待作者审阅的 pending 返回固定快照与摘要，不包含不存在的异步 task_id。报告含问题仍可任务成功；工具执行失败与作品存在冲突是两种不同结果。

内核错误短名按下表管理；公开 AXI 错误优先复用其标准码，其余使用 `hetu.` 命名空间，例如 `hetu.blueprint_locked`。`operation_unknown` 对外映射 `result_unknown` 并提供原操作恢复动作。AXI 为本团队草案，不是 MCP 官方标准，采用映射和证据见[27](27-Agent与Codex插件集成设计.md)。

稳定接入尚未绑定作品时，结果的 `context.scope_id` 为 `collaboration`；任务调用成功后使用实际作品或筹备范围。无权任务的错误不回显其名称、目录或内容。稳定机器入口接受固定客户端、可选本机接入目录和业务请求；登记及撤权仍由作者 Workspace 动作执行。

无作品时，稳定入口的 `hetu.creation_projects.create` 接受 `brief, locale, operation_key`，分配独立筹备和全新受管作品目录，返回 `management_ref, project_path, target_path`。后续筹备维护、创建、空章节／分集及首任务准备携带确切 `management_ref`，领域输入仍使用各动作的原 Schema。创建成功返回新的 `workspace_management_ref`；准备首任务后，以返回的 `task_locator` 打开固定任务。该有限新建规则不接管任意用户目录，也不授予正文写入、采纳、定稿或其他客户端权限；业务 JSON 和公开 CLI 均不能组装内部管理连接。可信作者通过 `hetu.collaboration.revoke_management` 可撤销本作品的管理授权及派生任务。

可信App Server提供模型连接与渠道设置的专用请求，网络调用由受管后台任务执行。CLI 仅通过 `model-service status|login|poll` 开放连接状态与浏览器登录交接，输出连接状态、账号引用、到期时间及待验证链接和验证码；不返回凭据，不开放渠道配置、断开连接或创作计划批准。模型业务仍通过固定任务动作执行，费用授权在作者当前 Agent 对话登记。

## 3. 错误分类

| 错误码 | 含义与处理 |
| --- | --- |
| `invalid_input, schema_unsupported` | 纠正参数或使用匹配版本，不自动改写数据 |
| `permission_denied, capability_unavailable` | 展示授权或平台限制，不隐式提权 |
| `workspace_busy, recovery_required` | 等待占用结束或恢复原事务 |
| `revision_conflict, stale_evidence` | 重新读取并比较，原确认不可复用 |
| `blueprint_locked, author_confirmation_required` | 需要作者在可信入口操作 |
| `path_out_of_scope, unsafe_path` | 目标不合法，不能用相对路径变体绕过 |
| `io_failure, integrity_failure` | 保留原数据与损坏证据 |
| `budget_exceeded, cancelled` | 明确已覆盖范围与是否已产生持久结果 |
| `git_conflict, non_fast_forward, authentication_failed` | 回到 Git 审阅或凭据流程 |
| `operation_unknown` | 查询原操作并核对副作用，不能自动重试 |

## 4. 独立CLI

Rust CLI源码位于 `apps/cli/src/main.rs`，使用 `cargo build --locked --package hetu-cli --bin hetu` 构建。它直接复用Core和CollaborationHub，不调用桌面作者RPC，不依赖桌面进程或动态Core库。

机器输入为文件或stdin中的完整UTF-8 JSON对象，上限16MiB，接受UTF-8 BOM并计入完整字节预算；默认输出单个AXI结果，也接受命令末尾的 `--json`。无效参数及输入不回显原文或路径。全局 `--locale zh-CN|en` 控制帮助，`--version` 读取制品版本，不要求作品或用户授权目录。稳定接入、旧任务入口、bundle验证及模型连接状态沿用现有公开参数和权限。

本机偏好及所选方法安装由独立Rust本机Owner执行；稳定客户端调用及兼容`--local --client`入口复用同一私密存储，不递归调用自身。公开合同无作者批准，可信Electron App Server独立提供固定审核。历史设置和方案保留原义，新服务不静默双写。模型服务命令仅开放 `status|login|poll` 和既有公开连接字段，不开放渠道配置或费用批准。目标平台与制品分发分别验收，不能由核心读写通过推导完成。

终端适配分别处理POSIX TTY／信号和Windows Console／Ctrl+C、UTF-8、非交互stdin与重定向。macOS、Windows的签名分发和干净系统运行独立验收；Linux作为后续CLI目标，不计V1桌面支持。MCP使用独立Rust Server，不嵌入CLI进程。

## 5. CLI 命令面

稳定入口无需预有作品或任务，先检查实际能力，再开始筹备：

```bash
hetu --client codex collaboration inspect
printf '%s\n' '{"brief":"筹备一本港口悬疑小说","locale":"zh-CN","operation_key":"first-book-preparation"}' \
  | hetu --client codex call hetu.creation_projects.create --input -
```

隔离验收时在 `--client codex` 后增加 `--collaboration-dir` 和独立绝对目录。后续调用保留回执中的管理引用、修订摘要与预留目录，按发现的 Schema 保存资料、创建作品和准备任务；不把创建回执当成采纳或定稿。正式任务以 `collaboration open --input -` 打开返回的 `task_locator`，每次任务调用显式携带完整 `task_ref`。

| 命令组 | 目标能力 | 副作用 |
| --- | --- | --- |
| `hetu capabilities` | 平台、合同、参数和可用性发现 | 只读 |
| `hetu model-service status/login/poll` | 无作品连接状态、浏览器登录交接与原连接查询 | login 创建待验证连接；poll 沿原连接查询，已完成时本地回读；不返回凭据或批准生成 |
| `hetu collaboration inspect/open` | 检查稳定本机接入，按精确任务引用打开 | 只读；不扫描书库或切换全局当前任务 |
| `hetu library list/register` | 本机书库查询与显式登记 | register 仅修改本机登记，不复制作品或授予 Agent 权限 |
| `hetu creation prepare/show/create-workspace` | 建书筹备、候选选择与作者确认创建 | 创建须固定资料、明确目录与原键，不自动生成 |
| `hetu creative-task prepare/show/prompt/submissions` | 固定任务、复制内容与外部结果查询 | prepare 保存请求，其余按能力合同读取；不调用 Agent |
| `hetu task-context list/read/search/request-material` | 获权固定资料的按需读取和缺项 | request-material 记录请求，不授予更多原文权限 |
| `hetu working-copy create/show/save/checkout/import` | 同任务持续编辑参考稿、可选文件交接 | 保存与导入形成参考修订；不覆盖作者正文或旧候选 |
| `hetu task-feedback list/save` | 公开意见与确切成果引用 | 保存不采纳、不扩权；继续消息由当前宿主按能力处理 |
| `hetu workspace init/open/inspect` | 创建、检查与打开 | init 写入新目录 |
| `hetu blueprint show/edit/lock/unlock` | 作者设定集维护 | edit／lock／unlock 需可信作者入口 |
| `hetu document list/show/save` | 修订与正文管理 | save 创建修订并 CAS 更新 |
| `hetu draft submit/list/show` | 提交、查询草稿 | submit 仅写草稿 |
| `hetu plot extract` | 对已有修订提取节点 | 可选保存派生结果 |
| `hetu resource list/show/create/update/adopt/usages` | 资料草稿、作者采用和固定使用 | 按任务与作者权限分别执行；Agent 不得写已采用资料 |
| `hetu design list/show/create/update` | 造型、场景和道具设计 | CAS 保存草稿；正式采用仅作者 |
| `hetu asset-candidate submit/list/show` | 成组素材回传与查询 | 提交只读取任务 inbox，不接受任意路径 |
| `hetu asset-selection preview/select/withdraw` | 按用途选用或撤回 | preview 只读，其余可信作者确认 |
| `hetu drama project/episode/script/storyboard/segment` | 项目、分集、语义读取与候选协作 | 正式编辑与候选授权分开，动作和 Schema 共同发布 |
| `hetu drama skeleton/compare` | 骨架与原著比较 | 保存候选，不覆盖定稿 |
| `hetu validate` | 校验与覆盖报告 | 可选保存报告 |
| `hetu review list/show/decide` | 人工审核与批注 | decide 需作者确认 |
| `hetu document adopt/finalize/withdraw-finalization` | 采纳到写作稿及独立定稿／撤回 | 分别确认固定输入，采纳不设置定稿 |
| `hetu git status/diff/log` | 版本观察 | 只读 |
| `hetu git snapshot/branch/switch/merge/fetch/pull/push` | 本地和远端协作 | 按具体目标确认 |
| `hetu bundle preview/export/verify` | 交付选集、导出与摘要检查 | export 创建新包 |
| `hetu operation show` | 原操作状态和恢复证据 | 只读 |

参数、帮助与能力发现由同一正式合同生成。CLI 是外部 Agent 的主要业务入口，支持无桌面进程的完整获权闭环；作者可以手动使用相同命令。Agent 不获取通用作者身份，所需作者决定通过确切操作提案与独立确认承接。

表中命令组定义设计面；正式子命令与动作合同一同发布，安装版本通过 `hetu capabilities` 和自身帮助声明实际入口，不把文档中的拟发布命令当成已安装能力。

Agent 入口覆盖无作品筹备、明确新建、已授权作品管理和单任务接续，无需先创建作品、填写 GUI 表单或启动桌面窗口。稳定任务定位复用 MCP 的 TaskLocator／RequestRef 和私有授权，不接受任意目录冒充授权；调用参数、JSON 输入与环境不得含秘密。正文导入、正式保存和交付需要的操作输入由 Agent 准备，Core 按对象、影响及现有授权判断能否直接执行或需要作者决定；获得独立的确切批准后可以由机器继续执行，不把批准等同于必须由人点击执行按钮。当前实现、打包差距及实施准入集中见[20第6节](20-实施路线与里程碑.md#6-持续协作的实施准入)。

任务命令先 open 并核对请求版本，再按需读资料、保存参考稿或提交；结果未知查原键，恢复先回读现有成果及公开反馈。文件编辑只使用 Core 签发的任务临时检出，不把作者 packages 目录作为工作树交给 Agent。精确动作、输入输出及错误由[30第23节](30-应用API详细设计.md#23-持续协作与任务接续合同)维护，CLI 不重写业务校验。

## 6. CLI 输出与交互

`--json` 的 stdout 只有一个 UTF-8 结果对象，诊断与进度写 stderr；长任务可显式选择 NDJSON 事件流，每条有类型与任务 ID。默认人类输出可本地化，JSON 字段和错误码不本地化。

`--locale zh-CN|en` 控制帮助和人类消息，默认 zh-CN；语言切换不影响作品内容、动作名和机器字段。完整规则见[31](31-国际化与中文体验.md)。

退出码：`0` 成功，`2` 输入错误，`3` 权限或确认缺失，`4` 冲突／过期，`5` I/O／完整性／执行失败，`6` 部分或取消，`7` 未知副作用，`8` 不支持。作品诊断有 error finding 时 `validate` 可用独立的 `--fail-on` 规则返回非零，报告仍需正常输出，不伪装为引擎崩溃。

无交互终端且没有可信作者确认的高风险操作返回 `author_confirmation_required`。不存在模型可传入的通用 `--yes`、假审核人或万能批准布尔值。操作确认与工作区授权、系统文件权限分别管理。

检测到 TTY 只说明可以交互，不证明操作者是人；Agent 也可能持有伪终端。作者动作须获得独立本机作者会话对确切操作的授权，不能仅靠输入 `y` 提升 Agent 权限。Apps、网页与 MCP 的授权不能转换为 CLI 作者模式。

## 7. 机器执行与作者决定

CLI/MCP 对同一用例提供发现、预览、准备、获权执行、回读及恢复能力。无书名时可开始筹备，Agent 负责填充结构化字段；新建作品只影响明确的新目录，不能因此得到既有作品、整座书库或作者角色。作者已经提供的字段、选择和批准引用在后续步骤复用，不要求手工转录。

需要作者判断的操作由机器生成完整提案，固定 action、输入摘要、目标对象及版本、预期影响和所需决定；确认只授权该确切操作。Core 在执行时重新验证授权、CAS、输入及外部目标，不把提案文本里的“已批准”解释成权限。具体行为与数据见[30第25节](30-应用API详细设计.md#25-全软件联动与操作提案合同)。

整书原稿导入使用 `hetu.import_authorizations.register/get/revoke`：Agent 根据作者当前会话真实指令登记固定 WorkRef、完整目录和原稿／阅读文本摘要；Core 返回 `import_authorization_ref`。管理方案执行携带该引用，只允许固定分卷与下一组导入批次，正文与游标同事务落盘。既有明确导入授权在范围内复用，不要求桌面批准或逐批再次确认；其他作者决定仍按各自合同处理。

CLI/MCP 缺业务入口属于未完成用例，不能要求 Skill 通过 Computer Use 操作 GUI 补齐。GUI 验收可以调用 Computer Use；真正没有机器入口的外部系统才按实际限制使用兜底，并记录范围。

## 独立创作对象与视频入口

CLI能力发现须覆盖独立小说／剧本／视频、固定来源关联、分镜、预演、媒体接收、视频计划、剪辑音画、位置意见和交付。具体动作名、Schema及限制从当前能力目录获取，不将[30第26节](30-应用API详细设计.md#26-独立创作对象与视频用例合同)的设计名称直接写成已发布命令。各入口复用相同用例，不另建授权或业务状态。

每次调用携带明确对象／任务及固定版本，不使用全局当前项目。大媒体和工程使用有界文件流或任务inbox，JSON只回必要元数据与受管引用；原操作、授权、分页、CAS与退出码保持一致。机器新建和制作不依赖桌面窗口；收到媒体、技术校验、内容观看和作者确认分别回执，unknown先查询原计划，不能因进程重启重复付费。

精确作品的文稿版本在 `hetu.git.status/diff/log/snapshot/get_snapshot/list_snapshots/snapshot_diff/read_version` 显式携带 `work_ref`。新快照1.1.0固定作品，旧1.0.0保持工作区语义；不从当前页面补历史归属。稳定MCP的 `hetu_commit_snapshot` 提供同一准备／执行合同，作者批准只由可信宿主完成。独立作品引用从空树建立，整仓引用／合并／远端能力不向单作品连接开放。具体约束见[插件20第22节](plugin/20-首期可执行合同与开发入口.md#22-精确作品的文稿版本)。

## 全软件会话入口

CLI、MCP、Skills功能及源码与验收状态统一见[40机器能力地图](40-机器能力地图与Review清单.md)。稳定 `--client` 入口同时承接固定领域方案、会话决定、本机设置、插件生命周期、模型渠道设置和文稿版本；不依赖运行中的桌面。实际Schema从inspect和agent_operations.catalog发现，不从文档复制旧参数。

决定与执行分开：Agent准备确切结果及差异，依据真实用户指令登记record_decision，再execute并回读。采纳、定稿、解锁、封面选用等必须有各自确切决定；无需因其是作者决定就强制使用GUI。费用和内容外发仍使用独立任务授权，执行者不提升为作者。
