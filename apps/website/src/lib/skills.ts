import catalog from '../../../../integrations/catalog.json';
import genres from '../../../../tools/hetu-skills/genres.json';
import nativeStrings from '../../../../assets/localization/native.json';
import type { Locale } from './site';

const manifests = import.meta.glob<{ version: string }>(
  '../../../../integrations/codex/*/plugin.json', { eager: true, import: 'default' },
);
const strings = nativeStrings as Record<string, Record<Locale, string>>;

// 英文官网只翻译介绍；安装包中的中文方法始终直接读取题材事实源。
const englishSummaries: Record<string, string> = {
  general: 'Compare story directions before committing to a genre or a commercial formula.',
  military: 'Build individual and collective choices around missions, organizations, limited resources, and the consequences of war.',
  espionage: 'Develop covert conflicts through identity, evidence, trust, and the real cost of obtaining information.',
  historical: 'Ground characters in the institutions, living conditions, and value conflicts of a specific era.',
  'historical-brainstorm': 'Explore an explicit departure from history while testing knowledge against institutions, resources, and communication.',
  xuanhuan: 'Support discovery and character choices with understandable power systems, growth costs, and competing factions.',
  'xuanhuan-brainstorm': 'Change a familiar fantasy world through an unusual rule with clear limits and room to develop.',
  xianxia: 'Connect cultivation and the pursuit of power to personal values, commitments, and the surrounding order.',
  wuxia: 'Test what heroism means through conflicts of martial power, loyalty, identity, and institutions.',
  'western-fantasy': 'Shape a journey through the institutions, beliefs, magic, and cultural differences of a distinct world.',
  'urban-daily': 'Let small changes in work, family, community, and personal wishes accumulate into meaningful progress.',
  'urban-brainstorm': 'Disrupt familiar life with an extraordinary ability or situation that creates both immediate feedback and lasting conflict.',
  'urban-high-martial': 'Explore how new powers change modern organizations, society, and the competition to grow.',
  'urban-cultivation': 'Develop the conflicts of identity, responsibility, and resources where cultivation meets modern life.',
  'urban-farming': 'Trace improvements in everyday life through labor, enterprise, and community relationships.',
  business: 'Shape choices through professional work, organizational interests, and competition over resources.',
  realistic: 'Portray complex characters through concrete lives, social relationships, and personal circumstances.',
  scifi: 'Explore how a scientific or technological premise changes people, institutions, and civilizations.',
  apocalypse: 'Drive characters through choices about survival, cooperation, and rebuilding after disaster.',
  infinite: 'Connect trials across worlds or stages to a continuing character arc and an overarching story.',
  'rules-horror': 'Create fear and curiosity through recognizable rules, contradictions, and the unknown.',
  mystery: 'Organize evidence, motives, and changing understanding around a question worth solving.',
  supernatural: 'Keep causality traceable while exploring local life, beliefs, and unexplained events.',
  thriller: 'Force increasingly difficult choices under danger, time pressure, and incomplete information.',
  gaming: 'Drive exploration, competition, and character choices through clear game and world rules.',
  esports: 'Make individual skill, teamwork, and professional structures matter to competitive outcomes.',
  sports: 'Develop competition and growth through physical, tactical, team, and career constraints.',
  'light-novel': 'Sustain a reading experience through distinctive voices, relationships, and an unusual premise.',
  derivative: 'Develop new choices and consequences within explicit source material, changes, and conditions of use.',
  'historical-romance': 'Connect intimacy to identity, family, institutions, and personal wishes in a particular era.',
  palace: 'Give competition over resources, status, and relationships lasting consequences within a household or court.',
  'modern-romance': 'Build believable relationships through mutual actions, personal boundaries, and life choices.',
  'ceo-romance': 'Give characters agency within relationships shaped by wealth, family, and unequal power.',
  'youth-romance': 'Explore changing relationships through growing up, peer groups, and choices about the future.',
  'workplace-romance': 'Shape characters through the competing demands of careers, family, time, and intimacy.',
  'fantasy-romance': 'Make the rules of a fantasy world and the choices within a relationship affect one another.',
  entertainment: 'Develop growth and relationships through creative production, professional collaboration, and public image.',
  period: 'Ground everyday life and growth in the resources, institutions, and family ties of a specific period.',
  farming: 'Create a rhythm of progress through work, enterprise, and building a community.',
  'quick-transmigration': 'Connect identities and missions across multiple worlds to one continuing character arc.',
  danmei: 'Give two male leads distinct goals and agency within the relationship the author chooses.',
  baihe: 'Develop the agency, differences, and shared growth of two female leads in the relationship the author chooses.',
  'war-god': 'Use hidden identity and real responsibilities to create genre payoffs with meaningful choices and consequences.',
  'short-story': 'Resolve a clear story question, character choice, and emotional arc within a limited length.',
  'historical-life': 'Explore livelihoods, social ties, and personal wishes in historical or invented societies.',
};

const familyNames: Record<string, string> = {
  通用: 'General', 历史军事: 'History and military', 幻想修行: 'Fantasy and cultivation',
  都市现实: 'Urban and realistic', 科幻冒险: 'Science fiction and adventure',
  悬疑惊悚: 'Mystery and suspense', 游戏体育: 'Games and sports',
  衍生轻小说: 'Light novels and derivative fiction', 关系成长: 'Relationships and growth', 短篇: 'Short fiction',
};

const taskDescriptions: Record<string, Record<Locale, string>> = {
  'hetu-setup': { 'zh-CN': '开始前看看所选 Agent 能做什么；中途退出后，可以接着原来的写作任务继续。', en: 'See what your chosen Agent can help with, or pick up a writing task where you left off.' },
  'hetu-book-create': { 'zh-CN': '比较题材、读者和故事方向，准备几个新书方案，由你挑选。', en: 'Compare genres, readers, and story directions, then choose an idea for your new book.' },
  'hetu-book-profile': { 'zh-CN': '根据故事内容拟书名、写简介、提炼看点，由你选用。', en: 'Explore titles, synopses, and highlights that fit your story, then choose what to use.' },
  'hetu-outline': { 'zh-CN': '从全书到每卷、每章安排情节，想清人物为什么这样选、伏笔何时回应。', en: 'Plan your story from the whole book down to each chapter, with clear choices and payoffs.' },
  'hetu-cover': { 'zh-CN': '根据书名、题材和你的想法准备封面，你看过后再选。', en: 'Explore covers based on the title, genre, and your ideas, then pick the one you like.' },
  'hetu-draft': { 'zh-CN': '你提出写作请求后，按设定和章纲准备章节参考稿。', en: 'Ask for a chapter reference draft that follows your story bible and outline.' },
  'hetu-revise': { 'zh-CN': '只改你选中的文字，或按你的批注返工，并说明改了哪里、为什么改。', en: 'Revise the text you select or respond to your comments, explaining what changed and why.' },
  'hetu-drama': { 'zh-CN': '将你有权使用的小说内容改成短剧参考稿，保留与原文的对应。', en: 'Adapt a novel you have the right to use into a short drama reference draft, keeping its links to the source.' },
};

export const familyLabel = (family: string, locale: Locale) => locale === 'en' ? familyNames[family] ?? family : family;
export const platformLabel = (platform: string, locale: Locale) => platform === 'qidian'
  ? (locale === 'en' ? 'Qidian' : '起点中文网') : (locale === 'en' ? 'Fanqie' : '番茄小说');
export const channelLabel = (channel: string, locale: Locale) => ({
  male: locale === 'en' ? 'Male readership' : '男频',
  female: locale === 'en' ? 'Female readership' : '女频',
  shared: locale === 'en' ? 'Shared' : '通用频道',
})[channel] ?? channel;

export function skillCatalog(locale: Locale) {
  return catalog.suites.map(suite => {
    const genre = genres.find(item => item.id === suite.id);
    const manifest = manifests[`../../../../integrations/codex/${suite.pluginName}/plugin.json`];
    if (!genre || !manifest || !englishSummaries[suite.id]) throw new Error(`官网题材资料缺失：${suite.id}`);
    const categories = catalog.categories.filter(category => category.kind !== 'field' && category.suiteIDs.includes(suite.id));
    return {
      ...suite,
      title: locale === 'en' ? genre.en : genre.name,
      summary: locale === 'en' ? englishSummaries[suite.id] : suite.summary,
      version: manifest.version,
      familyLabel: familyLabel(suite.family, locale),
      genre,
      categories,
      search: [suite.id, suite.pluginName, genre.name, genre.en, suite.family, ...suite.aliases].join(' ').toLocaleLowerCase(),
      sources: [...new Set(categories.map(category => `${category.platform}:${category.channel}`))].join(' '),
    };
  });
}

export const skillTasks = (locale: Locale) => catalog.skills.map(id => ({
  id, title: strings[`agent.skill.${id}`][locale], description: taskDescriptions[id][locale],
}));

export const skillFamilies = [...new Set(catalog.suites.map(suite => suite.family))];
export const featuredSuiteIDs = ['military', 'xianxia', 'apocalypse', 'infinite', 'mystery', 'modern-romance'];
