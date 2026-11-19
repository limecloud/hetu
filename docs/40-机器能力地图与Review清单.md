# 机器能力地图与 Review 清单

这份地图供产品逐项审阅，也供 AI 按目标定位 Skills、CLI 和 MCP。它由同一组源码合同生成，不依赖打开桌面。

- 产品原则：所有业务应有机器操作路径；桌面承担阅读、比较和可选手动编辑。必要的作者决定可以在当前 Agent 会话完成。
- 执行前发现：`hetu --client codex collaboration inspect`，按返回的真实 Schema、精确 `management_ref` 或 `task_ref` 操作。
- 无窗口查询：CLI 使用 `hetu --client codex call hetu.capabilities.map --input -`；MCP 使用 `hetu_get_capability_map`，支持 group、action、skill 筛选与分页。
- AI 完整索引：[contracts/capability-map.json](../contracts/capability-map.json)。其中包含输入 Schema、MCP profile、Skill 源文件和恢复动作。
- 默认产品：小说、剧本及视频基础能力随应用提供，无需额外创作插件；`hetu.baseline.inspect`核对合同，装配、业务及创作品质分别验收。
- 维护边界：本清单只维护宿主能力及插件发现入口；各插件自行维护功能清单和 manifest，AI按安装包继续发现，不在宿主重复登记插件功能。
- 插件公共服务：SDK提供受管项目适配、固定来源与原操作恢复；桌面提供固定素材预览及当前渲染器派生Blob媒体播放，以及Markdown／JSON／HTML固定对象分块导出。合同见[开放宿主SDK](plugin/27-开放宿主SDK与核心能力审计.md)，专业Schema仍由插件维护；定向机器调用仅核验本包与依赖闭包；已安装包始终核验实际字节摘要。
- 插件选择：[官网插件中心](https://hetu.limeai.run/plugins/)展示来源、发行与包内功能清单；目录不代表本机安装状态，执行仍需重新发现。开发与上架见[插件23](plugin/23-插件发布与上架指南.md)。
- 状态解释：**已验证**有专项证据；**源码已连线**需要运行验收；**机器替代入口**指向独立合同；**宿主边界**保留授权或私密性；**作者入口缺口**需继续处理。安装证据与功能验收分别记录。
- 进度由 [38](38-创作工作台重构执行计划.md) 管理；验收要求见 [19](19-测试策略与验收矩阵.md)，构建和实测证据见 [20](20-实施路线与里程碑.md)。

## AI 任务路由

| 用户目标 | Skill | 起点 | 可回读流程 |
| --- | --- | --- | --- |
| 导入已有小说 | `hetu-import` | `hetu.import_authorizations.register` | 发现能力及精确作品 → 核对原稿、完整目录和摘要 → 登记真实导入指令 → 固定分批方案并执行 → 逐篇回读及原键恢复 |
| 整理资料、目录、设定或执行作者取舍 | `hetu-manage` | `hetu.agent_operations.catalog` | 读取对象及固定修订 → 按领域Schema准备方案 → 展示差异并记录真实决定 → 原Agent执行 → 回读领域结果 |
| 起草、改稿或整理大纲 | `hetu-setup` | `hetu.creative_tasks.list` | 恢复已有任务或准备确切新任务 → 按任务类型选择写作Skill → 按需读取固定上下文 → 提交参考成果 → 阅读反馈并沿原任务继续 |
| 剧本复盘、全剧分集规划与场次创作 | `hetu-drama` | `hetu.drama.projects.get` | 新作先独立筹备；已有作品读取确切项目、分集及固定正文 → 区分作者稿、候选、旧大纲及原著阅读覆盖 → 全剧→分集→场次；专业规划按实际插件能力保存 → 固定Fountain任务起草、意见及同任务返工 → 分集入口回读正文与来源；采纳后增量更新，完整范围单独验收 |
| 短剧视频全季规划、制作与返工交付 | `hetu-video` | `hetu.video.projects.get` | 独立筹备或恢复确切项目与原操作 → 复盘剧本、已选素材、旧工程及实际观看覆盖 → 全季→分集→分镜与资产；专业数据按实际插件合同保存 → 按问题预演并固定代表性生成与预算，未知查原提供方任务 → 剪辑音画→固定区间意见→局部返工→逐集成片与可恢复工程 |
| 设置偏好或安装所选Skills套件 | `hetu-manage` | `hetu.local_settings.get` | 读取本机基线 → 准备固定设置方案 → 记录真实选择 → 精确市场预检后执行；未知沿原键只读恢复 → 分别核对安装和本会话加载状态 |
| 配置模型渠道 | `hetu-manage` | `hetu.model_settings.inspect` | 读取非敏感设置及摘要 → 按真实指令提交固定设置 → 凭据仅进入私密存储 → 回读非敏感结果；生成与费用另行授权 |
| 安装、启停或卸载插件 | `hetu-manage` | `hetu.plugins.inspect` | 核对包内容及摘要 → 核对依赖和状态基线 → 提交真实安装选择 → 回读原操作 → 启用后发现公开核心及插件能力 |
| 使用插件及接续数据迁移 | `hetu-manage` | `hetu.plugins.capabilities` | 读取活动包与作品连接 → 发现核心和专业动作Schema → 固定输入及原键执行 → 迁移固定前后内容和CAS → 回读原操作及成果 |
| 发现并按需读取插件Skill | `hetu-setup` | `hetu.plugins.inspect` | 列出活动插件方法摘要 → 按精确作品发现skills及resource_actions → 通过invoke的skills.read读取同包方法与引用 → 按实际Schema执行并回读；停用或升级后重查 |
| 保存文稿版本 | `hetu-manage` | `hetu.git.status` | 读取本作品HEAD → 准备固定文稿快照 → 审阅完整差异及提交身份 → 记录确切snapshot决定 → 执行并沿原snapshot和键回读 |
| 导出文稿或交付包 | `hetu-manage` | `hetu.documents.preview_export` | 读取确切修订及交付目标 → 准备固定交付方案 → 记录真实决定 → 执行并核验文件和摘要 |

## 按领域定位

| 功能领域 | Skill | 动作数 | 作者入口缺口 | 专项已验证 |
| --- | --- | ---: | ---: | ---: |
| 能力导航与Review | hetu-setup | 2 | 0 | 0 |
| 接入与恢复 | hetu-setup | 8 | 0 | 0 |
| 设定与规则 | hetu-outline | 6 | 0 | 0 |
| 章节、正文与定稿 | hetu-import、hetu-manage | 16 | 0 | 0 |
| 参考稿与采纳 | hetu-draft | 6 | 0 | 0 |
| 剧情与一致性 | hetu-drama | 10 | 0 | 0 |
| 剧本与改编 | hetu-drama | 18 | 0 | 0 |
| 审核与返工 | hetu-revise | 5 | 0 | 0 |
| 文稿版本与协作 | hetu-manage | 20 | 0 | 0 |
| 图片与素材 | hetu-artwork、hetu-import | 11 | 0 | 0 |
| 小说资料与目录 | hetu-book-profile | 5 | 0 | 0 |
| 新建与创作库接纳 | hetu-book-create | 6 | 0 | 2 |
| 创作任务与接续 | hetu-setup | 10 | 1 | 0 |
| 局部选择 | hetu-setup | 2 | 0 | 0 |
| 封面 | hetu-cover、hetu-import | 9 | 2 | 0 |
| 导出与交付 | hetu-manage | 3 | 0 | 0 |
| 作者批注 | hetu-revise | 2 | 0 | 0 |
| 大纲 | hetu-outline | 2 | 0 | 0 |
| 资料与来源 | hetu-resources | 8 | 0 | 0 |
| 连接与精确授权 | hetu-setup | 9 | 0 | 0 |
| 持续参考稿与反馈 | hetu-draft、hetu-revise | 6 | 0 | 0 |
| 按需上下文 | hetu-setup | 3 | 0 | 0 |
| 模型计划与费用 | hetu-setup | 8 | 0 | 0 |
| 共享固定方案 | hetu-manage | 7 | 0 | 0 |
| 本机设置与套件安装 | hetu-manage | 7 | 0 | 6 |
| 作品读取与关联 | hetu-manage | 7 | 0 | 0 |
| 视频工程 | hetu-video | 13 | 0 | 0 |
| 整书导入与恢复 | hetu-import | 3 | 0 | 0 |
| 插件授权 | hetu-manage | 6 | 0 | 3 |
| 模型渠道设置 | hetu-manage | 3 | 0 | 0 |
| 插件安装与生命周期 | hetu-manage | 6 | 0 | 4 |
| 运行与方法诊断 | hetu-setup | 1 | 0 | 0 |
| 任务接续与交接 | hetu-setup | 2 | 0 | 0 |
| 随包基础能力 | hetu-setup | 1 | 0 | 0 |

## AI 按需查询

先按目标选择Skill，再窄查动作；只有准备执行时才读取输入Schema，避免每次加载全部动作。

```bash
hetu --client codex call hetu.capabilities.map --input - <<'JSON'
{"skill":"hetu-import","limit":8}
JSON
```

MCP 对应调用 `hetu_get_capability_map`，参数同上。具体动作查询可传 `action` 和 `include_schema: true`，分页沿返回的 `next_offset`。地图不授予作品权限，执行仍使用实际能力发现返回的精确引用。

## Skills 方法入口

| Skill | 适用目标 | 源文件 |
| --- | --- | --- |
| `hetu-setup` | 在河图洛书任务首次接入、检查当前客户端能力或恢复已知任务时使用；不用于生成小说正文。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) |
| `hetu-book-create` | 作者希望从零筹备小说或剧本，或为已有河图洛书筹备构思方向、书名、简介及初步大纲时使用。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-book-create/SKILL.md) |
| `hetu-book-profile` | 作者在河图洛书为已知作品拟书名、简介、卖点或其他资料候选时使用。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-book-profile/SKILL.md) |
| `hetu-outline` | 作者通过河图洛书设计或调整总纲、卷纲和章纲时使用。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-outline/SKILL.md) |
| `hetu-cover` | 为河图洛书 Hetu Luoshu 小说封面任务设计并生成候选图片，按任务约定写回作品目录，供作者在河图洛书预览选用。用于用户提供河图洛书封面 request.json 或请求完成河图洛书封面设计时。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-cover/SKILL.md) |
| `hetu-draft` | 作者通过河图洛书明确请求章节起草或续写参考稿时使用，不在保存正文时自动触发。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) |
| `hetu-revise` | 作者通过河图洛书明确请求固定原文选区改稿，或依据公开批注返工参考稿时使用。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) |
| `hetu-drama` | 作者通过河图洛书复盘、规划、创作或返工剧本，组织全剧、分集和场次，或将已授权原著改编为 Fountain 参考稿时使用。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) |
| `hetu-resources` | 作者通过河图洛书资料任务整理人物资料、场景参考、道具说明或考据笔记时使用。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-resources/SKILL.md) |
| `hetu-artwork` | 为河图洛书角色、场景、道具及插图任务设计图片候选，通过实际发现的图像工具生成并回写固定任务，供作者预览。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) |
| `hetu-manage` | 作者需要在河图洛书整理作品资料、卷章大纲、设定、短剧场次、资料关联、导入交付、版本或本机设置时使用。由 Agent 准备完整操作，作者审阅后执行；正文创作和改稿使用对应写作 Skill。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) |
| `hetu-import` | 作者要求将已有小说导入河图洛书，或从 TXT、Markdown、Word、EPUB 整理分卷章节并接续改编时使用。保留原稿、核对目录和来源，通过 CLI/MCP 固定方案导入，支持中断恢复。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-import/SKILL.md) |
| `hetu-video` | 在河图洛书复盘、规划或推进短剧视频项目，组织全季分集、分镜、预演、生成、剪辑音画、媒体返工及工程交付时使用。 | [SKILL.md](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) |

## Review 方法

每个领域逐项检查：目标是否可从当前对话开始；实际能力是否可发现；作者是否需要重复填表或进入桌面；决定是否固定结果与版本；执行是否仍为 Agent；成功是否可回读；未知结果是否可沿原键恢复；越权、撤权、冲突是否拒绝。

表中 MCP 的“固定方案”表示该领域动作通过共享 prepare／record_decision／execute 工具执行，并非直接暴露作者函数。`workspace` profile 不能等同于稳定连接，也不能等同于获权作品。Skills 是方法层，不凭文件存在获得执行权限。

纯视图状态（窗口尺寸、滚动位置、浏览器布局）不作为创作领域业务接口。私密批注和凭据不能因机器可操作而成为普通读取内容。仅作者入口行表示实现缺口或受限旧入口，不能由 Agent 自设作者身份绕过。

## 完整动作清单

### 能力导航与Review

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 查询当前构建实际实现的动作<br>`hetu.capabilities.get` | `hetu_managed_capabilities_get` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 按目标、领域或Skill查询人机能力地图及Review证据<br>`hetu.capabilities.map` | `hetu_get_capability_map` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 接入与恢复

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取当前工作区<br>`hetu.workspaces.get` | `hetu_get_workspace` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 列出当前授权工作区与内容包<br>`hetu.workspaces.list` | `hetu_list_workspace` (workspace) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 查询原操作回执<br>`hetu.operations.get` | `hetu_read_task_operation` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 从当前对象和实际能力生成页面交接<br>`hetu.handoffs.get` | `hetu_get_page_handoff` (workspace/stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 按任务查找随包共同方法、固定摘要与读取入口<br>`hetu.methods.list` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 按固定摘要分块读取共同方法；不读取任意本机文件<br>`hetu.methods.read` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 按精确任务分页查询执行成功、失败、取消和未知状态；不读取请求正文<br>`hetu.task_executions.list` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 核对执行尝试与终态，沿固定原操作或模型计划恢复<br>`hetu.task_executions.get` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 设定与规则

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取设定集及确切修订<br>`hetu.blueprints.get` | `hetu_read_blueprint` (workspace/stable) | [hetu-outline](../tools/hetu-skills/base/skills/hetu-outline/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 预览设定实体变更<br>`hetu.blueprints.preview_change` | `hetu_managed_blueprints_preview_change` (stable) | [hetu-outline](../tools/hetu-skills/base/skills/hetu-outline/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 保存作者确认的设定实体变更<br>`hetu.blueprints.save` | 固定方案 | [hetu-outline](../tools/hetu-skills/base/skills/hetu-outline/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 作者锁定或解锁设定集<br>`hetu.blueprints.lock` | 固定方案 | [hetu-outline](../tools/hetu-skills/base/skills/hetu-outline/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 作者锁定或解锁设定集<br>`hetu.blueprints.unlock` | 固定方案 | [hetu-outline](../tools/hetu-skills/base/skills/hetu-outline/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 为既有剧本或视频建立独立空设定；保留旧根设定及任务<br>`hetu.blueprints.initialize` | 固定方案 | [hetu-outline](../tools/hetu-skills/base/skills/hetu-outline/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |

### 章节、正文与定稿

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 作者新建正文文档<br>`hetu.documents.create` | `hetu_create_empty_document` (stable)<br>固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 列出文档<br>`hetu.documents.list` | `hetu_list_documents` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取不可变正文修订<br>`hetu.documents.get` | `hetu_get_document` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 基于确切基线保存正文新修订<br>`hetu.documents.save` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 直接检查已保存正文，无需创建草稿<br>`hetu.documents.validate` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 预览确切正文修订的独立定稿资格<br>`hetu.documents.preview_finalization` | `hetu_preview_finalization` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者独立确认确切正文修订<br>`hetu.documents.finalize` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 撤回当前定稿，保留正文及历史<br>`hetu.documents.withdraw_finalization` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取采纳来源与独立定稿历史<br>`hetu.documents.lifecycle` | `hetu_read_document_lifecycle` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 预览固定正文的格式转换与损失<br>`hetu.documents.preview_export` | `hetu_managed_documents_preview_export` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 由作者确认导出固定正文与转换报告<br>`hetu.documents.export` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 检查作者选择的文本文件与导入损失<br>`hetu.documents.preview_import` | `hetu_managed_documents_preview_import` (stable) | [hetu-import](../tools/hetu-skills/base/skills/hetu-import/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 由作者确认导入新文档修订并保存转换报告<br>`hetu.documents.import` | 固定方案 | [hetu-import](../tools/hetu-skills/base/skills/hetu-import/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 固定一批小说原稿及目录基线，原子导入章节并保留逐章来源<br>`hetu.documents.import_batch` | 固定方案 | [hetu-import](../tools/hetu-skills/base/skills/hetu-import/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 分页读取本作品正文修订历史<br>`hetu.documents.history` | `hetu_managed_documents_history` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 按当前正文修订改名，保持内容不变<br>`hetu.documents.rename` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |

### 参考稿与采纳

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 外部 Agent 或作者提交待审草稿<br>`hetu.drafts.submit` | `hetu_write_draft` (workspace) | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 查询草稿审核状态<br>`hetu.drafts.list` | 无直接工具映射 | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取确切草稿与审核状态<br>`hetu.drafts.get` | `hetu_managed_drafts_get` (stable) | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者提交当前保存修订作为独立待审草稿<br>`hetu.drafts.submit_current` | 固定方案 | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 预览固定参考稿选区对写作稿的修改<br>`hetu.drafts.preview_adoption` | `hetu_preview_adoption` (stable) | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者采纳参考内容并保存来源，定稿保持不变<br>`hetu.drafts.adopt` | 固定方案 | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |

### 剧情与一致性

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 从固定原文修订提取剧情候选<br>`hetu.plot.extract` | `hetu_extract_plot` (workspace/stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者校正剧情节点并保存新修订<br>`hetu.plot.correct` | 固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取固定剧情修订与当前性<br>`hetu.plot.get` | `hetu_managed_plot_get` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 查询当前工作区内的剧情提取修订<br>`hetu.plot.list` | `hetu_managed_plot_list` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 对固定剧情与设定修订执行一致性诊断<br>`hetu.validation.run` | `hetu_validate_blueprint` (workspace/stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者记录问题处置与理由<br>`hetu.findings.disposition` | 固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取不可变诊断报告及当前处置<br>`hetu.reports.get` | `hetu_managed_reports_get` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分页查询固定诊断报告<br>`hetu.reports.list` | `hetu_managed_reports_list` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 提交问题处置建议，不改变作者决定<br>`hetu.findings.suggest` | `hetu_findings_suggest` (workspace/stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取固定问题的处置建议<br>`hetu.findings.suggestions` | `hetu_findings_suggestions` (workspace/stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 剧本与改编

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 将固定剧情修订转换为独立短剧结构候选<br>`hetu.drama.build_skeleton` | `hetu_build_drama_skeleton` (workspace/stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取固定短剧骨架修订与当前性<br>`hetu.drama.get_skeleton` | `hetu_managed_drama_get_skeleton` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分页查询短剧骨架及修订<br>`hetu.drama.list_skeletons` | `hetu_managed_drama_list_skeletons` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者拆合重排短剧结构并保存不可变修订<br>`hetu.drama.edit_skeleton` | 固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 对比骨架映射与固定原著修订<br>`hetu.drama.compare` | `hetu_managed_drama_compare` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取固定骨架原著结构差异报告<br>`hetu.drama.get_comparison` | `hetu_managed_drama_get_comparison` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分页查询骨架原著差异报告<br>`hetu.drama.list_comparisons` | `hetu_managed_drama_list_comparisons` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者从固定骨架建立独立 Fountain 结构剧本与不可变来源映射<br>`hetu.drama.create_script` | 固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取剧本初始结构映射并核验固定证据及当前性<br>`hetu.drama.get_script_mapping` | `hetu_managed_drama_get_script_mapping` (stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 新建独立短剧短剧项目<br>`hetu.drama.projects.create` | `hetu_create_drama_project` (stable)<br>固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取短剧项目<br>`hetu.drama.projects.get` | `hetu_read_drama_project` (workspace/stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 列出当前作品的短剧项目<br>`hetu.drama.projects.list` | `hetu_list_drama_projects` (workspace/stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 修改名称、说明或归档状态<br>`hetu.drama.projects.update` | 固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 将未归属的骨架或剧本归入短剧项目<br>`hetu.drama.projects.attach` | 固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 在短剧项目中建立独立分集剧本<br>`hetu.drama.episodes.create` | `hetu_create_drama_episode` (stable)<br>固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取写作分集与当前集序<br>`hetu.drama.episodes.get` | `hetu_read_drama_episode` (workspace/stable) | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 维护分集计划或归档<br>`hetu.drama.episodes.update` | 固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 重排项目完整分集目录<br>`hetu.drama.episodes.reorder` | 固定方案 | [hetu-drama](../tools/hetu-skills/base/skills/hetu-drama/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |

### 审核与返工

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 作者开始审核并冻结既有草稿的证据<br>`hetu.reviews.begin` | 固定方案 | [hetu-revise](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 检查不可变草稿并同事务保存剧情与诊断报告<br>`hetu.reviews.validate` | `hetu_validate_draft` (workspace/stable) | [hetu-revise](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 记录参考稿审核决定，不修改正文或定稿<br>`hetu.reviews.decide` | 固定方案 | [hetu-revise](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 查询草稿证据、诊断与不可变审核历史<br>`hetu.reviews.get` | `hetu_managed_reviews_get` (stable) | [hetu-revise](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分页查询审核草稿状态<br>`hetu.reviews.list` | `hetu_managed_reviews_list` (stable) | [hetu-revise](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 文稿版本与协作

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取当前内容仓库与工作树状态<br>`hetu.git.status` | `hetu_managed_git_status` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取文件的工作树与HEAD差异<br>`hetu.git.diff` | `hetu_managed_git_diff` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分页读取提交历史<br>`hetu.git.log` | `hetu_managed_git_log` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者初始化独立内容仓库<br>`hetu.git.init` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 准备或执行确切Git快照<br>`hetu.git.snapshot` | `hetu_commit_snapshot` (workspace/stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者确认确切快照及提交身份<br>`hetu.git.approve_snapshot` | 无直接工具映射 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 机器使用独立合同：hetu.git.record_snapshot_decision | 机器替代入口；安装待核对 |
| 读取固定快照、当前性与本机批准状态<br>`hetu.git.get_snapshot` | `hetu_managed_git_get_snapshot` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分页读取本机准备的Git快照<br>`hetu.git.list_snapshots` | `hetu_managed_git_list_snapshots` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 核对固定快照内文件的确切差异<br>`hetu.git.snapshot_diff` | `hetu_managed_git_snapshot_diff` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取版本线和无凭据远端<br>`hetu.git.references` | `hetu_git_references` (workspace/stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 预览固定版本合并和冲突<br>`hetu.git.merge_preview` | `hetu_git_merge_preview` (workspace/stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 准备新版本线<br>`hetu.git.branch_create` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 准备切换版本记录并保留当前正文<br>`hetu.git.branch_switch` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 准备合并固定版本记录<br>`hetu.git.merge` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 准备绑定不含凭据的远端<br>`hetu.git.remote_save` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 准备拉取远端固定版本<br>`hetu.git.fetch` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 准备推送确切版本<br>`hetu.git.push` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 准备合并已拉取的固定远端版本<br>`hetu.git.pull` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取确切历史版本和有界文件，不覆盖当前正文<br>`hetu.git.read_version` | `hetu_git_read_version` (workspace/stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 记录作者在当前会话对固定文稿版本及提交身份的决定<br>`hetu.git.record_snapshot_decision` | `hetu_record_version_decision` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 固定 snapshot_id/SHA 和提交身份；登记不提交 | 源码已连线；安装待核对 |

### 图片与素材

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 检查作者选定或 Agent 明确提交的媒体签名与摘要<br>`hetu.assets.inspect` | `hetu_managed_assets_inspect` (stable) | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 复制选定媒体并登记来源与权利声明<br>`hetu.assets.import` | 固定方案 | [hetu-import](../tools/hetu-skills/base/skills/hetu-import/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 作者修订素材元数据与权利声明<br>`hetu.assets.update` | 固定方案 | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 核验固定素材修订、媒体摘要与当前权利<br>`hetu.assets.get` | `hetu_managed_assets_get` (stable) | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分页查询已登记媒体元数据<br>`hetu.assets.list` | `hetu_managed_assets_list` (stable) | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者保存乐律或视觉线索与固定来源引用<br>`hetu.cues.save` | 固定方案 | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取固定线索与来源过期状态<br>`hetu.cues.get` | `hetu_managed_cues_get` (stable) | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分页查询乐律与视觉线索<br>`hetu.cues.list` | `hetu_managed_cues_list` (stable) | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 预览当前作品的图片参考任务，不外发内容<br>`hetu.image_tasks.preview_prompt` | `hetu_preview_image_task` (workspace) | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 准备当前作品的图片参考任务，不调用模型或批准费用<br>`hetu.image_tasks.prepare` | `hetu_prepare_image_task` (workspace)<br>固定方案 | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 分块读取当前作品固定素材原字节<br>`hetu.assets.read_blob` | 无直接工具映射 | [hetu-artwork](../tools/hetu-skills/base/skills/hetu-artwork/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 小说资料与目录

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取当前小说资料与有序卷章目录<br>`hetu.novels.get` | `hetu_get_novel` (stable) | [hetu-book-profile](../tools/hetu-skills/base/skills/hetu-book-profile/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者确认并初始化既有作品的小说目录<br>`hetu.novels.initialize` | 固定方案 | [hetu-book-profile](../tools/hetu-skills/base/skills/hetu-book-profile/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 保存小说资料<br>`hetu.novels.update` | 固定方案 | [hetu-book-profile](../tools/hetu-skills/base/skills/hetu-book-profile/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 保存小说卷章顺序与分卷归属<br>`hetu.novels.save_structure` | 固定方案 | [hetu-book-profile](../tools/hetu-skills/base/skills/hetu-book-profile/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取小说目录、固定正文来源及实际字数<br>`hetu.novels.snapshot` | `hetu_novels_snapshot` (stable) | [hetu-book-profile](../tools/hetu-skills/base/skills/hetu-book-profile/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 新建与创作库接纳

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取单项建书筹备<br>`hetu.creation_projects.get` | `hetu_get_creation_project` (stable) | [hetu-book-create](../tools/hetu-skills/base/skills/hetu-book-create/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 保存作者的筹备想法和所选资料<br>`hetu.creation_projects.save` | `hetu_save_creation_project` (stable) | [hetu-book-create](../tools/hetu-skills/base/skills/hetu-book-create/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 从筹备创建独立小说并保存来源<br>`hetu.creation_projects.create_novel` | `hetu_create_novel_from_project` (stable) | [hetu-book-create](../tools/hetu-skills/base/skills/hetu-book-create/SKILL.md) | 按任务或读取范围执行 | 已验证；安装已发现 |
| 将筹备资料创建为独立剧本作品<br>`hetu.creation_projects.create_drama` | `hetu_create_drama_from_project` (stable) | [hetu-book-create](../tools/hetu-skills/base/skills/hetu-book-create/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 开始独立小说、剧本或视频筹备，预留全新受管目录，不获得既有作品权限<br>`hetu.creation_projects.create` | `hetu_begin_creation` (stable) | [hetu-book-create](../tools/hetu-skills/base/skills/hetu-book-create/SKILL.md) | 按任务或读取范围执行 | 已验证；安装已发现 |
| 将筹备创建为独立视频项目，无小说或剧本前置<br>`hetu.creation_projects.create_video` | `hetu_create_video_from_project` (stable) | [hetu-book-create](../tools/hetu-skills/base/skills/hetu-book-create/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 创作任务与接续

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 预览小说构思、书名简介、大纲、章节起草、改稿、剧本和资料整理的固定任务与提示词<br>`hetu.creative_tasks.preview_prompt` | `hetu_preview_creative_task` (stable/workspace) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 准备小说构思、书名简介、大纲、章节起草、改稿、剧本和资料整理的固定协作任务<br>`hetu.creative_tasks.prepare` | `hetu_prepare_creative_task` (stable)<br>固定方案 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取指定任务与参考结果<br>`hetu.creative_tasks.get` | `hetu_read_creative_task` (task/stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 列出本范围的外部任务<br>`hetu.creative_tasks.list` | `hetu_list_creative_tasks` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 向获权任务提交独立参考成果<br>`hetu.creative_tasks.submit_result` | `hetu_submit_creative_result` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 核验指定任务收件文件并登记成果<br>`hetu.creative_tasks.inspect_inbox` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 机器使用独立合同：hetu.creative_tasks.submit_result | 机器替代入口；安装待核对 |
| 关闭本机任务跟踪并撤销后续任务访问<br>`hetu.creative_tasks.close` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 仅作者入口；机器路径缺口须逐项处理 | 作者入口缺口；安装待核对 |
| 记录作者已复制固定任务提示词<br>`hetu.creative_tasks.mark_copied` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 宿主剪贴板状态；机器执行不要求复制提示词。 | 宿主边界；安装待核对 |
| 分块读取固定文字候选；不跟随新版<br>`hetu.creative_tasks.read_candidate` | `hetu_read_task_candidate` (task/stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分层核对固定候选、专业Owner检查覆盖与反证、作者决定；不以Agent说明或候选存在宣称完成<br>`hetu.creative_tasks.assess` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 局部选择

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取当前任务的局部选择视图<br>`hetu.interactions.get` | `hetu_open_task_view` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 记录本任务候选偏好，不采纳或定稿<br>`hetu.interactions.save_selection` | `hetu_save_task_selection` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 封面

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 核验作者选用的封面与历史修订<br>`hetu.covers.get` | `hetu_read_cover` (stable) | [hetu-cover](../tools/hetu-skills/base/skills/hetu-cover/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 预览外部封面设计提示词<br>`hetu.covers.preview_prompt` | 无直接工具映射 | [hetu-cover](../tools/hetu-skills/base/skills/hetu-cover/SKILL.md) | 机器使用独立合同：hetu.image_tasks.preview_prompt | 机器替代入口；安装待核对 |
| 保存作者确认的封面设计请求<br>`hetu.covers.create_request` | 无直接工具映射 | [hetu-cover](../tools/hetu-skills/base/skills/hetu-cover/SKILL.md) | 机器使用独立合同：hetu.image_tasks.prepare | 机器替代入口；安装待核对 |
| 列出当前作品的封面设计请求<br>`hetu.covers.list_requests` | 无直接工具映射 | [hetu-cover](../tools/hetu-skills/base/skills/hetu-cover/SKILL.md) | 机器使用独立合同：hetu.creative_tasks.list | 机器替代入口；安装待核对 |
| 核验外部封面回执与候选图片<br>`hetu.covers.list_candidates` | 无直接工具映射 | [hetu-cover](../tools/hetu-skills/base/skills/hetu-cover/SKILL.md) | 机器使用独立合同：hetu.creative_tasks.get、hetu.assets.list | 机器替代入口；安装待核对 |
| 由作者选用封面并保存素材与来源<br>`hetu.covers.select` | 固定方案 | [hetu-cover](../tools/hetu-skills/base/skills/hetu-cover/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 将本书建书筹备中的封面候选复制为受管素材并保留来源<br>`hetu.covers.import_preparation` | 无直接工具映射 | [hetu-import](../tools/hetu-skills/base/skills/hetu-import/SKILL.md) | 仅作者入口；机器路径缺口须逐项处理 | 作者入口缺口；安装待核对 |
| 核验并预览已转入本书的筹备封面<br>`hetu.covers.list_preparations` | 无直接工具映射 | [hetu-cover](../tools/hetu-skills/base/skills/hetu-cover/SKILL.md) | 仅作者入口；机器路径缺口须逐项处理 | 作者入口缺口；安装待核对 |
| 完整解码作者选择的封面并生成等比预览<br>`hetu.covers.inspect_file` | 无直接工具映射 | [hetu-cover](../tools/hetu-skills/base/skills/hetu-cover/SKILL.md) | 作者文件选择入口；机器导入固定inline_source后使用hetu.assets.inspect。 | 宿主边界；安装待核对 |

### 导出与交付

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 预览固定修订的交付内容、缺口与素材排除<br>`hetu.bundles.preview` | `hetu_managed_bundles_preview` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 由作者确认导出固定版本交付包<br>`hetu.bundles.export` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 核验本作品已导出交付包的清单与摘要<br>`hetu.bundles.verify` | `hetu_managed_bundles_verify` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 作者批注

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取作者批注<br>`hetu.annotations.list` | 无直接工具映射 | [hetu-revise](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) | 作者私密批注；对外反馈使用hetu.task_feedback.list。 | 宿主边界；安装待核对 |
| 保存作者批注，原文引用保持不变<br>`hetu.annotations.save` | 无直接工具映射 | [hetu-revise](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) | 作者私密批注；Agent反馈使用hetu.task_feedback.save。 | 宿主边界；安装待核对 |

### 大纲

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取总纲、卷纲与章纲<br>`hetu.outlines.get` | `hetu_read_outline` (workspace/stable) | [hetu-outline](../tools/hetu-skills/base/skills/hetu-outline/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 保存关联卷章的大纲<br>`hetu.outlines.save` | 固定方案 | [hetu-outline](../tools/hetu-skills/base/skills/hetu-outline/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |

### 资料与来源

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 新建资料草稿<br>`hetu.resources.create` | `hetu_create_resource` (task) | [hetu-resources](../tools/hetu-skills/base/skills/hetu-resources/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 维护获权资料<br>`hetu.resources.update` | `hetu_update_resource` (task) | [hetu-resources](../tools/hetu-skills/base/skills/hetu-resources/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取固定资料修订<br>`hetu.resources.get` | `hetu_read_resource` (workspace/task/stable) | [hetu-resources](../tools/hetu-skills/base/skills/hetu-resources/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 查询资料摘要<br>`hetu.resources.list` | `hetu_list_resources` (workspace/task/stable) | [hetu-resources](../tools/hetu-skills/base/skills/hetu-resources/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者采用资料<br>`hetu.resources.adopt` | 固定方案 | [hetu-resources](../tools/hetu-skills/base/skills/hetu-resources/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 作者归档资料<br>`hetu.resources.archive` | 固定方案 | [hetu-resources](../tools/hetu-skills/base/skills/hetu-resources/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 关联固定资料与正文位置<br>`hetu.resource_usages.save` | 固定方案 | [hetu-resources](../tools/hetu-skills/base/skills/hetu-resources/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 查询资料使用位置<br>`hetu.resource_usages.list` | `hetu_managed_resource_usages_list` (stable) | [hetu-resources](../tools/hetu-skills/base/skills/hetu-resources/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 连接与精确授权

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 授权所选客户端访问本任务<br>`hetu.collaboration.authorize` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 初始任务授权由宿主核验；机器prepare创建的任务自动登记精确task_locator。 | 宿主边界；安装待核对 |
| 撤销所选客户端的本机任务授权<br>`hetu.collaboration.revoke` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 任务访问撤销属于宿主授权控制；不能从任务内提升权限。 | 宿主边界；安装待核对 |
| 检查本机接入与实际任务能力<br>`hetu.collaboration.inspect` | `hetu_inspect_collaboration` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 打开作者已授权的确切任务<br>`hetu.collaboration.open` | `hetu_open_collaboration_task` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者撤销本作品的有限管理授权及其派生任务<br>`hetu.collaboration.revoke_management` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 撤销父级管理授权属于宿主授权控制。 | 宿主边界；安装待核对 |
| 授权所选客户端读取当前作品并准备固定管理方案<br>`hetu.collaboration.authorize_workspace` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 已有作品初始授权由宿主核验；机器新建作品自动接纳精确授权。 | 宿主边界；安装待核对 |
| 读取当前客户端新建的受管作品交接<br>`hetu.collaboration.created_works` | `hetu_list_created_works` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取所选客户端当前作品的授权状态<br>`hetu.collaboration.workspace_access` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 宿主查询初始授权状态；机器以inspect及精确management_ref发现。 | 宿主边界；安装待核对 |
| 调用本连接已登记的确切动作；复用原授权与Schema<br>`hetu.collaboration.invoke` | `hetu_call_action` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 持续参考稿与反馈

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 创建任务参考稿<br>`hetu.working_copies.create` | `hetu_create_working_copy` (task) | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取固定参考稿修订<br>`hetu.working_copies.get` | `hetu_read_working_copy` (task) | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 列出任务参考稿<br>`hetu.working_copies.list` | `hetu_list_working_copies` (task) | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 保存参考稿新修订<br>`hetu.working_copies.save` | `hetu_save_working_copy` (task) | [hetu-draft](../tools/hetu-skills/base/skills/hetu-draft/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 保存针对固定成果的公开意见<br>`hetu.task_feedback.save` | `hetu_save_task_feedback` (task) | [hetu-revise](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取任务公开意见与后续成果<br>`hetu.task_feedback.list` | `hetu_list_task_feedback` (task) | [hetu-revise](../tools/hetu-skills/base/skills/hetu-revise/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 按需上下文

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 查看任务固定资料目录<br>`hetu.task_context.list` | `hetu_list_task_context` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 按需读取任务固定资料<br>`hetu.task_context.read` | `hetu_read_task_context` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 检索任务已授权固定资料<br>`hetu.task_context.search` | `hetu_search_task_context` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 模型计划与费用

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取当前账号的文字或图片模型目录<br>`hetu.models.list` | `hetu_list_models` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取本任务的模型计划及作者批准状态<br>`hetu.model_tasks.list` | `hetu_list_model_plans` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 独立任务与费用授权；不能用通用方案代替 | 源码已连线；安装待核对 |
| 固定模型输入、报价和内容外发预览，不执行生成<br>`hetu.model_tasks.prepare` | `hetu_prepare_model_task` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 独立任务与费用授权；不能用通用方案代替 | 源码已连线；安装待核对 |
| 按当前Agent对话中的真实授权登记任务额度，额度内连续生成<br>`hetu.model_tasks.authorize_usage` | `hetu_authorize_model_usage` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 独立任务与费用授权；不能用通用方案代替 | 源码已连线；安装待核对 |
| 作者确认固定模型输入外发和本次费用上限<br>`hetu.model_tasks.approve` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 机器使用独立合同：hetu.model_tasks.authorize_usage | 机器替代入口；安装待核对 |
| 沿原模型计划查询结果，不重新生成<br>`hetu.model_tasks.get` | `hetu_get_model_task` (task)<br>`hetu_request_model_confirmation` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 独立任务与费用授权；不能用通用方案代替 | 源码已连线；安装待核对 |
| 执行作者已批准的原模型计划<br>`hetu.model_tasks.submit` | `hetu_submit_model_task` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 独立任务与费用授权；不能用通用方案代替 | 源码已连线；安装待核对 |
| 核验并取得原模型结果，保存为任务候选文件<br>`hetu.model_tasks.collect` | `hetu_collect_model_task` (task) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 独立任务与费用授权；不能用通用方案代替 | 源码已连线；安装待核对 |

### 共享固定方案

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 准备固定作品管理方案，不改变正式内容<br>`hetu.agent_operations.prepare` | `hetu_prepare_management_operation` (workspace/stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取固定管理方案、决定和执行结果<br>`hetu.agent_operations.get` | `hetu_get_management_operation` (workspace/stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 查询本作品待审管理方案<br>`hetu.agent_operations.list` | `hetu_list_management_operations` (workspace/stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 作者确认或撤销固定管理方案<br>`hetu.agent_operations.decide` | 无直接工具映射 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 机器使用独立合同：hetu.agent_operations.record_decision | 机器替代入口；安装待核对 |
| 执行作者已批准的确切管理方案<br>`hetu.agent_operations.execute` | `hetu_execute_management_operation` (workspace/stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 发现固定方案支持的领域动作、输入Schema与会话决定路径<br>`hetu.agent_operations.catalog` | `hetu_list_management_actions` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 记录作者在当前会话对确切固定方案的决定，保留Agent执行身份<br>`hetu.agent_operations.record_decision` | `hetu_record_management_decision` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 本机设置与套件安装

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取可交接的本机偏好与套件目录<br>`hetu.local_settings.get` | `hetu_local_settings_get` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 独立本机固定方案；record_decision 后 execute | 已验证；安装已发现 |
| 核对指定客户端的套件文件、版本及登记，不证明当前会话已加载<br>`hetu.local_settings.inspect_suite` | `hetu_local_settings_inspect_suite` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 独立本机固定方案；record_decision 后 execute | 已验证；安装已发现 |
| 核对所选Agent的机器连接包登记与固定缓存，不推定当前GUI会话已加载<br>`hetu.local_settings.inspect_connection` | 无直接工具映射 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 独立本机固定方案；record_decision 后 execute | 源码已连线；安装待核对 |
| 准备本机设置或套件选择安装方案<br>`hetu.local_settings.prepare` | `hetu_local_settings_prepare` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 独立本机固定方案；record_decision 后 execute | 已验证；安装已发现 |
| 读取当前客户端本机方案与执行结果<br>`hetu.local_settings.get_operation` | `hetu_local_settings_get_operation` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 独立本机固定方案；record_decision 后 execute | 已验证；安装已发现 |
| 执行作者批准的确切本机方案<br>`hetu.local_settings.execute` | `hetu_local_settings_execute` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 独立本机固定方案；record_decision 后 execute | 已验证；安装已发现 |
| 记录当前会话对固定本机偏好或套件方案的确切决定<br>`hetu.local_settings.record_decision` | `hetu_local_settings_record_decision` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 独立本机固定方案；record_decision 后 execute | 已验证；安装已发现 |

### 作品读取与关联

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 列出当前获权工作区的创作对象<br>`hetu.works.list` | `hetu_list_works` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取精确创作对象与固定资料修订<br>`hetu.works.get` | `hetu_read_work` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 建立两个固定创作修订的来源关联<br>`hetu.work_links.create` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取创作对象的双向固定关联<br>`hetu.work_links.list` | `hetu_read_work_links` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 读取关联的固定依据与确切历史<br>`hetu.work_links.get` | `hetu_read_work_link` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 显式更新同一关联的固定依据，保留历史<br>`hetu.work_links.update_source` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 解除或恢复来源关联，保留依据与历史<br>`hetu.work_links.set_archived` | 固定方案 | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |

### 视频工程

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 建立独立视频项目<br>`hetu.video.projects.create` | `hetu_create_video_project` (stable)<br>固定方案 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取视频项目与分集目录<br>`hetu.video.projects.get` | `hetu_read_video_project` (stable) | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 更新视频项目资料或归档<br>`hetu.video.projects.update` | 固定方案 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 建立视频分集<br>`hetu.video.episodes.create` | `hetu_create_video_episode` (stable)<br>固定方案 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取固定视频分集<br>`hetu.video.episodes.get` | `hetu_read_video_episode` (stable) | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 更新视频分集资料或归档<br>`hetu.video.episodes.update` | 固定方案 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 重排完整视频分集目录<br>`hetu.video.episodes.reorder` | 固定方案 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 登记分集固定媒体与声明时基，接收不代表选用<br>`hetu.video.media.save` | 固定方案 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取分集固定媒体与素材<br>`hetu.video.media.get` | 无直接工具映射 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 分页读取当前分集固定成果<br>`hetu.video.media.list` | 无直接工具映射 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 保存固定媒体上的公开区间意见<br>`hetu.video.feedback.save` | 固定方案 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 准备固定方案 → 会话或桌面记录作者决定 → 执行 | 源码已连线；安装待核对 |
| 读取固定媒体公开意见，不迁移旧坐标<br>`hetu.video.feedback.list` | 无直接工具映射 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 核对选择的固定媒体并准备基础文件交付清单<br>`hetu.video.delivery.preview` | 无直接工具映射 | [hetu-video](../tools/hetu-skills/base/skills/hetu-video/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 整书导入与恢复

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 仅依据作者当前会话的明确指令登记固定整书导入范围<br>`hetu.import_authorizations.register` | `hetu_register_import_authorization` (stable) | [hetu-import](../tools/hetu-skills/base/skills/hetu-import/SKILL.md) | 真实导入指令＋完整固定篇目范围 | 源码已连线；安装待核对 |
| 回读确切整书导入授权及执行游标<br>`hetu.import_authorizations.get` | `hetu_get_import_authorization` (stable) | [hetu-import](../tools/hetu-skills/base/skills/hetu-import/SKILL.md) | 真实导入指令＋完整固定篇目范围 | 源码已连线；安装待核对 |
| 撤销当前客户端的确切导入授权，保留已导入正文<br>`hetu.import_authorizations.revoke` | `hetu_revoke_import_authorization` (stable) | [hetu-import](../tools/hetu-skills/base/skills/hetu-import/SKILL.md) | 真实导入指令＋完整固定篇目范围 | 源码已连线；安装待核对 |

### 插件授权

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 按当前会话的真实选择授权确切插件包及作品数据<br>`hetu.plugin_access.authorize` | `hetu_plugin_access_authorize` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 已验证；安装已发现 |
| 读取当前作品的确切插件授权<br>`hetu.plugin_access.inspect` | `hetu_plugin_access_inspect` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 撤销当前作品的确切插件授权<br>`hetu.plugin_access.revoke` | `hetu_plugin_access_revoke` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 在当前会话登记固定插件数据迁移方案的真实作者决定<br>`hetu.plugin_access.record_migration_decision` | `hetu_plugin_access_record_migration_decision` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| 发现当前已启用河图插件的获权动作与实时Schema<br>`hetu.plugin_access.capabilities` | `hetu_plugin_access_capabilities` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 已验证；安装已发现 |
| 通过稳定入口调用确切河图插件或专业数据动作<br>`hetu.plugin_access.invoke` | `hetu_plugin_access_invoke` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 按任务或读取范围执行 | 已验证；安装已发现 |

### 模型渠道设置

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取本机模型设置摘要与非敏感状态<br>`hetu.model_settings.inspect` | `hetu_model_settings_inspect` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 真实会话指令＋设置基线；凭据不回显 | 源码已连线；安装待核对 |
| 按原键回读模型设置操作<br>`hetu.model_settings.get_operation` | `hetu_model_settings_get_operation` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 真实会话指令＋设置基线；凭据不回显 | 源码已连线；安装待核对 |
| 依据真实会话选择修改模型设置，凭据不回显<br>`hetu.model_settings.update` | `hetu_model_settings_update` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 真实会话指令＋设置基线；凭据不回显 | 源码已连线；安装待核对 |

### 插件安装与生命周期

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取插件安装与依赖状态<br>`hetu.plugins.inspect` | `hetu_plugins_inspect` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 固定包摘要＋安装状态基线＋真实安装选择 | 已验证；安装已发现 |
| 检查预构建插件包、贡献及代码风险<br>`hetu.plugins.inspect_package` | `hetu_plugins_inspect_package` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 固定包摘要＋安装状态基线＋真实安装选择 | 已验证；安装已发现 |
| 执行确切插件安装、启用、停用或卸载选择<br>`hetu.plugins.apply` | `hetu_plugins_apply` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 固定包摘要＋安装状态基线＋真实安装选择 | 已验证；安装已发现 |
| 按原键回读插件安装操作<br>`hetu.plugins.get_operation` | `hetu_plugins_get_operation` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 固定包摘要＋安装状态基线＋真实安装选择 | 已验证；安装已发现 |
| 发现当前已启用河图插件的公开动作与实时Schema<br>`hetu.plugins.capabilities` | `hetu_plugins_capabilities` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 活动包与精确作品连接；无独立插件授权 | 源码已连线；安装待核对 |
| 通过稳定入口调用确切河图插件或专业数据动作<br>`hetu.plugins.invoke` | `hetu_plugins_invoke` (stable) | [hetu-manage](../tools/hetu-skills/base/skills/hetu-manage/SKILL.md) | 活动包与精确作品连接；无独立插件授权 | 源码已连线；安装待核对 |

### 运行与方法诊断

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 只读诊断实际运行版本、目录摘要与方法版本；不修复配置<br>`hetu.runtime.inspect` | `hetu_inspect_runtime` (stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 任务接续与交接

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 读取同一任务的接续记录与固定引用<br>`hetu.task_checkpoint.get` | `hetu_get_task_checkpoint` (task/stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |
| CAS保存计划、逐条依据与假设、交接及陷阱；不改变作者稿与决定<br>`hetu.task_checkpoint.save` | `hetu_save_task_checkpoint` (task/stable) | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

### 随包基础能力

| 功能／CLI 动作 | MCP 入口 | Skill | 范围／决定 | 状态 |
| --- | --- | --- | --- | --- |
| 核对随包基础能力合同，无作品和无插件可查询<br>`hetu.baseline.inspect` | 无直接工具映射 | [hetu-setup](../tools/hetu-skills/base/skills/hetu-setup/SKILL.md) | 按任务或读取范围执行 | 源码已连线；安装待核对 |

## 插件发现入口

河图插件安装在河图，不为每包安装Codex插件或新增MCP连接。先用 `hetu.plugins.inspect` 定位固定包及其自有功能清单；复用作品连接通过稳定 `hetu.plugins.capabilities/invoke` 发现和调用实时Schema。插件启用后经公开SDK复用核心领域服务；目录、固定来源、CAS与恢复由Core统一管理，无独立插件授权。同一连接按需重新查询，停用或升级后旧引用拒绝。插件自行维护视图、数据类型、动作与验证信息，宿主不汇总其业务功能。核心格式和热插拔用例见[插件合同](plugin/21-核心格式与动态能力发现.md)。

插件界面以独立页面打开；`views[].navigation=integrated` 将返回与插件工具栏合并，默认使用宿主返回栏。`host(close_view,{})` 仅请求关闭当前视图，退出前等待恢复稿；应用菜单与 Alt+Left 提供宿主返回入口。该能力只管理界面，不增加机器业务权限，具体合同见[插件20](plugin/20-首期可执行合同与开发入口.md)。

通用二进制导出由`host(save_artifact,...)`核验固定对象、字节预算、摘要与格式后保存到作者选择的文件；不增加Core业务动作或任意路径接口。机器业务从各插件发现固定渲染计划及同包脚本，正常操作无需GUI。具体合同与验收归[插件20](plugin/20-首期可执行合同与开发入口.md)，宿主不维护插件的三维专业清单。


## 维护与检查

```bash
python3 tools/sync-capability-map.py
python3 tools/sync-capability-map.py --check
```

新增或修改领域动作、MCP 映射、权限路由或 Skill 时重新生成。功能测试通过后将确切动作与测试证据写入地图引用的 evidence 文件，再生成；生成器不会把合同声明自动算作验收通过。
