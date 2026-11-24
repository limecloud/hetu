import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { WorkRef } from "@hetu/plugin-sdk";
import type { AgentContextRef, AgentRequest, AgentSessionAdapter, AgentSessionEvent, AgentSurface, AgentTool, SessionSnapshot,SessionLaunch } from "../../agent-session-contract.ts";
import {requestKind,validateServerAnswer} from "../../agent-request.ts";
import { buildCodexAppServerArgs } from "./context.ts";
import {creativeParticipation} from "../../creative-request.ts";
import { resolveCodexCommand } from "./codex-command.ts";
import { CodexRpc, CodexRpcError, type CodexWireMessage } from "./codex-rpc.ts";
import { CodexTerminal } from "./codex-terminal.ts";
import desktopPackage from "../../../package.json" with {type:"json"};
import { CodexTerminalBridge,passiveTerminalMessage } from "./codex-terminal-bridge.ts";
import { atomicJson, defaultSessionId, loadRecord, recordPath, validateContextRefs, type CodexRecord, type ThreadProjection } from "./session-storage.ts";
import { SessionLease } from "./session-lease.ts";
import {toolOutput as limited} from "./tool-output.ts";

export type CodexSessionOptions = {
  client: string; work?: WorkRef; cwd: string; profile: string;
  id?: string; defaultSurface?: AgentSurface; machineDirectory?: string; machineMcpBinary?: string;
  transport?: "socket" | "stdio"; timeout?: number;
  launch?:SessionLaunch;
  emit: (event: AgentSessionEvent) => void;
};
const now = () => new Date().toISOString();
/** 一个受管引擎、一个线程、唯一输入表面。作品持久化仍由河图机器用例拥有。 */
export class CodexSession implements AgentSessionAdapter {
  #options: CodexSessionOptions;
  #rpc?: CodexRpc;
  #command?: {binary:string;env:NodeJS.ProcessEnv};
  #terminal = new CodexTerminal();
  #terminalGeneration=0;
  #terminalBridge?: CodexTerminalBridge;
  #threadLease?: SessionLease;
  #pendingThreadLeases: SessionLease[] = [];
  #threads = new Map<string, ThreadProjection>();
  #snapshot: SessionSnapshot;
  #record: string;
  #lease: SessionLease;
  #held = false;
  #generation = 0;
  #ownerGeneration = 0;
  #requestGeneration = 0;
  #starting?: Promise<SessionSnapshot>;
  #transition?: Promise<SessionSnapshot>;
  #sending = false;
  #persisting = Promise.resolve();
  #loaded = false;
  #closed = false;
  #sequence=0;
  #lastEmission?:{generation:number;surface?:AgentSurface;terminal:boolean};
  constructor(options: CodexSessionOptions) {
    this.#options = options;
    const id = options.id ?? defaultSessionId(options.work);
    this.#record = recordPath(options.profile, options.work, id);
    this.#lease = new SessionLease(options.profile, this.#record);
    this.#snapshot = { session_id: id, client: "codex", work_ref: options.work && structuredClone(options.work), title: options.launch?.title??"新对话", model:options.launch?.model,reasoning_effort:options.launch?.reasoning_effort,state: "idle", surface: options.defaultSurface ?? "gui", messages: [], tools: [], requests: [], updated_at: now(), draft: "", context_refs: [], capabilities: { terminal: options.transport !== "stdio", steer: false, models: true,chat:true } };
  }
  get #terminalConnected() { return this.#terminal.connected && !!this.#rpc?.connected; }
  snapshot(includeReplay=true): SessionSnapshot { return { ...structuredClone(this.#snapshot), terminal_connected: this.#terminalConnected,terminal_sequence:this.#terminal.sequence,...(includeReplay?{terminal_replay:this.#terminal.replay}:{}),generation: this.#ownerGeneration }; }
  async load() {
    if (this.#loaded) return this.snapshot();
    const saved = await loadRecord(this.#record, this.#options.work, this.#options.cwd);
    if (saved) { const { threads, ...projection } = saved; this.#snapshot = { ...this.#snapshot, ...projection, session_id: this.#snapshot.session_id, state: "idle" }; this.#threads = new Map(Object.entries(threads ?? {})); }
    this.#sequence=Math.max(0,...this.#snapshot.messages.map(item=>item.sequence??0),...(this.#snapshot.tools??[]).map(item=>item.sequence??0));
    this.#loaded = true; return this.snapshot();
  }
  async start(): Promise<SessionSnapshot> {
    if (this.#starting) return this.#starting;
    const operation = this.#start(); this.#starting = operation;
    try { return await operation; } finally { if (this.#starting === operation) this.#starting = undefined; }
  }
  async #start():Promise<SessionSnapshot> {
    if (this.#rpc?.connected) {
      if (this.#snapshot.surface === "tui" && !this.#terminal.connected) {
        ++this.#ownerGeneration;
        await this.#openTerminal();
        this.#emit();
      }
      return this.snapshot();
    }
    await this.load();
    if (this.#rpc?.running && this.#snapshot.thread_id) return this.#reconnect();
    if (this.#rpc) {
      await this.#terminal.close();
      await this.#terminalBridge?.close(); this.#terminalBridge = undefined;
      await this.#rpc.close(); this.#rpc = undefined;
      await this.#threadLease?.release(); this.#threadLease = undefined;
      for (const lease of this.#pendingThreadLeases) await lease.release(); this.#pendingThreadLeases = [];
    }
    if (!this.#held) { await this.#lease.acquire(); this.#held = true; }
    this.#closed = false;
    this.#set({ state: "starting", error: undefined });
    await mkdir(this.#options.cwd, { recursive: true, mode: 0o700 });
    const generation = ++this.#generation;
    ++this.#ownerGeneration; ++this.#requestGeneration;
    try { this.#command = await resolveCodexCommand(this.#options.machineMcpBinary ? path.dirname(this.#options.machineMcpBinary) : undefined); if (this.#snapshot.thread_id) await this.#claimThread(this.#snapshot.thread_id); } catch(error) { this.#set({state:"failed",error:(error as Error).message});await this.#lease.release();this.#held=false;throw error; }
    const rpc = new CodexRpc({
      binary: this.#command.binary, args: [...buildCodexAppServerArgs(this.#options.machineMcpBinary, this.#options.machineDirectory, this.#options.work,this.#command.env.HETU_LOCAL_SETTINGS_DIR),...(this.#snapshot.model?["-c","model="+JSON.stringify(this.#snapshot.model)]:[]),...(this.#snapshot.reasoning_effort?["-c","model_reasoning_effort="+JSON.stringify(this.#snapshot.reasoning_effort)]:[])],
      cwd: this.#options.cwd, env: { ...this.#command.env, ...(this.#options.machineDirectory ? { HETU_COLLABORATION_DIR: this.#options.machineDirectory } : {}) },
      transport: this.#options.transport, timeout: this.#options.timeout,
      message: value => { if (generation === this.#generation) this.#message(value); },
      disconnected: error => { if (!this.#closed && generation === this.#generation) { for (const message of this.#snapshot.messages) if (message.delivery === "written" || message.delivery === "prepared") message.delivery = "unknown"; this.#set({ state: "disconnected", error, pending_request: undefined, requests: [] }); this.#saveBackground(); } },
    });
    this.#rpc = rpc;
    try {
      await rpc.open(); await this.#lease.update(rpc.pid); await this.#threadLease?.update(rpc.pid);
      await rpc.request("initialize", { clientInfo: { name: "hetu-desktop", version: desktopPackage.version }, capabilities: { experimentalApi: true } });
      rpc.write({ method: "initialized", params: {} });
      const previous = this.#snapshot.thread_id;
      const result = await rpc.request(previous ? "thread/resume" : "thread/start", {
        ...(previous ? { threadId: previous } : { cwd: this.#options.cwd, ephemeral: false }),
        approvalPolicy: "on-request", sandbox: "workspace-write",
        ...(this.#snapshot.model?{model:this.#snapshot.model}:{}),
        ...(this.#snapshot.reasoning_effort?{config:{model_reasoning_effort:this.#snapshot.reasoning_effort}}:{}),
        developerInstructions: "你正在河图洛书工作台中协助作者。"+creativeParticipation+"需要作品能力时，通过已连接的hetu MCP和已安装Skills发现并操作；读取固定来源，保存后回读真实成果，不直接读写作品私有文件。当前公开范围：" + JSON.stringify(this.#options.work ?? { scope: "creation_preparation" }) + "。默认按Core的auto/confirm策略执行，采纳、定稿及费用决定保持独立。",
      });
      const thread = result?.thread;
      const id = thread?.id ?? result?.threadId;
      if (typeof id !== "string" || previous && id !== previous) throw new Error("Codex未恢复确切的原线程，已保留原会话。");
      if (!previous) await this.#claimThread(id);
      this.#snapshot.thread_id = id;
      this.#reconcile(thread);
      if (this.#snapshot.state === "starting" || this.#snapshot.state === "idle") this.#set({ state: "ready", error: undefined });
      await this.#save();
      if (!previous) await this.#rpc!.request("thread/name/set", { threadId: id, name: this.#snapshot.title || "河图创作" });
      if (this.#snapshot.surface === "tui") await this.#openTerminal();
      return this.snapshot();
    } catch (error) {
      this.#set({ state: "failed", error: (error as Error).message });
      this.#closed = true;
      await this.#terminal.close(); await this.#terminalBridge?.close(); this.#terminalBridge = undefined;
      await rpc.close(); this.#rpc = undefined;
      await this.#threadLease?.release(); this.#threadLease = undefined;
      for (const lease of this.#pendingThreadLeases) await lease.release(); this.#pendingThreadLeases = [];
      await this.#lease.release(); this.#held = false;
      throw error;
    }
  }
  async #reconnect():Promise<SessionSnapshot> {
    this.#set({ state:"starting",pending_request:undefined,requests:[],error:undefined });
    ++this.#requestGeneration;
    try {
      await this.#rpc!.reconnect();
      await this.#rpc!.request("initialize",{clientInfo:{name:"hetu-desktop",version:"0.14.0"},capabilities:{experimentalApi:true}});
      this.#rpc!.write({method:"initialized",params:{}});
      const result=await this.#rpc!.request("thread/resume",{threadId:this.#snapshot.thread_id});
      this.#reconcile(result.thread);this.#emit();await this.#save();return this.snapshot();
    } catch(error) {
      // 原生服务先移除socket、CLI启动器稍后退出；确认退出后才能沿原线程重建。
      if(await this.#rpc!.waitForExit(1000))return this.#start();
      this.#set({state:"disconnected",error:(error as Error).message});throw error;
    }
  }
  async send(text: string, displayText = text, options: { attempt_id?: string; model?: string; reasoning_effort?: string } = {}): Promise<SessionSnapshot> {
    if (!text.trim()) throw new Error("请输入要发送给Codex的内容。");
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error("消息过长，请改用固定引用分块读取。");
    if (this.#sending || this.#transition) throw new Error("会话正在处理另一次发送或切换，请稍候。");
    this.#sending = true;
    try {
      await this.start();
      if (this.#snapshot.surface !== "gui") throw new Error("当前由TUI接管输入，请在终端中继续或切回GUI。");
      const attempt = options.attempt_id ?? randomUUID();
      const existing = this.#snapshot.messages.find(message => message.id === attempt);
      if (existing) { if (existing.text !== displayText) throw new Error("同一消息身份对应不同内容。"); return this.snapshot(); }
      if (this.#snapshot.state !== "ready") throw new Error("当前轮次尚未结束或结果待核对，请先恢复原线程。");
      const message = { id: attempt, role: "user" as const, text: displayText, at: now(), input_sha256: createHash("sha256").update(text).digest("hex"), delivery: "prepared" as const,sequence:++this.#sequence,draft_version:this.#snapshot.draft_version??0 };
      this.#snapshot.messages.push(message);
      if (this.#snapshot.title === "新对话") this.#snapshot.title = displayText.trim().slice(0, 40);
      await this.#save();
      this.#set({ state: "running", error: undefined, model: options.model, reasoning_effort: options.reasoning_effort });
      try {
        const result = await this.#rpc!.request("turn/start", {
          threadId: this.#snapshot.thread_id, input: [{ type: "text", text }],
          ...(options.model ? { model: options.model } : {}), ...(options.reasoning_effort ? { effort: options.reasoning_effort } : {}),
        }, () => { const target = this.#snapshot.messages.find(item => item.id === attempt); if (target?.delivery === "prepared") { target.delivery = "written"; this.#emit(); this.#saveBackground(); } });
        const turn = result?.turn?.id ?? result?.turnId;
        if (typeof turn !== "string") throw new CodexRpcError("Codex未返回可核对的轮次，投递结果未知。", "unknown");
        const target = this.#snapshot.messages.find(item => item.id === attempt)!;
        target.delivery = "accepted"; target.turn_id = turn;
        this.#consumeGuiDraft(target);
        if (this.snapshot().state === "running") this.#snapshot.turn_id = turn;
        this.#emit(); await this.#save();
        return this.snapshot();
      } catch (error) {
        const target = this.#snapshot.messages.find(item => item.id === attempt)!;
        if(target.delivery==="accepted"&&target.turn_id){this.#consumeGuiDraft(target);this.#emit();await this.#save();return this.snapshot();}
        target.delivery = error instanceof CodexRpcError && error.delivery !== "unknown" ? "rejected" : "unknown";
        target.error = (error as Error).message;
        this.#set({ state: target.delivery === "unknown" ? "uncertain" : "ready", error: target.error }); await this.#save(); throw error;
      }
    } finally { this.#sending = false; }
  }
  async recover() {
    await this.start();
    const result = await this.#rpc!.request("thread/read", { threadId: this.#snapshot.thread_id, includeTurns: true });
    this.#reconcile(result.thread); this.#emit(); await this.#save(); return this.snapshot();
  }
  async interrupt() {
    if (!this.#snapshot.turn_id) {
      await this.recover();
      if (!this.#snapshot.turn_id) return this.snapshot();
    }
    this.#set({ state: "stopping", error: undefined });
    try { await this.#rpc!.request("turn/interrupt", { threadId: this.#snapshot.thread_id, turnId: this.#snapshot.turn_id }); }
    catch (error) { this.#set({ state: "uncertain", error: "停止结果待核对：" + (error as Error).message }); throw error; }
    return this.snapshot();
  }
  async respond(id: number | string, result: unknown, generation?: number) {
    if (this.#snapshot.surface !== "gui" || generation !== undefined && generation !== this.#requestGeneration) throw new Error("此执行端已不持有当前请求的答复权。");
    const request = this.#snapshot.requests?.find(request => request.id === id);
    if (!request || request.generation !== this.#requestGeneration) throw new Error("该请求已经结束或不属于当前连接。");
    validateServerAnswer(request,result);
    this.#rpc!.write(requestKind(request)==="unsupported"?{id,error:{code:-32601,message:"河图客户端未实现此服务端请求；未执行或授予权限。"}}:{ id, result });
    this.#snapshot.requests = this.#snapshot.requests!.filter(request => request.id !== id);
    this.#set({ pending_request: this.#snapshot.requests[0] });
  }
  async switchSurface(surface: AgentSurface) {
    if (!["gui", "tui"].includes(surface)) throw new Error("会话界面无效。");
    if (this.#transition || this.#sending) throw new Error("会话正在切换或发送，请稍候。");
    const operation = this.#switch(surface); this.#transition = operation;
    try { return await operation; } finally { if (this.#transition === operation) this.#transition = undefined; }
  }
  async #switch(surface: AgentSurface) {
    await this.load();
    if(this.#snapshot.surface===surface)return this.snapshot();
    if(!this.#rpc?.running&&!this.#terminal.connected&&["idle","stopped","failed"].includes(this.#snapshot.state)){
      const previous=this.#snapshot.surface!;
      this.#snapshot[previous==="gui"?"gui_draft":"tui_draft"]=this.#snapshot.draft??"";
      ++this.#ownerGeneration;++this.#requestGeneration;
      this.#snapshot.surface=surface;this.#snapshot.draft=this.#snapshot[surface==="gui"?"gui_draft":"tui_draft"]??"";
      this.#emit();await this.#save();return this.snapshot();
    }
    await this.start();
    if (this.#snapshot.surface === surface) return this.snapshot();
    await this.recover();
    if (this.#snapshot.state !== "ready" || this.#snapshot.requests?.length) throw new Error("请先完成当前轮次及待答请求，再切换界面；未知结果先核对原线程。");
    const previous = this.#snapshot.surface!;
    if(previous==="tui" && this.#terminal.connected)await this.#terminal.readyForInput();
    this.#set({ state: "switching" });
    try {
      ++this.#ownerGeneration; ++this.#requestGeneration;
      this.#snapshot[previous==="gui"?"gui_draft":"tui_draft"]=this.#snapshot.draft ?? "";
      this.#snapshot.surface = surface;
      this.#snapshot.draft=this.#snapshot[surface==="gui"?"gui_draft":"tui_draft"]??"";
      if (surface === "tui" && !this.#terminal.connected) await this.#openTerminal();
      else await this.#rpc!.request("thread/resume", { threadId: this.#snapshot.thread_id });
      this.#set({ state: "ready", error: undefined }); await this.#save(); return this.snapshot();
    } catch (error) { this.#snapshot.surface = previous; this.#set({ state: "uncertain", error: (error as Error).message }); throw error; }
  }
  async #openTerminal() {
    if (!this.#rpc?.endpoint || !this.#snapshot.thread_id) throw new Error("当前Codex连接不支持共享TUI，请使用支持remote的版本。");
    const client=++this.#terminalGeneration;
    await this.#terminalBridge?.close();
    const bridge = new CodexTerminalBridge(); this.#terminalBridge = bridge;
    await bridge.open({ endpoint: this.#rpc.endpoint, token: this.#rpc.token,
      check: message => {
        if (client !== this.#terminalGeneration || this.#closed) throw new Error("旧终端已失去执行权。");
        if(this.#snapshot.surface!=="tui"&&!passiveTerminalMessage(message))throw new Error("当前输入由GUI持有，终端仅可观察；未投递或答复请求。");
        if (message.params?.threadId && message.params.threadId !== this.#snapshot.thread_id && !this.#threads.has(message.params.threadId)) throw new Error("此线程不属于当前作品会话，请从河图会话列表打开对应作品。");
        if (["thread/start", "thread/resume", "thread/fork"].includes(message.method!)) {
          const id = message.params?.threadId;
          if (message.method !== "thread/start" && id !== this.#snapshot.thread_id && !this.#threads.has(id)) throw new Error("此线程不属于当前作品会话，请从河图会话列表打开对应作品。");
          if (message.method !== "thread/resume" || id !== this.#snapshot.thread_id) {
            if (this.#snapshot.state !== "ready" || this.#snapshot.requests?.length) throw new Error("请先结束当前轮次并核对未知结果，再切换线程。");
          }
        }
        if (message.method === "turn/start" && message.params?.threadId !== this.#snapshot.thread_id) throw new Error("输入线程与当前会话不一致，未发送请求。");
        if (message.method === "turn/start" && ["uncertain", "disconnected", "stopping", "switching", "failed"].includes(this.#snapshot.state)) throw new Error("当前结果尚待核对，请先恢复原线程，未发送新的模型轮次。");
        if (["thread/start", "thread/fork"].includes(message.method!)) message.params = { ...message.params, cwd:this.#options.cwd, approvalPolicy:"on-request", sandbox:"workspace-write", permissions:null };
      },
      thread: async thread => { if (client !== this.#terminalGeneration || this.#closed || this.#snapshot.surface!=="tui") throw new Error("旧终端已失去执行权。"); await this.#adoptThread(thread); },
      list: result => ({ ...result, data: (result.data ?? []).filter((thread: any) => thread.id === this.#snapshot.thread_id || this.#threads.has(thread.id)) }),
    });
    this.#terminal.start({
      binary: this.#command!.binary, endpoint: bridge.endpoint, thread: this.#snapshot.thread_id,
      cwd: this.#options.cwd, env: this.#command!.env, token: bridge.token,
      onData: data => { if (client === this.#terminalGeneration && this.#snapshot.surface==="tui") this.#options.emit({ type: "terminal", session_id: this.#snapshot.session_id!, generation: this.#ownerGeneration,sequence:this.#terminal.sequence,data }); },
      onExit: () => { this.#set({ error: "终端客户端已退出，受管引擎与原成果仍保留。" }); },
    });
    this.#emit();
    await bridge.ready();
  }
  async #acquireThread(id: string) {
    const configured = path.resolve(this.#command?.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
    const config = await realpath(configured).catch(error => { if (error.code === "ENOENT") return configured; throw error; });
    const lease = new SessionLease(path.join(os.tmpdir(), "hetu-codex-ownership-" + (process.getuid?.() ?? os.userInfo().username)), config + "\n" + id);
    await lease.acquire(); await lease.update(this.#rpc?.pid);
    return lease;
  }
  async #claimThread(id: string) {
    const lease = await this.#acquireThread(id);
    const previous = this.#threadLease; this.#threadLease = lease; await previous?.release();
  }
  #projection(): ThreadProjection {
    const { title, messages, tools, draft, gui_draft, tui_draft, context_refs, model, reasoning_effort } = this.#snapshot;
    return structuredClone({ title, messages, tools, draft, gui_draft, tui_draft, context_refs, model, reasoning_effort });
  }
  async #adoptThread(thread: any) {
    if (!thread || typeof thread.id !== "string") throw new Error("Codex终端未返回可核对的线程。");
    if (thread.id !== this.#snapshot.thread_id) {
      const lease = await this.#acquireThread(thread.id), before = structuredClone(this.#snapshot), previousThreads = new Map(this.#threads);
      try {
        // 空线程尚无rollout；官方命名动作先持久化，再让观察客户端恢复，不能发模型请求来占位。
        if (!this.#threads.has(thread.id)) await this.#rpc!.request("thread/name/set", { threadId: thread.id, name: thread.name || "新对话" });
        const resumed = await this.#rpc!.request("thread/resume", { threadId: thread.id });
        if (resumed.thread?.id !== thread.id) throw new Error("Codex未恢复确切的目标线程。");
        if (before.thread_id) this.#threads.set(before.thread_id, this.#projection());
        const previous = this.#threads.get(thread.id);
        this.#snapshot = { ...this.#snapshot, ...(previous ?? { title: thread.name || "新对话", messages: [], tools: [], draft: "", gui_draft:"",tui_draft:"",context_refs: [], model: undefined, reasoning_effort: undefined }), thread_id: thread.id, turn_id: undefined, requests: [], pending_request: undefined, error: undefined };
        this.#reconcile(resumed.thread); await this.#save();
        const previousLease = this.#threadLease; this.#threadLease = lease; await previousLease?.release();
        this.#emit(); return;
      } catch (error) {
        this.#snapshot = before; this.#threads = previousThreads; this.#pendingThreadLeases.push(lease);
        this.#set({ state: "uncertain", error: "终端线程切换待核对：" + (error as Error).message }); throw error;
      }
    }
    this.#reconcile(thread); await this.#save(); this.#emit();
  }
  terminalInput(data: string, generation: number) {
    if (generation !== this.#ownerGeneration || this.#snapshot.surface !== "tui" || this.#snapshot.state === "switching" || this.#snapshot.state === "stopped") throw new Error("旧终端已失去输入权，请刷新当前会话。");
    if (!this.#terminalConnected) throw new Error("Codex连接已中断，请先恢复原线程，输入尚未发送。");
    this.#terminal.write(data);
  }
  terminalResize(cols: number, rows: number, generation: number) {
    if (generation !== this.#ownerGeneration || this.#snapshot.surface !== "tui") throw new Error("终端执行权已变化。");
    this.#terminal.resize(cols, rows);
  }
  async insertDraft(text: string, check=()=>{}) {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text)>60_000) throw new Error("请求为空或超过终端输入预算，请使用固定引用分块交接。");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("请求包含终端控制字符，未插入输入框。");
    if (this.#transition || this.#sending) throw new Error("会话正在切换或投递，请稍后核对。");
    this.#sending=true;
    try{
      await this.start();
      if (this.#snapshot.state !== "ready" || this.#snapshot.requests?.length) throw new Error("请先结束当前轮次并处理待答请求，再插入新的请求草稿。");
      if(this.#snapshot.surface==="tui")await this.#terminal.readyForInput();
      check();
      const generation=this.#ownerGeneration;
      const draft=this.#snapshot.surface==="gui"&&this.#snapshot.draft?.trim()?this.#snapshot.draft+"\n\n"+text:text;
      await this.updateDraft(draft);
      check();
      if(generation!==this.#ownerGeneration)throw new Error("终端已重新连接，草稿已保留但未插入。");
      if (this.#snapshot.surface === "tui") this.#terminal.write("\u001b[200~" + text + "\u001b[201~");
      return this.snapshot();
    }finally{this.#sending=false;}
  }
  async updateDraft(text: string, refs?: AgentContextRef[], expected?:{surface?:AgentSurface;generation?:number}) {
    if (typeof text !== "string" || text.length > 512_000) throw new Error("草稿超过本机保存预算。");
    await this.load();
    if(expected&&(expected.surface!==undefined&&expected.surface!==this.#snapshot.surface||expected.generation!==undefined&&expected.generation!==this.#ownerGeneration))throw new Error("输入界面已切换，旧草稿未覆盖当前输入。");
    this.#snapshot.draft_version=(this.#snapshot.draft_version??0)+1;this.#snapshot.draft = text;
    this.#snapshot[this.#snapshot.surface==="gui"?"gui_draft":"tui_draft"]=text;
    if (refs) this.#snapshot.context_refs = validateContextRefs(refs);
    await this.#save(); this.#emit(); return this.snapshot();
  }
  async rename(title: string) { if (typeof title !== "string" || !title.trim() || title.length > 100) throw new Error("会话名称需为1～100字。"); this.#snapshot.title = title.trim(); await this.#save(); this.#emit(); return this.snapshot(); }
  async models() { await this.start(); return this.#rpc!.request("model/list", { includeHidden: false }); }
  async stop() {
    if (this.#starting) await this.#starting.catch(() => undefined);
    this.#closed = true;
    await this.#terminal.close();
    await this.#terminalBridge?.close(); this.#terminalBridge = undefined;
    await this.#rpc?.close(); this.#rpc = undefined;
    ++this.#generation; ++this.#ownerGeneration;
    if (this.#held) { await this.#lease.release(); this.#held = false; }
    await this.#threadLease?.release(); this.#threadLease = undefined;
    for (const lease of this.#pendingThreadLeases) await lease.release(); this.#pendingThreadLeases = [];
    for (const message of this.#snapshot.messages) if (message.delivery === "written" || message.delivery === "prepared") message.delivery = "unknown";
    this.#set({ state: "stopped", pending_request: undefined, requests: [], turn_id: undefined });
    await this.#save(); return this.snapshot();
  }
  #set(patch: Partial<SessionSnapshot>) { this.#snapshot = { ...this.#snapshot, ...patch, updated_at: now() }; this.#emit(); }
  #emit() { const state={generation:this.#ownerGeneration,surface:this.#snapshot.surface,terminal:this.#terminalConnected};const replay=state.surface==="tui"&&(!this.#lastEmission||state.generation!==this.#lastEmission.generation||state.surface!==this.#lastEmission.surface||state.terminal!==this.#lastEmission.terminal);this.#lastEmission=state;this.#options.emit({ type: "snapshot", snapshot: this.snapshot(replay) }); }
  #saveBackground() { void this.#save().catch(error => this.#set({ state: "uncertain", error: "本机会话保存失败：" + error.message })); }
  async #save() {
    const record: CodexRecord = { schema_version: 1, client:"codex", cwd: this.#options.cwd, session_id: this.#snapshot.session_id, title: this.#snapshot.title, work_ref: this.#snapshot.work_ref, surface: this.#snapshot.surface, thread_id: this.#snapshot.thread_id, messages: structuredClone(this.#snapshot.messages), tools: structuredClone(this.#snapshot.tools), draft: this.#snapshot.draft, gui_draft:this.#snapshot.gui_draft,tui_draft:this.#snapshot.tui_draft,draft_version:this.#snapshot.draft_version, context_refs: this.#snapshot.context_refs, model: this.#snapshot.model, reasoning_effort: this.#snapshot.reasoning_effort, threads: structuredClone(Object.fromEntries(this.#threads)), updated_at: now() };
    this.#persisting = this.#persisting.then(() => atomicJson(this.#record, record), () => atomicJson(this.#record, record));
    await this.#persisting;
  }
  #reconcile(thread: any) {
    if (!thread || thread.id !== this.#snapshot.thread_id) throw new Error("原线程读取不一致。");
    this.#sequence=Math.max(this.#sequence,...this.#snapshot.messages.map(item=>item.sequence??0),...(this.#snapshot.tools??[]).map(item=>item.sequence??0));
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const active = turns.findLast((turn: any) => turn.status === "inProgress");
    for (const turn of turns) for (const item of turn.items ?? []) this.#item(item, turn.id, item.status!=="inProgress",true);
    if (active) this.#set({ state: "running", turn_id: active.id });
    else if (!this.#snapshot.messages.some(message => message.delivery === "unknown")) this.#set({ state: "ready", turn_id: undefined, error: undefined });
    else this.#set({ state: "uncertain", error: "仍有投递结果无法与原轮次对应，请核对线程历史，不要重复发送。" });
  }
  #message(value: CodexWireMessage) {
    if (this.#closed || !value.method) return;
    const params = value.params ?? {};
    if (params.threadId && this.#snapshot.thread_id && params.threadId !== this.#snapshot.thread_id) return;
    const turnId = params.turnId ?? params.turn?.id;
    if (value.id !== undefined) {
      const request: AgentRequest = { id: value.id, method: value.method, params, turn_id: turnId, generation: this.#requestGeneration };
      this.#snapshot.requests = [...(this.#snapshot.requests ?? []).filter(item => item.id !== request.id), request];
      this.#set({ pending_request: this.#snapshot.requests[0] }); return;
    }
    if (value.method === "serverRequest/resolved") {
      this.#snapshot.requests = (this.#snapshot.requests ?? []).filter(request => request.id !== params.requestId);
      this.#set({ pending_request: this.#snapshot.requests[0] });
    }
    if (value.method === "turn/started") this.#set({ state: "running", turn_id: turnId, error: undefined });
    if (value.method === "item/started" || value.method === "item/completed") this.#item(params.item, turnId, value.method === "item/completed");
    if (value.method === "item/agentMessage/delta") {
      const id = params.itemId ?? "assistant-" + turnId;
      let message = this.#snapshot.messages.find(message => message.item_id === id);
      if (!message) { message = { id: randomUUID(), role: "assistant", text: "", at: now(), item_id: id, turn_id: turnId,sequence:++this.#sequence }; this.#snapshot.messages.push(message); }
      message.text += typeof params.delta === "string" ? params.delta : "";
      this.#options.emit({ type: "delta", text: params.delta ?? "", session_id: this.#snapshot.session_id });
      this.#emit(); this.#saveBackground();
    }
    if (value.method.endsWith("/outputDelta")) {
      const tool = this.#snapshot.tools?.find(tool => tool.id === params.itemId);
      if (tool) { tool.output = ((tool.output ?? "") + (params.delta ?? "")).slice(-128_000); this.#emit(); }
    }
    if (["turn/completed", "turn/failed", "turn/cancelled"].includes(value.method)) {
      if (!this.#snapshot.turn_id || !turnId || turnId === this.#snapshot.turn_id) this.#set({ state: "ready", turn_id: undefined, pending_request: undefined, requests: [], error: params.turn?.error?.message });
      this.#saveBackground();
    }
    this.#options.emit({ type: "notification", method: value.method, params, session_id: this.#snapshot.session_id,...(this.#snapshot.work_ref?{work_ref:structuredClone(this.#snapshot.work_ref)}:{}) });
  }
  #item(item: any, turn: string, complete: boolean,historical=false) {
    if (!item || typeof item.id !== "string") return;
    if (item.type === "agentMessage") {
      const previous = this.#snapshot.messages.find(message => message.item_id === item.id);
      if (previous) { previous.sequence??=++this.#sequence;if (typeof item.text === "string" && item.text.length >= previous.text.length) previous.text = item.text; }
      else this.#snapshot.messages.push({ id: randomUUID(), role: "assistant", text: item.text ?? "", at: now(), item_id: item.id, turn_id: turn,sequence:++this.#sequence });
    } else if (item.type === "userMessage") {
      const text = (item.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
      const previous = this.#snapshot.messages.find(message => message.item_id === item.id || message.role === "user" && (message.turn_id === turn || !message.turn_id && message.input_sha256 === createHash("sha256").update(text).digest("hex")));
      if (previous) { const unconfirmed=["prepared","written","unknown"].includes(previous.delivery??"");previous.sequence??=++this.#sequence;previous.item_id = item.id; previous.turn_id = turn; previous.delivery = "accepted";if(unconfirmed)this.#consumeGuiDraft(previous); }
      else this.#snapshot.messages.push({ id: randomUUID(), role: "user", text, at: now(), item_id: item.id, turn_id: turn, delivery: "accepted",sequence:++this.#sequence });
      if (this.#snapshot.title === "新对话" && text.trim()) this.#snapshot.title = text.trim().slice(0, 40);
      if(!historical&&!previous&&this.#snapshot.surface==="tui"){this.#snapshot.draft="";this.#snapshot.tui_draft="";}
    } else if (!["reasoning", "plan"].includes(item.type)) {
      const existing = this.#snapshot.tools!.find(previous => previous.id === item.id);
      const failed=item.status==="failed"||item.exitCode&&item.exitCode!==0||item.result?.isError===true||item.result?.structuredContent?.status==="failed";
      const tool: AgentTool = { id: item.id, turn_id: turn, kind: item.type,server:item.server,name:item.tool,title: item.command ?? (item.tool ? `${item.server ?? ""} ${item.tool}`.trim() : item.type), state: complete ? failed ? "failed" : "completed" : "running", input: limited(item.arguments ?? item.changes ?? item.command), output: limited(item.result ?? item.aggregatedOutput ?? item.error),sequence:existing?.sequence??++this.#sequence,started_at:existing?.started_at??(!historical?now():undefined),completed_at:existing?.completed_at??(complete&&!historical?now():undefined),...(typeof item.durationMs==="number"?{duration_ms:item.durationMs}:{}) };
      if (existing) Object.assign(existing, tool); else this.#snapshot.tools!.push(tool);
    }
    this.#emit(); this.#saveBackground();
  }
  #consumeGuiDraft(message:SessionSnapshot["messages"][number]){
    if(message.draft_version===undefined||message.draft_version!==(this.#snapshot.draft_version??0)||this.#snapshot.gui_draft!==message.text)return;
    this.#snapshot.gui_draft="";if(this.#snapshot.surface==="gui")this.#snapshot.draft="";
  }
}
