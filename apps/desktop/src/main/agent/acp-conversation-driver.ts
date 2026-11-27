import {JsonLineProcess} from "./json-line-process.ts";
import {randomUUID} from "node:crypto";
import type {ConversationEvent,ExternalConversationDriver} from "./external-conversation-driver.ts";
import type {ExternalImageAttachment} from "../../shared/external-attachment.ts";
import type {ExternalModel,ExternalConfigurationOption} from "../../shared/external-session.ts";
import {acpModelConfiguration,acpConfiguredModels,acpAdditionalConfiguration,type AcpModelConfiguration} from "./acp-model-configuration.ts";
import {AcpSessionProjection} from "./acp-session-projection.ts";
import {boundedExternalMessage} from "../../shared/external-message.ts";
import {AcpElicitationRequests,validAcpRequestId} from "./acp-elicitation-requests.ts";
import desktopPackage from "../../../package.json" with {type:"json"};
import {boundedExternalCommands,externalCommandText,type ExternalCommandCatalog} from "../../shared/external-command.ts";
import {acpProtocolDialect,isAcpDialectForm} from "./acp-protocol-dialect.ts";
import type {ExternalElicitationResponse} from "../../shared/external-elicitation.ts";
import type {AcpTurnReport} from "./acp-turn-report.ts";
import type {AcpLaunchPreparation} from "./acp-launch-preparation.ts";

type Options={binary:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;mcpServer:{command:string;args:string[]};instructions?:string;acp?:AcpLaunchPreparation;event(value:ConversationEvent):void};
/** ACP适配只开放已实现的宿主能力；文件和终端由外部提供方自己的工具执行。 */
export class AcpConversationDriver implements ExternalConversationDriver {
  readonly capabilities={questions:false,context:false,compact:false,images:false,elicitations:true,commands:true};
  #connection?:JsonLineProcess;#sessionId?:string;#models:ExternalModel[]=[];#selectedModel?:string;#approvals=new Map<string,{id:string|number;options:string[]}>();#opening:any[]=[];#openingBytes=0;
  #projection=new AcpSessionProjection();#running?:string;#loading=false;#disposed=false;#failed=false;
  #turnOutput=false;
  #turnFacts=new Map<string,{failure?:string;cancelled?:boolean;ended:boolean}>();
  #commandCatalog:ExternalCommandCatalog={revision:0,reported:false,commands:[]};
  #dialect=acpProtocolDialect(undefined);
  #elicitations?:AcpElicitationRequests;#source="ACP提供方";
  #config:AcpModelConfiguration={};#legacyModels:ExternalModel[]=[];
  #configurationOptions:ExternalConfigurationOption[]=[];#modes?:{current:string;choices:{id:string;label:string}[]};#configuredMode=false;#modeRevision=0;
  private options:Options;
  constructor(options:Options){this.options=options;}
  get connected(){return this.#connection?.connected??false;}
  get processId(){return this.#connection?.processId;}
  get sessionId(){return this.#sessionId;}
  get models(){return this.#models;}
  get commandCatalog(){return structuredClone(this.#commandCatalog);}
  get configuration(){return [...this.#configurationOptions,...(this.#modes&&!this.#configuredMode?[{id:"session:mode",label:"运行模式",value:this.#modes.current,choices:this.#modes.choices}]:[])];}
  async open(resumeId?:string){
    this.#connection=new JsonLineProcess({...this.options,message:value=>this.#message(value),closed:error=>{this.#finish("unknown");this.#elicitations?.clear();this.options.event({type:"closed",error:error?.message});}});
    this.#elicitations=new AcpElicitationRequests(this.#connection,this.options.event);
    try{
      const initialized=await this.#connection.request("initialize",{protocolVersion:1,clientInfo:{name:"hetu",version:desktopPackage.version},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false,session:{configOptions:{boolean:{}}},elicitation:{form:{},url:{}},...(this.options.acp?.clientMetadata?{_meta:this.options.acp.clientMetadata}:{})}},30000,"rpc",value=>{this.#dialect=acpProtocolDialect(value);});
      if(initialized.protocolVersion!==1)throw Error("提供方ACP协议版本不兼容。");
      this.#dialect=acpProtocolDialect(initialized);
      this.capabilities.images=initialized.agentCapabilities?.promptCapabilities?.image===true;
      const source=initialized.agentInfo?.title??initialized.agentInfo?.name;if(typeof source==="string"&&source.length>0&&source.length<=255&&!/[\x00-\x1f\x7f]/.test(source))this.#source=source;
      if(resumeId&&!initialized.agentCapabilities?.loadSession)throw Error("提供方未声明加载会话能力，没有启动新会话。");
      const metadata=this.options.acp?.sessionMetadata?this.options.acp.sessionMetadata(initialized,!!resumeId):!resumeId&&this.options.instructions?this.#dialect.sessionMetadata?.(this.options.instructions):undefined;
      const scope={cwd:this.options.cwd,mcpServers:[{name:"hetu",command:this.options.mcpServer.command,args:this.options.mcpServer.args,env:[]}],...(metadata?{_meta:metadata}:{})};
      this.#loading=true;this.#projection.begin("acp-load-"+randomUUID(),true);
      if(resumeId)this.#sessionId=resumeId;
      await this.#connection.request(resumeId?"session/load":"session/new",{...scope,...(resumeId?{sessionId:resumeId}:{})},30000,"rpc",value=>{
        if(!resumeId&&typeof value.sessionId!=="string"||resumeId&&value.sessionId!==undefined&&value.sessionId!==resumeId)throw Error("提供方未返回固定ACP会话身份。");
        this.#sessionId=resumeId??value.sessionId;this.options.event({type:"identity",id:this.#sessionId!});
        for(const message of this.#opening)this.#message(message);this.#opening=[];this.#openingBytes=0;
        this.#legacyModels=(value.models?.availableModels??[]).filter((model:any)=>typeof model.modelId==="string"&&model.modelId.length<=255).slice(0,128).map((model:any)=>({id:model.modelId,label:String(model.name??model.modelId).slice(0,128)}));
        this.#selectedModel=value.models?.currentModelId;
        this.#configuration(value.configOptions);
        if(value.modes){
          const modes=value.modes;
          if(typeof modes.currentModeId!=="string"||!Array.isArray(modes.availableModes)||modes.availableModes.length>128||modes.availableModes.some((mode:any)=>typeof mode.id!=="string"||!mode.id||mode.id.length>255||typeof mode.name!=="string"||mode.name.length>255))throw Error("ACP运行模式目录无效。");
          this.#modes={current:modes.currentModeId,choices:modes.availableModes.map((mode:any)=>({id:mode.id,label:mode.name}))};
        }
        this.#loading=false;this.#finish("unknown");
      });
      if(this.#failed)throw Error("ACP在加载期间报告了无效事件。");
    }catch(error){await this.close();throw error;}
  }
  #configuration(value:unknown){
    this.#config=acpModelConfiguration(value);this.#models=acpConfiguredModels(this.#config,this.#legacyModels);
    this.#configurationOptions=acpAdditionalConfiguration(value);
    this.#configuredMode=Array.isArray(value)&&value.some(row=>row?.category==="mode"&&row.type==="select");
    if(this.#config.model)this.#selectedModel=this.#config.model.current;
  }
  async configure(id:string,value:string|boolean){
    if(!this.#connection||!this.#sessionId)throw Error("ACP会话尚未连接。");
    const option=this.configuration.find(option=>option.id===id);
    if(!option||typeof value!==typeof option.value||typeof value==="string"&&!option.choices?.some(choice=>choice.id===value))throw Error("ACP配置或选项已变化。");
    if(id==="session:mode"){
      const revision=this.#modeRevision;
      await this.#connection.request("session/set_mode",{sessionId:this.#sessionId,modeId:value},30000,"rpc",()=>{if(revision===this.#modeRevision)this.#modes!.current=value as string;});
      if(this.#modes!.current!==value)throw Error("ACP尚未报告实际运行模式，请核对原会话。");
    }else{
      await this.#connection.request("session/set_config_option",{sessionId:this.#sessionId,configId:id.slice(7),value,...(typeof value==="boolean"?{type:"boolean"}:{})},30000,"rpc",response=>{
        if(!Array.isArray(response?.configOptions))throw Error("ACP没有回读配置变更结果。");this.#configuration(response.configOptions);
      });
      if(this.configuration.find(option=>option.id===id)?.value!==value)throw Error("ACP实际配置与选择不一致，请核对原会话。");
    }
    this.options.event({type:"catalog"});
  }
  async #writeOption(id:string,value:string){
    await this.#connection!.request("session/set_config_option",{sessionId:this.#sessionId,configId:id,value},30000,"rpc",response=>{
      if(!Array.isArray(response?.configOptions))throw Error("ACP没有回读配置变更结果，请核对原会话。");this.#configuration(response.configOptions);
    });
    const option=[this.#config.model,this.#config.effort].find(option=>option?.id===id);
    if(option?.current!==value)throw Error("ACP返回的实际配置与本次选择不同，请核对原会话。");
    this.options.event({type:"catalog"});
  }
  #message(value:any){
    value=this.#dialect.normalize(value);
    const p=value.params??{};
    if(this.#disposed||this.#failed)return;
    if(!this.#sessionId&&["elicitation/create","elicitation/complete","$/cancel_request"].includes(value.method)){
      this.#queueOpening(value);return;
    }
    if(Object.hasOwn(p,"sessionId")&&this.#sessionId&&p.sessionId!==this.#sessionId){if(value.id!==undefined)this.#connection?.send({jsonrpc:"2.0",id:value.id,error:{code:-32602,message:"Session mismatch"}});return;}
    const report=this.#dialect.turnReport?.(value);
    if(report&&!this.#loading){
      if(report.replay)return;
      if(report.id&&report.id!==this.#running){if(report.failure&&this.#turnFacts.get(report.id)?.ended)this.#reportFailure(report.id,report.failure);if(value.id!==undefined)this.#connection?.send({jsonrpc:"2.0",id:value.id,error:{code:-32602,message:"Prompt mismatch"}});return;}
      if(this.#running)this.#applyTurnReport(this.#running,report);
    }
    if(value.id===undefined&&value.method==="$/cancel_request"){
      if(this.#elicitations?.cancel(p.requestId))return;
      const id=String(p.requestId),pending=this.#approvals.get(id);if(pending&&pending.id===p.requestId){this.#connection?.respond(pending.id,{outcome:{outcome:"cancelled"}});this.#approvals.delete(id);this.options.event({type:"interaction_resolved",id});}return;
    }
    if(value.id===undefined&&value.method==="elicitation/complete"){this.#elicitations?.complete(p);return;}
    if(value.id!==undefined&&value.method){
      const id=String(value.id);
      if(!validAcpRequestId(value.id)||this.#approvals.has(id)||this.#elicitations?.has(id)||this.#approvals.size+(this.#elicitations?.size??0)>=16){this.#connection?.send({jsonrpc:"2.0",id:value.id,error:{code:-32602,message:"Invalid or duplicate request identity"}});return;}
      if(value.method==="elicitation/create"&&this.#sessionId){
        try{const form=isAcpDialectForm(value)?this.#dialect.form(p):{params:p,source:this.#source,reply:undefined,provider_item_id:undefined};this.#elicitations!.create(value.id,form.params,form.source??this.#source,form.reply,form.provider_item_id);}
        catch{this.#connection?.send({jsonrpc:"2.0",id:value.id,error:{code:-32602,message:"Unsupported or oversized elicitation request"}});this.options.event({type:"message",message:{id:"acp-form-unsupported-"+randomUUID(),role:"system",text:"外部表单未能完整显示，本次请求未处理。请核对提供方字段、模式和预算。"}});}return;
      }
      if(value.method==="session/request_permission"&&this.#sessionId&&p.sessionId===this.#sessionId&&this.#running&&Array.isArray(p.options)){
        const id=String(value.id),validId=typeof value.id==="string"&&value.id.length>0&&value.id.length<=255||typeof value.id==="number"&&Number.isSafeInteger(value.id);
        if(!validId||this.#approvals.has(id)||this.#approvals.size>=16||!p.options.length||p.options.length>32||p.options.some((row:any)=>typeof row?.optionId!=="string"||!row.optionId||row.optionId.length>255||typeof row.name!=="string"||row.name.length>255)||new Set(p.options.map((row:any)=>row.optionId)).size!==p.options.length){this.#connection?.send({jsonrpc:"2.0",id:value.id,error:{code:-32602,message:"Invalid or duplicate permission request"}});return;}
        const options=p.options.map((row:any)=>({id:row.optionId,label:row.name}));
        if(typeof p.toolCall?.toolCallId==="string"){const message=this.#projection.update({...p.toolCall,sessionUpdate:"tool_call_update"},!!report?.id&&report.id===this.#running);if(message)this.options.event({type:"message",message});}
        this.#approvals.set(id,{id:value.id,options:options.map((row:{id:string})=>row.id)});
        this.options.event({type:"approval",approval:{id,title:String(p.toolCall?.title??"外部AI请求权限").slice(0,255),detail:boundedExternalMessage({id,role:"system",text:JSON.stringify(p.toolCall??{})},16000).text,options}});
      }else this.#connection?.send({jsonrpc:"2.0",id:value.id,error:{code:-32601,message:"Host capability not implemented"}});
      return;
    }
    if(value.method!=="session/update")return;
    if(!this.#sessionId){this.#queueOpening(value);return;}
    if(p.sessionId!==this.#sessionId)return;
    const update=p.update??{};
    if(update.sessionUpdate==="available_commands_update"){
      try{
        const commands=boundedExternalCommands(update.availableCommands);
        if(!this.#commandCatalog.reported||JSON.stringify(commands)!==JSON.stringify(this.#commandCatalog.commands)){this.#commandCatalog={revision:this.#commandCatalog.revision+1,reported:true,commands};this.options.event({type:"commands_changed"});}
      }catch(error){
        this.#commandCatalog={revision:this.#commandCatalog.revision+1,reported:false,commands:[]};this.#failed=true;this.#finish("unknown");
        this.options.event({type:"commands_changed"});this.options.event({type:"closed",error:(error as Error).message});void this.#connection?.close().catch(()=>{});
      }return;
    }
    if(update.sessionUpdate==="config_option_update"){this.#configuration(update.configOptions);this.options.event({type:"catalog"});return;}
    if(update.sessionUpdate==="current_mode_update"&&this.#modes){if(!this.#modes.choices.some(option=>option.id===update.currentModeId))throw Error("ACP报告了未声明的运行模式。");this.#modes.current=update.currentModeId;this.#modeRevision++;this.options.event({type:"catalog"});return;}
    if(this.#failed||this.#disposed||!this.#running&&!this.#loading)return;
    try{
      if(update.sessionUpdate==="usage_update"){
        if(!Number.isSafeInteger(update.used)||update.used<0||!Number.isSafeInteger(update.size)||update.size<0)throw Error("ACP用量事件无效。");
        this.capabilities.context=true;this.options.event({type:"context",usage:{used_tokens:update.used,...(update.size>0?{window_tokens:update.size}:{}),estimated:true}});return;
      }
      const message=this.#projection.update(update,!!report?.id&&report.id===this.#running);if(message){if(message.text||message.tool||message.plan)this.#turnOutput=true;this.options.event({type:"message",message});}
    }catch(error){this.#failed=true;this.#finish("unknown");this.options.event({type:"closed",error:(error as Error).message});}
  }
  #queueOpening(value:unknown){this.#openingBytes+=Buffer.byteLength(JSON.stringify(value));if(this.#opening.length>=64||this.#openingBytes>256*1024)throw Error("ACP启动通知超过预算。");this.#opening.push(value);}
  #reportFailure(id:string,failure:string){
    const facts=this.#turnFacts.get(id);if(!facts||facts.failure===failure)return;
    facts.failure=failure;
    this.options.event({type:"message",message:{id:id+":failure",turn_id:id,role:"system",text:failure}});
    this.options.event({type:"run_failure",turn_id:id,error:failure});
  }
  #applyTurnReport(id:string,report:AcpTurnReport){
    if(report.failure)this.#reportFailure(id,report.failure);
    if(report.stop_reason==="cancelled"){const facts=this.#turnFacts.get(id);if(facts)facts.cancelled=true;}
    if(report.used_tokens!==undefined){this.capabilities.context=true;this.options.event({type:"context",usage:{used_tokens:report.used_tokens,estimated:true}});}
  }
  #finish(status:"interrupted"|"unknown"){for(const message of this.#projection.finish(status))this.options.event({type:"message",message});this.#running=undefined;this.#approvals.clear();}
  async send(text:string,model?:string,effort?:string,images:ExternalImageAttachment[]=[]){return this.#send(text,model,effort,images);}
  async command(name:string,argument:string,revision:number,model?:string,effort?:string){return this.#send("",model,effort,[],{name,argument,revision});}
  #commandText(value:{name:string;argument:string;revision:number}){
    const entry=this.#commandCatalog.commands.find(row=>row.name===value.name);
    if(!this.#commandCatalog.reported||this.#commandCatalog.revision!==value.revision||!entry)throw Error("提供方命令目录已变化，原命令未发送，请重新选择。");return externalCommandText(entry,value.argument);
  }
  async #send(text:string,model?:string,effort?:string,images:ExternalImageAttachment[]=[],command?:{name:string;argument:string;revision:number}){
    if(!this.#connection||!this.#sessionId||this.#running||this.#failed||this.#disposed)throw Error("ACP会话未就绪。");
    if(command)text=this.#commandText(command);
    if(images.length&&!this.capabilities.images)throw Error("此ACP提供方未声明支持图片。");
    if(model&&model!==this.#selectedModel){
      if(!this.#models.some(option=>option.id===model))throw Error("ACP模型已不在当前目录中，没有发送请求。");
      if(this.#config.model)await this.#writeOption(this.#config.model.id,model);
      else await this.#connection.request("session/set_model",{sessionId:this.#sessionId,modelId:model},30000,"rpc",()=>{this.#selectedModel=model;});
    }
    if(model&&this.#selectedModel!==model)throw Error("ACP实际模型已变化，没有发送请求。");
    if(effort){
      const option=this.#config.effort;if(!option?.choices.some(choice=>choice.id===effort))throw Error("ACP思考选项已变化，没有发送请求。");
      if(option.current!==effort)await this.#writeOption(option.id,effort);
    }
    if(command)text=this.#commandText(command);
    const turn="acp-turn-"+randomUUID();this.#running=turn;this.#turnOutput=false;this.#turnFacts.set(turn,{ended:false});while(this.#turnFacts.size>16)this.#turnFacts.delete(this.#turnFacts.keys().next().value!);this.#projection.begin(turn);this.options.event({type:"turn",id:turn});
    const metadata=this.#dialect.promptMetadata?.(turn);
    // ACP响应在整轮结束时返回；发送回执与运行完成分开，不阻塞宿主机器入口。
    void this.#connection.request("session/prompt",{sessionId:this.#sessionId,prompt:[...(text?[{type:"text",text}]:[]),...images.map(image=>({type:"image",mimeType:image.mime_type,data:image.data}))],...(metadata?{_meta:metadata}:{})},600000,"rpc",result=>{
      if(this.#disposed||this.#failed||this.#running!==turn)return;
      const report=this.#dialect.resultReport?.(result);if(report?.id&&report.id!==turn)throw Error("提供方回执不属于原轮次，结果待核对。");if(report)this.#applyTurnReport(turn,report);
      const reason=result.stopReason;
      if(command&&reason==="end_turn"&&!this.#turnOutput)this.options.event({type:"message",message:{id:turn+":command-receipt",role:"system",text:"原命令 /"+command.name+" 返回了结束回执，提供方没有返回可显示内容；实际操作结果仍需核对。"}});
      const facts=this.#turnFacts.get(turn)!;facts.ended=true;const failure=facts.failure;
      const cancelled=reason==="cancelled"||facts.cancelled===true;
      this.#finish(cancelled?"interrupted":"unknown");
      this.options.event({type:"complete",outcome:failure?"failed":cancelled?"interrupted":reason==="end_turn"?"completed":"failed",...(failure?{error:failure}:reason!=="cancelled"&&reason!=="end_turn"?{error:"ACP本轮因提供方限制或拒绝而结束，请核对原会话。"}:{})});
    }).catch(()=>{if(this.#disposed||this.#failed||this.#running!==turn)return;this.#failed=true;this.#finish("unknown");this.options.event({type:"closed",error:"ACP运行结果待核对；没有自动重发。"});});
  }
  async interrupt(){if(!this.#connection||!this.#sessionId||!this.#running)throw Error("没有固定ACP会话可中断。");this.#connection.send({jsonrpc:"2.0",method:"session/cancel",params:{sessionId:this.#sessionId}});}
  async approve(id:string,option:string){const pending=this.#approvals.get(id);if(!pending||!pending.options.includes(option))throw Error("ACP权限请求或选项已变化。");this.#connection!.respond(pending.id,{outcome:{outcome:"selected",optionId:option}});this.#approvals.delete(id);}
  async respond(id:string,response:ExternalElicitationResponse){if(!this.#connection?.connected||this.#disposed||this.#failed)throw Error("ACP表单连接已关闭。");this.#elicitations!.respond(id,response);}
  async close(){this.#disposed=true;this.#loading=false;this.#finish("unknown");this.#elicitations?.clear();await this.#connection?.close();}
}
