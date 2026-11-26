# 视频功能操作导航

先读[统一执行模式](../execution-modes.md)：auto在明确当前工作区直接执行，confirm写入使用集中固定方案；下表的旧管理方案仅适用于仍使用精确管理连接的入口。从实际能力地图按`hetu-video`窄查，再读取当前插件Schema。CLI使用领域动作，MCP使用已发现工具，不从领域名猜工具。保留实际入口需要的作品或任务引用、修订、摘要和原操作键。

## 宿主项目与目录

| 用户目标 | 领域动作 | 执行与回读 |
| --- | --- | --- |
| 从构思创建独立视频 | `hetu.creation_projects.create_video` | 先筹备并固定作品类型、新目录及资料；返回自身范围，不要求小说或剧本 |
| 在允许范围新建视频项目 | `hetu.video.projects.create` | 已有作品内新建按固定方案；同名不是新建依据，不能反复建立同义项目 |
| 读取项目及分集 | `hetu.video.projects.get` | 读确切项目及有序分集；历史项目资料与其当前子对象组合不等于全季历史快照 |
| 维护项目资料或归档 | `hetu.video.projects.update` | 固定方案；CAS核对项目修订和摘要，不改媒体或上游剧本 |
| 建立视频分集 | `hetu.video.episodes.create` | 按新建范围或固定方案；保存返回稳定ID与当前项目，不以空分集证明完成 |
| 读取固定分集资料 | `hetu.video.episodes.get` | 确切`video_episode_id`及可选历史修订；回读当前`project_ref`与实际集序 |
| 更新分集制作说明或归档 | `hetu.video.episodes.update` | 固定方案；核对项目及分集双基线，只改元数据，保留媒体与工程身份 |
| 重排全季分集 | `hetu.video.episodes.reorder` | 固定方案；完整、不重复的原稳定ID序列；旧目录可查，旧分集修订保持 |

项目已归档时拒绝新增及修改分集，先按真实决定恢复项目。未知结果查原操作，不换键重排；标题、文件名、集号与时间戳都不能替代固定引用。

## 无额外插件的成果与意见

先用`hetu.baseline.inspect`核对随包基础合同；它不授予作品访问权。视频项目与分集、固定媒体审阅和基础文件交付无需额外创作插件。制作工具的实际文件通过现有固定`assets.import`方案导入，再登记本集成果。

| 目标 | 已发布动作 | 固定与恢复 |
| --- | --- | --- |
| 接收预演、片段或成片候选 | `hetu.video.media.save` | 固定work_ref、分集、asset_ref、用途、流索引、有理数time_base与实际工具报告的duration_ticks；有前版时带previous_media_ref。auto在当前工作区直接保存，confirm经集中固定方案确认后执行；保存不表示正式选用 |
| 查询成果与前版 | `hetu.video.media.list`、`hetu.video.media.get` | 返回固定media_ref；分页沿原游标，目录变化重新读取；不能以文件名或最新顺序猜前版 |
| 保存公开意见 | `hetu.video.feedback.save` | 固定media_ref和原话；局部范围按同一流时基传start_tick/end_tick半开区间，整版意见无需区间。作者确切意见经固定方案执行 |
| 继续返工 | `hetu.video.feedback.list` | 回读固定旧成果及意见，修改后登记新成果和前版；不把旧意见坐标套到新版 |
| 认可、选用或确认成片 | `hetu.video.decisions.get`、`hetu.video.decisions.preview`、`hetu.video.decisions.save` | 先读取本集用途当前决定，按作者确切原话固定media_ref、purpose、confirmed／withdrawn及expected_decision_ref；预览后保存同一版本，unknown查原键，不因auto或生成成功自作认可 |
| 查看认可历史 | `hetu.video.decisions.history` | 固定作品、分集、用途，按原游标读取；旧媒体认可与被替换决定保留，不能撤回另一当前媒体 |
| 基础文件交付 | `hetu.video.delivery.preview` | 明确选择media_refs，核对清单及当前权利；`hetu.assets.read_blob`按固定asset_ref连续读取，重组后核对完整blob_sha256 |

Core核验固定字节与引用；提交方声明的流时基、技术解码、实际观看和作者认可分别取证。默认工作面能播放、查看前版、保存意见、读取认可历史和分别导出本版视频与字幕原文件。认可按previsualization／clip／final分开，分别对应预演认可、片段选用和成片确认；一个分集用途只有一个当前头，新版不继承旧决定，当前权利仍独立核对。完整剪辑工程、分镜规划和提供方适配继续使用专业插件或外部工具，不为基础审阅要求作者先安装插件。

## 专业插件与外部制作

| 环节 | 入口归属 | 核对事项 |
| --- | --- | --- |
| 全季规划、分镜与制作依赖 | 已安装视频专业插件的能力与Skill | 支持video WorkRef，固定专业对象、长详情、来源及实际Schema；没有则明确缺口 |
| 人物、场景、道具与素材 | 宿主公开设定／资料／素材入口及对应Skill | 复用作品内固定修订；另一作品分别获权，插件不从文件路径越权读原文件 |
| 动态分镜、白模 | 已发现外部制作工具或专业插件 | 固定输入、实际可播输出及可接续工程，不把工程JSON当视频 |
| 视频／声音生成 | 已发现外部提供方工具或明确适配器 | 固定计划与预算、提供方原任务及查询；文字／图片模型接口不自动支持视频 |
| 剪辑、字幕、混音 | 外部机器工具与专业工程合同 | 固定素材区间、实际流时基、映射、工程依赖及渲染文件 |
| 区间意见及局部返工 | 已发现的媒体反馈合同 | 固定媒体版本与流区间、真实意见来源，坐标不能直接套新版 |
| 选用、认可及工程交付 | 相应专业决定与交付合同 | 作者真实决定与执行分开，离线可播／可恢复独立验证，不伪造文稿定稿 |

专业插件先通过稳定`hetu.plugins.capabilities`发现，再用`hetu.plugins.invoke`的`skills.read`按需读同包方法及资源。启停升级后重新发现，不安装同名Codex插件来代替。每个插件自维护功能清单，不向宿主清单复制专业动作。

confirm集中方案经`hetu.execution.prepare`固定完整变更并按真实指令确认、执行；仍使用旧管理连接时，固定方案由`hetu.agent_operations.catalog`发现。作品管理权不含采纳、成片确认、付费外发或任意文件读取。共用[任务合同](../task-contract.md)与[管理工作法](management.md)，完整旅程见[全季推进](video-planning.md)。
