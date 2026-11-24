import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { route, type Locale } from './site';
import { assetURL } from './assets';
import captures from '../../assets/guides/captures.json';

const root = path.resolve(process.cwd(), 'src/content/guides');
export const groups = [
  { id: 'start', title: { 'zh-CN': '开始使用', en: 'Getting started' } },
  { id: 'novel', title: { 'zh-CN': '小说创作', en: 'Writing novels' } },
  { id: 'screen', title: { 'zh-CN': '剧本与视频', en: 'Scripts and video' } },
  { id: 'assets', title: { 'zh-CN': '设定与素材', en: 'Story and assets' } },
  { id: 'review', title: { 'zh-CN': '审阅与交付', en: 'Review and delivery' } },
  { id: 'manage', title: { 'zh-CN': '协作与管理', en: 'Collaboration' } },
  { id: 'developer', title: { 'zh-CN': '开发者', en: 'For developers' } },
] as const;
export const docs = [
  {id:'when-to-use',group:'start',title:{'zh-CN':'这次需要河图吗',en:'Does this task need Hetu?'},description:{'zh-CN':'从直接回答、只读查阅到持续返工，选择最简单的路径。',en:'Choose a direct answer, read-only lookup or sustained revision.'}},
  { id: 'getting-started', group: 'start', title: { 'zh-CN': '快速入门', en: 'Quick start' }, description: { 'zh-CN': '向 Agent 说出目标，回来读稿或看片，提意见并继续。', en: 'Give your Agent a goal, read or watch the result, then give feedback and continue.' } },
  { id: 'install', group: 'start', title: { 'zh-CN': '下载与安装', en: 'Download and install' }, description: { 'zh-CN': '获取 Mac、Windows 或 Linux 版，保留已有作品与任务继续。', en: 'Get Hetu for Mac, Windows or Linux and continue your existing works and tasks.' } },
  { id: 'creative-library', group: 'start', title: { 'zh-CN': "认识创作库", en: "Your creative library" }, description: { 'zh-CN': "分别组织小说、剧本与视频，保留各自版本和来源关联。", en: "Organize novels, scripts and videos with their own revisions and source links." } },
  { id: 'creative-paths', group: 'start', title: { 'zh-CN': '选择你的创作路径', en: 'Choose a project starting point' }, description: { 'zh-CN': '只有一个点子、已经写了十万字，或拿到了改编授权，该从哪里开始？', en: 'Find the right starting point for an original script, your own book, a licensed adaptation or an existing draft.' } },
  { id: 'skills', group: 'start', title: { 'zh-CN': '选择与安装 Skills', en: 'Choose and install Skills' }, description: { 'zh-CN': '给自己的写作助手选一套适合这本书的题材方法。', en: 'Choose genre methods that fit this book for your writing assistant.' } },
  { id: 'codex-first-task', group: 'novel', title: { 'zh-CN': '用 Codex 构思一本新书', en: 'Plan a book with Codex' }, description: { 'zh-CN': '向 Codex 说出想法，让它准备并保存建书方案，你来审阅。', en: 'Give Codex the idea. Let it prepare and save a book proposal for your review.' } },
  { id: 'import-manuscript', group: 'novel', title: { 'zh-CN': "导入已有小说", en: "Import an existing manuscript" }, description: { 'zh-CN': "带着旧稿开始，核对卷章、顺序与原文，再继续写作。", en: "Bring in a draft, check its structure and text, then continue writing." } },
  { id: 'outlining', group: 'novel', title: { 'zh-CN': "大纲与卷章规划", en: "Plan an outline and chapters" }, description: { 'zh-CN': "从一个故事问题开始，比较方向，把大纲拆成能继续写的一章。", en: "Compare story directions and turn an outline into the next chapter." } },
  { id: 'writing', group: 'novel', title: { 'zh-CN': '章节与写作', en: 'Chapters and writing' }, description: { 'zh-CN': '切换章节、编辑正文，理解保存与修订。', en: 'Find chapters, edit a manuscript and understand revisions.' } },
  { id: 'screenplays', group: 'screen', title: { 'zh-CN': '剧本与分集审阅', en: 'Develop and review a screenplay' }, description: { 'zh-CN': '从原创冲突或获权原著开始，读完整行动与对白，沿同一集返工。', en: 'Start from an original conflict or an authorized source. Read full scenes and dialogue, then revise the same episode.' } },
  { id: 'adaptation', group: 'screen', title: { 'zh-CN': '从小说到短剧', en: 'From novel to screenplay' }, description: { 'zh-CN': '“她很生气”，到了镜头里怎么演？先用一章原文，试成一场戏。', en: 'Work with episodes and scenes while keeping the source novel in view.' } },
  { id: 'video', group: 'screen', title: { 'zh-CN': '从预演到成片', en: 'From preview to finished video' }, description: { 'zh-CN': '从创意、剧本或已有片段开始，观看预演、核对真实音画并交付工程。', en: 'Start with a brief, script or existing clips. Review previews, inspect actual picture and sound, and deliver an editable project.' } },
  { id: 'story-bible', group: 'assets', title: { 'zh-CN': '维护设定集', en: 'Maintain your story bible' }, description: { 'zh-CN': '写到第五十章，还能找到配角受过哪次伤、秘密何时才揭开。', en: 'Keep characters, world rules and timelines grounded in confirmed facts.' } },
  { id: 'characters-and-scenes', group: 'assets', title: { 'zh-CN': "人物、场景与道具", en: "Characters, locations and props" }, description: { 'zh-CN': "整理身份与造型，复用确定的素材，并找到实际使用位置。", en: "Keep identities and appearances consistent and trace where assets are used." } },
  { id: 'cover-art', group: 'assets', title: { 'zh-CN': "设计与选用封面", en: "Create and choose a cover" }, description: { 'zh-CN': "向 Agent 说明封面方向，比较候选，再选用正式封面。", en: "Brief your Agent, compare candidates and choose the cover for your book." } },
  { id: 'illustrations', group: 'assets', title: { 'zh-CN': "图片与插图", en: "Images and illustrations" }, description: { 'zh-CN': "区分人物形象与剧情插图，固定参考，提出具体图片意见。", en: "Separate character images from story illustrations and give precise feedback." } },
  { id: 'references', group: 'assets', title: { 'zh-CN': '资料更新与影响核对', en: 'Review reference changes' }, description: { 'zh-CN': '一件外套改了设定，回头看清哪些已关联的文字需要核对。', en: 'Compare a reference and its linked passages across saved versions.' } },
  { id: 'review', group: 'review', title: { 'zh-CN': '检查与草稿审核', en: 'Checks and draft review' }, description: { 'zh-CN': '建议里只有半句合意，也可以只留下半句。采纳后，再决定是否定稿。', en: 'Review references, adopt excerpts and finalize a saved revision separately.' } },
  { id: 'feedback', group: 'review', title: { 'zh-CN': "提出意见与局部返工", en: "Give feedback and revise" }, description: { 'zh-CN': "用具体文字、图片位置或视频区间，接续同一个任务。", en: "Point to text, an image detail or a video range and continue the same task." } },
  { id: 'formats-and-delivery', group: 'review', title: { 'zh-CN': '文件格式与交稿', en: 'Formats and delivery' }, description: { 'zh-CN': '“发我最新一版”之前，先说清楚哪一稿、哪几集、带哪些附件。', en: 'Choose manuscripts, scripts and supporting materials for a handoff.' } },
  { id: 'agents', group: 'manage', title: { 'zh-CN': '使用外部 Agent', en: 'Work with external agents' }, description: { 'zh-CN': '决定交给 Agent 什么，保留作者审核与决定权。', en: 'Choose what an agent can see and keep approval in your hands.' } },
  { id: 'model-services', group: 'manage', title: { 'zh-CN': "模型服务与费用", en: "Model services and costs" }, description: { 'zh-CN': "选择文字与图片渠道，在对话中核对外发内容和本次预算。", en: "Choose text and image services and approve the material and budget in your conversation." } },
  { id: 'privacy-and-permissions', group: 'manage', title: { 'zh-CN': "隐私与授权范围", en: "Privacy and permissions" }, description: { 'zh-CN': "看清本机保存、外部处理和关联作品之间的授权边界。", en: "Understand local storage, external processing and permissions across linked works." } },
  { id: 'data-and-backup', group: 'manage', title: { 'zh-CN': '作品、版本与备份', en: 'Your work, versions and backups' }, description: { 'zh-CN': '区分页面演示与真实作品，安排版本和独立备份。', en: 'Understand demo data, revision history and independent backups.' } },
  { id: 'troubleshooting', group: 'manage', title: { 'zh-CN': "常见问题与恢复", en: "Troubleshooting and recovery" }, description: { 'zh-CN': "遇到连接、候选、冲突或未知结果，保留原任务继续处理。", en: "Recover from connection issues, conflicts and unknown results using the original task." } },
  { id: 'plugins', group: 'manage', title: { 'zh-CN': '使用创作插件', en: 'Use creative plugins' }, description: { 'zh-CN': '按需组织规划、分支、系列、译稿、听读与交付，让Agent操作，在作品中审阅与接续。', en: 'Choose planning, branches, series, translation, listening and delivery tools; let your Agent operate and review saved results.' } },
  { id: 'plugin-development', group: 'developer', title: { 'zh-CN': '开发创作插件', en: 'Develop a creative plugin' }, description: { 'zh-CN': '从独立 JS/TS/React 工程开始，构建、校验并验证插件。', en: 'Scaffold an independent JS/TS/React project, build a fixed package and validate it.' } },
  { id: 'plugin-publishing', group: 'developer', title: { 'zh-CN': '插件发布与上架', en: 'Publish and list a plugin' }, description: { 'zh-CN': '准备版本与验证证据，通过 GitHub 申请官网目录收录，维护更新与退出。', en: 'Prepare a version and evidence, request a catalog listing through GitHub and maintain updates.' } },
] as const;
export type Doc = (typeof docs)[number];
export type DocGroup = (typeof groups)[number];
export const sectionPath = (group: DocGroup['id']) => `docs/sections/${group}`;
export const sectionContent: Record<DocGroup['id'], {
  description: Record<Locale, string>;
  request: Record<Locale, string>;
  outcome: Record<Locale, string>;
  related: Doc['id'][];
}> = {
  start: {
    description: { 'zh-CN': '安装河图，认识创作库，选择适合自己的第一项创作任务。', en: 'Get Hetu, explore your creative library and choose your first task.' },
    request: { 'zh-CN': '我第一次使用河图。想写一部小镇悬疑小说，先帮我讨论方向、选择合适的创作方法，准备可审阅的建书方案。', en: 'I am new to Hetu. I want to write a small-town mystery. Help me explore directions, choose suitable methods and prepare a book proposal I can review.' },
    outcome: { 'zh-CN': '核对作品类型、保存位置和本次允许范围。先读方案，再决定创建；已有作品就沿原作品继续。', en: 'Check the work type, save location and permission scope. Read the proposal before creating a work; continue an existing work in place.' },
    related: ['codex-first-task', 'screenplays', 'video'],
  },
  novel: {
    description: { 'zh-CN': '从新想法或已有小说出发，讨论故事方向、整理卷章，再读完整参考稿。', en: 'Start with an idea or an existing manuscript, plan the story and read complete chapter drafts.' },
    request: { 'zh-CN': '接着写修表师回乡这一章。先读已确认的大纲与人物设定，保留父亲失踪的悬念，给参考稿，不替换我的正文。', en: 'Continue the chapter where the watchmaker returns home. Read the confirmed outline and character notes first. Keep the father’s disappearance unresolved and return a reference draft without replacing my text.' },
    outcome: { 'zh-CN': '连贯阅读章节，核对人物、伏笔和上下文。需要返工时指明原版本与段落；参考稿、正文采纳和作者定稿分别决定。', en: 'Read the whole chapter and check character, foreshadowing and context. Tie feedback to the original revision and passage. Review, adoption and finalization are separate decisions.' },
    related: ['story-bible', 'feedback', 'formats-and-delivery'],
  },
  screen: {
    description: { 'zh-CN': '原创或改编都从故事开始。阅读分集剧本，观看预演，再核对真实音画与工程交付。', en: 'Develop original or adapted stories, read episode scripts, review previews and check final picture, sound and project files.' },
    request: { 'zh-CN': '开发一个原创短剧：女主从旧钟里听见明天的求救声。先给第一集完整行动与对白；我确认方向后，再讨论预演，不先付费生成。', en: 'Develop an original short drama: a woman hears tomorrow’s cry for help through an old clock. Start with complete action and dialogue for episode one. Discuss a preview after I review it; do not start paid generation yet.' },
    outcome: { 'zh-CN': '先读完整场次，再带声音连续看片。分别判断剧本、预演、实际片段和成片；交付时核对可播放文件与可编辑工程。', en: 'Read complete scenes, then watch continuously with sound. Review scripts, previews, actual clips and the final cut separately. Check playable files and editable project dependencies at delivery.' },
    related: ['characters-and-scenes', 'feedback', 'formats-and-delivery'],
  },
  assets: {
    description: { 'zh-CN': '整理人物、地点与道具的依据，比较封面和图片候选，保留每份素材的用途与来源。', en: 'Ground characters, locations and props, compare covers and image candidates, and keep sources and uses clear.' },
    request: { 'zh-CN': '整理女主的身份、冬季服装和修表铺资料。先复用已经确认的素材，列出缺口；人物形象与剧情插图分开准备，生成前说明参考与费用。', en: 'Organize the protagonist’s identity, winter outfit and watch shop references. Reuse confirmed assets and list gaps first. Prepare character portraits separately from story illustrations, explaining references and costs before generation.' },
    outcome: { 'zh-CN': '放大核对身份、服装、构图与细节，查看图片关联的具体人物或场景。收到候选后再决定选用；资料变化时核对已关联的使用位置。', en: 'Enlarge images to check identity, clothing, composition and details, and inspect their linked character or location. Choose candidates explicitly and review linked uses when references change.' },
    related: ['model-services', 'feedback', 'privacy-and-permissions'],
  },
  review: {
    description: { 'zh-CN': '从完整成果中表达判断，比较返工版本，选择采用内容，再准备明确的交付版本。', en: 'Review complete results, compare revisions, choose what to adopt and prepare a specific version for delivery.' },
    request: { 'zh-CN': '第一集门口这场戏，只改解释能力的两句对白。保留她伸手又收回的动作和后续场次，给我能与当前版比较的候选。', en: 'In the doorway scene of episode one, change only the two lines explaining her ability. Keep the gesture where she reaches out and withdraws her hand, preserve later scenes and return a candidate I can compare with the current revision.' },
    outcome: { 'zh-CN': '确认问题是否解决、保留部分是否被改动。采纳与定稿分别确认；交稿前看清所选修订、附件与文件实际内容。', en: 'Check that the concern is resolved and protected content is intact. Confirm adoption and finalization separately, then inspect the chosen revision, attachments and actual delivered files.' },
    related: ['writing', 'video', 'data-and-backup'],
  },
  manage: {
    description: { 'zh-CN': '安排 Agent 协作、模型费用、权限和备份；遇到冲突或未知结果，沿原操作恢复。', en: 'Manage Agent collaboration, model costs, permissions and backups, and recover conflicts or unknown outcomes through the original operation.' },
    request: { 'zh-CN': '只处理这部作品的封面。先说明会发送的材料、模型、候选数量与费用上限；结果未知时查原计划，不重新付费生成。', en: 'Work only on this book’s cover. Explain the material to send, model, candidate count and spending limit first. If the outcome is unknown, query the original plan instead of paying for another generation.' },
    outcome: { 'zh-CN': '核对本次授权范围与实际账户状态。密钥留在私密存储，作品保留独立备份；恢复后读回原任务结果，不以重建作品解决连接问题。', en: 'Check the permission scope and actual account state. Keep keys in private storage and maintain independent backups. Read back the original task after recovery instead of recreating a work to resolve a connection issue.' },
    related: ['skills', 'creative-library', 'formats-and-delivery'],
  },
  developer: {
    description: { 'zh-CN': '从独立插件开发到发布上架，面向创作工具开发者。普通作者从“开始使用”获取安装包。', en: 'Build independent creative plugins and prepare them for publishing and listing. Authors can get an installer under Getting started.' },
    request: { 'zh-CN': '我想做一个整理人物笔记的河图插件。先阅读开发指南，创建独立工程，声明最小权限并构建校验；用演示资料验证后，整理发布与收录材料。需要构建宿主时再查GitHub仓库说明。', en: 'I want to build a Hetu plugin for character notes. Read the development guide, scaffold an independent project, declare minimal permissions and validate the build. Test with demo material before preparing release and listing evidence. Consult the GitHub repository instructions if a host build is needed.' },
    outcome: { 'zh-CN': '核对包版本与摘要、权限、机器调用和实际界面成果。发布前区分下载制品与源码，保留失败和未验证项，不在日志或申请中附带密钥、作者正文或私密数据。', en: 'Check package version and digest, permissions, machine calls and actual UI results. Distinguish distributions from source before publishing, preserve failed or unverified cases and exclude credentials and private manuscripts from reports.' },
    related: ['install', 'agents', 'troubleshooting'],
  },
};
export const orderedDocs = groups.flatMap(group => docs.filter(doc => doc.group === group.id));
export function docText(doc: Doc, locale: Locale) {
  return fs.readFileSync(path.join(root, locale, doc.id + '.md'), 'utf8');
}
export function searchDocuments(locale: Locale) {
  return orderedDocs.map(doc => ({
    title: doc.title[locale], description: doc.description[locale],
    group: groups.find(group => group.id === doc.group)!.title[locale],
    href: route(locale, 'docs/' + doc.id),
    text: docText(doc, locale).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]+>|[#*`>|]/g, '').replace(/\s+/g, ' ').trim(),
  }));
}
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export async function renderDoc(doc: Doc, locale: Locale) {
  const raw = docText(doc, locale);
  const headings: { id: string; text: string }[] = [];
  const renderer = new marked.Renderer();
  renderer.heading = ({ tokens, depth }) => {
    const text = renderer.parser.parseInline(tokens);
    if (depth !== 2) return `<h${depth}>${text}</h${depth}>`;
    const id = `section-${headings.length + 1}`;
    headings.push({ id, text: text.replace(/<[^>]*>/g, '') });
    return `<h2 id="${id}">${text}</h2>`;
  };
  renderer.link = ({ href, title, tokens }) => {
    let url = href;
    if (href.endsWith('.md')) {
      const target = docs.find(item => item.id === path.posix.basename(href, '.md'));
      if (!target) throw new Error('未知使用指南链接：' + href);
      url = route(locale, 'docs/' + target.id);
    }
    return `<a href="${escape(url)}"${title ? ` title="${escape(title)}"` : ''}>${renderer.parser.parseInline(tokens)}</a>`;
  };
  renderer.code = ({ text, lang }) => lang === 'mermaid'
    ? `<pre class="mermaid">${escape(text)}</pre>`
    : `<pre><code class="language-${escape(lang ?? 'text')}">${escape(text)}</code></pre>`;
  renderer.image = ({ href, text, title }) => {
    const image = (captures as Record<string, { width: number; height: number }>)[path.posix.basename(href)];
    if (!href.startsWith('/images/guides/') || !image) throw new Error('使用指南图片未登记：' + href);
    const url = escape(assetURL(href));
    const hint = locale === 'en' ? 'Open image to enlarge' : '点击图片看大图';
    return `<a class="guide-image" href="${url}" target="_blank" rel="noreferrer" aria-label="${escape(text)} — ${hint}"><img src="${url}" alt="${escape(text)}" width="${image.width}" height="${image.height}" loading="lazy" decoding="async"/></a><small class="guide-image-caption">${escape(title ?? text)}<span>${hint}</span></small>`;
  };
  return { html: await marked.parse(raw, { renderer }), headings, hasMermaid: raw.includes('```mermaid') };
}
