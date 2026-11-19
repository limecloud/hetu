import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps";

export type MessageTarget = "active" | "new";

// 只在此处解释供应商扩展；标准宿主不按产品名分支。
export function supportsMessageDrafts(capabilities?: McpUiHostCapabilities): boolean {
  const extension = capabilities?.experimental?.["openai/message"];
  return !!capabilities?.message?.text && !!extension && typeof extension === "object" && !Array.isArray(extension);
}

export function messageMetadata(capabilities: McpUiHostCapabilities | undefined, target: MessageTarget, send: boolean) {
  if (target === "active" && send) return {};
  if (!supportsMessageDrafts(capabilities)) throw new Error("宿主不支持消息草稿。");
  return { _meta: { "openai/message": { target, send } } };
}

export function taskDeepLink(context: Record<string, unknown> | undefined) {
  const value = context?.["openai/deepLink"];
  if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string") return undefined;
  const match = /^\/tasks\/(workspace|creation_project)\/((?:workspace|project)_[0-9a-f-]{36})\/(task_[0-9a-f-]{36})$/.exec(value.url);
  if (!match || (match[1] === "workspace") !== match[2].startsWith("workspace_")) return undefined;
  return { scope_ref: { kind: match[1], id: match[2] }, task_id: match[3] };
}
