import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import type { Locale } from './site';
import { evidence } from './market';

export const articles = [
  { id: 'agent-work-author-review', titles: { 'zh-CN': '把时间留给审稿与创作', en: 'More time for the decisions that shape your story' }, descriptions: { 'zh-CN': '向 Agent 说出目标，让它整理资料、准备稿件和交付。打开河图洛书，读成果、比差异、提意见，再决定留下什么。', en: 'Let your Agent organize the project and prepare the work. Read, compare and make the creative decisions in Hetu Luoshu.' } },
  { id: 'authors-at-the-center', titles: { 'zh-CN': 'AI 可以多给一稿，但不能替你说那句话', en: 'The line an Agent cannot choose for you' }, descriptions: { 'zh-CN': '同一场告别，为什么有人写对白，有人只写关门声？谈谈作者的品味、判断，以及工具该站在哪里。', en: 'A key on a table, a final accusation or a quiet gesture: the choices that make a story yours deserve room to breathe.' } },
  { id: 'story-to-screen', titles: { 'zh-CN': '小说写了十万字，短剧第一集却卡住了', en: 'Your novel is ready. What happens in the first scene?' }, descriptions: { 'zh-CN': '从一枚玉扣、三声敲门，到数亿人的观看市场：好故事离短剧，还差哪几步？', en: 'A broken radio, a growing mobile market and the practical work between a manuscript and a scene someone can perform.' } },
  { id: 'agent-friendly', titles: { 'zh-CN': '别让好故事，困在“最终版3”里', en: 'Bring your Agent. Find the right draft.' }, descriptions: { 'zh-CN': 'AI 越来越能写，创作软件还要做好什么？从一次人物关系的改动，谈作品、来源和作者决定如何持续积累。', en: 'As agents become more capable, durable sources, revisions and author decisions help a creative project keep moving.' } },
] as const;
export type Article = typeof articles[number];

export function articleImage(article: Article, locale: Locale): string {
  if (article.id === 'story-to-screen') return `/images/journal-adaptation${locale === 'en' ? '-en' : ''}.webp`;
  return `/images/${article.id === 'authors-at-the-center' ? 'journal-authors' : 'journal-workspace'}.webp`;
}

export async function renderArticle(article: Article, locale: Locale) {
  const raw = fs.readFileSync(path.resolve(process.cwd(), 'src/content/blog', locale, article.id + '.md'), 'utf8').replace(/\{\{(china|global)\.([a-z0-9_]+)\}\}/g, (_, region: 'china' | 'global', key: string) => {
    const fact = (evidence[region] as Record<string, { display: string }>)[key];
    if (!fact) throw new Error(`未知市场数据：${region}.${key}`);
    return fact.display;
  });
  const headings: { id: string; text: string }[] = [];
  const renderer = new marked.Renderer();
  renderer.heading = ({ tokens, depth }) => {
    const text = renderer.parser.parseInline(tokens);
    if (depth !== 2) return `<h${depth}>${text}</h${depth}>`;
    const id = `article-section-${headings.length + 1}`;
    headings.push({ id, text: text.replace(/<[^>]*>/g, '') });
    return `<h2 id="${id}">${text}</h2>`;
  };
  return { html: await marked.parse(raw, { renderer }), headings };
}
