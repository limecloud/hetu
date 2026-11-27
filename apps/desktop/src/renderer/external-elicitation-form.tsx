import React,{useState} from "react";
import {validateExternalElicitationResponse,type ExternalElicitation,type ExternalElicitationResponse,type ExternalFormValue} from "../shared/external-elicitation.ts";

/** 原服务的字段与决定；浏览器打开和提交决定是两个独立动作。 */
export function ExternalElicitationForm({request,respond,open,error}:{request:ExternalElicitation;respond(value:ExternalElicitationResponse):Promise<unknown>;open():Promise<unknown>;error(message:string):void}){
  const [values,setValues]=useState<Record<string,string|boolean|string[]>>(()=>Object.create(null)),[busy,setBusy]=useState(false),[opened,setOpened]=useState(false),[opening,setOpening]=useState(false);
  const copyValues=()=>Object.assign(Object.create(null),values) as typeof values;
  const submit=(action:ExternalElicitationResponse["action"])=>{
    if(busy)return;
    try{
      const content=Object.fromEntries(Object.entries(values).map(([id,value])=>{const field=request.mode==="form"?request.fields.find(field=>field.id===id):undefined;return [id,field&&["number","integer"].includes(field.type)&&typeof value==="string"&&value!==""?Number(value):value];})) as Record<string,ExternalFormValue>;
      const response=validateExternalElicitationResponse(request,{action,...(action==="accept"&&request.mode==="form"?{content}:{})});
      setBusy(true);void respond(response).catch(cause=>error((cause as Error).message)).finally(()=>setBusy(false));
    }catch(cause){error((cause as Error).message);}
  };
  return <form className="external-conversation-elicitation" aria-label={request.title} noValidate onSubmit={event=>{event.preventDefault();submit("accept");}}>
    <strong>{request.title}</strong><small>服务：{request.server}</small>{request.environment_id&&<small>登记范围：{request.environment_id}</small>}<p>{request.message}</p>
    {request.mode==="url"?<>
      <code className="external-elicitation-url">{request.url}</code>
      <p>请在浏览器中完成此服务的操作，再告知提供方继续核验。</p>
      <button type="button" disabled={busy||opening} onClick={()=>{setOpening(true);void open().then(()=>setOpened(true)).catch(cause=>error((cause as Error).message)).finally(()=>setOpening(false));}}>{opening?"正在打开…":"在浏览器打开"}</button>
      {opened&&<small role="status">已交给浏览器打开；网页操作结果由提供方核验。</small>}
    </>:request.fields.map(field=><fieldset key={field.id} disabled={busy}>
      <legend>{field.title}{field.required?"（必填）":"（可选）"}</legend>{field.description&&<p>{field.description}</p>}
      {field.type==="boolean"?<select aria-label={field.title} value={Object.hasOwn(values,field.id)?String(values[field.id]):""} onChange={event=>{const next=copyValues();if(event.target.value==="")delete next[field.id];else next[field.id]=event.target.value==="true";setValues(next);}}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>:
      field.type==="array"?<div>{field.options!.map(option=><label key={option.value}><input type="checkbox" checked={Array.isArray(values[field.id])&&(values[field.id] as string[]).includes(option.value)} onChange={event=>{const prior=(Array.isArray(values[field.id])?values[field.id]:[]) as string[];setValues({...values,[field.id]:event.target.checked?[...prior,option.value]:prior.filter(value=>value!==option.value)});}}/>{option.label}{option.description&&<small>{option.description}</small>}</label>)}</div>:
      field.options?<select aria-label={field.title} value={Object.hasOwn(values,field.id)?"value:"+values[field.id]:""} onChange={event=>{const next=copyValues();if(event.target.value==="")delete next[field.id];else next[field.id]=event.target.value.slice(6);setValues(next);}}><option value="">请选择</option>{field.options.map(option=><option key={option.value} value={"value:"+option.value}>{option.label}{option.description?"："+option.description:""}</option>)}</select>:
      <input aria-label={field.title} type={field.type==="number"||field.type==="integer"?"number":"text"} step={field.type==="number"?"any":field.type==="integer"?1:undefined} min={field.minimum} max={field.maximum} maxLength={8000} autoComplete="off" value={Object.hasOwn(values,field.id)?String(values[field.id]):""} onChange={event=>{const next=copyValues();if(event.target.value===""&&field.type!=="string")delete next[field.id];else next[field.id]=event.target.value;setValues(next);}}/>}
      {!field.required&&Object.hasOwn(values,field.id)&&<button type="button" onClick={()=>{const next=copyValues();delete next[field.id];setValues(next);}}>不填写此项</button>}
    </fieldset>)}
    <div className="external-elicitation-actions"><button disabled={busy}>{busy?"正在提交…":request.mode==="url"?"已完成网页操作":"提交表单"}</button><button type="button" disabled={busy} onClick={()=>submit("decline")}>拒绝提供</button><button type="button" disabled={busy} onClick={()=>submit("cancel")}>取消请求</button></div>
  </form>;
}
