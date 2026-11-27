import type { WorkRef } from "@hetu/plugin-sdk";
import type {ExternalConversationSnapshot,ExternalSessionState} from "./shared/external-session.ts";
import type {ExternalStorageBinding} from "./shared/external-storage-binding.ts";

export type AgentSurface = "gui" | "tui";
export type AgentEngineId = string;
export type AgentBotContext={bot_ref:Record<string,unknown>;name:string;purpose:string};
export type SessionLaunch = { client: AgentEngineId; surface: AgentSurface; title?: string; model?: string; reasoning_effort?: string;bot_context?:AgentBotContext };
export type AgentModel = { id: string; name: string; efforts: string[]; default_effort?: string };
export type AgentEngine = { id: AgentEngineId; name: string; available: boolean; chat: boolean; models: boolean; protocol?:string; minimum_versions?:string[] };
export type SessionState = "idle" | "starting" | "ready" | "running" | "stopping" | "switching" | "uncertain" | "disconnected" | "stopped" | "failed";
export type DeliveryState = "prepared" | "written" | "accepted" | "rejected" | "unknown";
export type CodexAuthentication={state:"ready"|"required"|"changed"|"unavailable"|"signing_in";mode?:string};
export type SessionMessage = {
  id?: string; role: "user" | "assistant" | "system"; text: string; at: string;
  input_sha256?: string; delivery?: DeliveryState; turn_id?: string; item_id?: string; error?: string;
  sequence?:number;
  draft_version?:number;
  context_refs?:AgentContextRef[];
};
export type AgentTool = {
  id: string; turn_id: string; kind: string; title: string;
  state: "running" | "completed" | "failed" | "unknown";
  input?: string; output?: string; started_at?: string; completed_at?: string; duration_ms?:number;sequence?:number;server?:string;name?:string;
};
export type AgentRequest = { id: number | string; method: string; params: unknown; turn_id?: string; generation?: number };
export type AgentContextRef = { label: string; reference: Record<string, unknown> };
export type SessionSnapshot = {
  session_id?: string; title?: string; state: SessionState; client: string; work_ref?: WorkRef;
  surface?: AgentSurface; generation?: number; thread_id?: string; turn_id?: string;
  messages: SessionMessage[]; tools?: AgentTool[]; pending_request?: AgentRequest;
  requests?: AgentRequest[]; error?: string; updated_at: string;
  draft?: string; context_refs?: AgentContextRef[]; terminal_connected?: boolean;
  gui_draft?:string; tui_draft?:string;
  draft_version?:number;
  terminal_replay?: string; terminal_sequence?: number; model?: string; reasoning_effort?: string;
  capabilities?: { terminal: boolean; steer: boolean; models: boolean; chat?: boolean };
  authentication?:CodexAuthentication;
  external?:ExternalConversationSnapshot;
  external_state?:ExternalSessionState;
  storage_binding?:ExternalStorageBinding;
  bot_context?:AgentBotContext;
};
export type AgentSessionEvent =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "delta"; text: string; session_id?: string }
  | { type: "notification"; method: string; params: unknown; session_id?: string;work_ref?:WorkRef }
  | { type: "server_request"; id: number | string; method: string; params: unknown; session_id?: string }
  | { type: "terminal"; session_id: string; data: string; generation: number; sequence: number };
export interface AgentSessionAdapter {
  start(): Promise<SessionSnapshot>;
  send(text: string, displayText?: string, options?: { attempt_id?: string; model?: string; reasoning_effort?: string; draft_version?:number; context_refs?:AgentContextRef[] }): Promise<SessionSnapshot>;
  interrupt(): Promise<SessionSnapshot>;
  respond(id: number | string, result: unknown, generation?: number): Promise<void>;
  stop(): Promise<SessionSnapshot>;
  snapshot(): SessionSnapshot;
  switchSurface?(surface: AgentSurface): Promise<SessionSnapshot>;
  terminalInput?(data: string, generation: number): void;
  terminalResize?(cols: number, rows: number, generation: number): void;
  updateDraft?(text: string, refs?: AgentContextRef[]): Promise<SessionSnapshot>;
  models?(): Promise<unknown>;
  recover?(): Promise<SessionSnapshot>;
}
