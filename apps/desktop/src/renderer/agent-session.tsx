import React, { useEffect, useRef, useState } from "react";
import type { WorkRef } from "@hetu/plugin-sdk";
import type { SurfaceContext } from "./contributions.tsx";
import type { SessionSnapshot } from "../agent-session-contract.ts";
import { desktop } from "./bridge.ts";
import { CodexTerminal } from "./codex-terminal.tsx";
import {CodexResults} from "./codex-results.tsx";
import {AgentChat} from "./agent-chat.tsx";
import {AgentContextPicker,type AgentContextPickerKind} from "./agent-context-picker.tsx";
import {AgentContent} from "./agent-content.tsx";
import {Icon,IconButton} from "@hetu/workbench-ui";
import {AgentLaunchDialog,engineTitle} from "./agent-launch-dialog.tsx";
import type {SessionLaunch} from "../agent-session-contract.ts";
import "./codex-session.css";
import {ExternalRuntimePanel} from "./external-runtime-panel.tsx";
import {AgentBusiness,WorkChoice,type AgentWorkChoice,workChoiceKey} from "./agent-business.tsx";
import {ExecutionNavigation,ExecutionNavigationProvider, type ExecutionLayout, type ExecutionNavigationProps, type BotNavigationItem} from "./execution-navigation.tsx";
import {ExecutionTabs, useExecutionTabs} from "./execution-tabs.tsx";
import {AgentChatSettings} from "./agent-chat-settings.tsx";

const status: Record<string, string> = { idle: "未开始", starting: "正在连接", ready: "已连接", running: "处理中", stopping: "正在停止", switching: "正在切换", stopped: "已关闭", failed: "连接失败", uncertain: "结果待核对", disconnected: "连接中断" };
export function AgentSession({ work, notify, controls,layout:providedLayout,maximized=false,works=[],onScope,onLaunch,onRuntimeChange }: Omit<SurfaceContext, "work"> & { layout?:ExecutionLayout;work?: WorkRef; controls?:React.ReactNode;maximized?:boolean;works?:AgentWorkChoice[];onScope?(work?:WorkRef):Promise<void>;onLaunch?(launch:SessionLaunch,work?:WorkRef):Promise<boolean>;onRuntimeChange?(open:boolean):void }) {
  const layout:ExecutionLayout=providedLayout??{full:false,navigationVisible:false,navigationWidth:280,onNavigation:()=>{},onNavigationWidth:()=>{},onLibrary:()=>{},onScope,works,work};
  const [snapshot, setSnapshot] = useState<SessionSnapshot>({ state: "idle", client: "codex", surface: "tui", work_ref: work, messages: [], updated_at: "" });
  const [sessions, setSessions] = useState<{session_id:string;title:string}[]>([]);
  const [bots,setBots] = useState<BotNavigationItem[]>([]),[navigationError,setNavigationError]=useState("");
  const [renameTitle,setRenameTitle] = useState("");
  const [renaming,setRenaming] = useState(false);
  const [removing,setRemoving] = useState(false);
  const [creating,setCreating]=useState(false);
  const [runtimeDomain,setRuntimeDomain]=useState<"bots"|"computer">();
  const [runtimeBot,setRuntimeBot]=useState<string>(),[runtimeCreate,setRuntimeCreate]=useState(false);
  useEffect(()=>{onRuntimeChange?.(!!runtimeDomain);return()=>onRuntimeChange?.(false);},[runtimeDomain,onRuntimeChange]);
  useEffect(()=>{const underlay=panel.current?.querySelector<HTMLElement>(".codex-main-underlay");if(underlay)underlay.inert=!!runtimeDomain;},[runtimeDomain]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError,setSendError]=useState("");
  const [contextPicker,setContextPicker]=useState<{kind:AgentContextPickerKind;work:WorkRef;session_id?:string;generation?:number}>();
  const [preferences, setPreferences] = useState<any>({});
  const [terminalTools,setTerminalTools]=useState<HTMLDivElement|null>(null);
  const panel=useRef<HTMLElement>(null);
  const current = useRef(snapshot); current.current = snapshot;
  const localDraft=useRef({text:"",version:0,dirty:false});
  const savingDraft=useRef<Promise<void>>();
  const sending=useRef(false);
  const key = work ? `${work.workspace_id}/${work.kind}/${work.object_id}` : "library";
  const currentKey=useRef(key);currentKey.current=key;
  const scope = work ? {work_ref:work} : { scope: "library" };
  const errorShown=(message:string)=>!!current.current.error&&message.includes(current.current.error);
  useEffect(()=>setContextPicker(undefined),[snapshot.session_id,snapshot.generation,snapshot.surface]);
  function closeContextPicker(){setContextPicker(undefined);requestAnimationFrame(()=>document.querySelector<HTMLElement>('.agent-chat summary[aria-label="附加上下文"]')?.focus());}
  function closeCreate(){setCreating(false);if(current.current.state==="idle")requestAnimationFrame(()=>panel.current?.querySelector<HTMLButtonElement>('button[aria-label="新建会话"]')?.focus());}
  function attach(page:string){
    const fixed=current.current;
    const kind=({"work.tasks":"tasks","plugin.results":"plugins","novel.outlines":"outlines","work.canon":"canon","drama.scenes":"scenes","video.sources":"video"} as Record<string,AgentContextPickerKind>)[page];
    if(kind&&fixed.work_ref)setContextPicker({kind,work:fixed.work_ref,session_id:fixed.session_id,generation:fixed.generation});
    else void call("attach_context",{page,session_id:fixed.session_id,generation:fixed.generation});
  }
  function accept(value:SessionSnapshot){
    const previous=current.current,changed=value.session_id!==previous.session_id||value.surface!==previous.surface||value.thread_id!==previous.thread_id;
    if(value.session_id===previous.session_id&&(value.generation??0)<(previous.generation??0))return;
    if(!changed&&(value.draft_version??0)<(previous.draft_version??0))value={...value,draft:previous.draft,gui_draft:previous.gui_draft,tui_draft:previous.tui_draft,draft_version:previous.draft_version,context_refs:previous.context_refs};
    current.current=value;setSnapshot(value);
    if(value.session_id!==previous.session_id||value.surface!==previous.surface||!localDraft.current.dirty){localDraft.current={text:value.draft??"",version:localDraft.current.version+1,dirty:false};setDraft(value.draft??"");}
  }
  async function saveDraft():Promise<void>{
    if(savingDraft.current){await savingDraft.current;return saveDraft();}
    if(current.current.surface!=="gui"||!localDraft.current.dirty)return;
    const fixed=current.current,{text,version}=localDraft.current;
    const pending=desktop.agentSession("draft",{...scope,text,session_id:fixed.session_id,generation:fixed.generation,surface:"gui"}).then((value:SessionSnapshot)=>{
      if(currentKey.current!==key||current.current.session_id!==fixed.session_id||current.current.generation!==fixed.generation)return;
      if(localDraft.current.version===version)localDraft.current.dirty=false;
      accept(value);
    });savingDraft.current=pending;
    try{await pending;}finally{if(savingDraft.current===pending)savingDraft.current=undefined;}
  }
  async function list() { const value=await desktop.agentSession("list", scope);if(currentKey.current===key)setSessions(value); }
  async function listBots() {
    try {const value=await desktop.agentSession("runtime",{...scope,domain:"bots",input:{method:"list",limit:128}});if(value.status!=="succeeded")throw Error(value.error?.message??"Bots目录读取失败。");if(currentKey.current===key){setBots((value.data.bots??[]).map((row:any)=>({id:row.bot_ref.bot_id,name:row.bot.config.name,purpose:row.bot.config.purpose,status:row.bot.status})));setNavigationError("");}}
    catch(error){if(currentKey.current===key)setNavigationError((error as Error).message);}
  }
  useEffect(()=>{if(!runtimeDomain)void listBots();},[key,runtimeDomain]);
  async function call(method: Parameters<typeof desktop.agentSession>[0], input?: Record<string, unknown>, propagate = false) {
    setBusy(true);
    try { if(["surface","select","new","stop","send","attach_context","remove_context"].includes(method))await saveDraft();const value = await desktop.agentSession(method, { ...scope, session_id: current.current.session_id, ...input }); if(currentKey.current!==key)return;if (value?.state) { accept(value); void list(); }if(["attach_context","remove_context","select","new"].includes(method))setSendError(""); return value; }
    catch (error) {
      if(currentKey.current===key&&method==="new")await desktop.agentSession("get",scope).then(value=>{if(currentKey.current===key)accept(value);}).catch(()=>{});
      if(currentKey.current===key){
        const message=(error as Error).message,shown=errorShown(message);
        if(method==="send")setSendError(shown?"":message);else if(!propagate&&!shown)notify(message);
      }
      if(propagate)throw error;return undefined;
    }
    finally { if(currentKey.current===key)setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    setSnapshot({state:"idle",client:"codex",surface:"tui",work_ref:work,messages:[],updated_at:""});setDraft("");setSessions([]);setBusy(false);
    setSendError("");
    setContextPicker(undefined);
    localDraft.current={text:"",version:localDraft.current.version+1,dirty:false};
    void desktop.agentSession("get", scope).then(async value => { if(!active)return;accept(value);if(value.thread_id||value.client!=="codex"||value.generation>0){setBusy(true);try{const connected=await desktop.agentSession("start",{...scope,session_id:value.session_id});if(active)accept(connected);}finally{if(active)setBusy(false);}}else setCreating(true); }).catch(error => {if(active&&!errorShown(error.message))notify(error.message);});
    void list().catch(error => notify(error.message));
    void desktop.state().then(value => { if (active) setPreferences(value.preferences ?? {}); });
    const unsubscribe = desktop.onAgentSession(event => {
      const next = event?.snapshot;
      if (!active || event?.type !== "snapshot" || next.work_ref?.workspace_id !== work?.workspace_id || next.work_ref?.kind !== work?.kind || next.work_ref?.object_id !== work?.object_id || current.current.session_id && next.session_id !== current.current.session_id) return;
      if(next.title !== current.current.title || next.thread_id !== current.current.thread_id) void list().catch(error=>notify(error.message));
      accept(next);
    });
    const unpreferences = desktop.onPreferences(value => { if (active) setPreferences(value); });
    return () => { active = false; unsubscribe(); unpreferences(); };
  }, [key]);
  const running = ["starting", "running", "stopping", "switching"].includes(snapshot.state);
  const currentStatus=snapshot.authentication?.state==="required"?"需要登录":snapshot.authentication?.state==="signing_in"?"等待登录":status[snapshot.state]??snapshot.state;
  async function send() {
    if (!draft.trim() || busy || sending.current) return;
    sending.current=true;
    try{setSendError("");await saveDraft();await call("send", { text:localDraft.current.text,attempt_id:crypto.randomUUID(),generation:current.current.generation,draft_version:current.current.draft_version });}
    catch(error){setSendError((error as Error).message);}
    finally{sending.current=false;}
  }
  const selectSession=async(id:string)=>{if(id===current.current.session_id){await saveDraft();return;}const value=await call("select",{session_id:id},true);if(value)await call("start",{session_id:id},true);};
  const view=useExecutionTabs(key,snapshot.state==="idle"&&!snapshot.thread_id&&!snapshot.generation?undefined:snapshot.session_id,saveDraft,selectSession);
  const openRuntime=(domain:"bots"|"computer",botId?:string,create=false)=>{setRuntimeBot(botId);setRuntimeCreate(create);setRuntimeDomain(domain);};
  const nav:ExecutionNavigationProps={
    layout:{...layout,onScope:async target=>{await saveDraft();await onScope?.(target);},onWorkSurface:layout.onWorkSurface?async page=>{await saveDraft();await layout.onWorkSurface!(page);}:undefined,onLibrary:()=>{void saveDraft().then(layout.onLibrary).catch(error=>notify(error.message));}},
    active:"sessions",sessions,sessionId:snapshot.session_id,bots,busy,error:navigationError,
    onSession:async id=>{await view.open(id);setRuntimeDomain(undefined);},onBot:async id=>openRuntime("bots",id),
    onSessions:()=>setRuntimeDomain(undefined),onBots:()=>openRuntime("bots"),onNewBot:()=>openRuntime("bots",undefined,true),onComputer:()=>openRuntime("computer"),
    onRefresh:()=>{void list().catch(error=>notify(error.message));void listBots();},notify,
  };
  const location=<><span><Icon name="terminal" size={12}/>本地{navigator.platform.includes("Mac")?" Mac":"电脑"}</span><span><Icon name="folder" size={12}/>{works.find(item=>workChoiceKey(item.work_ref)===workChoiceKey(work))?.title??(work?"当前作品":"创作库筹备")}</span><span role="status">{currentStatus}</span></>;
  return <ExecutionNavigationProvider><section ref={panel} className="codex-session surface-page" aria-label="独立 Agent 会话" aria-busy={busy}>
    <div className={runtimeDomain?"codex-main-underlay is-covered":"codex-main-underlay"} data-navigation-open={layout.full&&layout.navigationVisible} aria-hidden={!!runtimeDomain}>
    <ExecutionNavigation {...nav}/>
    <div className="codex-session-main" data-surface={snapshot.surface}>
    <AgentContent work={work} snapshot={snapshot} sessionTitle={engineTitle(snapshot.client)} notify={notify} maximized={maximized} includeSessionTab={false} header={(directoryControl,tabs,preview)=><>
    <header className="codex-session-header">
      {layout.full&&!layout.navigationVisible&&<IconButton icon="sidebar" label="展开左侧栏" onClick={()=>layout.onNavigation(true)}/>}
      <ExecutionTabs items={(tabs&&!view.ids.length&&snapshot.session_id?[snapshot.session_id]:view.ids).flatMap(id=>{const item=sessions.find(item=>item.session_id===id);return item?[item]:id===snapshot.session_id?[{session_id:id,title:snapshot.title??engineTitle(snapshot.client)}]:[];})} activeId={view.closed||preview.active?undefined:snapshot.session_id} disabled={busy} onSelect={id=>{preview.onSession();void view.open(id).catch(error=>notify(error.message));}} onClose={id=>void view.close(id).catch(error=>notify(error.message))} onNew={()=>setCreating(true)}>{tabs&&<div className="codex-header-tabs">{tabs}</div>}</ExecutionTabs>
      <div className="codex-session-actions">
        {["required","signing_in"].includes(snapshot.authentication?.state??"")&&<button disabled={busy} onClick={()=>void call("login")}>{snapshot.authentication?.state==="signing_in"?"打开登录页面":"登录 Codex"}</button>}
        {!running && !["required","signing_in"].includes(snapshot.authentication?.state??"") && !["idle","uncertain"].includes(snapshot.state) && (snapshot.state !== "ready" || snapshot.surface === "tui" && !snapshot.terminal_connected) && <button disabled={busy} onClick={() => void call("start")}>重新连接</button>}
        {running && <button disabled={busy || snapshot.state === "starting" || snapshot.state === "switching" || snapshot.state === "stopping"} onClick={() => void call("interrupt")}>停止本轮</button>}
        {snapshot.surface==="tui"&&<div className="codex-header-tools" ref={setTerminalTools}/>}
        {directoryControl}
        <details className="popover-menu"><summary aria-label="会话操作" title="会话操作"><Icon name="more"/></summary><div className="menu-panel"><button disabled={!snapshot.session_id} onClick={()=>{setRenameTitle(snapshot.title ?? "");setRenaming(true);}}>重命名</button>{snapshot.client==="codex"&&<button disabled={busy||running} onClick={()=>void call("surface",{surface:snapshot.surface==="tui"?"gui":"tui"})}>{snapshot.surface==="tui"?"切换到聊天":"切换到终端"}</button>}<button disabled={busy || running} onClick={()=>setRemoving(true)}>移除会话记录</button>{snapshot.client==="codex"&&<button disabled={busy} onClick={() => void call("recover")}>核对原线程</button>}<button disabled={busy} onClick={() => void call("stop")}>关闭终端</button>{!layout.full&&<><button onClick={()=>openRuntime("bots")}>Bots</button>{onScope&&<WorkChoice work={work} works={works} disabled={busy} onChange={target=>void nav.layout.onScope?.(target).catch(error=>notify(error.message))}/>}</>}<button onClick={()=>openRuntime("computer")}>计算机控制</button><button onClick={()=>void desktop.settingsWindow("open")}>本机设置</button></div></details>
        {controls}
      </div>
    </header>
    {snapshot.error && <p className="notice" role="alert">{snapshot.error}</p>}
    {snapshot.client!=="codex"&&snapshot.client!=="shell"&&snapshot.draft&&<div className="agent-draft-bar" role="status"><span>创作请求已准备</span><button disabled={busy||!snapshot.terminal_connected} title="完成终端登录或信任提示后放入，不自动发送" onClick={()=>void call("paste_draft",{generation:snapshot.generation,draft_version:snapshot.draft_version})}>放入终端</button><button disabled={busy} onClick={()=>void call("draft",{text:"",generation:snapshot.generation})}>清除</button></div>}
    {renaming && <form className="codex-session-inline" onSubmit={event=>{event.preventDefault();void call("rename",{title:renameTitle}).then(value=>{if(value)setRenaming(false);});}}><label>会话名称<input autoFocus maxLength={100} value={renameTitle} onChange={event=>setRenameTitle(event.target.value)}/></label><button disabled={busy || !renameTitle.trim()}>保存名称</button><button type="button" onClick={()=>setRenaming(false)}>取消</button></form>}
    {removing && <div className="codex-session-inline" role="alertdialog" aria-label="移除会话记录"><p>移除“{snapshot.title}”的本机列表记录；作品、任务及引擎历史保留。</p><button disabled={busy} onClick={()=>void call("remove").then(value=>{if(value){setRemoving(false);setCreating(true);}})}>移除记录</button><button onClick={()=>setRemoving(false)}>取消</button></div>}

    </>}>
    <div className="agent-session-view" hidden={view.closed}>
    {snapshot.surface === "tui" ? <><CodexTerminal snapshot={snapshot} preferences={preferences} notify={notify} toolbarTarget={terminalTools} actions={snapshot.client!=="shell"?<CodexResults snapshot={snapshot} compact/>:undefined}/><footer className="agent-session-location">{location}<span className="agent-session-footer-task"><AgentBusiness snapshot={snapshot} notify={notify}/></span></footer></> : <AgentChat key={JSON.stringify([snapshot.session_id,snapshot.thread_id])} snapshot={snapshot} preferences={preferences} draft={draft} busy={busy} error={sendError} toolbar={<><CodexResults snapshot={snapshot} compact disabled={view.closed}/><AgentChatSettings preferences={preferences} notify={notify}/></>} location={location} inputActions={<AgentBusiness snapshot={snapshot} notify={notify}/>} onDraft={text=>{localDraft.current={text,version:localDraft.current.version+1,dirty:true};setDraft(text);}} onSave={saveDraft} onSend={send} onAttach={attach} onRemove={reference=>void call("remove_context",{reference:reference.reference,generation:current.current.generation})} onAnswer={(request,result)=>void call("respond",{id:request.id,generation:request.generation,result})} notify={notify}/>}</div>
    {view.closed&&<div className="agent-session-closed"><Icon name="comment" size={28}/><h2>打开会话继续</h2><p>从侧栏打开原会话，或开始新的对话。</p><button onClick={()=>void view.open(snapshot.session_id!).catch(error=>notify(error.message))}>重新打开 {snapshot.title}</button></div>}
    </AgentContent>
    </div>
    </div>
    {runtimeDomain&&<ExternalRuntimePanel key={JSON.stringify([key,runtimeDomain])} domain={runtimeDomain} navigation={nav} initialBotId={runtimeBot} createBot={runtimeCreate} work={work} snapshot={snapshot} preferences={preferences} notify={notify} onClose={()=>setRuntimeDomain(undefined)}/>}
    {contextPicker&&<AgentContextPicker key={JSON.stringify([contextPicker.kind,contextPicker.work,contextPicker.session_id,contextPicker.generation])} kind={contextPicker.kind} work={contextPicker.work} onClose={closeContextPicker} onSelect={async value=>{
      if(current.current.session_id!==contextPicker.session_id||current.current.generation!==contextPicker.generation||workChoiceKey(current.current.work_ref)!==workChoiceKey(contextPicker.work))throw Error("会话或作品已切换，请重新选择上下文。");
      return !!await call("attach_context",{...value,work_ref:contextPicker.work,session_id:contextPicker.session_id,generation:contextPicker.generation},true);
    }}/>}
    {creating&&<AgentLaunchDialog client={snapshot.client} context={work?"当前作品":"创作库"} work={work} works={works} busy={busy} onClose={closeCreate} onCreate={async(launch:SessionLaunch,target?:WorkRef)=>{if(workChoiceKey(target)!==workChoiceKey(work)&&onLaunch){setBusy(true);try{return await onLaunch(launch,target);}finally{setBusy(false);}}const previous=current.current.session_id;const value=await call("new",{session_id:undefined,launch});return !!value||current.current.session_id!==previous;}}/> }
  </section></ExecutionNavigationProvider>;
}
