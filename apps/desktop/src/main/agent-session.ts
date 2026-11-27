import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {RecoveryStore} from "./recovery.ts";
import type { WorkRef } from "@hetu/plugin-sdk";
import desktopPackage from "../../package.json" with { type: "json" };

import { CodexSession as AgentSession } from "./agent/codex-session.ts";
import type { AgentSessionAdapter, AgentSessionEvent as Event, SessionSnapshot, SessionMessage } from "../agent-session-contract.ts";
export { CodexSession as AgentSession } from "./agent/codex-session.ts";
export { agentSessionSandbox, agentSessionPersistPath, buildAgentSessionPrompt, buildCodexAppServerArgs, serializeAgentSessionContext } from "./agent/context.ts";
export type { AgentSessionContext } from "./agent/context.ts";
export type { AgentSessionAdapter } from "../agent-session-contract.ts";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function now() { return new Date().toISOString(); }
function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "delta", "message"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  if (Array.isArray(record.content)) return record.content.map(textFrom).filter(Boolean).join("");
  if (record.item) return textFrom(record.item);
  if (record.event) return textFrom(record.event);
  return "";
}

/** Claude Code CLI 的 JSONL 会话适配；权限固定为 plan，工具拒绝由引擎返回。 */
export class ClaudeSession implements AgentSessionAdapter {
  #child?: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #closed = true;
  #starting?: Promise<SessionSnapshot>;
  #snapshot: SessionSnapshot;
  #cwd: string;
  #profile: string;
  #machineDirectory?: string;
  #persistPath: string;
  #emit: (event: Event) => void;
  #sessionId?: string;

  constructor(options: { client: string; work: WorkRef; cwd: string; profile: string; machineDirectory?: string; emit: (event: Event) => void }) {
    this.#cwd = options.cwd;
    this.#profile = options.profile;
    this.#machineDirectory = options.machineDirectory;
    this.#persistPath = path.join(options.profile, "agent-sessions", `claude-code-${encodeURIComponent(options.work.workspace_id)}-${options.work.kind}-${encodeURIComponent(options.work.object_id)}.json`);
    this.#emit = options.emit;
    this.#snapshot = { state: "idle", client: options.client, work_ref: structuredClone(options.work), messages: [], updated_at: now() };
  }

  snapshot(): SessionSnapshot { return structuredClone(this.#snapshot); }

  async start(): Promise<SessionSnapshot> {
    if (this.#snapshot.state === "ready" || this.#snapshot.state === "running") return this.snapshot();
    if (this.#starting) return this.#starting;
    if (this.#snapshot.client !== "claude-code") throw new Error("当前会话适配器不是 Claude Code。");
    const pending = this.#start(); this.#starting = pending;
    try { return await pending; } finally { if (this.#starting === pending) this.#starting = undefined; }
  }

  async #start(): Promise<SessionSnapshot> {
    this.#set({ state: "starting", error: undefined });
    await this.#loadPersisted();
    await mkdir(this.#cwd, { recursive: true });
    const binary = process.env.HETU_CLAUDE_BIN || "claude";
    const args = ["--print", "--output-format", "stream-json", "--input-format", "stream-json", "--include-partial-messages", "--verbose", "--permission-mode", "plan", "--permission-prompts", "none"];
    if (this.#sessionId) args.push("--resume", this.#sessionId); else args.push("--session-id", randomUUID());
    const child = spawn(binary, args, { cwd: this.#cwd, stdio: "pipe", windowsHide: true, shell: false, ...(this.#machineDirectory ? { env: { ...process.env, HETU_COLLABORATION_DIR: this.#machineDirectory } } : {}) });
    this.#child = child; this.#closed = false;
    child.stdout.on("data", bytes => this.#read(bytes));
    child.stderr.on("data", () => { /* Claude diagnostics remain outside作品事实。 */ });
    child.on("error", error => this.#fail(error.message));
    child.on("exit", (code, signal) => { if (!this.#closed) this.#fail(`Claude Code 进程已退出（${code ?? signal ?? "未知原因"}）。`); });
    this.#set({ state: "ready" });
    await this.#savePersisted();
    return this.snapshot();
  }

  async send(text: string, displayText = text): Promise<SessionSnapshot> {
    const message = text.trim(); if (!message) throw new Error("请输入要发送给 Agent 的内容。");
    if (!this.#child || this.#closed) await this.start();
    this.#snapshot.messages.push({ role: "user", text: displayText.trim() || message, at: now() });
    this.#set({ state: "running" });
    this.#write({ type: "user", message: { role: "user", content: message } });
    await this.#savePersisted();
    return this.snapshot();
  }

  async interrupt(): Promise<SessionSnapshot> { this.#child?.kill("SIGINT"); this.#set({ state: "ready" }); return this.snapshot(); }
  async respond(_id: number | string, _result: unknown): Promise<void> { throw new Error("Claude Code 当前使用 plan 权限模式，不开放宿主逐请求审批回传。"); }
  async stop(): Promise<SessionSnapshot> {
    this.#closed = true; this.#child?.kill(); this.#child = undefined; this.#buffer = Buffer.alloc(0); this.#set({ state: "stopped" }); await this.#savePersisted(); return this.snapshot();
  }

  #set(patch: Partial<SessionSnapshot>) { this.#snapshot = { ...this.#snapshot, ...patch, updated_at: now() }; this.#emit({ type: "snapshot", snapshot: this.snapshot() }); }
  #fail(message: string) { this.#closed = true; this.#child?.kill(); this.#child = undefined; this.#set({ state: "failed", error: message }); void this.#savePersisted().catch(() => undefined); }
  #read(bytes: Buffer) {
    this.#buffer = Buffer.concat([this.#buffer, bytes]); let end = -1;
    while ((end = this.#buffer.indexOf(10)) >= 0) {
      if (end > MAX_LINE_BYTES) { this.#fail("Claude Code 消息超过传输预算。"); return; }
      const line = this.#buffer.subarray(0, end); this.#buffer = this.#buffer.subarray(end + 1); if (!line.length) continue;
      try { this.#message(JSON.parse(line.toString("utf8"))); } catch (error) { this.#fail(`Claude Code 消息无效：${error instanceof Error ? error.message : String(error)}`); return; }
    }
    if (this.#buffer.length > MAX_LINE_BYTES) this.#fail("Claude Code 消息超过传输预算。");
  }
  #message(value: any) {
    if (value?.session_id && typeof value.session_id === "string") { this.#sessionId = value.session_id; this.#snapshot.thread_id = value.session_id; }
    const delta = value?.type === "stream_event" ? textFrom(value.event) : value?.type === "assistant" ? textFrom(value.message) : "";
    if (delta) { const last = this.#snapshot.messages.at(-1); if (last?.role === "assistant") last.text += delta; else this.#snapshot.messages.push({ role: "assistant", text: delta, at: now() }); this.#emit({ type: "delta", text: delta }); this.#emit({ type: "snapshot", snapshot: this.snapshot() }); void this.#savePersisted().catch(() => undefined); }
    if (value?.type === "result") { if (!delta && typeof value.result === "string" && value.result) this.#snapshot.messages.push({ role: "assistant", text: value.result, at: now() }); this.#set({ state: value.is_error ? "failed" : "ready", error: value.is_error ? String(value.result ?? "Claude Code 执行失败。") : undefined }); void this.#savePersisted().catch(() => undefined); }
    if (value?.type === "error") this.#fail(String(value.error ?? value.message ?? "Claude Code 执行失败。"));
    this.#emit({ type: "notification", method: value?.type ?? "claude/event", params: value });
  }
  #write(value: unknown) { if (!this.#child || this.#closed) throw new Error("Claude Code 会话已关闭。"); this.#child.stdin.write(JSON.stringify(value) + "\n"); }
  async #loadPersisted() { try { const value = JSON.parse(await readFile(this.#persistPath, "utf8")); this.#sessionId = value.session_id; this.#snapshot.thread_id = value.thread_id; this.#snapshot.messages = Array.isArray(value.messages) ? value.messages.slice(-200) : []; } catch { /* 新会话。 */ } }
  async #savePersisted() { await mkdir(path.dirname(this.#persistPath), { recursive: true }); await writeFile(this.#persistPath, JSON.stringify({ session_id: this.#sessionId, thread_id: this.#snapshot.thread_id, work_ref: this.#snapshot.work_ref!, messages: this.#snapshot.messages.slice(-200), updated_at: this.#snapshot.updated_at }) + "\n", { mode: 0o600 }); }
}

type AcpPersistedSession = {
  session_id?: string;
  thread_id?: string;
  cwd: string;
  work_ref: WorkRef;
  messages: SessionMessage[];
  updated_at: string;
};

type AcpPending = {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onResult?: (value: any) => void;
};

/** ACP v1 的最小客户端适配；只开放会话和宿主审批，不把作品目录交给 Agent。 */
export class AcpSession implements AgentSessionAdapter {
  #persistence=new RecoveryStore();
  #child?: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #closed = true;
  #generation = 0;
  #next = 0;
  #starting?: Promise<SessionSnapshot>;
  #pending = new Map<number, AcpPending>();
  #snapshot: SessionSnapshot;
  #cwd: string;
  #machineDirectory?: string;
  #persistPath: string;
  #emit: (event: Event) => void;
  #sessionId?: string;
  #capabilities: any = {};

  constructor(options: { client: string; work: WorkRef; cwd: string; profile: string; machineDirectory?: string; emit: (event: Event) => void }) {
    this.#cwd = options.cwd;
    this.#machineDirectory = options.machineDirectory;
    const segment = (value: string) => encodeURIComponent(value).replaceAll("%", "_");
    this.#persistPath = path.join(options.profile, "agent-sessions", `acp-${segment(options.work.workspace_id)}-${segment(options.work.kind)}-${segment(options.work.object_id)}.json`);
    this.#emit = options.emit;
    this.#snapshot = { state: "idle", client: options.client, work_ref: structuredClone(options.work), messages: [], updated_at: now() };
  }

  snapshot(): SessionSnapshot { return structuredClone(this.#snapshot); }

  async start(): Promise<SessionSnapshot> {
    if (this.#snapshot.state === "ready" || this.#snapshot.state === "running") return this.snapshot();
    if (this.#starting) return this.#starting;
    if (this.#snapshot.client !== "acp") throw new Error("当前会话适配器不是 ACP。");
    const pending = this.#start(); this.#starting = pending;
    try { return await pending; } finally { if (this.#starting === pending) this.#starting = undefined; }
  }

  async #start(): Promise<SessionSnapshot> {
    this.#set({ state: "starting", error: undefined });
    await this.#loadPersisted();
    await mkdir(this.#cwd, { recursive: true });
    const generation = ++this.#generation;
    const binary = process.env.HETU_ACP_BIN || "acp-agent";
    const child = spawn(binary, [], {
      cwd: this.#cwd,
      stdio: "pipe",
      windowsHide: true,
      shell: false,
      ...(this.#machineDirectory ? { env: { ...process.env, HETU_COLLABORATION_DIR: this.#machineDirectory } } : {}),
    });
    this.#child = child; this.#closed = false;
    child.stdout.on("data", bytes => { if (generation === this.#generation) this.#read(bytes, generation); });
    child.stderr.on("data", () => { /* ACP diagnostics remain outside作品事实。 */ });
    child.on("error", error => { if (generation === this.#generation) this.#fail(error.message, generation); });
    child.on("exit", (code, signal) => { if (generation === this.#generation && !this.#closed) this.#fail(`ACP Agent 进程已退出（${code ?? signal ?? "未知原因"}）。`, generation); });
    try {
      const initialized = await this.#request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "hetu-desktop", title: "河图洛书", version: desktopPackage.version },
      }, generation);
      this.#capabilities = initialized?.agentCapabilities ?? {};
      const canLoad = this.#capabilities.loadSession === true;
      if (this.#sessionId && canLoad) {
        try {
          await this.#request("session/load", { sessionId: this.#sessionId, cwd: this.#cwd, mcpServers: [] }, generation);
        } catch (error) {
          if (error instanceof Error && error.message.includes("结果未知")) throw error;
          this.#sessionId = undefined; this.#snapshot.thread_id = undefined;
        }
      } else if (this.#sessionId && !canLoad) {
        this.#sessionId = undefined; this.#snapshot.thread_id = undefined;
      }
      if (!this.#sessionId) {
        const created = await this.#request("session/new", { cwd: this.#cwd, mcpServers: [] }, generation);
        this.#sessionId = created?.sessionId;
        if (typeof this.#sessionId !== "string" || !this.#sessionId) throw new Error("ACP 未返回可恢复的会话身份。");
        this.#snapshot.thread_id = this.#sessionId;
      }
      this.#set({ state: "ready", error: undefined });
      await this.#savePersisted();
      return this.snapshot();
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error), generation);
      throw error;
    }
  }

  async send(text: string, displayText = text): Promise<SessionSnapshot> {
    const message = text.trim(); if (!message) throw new Error("请输入要发送给 Agent 的内容。");
    if (!this.#child || this.#closed || !this.#sessionId) await this.start();
    if (!this.#sessionId) throw new Error("当前 ACP 会话没有可恢复的会话身份。");
    this.#snapshot.messages.push({ role: "user", text: displayText.trim() || message, at: now() });
    this.#set({ state: "running", error: undefined });
    const generation = this.#generation;
    void this.#request("session/prompt", { sessionId: this.#sessionId, prompt: [{ type: "text", text: message }] }, generation)
      .then(result => {
        if (generation !== this.#generation || this.#closed) return;
        const reason = result?.stopReason;
        this.#set({ state: reason === "cancelled" ? "ready" : "ready", error: reason === "refusal" ? "ACP Agent 拒绝了当前请求。" : undefined });
        void this.#savePersisted().catch(() => undefined);
      })
      .catch(error => { if (generation === this.#generation) this.#fail(error instanceof Error ? error.message : String(error), generation); });
    await this.#savePersisted();
    return this.snapshot();
  }

  async interrupt(): Promise<SessionSnapshot> {
    if (this.#sessionId && !this.#closed) {
      try { this.#notify("session/cancel", { sessionId: this.#sessionId }); } catch { /* 进程已退出。 */ }
    }
    this.#set({ state: "ready" });
    return this.snapshot();
  }

  async respond(id: number | string, result: unknown): Promise<void> {
    if (!this.#child || this.#closed) throw new Error("ACP 会话已关闭。");
    if (!this.#snapshot.pending_request || this.#snapshot.pending_request.id !== id) throw new Error("该 ACP 请求已结束或不属于当前会话。");
    this.#write({ jsonrpc: "2.0", id, result });
    this.#snapshot.pending_request = undefined;
    this.#emitSnapshot();
    await this.#savePersisted();
  }

  async stop(): Promise<SessionSnapshot> {
    const child = this.#child;
    this.#generation++;
    if (child && !this.#closed && this.#sessionId && this.#capabilities?.sessionCapabilities?.close) {
      try { this.#write({ jsonrpc: "2.0", id: ++this.#next, method: "session/close", params: { sessionId: this.#sessionId } }); } catch { /* 进程已退出。 */ }
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("ACP 会话已关闭。")); }
    this.#pending.clear();
    child?.kill(); this.#child = undefined; this.#buffer = Buffer.alloc(0);
    this.#snapshot.pending_request = undefined;
    this.#set({ state: "stopped" });
    await this.#savePersisted();
    return this.snapshot();
  }

  #set(patch: Partial<SessionSnapshot>) { this.#snapshot = { ...this.#snapshot, ...patch, updated_at: now() }; this.#emit({ type: "snapshot", snapshot: this.snapshot() }); }
  #emitSnapshot() { this.#emit({ type: "snapshot", snapshot: this.snapshot() }); }
  #fail(message: string, generation = this.#generation) {
    if (generation !== this.#generation) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.#pending.clear(); this.#snapshot.pending_request = undefined;
    this.#set({ state: "failed", error: message }); this.#child?.kill(); this.#child = undefined; this.#buffer = Buffer.alloc(0);
    void this.#savePersisted().catch(() => undefined);
  }

  #read(bytes: Buffer, generation: number) {
    if (generation !== this.#generation || this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, bytes]); let end = -1;
    while ((end = this.#buffer.indexOf(10)) >= 0) {
      if (end > MAX_LINE_BYTES) { this.#fail("ACP 消息超过传输预算。", generation); return; }
      const line = this.#buffer.subarray(0, end); this.#buffer = this.#buffer.subarray(end + 1); if (!line.length) continue;
      try { this.#message(JSON.parse(line.toString("utf8")), generation); } catch (error) { this.#fail(`ACP 消息无效：${error instanceof Error ? error.message : String(error)}`, generation); return; }
    }
    if (this.#buffer.length > MAX_LINE_BYTES) this.#fail("ACP 消息超过传输预算。", generation);
  }

  #message(value: any, generation: number) {
    if (generation !== this.#generation || this.#closed) return;
    if (value && value.id !== undefined && (value.result !== undefined || value.error !== undefined)) {
      const pending = this.#pending.get(value.id); if (!pending) return;
      clearTimeout(pending.timer); this.#pending.delete(value.id);
      if (value.error) pending.reject(new Error(value.error.message || "ACP 请求失败。")); else { pending.onResult?.(value.result); pending.resolve(value.result); }
      return;
    }
    if (value?.method && value.id !== undefined) {
      this.#snapshot.pending_request = { id: value.id, method: value.method, params: value.params };
      this.#emit({ type: "server_request", id: value.id, method: value.method, params: value.params }); this.#emitSnapshot(); return;
    }
    if (value?.method !== "session/update") { if (value?.method) this.#emit({ type: "notification", method: value.method, params: value.params }); return; }
    const update = value.params?.update ?? {};
    const text = update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_message" ? textFrom(update.content) : "";
    if (text) {
      const last = this.#snapshot.messages.at(-1); if (last?.role === "assistant") last.text += text; else this.#snapshot.messages.push({ role: "assistant", text, at: now() });
      this.#emit({ type: "delta", text }); this.#emitSnapshot(); void this.#savePersisted().catch(() => undefined);
    }
    this.#emit({ type: "notification", method: value.method, params: value.params });
  }

  #write(value: unknown) { if (!this.#child || this.#closed) throw new Error("ACP 会话已关闭。"); this.#child.stdin.write(JSON.stringify(value) + "\n"); }
  #notify(method: string, params: unknown) { this.#write({ jsonrpc: "2.0", method, params }); }
  #request(method: string, params: unknown, generation = this.#generation): Promise<any> {
    if (generation !== this.#generation) return Promise.reject(new Error("ACP 会话连接代次已切换。"));
    const id = ++this.#next; this.#write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); const error = new Error("ACP 请求超时，结果未知；请沿原会话查询。"); reject(error); this.#fail(error.message, generation); }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { method, resolve, reject, timer });
    });
  }

  async #loadPersisted() {
    try {
      const value = JSON.parse(await readFile(this.#persistPath, "utf8")) as AcpPersistedSession;
      if (value.cwd === this.#cwd && value.work_ref.workspace_id === this.#snapshot.work_ref!.workspace_id && value.work_ref.kind === this.#snapshot.work_ref!.kind && value.work_ref.object_id === this.#snapshot.work_ref!.object_id) {
        this.#sessionId = value.session_id; this.#snapshot.thread_id = value.thread_id; this.#snapshot.messages = Array.isArray(value.messages) ? value.messages.slice(-200) : [];
      }
    } catch { /* 首次会话或损坏的私有投影从新会话开始。 */ }
  }
  async #savePersisted() {
    const record: AcpPersistedSession = { session_id: this.#sessionId, thread_id: this.#snapshot.thread_id, cwd: this.#cwd, work_ref: this.#snapshot.work_ref!, messages: this.#snapshot.messages.slice(-200), updated_at: this.#snapshot.updated_at };
    await this.#persistence.write(this.#persistPath,record,8*1024*1024);
  }
}

export function createAgentSession(options: { client: string; work: WorkRef; cwd: string; profile: string; machineDirectory?: string; machineMcpBinary?: string; emit: (event: Event) => void }): AgentSessionAdapter {
  if (options.client === "codex") return new AgentSession(options);
  if (options.client === "claude-code") return new ClaudeSession(options);
  if (options.client === "acp") return new AcpSession(options);
  throw new Error(`当前桌面尚未实现 ${options.client} 会话适配器。`);
}

export type { Event as AgentSessionEvent, SessionSnapshot };
