import fs from 'node:fs';
import path from 'node:path';
import type { Locale } from './site';
import { source } from './site';
import externalListings from '../data/plugin-listings.json';

// 官网只组织作者场景；可执行合同与版本仍归各插件包。
const editorial = [
  {"slug": "lorebook-bridge", "category": "exchange", "summary": {"zh-CN": "让角色卡与世界书带着原件、未知字段和转换说明，在创作工具之间往返。", "en": "Exchange character cards and lorebooks with original files, unknown fields and explicit conversion notes."}, "use": {"zh-CN": "角色卡、世界书与JSON／PNG／CHARX互通", "en": "Character cards, lorebooks and JSON/PNG/CHARX exchange"}, "request": {"zh-CN": "先发现lorebook-bridge与本作品的实际能力，读取同包Skill、固定原件与已有交换记录，解析角色及世界书，保留未知字段和禁用条目。列出字段映射与转换损失，准备设定候选；原格式导出后核对往返，不执行卡片脚本，不自动覆盖正式设定。 保存并回读，未知结果先查询原操作。", "en": "Discover lorebook-bridge and this work’s actual capabilities. Read the packaged Skill, fixed originals and existing exchanges. Inspect cards and lorebooks, preserve unknown fields and disabled entries, review mappings and losses, and prepare canon candidates. Verify round trips without executing card scripts or replacing canon. Save, read back and recover unknown operations first."}, "review": {"zh-CN": "先读角色、条目和未映射字段，再看转换说明。原件与修改版分别保留，正式设定由作者决定。", "en": "Review the character, entries, unmapped fields and conversion notes. Keep originals and edited versions distinct; canon remains your decision."}},
  {"slug": "interactive-fiction", "category": "interactive", "summary": {"zh-CN": "把故事组织成可检查、试玩、存档和离线阅读的分支叙事工程。", "en": "Build branching stories you can inspect, play, save and read offline."}, "use": {"zh-CN": "分支故事、选择路线与多结局试演", "en": "Branching stories, routes and alternative endings"}, "request": {"zh-CN": "先发现interactive-fiction与本作品的实际能力，读取同包Skill、固定故事与现有节点，组织变量、条件、选项和结局。区分结构检查与有界条件探索，试玩两条路线，保存并回放；输出离线HTML。选中路线只交给宿主候选，不采纳或定稿。 保存并回读，未知结果先查询原操作。", "en": "Discover interactive-fiction and this work’s actual capabilities. Read the packaged Skill, fixed story and existing graph. Organize typed variables, conditions, choices and endings. Distinguish structural checks from bounded exploration, play and save two routes, then export offline HTML. Hand chosen routes to host drafts without adoption or finalization. Save, read back and recover unknown operations first."}, "review": {"zh-CN": "按路线阅读节点、选择与变量变化。工程修改后保留旧存档，先确认对应版本再回放。", "en": "Read nodes, choices and variable changes along each route. Keep old saves tied to their story version."}},
  {"slug": "series-organizer", "category": "series", "summary": {"zh-CN": "把正篇、续作与番外放在一起组织，保留每部作品独立的身份和人物解释。", "en": "Organize main stories, sequels and side stories while keeping each work and its characters independent."}, "use": {"zh-CN": "系列阅读顺序、角色出演与番外计划", "en": "Series reading order, character appearances and side-story plans"}, "request": {"zh-CN": "先发现series-organizer与本作品的实际能力，读取同包Skill，分别核对每部作品的固定资料与管理范围，登记系列成员和阅读顺序。对照角色在各作的解释，准备番外目标与参考；跨作品引用不代表读取权，只向明确目标交接，不合并正典。 保存并回读，未知结果先查询原操作。", "en": "Discover series-organizer and this work’s actual capabilities. Read the packaged Skill and verify each work’s fixed profile and management scope separately. Organize members and reading order, compare character interpretations and plan a side story. References do not grant access; hand off only to the chosen work without merging canon. Save, read back and recover unknown operations first."}, "review": {"zh-CN": "核对作品顺序、续作关系与角色在各作的解释。阅读顺序可以不同于故事发生时间。", "en": "Check reading order, sequel links and each work’s character interpretation. Reading order may differ from chronology."}},
  {"slug": "story-translation", "category": "translation", "summary": {"zh-CN": "让源文、译稿、术语与意见保持对应，局部返工后仍能看清依据。", "en": "Keep sources, translations, terminology and feedback aligned through revisions."}, "use": {"zh-CN": "双语对照、术语检查与HTML／XLIFF交付", "en": "Bilingual review, terminology checks and HTML/XLIFF delivery"}, "request": {"zh-CN": "先发现story-translation与本作品的实际能力，读取同包Skill和固定源文，明确实际翻译范围，组织一对多或多对一对齐及术语。检查未译范围和字面术语，按固定译文记录意见并准备新译稿；读取后复核，输出双语稿，不覆盖源文或自动定稿。 保存并回读，未知结果先查询原操作。", "en": "Discover story-translation and this work’s actual capabilities. Read the packaged Skill and fixed source, declare scope, and create one-to-many or many-to-one alignments. Review coverage and literal terminology checks, bind feedback to the translation, revise and recheck, then export bilingual files without replacing or finalizing the source. Save, read back and recover unknown operations first."}, "review": {"zh-CN": "并排阅读原文与译稿，查看未译范围及旧意见。覆盖完整不等于翻译准确，语义与文风仍需判断。", "en": "Read source and translation together, including gaps and older feedback. Complete coverage does not establish accuracy or style."}},
  {"slug": "readthrough", "category": "readthrough", "summary": {"zh-CN": "把实际朗读声音、原文区间与听读意见连起来，让拗口与对白问题有处可查。", "en": "Connect actual recordings, source passages and listening feedback to locate prose and dialogue issues."}, "use": {"zh-CN": "听读定位、声音映射与返工交接", "en": "Listening review, text/audio mappings and revision handoffs"}, "request": {"zh-CN": "先发现readthrough与本作品的实际能力，读取同包Skill、固定原文与已有声音，准备朗读范围。核验实际PCM WAV、真实时长及固定素材摘要；映射如为估计须说明，播放后记录区间意见，再向宿主返工任务交接。声音生成、外发、费用及权利按我的明确决定处理。 保存并回读，未知结果先查询原操作。", "en": "Discover readthrough and this work’s actual capabilities. Read the packaged Skill, fixed text and recordings. Verify actual PCM WAV bytes, duration and asset hashes. Label estimated mappings, listen and attach interval feedback, then prepare host revision handoffs. Audio generation, external processing, costs and rights require my explicit choices. Save, read back and recover unknown operations first."}, "review": {"zh-CN": "播放实际声音，沿时间映射看原文并指出具体区间。文件可解码、映射精度和人工听读分别核对。", "en": "Play the actual recording, inspect mapped text and name the interval to revise. Decoding, alignment precision and human listening are separate checks."}},
  {"slug": "book-export", "category": "delivery", "summary": {"zh-CN": "从固定章节编译HTML、EPUB和中文PDF，核对目录、附件与每次转换的说明。", "en": "Compile fixed chapters into HTML, EPUB and Chinese PDF with explicit contents, attachments and conversion notes."}, "use": {"zh-CN": "书稿目录、版式预检与离线交付", "en": "Manuscript contents, layout preflight and offline delivery"}, "request": {"zh-CN": "先发现book-export与本作品的实际能力，读取同包Skill、固定目录与全部选中正文，明确顺序、纳入或跳过、版式、脚注和插图。先预检缺失与格式损失，再生成HTML、EPUB和PDF；重组核验完整文件，检查EPUB目录与资源，逐页查看PDF。保留再生成工程，不自动定稿或外部发布。 保存并回读，未知结果先查询原操作。", "en": "Discover book-export and this work’s actual capabilities. Read the packaged Skill, fixed contents and every selected chapter. Confirm ordering, inclusion, layout, notes and illustrations. Preflight missing material and conversion losses, compile HTML, EPUB and PDF, verify complete files and EPUB resources, and inspect every PDF page. Keep the regeneration project; do not finalize or publish externally. Save, read back and recover unknown operations first."}, "review": {"zh-CN": "先核对目录与纳入范围，再读脚注、插图和转换说明。打开实际交付文件检查，生成文件不等于作品定稿。", "en": "Check contents and scope before notes, illustrations and conversion notes. Open actual files for review; file generation does not finalize the work."}},
  {
    slug: 'story-research', category: 'research',
    summary: { 'zh-CN': '从问题出发整理来源、观察与反证，让研究结论带着依据进入下一轮创作。', en: 'Connect questions, observations and counterevidence, then carry qualified conclusions into the next draft.' },
    use: { 'zh-CN': '旧稿复盘、人物动机研究、情节考据与有据创作交接', en: 'Manuscript research, character motivations and evidence-linked handoffs' },
    request: { 'zh-CN': '发现创作研究台与本作品的实际能力，读取同包Skill、固定原稿与现有研究。围绕我的问题记录来源观察、支持与反证，区分原文、推断和待核实内容；结论不掩盖反证。保存回读，整理有界研究摘要及固定交接，不改正文、正式设定或定稿。未知先查原操作。', en: 'Discover Story Research and this work’s capabilities. Read its packaged Skill, fixed sources and existing research. Record observations, support and counterevidence. Separate facts, inferences and uncertainties. Save, read back and prepare a bounded digest and fixed handoff without changing manuscript, canon or finalization. Recover unknown operations first.' },
    review: { 'zh-CN': '先看研究覆盖与来源，再对照支持、反证和有条件结论。指出需要补证的问题，让Agent沿同一研究接续。', en: 'Review sources and scope before support, counterevidence and qualified conclusions. Name the question that needs more evidence to continue the same research.' },
  },
  {
    slug: 'character-lab', category: 'characters',
    summary: { 'zh-CN': '把人物侧写、动机假设、访谈、对白试演与弧光放在一起，比较人物选择的依据和代价。', en: 'Review character profiles, motivation hypotheses, interviews, dialogue trials and arcs with their evidence and costs.' },
    use: { 'zh-CN': '人物塑造、动机比较、对白试演、成长弧光与字面提及测量', en: 'Character development, motivation alternatives, dialogue trials, arcs and literal mention measurement' },
    request: { 'zh-CN': '发现人物工坊与当前小说能力，读取同包Skill、固定来源及已有侧写。核对正式人物引用，把事实、动机假设和未来弧光分开。准备访谈与对白试演，明确参与者和创作问题；姓名提及统计不冒充实际出场。保存回读并准备接续上下文，不改正式设定、正文，不采纳或定稿；未知先查原操作。', en: 'Discover Character Lab and this novel’s capabilities. Read its packaged Skill, sources and profiles. Verify canonical references; separate facts, hypotheses and future arcs. Prepare interviews and dialogue trials with explicit participants. Name counts do not prove appearances. Save, read back and prepare writing context without changing canon, adopting or finalizing. Recover unknown operations first.' },
    review: { 'zh-CN': '核对人物依据、访谈与试演的参与者，以及弧光各阶段的选择和代价。假设与试演可继续修改，不自动成为正式人物事实。', en: 'Check evidence, participants, and choices and costs at each arc stage. Hypotheses and trials remain revisable and do not become canon automatically.' },
  },
  {
    slug: 'story-analysis', category: 'analysis',
    summary: { 'zh-CN': '看清实际读了什么，再从场景、叙事信号与问题依据分析故事，接续新稿影响和复核。', en: 'Establish what was actually read, analyze scenes and narrative signals, then inspect the impact of a revised draft.' },
    use: { 'zh-CN': '旧稿结构拆解、阅读覆盖、模拟读者、问题定位与新稿影响预览', en: 'Manuscript structure, reading coverage, simulated readers and revision impact' },
    request: { 'zh-CN': '发现故事分析与当前小说能力，读取同包Skill、固定阅读范围及已有分析。按实际阅读保存分块、场景、叙事信号和问题依据，覆盖按字节并集计算。模拟读者观点明确标注，不冒充真实反馈。读取新固定候选后预览影响与缺口，不自动解决旧问题、替换来源或采纳定稿。保存回读，未知先查原操作。', en: 'Discover Story Analysis and this novel’s capabilities. Read its packaged Skill, fixed scope and existing analysis. Record reading chunks, scenes, signals and findings; compute coverage from byte-range unions. Label simulated readers. Read a new fixed candidate to preview impact without resolving findings, replacing sources, adopting or finalizing automatically. Save and read back; recover unknown operations first.' },
    review: { 'zh-CN': '先看已读范围与缺口，再读场景、信号和问题。比较新稿影响时保留原依据，模拟读者只作为分析视角。', en: 'Read coverage and gaps before scenes, signals and findings. Keep original evidence when comparing revisions; simulated readers provide analytical viewpoints only.' },
  },
  {
    slug: 'relationships', category: 'relationships',
    summary: { 'zh-CN': '谁信任谁，谁隐瞒了什么。把复杂人物关系放在同一张图里审阅。', en: 'See loyalties, secrets and connections together as your cast grows.' },
    use: { 'zh-CN': '群像故事、悬疑线索、多方阵营', en: 'Ensemble casts, mysteries and rival factions' },
    request: { 'zh-CN': '请先发现河图当前安装的插件和实际能力，核对人物关系图的包版本及这部作品的授权。读取当前获权资料，整理主要人物之间的关系，不能确定的关系先列出来问我。保存为本作品的关系图并回读核对，不改正文、不采纳或定稿。缺少包或授权时先说明具体来源与范围。结果未知时查询原操作，不换键重做。', en: 'Discover the installed Hetu plugins and their actual capabilities. Check the Relationships package version and permission for this work. Read the authorized material, organize the main cast’s relationships and ask about uncertain connections. Save a relationship graph for this work and read it back. Do not change the manuscript, adopt text or finalize anything. If a package or permission is missing, explain the source and scope first. Recover an unknown outcome through the original operation.' },
    review: { 'zh-CN': '核对人物是否遗漏，连线方向与关系说明是否准确。指出具体两个人物，让 Agent 沿当前图继续调整。', en: 'Check the cast, link direction and relationship labels. Name the two people involved when asking your Agent to revise the graph.' },
  },
  {
    slug: 'timeline', category: 'timeline',
    summary: { 'zh-CN': '把事件、时间与说明排在一起，找出故事先后顺序里的疑问。', en: 'Bring events, times and context together to inspect your story’s chronology.' },
    use: { 'zh-CN': '多线叙事、倒叙插叙、跨集连续性', en: 'Parallel plots, flashbacks and episode continuity' },
    request: { 'zh-CN': '请先发现河图当前安装的插件和实际能力，核对故事时间线的包版本及这部作品的授权。读取当前获权资料，整理事件时间、标题与说明，区分确定时间和待核实时间。保存为本作品的时间线并回读核对，不改正文、不采纳或定稿。缺少包或授权时先说明具体来源与范围。结果未知时查询原操作，不换键重做。', en: 'Discover the installed Hetu plugins and their actual capabilities. Check the Story timeline package version and permission for this work. Read the authorized material and organize event times, titles and descriptions, separating confirmed dates from uncertain ones. Save a timeline for this work and read it back. Do not change the manuscript, adopt text or finalize anything. If a package or permission is missing, explain the source and scope first. Recover an unknown outcome through the original operation.' },
    review: { 'zh-CN': '核对事件时间、顺序和描述。故事发生顺序与正文叙述顺序可以不同；不确定的时间先保留疑问。', en: 'Check event times, order and descriptions. Story chronology may differ from narrative order; keep uncertain dates open for review.' },
  },
  {
    slug: 'novel-planner', category: 'planning',
    summary: { 'zh-CN': '从整书分卷到详细剧情，把目标、冲突、人物与伏笔放回同一部小说中审阅。', en: 'Review volumes, chapter plans, detailed plots, characters and clues in the context of the whole novel.' },
    use: { 'zh-CN': '长篇筹备、分卷与篇章规划、剧情展开、人物和伏笔整理', en: 'Novel preparation, volume and chapter planning, detailed plots, story entities and clues' },
    request: { 'zh-CN': '重新发现河图已安装的插件与实际能力，核对小说规划包、本次小说和固定修订。先读取现有规划、实体与工作记录，再整理各卷目标、主题、冲突、转折和详细剧情；保留作者主张及其他范围。保存成果并回读，结果未知先查原操作，不改正文、不采纳或定稿。', en: 'Rediscover Hetu’s installed plugins and actual capabilities. Check Novel Planner, this novel and its fixed revision. Read existing plans, story entities and work records before developing each volume’s goal, theme, conflict, turning points and detailed plot. Preserve author choices and other scopes. Save and read back the results, checking original operations for unknown outcomes. Do not change, adopt or finalize manuscript text.' },
    review: { 'zh-CN': '沿卷列表阅读卷信息、卷规划与详细剧情，核对实体关联和线索回收。指出具体卷章与修改目标，让 Agent 沿固定成果继续；也可以亲自编辑、比较版本与查看真实工作步骤。', en: 'Read volume information, plans and detailed plots from the volume list. Check linked entities and clue payoffs. Name a specific node and goal for your Agent to continue from fixed results, or edit, compare revisions and inspect real work steps yourself.' },
  },
  {
    slug: 'screenplay', category: 'screenplay',
    summary: { 'zh-CN': '把全剧、分集、场次与人物选择连起来，从规划继续到可比较的剧本参考稿。', en: 'Connect the whole story, episodes, scenes and character choices, then continue into comparable screenplay drafts.' },
    use: { 'zh-CN': '原创电影、系列短剧、旧稿复盘、人物弧线与场次返工', en: 'Original films, episodic drama, script review, character arcs and scene revisions' },
    request: { 'zh-CN': '发现河图剧本创作插件与本次作品的实际能力，按同包Skill先阅读已有方案和固定原稿，再整理全剧、分集、场次、人物弧线与伏笔。把选定分集关联宿主写作任务，准备Fountain参考稿，读取意见后返工并回读两版成果；不自动采纳或定稿。未知结果沿原操作查询。', en: 'Discover Screenplay and the actual capabilities for this work. Read its packaged Skill, existing plans and fixed manuscripts before organizing the story, episodes, scenes, character arcs and clues. Connect an episode to a host writing task, prepare a Fountain draft, revise against feedback and read both versions back. Do not adopt or finalize text automatically. Recover unknown outcomes through the original operation.' },
    review: { 'zh-CN': '沿故事结构阅读人物的目标、冲突与代价，对照关系和伏笔。阅读实际分集稿，指出具体场次，让 Agent 依据固定版本继续。', en: 'Review goals, conflicts and costs alongside relationships and clues. Read the actual episode draft and name the scene your Agent should continue from a fixed version.' },
  },
  {
    slug: 'video-studio', category: 'video',
    summary: { 'zh-CN': '围绕分镜、素材、预演和剪辑版本推进制作，把审片意见接续到局部返工与工程交付。', en: 'Organize shots, assets, previs and edit versions, then carry review feedback into local rework and project delivery.' },
    use: { 'zh-CN': '短剧视频、独立短片、已有素材续作、预演审片与返工交付', en: 'Short drama, independent films, existing footage, previs review and rework delivery' },
    request: { 'zh-CN': '发现河图视听制作插件与本次视频作品的实际能力，读取同包Skill和已有工程，先梳理分镜、素材职责及实际媒体。按需要准备预演，固定制作请求和预算；需要付费或外发时另行确认。导入真实成果并核验完整解码，组织剪辑时间映射，按固定区间意见建立新版本，核验媒体及工程清单后交付。未知先查原任务，不自动认可成片。', en: 'Discover Video Studio and the actual capabilities for this video work. Read its packaged Skill and existing project, then organize shots, asset roles and actual media. Prepare previs when useful and fix production requests and budgets; confirm costs and external sharing separately. Import results, verify full decoding, organize edit mappings, create a new version from fixed-range feedback, and verify media and the project manifest before delivery. Recover unknown tasks first and do not approve the final film automatically.' },
    review: { 'zh-CN': '观看固定预演或成片，明确哪一段需要改变。保留旧版与意见，对照返工版本，再决定选用及交付。', en: 'Watch fixed previs or rendered edits and identify the interval to change. Keep the old version and feedback, compare the rework, then decide what to select and deliver.' },
  },
  {
    slug: 'director-stage', category: 'video',
    summary: { 'zh-CN': '在同一场景联动俯视调度、三维取景和镜头台词，由 Agent 安排逐镜走位与节奏。', en: 'Connect a floor plan, 3D framing and shot dialogue in one scene; ask your Agent to arrange blocking and pacing per shot.' },
    use: { 'zh-CN': '对白走位、场景布置、机位比较、白模预演与工程参考', en: 'Dialogue blocking, set layout, camera comparisons, previs and reusable scene projects' },
    request: { 'zh-CN': '重新发现河图已安装的导演布景台及当前作品能力，读取同包Skill、已有场景与固定来源。按我的目标安排人物站位、家具、机位、关键帧和镜头切换。局部走位绑定具体镜头，保留相邻镜头；检查台词估时、可能遮挡及明确轴线，保存后回读。固定计划并输出真实白模图、预演和可接续场景工程，检查画面与完整解码，再按固定版本意见返工并比较两版。正常操作通过CLI/MCP完成，不要求我先学三维操作；不自动调用付费模型或认可成片，未知先回读原操作。', en: 'Rediscover Director Stage and the actual capabilities for this work. Read its packaged Skill, existing scenes and fixed sources. Arrange people, props, cameras, keyframes and cuts. Bind local blocking to a shot and preserve neighboring shots; check estimated dialogue timing, possible occlusion and an explicit axis, then save and read back. Fix a render plan and produce actual white-model images, previs and a reusable scene project. Inspect the images and full decoding, revise against fixed-version feedback and compare both versions. Use CLI/MCP without requiring me to learn 3D controls. Do not invoke paid models or approve a final film automatically; recover unknown operations first.' },
    review: { 'zh-CN': '在平面图查看站位，在三维取景中比较结果，沿镜头表检查台词和时长，播放白模预演。说出哪一帧、哪个人物或哪次切镜需要改变，让 Agent 沿固定场景继续；也可直接拖动、精确编辑和导出。', en: 'Inspect blocking on the floor plan and compare its 3D framing. Review dialogue and duration in the shot table, then watch previs. Name a frame, person or cut for your Agent to revise from the fixed scene, or drag, edit and export it yourself.' },
  },
  {
    slug: 'shanhai', category: 'templates',
    summary: { 'zh-CN': '先读一个故事，再带走它的写法。用创作模板推进小说、剧本与短剧，并在作品里接续两稿与意见。', en: 'Try a story, take its method and continue fiction or screenwriting with fixed drafts and feedback.' },
    use: { 'zh-CN': '故事构思、人物设定、长篇复盘、章节起草、场次改编、审阅与交付', en: 'Story ideas, characters, manuscript review, chapters, scenes, revisions and delivery' },
    request: { 'zh-CN': '发现已安装的山海经纬和本次作品能力，读取同包 Skill，按我的目标选择固定模板。先阅读已有资料并列明实际覆盖范围，保存方法实例，再通过宿主任务准备候选、读取意见并沿原任务返工。核对两稿和固定引用后整理交付，不自动采纳或定稿。山海与小说规划为平行插件，无需先安装其他专业插件；结果未知先查原操作。', en: 'Discover Shanhai and the capabilities for this work. Read its packaged Skill and choose a fixed template for my goal. Read existing material and state the actual coverage, save a method instance, then use host tasks to prepare drafts and revise against feedback. Verify both drafts and fixed references before delivery. Do not adopt or finalize automatically. Shanhai works independently of Novel Planner; recover unknown outcomes through the original operation.' },
    review: { 'zh-CN': '在山海独立官网体验原创故事和方法；回到河图阅读固定候选、比较版本、写下意见，沿当前实例继续。模板可以独立浏览、复制和下载。', en: 'Explore original stories and methods on Shanhai’s independent website. In Hetu, read fixed drafts, compare versions, leave feedback and continue the same instance. Templates can also be read, copied and downloaded independently.' },
  },
  {"slug": "prose-studio", "category": "editing", "summary": {"zh-CN": "把作者偏好、不同写法与局部返工接在一起，留下每条判断的依据。", "en": "Connect author preferences, alternative approaches and local revisions with explicit evidence."}, "use": {"zh-CN": "文风整理、开篇方向比较、按意见微调与续写前选材", "en": "Style preferences, opening alternatives, feedback-driven refinement and writing context"}, "request": {"zh-CN": "发现文风工坊及当前小说的实际能力，读取同包Skill、固定原稿与已有偏好。区分我明确表达的偏好和你的推断，比较有实际差异的写法并说明代价。按选定范围准备修改候选，核验选区外原字节保持；保存、回读并接续意见，不采纳或定稿，未知先查原操作。", "en": "Discover Prose Studio and this novel’s actual capabilities. Read its packaged Skill, fixed sources and existing preferences. Separate my stated preferences from your inferences. Compare distinct approaches and their tradeoffs. Prepare a candidate for the chosen range, verify unchanged bytes outside it, then save, read back and continue from feedback. Do not adopt or finalize; recover unknown operations first."}, "review": {"zh-CN": "阅读偏好依据与方向代价，对照固定原稿和返工候选。偏好可以修改或停用；局部修改核验不等于写作质量认可。", "en": "Review preference evidence and tradeoffs alongside fixed sources and revisions. Preferences can be changed or disabled; a byte-range check does not establish creative quality."}},
  {"slug": "novel-review", "category": "editing", "summary": {"zh-CN": "看清检查了哪些内容、问题依据在哪里，让返工后的复核接得上原问题。", "en": "See what was reviewed, where each concern comes from and how a revised draft addresses it."}, "use": {"zh-CN": "连贯逻辑、人物、情节承诺、节奏、文风与设定的有据审校", "en": "Evidence-based checks of continuity, characters, promises, pacing, prose and canon"}, "request": {"zh-CN": "发现小说审校实际能力，读取同包Skill、固定原稿与现有问题。按六域记录实际覆盖，区分未检查、无法判断与通过；问题关联原文依据。准备返工建议，读取新的固定候选再复核，不因提交了新稿自动标记解决。保存回读，不改正文、不采纳或定稿。", "en": "Discover Novel Review, read its packaged Skill, fixed sources and existing concerns. Record actual coverage across six domains and distinguish unchecked, inconclusive and passed. Cite each concern. Prepare revision advice and read the new fixed candidate before resolving anything. Save and read back without changing, adopting or finalizing manuscript text."}, "review": {"zh-CN": "先看检查覆盖，再读问题和固定原文。说明哪些悬念是有意保留，沿新候选复核；软件不替作者判断创意好坏。", "en": "Read coverage before concerns and source excerpts. Explain deliberate mysteries and review the new fixed candidate; creative judgment remains yours."}},
  {"slug": "novel-atlas", "category": "atlas", "summary": {"zh-CN": "从同一份作品资料阅读人物、势力、关系、地点、时间与器物，并带走离线图鉴。", "en": "Explore people, factions, relationships, places, events and objects from one evidence-linked atlas, including an offline edition."}, "use": {"zh-CN": "长篇设定复盘、群像关系、事件顺序、状态变化与离线阅读", "en": "Long-form world review, ensemble relationships, chronology, changing states and offline reading"}, "request": {"zh-CN": "发现小说图鉴及当前小说的实际能力，读取同包Skill、固定正文和设定。保留正式投影、抽取候选与未来规划的区别，建立同源人物、关系、地点和事件视图；未知时间与位置保持未知。保存回读，导出不带整章正文的离线HTML，不改正式设定、不采纳或定稿。", "en": "Discover Novel Atlas and this novel’s capabilities. Read its packaged Skill, fixed manuscript and canon. Distinguish canonical projections, extracted candidates and future plans. Build linked views of people, relationships, places and events, leaving unknown times and locations unknown. Save, read back and export offline HTML without full chapters; do not change canon, adopt or finalize text."}, "review": {"zh-CN": "在目录、关系图和时间线交叉核对；按故事时间文本或叙事顺序阅读。地点示意不代表真实地理，导出可离线阅读且不依赖脚本。", "en": "Cross-check the directory, graph and timeline. Sort by narrative order or recorded story-time text. Location diagrams do not establish geography; exported HTML is readable offline without scripts."}},
] as const;
export const categories = [
  { id: 'delivery', title: { 'zh-CN': '书稿交付', en: 'Book delivery' } },
  { id: 'readthrough', title: { 'zh-CN': '朗读审阅', en: 'Readthrough' } },
  { id: 'translation', title: { 'zh-CN': '译稿审阅', en: 'Translation' } },
  { id: 'series', title: { 'zh-CN': '系列组织', en: 'Series' } },
  { id: 'interactive', title: { 'zh-CN': '互动叙事', en: 'Interactive stories' } },
  { id: 'exchange', title: { 'zh-CN': '世界书互通', en: 'Worldbook exchange' } },
  { id: 'research', title: { 'zh-CN': '创作研究', en: 'Story research' } },
  { id: 'characters', title: { 'zh-CN': '人物塑造', en: 'Character development' } },
  { id: 'analysis', title: { 'zh-CN': '故事分析', en: 'Story analysis' } },
  { id: 'editing', title: { 'zh-CN': '文风与审校', en: 'Style and review' } },
  { id: 'atlas', title: { 'zh-CN': '小说图鉴', en: 'Novel atlas' } },
  { id: 'templates', title: { 'zh-CN': '创作模板', en: 'Creative templates' } },
  { id: 'planning', title: { 'zh-CN': '小说规划', en: 'Novel planning' } },
  { id: 'screenplay', title: { 'zh-CN': '剧本创作', en: 'Screenwriting' } },
  { id: 'video', title: { 'zh-CN': '视听制作', en: 'Video production' } },
  { id: 'relationships', title: { 'zh-CN': '人物关系', en: 'Relationships' } },
  { id: 'timeline', title: { 'zh-CN': '故事时间', en: 'Chronology' } },
] as const;
export const plugins = editorial.map(item => {
  const listing = externalListings.find(entry => entry.slug === item.slug);
  const directory = `plugins/${item.slug}`;
  const manifest = (listing?.manifest ?? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../..', directory, 'plugin.json'), 'utf8'))) as {
    id: string; version: string; host_api: string; license: string;
    display: Record<Locale, string>; permissions: string[];
  };
  if (!manifest.display.en || !manifest.display['zh-CN']) throw new Error(`插件缺少双语名称：${item.slug}`);
  if (listing) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(manifest.id) || !/^[0-9a-f]{40}$/.test(listing.source_commit)) throw new Error(`外部插件来源无效：${item.slug}`);
    if (!/^[0-9a-f]{64}$/.test(listing.release.archive_sha256) || !/^[0-9a-f]{64}$/.test(listing.release.package_sha256)) throw new Error(`插件缺少固定摘要：${item.slug}`);
    for (const url of [listing.source_repository, listing.release.url, listing.release.download_url, listing.release.evidence_url, listing.release.integrity_url, ...(listing.homepage ? [listing.homepage] : [])]) if (new URL(url).protocol !== 'https:') throw new Error(`插件来源必须为HTTPS：${item.slug}`);
    if (listing.capabilities_path && (/[\\?#]/.test(listing.capabilities_path) || listing.capabilities_path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error(`插件功能清单路径无效：${item.slug}`);
  } else {
    if (manifest.id !== `org.hetu.${item.slug}`) throw new Error(`插件目录与包不符：${directory}`);
    fs.accessSync(path.resolve(process.cwd(), '../..', directory, 'CAPABILITIES.md'));
  }
  const repository = listing?.source_repository ?? source;
  return {
    ...item, ...manifest, directory,
    publisher: listing?.publisher ?? { 'zh-CN': '河图洛书', en: 'Hetu Luoshu' },
    release: listing?.release,
    homepage: listing?.homepage,
    source: listing ? `${repository}/tree/${listing.source_commit}` : `${source}/tree/main/${directory}`,
    capabilities: listing ? `${repository}/blob/${listing.source_commit}/${listing.capabilities_path ?? 'CAPABILITIES.md'}` : `${source}/blob/main/${directory}/CAPABILITIES.md`,
  };
});
export type CreativePlugin = typeof plugins[number];
