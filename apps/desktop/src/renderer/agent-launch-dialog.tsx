import React,{useEffect,useRef,useState} from "react";
import {Icon,IconButton} from "@hetu/workbench-ui";
import type {AgentEngine,AgentModel,AgentSurface,SessionLaunch} from "../agent-session-contract.ts";
import {desktop} from "./bridge.ts";
import type {WorkRef} from "@hetu/plugin-sdk";
import {WorkChoice,type AgentWorkChoice} from "./agent-business.tsx";
import {AgentLaunchPicker,type AgentPickerValue} from "./agent-launch-picker.tsx";
export {engineTitle} from "./agent-launch-picker.tsx";

export function AgentLaunchDialog({client="codex",context,work,works=[],busy,onCreate,onClose}:{client?:string;context:string;work?:WorkRef;works?:AgentWorkChoice[];busy:boolean;onCreate(value:SessionLaunch,work?:WorkRef):Promise<boolean>;onClose():void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [engines,setEngines]=useState<AgentEngine[]>([]),[choice,setChoice]=useState<AgentPickerValue>({client}),[models,setModels]=useState<AgentModel[]>([]);
 const [name,setName]=useState(""),[loading,setLoading]=useState(false),[error,setError]=useState(""),[revision,setRevision]=useState(0),[target,setTarget]=useState(work);
 const engine=engines.find(item=>item.id===choice.client);
 useEffect(()=>{dialog.current?.showModal();void desktop.agentSession("catalog").then((items:AgentEngine[])=>{setEngines(items);if(!items.some(item=>item.id===choice.client&&item.available))setChoice({client:items.find(item=>item.available)?.id??"shell"});}).catch(error=>setError(error.message));return()=>dialog.current?.close();},[]);
 useEffect(()=>{let active=true;setModels([]);setLoading(true);setError("");void desktop.agentSession("model_options",{client:choice.client}).then((items:AgentModel[])=>{if(active)setModels(items);}).catch(error=>{if(active)setError(error.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[choice.client,revision]);
 const launch=async(surface:AgentSurface)=>{if(!engine?.available||busy)return;if(await onCreate({...choice,surface,...(name.trim()?{title:name.trim()}:{})},target))onClose();};
 return <dialog ref={dialog} className="agent-launch-dialog" aria-labelledby="agent-launch-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==="Enter"&&(event.metaKey||event.ctrlKey)&&engine?.chat){event.preventDefault();void launch("gui");}}}>
  <form onSubmit={event=>{event.preventDefault();void launch("tui");}}>
   <header><h2 id="agent-launch-title">创建会话</h2><IconButton icon="close" label="关闭创建会话" disabled={busy} onClick={onClose}/></header>
   <div className="agent-launch-context"><div><span>作品</span><div className="agent-launch-value"><Icon name="folder" size={14}/>{works.length?<WorkChoice work={target} works={works} disabled={busy} onChange={setTarget}/>:<span>{context}</span>}</div></div><div><span>电脑</span><div className="agent-launch-value"><Icon name="terminal" size={14}/><span>本机{navigator.platform.includes("Mac")?" Mac":""}</span></div></div></div>
   <label className="agent-launch-name">会话名称 <span>可选</span><input autoFocus aria-label="会话名称" placeholder="会话名称" maxLength={100} value={name} onChange={event=>setName(event.target.value)}/></label>
   <AgentLaunchPicker value={choice} onChange={setChoice} engines={engines} models={models} loading={loading} label="引擎" disabled={busy} onDefaultAction={()=>void launch("tui")} footer={<>{engine?.chat&&<button type="button" disabled={busy} onClick={()=>void launch("gui")}><Icon name="comment" size={14}/>打开聊天<kbd aria-hidden="true">{navigator.platform.includes("Mac")?"⌘":"Ctrl"}↵</kbd></button>}<button className="primary" type="button" disabled={busy||!engine?.available} onClick={()=>void launch("tui")}><Icon name="terminal" size={14}/>打开终端<kbd aria-hidden="true">↵</kbd></button></>}/>
   {error&&<div className="agent-launch-error" role="alert">{error}<button type="button" onClick={()=>setRevision(revision+1)}>重新读取模型</button></div>}
   <footer><span/><button className="primary" disabled={busy||!engine?.available} type="submit">{busy?"正在启动…":"创建"}<kbd aria-hidden="true">↵</kbd></button></footer>
  </form>
 </dialog>;
}
