import type {ExternalProviderAvailability,ExternalSessionMode} from "./external-ai.ts";
import type {ExternalConversationSnapshot,ExternalForkOrigin,ExternalRewindOrigin} from "./external-session.ts";
import type {ExternalTeamPane} from "./external-team.ts";
import type {ExternalInstallation} from "./external-installation.ts";
import type {ExternalStorageBinding} from "./external-storage-binding.ts";
import type {WorkRef} from "@hetu/plugin-sdk";
export type TerminalBinding = {workspace: string; accessDirectory: string; knowledgeBaseId?: string; workRef?:WorkRef; title: string; localSettings?:boolean};
export type TerminalSnapshot = {
  session_id: string; generation: number; connected: boolean; title: string; directory: string;
  replay: string; sequence: number; program_state?: string; exit_reason?: string;
  cols?:number;rows?:number;
  provider_session_id?:string;restore_available?:boolean;identity_status?:"bound"|"unavailable"|"ambiguous";
  provider_id?:string;mode?:ExternalSessionMode;history_available?:boolean;
  conversation?:ExternalConversationSnapshot;
  installation?:ExternalInstallation;
  storage_binding?:ExternalStorageBinding;
  fork_origin?:ExternalForkOrigin;
  team?:ExternalTeamPane;
  rewind_origin?:ExternalRewindOrigin;rewind_count?:number;pending_rewind?:ExternalRewindOrigin;
};
export type TerminalEvent = {session_id: string; generation: number; sequence: number; data?: string; snapshot?: TerminalSnapshot;resync?:boolean;transient?:boolean};
export type TerminalMethod = "get" | "start" | "resume" | "reconnect" | "input" | "paste" | "resize" | "stop" | "draft" | "send" | "interrupt" | "approve" | "model" | "answer" | "respond" | "effort" | "compact" | "history" | "rewind" | "configure" | "background" | "background_stop" | "commands" | "command";
export type TerminalKnowledgeMethod="tree"|"search"|"read"|"reference"|"open";
export type TerminalLayout={type:"group";id:string}|{type:"split";id:string;direction:"right"|"down";ratio:number;first:TerminalLayout;second:TerminalLayout};
export type TerminalTab=TerminalSnapshot&{group_id:string;pinned:boolean;custom_title?:string};
export type TerminalWorkspaceSnapshot={workspace_id:string;revision:number;active_session_id:string;selected_by_group:Record<string,string>;sessions:TerminalTab[];layout:TerminalLayout;maximized_group_id?:string;recovery_error?:string;providers?:ExternalProviderAvailability[]};
export type TerminalWorkspaceMethod="get"|"create"|"split"|"select"|"close"|"rename"|"pin"|"move"|"resize"|"maximize"|"fork";
export function sameTerminalBinding(left:TerminalBinding|undefined,right:TerminalBinding|undefined) {
  return !!left&&!!right&&left.workspace===right.workspace&&left.accessDirectory===right.accessDirectory&&left.knowledgeBaseId===right.knowledgeBaseId&&left.localSettings===right.localSettings;
}
