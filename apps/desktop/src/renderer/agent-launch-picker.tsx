import React,{useEffect,useId,useLayoutEffect,useRef,useState} from "react";
import {Icon} from "@hetu/workbench-ui";
import type {AgentEngine,AgentModel} from "../agent-session-contract.ts";
import {externalProviders} from "../shared/external-ai.ts";
import {AgentProviderIcon} from "./agent-provider-icons.tsx";

export type AgentPickerValue={client:string;model?:string;reasoning_effort?:string};
const effortName:Record<string,string>={none:"无",minimal:"最低",low:"低",medium:"中",high:"高",xhigh:"极高",max:"最大",ultra:"极致"};
export const engineTitle=(client:string)=>client==="shell"?"终端":externalProviders.find(provider=>provider.id===client)?.label??"Agent";

/** 创建、Bot配置与会话模型共用Orca的图标标签、搜索、模型和强度选择。 */
export function AgentLaunchPicker({value,onChange,engines,models,loading=false,label="智能体",disabled=false,showEngine=true,allowDefault=true,customModelLabel,footer,onDefaultAction,onOpen,dismissKey}:{value:AgentPickerValue;onChange(value:AgentPickerValue):void;engines:AgentEngine[];models:AgentModel[];loading?:boolean;label?:string;disabled?:boolean;showEngine?:boolean;allowDefault?:boolean;customModelLabel?:string;footer?:React.ReactNode;onDefaultAction?():void;onOpen?():void;dismissKey?:number;}){
 const root=useRef<HTMLDivElement>(null),popover=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),search=useRef<HTMLInputElement>(null),drafts=useRef(new Map<string,AgentPickerValue>());
 const id=useId(),panelId=id+"-models";
 const [open,setOpen]=useState(false),[query,setQuery]=useState(""),[more,setMore]=useState(false),[position,setPosition]=useState<React.CSSProperties>({});
 const engine=engines.find(item=>item.id===value.client),chosen=models.find(item=>item.id===value.model);
 const filtered=models.filter(item=>(item.name+" "+item.id).toLowerCase().includes(query.toLowerCase())),visible=query||more?filtered:filtered.slice(0,5);
 const close=()=>{setOpen(false);requestAnimationFrame(()=>trigger.current?.focus());};
 useEffect(()=>{if(open)close();},[dismissKey]);
 const chooseEngine=(client:string)=>{drafts.current.set(value.client,value);onChange(drafts.current.get(client)??{client});setQuery("");setMore(false);requestAnimationFrame(()=>search.current?.focus());};
 useEffect(()=>{setQuery("");setMore(false);},[value.client]);
 useEffect(()=>{if(open)requestAnimationFrame(()=>{(search.current??popover.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();});},[open,value.client]);
 useLayoutEffect(()=>{
  if(!open)return;
  const place=()=>{const anchor=trigger.current!.getBoundingClientRect(),width=Math.min(416,innerWidth-32),height=popover.current!.getBoundingClientRect().height;setPosition({width,left:Math.max(16,Math.min(anchor.left,innerWidth-width-16)),top:Math.max(16,Math.min(anchor.bottom+4,innerHeight-height-16))});};
  place();const observer=new ResizeObserver(place);observer.observe(popover.current!);window.addEventListener("resize",place);
  return()=>{observer.disconnect();window.removeEventListener("resize",place);};
 },[open]);
 useEffect(()=>{const down=(event:PointerEvent)=>{if(open&&!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener("pointerdown",down);return()=>document.removeEventListener("pointerdown",down);},[open]);
 return <div className="agent-launch-choice" ref={root}>
  <span id={id+"-label"}>{label}</span>
  <button ref={trigger} type="button" className="agent-engine-trigger" disabled={disabled} aria-labelledby={id+"-label "+id+"-selection"} aria-controls={open?id+"-picker":undefined} aria-haspopup="dialog" aria-expanded={open} onClick={()=>{if(!open)onOpen?.();setOpen(!open);}}><AgentProviderIcon client={value.client}/><span id={id+"-selection"}>{showEngine?engineTitle(value.client):chosen?.name??value.model??"模型"}{value.model&&<span className="agent-launch-muted"> {showEngine?chosen?.name??value.model:""}{value.reasoning_effort?" "+(effortName[value.reasoning_effort]??value.reasoning_effort):""}</span>}</span><Icon name="chevron" size={12}/></button>
  {open&&<div id={id+"-picker"} ref={popover} style={position} className="agent-engine-picker" role="dialog" aria-label="选择引擎与模型" onKeyDown={event=>{
   if(event.nativeEvent.isComposing)return;
   if(event.key==="Escape"){event.preventDefault();event.stopPropagation();close();return;}
   if(event.key==="Tab"&&event.shiftKey&&event.target===search.current){event.preventDefault();popover.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();return;}
   if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)&&!(event.target as HTMLElement).closest('[role="tablist"], [role="group"], .agent-custom-model')&&(!(event.target instanceof HTMLInputElement)||!["Home","End"].includes(event.key))){const items=[...popover.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')];if(items.length){event.preventDefault();const index=items.indexOf(event.target as HTMLButtonElement),next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next].focus();}}
   if(event.key==="Enter"&&!event.metaKey&&!event.ctrlKey&&event.target===search.current){event.preventDefault();onDefaultAction?.();}
  }}>
   <div className="agent-engine-tabs" role="tablist" aria-label="引擎" onWheel={event=>{if(Math.abs(event.deltaY)>Math.abs(event.deltaX))event.currentTarget.scrollLeft+=event.deltaY;}} onKeyDown={event=>{
    if(event.nativeEvent.isComposing||event.key==="Escape")return;
    const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')],index=items.indexOf(event.target as HTMLButtonElement);
    if(["ArrowRight","ArrowLeft","Home","End"].includes(event.key)){event.preventDefault();event.stopPropagation();const next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowRight"?1:-1)+items.length)%items.length;items[next]?.focus();}
    else if(event.key==="ArrowDown"||event.key==="Tab"&&!event.shiftKey){event.preventDefault();event.stopPropagation();(search.current??popover.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();}
   }}>
    {engines.map(item=><button key={item.id} type="button" role="tab" aria-label={item.name} title={item.name+(item.available?"":" 未安装")} aria-selected={item.id===value.client} aria-controls={panelId} tabIndex={item.id===value.client?0:-1} data-available={item.available} onMouseDown={event=>event.preventDefault()} onClick={()=>chooseEngine(item.id)}><AgentProviderIcon client={item.id}/></button>)}
   </div>
   <div id={panelId} className="agent-engine-panel" role="tabpanel" aria-label={engineTitle(value.client)}>
    {value.client!=="shell"&&<div className="agent-model-search"><Icon name="search" size={14}/><input ref={search} type="search" aria-label="搜索模型" placeholder={"搜索 "+engineTitle(value.client)+" 模型…"} value={query} onChange={event=>setQuery(event.target.value)}/></div>}
    <div className="agent-model-options"><div className="agent-model-list" role="listbox" aria-label="可用模型">{allowDefault&&<button type="button" role="option" tabIndex={!value.model?0:-1} aria-selected={!value.model} onClick={()=>onChange({client:value.client})}>{value.client==="shell"?"系统默认 Shell":"使用已配置的默认模型"}{!value.model&&<Icon name="check" size={14}/>}</button>}{visible.map(item=><button type="button" role="option" tabIndex={item.id===value.model?0:-1} aria-selected={item.id===value.model} key={item.id} onClick={()=>onChange({client:value.client,model:item.id,...(item.default_effort?{reasoning_effort:item.default_effort}:{})})}>{item.name}{item.id===value.model&&<Icon name="check" size={14}/>}</button>)}</div>{loading&&<p role="status">正在读取模型…</p>}{!engine?.available&&<p role="status">当前引擎未安装</p>}{!query&&filtered.length>5&&<button className="agent-model-more" type="button" onClick={()=>setMore(!more)}>{more?"收起更多模型":"更多模型（"+(filtered.length-5)+"）"}<Icon name="chevron" size={12}/></button>}{query&&!filtered.length&&!loading&&<p role="status">没有匹配的模型</p>}</div>
    {customModelLabel&&(!models.length||value.model&&!chosen)&&<label className="agent-custom-model">模型<input aria-label={customModelLabel} maxLength={255} value={value.model??""} placeholder="原生引擎的模型名称" onChange={event=>onChange({...value,model:event.target.value})}/></label>}
    {!!chosen?.efforts.length&&<div className="agent-efforts" role="group" aria-label="推理强度">{chosen.efforts.map(effort=><button type="button" key={effort} aria-pressed={effort===value.reasoning_effort} onClick={()=>onChange({...value,reasoning_effort:effort})}>{effortName[effort]??effort}</button>)}</div>}
    {footer&&<footer>{footer}</footer>}
   </div>
  </div>}
 </div>;
}
