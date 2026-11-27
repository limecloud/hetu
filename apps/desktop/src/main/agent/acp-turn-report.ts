export type AcpTurnReport={id?:string;replay?:boolean;stop_reason?:string;failure?:string;used_tokens?:number};
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const identity=(value:unknown)=>typeof value==="string"&&/^[a-zA-Z0-9_.:-]{1,255}$/.test(value);
const detail=(value:unknown)=>{if(typeof value!=="string"||!value.trim())return undefined;let end=Math.min(value.length,4000);if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]))end--;return value.slice(0,end).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,"");};

/** 已协商方言的原轮次事实；错误和上下文估计不成为计费或知识完成事实。 */
export function grokTurnReport(frame:unknown):AcpTurnReport|undefined{
 if(!object(frame)||typeof frame.method!=="string")return;
 const method=frame.method.replace(/^_/,"");
 if(!["session/update","x.ai/session_notification","x.ai/session/update","x.ai/session/prompt_complete","session/request_permission","elicitation/create"].includes(method))return;
 if(!object(frame.params))throw Error("提供方轮次通知格式无效。");
 const p=frame.params,u=object(p.update)?p.update:{},meta=object(p._meta)?p._meta:{},completion=method==="x.ai/session/prompt_complete";
 if(method!=="elicitation/create"&&!identity(p.sessionId))throw Error("提供方轮次通知缺少有效会话身份。");
 const values=[meta.promptId,u.prompt_id,p.promptId].filter(value=>value!==undefined&&value!==null);
 if(values.some(value=>!identity(value))||new Set(values).size>1)throw Error("提供方轮次身份无效或互相冲突。");
 const report:AcpTurnReport={...(values.length?{id:values[0]}:{}),...(meta.isReplay===true?{replay:true}:{})};
 if(completion||u.sessionUpdate==="turn_completed"){
  const reason=completion?p.stopReason:u.stop_reason;
  if(typeof reason!=="string"||!identity(reason)||!report.id)throw Error("提供方轮次结束缺少原身份或有效结果。");report.stop_reason=reason;
  const blocked=meta.cancellationCategory==="HookDenied"||p.cancellationCategory==="HookDenied",context=meta.cancellationContext??p.cancellationContext;
  if(blocked)report.failure=detail(context?.reason)??"提供方的前置规则拒绝了本轮请求。";
  else if(["error","rate_limit"].includes(reason))report.failure=detail(completion?p.agentResult:u.agent_result)??(reason==="rate_limit"?"提供方因用量限制结束本轮，请核对原会话。":"提供方报告本轮失败，请核对原会话。");
  else if(!["end_turn","cancelled"].includes(reason))report.failure="提供方以 "+reason+" 结束本轮，请核对原会话。";
 }else if(u.sessionUpdate==="retry_state"&&u.type==="failed")report.failure=detail(u.message)??"提供方报告本轮重试已失败。";
 if(u.sessionUpdate==="response_completed"){
  if(!object(u.usage))throw Error("提供方用量格式无效。");
  const values=[u.usage.input_tokens,u.usage.output_tokens??0,u.usage.cache_read_input_tokens??0,u.usage.cache_creation_input_tokens??0];
  if(values.some(value=>!Number.isSafeInteger(value)||value<0))throw Error("提供方用量不是非负安全整数。");
  const used=values.reduce((sum,value)=>sum+value,0);if(!Number.isSafeInteger(used))throw Error("提供方用量合计超过安全整数范围。");report.used_tokens=used;
 }
 return report;
}

export function grokResultReport(value:unknown):AcpTurnReport{
 if(!object(value))throw Error("提供方轮次回执格式无效。");
 const meta=object(value._meta)?value._meta:{},id=meta.promptId;
 if(id!==undefined&&!identity(id))throw Error("提供方轮次回执身份无效。");
 const report:AcpTurnReport={...(id!==undefined?{id}:{})};
 if(meta.cancellationCategory==="HookDenied")report.failure=detail(meta.cancellationContext?.reason)??"提供方的前置规则拒绝了本轮请求。";
 return report;
}
