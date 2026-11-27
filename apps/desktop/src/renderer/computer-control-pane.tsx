import React,{useEffect,useId,useRef,useState} from "react";
import {Icon} from "@hetu/workbench-ui";
import {desktop} from "./bridge.ts";
type Request=(input:Record<string,unknown>)=>Promise<any>;

export function ComputerControlPane({request,scope,onPageChange}:{request:Request;scope:Record<string,unknown>;onPageChange?(page:string):void}){
  const [capabilities,setCapabilities]=useState<any>(),[permissions,setPermissions]=useState<any>(),[apps,setApps]=useState<any[]>([]),[windows,setWindows]=useState<any[]>([]),[app,setApp]=useState(""),[window,setWindow]=useState("");
  const [snapshot,setSnapshot]=useState<any>(),[element,setElement]=useState(""),[text,setText]=useState(""),[sessionId,setSessionId]=useState(()=>"computer-"+crypto.randomUUID()),[working,setWorking]=useState(false),[state,setState]=useState(""),[inspectionOpen,setInspectionOpen]=useState(false);
  const [control,setControl]=useState<any>({state:"active",owned:false}),targetEpoch=useRef(0);
  const inspectionDescription=useId();
  useEffect(()=>{onPageChange?.(inspectionOpen?"应用窗口":"权限");},[inspectionOpen]);
  const run=async(input:Record<string,unknown>)=>{setWorking(true);try{return await request(input);}finally{setWorking(false);}};
  const observe=async()=>{const epoch=targetEpoch.current;const value=await run({method:"snapshot",session_id:sessionId,app:{pid:Number(app)},window_id:Number(window),screenshot:{max_edge:1600,ocr:true}});if(epoch!==targetEpoch.current)return;setSnapshot(value);setControl(value.control??{state:"active",owned:false});setElement("");setState(value.control?.state==="taken_over"?value.control.owned?"窗口由你接管，机器输入已冻结。":"此窗口由其他会话接管，机器输入已冻结。":"已更新观察。");};
  useEffect(()=>{let active=true;void (async()=>{
    const value=await run({method:"capabilities"});if(!active)return;setCapabilities(value);if(!value.available)return;
    const permission=await run({method:"permissions"});if(!active)return;setPermissions(permission);
    const data=await run({method:"apps",limit:128});if(!active)return;setApps(data.items??[]);
    const previous=await desktop.agentSession("runtime_computer_state",scope);if(!active||!previous)return;
    setInspectionOpen(true);setSessionId(previous.session_id);setApp(String(previous.pid));setWindow(String(previous.window_id));setControl({state:previous.state,owned:true});
    if(previous.state==="taken_over")setState("原窗口由你接管，机器输入仍已冻结。请先更新观察。");
    const listed=await run({method:"windows",app:{pid:previous.pid},limit:128});if(active)setWindows(listed.items??[]);
  })().catch(()=>{});return()=>{active=false;++targetEpoch.current;};},[]);
  const act=async(kind:string)=>{const value=await run({method:"act",session_id:sessionId,snapshot_ref:snapshot.snapshot_ref,operation_key:crypto.randomUUID(),element_index:Number(element),action:{kind,...(["type_text","set_value"].includes(kind)?{text}:{})}});setSnapshot(undefined);setElement("");setState(value.state==="succeeded"?"动作已送达，请更新观察核对。":"原动作结果待核对。");};
  const takenOver=control.state==="taken_over";

  const openPermission=(permission:string)=>{void desktop.agentSession("runtime_permissions_open",{permission}).catch(()=>{});};
  const ready=permissions?.accessibility&&permissions?.screen_capture;
  return <div className="external-computer-scroll" onKeyDown={event=>{if(event.key==="Escape"&&inspectionOpen&&!event.defaultPrevented&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();setInspectionOpen(false);}}}><section className="external-computer">
    <header className="computer-settings-title">{inspectionOpen?<><button className="computer-page-back" onClick={()=>setInspectionOpen(false)}><Icon name="back" size={14}/>返回计算机控制</button><h2>应用窗口</h2><p>选择本机窗口，查看固定观察或接续原操作。</p></>:<><h2>计算机控制</h2><p>让代理控制本机应用</p></>}</header>
    {!inspectionOpen&&<><section className="computer-permission-group" aria-label="计算机控制权限"><header><div><strong><Icon name="shield" size={14}/>{!capabilities?"正在检查计算机控制访问权限":!capabilities.available?"计算机控制不可用":ready?"计算机控制已就绪":"完成本机应用的访问设置"}</strong><p>{!capabilities?"正在检查本机隐私权限":!capabilities.available?"当前安装没有可用的本机电脑适配器。":ready?"代理可在你的要求下观察和操作应用窗口。":"观察不会自动申请系统权限。"}</p></div><button disabled={working||!capabilities?.available} onClick={()=>void run({method:"permissions"}).then(setPermissions).catch(()=>{})}><Icon name="refresh" size={14}/>刷新</button></header>
      {[["accessibility","无障碍","读取应用界面树并执行请求的操作","shield"],["screen_capture","截图","捕获应用窗口，以便代理核对视觉状态","image"]].map(([key,label,description,icon])=><div className="computer-permission-row" key={key}><Icon name={icon as "shield"|"image"} size={14}/><div><strong>{label}</strong><span className="computer-permission-badge" data-granted={permissions?.[key]===true}>{permissions?.[key]===true?"已允许":permissions?.[key]===false?"未启用":"未核验"}</span><p>{description}</p></div><button disabled={!capabilities?.available||!navigator.platform.includes("Mac")} aria-label={"打开"+label+"设置"} onClick={()=>openPermission(key)}><Icon name="export" size={14}/>打开</button></div>)}
    </section>{capabilities?.available&&<button className="computer-inspection-entry" aria-label="查看应用窗口" aria-describedby={inspectionDescription} onClick={()=>setInspectionOpen(true)}><Icon name="terminal" size={18}/><span><strong>查看应用窗口</strong><small id={inspectionDescription}>{takenOver?"原窗口已接管，机器输入仍冻结。":"观察、接管与恢复本机窗口。"}</small></span><Icon name="chevron" size={14}/></button>}</>}
    {capabilities?.available&&inspectionOpen&&<div className="computer-inspection-body">
      <div className="external-runtime-toolbar"><label>应用<select aria-label="电脑应用" disabled={working} value={app} onChange={event=>{const epoch=++targetEpoch.current;setApp(event.target.value);setWindow("");setWindows([]);setSnapshot(undefined);setState("");setControl({state:"active",owned:false});if(event.target.value)void run({method:"windows",app:{pid:Number(event.target.value)},limit:128}).then(data=>{if(epoch===targetEpoch.current)setWindows(data.items??[]);}).catch(()=>{});}}><option value="">请选择应用</option>{apps.map(item=><option key={item.pid} value={item.pid}>{item.name}</option>)}</select></label><label>窗口<select aria-label="电脑窗口" disabled={working} value={window} onChange={event=>{++targetEpoch.current;setWindow(event.target.value);setSnapshot(undefined);setState("");setControl({state:"active",owned:false});}}><option value="">请选择窗口</option>{windows.map(item=><option key={item.window_id} value={item.window_id}>{item.title||"窗口"}</option>)}</select></label><button disabled={working||!app||!window} onClick={()=>void observe().catch(()=>{})}>更新观察</button></div>
      {state&&<p role="status">{state}</p>}
      {takenOver&&!control.owned&&<p role="status">此窗口由其他会话接管，机器输入已冻结。</p>}
      {snapshot&&<>
        {snapshot.screenshot?.data&&<img alt="当前窗口的固定观察" src={"data:image/"+(snapshot.screenshot.format==="jpeg"?"jpeg":"png")+";base64,"+snapshot.screenshot.data}/>}
        {snapshot.accessibility_status?.state==="unavailable"&&<p role="status">当前窗口仅可观察截图，辅助功能操作保持停用。</p>}
        <div className="external-runtime-toolbar"><button disabled={working||takenOver} onClick={()=>{void run({method:"takeover",session_id:sessionId,snapshot_ref:snapshot.snapshot_ref,operation_key:crypto.randomUUID()}).then(()=>{setControl({state:"taken_over",owned:true});setSnapshot(undefined);setElement("");setState("已交给你操作，机器输入已冻结。恢复前请更新观察。");}).catch(()=>{});}}>交给我操作</button><button disabled={working||!takenOver||!control.owned} onClick={()=>{void run({method:"resume",session_id:sessionId,snapshot_ref:snapshot.snapshot_ref,operation_key:crypto.randomUUID()}).then(()=>{setControl({state:"active",owned:true});setSnapshot(undefined);setElement("");setState("已恢复输入，请更新观察后操作。");}).catch(()=>{});}}>恢复机器操作</button></div>
        {!!snapshot.elements?.length&&<><details><summary>窗口元素</summary><div className="external-computer-elements">{snapshot.elements.map((item:any)=><button key={item.index} aria-pressed={element===String(item.index)} onClick={()=>setElement(String(item.index))}>{item.title||item.description||({AXWindow:"窗口",AXTextField:"文字输入",AXTextArea:"多行文字",AXButton:"按钮",AXGroup:"分组",AXScrollArea:"滚动区域"} as any)[item.role]||item.role} <small>{item.title===item.role||item.description===item.role?null:item.role}</small></button>)}</div></details>
        <div className="external-runtime-toolbar"><button disabled={working||takenOver||!element} onClick={()=>void act("focus_element").catch(()=>{})}>聚焦元素</button><button disabled={working||takenOver||!element} onClick={()=>void act("click").catch(()=>{})}>点击元素</button></div>
        <label>输入文字<input aria-label="电脑输入文字" value={text} maxLength={4096} onChange={event=>setText(event.target.value)}/></label><button disabled={working||takenOver||!element||!text} onClick={()=>void act("set_value").catch(()=>{})}>填入所选元素</button></>}
        {snapshot.truncation&&<details><summary>观察范围</summary><pre>{JSON.stringify(snapshot.truncation,null,2)}</pre></details>}
      </>}
    </div>}
  </section></div>;
}
