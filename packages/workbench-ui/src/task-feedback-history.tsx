import React,{useEffect,useRef,useState} from "react";
import type {ImageRegion} from "./image-region.ts";
import type {MappedSelection} from "./source-selection.ts";

export type FeedbackTaskRef={scope_ref:{kind:string;id:string};task_id:string;request_revision:number;sha256?:string};
export type TaskFeedbackTarget=
 |{kind:"candidate";candidate_ref:Record<string,unknown>;range?:MappedSelection;image_region?:ImageRegion}
 |{kind:"working_copy";working_copy_ref:Record<string,unknown>;range?:MappedSelection}
 |{kind:"context";context_ref:{context_id:string;sha256:string};range?:MappedSelection};
import type {FeedbackRef} from "./task-reference.ts";
export type TaskFeedbackEntry={feedback:{task_ref:FeedbackTaskRef;feedback_id:string;sequence:number;intent:"preference"|"request_changes";public_comment:string;target_refs:TaskFeedbackTarget[]};feedback_ref:FeedbackRef;reported_result_refs:unknown[];author_acceptance:"not_implied"};
export type TaskFeedbackPage={feedback:TaskFeedbackEntry[];feedback_head:FeedbackRef|null;next_cursor:string|null};
const taskKey=(task:FeedbackTaskRef)=>JSON.stringify([task.scope_ref.kind,task.scope_ref.id,task.task_id,task.request_revision,task.sha256]);
const refKey=(ref:FeedbackRef|null)=>JSON.stringify(ref&&[ref.feedback_id,ref.sha256]);

/** 只读原任务意见；分页与返稿事实来自Core，不在页面增加处理决定。 */
export function TaskFeedbackHistory({task,read,filter,onPosition,onContinue,onCopy,continueLabel,revision,available=true,disabled=false,language="zh-CN"}:{
 task:FeedbackTaskRef;read(after?:string,signal?:AbortSignal):Promise<TaskFeedbackPage>;filter?(target:TaskFeedbackTarget):boolean;
 onPosition?(target:TaskFeedbackTarget):void;revision?:string;available?:boolean;disabled?:boolean;language?:string;
 onContinue?(entry:TaskFeedbackEntry):void;onCopy?(entry:TaskFeedbackEntry):void;continueLabel?:string;
}){
 const english=language==="en",key=taskKey(task),generation=useRef(0),opened=useRef(false),details=useRef<HTMLDetailsElement>(null),reading=useRef<AbortController>();
 const reader=useRef(read);reader.current=read;
 const failedReset=useRef(false);
 const [page,setPage]=useState<{entries:TaskFeedbackEntry[];head:FeedbackRef|null;next:string|null;seen:string[];revision?:string}>(),[loading,setLoading]=useState(false),[error,setError]=useState("");
 const [status,setStatus]=useState("all");
 const labels=english?{summary:"All feedback",region:"Public feedback history",loading:"Loading feedback…",reload:"Reload feedback",more:"More feedback",retry:"Retry reading feedback",all:"All",pending:"Awaiting revision",returned:"Revision returned",preference:"Preference recorded",empty:"No matching feedback in the loaded history.",position:"View original position",image:"Original image region",reference:"Fixed reference",original:"Original passage",unavailable:"The host cannot read feedback right now.",invalid:"Feedback history does not match this task or page. Reload it."}
  :{summary:"全部意见",region:"公开意见历史",loading:"正在读取意见…",reload:"重新读取意见",more:"更多意见",retry:"重试读取意见",all:"全部",pending:"待返稿",returned:"已有返稿",preference:"已记录偏好",empty:"已读历史中没有对应意见。",position:"查看原位置",image:"原图区域",reference:"固定参考资料",original:"原文位置",unavailable:"当前宿主暂不能读取意见。",invalid:"意见历史与当前任务或分页不一致，请重新读取。"};
 useEffect(()=>{
  generation.current++;reading.current?.abort();failedReset.current=false;opened.current=false;if(details.current)details.current.open=false;setPage(undefined);setError("");setLoading(false);setStatus("all");
  return()=>{generation.current++;reading.current?.abort();opened.current=false;};
 },[key]);
 useEffect(()=>{if(!available){generation.current++;reading.current?.abort();setLoading(false);}},[available]);
 async function load(reset=false){
  if(!opened.current||loading)return;
  if(!available){setError(labels.unavailable);return;}
  const epoch=++generation.current,prior=reset?undefined:page,cursor=prior?.next??undefined;
  const controller=new AbortController();reading.current=controller;
  setLoading(true);setError("");
  try{
   const next=await reader.current(cursor,controller.signal);
   if(epoch!==generation.current||!opened.current)return;
   const invalid=()=>{throw Error(labels.invalid);};
   if(!Array.isArray(next?.feedback)||next.feedback.length>10||next.next_cursor!==null&&typeof next.next_cursor!=="string"||next.feedback_head!==null&&(!next.feedback_head?.feedback_id||!next.feedback_head.sha256))invalid();
   if(prior&&refKey(prior.head)!==refKey(next.feedback_head))invalid();
   if(next.next_cursor&&(next.next_cursor===cursor||prior?.seen.includes(next.next_cursor)))invalid();
   const entries=[...(prior?.entries??[])];
   for(const entry of next.feedback){
    if(!entry?.feedback?.task_ref||taskKey(entry.feedback.task_ref)!==key||!Number.isSafeInteger(entry.feedback.sequence)||entry.feedback.sequence<1||entry.feedback.sequence>100||entry.feedback.sequence<=(entries.at(-1)?.feedback.sequence??0)||entries.some(previous=>previous.feedback_ref.feedback_id===entry.feedback_ref?.feedback_id)||entry.feedback.feedback_id!==entry.feedback_ref?.feedback_id||!Array.isArray(entry.feedback.target_refs)||typeof entry.feedback.public_comment!=="string"||!Array.isArray(entry.reported_result_refs)||entry.author_acceptance!=="not_implied")invalid();
    entries.push(entry);
   }
   if(entries.length>100||next.next_cursor&&!next.feedback.length)invalid();
   setPage({entries,head:next.feedback_head,next:next.next_cursor,seen:[...(prior?.seen??[]),...(cursor?[cursor]:[])],revision});
  }catch(error){if(epoch===generation.current&&opened.current){failedReset.current=reset;setError(error instanceof Error?error.message:String(error));}}
  finally{if(epoch===generation.current)setLoading(false);}
 }
 const state=(entry:TaskFeedbackEntry)=>entry.feedback.intent==="preference"?"preference":entry.reported_result_refs.length?"returned":"pending";
 const entries=page?.entries.filter(entry=>(!filter||entry.feedback.target_refs.some(filter))&&(status==="all"||state(entry)===status))??[];
 const changed=page&&page.revision!==revision;
 return <details ref={details} className="task-feedback-history" onToggle={event=>{
  opened.current=event.currentTarget.open;
  if(opened.current){if(!page)void load(true);}
  else{generation.current++;reading.current?.abort();setLoading(false);}
 }}><summary onClick={()=>{
  // toggle通知排入后续任务；先在关闭动作中阻止迟到回包继续分页。
  if(details.current?.open){generation.current++;opened.current=false;reading.current?.abort();setLoading(false);}
 }}>{labels.summary}</summary>
  <section aria-label={labels.region} aria-busy={loading}>
   <div className="feedback-history-tools"><label>{english?"Show":"显示"}<select aria-label={english?"Feedback status":"意见状态"} value={status} onChange={event=>setStatus(event.target.value)}>
    <option value="all">{labels.all}</option><option value="pending">{labels.pending}</option><option value="returned">{labels.returned}</option><option value="preference">{labels.preference}</option>
   </select></label><button type="button" disabled={loading||!available} onClick={()=>void load(true)}>{labels.reload}</button></div>
   {loading&&<p role="status">{labels.loading}</p>}
   {changed&&!loading&&<p role="status">{english?"The task has changed. Reload its feedback.":"任务已有更新，请重新读取意见。"}</p>}
   {error&&<p role="alert">{error}</p>}
   {page&&!entries.length&&<p className="muted">{labels.empty}</p>}
   <div className="feedback-history-list">{entries.map(entry=><article aria-label={`${english?"Feedback":"意见"} ${entry.feedback.sequence}`} key={entry.feedback_ref.feedback_id}>
    <header><h4>{english?"Feedback":"意见"} {entry.feedback.sequence}</h4><span className="muted">{labels[state(entry)]}</span></header>
    <p className="feedback-history-comment">{entry.feedback.public_comment}</p>
    {entry.feedback.target_refs.filter(target=>!filter||filter(target)).map((target,index)=>{
     const region=target.kind==="candidate"?target.image_region:undefined;
     return <div className="feedback-history-target" key={index}>
      {region?<p>{labels.image} {region.x}, {region.y}　{region.width} × {region.height} px</p>:target.range?<blockquote>{target.range.quote}</blockquote>:<span className="muted">{target.kind==="context"?labels.reference:labels.original}</span>}
      {onPosition&&<button type="button" disabled={disabled||loading||!available} onClick={()=>onPosition(target)}>{labels.position}</button>}
     </div>;
    })}
    {(onContinue||onCopy)&&<div className="actions">
     {onContinue&&<button type="button" disabled={disabled||loading||!available} onClick={()=>onContinue(entry)}>{continueLabel??(english?"Continue this feedback":"继续处理此意见")}</button>}
     {onCopy&&<button type="button" disabled={disabled||loading||!available} onClick={()=>onCopy(entry)}>{english?"Copy continuation prompt":"复制继续提示词"}</button>}
    </div>}
    <details className="feedback-history-reference"><summary>{english?"Fixed references":"固定引用"}</summary><pre>{JSON.stringify({feedback_ref:entry.feedback_ref,target_refs:entry.feedback.target_refs},null,2)}</pre></details>
   </article>)}</div>
   {error?<button type="button" disabled={loading||!available||!!changed&&!failedReset.current} onClick={()=>void load(failedReset.current)}>{labels.retry}</button>:page?.next?<button type="button" disabled={loading||!available||!!changed} onClick={()=>void load()}>{labels.more}</button>:null}
  </section>
 </details>;
}
