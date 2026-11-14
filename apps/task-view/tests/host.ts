import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/client";

declare global {
  interface Window {
    initialTask: CallToolResult;
    viewHtml: string;
    testTheme?: "light" | "dark";
    testLocale?: string;
    testMessages?: boolean;
    realTask?: boolean;
    harness: {
      calls: { name: string; arguments?: Record<string, unknown> }[];
      reads: string[];
      saveMode: "normal" | "lost" | "conflict" | "absent";
      messages: unknown[];
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
const bridge = new AppBridge(null, { name: "Hetu Apps contract host", version: "1" }, { serverTools: {}, serverResources: {}, ...(window.testMessages ? { message: { text: {} } } : {}) }, { hostContext: { theme: window.testTheme ?? "light", locale: window.testLocale ?? "zh-CN" } });
let current = structuredClone(window.initialTask);
let original: CallToolResult | undefined;
const harness: Window["harness"] = window.harness = {
  calls: [], reads: [], saveMode: "normal", messages: [], messageMode: "accepted",
  send: result => { current = structuredClone(result); bridge.sendToolResult(result); },
  teardown: () => bridge.teardownResource({}),
};
bridge.oncalltool = async params => {
  harness.calls.push(structuredClone(params));
  if (window.realTask) {
    const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "tools/call", params }) });
    if (!response.ok) throw new Error("Real MCP tool call failed");
    return await response.json();
  }
  if (params.name === "hetu_open_task_view") return current;
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
  const data = (current.structuredContent as { data: { request: Record<string, unknown>; task_ref?: Record<string, unknown> } }).data;
  const task = data.request;
  bridge.sendToolInput({ arguments: { task_ref: data.task_ref ?? { task_id: task.task_id, scope_ref: task.scope_ref, request_revision: task.request_revision } } });
  bridge.sendToolResult(current);
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
iframe.srcdoc = window.viewHtml;
