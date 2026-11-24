import React,{useEffect,useLayoutEffect,useRef,useState} from "react";
import {Icon,IconButton} from "@hetu/workbench-ui";
import type {AgentEngine,AgentEngineId,AgentModel,AgentSurface,SessionLaunch} from "../agent-session-contract.ts";
import {desktop} from "./bridge.ts";
import type {WorkRef} from "@hetu/plugin-sdk";
import {WorkChoice,type AgentWorkChoice} from "./agent-business.tsx";

const marks:Record<AgentEngineId,string>={shell:">_",codex:"◎","claude-code":"✳",gemini:"✦",opencode:"◧"};
const effortName:Record<string,string>={none:"无",minimal:"最低",low:"低",medium:"中",high:"高",xhigh:"极高",max:"最大",ultra:"极致"};
export const engineTitle=(client:string)=>({shell:"终端",codex:"Codex","claude-code":"Claude Code",gemini:"Gemini CLI",opencode:"OpenCode"}[client]??"终端");
export function AgentLaunchDialog({client="codex",context,work,works=[],busy,onCreate,onClose}:{client?:string;context:string;work?:WorkRef;works?:AgentWorkChoice[];busy:boolean;onCreate(value:SessionLaunch,work?:WorkRef):Promise<boolean>;onClose():void}){
  const dialog=useRef<HTMLDialogElement>(null),picker=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null);
  const popover=useRef<HTMLDivElement>(null);
  const [position,setPosition]=useState<React.CSSProperties>({});
  const [engines,setEngines]=useState<AgentEngine[]>([]),[selected,setSelected]=useState<AgentEngineId>(client as AgentEngineId),[models,setModels]=useState<AgentModel[]>([]);
  const [model,setModel]=useState(""),[effort,setEffort]=useState(""),[name,setName]=useState(""),[open,setOpen]=useState(false),[query,setQuery]=useState(""),[loading,setLoading]=useState(false),[error,setError]=useState("");
  const [more,setMore]=useState(false),[revision,setRevision]=useState(0);
  const [target,setTarget]=useState(work);
  const engine=engines.find(item=>item.id===selected),chosen=models.find(item=>item.id===model);
  useEffect(()=>{dialog.current?.showModal();void desktop.agentSession("catalog").then((items:AgentEngine[])=>{setEngines(items);if(!items.some(item=>item.id===selected&&item.available))setSelected(items.find(item=>item.available)?.id??"shell");}).catch(error=>setError(error.message));return()=>dialog.current?.close();},[]);
  useEffect(()=>{
    let active=true;setModels([]);setModel("");setEffort("");setError("");setQuery("");setMore(false);setLoading(true);
    void desktop.agentSession("model_options",{client:selected}).then((value:AgentModel[])=>{if(active)setModels(value);}).catch(error=>{if(active)setError(error.message);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[selected,revision]);
  useEffect(()=>{if(open)search.current?.focus();},[open]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const anchor=picker.current!.getBoundingClientRect(),height=popover.current!.getBoundingClientRect().height;setPosition({width:anchor.width,left:Math.max(16,Math.min(anchor.left,innerWidth-anchor.width-16)),top:Math.max(24,Math.min(anchor.bottom+4,innerHeight-height-24))});};
    place();const observer=new ResizeObserver(place);observer.observe(popover.current!);window.addEventListener("resize",place);
    return()=>{observer.disconnect();window.removeEventListener("resize",place);};
  },[open]);
  useEffect(()=>{const down=(event:PointerEvent)=>{if(open&&!picker.current?.contains(event.target as Node))setOpen(false);};document.addEventListener("pointerdown",down);return()=>document.removeEventListener("pointerdown",down);},[open]);
  const launch=async(surface:AgentSurface)=>{if(!engine?.available||busy)return;if(await onCreate({client:selected,surface,...(name.trim()?{title:name.trim()}:{}),...(model?{model}:{}),...(effort?{reasoning_effort:effort}:{})},target))onClose();};
  const filtered=models.filter(item=>(item.name+" "+item.id).toLowerCase().includes(query.toLowerCase()));
  const visible=query||more?filtered:filtered.slice(0,5);
  return <dialog ref={dialog} className="agent-launch-dialog" aria-labelledby="agent-launch-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onKeyDown={event=>{
    if(event.nativeEvent.isComposing)return;
    if(event.key==="Escape"&&open){event.preventDefault();event.stopPropagation();setOpen(false);return;}
    if(event.key==="Enter"&&(event.metaKey||event.ctrlKey)&&engine?.chat){event.preventDefault();void launch("gui");}
  }}>
    <form onSubmit={event=>{event.preventDefault();if(!open)void launch("tui");}}>
      <header><h2 id="agent-launch-title">创建会话</h2><IconButton icon="close" label="关闭创建会话" disabled={busy} onClick={onClose}/></header>
      <div className="agent-launch-context"><div><span>作品</span><div className="agent-launch-value"><Icon name="folder" size={14}/>{works.length?<WorkChoice work={target} works={works} disabled={busy} onChange={setTarget}/>:<span>{context}</span>}</div></div><div><span>运行于</span><div className="agent-launch-value"><Icon name="terminal" size={14}/><span>本机{navigator.platform.includes("Mac")?" Mac":""}</span></div></div></div>
      <label className="agent-launch-name">会话名称 <span>可选</span><input autoFocus aria-label="会话名称" placeholder="会话名称" maxLength={100} value={name} onChange={event=>setName(event.target.value)}/></label>
      <div className="agent-launch-choice" ref={picker}><span id="agent-engine-label">引擎</span><button type="button" className="agent-engine-trigger" aria-labelledby="agent-engine-label" aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(!open)}><span aria-hidden="true">{marks[selected]}</span><span>{engineTitle(selected)}{selected!=="shell"?"（CLI）":""}</span>{chosen&&<span className="agent-launch-muted">{chosen.name}{effort?"  "+(effortName[effort]??effort):""}</span>}<Icon name="chevron" size={12}/></button>
      {open&&<div ref={popover} style={position} className="agent-engine-picker" role="dialog" aria-label="选择引擎与模型" onKeyDown={event=>{
        if(event.nativeEvent.isComposing)return;
        if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)&&!(event.target as HTMLElement).closest('[role="tablist"], [role="group"]')){
          const items=[...popover.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')];if(items.length){event.preventDefault();const index=items.indexOf(event.target as HTMLButtonElement),next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next].focus();}
        }
        if(event.key==="Enter"&&!event.metaKey&&!event.ctrlKey&&event.target instanceof HTMLInputElement){event.preventDefault();void launch("tui");}
      }}>
        <div className="agent-engine-tabs" role="tablist" aria-label="终端引擎" onKeyDown={event=>{if(["ArrowLeft","ArrowRight"].includes(event.key)){event.preventDefault();const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],index=items.indexOf(event.target as HTMLButtonElement),next=(index+(event.key==="ArrowRight"?1:-1)+items.length)%items.length;items[next]?.focus();items[next]?.click();}}}>{engines.map(item=><button key={item.id} type="button" role="tab" aria-selected={selected===item.id} aria-label={item.name+(item.available?"":" 未安装")} disabled={!item.available} title={item.name+(item.available?"":" 未安装")} onClick={()=>setSelected(item.id)}>{marks[item.id]}</button>)}</div>
        {engine?.models&&<div className="agent-model-search"><Icon name="search" size={14}/><input ref={search} type="search" aria-label="搜索模型" placeholder={"搜索"+engineTitle(selected)+"模型"} value={query} onChange={event=>setQuery(event.target.value)}/></div>}
        <div className="agent-model-list" role="listbox" aria-label="可用模型"><button type="button" role="option" aria-selected={!model} onClick={()=>{setModel("");setEffort("");}}>{selected==="shell"?"系统默认 Shell":"使用已配置的默认模型"}{!model&&<Icon name="check" size={14}/>}</button>{loading&&engine?.models&&<p role="status">正在读取模型…</p>}{visible.map(item=><button type="button" role="option" aria-selected={item.id===model} key={item.id} onClick={()=>{setModel(item.id);setEffort(item.default_effort??"");}}>{item.name}{item.id===model&&<Icon name="check" size={14}/>}</button>)}{!query&&filtered.length>5&&<button type="button" onClick={()=>setMore(!more)}>{more?"收起更多模型":"更多模型（"+(filtered.length-5)+"）"}<Icon name="chevron" size={12}/></button>}{query&&!filtered.length&&!loading&&<p role="status">没有匹配的模型</p>}</div>
        {chosen&&chosen.efforts.length>0&&<div className="agent-efforts" role="group" aria-label="推理强度">{chosen.efforts.map(value=><button type="button" key={value} aria-pressed={value===effort} onClick={()=>setEffort(value)}>{effortName[value]??value}</button>)}</div>}
        <footer>{engine?.chat&&<button type="button" disabled={busy} onClick={()=>void launch("gui")}><Icon name="comment" size={14}/>打开聊天<kbd aria-hidden="true">{navigator.platform.includes("Mac")?"⌘":"Ctrl"}↵</kbd></button>}<button className="agent-launch-primary" type="button" disabled={busy||!engine?.available} onClick={()=>void launch("tui")}><Icon name="terminal" size={14}/>打开终端<kbd aria-hidden="true">↵</kbd></button></footer>
      </div>}
      </div>
      {error&&<div className="agent-launch-error" role="alert">{error}<button type="button" onClick={()=>setRevision(revision+1)}>重新读取模型</button></div>}
      <footer><span/ ><button className="agent-launch-primary" disabled={busy||!engine?.available} type="submit">{busy?"正在启动…":"创建"}<kbd aria-hidden="true">↵</kbd></button></footer>
    </form>
  </dialog>;
}
