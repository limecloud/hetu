import React,{useEffect,useRef,useState} from "react";
import {sameWork,type WorkRef} from "@hetu/plugin-sdk";
import type {ProfessionalCapabilities,ProfessionalPlugin,ProfessionalRef,ProfessionalSelection,ProfessionalTarget} from "../professional-contract.ts";
import {desktop} from "./bridge.ts";
import {ContextPickerDialog} from "./agent-context-dialog.tsx";
import {pluginStateLabels} from "./plugin-state.ts";
import {Icon} from "@hetu/workbench-ui";
import "./professional-tools.css";

type Prepared={work_ref:WorkRef;prompt:string;professional:ProfessionalRef;fixed_refs:unknown[]};
export function ProfessionalToolsDialog({work,target,onClose,deliver}:{work:WorkRef;target:ProfessionalTarget;onClose():void;deliver?(text:string):Promise<void>}){
 const [plugins,setPlugins]=useState<(ProfessionalPlugin&{supported:boolean})[]>(),[query,setQuery]=useState("");
 const [plugin,setPlugin]=useState<ProfessionalPlugin>(),[cap,setCap]=useState<ProfessionalCapabilities>(),[selection,setSelection]=useState("");
 const [goal,setGoal]=useState(""),[method,setMethod]=useState(""),[prepared,setPrepared]=useState<Prepared>();
 const [loading,setLoading]=useState(false),[sending,setSending]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [delivery,setDelivery]=useState<"idle"|"accepted"|"drafted"|"rejected"|"unknown">("idle");
 const generation=useRef(0),inflight=useRef(false),retry=useRef<()=>void>();
 const host=desktop.promptDelivery;
 const binding=cap?{plugin_id:cap.plugin_id,package_sha256:cap.package_sha256,capabilities_sha256:cap.capabilities_sha256}:undefined;
 const selected:ProfessionalSelection=selection.startsWith("action:")?{action_id:selection.slice(7)}:selection.startsWith("skill:")?{skill_id:selection.slice(6),skill_sha256:cap?.skills?.find(item=>item.id===selection.slice(6))?.content_sha256}:{};
 async function read<T>(request:()=>Promise<T>,receive:(value:T)=>void,again:()=>void){
  const ticket=++generation.current;setLoading(true);setError("");retry.current=undefined;
  try{const value=await request();if(ticket===generation.current)receive(value);}
  catch(e){if(ticket===generation.current){setError((e as Error).message);retry.current=again;}}
  finally{if(ticket===generation.current)setLoading(false);}
 }
 function reset(){setPrepared(undefined);setNotice("");setDelivery("idle");}
 function invalidate(){generation.current++;retry.current=undefined;setLoading(false);setError("");}
 function catalog(){setPlugins(undefined);setPlugin(undefined);setCap(undefined);setSelection("");setMethod("");reset();return read(()=>desktop.professional("catalog",{work_ref:work}),value=>setPlugins(value.plugins),()=>void catalog());}
 useEffect(()=>{void catalog();const unsubscribe=desktop.onPluginsChanged(()=>{
  if(inflight.current||deliveryState.current!=="idle"){setNotice("插件已变化，请先核对原对话，再重新打开专业工具。");return;}
  void catalog();
 });return()=>{generation.current++;unsubscribe();};},[]);
 const deliveryState=useRef(delivery);deliveryState.current=delivery;
 function open(item:ProfessionalPlugin){
  setPlugin(item);setCap(undefined);setSelection("");setMethod("");reset();
  return read(()=>desktop.professional("capabilities",{work_ref:work,plugin:{plugin_id:item.id,package_sha256:item.package_sha256}}),setCap,()=>void open(item));
 }
 function previewMethod(){return read(()=>desktop.professional("method",{work_ref:work,plugin:binding,selection:selected}),value=>setMethod(value.content),()=>void previewMethod());}
 const request=()=>desktop.professional("prepare",{work_ref:work,plugin:binding,selection:selected,target:{...target,object:target.object??{}},goal});
 function prepare(){return read(request,value=>{if(!sameWork(value.work_ref,work))throw Error("作品已变化，请重新打开专业工具。");setPrepared(value);setDelivery("idle");setNotice("");},()=>void prepare());}
 async function publish(mode:"copy"|"draft"|"send"){
  if(!prepared||inflight.current||loading||mode!=="copy"&&delivery!=="idle")return;
  inflight.current=true;setSending(true);setError("");setNotice("");const ticket=generation.current;
  try{
   if(delivery==="idle"){
    const checked=await request();if(ticket!==generation.current)return;
    if(checked.prompt!==prepared.prompt||!sameWork(checked.work_ref,work))throw Error("固定目标或专业能力已变化，请重新准备请求。");
   }
   if(mode==="copy"){await desktop.copy(prepared.prompt);if(ticket===generation.current)setNotice("请求已复制。");return;}
   // 投递已开始后的异常属于未知；校验失败仍可重新准备，不能混为发送失败。
   try{
    const result=deliver?(await deliver(prepared.prompt),{isError:false}):await host!.send(prepared.prompt,mode,work);
    if(ticket!==generation.current)return;
    setDelivery(result.isError?"rejected":mode==="draft"?"drafted":"accepted");
    if(!result.isError&&desktop.agentSessionHost){onClose();window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref:work}}));}
   }catch{if(ticket===generation.current)setDelivery("unknown");}
  }catch(e){if(ticket===generation.current)setError((e as Error).message);}
  finally{inflight.current=false;if(ticket===generation.current)setSending(false);}
 }
 const term=query.trim().toLowerCase(),items=(plugins??[]).filter(item=>item.supported&&(!term||[item.display["zh-CN"],item.description["zh-CN"]].join(" ").toLowerCase().includes(term)));
 return <ContextPickerDialog title="专业工具" className={!plugin?"professional-picker":""} disabled={sending} onClose={onClose}>
  <div className={"professional-tools"+(!plugin?" professional-catalog":"")}>
   {!plugin?<>
    <input type="search" aria-label="查找专业工具" placeholder="查找工具" value={query} onChange={event=>setQuery(event.target.value)} maxLength={120}/>
    <div className="professional-tool-list" aria-label="专业工具目录">{items.map(item=><div key={item.id}>
     <button aria-label={item.display["zh-CN"]} title={item.description["zh-CN"]} disabled={loading||item.state!=="active"} onClick={()=>void open(item)}><span className="professional-tool-copy"><strong>{item.display["zh-CN"]}</strong><span>{item.description["zh-CN"]}</span></span><Icon name="chevron" size={14}/></button>
     {item.state!=="active"&&<small>{pluginStateLabels[item.state]??"状态待核对"}{item.reason?`：${item.reason}`:""}</small>}
    </div>)}</div>
    {plugins&&!loading&&!error&&!items.length&&<p>{term?"没有匹配的工具。":plugins.length?"已安装的工具不适用于当前作品。":"当前作品没有可用的专业工具。"}</p>}
    {!loading&&<div className="professional-catalog-footer"><button onClick={()=>{onClose();window.dispatchEvent(new CustomEvent("hetu:show-plugins"));}}>管理创作插件</button></div>}
   </>:<>
    <button disabled={sending||delivery!=="idle"} onClick={()=>{invalidate();setPlugin(undefined);setCap(undefined);setMethod("");reset();}}>返回工具目录</button>
    <h3>{plugin.display["zh-CN"]}</h3><p className="muted">{plugin.description["zh-CN"]}</p>
    {cap&&<>
     <label>处理方式<select aria-label="专业处理方式" value={selection} disabled={sending||delivery!=="idle"} onChange={event=>{invalidate();setSelection(event.target.value);setMethod("");reset();}}>
      <option value="">由 Agent 按目标选择</option>
      {cap.skills?.map(item=><option key={"skill:"+item.id} value={"skill:"+item.id}>{item.description}</option>)}
      {cap.actions.map(item=><option key={"action:"+item.id} value={"action:"+item.id}>{item.title}</option>)}
     </select></label>
     {!!selected.skill_id&&<button disabled={loading||sending||delivery!=="idle"} onClick={()=>void previewMethod()}>查看创作方法</button>}
     {method&&<pre className="professional-method" aria-label="创作方法">{method}</pre>}
     {!cap.skills?.length&&<p className="muted">此插件未提供创作方法。</p>}
     <label>本次目标<textarea aria-label="专业处理目标" placeholder="说明需要检查、整理或制作的内容" maxLength={6000} value={goal} disabled={sending||delivery!=="idle"} onChange={event=>{invalidate();setGoal(event.target.value);reset();}}/></label>
     <details><summary>能力与版本</summary><p>{plugin.version}</p><pre>{JSON.stringify({plugin:binding,selection:selected,actions:cap.actions,types:cap.types},null,2)}</pre></details>
     <button className="primary" disabled={loading||sending||delivery!=="idle"||!goal.trim()} onClick={()=>void prepare()}>准备请求</button>
    </>}
   </>}
   {loading&&<p role="status">正在核对专业能力…</p>}
   {sending&&<p role="status">正在核对并交接请求…</p>}
   {error&&<p role="alert">{error}</p>}
   {error&&retry.current&&<button disabled={loading||sending} onClick={()=>retry.current?.()}>重新读取</button>}
   {prepared&&<section aria-label="专业请求预览">
    <details><summary>查看固定请求</summary><textarea aria-label="专业工具请求" readOnly value={prepared.prompt}/></details>
    <div className="actions"><button disabled={loading||sending} onClick={()=>void publish("copy")}>复制请求</button>
     {(deliver||host?.drafts)&&<button disabled={loading||sending||delivery!=="idle"} onClick={()=>void publish("draft")}>{desktop.agentSessionHost?"放入当前会话":"放入对话草稿"}</button>}
     {!deliver&&host&&host.directSend!==false&&<button disabled={loading||sending||delivery!=="idle"} onClick={()=>void publish("send")}>发送给当前 Agent</button>}
    </div>
   </section>}
   {delivery!=="idle"&&<p role="status">{{accepted:"宿主已接收请求，等待 Agent 处理。",drafted:"已放入草稿，尚未发送。",rejected:"宿主未接收请求，可复制请求继续。",unknown:"发送结果尚未确认，请先检查原对话，避免重复执行。",idle:""}[delivery]}</p>}
   {notice&&<p role="status">{notice}</p>}
  </div>
 </ContextPickerDialog>;
}
