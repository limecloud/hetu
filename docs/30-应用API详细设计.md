# 应用 API 详细设计

API 为共享应用用例合同，供原生 GUI、Swift CLI、MCP 及按需局部页面适配；V1 不引入必装 HTTP 后端。Node.js 页面通过受限本机 IPC 消费白名单用例，不能绕过 Core 直接写文件。领域见[28](28-领域设计与边界上下文.md)，字段语义见[29](29-数据字典与Schema设计.md)。

本章定义产品设计面；调用方仅使用当前构建能力发现实际发布的动作。专项设计或 Schema 文件的存在不表示动作已经实装。

## 1. 入口、权限与版本

| 入口 | 可调用范围 | 身份来源 |
| --- | --- | --- |
| macOS／Windows GUI | 用户授权的完整人工任务 | 本机可信窗口、系统访问与作者会话 |
| Swift CLI 人工模式 | 同一核心任务，支持交互确认 | 控制终端与本机作者会话 |
| MCP Agent | 获权查询、协作候选维护、资料草稿、派生结构、报告、受限交付 | 已批准的 Server 上下文，非 clientInfo 自报 |
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
| `hetu.workspaces.get` | 空对象 | 工作区配置、`properties={schema_version,workspace_id,created_at,updated_at}`、包、覆盖与 `access.write_available` | 时间未知为 null，读取不更新时间；使用入口已授权 scope；写入者存在时仍可查询，是否可写仅为即时状态，保存仍检查锁与修订 |
| `hetu.workspaces.list` | 空对象 | 当前授权工作区、同一 properties 与包配置 | 对应 MCP list_workspace；不扫描其他作品，正文目录独立查询 |
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
| `hetu.documents.preview_import` | inline_source 或作者选择的 file_path、format、profile | 固定文件摘要、转换预览与损失报告 | 机器提交文件字节，作品授权不能读取任意本机路径；不执行宏 |
| `hetu.documents.import` | preview、kind、title、language_tag、volume_id?、acknowledgement、operation_key | ImportRecord、文档及修订 | 作者确认或获批固定管理方案；核验原字节，保留非定稿状态与原键恢复 |
| `hetu.documents.import_batch` | expected、items[1..32]、acknowledgement、operation_key | documents、novel、revision、sha256 | 每项含 source、title、language_tag、volume_id；同批原子导入全部原稿和目录，一项失败不公开部分章节 |
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

[建立剧本输入](../contracts/schemas/drama-script-input.schema.json) 必须明确骨架修订与摘要；标题由 Agent 按作者目标准备，允许手动调整，`language_tag` 只接受 `zh-CN|en`。结构渲染保留未知字段，不能直接表示的标题／地点返回 `hetu.format_unrepresentable`，输出预算超限返回 `hetu.budget_exceeded`；写入受原键重放与明确执行授权保护。来源为部分剧情时，创建与映射读取继续返回 `partial`。历史基线允许建立独立文档并明确返回 stale；不更新或覆盖现有剧本。

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

外部 `hetu-cover` Skill 读取请求并写入固定 inbox，不需要增加图像生成工具。核心不代理图像 API；候选回执不具有作者身份，也不能调用选用操作。

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
int32_t hetu_model_service_request(const uint8_t *request, uint64_t size,
                                  HetuBuffer *out_result);
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

以下为产品设计动作，不因本章存在而自动加入运行目录。动作发布时提供独立 inputSchema／outputSchema、权限及合同修订；客户端和 Skill 只调用实际发现的能力。通用幂等、CAS、事务与错误约定沿用第3节，scope 支持单一 creation_project 或 workspace，不开放整库扫描。表中“仅作者”说明当前底层入口的身份要求；默认 Agent 建书通过第25节的操作提案和限定执行合同衔接，由 Core 验证确切决定及授予范围，不向 Agent 开放通用作者身份。入口覆盖由20第7节追踪。

| 动作 | 输入 | 输出 | 入口与边界 |
| --- | --- | --- | --- |
| `hetu.creation_projects.create` | 稳定入口 `{brief,locale,operation_key}`；可信作者另可使用打开参数 `creation_project_path` 与 `create_project` | 独立 project、修订摘要、管理引用及预留目标 | 稳定入口仅分配全新受管目录，不接管已有范围；书名可未定，不创建正式作品 |
| `hetu.creation_projects.get` | project_id、revision? | 已获权筹备及来源投影 | 不返回其他筹备或全部作品位置 |
| `hetu.creation_projects.save` | project_id、expected、brief、selected_fields、work_profile?、operation_key | 新筹备修订 | 仅作者；选中字段记录候选引用或手工来源；work_profile 保存作品类型、改编方式和正文语言，缺省保留原选择 |
| `hetu.creation_projects.create_novel` | project_id、expected、metadata、target_path、operation_key；稳定入口另带 management_ref | workspace、novel、创建回执、来源及新管理引用 | 作者或确切有限新建授权；来源从已保存 selected_fields 核验，新作品身份固定，未知结果查原目标与原键，跨卷恢复按07 |
| `hetu.creation_projects.create_drama` | project_id、expected、profile={title,description,mode,language_tag}、target_path、operation_key；稳定入口另带 management_ref | 剧本作品、首个短剧项目、创建回执、来源及新管理引用 | 作者或确切有限新建授权；不创建空小说；mode 为 original 或 adaptation；跨目录创建先保存意图，恢复不重复建项目 |
| `hetu.creative_tasks.preview_prompt` | scope_ref、task_kind、brief、input_refs、client_adapter、language_tag、candidate_limit?、edit_scope? | 外发资料、完整可编辑 Prompt、prepare_input、输出合同 | 仅作者；本地模板，无模型、无落盘；Skill 由任务类型确定 |
| `hetu.creative_tasks.prepare` | 固定预览输入、作者编辑后的 Prompt、expected_scope、operation_key | 不可变 task_ref、请求摘要、可复制调用说明 | 仅作者；不启动客户端、不发送消息、不调用生成服务 |
| `hetu.creative_tasks.get` | task_ref、submission_id? | 固定请求、当前请求引用、成果摘要、反馈游标及观察状态 | Agent 只读当前获权任务；不内联全部原文或历史候选，具体内容通过固定引用读取 |
| `hetu.creative_tasks.list` | 当前 scope、state?、cursor?、limit? | 任务摘要与 next_cursor | 游标绑定 scope／身份／筛选，默认20、最多100；不跨作品 |
| `hetu.creative_tasks.submit_result` | task_ref、request_sha256、candidates、complete、missing_items、provenance、operation_key | submission_ref、submission、expected、approval_state | Agent 可在精确任务提交；候选内容／固定 inbox 文件／改稿 patches 三选一；禁止任意路径和作者决定字段，不自动采纳 |
| `hetu.creative_tasks.inspect_inbox` | task_ref、file_name、manifest_sha256、operation_key | 核验后的提交回执或具体错误 | 只检查该任务 inbox 内的指定清单；摘要不符或半写入不登记，原键不重复导入 |
| `hetu.creative_tasks.close` | task_ref、expected、reason、operation_key | 本机跟踪关闭记录 | 仅作者；不取消外部 Agent、不声称退款或删除文件 |
| `hetu.creative_tasks.mark_copied` | task_ref、request_sha256、operation_key | copied_at、观察状态及 expected | 仅作者；记录实际复制，不显示 Agent 已启动 |

文本候选复用 Markdown／Fountain 与 UTF-8 1 MiB 单稿预算；图片复用34的类型、尺寸及单图32 MiB预算。数量与请求合同取交集；新任务默认候选不超过4项，扩展上限由明确动作 Schema 发布。内联文本和文件来源互斥，不能将 HTTP URL 解释为自动下载指令。

submit_result 先检查原键；请求摘要不符、跨 scope、目录逃逸、超出预算或格式不符分别返回明确阻断。合法但不足请求数量可返回 partial 并列明缺项，不能隐式产生更多生成请求。provenance 为来源声明，不承担版权认证或宿主身份认证。

建书前的封面探索使用 creation_project scope 的 cover 任务；正式作品的 CoverRequest 保持34定义的 workspace 合同。作者创建作品后显式导入选定筹备候选，不给旧筹备会话增授作品权限。

### 17.1 受限改稿合同

任务输入及持久记录以[creative-task.schema.json](../contracts/schemas/creative-task.schema.json)为准。`task_kind=revision` 必须提供 `edit_scope={document_id,revision_id,ranges}`，该文档及修订也必须列入 `input_refs`；准备时必须仍是当前作者文档。`input_refs` 允许额外固定章节和设定供参考，不赋予这些对象的修改权。新请求记录1.1.0固定最多100个明确资料引用，单篇文本及候选各不超过 UTF-8 1 MiB；get 只返回目录元数据，原文通过第23节分段读取。序列化目录、作品上下文和资料任务快照总预算2 MiB，不把整书正文计入这份内联预算。1.0.0历史记录按原合同读取，字节及摘要不重写。

`ranges` 是1～16个不重叠的 UTF-8 半开范围，每项包含 `byte_start,byte_end,quote`，空范围为作者指定的插入点。整章必须显式传完整范围；传入空数组、缺省范围或其他任务类型的 edit_scope 均不解释为全部授权。同一改稿目标的范围或基线变更由作者按第23节发布新的请求修订；其他文档的独立改稿另建关联任务。Agent 不能修改固定请求。

改稿候选使用 `patches`，每项包含 `byte_start,byte_end,quote,replacement`，最多64处。原文、字符边界和范围包含关系须全都匹配；同点重复插入、重叠、NUL、越界或整章 `content` 替换均拒绝。合法补丁由 Core 在固定原文上合成为独立候选及参考稿，范围外字节不变。插入允许授权范围的两端；需要更窄限制时作者选择精确插入点。

候选提交不要求当前写作稿仍等于基线：作者等待期间可继续写作，迟到结果仍保存旧来源。正式采纳必须按第7节重新固定当前稿和比较预览；不能把提交成功当作正文保存、检查通过或定稿。任一候选非法时整批不登记，不能仅裁掉越界部分后返回完成。

任务范围只开放能力发现、原操作查询、获权任务读取与成果维护、局部投影及选择；每次请求重新核验显式 task_ref、授权版本及关闭状态。稳定入口与持续协作按第23节投影，不因工具名存在而扩大到其他任务或正文。相同动作及操作键在不同任务中隔离，知道其他任务的 ID、请求摘要或 operation ID 不授予访问权。

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

工作区工具保持各自业务范围；创作任务按获权任务类型投影窄工具，不把 `hetu_list_workspace` 扩展成书库访问，也不把 `hetu_write_draft` 改成任意 JSON 或媒体写入入口。资料任务提供资料查询、新增及更新工具，不暴露文字候选提交或作者采用动作。

| 任务连接工具 | 应用动作 | 可见性与边界 |
| --- | --- | --- |
| `hetu_read_creative_task` | creative_tasks.get | 获权任务读取，返回结构化文本及候选引用 |
| `hetu_submit_creative_result` | creative_tasks.submit_result | 固定任务的候选提交，无采纳或定稿能力 |
| `hetu_open_task_view` | interactions.get | 支持 Apps 的任务连接关联 `ui://hetu/task-view/1`；其他宿主返回相同业务数据，HTML 与宿主版本分别验收 |
| `hetu_save_task_selection` | interactions.save_selection | 只对绑定任务记录偏好，服务端重新核验授权；不冒充作者采纳 |

新增工具须同步 `contracts/tools/catalog.json`、Schema、宿主矩阵、Skill 方法及权限负例。用户复制 Prompt 是首次交接方式；继续修改支持第23节的显式反馈接续，任何消息桥接都不能向另一会话发送内容、启动 Agent 循环或扩大授权。当前工具目录与持续协作设计面分别验收，未发布动作用能力缺口表达。


## 20. 短剧项目与语义编辑合同

本节与第21节定义新增设计面，动作进入能力目录前须落实精确 Schema、权限、错误和恢复测试。作者入口与获权 Agent 入口共享领域实现，不能让 Agent 通过伪造作者模式调用正式保存。

| 动作 | 固定输入与结果 | 权限与不变量 |
| --- | --- | --- |
| `hetu.drama.projects.list/get` | 项目筛选、分页／project_id；返回资料、修订及有序分集引用 | 获权读取；不按名称推断原著 |
| `hetu.drama.projects.create` | title、description?、mode?、source_refs?、operation_key | 作者建立正式项目；原创无来源，改编可先留空并显示待补来源；固定来源逐项核验文档修订和摘要 |
| `hetu.drama.projects.update` | project_ref、title、description、archived、source_refs?、operation_key | 作者保存；project_ref 固定项目 ID、revision 与 sha256；创作方式不可改，补充来源仍核验固定原文 |
| `hetu.drama.episodes.create/update` | project_ref、资料、可选骨架映射；返回分集与文档引用 | 作者创建或维护正式分集；项目及分集分别 CAS，同事务更新，不重复保存集号 |
| `hetu.drama.episodes.get` | episode_id、revision? | 读取当前或历史分集资料，返回 sha256、is_head；显示集号由当前项目目录计算 |
| `hetu.drama.episodes.reorder` | project_ref、完整且不重复的 episode_refs、operation_key | 作者操作，目录是集号的唯一来源；归档通过分集 update 的 archived 字段保存，保留历史正文和定稿 |
| `hetu.drama.scripts.inspect` | document_ref、解析版本 | 读取具体 Fountain 修订的元素、场次、角色候选和诊断；不落业务数据 |
| `hetu.drama.scripts.save` | document_id、base_revision_id、语义变更、原键 | 作者保存；闭合段落操作转换为唯一 Fountain 源文，正文与语义索引同事务 |
| `hetu.drama.storyboards.get/save` | 固定场次、镜头与素材引用；写入带 expected 和原键 | 作者正式保存；Agent 仅在明确候选范围维护分镜提案 |
| `hetu.drama.segments.get/save` | 固定镜头、ModelProfile、参考、提示词与候选引用 | 与外部任务相连；不发送生成请求、不把片段完成变成剧本定稿 |

列表/get 是动作族的展示简写，每个实际动作独立 Schema。骨架创建与初稿映射继续遵循第6节；这里的分集是写作对象，不复用骨架 ID。语义保存执行 base CAS、UTF-8 范围与源文字节校验；不允许调用方把解析结果当作另一份完整剧本文字提交双写。

Agent 需要协作时，先发现当前能力与作品摘要，读取固定项目、正文或选区，取得具体任务授权，再提交或维护该任务的分集计划、剧本、分镜和片段候选。正式建集、改正式剧本、素材选用及定稿依然是作者用例。

## 21. 资料、设计与素材协作合同

| 动作 | 输入与结果 | 边界 |
| --- | --- | --- |
| `hetu.resources.list/get` | 分类、project_id、标签、状态、字段投影、分页／固定资源引用 | 只返回获权范围；列表不读取全部二进制或整本正文 |
| `hetu.resources.create/update` | title、category、body、tags、project_id、entity_refs、source_notes、原键；更新增加 resource_id 与 expected | 作者维护；绑定 resource_organize 的 Agent 只维护获权草稿或本任务创建的草稿；状态不接收外部赋值 |
| `hetu.resources.adopt/archive` | resource_id、expected={revision,sha256}、operation_key | 仅作者；历史引用保留，更新资料不自动替换已有使用位置的固定修订 |
| `hetu.designs.list/get/create/update` | 资料引用、设计字段、固定参考、expected?、task_ref?、原键 | 与资料相同的草稿边界；既有采用版本的 Agent 修改提交新提案 |
| `hetu.designs.adopt/archive` | 固定设计引用、expected、原键 | 仅作者，不回写设定集 |
| `hetu.asset_candidates.submit/get/list` | 任务与请求摘要、固定设计、文件清单、来源声明、原键／候选筛选 | Agent 从受管 inbox 提交，逐项核验后整批登记；候选文件不可覆盖 |
| `hetu.asset_selections.preview/select/withdraw` | 用途、目标、固定候选、当前决定引用、原键 | 作者选用／撤回；预览无写入；封面委托既有 BookCover 用例，保持唯一封面头 |
| `hetu.resource_usages.list/save` | 固定资料／设计／候选与目标位置、expected?、task_ref?、原键 | 作者正式保存；Agent 只维护本任务候选中的使用提案 |
| `hetu.resources.preview_import/import` | 作者选定来源范围、固定清单、来源映射、原键 | 显式跨作品导入，生成本作品独立身份与受管字节；不接受 Agent 任意路径 |
| `hetu.model_profiles.list/get` | 媒体类型、能力／固定档案引用 | 静态能力资料与来源，不含 Key、账号、在线可用性或模型调用入口 |

### 21.1 任务授权与批量操作

授权固定 `task_ref, scope_ref, allowed_actions, object_refs, editable_fields, input_refs, limits, expires_at` 及本机主体与授权修订，由可信入口创建并在 Core 检查；版本语义见第23节。读参考、改草稿、提交文件、作者采用分别授权；Agent 不传作者身份、角色或批准布尔值。关闭任务或撤权后先拒绝请求，再处理已知操作键，不能用原回执泄漏失权数据。

同一任务可在预算内连续提交多个候选和资料草稿修订，无需每个字段重新询问作者。批量请求固定每项 CAS 与输入，约定全部校验后原子提交；不提供无限批量或任意 JSON Patch。默认每批最多50条，单批元数据不超过4 MiB；二进制按文件合同单独流式核验。能力发现公布实际限额，客户端不能将 partial 当整批成功。

### 21.2 文件组、查询与恢复

提交清单最后原子落入固定任务 inbox。路径只能是该任务下普通文件的相对路径，拒绝逃逸、链接、设备、重复路径及正在写入的文件；每项绑定字节数和摘要。根据类型执行独立验证；图片核对真实尺寸、像素限额与 alpha，视频／音频记录探测与解码覆盖，源工程按附件合同接收，不运行脚本或宏。合法组缺少某输出可显式 partial，非法字节整批不登记。

查询提供摘要、选定字段、受管预览与明确分页；固定引用读取返回记录及当前性，历史读取不悄悄转向 head。使用位置分页按实际引用查找，不能为展示一个缩略图扫描全书和读入所有媒体。

新动作用第3节的原键协议；重放返回原对象及摘要，不重复登记、选用或复制。错误至少区分 `permission_denied, revision_conflict, stale_input, invalid_reference, unsupported_media, invalid_file_group, capability_mismatch, budget_exceeded, task_closed`，实际完整命名与细分由发布 Schema／错误目录统一。基于当前资料的冲突必须重读与比较，不能自动修改 expected 后覆盖作者内容。

## 22. 创作场景与原著材料合同

创建和导入共用[36](36-创作场景与引导流程.md)的场景规则。引导只收集当前任务必需输入，CLI 和 Agent 获得相同的结构、缺项与恢复信息，不能只在 GUI 做判断。以下来源动作为领域设计面，进入能力目录须有对应 Schema、策略与恢复测试。

| 动作族 | 输入与结果 | 权限与边界 |
| --- | --- | --- |
| 作品创建／创建预览 | work_type、最小资料、明确目标、原键 | 作者建立小说或剧本；剧本不要求 Novel metadata；无书名先保存筹备 |
| `hetu.sources.preview_import/import` | 作者所选文件、固定摘要、用途、版本、来源说明、rights_draft、原键 | 导入独立原著材料，不当小说章节写入；预览无业务写入，确认后整批公开 |
| `hetu.sources.list/get` | 来源筛选、固定 source_ref、分页 | 获权原著读取；任务只读所选范围，不自动取得整本或其他作品 |
| `hetu.sources.update_rights` | source_ref、expected_rights_ref、用途范围与依据、原键 | 仅作者；保留历史，不能由 Agent 声称获得授权 |
| `hetu.drama.projects.set_sources` | project_ref、固定来源、角色、范围、原键 | 作者确认项目原著关系；不覆盖剧本或自动重建映射 |
| 稿件导入预览／执行 | purpose、目标作品／项目、原文件摘要、作者校正结构及损失确认 | 明确区分小说正文、分集剧本、改编原著及参考资料，不按扩展名自动决定用途 |
| 任务准备／交付预览 | 固定来源、拟外发范围、用途与当前权利 | 按材料返回允许、排除或待确认项；缺材料不阻断本机阅读和独立写作 |

原著引入、授权声明、正式正文保存和定稿分别是独立动作。来源登记成功不代表确认版权，允许改编不代表允许把整本原著传给 Agent 或放进交付包。失败返回具体材料、具体缺项与可继续的本机任务，不能只返回全项目“无权限”。

创建或导入回执丢失沿原键恢复；更换作品类型、导入用途或目标目录是新意图，需要新预览，不能修改原输入后复用旧键。表单缓冲由本机保存，不进入 Git／Bundle；正式作品和来源记录才进入受管事务。

## 23. 持续协作与任务接续合同

本节定义稳定接入、按需上下文、可持续编辑的参考稿和反馈接续的目标合同。动作只有在机器 Schema、权限投影、分发与验收同步完成后才进入能力目录；实现准入由[20](20-实施路线与里程碑.md)维护。以下动作名不能作为已安装客户端的调用依据。

### 23.1 任务定位与版本

`TaskLocator={scope_ref,task_id}` 定位持续任务；`RequestRef={task_id,request_revision,sha256}` 固定一次不可变请求。业务调用使用包含 scope 与 RequestRef 的 `task_ref`，成果、反馈及操作都保存它。稳定入口只从本机已批准映射解析 TaskLocator；绝对路径、全书库扫描、全局 activeTask、URL 中的令牌或调用方指定的作者身份均不属于协议。交接引用可复制，但没有权限含义。

| 动作 | 输入 | 输出与效果 |
| --- | --- | --- |
| `hetu.collaboration.inspect` | 客户端实际协商信息 | 本机助手、合同与可用功能；未获任务权不返回作品名、目录或内容，不持久写入 |
| `hetu.collaboration.open` | task_locator、known_request_ref? | 当前 task_ref、目标、已确定事实引用、允许动作、上下文入口、成果／反馈摘要及可恢复操作；仅获权任务，分页读取历史 |
| `hetu.creative_tasks.revise_request` | task_locator、expected_request_ref、作者确认的新 brief／context_manifest／edit_scope／输出合同、expected_grant_revision、operation_key | 新请求修订、摘要及新授权版本；仅可信作者，先预览外发差异，事务保留旧请求 |

`open` 不创建任务、不扩权、不运行 Agent。请求 head 与授权版本在同一可恢复本机操作中发布，发布前旧权限继续按旧合同；发布后旧请求不能再保存或提交新成果，返回 `stale_request` 和获权范围内的当前引用。已提交的原操作在仍获权时可沿原键读取，不因请求升级重新执行；撤权优先于回执读取。旧工作副本可读，新请求要复用时显式创建后继副本并记录来源，不隐式重定基线。

同目标的偏好和返工不更新请求，使用反馈；上下文、改稿基线、可改范围和输出预算的变化才修订请求。切换作品、筹备转作品或完全不同目标使用新任务。改稿仍固定一个目标文档，多个文档各有明确子任务，不引入任意整书写权限。

### 23.2 按需读取与补充资料

| 动作 | 输入 | 输出与边界 |
| --- | --- | --- |
| `hetu.task_context.list` | task_ref、kind?、cursor?、limit? | 已授权固定资料的目录、摘要来源、字节量及窄读取引用；不含未授权对象的标题或命中数 |
| `hetu.task_context.read` | task_ref、context_ref、range?、section?、entity_id?、cursor?、limit?、max_bytes? | 固定修订的原文或设定实体、准确范围与摘要、剩余读取入口；不跟随当前 head |
| `hetu.task_context.search` | task_ref、query、kind?、cursor?、limit? | 授权固定集合内的命中、片段、SourceRef、索引／扫描覆盖及下一页；不静默补全未覆盖资料 |
| `hetu.task_context.request_material` | task_ref、所需对象或资料说明、purpose、requested_range?、operation_key | 待作者处理的具体缺项及 request_id；不读取或授予新内容，不自动阻塞无关工作副本 |
| `hetu.task_context.resolve_material_request` | 固定缺项请求、expected、provided／declined、resolution_ref?、operation_key | 仅作者记录处理结果；provided 必须引用实际已发布的新请求及材料，不能只改状态授予权限 |

目录和搜索默认20条、最多100条；单次原文读取默认16 KiB、最多64 KiB，默认按段落边界返回实际范围。不能通过将 max_bytes 设大来返回整本；超过单次预算给继续入口，不截掉字符。游标绑定授权主体、任务、请求、筛选及快照，失效后显式重新查询。大作品按目录与固定片段访问，不受“把所有原文内联到一次 get”的设计约束；实际容量仍由能力目录公布并经规模验收。

`read.range={byte_start,byte_end?}` 使用固定原文的 UTF-8 字节边界，byte_end 缺省为原文末尾；回执返回准确 SourceRef、range、complete 和 next_range。文本搜索按字面匹配，每篇返回首个命中及附近片段；coverage 声明 first_per_entry、已扫描文档数及未检索的结构化资料数，不伪装语义搜索或全部命中。

设定集在预算内可整份读取；超过预算返回六类目录 `sections`，不截断 JSON。`section` 取 `characters/factions/locations/timeline/world/rules`，先分页返回实体的 ID、名称、字节量及实体摘要，再以 `section + entity_id` 读取固定实体。实体回执同时保留整份设定集的固定引用与摘要，并单列 `entity_sha256`；不是文本 SourceRef，也不暗示其他实体已读取。目录分页同样受字节预算约束，单个实体超过预算明确拒绝。`range` 与结构选择互斥；文本不接受 section／entity_id，实体读取不接受游标。目录及实体均来自任务获准的设定集修订。

文本原文返回精确 SourceRef；结构化资料返回固定记录及摘要，媒体返回获权预览／文件引用，不把原图或视频当文本切片。

作者在缺项面板提供、缩小或拒绝资料。提供获准材料时通过 revise_request 固定新清单及授权，新增读取不隐含新增可改范围。拒绝记录结果及可继续的步骤；Agent 可提交明确缺项的部分成果。原著外发权限仍按第22节逐材料核对。自动摘要及 Agent 摘要必须注明来源与覆盖，不能替代原文证据。

### 23.3 可编辑参考稿与固定候选

| 动作 | 输入 | 输出与不变量 |
| --- | --- | --- |
| `hetu.working_copies.create` | task_ref、artifact_kind、source_format、title、base_refs、content 或 patches、parent_ref?、feedback_refs?、operation_key | 工作副本身份、首修订和固定请求引用；仅本任务允许类型，不创建正式章节／分集 |
| `hetu.working_copies.get` | task_ref、working_copy_ref | 固定修订、内容或窄内容引用、当前头与修订历史；旧修订不转读最新 |
| `hetu.working_copies.list` | task_ref、cursor?、limit? | 本任务参考稿身份、标题与当前固定修订，不返回其他任务或正文列表 |
| `hetu.working_copies.save` | task_ref、working_copy_id、expected、content或patches、feedback_refs、operation_key | 新参考修订、摘要和回执；同一副本 CAS，作者与 Agent 竞争不自动覆盖 |
| `hetu.working_copies.checkout` | task_ref、working_copy_ref、operation_key | 可选文件编辑交接：任务临时目录内的安全相对位置、基线摘要、格式、大小限制和 checkout_id；不授予 OS 任意目录权 |
| `hetu.working_copies.import_checkout` | task_ref、checkout_id、expected、file_sha256、operation_key | 核验普通文件、归属、字节与基线后导入新参考修订；原文件仍变化则冲突，不登记半稿 |
| `hetu.creative_tasks.submit_result` 扩展 | 固定 task_ref、request_sha256、working_copy_refs 或既有候选输入、feedback_refs、complete、missing_items、provenance、operation_key | 固定批次、候选／Draft 引用及回执；与内联内容／inbox 输入互斥，不改变正式作品 |

正文参考稿采用 Markdown，短剧参考稿采用 Fountain；资料草稿仍复用第21节的领域动作，不重复维护正式 Resource 事实。媒体二进制走固定 inbox，工作副本只引用已核验文件组。文本单项1 MiB；每任务最多100份参考稿，每份最多100个修订，每任务最多100条公开意见。预算由任务读取回执公布。超限提供拆分工作项的明确缺口，不静默裁剪；文件检出可分段编辑，但最终导入仍受发布预算约束。`revision` 类型工作副本只接受范围内 patches，或由这些 patches 渲染的只读预览；不得用普通全稿保存绕过 EditScope。

工作副本保存的 expected 为完整 WorkingCopyRef，字段定义见[29第22节](29-数据字典与Schema设计.md#22-持续协作上下文与反馈)。create／save／import 与新修订、head、原操作和审计同事务。提交固定一个已保存修订，后续 save 不能改旧候选。工作副本尚未正式提交时可供作者查看，不显示为待采纳候选或定稿；正式采纳仍只接收已提交且核验过的 Draft。请求升级、任务关闭、撤权、工作副本冲突或已采用资料均不能被 checkout 路径绕过。

### 23.4 公开反馈与继续修改

| 动作或步骤 | 输入 | 结果与边界 |
| --- | --- | --- |
| `hetu.task_feedback.save` | task_ref、固定 target_refs、expected_feedback_head、intent、public_comment、selected_refs、operation_key | 不可变 TaskFeedback；intent 为 preference 或 request_changes，仅表达任务内意图，不采纳或授权 |
| `hetu.task_feedback.list` | task_ref、after_cursor?、limit? | 按序公开反馈、所指成果、作者可见处理状态及下一页；不含私密批注 |
| 预览继续内容 | 已保存 feedback_ref、task_ref、成果引用 | 本地组装精简继续提示词；不含全文聊天、授权秘密或未公开批注，无业务写入 |
| 宿主消息桥接 | 用户显式点击、当前会话、精确继续内容 | 协商能力可用才请求；响应只证明消息请求结果，不证明生成或返工完成 |
| 新成果确认反馈处理 | save／submit 的 feedback_refs 与实际结果 | 记录 Agent 声明已处理及对应成果；作者仍可判断未满足，不自动把反馈改为“作者已验收” |

InteractionDecision 保留 preference_only 语义。作者对既有选择点“按此修改”时，TaskFeedback 引用该决定及确切成果；单纯保存偏好不自动生成返工指令。反馈保存成功、发送成功与收到后续成果使用独立回执；发送失败可重用同一反馈复制继续提示词，不能换键重复保存或对付费生成自动重试。页面会话只可写本任务公开反馈，正式审核决定继续走第7节。

MCP Apps 仅在真实宿主能力、用户同意和当前会话范围内使用标准消息／模型上下文桥接。普通浏览器页面没有该能力，不伪造桥接。失权、任务关闭或请求过期时停止发送并清理显示；原生端仍可查看历史。网络／宿主消息的未知结果独立记录，Core 不宣称可以事务回滚外部消息。

### 23.5 工具投影、恢复与错误

稳定入口先提供 inspect／open 等窄发现；业务工具接受显式 task_ref，再在 Core 按该任务授权取交集。上下文、工作副本和反馈动作分别投影到 MCP 与 CLI，不提供任意 action/root/actor 的通用远程执行工具。无相应动作时明确 `capability_unavailable`，Skill 依输出合同改用文件交接，不调用猜测的工具名。

稳定 profile 的原操作窄工具 `hetu_read_task_operation` 投影到 `hetu.operations.get`，必含当前获权 task_ref 和原操作 ID 或动作／原键；不能移除 task_ref 后查询作品全部回执。嵌套候选或成果的 task_ref 必须与本次调用一致，包括请求修订与摘要。静态 Apps 资源只提供面板代码，不开放作品文件或按 URI 猜测任务的读取接口；单任务隔离 profile 的旧资源模板不自动成为稳定 profile 的能力。

恢复顺序：核验当前授权 → 打开原任务 → 核对请求版本 → 查询在途原键 → 读取工作副本／已提交候选 → 读取未处理公开反馈和缺项 → 继续现有工作。业务阶段和外部自报进度放在 data 内，AXI 状态仍使用13定义的枚举；Agent 自报“完成”不覆盖持久成果与作者决定。

| 错误 | 恢复与保证 |
| --- | --- |
| `permission_denied, task_closed` | 不返回内容或历史回执；保留作者可见数据，重新访问需明确授权 |
| `stale_request` | 新写入拒绝，返回获权的当前请求引用；旧成果只读，不自动转换新请求 |
| `revision_conflict` | 保留本地稿和对方修订，先比较再保存，不能静默改 expected |
| `context_unavailable, invalid_reference` | 指出缺失／不适用的获权引用，不扫描其他书或回退最新原文 |
| `budget_exceeded, capability_unavailable` | 返回预算或能力缺口及可继续步骤，不冒充部分内容为全量完成 |
| `integrity_failure, unsafe_path` | 不登记损坏或逃逸文件，不修改摘要洗掉外部改写 |
| `result_unknown` | 保存原输入和原键，回查原结果；不重新生成、提交或发送 |

这些是设计语义短名，发布时按13的 AXI 命名空间映射并登记精确错误 Schema。接入、权限、上下文、工作副本、反馈、原键恢复和真实宿主证据必须一同发布，不能只增加工具名或页面按钮。


## 24. 可选模型服务与固定计划

图片候选可携带 `image_category` 及 `subject_refs`。分类限 character、scene、prop、illustration、costume、other；封面身份只由 cover 任务确定。对象引用为固定设定修订中的 entity_ref，或固定文档的 document_id + revision_id，且必须属于该候选声明的来源。Core 验证存在性与范围后写入不可变批次，拒绝文字候选附带图片字段。关联只控制展示，不授予编辑、素材采用或封面选用权。`hetu.interactions.get` 可携带 submission_id 回读指定批次及核验后的等比预览；省略时读取最新批次。

文字与图片模型使用作者本机配置的 HTTPS OpenAI 兼容渠道，或经 `hetu website` 同源服务端消费 Cloud 开放平台。动作输入唯一源为 `contracts/schemas/model-service.schema.json`，动作与 MCP 映射分别由 `contracts/actions.json`、`contracts/tools/catalog.json` 管理；CLI 使用相同 `call` 合同。

已有作品的图片参考任务可由 Agent 使用作品范围的 `hetu.image_tasks.preview_prompt`、`hetu.image_tasks.prepare` 准备，分别映射 `hetu_preview_image_task`、`hetu_prepare_image_task`。调用方明确提供作品目录和 scope_ref，保留预览返回的固定输入、expected_scope 与原操作键；仅接受 `cover`、`artwork`，拒绝正文 edit_scope 与资料修改 resource_scope。此入口只保存本地参考任务，不外发、不付费、不选用封面或素材。任务返回后，使用同作品的精确任务连接继续；不因此取得稳定连接登记、其他作品或作者决定权限。

| 动作 | 行为 |
| --- | --- |
| `hetu.models.list` | 读取本任务当前账号的文字或图片目录、价格、限制和本机默认选择 |
| `hetu.model_tasks.list` | 读取本任务的固定计划及批准状态 |
| `hetu.model_tasks.prepare` | 本机保存确切模型、输入、报价、请求摘要、账号与环境，不发送正文 |
| `hetu.model_tasks.approve` | 仅可信作者入口，绑定计划摘要及单次 Credits 上限或供应商计费批准 |
| `hetu.model_tasks.submit` | 在联网前持久记录已提交标记；每计划至多一次创建请求 |
| `hetu.model_tasks.get` | 查询原计划及远端原操作；结果未知不重新生成 |
| `hetu.model_tasks.collect` | 校验原结果，写本任务候选文件并返回提交入口 |

所有动作携带 task_ref，稳定连接先核验完整 sha256 后归一到领域引用。批准不向 Agent 开放；model_service 设置的 C ABI 仅供可信原生界面，响应不包含连接凭据。网络执行不持有作品锁，结果保存前重验请求、任务关闭、账号及环境。

准备、批准仍使用普通本机 operation_key 回执。远端提交和收集以原 plan_id 作为恢复身份，不能通过换 operation_key 重新下单；网络失败后调用 model_tasks.get。文字输出 `{text: string}`；图片仅走临时生成，取得后验证大小、摘要、格式、尺寸和完整解码。collect 不采纳或定稿，Agent 按原 output_contract 提交候选；改稿继续受 edit_scope 限制。

平台计划携带 `billing_policy_version` 与 `estimated_credits`，作者批准 `max_credits`。自定义计划须声明 `billing_mode: provider`，禁止填写两项 Cloud 报价字段；作者以 `provider_billing_accepted: true` 批准供应商单次请求，不提供虚构的金额上限。自定义渠道的地址、模型配置和密钥引用摘要固定在计划中，凭据不进入作品；返回仅接受完整可解码的 Base64 图片或闭合文字 JSON。发送标记持久化在本机私密 journal，未知结果不自动重发，也不伪造供应商查询能力。

作品内封面任务的图片候选由作者通过 `hetu.covers.select` 的 `source.kind: creative_task` 选用，携带原 `candidate_ref`；Core 核对作品、任务、批次及图片，保留固定请求、提交及候选来源，不将模型候选改记为作者导入。原生封面入口读取同一任务成果并执行作者选用；生成计划与费用在外部 Agent 对话引导确认，经可信本机确认通道绑定实际决定，不把模型计划表单作为作者必经界面。

## 25. 全软件联动与操作提案合同

### 25.1 用例覆盖与入口

本节定义全软件 Agent 联动所需的应用合同。已发布动作和工具名称以 `contracts/actions.json`、`contracts/tools/catalog.json` 及安装制品的能力发现为准；实施覆盖由[20第7节](20-实施路线与里程碑.md#7-全软件-agent-联动的实施准入)追踪。下表是用例要求，不授权调用尚未发布的名称。

| 用例 | 机器必须能完成 | 人的决定与执行约束 |
| --- | --- | --- |
| 无作品筹备 | 开始筹备、讨论方向、保存资料及候选、回读恢复 | 不要求预有 task_id；只分配独立筹备，不获得既有作品权限 |
| 创建小说或剧本 | 填充创建输入、预览新目录与身份、创建并回读、准备首个任务 | 明确新目录与授权；禁止覆盖或接管既有作品，不自动采纳正文或定稿 |
| 管理作品结构 | 读取获权目录，准备卷章／分集的新增、排序和归属变更 | 确切目录 CAS；不能以重排改变正文、身份或定稿 |
| 维护资料与设定 | 保存获权草稿、准备资料／设定变更、固定来源及差异 | 采用、解锁和修改已采用事实各自独立确认，不以能读替代能改 |
| 创作与返工 | 按固定上下文与编辑范围维护参考稿、提交、读取意见并接续 | 保留作者正文与未保存缓冲；实际采纳、作者编辑及定稿分开 |
| 导入导出 | 固定文件输入、解析、填充映射、预览损失和选集、获权执行、核验产物 | 显式文件／目录授权；不得读任意路径或默认为全部内容拥有再分发权 |
| 版本与恢复 | 查询状态、准备快照和冲突方案、查询原操作、执行确切获权动作 | Git 外部目标、文件集合和副作用单独核验，unknown 不换键重发 |
| 设置与接入 | 查询可公开的本机配置、检查扩展、准备并执行获权偏好或安装变更 | 秘密不进入普通读写；不使用工作区能力改变系统或全局配置 |

### 25.2 权限层次

| 能力 | 可做什么 | 不意味着什么 |
| --- | --- | --- |
| 发现 | 查询实际版本、用例、输入 Schema、权限要求与限制 | 不扫描书库或泄漏作品名称、路径 |
| 读取 | 在明确对象、修订、字段和预算内读取 | 不获得编辑、外发或跨作品权限 |
| 草稿维护 | 在明确任务内保存参考稿和未采用资料 | 不推进作者正文、设定、选用及定稿头 |
| 操作准备 | 提交完整结构化输入，得到固定预览、差异和待审提案 | 不等于已批准或已执行；不能借预览读取范围外文件 |
| 获权执行 | 在已有用例授权或确切批准内执行一次确定性事务 | 不授予通用作者角色、任意动作或后续扩大范围 |
| 作者决定 | 可信作者会话对固定提案作出采纳、拒绝、授权或定稿决定 | 不能由模型自报身份、普通公开反馈或模拟点击替代 |

正常可恢复的读取与获权草稿维护无需逐次弹确认。允许的批次操作固定整批输入及影响，不让作者逐项抄录或逐次点击同类操作。创作取舍和高风险副作用在必要节点审阅；已有确认仍有效时复用，不因接口换成 CLI/MCP 再次索取相同决定。

任务引用与作品管理范围分别建模：TaskGrant 限定创作任务，WorkspaceGrant 限定明确作品及管理用例，CreationGrant 限定新建范围。单任务授权不自动变成作品管理授权；管理授权不自动解锁设定或获得定稿权。首次无作品时允许创建隔离筹备，正式目录执行仍按明确的新建授权核验。授权留在本机私有存储，Prompt、上下文引用、已知目录和 UI 路由均不构成授权。

当前有限新建切片返回 `management_ref={grant_id,scope_ref}`。私有登记将客户端、筹备路径和一个全新作品路径绑定；稳定入口只允许核验后的筹备读取／保存／创建，以及该作品的读取、空文档／分集创建和首任务准备。`target_path` 必须等于预留路径，不能用任意目录替换；非空目录和链接拒绝。`hetu.creative_tasks.prepare` 仅为相同客户端派生 TaskGrant，后续创作使用完整 `task_ref`，管理引用不参与采纳或定稿。旧作者入口的 `author_only` 保护保持；内部窄授权单独校验，不将管理连接改为作者。`hetu.collaboration.revoke_management` 仅供可信作者撤销当前作品的新建管理授权和派生任务，撤权在原键重放前重新校验。

稳定能力目录描述精确管理授权下的 Agent 变体，因此不会沿用作者入口的 `author_only=true` 标记。该标记不授予权限，实际执行仍核对管理引用及允许动作；作者入口的合同保持独立。导入、导出和交付预览作为获权只读能力交接，正式执行继续走固定方案及独立批准。

作品管理授权不包含任意本机文件读取权。Agent 调用 `documents.preview_import`、`assets.inspect` 及准备导入方案时，使用 `inline_source={filename,base64,sha256}` 提交宿主已授权读取的明确字节；Core 验证文件名、编码、摘要及8MiB原字节上限，不替 Agent 打开 `file_path`。作者的原生文件选择器仍可使用路径导入。内联原稿预览和完整方案另限制为7MiB序列化结果，超出时明确返回预算错误并要求拆分；不先登记不可审阅的方案。媒体检查仍只承诺签名与摘要，不等同完整解码或版权审核。

### 25.3 页面上下文与交接

页面把 `view_kind`、明确的 scope／object 引用、固定修订及摘要、可公开状态、相关任务／提案和原操作引用交给 Core 生成交接。无作品时 scope 为明确筹备或未分配状态，不能虚构作品 ID。未保存缓冲单独标识，除非作者明确交接固定快照，否则不作为机器可读原文。

Core 从实际用例及授权生成可操作能力、必要缺项、所需决定和恢复方式；页面不维护另一份动作白名单。完整提示词指导所选 Skill 发现能力、读取范围、执行并回读，缺少输入由 Agent 在对话中澄清或提出方案，不要求作者回 GUI 填字段。复制只产生交接回执，不宣称已发送、运行或完成。

GUI 路由和定位引用帮助人审阅相同对象；CLI/MCP 不依赖页面先被打开。Apps 和本地页面消费相同上下文，不能通过渲染任意操作按钮扩大权限。

### 25.4 固定操作提案与执行

操作准备复用对应领域用例的 Schema、预览和校验，形成不可变 OperationProposal：确切动作与合同修订、固定输入与摘要、目标对象及预期版本、影响集合、来源、发起主体及所需决定。准备不产生所提议的正式业务写入；它可以持久保存提案和原操作回执。损坏引用、未授权读取或不支持的动作在准备阶段明确拒绝。

作者审阅成果、差异和影响后，可信确认通道记录 AuthorDecisionRef，批准精确绑定提案摘要、执行动作、授权主体、范围、限额及有效期。Agent 获得的执行凭据为本机可验证的窄授权引用，不是业务 JSON 中的 `approved=true`。模型不能提交自己的 AuthorDecisionRef，也不能用通用 actor 或任意 action 冒充作者。

执行重验当前权限、未撤权、输入摘要、CAS、来源及副作用目标。批准后字段变化必须准备新提案，不能修改原提案或把旧批准转给新目标。成功原键重放返回同一结果；回执丢失查询原操作。执行与确认分别记录来源：Agent 执行的事实不冒称作者手动编辑。

有限新建和已明确授予的草稿管理可按对应合同直接执行，不为所有操作强制创建提案；需要作者决定的用例统一采用该模式，不能为规避 `author_only` 暴露通用作者句柄。已执行提案与对应领域结果共用操作身份，提案不成为第二份正文、设定或作品目录。

当前作品范围的已发布切片使用 `hetu.handoffs.get` 生成真实能力和固定对象交接；`hetu.agent_operations.prepare/list/get/decide/execute` 管理单项固定方案。`decide` 仅可信作者可用，MCP 不暴露批准工具。`prepare` 复用明确允许的本地域用例 Schema 和校验，固定预演产生的对象身份、正式文件字节、变更前摘要及作品基线；仅方案和回执进入事务，不提前提交正式内容。`execute` 在相同作品锁内重新检查批准、有效期、摘要及原文件，正式变更与方案执行状态同一事务提交，审计保留 Agent 身份。原方案成功结果可重复回读，不再次写入业务内容。

允许的动作包括作品资料、空文档、卷章、大纲、未锁定设定、剧情校正、短剧项目／分集／骨架、协作任务准备、素材元数据与原文件导入、资料关联、线索、文稿导入和固定交付，以及确切 Git 操作。白名单由 Core 持有；不开放正文直接保存、采纳、定稿、解锁或费用批准。新任务执行后为同客户端派生独立 TaskGrant，结果返回 task_locator，再通过稳定连接 open 获得完整 task_ref；不因此获得整库权限。Schema 和状态词汇见 `contracts/schemas/agent-operation.schema.json`，MCP 名称从工具目录发现。

已有作品的 `hetu.collaboration.authorize_workspace` 与 `workspace_access` 仅可信作者可用，返回带 grant_revision 的 management_ref。私有授权绑定客户端、作品身份、目录 dev/ino、修订和期限；每次读取、执行及重放都核验。撤权后再授权推进修订，不能复活旧管理引用或旧派生任务。`hetu.collaboration.created_works` 分页列本客户端有限新建的有效作品，由原生书库核验并接纳，不公开整库目录。

普通方案固定 UTF-8 与必要原文件二进制写集，总量不超过8MiB，before_files 与写集一一对应。导入保留审阅时原字节，外部文件后来改变不替换固定输入。素材导入、交付和 Git 使用 deferred 执行：先落 executing 意图，按固定子操作键或确定性 Git 身份恢复，再提交结果。导出沿原交付事务恢复，不能换键重复产出；执行中不能改变批准决定。

Git 读取动作 references、read_version、merge_preview 提供版本线、固定历史和冲突。方案可准备 init、branch_create、branch_switch、merge、remote_save、fetch、push、pull。版本线切换与合并只组织 Git 记录，保留当前工作文件、领域修订和真实 index；历史内容另供比较，不能 checkout 覆盖作品。合并固定父节点、冲突选择、身份与时间；fetch 固定提交并 CAS 更新追踪引用，push 固定提交并以远端原引用校验。仅接受不含凭据的 HTTPS、SSH 或本地绝对路径；禁用 hooks、自定义 helper、地址重写和交互输入。当前同步依赖系统 Git/SSH，实际服务商鉴权应分别验收。

`hetu.findings.suggest/suggestions` 绑定 report_id、finding_id 和当前处置修订，保存 Agent 建议而不修改正式处置。作者可把建议带入处置页，最后独立确认。报告或处置变化后建议标记过期，不自动搬到其他问题。

### 25.5 结果、观察与失败

机器回执返回确切对象／修订、实际作用、状态、待审或执行引用及可继续步骤。原生端按对象修订刷新已保存投影，保留本地未保存缓冲和焦点；不用整页刷新掩盖冲突。Agent 可读作者允许公开的决定与反馈，不读私密批注或确认凭据。

缺输入、无权限、待作者决定、版本冲突、能力缺失、执行失败及结果未知分别返回结构化状态，不统称“请回软件操作”。没有已验收的可信宿主确认时定位原生提案审阅页，人只审阅具体决定；普通操作和资料填写继续通过机器完成。Computer Use 不作为本合同的正常执行或批准通道。

### 25.6 图片图组与角色视图

`hetu.creative_tasks.submit_result` 的图片候选可带 `image_category`、`subject_refs` 及 `image_view`。视图枚举由 `creative-task.schema.json` 的 `image_view` 定义；只用于 `character` 或 `costume` 图片，且须关联一个固定角色。其他图片类型不能伪装成人物视图，文字候选不能带图片字段。同一提交可以包含多个视图，数量仍受原任务限制，每个候选保存独立文件摘要与视角；CLI、MCP、原生和资产库读取同一记录。

单人形象或正面可作为角色卡片主图；三视图、侧面和背面保留在角色图组。多人情节图使用 `illustration`，不参与角色主图选择。原图裁出的单人视图属于文件派生，不产生新的模型请求；提交来源记录原图摘要及裁切像素范围，保留完整原图。软件展示视图标签和固定批次，不以视图字段承诺图片身份一致，视觉一致性仍由 Agent 核对及作者审阅。

### 25.7 本机设置与安装方案

`hetu.local_settings.get/prepare/get_operation/execute` 由原生 LocalAutomation 持有；稳定 MCP 委托同包 CLI，不复制偏好存储。公开入口没有 decide，作者从设置页审阅固定差异。偏好白名单包括语言、主题、书库布局、自动保存、字体、字号、行距、缩进、Git 作者和默认客户端；密钥与私密模型配置不回读。

方案绑定偏好域、客户端、原值、套件及其指纹、可选作品身份和24小时期限。执行使用跨进程锁、CAS、原子落盘和同步，executing 只接续原键与已批准值，外部第三种值造成冲突。套件选择可独立保存，受管安装按实际客户端能力执行；Codex 安装未知先只读核实，不自动重复安装。MCP Apps 的 `ui://hetu/operation-view/1` 只读方案及状态；批准始终回原生端，任务面板的偏好和意见不构成批准。
