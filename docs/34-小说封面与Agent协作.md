# 小说封面与 Agent 协作

关联需求 FR-20。本章定义每部小说的封面 Prompt、配套 Skill、固定目录交接、候选识别与作者选用合同。身份与来源见[领域设计](28-领域设计与边界上下文.md)，通用媒体导入见[应用 API](30-应用API详细设计.md)。

## 1. 产品职责

作者在小说的“封面”页选择“外部设计封面”，再使用设置中的默认客户端或改选。河图根据作者确认的书名、笔名、简介、题材和视觉要求组装 Prompt，保存不可变请求，提供“复制到 Codex／WorkBuddy／Claude Code”等对应操作。作者在所选客户端使用 `hetu-cover` 专用 Skill 对话和生成，候选回到固定目录，由河图预览并由作者选用。

河图核心负责模板、任务文件、识别、展示、素材持有和封面引用；图像生成在外部 Agent 的宿主能力中执行。图像工具、模型、服务账号和费用由外部 Agent 的环境负责。此流程属于核心与外部 Skill 的文件交接，不要求安装商业多媒体调度插件，不增加核心生成 API。

本地导入已有封面始终可用。未配置 Agent、离线或不生成图片时，作者仍可维护书名、笔名，选择现成图片或使用文字占位封面。

## 2. 用户流程与界面

1. 在作者书库选定一部小说，打开作品资料中的“封面”。持续显示该书书名与笔名。
2. 调整视觉方向、封面语言、目标尺寸、文字方式和候选数量。默认 1024×1536、1 张，为河图初始预设；投稿平台的尺寸通过明确 profile 选择。
3. 查看并编辑完整 Prompt，确认要交给外部 Agent 的作品资料。默认只取书名、笔名与作者确认的短简介，不自动附带章节。
4. 创建请求，复制包含适配该宿主的 Skill 调用、请求位置和输出目录的提示词，粘贴到客户端。Codex CLI 的显式调用可使用 `$hetu-cover`，其他表面按实际发现的语法提供。绝对路径仅作为本机交接展示数据；版本化任务文件只保存相对路径。不能访问本机的客户端须走明确的文件转交，不声称路径可达。
5. 外部 Agent 的封面 Skill 读取任务、在客户端生成图片、写候选文件，最后提交完成回执。
6. 河图发现回执后独立核验并展示候选图。作者可以预览原图、查看生成说明和尺寸，或选择“用作封面”。
7. 选用后，原图进入受管素材，作品封面记录引用该素材及裁切参数；作者书库刷新缩略图。候选、旧封面和请求来源保留。

Prompt 字段支持简体中文和英文；界面语言、Prompt 语言和封面文字语言分别选择。英文界面不能自动翻译作者的中文书名。`background_only` 生成无文字底图，河图可叠加真实书名与笔名；`title_and_author` 要求生成图包含指定文字，结果仍须作者校对。

界面区分“等待外部结果”“发现文件”“正在检查”“候选可预览”“部分结果”“结果需处理”和“已选用”。创建请求只能显示等待状态；没有实际宿主事件时，不显示“Codex 正在绘图”、生成百分比或完成倒计时。

## 3. 固定目录与交接

每部小说的内容工作区保留独立封面目录，使用稳定工作区身份关联该书：

```text
my-novel/
  .heturc.json
  packages/
    visual-prompt/
      covers/
        requests/<request_id>.json
        inbox/<request_id>/
          candidate-01.png
          result.json
        cover.json
      assets/                         # 选用图片复用现有素材存储
```

`request_id` 为 `cover_request_` 加小写 UUID；文件夹和文件名不使用书名，中文、重名和书名修改均不影响定位。`cover.json` 由作者选用动作维护，Skill 只写自己的 inbox。

候选图片先写同目录临时文件，完整后安装为最终图片；`result.json` 最后原子写入。文件事件只触发重新检查，完整回执才使候选进入可选状态。图片已经出现而回执未完成时显示发现文件，避免读取半张图或把旧结果当新结果。

应用启动、窗口重新激活及作者点击“重新检查”时执行有界补查，恢复应用关闭期间产生的结果；持续文件监听只覆盖当前授权作品。请求和回执可保留在作品中，不通过扫描同级小说目录发现任务。inbox 和临时缩略图不默认进入 Git 快照或交付包。

## 4. 数据合同与不变量

机器合同分别为 [CoverRequest](../contracts/schemas/cover-request.schema.json) 与 [CoverResult](../contracts/schemas/cover-result.schema.json)，均使用 `schema_version=1.0.0`、UTF-8 JSON、UTC RFC 3339 与闭合字段。

| 对象 | 主要字段 | 语义 |
| --- | --- | --- |
| CoverRequest | `workspace_id, request_id, book, design, prompt, output_relative_dir, created_at` | 作者确认的小说资料快照、视觉要求、最终 Prompt 和固定输出根；保存后不覆盖 |
| book | `title, author_name, synopsis, language_tag` | 用于本次封面设计的快照；不是正文副本，也不赋予 Agent 修改作品资料的权限 |
| design | `art_direction, width, height, text_mode, cover_language, candidate_count` | 目标像素、文字方式及 1～4 张候选；每次请求单独确认数量 |
| CoverResult | `workspace_id, request_id, request_sha256, completed_at, candidates[]` | Agent 完成声明；摘要指向请求文件原始字节，需内核重新核验 |
| Candidate | `filename, sha256, size_bytes, width, height, media_type, used_prompt, generator` | 实际图片字节、尺寸、Prompt 与生成来源声明；generator 只在确知时记录 model |
| BookCover | `revision, asset_ref, source_ref, presentation, previous_sha256` | 作者选用后的版本记录；`asset_ref={asset_id,revision,sha256}`；`source_ref={request_id,request_sha256,filename,sha256}` 或手工导入来源 |
| presentation | `crop_rect, title_overlay, author_overlay` | 原图坐标系内的归一化裁切范围与可编辑真实文字；修改展示不改原图 |

JSON Schema 校验结构后，还须校验跨字段和文件事实：

- 请求身份与 `.heturc.json`、请求文件名和输出目录相同；结果的工作区、请求 ID 与原始请求摘要完全匹配。
- 文件名在同一回执内唯一，候选数量等于请求数量；少于请求数量时可展示已有合法图片并标记部分结果，不将整个请求标为完成。
- 结果路径只允许 inbox 内单个候选文件名，禁止目录逃逸、符号／硬链接、设备文件与可执行文件。
- 图片限 PNG、JPEG、WebP，签名、解码、媒体类型和扩展名相符；每图不超过 32 MiB，宽高各为 64～8192，像素总量不超过 6400 万。
- 重新读取实际文件的字节数、SHA-256 与尺寸；不信任 Agent 自报的解码结果。像素尺寸不匹配目标时说明差异，作者可修改目标创建新请求，不能静默拉伸。
- 候选通过不等于生成版权得到验证；素材来源记录为 Agent 声明，权利状态延用通用媒体合同，默认不授予可再分发权限。

书名、笔名或其他封面输入变更后，历史任务保留并显示与当前资料不同。作者仍可明确选择历史图；不会自动把新标题烧录进旧图。已有同一回执和摘要时复查不重复导入；相同路径出现不同字节时作为冲突处理，不修改历史摘要。

## 5. 配套 Skill

Codex 适配中的 Skill 文件见 [`hetu-cover`](../integrations/codex/hetu/skills/hetu-cover/SKILL.md)，方法归属和跨宿主打包规则见[27](27-Agent与Codex插件集成设计.md)。Skill 的核心步骤为：核对作品与任务 → 读取 Prompt → 使用宿主图像能力 → 检查实际输出 → 写候选图与回执 → 告知作者回河图选用。安装路径、调用方式和图像工具分别按宿主适配，不复制动态小说资料到安装包。

Skill 不假定某个图像工具始终存在，不内置供应商或密钥，不通过虚构河图 API 回报成功。没有生成能力时给出具体缺口；生成结果未知时先寻找原产物，避免重复收费。安装 Skill、允许外发设计资料、执行付费生成和作者选用分别遵循用户的实际授权。

## 6. 应用动作

以下是设计动作；能力发现仅发布当前构建实际实现的合同。Skill 使用上述文件交接，不依赖未发布动作。

| 动作 | 输入 | 结果 | 边界 |
| --- | --- | --- | --- |
| `hetu.covers.preview_prompt` | 作者确认的 book、design、Prompt 修改 | 完整 Prompt、资料清单、输出预览 | 仅作者；无落盘、无网络 |
| `hetu.covers.create_request` | 预览的固定输入、`operation_key` | 不可变请求、摘要、可复制调用说明 | 仅作者；保留原键；不调用或自动启动 Agent |
| `hetu.covers.list_candidates` | `request_id, cursor?, limit?` | 核验状态、候选摘要和下一游标 | 仅当前授权作品；默认 20，最多 100；有界重查 |
| `hetu.covers.select` | 固定候选引用或手工素材引用、`expected_cover`、展示参数、`operation_key` | 素材引用、封面新修订、缩略图更新 | 仅作者；`expected_cover=null` 仅允许首次选用，后续需修订和摘要 CAS |

选用事务协调素材导入、BookCover 新版本、原操作与审计；缩略图是可重建投影。Agent 对候选的提交不能改变作者封面选择，不扩张为对 `assets.import` 或作品元数据的任意写权限。

## 7. 失败、恢复与验收

请求创建后重启仍能复制同一任务；结果到达时应用关闭，重开能发现。半写入、格式不符、摘要错误、其他作品的回执和损坏图片均显示具体原因，保留现有封面和可恢复产物。

同一请求重复交付只形成同一候选观察；作者双窗口同时选用通过 CAS 处理。并发冲突、导入失败或磁盘满不得出现封面引用成功但素材缺失。取消或放弃请求只改变本地跟踪状态，不声称已经停止外部 Agent 或退款，也不自动删除生成文件。

验收覆盖中英文 Prompt、中文路径、封面原比例、英文封面文字、无生成工具、部分结果、原请求恢复、跨作品隔离、图片解码限额、历史封面、选用权限、可重建缩略图，以及核心完全没有生成网络请求。实际宿主验收使用明确版本的 Codex 与其图像能力；仅有 Skill 文件或 Schema 通过不构成桌面闭环完成。

## 8. 建书筹备与局部预览

第一本书尚未创建时，可以通过 creation_project scope 的通用 cover 创作任务探索视觉方向；它使用29定义的 CreativeTaskRequest／TaskSubmission，不把缺少 workspace_id 的数据塞入正式 CoverRequest。作者在筹备中提供暂定书名或无文字设计要求，结果只作为筹备候选。

创建作品后，作者选择导入哪些筹备图片，内核复制受管原件并保存原请求、候选及摘要的来源快照；书名、笔名或尺寸与最终资料不同要显式提示。然后由作者在作品封面页确认正式选用，或以正式 CoverRequest 请求新的设计。导入已有候选不再次发起生成或收取算力费。

支持的 MCP Apps 可以等比比较候选、放大核对文字和保存偏好；必要时按需启动 Node.js 页面供内置浏览器使用。它们记录原任务的 InteractionDecision，正式 BookCover 选用仍在原生端确认。网页保存、候选通过核验和正式封面选用是不同结果，无 Apps 或浏览器时使用原生预览。
