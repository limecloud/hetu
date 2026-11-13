# GitHub 写作 Skills 对照与河图洛书方法整理

研究日期：2026-11-13。对象为十个完整源码仓库，均已 `git clone` 并核对固定 commit、根许可与相关方法；checkout 位于忽略目录 `build/research/github-skills/repos/`。不执行上游脚本，不把源码对照称为二进制反编译或作品质量实测。

## 1. 产品定位决定整理边界

河图洛书是本地多作品创作工作台，作者掌握正文、设定、采纳与定稿。AI均指Codex、Claude Code、WorkBuddy等外部Agent；河图不接大模型API、不托管模型密钥、不内置聊天或生成循环。整理依据为[PRD](../01-产品需求PRD.md)和[Agent集成设计](../27-Agent与Codex插件集成设计.md)。

Skills服务接入、建书、资料、大纲、封面、起草、改稿、短剧八项实际任务。不同题材需覆盖整个任务链，不能只有风格形容词；也不能把数百标签变成数百套重复入口。软件拥有完整分类目录，Agent只安装作者所选套件及其必要共同方法。

## 2. 逐仓取舍

| 固定源码 | 对照内容 | 可取方法 | 不进入河图的内容 |
| --- | --- | --- | --- |
| [screenwriting-skills](https://github.com/jtydhr88/screenwriting-skills/tree/51115f18d160aa8b2ac5813e4432b6f0b425358f/plugins/screenwriting/skills)，MIT | 人物冲突、结构、场景、对白、改编、剧集与案例 | 用行动表达目标；场景变化；改编保留因果 | 不整包安装26专题；戏曲、电影地区流派、行业提案和案例原文不混入每个小说包 |
| [story-skills](https://github.com/danjdewhurst/story-skills/tree/74dd2f92dd757d4b262085bddccb09ed5a4281d1)，MIT | 场景、章节、世界、人物、修改与系列连续性 | 行动—结果—反应—决定；分层诊断；时间和资源连续性 | 不执行Story CLI、索引或作品数据库维护；不机械要求每场失败 |
| [oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode/tree/41a9b6c855d7d29a2bf214b4eefda2b10a0e8afb)，MIT | 长篇方法、题材提示卡、平台标签转录与截图 | 长期引擎、期待回收、题材差异、平台字段分离 | 不强制爽点密度、前三章开挂、每章悬崖；不复制发布、记忆库和强制子Agent流程 |
| [webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer/tree/e5b6a4b3798224dd2e78c806b6923abb3924dd56)，GPL-3.0 | 题材CSV、写章流程、预设与标签维度 | 只对照“主类、机制、路线、形式”分离的设计问题 | 不复制正文、代码、CSV或模板；其37题材不代表平台全量 |
| [Chinese-WebNovel-Skill](https://github.com/Tomsawyerhu/Chinese-WebNovel-Skill/tree/96709f477f4b59be856ebb10bec052dd0452b846)，未声明根许可 | 逻辑、身体、信息与连续性症状 | 只对照诊断维度 | 无明确再分发许可，不复制正文、代码和例库 |
| [bookflow-skill](https://github.com/LanyXiaosheng/bookflow-skill/tree/eb56fb5c66ace4e0dd98027291c6912a2062c079)，MIT | 短篇标题、简介、冲突、关系与结局模板 | 作品承诺与结尾兑现；短篇聚焦 | 不限定女性视角、固定beat数或平台；不把发布操作变成创作必经步骤 |
| [chinese-novelist-skill](https://github.com/PenglongHuang/chinese-novelist-skill/tree/507d41567925eab520ad459db08fda83813e8051)，MIT | 递进问答、人物设计、章节检查与续写 | 必要信息逐步定位，人物目标与阻力分开 | 不复制自动整书生成、自动重写和文件状态库；不要求每章冲突与钩子 |
| [novel-writer-skills](https://github.com/wordflowlab/novel-writer-skills/tree/5bc9b373ff609e8910e0e8d179e4a697bf2b1268)，MIT | 三类题材知识、场景与对白工艺、质量检查 | 区分题材知识与共用工艺；证据与推理回收 | 三类不覆盖中文网文全目录；固定百分比结构与原作文件写回不作为河图规则 |
| [Chinese-WebNovel-Master](https://github.com/TianHengZhuang/Chinese-WebNovel-Master/tree/d6730b63cd950ea8aa7af86293224d22b0873e8c)，MIT | 选题、读者期待、规划、编辑与商业指标 | 定位与作品承诺对齐，症状到修复建议 | 留存优先于文学、不可跳过的多Agent生产链和自动发布不符合作者掌规定位 |
| [general-novel-skill](https://github.com/xiaoyuCR7/general-novel-skill/tree/f099e4bf9524e26c6e1680193ea215767e07e604)，MIT | 按任务路由、题材卡、文风与连续性 | 按需读取、虚构规则与现实资料分开、作者约定优先 | 不复制外部章事务、五张追踪表、文件记忆库、托管写书和其MCP服务；不把本地分数当文学验收 |

检索入口包括[skills.sh](https://skills.sh/)和GitHub仓库搜索；安装量、星数只用于发现，不代替源码和许可核对。审阅文件摘要和许可证见[来源源记录](../../tools/hetu-skills/sources.json)，分发声明见[包内声明](../../integrations/codex/hetu/THIRD_PARTY_NOTICES.md)。未实测上游的真实宿主效果、市场收益和文学质量。

## 3. 分类证据与覆盖

| 来源 | 本次可核实范围 | 证据边界 |
| --- | --- | --- |
| [起点移动分类页](https://m.qidian.com/category/) | 官方SSR `info` 中15主类、82子类，保留原ID和主子关系 | 2026-11-13公开页面；不推导女频分类 |
| [番茄官方标签说明](https://fanqienovel.com/writer/zone/article/7617805652965982232) | 核对阅读标签与内容标签分别表达的维度 | 不将说明文章当后台全量选项实测 |
| [番茄公开截图证据](https://github.com/zenstory-ai/oh-story-claudecode/tree/41a9b6c855d7d29a2bf214b4eefda2b10a0e8afb/docs/evidence/fanqie) | 长篇男频阅读154项、女频182项；共同内容标签356项；短故事102项 | 固定commit二手转录；截图采集2026-10-25至10-29。本次抽查女频阅读主类和短篇主类截图，不声称河图登录官方后台逐项实测 |
| [起点女生分类页](https://m.qdmm.com/category/) | 返回202挑战页，未取得分类 | 明确记为未核实；不以挑战页面证明全量覆盖 |

目录有908个具来源的字段／分类节点，去掉字段后有635个不同名称。这些是不同表单、频道和平台中的限定条目，不是908种小说，更不是908个安装包。同名条目在不同字段保留各自ID、父级和出处；只有平台实际提供的主子关系作为层级。

番茄长篇阅读标签保留主分类、主题、角色、情节；内容标签保留情节、情感、人设、世界观；短故事保留主分类、情节、角色、情绪、背景。平台创建时的必选数量不成为河图本地建书的前置条件，河图不自动投稿。

## 4. 河图方法与安装模型

中文唯一源为 `tools/hetu-skills/`。`base/` 包含八任务入口、七工作法、四项共用工艺和任务合同；`genres.json` 提供45个可选方向，含通用、军事、谍战、历史、玄幻、仙侠、都市、末世、无限、规则怪谈、推理、体育、衍生、言情、年代、种田、快穿、双主角及短篇等。每个方向有输入依据、七环节增量、专项复核问题与诊断例，不只列题材名。每包约72KB，只有所选题材方法；没有上游166份整库或完整平台标签表。

源内容按职责维护一次：人物与关系、结构和回收、场景语言、世界规则是共同工艺；灾变资源、跨副本继承、谍战身份、历史制度等由相应题材拥有。分发副本自包含以适配宿主安装，不依赖兄弟包或符号链接。上轮译稿和分发包备份在忽略目录 `build/research/github-skills/pre-selective-packages/`，不作为当前方法事实源。

分类只推荐候选，不决定作者的故事。比如：

- 番茄女频“科幻末世”可选末世或科幻包；不自动加爱情，无CP是约定而非另一个必须安装的包。
- 起点“诸天无限／无限”路由无限包，检查副本规则、结算、状态继承和跨世界主线。
- “古风世情”有独立生活与制度方法，不强制按古言恋爱处理。
- “都市日常”保留生活节律和关系微变，不默认升级、反派和打脸。
- 军事检查职责、知情范围、时间、通信、补给和持续后果；谍战另有身份、证据与信任方法。

作者可手工查找，也可通过外部Agent定位。共用选择器复制目录及作者意图，外部Agent返回最多三个目录内套件ID与理由；河图仅校验与展示，作者选定一项后从设置、建书、作品资料或封面共用窗口安装。已有构思候选回填题材可用于目录匹配；界面明确标为目录匹配，不能冒充AI分析。多部作品可各关联一个主要体验套件，切换选择不自动卸载其他作品所用包。

复合题材以主要体验选包，次要机制、CP、篇幅、视角与基调保留在作品和任务中；不做全标签笛卡尔组合。任务提示词明确所选包，Agent不叠加其他已装包的类型约定。工作法、题材、诊断例和导航使用中文；协议字段、代码标识、Fountain语法与原始MIT许可保留原文。

## 5. 验证入口与限制

```bash
python3 "tools/sync-writing-methods.py" --check
python3 "tools/verify-skills.py"
swift run --skip-build hetu-native-tests --agent-integration
```

生成只读本仓中文源，离线可复现；引入新参考时先clone、固定commit、核对许可与调用边界，再由维护者取舍。源记录与分发方法摘要分别保存，更新推进插件版本，不以同版本静默覆盖安装。

静态门禁覆盖入口发现、中文、来源许可、文件摘要、本地链接与锚点、可达性、包预算、分类ID与父子关系、映射目标，以及女频末世无CP、男频无限、都市日常、古风世情和军事约束。原生专项验证建议JSON、逐作品关联、残包、版本与宿主隔离，并在隔离目录检查WorkBuddy仅安装所选包、Codex官方CLI登记与安装回读。实际会话加载、作品文学质量、史实和平台最新后台选项仍需分别验证，不能由文件数量或通过静态门禁推导。
