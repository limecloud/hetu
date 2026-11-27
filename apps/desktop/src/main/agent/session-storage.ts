import { mkdir, readFile, rename, writeFile, unlink, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import type { WorkRef } from "@hetu/plugin-sdk";
import {externalProviders} from "../../shared/external-ai.ts";
import type { SessionSnapshot } from "../../agent-session-contract.ts";
import { agentSessionPersistPath } from "./context.ts";
import {validateContextRefs} from "../../agent-context.ts";
import {validIdentityBinding,type CodexIdentityBinding} from "./codex-identity.ts";
import {validExternalStorageBinding} from "../../shared/external-storage-binding.ts";
import {validBotContext} from "./bot-context.ts";
export {validateContextRefs} from "../../agent-context.ts";

export type ThreadProjection = Pick<SessionSnapshot, "title" | "messages" | "tools" | "draft" | "gui_draft" | "tui_draft" | "context_refs" | "model" | "reasoning_effort">;
export type CodexRecord = Pick<SessionSnapshot, "session_id" | "title" | "work_ref" | "surface" | "thread_id" | "messages" | "tools" | "updated_at" | "draft" | "gui_draft" | "tui_draft" | "draft_version" | "context_refs" | "model" | "reasoning_effort"> & { schema_version: 1; client?:string; cwd: string; input_generation?:number;request_generation?:number;engine_identity?:CodexIdentityBinding;threads?: Record<string, ThreadProjection> };
function sameWork(a?: WorkRef, b?: WorkRef) { return !a && !b || !!a && !!b && a.workspace_id === b.workspace_id && a.kind === b.kind && a.object_id === b.object_id; }
export function defaultSessionId(work?: WorkRef) {
  return "codex-" + createHash("sha256").update(JSON.stringify(work ?? "library")).digest("hex").slice(0, 24);
}
export function recordPath(profile: string, work?: WorkRef, id = defaultSessionId(work)) {
  if (!/^(codex|terminal)-[a-zA-Z0-9-]{16,64}$/.test(id)) throw new Error("会话身份格式无效。");
  return id === defaultSessionId(work) && work ? agentSessionPersistPath(profile, work) : path.join(profile, "agent-sessions", id + ".json");
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export async function loadRecord(file: string, work: WorkRef | undefined, cwd: string): Promise<CodexRecord | undefined> {
  let value: any;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("本机会话记录无法读取，已保留原文件，请检查后恢复。"); }
  if (value.cwd !== cwd || !sameWork(value.work_ref, work) || !Array.isArray(value.messages)
    || value.client!==undefined&&value.client!=="shell"&&!externalProviders.some(provider=>provider.id===value.client)
    || value.draft_version!==undefined&&(!Number.isSafeInteger(value.draft_version)||value.draft_version<0)
    || ["input_generation","request_generation"].some(key=>value[key]!==undefined&&(!Number.isSafeInteger(value[key])||value[key]<0))
    || value.engine_identity!==undefined&&!validIdentityBinding(value.engine_identity)
    || value.storage_binding!==undefined&&!validExternalStorageBinding(value.storage_binding,value.client)
    || value.bot_context!==undefined&&!validBotContext(value.bot_context)
    || (value.surface!==undefined && !["gui","tui"].includes(value.surface))
    || ["draft","gui_draft","tui_draft"].some(key=>value[key]!==undefined && (typeof value[key]!=="string" || value[key].length>512_000))
    || value.messages.some((message: any) => !message || !["user", "assistant", "system"].includes(message.role) || typeof message.text !== "string")
    || (value.thread_id !== undefined && typeof value.thread_id !== "string") || (value.schema_version !== undefined && value.schema_version !== 1)
    || (value.threads !== undefined && (!value.threads || Array.isArray(value.threads) || typeof value.threads !== "object" || Object.entries(value.threads).some(([id, projection]: [string, any]) => !id || !projection || !Array.isArray(projection.messages)))))
    throw new Error("本机会话记录与当前范围不一致，已保留原记录，未新建替代线程。");
  try{
    for(const projection of [value,...Object.values(value.threads??{})] as any[]){
      if(projection.context_refs!==undefined)validateContextRefs(projection.context_refs);
      for(const message of projection.messages)if(message.context_refs!==undefined)validateContextRefs(message.context_refs);
    }
  }catch{throw new Error("本机会话的固定上下文损坏，已保留原记录，请检查后恢复。");}
  return value;
}
export async function sessionDirectory(profile: string, work?: WorkRef) {
  const directory = path.join(profile, "agent-sessions");
  const result: CodexRecord[] = [];
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  for (const name of names.filter(name => name.endsWith(".json") && !name.startsWith("claude-code-") && !name.startsWith("acp-"))) {
    const value = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    if (sameWork(value.work_ref, work)) result.push(value);
  }
  return result.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
