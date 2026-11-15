import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

type RecordValue = Record<string, unknown>;
type ToolResult = { structuredContent?: unknown; content?: { type: string; text?: string }[] };
const app = new App({ name: "Hetu Luoshu operation review", version: "0.7.0" }, {});
const root = document.getElementById("app")!;
let locale = "zh-CN";
let data: RecordValue | undefined;
let managementRef: unknown;
let reference: { kind: "work" | "local"; id: string } | undefined;
let busy = false;
let connected = false;
let error = "";
const words = {
  "zh-CN": { title: "查看操作方案", boundary: "此处只读。请在河图洛书审阅并批准，随后让 Agent 执行原方案。", waiting: "等待方案结果", refresh: "刷新状态", details: "完整方案", before: "变更前", after: "变更后", unavailable: "请在支持 MCP Apps 的客户端查看，或回到河图洛书。", denied: "读取未完成，请回读原操作。", scope: "此面板绑定原方案，请另开面板查看其他方案。", expired: "方案已过期", stale: "依据已有变化", pending: "待审阅", approved: "已批准，待 Agent 执行", rejected: "已驳回", executing: "执行中，沿原方案恢复", executed: "已执行" },
  en: { title: "Inspect operation", boundary: "Read-only. Review and approve in Hetu Luoshu, then ask the agent to execute the original plan.", waiting: "Waiting for an operation", refresh: "Refresh status", details: "Full operation", before: "Before", after: "After", unavailable: "Use an MCP Apps client or open Hetu Luoshu.", denied: "Read failed. Recover the original operation.", scope: "This panel is bound to its original operation. Open another panel for a different plan.", expired: "Operation expired", stale: "The underlying work has changed", pending: "Awaiting review", approved: "Approved, awaiting agent execution", rejected: "Rejected", executing: "Executing; recover this operation", executed: "Executed" },
};
type Key = keyof typeof words.en;
const t = (key: Key) => words[locale === "en" ? "en" : "zh-CN"][key];
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("denied"));
  return value as RecordValue;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string) {
  const element = document.createElement(tag); element.textContent = text; return element;
}
function pretty(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""; }
function receive(result: ToolResult) {
  const envelope = object(result.structuredContent ?? JSON.parse(result.content?.find(c => c.type === "text")?.text ?? "null"));
  if (envelope.error) { data = undefined; throw new Error(t("denied")); }
  const next = object(envelope.data);
  const kind = typeof next.proposal_id === "string" ? "work" : "local";
  const id = kind === "work" ? next.proposal_id : next.operation_id;
  if (typeof id !== "string" || !["pending", "approved", "rejected", "executing", "executed"].includes(String(next.state))) throw new Error(t("denied"));
  if (reference && (reference.kind !== kind || reference.id !== id)) throw new Error(t("scope"));
  reference = { kind, id }; data = next; error = "";
}
function render() {
  root.replaceChildren();
  root.setAttribute("aria-busy", String(busy));
  const top = node("div", ""); top.className = "top";
  const language = node("button", locale === "en" ? "中文" : "English");
  language.type = "button"; language.onclick = () => { locale = locale === "en" ? "zh-CN" : "en"; render(); };
  top.append(node("h1", t("title")), language); root.append(top, node("p", t("boundary")));
  if (error) { const message = node("p", error); message.setAttribute("role", "alert"); root.append(message); }
  if (data) {
    const fixed = data.fixed && typeof data.fixed === "object" ? data.fixed as RecordValue : data;
    root.append(node("h2", String(fixed.summary ?? "")));
    root.append(node("p", t(String(data.state) as Key)));
    if (data.is_expired === true) root.append(node("p", t("expired")));
    if (data.is_current === false && data.state !== "executed") root.append(node("p", t("stale")));
    for (const item of Array.isArray(data.changes) ? data.changes : []) {
      const change = object(item); const section = node("section", "");
      const columns = node("div", ""); columns.className = "comparison";
      for (const [field, label] of [["before", "before"], ["after", "after"]] as const) {
        const column = node("div", ""); column.append(node("h3", t(label)), node("pre", pretty(change[field]))); columns.append(column);
      }
      section.append(columns); root.append(section);
    }
    const details = node("details", "");
    details.append(node("summary", t("details")), node("pre", pretty(fixed)));
    root.append(details);
  } else if (!error) root.append(node("p", connected ? t("waiting") : t("unavailable")));
  if (reference && connected) {
    const refresh = node("button", t("refresh")); refresh.type = "button"; refresh.disabled = busy;
    refresh.onclick = () => { void load(); }; root.append(refresh);
  }
  document.documentElement.lang = locale;
}
async function load() {
  if (!reference || busy) return;
  busy = true; render();
  try {
    if (reference.kind === "work" && !managementRef) throw new Error(t("denied"));
    const result = await app.callServerTool(reference.kind === "work"
      ? { name: "hetu_get_management_operation", arguments: { management_ref: managementRef, proposal_id: reference.id } }
      : { name: "hetu_local_settings_get_operation", arguments: { operation_id: reference.id } });
    receive(result);
  } catch { data = undefined; error = t("denied"); }
  finally { busy = false; render(); }
}
app.ontoolinput = ({ arguments: input }) => {
  const next = input?.management_ref;
  if (managementRef && next && JSON.stringify(managementRef) !== JSON.stringify(next)) { error = t("scope"); render(); return; }
  if (next) managementRef = next;
};
app.ontoolresult = result => { try { receive(result); } catch (e) { error = e instanceof Error ? e.message : t("denied"); } render(); };
app.onhostcontextchanged = context => {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  if (context.locale) locale = context.locale.startsWith("en") ? "en" : "zh-CN";
  render();
};
app.onteardown = async () => { connected = false; data = undefined; managementRef = undefined; reference = undefined; render(); return {}; };
render();
if (window.parent !== window) void app.connect().then(() => {
  connected = true; locale = app.getHostContext()?.locale?.startsWith("en") ? "en" : "zh-CN"; render();
}).catch(() => { error = t("unavailable"); render(); });
