import React,{useEffect,useRef,useState} from "react";
import type {WorkRef} from "@hetu/plugin-sdk";
import {desktop,data} from "./bridge.ts";
import {canonEntries,canonKinds,entityName} from "./canon-model.ts";
import {ContextPickerDialog,type ContextSelection} from "./agent-context-dialog.tsx";

/** 大纲和设定继续由领域Owner提供，界面只保存所选固定引用。 */
export function AgentDomainContextPicker({kind,work,onSelect,onClose}:{kind:"outlines"|"canon";work:WorkRef;onSelect(value:ContextSelection):Promise<boolean>;onClose():void}){
 const generation=useRef(0),queryUsed=useRef("");
 const [items,setItems]=useState<any[]>([]),[snapshot,setSnapshot]=useState<any>(),[query,setQuery]=useState(""),[section,setSection]=useState("characters");
 const [cursor,setCursor]=useState<string>(),[count,setCount]=useState(20),[loading,setLoading]=useState(false),[loaded,setLoaded]=useState(false),[attaching,setAttaching]=useState(false),[error,setError]=useState("");
 const title=kind==="outlines"?"正式大纲":"人物与设定";
 async function load(more=false){
  const token=++generation.current;setLoading(true);setError("");
  if(!more){setItems([]);setCursor(undefined);queryUsed.current=query;}
  try{
   if(kind==="outlines"){
    const value=data(await desktop.read("hetu.outlines.get",{work_ref:work,detail:"summary",query:queryUsed.current,limit:20,...(more&&cursor?{cursor}:{})}));
    if(token!==generation.current)return;
    const rows=value.items.map((item:any)=>({...item,outlineRevision:value.revision,outlineSha256:value.sha256}));
    setItems(previous=>more?[...previous,...rows]:rows);setCursor(value.next_cursor??undefined);
   }else{
    const value=data(await desktop.read("hetu.blueprints.get",{work_ref:work}));
    if(token!==generation.current)return;
    setSnapshot(value);setItems(canonEntries(value.blueprint).filter(entry=>!entry.value.archived));
   }
   setLoaded(true);
  }catch(e){if(token===generation.current)setError((e as Error).message);}
  finally{if(token===generation.current)setLoading(false);}
 }
 useEffect(()=>{void load();return()=>{generation.current++;};},[kind,work.workspace_id,work.kind,work.object_id]);
 useEffect(()=>setCount(20),[section,query]);
 async function choose(value:ContextSelection){
  const token=generation.current;setAttaching(true);setError("");
  try{if(await onSelect({...value,label:value.label.trim().slice(0,120)})&&token===generation.current)onClose();}
  catch(e){if(token===generation.current)setError((e as Error).message);}
  finally{if(token===generation.current)setAttaching(false);}
 }
 const filtered=kind==="canon"?items.filter(entry=>entry.section===section&&entityName(entry).toLowerCase().includes(query.toLowerCase())):items;
 return <ContextPickerDialog title={title} disabled={attaching} onClose={onClose}>
  <form onSubmit={event=>{event.preventDefault();if(kind==="outlines")void load();}}>
   {kind==="canon"&&<select aria-label="设定分类" value={section} disabled={attaching} onChange={event=>setSection(event.target.value)}>{canonKinds.map(item=><option key={item.section} value={item.section}>{item.label}</option>)}</select>}
   <input type="search" aria-label={kind==="outlines"?"查找正式大纲":"查找人物或设定"} maxLength={120} value={query} disabled={attaching} onChange={event=>setQuery(event.target.value)}/>
   {kind==="outlines"&&<button disabled={attaching||loading}>查找</button>}
  </form>
  {error&&<p role="alert">{error}</p>}
  {(loading||attaching)&&<p role="status">{attaching?"正在附加固定来源…":"正在读取来源目录…"}</p>}
  {kind==="canon"&&snapshot?.blueprint&&<button disabled={attaching||loading} onClick={()=>void choose({page:"work.canon",object:{blueprint_revision:snapshot.revision},label:"人物与设定"})}>附加整份设定<small>第{snapshot.revision}版</small></button>}
  <div className="agent-context-picker-items">{(kind==="canon"?filtered.slice(0,count):filtered).map(item=>kind==="outlines"?
   <button key={item.id} disabled={attaching||loading} onClick={()=>void choose({page:"novel.outlines",object:{outline_id:item.id,outline_revision:item.outlineRevision,outline_sha256:item.outlineSha256},label:item.title})}><span className="agent-context-picker-copy"><strong>{item.title}</strong><span>{item.excerpt}</span></span><small>{({book:"总纲",volume:"卷纲",chapter:"章纲"} as Record<string,string>)[item.level]} 第{item.outlineRevision}版</small></button>:
   <button key={item.value[item.id]} disabled={attaching||loading} onClick={()=>void choose({page:"work.canon",object:{entity_ref:item.value[item.id],blueprint_revision:snapshot.revision},label:entityName(item)})}><span className="agent-context-picker-copy"><strong>{entityName(item)}</strong>{(item.value.description||item.value.rationale||item.value.aliases?.length>0)&&<span>{String(item.value.description||item.value.rationale||item.value.aliases.join("、")).slice(0,200)}</span>}</span><small>{item.label} 第{snapshot.revision}版</small></button>)}</div>
  {loaded&&!loading&&!error&&!filtered.length&&<p>{kind==="outlines"?queryUsed.current?"没有匹配的正式大纲。":"还没有正式大纲。":snapshot?.blueprint?"没有匹配的人物或设定。":"当前作品尚未建立设定。"}</p>}
  {kind==="outlines"&&cursor&&<button disabled={loading||attaching} onClick={()=>void load(true)}>更多大纲</button>}
  {kind==="canon"&&filtered.length>count&&<button disabled={attaching} onClick={()=>setCount(value=>value+20)}>更多人物或设定</button>}
  {error&&<button disabled={loading||attaching} onClick={()=>void load()}>重新读取</button>}
 </ContextPickerDialog>;
}
