import React,{useEffect,useRef,useState} from "react";
import type {WorkRef} from "@hetu/plugin-sdk";
import type {SessionSnapshot} from "../agent-session-contract.ts";
import {desktop} from "./bridge.ts";
import {Icon,IconButton} from "@hetu/workbench-ui";
import {BotWorkspace} from "./external-bot-workspace.tsx";
import {ComputerControlPane} from "./computer-control-pane.tsx";
import {ExecutionNavigation,type ExecutionNavigationProps} from "./execution-navigation.tsx";
import "./external-runtime.css";

type Request=(input:Record<string,unknown>)=>Promise<any>;
export function ExternalRuntimePanel({domain,work,snapshot,preferences,notify,onClose,navigation,initialBotId,createBot}:{domain:"bots"|"computer";work?:WorkRef;snapshot:SessionSnapshot;preferences?:any;notify(message:string):void;onClose():void;navigation:ExecutionNavigationProps;initialBotId?:string;createBot?:boolean}){
 const section=useRef<HTMLElement>(null),live=useRef(true),flush=useRef<()=>Promise<void>>(()=>Promise.resolve()),writes=useRef(Promise.resolve()),writeCount=useRef(0);
 const [error,setError]=useState(""),[pending,setPending]=useState<any[]>([]),[busy,setBusy]=useState(false),[computerPage,setComputerPage]=useState("权限");
 const scope=work?{work_ref:work}:{scope:"library"};
 const close=()=>{void flush.current().then(onClose).catch(error=>setError(error.message));};
 useEffect(()=>{live.current=true;const previous=document.activeElement as HTMLElement;section.current?.focus();void refreshPending().catch(()=>{});return()=>{live.current=false;requestAnimationFrame(()=>previous?.focus());};},[]);
 const refreshPending=async()=>{const rows=await desktop.agentSession("runtime_pending",scope);if(live.current)setPending(rows.filter((row:any)=>row.domain===domain&&["pending","unknown"].includes(row.state)));};
 const request:Request=async(input)=>{
  const read=["capabilities","permissions","apps","windows","snapshot","query","wait","operation","list","get","templates","sessions","session_read","session_draft_read","session_get","session_models","session_interaction","session_history","session_commands"].includes(String(input.method));
  const fixed=structuredClone(input);
  const invoke=async()=>{try{const result=await desktop.agentSession("runtime",{...scope,domain,input:fixed});if(live.current)await refreshPending();if(result.status!=="succeeded")throw Error(result.error?.message??"操作未完成。");if(!read&&["unknown","dispatching","not_found"].includes(result.data?.state))throw Error("原操作结果待核对，请先查询原操作。");return result.data;}catch(cause){if(live.current){setError((cause as Error).message);if(!read)await refreshPending().catch(()=>{});}throw cause;}};
  if(read)return invoke();
  writeCount.current++;setBusy(true);setError("");
  const result=writes.current.then(invoke);writes.current=result.then(()=>{},()=>{});
  try{return await result;}finally{writeCount.current--;if(live.current)setBusy(writeCount.current>0);}
 };
 const notices=<>
  {error&&<p className="external-runtime-error" role="alert">{error}</p>}
  {!!pending.length&&<div className="external-runtime-recovery" role="status">原操作结果待核对。{pending.map(row=><button key={row.operation_key} onClick={()=>{void request({method:"operation",operation_key:row.operation_key,...(domain==="computer"?{session_id:row.session_id}:{})}).then(result=>{if(result.state==="unknown"||result.state==="dispatching")notify("原操作仍待核对，没有重发。");}).catch(()=>{});}}>查询原操作</button>)}</div>}
 </>;
 return <section ref={section} className="external-runtime-panel" aria-label={domain==="bots"?"Bots":"计算机控制"} tabIndex={-1} onKeyDown={event=>{if(event.key==="Escape"&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&!(event.target as Element).closest(".popover-menu[open]")){event.preventDefault();close();}}}>
  <div className="external-runtime-body" aria-busy={busy}>{domain==="bots"?<BotWorkspace request={request} snapshot={snapshot} work={work} preferences={preferences} notify={notify} onClose={close} notices={notices} navigation={navigation} initialBotId={initialBotId} createBot={createBot} registerFlush={value=>{flush.current=value;}}/>:<div className="external-settings-layout" data-navigation-open={navigation.layout.navigationVisible}><ExecutionNavigation {...navigation} active="computer" onSessions={close}/><div className="external-settings-main"><header className="external-settings-header">{!navigation.layout.navigationVisible&&<IconButton icon="sidebar" label="展开左侧栏" onClick={()=>navigation.layout.onNavigation(true)}/>}<nav aria-label="设置导航路径"><span>设置</span><span>/</span><strong>计算机控制</strong>{computerPage!=="权限"&&<><span>/</span><span>{computerPage}</span></>}</nav><span/><IconButton icon="close" label="关闭外部工作面" onClick={close}/></header>{notices}<ComputerControlPane request={request} scope={scope} onPageChange={setComputerPage}/></div></div>}</div>
 </section>;
}
