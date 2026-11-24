import type { Locale } from './site';
import { workflowClients, type WorkflowClientID } from './workflow-clients';

export type WorkflowKind = 'connect' | 'novel' | 'screenplay' | 'video' | 'revision';
type Text = readonly [string, string];
export interface WorkflowPhase {
  title: string;
  author: string;
  agent: string;
  hetu: string;
  preview: string[];
  artifact: number;
}
export interface WorkflowScenario {
  id: WorkflowKind;
  title: string;
  project: string;
  prompt: string;
  guide: string;
  artifacts: string[];
  phases: WorkflowPhase[];
}

// 提示词指向实际官方来源，由所选客户端发现当前安装能力，不硬编码易过期的安装命令。
export function agentInstallPrompt(locale: Locale, clientID: WorkflowClientID = 'codex'): string {
  const client = workflowClients.find(item => item.id === clientID)!;
  const instructions = {
    codex: ['优先核对当前 Codex 官方 Plugin 安装能力，安装河图客户端插件及其 Skills 和连接定义。', 'Check this Codex version’s official Plugin installation capability first, then install the Hetu client plugin with its Skills and connection definition.'],
    'claude-code': ['核对当前 Claude Code 支持的 Skills 和 MCP 接入方式，使用适用于 Claude Code 的配置，不套用 Codex 的配置路径。', 'Check the Skills and MCP integration supported by this Claude Code version. Use Claude Code configuration, not Codex configuration paths.'],
    cursor: ['先发现当前 Cursor 版本实际支持的 Skills 和 MCP 能力，按官方方式接入；不要把一种入口可用视为全量兼容。', 'Discover the Skills and MCP capabilities actually supported by this Cursor version and use the official integration method. Do not infer full compatibility from one working entry point.'],
    workbuddy: ['核对当前 WorkBuddy 的 Skills 与自定义 MCP 连接器，使用适配 WorkBuddy 的官方接入方式，不混用其他客户端的路径。', 'Check this WorkBuddy version’s Skills and custom MCP connector. Use the official WorkBuddy integration and do not reuse another client’s configuration paths.'],
  }[clientID];
  return locale === 'en'
    ? `Help me connect ${client.name} to Hetu Luoshu. Read the official integration guide at https://hetu.limeai.run/docs/agents/ and the official repository https://github.com/limecloud/hetu first. Inspect the current client version and existing Hetu installation. ${instructions[1]} Use official sources, preserve unrelated settings and install only the selected suite. If Hetu is missing, guide me to the official desktop installer. If this client requires a new session, explain that step. Verify package installation, session discovery and the connection separately, and report unverified steps accurately. This request only authorizes connecting this client. Do not read my creative library, change manuscripts, generate paid content, adopt or finalize work. Recover unknown installation results through the original operation before retrying.`
    : `请帮我把 ${client.name} 接入河图洛书。先阅读官方接入指南 https://hetu.limeai.run/docs/agents/ 和官方仓库 https://github.com/limecloud/hetu ，检查当前客户端版本及已有河图安装。${instructions[0]}使用官方来源，保留无关配置，只安装选定套件。如果本机缺少河图，请引导我使用官方桌面安装包。需要新会话时明确告诉我。分别验证接入包安装、当前会话发现和连接状态，如实说明未验证项。这次仅授权接入当前客户端，不读取创作库、不改正文、不执行付费生成、不采纳或定稿。安装结果未知时，先沿原操作回读再决定下一步。`;
}

export function workflowScenarios(locale: Locale): WorkflowScenario[] {
  const t = (text: Text) => text[locale === 'en' ? 1 : 0];
  const phase = (title: Text, author: Text, agent: Text, hetu: Text, preview: Text[], artifact: number): WorkflowPhase => ({
    title: t(title), author: t(author), agent: t(agent), hetu: t(hetu), preview: preview.map(t), artifact,
  });
  return [
    {
      id: 'connect', title: t(['开始接入', 'Connect']), project: t(['你的创作环境', 'Your creative setup']),
      prompt: t(['请帮我安装河图接入包，让 Codex 接入我的创作工作台。', 'Install the Hetu integration and connect Codex to my creative workspace.']),
      guide: 'agents', artifacts: [t(['安装提示词', 'Install prompt']), t(['河图接入包', 'Hetu integration']), t(['会话与连接', 'Session & connection']), t(['开始创作', 'Ready to create'])],
      phases: [
        phase(['复制提示词', 'Copy the prompt'], ['复制安装提示词，交给自己的 Agent。', 'Copy the installation prompt into your own Agent.'], ['收到安装目标，检查官方来源。', 'Read the request and inspect the official source.'], ['提供官方接入说明', 'Official integration guide'], [['接入河图洛书', 'Connect to Hetu Luoshu'], ['官方来源', 'Official source'], ['只安装选定套件', 'Only the chosen suite']], 0),
        phase(['安装接入包', 'Install the integration'], ['确认所选客户端和安装来源。', 'Confirm the client and installation source.'], ['通过客户端支持的方式安装，保留已有配置。', 'Install through the supported client flow, preserving existing settings.'], ['Skills 与连接定义', 'Skills & connection definition'], [['Codex', 'Codex'], ['河图客户端接入包', 'Hetu client integration'], ['安装与启用', 'Install and enable']], 1),
        phase(['验证接入', 'Verify the connection'], ['按客户端要求开启新会话。', 'Start a new session if the client requires it.'], ['核对包版本，发现当前会话的 Skills 与机器入口。', 'Check the package, discover session Skills and the machine connection.'], ['连接状态分别核对', 'Check each connection state'], [['插件文件已核对', 'Package checked'], ['会话能力已发现', 'Session capabilities discovered'], ['连接可用', 'Connection available']], 2),
        phase(['明确范围', 'Choose the scope'], ['说出目标，选择这次允许使用的作品和资料。', 'Describe the goal and choose the work and material to use.'], ['定位新筹备或已有工程，读取本次获权范围。', 'Locate a new project or existing work within the granted scope.'], ['按作品与任务接续', 'Continue by work and task'], [['小说 / 剧本 / 短视频', 'Novel / Script / Short video'], ['已有作品也能继续', 'Existing work can continue'], ['本次范围由你决定', 'You choose the scope']], 3),
        phase(['准备就绪', 'Ready to create'], ['从任意一种创作开始。', 'Start with any kind of creative work.'], ['根据目标组织创作方法和实际可用工具。', 'Organize methods and available tools around your goal.'], ['等待你的创作目标', 'Waiting for your creative goal'], [['说出想法', 'Describe your idea'], ['让 Agent 推进', 'Let your Agent move it forward'], ['回河图审阅成果', 'Return to Hetu to review']], 3),
      ],
    },
    {
      id: 'novel', title: t(['小说', 'Novel']), project: t(['雨夜来信 / 小说', 'A Letter in the Rain / Novel']),
      prompt: t(['写一个雨夜收到旧友来信的开篇，保留人物隐瞒身份的悬念。', 'Open with a letter from an old friend on a rainy night. Keep the sender’s identity uncertain.']),
      guide: 'writing', artifacts: [t(['人物与设定', 'Cast & story bible']), t(['卷章大纲', 'Story outline']), t(['章节参考稿', 'Chapter draft']), t(['待审阅', 'Awaiting review'])],
      phases: [
        phase(['说出构思', 'Describe the idea'], ['给出故事目标，也可以带上已有原稿。', 'Give the story goal, with an existing manuscript if you have one.'], ['理解人物、题材和这次希望完成的内容。', 'Understand the cast, genre and intended result.'], ['新建筹备或接续作品', 'Start or continue a work'], [['雨夜来信', 'A Letter in the Rain'], ['旧友的来信，陌生的笔迹。', 'An old friend’s letter. Unfamiliar handwriting.'], ['开篇悬念', 'An opening mystery']], 0),
        phase(['读取依据', 'Read the context'], ['确认允许使用的资料范围。', 'Confirm which material can be used.'], ['读取当前设定、原稿与固定版本，找出需要核实的内容。', 'Read the story bible, manuscript and fixed revision; flag uncertainties.'], ['保留资料与来源', 'Keep material and sources'], [['林舟 / 隐瞒真实身份', 'Lin / A hidden identity'], ['旧友 / 失联三年', 'An old friend / Missing for three years'], ['雨夜 / 一封来信', 'Rain / A letter']], 0),
        phase(['整理大纲', 'Develop the outline'], ['选择故事方向，补充希望保留的表达。', 'Choose a direction and say what should be preserved.'], ['按适合题材的方法组织冲突、线索与章节推进。', 'Organize conflict, clues and chapter progression using suitable methods.'], ['保存大纲候选', 'Save an outline candidate'], [['第一章 / 来信', 'Chapter 1 / The letter'], ['第二章 / 旧约', 'Chapter 2 / An old promise'], ['第三章 / 叩门', 'Chapter 3 / A knock']], 1),
        phase(['起草章节', 'Draft the chapter'], ['可以继续提出语气、视角与篇幅要求。', 'Specify voice, viewpoint and length if needed.'], ['围绕已确认方向起草独立参考稿。', 'Draft a separate reference version from the agreed direction.'], ['参考稿与作者稿分开', 'Keep reference and author drafts separate'], [['第一章 来信', 'Chapter 1 — The letter'], ['雨落到第三更，信才送到。', 'The letter arrived long after midnight.'], ['林舟没有拆开。那笔迹，他认得。', 'Lin left it sealed. He knew the handwriting.']], 2),
        phase(['保存回读', 'Save and read back'], ['回到河图查看成果。', 'Return to Hetu to see the result.'], ['保存参考稿，回读核对内容和版本。', 'Save the reference draft and read it back to verify content and revision.'], ['成果与依据一起保存', 'Save results with their sources'], [['章节参考稿 / 第 1 版', 'Chapter draft / Revision 1'], ['人物与线索可追溯', 'Traceable cast and clues'], ['原稿继续保留', 'Original manuscript retained']], 2),
        phase(['作者审阅', 'Author review'], ['连贯阅读、比较版本，只选用认可的内容。', 'Read, compare revisions and choose the passages you want.'], ['等待意见，沿同一任务继续。', 'Wait for feedback and continue the same task.'], ['待审阅', 'Awaiting review'], [['阅读完整章节', 'Read the complete chapter'], ['比较与提意见', 'Compare and give feedback'], ['采纳与定稿分别决定', 'Adoption and finalization are separate']], 3),
      ],
    },
    {
      id: 'screenplay', title: t(['剧本', 'Script']), project: t(['雨夜来信 / 剧本', 'A Letter in the Rain / Script']),
      prompt: t(['写一场雨夜对峙的戏，用动作和对白表现试探，结尾响起叩门声。', 'Write a tense encounter on a rainy night. Let action and dialogue carry the suspicion. End with a knock.']),
      guide: 'screenplays', artifacts: [t(['分集方案', 'Episode plan']), t(['场次与对白', 'Scenes & dialogue']), t(['剧本参考稿', 'Script draft']), t(['待审阅', 'Awaiting review'])],
      phases: [
        phase(['确定起点', 'Choose a starting point'], ['直接给原创构思，或指定获权改编来源。', 'Give an original idea or a source you have permission to adapt.'], ['理解戏剧目标，改编时固定所用原著版本。', 'Understand the dramatic goal; fix the source revision for an adaptation.'], ['剧本独立保存', 'Keep the script independent'], [['原创剧本', 'Original script'], ['也可关联获权原著', 'Or link an authorized source'], ['人物、冲突与场次', 'Characters, conflict and scenes']], 0),
        phase(['安排分集', 'Plan the episode'], ['说明时长、集数和希望观众留下的疑问。', 'Describe duration, episode count and the question to leave open.'], ['组织分集目标、冲突转折和结尾悬念。', 'Organize episode goals, turns and the ending beat.'], ['保存分集方案', 'Save the episode plan'], [['第 1 集 / 雨夜', 'Episode 1 / Rain'], ['一场试探，两种解释。', 'One encounter. Two explanations.'], ['结尾 / 门外来客', 'Ending / A visitor outside']], 0),
        phase(['组织场次', 'Develop the scene'], ['查看人物行动和信息释放是否合适。', 'Review character actions and the release of information.'], ['把意图写成可表演的行动与对白。', 'Turn intent into playable action and dialogue.'], ['分集与场次对应', 'Connect the episode and its scenes'], [['内景 茶室 夜', 'INT. TEA ROOM — NIGHT'], ['林舟伸手，停在玉扣上方。', 'Lin reaches for the jade pendant, then stops.'], ['苏晚：你认得它？', 'SU: You recognize it?']], 1),
        phase(['完成参考稿', 'Prepare a script draft'], ['可按场次阅读，也可与原著对照。', 'Read by scene, or compare with the source.'], ['完成行动与对白，检查节奏和人物连续性。', 'Complete the action and dialogue, checking pacing and continuity.'], ['保留固定改编依据', 'Keep fixed adaptation sources'], [['苏晚：你认得它？', 'SU: You recognize it?'], ['林舟收回手。', 'Lin withdraws his hand.'], ['三声叩门。两人同时回头。', 'Three knocks. They both turn.']], 2),
        phase(['保存回读', 'Save and read back'], ['回河图连贯阅读本集。', 'Read the full episode in Hetu.'], ['保存剧本与来源，回读核对场次和版本。', 'Save the script and its sources; verify scenes and revision.'], ['剧本参考稿 / 第 1 版', 'Script draft / Revision 1'], [['行动 / 对白 / 场次', 'Action / Dialogue / Scenes'], ['来源与修改可比较', 'Compare sources and changes'], ['原著保持独立', 'Source work stays independent']], 2),
        phase(['作者审阅', 'Author review'], ['比较对白、行动与节奏，提出具体意见。', 'Review dialogue, action and pacing; give specific feedback.'], ['沿原任务接续修改。', 'Continue revisions in the same task.'], ['待审阅', 'Awaiting review'], [['阅读本集', 'Read the episode'], ['选中场次提意见', 'Give feedback on a scene'], ['确认后再定稿', 'Finalize after your decision']], 3),
      ],
    },
    {
      id: 'video', title: t(['短视频', 'Short video']), project: t(['雨夜来信 / 30 秒短片', 'A Letter in the Rain / 30-second film']),
      prompt: t(['做一支 30 秒的悬疑短片：触碰玉扣、收回手、听见叩门，停在门打开之前。', 'Make a 30-second mystery: reach for the pendant, pull back, hear a knock. Stop before the door opens.']),
      guide: 'video', artifacts: [t(['分镜与素材', 'Shots & assets']), t(['动态分镜', 'Animatic']), t(['画面与声音', 'Picture & sound']), t(['成片待审', 'Cut awaiting review'])],
      phases: [
        phase(['说出目标', 'Describe the goal'], ['提供创意、剧本、分镜或已有片段。', 'Bring an idea, a script, a storyboard or existing clips.'], ['确定画幅、时长和本次制作范围。', 'Define aspect ratio, duration and the scope of this task.'], ['视频工程独立开始', 'Start an independent video project'], [['30 秒 / 悬疑短片', '30 seconds / Mystery'], ['玉扣、试探、叩门', 'Jade, suspicion, a knock'], ['停在门打开之前', 'Stop before the door opens']], 0),
        phase(['规划分镜', 'Plan the shots'], ['查看镜头意图和节奏安排。', 'Review shot intent and pacing.'], ['组织镜头顺序、景别、时长与声音意图。', 'Organize shot order, framing, timing and sound intent.'], ['保存分镜计划', 'Save the shot plan'], [['01 / 伸手 / 特写', '01 / Reach / Close-up'], ['02 / 收手 / 双人中景', '02 / Withdraw / Two-shot'], ['03 / 叩门 / 反打', '03 / Knock / Reverse shot']], 0),
        phase(['准备素材', 'Prepare the assets'], ['确认人物、场景参考和本次外发与费用。', 'Confirm cast and scene references, content transfer and this task’s cost.'], ['调用实际可用的图像等工具，准备一致的素材。', 'Use available image and other tools to prepare consistent assets.'], ['素材关联对应镜头', 'Link assets to their shots'], [['人物 / 林舟与苏晚', 'Cast / Lin and Su'], ['场景 / 雨夜茶室', 'Scene / A tea room in the rain'], ['道具 / 玉扣', 'Prop / A jade pendant']], 0),
        phase(['观看预演', 'Review the animatic'], ['先看顺序、停顿与声音落点。', 'Review order, pauses and sound placement first.'], ['用动态分镜预演节奏，复杂调度再按需做白模。', 'Preview timing with an animatic; add a simple 3D preview when staging needs it.'], ['预演单独审阅', 'Review the preview separately'], [['伸手，停住。', 'Reach. Pause.'], ['收回手，避开目光。', 'Withdraw. Avoid her eyes.'], ['叩门，转头。', 'A knock. They turn.']], 1),
        phase(['制作片段', 'Make the clips'], ['核对代表性画面的身份、动作和质感。', 'Review identity, action and texture in representative shots.'], ['通过外部制作工具生成或整理实际片段，再分组推进。', 'Use external production tools to generate or organize real clips, then continue in groups.'], ['保留片段与制作来源', 'Keep clips and their production sources'], [['镜头 01 / 人物动作', 'Shot 01 / Character action'], ['镜头 02 / 表演衔接', 'Shot 02 / Performance continuity'], ['镜头 03 / 叩门反应', 'Shot 03 / The reaction']], 2),
        phase(['剪辑音画', 'Edit picture and sound'], ['连续观看，核对节奏、声音与字幕。', 'Watch continuously; review timing, sound and subtitles.'], ['组织剪辑、配音、音效、配乐与字幕，回传可接续工程。', 'Edit picture, dialogue, effects, music and subtitles; return an editable project.'], ['保存剪辑与时间对应', 'Save the edit and time mapping'], [['画面 / 三个镜头', 'Picture / Three shots'], ['声音 / 雨声与三声叩门', 'Sound / Rain and three knocks'], ['字幕 / 与对白对齐', 'Subtitles / Aligned with dialogue']], 2),
        phase(['审阅成片', 'Review the cut'], ['完整观看，在任意区间提出意见，再决定确认成片。', 'Watch the whole cut, leave feedback anywhere, then decide whether to confirm it.'], ['保存实际成片和工程，回读核对交付版本。', 'Save the actual cut and project; read back the delivered revision.'], ['成片待审', 'Cut awaiting review'], [['成片 / 第 1 版', 'Cut / Revision 1'], ['片段、声音与工程保留', 'Clips, sound and project retained'], ['由你确认成片', 'You confirm the final cut']], 3),
      ],
    },
    {
      id: 'revision', title: t(['返工与交付', 'Revise & deliver']), project: t(['雨夜来信 / 第 2 版', 'A Letter in the Rain / Revision 2']),
      prompt: t(['叩门前多停一秒，先听见声音，再让人物回头。其他镜头保持原样。', 'Hold one second before the knock. Let us hear it before they turn. Keep the other shots.']),
      guide: 'review', artifacts: [t(['原版与意见', 'Original & feedback']), t(['局部返工', 'Focused revision']), t(['新版对照', 'Revision comparison']), t(['交付工程', 'Project handoff'])],
      phases: [
        phase(['指出位置', 'Point to the moment'], ['选中段落、场次或视频区间，写下意见。', 'Select a passage, scene or video range and leave feedback.'], ['接收确切成果版本与作者原话。', 'Receive the exact result revision and the author’s own words.'], ['意见固定在原版本', 'Anchor feedback to its revision'], [['第 1 版 / 00:12–00:16', 'Revision 1 / 00:12–00:16'], ['叩门前多停一秒。', 'Hold one second before the knock.'], ['其他镜头保持原样。', 'Keep the other shots.']], 0),
        phase(['接续原任务', 'Continue the task'], ['在当前或新会话里明确要求继续已有成果。', 'Ask your current or new conversation to continue the saved work.'], ['读取原任务、原成果和修改意见，确认返工范围。', 'Read the original task, result and feedback; confirm the revision scope.'], ['保留原稿与历史', 'Keep the original and its history'], [['原任务继续', 'Continue the original task'], ['固定第 1 版', 'Keep revision 1 fixed'], ['只调整选定区间', 'Adjust only the selected range']], 0),
        phase(['局部返工', 'Revise the selected part'], ['范围或费用变化时再作决定。', 'Make a new decision if scope or cost changes.'], ['调整停顿和声音顺序，保存新成果并回读。', 'Adjust the pause and sound order, save the new result and verify it.'], ['生成第 2 版候选', 'Prepare revision 2'], [['原版 / 先转头', 'Original / Turn first'], ['新版 / 先听见叩门', 'New / Hear the knock first'], ['新增停顿 / 1 秒', 'Added pause / 1 second']], 1),
        phase(['比较新版', 'Compare revisions'], ['对照前后版本，检查意见是否落实。', 'Compare revisions and check that the feedback was addressed.'], ['交回变化与依据，保留未修改部分。', 'Return the changes and their basis; retain untouched parts.'], ['新版待审阅', 'New revision awaiting review'], [['第 1 版 ↔ 第 2 版', 'Revision 1 ↔ Revision 2'], ['只改选定镜头', 'Only the selected shot changed'], ['原版随时可查', 'Original remains available']], 2),
        phase(['作者确认', 'Author decision'], ['分别决定选用、定稿或成片确认。', 'Decide adoption, finalization or cut confirmation separately.'], ['按作者明确决定准备固定版本交付。', 'Prepare delivery of the exact revision the author chose.'], ['记录作者选择', 'Record the author’s choice'], [['选用新版', 'Choose the new revision'], ['确认成片', 'Confirm the cut'], ['准备交付版本', 'Prepare the handoff revision']], 2),
        phase(['交付工程', 'Deliver the project'], ['确认这次要交出的版本和材料。', 'Confirm the revision and material to hand over.'], ['核对成片、素材、声音和工程依赖，交回可继续创作的工程包。', 'Verify the cut, assets, sound and dependencies; return a project that can continue.'], ['按确认版本交付', 'Deliver the confirmed revision'], [['所选文稿或成片', 'Selected text or cut'], ['素材、声音与来源', 'Assets, sound and sources'], ['可接续的完整工程', 'An editable, complete project']], 3),
      ],
    },
  ];
}
