import type { WorkRef } from "@hetu/plugin-sdk";
export interface DesktopBridge {
  workAgent(method: "get" | "inspect" | "select" | "choose_package" | "auto_detect" | "reveal_bundle" | "prepare_install" | "recover" | "acknowledge", input?: Record<string, unknown>): Promise<any>;
  canon(method: "get" | "preview" | "save" | "lock" | "recover" | "acknowledge", input?: Record<string, unknown>): Promise<any>;
  novel(method: "get" | "save" | "recover" | "acknowledge", input?: Record<string, unknown>): Promise<any>;
  models(action: "inspect" | "connect" | "poll" | "disconnect" | "catalog" | "custom_save" | "channel_select" | "select" | "account" | "verify", input?: Record<string, unknown>): Promise<any>;
  covers(method: "get" | "requests" | "candidates" | "choose_file" | "prepare" | "commit" | "recover" | "acknowledge", input?: Record<string, unknown>): Promise<any>;
  migrations(method: "preview" | "approve" | "continue", input: Record<string, unknown>): Promise<any>;
  versions(method: "status" | "snapshots" | "snapshot" | "diff" | "snapshot_diff" | "history" | "version" | "journal" | "prepare" | "commit" | "recover" | "acknowledge" | "continue", input?: Record<string, unknown>): Promise<any>;
  settings(method: "get" | "list" | "operation" | "prepare" | "manual" | "update" | "commit" | "recover" | "acknowledge" | "handoff" | "continue" | "select_suite", input?: Record<string, unknown>): Promise<any>;
  settingsWindow(method: "open" | "close"): Promise<void>;
  settingsAgent(method: string, input?: Record<string, unknown>): Promise<any>;
  onPreferences(listener: (value: any) => void): () => void;
  zoom(): Promise<void>;
  library(
    method: "refresh" | "open" | "client" | "bootstrap",
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
    method: "list" | "journal" | "recover" | "call" | "resource",
    ref?: unknown,
    params?: unknown,
  ): Promise<any>;
  handoff(page: string, object?: Record<string, unknown>): Promise<void>;
  connection(
    method: "status" | "select" | "authorize" | "revoke",
    client: string,
  ): Promise<any>;
  dirty(value: boolean): Promise<void>;
  buffer(
    document_id: string,
    value?: unknown,
    kind?: "document" | "annotations",
  ): Promise<any>;
  copy(text: string): Promise<void>;
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
  browser(address: string): Promise<void>;
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
export function data(result: any) {
  if (result.status !== "succeeded")
    throw new Error(result.error?.message ?? "操作未完成。");
  return result.data;
}
