import type { Locale } from './site';

const zh = {
  title: '你已经会讲故事。下一步，让它成为短剧。',
  intro: '小说给了你人物、世界和冲突。真正挡在前面的，是把这些积累变成可表演的剧本、可复用的制作资料，以及能继续修改的成果。',
  gaps: [
    { from: '写得动人', to: '演得出来', question: '内心独白，怎么让观众看见？', answer: '把心理与叙述转成动作、对白和场景，保留原著依据，新增表达交给作者判断。' },
    { from: '长篇连载', to: '分集叙事', question: '几十万字，怎么安排每集的冲突？', answer: '梳理人物目标、事件和伏笔，组织分集与场次；改编方案独立修订，原著保持可查。' },
    { from: '文字设定', to: '制作资料', question: '同一个人物，为什么每次生成都不一样？', answer: '把人物造型、场景和道具做成有版本的资料，明确参考图与使用位置，再比较和选用候选。' },
  ],
  exampleTitle: '同一个悬念，跨过三种表达。',
  exampleNote: '原创改编示例，含新增动作与对白。对照原著，理解从文字到表演与制作资料的选择。',
  tabs: ['小说原文', '分场剧本', '制作资料'],
  novel: '林舟认出那枚玉扣，却把手缩回袖中。父亲在雨夜里的叮嘱又响起来：不能让她知道。门外，忽然传来三声叩门。',
  scene: '内景　旧宅　夜',
  action: '林舟的手停在玉扣前，缓缓收回。他望向乔宁。门外三声叩门，两人同时转头。',
  speaker: '乔宁',
  dialogue: '你认得它？',
  assets: [['人物', '林舟 / 赴宴造型'], ['场景', '旧宅 / 雨夜版本'], ['道具', '旧玉扣 / 完整状态'], ['镜头与声音', '手部特写 / 三声叩门']],
  engineeringTitle: '小说工程化，补齐从故事到制作的能力。',
  engineeringBody: '软件工程让复杂软件可以分工、检查和持续修改。小说工程化也让创作有共同依据：设定可查询，改编有来源，素材有版本，修改能追踪。文学判断仍属于作者，工程方法帮助好故事走到下一步。',
  stages: ['原著与设定', '剧情与证据', '分集与剧本', '资料与素材', '版本与交付'],
  stageDetails: ['保留故事依据', '看清事件与冲突', '组织可表演内容', '固定人物与场景设计', '带着来源继续协作'],
  outside: '围绕同一部作品组织原著、剧本、制作资料与交付，保留每一步的来源和选择。拍摄、外部生成、剪辑与发行由所选工具和团队完成。',
  rolesTitle: '把 AI 的能力，接到你的作品上。',
  roleBodies: [
    ['外部 Agent', '整理资料、创作与操作', '向熟悉的 Codex、Claude Code 或 WorkBuddy 说出目标。'],
    ['河图洛书', '查询、操作和恢复', 'MCP、CLI、Skills 与原生界面共用作品、任务和版本。'],
    ['作者', '审阅、取舍与定稿', '比较成果与差异，提出意见，随时亲自编辑优化。'],
  ],
  questionsTitle: '从你真正想问的事开始。',
  questions: [
    ['我只会写小说，能开始吗？', '可以从自己已授权的一章开始，先核对人物和事件，再整理一场戏。无需先准备完整剧本或制作团队。'],
    ['会不会把我的小说改得面目全非？', '改编与原著保留固定来源。新增、删减和重排可对照，参考稿独立保存，作者确认后才采纳。'],
    ['能一键生成一部成片吗？', '河图提供从原著、剧本到制作资料的组织与交接。理解和生成由外部 Agent 与制作工具完成，拍摄、剪辑和发行另行处理。'],
    ['免费开源，会不会把作品也公开？', '软件按 Apache-2.0 免费开源。你的作品保存在自己的目录，不随软件开源；外部 Agent 与生成服务按其各自规则和费用使用。'],
  ],
  readMore: '阅读创作与改编文章',
};

const en = {
  title: 'You built a story world. Give it a life on screen.',
  intro: 'For independent authors and small studios, the hard part is turning a manuscript into material collaborators can actually use: a playable scene, a consistent character reference and a production handoff that survives revisions.',
  gaps: [
    { from: 'Interior voice', to: 'Visible performance', question: 'How does an audience see what a character is thinking?', answer: 'Develop action, dialogue and setting around the original intent. Keep new adaptation choices visible and trace them to the manuscript.' },
    { from: 'A long narrative', to: 'Episode structure', question: 'Where does a chapter become a scene or an episode?', answer: 'Track goals, reveals and consequences, then build a separate adaptation. Preserve the source while experimenting with pacing and episode endings.' },
    { from: 'Worldbuilding', to: 'Production continuity', question: 'How do collaborators keep the same character and location?', answer: 'Maintain versioned character, location and prop references. Use fixed designs across scenes and compare returned assets before selecting them.' },
  ],
  exampleTitle: 'One dramatic question. Three working forms.',
  exampleNote: 'Original adaptation example with new action and dialogue. Compare the choices that turn a manuscript into performance and production references.',
  tabs: ['Manuscript', 'Screenplay', 'Production references'],
  novel: 'Mara knew the voice on the broken radio. She kept her hand away from the dial. Her brother had been missing for seven years. Then the lighthouse went dark.',
  scene: 'INT. LIGHTHOUSE — NIGHT',
  action: 'Mara reaches for the radio. A familiar voice crackles through the static. Her hand freezes. The beam outside cuts out.',
  speaker: 'MARA',
  dialogue: 'Say my name again.',
  assets: [['Character', 'Mara / Night watch costume'], ['Location', 'Lighthouse / Power outage'], ['Prop', 'Radio / Broken casing'], ['Shot and sound', 'Hand close-up / Radio static']],
  engineeringTitle: 'Story engineering for the work between formats.',
  engineeringBody: 'Software engineering makes complex work inspectable, shareable and revisable. Apply that discipline to adaptation: a shared story bible, traceable creative choices, versioned assets and clear approvals. Craft stays with the author; the system makes the next collaboration possible.',
  stages: ['Manuscript & canon', 'Beats & evidence', 'Episodes & scripts', 'Production references', 'Versioned handoff'],
  stageDetails: ['Keep the original intent', 'Trace story decisions', 'Build playable scenes', 'Keep designs consistent', 'Let collaborators continue'],
  outside: 'Keep manuscripts, scripts, production references and handoffs connected to the same work, with sources and choices preserved. Filming, external generation, editing and distribution happen in your chosen tools and teams.',
  rolesTitle: 'Bring your Agent. Keep ownership of the work.',
  roleBodies: [
    ['External Agent', 'Organize, create and act', 'Give the goal to your familiar Codex, Claude Code or compatible client.'],
    ['Hetu Luoshu', 'Query, act and recover', 'MCP, CLI, Skills and the native app share works, tasks and versions.'],
    ['Author', 'Review, choose and finalize', 'Compare results, give feedback and edit directly whenever you choose.'],
  ],
  questionsTitle: 'Questions an author should ask first.',
  questions: [
    ['Do I need a production team to begin?', 'Begin with one chapter you have the rights to adapt. Inspect the characters and events, then develop a single scene before scaling the project.'],
    ['Will this rewrite or publish my book?', 'Adaptations keep fixed source references. Candidates stay separate; you choose what to adopt and finalize. Publishing is a separate action.'],
    ['Does this produce a finished video?', 'Hetu organizes manuscripts, scripts and production references. Your external Agent and production tools handle generation; filming, editing and distribution remain separate.'],
    ['What is free, and what do I own?', 'The software is free and open source under Apache-2.0. Your content stays in your local workspace and retains its own rights. External agents and generation services have their own pricing and terms.'],
  ],
  readMore: 'Read the adaptation journal',
};

export const positioning = (locale: Locale) => locale === 'en' ? en : zh;
