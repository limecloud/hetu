import path from "node:path";
import { readFile, rename, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { WorkRef } from "@hetu/plugin-sdk";
import type { AgentSessionEvent, AgentSurface,SessionLaunch } from "../../agent-session-contract.ts";
import { agentSessionSandbox } from "./context.ts";
import { CodexSession } from "./codex-session.ts";
import {ProcessSession} from "./process-session.ts";
import { atomicJson, recordPath, defaultSessionId, sessionDirectory } from "./session-storage.ts";

const scopeKey = (work?: WorkRef) => work ? [work.workspace_id, work.kind, work.object_id].join("/") : "library";
export class AgentSessions {
  #sessions = new Map<string, CodexSession|ProcessSession>();
  #selected = new Map<string, string>();
  #loaded?: Promise<void>;
  #loading = new Map<string, Promise<CodexSession|ProcessSession>>();
  #saving = Promise.resolve();
  constructor(privateOptions: { profile: string; machineDirectory?: string; machineMcpBinary?: string; machineNodeBinary?:string;machineRelay?:string;engineGuard?:string; emit: (event: AgentSessionEvent) => void }) { this.options = privateOptions; }
  private options: { profile: string; machineDirectory?: string; machineMcpBinary?: string; machineNodeBinary?:string;machineRelay?:string;engineGuard?:string; emit: (event: AgentSessionEvent) => void };
  isSelected(session:CodexSession|ProcessSession,work?:WorkRef) {return this.#selected.get(scopeKey(work))===session.snapshot(false).session_id;}
  async get(work?: WorkRef, defaultSurface: AgentSurface = "tui", selectedId?: string, choose = false, launch?:SessionLaunch) {
    await this.#load();
    const key = scopeKey(work), id = selectedId ?? this.#selected.get(key) ?? defaultSessionId(work);
    let session = this.#sessions.get(id);
    if (session && scopeKey(session.snapshot().work_ref) !== key) throw new Error("会话不属于当前作品。");
    if (!session) {
      let loading = this.#loading.get(id);
      if (!loading) {
        loading = (async () => {
          let saved:any;
          try{saved=JSON.parse(await readFile(recordPath(this.options.profile,work,id),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
          const config=launch??{client:saved?.client??"codex",surface:saved?.surface??defaultSurface};
          const base=work?agentSessionSandbox(this.options.profile,work):path.join(this.options.profile,"agent-sessions","sandbox","library");
          const created=config.client==="codex"?new CodexSession({...this.options,client:"codex",id,work,defaultSurface:config.surface,cwd:base,launch:config}):new ProcessSession({...this.options,id,work,launch:config,cwd:path.join(base,id)});
          await created.load(); this.#sessions.set(id,created);return created;
        })();
        this.#loading.set(id,loading);
      }
      try { session = await loading; } finally { if(this.#loading.get(id) === loading) this.#loading.delete(id); }
    }
    if (choose || !this.#selected.has(key)) { this.#selected.set(key,id); await this.#saveSelection(); } return session;
  }
  async create(work?: WorkRef, surface: AgentSurface = "tui",launch?:SessionLaunch) {
    const session = await this.get(work, surface, (launch&&launch.client!=="codex"?"terminal-":"codex-") + randomUUID(), true,launch);
    await session.updateDraft("");return session;
  }
  async list(work?: WorkRef) {
    const saved = await sessionDirectory(this.options.profile,work);
    const entries = new Map(saved.map(record=>[record.session_id ?? defaultSessionId(record.work_ref),record]));
    for(const [id,session] of this.#sessions) if(scopeKey(session.snapshot().work_ref)===scopeKey(work)) entries.set(id,session.snapshot() as any);
    return [...entries.entries()].map(([session_id,value])=>({session_id,client:(value as any).client??"codex",title:value.title ?? "对话",updated_at:value.updated_at,state:(value as any).state ?? "idle",surface:value.surface ?? "tui"})).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
  }
  async remove(work: WorkRef | undefined, id: string, surface: AgentSurface) {
    const session = await this.get(work,surface,id);
    if (!["idle","stopped","ready"].includes(session.snapshot().state) || session.snapshot().requests?.length) throw new Error("此会话有运行、未知结果或待答请求，请先核对并停止。");
    await session.stop();
    const directory = path.join(this.options.profile,"agent-sessions","removed");
    await mkdir(directory,{recursive:true,mode:0o700});
    await rename(recordPath(this.options.profile,work,id),path.join(directory,id+"-"+Date.now()+".json"));
    this.#sessions.delete(id);this.#selected.delete(scopeKey(work));
    await this.#saveSelection();
    return this.create(work,surface);
  }
  async #load() {
    if(!this.#loaded) this.#loaded = (async()=>{
      let value:any;
      try {value = JSON.parse(await readFile(path.join(this.options.profile,"agent-sessions","index","selection.json"),"utf8"));}
      catch(error) {if((error as NodeJS.ErrnoException).code === "ENOENT") return;throw new Error("会话选择记录无法读取，已保留原文件。");}
      if(value.schema_version!==1 || !value.selected || typeof value.selected!=="object" || Object.entries(value.selected).some(([key,id])=>key.length>500 || typeof id!=="string" || !/^(codex|terminal)-[a-zA-Z0-9-]{16,64}$/.test(id))) throw new Error("会话选择记录无效，未替换原会话。");
      this.#selected = new Map(Object.entries(value.selected));
    })();
    await this.#loaded;
  }
  async #saveSelection() {
    const value = {schema_version:1,selected:Object.fromEntries(this.#selected)};
    this.#saving = this.#saving.then(()=>atomicJson(path.join(this.options.profile,"agent-sessions","index","selection.json"),value));
    await this.#saving;
  }
  async stopWork(work?: WorkRef) { await Promise.all([...this.#sessions.values()].filter(session=>scopeKey(session.snapshot().work_ref)===scopeKey(work)).map(session=>session.stop())); }
  async stopAll() { await Promise.all([...this.#sessions.values()].map(session=>session.stop())); }
}
