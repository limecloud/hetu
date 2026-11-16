import fs from 'node:fs';
import path from 'node:path';
import type { Locale } from './site';
import { source } from './site';

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
] as const;
export const categories = [
  { id: 'relationships', title: { 'zh-CN': '人物关系', en: 'Relationships' } },
  { id: 'timeline', title: { 'zh-CN': '故事时间', en: 'Chronology' } },
] as const;
export const plugins = editorial.map(item => {
  const directory = `plugins/${item.slug}`;
  const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../..', directory, 'plugin.json'), 'utf8')) as {
    id: string; version: string; host_api: string; license: string;
    display: Record<Locale, string>; permissions: string[];
  };
  if (manifest.id !== `org.hetu.${item.slug}` || !manifest.display.en || !manifest.display['zh-CN']) throw new Error(`插件目录与包不符：${directory}`);
  fs.accessSync(path.resolve(process.cwd(), '../..', directory, 'CAPABILITIES.md'));
  return { ...item, ...manifest, directory, source: `${source}/tree/main/${directory}`, capabilities: `${source}/blob/main/${directory}/CAPABILITIES.md` };
});
export type CreativePlugin = typeof plugins[number];
