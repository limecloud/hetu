import React, {useEffect, useLayoutEffect, useRef, useState} from "react";
import {sameWork, type WorkRef} from "@hetu/plugin-sdk";
import {Icon, IconButton, ManuscriptText, ScreenplayText} from "@hetu/workbench-ui";
import type {SessionSnapshot} from "../agent-session-contract.ts";
import {desktop, data} from "./bridge.ts";
import {readWorkContent} from "./work-content.ts";
import {ResourceBody} from "./resource-reading.tsx";
import {useObjectContextMenu} from "./text-context-menus.tsx";
import {viewStorage} from "./view-storage.ts";
import {AgentPreviewTabs} from "./agent-preview-tabs.tsx";

type Entry={kind:"document"|"resource";id:string;revision:string|number;title:string};
type Preview={entry:Entry;text:string;format:string;pinned:boolean};
type Group={title:string;entries:Entry[];episode_id?:string};
const referenceType="application/x-hetu-work-reference";
const entryKey=(entry:Entry)=>JSON.stringify([entry.kind,entry.id,entry.revision]);

/** 只呈现Core正式内容；临时预览和目录状态不拥有作品数据。 */
export function AgentContent({work,snapshot,sessionTitle,children,notify,header,maximized=false}:{work?:WorkRef;snapshot:SessionSnapshot;sessionTitle:string;children:React.ReactNode;notify(message:string):void;header?(controls:React.ReactNode,tabs:React.ReactNode):React.ReactNode;maximized?:boolean}) {
  const [groups,setGroups]=useState<Group[]>([]),[errors,setErrors]=useState<string[]>([]),[busy,setBusy]=useState(false);
  const [query,setQuery]=useState(""),[collapsed,setCollapsed]=useState<Set<string>>(new Set());
  const [visible,setVisible]=useState(()=>viewStorage.getItem("hetu-agent-directory-visible")!=="false"),[narrow,setNarrow]=useState(false),[overlay,setOverlay]=useState(false),[width,setWidth]=useState(()=>Math.max(220,Math.min(440,Number(viewStorage.getItem("hetu-agent-directory-width"))||350)));
  const [previews,setPreviews]=useState<Preview[]>([]),[active,setActive]=useState<string>();
  const [reading,setReading]=useState(false),[readError,setReadError]=useState("");
  const [requested,setRequested]=useState<Entry>();
  const generation=useRef(0),readGeneration=useRef(0),current=useRef(snapshot);current.current=snapshot;
  const panel=useRef<HTMLDivElement>(null),drag=useRef<{x:number;width:number}>();
  const cache=useRef(new Map<string,Preview>()),context=useObjectContextMenu(notify);
  const readingPanel=useRef<HTMLDivElement>(null),positions=useRef(new Map<string,number>());
  const locate=useRef<string>();
  const selected=previews.find(item=>entryKey(item.entry)===active);
  const head=selected&&groups.flatMap(group=>group.entries).find(entry=>entry.kind===selected.entry.kind&&entry.id===selected.entry.id);
  const outdated=(entry:Entry)=>groups.some(group=>group.entries.some(current=>current.kind===entry.kind&&current.id===entry.id&&entryKey(current)!==entryKey(entry)));
  const overlayMode=narrow||maximized;
  const directoryVisible=overlayMode?overlay:visible;
  const showDirectory=(show:boolean)=>{
    if(overlayMode)setOverlay(show);else setVisible(show);
    if(!show)requestAnimationFrame(()=>panel.current?.parentElement?.querySelector<HTMLButtonElement>('button[aria-label="作品目录"]')?.focus({preventScroll:true}));
  };
  useEffect(()=>{setOverlay(false);},[maximized]);
  useEffect(()=>{const element=panel.current;if(!element)return;const observer=new ResizeObserver(()=>setNarrow(element.clientWidth-width<600));observer.observe(element);return()=>observer.disconnect();},[width]);
  useEffect(()=>{viewStorage.setItem("hetu-agent-directory-width",String(width));},[width]);
  useEffect(()=>{viewStorage.setItem("hetu-agent-directory-visible",String(visible));},[visible]);
  useLayoutEffect(()=>{if(active&&readingPanel.current)readingPanel.current.scrollTop=positions.current.get(active)??0;},[active,reading]);
  useLayoutEffect(()=>{if(!locate.current||!directoryVisible)return;const row=[...panel.current?.querySelectorAll<HTMLButtonElement>(".agent-content-entry")??[]].find(row=>row.dataset.entryId===locate.current);if(row){row.scrollIntoView({block:"nearest"});row.focus({preventScroll:true});locate.current=undefined;}});
  const remember=()=>{if(active&&readingPanel.current)positions.current.set(active,readingPanel.current.scrollTop);};
  useEffect(()=>()=>{generation.current++;readGeneration.current++;},[]);
  async function load(){
    if(!work)return;
    const token=++generation.current;setBusy(true);setErrors([]);
    const results=await Promise.allSettled([
      readWorkContent(work,{active:()=>token===generation.current}).then(value=>value.groups.map(group=>({title:group.title,episode_id:group.episode_id,entries:group.documents.map(item=>({kind:"document" as const,id:item.document_id,revision:item.current_revision_id,title:group.episode_id?group.title:item.title}))}))),
      (async()=>{const entries:Entry[]=[];let cursor:string|undefined;do{if(token!==generation.current)return {title:"资料与素材",entries};const page=data(await desktop.resources("list",{cursor}));if(token!==generation.current)return {title:"资料与素材",entries};entries.push(...page.resources.map((item:any)=>({kind:"resource" as const,id:item.resource_id,revision:item.revision,title:item.title})));cursor=page.next_cursor??undefined;}while(cursor);return {title:"资料与素材",entries};})(),
    ]);
    if(token!==generation.current)return;
    const next:Group[]=[],failures:string[]=[];
    for(const [index,result] of results.entries())if(result.status==="fulfilled")next.push(...(Array.isArray(result.value)?result.value:[result.value]));else failures.push((index===0?"文稿":"资料")+"未能读取："+result.reason.message);
    setGroups(next);setErrors(failures);setBusy(false);
  }
  useEffect(()=>{void load();const changed=()=>{void load();};window.addEventListener("hetu:work-changed",changed);const un=desktop.onAgentSession(event=>{if(event.type==="notification"&&["turn/completed","results/verified"].includes(event.method)&&(event.work_ref?work&&sameWork(event.work_ref,work):event.session_id===current.current.session_id))changed();});return()=>{generation.current++;window.removeEventListener("hetu:work-changed",changed);un();};},[work?.workspace_id,work?.kind,work?.object_id]);
  async function open(entry:Entry,pinned=false){
    remember();
    const token=++readGeneration.current,key=entryKey(entry);setRequested(entry);setActive(key);setReading(true);setReadError("");
    try{
      let preview=cache.current.get(key);
      if(!preview){
        if(entry.kind==="document"){
          const value=data(await desktop.read("hetu.documents.get",{document_id:entry.id,revision_id:entry.revision}));
          if(value.document.document_id!==entry.id||value.revision.revision_id!==entry.revision)throw Error("文稿修订已有变化，请刷新目录。");
          preview={entry,text:value.content,format:value.revision.source_format,pinned};
        }else{
          const value=await desktop.resources("get",{resource_id:entry.id,revision:entry.revision});
          if(value.resource.resource_id!==entry.id||value.resource.revision!==entry.revision)throw Error("资料修订已有变化，请刷新目录。");
          preview={entry,text:value.resource.body,format:"markdown",pinned};
        }
        if(token!==readGeneration.current)return;
        cache.current.set(key,preview);
        while(cache.current.size>12)cache.current.delete(cache.current.keys().next().value!);
      }
      if(token!==readGeneration.current)return;
      const loaded=preview;
      setPreviews(previous=>{const existing=previous.find(item=>entryKey(item.entry)===key);return existing?previous.map(item=>item===existing?{...item,pinned:item.pinned||pinned}:item):[...previous.filter(item=>item.pinned),{...loaded,pinned}];});
    }catch(error){if(token===readGeneration.current)setReadError((error as Error).message);}
    finally{if(token===readGeneration.current)setReading(false);}
  }
  function terminal(){remember();readGeneration.current++;setReading(false);setReadError("");setActive(undefined);requestAnimationFrame(()=>panel.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea, .codex-composer textarea")?.focus({preventScroll:true}));}
  async function insert(entry:Entry){
    if(!work)throw Error("请先打开作品。");
    const fixed=current.current;
    if(fixed.surface==="gui"){
      await desktop.agentSession("attach_context",{session_id:fixed.session_id,generation:fixed.generation,work_ref:work,page:entry.kind==="document"?(work.kind==="drama"?"drama.reader":"novel.reader"):"work.resources",object:entry.kind==="document"?{document_id:entry.id,revision_id:entry.revision}:{resource_id:entry.id,revision:entry.revision},label:entry.title});
      if(current.current.session_id!==fixed.session_id||current.current.generation!==fixed.generation)throw Error("会话已切换，请在原会话核对所附来源。");
      terminal();return;
    }
    const request=await desktop.handoff(entry.kind==="document"?(work.kind==="drama"?"drama.reader":"novel.reader"):"work.resources",entry.kind==="document"?{document_id:entry.id,revision_id:entry.revision}:{resource_id:entry.id,revision:entry.revision},"draft");
    if(!request?.work_ref||!sameWork(work,request.work_ref)||current.current.session_id!==fixed.session_id||current.current.generation!==fixed.generation)throw Error("作品或会话已切换，引用未插入。");
    await desktop.agentSession("insert",{session_id:fixed.session_id,...(fixed.terminal_connected?{generation:fixed.generation}:{}),work_ref:work,text:request.prompt});terminal();
  }
  function edit(entry:Entry){
    if(entry.kind==="document")window.dispatchEvent(new CustomEvent("hetu:agent-document",{detail:{work_ref:work,document_id:entry.id}}));
    else window.dispatchEvent(new CustomEvent("hetu:agent-resource",{detail:{work_ref:work,resource_id:entry.id,revision:entry.revision,title:entry.title}}));
  }
  function select(key?:string){if(!key){terminal();return;}remember();readGeneration.current++;setReading(false);setReadError("");setRequested(previews.find(item=>entryKey(item.entry)===key)?.entry);setActive(key);}
  function close(keys:string[]){
    const closing=new Set(keys),remaining=previews.filter(item=>!closing.has(entryKey(item.entry)));
    let next=active;
    if(active&&closing.has(active)){const index=previews.findIndex(item=>entryKey(item.entry)===active),neighbor=remaining[Math.min(index,remaining.length-1)];next=neighbor?entryKey(neighbor.entry):undefined;select(next);}
    setPreviews(remaining);for(const key of keys)positions.current.delete(key);
    return next;
  }
  function reveal(key:string){
    const entry=previews.find(item=>entryKey(item.entry)===key)?.entry;if(!entry)return;
    const index=groups.findIndex(group=>group.entries.some(item=>item.kind===entry.kind&&item.id===entry.id));
    if(index<0){notify("当前目录中没有此内容，请刷新目录后重试。");return;}
    locate.current=entry.id;setQuery("");showDirectory(true);setCollapsed(previous=>{const next=new Set(previous);next.delete(String(index)+groups[index].title);return next;});
  }
  function directoryKey(event:React.KeyboardEvent){
    if(event.nativeEvent.isComposing||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
    const target=event.target as HTMLButtonElement,group=target.closest("section"),heading=group?.querySelector<HTMLButtonElement>(".agent-content-group");
    const nodes=[...panel.current?.querySelectorAll<HTMLButtonElement>(".agent-content-group, .agent-content-entry")??[]],index=nodes.indexOf(target);
    if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){
      event.preventDefault();nodes[event.key==="Home"?0:event.key==="End"?nodes.length-1:Math.max(0,Math.min(nodes.length-1,index+(event.key==="ArrowDown"?1:-1)))]?.focus();
    }else if(event.key==="ArrowLeft"){
      event.preventDefault();if(target===heading&&heading.getAttribute("aria-expanded")==="true"&&!query)heading.click();else heading?.focus();
    }else if(event.key==="ArrowRight"&&target===heading){
      event.preventDefault();if(heading.getAttribute("aria-expanded")==="false")heading.click();else group?.querySelector<HTMLButtonElement>(".agent-content-entry")?.focus();
    }
  }
  function resize(next:number){setWidth(Math.round(Math.max(220,Math.min(440,next))));}
  function row(entry:Entry){const key=entryKey(entry);return <button key={key} type="button" className="agent-content-entry" data-entry-id={entry.id} aria-current={active===key?"true":undefined} draggable
    {...context(entry.title,[{id:"preview",label:"预览",action:()=>open(entry)},{id:"keep",label:"保留标签",action:()=>open(entry,true)},{id:"insert",label:"插入终端引用",action:()=>insert(entry)},{id:"edit",label:entry.kind==="document"?"打开文稿编辑":"打开资料",action:()=>edit(entry)},{id:"copy",label:"复制名称",action:()=>desktop.copy(entry.title)}])}
    onClick={()=>void open(entry)} onDoubleClick={()=>void open(entry,true)} onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData(referenceType,JSON.stringify({work_ref:work,entry}));}}
    onKeyDownCapture={event=>{if(event.nativeEvent.isComposing)return;if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)){event.preventDefault();void open(entry,true);}}}>
    <Icon name="file" size={14}/><span>{entry.title}</span></button>;}
  const directoryControl=work&&<IconButton icon="inspector" label="作品目录" aria-pressed={directoryVisible} onClick={()=>showDirectory(!directoryVisible)}/>;
  const tabs=work&&!!previews.length&&<AgentPreviewTabs sessionTitle={sessionTitle} tabs={previews.map(item=>({id:entryKey(item.entry),title:item.entry.title+(outdated(item.entry)?"（旧修订）":""),preview:!item.pinned}))} activeId={active} onSelect={select} onClose={close} onKeep={key=>setPreviews(previous=>previous.map(item=>entryKey(item.entry)===key?{...item,pinned:true}:item))} onReveal={reveal} notify={notify}/>;
  return <>{header?.(directoryControl,tabs)}<div className="agent-content" ref={panel}>
    <div className="agent-content-main">
      {!header&&tabs}
      <div className="agent-content-terminal" hidden={!!active} onDragOver={event=>{if(event.dataTransfer.types.includes(referenceType)){event.preventDefault();event.dataTransfer.dropEffect="copy";}}} onDrop={event=>{
        const raw=event.dataTransfer.getData(referenceType);if(!raw)return;event.preventDefault();event.stopPropagation();
        try{const value=JSON.parse(raw);const found=groups.flatMap(group=>group.entries).find(entry=>entryKey(entry)===entryKey(value.entry));if(!work||!sameWork(value.work_ref,work)||!found)throw Error("引用不属于当前作品，请从目录重新拖入。");void insert(found).catch(error=>notify(error.message));}catch(error){notify((error as Error).message);}
      }}>{children}</div>
      {active&&<section className="agent-content-preview" aria-label="作品内容预览" aria-busy={reading}>
        <header><strong>{selected?.entry.title??requested?.title??"预览"}</strong>{selected&&<><button onClick={()=>void insert(selected.entry).catch(error=>notify(error.message))}>插入引用</button><button onClick={()=>edit(selected.entry)}>{selected.entry.kind==="document"?"打开编辑":"打开资料"}</button><button aria-label="保留当前预览" aria-pressed={selected.pinned} onClick={()=>setPreviews(previous=>previous.map(item=>item===selected?{...item,pinned:true}:item))}>保留标签</button></>}<IconButton icon="close" label="返回会话终端" onClick={terminal}/></header>
        {selected&&head&&entryKey(head)!==entryKey(selected.entry)&&<div className="agent-content-revision" role="status"><span>正在查看旧修订</span><button onClick={()=>void open(head,selected.pinned)}>查看当前修订</button></div>}
        {reading?<p role="status">正在读取…</p>:readError?<div role="alert"><p>{readError}</p>{requested&&<button onClick={()=>void open(requested)}>重新读取预览</button>}<button onClick={()=>void load()}>刷新目录</button><button onClick={terminal}>返回终端</button></div>:selected&&<div className="agent-content-reading" ref={readingPanel} tabIndex={0}>{selected.entry.kind==="resource"?<ResourceBody text={selected.text} title={selected.entry.title}/>:selected.format==="fountain"?<ScreenplayText text={selected.text} title={selected.entry.title}/>:<ManuscriptText text={selected.text} title={selected.entry.title} format={selected.format==="markdown"?"markdown":"plain"}/>}</div>}
      </section>}
    </div>
    {work&&directoryVisible&&<aside className={"agent-content-directory"+(overlayMode?" agent-content-directory-overlay":"")} aria-label="作品目录" style={{width}}>
      <div className="agent-content-resize" role="separator" aria-label="调整作品目录宽度" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={440} aria-valuenow={width} tabIndex={0}
        onPointerDown={event=>{if(event.button!==0)return;drag.current={x:event.clientX,width};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();}} onPointerMove={event=>{if(drag.current)resize(drag.current.width+drag.current.x-event.clientX);}} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}} onLostPointerCapture={()=>{drag.current=undefined;}} onDoubleClick={()=>resize(350)} onKeyDown={event=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();resize(event.key==="Home"?220:event.key==="End"?440:width+(event.key==="ArrowLeft"?20:-20));}}}/>
      <header><strong>作品目录</strong><IconButton icon="document-search" label="定位当前预览" disabled={!selected} onClick={()=>active&&reveal(active)}/><IconButton icon="layers" label="折叠全部目录" disabled={!groups.length} onClick={()=>{setQuery("");setCollapsed(new Set(groups.map((group,index)=>String(index)+group.title)));}}/><IconButton icon="refresh" label="刷新作品目录" disabled={busy} onClick={()=>void load()}/><IconButton icon="close" label="收起作品目录" onClick={()=>showDirectory(false)}/></header>
      <input type="search" aria-label="查找作品内容" placeholder="查找文稿和资料" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent.isComposing){event.preventDefault();if(query)setQuery("");else showDirectory(false);}}}/>
      <nav aria-label="作品文稿和资料" aria-busy={busy} onKeyDown={directoryKey}>
        {busy&&!groups.length&&<p role="status">正在读取目录…</p>}
        {errors.map(error=><p role="alert" key={error}>{error}</p>)}
        {!!errors.length&&<button onClick={()=>void load()}>重新读取目录</button>}
        {groups.map((group,index)=>{const entries=group.entries.filter(entry=>entry.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));if(!entries.length)return null;const key=String(index)+group.title;if(group.episode_id)return <section key={group.episode_id}>{entries.map(row)}</section>;const open=!!query||!collapsed.has(key);return <section key={key}><button className="agent-content-group" aria-expanded={open} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);if(open)next.add(key);else next.delete(key);return next;})}><Icon name="chevron" size={12}/><span>{group.title}</span><small>{entries.length}</small></button>{open&&entries.map(row)}</section>;})}
        {!busy&&!errors.length&&!groups.some(group=>group.entries.some(entry=>entry.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())))&&<p>{query?"没有匹配的内容。":"暂无文稿和资料。"}</p>}
      </nav>
    </aside>}
  </div></>;
}
