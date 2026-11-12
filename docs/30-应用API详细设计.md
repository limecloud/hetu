# 应用 API 详细设计

API 为本地 C ABI／应用用例合同，供 GUI、Swift CLI 与 MCP 适配；V1 不引入必装 HTTP 后端。领域见[28](28-领域设计与边界上下文.md)，字段语义见[29](29-数据字典与Schema设计.md)。

## 1. 入口、权限与版本

| 入口 | 可调用范围 | 身份来源 |
| --- | --- | --- |
| macOS／Windows GUI | 用户授权的完整人工任务 | 本机可信窗口、系统访问与作者会话 |
| Swift CLI 人工模式 | 同一核心任务，支持交互确认 | 控制终端与本机作者会话 |
| MCP Agent | 读设定集／获权原文、草稿、派生结构、报告、受限交付 | 已批准的 Server 上下文，非 clientInfo 自报 |
| MCP Apps | 受允许的查询与审核意图 | 宿主桥接及可验证的人类授权，缺失时原生接管 |

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
| `hetu.workspaces.get` | 当前 scope | 项目属性、包、覆盖与占用 | 无额外目录扫描 |
| `hetu.workspaces.list` | package?、cursor?、limit? | 已授权范围的工作区／包列表 | 对应 MCP list_workspace，不泄漏全盘路径 |
| `hetu.blueprints.get` | section?、entity_ids?、cursor? | 设定集数据、revision、sha256、lock | 分页保留总范围与继续入口 |
| `hetu.blueprints.preview_change` | expected、typed_changes[] | 引用影响、差异、阻断与警告 | 无写入；不接收任意脚本／路径 patch |
| `hetu.blueprints.save` | expected、typed_changes[]、operation_key | 新 revision、摘要、影响引用 | 仅作者、必须未锁定；拒绝借 changes 改锁／身份 |
| `hetu.blueprints.lock` | expected、reason?、operation_key | 新修订、锁状态 | 作者确认；检查当前内容完整性 |
| `hetu.blueprints.unlock` | expected、reason、operation_key | 新修订、解锁审计 | 作者明确操作；不改变 Agent 能力 |
| `hetu.blueprints.apply_suggestion` | suggestion_ref、expected、author_changes、operation_key | 采纳记录、新设定集修订 | 仅作者；源证据过期／歧义先处理 |

typed_changes 是受限的实体新增、字段更新、归档、引用迁移和删除联合类型。删除有被引用项时阻止，迁移先预览。建议草稿不是待执行命令，作者选取后才形成合法变更。

## 5. 正文、草稿与导入

| 动作 | 输入 | 结果 | 限制与失败 |
| --- | --- | --- | --- |
| `hetu.documents.list` | kind?、query?、cursor?、limit? | 文档摘要与修订指针 | 搜索与分页绑定 scope 和查询快照 |
| `hetu.documents.get` | document_id、revision_id? | 元数据、格式、内容或有界范围 | 默认当前修订必须在结果明确，固定引用优先 |
| `hetu.documents.save` | document_id、base_revision_id、source_format、content、operation_key | 新 revision_id、sha256、当前指针 | 作者编辑入口；不自动批准；基线冲突不覆盖 |
| `hetu.documents.import` | 已选本机文件句柄、source_format、profile、preview_receipt、operation_key | ImportRecord、文档及修订 | 人工入口；先预览损失与编码；不执行宏 |
| `hetu.documents.export` | revision_refs、profile、format、operation_key | 新文件、摘要、转换报告 | 受限导出根；格式和正文修订明确 |
| `hetu.drafts.submit` | package、source_format、content、blueprint_revision、operation_key、目标或新稿信息 | draft_id、operation、诊断任务 | 新稿需title；修改需target_document_id＋base_revision_id |
| `hetu.drafts.get` | draft_id | 正文引用、状态、来源、审核与诊断引用 | 不返回隐藏内部批注 |
| `hetu.drafts.list` | state?、package?、cursor?、limit? | 获权草稿摘要 | 不宣称列表为空就是没有未授权草稿 |
| `hetu.annotations.add` | source_ref、body、visibility、operation_key | annotation_id | 绑定确切修订；外发范围显式 |

Agent 通过 drafts.submit 创作，不通过 documents.save 直接覆盖正文。草稿接收后自动诊断属于独立任务；提交成功回执可显示诊断 pending，不能伪造报告通过。

## 6. 抽取、骨架、对比与校验

| 动作 | 输入 | 结果 | 限制与失败 |
| --- | --- | --- | --- |
| `hetu.plot.extract` | document_revisions[]、blueprint_revision、options、save_result、operation_key? | 节点候选、来源、覆盖、可选保存 ID | 保存需原键；预算耗尽返回 partial |
| `hetu.plot.get` | plot_revision_id、cursor? | 节点与边的固定修订 | 不能混入后来人工校正 |
| `hetu.plot.correct` | plot_revision_id、corrections[]、operation_key | 新 plot_revision_id | 作者确认实体／时序；Agent补充仍为候选 |
| `hetu.drama.build_skeleton` | plot_revision_id、blueprint_revision、episode_options、operation_key | skeleton_id、revision、缺项、来源 | 新候选，不覆盖现有人工稿 |
| `hetu.drama.get_skeleton` | skeleton_id、revision? | episodes、scenes、源映射 | 显示实际读取修订 |
| `hetu.drama.edit_skeleton` | skeleton_id、expected、typed_changes[]、operation_key | 新修订及影响 | 作者结构编辑；保留稳定场景 ID |
| `hetu.drama.compare` | source_revisions、skeleton_ref、script_revision?、save_result、operation_key? | 新增／删减／重排／过期报告 | 不自动回写原著 |
| `hetu.validation.run` | target_refs[]、blueprint_revision、rule_set_version、save_report、operation_key? | report或task、coverage、findings | 无生成模型；保存需原键 |
| `hetu.reports.get` | report_id | 原报告及计算出的stale原因 | 固定结果与当前性分开 |
| `hetu.findings.disposition` | finding_ref、expected_inputs、disposition、reason、operation_key | 问题处理记录 | 完整性错误不可豁免，例外限定证据 |

episode_options 只包含分集锚点、目标集长估计或分组策略，不能传“请续写”等自然语言让 Core 生成内容。结构化明确断言才进入确定规则前提。

## 7. 审核与素材

| 动作 | 输入 | 结果 | 限制与失败 |
| --- | --- | --- | --- |
| `hetu.reviews.list` | state?、cursor?、limit? | 待审或既有决定摘要 | 按权限过滤 |
| `hetu.reviews.get` | review_id或draft_id | 决定、当前证据、可见批注 | 模型仅可读获准投影 |
| `hetu.reviews.decide` | draft_id、expected_draft_revision、input_snapshot、report_refs[]、decision、comments、exceptions[]、operation_key | review_id、可选approved_revision_id | 作者能力；事务更新草稿、定稿和审计 |
| `hetu.cues.list` | kind?、narrative_ref?、cursor? | 乐律／视觉线索 | 原文权限过滤 |
| `hetu.cues.save` | cue_id?、expected?、kind、narrative_refs[]、description、asset_refs[]、operation_key | cue及新revision | 已有cue需CAS；Agent改动先草稿审核 |
| `hetu.assets.import` | 用户选定文件或受管插件结果句柄、source、rights_status、operation_key | asset_id、摘要、检测结果 | 无任意URL下载／可执行文件导入 |

`decision=approved` 需完整性、当前证据和例外政策通过；接口存在不意味着模型可调用。Apps 仅有意图能力时返回 pending 与后续作者入口，不保存伪审核决定。

## 8. Git、Bundle 与恢复

| 动作 | 输入 | 结果 | 限制与失败 |
| --- | --- | --- | --- |
| `hetu.git.status`／`diff`／`log` | 已授权仓库、范围／修订 | 工作树、差异、提交记录 | 只读、不执行hooks |
| `hetu.git.snapshot` | phase、selected_refs?、message?、expected_head?、operation_key?、operation_id? | 持久预览／pending或实际commit | MCP仅暴露该受控Git动作；prepare需operation_key；execute需已批准原操作 |
| `hetu.git.branch_create`／`switch` | 分支名、起点／目标、expected_head、operation_key | 实际分支／HEAD | 作者确认；保护脏工作树 |
| `hetu.git.merge` | phase、source_ref、expected_head、resolution_ref?、operation_key | 冲突预览／已验证合并结果 | 三方人工解决，JSON引用再校验 |
| `hetu.git.fetch`／`pull`／`push` | remote_ref、branch_ref、expected_refs、operation_key | 实际远端／本地证据或unknown | 明确单次授权，禁止强推；秘密不入参数 |
| `hetu.bundles.preview` | selection、profile、expected_inputs | 确切输入、字节估计、缺口与排除 | 不创建最终包 |
| `hetu.bundles.export` | selection、profile、expected_inputs、operation_key | bundle_id、路径、ZIP摘要、manifest | 默认exports新目标；待审／权利例外另审 |
| `hetu.bundles.verify` | 已选包的受管句柄 | 文件与引用核验结果 | 有大小、条目和解压预算，不执行内容 |
| `hetu.operations.get` | operation_id或原key＋action | 原回执、当前状态与恢复缺口 | 重新授权，不因找不到记录就重执行 |
| `hetu.tasks.get`／`cancel` | task_id、operation_key? | 当前任务／取消范围 | cancel若改变持久状态需幂等记录 |

Git 的外部观察、确认范围与未知核对按16执行；没有手工批准的自动化请求不取得 push／pull 等能力。Bundle不自动上传、不向他人发消息。

## 9. MCP 适配

八个工具分别映射上述动作或其受控流程；MCP tools/call 外层与内层 AXI action 名分开。文档、审核、报告和 operations 以资源读取适配查询用例。CLI 命令、GUI ViewModel 与 MCP 不重新实现审核、CAS 或 Git 策略。

MCP 的标准工具描述必须静态且如实反映其写入可能性；实际权限依请求上下文重验。长任务先返回持久原操作，再通过可用资源／窄查询继续。核心报告有错误发现时工具可以执行成功，不能将JSON-RPC成功误读为草稿定稿。

## 10. 错误、分页与任务

AXI 标准错误使用 invalid_input、missing_context、forbidden、not_found、revision_conflict、idempotency_conflict、unsupported_version、cursor_invalid、unavailable、deadline_exceeded、result_unknown 等；内核特有错误使用 `hetu.blueprint_locked`、`hetu.stale_evidence` 等命名空间。每个错误给出 correction／read／recover／request_decision 方向，不添加泛用“重试即可”。

分页 `limit` 默认50、最大200，游标为不透明值，绑定身份、范围、筛选与快照。字段选择不允许隐藏操作、版本、覆盖或错误所需元数据。

任务排队／执行／终态与 AXI status 是不同层次；公开 pending 包含data.task_id和operation。取消通知仅停止当前RPC观察时不得改业务状态为cancelled，必须读真实任务状态。

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

本例对应第2节请求。提交已完成而诊断仍排队，因此顶层为 succeeded，诊断任务单独表示 queued；这不代表内容已经通过校验或定稿。

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
    "validation": {
      "task_id": "task_66666666-6666-4666-8666-666666666666",
      "state": "queued"
    }
  }
}
```

原操作摘要使用去掉 operation_key 的固定业务输入；正式规范化采用 RFC 8785 JCS，并发布中文、换行、数字和 Unicode 的跨语言向量。本例仅含整数与字符串，其规范化字节可直接复算。content 不做换行或 Unicode 清洗；把不同正文归一为同一输入会破坏幂等语义。

## 15. 快照阶段合同

| phase | 必填输入 | 持久效果与返回 |
| --- | --- | --- |
| prepare | selected_refs、message、expected_head、operation_key | 冻结精确文件与 HEAD，保存预览操作；返回 pending、operation 与 approval_state |
| execute | operation_id | 读取原操作及可信作者批准，复核输入后最多创建一次 commit；不接受新的文件集合、备注或批准布尔值 |

execute 的幂等身份继承 prepare 的原操作，不另创业务键。重复 execute 回读原 commit；工作树、HEAD 或批准范围变化时阻断，调用方需审阅新预览。批准和执行是独立授权步骤，不允许 Agent 通过 prepare 自行取得提交权。

## 16. 查询、分页与错误约定

查询返回确切读取修订，范围性查询返回 AXI page 或结果 data 中的正式页结构，并提供 next_cursor。结果为空、无权和不存在按既定策略区分，不能通过错误响应泄漏未授权作品。

| 场景 | AXI status／code | 下一步 |
| --- | --- | --- |
| 新稿保存成功，诊断未完成 | succeeded，data.validation 为 queued／running | 查询原草稿或任务 |
| 存储任务已受理，业务未完成 | pending，含 operation 与 task_id | 查询原操作 |
| 基线或正文摘要变化 | blocked／revision_conflict | 读取当前修订并比较 |
| 同键不同固定输入 | blocked／idempotency_conflict | 保留原键，纠正错误关联 |
| 校验完成且发现问题 | succeeded，data.report 含 findings | 作者处理问题，不当作RPC失败 |
| 仅扫描部分范围 | partial，coverage 明确缺口 | 缩小范围或调整明确预算 |
| 外部副作用无法确认 | unknown／result_unknown | recover 原操作，禁止自动重发 |

C ABI 整数码、MCP 协议错误、AXI 执行结果、诊断 findings 和作品审核状态分别表达各自层次，入口不得用一个布尔 success 合并这些状态。
