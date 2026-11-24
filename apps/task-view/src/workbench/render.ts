import { object, type RecordValue } from "./gateway.ts";
import { detailLinks, type DetailLink } from "./domains.ts";

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function button(text: string, click: () => void | Promise<void>) {
  const node = element("button", text); node.type = "button";
  node.onclick = () => { void click(); }; return node;
}

const labels: Record<string, string> = {
  title: "名称", name: "名称", brief: "目标", synopsis: "简介", author_name: "作者", genre: "题材", status: "状态", state: "状态", content: "内容", body: "正文", description: "说明", summary: "概况", metadata: "资料", novel: "小说", record: "资料", project: "项目", episode: "分集", episodes: "分集", volumes: "卷", chapters: "章节", documents: "正文", tasks: "任务", resources: "资料", assets: "素材", cues: "线索", items: "成果", media: "媒体", feedback: "意见", public_comment: "公开意见", comment: "意见", candidates: "候选", submission: "已提交成果", submissions: "成果批次", request: "任务要求", working_copies: "参考稿", blueprint: "设定集", characters: "人物", locations: "地点", factions: "势力", timeline: "时间线", world: "世界观", rules: "规则", traits: "特征", facts: "事实", notes: "备注", before: "变更前", after: "变更后", changes: "变更", fixed: "固定方案", observations: "核对结果", findings: "发现", reports: "检查报告", reviews: "待审内容", draft: "待审稿", source_rights: "来源与权利", rights: "权利", purpose: "用途", excerpt: "摘要", outline: "大纲", outlines: "大纲", nodes: "节点", children: "内容", preferences: "偏好", appearance: "外观", language: "语言", font_size: "字号", agent_client: "Agent", packages: "已安装插件", plugins: "插件", enabled: "已启用", version: "版本", message: "说明", error: "读取问题", initialized: "已建立", complete: "完整性", missing_items: "缺项", archived: "已归档", source_format: "文本格式", position: "顺序", dirty: "存在修改", branch: "版本线", staged: "待保存", unstaged: "已有修改", untracked: "新增文件", operations: "操作方案", links: "关联", source: "来源", target: "目标", channels: "模型渠道", models: "模型", model: "型号", provider: "渠道", configured: "已配置", available: "可用", connected: "已连接", total: "总数", submission_count: "成果批次", created_at: "创建时间", updated_at: "更新时间", revision: "修订", is_current: "当前依据有效", is_expired: "已过期", label: "名称", reason: "原因", warning: "提示", warnings: "提示", action: "操作", effect: "影响", purpose_title: "用途",
};
Object.assign(labels, { manuscript: "稿件", references: "参考稿", reference_content: "最新提交参考稿", author_state: "作者稿状态",
  text: "正文", plan: "创作计划", scenes: "场次", scene: "场次", episode_number: "集数", scene_number: "场次顺序", action: "行动", dialogue: "对白", speaker: "角色", beat: "节拍", beats: "节拍", target: "对象", response: "响应",
  snapshots: "文稿快照", snapshot: "固定快照", commits: "已保存版本", files: "文稿文件", file_count: "文稿文件数", selection: "固定范围", approval_state: "作者决定状态", timestamp: "记录时间",
  findings: "检查发现", severity: "重要程度", disposition: "处理结果", evidence: "依据", evidence_refs: "固定依据", recommendations: "建议", differences: "差异", matches: "对应内容", mapping: "原著映射", skeleton: "剧本骨架", comparisons: "原著对照", skeletons: "分集与场次",
  image_view: "图片视图", category: "分类", tags: "标签", usages: "使用位置", candidates: "候选成果", current_revision: "当前修订", working: "未提交参考稿", submitted: "已提交参考稿", author: "作者", author_has_content: "作者稿已有内容", word_count: "字数",
  purpose: "用途", duration_ticks: "时长单位数", time_base: "时间基准", range: "意见区间", start_tick: "开始", end_tick: "结束", numerator: "分子", denominator: "分母", stream_index: "轨道", filename: "交付文件名", size_bytes: "字节数", delivery: "交付", manifest: "交付清单", export: "交付内容",
  font_family: "阅读字体", line_spacing: "行距", first_line_indent: "首行缩进", library_list: "创作库列表", suites: "创作方法", installable_clients: "可安装客户端", installations: "连接安装", connection: "连接", capabilities: "能力", methods: "方法", limitations: "使用范围", notes: "备注",
});
const privateField = /^(management_ref|related_management_ref|grant.*|client.*|actor_ref|.*path|.*directory|api_key|token|secret|credential.*|base64|blob|input_schema|output_schema|allowed_actions|recovery|response|result_fields)$/i;
const technical = /(^|_)(id|sha256|ref|refs)$|^(expected|scope_ref|operation|provenance|schema_version|request_sha256|allowed_actions_page|app)$/;

/** 未知专业数据仍按结构阅读，禁止将候选HTML或远程URL解释为可执行界面。 */
export function renderData(value: unknown, open: (link: DetailLink) => void, depth = 0): HTMLElement {
  if (typeof value === "string") return element("pre", value, "reading");
  if (typeof value === "number" || typeof value === "boolean") return element("span", typeof value === "boolean" ? value ? "是" : "否" : String(value));
  if (value === null || value === undefined) return element("span", "未记录", "muted");
  const container = element("div", undefined, Array.isArray(value) ? "record-list" : "record-fields");
  if (depth > 10) { container.append(element("p", "内容层级较深，请让 Agent 按固定对象提供阅读成果。")); return container; }
  if (Array.isArray(value)) {
    if (!value.length) container.append(element("p", "暂无内容", "muted"));
    for (const item of value) {
      const row = element("section", undefined, "record-row");
      row.dataset.mcpContext = "record";
      row.dataset.mcpContextLabel = "固定成果";
      row.tabIndex = 0;
      row.append(renderData(item, open, depth + 1)); container.append(row);
    }
    return container;
  }
  const record = object(value);
  const manifest = object(record.manifest);
  if (manifest.id) {
    const display = object(manifest.display), description = object(manifest.description);
    container.append(element("h3", String(display["zh-CN"] ?? display.en ?? "创作插件")), element("p", String(description["zh-CN"] ?? description.en ?? "")));
  }
  const links = detailLinks(record);
  const tech: RecordValue = {};
  for (const [key, child] of Object.entries(record)) {
    if (privateField.test(key) || key === "next_cursor") continue;
    if (technical.test(key)) { tech[key] = child; continue; }
    const field = element("div", undefined, "record-field");
    const fieldLabel = labels[key];
    if (key === "title" || key === "name") field.append(element("h3", String(child ?? "未命名")));
    else if (child !== null && child !== undefined) {
      if (!fieldLabel) {
        // 未知专业字段保留为渐进详情，不能静默丢弃作者已有成果。
        const detail = element("details", undefined, "technical");
        detail.append(element("summary", key.replaceAll("_", " ")), renderData(child, open, depth + 1));
        container.append(detail); continue;
      }
      field.append(element("h4", fieldLabel), renderData(child, open, depth + 1));
    }
    field.dataset.mcpContext = "record";
    field.dataset.mcpContextLabel = key === "title" || key === "name" ? String(child ?? "固定成果") : (fieldLabel ?? "固定成果");
    field.tabIndex = 0;
    container.append(field);
  }
  if (links.length) {
    const actions = element("div", undefined, "actions");
    for (const link of links) actions.append(button(link.label, () => open(link)));
    container.append(actions);
  }
  if (Object.keys(tech).length) {
    const details = element("details", undefined, "technical");
    details.append(element("summary", "固定引用"), element("pre", JSON.stringify(tech, null, 2))); container.append(details);
  }
  if (!container.childElementCount) container.append(element("p", "此对象没有可展示内容，可让 Agent 核对固定来源。", "muted"));
  return container;
}
