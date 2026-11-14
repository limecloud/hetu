import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { route, type Locale } from './site';
import { assetURL } from './assets';
import captures from '../../assets/guides/captures.json';

const root = path.resolve(process.cwd(), 'src/content/guides');
export const groups = [
  { id: 'start', title: { 'zh-CN': '开始创作', en: 'Getting started' } },
  { id: 'create', title: { 'zh-CN': '改编、审核与交付', en: 'Adapt, review and deliver' } },
  { id: 'manage', title: { 'zh-CN': '管理你的创作方式', en: 'Your creative workflow' } },
  { id: 'developer', title: { 'zh-CN': '开发者', en: 'For developers' } },
] as const;
export const docs = [
  { id: 'getting-started', group: 'start', title: { 'zh-CN': '快速入门', en: 'Quick start' }, description: { 'zh-CN': '打开一本书，比较和采纳参考稿，需要时亲自编辑。', en: 'Open a book, compare and adopt a reference passage, then edit whenever you choose.' } },
  { id: 'creative-paths', group: 'start', title: { 'zh-CN': '选择你的创作路径', en: 'Choose a project starting point' }, description: { 'zh-CN': '只有一个点子、已经写了十万字，或拿到了改编授权，该从哪里开始？', en: 'Find the right starting point for an original script, your own book, a licensed adaptation or an existing draft.' } },
  { id: 'skills', group: 'start', title: { 'zh-CN': '选择与安装 Skills', en: 'Choose and install Skills' }, description: { 'zh-CN': '给自己的写作助手选一套适合这本书的题材方法。', en: 'Choose genre methods that fit this book for your writing assistant.' } },
  { id: 'codex-first-task', group: 'start', title: { 'zh-CN': '用 Codex 构思一本新书', en: 'Plan a book with Codex' }, description: { 'zh-CN': '向 Codex 说出想法，让它准备并保存建书方案，你来审阅。', en: 'Give Codex the idea. Let it prepare and save a book proposal for your review.' } },
  { id: 'writing', group: 'start', title: { 'zh-CN': '章节与写作', en: 'Chapters and writing' }, description: { 'zh-CN': '切换章节、编辑正文，理解保存与修订。', en: 'Find chapters, edit a manuscript and understand revisions.' } },
  { id: 'story-bible', group: 'start', title: { 'zh-CN': '维护设定集', en: 'Maintain your story bible' }, description: { 'zh-CN': '写到第五十章，还能找到配角受过哪次伤、秘密何时才揭开。', en: 'Keep characters, world rules and timelines grounded in confirmed facts.' } },
  { id: 'adaptation', group: 'create', title: { 'zh-CN': '从小说到短剧', en: 'From novel to screenplay' }, description: { 'zh-CN': '“她很生气”，到了镜头里怎么演？先用一章原文，试成一场戏。', en: 'Work with episodes and scenes while keeping the source novel in view.' } },
  { id: 'review', group: 'create', title: { 'zh-CN': '检查与草稿审核', en: 'Checks and draft review' }, description: { 'zh-CN': '建议里只有半句合意，也可以只留下半句。采纳后，再决定是否定稿。', en: 'Review references, adopt excerpts and finalize a saved revision separately.' } },
  { id: 'formats-and-delivery', group: 'create', title: { 'zh-CN': '文件格式与交稿', en: 'Formats and delivery' }, description: { 'zh-CN': '“发我最新一版”之前，先说清楚哪一稿、哪几集、带哪些附件。', en: 'Choose manuscripts, scripts and supporting materials for a handoff.' } },
  { id: 'agents', group: 'manage', title: { 'zh-CN': '使用外部 Agent', en: 'Work with external agents' }, description: { 'zh-CN': '决定交给 Agent 什么，保留作者审核与决定权。', en: 'Choose what an agent can see and keep approval in your hands.' } },
  { id: 'references', group: 'manage', title: { 'zh-CN': '资料更新与影响核对', en: 'Review reference changes' }, description: { 'zh-CN': '一件外套改了设定，回头看清哪些已关联的文字需要核对。', en: 'Compare a reference and its linked passages across saved versions.' } },
  { id: 'data-and-backup', group: 'manage', title: { 'zh-CN': '作品、版本与备份', en: 'Your work, versions and backups' }, description: { 'zh-CN': '区分页面演示与真实作品，安排版本和独立备份。', en: 'Understand demo data, revision history and independent backups.' } },
  { id: 'download-and-install', group: 'developer', title: { 'zh-CN': 'Mac 源码版（开发者）', en: 'Mac source build for developers' }, description: { 'zh-CN': '面向已有开发环境的维护者，获取源码并构建 Mac 开发版。', en: 'Get the source and build the Mac development app using an existing development environment.' } },
] as const;
export type Doc = (typeof docs)[number];
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export async function renderDoc(doc: Doc, locale: Locale) {
  const raw = fs.readFileSync(path.join(root, locale, doc.id + '.md'), 'utf8');
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
