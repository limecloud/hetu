import React,{useEffect,useRef,useState} from "react";
import {desktop} from "./bridge.ts";

const labels:Record<string,{action:string;confirmed:string;withdrawn:string}>= {
 previsualization:{action:"认可预演",confirmed:"本版预演已认可",withdrawn:"本版预演认可已撤回"},
 clip:{action:"选用片段",confirmed:"本版片段已选用",withdrawn:"本版片段选用已撤回"},
 final:{action:"确认成片",confirmed:"本版成片已确认",withdrawn:"本版成片确认已撤回"},
};

/** 仅呈现Core的固定决定；播放完成和模型评价均不产生作者认可。 */
export function VideoDecision({view,changed,locked}:{view:any;changed():Promise<void>;locked:boolean}){
 const [journal,setJournal]=useState<any>(),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [decision,setDecision]=useState<"confirmed"|"withdrawn">(),[statement,setStatement]=useState("");
 const [history,setHistory]=useState<any>(),[historyOpen,setHistoryOpen]=useState(false),[historyLoading,setHistoryLoading]=useState(false),[historyError,setHistoryError]=useState("");
 const modal=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),hadDialog=useRef(false),active=useRef(true),historyEpoch=useRef(0);
 const label=labels[view.media.purpose],current=view.author_decision;
 const pending=journal?.status==="pending"||journal?.status==="succeeded"&&journal.acknowledged!==true,disabled=locked||busy||!ready||pending;
 useEffect(()=>{void desktop.video("decision_journal").then(value=>{if(active.current){setJournal(value);setReady(true);}}).catch(error=>{if(active.current)setError(error.message);});return()=>{active.current=false;historyEpoch.current++;};},[]);
 useEffect(()=>{if(decision){hadDialog.current=true;if(!modal.current?.open)modal.current?.showModal();}else if(hadDialog.current&&!busy){hadDialog.current=false;trigger.current?.focus();}},[decision,busy]);
 async function refreshJournal(){const value=await desktop.video("decision_journal");if(active.current){setJournal(value);setReady(true);}return value;}
 async function run(action:()=>Promise<void>){
  setBusy(true);setError("");
  try{await action();}catch(error){if(active.current)setError((error as Error).message);await refreshJournal().catch(()=>{});}
  finally{if(active.current)setBusy(false);}
 }
 function open(value:"confirmed"|"withdrawn"){
  setError("");setStatement(`${value==="withdrawn"?"撤回":label.action}《${view.media.title}》这一版。`);setDecision(value);
 }
 async function received(record:any){
  await changed();
  const acknowledged=await desktop.video("acknowledge_decision",{operation_key:record.input.operation_key,decision_ref:record.result.decision_ref});
  if(active.current){setJournal(acknowledged);setDecision(undefined);setHistory(undefined);if(historyOpen)await loadHistory();}
 }
 async function save(){
  const prepared=await desktop.video("prepare_decision",{media_ref:view.media_ref,purpose:view.media.purpose,decision,expected_decision_ref:current?.current_decision_ref??null,author_statement:statement});
  const snapshot=prepared.preview?.snapshot;
  if(snapshot?.title!==view.media.title||snapshot.media_ref?.sha256!==view.media_ref.sha256||snapshot.media_ref?.media_id!==view.media_ref.media_id||snapshot.media_ref?.revision!==view.media_ref.revision)throw Error("媒体决定预览与正在查看的版本不一致，请重新读取。");
  const record=await desktop.video("save_decision",{token:prepared.token});
  if(!active.current)return;
  await received(record);
 }
 async function recover(){const record=await desktop.video("recover_decision");if(active.current)await received(record);}
 async function loadHistory(more=false){
  const ticket=++historyEpoch.current;setHistoryLoading(true);setHistoryError("");
  try{const value=await desktop.video("decision_history",{video_episode_id:view.media.video_episode_id,purpose:view.media.purpose,limit:20,...(more&&history?.next_cursor?{cursor:history.next_cursor}:{})});if(active.current&&ticket===historyEpoch.current)setHistory((old:any)=>more?{...value,items:[...(old?.items??[]),...value.items]}:value);}
  catch(error){if(active.current&&ticket===historyEpoch.current)setHistoryError((error as Error).message);}
  finally{if(active.current&&ticket===historyEpoch.current)setHistoryLoading(false);}
 }
 if(!label)return null;
 return <section className="video-decision" aria-label="视频认可" aria-busy={busy||!ready&&!error}>
  <div className="surface-filters">
   <span>{current?.state==="confirmed"?label.confirmed:current?.state==="withdrawn"?label.withdrawn:current?.state==="other_media"?"认可记录属于本集另一版本":"本版尚未认可"}</span>
   <button ref={trigger} disabled={disabled} onClick={()=>open(current?.state==="confirmed"?"withdrawn":"confirmed")}>{current?.state==="confirmed"?"撤回本版认可":label.action}</button>
   <button disabled={busy} aria-expanded={historyOpen} onClick={()=>{historyEpoch.current++;setHistoryOpen(!historyOpen);setHistoryLoading(false);if(!historyOpen)void loadHistory();}}>{historyOpen?"收起认可历史":"认可历史"}</button>
  </div>
  {pending&&<p role="status">前次决定尚待核对。<button disabled={busy} onClick={()=>void run(recover)}>恢复原决定</button></p>}
  {error&&<div role="alert"><p>{error}</p>{!busy&&!pending&&<button onClick={()=>void run(async()=>{await refreshJournal();await changed();})}>重新读取认可状态</button>}</div>}
  {historyOpen&&<section aria-label="认可历史" aria-busy={historyLoading}>
   {historyLoading&&!history&&<p role="status">正在读取认可历史…</p>}
   {history?.items?.map((item:any)=><blockquote key={item.decision_ref.revision}><strong>第{item.decision_ref.revision}次 {item.decision.decision==="confirmed"?label.action:"撤回认可"}</strong><p>{item.decision.author_statement}</p></blockquote>)}
   {history?.total===0&&<p className="muted">还没有认可记录。</p>}
   {history?.next_cursor&&<button disabled={historyLoading} onClick={()=>void loadHistory(true)}>更多认可历史</button>}
   {historyError&&<div role="alert"><p>{historyError}</p><button disabled={historyLoading} onClick={()=>void loadHistory(!!history?.next_cursor)}>重新读取认可历史</button></div>}
  </section>}
  {decision&&<dialog ref={modal} aria-label={decision==="confirmed"?label.action:"撤回本版认可"} onCancel={event=>{event.preventDefault();if(!busy)setDecision(undefined);}}>
   <form onSubmit={event=>{event.preventDefault();void run(save);}}>
    <h2>{decision==="confirmed"?label.action:"撤回本版认可"}</h2><p>{view.media.title}</p>
    <label>决定说明<textarea aria-label="决定说明" maxLength={4000} value={statement} disabled={busy} onChange={event=>setStatement(event.target.value)}/></label>
    {error&&<div role="alert"><p>{error}</p>{!pending&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await refreshJournal();await changed();})}>重新读取认可状态</button>}</div>}
    {pending&&<p role="status">前次决定尚待核对。<button type="button" disabled={busy} onClick={()=>void run(recover)}>恢复原决定</button></p>}
    <div className="surface-filters"><button type="button" disabled={busy} onClick={()=>setDecision(undefined)}>取消</button><button type="submit" disabled={busy||!statement.trim()||pending}>{decision==="confirmed"?"确认本版":"撤回本版"}</button></div>
   </form>
  </dialog>}
 </section>;
}
