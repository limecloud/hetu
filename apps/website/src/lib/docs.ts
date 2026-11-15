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
  { id: 'getting-started', group: 'start', title: { 'zh-CN': '快速入门', en: 'Quick start' }, description: { 'zh-CN': '向 Agent 说出目标，回来读稿或看片，提意见并继续。', en: 'Give your Agent a goal, read or watch the result, then give feedback and continue.' } },
  { id: 'install', group: 'start', title: { 'zh-CN': '获取与安装 Mac 版', en: 'Get Hetu for Mac' }, description: { 'zh-CN': '从正式发布页获取安装包，保留已有作品与任务继续。', en: 'Get a release installer and continue your existing works and tasks.' } },
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
  { id: 'download-and-install', group: 'developer', title: { 'zh-CN': 'Mac 源码版（开发者）', en: 'Mac source build for developers' }, description: { 'zh-CN': '面向已有开发环境的维护者，获取源码并构建 Mac 开发版。', en: 'Get the source and build the Mac development app using an existing development environment.' } },
] as const;
export type Doc = (typeof docs)[number];
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
