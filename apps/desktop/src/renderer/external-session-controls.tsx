import React,{useState} from "react";
import {createPortal} from "react-dom";
import {Icon} from "@hetu/workbench-ui";
import type {SessionSnapshot} from "../agent-session-contract.ts";
import {desktop} from "./bridge.ts";
import {ExternalQuestionForm} from "./external-question-form.tsx";
import {ExternalElicitationForm} from "./external-elicitation-form.tsx";

/** 原协议目录与请求共用工作面；答复固定原身份、代次及请求版本。 */
export function ExternalSessionControls({snapshot,notify,settingsTarget}:{snapshot:SessionSnapshot;notify(message:string):void;settingsTarget:HTMLElement|null}){
  const value=snapshot.external;
  const [busy,setBusy]=useState(false),[command,setCommand]=useState(""),[argument,setArgument]=useState(""),[history,setHistory]=useState<any>();
  if(!value)return null;
  const scope=snapshot.work_ref?{work_ref:snapshot.work_ref}:{scope:"library"};
  const call=async(method:string,input:Record<string,unknown>={})=>{setBusy(true);try{return (await desktop.agentSession("external",{...scope,session_id:snapshot.session_id,generation:snapshot.generation,external_method:method,external_input:input})).result;}finally{setBusy(false);}};
  const run=(method:string,input:Record<string,unknown>={})=>{void call(method,input).catch(error=>notify(error.message));};
  const messages=value.messages.filter(message=>message.channel==="reasoning"||message.plan);
  const hasSettings=!!value.configuration?.length||value.capabilities?.compact||value.capabilities?.history||!!value.command_catalog?.commands.length;
  const hasInteractions=!!value.approvals.length||!!value.questions?.length||!!value.elicitations?.length||!!messages.length||!!history;
  const settings=<details className="popover-menu external-session-settings"><summary aria-label="引擎会话设置" title="引擎会话设置"><Icon name="more" size={14}/></summary><div className="menu-panel external-session-options">
      {!!value.configuration?.length&&<div>{value.configuration.map(option=><label key={option.id}>{option.label}<select aria-label={option.label} disabled={busy||value.status!=="ready"} value={String(option.value)} onChange={event=>run("configure",{option_id:option.id,value:typeof option.value==="boolean"?event.target.value==="true":event.target.value,configuration_revision:value.configuration_revision})}>{typeof option.value==="boolean"?<><option value="true">启用</option><option value="false">关闭</option></>:(option.choices??[]).map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>)}</div>}
      {value.capabilities?.compact&&<button disabled={busy||value.status!=="ready"} onClick={()=>run("compact")}>压缩上下文</button>}
      {value.capabilities?.history&&<button disabled={busy} onClick={()=>{void call("history",{history_revision:value.history_revision}).then(result=>setHistory(result.conversation?.history_page??result)).catch(error=>notify(error.message));}}>读取历史</button>}
      {!!value.command_catalog?.commands.length&&<details><summary>引擎命令</summary><form onSubmit={event=>{event.preventDefault();if(command)run("command",{command_name:command,command_arguments:argument,command_revision:value.command_catalog!.revision});}}><select aria-label="引擎命令" disabled={busy} value={command} onChange={event=>setCommand(event.target.value)}><option value="">请选择命令</option>{value.command_catalog.commands.map(item=><option key={item.name} value={item.name}>{item.name}{item.description?"："+item.description:""}</option>)}</select><input aria-label="命令参数" value={argument} maxLength={65536} onChange={event=>setArgument(event.target.value)}/><button disabled={busy||!command||value.status!=="ready"}>执行命令</button></form></details>}
    </div></details>;
  return <>{hasSettings&&settingsTarget&&createPortal(settings,settingsTarget)}{hasInteractions&&<section className="external-session-controls" aria-label="引擎会话交互">
    {value.approvals.map(request=><div className="external-conversation-approval" key={request.id}><strong>{request.title}</strong><p>{request.detail}</p><div>{request.options.map(option=><button key={option.id} disabled={busy} onClick={()=>run("approve",{approval_id:request.id,option_id:option.id})}>{option.label}</button>)}</div></div>)}
    {value.questions?.map(request=><ExternalQuestionForm key={JSON.stringify([snapshot.generation,request.id])} request={request} answer={answers=>call("answer",{request_id:request.id,answers})} error={notify}/>)}
    {value.elicitations?.map(request=><ExternalElicitationForm key={JSON.stringify([snapshot.generation,request.id,request.revision])} request={request} respond={response=>call("respond",{request_id:request.id,request_revision:request.revision,response})} open={()=>call("open_url",{request_id:request.id})} error={notify}/>)}
    {messages.map(message=><details key={message.id}><summary>{message.plan?"执行计划":"思考过程"}</summary>{message.plan?<ol>{message.plan.map((step,index)=><li key={index}>{step.content} <small>{step.status}</small></li>)}</ol>:<pre>{message.text}</pre>}</details>)}
    {history&&<details open><summary>历史记录</summary><pre>{(history.messages??[]).map((message:any)=>message.text).join("\n\n")}</pre><button onClick={()=>setHistory(undefined)}>收起历史</button></details>}
  </section>}</>;
}
