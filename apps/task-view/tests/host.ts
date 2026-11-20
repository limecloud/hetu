import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/client";

declare global {
  interface Window {
    initialTask: CallToolResult;
    viewHtml: string;
    testTheme?: "light" | "dark";
    testLocale?: string;
    testMessages?: boolean;
    testExtensions?: boolean;
    testContext?: boolean;
    testDeepLink?: string;
    testActions?: Record<string, Record<string, unknown>>;
    realTask?: boolean;
    workbenchMode?: boolean;
    operationInput?: Record<string, unknown>;
    harness: {
      calls: { name: string; arguments?: Record<string, unknown> }[];
      invalidToolArguments: number;
      reads: string[];
      saveMode: "normal" | "lost" | "conflict" | "absent";
      messages: unknown[];
      wireMessages: unknown[];
      contexts: unknown[];
      messageMode: "accepted" | "rejected" | "lost";
      send: (result: CallToolResult) => void;
      teardown: () => Promise<unknown>;
    };
  }
}

const iframe = document.createElement("iframe");
iframe.title = "Task view";
iframe.setAttribute("sandbox", "allow-scripts");
iframe.style.cssText = "width:100%;height:1400px;border:0;display:block";
document.body.style.margin = "0";
document.body.append(iframe);
const bridge = new AppBridge(null, { name: "Hetu Apps contract host", version: "1" }, { serverTools: {}, serverResources: {}, ...(window.testMessages ? { message: { text: {} } } : {}), ...(window.testContext ? { updateModelContext: { text: {} } } : {}), ...(window.testExtensions ? { experimental: { "openai/message": {} } } : {}) }, { hostContext: { theme: window.testTheme ?? "light", locale: window.testLocale ?? "zh-CN", ...(window.testDeepLink ? { "openai/deepLink": { url: window.testDeepLink } } : {}) } });
let current = structuredClone(window.initialTask);
let original: CallToolResult | undefined;
const harness: Window["harness"] = window.harness = {
  calls: [], invalidToolArguments: 0, reads: [], saveMode: "normal", messages: [], wireMessages: [], contexts: [], messageMode: "accepted",
  send: result => { current = structuredClone(result); bridge.sendToolResult(result); },
  teardown: () => bridge.teardownResource({}),
};
window.addEventListener("message", event => {
  if (event.source === iframe.contentWindow && event.data?.method === "ui/message") harness.wireMessages.push(structuredClone(event.data.params));
});
bridge.onupdatemodelcontext = async params => { harness.contexts.push(structuredClone(params)); return {}; };
bridge.oncalltool = async params => {
  // Codex在转发前校验严格JSON；HTTP序列化会掩盖structured clone保留的undefined。
  if (window.workbenchMode) {
    const json = (value: unknown): boolean => value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (Array.isArray(value) ? Array.from(value).every(json) : typeof value === "object" && Object.values(value!).every(json));
    if (!json(params.arguments)) { harness.invalidToolArguments++; throw new Error("Invalid MCP tool call params: arguments must contain only JSON values"); }
  }
  harness.calls.push(structuredClone(params));
  if (window.realTask) {
    const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "tools/call", params }) });
    if (!response.ok) throw new Error("Real MCP tool call failed");
    return await response.json();
  }
  if (params.name === "hetu_inspect_collaboration" && window.testActions) {
    const action = String(params.arguments?.action);
    return { content: [], structuredContent: { status: "succeeded", data: { actions: [{ name: action, effect: "read", input_schema: { properties: { management_ref: {}, work_ref: {} } } }] } } };
  }
  if (params.name === "hetu_call_action" && window.testActions) {
    const action = String(params.arguments?.action);
    const value = window.testActions[action];
    return value ? { content: [], structuredContent: { status: "succeeded", data: value } } : { content: [], isError: true, structuredContent: { status: "blocked", error: { code: "forbidden", message: "Not authorized" } } };
  }
  if (params.name === "hetu_open_app") return current;
  if (params.name === "hetu_open_task_view") return current;
  if (["hetu_get_management_operation", "hetu_local_settings_get_operation"].includes(params.name)) return current;
  if (params.name === "hetu_read_task_operation") {
    return { content: [], structuredContent: original
      ? { status: "succeeded", data: { original_result: original.structuredContent } }
      : { status: "blocked", error: { code: "not_found" } } };
  }
  if (!["hetu_save_task_selection", "hetu_save_task_feedback"].includes(params.name)) throw new Error("Tool is not allowed");
  if (harness.saveMode === "conflict") return { content: [], structuredContent: { status: "blocked", error: { code: "revision_conflict", message: "Task changed" } }, isError: true };
  const data = current.structuredContent as { data: Record<string, unknown> };
  if (params.name === "hetu_save_task_feedback") {
    const reference = { feedback_id: "feedback_test", sha256: "c".repeat(64) };
    data.data.feedback_head = reference;
    data.data.last_feedback = { intent: "request_changes", public_comment: params.arguments?.public_comment };
    const result = { content: [], structuredContent: { status: "succeeded", data: { feedback_ref: reference, delivery_state: "not_requested" } } };
    if (harness.saveMode !== "absent") original = result;
    if (harness.saveMode === "lost" || harness.saveMode === "absent") throw new Error("Simulated lost response");
    return result;
  }
  data.data.decision = { candidate_refs: params.arguments?.candidate_refs, comment: params.arguments?.comment };
  data.data.expected = { revision: 3, sha256: "b".repeat(64) };
  const result = { content: [], structuredContent: { status: "succeeded", data: { effect: "preference_only" } }, isError: false };
  if (harness.saveMode !== "absent") original = result;
  if (harness.saveMode === "lost" || harness.saveMode === "absent") throw new Error("Simulated lost response");
  return result;
};
bridge.onmessage = async params => {
  harness.messages.push(structuredClone(params));
  if (harness.messageMode === "lost") throw new Error("Unconfirmed host message");
  return harness.messageMode === "rejected" ? { isError: true } : {};
};
bridge.onreadresource = async params => {
  harness.reads.push(params.uri);
  if (window.realTask) {
    const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "resources/read", params }) });
    if (!response.ok) throw new Error("Real MCP resource read failed");
    return await response.json();
  }
  const result = original ? { status: "succeeded", data: { original_result: original.structuredContent } } : { status: "blocked", error: { code: "not_found" } };
  return { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(result) }] };
};
bridge.oninitialized = () => {
  if ((current.structuredContent as { data?: { app?: unknown } }).data?.app) {
    bridge.sendToolInput({ arguments: {} }); bridge.sendToolResult(current); return;
  }
  if (window.operationInput) {
    bridge.sendToolInput({ arguments: window.operationInput }); bridge.sendToolResult(current); return;
  }
  const data = (current.structuredContent as { data: { request: Record<string, unknown>; task_ref?: Record<string, unknown> } }).data;
  const task = data.request;
  bridge.sendToolInput({ arguments: { task_ref: data.task_ref ?? { task_id: task.task_id, scope_ref: task.scope_ref, request_revision: task.request_revision } } });
  bridge.sendToolResult(current);
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
iframe.srcdoc = window.viewHtml;
