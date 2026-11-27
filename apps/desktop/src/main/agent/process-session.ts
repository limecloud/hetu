import {mkdir} from "node:fs/promises";
import path from "node:path";
import type {WorkRef} from "@hetu/plugin-sdk";
import type {AgentContextRef,AgentSessionEvent,AgentSurface,SessionLaunch,SessionSnapshot} from "../../agent-session-contract.ts";
import {CodexTerminal as PtyProcess} from "./codex-terminal.ts";
import {atomicJson,loadRecord,recordPath,validateContextRefs} from "./session-storage.ts";
import {SessionLease} from "./session-lease.ts";
import {engineName,resolveEngine} from "./engines.ts";
import {externalProvider} from "../../shared/external-ai.ts";
import {resolveExternalStorageBinding} from "./external-storage-binding.ts";
import {canBindExternalStorage} from "../../shared/external-storage-binding.ts";
import {externalEnvironment,prepareExternalLaunch} from "./external-ai-launch.ts";
import {hermesProfileArgs} from "./hermes-profile.ts";
import {readSessionToolReceipts} from "./session-tool-receipts.ts";

/** 原生CLI只承接真实PTY；不从终端文字推断模型轮次、线程或作品保存。 */
export class ProcessSession {
  #terminal=new PtyProcess();#snapshot:SessionSnapshot;#generation=0;#loaded=false;#lease:SessionLease;#held=false;#starting?:Promise<SessionSnapshot>;#saving=Promise.resolve();
  private options:{id:string;launch:SessionLaunch;work?:WorkRef;cwd:string;profile:string;machineDirectory?:string;machineMcpBinary?:string;machineNodeBinary?:string;machineRelay?:string;emit(event:AgentSessionEvent):void};
  constructor(options:ProcessSession["options"]){
    this.options=options;
    this.#lease=new SessionLease(options.profile,recordPath(options.profile,options.work,options.id));
    this.#snapshot={session_id:options.id,client:options.launch.client,title:options.launch.title??engineName(options.launch.client),model:options.launch.model,bot_context:options.launch.bot_context,work_ref:options.work,surface:"tui",state:"idle",messages:[],updated_at:new Date().toISOString(),capabilities:{terminal:true,steer:false,models:false,chat:false}};
  }
  snapshot(includeReplay=true):SessionSnapshot{return {...structuredClone(this.#snapshot),generation:this.#generation,terminal_connected:this.#terminal.connected,terminal_sequence:this.#terminal.sequence,...(includeReplay?{terminal_replay:this.#terminal.replay}:{})};}
  async load(){if(this.#loaded)return this.snapshot();const saved=await loadRecord(recordPath(this.options.profile,this.options.work,this.options.id),this.options.work,this.options.cwd);if(saved){if(saved.client!==this.options.launch.client)throw Error("终端引擎与原记录不一致。");const {input_generation,request_generation,...projection}=saved;this.#generation=input_generation??Date.now();this.#snapshot={...this.#snapshot,...projection,client:saved.client,state:"idle"};}this.#loaded=true;return this.snapshot();}
  async start(){if(this.#starting)return this.#starting;this.#starting=this.#start();try{return await this.#starting;}finally{this.#starting=undefined;}}
  async #start(){
    if(this.#terminal.connected)return this.snapshot();await this.load();
    if(!Number.isSafeInteger(this.#generation+1))throw Error("终端输入代次已达上限，已保留原记录。");
    if(!this.#held){await this.#lease.acquire();this.#held=true;}
    try{
      this.#generation=Math.max(this.#generation+1,Date.now());await this.#save();this.#set({state:"starting",error:undefined});
      const command=await resolveEngine(this.options.launch.client,this.options.machineMcpBinary?path.dirname(this.options.machineMcpBinary):undefined);
      await mkdir(this.options.cwd,{recursive:true,mode:0o700});
      const args:string[]=[];const client=this.options.launch.client;
      if(client==="shell"&&process.platform!=="win32")args.push("-i");
      if(client!=="shell"){
        command.env=externalEnvironment(command.env);
        const previous=this.#snapshot.storage_binding;
        if(this.options.machineMcpBinary&&this.options.machineDirectory&&this.options.machineNodeBinary&&this.options.machineRelay){
          const launch=await prepareExternalLaunch({providerId:client,mode:"tui",directory:this.options.cwd,binding:{workspace:this.options.cwd,accessDirectory:this.options.machineDirectory,title:this.#snapshot.title??engineName(client),workRef:this.options.work,localSettings:!this.options.work},mcp:this.options.machineMcpBinary,cli:path.join(path.dirname(this.options.machineMcpBinary),process.platform==="win32"?"hetu.exe":"hetu"),node:this.options.machineNodeBinary,relay:this.options.machineRelay,binary:command.binary,codexBinary:command.binary,env:command.env,expectedStorage:previous,bindStorage:async storage=>{this.#snapshot.storage_binding=storage;await this.#save();},botContext:this.#snapshot.bot_context});
          args.push(...launch.args);command.env=launch.env;
        }else{
          const storage=await resolveExternalStorageBinding(client,command.binary,command.env,previous?.profile);
          if(previous&&!canBindExternalStorage(previous,storage))throw Error("原终端的引擎或存储目录已变化，未启动替代会话。");
          this.#snapshot.storage_binding=storage;await this.#save();
          args.push(...(externalProvider(client).args??[]));
          if(storage.profile){command.env.HERMES_HOME=storage.profile.selected;args.push(...hermesProfileArgs(storage.profile));}
        }
      }
      if(this.#snapshot.model){const flags=client!=="shell"?externalProvider(client).modelArgs:undefined;if(!flags)throw Error("此引擎尚无固定模型的原生启动合同，请使用聊天会话。");args.push(...flags,this.#snapshot.model);}
      if(client==="claude-agent-teams")command.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1";
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
  async updateDraft(text:string,refs?:AgentContextRef[],expected?:{surface?:AgentSurface;generation?:number}){if(typeof text!=="string"||text.length>512_000)throw Error("草稿超过保存预算。");if(expected?.generation!==undefined&&expected.generation!==this.#generation)throw Error("旧终端草稿未覆盖当前输入。");const contexts=refs===undefined?undefined:validateContextRefs(refs);this.#set({draft:text,tui_draft:text,draft_version:(this.#snapshot.draft_version??0)+1,...(contexts?{context_refs:contexts}:{})});await this.#save();return this.snapshot();}
  async rename(title:string){if(typeof title!=="string"||!title.trim()||title.length>100)throw Error("会话名称需为1～100字。");this.#set({title:title.trim()});await this.#save();return this.snapshot();}
  async switchSurface(surface:AgentSurface){if(surface!=="tui")throw Error("此引擎使用原生终端。");return this.snapshot();}
  async interrupt(){this.#terminal.write("\u0003");return this.snapshot();}
  async stop(){if(this.#starting)await this.#starting.catch(()=>{});if(!this.#held&&!this.#terminal.connected&&this.#snapshot.state==="stopped")return this.snapshot();await this.#terminal.close();if(Number.isSafeInteger(this.#generation+1))++this.#generation;this.#set({state:"stopped"});await this.#save();if(this.#held){await this.#lease.release();this.#held=false;}return this.snapshot();}
  async recover(){return this.snapshot();}
  readTools(){return readSessionToolReceipts(this.options.cwd);}
  async models(){return {data:[]};}
  async send():Promise<SessionSnapshot>{throw Error("请在原生终端中发送。");}
  async respond():Promise<void>{throw Error("请在原生终端中处理请求。");}
  #set(value:Partial<SessionSnapshot>){this.#snapshot={...this.#snapshot,...value,updated_at:new Date().toISOString()};this.options.emit({type:"snapshot",snapshot:this.snapshot()});}
  async #save(){const record={...this.#snapshot,input_generation:this.#generation,schema_version:1,cwd:this.options.cwd};this.#saving=this.#saving.then(()=>atomicJson(recordPath(this.options.profile,this.options.work,this.options.id),record));await this.#saving;}
}
