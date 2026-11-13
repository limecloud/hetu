import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { route, type Locale } from './site';

const root = path.resolve(process.cwd(), 'src/content/guides');
export const groups = [
  { id: 'start', title: { 'zh-CN': '开始创作', en: 'Getting started' } },
  { id: 'create', title: { 'zh-CN': '改编、审核与交付', en: 'Adapt, review and deliver' } },
  { id: 'manage', title: { 'zh-CN': '管理你的创作方式', en: 'Your creative workflow' } },
] as const;
export const docs = [
  { id: 'getting-started', group: 'start', title: { 'zh-CN': '快速入门', en: 'Quick start' }, description: { 'zh-CN': '用演示作品走一遍写作、设定、审核与交付。', en: 'Explore writing, story facts, review and delivery with a sample project.' } },
  { id: 'writing', group: 'start', title: { 'zh-CN': '章节与写作', en: 'Chapters and writing' }, description: { 'zh-CN': '切换章节、编辑正文，理解保存与修订。', en: 'Find chapters, edit a manuscript and understand revisions.' } },
  { id: 'story-bible', group: 'start', title: { 'zh-CN': '维护设定集', en: 'Maintain your story bible' }, description: { 'zh-CN': '整理人物、世界观与时间线，确认后再锁定。', en: 'Keep characters, world rules and timelines grounded in confirmed facts.' } },
  { id: 'adaptation', group: 'create', title: { 'zh-CN': '从小说到短剧', en: 'From novel to screenplay' }, description: { 'zh-CN': '看懂分集与场次，保留与原著的对应关系。', en: 'Work with episodes and scenes while keeping the source novel in view.' } },
  { id: 'review', group: 'create', title: { 'zh-CN': '检查与草稿审核', en: 'Checks and draft review' }, description: { 'zh-CN': '核对参考稿、局部采纳，再独立确认作者定稿。', en: 'Review references, adopt excerpts and finalize a saved revision separately.' } },
  { id: 'formats-and-delivery', group: 'create', title: { 'zh-CN': '文件格式与交稿', en: 'Formats and delivery' }, description: { 'zh-CN': '选择正文、剧本和素材，准备接收方需要的材料。', en: 'Choose manuscripts, scripts and supporting materials for a handoff.' } },
  { id: 'agents', group: 'manage', title: { 'zh-CN': '使用外部 Agent', en: 'Work with external agents' }, description: { 'zh-CN': '决定交给 Agent 什么，保留作者审核与决定权。', en: 'Choose what an agent can see and keep approval in your hands.' } },
  { id: 'data-and-backup', group: 'manage', title: { 'zh-CN': '作品、版本与备份', en: 'Your work, versions and backups' }, description: { 'zh-CN': '区分页面演示与真实作品，安排版本和独立备份。', en: 'Understand demo data, revision history and independent backups.' } },
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
  return { html: await marked.parse(raw, { renderer }), headings, hasMermaid: raw.includes('```mermaid') };
}
