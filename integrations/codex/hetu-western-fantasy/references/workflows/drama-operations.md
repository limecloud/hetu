# 剧本功能操作导航

先从实际能力目录或能力地图按`hetu-drama`窄查。CLI以领域动作名定位；MCP使用目录返回的工具或共享方案入口，不按CLI动作猜MCP名称。每次业务携带精确`management_ref`或完整`task_ref`；下表列方法，不声明执行权限。

## 项目、分集与结构

| 用户目标 | 领域动作 | 处理与回读 |
| --- | --- | --- |
| 从构思创建独立剧本 | `hetu.creation_projects.create_drama` | 先按构思Skill恢复或建立筹备，保存资料后创建；使用返回的新作品管理引用，不造空小说 |
| 在允许新建范围建立项目 | `hetu.drama.projects.create` | 原创／改编、来源及作品身份按Schema提交；已有作品内整理须按目录核对固定方案，避免同名重建 |
| 查询当前项目 | `hetu.drama.projects.list`、`hetu.drama.projects.get` | 列表分页；核对项目身份和有序分集，项目读取不冒充历史组合快照 |
| 修改项目说明或归档 | `hetu.drama.projects.update` | 固定方案；CAS匹配项目修订及摘要，说明变化不覆盖剧本文本 |
| 接入未归属骨架或剧本 | `hetu.drama.projects.attach` | 固定方案；核对原归属、稳定身份及来源，不能重复占用别的项目对象 |
| 创建写作分集 | `hetu.drama.episodes.create` | 按已发现的新建或固定方案合同创建；返回`depisode_id`及文档引用，空文档不是正文成果 |
| 阅读分集及参考稿 | `hetu.drama.episodes.get` | 核对`manuscript`、作者状态、工作稿／提交及真实Fountain；集序由项目目录计算 |
| 修改分集计划或归档 | `hetu.drama.episodes.update` | 固定方案；只更新元数据，回读同一正文身份及未改字节 |
| 重排分集目录 | `hetu.drama.episodes.reorder` | 固定方案；提交完整稳定ID序列，不丢集、不用集号或标题替代ID |
| 从固定剧情建立改编骨架 | `hetu.drama.build_skeleton` | 固定剧情及设定修订，保持部分覆盖、未知时间地点和待审标记；不生成对白，不代替全剧规划 |
| 阅读骨架及历史 | `hetu.drama.list_skeletons`、`hetu.drama.get_skeleton` | 分页及确切修订；骨架`episode_id`与写作分集`depisode_id`不能互换 |
| 场次拆分、合并、重排及资料调整 | `hetu.drama.edit_skeleton` | 固定方案；保留稳定场次身份和来源，输出仍为结构；不自动改写已生成Fountain |
| 与指定原著比较 | `hetu.drama.compare`、`hetu.drama.get_comparison`、`hetu.drama.list_comparisons` | 固定两端、收齐分页及未映射项；这是结构／来源比较，不是任意两个专业规划方案的全文语义比较 |
| 由骨架建立结构剧本 | `hetu.drama.create_script` | 固定方案；回读独立Fountain及初始映射，只生成结构不等于写完对白 |
| 核对结构剧本来源 | `hetu.drama.get_script_mapping` | 核验固定初始字节、场次和来源；后续正文变更不能套用旧坐标 |

## 剧情检查与问题处理

| 用户目标 | 领域动作 | 处理与回读 |
| --- | --- | --- |
| 获取剧情提取候选 | `hetu.plot.extract`、`hetu.plot.list`、`hetu.plot.get` | 固定原文和设定，分开机器提取与Agent语义复盘；不由节点数推断阅读完成 |
| 校正提取结果 | `hetu.plot.correct` | 固定方案；保留原证据及修订，不自行将推断设为作者已确认 |
| 一致性诊断 | `hetu.validation.run`、`hetu.reports.list`、`hetu.reports.get` | 固定剧情、规则与设定；保留覆盖不足与未知，规则通过不证明戏剧质量 |
| 提建议和读取建议 | `hetu.findings.suggest`、`hetu.findings.suggestions` | 建议归Agent，不改变作者决定；固定报告和问题引用 |
| 记录作者问题取舍 | `hetu.findings.disposition` | 固定方案；记录真实选择，不能用消除警告的需要编造事实 |

## 共用能力与专业边界

Fountain起草、意见、工作稿、提交、采纳、定稿、设定、素材、导入、版本及交付使用[任务合同](../task-contract.md)与[管理工作法](management.md)中的实际公共入口。维护项目不赋予正文采纳或定稿权；付费外发也有独立范围。

全剧总纲、人物弧线、关系／伏笔、场次长剧情、多套备选比较和工作进度属于专业规划。先发现已安装剧本插件；没有对应对象与动作时可使用实际允许的文字成果表达，并说明预算、索引及恢复能力，不能宣称这些专业对象已经实现。插件功能清单由插件维护，宿主只列发现入口；河图插件与Codex接入包分开处理。

固定方案沿`hetu.agent_operations.catalog`发现允许动作，再准备完整差异、复用真实作者决定并执行；不是每个作者函数都有独立MCP工具。未知结果使用已发现的原操作查询；写入前保存原请求，先回读再决定下一步。流程选择与完整交付标准见[全剧与分集规划](drama-planning.md)。
