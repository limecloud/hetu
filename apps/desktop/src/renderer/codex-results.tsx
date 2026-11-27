import React,{useEffect,useRef,useState} from "react";
import type {SessionSnapshot} from "../agent-session-contract.ts";
import type {SessionResult,SessionResults} from "../session-results.ts";
import {desktop} from "./bridge.ts";
import {Icon} from "@hetu/workbench-ui";
export type SessionResultsReader=(snapshot:SessionSnapshot)=>Promise<SessionResults>;

/** 两种表面共用真实成果回读；终端回显及模型文字均不触发保存提示。 */
export function CodexResults({snapshot,compact=false,inline=false,readResults,disabled=false}:{snapshot:SessionSnapshot;compact?:boolean;inline?:boolean;readResults?:SessionResultsReader;disabled?:boolean}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [value,setValue]=useState<SessionResults>();
 const root=useRef<HTMLDivElement>(null);
 const key=JSON.stringify([snapshot.session_id,snapshot.thread_id,snapshot.generation,snapshot.work_ref?.workspace_id,snapshot.work_ref?.kind,snapshot.work_ref?.object_id]);
 const epoch=useRef(0);
 const request=useRef(0);
 useEffect(()=>{epoch.current++;setValue(undefined);setError("");setOpen(false);setBusy(false);return()=>{epoch.current++;};},[key]);
 const completed=(snapshot.tools??[]).filter(tool=>tool.state==="completed").map(tool=>[tool.id,tool.output?.length]).join(";");
 useEffect(()=>{if(inline&&!disabled&&completed&&!['running','starting','stopping','switching'].includes(snapshot.state))void refresh();},[inline,key,completed,snapshot.state,disabled]);
 useEffect(()=>{
  if(!open)return;
  const dismiss=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
  const keyboard=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!event.isComposing&&!document.querySelector("dialog[open]")){event.preventDefault();event.stopPropagation();setOpen(false);root.current?.querySelector<HTMLButtonElement>(":scope > button")?.focus();}};
  document.addEventListener("pointerdown",dismiss);document.addEventListener("keydown",keyboard,true);
  return()=>{document.removeEventListener("pointerdown",dismiss);document.removeEventListener("keydown",keyboard,true);};
 },[open]);
 async function refresh(){
  if(disabled)return;
  const ticket=epoch.current,attempt=++request.current;
  setBusy(true);setError("");
  try{const value=await (readResults?readResults(snapshot):desktop.agentSession("results",{session_id:snapshot.session_id,...(snapshot.work_ref?{work_ref:snapshot.work_ref}:{scope:"library"})}));if(ticket===epoch.current&&attempt===request.current)setValue(value);}
  catch(error){if(ticket===epoch.current&&attempt===request.current){setValue(undefined);setError((error as Error).message);}}finally{if(ticket===epoch.current&&attempt===request.current)setBusy(false);}
 }
 function show(item:SessionResult){setOpen(false);window.dispatchEvent(new CustomEvent("hetu:session-result",{detail:item}));}
 if(inline){
  if(!busy&&!error&&!value?.items.length&&!value?.unread)return null;
  return <section className="codex-results-inline" aria-label="作品变更"><header><strong>作品变更</strong><button disabled={busy||disabled} onClick={()=>void refresh()}>{busy?"正在回读…":"核对成果"}</button></header>{error&&<p role="alert">{error}</p>}{value?.items.map(item=><div key={item.id} className="codex-result"><span>{item.state==="verified"?"已回读":"待核对"}</span><button disabled={disabled||item.state!=="verified"} onClick={()=>show(item)}>{item.title}</button>{item.message&&<small>{item.message}</small>}</div>)}{!!value?.unread&&<p>{value.unread}项结果未能完整回读。</p>}</section>;
 }
 return <div ref={root} className="codex-results">
  <button aria-label={busy?"正在回读成果…":"查看作品成果"} title="查看作品成果" aria-expanded={open} disabled={busy||disabled} onClick={()=>{setOpen(!open);if(!open)void refresh();}}>{compact?<Icon name="check"/>:busy?"正在回读成果…":"查看作品成果"}</button>
  {open&&<section aria-label="作品成果" className="codex-results-panel"><header><strong>已保存成果</strong><button disabled={busy||disabled} onClick={()=>void refresh()}>重新回读</button></header>
   {error&&<p role="alert">{error}</p>}
   {value?.items.map(item=><div key={item.id} className="codex-result"><span>{item.state==="verified"?"已回读":"待核对"}</span><button disabled={disabled||item.state!=="verified"} onClick={()=>show(item)}>{item.title}</button>{item.message&&<small>{item.message}</small>}</div>)}
   {!busy&&value&&!value.items.length&&<p>暂无可回读的保存成果。可在作品中核对其他变化。</p>}
   {!!value?.unread&&<p>{value.unread}项结果未能完整回读，请查看过程并核对作品。</p>}
  </section>}
 </div>;
}
