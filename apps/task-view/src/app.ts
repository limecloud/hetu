import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

type TaskRef = { scope_ref: { kind: string; id: string }; task_id: string; request_revision: number; sha256?: string };
type CandidateRef = { task_ref: TaskRef; submission_id: string; candidate_id: string };
type FeedbackRef = { feedback_id: string; sha256: string };
type Candidate = { candidate_id: string; kind: string; title: string; content?: string; width?: number; height?: number; patches?: { quote: string; replacement: string; byte_start: number; byte_end: number }[] };
type TaskData = {
  task_ref?: TaskRef;
  request: TaskRef & { task_kind: string; brief: string; prompt_language: string; input_snapshot: { sources: { title?: string; content?: string; sha256?: string; blueprint?: Record<string, unknown> }[] } };
  observation: { state: string };
  expected: { revision: number; sha256: string };
  submission: { submission_id: string; candidates: Candidate[]; complete: boolean; missing_items: string[]; feedback_refs?: FeedbackRef[] } | null;
  decision: { candidate_refs: CandidateRef[]; comment: string } | null;
  feedback_head?: FeedbackRef | null;
  last_feedback?: { intent: string; public_comment: string } | null;
  feedback_ref?: FeedbackRef;
  allowed_actions?: string[];
  image_previews?: { candidate_id: string; media_type: string; base64: string; width: number; height: number }[];
};
type Envelope = { status: string; data?: TaskData; error?: { code: string; message: string } };
type ToolResult = { structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };

const messages = {
  "zh-CN": {
    title: "比较参考方案", boundary: "选择只记录你的偏好。采纳到正文、选用正式封面和定稿，请回到河图洛书确认。",
    empty: "暂未收到参考方案。你可以回到外部 AI 客户端继续创作，再读取最新结果。",
    refresh: "读取最新结果", discard: "放弃未保存选择并读取最新结果", comment: "补充要求或意见", placeholder: "例如：保留第二个方案的节奏，结尾再收敛一些。",
    save: "保存选择与意见", saving: "正在保存…", saved: "已记录偏好，尚未采纳。外部 Agent 可回读本任务查看你的意见。",
    revise: "按此修改", feedbackSaved: "修改意见已保存，尚未发送给 Agent。", send: "发送给当前 Agent", accepted: "宿主已接收继续请求，等待后续稿。", rejected: "宿主未接收继续请求。可复制下方提示词。", deliveryUnknown: "发送结果尚未确认。请先查看当前会话，不自动重发。", copyPrompt: "继续提示词", copy: "复制继续提示词", copied: "提示词已复制，尚未确认 Agent 接收。", copyManually: "请选择下方提示词复制。", followup: "已收到针对这条意见的新方案，请核对修改。",
    unknown: "保存结果尚未确认。请查询原操作，勿重复提交。", recover: "查询原保存结果", noOperation: "尚未找到原操作。可以沿原键重试保存。", retry: "沿原键重试保存",
    dirty: "有未保存的选择或意见。", changed: "任务收到新结果，当前选择尚未覆盖；请读取最新结果后重新比较。",
    connecting: "正在连接任务…", disconnected: "面板连接已结束。已保存的意见仍保留在原任务中。", waiting: "等待宿主提供任务结果。", unavailable: "此页面需要支持 MCP Apps 的宿主。请在河图洛书查看原任务。",
    error: "任务操作未完成：", source: "查看固定参考资料（只读）", readSource: "读取原文", nextSource: "下一段", sourceIndex: "返回设定目录", moreSourceEntries: "更多设定", characters: "人物", factions: "势力", locations: "地点", timeline: "时间线", world: "世界观", rules: "规则", imageMissing: "此候选没有可显示的缩略图，请回桌面端核对原图。",
    partial: "部分结果", missing: "缺少的结果", select: "选择这个方案", selected: "已记录的意见", closed: "任务已关闭，请回桌面端查看历史。",
    scopeChanged: "此面板绑定原任务，不能切换作品或任务。请重新打开对应任务面板。",
    concept: "故事方向", titleKind: "书名", synopsis: "简介", outline: "大纲", text: "参考稿", image: "封面候选", before: "原文", after: "建议", change: "改动", bible: "设定集", noSources: "这个任务没有附加参考资料。", readonly: "宿主未提供工具交互能力，请回桌面端保存意见。",
  },
  en: {
    title: "Compare references", boundary: "Selections record preferences only. Adopt text, choose an official cover and finalize in the Hetu Luoshu desktop app.",
    empty: "No references received yet. Continue in your external AI client, then load the latest results.",
    refresh: "Load latest results", discard: "Discard unsaved choices and load latest", comment: "Requirements or feedback", placeholder: "For example: keep the pacing of option two and simplify the ending.",
    save: "Save preferences", saving: "Saving…", saved: "Preferences saved; content has not been adopted. Your external agent can read this task for your feedback.",
    revise: "Request changes", feedbackSaved: "Revision feedback saved; it has not been sent to the agent.", send: "Send to current agent", accepted: "The host accepted the continuation request. Awaiting follow-up work.", rejected: "The host did not accept the request. Copy the prompt below.", deliveryUnknown: "Message delivery is unconfirmed. Check this conversation before resending.", copyPrompt: "Continuation prompt", copy: "Copy continuation prompt", copied: "Prompt copied. Agent receipt is unconfirmed.", copyManually: "Select and copy the prompt below.", followup: "A new reference addresses this feedback. Review the changes.",
    unknown: "The save result is unconfirmed. Check the original operation before submitting again.", recover: "Check original save", noOperation: "The original operation was not found. You can retry with the same key.", retry: "Retry original save",
    dirty: "You have unsaved choices or feedback.", changed: "New results are available. Your choices have been preserved; load the latest results before comparing again.",
    connecting: "Connecting to task…", disconnected: "This view has disconnected. Saved preferences remain in the original task.", waiting: "Waiting for the host to supply task results.", unavailable: "This page requires an MCP Apps host. Open the original task in Hetu Luoshu.",
    error: "Task operation did not complete: ", source: "View fixed reference material (read-only)", readSource: "Read source", nextSource: "Next passage", sourceIndex: "Back to story bible index", moreSourceEntries: "More entries", characters: "Characters", factions: "Factions", locations: "Locations", timeline: "Timeline", world: "World", rules: "Rules", imageMissing: "A preview is unavailable. Inspect the original image in the desktop app.",
    partial: "Partial results", missing: "Missing results", select: "Choose this option", selected: "Recorded feedback", closed: "This task is closed. Open its history in the desktop app.",
    scopeChanged: "This view is bound to its original task. Open a new panel to change tasks or books.",
    concept: "Story direction", titleKind: "Book title", synopsis: "Synopsis", outline: "Outline", text: "Reference draft", image: "Cover candidate", before: "Original", after: "Suggestion", change: "Change", bible: "Story bible", noSources: "No additional reference material is attached to this task.", readonly: "The host has not enabled tool interactions. Save feedback in the desktop app.",
  },
};

const app = new App({ name: "Hetu Luoshu task view", version: "0.7.0" }, {});
const root = document.getElementById("app")!;
let locale: keyof typeof messages = "zh-CN";
let data: TaskData | undefined;
type SourceSection = "characters" | "factions" | "locations" | "timeline" | "world" | "rules";
type SourceSelector = { section?: SourceSection; entity_id?: string; cursor?: string };
type SourcePreview = { content?: string; blueprint?: Record<string, unknown>; entity?: Record<string, unknown>; section?: SourceSection; sections?: { section: SourceSection; count: number }[]; entities?: { entity_id: string; title: string }[]; next_cursor?: string | null; next_range?: { byte_start: number; byte_end: number } | null };
const sourcePreviews = new Map<number, SourcePreview>();
let sourcesOpen = false;
let boundRef: TaskRef | undefined;
let connected = false;
let busy = false;
let dirty = false;
let stale = false;
let status = "";
let statusError = false;
let pending: Record<string, unknown> | undefined;
let pendingAction = "hetu.interactions.save_selection";
let feedbackReceipt: { feedback_ref: FeedbackRef; task_ref: TaskRef } | undefined;
let delivery: "not_requested" | "accepted" | "rejected" | "unknown" = "not_requested";
let canRetry = false;
let selected = new Set<string>();
let comment = "";
const t = (key: keyof typeof messages["en"]) => messages[locale][key];
const sameTask = (a: TaskRef, b: TaskRef) => a.task_id === b.task_id && a.request_revision === b.request_revision && a.sha256 === b.sha256 && a.scope_ref.kind === b.scope_ref.kind && a.scope_ref.id === b.scope_ref.id;
const taskRef = (value: TaskData): TaskRef => value.task_ref ?? ({ scope_ref: value.request.scope_ref, task_id: value.request.task_id, request_revision: value.request.request_revision });

function element<K extends keyof HTMLElementTagNameMap>(name: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label: string, handler: () => void | Promise<void>, primary = false) {
  const node = element("button", label, primary ? "primary" : undefined);
  node.type = "button";
  node.disabled = busy;
  node.addEventListener("click", () => { void handler(); });
  return node;
}
function envelope(result: ToolResult): Envelope {
  const value = (result.structuredContent ?? JSON.parse(result.content?.find(item => item.type === "text")?.text ?? "null")) as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || typeof value.status !== "string") throw new Error("Invalid task response");
  return value as Envelope;
}
function showError(error: unknown) {
  status = t("error") + (error instanceof Error ? error.message : String(error));
  statusError = true;
}
function receive(result: ToolResult, replace = false) {
  const value = envelope(result);
  if (value.error) {
    if (["forbidden", "hetu.stale_request", "task_closed"].includes(value.error.code)) {
      data = undefined; sourcePreviews.clear(); selected.clear(); comment = ""; feedbackReceipt = undefined; pending = undefined; stale = true;
    }
    throw new Error(`${value.error.code}: ${value.error.message}`);
  }
  const next = value.data;
  if (!next?.request?.scope_ref || !next.expected || !next.observation || !(next.submission === null || Array.isArray(next.submission?.candidates))) throw new Error("Invalid task projection");
  const ref = taskRef(next);
  if (boundRef && !sameTask(boundRef, ref)) throw new Error(t("scopeChanged"));
  boundRef = ref;
  if (!data && next.last_feedback?.intent === "request_changes" && next.feedback_head) feedbackReceipt = { feedback_ref: next.feedback_head, task_ref: ref };
  if (!replace && data && (dirty || pending)) {
    if (data.expected.sha256 !== next.expected.sha256) { stale = true; status = t("changed"); }
    return;
  }
  if (!data) {
    const hostLocale = app.getHostContext()?.locale;
    locale = hostLocale ? hostLocale.startsWith("en") ? "en" : "zh-CN" : next.request.prompt_language === "en" ? "en" : "zh-CN";
  }
  data = next;
  stale = false;
  dirty = false;
  const currentSubmission = next.submission?.submission_id;
  selected = new Set(next.decision?.candidate_refs.filter(item => item.submission_id === currentSubmission).map(item => item.candidate_id) ?? []);
  comment = next.decision?.comment ?? "";
  document.documentElement.lang = locale;
}
function render() {
  root.replaceChildren();
  root.setAttribute("aria-busy", String(busy || (!connected && !data)));
  const top = element("div", undefined, "top");
  top.append(element("h1", t("title")), button(locale === "en" ? "中文" : "English", () => {
    locale = locale === "en" ? "zh-CN" : "en"; document.documentElement.lang = locale; render();
  }));
  root.append(top, element("p", t("boundary"), "boundary"));
  if (data) {
    root.append(element("p", data.request.brief, "brief"));
    if (data.submission && !data.submission.complete) {
      root.append(element("span", t("partial"), "badge"));
      root.append(element("p", `${t("missing")}: ${data.submission.missing_items.join("; ")}`, "muted"));
    }
    const cards = element("div", undefined, "candidates");
    for (const candidate of data.submission?.candidates ?? []) cards.append(candidateCard(candidate));
    if (!cards.childElementCount) root.append(element("p", t("empty"), "empty")); else root.append(cards);
    const details = element("details", undefined, "detail");
    details.open = sourcesOpen;
    details.addEventListener("toggle", () => { sourcesOpen = details.open; });
    details.append(element("summary", t("source")));
    for (const [index, fixed] of data.request.input_snapshot.sources.entries()) {
      const source = { ...fixed, ...sourcePreviews.get(index) };
      details.append(element("h2", source.title?.trim() || t("bible")));
      if (fixed.content === undefined && fixed.blueprint === undefined && data.allowed_actions?.includes("hetu.task_context.read")) {
        const preview = sourcePreviews.get(index);
        if (!preview || preview.next_range) {
          const load = button(t(preview ? "nextSource" : "readSource"), () => readSource(index));
          load.disabled ||= !connected || !!pending;
          details.append(load);
        }
      }
      if (source.content !== undefined) details.append(element("pre", source.content));
      for (const section of source.sections ?? []) {
        details.append(button(t(section.section), () => readSource(index, { section: section.section })));
      }
      for (const entity of source.entities ?? []) {
        details.append(button(entity.title, () => readSource(index, { section: source.section, entity_id: entity.entity_id })));
      }
      if (source.next_cursor) details.append(button(t("moreSourceEntries"), () => readSource(index, { section: source.section, cursor: source.next_cursor! })));
      if (source.section) details.append(button(t("sourceIndex"), () => readSource(index, {})));
      if (source.blueprint || source.entity) {
        for (const group of source.entity ? [[source.entity]] : Object.values(source.blueprint!).filter(Array.isArray)) {
          for (const entry of group) {
            if (entry && typeof entry === "object") {
              const fields = entry as Record<string, unknown>;
              if (typeof (fields.name ?? fields.title) === "string") details.append(element("h3", (fields.name ?? fields.title) as string));
              for (const key of ["description", "summary", "identity", "notes", "content", "rationale"]) {
                if (typeof fields[key] === "string") details.append(element("p", fields[key]));
              }
            }
          }
        }
      }
    }
    if (!data.request.input_snapshot.sources.length) details.append(element("p", t("noSources"), "muted"));
    root.append(details);
    const label = element("label", t("comment"), "comment-label"); label.htmlFor = "comment";
    const field = element("textarea"); field.id = "comment"; field.maxLength = 4000; field.placeholder = t("placeholder"); field.value = comment;
    field.disabled = !connected || busy || !!pending || data.observation.state === "closed";
    const count = element("p", `${comment.length} / 4000`, "meta");
    field.addEventListener("input", () => {
      comment = field.value; count.textContent = `${comment.length} / 4000`; dirty = true; updateStatus(t("dirty"), false);
      const revise = document.getElementById("request-changes") as HTMLButtonElement | null;
      if (revise) revise.disabled = !connected || busy || !!pending || stale || !comment.trim() || data?.observation.state === "closed";
    });
    root.append(label, field, count);
    const actions = element("div", undefined, "actions");
    const saveButton = button(busy ? t("saving") : pending ? canRetry ? t("retry") : t("recover") : t("save"), pending ? canRetry ? savePending : recover : save, true);
    saveButton.disabled ||= !connected || !app.getHostCapabilities()?.serverTools || data.observation.state === "closed" || (stale && !pending);
    const refreshButton = button(dirty ? t("discard") : t("refresh"), refresh);
    refreshButton.disabled ||= !connected || !!pending;
    actions.append(saveButton, refreshButton); root.append(actions);
    if (data.allowed_actions?.includes("hetu.task_feedback.save") && data.submission?.candidates.length) {
      const revise = button(t("revise"), requestChanges);
      revise.id = "request-changes";
      revise.disabled ||= !connected || !!pending || stale || !comment.trim() || data.observation.state === "closed";
      actions.append(revise);
    }
    if (feedbackReceipt && data.observation.state !== "closed") {
      const continuation = element("div", undefined, "detail");
      const prompt = element("textarea"); prompt.readOnly = true; prompt.value = continuationPrompt(); prompt.setAttribute("aria-label", t("copyPrompt"));
      continuation.append(prompt);
      const copy = button(t("copy"), async () => {
        if (!await validateContinuation()) return;
        try { await navigator.clipboard.writeText(continuationPrompt()); updateStatus(t("copied"), false); }
        catch { prompt.focus(); prompt.select(); updateStatus(t("copyManually"), false); }
      });
      copy.disabled ||= !connected || !!pending || stale;
      continuation.append(copy);
      if (app.getHostCapabilities()?.message?.text) {
        const send = button(t("send"), sendContinuation);
        send.disabled ||= !connected || !!pending || stale || delivery !== "not_requested";
        continuation.append(send);
      }
      const followup = data.submission?.feedback_refs?.some(ref => ref.feedback_id === feedbackReceipt!.feedback_ref.feedback_id && ref.sha256 === feedbackReceipt!.feedback_ref.sha256);
      continuation.append(element("p", t(followup ? "followup" : delivery === "accepted" ? "accepted" : delivery === "rejected" ? "rejected" : delivery === "unknown" ? "deliveryUnknown" : "feedbackSaved"), "meta"));
      root.append(continuation);
    }
    if (!app.getHostCapabilities()?.serverTools) root.append(element("p", t("readonly"), "muted"));
    if (data.observation.state === "closed") status = t("closed");
  } else root.append(element("p", connected ? t("waiting") : t("connecting"), "empty"));
  const note = element("p", status, "status"); note.id = "status"; note.setAttribute("role", "status"); note.dataset.error = String(statusError); root.append(note);
}
async function readSource(index: number, selector?: SourceSelector) {
  if (!boundRef || !connected || busy || pending) return;
  const ref = boundRef;
  const source = data?.request.input_snapshot.sources[index];
  if (!source?.sha256) return;
  busy = true; render();
  try {
    const input = { task_ref: ref, context_ref: { context_id: `context_${index}`, sha256: source.sha256 }, max_bytes: 16 * 1024,
      ...(selector ?? (sourcePreviews.get(index)?.next_range ? { range: sourcePreviews.get(index)!.next_range } : {})) };
    const result = await app.callServerTool({ name: "hetu_read_task_context", arguments: input });
    if (!connected || !boundRef || !sameTask(ref, boundRef) || !data) return;
    const value = envelope(result);
    if (value.error) { receive(result); return; }
    sourcePreviews.set(index, value.data as unknown as SourcePreview);
  } catch (error) { showError(error); }
  finally { busy = false; render(); }
}
function updateStatus(value: string, error: boolean) {
  status = value; statusError = error;
  const note = document.getElementById("status");
  if (note) { note.textContent = value; note.dataset.error = String(error); }
}
function candidateCard(candidate: Candidate) {
  const card = element("section", undefined, "candidate");
  const heading = element("div", undefined, "candidate-heading");
  const input = element("input"); input.type = "checkbox"; input.id = candidate.candidate_id; input.checked = selected.has(candidate.candidate_id); input.disabled = !connected || busy || !!pending || data?.observation.state === "closed";
  input.addEventListener("change", () => { if (input.checked) selected.add(candidate.candidate_id); else selected.delete(candidate.candidate_id); dirty = true; updateStatus(t("dirty"), false); });
  const label = element("label"); label.htmlFor = input.id; label.append(element("h2", candidate.title));
  const kind = candidate.kind === "title" ? "titleKind" : candidate.kind as "concept" | "synopsis" | "outline" | "text" | "image";
  label.append(element("span", messages[locale][kind] ?? candidate.kind, "badge"));
  heading.append(input, label); card.append(heading);
  if (candidate.kind === "image") {
    const preview = data?.image_previews?.find(item => item.candidate_id === candidate.candidate_id);
    if (preview?.media_type === "image/jpeg" && /^[A-Za-z0-9+/]*={0,2}$/.test(preview.base64) && preview.base64.length <= 350000) {
      const image = element("img"); image.className = "cover"; image.alt = candidate.title; image.src = `data:image/jpeg;base64,${preview.base64}`; image.width = preview.width; image.height = preview.height; card.append(image);
    } else card.append(element("p", t("imageMissing"), "unavailable"));
    card.append(element("p", `${candidate.width} × ${candidate.height}`, "meta"));
  } else if (candidate.patches?.length) {
    for (const [index, patch] of candidate.patches.entries()) {
      const diff = element("div", undefined, "patch");
      diff.append(element("span", `${t("change")} ${index + 1}`, "meta"), element("del", `${t("before")}: ${patch.quote}`), element("ins", `${t("after")}: ${patch.replacement}`)); card.append(diff);
    }
  } else card.append(element("pre", candidate.content ?? "", "content"));
  return card;
}
async function refresh() {
  if (!boundRef || pending) return;
  busy = true; render();
  try { receive(await app.callServerTool({ name: "hetu_open_task_view", arguments: { task_ref: boundRef } }), true); status = ""; statusError = false; }
  catch (error) { showError(error); }
  finally { busy = false; render(); }
}
async function save() {
  if (!data || !boundRef || stale || pending) return;
  pendingAction = "hetu.interactions.save_selection";
  pending = {
    task_ref: boundRef, expected: data.expected,
    candidate_refs: [...selected].map(candidate_id => ({ task_ref: boundRef, submission_id: data!.submission!.submission_id, candidate_id })),
    comment, operation_key: `app-selection-${crypto.randomUUID()}`,
  };
  await savePending();
}
async function requestChanges() {
  if (!data?.submission || !boundRef || stale || pending || !comment.trim()) return;
  const targets = data.submission.candidates.map(item => ({ kind: "candidate", candidate_ref: { task_ref: boundRef, submission_id: data!.submission!.submission_id, candidate_id: item.candidate_id } }));
  pendingAction = "hetu.task_feedback.save";
  pending = { task_ref: boundRef, target_refs: targets, expected_feedback_head: data.feedback_head ?? null,
    intent: "request_changes", public_comment: comment, selected_refs: targets.filter(item => selected.has(item.candidate_ref.candidate_id)), operation_key: `app-feedback-${crypto.randomUUID()}` };
  await savePending();
}
function continuationPrompt() {
  if (!feedbackReceipt) return "";
  const { scope_ref, task_id } = feedbackReceipt.task_ref;
  const locator = JSON.stringify({ scope_ref, task_id });
  const feedback = JSON.stringify(feedbackReceipt.feedback_ref);
  return locale === "en"
    ? `Continue the same Hetu Luoshu task. Open task_locator ${locator} using the available task connection. Read feedback ${feedback} and its fixed targets with hetu_list_task_feedback. Continue the working copy and include handled feedback_refs when saving and submitting. Preserve the author's requested sections. Do not create a duplicate task, overwrite author text, adopt or finalize.`
    : `继续河图洛书原任务。通过当前可用任务连接打开 task_locator：${locator}。用 hetu_list_task_feedback 读取公开意见 ${feedback} 及其固定成果，沿原参考稿返工。保留作者要求的部分，保存与提交时引用实际处理的 feedback_refs。不要重建任务、覆盖作者正文、采纳或定稿。`;
}
async function validateContinuation() {
  if (!feedbackReceipt || !boundRef || !connected || pending || stale) return false;
  try {
    const result = await app.callServerTool({ name: "hetu_open_task_view", arguments: { task_ref: boundRef } });
    const value = envelope(result);
    if (value.error) { receive(result); return false; }
    if (!value.data || !sameTask(boundRef, taskRef(value.data)) || value.data.observation.state === "closed") throw new Error(t("closed"));
    return connected && !!feedbackReceipt && !stale;
  } catch (error) { feedbackReceipt = undefined; showError(error); render(); return false; }
}
async function sendContinuation() {
  if (busy || delivery !== "not_requested" || !app.getHostCapabilities()?.message?.text) return;
  busy = true; render();
  if (!await validateContinuation()) { busy = false; render(); return; }
  delivery = "unknown"; render();
  try {
    const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: continuationPrompt() }] });
    delivery = result.isError ? "rejected" : "accepted";
  } catch { delivery = "unknown"; }
  finally { busy = false; render(); }
}
async function savePending() {
  if (!pending) return;
  busy = true; canRetry = false; render();
  try {
    const result = envelope(await app.callServerTool({ name: pendingAction === "hetu.task_feedback.save" ? "hetu_save_task_feedback" : "hetu_save_task_selection", arguments: pending }));
    if (result.status === "succeeded") { captureFeedback(result); pending = undefined; dirty = false; await refreshAfterSave(); }
    else if (result.status === "blocked" && result.error?.code !== "workspace_busy") {
      pending = undefined; showError(new Error(`${result.error?.code}: ${result.error?.message}`));
    } else { status = t("unknown"); statusError = true; }
  } catch { status = t("unknown"); statusError = true; }
  finally { busy = false; render(); }
}
async function refreshAfterSave() {
  try { receive(await app.callServerTool({ name: "hetu_open_task_view", arguments: { task_ref: boundRef } }), true); }
  catch { stale = true; }
  status = t(pendingAction === "hetu.task_feedback.save" ? "feedbackSaved" : "saved"); statusError = false;
}
function captureFeedback(result: Envelope) {
  if (pendingAction === "hetu.task_feedback.save" && result.data?.feedback_ref && boundRef) {
    feedbackReceipt = { feedback_ref: result.data.feedback_ref, task_ref: boundRef }; delivery = "not_requested";
  }
}
async function recover() {
  if (!pending || !boundRef) return;
  busy = true; render();
  try {
    const uri = `hetu://task/${boundRef.scope_ref.kind}/${boundRef.scope_ref.id}/${boundRef.task_id}/operations/by-key?action=${pendingAction}&key=${encodeURIComponent(String(pending.operation_key))}`;
    let result;
    if (boundRef.sha256) {
      result = envelope(await app.callServerTool({ name: "hetu_read_task_operation", arguments: { task_ref: boundRef, action: pendingAction, key: pending.operation_key } }));
    } else {
      const resource = await app.readServerResource({ uri });
      const text = resource.contents.find(item => "text" in item);
      result = JSON.parse(text && "text" in text ? text.text : "null");
    }
    if (result?.data?.original_result?.status === "succeeded") { captureFeedback(result.data.original_result); pending = undefined; dirty = false; await refreshAfterSave(); }
    else if (result?.error?.code === "not_found") { canRetry = true; status = t("noOperation"); statusError = false; }
    else { status = t("unknown"); statusError = true; }
  } catch { status = t("unknown"); statusError = true; }
  finally { busy = false; render(); }
}

app.ontoolinput = ({ arguments: input }) => {
  const ref = input?.task_ref as TaskRef | undefined;
  if (!ref?.scope_ref || !ref.task_id) return;
  if (boundRef && !sameTask(boundRef, ref)) { showError(new Error(t("scopeChanged"))); render(); return; }
  boundRef = ref;
};
app.ontoolresult = result => { try { receive(result); } catch (error) { showError(error); } render(); };
app.onhostcontextchanged = context => {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  if (context.locale) { locale = context.locale.startsWith("en") ? "en" : "zh-CN"; document.documentElement.lang = locale; render(); }
};
app.ontoolcancelled = () => { status = t("unknown"); statusError = true; render(); };
app.onteardown = async () => { connected = false; busy = false; data = undefined; sourcePreviews.clear(); feedbackReceipt = undefined; selected.clear(); comment = ""; status = t("disconnected"); statusError = false; render(); return {}; };
render();
if (window.parent === window) { status = t("unavailable"); statusError = true; render(); }
else {
  void app.connect().then(() => {
    connected = true;
    const theme = app.getHostContext()?.theme;
    if (theme) document.documentElement.dataset.theme = theme;
    render();
  }).catch(error => { showError(error); render(); });
}
