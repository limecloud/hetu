import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const strings = {
  "zh-CN": { title: "河图洛书 任务页面", description: "此页面只查看当前任务并记录选择和意见。请先在桌面软件确认配对。", pair: "请求配对", pending: "请核对下方配对码，再到河图洛书批准这个浏览器。", ready: "点击请求配对；页面地址本身不授予作品访问权。", loading: "正在读取当前任务…", retry: "重新读取任务", ended: "页面访问已结束。已保存的意见仍在原任务中；请回桌面软件重新打开。", boundary: "采纳正文、选用正式封面和定稿，请回桌面软件确认。", connection: "连接暂时中断。未确认的保存请查询原操作，勿重复提交。", failed: "页面操作未完成。请稍后重试或回桌面端查看原任务。" },
  en: { title: "Hetu Luoshu Task view", description: "View this task and record preferences or feedback. Pair this browser in the desktop app first.", pair: "Request pairing", pending: "Compare the code below, then approve this browser in Hetu Luoshu.", ready: "Request pairing to continue. This URL grants no access to your book.", loading: "Loading the current task…", retry: "Reload task", ended: "Access has ended. Saved feedback remains in the original task. Reopen this view in the desktop app.", boundary: "Adopt text, choose an official cover and finalize in the desktop app.", connection: "Connection interrupted. Check the original operation before submitting an unconfirmed save again.", failed: "The operation did not complete. Try again later or inspect the original task in the desktop app." },
};
type State = { state: string; csrf: string; code?: string; locale: "zh-CN" | "en"; theme: "light" | "dark"; task_ref?: Record<string, unknown> };
let state: State;
let bridge: AppBridge | undefined;
let events: EventSource | undefined;
let ended = false;
let starting = false;
let loadFailed = false;
const node = (id: string) => document.getElementById(id)!;
const t = (key: keyof typeof strings.en) => strings[state?.locale ?? "zh-CN"][key];
async function end() {
  if (ended) return;
  ended = true; events?.close();
  document.body.classList.remove("paired"); node("view").replaceChildren(); node("code").textContent = "";
  (node("pair") as HTMLButtonElement).disabled = true; node("status").textContent = t("ended"); node("connection").textContent = "";
  try { await bridge?.close(); } catch { /* 撤权先清理页面；断开的宿主无需再次请求。 */ }
  bridge = undefined;
}
async function rpc(method: string, params: unknown) {
  if (ended) throw new Error(t("ended"));
  const response = await fetch("/api/rpc", { method: "POST", headers: { "Content-Type": "application/json", "X-Hetu-CSRF": state.csrf }, body: JSON.stringify({ method, params }), cache: "no-store" });
  if (response.status === 403 || response.status === 410) { await end(); throw new Error(t("ended")); }
  if (!response.ok) throw new Error(t("connection"));
  return await response.json();
}
async function open() {
  if (bridge || starting || ended) return;
  starting = true;
  try {
    const result = await rpc("tools/call", { name: "hetu_open_task_view", arguments: { task_ref: state.task_ref } });
    if (ended) return;
    if (result.isError) { await end(); return; }
    const iframe = document.createElement("iframe"); iframe.title = t("title"); iframe.setAttribute("sandbox", "allow-scripts");
    node("view").replaceChildren(iframe);
    const current = bridge = new AppBridge(null, { name: "Hetu Luoshu local task host", version: "0.4.0" }, { serverTools: {}, serverResources: {} }, { hostContext: { theme: state.theme, locale: state.locale } });
    current.oncalltool = params => rpc("tools/call", params);
    current.onreadresource = params => rpc("resources/read", params);
    current.oninitialized = () => { current.sendToolInput({ arguments: { task_ref: state.task_ref } }); current.sendToolResult(result); };
    current.onsizechange = size => { iframe.style.height = `${Math.max(600, Math.min(size.height ?? 800, 20000))}px`; };
    await current.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
    if (ended) { iframe.remove(); await current.close(); return; }
    iframe.src = "/view.html"; document.body.classList.add("paired");
    events = new EventSource("/api/events");
    events.addEventListener("revoked", () => { void end(); });
    events.onerror = () => { void end(); };
    events.onopen = () => { node("connection").textContent = ""; };
  } catch {
    if (ended) return;
    loadFailed = true;
    try { await bridge?.close(); } catch { /* 连接失败时清理本次宿主。 */ }
    bridge = undefined; node("view").replaceChildren(); node("status").textContent = t("failed");
  }
  finally { starting = false; }
}
async function refresh() {
  if (ended) return;
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (response.status === 403 || response.status === 410) { await end(); return; }
    if (!response.ok) throw new Error("Unavailable");
    state = await response.json() as State;
    if (ended) return;
    document.documentElement.lang = state.locale; document.documentElement.dataset.theme = state.theme;
    document.title = t("title");
    for (const id of ["title", "description", "pair", "boundary"] as const) node(id).textContent = t(id);
    (node("pair") as HTMLButtonElement).disabled = state.state !== "unpaired" && !(state.state === "paired" && loadFailed);
    node("pair").textContent = t(loadFailed && state.state === "paired" ? "retry" : "pair");
    node("status").textContent = t(state.state === "pending" ? "pending" : state.state === "paired" ? loadFailed ? "failed" : "loading" : "ready");
    node("code").replaceChildren();
    if (state.code) { const code = document.createElement("code"); code.textContent = state.code; node("code").append(code); }
    if (state.state === "paired" && !loadFailed) await open();
  } catch {
    if (ended) return;
    if (bridge) await end();
    else node("status").textContent = t("connection");
  }
}
node("pair").addEventListener("click", () => { void (async () => {
  (node("pair") as HTMLButtonElement).disabled = true;
  if (state.state === "paired") { loadFailed = false; await open(); return; }
  try {
    const response = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json", "X-Hetu-CSRF": state.csrf }, body: "{}" });
    if (!response.ok) throw new Error("Pairing failed");
    await refresh();
  } catch { if (!ended) { node("status").textContent = t("failed"); (node("pair") as HTMLButtonElement).disabled = false; } }
})(); });
await refresh();
const poll = setInterval(() => { void refresh(); }, 1000);
window.addEventListener("pagehide", () => { clearInterval(poll); events?.close(); void bridge?.close(); });
