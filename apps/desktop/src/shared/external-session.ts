import type {ExternalCommandCatalog} from "./external-command.ts";
import type {ExternalSessionMode} from "./external-ai.ts";
import type {TerminalBinding,TerminalMethod,TerminalSnapshot} from "./codex-terminal.ts";
import type {ExternalTeamPane} from "./external-team.ts";
import type {ExternalElicitation} from "./external-elicitation.ts";
import type {ExternalBackgroundRef,ExternalBackgroundPage} from "./external-background.ts";
import type {ExternalStorageBinding} from "./external-storage-binding.ts";

export type ExternalForkOrigin={session_id:string;provider_session_id:string;turn_id:string;model_id?:string;effort_id?:string;source_directory?:string;checkpoint_id?:string;checkpoint_token?:string;target_provider_session_id?:string};
export type ExternalRewindOrigin={source_provider_session_id:string;target_provider_session_id:string;before_turn_id:string;through_entry_id:string|null;checkpoint_token:string;model_id?:string;effort_id?:string};
export type ExternalSessionState={id:string;generation:number;has_started:boolean;provider_session_id?:string;process_id?:number;provider_id?:string;mode?:ExternalSessionMode;storage_binding?:ExternalStorageBinding;fork_origin?:ExternalForkOrigin;fork_verified?:boolean;rewind_history?:ExternalRewindOrigin[];pending_rewind?:ExternalRewindOrigin;pending_background_stops?:ExternalBackgroundRef[];team?:ExternalTeamPane};
export type ExternalConversationStatus="ready"|"running"|"blocked"|"stopped"|"unknown";
export type ExternalToolActivity={kind:"command"|"file_change"|"mcp"|"dynamic"|"web_search";name:string;status:"running"|"completed"|"failed"|"declined"|"interrupted"|"unknown";input?:string;progress?:string;error?:string;exit_code?:number;duration_ms?:number;provider_kind?:string;locations?:{path:string;line?:number}[];background?:boolean;process_id?:string;process_state?:"running"|"stopped"|"unknown"};
export type ExternalPlanEntry={content:string;priority:string;status:string};
export type ExternalMessage={id:string;role:"user"|"assistant"|"tool"|"system";text:string;turn_id?:string;provider_item_id?:string;channel?:"reasoning";plan?:ExternalPlanEntry[];truncated?:boolean;tool?:ExternalToolActivity};
export type ExternalHistoryPage={messages:ExternalMessage[];next_cursor?:string;truncated:boolean};
export type ExternalApproval={id:string;title:string;detail:string;options:{id:string;label:string}[]};
export type ExternalQuestion={id:string;title:string;prompt:string;options:{id:string;label:string;description?:string}[];allow_other:boolean;multiple?:boolean;secret?:boolean};
export type ExternalQuestionRequest={id:string;title:string;questions:ExternalQuestion[]};
export type ExternalAnswers=Record<string,string[]>;
export type ExternalModel={id:string;label:string;efforts?:{id:string;label:string}[]};
export type ExternalConfigurationOption={id:string;label:string;description?:string;value:string|boolean;choices?:{id:string;label:string}[]};
export type ExternalContextUsage={used_tokens:number;window_tokens?:number;estimated?:boolean};
export type ExternalRunOutcome="completed"|"interrupted"|"failed";
export type ExternalConversationCapabilities={questions:boolean;context:boolean;compact:boolean;images?:boolean;history?:boolean;rewind?:boolean;fork?:boolean;elicitations?:boolean;background?:boolean;commands?:boolean};
export type ExternalConversationSnapshot={status:ExternalConversationStatus;messages:ExternalMessage[];draft:string;approvals:ExternalApproval[];model?:string;models:ExternalModel[];error?:string;truncated?:boolean;questions?:ExternalQuestionRequest[];elicitations?:ExternalElicitation[];interruptible?:boolean;background_revision?:number;background_page?:ExternalBackgroundPage;pending_background_stops?:ExternalBackgroundRef[];effort?:string;context?:ExternalContextUsage;outcome?:ExternalRunOutcome;capabilities?:ExternalConversationCapabilities;history_revision?:number;history_page?:ExternalHistoryPage;configuration?:ExternalConfigurationOption[];configuration_revision?:number;command_catalog?:ExternalCommandCatalog};

export function validExternalForkOrigin(value:unknown):value is ExternalForkOrigin {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!["provider_session_id","session_id","turn_id","model_id","effort_id","source_directory","checkpoint_id","checkpoint_token","target_provider_session_id"].includes(key)))return false;
  const origin=value as ExternalForkOrigin;
  return typeof origin.session_id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(origin.session_id)&&[origin.provider_session_id,origin.turn_id].every(id=>typeof id==="string"&&/^[a-zA-Z0-9_.:-]{1,255}$/.test(id))&&(origin.source_directory===undefined||typeof origin.source_directory==="string"&&origin.source_directory.length>0&&origin.source_directory.length<=4096&&!/[\x00-\x1f\x7f]/.test(origin.source_directory))&&[origin.checkpoint_id,origin.target_provider_session_id].every(id=>id===undefined||typeof id==="string"&&/^[0-9a-f-]{36}$/i.test(id))&&(origin.checkpoint_token===undefined||typeof origin.checkpoint_token==="string"&&/^[a-f0-9]{64}$/.test(origin.checkpoint_token))&&[origin.model_id,origin.effort_id].every(id=>id===undefined||typeof id==="string"&&id.length>0&&id.length<=255&&!/[\x00-\x1f\x7f]/.test(id));
}

export function validExternalRewindOrigin(value:unknown):value is ExternalRewindOrigin {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!["source_provider_session_id","target_provider_session_id","before_turn_id","through_entry_id","checkpoint_token","model_id","effort_id"].includes(key)))return false;
  const v=value as ExternalRewindOrigin,id=(value:unknown)=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  return id(v.source_provider_session_id)&&id(v.target_provider_session_id)&&v.source_provider_session_id!==v.target_provider_session_id&&id(v.before_turn_id)&&(v.through_entry_id===null||id(v.through_entry_id)&&v.through_entry_id!==v.before_turn_id)&&typeof v.checkpoint_token==="string"&&/^[a-f0-9]{64}$/.test(v.checkpoint_token)&&[v.model_id,v.effort_id].every(value=>value===undefined||typeof value==="string"&&value.length>0&&value.length<=255&&!/[\x00-\x1f\x7f]/.test(value));
}

/** 回退只追加原生身份链；待核对记录允许身份回执已到达但验证尚未完成。 */
export function validExternalRewindState(state:Pick<ExternalSessionState,"provider_session_id"|"rewind_history"|"pending_rewind">){
  const history=state.rewind_history===undefined?[]:state.rewind_history,pending=state.pending_rewind;
  if(!Array.isArray(history)||history.length+(pending?1:0)>256||history.some(value=>!validExternalRewindOrigin(value))||pending!==undefined&&!validExternalRewindOrigin(pending))return false;
  const seen=new Set<string>();let previous:string|undefined;
  for(const origin of [...history,...(pending?[pending]:[])]){
    if(previous&&previous!==origin.source_provider_session_id||seen.has(origin.target_provider_session_id))return false;
    seen.add(origin.source_provider_session_id);seen.add(origin.target_provider_session_id);previous=origin.target_provider_session_id;
  }
  if(pending)return state.provider_session_id===pending.source_provider_session_id||state.provider_session_id===pending.target_provider_session_id;
  return !history.length||state.provider_session_id===previous;
}

export function boundedExternalQuestions(request:ExternalQuestionRequest):ExternalQuestionRequest {
  const text=(value:unknown,max:number)=>typeof value==="string"&&value.length>0&&value.length<=max;
  if(!text(request.id,255)||!text(request.title,255)||!Array.isArray(request.questions)||request.questions.length<1||request.questions.length>8)throw Error("外部问题请求格式无效或超过预算。");
  const ids=new Set<string>();
  for(const question of request.questions){
    if(!text(question.id,255)||ids.has(question.id)||!text(question.title,255)||!text(question.prompt,8000)||typeof question.allow_other!=="boolean"||!Array.isArray(question.options)||question.options.length>32)throw Error("外部问题请求格式无效或超过预算。");
    ids.add(question.id);const options=new Set<string>();
    for(const option of question.options){if(!text(option.id,255)||options.has(option.id)||!text(option.label,255)||option.description!==undefined&&!text(option.description,2000))throw Error("外部问题选项无效。");options.add(option.id);}
    if(!question.allow_other&&!question.options.length)throw Error("外部问题没有可用回答。");
  }
  if(new TextEncoder().encode(JSON.stringify(request)).length>32000)throw Error("外部问题请求超过预算。");
  return structuredClone(request);
}

/** 提供方表单是数据；问题、原选项与回答范围在应用层验证后交给对应适配器。 */
export function validateExternalAnswers(request:ExternalQuestionRequest,input:unknown):ExternalAnswers {
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length!==request.questions.length)throw Error("请回答当前请求中的全部问题。");
  const answers=input as ExternalAnswers;
  for(const question of request.questions){
    if(!Object.hasOwn(answers,question.id))throw Error("回答包含未知问题或缺少原问题。");
    const values=answers[question.id];
    if(!Array.isArray(values)||values.length<1||values.length>(question.multiple?32:1)||new Set(values).size!==values.length||values.some(value=>typeof value!=="string"||!value.trim()||value.length>8000||/[\x00-\x08\x0b-\x1f\x7f]/.test(value)))throw Error("问题回答格式无效或超过预算。");
    if(!question.allow_other&&values.some(value=>!question.options.some(option=>option.id===value)))throw Error("回答只能选择原请求提供的选项。");
  }
  if(new TextEncoder().encode(JSON.stringify(answers)).length>32000)throw Error("问题回答超过预算。");
  return structuredClone(answers);
}

/** 应用层会话端口；知识数据、UI、进程和各提供方协议都不进入此合同。 */
export interface ExternalSession {
  snapshot(includeReplay?:boolean):TerminalSnapshot;
  persistent():ExternalSessionState;
  request(method:TerminalMethod,input?:Record<string,unknown>,binding?:TerminalBinding):Promise<TerminalSnapshot>;
  close():Promise<void>;
  prepareFork?(turnId:string,generation:number,historyRevision:number):Promise<ExternalForkOrigin>;
}

/** 聚合只管理一次外部运行的生命周期，不执行规划或自动重试。 */
export class ExternalConversationState {
  #status:ExternalConversationStatus="stopped";
  get status(){return this.#status;}
  ready(){if(this.#status!=="stopped"&&this.#status!=="unknown")throw Error("外部会话仍在运行。");this.#status="ready";}
  begin(){if(this.#status!=="ready")throw Error("外部会话未就绪，请先处理原运行或权限请求。");this.#status="running";}
  block(){if(!["ready","running","blocked"].includes(this.#status))throw Error("权限请求没有所属会话或运行。");this.#status="blocked";}
  continue(status:"running"|"ready"="running"){if(this.#status!=="blocked")throw Error("权限请求已变化。");this.#status=status;}
  complete(){if(this.#status==="running"||this.#status==="blocked")this.#status="ready";}
  unknown(){this.#status="unknown";}
  stop(){this.#status="stopped";}
}
