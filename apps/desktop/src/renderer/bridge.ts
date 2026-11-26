import type { WorkRef, WorkSurface } from "@hetu/plugin-sdk";
export interface DesktopBridge {
  professional(method:"catalog"|"capabilities"|"method"|"prepare",input:import("../professional-contract.ts").ProfessionalInput):Promise<any>;
  execution(request: {action: string; contract_revision: string; input: Record<string, unknown>}): Promise<any>;
  fonts(refresh?: boolean): Promise<import("@hetu/workbench-ui").FontCatalog>;
  interfaceScale(method: "get" | "set", input?: {value: number}): Promise<number>;
  onInterfaceScale(listener: (value: number) => void): () => void;
  readingState(method: "get" | "save", input: Record<string, unknown>): Promise<any>;
  readonly windowControls?: {zoom:boolean; interfaceScale?: boolean; titlebarInset?: boolean};
  onWindowChrome?(listener: (value: {inset: boolean; scale: number;fullscreen?:boolean}) => void): () => void;
  outlines(method: "get" | "save" | "draft" | "recover", input?: Record<string, unknown>): Promise<any>;
  video(method: "list" | "media" | "feedback" | "delivery" | "draft" | "journal" | "save_feedback" | "recover" | "export" | "export_caption" | "decision_history" | "decision_journal" | "prepare_decision" | "save_decision" | "recover_decision" | "acknowledge_decision", input?: Record<string, unknown>): Promise<any>;
  workAgent(method: "get" | "inspect" | "select" | "choose_package" | "auto_detect" | "reveal_bundle" | "prepare_install" | "recover" | "acknowledge", input?: Record<string, unknown>): Promise<any>;
  agentSessionHost?: boolean;
  agentSession(method: "get" | "start" | "login" | "send" | "interrupt" | "respond" | "stop" | "surface" | "terminal_input" | "terminal_resize" | "draft" | "recover" | "models" | "open_link" | "list" | "new" | "select" | "rename" | "remove" | "insert" | "results" | "catalog" | "model_options" | "paste_draft" | "attach_context" | "remove_context", input?: Record<string, unknown>): Promise<any>;
  onAgentSession(listener: (value: any) => void): () => void;
  canon(method: "get" | "preview" | "save" | "lock" | "recover" | "acknowledge", input?: Record<string, unknown>): Promise<any>;
  novel(method: "get" | "save" | "recover" | "acknowledge", input?: Record<string, unknown>): Promise<any>;
  models(action: "inspect" | "connect" | "poll" | "disconnect" | "catalog" | "custom_save" | "channel_select" | "select" | "account" | "verify", input?: Record<string, unknown>): Promise<any>;
  covers(method: "get" | "requests" | "candidates" | "choose_file" | "prepare" | "commit" | "recover" | "acknowledge", input?: Record<string, unknown>): Promise<any>;
  migrations(method: "preview" | "approve" | "continue", input: Record<string, unknown>): Promise<any>;
  versions(method: "status" | "snapshots" | "snapshot" | "diff" | "snapshot_diff" | "history" | "version" | "journal" | "prepare" | "commit" | "recover" | "acknowledge" | "continue", input?: Record<string, unknown>): Promise<any>;
  settings(method: "storage_cancel" | "storage_inspect" | "storage_prepare" | "storage_operation" | "storage_execute" | "preferences" | "get" | "list" | "operation" | "prepare" | "manual" | "update" | "commit" | "recover" | "acknowledge" | "handoff" | "continue" | "select_suite", input?: Record<string, unknown>): Promise<any>;
  settingsWindow(method: "open" | "close"): Promise<void>;
  settingsAgent(method: string, input?: Record<string, unknown>): Promise<any>;
  onPreferences(listener: (value: any) => void): () => void;
  onOpenDocument(listener: (value: {work_ref:WorkRef;document_id:string}) => void): () => void;
  onPluginsChanged(listener: (value: any) => void): () => void;
  onClosePlugin(listener: (value: {owner:string;view:string;epoch:number}) => void): () => void;
  onOpenWork(listener: (value: {work_ref:WorkRef;epoch:number;target:WorkSurface}) => void): () => void;
  zoom(): Promise<void>;
  maximize?(): Promise<void>;
  fullscreen?(method:"get"|"set",enabled?:boolean):Promise<boolean>;
  windowLayout?(layout:"terminal"|"default"):Promise<void>;
  library(
    method: "refresh" | "open" | "client" | "bootstrap" | "archive",
    input?: Record<string, unknown>,
  ): Promise<any>;
  open(): Promise<any>;
  state(): Promise<any>;
  select(ref: WorkRef): Promise<any>;
  read(action: string, input: Record<string, unknown>): Promise<any>;
  media(method: "open" | "release", input: Record<string, unknown>): Promise<any>;
  resources(
    method: "list" | "get" | "draft" | "usages" | "prepare" | "commit" | "recover" | "acknowledge",
    input?: Record<string, unknown>,
  ): Promise<any>;
  author(
    method:
      | "rename"
      | "duplicate"
      | "move_range"
      | "move_to_new"
      | "restore_move"
      | "adoption"
      | "adoption_options"
      | "new_adoption_journal"
      | "new_adoption_recover"
      | "new_adoption_acknowledge"
      | "adoption_context"
      | "adoption_partial"
      | "check"
      | "finalization"
      | "withdrawal"
      | "journal"
      | "acknowledge"
      | "recover"
      | "commit",
    input: Record<string, unknown>,
  ): Promise<any>;
  management(
    method:
      | "list"
      | "get"
      | "verify"
      | "prepare"
      | "commit"
      | "recover"
      | "acknowledge"
      | "continue",
    input?: Record<string, unknown>,
  ): Promise<any>;
  tasks(
    method: "list" | "journal" | "recover" | "call" | "resource" | "assessment" | "continuation",
    ref?: unknown,
    params?: unknown,
  ): Promise<any>;
  handoff(page: string, object?: Record<string, unknown>, delivery?: "draft"): Promise<void | {prompt: string; work_ref: WorkRef}>;
  writingPrompt(input: import("../writing-prompts.ts").WritingPromptRequest): Promise<{prompt: string}>;
  readonly promptDelivery?: {
    drafts: boolean;
    directSend?: boolean;
    send(text: string, mode: "send" | "draft", workRef?: WorkRef): Promise<{isError?: boolean}>;
  };
  connection(
    method: "status" | "select" | "authorize" | "revoke",
    client: string,
  ): Promise<any>;
  installConnection(client: string): Promise<any>;
  installSuite(input?: {work_ref?: WorkRef}): Promise<any>;
  dirty(value: boolean): Promise<void>;
  buffer(
    document_id: string,
    value?: unknown,
    kind?: "document" | "annotations",
  ): Promise<any>;
  copy(text: string, html?: string): Promise<void>;
  paste(): Promise<string>;
  paste(format: "rich"): Promise<{text: string; html: string}>;
  install(): Promise<any>;
  toggle(id: string, enabled: boolean): Promise<any>;
  uninstall(id: string): Promise<any>;
  bounds(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<void>;
  closeSurface(): Promise<void>;
  view(owner: string, id: string): Promise<void>;
  fallback(
    owner: string,
    action: string,
    input: Record<string, unknown>,
  ): Promise<any>;
}
declare global {
  interface Window {
    hetuDesktop: DesktopBridge;
  }
}
export const desktop = window.hetuDesktop;
/** 普通AI入口进入当前宿主；显式“复制”入口继续使用原handoff。 */
export async function requestAgent(page: string, object?: Record<string, unknown>) {
  if (desktop.agentSessionHost !== true) { await desktop.handoff(page, object); return; }
  const request = await desktop.handoff(page, object, "draft");
  if (!request || !desktop.promptDelivery) throw new Error("当前宿主未提供会话交接。");
  window.dispatchEvent(new CustomEvent("hetu:agent-open", {detail:{work_ref:request.work_ref}}));
  const result = await desktop.promptDelivery.send(request.prompt, "draft", request.work_ref);
  if (result.isError) throw new Error("当前终端未接收请求草稿，请核对当前会话。");
}
export function data(result: any) {
  if (result.status !== "succeeded")
    throw new Error(result.error?.message ?? "操作未完成。");
  return result.data;
}
