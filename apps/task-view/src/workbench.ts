import { createAppHost } from "./host/bridge.ts";
import { mountTaskReview } from "./task-review.ts";
import { WorkbenchGateway, result, object, type RecordValue, type WorkRef } from "./workbench/gateway.ts";
import { sections, localSections, type Section, type DetailLink } from "./workbench/domains.ts";
import { element, button, renderData } from "./workbench/render.ts";
import { readMedia } from "./workbench/media.ts";

const host = createAppHost("Hetu Luoshu workbench");
const gateway = new WorkbenchGateway(host);
const root = document.getElementById("app")!;
let connected = false, disposed = false, epoch = 0, busy = false;
let route: Section | undefined, work: WorkRef | undefined, works: RecordValue[] = [];
type Reading = { action: string; input: RecordValue; data: RecordValue; view?: RecordValue };
let current: Reading | undefined;
let history: Reading[] = [];
let taskView: ReturnType<typeof mountTaskReview> | undefined;
let mediaUrl: string | undefined;
let error = "", notice = "", initialBinding: string | undefined;
let content = element("section"), status = element("p");
let request: { intent: string; references: RecordValue; text: string; delivery: "ready" | "pending" | "accepted" | "drafted" | "unknown" | "rejected" } | undefined;

function live(ticket: number) { return !disposed && ticket === epoch; }
function fail(value: unknown) { error = value instanceof Error ? value.message : String(value); }
function canLeave() {
  if (taskView && !taskView.canLeave()) { notice = "请先保存当前选择或意见，并查询未确认操作，再切换页面。"; updateStatus(); return false; }
  if (request?.delivery === "pending" || request?.delivery === "unknown") { notice = "消息结果尚未确认，请先核对当前会话。"; updateStatus(); return false; }
  if (request?.delivery === "ready" && request.text.trim()) { notice = "当前目标尚未交接，请先发送、放入草稿或明确放弃。"; updateStatus(); return false; }
  return true;
}
function releaseMedia() { if (mediaUrl) URL.revokeObjectURL(mediaUrl); mediaUrl = undefined; }
function leave() { releaseMedia(); taskView?.dispose(); taskView = undefined; current = undefined; history = []; request = undefined; error = ""; notice = ""; bindEvents(); }
function updateStatus() { status.textContent = error || notice; status.setAttribute("role", error ? "alert" : "status"); }

function render() {
  root.replaceChildren(); root.setAttribute("aria-busy", String(busy));
  const header = element("header", undefined, "workbench-header");
  header.append(element("h1", "河图洛书"));
  if (work) header.append(element("span", works.find(item => JSON.stringify(item.work_ref) === JSON.stringify(work))?.title as string ?? "当前作品"));
  root.append(header);
  const layout = element("div", undefined, "workbench-layout");
  const nav = element("nav"); nav.setAttribute("aria-label", "创作工作台");
  nav.append(button("创作库", () => showHome()));
  if (gateway.management) for (const section of sections) {
    const item = button(section.title, () => showSection(section)); item.disabled = busy || !work;
    if (route?.id === section.id) item.setAttribute("aria-current", "page"); nav.append(item);
  }
  for (const section of localSections) { const item = button(section.title, () => showSection(section)); item.disabled = busy; nav.append(item); }
  content = element("section", undefined, "workbench-content");
  layout.append(nav, content); root.append(layout);
  status = element("p", undefined, "status"); root.append(status); updateStatus();
}
function showHome() {
  if (!canLeave()) return;
  epoch++; leave(); route = undefined; render();
  content.append(element("h2", "创作库"));
  if (!connected) { content.append(element("p", "正在连接河图…", "empty")); return; }
  if (!works.length) {
    content.append(element("p", "尚未打开获权作品。请在当前对话说明要创作或继续的作品，让 Agent 打开对应任务或作品。", "empty"));
    content.append(button("从一个想法开始", () => prepare("从当前想法筹备小说、剧本或视频，先讨论方向并保留作者选择权", {})));
  }
  for (const item of works) {
    const ref = object(item.work_ref) as WorkRef;
    const row = element("section", undefined, "work-row");
    row.append(element("h3", String(item.title ?? "未命名作品")), element("span", ({ novel: "小说", drama: "剧本", video: "视频" })[ref.kind] ?? "作品"));
    row.append(button("打开作品", async () => { work = ref; gateway.work = ref; await showSection(sections[0]); })); content.append(row);
  }
  if (gateway.management) content.append(button("刷新获权作品", async () => {
    if (!canLeave()) return;
    await readWorks(); showHome();
  }));
}
async function readWorks() {
  const data = await gateway.read("hetu.works.list", { limit: 20 });
  works = Array.isArray(data.works) ? data.works.map(object) : [];
}
function pageActions() {
  const actions = element("div", undefined, "actions");
  if (route) actions.append(button("让 AI 处理", () => prepare(route!.intent, references())));
  if (current) {
    const source = current;
    actions.append(button("刷新", () => load(source.action, source.input, source.view, false)));
  }
  if (history.length) actions.append(button("返回上一项", async () => {
    const previous = history.pop()!; await load(previous.action, previous.input, previous.view, false);
  }));
  return actions;
}
function references(): RecordValue { return current ? { action: current.action, input: current.input, ...fixedReferences(current.data) } : {}; }
function fixedReferences(data: RecordValue) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => /(^sha256$|revision$|_ref$)/.test(key) && !/management|grant/.test(key)));
}
async function showSection(section: Section) {
  if (!canLeave()) return;
  epoch++; leave(); route = section; render();
  const read = section.read(work);
  if (!read) {
    content.append(element("h2", section.title), element("p", "由 Agent 读取已有依据并准备方案。", "empty"), pageActions()); return;
  }
  await load(read.action, read.input ?? {});
}
async function load(action: string, input: RecordValue = {}, view?: RecordValue, navigate = true) {
  if (busy || !connected || disposed) return;
  if (navigate && current) history.push(current);
  const ticket = ++epoch; busy = true; error = ""; notice = "";
  releaseMedia();
  render(); content.append(element("p", "正在读取…", "empty"));
  try {
    const data = await gateway.read(action, input, view);
    if (!live(ticket)) return;
    current = { action, input, data, view };
  } catch (value) { if (live(ticket)) { current = undefined; fail(value); } }
  finally { if (live(ticket)) { busy = false; render(); showCurrent(); } }
}
function showCurrent() {
  content.append(element("h2", route?.title ?? "固定成果"), pageActions());
  if (!current) { content.append(element("p", error ? "读取未完成，可刷新或让 Agent 检查当前授权。" : "暂无成果", "empty")); return; }
  const source = current;
  content.append(renderData(source.data, link => { void openDetail(link); }));
  if (source.action === "hetu.plugins.capabilities" && typeof source.data.capabilities_sha256 === "string") {
    const declared = [...(Array.isArray(source.data.actions) ? source.data.actions : []), ...(Array.isArray(source.data.data_actions) ? source.data.data_actions : [])].map(object);
    for (const capability of declared) {
      const schema = object(capability.input_schema), required = Array.isArray(schema.required) ? schema.required : [];
      if (capability.effect !== "read" || required.length || typeof (capability.id ?? capability.name) !== "string") continue;
      content.append(button(String(capability.title ?? capability.purpose ?? "读取专业成果"), () => load("hetu.plugins.invoke", {
        plugin_id: source.data.plugin_id, package_sha256: source.data.package_sha256 ?? source.input.package_sha256,
        capabilities_sha256: source.data.capabilities_sha256, action: capability.id ?? capability.name, arguments: {},
      }, {})));
    }
  }
  const asset = object(source.data.asset), media = object(source.data.media);
  const assetRef = object(media.asset_ref ?? (asset.asset_id && source.data.sha256 ? { asset_id: asset.asset_id, revision: asset.revision, sha256: source.data.sha256 } : undefined));
  if (asset.blob && assetRef.asset_id) {
    const preview = element("div", undefined, "media-preview");
    preview.append(button("预览媒体", async () => {
      const ticket = epoch; error = ""; preview.replaceChildren(element("p", "正在核验固定媒体…"));
      try {
        const value = await readMedia(gateway, asset, assetRef, () => live(ticket));
        if (!live(ticket)) { URL.revokeObjectURL(value.url); return; }
        releaseMedia(); mediaUrl = value.url;
        if (value.mime.startsWith("image/")) { const image = element("img"); image.alt = String(asset.title ?? media.title ?? "固定图片"); image.src = value.url; image.className = "cover"; preview.replaceChildren(image); }
        else { const player = element(value.mime.startsWith("video/") ? "video" : "audio"); player.src = value.url; player.controls = true; player.preload = "metadata"; preview.replaceChildren(player); }
      } catch (value) { if (live(ticket)) { fail(value); preview.replaceChildren(); updateStatus(); } }
    })); content.append(preview);
  }
  if (typeof source.data.next_cursor === "string") content.append(button("下一页", () => load(source.action, { ...source.input, cursor: source.data.next_cursor })));
  if (source.data.response) {
    const response = object(source.data.response), recovery = object(response.read), patch = object(object(response.read).input_patch);
    const readInput = object(recovery.input);
    const view = object(readInput.view ?? patch.view);
    const fields = Array.isArray(source.data.result_fields) ? source.data.result_fields.map(object) : [];
    content.append(element("p", "当前为摘要，请按需读取固定内容。", "muted"));
    for (const field of fields) if (typeof field.result_path === "string") content.append(button(`读取${fieldTitle(String(field.name))}`, () => load(source.action, source.input, { ...view, result_path: field.result_path, max_bytes: 12000 })));
  }
  const projection = object(source.data.view), page = object(projection.page);
  if (projection.value !== undefined) content.append(renderData(projection.value, link => { void openDetail(link); }));
  if (projection.items !== undefined) content.append(renderData(projection.items, link => { void openDetail(link); }));
  for (const field of Array.isArray(projection.fields) ? projection.fields.map(object) : []) content.append(button(`读取${fieldTitle(String(field.name))}`, () => load(source.action, source.input, { result_path: field.result_path, expected_result_sha256: projection.source_result_sha256, max_bytes: 12000 })));
  if (typeof projection.next_path === "string") content.append(button("展开固定内容", () => load(source.action, source.input, { result_path: projection.next_path, expected_result_sha256: projection.source_result_sha256, max_bytes: 12000 })));
  if (projection.page) content.append(renderData(page.text ?? page.items ?? page, link => { void openDetail(link); }));
  if (typeof projection.next_offset === "number") content.append(button("继续读取固定内容", () => load(source.action, source.input, { result_path: projection.result_path, expected_result_sha256: projection.source_result_sha256, offset: projection.next_offset, max_bytes: 12000 })));
  if (route?.id === "versions") {
    const links = element("div", undefined, "actions");
    links.append(button("查看历史", () => load("hetu.git.log", { limit: 20 })), button("查看快照", () => load("hetu.git.list_snapshots", { limit: 20 }))); content.append(links);
  }
}
function fieldTitle(key: string) { return ({ content: "正文", novel: "卷章", project: "项目", blueprint: "设定", actions: "能力", tasks: "任务", documents: "正文目录", resources: "资料", works: "作品" } as Record<string, string>)[key] ?? "内容"; }
async function openDetail(link: DetailLink) {
  if (!canLeave()) return;
  if (link.task) {
    const ticket = ++epoch; busy = true;
    try {
      const response = await gateway.openTask(link.task);
      if (!live(ticket)) return;
      busy = false; showTask(response);
    } catch (value) { if (live(ticket)) { busy = false; fail(value); updateStatus(); } }
  } else if (link.action) await load(link.action, link.input);
}
function showTask(response: Parameters<ReturnType<typeof mountTaskReview>["receive"]>[0]) {
  if (!canLeave()) return;
  leave(); render(); content.append(element("h2", "任务与参考稿"));
  const pane = element("div"); content.append(pane);
  taskView = mountTaskReview(host, pane); taskView.receive(response); if (connected) taskView.ready();
  host.onteardown = teardown;
}

function prepare(intent: string, references_: RecordValue) {
  request = { intent, references: references_, text: "", delivery: "ready" }; renderRequest();
}
function renderRequest() {
  if (!request) return;
  const value = request;
  root.querySelector(".agent-request")?.remove();
  const panel = element("section", undefined, "agent-request"); panel.setAttribute("aria-label", "让 AI 处理");
  panel.append(element("h2", "让 AI 处理"));
  const field = element("textarea"); field.setAttribute("aria-label", "创作目标"); field.placeholder = value.intent; field.value = value.text; field.maxLength = 4000;
  field.disabled = value.delivery !== "ready"; field.oninput = () => { value.text = field.value; };
  panel.append(field);
  const prompt = () => gateway.handoff(value.text.trim() || value.intent, value.references);
  const actions = element("div", undefined, "actions");
  const copy = button("复制请求", async () => {
    const preview = element("textarea"); preview.readOnly = true; preview.value = prompt(); preview.setAttribute("aria-label", "继续请求");
    try { await navigator.clipboard.writeText(preview.value); notice = "请求已复制，尚未发送。"; }
    catch { panel.append(preview); preview.focus(); preview.select(); notice = "请选择请求内容复制。"; }
    updateStatus();
  }); actions.append(copy);
  const send = async (target: "active" | "new", submit: boolean) => {
    if (value.delivery !== "ready" || !connected) return;
    value.delivery = "pending"; renderRequest();
    try {
      // 先回读精确作品；发送过程与作品读取不能假装原子完成。
      if (work) await gateway.read("hetu.works.get", { work_ref: work });
      if (disposed || request !== value) return;
      const response = await host.sendText(prompt(), target, submit);
      if (disposed || request !== value) return;
      value.delivery = response.isError ? "rejected" : submit ? "accepted" : "drafted";
    } catch { if (!disposed && request === value) value.delivery = "unknown"; }
    finally { if (!disposed && request === value) renderRequest(); }
  };
  if (host.features().messages) actions.append(button("发送给当前 Agent", () => send("active", true)));
  if (host.features().drafts) actions.append(button("放入当前草稿", () => send("active", false)), button("在新对话中准备", () => send("new", false)));
  for (const node of actions.querySelectorAll("button")) if (node !== copy) node.disabled = value.delivery !== "ready";
  panel.append(actions);
  if (value.delivery === "ready") panel.append(button("放弃未发送请求", () => { request = undefined; panel.remove(); }));
  const states = { ready: "先核对目标，再交给 Agent。", pending: "正在核对并交接…", accepted: "宿主已受理，等待实际成果。", drafted: "请求已放入草稿，尚未发送。", rejected: "宿主未接收请求，可复制后继续。", unknown: "结果尚未确认，请先查看当前会话，不自动重发。" };
  panel.append(element("p", states[value.delivery], "muted")); root.append(panel);
}

async function receive(response: Parameters<ReturnType<typeof mountTaskReview>["receive"]>[0]) {
  try {
    const data = result(response).data ?? {}, app = object(data.app);
    if (!canLeave()) return;
    if (app.route === "task") { showTask(response); return; }
    if (app.route === "works") {
      const reference = object(app.management_ref), binding = JSON.stringify(reference);
      if (initialBinding && binding !== initialBinding) throw new Error("请另开面板查看其他作品，当前未保存内容保持原位。");
      initialBinding = binding; gateway.management = reference;
      works = Array.isArray(data.works) ? data.works.map(object) : [];
    }
    showHome();
  } catch (value) { fail(value); updateStatus(); }
}
async function deepLink(context: Parameters<typeof host.taskLink>[0]) {
  const locator = host.taskLink(context);
  if (!locator || !canLeave()) return;
  await openDetail({ label: "审阅任务", task: locator });
}
async function teardown() {
  disposed = true; epoch++; connected = false; taskView?.dispose(); taskView = undefined;
  releaseMedia();
  gateway.management = undefined; gateway.work = undefined; works = []; work = undefined; current = undefined; history = []; request = undefined;
  root.replaceChildren(element("p", "面板连接已结束。已保存成果保留在原作品。", "empty")); return {};
}
function bindEvents() {
  host.ontoolresult = response => { void receive(response); };
  host.onhostcontextchanged = context => {
    if (context.theme) document.documentElement.dataset.theme = context.theme;
    void deepLink(context);
  };
  host.onteardown = teardown;
}
bindEvents(); render();
if (window.parent === window) { error = "请在支持 MCP Apps 的客户端打开河图。"; updateStatus(); }
else void host.connect().then(async () => {
  if (disposed) return;
  connected = true;
  const context = host.getHostContext();
  if (context?.theme) document.documentElement.dataset.theme = context.theme;
  if (taskView) taskView.ready(); else if (!current) showHome();
  await deepLink(context);
}).catch(value => { fail(value); updateStatus(); });
