import {randomUUID} from "node:crypto";
import {JsonLineProcess} from "./json-line-process.ts";
import type {ConversationEvent,ExternalConversationDriver} from "./external-conversation-driver.ts";
import {boundedExternalQuestions,validExternalForkOrigin,validExternalRewindOrigin,type ExternalAnswers,type ExternalModel,type ExternalForkOrigin,type ExternalRewindOrigin} from "../../shared/external-session.ts";
import type {ExternalImageAttachment} from "../../shared/external-attachment.ts";
import {ClaudeTranscriptHistory} from "./claude-transcript-history.ts";

function claudeRunError(value:any){
  const detail=JSON.stringify([value.result,value.errors]);
  const reason=/not logged|authentication|invalid.{0,20}key|\b401\b|\/login/i.test(detail)?"登录或API认证不可用，请在原生CLI核对账户。":/insufficient|balance|\b402\b|credit|quota/i.test(detail)?"账户额度或配额不可用，请在原生CLI核对。":/model.{0,80}(not found|not supported|unavailable|may not exist|does not exist)|selected model|\b404\b/i.test(detail)?"当前模型不可用，请核对提供方配置或选择其他模型。":"本轮运行失败，请核对原会话。";
  return "Claude"+reason;
}

function claudeModels(value:unknown):ExternalModel[]{
  if(!Array.isArray(value))return [];
  const text=(value:unknown)=>typeof value==="string"&&value.length>0&&value.length<=255&&!/[\x00-\x1f\x7f]/.test(value),seen=new Set<string>();
  return value.filter(row=>row&&text(row.value)&&row.disabled!==true&&!seen.has(row.value)&&!!seen.add(row.value)).slice(0,128).map(row=>({
    id:row.value,label:typeof row.displayName==="string"?row.displayName.slice(0,128):row.value,
    ...(row.supportsEffort===true&&Array.isArray(row.supportedEffortLevels)?{efforts:[...new Set<string>(row.supportedEffortLevels.filter(text))].slice(0,16).map(id=>({id,label:id}))}:{}),
  }));
}
function nativeForkSupported(version:unknown){
  const match=typeof version==="string"?/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version):null;
  if(!match)return false;const [major,minor,patch]=match.slice(1).map(Number);
  return major>2||major===2&&(minor>1||minor===1&&patch>=330);
}

export class ClaudeConversationDriver implements ExternalConversationDriver {
  #connection?:JsonLineProcess;#sessionId?:string;#models:ExternalModel[]=[];#messageId="";#selectedModel?:string;#selectedEffort?:string;#approvals=new Map<string,{input:unknown}>();
  #questions=new Map<string,{input:Record<string,unknown>;keys:string[]}>();#interrupted=false;
  #running=false;#inputId?:string;#compact?:{boundary:boolean;failed:boolean};#watchdog?:NodeJS.Timeout;
  #history?:ClaudeTranscriptHistory;#tools=new Map<string,string>();#historyOwnChange=false;
  #bootstrap?:{id:string;resolve():void;reject(error:Error):void};
  #plannedClose=new WeakSet<JsonLineProcess>();#lifecycle=0;
  readonly capabilities={questions:true,context:true,compact:true,images:true,history:true,fork:false,rewind:false};
  private options:{binary:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;event(value:ConversationEvent):void};
  constructor(options:ClaudeConversationDriver["options"]){this.options=options;}
  get connected(){return this.#connection?.connected??false;}
  get processId(){return this.#connection?.processId;}
  get sessionId(){return this.#sessionId;}
  get models(){return this.#models;}
  async open(resumeId?:string,fork?:ExternalForkOrigin){
    if(this.connected)throw Error("Claude原会话仍连接，没有重复启动。");
    if(fork&&(!validExternalForkOrigin(fork)||!fork.source_directory||!fork.checkpoint_token||fork.checkpoint_id!==fork.turn_id||!fork.target_provider_session_id||fork.target_provider_session_id===fork.provider_session_id||resumeId&&resumeId!==fork.target_provider_session_id))throw Error("Claude分支缺少固定来源、历史快照或独立身份。");
    const source=fork?new ClaudeTranscriptHistory(fork.source_directory!,this.options.env,fork.provider_session_id):undefined;
    const checkpoint=fork?await source!.checkpoint(fork.turn_id,fork.checkpoint_token):undefined;
    const id=resumeId??fork?.target_provider_session_id??randomUUID(),history=new ClaudeTranscriptHistory(this.options.cwd,this.options.env,id);
    if(resumeId&&!await history.exists())throw Error("Claude原会话历史已不可用，没有启动新会话。");
    if(fork&&!resumeId&&await history.exists())throw Error("Claude目标分支已存在，请按原身份恢复，没有再次创建。");
    const args=fork&&!resumeId?["--resume",fork.provider_session_id,"--fork-session","--session-id",id,"--resume-session-at",fork.turn_id]:[resumeId?"--resume":"--session-id",id];
    await this.#connect(id,args,{history:!!resumeId||!!fork,native:!!fork,materialize:!!fork&&!resumeId,...(fork?{verify:async()=>{await source!.checkpoint(fork.turn_id,fork.checkpoint_token);await this.#history!.verifyFork(checkpoint!);}}:{})});
  }
  async #connect(id:string,args:string[],options:{history?:boolean;native?:boolean;materialize?:boolean;verify?():Promise<void>}={}){
    this.#sessionId=id;this.#history=new ClaudeTranscriptHistory(this.options.cwd,this.options.env,id);this.#historyOwnChange=false;this.#selectedModel=undefined;this.#selectedEffort=undefined;
    const connection=new JsonLineProcess({...this.options,args:[...this.options.args,...args],message:value=>{if(this.#connection===connection)this.#message(value);},closed:error=>{
      if(this.#connection!==connection||this.#plannedClose.has(connection))return;
      this.#bootstrap?.reject(error??Error("Claude在会话确认前退出，请核对原身份。"));this.options.event({type:"closed",error:error?.message});
    }});this.#connection=connection;
    try{
      const initialized=await this.#connection.request("initialize",{},30000,"claude");
      this.#models=claudeModels(initialized.models);this.capabilities.fork=this.capabilities.rewind=nativeForkSupported(initialized.claude_code_version);
      if(options.native&&!this.capabilities.fork)throw Error("当前Claude版本未核验原生分支或回退参数，请升级后重新核对。");
      this.options.event({type:"identity",id});
      // /status由CLI本地处理，使原生会话落盘；没有模型调用或知识目标。
      if(options.materialize)await this.#materializeSession();await options.verify?.();
      const page=options.history?await this.history():{messages:[],truncated:false};
      if(options.history)this.options.event({type:"history",page});return page;
    }catch(error){await this.close();throw error;}
  }
  async #materializeSession(){
    let timer:NodeJS.Timeout|undefined;this.#inputId=randomUUID();const id=this.#inputId;
    try{await new Promise<void>((resolve,reject)=>{this.#bootstrap={id,resolve,reject};timer=setTimeout(()=>reject(Error("Claude原生会话回执超时，请按原身份核对，没有再次创建。")),30000);this.#user("/status");});}
    finally{clearTimeout(timer);this.#bootstrap=undefined;}
  }
  #begin(compact=false){
    if(!this.#connection||!this.#sessionId||this.#running)throw Error("Claude会话未就绪或原运行尚未结束。");
    this.#running=true;this.#inputId=randomUUID();this.#interrupted=false;this.#messageId="";
    if(!compact)this.options.event({type:"turn",id:this.#inputId});
    this.#historyOwnChange=true;
    this.#compact=compact?{boundary:false,failed:false}:undefined;
    clearTimeout(this.#watchdog);this.#watchdog=setTimeout(()=>{if(this.#running)this.options.event({type:"closed",error:"Claude本轮回执超时，请核对原会话，没有自动重发。"});},600000);this.#watchdog.unref();
  }
  #user(text:string,images:ExternalImageAttachment[]=[]){
    this.#connection!.send({type:"user",uuid:this.#inputId,session_id:this.#sessionId,parent_tool_use_id:null,message:{role:"user",content:[...(text?[{type:"text",text}]:[]),...images.map(image=>({type:"image",source:{type:"base64",media_type:image.mime_type,data:image.data}}))]}});
  }
  #tool(id:string,detail:string){this.options.event({type:"message",message:{id,role:"tool",text:detail}});}
  #message(value:any){
    if(value.session_id&&value.session_id!==this.#sessionId){this.#bootstrap?.reject(Error("Claude返回了不同的分支会话身份。"));this.options.event({type:"closed",error:"Claude返回了不同的会话身份；原运行待核对。"});void this.close();return;}
    if(this.#bootstrap){
      if(value.type==="result"&&value.session_id===this.#sessionId&&!value.parent_tool_use_id&&(!value.user_message_uuid||value.user_message_uuid===this.#bootstrap.id)){
        if(value.subtype==="success"&&!value.is_error)this.#bootstrap.resolve();else this.#bootstrap.reject(Error("Claude未确认原生分支成功，请核对原操作。"));
      }
      if(value.type==="control_request")this.#connection?.send({type:"control_response",response:{subtype:"error",request_id:value.request_id,error:"No tools allowed while materializing a conversation fork"}});
      return;
    }
    if(value.type==="control_request"){
      const request=value.request??{},id=value.request_id;
      if(this.#running&&request.subtype==="can_use_tool"&&typeof id==="string"){
        if(this.#approvals.size+this.#questions.size>=16){this.#connection?.send({type:"control_response",response:{subtype:"error",request_id:id,error:"Too many pending requests"}});return;}
        if(request.tool_name==="AskUserQuestion"){
          try{
            const questions=(request.input?.questions??[]).map((question:any,index:number)=>({id:String(index),title:question.header,prompt:question.question,allow_other:true,multiple:question.multiSelect===true,options:(question.options??[]).map((option:any)=>({id:option.label,label:option.label,...(option.description?{description:option.description}:{})}))}));
            const form=boundedExternalQuestions({id,title:"Claude需要你的回答",questions});
            const keys=request.input.questions.map((question:any)=>question.question);
            if(new Set(keys).size!==keys.length)throw Error("重复问题");
            this.#questions.set(id,{input:request.input,keys});this.options.event({type:"question",request:form});
          }catch{this.#connection?.send({type:"control_response",response:{subtype:"error",request_id:id,error:"Invalid question request"}});}
          return;
        }
        this.#approvals.set(id,{input:request.input});this.options.event({type:"approval",approval:{id,title:"Claude请求使用工具："+String(request.tool_name??"工具").slice(0,128),detail:JSON.stringify(request.input??{}).slice(0,16000),options:[{id:"allow",label:"允许本次"},{id:"deny",label:"拒绝"}]}});
      }else this.#connection?.send({type:"control_response",response:{subtype:"error",request_id:id,error:"Host capability not implemented"}});
      return;
    }
    if(!this.#running||value.parent_tool_use_id)return;
    if(value.user_message_uuid&&value.user_message_uuid!==this.#inputId)return;
    if(value.type==="system"&&this.#compact){
      if(value.subtype==="compact_boundary")this.#compact.boundary=true;
      if(value.compact_result==="failed")this.#compact.failed=true;
    }
    if(this.#compact&&["user","assistant","stream_event"].includes(value.type))return;
    if(value.type==="stream_event"){
      const event=value.event??{};
      if(event.type==="message_start"&&typeof event.message?.id==="string")this.#messageId=event.message.id;
      if(event.type==="content_block_delta"&&event.delta?.type==="text_delta"&&typeof event.delta.text==="string")this.options.event({type:"delta",id:this.#messageId||(this.#messageId=randomUUID()),text:event.delta.text});
    }
    if(value.type==="assistant"){
      const content=value.message?.content??[],id=value.message?.id??this.#messageId??value.uuid;
      const text=content.filter((row:any)=>row.type==="text").map((row:any)=>row.text).join("\n");if(text&&id)this.options.event({type:"message",message:{id,role:"assistant",text}});
      for(const tool of content.filter((row:any)=>row.type==="tool_use"&&typeof row.id==="string")){
        const detail=String(tool.name??"工具")+"\n"+JSON.stringify(tool.input??{}).slice(0,12000);this.#tools.set(tool.id,detail);this.#tool(tool.id,detail+"\n运行中");
        if(this.#tools.size>128)this.#tools.delete(this.#tools.keys().next().value!);
      }
    }
    if(value.type==="user"&&Array.isArray(value.message?.content))for(const result of value.message.content){
      if(result.type!=="tool_result"||typeof result.tool_use_id!=="string")continue;
      const output=typeof result.content==="string"?result.content:JSON.stringify(result.content??[]);
      this.#tool(result.tool_use_id,(this.#tools.get(result.tool_use_id)??"工具")+"\n"+(result.is_error?"失败":"完成")+"\n"+output.slice(0,16000));
    }
    if(value.type==="result"){
      clearTimeout(this.#watchdog);this.#watchdog=undefined;this.#running=false;
      this.#approvals.clear();this.#questions.clear();
      const usages=Object.values(value.modelUsage??{}) as any[];
      if(usages.length){const last=usages.at(-1);const used=(last.inputTokens??0)+(last.cacheReadInputTokens??0)+(last.cacheCreationInputTokens??0);if(used>0)this.options.event({type:"context",usage:{used_tokens:used,window_tokens:last.contextWindow??undefined}});}
      const compact=this.#compact;this.#compact=undefined;
      if(compact){
        const failed=compact.failed||value.is_error||value.subtype!=="success"||!compact.boundary&&!this.#interrupted;
        if(compact.boundary&&!failed)this.options.event({type:"message",message:{id:this.#inputId+":compact",role:"system",text:"外部会话上下文已压缩。"}});
        this.options.event({type:"complete",outcome:failed?"failed":!compact.boundary&&this.#interrupted?"interrupted":"completed",...(failed?{error:value.is_error||value.subtype!=="success"?claudeRunError(value)+"上下文压缩未完成。":"Claude尚未确认上下文压缩成功，请核对原会话。"}:{})});
      }else if(value.is_error||value.subtype!=="success"){
        this.options.event({type:"complete",outcome:"failed",error:claudeRunError(value)});
      }else this.options.event({type:"complete",outcome:this.#interrupted?"interrupted":"completed"});
    }
  }
  async send(text:string,model?:string,effort?:string,images:ExternalImageAttachment[]=[]){
    if(!this.#connection||!this.#sessionId||this.#running)throw Error("Claude会话未就绪或原运行尚未结束。");
    if(effort&&!this.#models.find(row=>row.id===model)?.efforts?.some(option=>option.id===effort))throw Error("Claude思考强度不在当前模型提供的选项中。");
    if(model&&model!==this.#selectedModel){await this.#connection.request("set_model",{model},30000,"claude");this.#selectedModel=model;this.#selectedEffort=undefined;}
    if(effort&&effort!==this.#selectedEffort){
      await this.#connection.request("apply_flag_settings",{settings:{effortLevel:effort}},30000,"claude");
      const settings=await this.#connection.request("get_settings",{},30000,"claude");
      if(settings.applied?.effort!==effort)throw Error("Claude未回读到选定的思考强度，本轮目标没有发送。");this.#selectedEffort=effort;
    }
    this.#begin();this.#user(text,images);
  }
  async compact(){this.#begin(true);this.#user("/compact");}
  async history(cursor?:string){
    if(!this.#history||this.#running)throw Error("Claude历史不可用或原运行尚未结束。");
    const previous=this.#history.revision,page=await this.#history.page(cursor);
    if(previous&&previous!==this.#history.revision&&!this.#historyOwnChange)this.options.event({type:"history_changed"});this.#historyOwnChange=false;return page;
  }
  async prepareFork(turnId:string){
    if(!this.#history||!this.#sessionId||this.#running||!this.capabilities.fork)throw Error("Claude原生分支不可用或原运行尚未结束。");
    await this.history();const checkpoint=await this.#history.checkpoint(turnId,this.#history.revision);
    return {source_directory:this.options.cwd,checkpoint_id:turnId,checkpoint_token:checkpoint.sha,target_provider_session_id:randomUUID()};
  }
  async prepareRewind(beforeTurnId:string):Promise<ExternalRewindOrigin>{
    if(!this.#history||!this.#sessionId||this.#running||!this.capabilities.rewind)throw Error("Claude回退不可用或原运行尚未结束。");
    const checkpoint=await this.#history.beforePrompt(beforeTurnId,this.#historyOwnChange?undefined:this.#history.contextRevision);this.#historyOwnChange=false;
    return {source_provider_session_id:this.#sessionId,target_provider_session_id:randomUUID(),before_turn_id:beforeTurnId,through_entry_id:checkpoint.through,checkpoint_token:checkpoint.context_sha};
  }
  async #rewindCheckpoint(origin:ExternalRewindOrigin){
    if(!validExternalRewindOrigin(origin))throw Error("Claude回退检查点无效。");
    const source=new ClaudeTranscriptHistory(this.options.cwd,this.options.env,origin.source_provider_session_id),checkpoint=await source.beforePrompt(origin.before_turn_id,origin.checkpoint_token);
    if(checkpoint.through!==origin.through_entry_id)throw Error("Claude回退父链位置已变化。");return {source,checkpoint};
  }
  async rewind(beforeTurnId:string,origin?:ExternalRewindOrigin){
    if(!origin||origin.before_turn_id!==beforeTurnId||origin.source_provider_session_id!==this.#sessionId||!this.#connection?.connected||this.#running||!this.capabilities.rewind)throw Error("Claude回退缺少固定意图、原身份或空闲连接。");
    const lifecycle=this.#lifecycle,{source,checkpoint}=await this.#rewindCheckpoint(origin),target=new ClaudeTranscriptHistory(this.options.cwd,this.options.env,origin.target_provider_session_id);
    if(await target.exists())throw Error("Claude回退目标已存在，请核对原操作，没有再次创建。");
    const previous=this.#connection;this.#plannedClose.add(previous);await previous.close();
    if(lifecycle!==this.#lifecycle)throw Error("Claude回退已停止，没有启动目标会话。");
    const args=origin.through_entry_id?["--resume",origin.source_provider_session_id,"--fork-session","--session-id",origin.target_provider_session_id,"--resume-session-at",origin.through_entry_id]:["--session-id",origin.target_provider_session_id];
    return this.#connect(origin.target_provider_session_id,args,{history:true,native:true,materialize:true,verify:async()=>{await source.beforePrompt(origin.before_turn_id,origin.checkpoint_token);await this.#history!.verifyFork(checkpoint);}});
  }
  async recoverRewind(origin:ExternalRewindOrigin){
    if(this.connected)throw Error("原Claude连接仍存在，请先停止再核对回退。");
    const {source,checkpoint}=await this.#rewindCheckpoint(origin),target=new ClaudeTranscriptHistory(this.options.cwd,this.options.env,origin.target_provider_session_id);
    if(!await target.exists())throw Error("Claude原回退目标尚未落盘，没有重新执行回退。");
    return this.#connect(origin.target_provider_session_id,["--resume",origin.target_provider_session_id],{history:true,native:true,verify:async()=>{await source.beforePrompt(origin.before_turn_id,origin.checkpoint_token);await this.#history!.verifyFork(checkpoint);}});
  }
  async interrupt(){if(!this.#connection||!this.#running||!this.#inputId)throw Error("没有已绑定的Claude运行可中断。");this.#interrupted=true;await this.#connection.request("interrupt",{},30000,"claude");}
  async approve(id:string,option:string){
    const request=this.#approvals.get(id);if(!request||!["allow","deny"].includes(option))throw Error("Claude权限请求或选项已变化。");
    this.#connection!.send({type:"control_response",response:{subtype:"success",request_id:id,response:option==="allow"?{behavior:"allow",updatedInput:request.input}:{behavior:"deny",message:"用户拒绝本次工具请求。"}}});this.#approvals.delete(id);
  }
  async answer(id:string,answers:ExternalAnswers){
    const request=this.#questions.get(id);if(!request)throw Error("Claude问题请求已变化。");
    const mapped=Object.fromEntries(request.keys.map((question,index)=>[question,answers[String(index)].join(", ")]));
    this.#connection!.send({type:"control_response",response:{subtype:"success",request_id:id,response:{behavior:"allow",updatedInput:{...request.input,answers:mapped}}}});this.#questions.delete(id);
  }
  async close(){this.#lifecycle++;this.#bootstrap?.reject(Error("Claude会话确认已停止，请核对原身份。"));this.#running=false;clearTimeout(this.#watchdog);this.#watchdog=undefined;this.#compact=undefined;this.#approvals.clear();this.#questions.clear();this.#tools.clear();await this.#connection?.close();}
}
