import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import type { Locale } from './site';
import { evidence } from './market';

export const articles = [
  {"id": "line-to-take", "titles": {"zh-CN": "改过一句词，下一次该听什么", "en": "Change a line. Know what to hear next."}, "descriptions": {"zh-CN": "让歌词结构、逐句备选和实际录音保留固定联系，让下一轮返工知道从哪里继续。", "en": "Keep lyrics, alternatives and actual recordings connected so the next revision has a precise place to continue."}},
  {"id": "script-to-preparation", "titles": {"zh-CN": "从一把钥匙到一张制作单", "en": "From a key to a production sheet"}, "descriptions": {"zh-CN": "把固定剧本、制作需求、准备依赖和专业成果连起来，按具体缺漏继续下一轮。", "en": "Connect fixed scripts, requirements and professional results, then revise concrete gaps."}},
  {"id": "pages-and-players", "titles": {"zh-CN": "同一个故事，翻一页，或换一个人来读", "en": "Turn a page, or give the story another reader"}, "descriptions": {"zh-CN": "从绘本的翻页到剧本杀的角色资料，让不同表达保留来源、旧版与下一轮修改的依据。", "en": "From picturebook page turns to role-specific mystery packets, keep sources, prior versions and reasons for the next revision."}},
  {"id": "world-to-screen", "titles": {"zh-CN": "从世界的规则，到屏幕上的一句话", "en": "From a world’s rules to a line on screen"}, "descriptions": {"zh-CN": "把世界前提、读者线索、实际参考图与双语字幕，变成下一轮创作可以继续使用的依据。", "en": "Carry world premises, reader clues, actual images and bilingual subtitles into the next creative iteration."}},
  {"id": "story-across-media", "titles": {"zh-CN": "一个故事，可以怎样继续生长", "en": "More ways for one story to continue"}, "descriptions": {"zh-CN": "从改编理由、固定试读反馈到漫画页面与实际声音，让不同表达接续同一部作品。", "en": "Connect adaptation choices, fixed reader feedback, comic pages and actual recordings."}},
  { id: 'novel-ecosystem', titles: { 'zh-CN': '从规划到下一稿，让工具围绕同一部小说工作', en: 'From the plan to the next draft' }, descriptions: { 'zh-CN': '规划、文风、审校与图鉴如何围绕固定作品接续，让作者把时间用在阅读、判断与下一轮创作。', en: 'Connect planning, preferences, review and an atlas around a durable novel.' } },

  { id: 'creative-plugins', titles: { 'zh-CN': '工具可以生长，作品始终在你手中', en: 'Let the tools grow around your story' }, descriptions: { 'zh-CN': '从一张人物关系图开始，谈稳定的作品底座、按需扩展的工具，以及作者不必承担的操作复杂度。', en: 'Why a durable creative workspace, optional tools and Agent-driven operations belong together.' } },
  { id: 'creative-library', titles: { 'zh-CN': '写剧本，不必先建一本不存在的小说', en: 'A screenplay should not need a placeholder novel' }, descriptions: { 'zh-CN': '小说、剧本与视频各有起点。让作品独立，让关联记住来源，把每次修改的决定留给作者。', en: 'Novels, scripts and videos begin in different places. Keep each work independent and its source connections explicit.' } },
  { id: 'preview-before-production', titles: { 'zh-CN': '先看这一场怎样发生，再决定怎样生成', en: 'See how the scene works before generating it' }, descriptions: { 'zh-CN': '剧本、动态分镜、白模和真实片段回答不同问题。先用合适的材料判断，再把预算用在需要验证的画面上。', en: 'Scripts, animatics, simple 3D previews and real clips answer different questions. Choose what you need to inspect before spending on production.' } },
  { id: 'agent-work-author-review', titles: { 'zh-CN': '把时间留给审稿与创作', en: 'More time for the decisions that shape your story' }, descriptions: { 'zh-CN': '向 Agent 说出目标，让它整理资料、准备稿件和交付。打开河图洛书，读成果、比差异、提意见，再决定留下什么。', en: 'Let your Agent organize the project and prepare the work. Read, compare and make the creative decisions in Hetu Luoshu.' } },
  { id: 'authors-at-the-center', titles: { 'zh-CN': 'AI 可以多给一稿，但不能替你说那句话', en: 'The line an Agent cannot choose for you' }, descriptions: { 'zh-CN': '同一场告别，为什么有人写对白，有人只写关门声？谈谈作者的品味、判断，以及工具该站在哪里。', en: 'A key on a table, a final accusation or a quiet gesture: the choices that make a story yours deserve room to breathe.' } },
  { id: 'story-to-screen', titles: { 'zh-CN': '小说写了十万字，短剧第一集却卡住了', en: 'Your novel is ready. What happens in the first scene?' }, descriptions: { 'zh-CN': '从一枚玉扣、三声敲门，到数亿人的观看市场：好故事离短剧，还差哪几步？', en: 'A broken radio, a growing mobile market and the practical work between a manuscript and a scene someone can perform.' } },
  { id: 'agent-friendly', titles: { 'zh-CN': '别让好故事，困在“最终版3”里', en: 'Bring your Agent. Find the right draft.' }, descriptions: { 'zh-CN': 'AI 越来越能写，创作软件还要做好什么？从一次人物关系的改动，谈作品、来源和作者决定如何持续积累。', en: 'As agents become more capable, durable sources, revisions and author decisions help a creative project keep moving.' } },
] as const;
export type Article = typeof articles[number];

export function articleImage(article: Article, locale: Locale): string {
  if (article.id === 'story-to-screen' || article.id === 'preview-before-production') return `/images/journal-adaptation${locale === 'en' ? '-en' : ''}.webp`;
  return `/images/${article.id === 'authors-at-the-center' || article.id === 'creative-library' ? 'journal-authors' : 'journal-workspace'}.webp`;
}

export async function renderArticle(article: Article, locale: Locale) {
  const raw = fs.readFileSync(path.resolve(process.cwd(), 'src/content/blog', locale, article.id + '.md'), 'utf8').replace(/^# [^\r\n]*(?:\r?\n|$)/, '').replace(/\{\{(china|global)\.([a-z0-9_]+)\}\}/g, (_, region: 'china' | 'global', key: string) => {
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
