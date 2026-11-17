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
  {
    slug: 'screenplay', category: 'screenplay',
    summary: { 'zh-CN': '把全剧、分集、场次与人物选择连起来，从规划继续到可比较的剧本参考稿。', en: 'Connect the whole story, episodes, scenes and character choices, then continue into comparable screenplay drafts.' },
    use: { 'zh-CN': '原创电影、系列短剧、旧稿复盘、人物弧线与场次返工', en: 'Original films, episodic drama, script review, character arcs and scene revisions' },
    request: { 'zh-CN': '发现河图剧本创作插件与本次作品的实际能力，按同包Skill先阅读已有方案和固定原稿，再整理全剧、分集、场次、人物弧线与伏笔。把选定分集关联宿主写作任务，准备Fountain参考稿，读取意见后返工并回读两版成果；不自动采纳或定稿。未知结果沿原操作查询。', en: 'Discover Screenplay and the actual capabilities for this work. Read its packaged Skill, existing plans and fixed manuscripts before organizing the story, episodes, scenes, character arcs and clues. Connect an episode to a host writing task, prepare a Fountain draft, revise against feedback and read both versions back. Do not adopt or finalize text automatically. Recover unknown outcomes through the original operation.' },
    review: { 'zh-CN': '沿故事结构阅读人物的目标、冲突与代价，对照关系和伏笔。阅读实际分集稿，指出具体场次，让 Agent 依据固定版本继续。', en: 'Review goals, conflicts and costs alongside relationships and clues. Read the actual episode draft and name the scene your Agent should continue from a fixed version.' },
  },
  {
    slug: 'video-studio', category: 'video',
    summary: { 'zh-CN': '围绕分镜、素材、预演和剪辑版本推进制作，把审片意见接续到局部返工与工程交付。', en: 'Organize shots, assets, previs and edit versions, then carry review feedback into local rework and project delivery.' },
    use: { 'zh-CN': '短剧视频、独立短片、已有素材续作、预演审片与返工交付', en: 'Short drama, independent films, existing footage, previs review and rework delivery' },
    request: { 'zh-CN': '发现河图视听制作插件与本次视频作品的实际能力，读取同包Skill和已有工程，先梳理分镜、素材职责及实际媒体。按需要准备预演，固定制作请求和预算；需要付费或外发时另行确认。导入真实成果并核验完整解码，组织剪辑时间映射，按固定区间意见建立新版本，核验媒体及工程清单后交付。未知先查原任务，不自动认可成片。', en: 'Discover Video Studio and the actual capabilities for this video work. Read its packaged Skill and existing project, then organize shots, asset roles and actual media. Prepare previs when useful and fix production requests and budgets; confirm costs and external sharing separately. Import results, verify full decoding, organize edit mappings, create a new version from fixed-range feedback, and verify media and the project manifest before delivery. Recover unknown tasks first and do not approve the final film automatically.' },
    review: { 'zh-CN': '观看固定预演或成片，明确哪一段需要改变。保留旧版与意见，对照返工版本，再决定选用及交付。', en: 'Watch fixed previs or rendered edits and identify the interval to change. Keep the old version and feedback, compare the rework, then decide what to select and deliver.' },
  },
  {
    slug: 'director-stage', category: 'video',
    summary: { 'zh-CN': '让 Agent 布置人物、家具与机位，用三维白模看清空间、构图和镜头节奏。', en: 'Ask your Agent to arrange people, props and cameras, then inspect space, framing and pacing in 3D previs.' },
    use: { 'zh-CN': '对白走位、场景布置、机位比较、白模预演与工程参考', en: 'Dialogue blocking, set layout, camera comparisons, previs and reusable scene projects' },
    request: { 'zh-CN': '重新发现河图已安装的导演布景台及当前作品能力，读取同包Skill、已有场景与固定来源。按我的目标安排人物站位、家具、机位、关键帧和镜头切换，保存后回读。固定计划并输出真实白模图、预演和可接续场景工程，检查画面与完整解码，再按固定版本意见返工并比较两版。正常操作通过CLI/MCP完成，不要求我先学三维操作；不自动调用付费模型或认可成片，未知先回读原操作。', en: 'Rediscover Director Stage and the actual capabilities for this work. Read its packaged Skill, existing scenes and fixed sources. Arrange people, props, cameras, keyframes and cuts for my goal, then save and read back. Fix a render plan and produce actual white-model images, previs and a reusable scene project. Inspect the images and full decoding, revise against fixed-version feedback and compare both versions. Use CLI/MCP without requiring me to learn 3D controls. Do not invoke paid models or approve a final film automatically; recover unknown operations first.' },
    review: { 'zh-CN': '查看人物相对位置、遮挡和机位，播放白模预演。说出哪一帧、哪个人物或哪次切镜需要改变，让 Agent 沿固定场景继续；也可直接拖动、精确编辑和导出。', en: 'Inspect positions, occlusion and cameras, then watch the previs. Name a frame, person or cut for your Agent to revise from the fixed scene, or drag, edit and export it yourself.' },
  },
  {
    slug: 'shanhai', category: 'templates',
    summary: { 'zh-CN': '先读一个故事，再带走它的写法。用创作模板推进小说、剧本与短剧，并在作品里接续两稿与意见。', en: 'Try a story, take its method and continue fiction or screenwriting with fixed drafts and feedback.' },
    use: { 'zh-CN': '故事构思、人物设定、长篇复盘、章节起草、场次改编、审阅与交付', en: 'Story ideas, characters, manuscript review, chapters, scenes, revisions and delivery' },
    request: { 'zh-CN': '发现已安装的山海经纬和本次作品能力，读取同包 Skill，按我的目标选择固定模板。先阅读已有资料并列明实际覆盖范围，保存方法实例，再通过宿主任务准备候选、读取意见并沿原任务返工。核对两稿和固定引用后整理交付，不自动采纳或定稿。山海与小说规划为平行插件，无需先安装其他专业插件；结果未知先查原操作。', en: 'Discover Shanhai and the capabilities for this work. Read its packaged Skill and choose a fixed template for my goal. Read existing material and state the actual coverage, save a method instance, then use host tasks to prepare drafts and revise against feedback. Verify both drafts and fixed references before delivery. Do not adopt or finalize automatically. Shanhai works independently of Novel Planner; recover unknown outcomes through the original operation.' },
    review: { 'zh-CN': '在山海独立官网体验原创故事和方法；回到河图阅读固定候选、比较版本、写下意见，沿当前实例继续。模板可以独立浏览、复制和下载。', en: 'Explore original stories and methods on Shanhai’s independent website. In Hetu, read fixed drafts, compare versions, leave feedback and continue the same instance. Templates can also be read, copied and downloaded independently.' },
  },
] as const;
export const categories = [
  { id: 'templates', title: { 'zh-CN': '创作模板', en: 'Creative templates' } },
  { id: 'planning', title: { 'zh-CN': '小说规划', en: 'Novel planning' } },
  { id: 'screenplay', title: { 'zh-CN': '剧本创作', en: 'Screenwriting' } },
  { id: 'video', title: { 'zh-CN': '视听制作', en: 'Video production' } },
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
    for (const url of [listing.source_repository, listing.release.url, listing.release.download_url, listing.release.evidence_url, listing.release.integrity_url, ...(listing.homepage ? [listing.homepage] : [])]) if (new URL(url).protocol !== 'https:') throw new Error(`插件来源必须为HTTPS：${item.slug}`);
    if (listing.capabilities_path && (/[\\?#]/.test(listing.capabilities_path) || listing.capabilities_path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error(`插件功能清单路径无效：${item.slug}`);
  } else {
    if (manifest.id !== `org.hetu.${item.slug}`) throw new Error(`插件目录与包不符：${directory}`);
    fs.accessSync(path.resolve(process.cwd(), '../..', directory, 'CAPABILITIES.md'));
  }
  const repository = listing?.source_repository ?? source;
  return {
    ...item, ...manifest, directory,
    publisher: listing?.publisher ?? { 'zh-CN': '河图洛书', en: 'Hetu Luoshu' },
    release: listing?.release,
    homepage: listing?.homepage,
    source: listing ? `${repository}/tree/${listing.source_commit}` : `${source}/tree/main/${directory}`,
    capabilities: listing ? `${repository}/blob/${listing.source_commit}/${listing.capabilities_path ?? 'CAPABILITIES.md'}` : `${source}/blob/main/${directory}/CAPABILITIES.md`,
  };
});
export type CreativePlugin = typeof plugins[number];
