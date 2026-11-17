import fs from 'node:fs';
import path from 'node:path';
import type { Locale } from './site';
import { source } from './site';
import externalListings from '../data/plugin-listings.json';

// 官网只组织作者场景；可执行合同与版本仍归各插件包。
const editorial = [
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
] as const;
export const categories = [
  { id: 'planning', title: { 'zh-CN': '小说规划', en: 'Novel planning' } },
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
    for (const url of [listing.source_repository, listing.release.url, listing.release.download_url, listing.release.evidence_url, listing.release.integrity_url]) if (new URL(url).protocol !== 'https:') throw new Error(`插件来源必须为HTTPS：${item.slug}`);
  } else {
    if (manifest.id !== `org.hetu.${item.slug}`) throw new Error(`插件目录与包不符：${directory}`);
    fs.accessSync(path.resolve(process.cwd(), '../..', directory, 'CAPABILITIES.md'));
  }
  const repository = listing?.source_repository ?? source;
  return {
    ...item, ...manifest, directory,
    publisher: listing?.publisher ?? { 'zh-CN': '河图洛书', en: 'Hetu Luoshu' },
    release: listing?.release,
    source: listing ? `${repository}/tree/${listing.source_commit}` : `${source}/tree/main/${directory}`,
    capabilities: listing ? `${repository}/blob/${listing.source_commit}/CAPABILITIES.md` : `${source}/blob/main/${directory}/CAPABILITIES.md`,
  };
});
export type CreativePlugin = typeof plugins[number];
