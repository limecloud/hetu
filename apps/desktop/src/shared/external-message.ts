import type {ExternalMessage,ExternalToolActivity} from "./external-session.ts";

export const externalToolStatus:Record<ExternalToolActivity["status"],string>={running:"执行中",completed:"已完成",failed:"失败",declined:"已拒绝",interrupted:"已中断",unknown:"结果待核对"};

export const externalMessageIdentity=(message:Pick<ExternalMessage,"id"|"turn_id">)=>JSON.stringify([message.turn_id??null,message.id]);

/** 工具参数、输出与错误同属显示预算；不解码或执行提供方内容。 */
export function boundedExternalMessage(message:ExternalMessage,maxBytes=16000,maxText=16000,tail=false):ExternalMessage {
  const value=structuredClone(message);let cut=!!value.truncated;
  const clip=(text:string,max:number,fromEnd=false)=>{if(text.length<=max)return text;cut=true;value.truncated=true;let start=fromEnd?text.length-max:0,end=fromEnd?text.length:max;if(start&&/[\uDC00-\uDFFF]/.test(text[start]))start++;if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;return text.slice(start,end);};
  if(value.tool){
    value.tool.name=clip(value.tool.name,255);
    if(value.tool.provider_kind)value.tool.provider_kind=clip(value.tool.provider_kind,80);
    if(value.tool.locations){if(value.tool.locations.length>32){value.tool.locations=value.tool.locations.slice(0,32);cut=true;}value.tool.locations=value.tool.locations.map(location=>({...location,path:clip(location.path,1024)}));}
    for(const field of ["input","progress","error"] as const)if(value.tool[field]!==undefined)value.tool[field]=clip(value.tool[field]!,field==="progress"?2000:4000);
  }
  if(value.plan){if(value.plan.length>32){value.plan=value.plan.slice(0,32);cut=true;}value.plan=value.plan.map(entry=>({content:clip(entry.content,1024),priority:clip(entry.priority,80),status:clip(entry.status,80)}));}
  value.text=clip(value.text,maxText,tail);
  const size=()=>new TextEncoder().encode(JSON.stringify(value)).length;
  while(size()>maxBytes){
    const field=["text",...(value.tool?["input","error","progress","name"]:[])].find(field=>(field==="text"?value.text:(value.tool as any)?.[field])?.length>0);
    if(!field){if(value.tool?.locations?.length){value.tool.locations.pop();cut=true;continue;}if(value.plan?.length){value.plan.pop();cut=true;continue;}break;}
    const text=field==="text"?value.text:(value.tool as any)[field],next=clip(text,Math.floor(text.length*.75),field==="text"&&tail);
    if(field==="text")value.text=next;else (value.tool as any)[field]=next;
  }
  if(cut)value.truncated=true;return value;
}

export function externalMessageText(message:ExternalMessage):string {
  const tool=message.tool;
  if(message.plan)return "plan: 外部执行计划\n"+message.plan.map(entry=>"["+entry.status+"] "+entry.content+"（"+entry.priority+"）").join("\n");
  if(message.channel==="reasoning")return "reasoning: "+message.text;
  if(!tool)return message.role+": "+message.text;
  return ["tool: "+tool.name+" · "+externalToolStatus[tool.status],tool.background?"后台进程："+({running:"运行中",stopped:"已停止",unknown:"状态待核对"}[tool.process_state??"unknown"])+(tool.process_id?"（"+tool.process_id+"）":""):undefined,tool.input,tool.locations?.map(location=>location.path+(location.line!==undefined?":"+location.line:"")).join("\n"),tool.progress,message.text,tool.error,tool.exit_code!==undefined?"退出码："+tool.exit_code:undefined].filter(value=>value!==undefined&&value!=="").join("\n");
}
