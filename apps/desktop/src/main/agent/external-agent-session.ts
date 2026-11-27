import path from "node:path";
import {mkdir} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import type {WorkRef} from "@hetu/plugin-sdk";
import type {AgentContextRef,AgentSessionEvent,AgentSurface,SessionLaunch,SessionSnapshot} from "../../agent-session-contract.ts";
import type {TerminalBinding,TerminalMethod,TerminalSnapshot} from "../../shared/codex-terminal.ts";
import type {ExternalSessionState} from "../../shared/external-session.ts";
import {externalProvider} from "../../shared/external-ai.ts";
import {StructuredExternalSession} from "./structured-external-session.ts";
import {createConversationDriver} from "./external-conversation-registry.ts";
import {prepareExternalLaunch} from "./external-ai-launch.ts";
import {atomicJson,loadRecord,recordPath,validateContextRefs} from "./session-storage.ts";
import {SessionLease} from "./session-lease.ts";
import {resolveEngine,engineName} from "./engines.ts";
import {isDeepStrictEqual} from "node:util";
import {readSessionToolReceipts} from "./session-tool-receipts.ts";
import {externalSessionDirectory} from "./terminal-workspace-state.ts";

type Options={id:string;launch:SessionLaunch;work?:WorkRef;cwd:string;profile:string;machineDirectory?:string;machineMcpBinary?:string;machineNodeBinary?:string;machineRelay?:string;emit(event:AgentSessionEvent):void};

/** 原协议会话接到现有作品工作面；提供方身份与作品成果分别回读。 */
export class ExternalAgentSession {
  #session?:StructuredExternalSession;
  #record:SessionSnapshot;
  #loaded=false;
  #starting?:Promise<SessionSnapshot>;
  #saving=Promise.resolve();
  #lease:SessionLease;
  #held=false;
  private options:Options;
  constructor(options:Options){this.options=options;
    if(!externalProvider(options.launch.client).structured)throw Error("此引擎没有结构化协议。");
    this.#lease=new SessionLease(options.profile,recordPath(options.profile,options.work,options.id));
    this.#record={session_id:options.id,client:options.launch.client,title:options.launch.title??engineName(options.launch.client),work_ref:options.work,bot_context:options.launch.bot_context,surface:"gui",state:"idle",messages:[],updated_at:new Date().toISOString(),model:options.launch.model,reasoning_effort:options.launch.reasoning_effort,capabilities:{terminal:false,chat:true,steer:false,models:false}};
  }
  #binding():TerminalBinding{return {workspace:this.options.cwd,accessDirectory:this.options.machineDirectory??this.options.profile,title:this.#record.title??engineName(this.options.launch.client),knowledgeBaseId:this.options.work?JSON.stringify(this.options.work):undefined,workRef:this.options.work,localSettings:!this.options.work};}
  snapshot(includeReplay=true):SessionSnapshot{
    const raw=this.#session?.snapshot(includeReplay),conversation=raw?.conversation;
    const state=raw?conversation?({ready:"ready",running:"running",blocked:"running",stopped:raw.connected?"ready":"stopped",unknown:"uncertain"} as const)[conversation.status]:({working:"running",blocked:"running",error:"uncertain",clear:"stopped",idle:"ready"} as const)[raw.program_state as "working"|"blocked"|"error"|"clear"|"idle"]??"stopped":this.#record.state;
    const result:SessionSnapshot={...structuredClone(this.#record),state,generation:raw?.generation??this.#record.generation??0,thread_id:raw?.provider_session_id??this.#record.thread_id,updated_at:this.#record.updated_at,terminal_connected:false,capabilities:{terminal:false,chat:true,steer:false,models:!!conversation?.models.length}};
    if(raw)result.external_state=this.#session!.persistent();
    if(conversation){
      result.external=conversation;
      result.model=conversation.model??result.model;result.reasoning_effort=conversation.effort??result.reasoning_effort;result.error=conversation.error;
      result.messages=conversation.messages.filter(message=>message.role!=="tool"&&!message.channel&&!message.plan).map(message=>({id:message.id,role:message.role as "user"|"assistant"|"system",text:message.role==="user"?((this.#record as any).display_texts?.[createHash("sha256").update(message.text).digest("hex")]??message.text):message.text,at:result.updated_at,turn_id:message.turn_id,item_id:message.provider_item_id}));
      result.tools=conversation.messages.filter(message=>message.tool).map(message=>({id:message.id,turn_id:message.turn_id??"",kind:message.tool!.kind,title:message.tool!.name,state:message.tool!.status==="completed"?"completed":message.tool!.status==="running"?"running":message.tool!.status==="unknown"?"unknown":"failed",input:message.tool!.input,output:message.text}));
    }
    if(((this.#record as any).delivery_records??[]).some((entry:any)=>["prepared","unknown"].includes(entry.state))&&result.state!=="stopped")result.state="uncertain";
    return result;
  }
  async load(){
    if(this.#loaded)return this.snapshot();
    const saved=await loadRecord(recordPath(this.options.profile,this.options.work,this.options.id),this.options.work,this.options.cwd);
    if(saved){if(saved.client!==this.options.launch.client||saved.surface!=="gui")throw Error("原会话引擎或表面不一致，已保留原记录。");this.#record={...this.#record,...saved,state:"idle"} as SessionSnapshot;}
    const previous=(saved as any)?.external_state as ExternalSessionState|undefined;
    const id=previous?.id??this.options.id.replace(/^terminal-/,"");
    const restored=previous??{id:/^[a-f0-9-]{36}$/.test(id)?id:randomUUID(),generation:this.#record.generation??Date.now(),has_started:false,provider_id:this.options.launch.client,mode:"structured"};
    this.#session=new StructuredExternalSession({profile:this.options.profile,id:restored.id,providerId:this.options.launch.client,restored,checkpoint:()=>this.#save(),emit:event=>{
      this.#record.updated_at=new Date().toISOString();this.options.emit({type:"snapshot",snapshot:this.snapshot()});
      if(!event.transient)void this.#save().catch(()=>{this.#record.error="会话记录保存失败，请核对原操作。";this.options.emit({type:"snapshot",snapshot:{...this.snapshot(),state:"uncertain",error:this.#record.error}});});
    },driver:async(directory,binding,event,storage,bindStorage)=>{
      if(!this.options.machineMcpBinary)throw Error("当前制品缺少河图机器入口。");
      const command=await resolveEngine(this.options.launch.client,path.dirname(this.options.machineMcpBinary));
      const launch=await prepareExternalLaunch({providerId:this.options.launch.client,mode:"structured",directory,binding,mcp:this.options.machineMcpBinary,cli:path.join(path.dirname(this.options.machineMcpBinary),process.platform==="win32"?"hetu.exe":"hetu"),node:this.options.machineNodeBinary,relay:this.options.machineRelay,env:command.env,codexBinary:command.binary,binary:command.binary,expectedStorage:storage,bindStorage,installation:value=>event({type:"installation",value}),botContext:this.#record.bot_context});
      return createConversationDriver(externalProvider(this.options.launch.client).structured!.protocol,{...launch,cwd:directory,event});
    }});
    this.#loaded=true;return this.snapshot();
  }
  async start(){if(this.#starting)return this.#starting;const pending=this.#start();this.#starting=pending;try{return await pending;}finally{if(this.#starting===pending)this.#starting=undefined;}}
  async #start(){
    await this.load();if(this.#session!.snapshot(false).connected)return this.snapshot();
    if(!this.#held){await this.#lease.acquire();this.#held=true;}
    try{
      await mkdir(this.options.cwd,{recursive:true,mode:0o700});await this.#save();
      const persistent=this.#session!.persistent();
      await this.#session!.request(persistent.has_started?"reconnect":"start",{},this.#binding());
      await this.#lease.update(this.#session!.persistent().process_id);
      if(this.#record.model)await this.requestExternal("model",{model_id:this.#record.model});
      if(this.#record.reasoning_effort)await this.requestExternal("effort",{effort_id:this.#record.reasoning_effort});
      await this.#save();return this.snapshot();
    }catch(error){await this.#session!.close();await this.#lease.release();this.#held=false;this.#record.error=(error as Error).message;await this.#save();throw error;}
  }
  async requestExternal(method:TerminalMethod,input:Record<string,unknown>={}){
    await this.load();const raw=this.#session!.snapshot(false);
    if(input.generation!==undefined&&input.generation!==raw.generation)throw Error("旧会话代次未执行。");
    const {generation:_,session_id:__,...fields}=input;
    const value=await this.#session!.request(method,{...fields,session_id:raw.session_id,generation:raw.generation});
    if(method==="model"){this.#record.model=String(input.model_id);this.#record.reasoning_effort=value.conversation?.effort;}
    if(method==="effort")this.#record.reasoning_effort=String(input.effort_id);
    await this.#save();return value;
  }
  async send(text:string,displayText=text,options:{attempt_id?:string;model?:string;reasoning_effort?:string;context_refs?:AgentContextRef[];draft_version?:number}={}){
    await this.start();if(!text.trim()||Buffer.byteLength(text)>65536)throw Error("发送内容为空或超过预算。");
    if(options.draft_version!==undefined&&options.draft_version!==this.#record.draft_version)throw Error("草稿已变化，旧请求未发送。");
    const sentDraftVersion=this.#record.draft_version??0;
    const attempt=options.attempt_id??randomUUID(),digest=createHash("sha256").update(JSON.stringify({text,model:options.model??this.#record.model,effort:options.reasoning_effort??this.#record.reasoning_effort,refs:options.context_refs??this.#record.context_refs})).digest("hex");
    const deliveries=((this.#record as any).delivery_records??=[]) as {id:string;sha256:string;state:string}[];
    const prior=deliveries.find(value=>value.id===attempt);
    if(prior){if(prior.sha256!==digest)throw Error("原发送身份不能更换内容或配置。");return this.snapshot();}
    if(deliveries.some(value=>["prepared","unknown"].includes(value.state)))throw Error("原发送结果待核对，不换键重发。");
    if(deliveries.length>=256)throw Error("发送恢复记录已达预算，请保留原会话后继续。");
    const displays=((this.#record as any).display_texts??={});displays[createHash("sha256").update(text).digest("hex")]=displayText;
    const pending={id:attempt,sha256:digest,state:"prepared"};deliveries.push(pending);await this.#save();
    try{
      if(options.model)await this.requestExternal("model",{model_id:options.model});
      if(options.reasoning_effort)await this.requestExternal("effort",{effort_id:options.reasoning_effort});
      await this.requestExternal("send",{data:text});pending.state="accepted";await this.#save();
      if((this.#record.draft_version??0)===sentDraftVersion)await this.updateDraft("",[]);return this.snapshot();
    }catch(error){pending.state="unknown";await this.#save();throw error;}
  }
  async updateDraft(text:string,refs?:AgentContextRef[],expected?:{surface?:AgentSurface;generation?:number}){
    await this.load();if(typeof text!=="string"||text.length>512000)throw Error("草稿超过预算。");
    if(expected?.generation!==undefined&&expected.generation!==this.snapshot().generation||expected?.surface!==undefined&&expected.surface!=="gui")throw Error("旧表面草稿未覆盖当前会话。");
    this.#record.draft=text;this.#record.gui_draft=text;this.#record.draft_version=(this.#record.draft_version??0)+1;
    if(refs!==undefined)this.#record.context_refs=validateContextRefs(refs);await this.#save();return this.snapshot();
  }
  async insertDraft(text:string,check=()=>{}){await this.start();check();return this.updateDraft(text);}
  async attachContext(reference:AgentContextRef,expected:{generation?:number},check=()=>{}){check();if(expected.generation!==undefined&&expected.generation!==this.snapshot().generation)throw Error("旧会话不能附加上下文。");const refs=validateContextRefs([...(this.#record.context_refs??[]),reference]);check();return this.updateDraft(this.#record.draft??"",refs,expected);}
  async removeContext(reference:Record<string,unknown>,expected:{generation?:number}){return this.updateDraft(this.#record.draft??"",(this.#record.context_refs??[]).filter(value=>!isDeepStrictEqual(value.reference,reference)),expected);}
  async pasteDraft():Promise<SessionSnapshot>{throw Error("当前会话使用聊天输入。");}
  async respond(id:string|number,result:unknown,generation?:number){
    const request=this.snapshot().external?.approvals.find(value=>value.id===String(id));
    if(!request||typeof result!=="string"||!request.options.some(option=>option.id===result))throw Error("请回答原会话的当前权限选项。");
    await this.requestExternal("approve",{approval_id:String(id),option_id:result,generation});
  }
  async models(){return {data:(this.snapshot().external?.models??[]).map(model=>({model:model.id,displayName:model.label,supportedReasoningEfforts:(model.efforts??[]).map(effort=>({reasoningEffort:effort.id}))}))};}
  async readTools(){await this.load();return readSessionToolReceipts(externalSessionDirectory(this.options.profile,this.#binding(),this.#session!.persistent().id,this.options.launch.client));}
  async rename(title:string){if(!title.trim()||title.length>100)throw Error("会话名称需为1～100字。");this.#record.title=title.trim();await this.#save();return this.snapshot();}
  async switchSurface(surface:AgentSurface){if(surface!=="gui")throw Error("此协议未提供共享PTY连接，请创建独立终端会话。");return this.snapshot();}
  terminalInput():never{throw Error("当前会话没有PTY输入。");}
  terminalResize():never{throw Error("当前会话没有PTY尺寸。");}
  async interrupt(){await this.requestExternal("interrupt");return this.snapshot();}
  async recover(){await this.load();return this.snapshot();}
  async stop(){if(this.#starting)await this.#starting.catch(()=>{});await this.load();await this.#session!.close();await this.#save();if(this.#held){await this.#lease.release();this.#held=false;}return this.snapshot();}
  async #save(){const projection=this.#session?.snapshot().conversation;if(projection){const rendered=this.snapshot();this.#record.messages=rendered.messages;this.#record.tools=rendered.tools;}const value=structuredClone({...this.#record,external_state:this.#session?.persistent(),input_generation:this.#session?.persistent().generation??0,schema_version:1,cwd:this.options.cwd});this.#saving=this.#saving.then(()=>atomicJson(recordPath(this.options.profile,this.options.work,this.options.id),value));await this.#saving;}
}
