import {mkdir,readFile,stat} from "node:fs/promises";
import path from "node:path";
import type {WorkRef} from "@hetu/plugin-sdk";
import type {AgentContextRef,AgentSessionEvent,AgentSurface,SessionLaunch,SessionSnapshot} from "../../agent-session-contract.ts";
import {CodexTerminal as PtyProcess} from "./codex-terminal.ts";
import {atomicJson,loadRecord,recordPath,validateContextRefs} from "./session-storage.ts";
import {SessionLease} from "./session-lease.ts";
import {engineName,resolveEngine} from "./engines.ts";
import {prepareBusinessContext} from "./business-context.ts";

/** 原生CLI只承接真实PTY；不从终端文字推断模型轮次、线程或作品保存。 */
export class ProcessSession {
  #terminal=new PtyProcess();#snapshot:SessionSnapshot;#generation=0;#loaded=false;#lease:SessionLease;#held=false;#starting?:Promise<SessionSnapshot>;#saving=Promise.resolve();
  private options:{id:string;launch:SessionLaunch;work?:WorkRef;cwd:string;profile:string;machineDirectory?:string;machineMcpBinary?:string;machineNodeBinary?:string;machineRelay?:string;emit(event:AgentSessionEvent):void};
  constructor(options:ProcessSession["options"]){
    this.options=options;
    this.#lease=new SessionLease(options.profile,recordPath(options.profile,options.work,options.id));
    this.#snapshot={session_id:options.id,client:options.launch.client,title:options.launch.title??engineName(options.launch.client),work_ref:options.work,surface:"tui",state:"idle",messages:[],updated_at:new Date().toISOString(),capabilities:{terminal:true,steer:false,models:false,chat:false}};
  }
  snapshot(includeReplay=true):SessionSnapshot{return {...structuredClone(this.#snapshot),generation:this.#generation,terminal_connected:this.#terminal.connected,terminal_sequence:this.#terminal.sequence,...(includeReplay?{terminal_replay:this.#terminal.replay}:{})};}
  async load(){if(this.#loaded)return this.snapshot();const saved=await loadRecord(recordPath(this.options.profile,this.options.work,this.options.id),this.options.work,this.options.cwd);if(saved){if(saved.client!==this.options.launch.client)throw Error("终端引擎与原记录不一致。");this.#snapshot={...this.#snapshot,...saved,client:saved.client,state:"idle"};}this.#loaded=true;return this.snapshot();}
  async start(){if(this.#starting)return this.#starting;this.#starting=this.#start();try{return await this.#starting;}finally{this.#starting=undefined;}}
  async #start(){
    if(this.#terminal.connected)return this.snapshot();await this.load();
    if(!this.#held){await this.#lease.acquire();this.#held=true;}
    this.#set({state:"starting",error:undefined});++this.#generation;
    try{
      const command=await resolveEngine(this.options.launch.client,this.options.machineMcpBinary?path.dirname(this.options.machineMcpBinary):undefined);
      await mkdir(this.options.cwd,{recursive:true,mode:0o700});
      const args:string[]=[];const client=this.options.launch.client;
      if(client==="shell"&&process.platform!=="win32")args.push("-i");
      if(client==="opencode")args.push("--standalone");
      if(client!=="shell"&&this.options.machineMcpBinary&&this.options.machineDirectory&&this.options.machineNodeBinary&&this.options.machineRelay){
        const business=await prepareBusinessContext({client,cwd:this.options.cwd,binary:this.options.machineMcpBinary,directory:this.options.machineDirectory,work:this.options.work,node:this.options.machineNodeBinary,relay:this.options.machineRelay});
        args.push(...business.args);Object.assign(command.env,business.env);
      }
      const generation=this.#generation;
      this.#terminal.startProcess({...command,args,cwd:this.options.cwd,onData:data=>{if(generation===this.#generation)this.options.emit({type:"terminal",session_id:this.options.id,generation,sequence:this.#terminal.sequence,data});},onExit:()=>{if(generation===this.#generation){this.#set({state:"stopped",error:undefined});void this.#save();}}});
      await this.#lease.update(this.#terminal.pid);
      if(!this.#terminal.connected)throw Error(engineName(client)+"已退出，请在原会话中重试。");
      this.#set({state:"ready"});await this.#save();return this.snapshot();
    }catch(error){await this.#terminal.close();this.#set({state:"failed",error:(error as Error).message});await this.#lease.release();this.#held=false;throw error;}
  }
  terminalInput(data:string,generation:number){if(generation!==this.#generation||!this.#terminal.connected)throw Error("终端已切换或退出，旧输入未发送。");this.#terminal.write(data);}
  terminalResize(cols:number,rows:number,generation:number){if(generation!==this.#generation)throw Error("终端执行权已变化。");this.#terminal.resize(cols,rows);}
  async insertDraft(text:string,check=()=>{}){
    if(this.#snapshot.client==="shell")throw Error("请先创建Agent终端，再放入创作请求。");
    if(typeof text!=="string"||!text.trim()||Buffer.byteLength(text)>60_000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw Error("请求为空、超出预算或包含控制字符。");
    await this.start();check();await this.updateDraft(text);check();return this.snapshot();
  }
  async pasteDraft(version:number){
    const text=this.#snapshot.draft;
    if(version!==this.#snapshot.draft_version||!text)throw Error("创作请求已变化，请重新查看。");
    if(Buffer.byteLength(text)>60_000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw Error("创作请求超过预算或包含控制字符。");
    this.#terminal.write("\u001b[200~"+text+"\u001b[201~");return this.updateDraft("");
  }
  async updateDraft(text:string,refs?:AgentContextRef[],expected?:{surface?:AgentSurface;generation?:number}){if(typeof text!=="string"||text.length>512_000)throw Error("草稿超过保存预算。");if(expected?.generation!==undefined&&expected.generation!==this.#generation)throw Error("旧终端草稿未覆盖当前输入。");this.#set({draft:text,tui_draft:text,draft_version:(this.#snapshot.draft_version??0)+1,...(refs?{context_refs:validateContextRefs(refs)}:{})});await this.#save();return this.snapshot();}
  async rename(title:string){if(typeof title!=="string"||!title.trim()||title.length>100)throw Error("会话名称需为1～100字。");this.#set({title:title.trim()});await this.#save();return this.snapshot();}
  async switchSurface(surface:AgentSurface){if(surface!=="tui")throw Error("此引擎使用原生终端。");return this.snapshot();}
  async interrupt(){this.#terminal.write("\u0003");return this.snapshot();}
  async stop(){if(this.#starting)await this.#starting.catch(()=>{});await this.#terminal.close();++this.#generation;if(this.#held){await this.#lease.release();this.#held=false;}this.#set({state:"stopped"});await this.#save();return this.snapshot();}
  async recover(){return this.snapshot();}
  async readTools(){
    const file=path.join(this.options.cwd,"receipts.json");
    try{if((await stat(file)).size>2_000_000)throw Error("成果回执超过预算，请在作品中核对。");const tools=JSON.parse(await readFile(file,"utf8"));if(!Array.isArray(tools)||tools.length>64)throw Error("成果回执无效。");return tools;}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
  }
  async models(){return {data:[]};}
  async send():Promise<SessionSnapshot>{throw Error("请在原生终端中发送。");}
  async respond():Promise<void>{throw Error("请在原生终端中处理请求。");}
  #set(value:Partial<SessionSnapshot>){this.#snapshot={...this.#snapshot,...value,updated_at:new Date().toISOString()};this.options.emit({type:"snapshot",snapshot:this.snapshot()});}
  async #save(){const record={...this.#snapshot,schema_version:1,cwd:this.options.cwd};this.#saving=this.#saving.then(()=>atomicJson(recordPath(this.options.profile,this.options.work,this.options.id),record));await this.#saving;}
}
