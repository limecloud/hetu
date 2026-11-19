import type { RecordValue, WorkRef } from "./gateway.ts";

type Read = { action: string; input?: RecordValue };
export type Section = { id: string; title: string; intent: string; read: (work?: WorkRef) => Read | undefined };
const exact = (action: string) => () => ({ action });

// 导航按作者任务组织。新增领域视图不需要修改Codex桥接。
export const sections: Section[] = [
  { id: "profile", title: "作品", intent: "完善作品资料与创作方向", read: work => work ? ({ action: "hetu.works.get", input: { work_ref: work } }) : undefined },
  { id: "content", title: "正文与分集", intent: "整理卷章或分集场次，起草或返工指定内容", read: work => !work ? undefined : work.kind === "novel" ? { action: "hetu.novels.get" } : work.kind === "drama" ? { action: "hetu.drama.projects.get", input: { project_id: work.object_id } } : { action: "hetu.video.projects.get", input: { video_project_id: work.object_id } } },
  { id: "outline", title: "大纲", intent: "复盘并完善总纲、卷纲与章纲，或剧本及视频计划", read: work => work?.kind === "novel" ? { action: "hetu.outlines.get" } : undefined },
  { id: "canon", title: "设定", intent: "整理人物、世界、时间与规则，准备有依据的变更", read: work => work ? { action: "hetu.blueprints.get" } : undefined },
  { id: "tasks", title: "任务与参考稿", intent: "恢复原任务，读取参考稿、候选和公开意见并继续", read: exact("hetu.creative_tasks.list") },
  { id: "resources", title: "资料", intent: "整理人物、地点、道具与考据资料", read: exact("hetu.resources.list") },
  { id: "assets", title: "图片与素材", intent: "准备或返工图片及制作素材，保持固定来源与用途", read: exact("hetu.assets.list") },
  { id: "cues", title: "创作线索", intent: "整理创作线索并关联固定内容", read: exact("hetu.cues.list") },
  { id: "reviews", title: "审核", intent: "核对待审稿与固定依据，解释差异并准备作者决定", read: exact("hetu.reviews.list") },
  { id: "reports", title: "检查", intent: "检查故事、设定与改编一致性，说明实际覆盖和未核对内容", read: exact("hetu.reports.list") },
  { id: "links", title: "关联作品", intent: "核对关联作品及固定来源，准备更新依据或解除关系的方案", read: exact("hetu.work_links.list") },
  { id: "versions", title: "版本", intent: "准备固定版本快照、比较或合并方案，保留当前正文与未保存稿", read: exact("hetu.git.status") },
  { id: "delivery", title: "导入与交付", intent: "导入明确原稿，或按固定文稿、媒体与完整工程准备交付方案", read: exact("hetu.agent_operations.list") },
  { id: "operations", title: "操作方案", intent: "读取原操作方案，解释完整差异并沿原操作执行或恢复", read: exact("hetu.agent_operations.list") },
];

export const localSections: Section[] = [
  { id: "plugins", title: "插件", intent: "发现专业插件与当前能力，按明确选择安装、启停或整理专业成果", read: exact("hetu.plugins.inspect") },
  { id: "settings", title: "本机设置", intent: "准备偏好、Agent接入与所选题材Skills的固定设置方案", read: exact("hetu.local_settings.get") },
  { id: "models", title: "模型渠道", intent: "检查非敏感模型设置与连接状态，按明确范围配置渠道或恢复模型任务", read: exact("hetu.model_settings.inspect") },
];

export type DetailLink = { label: string; action?: string; input?: RecordValue; task?: RecordValue };
export function detailLinks(item: RecordValue): DetailLink[] {
  const links: DetailLink[] = [];
  const add = (label: string, action: string, input: RecordValue) => links.push({ label, action, input });
  const manifest = item.manifest && typeof item.manifest === "object" ? item.manifest as RecordValue : undefined;
  if (manifest && typeof manifest.id === "string" && typeof item.sha256 === "string" && item.enabled === true) add("查看专业能力", "hetu.plugins.capabilities", { plugin_id: manifest.id, package_sha256: item.sha256 });
  if (item.task_locator) links.push({ label: "审阅任务", task: item.task_locator as RecordValue });
  if (item.task_ref && !item.task_locator) { const ref = item.task_ref as RecordValue; links.push({ label: "审阅任务", task: { scope_ref: ref.scope_ref, task_id: ref.task_id } }); }
  if (typeof item.document_id === "string") add("阅读正文", "hetu.documents.get", { document_id: item.document_id, ...(typeof item.current_revision_id === "string" ? { revision_id: item.current_revision_id } : {}) });
  if (typeof item.resource_id === "string") add("查看资料", "hetu.resources.get", { resource_id: item.resource_id, ...(typeof item.revision === "number" ? { revision: item.revision } : {}) });
  if (typeof item.asset_id === "string") add("查看素材", "hetu.assets.get", { asset_id: item.asset_id, ...(typeof item.revision === "number" ? { revision: item.revision } : {}) });
  if (typeof item.cue_id === "string") add("查看线索", "hetu.cues.get", { cue_id: item.cue_id });
  if (typeof item.episode_id === "string") add("阅读分集", "hetu.drama.episodes.get", { episode_id: item.episode_id });
  if (typeof item.video_episode_id === "string") add("查看分集成果", "hetu.video.media.list", { video_episode_id: item.video_episode_id });
  if (item.media_ref) add("查看固定媒体", "hetu.video.media.get", { media_ref: item.media_ref });
  if (typeof item.proposal_id === "string") add("查看固定方案", "hetu.agent_operations.get", { proposal_id: item.proposal_id });
  if (typeof item.draft_id === "string") add("查看待审稿", "hetu.drafts.get", { draft_id: item.draft_id });
  const draft = item.draft_ref && typeof item.draft_ref === "object" ? item.draft_ref as RecordValue : undefined;
  if (typeof draft?.draft_id === "string") add("阅读参考稿", "hetu.drafts.get", { draft_id: draft.draft_id });
  if (typeof item.report_id === "string") add("查看固定检查", "hetu.reports.get", { report_id: item.report_id });
  if (typeof item.link_id === "string") add("查看固定关联", "hetu.work_links.get", { link_id: item.link_id, ...(typeof item.revision === "number" ? { revision: item.revision } : {}) });
  return links;
}
