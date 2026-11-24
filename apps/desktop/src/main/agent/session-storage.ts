import { mkdir, readFile, rename, writeFile, unlink, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import type { WorkRef } from "@hetu/plugin-sdk";
import type { SessionSnapshot, AgentContextRef } from "../../agent-session-contract.ts";
import { agentSessionPersistPath } from "./context.ts";

export type ThreadProjection = Pick<SessionSnapshot, "title" | "messages" | "tools" | "draft" | "gui_draft" | "tui_draft" | "context_refs" | "model" | "reasoning_effort">;
export type CodexRecord = Pick<SessionSnapshot, "session_id" | "title" | "work_ref" | "surface" | "thread_id" | "messages" | "tools" | "updated_at" | "draft" | "gui_draft" | "tui_draft" | "draft_version" | "context_refs" | "model" | "reasoning_effort"> & { schema_version: 1; client?:string; cwd: string; threads?: Record<string, ThreadProjection> };
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
    || value.client!==undefined&&!["codex","shell","claude-code","gemini","opencode"].includes(value.client)
    || value.draft_version!==undefined&&(!Number.isSafeInteger(value.draft_version)||value.draft_version<0)
    || (value.surface!==undefined && !["gui","tui"].includes(value.surface))
    || ["draft","gui_draft","tui_draft"].some(key=>value[key]!==undefined && (typeof value[key]!=="string" || value[key].length>512_000))
    || value.messages.some((message: any) => !message || !["user", "assistant", "system"].includes(message.role) || typeof message.text !== "string")
    || (value.thread_id !== undefined && typeof value.thread_id !== "string") || (value.schema_version !== undefined && value.schema_version !== 1)
    || (value.threads !== undefined && (!value.threads || Array.isArray(value.threads) || typeof value.threads !== "object" || Object.entries(value.threads).some(([id, projection]: [string, any]) => !id || !projection || !Array.isArray(projection.messages)))))
    throw new Error("本机会话记录与当前范围不一致，已保留原记录，未新建替代线程。");
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
export function validateContextRefs(value: unknown): AgentContextRef[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error("最多附加30项固定上下文。");
  if (JSON.stringify(value).length > 64_000) throw new Error("上下文引用超过预算，请按需分块读取。");
  for (const ref of value) {
    if (!ref || typeof ref.label !== "string" || ref.label.length > 300 || !ref.reference || typeof ref.reference !== "object" || Array.isArray(ref.reference)) throw new Error("固定上下文格式无效。");
    if (/management_ref|authorization|access_token|workspace_path|file_path|password/i.test(JSON.stringify(ref.reference))) throw new Error("上下文不能包含授权材料、凭据或任意本机路径。");
  }
  return structuredClone(value);
}
