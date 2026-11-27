import path from "node:path";
import {randomUUID} from "node:crypto";
import {
  ExternalConversationState,validateExternalAnswers,boundedExternalQuestions,validExternalForkOrigin,validExternalRewindOrigin,validExternalRewindState,
  type ExternalSession,type ExternalSessionState,type ExternalMessage,type ExternalApproval,
  type ExternalQuestionRequest,type ExternalContextUsage,type ExternalRunOutcome,type ExternalRewindOrigin,
} from "../../shared/external-session.ts";
import {externalProvider} from "../../shared/external-ai.ts";
import type {ExternalInstallation} from "../../shared/external-installation.ts";
import {validExternalStorageBinding,canBindExternalStorage,type ExternalStorageBinding} from "../../shared/external-storage-binding.ts";
import {sameTerminalBinding,type TerminalBinding,type TerminalMethod,type TerminalSnapshot,type TerminalEvent} from "../../shared/codex-terminal.ts";
import {terminalUuid} from "./codex-session-identity.ts";
import {externalSessionDirectory} from "./terminal-workspace-state.ts";
import type {ConversationEvent,ExternalConversationDriver} from "./external-conversation-driver.ts";
import {validateExternalImages} from "../../shared/external-attachment.ts";
import {boundedExternalMessage,externalMessageText,externalMessageIdentity} from "../../shared/external-message.ts";
import {boundedExternalElicitation,validateExternalElicitationResponse,type ExternalElicitation} from "../../shared/external-elicitation.ts";
import {externalCommandText} from "../../shared/external-command.ts";
import {validExternalBackgroundRef,validExternalBackgroundStops,type ExternalBackgroundRef,type ExternalBackgroundProcess} from "../../shared/external-background.ts";

type Options={
  profile:string;id?:string;providerId:string;restored?:ExternalSessionState;
  emit(event:TerminalEvent):void;
  checkpoint?():Promise<void>;
  driver(directory:string,binding:TerminalBinding,event:(value:ConversationEvent)=>void,storage?:ExternalStorageBinding,bindStorage?:(value:ExternalStorageBinding)=>Promise<void>):Promise<ExternalConversationDriver>;
};
const providerIdentity=/^[a-zA-Z0-9_.:-]{1,255}$/;
const fields:Record<TerminalMethod,string[]>={
  get:[],start:["cols","rows"],resume:["cols","rows"],reconnect:["cols","rows"],
  stop:["session_id","generation"],input:["session_id","generation","data"],paste:["session_id","generation","data"],
  resize:["session_id","generation","cols","rows"],draft:["session_id","generation","data"],send:["session_id","generation","data","attachments"],
  interrupt:["session_id","generation"],approve:["session_id","generation","approval_id","option_id"],
  model:["session_id","generation","model_id"],answer:["session_id","generation","request_id","answers"],
  respond:["session_id","generation","request_id","request_revision","response"],
  effort:["session_id","generation","effort_id"],compact:["session_id","generation"],
  history:["session_id","generation","history_revision","cursor"],rewind:["session_id","generation","history_revision","turn_id"],
  configure:["session_id","generation","configuration_revision","option_id","value"],
  commands:["session_id","generation"],command:["session_id","generation","command_revision","command_name","command_arguments"],
  background:["session_id","generation","background_revision","cursor"],background_stop:["session_id","generation","background_revision","process_id","item_id","token"],
};

/** 会话应用用例：固定范围与代次，提供方协议通过端口接入，事件不成为作品事实。 */
export class StructuredExternalSession implements ExternalSession {
  #id:string;
  #generation:number;
  #sequence=0;
  #state=new ExternalConversationState();
  #driver?:ExternalConversationDriver;
  #driverEpoch?:{generation:number};
  #binding?:TerminalBinding;
  #directory="";
  #messages:ExternalMessage[]=[];
  #approvals:ExternalApproval[]=[];
  #questions:ExternalQuestionRequest[]=[];
  #elicitations:ExternalElicitation[]=[];
  #standaloneRequests=new Set<string>();
  #blockedFromReady=false;
  #openingRequests:ConversationEvent[]=[];
  #elicitationRevision=0;
  #backgroundRevision=0;
  #backgroundSeen=new Map<string,ExternalBackgroundProcess>();
  #backgroundNextCursor?:string;
  #backgroundCursors=new Set<string>();
  #pendingBackgroundStops:ExternalBackgroundRef[]=[];
  #draft="";
  #draftRevision=0;
  #model?:string;
  #effort?:string;
  #context?:ExternalContextUsage;
  #outcome?:ExternalRunOutcome;
  #error?:string;
  #installation?:ExternalInstallation;
  #storageBinding?:ExternalStorageBinding;
  #changing=false;
  #acceptEvents=false;
  #startupFault=false;
  #responding=new Set<string>();
  #started:boolean;
  #forkVerified=false;
  #rewindHistory:ExternalRewindOrigin[]=[];
  #pendingRewind?:ExternalRewindOrigin;
  #providerSessionId?:string;
  #priorPid?:number;
  #truncated=false;
  #historyRevision=0;
  #providerMutation=false;
  #configurationRevision=0;
  #activeTurnId?:string;
  #lastCompletedTurnId?:string;
  #publishTimer?:NodeJS.Timeout;
  private options:Options;

  constructor(options:Options){
    this.options=options;
    externalProvider(options.providerId);
    const saved=options.restored;
    this.#id=saved?.id??options.id??randomUUID();
    if(!terminalUuid.test(this.#id)||saved&&(
      !Number.isSafeInteger(saved.generation)||saved.generation<0||typeof saved.has_started!=="boolean"||
      saved.provider_id!==options.providerId||saved.mode!=="structured"||
      saved.storage_binding!==undefined&&!validExternalStorageBinding(saved.storage_binding,options.providerId)||
      saved.provider_session_id!==undefined&&!providerIdentity.test(saved.provider_session_id)||
      saved.process_id!==undefined&&(!Number.isSafeInteger(saved.process_id)||saved.process_id<1)||
      saved.fork_verified!==undefined&&(typeof saved.fork_verified!=="boolean"||!saved.fork_origin)||
      (saved.rewind_history!==undefined||saved.pending_rewind!==undefined)&&(options.providerId!=="claude-code"||!validExternalRewindState(saved))||
      saved.pending_background_stops!==undefined&&(options.providerId!=="codex"||!saved.provider_session_id||!validExternalBackgroundStops(saved.pending_background_stops))||
      saved.fork_origin!==undefined&&(!validExternalForkOrigin(saved.fork_origin)||saved.fork_origin.session_id===this.#id||!["codex","claude-code"].includes(options.providerId))
    ))throw Error("结构化会话恢复记录无效。");
    this.#generation=saved?saved.generation+1:0;
    this.#started=saved?.has_started??false;
    this.#storageBinding=saved?.storage_binding?structuredClone(saved.storage_binding):undefined;
    this.#forkVerified=saved?.fork_verified??(options.providerId==="codex"&&!!saved?.provider_session_id);
    if(saved?.fork_origin&&(!this.#started||!this.#forkVerified)){this.#model=saved.fork_origin.model_id;this.#effort=saved.fork_origin.effort_id;}
    this.#providerSessionId=saved?.provider_session_id;
    this.#rewindHistory=structuredClone(saved?.rewind_history??[]);this.#pendingRewind=saved?.pending_rewind?structuredClone(saved.pending_rewind):undefined;
    const selection=this.#pendingRewind??this.#rewindHistory.at(-1);if(selection){this.#model=selection.model_id;this.#effort=selection.effort_id;}
    this.#priorPid=saved?.process_id;
    this.#pendingBackgroundStops=structuredClone(saved?.pending_background_stops??[]);
  }
  persistent():ExternalSessionState{
    const processId=this.#driver?.processId??this.#priorPid;
    return {id:this.#id,generation:this.#generation,has_started:this.#started,provider_id:this.options.providerId,mode:"structured",
      ...(this.#storageBinding?{storage_binding:structuredClone(this.#storageBinding)}:{}),
      ...(this.options.restored?.fork_origin?{fork_origin:structuredClone(this.options.restored.fork_origin),fork_verified:this.#forkVerified}:{}),
      ...(this.#rewindHistory.length?{rewind_history:structuredClone(this.#rewindHistory)}:{}),...(this.#pendingRewind?{pending_rewind:structuredClone(this.#pendingRewind)}:{}),
      ...(this.#pendingBackgroundStops.length?{pending_background_stops:structuredClone(this.#pendingBackgroundStops)}:{}),
      ...(this.#providerSessionId?{provider_session_id:this.#providerSessionId}:{}),...(processId?{process_id:processId}:{})};
  }
  snapshot(includeReplay=true):TerminalSnapshot{
    return {
      session_id:this.#id,generation:this.#generation,sequence:this.#sequence,connected:this.#driver?.connected??false,
      title:this.#binding?.title??externalProvider(this.options.providerId).label,directory:this.#directory,
      provider_id:this.options.providerId,mode:"structured",provider_session_id:this.#providerSessionId,
      ...(this.#installation?{installation:structuredClone(this.#installation)}:{}),
      ...(this.#storageBinding?{storage_binding:structuredClone(this.#storageBinding)}:{}),
      ...(this.options.restored?.fork_origin?{fork_origin:structuredClone(this.options.restored.fork_origin)}:{}),
      ...(this.#rewindHistory.length?{rewind_origin:structuredClone(this.#rewindHistory.at(-1)!),rewind_count:this.#rewindHistory.length}:{}),...(this.#pendingRewind?{pending_rewind:structuredClone(this.#pendingRewind)}:{}),
      restore_available:!!this.#providerSessionId||this.options.providerId==="claude-code"&&this.#started&&!!this.options.restored?.fork_origin?.target_provider_session_id,history_available:false,identity_status:this.#providerSessionId?"bound":"unavailable",
      program_state:({ready:"idle",running:"working",blocked:"blocked",stopped:"clear",unknown:"error"})[this.#state.status],exit_reason:this.#error,
      replay:includeReplay?this.#messages.map(externalMessageText).join("\n\n"):"",
      ...(includeReplay?{conversation:{
        status:this.#state.status,interruptible:this.#state.status==="running"||this.#state.status==="blocked"&&!this.#blockedFromReady,messages:structuredClone(this.#messages),draft:this.#draft,
        background_revision:this.#backgroundRevision,pending_background_stops:structuredClone(this.#pendingBackgroundStops),
        approvals:structuredClone(this.#approvals),questions:structuredClone(this.#questions),elicitations:structuredClone(this.#elicitations),
        models:structuredClone(this.#driver?.models??[]),model:this.#model,effort:this.#effort,
        context:this.#context?{...this.#context}:undefined,outcome:this.#outcome,
        capabilities:this.#driver?.capabilities?{...this.#driver.capabilities,...(this.#providerMutation||this.#pendingRewind?{fork:false,rewind:false}:{})}:undefined,error:this.#error,truncated:this.#truncated,history_revision:this.#historyRevision,
        command_catalog:this.#driver?.commandCatalog?structuredClone(this.#driver.commandCatalog):undefined,
        configuration:structuredClone(this.#driver?.configuration??[]),configuration_revision:this.#configurationRevision,
      }}:{}),
    };
  }
  #publish(transient=false){
    clearTimeout(this.#publishTimer);this.#publishTimer=undefined;
    this.options.emit({session_id:this.#id,generation:this.#generation,sequence:++this.#sequence,snapshot:this.snapshot(),...(transient?{transient:true}:{})});
  }
  #clearRequests(){this.#approvals=[];this.#questions=[];this.#elicitations=[];this.#responding.clear();this.#standaloneRequests.clear();this.#blockedFromReady=false;this.#openingRequests=[];}
  #removeRequest(id:string){
    this.#approvals=this.#approvals.filter(request=>request.id!==id);this.#questions=this.#questions.filter(request=>request.id!==id);this.#elicitations=this.#elicitations.filter(request=>request.id!==id);this.#standaloneRequests.delete(id);
    if(!this.#approvals.length&&!this.#questions.length&&!this.#elicitations.length&&this.#state.status==="blocked"){this.#state.continue(this.#blockedFromReady?"ready":"running");this.#blockedFromReady=false;}
  }
  #unknown(message:string){
    this.#state.unknown();this.#error=message;this.#startupFault=true;this.#clearRequests();
    for(const message of this.#messages)if(message.tool?.status==="running"){message.tool.status="unknown";if(message.tool.background)message.tool.process_state="unknown";}
  }
  #trim(){
    this.#messages=this.#messages.map(message=>boundedExternalMessage(message,16000,16000,true));
    if(this.#messages.some(message=>message.truncated))this.#truncated=true;
    while(this.#messages.length>128||this.#messages.reduce((n,m)=>n+Buffer.byteLength(JSON.stringify(m)),0)>64000){
      const at=this.#messages.findIndex(message=>!message.tool?.background||message.tool.status!=="running");
      if(at>=0)this.#messages.splice(at,1);
      else{
        const large=this.#messages.findIndex(message=>message.text.length>0||!!message.tool?.input||!!message.tool?.progress);
        if(large<0)throw Error("后台命令身份超过会话预算，请核对原提供方。");
        const row=this.#messages[large];this.#messages[large]={...row,text:"",truncated:true,tool:{...row.tool!,input:undefined,progress:undefined}};
      }
      this.#truncated=true;
    }
  }
  #event(event:ConversationEvent,generation:number){
    if(!this.#acceptEvents||this.#generation!==generation)return;
    if(this.#state.status==="unknown"&&(event.type==="message"||event.type==="delta"))return;
    if(this.#changing&&this.#state.status==="stopped"&&(event.type==="approval"||event.type==="elicitation")){
      if(this.#openingRequests.length>=16)this.#unknown("启动期间的外部交互超过预算。");else this.#openingRequests.push(structuredClone(event));return;
    }
    if(event.type==="installation"){
      this.#installation=structuredClone(event.value);
    }else if(event.type==="identity"){
      const replacement=this.#pendingRewind&&(this.#changing||this.#providerMutation)&&event.id===this.#pendingRewind.target_provider_session_id;
      if(!providerIdentity.test(event.id)||this.#providerSessionId&&event.id!==this.#providerSessionId&&!replacement){
        this.#unknown("提供方返回的会话身份无效或与原会话不同。");
      }else this.#providerSessionId=event.id;
    }else if(event.type==="history"){
      this.#messages=event.page.messages;this.#truncated=event.page.truncated||!!event.page.next_cursor;
    }else if(event.type==="history_changed"){
      this.#historyRevision++;
    }else if(event.type==="catalog"){
      this.#configurationRevision++;
      const model=this.#driver?.models.find(model=>model.id===this.#model);
      if(this.#model&&!model){this.#model=undefined;this.#effort=undefined;}
      else if(this.#effort&&!model?.efforts?.some(effort=>effort.id===this.#effort))this.#effort=undefined;
    }else if(event.type==="commands_changed"){
      // 目录归提供方，变化只发布当前目录，不写入作品或布局。
    }else if(event.type==="background_changed"){
      this.#backgroundRevision++;this.#backgroundSeen.clear();this.#backgroundNextCursor=undefined;this.#backgroundCursors.clear();this.#historyRevision++;
    }else if(event.type==="turn"){
      if(!providerIdentity.test(event.id))this.#unknown("提供方本轮运行身份无效。");
      else{this.#activeTurnId=event.id;const user=this.#messages.findLast(message=>message.role==="user");if(user&&!user.turn_id)user.turn_id=event.id;}
    }else if(event.type==="message"){
      const incoming={...event.message,...(!event.message.turn_id&&this.#activeTurnId?{turn_id:this.#activeTurnId}:{})};
      const prior=this.#messages.find(message=>externalMessageIdentity(message)===externalMessageIdentity(incoming)||message.role==="user"&&incoming.role==="user"&&!!incoming.turn_id&&message.turn_id===incoming.turn_id);
      if(prior)Object.assign(prior,incoming);else this.#messages.push(incoming);
    }else if(event.type==="delta"){
      const turn_id=event.turn_id??this.#activeTurnId;
      let message=this.#messages.find(message=>externalMessageIdentity(message)===externalMessageIdentity({id:event.id,turn_id}));
      if(!message){message={id:event.id,role:"assistant",text:"",...(turn_id?{turn_id}:{})};this.#messages.push(message);}message.text+=event.text;
    }else if(event.type==="interaction_resolved"){
      this.#openingRequests=this.#openingRequests.filter(value=>value.type==="approval"?value.approval.id!==event.id:value.type==="elicitation"?value.request.id!==event.id:true);this.#removeRequest(event.id);
    }else if(event.type==="approval"||event.type==="question"||event.type==="elicitation"){
      const standalone=event.type!=="question"&&event.standalone===true;
      if(!["running","blocked"].includes(this.#state.status)&&!(standalone&&this.#state.status==="ready"))this.#unknown("收到没有所属会话或运行的交互请求。");
      else if(this.#approvals.length+this.#questions.length+this.#elicitations.length>=16)this.#unknown("外部待处理请求超过预算，请核对原会话。");
      else{
        const id=event.type==="approval"?event.approval.id:event.request.id;
        if(this.#approvals.some(request=>request.id===id)||this.#questions.some(request=>request.id===id)||this.#elicitations.some(request=>request.id===id)){this.#unknown("外部交互请求身份重复。");this.#publish();return;}
        if(this.#state.status!=="blocked")this.#blockedFromReady=this.#state.status==="ready";
        if(standalone)this.#standaloneRequests.add(id);
        this.#state.block();
        if(event.type==="approval"){
          const request=event.approval;
          if(typeof request.id!=="string"||request.id.length>255||typeof request.title!=="string"||request.title.length>255||!Array.isArray(request.options)||!request.options.length||request.options.length>32||request.options.some(option=>typeof option.id!=="string"||option.id.length>255||typeof option.label!=="string"||option.label.length>255)||Buffer.byteLength(JSON.stringify(request))>32000)this.#unknown("提供方权限请求格式无效或超过预算。");
          else this.#approvals=[...this.#approvals.filter(value=>value.id!==request.id),structuredClone(request)];
        }
        else if(event.type==="question"){
          try{this.#questions=[...this.#questions.filter(value=>value.id!==event.request.id),boundedExternalQuestions(event.request)];}
          catch{this.#unknown("提供方问题格式无效或超过预算。");}
        }else{
          try{this.#elicitations.push(boundedExternalElicitation({...event.request,revision:++this.#elicitationRevision}));}
          catch{this.#unknown("提供方表单格式无效或超过预算。");}
        }
      }
    }else if(event.type==="context"){
      const usage=event.usage;
      if(Number.isSafeInteger(usage.used_tokens)&&usage.used_tokens>=0&&(usage.window_tokens===undefined||Number.isSafeInteger(usage.window_tokens)&&usage.window_tokens>0))this.#context={...usage};
    }else if(event.type==="run_failure"){
      if(event.turn_id===this.#activeTurnId||!this.#activeTurnId&&this.#state.status==="ready"&&event.turn_id===this.#lastCompletedTurnId){this.#outcome="failed";this.#error=event.error;}
    }else if(event.type==="complete"){
      // unknown只能通过显式核对恢复；迟到的完成不能冲掉协议故障。
      if(["running","blocked"].includes(this.#state.status)){
        this.#state.complete();this.#outcome=event.outcome??"completed";this.#error=event.error;
        this.#approvals=this.#approvals.filter(request=>this.#standaloneRequests.has(request.id));this.#questions=[];this.#elicitations=this.#elicitations.filter(request=>this.#standaloneRequests.has(request.id));
        this.#responding=new Set([...this.#responding].filter(id=>this.#standaloneRequests.has(id)));
        if(this.#standaloneRequests.size){this.#blockedFromReady=true;this.#state.block();}else this.#blockedFromReady=false;
        this.#historyRevision++;this.#lastCompletedTurnId=this.#activeTurnId;this.#activeTurnId=undefined;
      }
    }else if(event.type==="closed"){
      if(this.#state.status==="unknown"){this.#error??=event.error;}
      else if(event.error||["running","blocked"].includes(this.#state.status))this.#unknown(event.error??"外部进程在运行结束前退出；结果待核对。");
      else{this.#startupFault=true;this.#state.stop();this.#error=event.error??"外部进程已退出。";this.#clearRequests();}
    }
    this.#trim();
    if(event.type==="message"||event.type==="delta"){if(!this.#publishTimer)this.#publishTimer=setTimeout(()=>this.#publish(true),75);}
    else this.#publish();
  }
  #assertCurrent(generation:number,driver:ExternalConversationDriver){
    if(this.#generation!==generation||this.#driver!==driver||!this.#acceptEvents||this.#changing)throw Error("外部会话已变化，请核对原操作；没有重发。");
  }
  async #finishRewind(driver:ExternalConversationDriver){
    const origin=this.#pendingRewind;
    if(!origin||this.#providerSessionId!==origin.target_provider_session_id||driver.sessionId!==origin.target_provider_session_id)throw Error("提供方尚未确认固定回退身份。");
    this.#rewindHistory.push(origin);this.#pendingRewind=undefined;
    try{await this.options.checkpoint?.();}
    catch(error){this.#rewindHistory.pop();this.#pendingRewind=origin;throw error;}
  }
  async prepareFork(turnId:string,generation:number,historyRevision:number){
    const driver=this.#driver,revision=this.#historyRevision;
    if(generation!==this.#generation||historyRevision!==revision||this.#changing||this.#providerMutation||this.#pendingRewind||this.#state.status!=="ready"||!driver?.connected||!driver.capabilities?.fork||!this.#providerSessionId||!providerIdentity.test(turnId))throw Error("分支来源、轮次或历史版本已变化，请重新读取。");
    this.#providerMutation=true;
    try{
      const checkpoint=await driver.prepareFork?.(turnId);this.#assertCurrent(generation,driver);
      if(revision!==this.#historyRevision||this.#state.status!=="ready")throw Error("分支准备期间历史已变化，请重新读取。");
      return {session_id:this.#id,provider_session_id:this.#providerSessionId,turn_id:turnId,...(this.#model?{model_id:this.#model}:{}),...(this.#effort?{effort_id:this.#effort}:{}),...checkpoint};
    }finally{this.#providerMutation=false;}
  }
  async #open(method:TerminalMethod,binding?:TerminalBinding){
    if(method==="resume")throw Error("请通过固定提供方会话身份恢复，没有打开全局历史。");
    if(this.#changing)throw Error("外部会话正在启动或停止。");
    if(this.#driver?.connected){
      if(binding&&!sameTerminalBinding(binding,this.#binding))throw Error("请先停止原会话再切换作品范围。");
      if(this.#state.status==="unknown")throw Error("原运行结果未知，请先核对并停止原连接，再按原身份恢复。");
      return this.snapshot();
    }
    if(!binding||!path.isAbsolute(binding.workspace)||!path.isAbsolute(binding.accessDirectory))throw Error("请先连接固定作品或本机设置范围。");
    const fork=this.options.restored?.fork_origin;
    if(this.#pendingBackgroundStops.length&&method!=="reconnect")throw Error("原后台停止结果待核对，请继续原会话，没有另开线程。");
    if(this.#pendingRewind&&method!=="reconnect")throw Error("原回退结果待核对，请继续原会话，没有另开会话。");
    const recoverId=this.#pendingRewind?.target_provider_session_id??this.#providerSessionId??(this.options.providerId==="claude-code"&&this.#started?fork?.target_provider_session_id:undefined);
    if(method==="reconnect"&&!recoverId)throw Error("原提供方身份不可用，没有另开会话。");
    if(fork?.source_directory&&fork.source_directory!==externalSessionDirectory(this.options.profile,binding,fork.session_id,this.options.providerId))throw Error("分支来源目录不属于当前作品范围和提供方。");
    if(fork&&this.#started&&method!=="reconnect")throw Error("分支已发起创建，请按原身份恢复或核对原操作；没有再次创建。");
    if(this.#priorPid){
      let live=true;try{process.kill(this.#priorPid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")live=false;}
      if(live)throw Error("原外部进程仍存在，没有重复启动。");this.#priorPid=undefined;
    }
    this.#changing=true;this.#acceptEvents=false;
    try{
      await this.#driver?.close();
      const resumeId=method==="reconnect"?recoverId:undefined;
      this.#binding={...binding};
      this.#directory=externalSessionDirectory(this.options.profile,binding,this.#id,this.options.providerId);
      this.#generation++;const epoch={generation:this.#generation};this.#driverEpoch=epoch;
      this.#sequence=0;this.#state.stop();this.#startupFault=false;this.#error=undefined;this.#outcome=undefined;this.#installation=undefined;
      this.#messages=[];this.#clearRequests();this.#truncated=false;this.#context=undefined;this.#activeTurnId=undefined;this.#lastCompletedTurnId=undefined;this.#historyRevision++;this.#configurationRevision++;this.#backgroundRevision++;this.#backgroundSeen.clear();
      this.#acceptEvents=true;
      this.#driver=await this.options.driver(this.#directory,binding,event=>this.#event(event,epoch.generation),this.#storageBinding,async value=>{
        if(!validExternalStorageBinding(value,this.options.providerId)||this.#storageBinding&&!canBindExternalStorage(this.#storageBinding,value))throw Error("外部AI存储目录绑定已变化，未创建提供方会话。");
        this.#storageBinding=structuredClone(value);await this.options.checkpoint?.();
      });if(!resumeId)this.#providerSessionId=undefined;this.#started=true;
      // 分支在调用外部协议前保存意图；崩溃后只能回读，不再次创建。
      if(fork&&!resumeId)await this.options.checkpoint?.();
      const pendingFork=resumeId?(this.options.providerId==="claude-code"&&!this.#forkVerified?fork:undefined):fork;
      if(this.#pendingRewind){
        if(!this.#driver.recoverRewind)throw Error("当前提供方不能核对原回退，原意图已保留。");
        const page=await this.#driver.recoverRewind(this.#pendingRewind);this.#messages=page.messages;this.#truncated=page.truncated||!!page.next_cursor;
      }else await this.#driver.open(resumeId,pendingFork);
      if(this.#startupFault||!this.#driver.connected||!this.#providerSessionId)throw Error(this.#error??"提供方在启动期间退出或未确认会话身份。");
      if(this.#pendingRewind)await this.#finishRewind(this.#driver);
      if(fork)this.#forkVerified=true;
      if(this.#model&&!this.#driver.models.some(model=>model.id===this.#model)){this.#model=undefined;this.#effort=undefined;}
      this.#state.ready();const opening=this.#openingRequests;this.#openingRequests=[];for(const event of opening)this.#event(event,this.#generation);this.#publish();return this.snapshot();
    }catch(error){
      this.#acceptEvents=false;await this.#driver?.close().catch(()=>{});
      this.#unknown((error as Error).message);this.#publish();throw error;
    }finally{this.#changing=false;}
  }
  async request(method:TerminalMethod,input:Record<string,unknown>={},binding?:TerminalBinding):Promise<TerminalSnapshot>{
    if(!Object.hasOwn(fields,method)||!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!fields[method].includes(key)))throw Error("外部会话动作或参数无效。");
    if(method==="get")return this.snapshot();
    if(["start","resume","reconnect"].includes(method))return this.#open(method,binding);
    if(input.session_id!==this.#id||input.generation!==this.#generation)throw Error("外部会话代次已变化，旧输入未发送。");
    if(this.#changing)throw Error("外部会话正在启动或停止。");
    if(method==="stop"){await this.close();this.#generation++;this.#publish();return this.snapshot();}
    const driver=this.#driver,generation=this.#generation;
    if(!driver?.connected)throw Error("外部会话未连接，输入未发送。");
    if(this.#providerMutation)throw Error("外部历史或配置正在变更，请等待原操作完成。");
    if(method==="commands"){if(!driver.capabilities?.commands||!driver.commandCatalog)throw Error("提供方尚未开放命令目录。");return this.snapshot();}
    if(method==="background"){
      if(!driver.background||!driver.capabilities?.background)throw Error("提供方后台进程目录未接通。");
      if(input.cursor!==undefined&&(typeof input.cursor!=="string"||!input.cursor.length||Buffer.byteLength(input.cursor)>8192))throw Error("后台进程游标无效或超过预算。");
      if(input.cursor&&(input.background_revision!==this.#backgroundRevision||input.cursor!==this.#backgroundNextCursor))throw Error("后台进程分页版本或游标已变化，请刷新目录。");
      const revision=this.#backgroundRevision,page=await driver.background(input.cursor as string|undefined);this.#assertCurrent(generation,driver);
      if(revision!==this.#backgroundRevision)throw Error("读取期间后台进程已变化，请刷新目录。");
      if(!input.cursor){this.#backgroundRevision++;this.#backgroundSeen.clear();this.#backgroundCursors.clear();}
      if(input.cursor)this.#backgroundCursors.add(input.cursor as string);
      if(page.next_cursor&&this.#backgroundCursors.has(page.next_cursor))throw Error("后台进程分页游标出现循环，请刷新目录。");
      if(this.#backgroundSeen.size+page.processes.length>128||page.processes.some(row=>this.#backgroundSeen.has(row.process_id)||[...this.#backgroundSeen.values()].some(prior=>prior.item_id===row.item_id)))throw Error("后台进程跨页重复或超过会话预算。");
      for(const row of page.processes)this.#backgroundSeen.set(row.process_id,structuredClone(row));
      this.#backgroundNextCursor=page.next_cursor;
      this.#publish();const value=this.snapshot();value.conversation!.background_page=page;return value;
    }
    if(method==="background_stop"){
      if(!driver.stopBackground||!driver.capabilities?.background||input.background_revision!==this.#backgroundRevision)throw Error("后台进程目录已变化或停止能力未接通，请刷新。");
      const ref={process_id:input.process_id,item_id:input.item_id,token:input.token};if(!validExternalBackgroundRef(ref))throw Error("后台停止需要完整的原进程身份。");
      const pending=this.#pendingBackgroundStops.find(row=>row.process_id===ref.process_id),seen=this.#backgroundSeen.get(ref.process_id);
      if(pending&&(pending.token!==ref.token||pending.item_id!==ref.item_id))throw Error("原后台停止身份仍待核对，没有停止其他进程。");
      if(!pending&&(!seen||seen.token!==ref.token||seen.item_id!==ref.item_id))throw Error("后台进程不在刚才读取的原目录中，没有停止。");
      if(!pending&&this.#pendingBackgroundStops.length>=16)throw Error("待核对后台停止超过预算。");
      this.#providerMutation=true;
      try{
        if(!pending){this.#pendingBackgroundStops.push(ref);await this.options.checkpoint?.();this.#assertCurrent(generation,driver);}
        const result=await driver.stopBackground(ref,!!pending);this.#assertCurrent(generation,driver);
        if(!result.stopped)throw Error("提供方未确认原后台进程已停止。");
        this.#pendingBackgroundStops=this.#pendingBackgroundStops.filter(row=>row.process_id!==ref.process_id);
        try{await this.options.checkpoint?.();}catch(error){this.#pendingBackgroundStops.push(ref);throw error;}
        this.#backgroundRevision++;this.#backgroundSeen.clear();this.#error=undefined;
      }catch(error){if(this.#generation===generation&&this.#driver===driver&&this.#acceptEvents)this.#error=(error as Error).message;throw error;}
      finally{this.#providerMutation=false;this.#publish();}
      return this.snapshot();
    }
    if(method==="configure"){
      if(this.#state.status!=="ready"||input.configuration_revision!==this.#configurationRevision||!driver.configure)throw Error("提供方配置已变化、不可修改或会话仍在运行。");
      const option=driver.configuration?.find(option=>option.id===input.option_id),value=input.value;
      if(!option||typeof value!==typeof option.value||typeof value==="string"&&!option.choices?.some(choice=>choice.id===value))throw Error("配置或值不在提供方当前选项中。");
      this.#providerMutation=true;
      try{await driver.configure(option.id,value as string|boolean);this.#assertCurrent(generation,driver);this.#configurationRevision++;}
      catch(error){if(this.#generation===generation&&this.#driver===driver&&this.#acceptEvents)this.#unknown((error as Error).message);throw error;}
      finally{this.#providerMutation=false;this.#publish();}
      return this.snapshot();
    }
    if(method==="history"||method==="rewind"){
      if(this.#state.status!=="ready"||input.history_revision!==this.#historyRevision)throw Error("外部历史已变化或会话仍在运行，请刷新后操作。");
      if(!driver.history||!driver.capabilities?.history)throw Error("提供方未开放分页历史能力。");
      if(input.cursor!==undefined&&(typeof input.cursor!=="string"||!input.cursor.length||Buffer.byteLength(input.cursor)>8192))throw Error("历史游标无效或超过预算。");
      if(method==="rewind"&&(!driver.rewind||!driver.capabilities?.rewind||typeof input.turn_id!=="string"||!providerIdentity.test(input.turn_id)))throw Error("提供方不支持回退或目标轮次无效。");
      const revision=this.#historyRevision;
      if(method==="history"){
        const page=await driver.history(input.cursor as string|undefined);this.#assertCurrent(generation,driver);
        if(this.#historyRevision!==revision||this.#state.status!=="ready")throw Error("读取期间外部历史已变化，请刷新。");
        const value=this.snapshot();value.conversation!.history_page=page;return value;
      }
      this.#providerMutation=true;
      try{
        if(this.#pendingRewind)throw Error("原回退结果待核对，没有再次执行。");
        if(driver.prepareRewind){
          if(this.#rewindHistory.length>=256)throw Error("当前会话回退身份记录已达预算，请在新标签继续。");
          const prepared=await driver.prepareRewind(input.turn_id as string);this.#assertCurrent(generation,driver);
          if(this.#historyRevision!==revision||this.#state.status!=="ready"||!validExternalRewindOrigin(prepared)||prepared.source_provider_session_id!==this.#providerSessionId||prepared.before_turn_id!==input.turn_id)throw Error("回退准备期间历史或原身份已变化。");
          this.#pendingRewind={...prepared,...(this.#model?{model_id:this.#model}:{}),...(this.#effort?{effort_id:this.#effort}:{})};
          // 在原生进程切换前落盘完整意图；未知结果只能恢复固定目标。
          await this.options.checkpoint?.();
          this.#assertCurrent(generation,driver);
        }
        const page=await driver.rewind!(input.turn_id as string,this.#pendingRewind);this.#assertCurrent(generation,driver);
        if(this.#state.status!=="ready"||this.#startupFault)throw Error("回退期间提供方退出或返回了异常身份。");
        if(this.#pendingRewind)await this.#finishRewind(driver);
        this.#assertCurrent(generation,driver);
        if(driver.prepareRewind){this.#generation++;this.#sequence=0;if(this.#driverEpoch)this.#driverEpoch.generation=this.#generation;}
        const background=this.#messages.filter(message=>message.tool?.background&&message.tool.process_state==="running");
        this.#messages=[...page.messages,...background.filter(message=>!page.messages.some(row=>externalMessageIdentity(row)===externalMessageIdentity(message)))];this.#trim();this.#truncated||=page.truncated||!!page.next_cursor;this.#historyRevision++;
        this.#configurationRevision++;this.#context=undefined;this.#outcome=undefined;this.#activeTurnId=undefined;this.#error=undefined;
      }catch(error){if(this.#generation===generation&&this.#driver===driver&&this.#acceptEvents)this.#unknown((error as Error).message);throw error;}
      finally{this.#providerMutation=false;this.#publish();}
      return this.snapshot();
    }
    if(["input","paste","draft"].includes(method)){
      if(typeof input.data!=="string"||Buffer.byteLength(input.data)>64*1024)throw Error("会话草稿格式无效或超过64KiB。");let text:string=input.data;
      if(method==="input"&&text.startsWith("\x1b[200~")&&text.endsWith("\x1b[201~"))text=text.slice(6,-6);
      if(/[\x00-\x08\x0b-\x1f\x7f]/.test(text))throw Error("结构化会话草稿不能包含终端控制字符。");
      const next=method==="draft"?text:this.#draft+text;
      if(Buffer.byteLength(next)>64*1024)throw Error("会话草稿超过64KiB。");this.#draft=next;this.#draftRevision++;
    }else if(method==="send"||method==="compact"||method==="command"){
      if(method==="compact"&&(!driver.compact||!driver.capabilities?.compact))throw Error("提供方尚未开放上下文压缩能力。");
      let text=input.data??this.#draft;
      if(method==="command"){
        const catalog=driver.commandCatalog,entry=catalog?.commands.find(row=>row.name===input.command_name);
        if(!driver.command||!driver.capabilities?.commands||!catalog?.reported||input.command_revision!==catalog.revision||!entry)throw Error("提供方命令目录已变化或不可调用，请重新读取。");
        text=externalCommandText(entry,input.command_arguments??"");
      }
      const images=method==="send"?validateExternalImages(input.attachments):[];
      if(images.length&&!driver.capabilities?.images)throw Error("当前提供方尚未声明支持会话图片，图片未发送。");
      if(method==="send"&&(typeof text!=="string"||!text.trim()&&!images.length||Buffer.byteLength(text)>64*1024))throw Error("请填写不超过64KiB的会话请求。");
      this.#state.begin();this.#outcome=undefined;this.#error=undefined;this.#historyRevision++;
      if(method!=="compact")this.#messages.push({id:randomUUID(),role:"user",text:(text as string)+(images.length?"\n"+images.map(image=>"[图片："+image.name+"]").join("\n"):"")});
      const draftRevision=this.#draftRevision;this.#trim();this.#publish();
      try{
        if(method==="compact")await driver.compact!();else if(method==="command")await driver.command!(input.command_name as string,(input.command_arguments??"") as string,input.command_revision as number,this.#model,this.#effort);else await driver.send(text as string,this.#model,this.#effort,images);
        this.#assertCurrent(generation,driver);
        if(method!=="compact"&&draftRevision===this.#draftRevision)this.#draft="";
      }catch(error){
        if(this.#generation===generation&&this.#driver===driver&&this.#acceptEvents){this.#unknown((error as Error).message);this.#publish();}throw error;
      }
    }else if(method==="interrupt"){
      if(!["running","blocked"].includes(this.#state.status)||this.#state.status==="blocked"&&this.#blockedFromReady)throw Error("当前没有运行可中断，请直接处理待回答的原请求。");
      await driver.interrupt();this.#assertCurrent(generation,driver);
    }else if(method==="approve"||method==="answer"||method==="respond"){
      const id=method==="approve"?input.approval_id:input.request_id;
      if(typeof id!=="string"||this.#responding.has(id)||this.#state.status!=="blocked")throw Error("交互请求已变化或正在提交。");
      const approval=this.#approvals.find(value=>value.id===id),question=this.#questions.find(value=>value.id===id),elicitation=this.#elicitations.find(value=>value.id===id);
      if(method==="approve"&&(!approval||!approval.options.some(option=>option.id===input.option_id)))throw Error("权限请求或决定已变化。");
      if(method==="answer"&&(!question||!driver.answer))throw Error("问题请求已变化或提供方不支持回答。");
      if(method==="respond"&&(!elicitation||elicitation.revision!==input.request_revision||!driver.respond))throw Error("表单请求已变化或提供方不支持回答。");
      const answers=question&&method==="answer"?validateExternalAnswers(question,input.answers):undefined;
      const response=elicitation&&method==="respond"?validateExternalElicitationResponse(elicitation,input.response):undefined;
      this.#responding.add(id);
      try{
        if(method==="approve")await driver.approve(id,input.option_id as string);else if(method==="answer")await driver.answer!(id,answers!);else await driver.respond!(id,response!);
        this.#assertCurrent(generation,driver);
        this.#removeRequest(id);
      }finally{this.#responding.delete(id);}
    }else if(method==="model"||method==="effort"){
      if(this.#state.status!=="ready")throw Error("模型不可选或会话仍在运行。");
      if(method==="model"){
        if(typeof input.model_id!=="string"||!driver.models.some(model=>model.id===input.model_id))throw Error("模型不可选。");
        this.#model=input.model_id;this.#effort=undefined;
      }else{
        const model=driver.models.find(model=>model.id===this.#model);
        if(typeof input.effort_id!=="string"||!model?.efforts?.some(effort=>effort.id===input.effort_id))throw Error("思考强度不在当前模型提供的选项中。");
        this.#effort=input.effort_id;
      }
    }else throw Error("此动作不适用于结构化会话。");
    this.#publish();return this.snapshot();
  }
  async close(){
    if(this.#changing)throw Error("外部会话正在启动或停止，请等待原操作。");
    this.#changing=true;this.#acceptEvents=false;clearTimeout(this.#publishTimer);this.#publishTimer=undefined;
    try{await this.#driver?.close();for(const message of this.#messages)if(message.tool?.status==="running"){message.tool.status="unknown";if(message.tool.background)message.tool.process_state="unknown";}this.#state.stop();this.#clearRequests();}
    catch(error){this.#unknown((error as Error).message);throw error;}
    finally{this.#changing=false;clearTimeout(this.#publishTimer);this.#publishTimer=undefined;}
  }
}
