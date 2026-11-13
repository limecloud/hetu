# 应用 API 详细设计

API 为共享应用用例合同，供原生 GUI、Swift CLI、MCP 及按需局部页面适配；V1 不引入必装 HTTP 后端。Node.js 页面通过受限本机 IPC 消费白名单用例，不能绕过 Core 直接写文件。领域见[28](28-领域设计与边界上下文.md)，字段语义见[29](29-数据字典与Schema设计.md)。

本章定义产品设计面；调用方仅使用当前构建能力发现实际发布的动作。专项设计或 Schema 文件的存在不表示动作已经实装。

## 1. 入口、权限与版本

| 入口 | 可调用范围 | 身份来源 |
| --- | --- | --- |
| macOS／Windows GUI | 用户授权的完整人工任务 | 本机可信窗口、系统访问与作者会话 |
| Swift CLI 人工模式 | 同一核心任务，支持交互确认 | 控制终端与本机作者会话 |
| MCP Agent | 读设定集／获权原文、草稿、派生结构、报告、受限交付 | 已批准的 Server 上下文，非 clientInfo 自报 |
| MCP Apps | 当前任务查询、候选选择、批注和采纳意图 | 宿主桥接及范围授权；不授予定稿、正式封面选用或设定写权限 |
| 本地 Node.js 页面 | 配对会话中的单任务查询、选择与意见 | 原生作者配对的短期会话；浏览器点击不充当作者批准 |

业务请求不能指定用户角色、作者批准、任意根目录或系统凭据。上下文在入口组装时取得能力，Core 每次操作重新验证；同 OS 用户恶意程序绕过受管入口的限制按18如实说明。

API 动作使用 `hetu.<domain>.<verb>`，每个动作有独立 `contract_revision`。AXI 封装版本、领域 Schema、MCP 协议和 ABI 版本独立声明。能力发现返回当前构建实际支持的动作、输入输出、effect、限额与不可用原因。

## 2. 调用封装

以下是 C ABI 内部用例调用格式，不是新增的 AXI 交换文档类型；CLI／MCP 的公开结果为 AXI result。

```json
{
  "action": "hetu.drafts.submit",
  "contract_revision": "1",
  "input": {
    "package": "novel",
    "source_format": "markdown",
    "title": "第一章草稿",
    "content": "林舟推开门。",
    "blueprint_revision": 7,
    "operation_key": "draft-submit-001"
  }
}
```

每个输入 Schema 默认 `additionalProperties=false`，拒绝拼错字段、非法枚举、过大内容和未知合同修订。缺必填上下文返回明确错误；不能默认选最近项目、最新设定集或第一个同名人物后写入。

## 3. 读写与公共前置

- 所有写入具有 operation_key；规范化固定输入排除操作键，不排除版本和业务参数，按27／14的规则计算摘要。
- 重授权 → 持久原键查询 → 同输入重放／异输入冲突 → 仅首次请求做 CAS／业务校验 → 可恢复事务 → 回执。
- 修改已有对象必须提供 expected_revision 与 expected_sha256，或对应不可变 base_revision_id；正式 Schema 明确每个动作采用哪种。
- 本次批准绑定动作、对象、固定输入摘要与有效期；数据变化不得沿用原批准。
- 读取同样核验范围；操作键和资源 ID 不是 bearer 授权。
- `save_result=false` 等预览路径无业务写入；保存结果的 effect 与幂等条件单独声明，不使用“只读”标签掩盖落盘。

## 4. 工作区与设定集动作

| 动作 | 输入 | 结果 | 限制与失败 |
| --- | --- | --- | --- |
| `hetu.workspaces.create` | 作者选定路径、title、packages、operation_key | workspace_id、创建文件摘要 | 人工入口；非空目标不覆盖；创建不自动 Git init |
| `hetu.workspaces.open` | 作者选定路径、requested_mode | 格式、权限、恢复状态、上下文句柄 | 路径本机可信入口输入，不经 MCP 暴露任意打开 |
| `hetu.workspaces.get` | 空对象 | 项目属性、包、覆盖与 `access.write_available` | 使用入口已授权 scope；写入者存在时仍可查询，是否可写仅为即时状态，保存仍检查锁与修订 |
| `hetu.workspaces.list` | 空对象 | 当前授权工作区与包配置 | 对应 MCP list_workspace；不扫描其他作品，正文目录独立查询 |
| `hetu.blueprints.get` | revision? | 完整设定集、revision、sha256、lock | 缺省读取当前；指定修订只读读取历史，核验原始字节摘要 |
| `hetu.blueprints.preview_change` | expected、typed_changes[] | 引用影响、差异、阻断与警告 | 无写入；不接收任意脚本／路径 patch |
| `hetu.blueprints.save` | expected、typed_changes[]、operation_key | 新 revision、摘要、影响引用 | 仅作者、必须未锁定；拒绝借 changes 改锁／身份 |
| `hetu.blueprints.lock` | expected、reason?、operation_key | 新修订、锁状态 | 作者确认；检查当前内容完整性 |
| `hetu.blueprints.unlock` | expected、reason、operation_key | 新修订、解锁审计 | 作者明确操作；不改变 Agent 能力 |
| `hetu.blueprints.apply_suggestion` | suggestion_ref、expected、author_changes、operation_key | 采纳记录、新设定集修订 | 仅作者；源证据过期／歧义先处理 |

typed_changes 是受限的实体新增、字段更新、归档、引用迁移和删除联合类型。删除有被引用项时阻止，迁移先预览。建议草稿不是待执行命令，作者选取后才形成合法变更。

实体操作为 `upsert_character|upsert_faction|upsert_location|upsert_event|upsert_world|upsert_rule`，携带完整 `entity`；移除为 `remove_entity`，携带 `entity_ref`。归档使用有 archived 字段的实体 upsert；引用迁移与其他实体变更一并提交。批次内同一实体只允许一次操作，允许引用同批新建实体，整批完成结构、引用、来源、时间和事实校验后再写入。预览返回 impact.changes 与候选设定修订，无业务落盘。

## 5. 正文、草稿与导入

### 小说作品与卷章

以下动作为运行目录中的作品管理入口，输入以 [Novel Schema](../contracts/schemas/novel.schema.json) 为准。书库登记属于本机客户端，不通过 MCP 向 Agent 提供所有作品的位置。

| 动作 | 输入 | 返回与约束 |
| --- | --- | --- |
| `hetu.novels.get` | 空对象 | `initialized, novel, revision, sha256`；未初始化返回空资料，不自动迁移 |
| `hetu.novels.initialize` | metadata、operation_key | 作者显式初始化，只收录既有小说章节，保留正文修订 |
| `hetu.novels.update` | expected、metadata、operation_key | 作者保存资料；expected 同时核对 revision 与 sha256 |
| `hetu.novels.save_structure` | expected、volumes、chapters、operation_key | 作者保存目录；稳定章节身份与正文绑定不可改变；章节完整且分组连续 |

`metadata` 包含 `title, author_name, synopsis, genre, language_tag, status`；状态为 `planning|writing|completed|archived`。目录数组定义顺序，分卷包含 `volume_id, title`，章节包含 `chapter_id, document_id, volume_id`，未分卷使用 `null`。作者创建 `novel_chapter` 或采纳候选建立新章时原子追加目录，参考稿接收或通过审核不自动创建章节，原操作重放不重复创建；大纲与剧本不进入小说章节目录。

### 正文与草稿动作

| 动作 | 输入 | 结果 | 限制与失败 |
| --- | --- | --- | --- |
| `hetu.documents.create` | kind、title、source_format、content、language_tag?、operation_key | 新文档与首个不可变修订 | 仅作者；普通新稿不自动批准 |
| `hetu.documents.list` | kind? | 文档摘要与修订指针 | MCP 资源层分页绑定 scope、过滤条件和完整列表快照 |
| `hetu.documents.get` | document_id、revision_id? | 元数据、格式、内容或有界范围 | 默认当前修订必须在结果明确，固定引用优先 |
| `hetu.documents.save` | document_id、base_revision_id、source_format、content、operation_key | 新 revision_id、sha256、当前指针 | 作者编辑入口；不自动批准；基线冲突不覆盖 |
| `hetu.documents.preview_import` | file_path、format、profile | 固定文件摘要、转换预览与损失报告 | 仅作者选择的本机文件；不修改作品、不执行宏 |
| `hetu.documents.import` | preview、kind、title、language_tag、volume_id?、acknowledgement、operation_key | ImportRecord、文档及修订 | 仅作者；确认预览与损失后重验原文件；原键恢复 |
| `hetu.documents.preview_export` | revision_refs、profile、format | 固定正文修订、格式转换预览与损失报告 | 仅作者；不创建最终文件 |
| `hetu.documents.export` | preview、acknowledgement、operation_key | 新文件、摘要、转换报告 | 仅作者确认固定预览；受限导出根；原键恢复 |
| `hetu.drafts.submit` | package、source_format、content、blueprint_revision、operation_key、目标或新稿信息 | draft_id、operation、diagnostic_state=not_requested | 新稿需title；修改需target_document_id＋base_revision_id |
| `hetu.drafts.get` | draft_id | 正文引用、状态、来源、审核与诊断引用 | 不返回隐藏内部批注 |
| `hetu.drafts.list` | state?、package? | 获权草稿摘要 | 不宣称列表为空就是没有未授权草稿；分页待审查询使用 reviews.list |
| `hetu.annotations.add` | source_ref、body、visibility、operation_key | annotation_id | 绑定确切修订；外发范围显式 |

Agent 通过 drafts.submit 创作，不通过 documents.save 直接覆盖正文。草稿提交与诊断是独立动作；需要检查时调用 reviews.validate，不能把接收成功解释为诊断通过或已定稿。

## 6. 抽取、骨架、对比与校验

| 动作 | 输入 | 结果 | 限制与失败 |
| --- | --- | --- | --- |
| `hetu.plot.extract` | document_revisions[]、blueprint_revision、options、save_result、operation_key? | 节点候选、来源、覆盖、可选保存 ID | 保存需原键；预算耗尽返回 partial |
| `hetu.plot.list` | document_id?、limit?、cursor? | 剧情修订摘要与 next_cursor | 游标绑定工作区、筛选与索引快照；变化后重新查询 |
| `hetu.plot.get` | plot_revision_id | 节点与边的固定修订、stale、stale_reasons | 不能混入后来人工校正；partial 修订仍返回 partial |
| `hetu.plot.correct` | plot_revision_id、corrections[]、operation_key | 新 plot_revision_id、父修订与当前性 | 仅作者；确认实体／时序或补标节点、编辑连线 |
| `hetu.drama.build_skeleton` | plot_revision_id、blueprint_revision、episode_options、operation_key | skeleton_id、revision、缺项、来源 | 新候选，不覆盖现有人工稿 |
| `hetu.drama.get_skeleton` | skeleton_id、revision? | skeleton、sha256、is_head、stale、stale_reasons | 省略 revision 读 head；指定时核验历史原始证据 |
| `hetu.drama.list_skeletons` | plot_revision_id?、limit?、cursor? | skeletons、next_cursor | 列出独立候选及其固定修订；快照游标 |
| `hetu.drama.edit_skeleton` | skeleton_id、expected、typed_changes[]、operation_key | 新修订及影响 | 作者结构编辑；保留稳定场景 ID |
| `hetu.drama.compare` | source_revisions、skeleton_ref、save_result、operation_key? | comparison、saved、stale、stale_reasons | 结构映射对比，不判断对白语义或自动回写原著 |
| `hetu.drama.get_comparison` | comparison_id | 固定 comparison、saved、stale、stale_reasons | 核验来源、骨架、摘要及差异结果 |
| `hetu.drama.list_comparisons` | skeleton_id、limit?、cursor? | comparisons、next_cursor | 同一骨架的固定报告；快照游标 |
| `hetu.drama.create_script` | skeleton_ref、title、language_tag、operation_key | document、revision、mapping、stale、stale_reasons | 仅作者；独立 Fountain 结构正文和固定映射，同事务保存；不定稿 |
| `hetu.drama.get_script_mapping` | document_id | mapping、current_revision_id、stale、stale_reasons | 读取初稿映射；核验固定正文、骨架、摘要和标题范围，不迁移到新正文 |
| `hetu.validation.run` | plot_revision_id、rule_set_version、options、save_report、operation_key? | report、saved、stale、stale_reasons、dispositions | 固定剧情所引用的正文与设定修订；保存需原键 |
| `hetu.documents.validate` | document_ref、plot_options、validation_options、operation_key | document_ref、document、report、reference、saved、stale、dispositions | 仅作者；直接检查当前已保存正文，同事务保存剧情与报告，不创建 Draft；保留 partial 覆盖 |
| `hetu.reports.list` | plot_revision_id?、limit?、cursor? | reports、next_cursor | 默认 50、最多 200；游标绑定查询快照 |
| `hetu.reports.get` | report_id | 原报告、reference、计算出的 stale 原因与处置历史 | 内核返回固定报告及当前处置摘要；部分报告返回 partial |
| `hetu.findings.disposition` | report_id、finding_id、expected_inputs、expected_disposition_revision、disposition、reason、operation_key | disposition_record | 仅作者；CAS、原键恢复，完整性错误不可豁免 |

`episode_options` 只接受 `episode_start_node_ids`，默认为空数组。锚点需属于未排除的固定输入节点，按原著顺序排列且不重复；不接受自然语言指令或隐式片长推断。`blueprint_revision` 必须等于输入剧情绑定的设定集修订，摘要由内核核验。

骨架创建与编辑响应均为 `skeleton, sha256, stale, stale_reasons`。[创建输入](../contracts/schemas/drama-build-input.schema.json)、[编辑输入](../contracts/schemas/drama-edit-input.schema.json)与[骨架资源](../contracts/schemas/drama-skeleton.schema.json)是确切机器合同。`expected={revision, sha256}` 只接受客户端已经读取的 head；原键重放先于 CAS，不会因后续修订增加而丢失原回执。

作者结构变更为闭合操作：`update_scene, move_scene, split_scene, merge_scene, set_scene_nodes, remove_scene, add_scene, split_episode, merge_episode, move_episode, update_episode, add_episode`。位置 `index` 为操作执行时目标数组的零基位置；移动场次先移出再插入，跨集同样适用。拆分锚点必须在本集／本场且不能是首项；合并只向后合并相邻集／场。一个请求中的操作依次执行，最终统一校验和事务保存，失败不发布部分修订。空集在整个操作序列完成后移除。

[对比输入](../contracts/schemas/drama-compare-input.schema.json) 的 `skeleton_ref` 包含 ID、确切修订与摘要；`source_revisions` 每项包含 `document_id, revision_id, sha256, source_format, size_bytes`，需按骨架的输入文档顺序提供同一组文档。与基线不同的修订明确产生 `stale_source`，不会让旧节点悄悄关联新文本。`save_result=false` 禁止操作键且不落盘；`true` 必须提供原键。[报告](../contracts/schemas/drama-comparison.schema.json)与当前性分开，输入部分覆盖仍返回 `partial`。列表默认 50、最多 200，游标绑定工作区、筛选和索引快照。

[建立剧本输入](../contracts/schemas/drama-script-input.schema.json) 必须明确骨架修订与摘要；标题由作者填写，`language_tag` 只接受 `zh-CN|en`。结构渲染保留未知字段，不能直接表示的标题／地点返回 `hetu.format_unrepresentable`，输出预算超限返回 `hetu.budget_exceeded`；写入受原键重放与作者权限保护。来源为部分剧情时，创建与映射读取继续返回 `partial`。历史基线允许建立独立文档并明确返回 stale；不更新或覆盖现有剧本。

剧本映射当前性先继承固定骨架的来源原因，再检查 `skeleton_changed` 与 `script_changed`；后者携带当前正文修订。报告中的范围、quote 和 scene ID 始终属于固定初稿。界面切换语言不改变 `language_tag`、正文或映射；新文档的模板语言由作者明确选择。

剧情输入的确切字段由[提取 Schema](../contracts/schemas/plot-extract-input.schema.json)与[校正 Schema](../contracts/schemas/plot-correct-input.schema.json)定义。`document_revisions` 每篇文档只接受一个固定修订，核验 `document_id, revision_id, sha256`；`options={}` 使用机器合同默认预算。`save_result=false` 禁止传操作键且不落盘；`true` 必须传原键。响应 data 为 `plot, saved, stale, stale_reasons`。

`update_node` 改变分类、确认关联、日夜、核对状态及可选结构 `annotation`，不能改原始来源；`add_node` 必须提供固定输入原文的精确 SourceRef；`add_edge` 需给出端点、关系与原文证据；`remove_edge` 指定稳定边 ID。校正不切换输入设定或原文修订，过期结果可保留分支校正；重新提取创建独立结果。`partial` 可能已经持久化，自动化入口必须先读取覆盖与原操作回执。

诊断机器输入见[执行 Schema](../contracts/schemas/validation-run-input.schema.json)；`save_report=false` 禁止操作键且不保存报告、索引或回执。`save_report=true` 必须提供原键，部分报告也保留同键回执；重复请求不重新分配报告。规则集版本、语境、证据前提和预算见[引擎规范](08-剧情抽取与一致性引擎.md)。处置的 `expected_inputs` 必须等于报告 `input_snapshot`，首次处置修订为 0；更新时使用最近返回的修订。报告读取不静默合并新校正或新设定。

## 7. 审核与素材

| 动作 | 输入 | 结果 | 限制与失败 |
| --- | --- | --- | --- |
| `hetu.drafts.submit_current` | document_id、base_revision_id、blueprint_revision、skeleton_ref?、operation_key | 独立待审草稿 | 仅作者；当前已保存修订 CAS；结构剧本必须引用骨架 |
| `hetu.reviews.begin` | draft_id、expected_draft_revision、operation_key | draft | 仅作者；既有无锚点草稿在此绑定固定证据 |
| `hetu.reviews.list` | state?、cursor?、limit? | reviews[]、next_cursor | 固定列表快照游标，列表变化后重新查询 |
| `hetu.reviews.get` | review_id或draft_id、report_limit?、report_cursor? | draft、content、input_snapshot、stale、stale_reasons、decisions、reports、reports_next_cursor、baseline、evidence_ready | ID 二选一；报告默认20条，最多50条；Agent投影移除私密批注 |
| `hetu.reviews.validate` | draft_id、expected_draft_revision、plot_options、validation_options、operation_key | report、saved、stale、stale_reasons、dispositions | 固定草稿与设定；同事务保存剧情与报告；partial原键可查 |
| `hetu.reviews.decide`，合同修订2 | draft_id、expected_draft_revision、input_snapshot、report_refs[]、decision、comments、private_comments?、coverage_acknowledgement?、operation_key | review、draft | 仅作者；只记录参考稿决定及审计，不设置正文定稿，不接受调用方例外列表 |
| `hetu.drafts.preview_adoption` | draft_ref、target_ref、new_document、selected_ranges[] | preview、content、baseline | 仅作者；固定候选／提交基线／当前稿；不写正文，不自动合并过期 patch |
| `hetu.drafts.adopt` | preview、operation_key | document、revision、adoption | 仅作者；重算完整预览，同事务保存来源和写作稿，定稿不变 |
| `hetu.documents.preview_finalization` | document_ref、expected_finalization_ref、report_refs[]、comments、coverage_acknowledgement | preview、content | 仅作者；返回固定快照、eligible 与 blocker，对象是已保存正文，可无 Draft |
| `hetu.documents.finalize` | preview、operation_key | document、finalization | 仅作者；重算完整预览，对固定修订独立确认，不创建不同正文或 Git 副作用 |
| `hetu.documents.withdraw_finalization` | document_id、expected_finalization_ref、reason、operation_key | document、finalization | 仅作者；只能撤回当前持有者，历史与当前稿保留 |
| `hetu.documents.lifecycle` | document_id | document、adoptions[]、finalizations[] | 仅作者；核验归属、摘要链与正文历史后返回，不能把缺失记录当空历史 |
| `hetu.cues.list` | kind?、document_id?、include_archived?、cursor?、limit? | cues摘要、next_cursor | 默认排除归档；游标绑定筛选与列表快照 |
| `hetu.cues.save` | cue_id?、expected?、kind、title、description、narrative_refs[]、asset_refs[]、archived、operation_key | cue、sha256、stale_sources、assets | 仅作者；已有cue需CAS；类别不变，引用核验 |
| `hetu.cues.get` | cue_id、revision? | cue、sha256、is_head、current_revision、stale_sources、assets | 固定正文与素材修订；过期状态单独返回 |
| `hetu.assets.inspect` | file_path | original_filename、sha256、size_bytes、kind、media_type、extension、validation | 仅作者选定本机文件；只识别签名，不落盘 |
| `hetu.assets.import` | file_path、expected_file、title、source、rights_status、redistribution_allowed、rights_statement、operation_key | asset、sha256、delivery_eligible、media_verified | 仅作者；流式复制并核对固定摘要；无URL下载 |
| `hetu.assets.update` | asset_id、expected、title、source、rights_status、redistribution_allowed、rights_statement、operation_key | asset新修订、sha256、delivery_eligible、media_verified | 仅作者；CAS；媒体原字节不变 |
| `hetu.assets.get` | asset_id、revision? | asset、sha256、current_revision、current_rights_status、is_head、delivery_eligible、media_verified | 流式核对媒体；历史许可不能绕过当前撤回 |
| `hetu.assets.list` | kind?、rights_status?、cursor?、limit? | assets摘要、next_cursor | 列表不加载媒体，media_verified=false |

参考稿 `decision=approved` 与正文定稿分开。采纳预览固定作者选区、目标及实际差异，adopt 在锁内重验；Apps／网页只能保存选择和意图，正式采纳在原生端确认。定稿接口存在不意味着模型可调用，不能用模型传入的批准布尔值或页面点击绕过作者权限。

采纳、正文检查和独立定稿的精确输入统一见[文档生命周期 Schema](../contracts/schemas/document-lifecycle.schema.json) 的 `$defs`。`document_ref={document_id,revision_id,sha256}`；`draft_ref={draft_id,revision,sha256}` 中的 revision 固定参考稿状态修订，sha256 固定其内容。修改已有文档使用非空 target_ref 且 new_document=null；新建文档使用 target_ref=null，new_document 包含作者确认的 `title,volume_id,novel_expected`。新小说章节的 novel_expected 固定目录修订及摘要，volume_id=null 明确表示未分卷；剧本的 volume_id 和 novel_expected 均为 null。

每个选区为 `{source,target,replacement?}`，source 与 target 各自是固定文本上的 UTF-8 半开范围及 quote。来源不得为空或重叠，目标不得重叠或重复使用同一插入点；空目标允许插入。未提供 replacement 时使用来源切片，提供时保存作者改写后的确切字符串。限制为1～100个选区；整稿采纳同样明确源范围和目标范围，不以空数组表示全选。被驳回、要求修改或已接替的参考稿不能直接采纳，应先回到相应审核／返工流程。

预览是服务端产生的完整 envelope。采纳 preview 包含 `request,snapshot,result_sha256,sha256`；定稿 preview 包含 `request,snapshot,eligible,blocker,sha256`。preview.sha256 对去掉自身 sha256 字段的 envelope 按 JCS 规范化后计算；它区别于持久文件原始字节摘要，也不是作者授权凭据。调用方原样保存并提交 preview，不自行拼 snapshot、只传摘要或修改选区；改变任何选项先重新预览。写操作在重授权及原键查询后重算并比较完整预览，过期或不一致则整次拒绝。

独立定稿的 `report_refs` 每项含 `report_id, sha256, dispositions_sha256`，报告必须覆盖所确认正文确切修订及固定设定，不能沿用采纳前候选的报告冒充当前检查。部分覆盖或未知前提要求非空 `coverage_acknowledgement`；`certain/error` 仅允许规则准许且已记录的具体 `accepted_exception`。私密批注只在作者投影返回，例外由已核实处置提取。

已保存报告的查询与检查结果由内核返回 `reference={report_id,sha256,dispositions_sha256}`；预览中未保存的报告 reference 为 null。调用方使用读取时返回的完整引用，不对重新编码的 JSON 自算摘要。问题处置更新后重新读取报告引用，并重新预览定稿。

定稿预览必须显式传入 comments 和 coverage_acknowledgement，不需要覆盖说明时后者可为空；确认定稿时 comments 不能仅含空白。首次定稿的 expected_finalization_ref=null，后续使用 `{finalization_id,sha256}` 固定当前持有者。report_refs 为1～50项，确认时重验报告和处置摘要。采纳及定稿写入的通用 operation 位于结果封装中；adoption／finalization 各返回 `{record,reference}`，reference 固定新记录 ID 和原始字节摘要。历史与指针字段见[29第5.1节](29-数据字典与Schema设计.md#51-采纳与独立定稿记录)。

参考稿审核的 withdrawn 只撤回该次候选决定，不清除正文定稿。撤回定稿使用独立 withdraw_finalization，仅修改仍由该记录持有的指针。并发采纳及定稿各自检查目标 CAS。返工保留包、格式、目标和父稿，新候选不覆盖原内容。音乐／视觉候选不能通过文本采纳建立正式章节。

参考稿决定采用 `contract_revision=2`，其记录采用 schema_version=2.0.0；生命周期动作的合同修订与记录版本分别声明。新请求使用能力目录公布的修订，不得通过指定旧修订请求已经废止的副作用。历史决定和原操作仍按自身版本读取；同键跨合同修订不转换为一次新执行。

素材与线索输入由 [Media Schema](../contracts/schemas/media.schema.json) 对应 `$defs` 定义，能力发现返回完整可独立解析的输入合同。`expected_file={sha256,size_bytes}`，`expected={revision,sha256}`；所有媒体写动作保留原键，成功后重放不依赖外部原文件仍存在。单文件上限 2 GiB，禁止可执行文件、符号／硬链接、设备与空文件。来源 URL 不含凭据、查询或片段，界面不自动移除参数后冒充原地址。列表默认50项、最多100项，单次枚举最多10000条；历史链单次核验最多1000条。

### 7.1 小说封面与外部 Skill

封面动作 `hetu.covers.get`、`hetu.covers.inspect_file`、`hetu.covers.preview_prompt`、`hetu.covers.create_request`、`hetu.covers.list_requests`、`hetu.covers.list_candidates`、`hetu.covers.import_preparation`、`hetu.covers.list_preparations`、`hetu.covers.select` 的输入、输出、权限和恢复以[34](34-小说封面与Agent协作.md)为专项合同，机器输入见 [BookCover Schema](../contracts/schemas/book-cover.schema.json)。预览和文件检查无导入副作用；请求创建保留原键；候选只核验本请求最多4张图片；请求和筹备导入列表独立分页；筹备转入与正式选用分开；选用为作者 CAS 事务。

外部 `hetu-cover` Skill 读取请求并写入固定 inbox，不需要为图像生成扩张八个基础 MCP 工具。核心不代理图像 API；候选回执不具有作者身份，也不能调用选用操作。

## 8. Git、Bundle 与恢复

| 动作 | 输入 | 结果 | 限制与失败 |
| --- | --- | --- | --- |
| `hetu.git.status` | 空对象 | initialized、head、changes、state、repository_instance | 仅当前工作区，不发现父仓库；HEAD→工作树，保留原 index |
| `hetu.git.diff` | path | head、before／after、摘要、mode、大小、binary／truncated | 受管相对路径；私密审核原记录仅作者可读 |
| `hetu.git.log` | limit?、cursor? | commits、head、next_cursor | 默认30，最多100；游标绑定HEAD |
| `hetu.git.init` | branch、operation_key | 当前仓库状态 | 仅作者；不自动提交或联网 |
| `hetu.git.snapshot` | phase、operation_key；prepare: expected_head、message、author、selected_paths?；execute: snapshot_id | 固定 snapshot／pending，或 commit_id 与排除项 | prepare 与 execute 分别幂等；执行需本机批准 |
| `hetu.git.approve_snapshot` | snapshot_id、snapshot_sha256、operation_key | approval_state、expires_at | 仅作者；固定摘要、仓库实例、所选字节与HEAD |
| `hetu.git.get_snapshot` | snapshot_id | 固定快照与摘要、当前性、批准状态及可空 execution | 核验快照与当前仓库实例；不接受分页字段 |
| `hetu.git.list_snapshots` | limit?、cursor? | 分页快照摘要与 next_cursor | 默认50，最多100；固定列表游标 |
| `hetu.git.snapshot_diff` | snapshot_id、path | 固定差异、snapshot_sha256 | 路径须属于该快照；HEAD或文件变化拒绝 |
| `hetu.git.branch_create`／`switch` | 分支名、起点／目标、expected_head、operation_key | 实际分支／HEAD | 作者确认；保护脏工作树 |
| `hetu.git.merge` | phase、source_ref、expected_head、resolution_ref?、operation_key | 冲突预览／已验证合并结果 | 三方人工解决，JSON引用再校验 |
| `hetu.git.fetch`／`pull`／`push` | remote_ref、branch_ref、expected_refs、operation_key | 实际远端／本地证据或unknown | 明确单次授权，禁止强推；秘密不入参数 |
| `hetu.bundles.preview` | selection、profile、reading_formats? | 固定修订、文件清单、缺口、排除与摘要 | 仅作者；不创建最终包 |
| `hetu.bundles.export` | preview、acknowledgement、operation_key | bundle_id、路径、ZIP摘要、manifest | 仅作者确认固定预览；发布前重验定稿与许可；原键恢复 |
| `hetu.bundles.verify` | bundle_id | 文件与引用核验结果 | 已获当前作品访问权限的连接可只读核验本书受管导出包；有大小、条目和解压预算，不执行内容，不接受任意本机路径 |
| `hetu.operations.get` | operation_id或原key＋action | 原回执、当前状态与恢复缺口 | 重新授权，不因找不到记录就重执行 |
| `hetu.tasks.get`／`cancel` | task_id、operation_key? | 当前任务／取消范围 | cancel若改变持久状态需幂等记录 |

Git 的外部观察、确认范围与未知核对按16执行；没有手工批准的自动化请求不取得 push／pull 等能力。Bundle不自动上传、不向他人发消息。

## 9. MCP 适配

`contracts/tools/catalog.json` 映射已开放工具与内核动作；MCP tools/call 外层工具名与内层 AXI action 名分开。inputSchema 复用内核展开后的机器合同，outputSchema 为绑定准确 action 的 `contracts/schemas/result.schema.json`。文档、审核、报告和 operations 以白名单资源读取适配查询用例，分页和恢复见[14](14-MCP与Agent接入.md)。CLI 命令、GUI ViewModel 与 MCP 不重新实现审核、CAS 或 Git 策略。

MCP 的标准工具描述必须静态且如实反映其写入可能性；实际权限依请求上下文重验。长任务先返回持久原操作，再通过可用资源／窄查询继续。核心报告有错误发现时工具可以执行成功，不能将JSON-RPC成功误读为草稿定稿。

## 10. 错误、分页与任务

AXI 标准错误使用 invalid_input、missing_context、forbidden、not_found、revision_conflict、idempotency_conflict、unsupported_version、cursor_invalid、unavailable、deadline_exceeded、result_unknown 等；内核特有错误使用 `hetu.blueprint_locked`、`hetu.stale_evidence` 等命名空间。每个错误给出 correction／read／recover／request_decision 方向，不添加泛用“重试即可”。

分页 `limit` 默认50、最大200，游标为不透明值，绑定身份、范围、筛选与快照。字段选择不允许隐藏操作、版本、覆盖或错误所需元数据。

任务排队／执行／终态与 AXI status 是不同层次；异步执行的 pending 包含 data.task_id 和 operation；Git 待审 pending 包含固定 snapshot 与 operation，不虚构运行中的任务。取消通知仅停止当前RPC观察时不得改业务状态为cancelled，必须读真实任务状态。

## 11. C ABI 签名

```c
#include <stdint.h>

typedef struct HetuContext HetuContext;
typedef struct HetuTask HetuTask;
typedef struct {
    uint8_t *data;
    uint64_t size;
} HetuBuffer;

uint32_t hetu_abi_version(void);
int32_t hetu_context_open(const uint8_t *config, uint64_t size,
                          HetuContext **out_context, HetuBuffer *out_result);
int32_t hetu_request(HetuContext *context, const uint8_t *request,
                    uint64_t size, HetuBuffer *out_result);
int32_t hetu_task_start(HetuContext *context, const uint8_t *request,
                       uint64_t size, HetuTask **out_task, HetuBuffer *out_result);
int32_t hetu_task_poll(HetuTask *task, HetuBuffer *out_result);
int32_t hetu_task_cancel(HetuTask *task, HetuBuffer *out_result);
void hetu_task_release(HetuTask *task);
void hetu_context_close(HetuContext *context);
void hetu_buffer_free(HetuBuffer *buffer);
```

正式头文件增加平台导出宏和显式调用约定；上例省略宏以说明所有权。返回整数只表示 ABI 交换是否成功，业务状态看 out_result；输出缓冲由 Core 分配、同一 Core 释放并清空。空句柄、重复释放、长度溢出和内存不足的行为必须在正式头文件明确，跨边界不抛异常。

## 12. 兼容与完成判据

不兼容输入／输出语义修改动作 contract_revision，持久化修改 schema_version，ABI 二进制不兼容修改 ABI 主版本。只发布通过目标入口与平台验证的能力；尚未实现的动作发现为 unavailable，不能通过空成功结果占位。

实现完成需输入正负例、权限、原键重放、异参数冲突、过期版本、取消、断线恢复、并发与跨端结果一致；字段名和命令帮助从正式合同生成，避免三份手工 API 表长期漂移。

## 13. 草稿提交输入合同

新稿与修改稿使用互斥分支；新稿必须给出 title，修改稿必须给出目标文档及基线。剧本为 Fountain，其余文本草稿为 Markdown。Agent 不得设置 actor、审核状态、路径或批准记录。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "HetuSubmitDraftInput",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "package",
    "source_format",
    "content",
    "blueprint_revision",
    "operation_key"
  ],
  "properties": {
    "package": {
      "enum": [
        "novel",
        "drama",
        "music-cue",
        "visual-prompt"
      ]
    },
    "source_format": {
      "enum": [
        "markdown",
        "fountain"
      ]
    },
    "content": {
      "type": "string",
      "minLength": 1
    },
    "blueprint_revision": {
      "type": "integer",
      "minimum": 1
    },
    "operation_key": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "target_document_id": {
      "type": "string",
      "pattern": "^doc_[0-9a-f-]{36}$"
    },
    "base_revision_id": {
      "type": "string",
      "pattern": "^rev_[0-9a-f-]{36}$"
    },
    "parent_draft_id": {
      "type": "string",
      "pattern": "^draft_[0-9a-f-]{36}$"
    },
    "skeleton_ref": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "skeleton_id": {
          "type": "string",
          "pattern": "^skeleton_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "revision": {
          "type": "integer",
          "minimum": 1
        },
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "skeleton_id",
        "revision",
        "sha256"
      ]
    },
    "language_tag": {
      "enum": [
        "zh-CN",
        "en"
      ]
    }
  },
  "oneOf": [
    {
      "required": [
        "title"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "target_document_id"
            ]
          },
          {
            "required": [
              "base_revision_id"
            ]
          }
        ]
      }
    },
    {
      "required": [
        "target_document_id",
        "base_revision_id"
      ]
    }
  ],
  "allOf": [
    {
      "if": {
        "properties": {
          "package": {
            "const": "drama"
          }
        }
      },
      "then": {
        "properties": {
          "source_format": {
            "const": "fountain"
          }
        }
      },
      "else": {
        "properties": {
          "source_format": {
            "const": "markdown"
          }
        }
      }
    }
  ]
}
```

正文内联上限为 UTF-8 1 MiB，标题上限200个 Unicode 字符，操作键为不超过128字符的不透明字符串。Schema 的字符长度与字节预算分别检查；超过预算通过明确的导入入口处理，不静默截断。源 ID、修订归属、设定集范围和权限由领域及应用层校验。

## 14. 草稿成功回执

本例对应第2节请求。提交已完成，因此顶层为 succeeded；`diagnostic_state=not_requested` 表示只保存参考稿，未执行诊断。调用方须另行发起检查，不能将保存成功显示为校验通过或定稿。

```json
{
  "spec_version": "0.2.1",
  "kind": "result",
  "action": "hetu.drafts.submit",
  "contract_revision": "1",
  "status": "succeeded",
  "context": {
    "scope_id": "workspace_33333333-3333-4333-8333-333333333333"
  },
  "operation": {
    "id": "op_44444444-4444-4444-8444-444444444444",
    "key": "draft-submit-001",
    "input_digest": "sha256:3ff85351520551601fc959b6b96ae64fb29b72769c1e661c9a89b8a9ccc9503a",
    "recover_action": "hetu.operations.get"
  },
  "data": {
    "draft_id": "draft_55555555-5555-4555-8555-555555555555",
    "draft_revision": 1,
    "state": "submitted",
    "diagnostic_state": "not_requested"
  }
}
```

原操作摘要使用去掉 operation_key 的固定业务输入；正式规范化采用 RFC 8785 JCS，并发布中文、换行、数字和 Unicode 的跨语言向量。本例仅含整数与字符串，其规范化字节可直接复算。content 不做换行或 Unicode 清洗；把不同正文归一为同一输入会破坏幂等语义。

## 15. 快照阶段合同

| phase | 必填输入 | 持久效果与返回 |
| --- | --- | --- |
| prepare | expected_head、message、author、operation_key；selected_paths 可省略 | 冻结精确文件、HEAD、身份与时间，保存快照；返回 pending、snapshot、snapshot_sha256、operation、approval_state |
| execute | snapshot_id、operation_key | 读取固定快照及本机作者批准，复核后提交；不接受新文件集合、备注或批准布尔值 |

机器输入见 [Git Snapshot Input](../contracts/schemas/git-snapshot-input.schema.json)，固定数据见 [Git Snapshot](../contracts/schemas/git-snapshot.schema.json)。prepare 与 execute 各有独立幂等键；prepare 原键重放保留原 pending 回执，快照当前性由 get_snapshot 单独查询。重复 execute 回读原 commit；所选工作树文件、HEAD 或批准范围变化时阻断，调用方需审阅新快照。批准和执行是独立授权步骤，不允许 Agent 通过 prepare 自行取得提交权。

## 16. 查询、分页与错误约定

查询返回确切读取修订，范围性查询返回 AXI page 或结果 data 中的正式页结构，并提供 next_cursor。结果为空、无权和不存在按既定策略区分，不能通过错误响应泄漏未授权作品。

| 场景 | AXI status／code | 下一步 |
| --- | --- | --- |
| 新稿仅保存成功，尚未请求诊断 | succeeded，data.diagnostic_state 为 not_requested | 按独立诊断动作检查原草稿 |
| Git 快照待作者批准 | pending，含 operation、snapshot 与 approval_state | 在本机审阅固定快照 |
| 异步存储任务已受理，业务未完成 | pending，含 operation 与 task_id | 查询原操作 |
| 基线或正文摘要变化 | blocked／revision_conflict | 读取当前修订并比较 |
| 同键不同固定输入 | blocked／idempotency_conflict | 保留原键，纠正错误关联 |
| 校验完成且发现问题 | succeeded，data.report 含 findings | 作者处理问题，不当作RPC失败 |
| 仅扫描部分范围 | partial，coverage 明确缺口 | 缩小范围或调整明确预算 |
| 外部副作用无法确认 | unknown／result_unknown | recover 原操作，禁止自动重发 |

C ABI 整数码、MCP 协议错误、AXI 执行结果、诊断 findings 和作品审核状态分别表达各自层次，入口不得用一个布尔 success 合并这些状态。

## 17. 建书筹备与外部创作任务

以下为产品设计动作，不因本章存在而自动加入运行目录。动作发布时提供独立 inputSchema／outputSchema、权限及合同修订；客户端和 Skill 只调用实际发现的能力。通用幂等、CAS、事务与错误约定沿用第3节，scope 支持单一 creation_project 或 workspace，不开放整库扫描。

| 动作 | 输入 | 输出 | 入口与边界 |
| --- | --- | --- | --- |
| `hetu.creation_projects.create` | 打开参数 `creation_project_path` 与 `create_project={brief,locale,operation_key}` | 独立 project 与修订摘要 | 仅作者的 scope 创建入口；书名可未定，不创建正式作品，不伪装为普通 request 动作 |
| `hetu.creation_projects.get` | project_id、revision? | 已获权筹备及来源投影 | 不返回其他筹备或全部作品位置 |
| `hetu.creation_projects.save` | project_id、expected、brief、selected_fields、operation_key | 新筹备修订 | 仅作者；选中字段记录候选引用或手工来源 |
| `hetu.creation_projects.create_novel` | project_id、expected、作者确认的 metadata、target_path、operation_key | workspace、novel、创建回执和来源 | 仅作者；来源从已保存 selected_fields 核验，新作品身份固定，未知结果查原目标与原键，跨卷恢复按07 |
| `hetu.creative_tasks.preview_prompt` | scope_ref、task_kind、brief、input_refs、client_adapter、language_tag、candidate_limit?、edit_scope? | 外发资料、完整可编辑 Prompt、prepare_input、输出合同 | 仅作者；本地模板，无模型、无落盘；Skill 由任务类型确定 |
| `hetu.creative_tasks.prepare` | 固定预览输入、作者编辑后的 Prompt、expected_scope、operation_key | 不可变 task_ref、请求摘要、可复制调用说明 | 仅作者；不启动客户端、不发送消息、不调用生成服务 |
| `hetu.creative_tasks.get` | task_ref、submission_id? | 固定请求、请求摘要、选定批次候选、交互决定及观察状态 | Agent 只读当前获权任务；Prompt 不含秘密；缺省读取最新批次 |
| `hetu.creative_tasks.list` | 当前 scope、state?、cursor?、limit? | 任务摘要与 next_cursor | 游标绑定 scope／身份／筛选，默认20、最多100；不跨作品 |
| `hetu.creative_tasks.submit_result` | task_ref、request_sha256、candidates、complete、missing_items、provenance、operation_key | submission_ref、submission、expected、approval_state | Agent 可在精确任务提交；候选内容／固定 inbox 文件／改稿 patches 三选一；禁止任意路径和作者决定字段，不自动采纳 |
| `hetu.creative_tasks.inspect_inbox` | task_ref、file_name、manifest_sha256、operation_key | 核验后的提交回执或具体错误 | 只检查该任务 inbox 内的指定清单；摘要不符或半写入不登记，原键不重复导入 |
| `hetu.creative_tasks.close` | task_ref、expected、reason、operation_key | 本机跟踪关闭记录 | 仅作者；不取消外部 Agent、不声称退款或删除文件 |
| `hetu.creative_tasks.mark_copied` | task_ref、request_sha256、operation_key | copied_at、观察状态及 expected | 仅作者；记录实际复制，不显示 Agent 已启动 |

文本候选复用 Markdown／Fountain 与 UTF-8 1 MiB 单稿预算；图片复用34的类型、尺寸及单图32 MiB预算。数量与请求合同取交集；新任务默认候选不超过4项，扩展上限由明确动作 Schema 发布。内联文本和文件来源互斥，不能将 HTTP URL 解释为自动下载指令。

submit_result 先检查原键；请求摘要不符、跨 scope、目录逃逸、超出预算或格式不符分别返回明确阻断。合法但不足请求数量可返回 partial 并列明缺项，不能隐式产生更多生成请求。provenance 为来源声明，不承担版权认证或宿主身份认证。

建书前的封面探索使用 creation_project scope 的 cover 任务；正式作品的 CoverRequest 保持34定义的 workspace 合同。作者创建作品后显式导入选定筹备候选，不给旧筹备会话增授作品权限。

### 17.1 受限改稿合同

机器输入及持久记录以[creative-task.schema.json](../contracts/schemas/creative-task.schema.json)为准。`task_kind=revision` 必须提供 `edit_scope={document_id,revision_id,ranges}`，该文档及修订也必须列入 `input_refs`；准备时必须仍是当前作者文档。`input_refs` 允许额外固定章节和设定供参考，不赋予这些对象的修改权。单篇原文及候选各不超过 UTF-8 1 MiB，序列化参考上下文总预算2 MiB；超限拒绝而不截断。

`ranges` 是1～16个不重叠的 UTF-8 半开范围，每项包含 `byte_start,byte_end,quote`，空范围为作者指定的插入点。整章必须显式传完整范围；传入空数组、缺省范围或其他任务类型的 edit_scope 均不解释为全部授权。修改目标或范围须新任务，不能由 Agent 修改固定请求。

改稿候选使用 `patches`，每项包含 `byte_start,byte_end,quote,replacement`，最多64处。原文、字符边界和范围包含关系须全都匹配；同点重复插入、重叠、NUL、越界或整章 `content` 替换均拒绝。合法补丁由 Core 在固定原文上合成为独立候选及参考稿，范围外字节不变。插入允许授权范围的两端；需要更窄限制时作者选择精确插入点。

候选提交不要求当前写作稿仍等于基线：作者等待期间可继续写作，迟到结果仍保存旧来源。正式采纳必须按第7节重新固定当前稿和比较预览；不能把提交成功当作正文保存、检查通过或定稿。任一候选非法时整批不登记，不能仅裁掉越界部分后返回完成。

任务连接只开放能力发现、原操作查询、当前任务读取与提交、局部投影及选择；每次请求重新核验绑定任务与关闭状态。普通工作区连接的通用权限不能因工具名存在而扩大到所有创作任务。相同动作及操作键在不同任务中隔离，知道其他任务的 ID、请求摘要或 operation ID 不授予访问权。

## 18. 局部选择与页面会话

| 动作 | 输入 | 输出 | 权限与效果 |
| --- | --- | --- | --- |
| `hetu.interactions.get` | task_ref | 单任务投影、image_previews、允许的局部动作 | 固定请求、当前批次候选与最后偏好；图片为本机核验后的等比 JPEG 缩略图，不含其他作品 |
| `hetu.interactions.save_selection` | task_ref、candidate_refs、expected、comment、operation_key | 固定 InteractionDecision 和新修订 | 受限交互会话；选择偏好不等于采纳、定稿或正式封面选用 |

同一内容视图有两种适配：MCP Apps 使用宿主工具桥接与 ui 资源；本地网页使用已配对的回环会话和 Node.js 白名单代理。普通网页不调用假定存在的 `window.openai`，MCP App 也不通过任意 fetch 绕过宿主权限。

`get` 与 `save_selection` 的实际输入由 [creative-task.schema.json](../contracts/schemas/creative-task.schema.json) 定义。`image_previews[]` 每项包含 `candidate_id,media_type,base64,width,height`，媒体类型固定 `image/jpeg`，最长边不超过512像素，不放大源图，单图不超过256 KiB；只为已核验归属的当前批次图片生成，不接受路径或下载 URL。

页面进程归原生应用会话管理，使用 `LocalTaskViewSession.start`、`approve`、`deny`、`stop`；这些是原生适配接口，不登记为 Core 动作或 Agent 工具。`start` 从可信当前作品／筹备与 `task_ref` 打开 agent 模式的任务句柄；`approve` 只能接受该实例经私有 IPC 提交的待配对引用。浏览器不能构造作者批准或切换句柄。停止不修改任务内容，不生成业务 operation_key。

| 本地 HTTP 路由 | 合同 |
| --- | --- |
| `GET /`、`GET /host.js` | 固定配对页面和宿主脚本，不含作品资料 |
| `GET /api/session` | 建立随机 HttpOnly、SameSite=Strict Cookie，返回同源 CSRF；配对前不返回 task_ref |
| `POST /api/pair` | 空 JSON、精确 Origin、Cookie 与 CSRF；仅向原生端发送配对请求和六位核对码 |
| `GET /view.html` | 已配对会话可读取静态 Apps 内容；iframe 使用 allow-scripts 沙箱 |
| `POST /api/rpc` | 已配对会话；仅投影 open_task_view、save_task_selection 和当前任务 save_selection 原键查询；请求上限128 KiB |
| `GET /api/events` | 已配对会话接收撤权事件；单会话最多两个连接 |

Node 与原生端以私有 stdio JSONL 通信，IPC 修订为1。原生端发送 start、authorize、deny、response、stop；Node 发送 ready、pair_request、request、stopped。每个消息绑定随机 view_id，业务请求另带随机 id；原生端再次检查动作及 task_ref，并经受限 Core 句柄执行。Node 无业务文件路径、作者句柄或任意命令入口。

配对请求有效期2分钟、已批准会话最多15分钟、页面实例最多30分钟。实例最多16个浏览器会话、32个连接、8个在途业务请求；单请求等待12秒，超时不自动重发保存。失回执使用原键查询。停止、父进程 EOF、实例到期或任务关闭均撤权；原生端以2秒间隔复核任务权限，当前任务变更／页面所属视图退出时同步停止旧实例。

停止页面不回滚已经进入 Core 的在途写入，也不表示外部生成取消。迟到回执按 view_id 丢弃，不转入新任务；原任务的实际写入结果由作者或重新获权的原任务连接沿原键查询。

这些是领域动作名，不是可随意 POST 的通用 HTTP execute。局部 HTTP 路由仅投影允许的动作，检查 Host、Origin、CSRF、会话及预算，再以应用组装的 scope 调用本机 IPC；浏览器不得选择任意 actor、root、action 或命令。精确页面路由属于版本化实现合同，不能把开发用固定端口写入插件。

## 19. MCP 工具投影与兼容

八个基础工具保持原有业务范围；创作任务通过新增窄工具投影，不把 `hetu_list_workspace` 扩展成书库访问，也不把旧 `hetu_write_draft` 偷换为任意 JSON 或媒体写入入口。

| 任务连接工具 | 应用动作 | 可见性与边界 |
| --- | --- | --- |
| `hetu_read_creative_task` | creative_tasks.get | 获权任务读取，返回结构化文本及候选引用 |
| `hetu_submit_creative_result` | creative_tasks.submit_result | 固定任务的候选提交，无采纳或定稿能力 |
| `hetu_open_task_view` | interactions.get | 支持 Apps 的任务连接关联 `ui://hetu/task-view/1`；其他宿主返回相同业务数据，HTML 与宿主版本分别验收 |
| `hetu_save_task_selection` | interactions.save_selection | 只对绑定任务记录偏好，服务端重新核验授权；不冒充作者采纳 |

新增工具须同步 `contracts/tools/catalog.json`、Schema、宿主矩阵、Skill 方法及权限负例。用户复制 Prompt 是缺省交接方式；任何消息桥接都不能自动向另一会话发送内容、启动 Agent 循环或扩大授权。
