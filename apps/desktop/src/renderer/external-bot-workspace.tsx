import React,{useEffect,useRef,useState} from "react";
import {Icon,IconButton} from "@hetu/workbench-ui";
import type {AgentEngine,AgentModel,SessionSnapshot} from "../agent-session-contract.ts";
import {desktop} from "./bridge.ts";
import {AgentChat} from "./agent-chat.tsx";
import {AgentLaunchPicker,engineTitle,type AgentPickerValue} from "./agent-launch-picker.tsx";
import {AgentProviderIcon} from "./agent-provider-icons.tsx";
import {ExternalQuestionForm} from "./external-question-form.tsx";
import {ExternalElicitationForm} from "./external-elicitation-form.tsx";
import {CodexRequest} from "./codex-request.tsx";
import {BotTerminal} from "./external-bot-terminal.tsx";
import {CodexResults} from "./codex-results.tsx";
import type {WorkRef} from "@hetu/plugin-sdk";
import {ExecutionNavigation,type ExecutionNavigationProps} from "./execution-navigation.tsx";
import {ExecutionTabs,useExecutionTabs} from "./execution-tabs.tsx";
import {BotExecutionPicker,BotInspector,botSessionStatus} from "./bot-configuration.tsx";
import {AgentChatSettings} from "./agent-chat-settings.tsx";

type Request=(input:Record<string,unknown>)=>Promise<any>;
type Draft={id?:string;generation?:number;text:string;version:number;dirty:boolean;attempt?:{version:number;input:Record<string,unknown>}};
const views=new Map<string,{botId:string;sessionId?:string}>();

/** Bots复用原消息工作面、原PTY及固定配置；界面状态不成为另一份会话事实。 */
export function BotWorkspace({request,snapshot,work,preferences,notify,registerFlush,onClose,notices,navigation,initialBotId,createBot=false}:{request:Request;snapshot:SessionSnapshot;work?:WorkRef;preferences:any;notify(message:string):void;registerFlush(value:()=>Promise<void>):void;onClose():void;notices?:React.ReactNode;navigation:ExecutionNavigationProps;initialBotId?:string;createBot?:boolean}){
 const [rows,setRows]=useState<any[]>([]),[selected,setSelected]=useState<any>(),[engines,setEngines]=useState<AgentEngine[]>([]),[models,setModels]=useState<AgentModel[]>([]),[templates,setTemplates]=useState<any[]>([]);
 const [name,setName]=useState(""),[purpose,setPurpose]=useState(""),[choice,setChoice]=useState<AgentPickerValue>({client:"codex"}),[surface,setSurface]=useState("gui");
 const [session,setSession]=useState<any>(),[sessions,setSessions]=useState<any[]>([]),[message,setMessage]=useState(""),[interaction,setInteraction]=useState<any>(),[working,setWorking]=useState(false),[editing,setEditing]=useState(false),[newMode,setNewMode]=useState(false),[search,setSearch]=useState(""),[loading,setLoading]=useState(true);
 const [inspector,setInspector]=useState(()=>innerWidth>=1180),[inspectorView,setInspectorView]=useState<"home"|"history"|"settings">("home"),[terminalTools,setTerminalTools]=useState<HTMLDivElement|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),section=useRef<HTMLDivElement>(null),dialogOpener=useRef<HTMLElement>(),draft=useRef<Draft>({text:"",version:0,dirty:false}),saving=useRef<Promise<void>>(),selection=useRef(0),readSequence=useRef(0),submitting=useRef(false),terminalFlush=useRef<()=>Promise<void>>(),operations=useRef(0);
 const scopeKey=JSON.stringify(work?[work.workspace_id,work.kind,work.object_id]:null);
 const remember=(botId:string,sessionId?:string)=>{views.delete(scopeKey);views.set(scopeKey,{botId,sessionId});if(views.size>50)views.delete(views.keys().next().value!);};
 const perform=async<T,>(operation:()=>Promise<T>)=>{operations.current++;setWorking(true);try{return await operation();}finally{operations.current--;setWorking(operations.current>0);}};
 const run=(input:Record<string,unknown>)=>perform(()=>request(input));
 const load=async()=>{setLoading(true);try{const data=await request({method:"list",limit:128});setRows(data.bots??[]);return data.bots??[];}finally{setLoading(false);}};
 async function saveDraft():Promise<void>{
  if(saving.current){await saving.current;if(draft.current.dirty)return saveDraft();return;}
  const current=draft.current;if(!current.dirty||!current.id)return;
  const attempt=current.attempt?.version===current.version?current.attempt:{version:current.version,input:{method:"session_draft",session_id:current.id,generation:current.generation,data:current.text,operation_key:crypto.randomUUID()}};
  current.attempt=attempt;
  const pending=request(attempt.input).then(()=>{if(draft.current.id===current.id&&draft.current.version===attempt.version)draft.current.dirty=false;});saving.current=pending;
  try{await pending;}finally{if(saving.current===pending)saving.current=undefined;}
 }
 const flushSession=async()=>{await terminalFlush.current?.();await saveDraft();};
 registerFlush(flushSession);
 const readSession=async(id:string)=>{
  const ticket=++readSequence.current,value=await request({method:"session_read",session_id:id,format:"conversation",limit:12000});
  let saved=value.draft??"";if(value.draft_read){let offset=0;for(let page=0;page<32;page++){if(ticket!==readSequence.current)return value;const part=await request({method:"session_draft_read",session_id:id,generation:value.generation,expected_draft_version:value.draft_version,offset,limit:4000});saved+=part.draft;if(part.next_offset===null)break;offset=part.next_offset;if(page===31)throw Error("草稿超过本次读取范围，原稿已保留。");}}
  if(ticket!==readSequence.current)return value;
  if(draft.current.id!==id){draft.current={id,generation:value.generation,text:saved,version:0,dirty:false};setMessage(draft.current.text);}
  else{draft.current.generation=value.generation;if(!draft.current.dirty){draft.current.text=saved;setMessage(draft.current.text);}}
  setSession(value);setInteraction(undefined);return value;
 };
 const sessionCall=(method:string,input:Record<string,unknown>={})=>perform(async()=>{const value=await run({method,session_id:session.session_id,generation:session.generation,operation_key:crypto.randomUUID(),...input});await readSession(session.session_id);return value;});
 const openSession=(id:string,bot:any)=>perform(async()=>{
  const epoch=selection.current;await flushSession();if(session?.session_id!==id)setSession(undefined);const value=await readSession(id);if(epoch!==selection.current)return;remember(bot.bot_ref.bot_id,id);
  if(bot.bot.status==="active"&&value.surface==="gui"&&value.thread_id&&value.state==="stopped"&&JSON.stringify(value.bot_ref)===JSON.stringify(bot.bot_ref)){
   await run({method:"session_restore",session_id:id,generation:value.generation,operation_key:crypto.randomUUID()});await readSession(id);
  }
  if(innerWidth<760)navigation.layout.onNavigation(false);
 });
 const select=(row:any)=>perform(async()=>{
  await flushSession();const epoch=++selection.current,data=await run({method:"get",bot_id:row.bot_ref.bot_id});if(epoch!==selection.current)return;
  const config=data.bot.config;if(session?.bot_ref?.bot_id!==data.bot_ref.bot_id){++readSequence.current;setSession(undefined);setSessions([]);}setSelected(data);setName(config.name);setPurpose(config.purpose);setChoice({client:config.execution.provider_id,model:config.execution.model_id});setSurface(config.execution.surface);setEditing(false);setInteraction(undefined);
  const found=await request({method:"sessions",bot_id:data.bot_ref.bot_id});if(epoch!==selection.current)return;setSessions(found.sessions??[]);
  const previous=views.get(scopeKey),current=found.sessions?.find((item:any)=>previous?.botId===data.bot_ref.bot_id&&item.session_id===previous?.sessionId)??found.sessions?.[0];
  if(current)await openSession(current.session_id,data);else{remember(data.bot_ref.bot_id);setSession(undefined);draft.current={text:"",version:0,dirty:false};setMessage("");}
 });
 const createSession=(bot:any)=>perform(async()=>{
  await flushSession();const receipt=await run({method:"session_create",expected_ref:bot.bot_ref,operation_key:crypto.randomUUID()}),value=receipt.result??receipt;
  await readSession(value.session_id);await run({method:"session_start",session_id:value.session_id,generation:value.generation,operation_key:crypto.randomUUID()});await readSession(value.session_id);remember(bot.bot_ref.bot_id,value.session_id);
  const found=await request({method:"sessions",bot_id:bot.bot_ref.bot_id});setSessions(found.sessions??[]);if(innerWidth<760)navigation.layout.onNavigation(false);
  requestAnimationFrame(()=>section.current?.querySelector<HTMLTextAreaElement>('.agent-chat-input textarea')?.focus());
 });
 const submit=async()=>{
  if(submitting.current||!name.trim()||!purpose.trim()||!choice.model?.trim()||!engines.find(item=>item.id===choice.client)?.available)return;submitting.current=true;
  try{await perform(async()=>{
  const creating=newMode||!selected,config={name,purpose,execution:{provider_id:choice.client,surface,model_id:choice.model}};
  const result=await run(creating?{method:"create",config,operation_key:crypto.randomUUID()}:{method:"update",expected_ref:selected.bot_ref,patch:config,operation_key:crypto.randomUUID()});
  await load();const data=await request({method:"get",bot_id:result.bot_ref.bot_id});setSelected(data);setEditing(false);setSessions([]);setSession(undefined);
  if(creating)await createSession(data);else await select({bot_ref:result.bot_ref});
  });}finally{submitting.current=false;}
 };
 useEffect(()=>{let active=true;if(innerWidth<760)navigation.layout.onNavigation(false);void load().then(async items=>{if(active&&items.length)await select(items.find((item:any)=>item.bot_ref.bot_id===(initialBotId??views.get(scopeKey)?.botId))??items[0]);if(active&&createBot)await newBot();}).catch(()=>{});void desktop.agentSession("catalog").then(items=>{if(active)setEngines(items);}).catch(()=>{});void request({method:"templates"}).then(value=>{if(active)setTemplates(value.templates??value.items??[]);}).catch(()=>{});return()=>{active=false;++selection.current;void saveDraft().catch(()=>{});};},[]);
 useEffect(()=>{let active=true;setModels([]);const found=snapshot.client===choice.client?snapshot.external?.models:undefined;if(found?.length){setModels(found.map(item=>({id:item.id,name:item.label,efforts:(item.efforts??[]).map(effort=>effort.id),default_effort:item.efforts?.find(effort=>effort.id===snapshot.reasoning_effort)?.id})));return;}
  void desktop.agentSession("model_options",{client:choice.client}).then(value=>{if(active)setModels(value);}).catch(()=>{});return()=>{active=false;};
 },[choice.client]);
 useEffect(()=>{const current=dialog.current,previous=dialogOpener.current??document.activeElement as HTMLElement;if(editing){current?.showModal();current?.querySelector<HTMLInputElement>('input[aria-label="名称"]')?.focus();}else current?.close();return()=>{current?.close();if(editing&&!submitting.current)requestAnimationFrame(()=>{if(previous.isConnected)previous.focus();});};},[editing]);
 useEffect(()=>{if(!draft.current.dirty||!draft.current.id)return;const timer=setTimeout(()=>void saveDraft().catch(error=>notify(error.message)),180);return()=>clearTimeout(timer);},[message]);
 useEffect(()=>{
  if(!session||session.surface!=="gui"||session.state!=="running"||session.read_error)return;
  const id=session.session_id;let active=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const value=await request({method:"session_read",session_id:id,format:"conversation",limit:12000});if(!active)return;setSession((current:any)=>current?.session_id===id?value:current);}catch{if(active)setSession((current:any)=>current?.session_id===id?{...current,read_error:true}:current);return;}if(active)timer=setTimeout(()=>void poll(),500);};
  void poll();return()=>{active=false;clearTimeout(timer);};
 },[session?.session_id,session?.surface,session?.state,session?.read_error]);
 useEffect(()=>{const resize=()=>{if(innerWidth<1180)setInspector(false);};window.addEventListener("resize",resize);return()=>window.removeEventListener("resize",resize);},[]);
 const canExecute=selected?.bot.status==="active"&&session?.bot_ref&&JSON.stringify(session.bot_ref)===JSON.stringify(selected.bot_ref);
 const changeBot=(method:"pause"|"resume"|"archive"|"restore")=>perform(async()=>{
  const current=selected;await flushSession();
  const result=await request({method,expected_ref:current.bot_ref,operation_key:crypto.randomUUID()});
  await select({bot_ref:result.bot_ref});
 });
 const newBot=(opener?:HTMLElement)=>{dialogOpener.current=opener??document.activeElement as HTMLElement;return perform(async()=>{++selection.current;++readSequence.current;await flushSession();setNewMode(true);setName("");setPurpose("");setChoice({client:"codex"});setSurface("gui");setEditing(true);});};
 const updateConfig=(patch:Record<string,unknown>)=>perform(async()=>{
  const fixed=selected;await flushSession();await run({method:"update",expected_ref:fixed.bot_ref,patch,operation_key:crypto.randomUUID()});
  await load();const latest=await request({method:"get",bot_id:fixed.bot_ref.bot_id});setSelected(latest);
 });
 const openSettings=()=>{setInspector(true);setInspectorView("settings");};
 const sessionItems=sessions.map((item,index)=>({...item,title:index?"聊天 "+(index+1):"主聊天"}));
 const tabView=useExecutionTabs(scopeKey+":"+(selected?.bot_ref.bot_id??"none"),session?.session_id,flushSession,async id=>{if(id!==session?.session_id)await openSession(id,selected);});
 const leave=(action:()=>void|Promise<void>)=>perform(async()=>{await flushSession();await action();});
 const nav:ExecutionNavigationProps={...navigation,active:"bots",busy:working||loading,bots:rows.map(row=>({id:row.bot_ref.bot_id,name:row.bot.config.name,purpose:row.bot.config.purpose,status:row.bot.status})),botId:selected?.bot_ref.bot_id,botSessions:sessionItems,botSessionId:session?.session_id,
  layout:{...navigation.layout,onScope:target=>leave(()=>navigation.layout.onScope?.(target)),onWorkSurface:navigation.layout.onWorkSurface?page=>leave(()=>navigation.layout.onWorkSurface!(page)):undefined,onLibrary:()=>void leave(navigation.layout.onLibrary).catch(()=>{})},
  onSession:id=>leave(()=>navigation.onSession(id)),onBot:async id=>{if(innerWidth<760)navigation.layout.onNavigation(false);if(id===selected?.bot_ref.bot_id&&session){await tabView.open(session.session_id);return;}const row=rows.find(row=>row.bot_ref.bot_id===id);if(row)await select(row);},onBotSession:id=>tabView.open(id),
  onSessions:()=>void leave(navigation.onSessions).catch(()=>{}),onBots:()=>{},onNewBot:()=>void newBot().catch(()=>{}),onComputer:()=>void leave(navigation.onComputer).catch(()=>{}),onRefresh:()=>void load().catch(()=>{}),
 };
 const requests=[...(session?.external?.approvals??[]),...(session?.external?.questions??[]),...(session?.external?.elicitations??[]),...(session?.requests??[])];
 const pending=<>
  {session?.conversation?.complete===false&&<p className="agent-chat-progress" role="status">这里显示有界会话记录，完整文字可沿原会话读取。</p>}
  {requests.map((item:any)=><button className="bot-pending-request" key={item.id} onClick={()=>void request({method:"session_interaction",session_id:session.session_id,request_id:String(item.id)}).then(value=>setInteraction(value.request)).catch(()=>{})}>{item.title??"查看待答请求"}<Icon name="chevron" size={12}/></button>)}
  <fieldset disabled={working||!canExecute} className="external-bot-interaction">
   {interaction?.questions&&<ExternalQuestionForm key={interaction.id} request={interaction} answer={answers=>sessionCall("session_answer",{request_id:interaction.id,answers})} error={notify}/>}
   {interaction?.options&&<div className="external-elicitation-actions">{interaction.options.map((option:any)=><button key={option.id} onClick={()=>void sessionCall("session_approve",{approval_id:interaction.id,option_id:option.id}).catch(()=>{})}>{option.label}</button>)}</div>}
   {interaction?.mode&&<ExternalElicitationForm request={interaction} respond={response=>sessionCall("session_respond",{request_id:interaction.id,request_revision:interaction.revision,response})} open={()=>desktop.agentSession("open_link",{url:interaction.url})} error={notify}/>}
   {interaction?.method&&<CodexRequest request={interaction} busy={working} notify={notify} onAnswer={response=>void sessionCall("session_respond",{request_id:String(interaction.id),request_revision:0,response}).catch(()=>{})}/>}
  </fieldset>
 </>;
 const chat:SessionSnapshot=session?{...session,messages:session.conversation?.messages??[],tools:session.conversation?.tools??[],requests:[],external:undefined}:snapshot;
 const readResults=(current:SessionSnapshot)=>desktop.agentSession("runtime_results",{domain:"bots",session_id:current.session_id,generation:current.generation,bot_ref:session.bot_ref,...(work?{work_ref:work}:{scope:"library"})});
 return <div ref={section} className="bot-workspace" data-navigation-open={navigation.layout.navigationVisible} data-inspector-open={inspector}>
  <ExecutionNavigation {...nav}/>
  <section className="bot-main" aria-label="Bot 会话" data-surface={session?.surface??"gui"}>
   <header className="bot-chat-header">
    {!navigation.layout.navigationVisible&&<IconButton icon="sidebar" label="展开左侧栏" onClick={()=>navigation.layout.onNavigation(true)}/>}
    <ExecutionTabs label="Bot 聊天" newLabel="新建聊天" panelId="bot-chat-panel" items={tabView.ids.flatMap(id=>{const item=sessionItems.find(item=>item.session_id===id);return item?[item]:[];})} activeId={tabView.closed?undefined:session?.session_id} disabled={working||loading} onSelect={id=>void tabView.open(id).catch(()=>{})} onClose={id=>void tabView.close(id).catch(()=>{})} onNew={()=>{if(selected)void createSession(selected).catch(()=>{});}}/>
    <div className="bot-chat-actions">
     {session?.surface==="tui"&&<><CodexResults snapshot={chat} compact readResults={readResults} disabled={working||tabView.closed}/><div className="bot-terminal-tools" ref={setTerminalTools}/></>}
     <details className="popover-menu"><summary aria-label="聊天操作" title="聊天操作"><Icon name="more"/></summary><div className="menu-panel">
      <button disabled={!selected||working} onClick={openSettings}>Bot 设置</button>
      {session&&<><button disabled={working} onClick={()=>void readSession(session.session_id).catch(()=>{})}>读取进展</button><button disabled={working} onClick={()=>void sessionCall("session_interrupt").catch(()=>{})}>中断</button><button disabled={working} onClick={()=>void sessionCall("session_stop").catch(()=>{})}>停止</button></>}
      <button onClick={onClose}>关闭外部工作面</button>
     </div></details>
     <IconButton icon="inspector" label="切换 Bot 详情" aria-pressed={inspector} onClick={()=>setInspector(!inspector)}/>
    </div>
   </header>{notices}
   <div id="bot-chat-panel" className="bot-chat-panel" role="tabpanel" aria-labelledby={session?"execution-tab-"+session.session_id:undefined} aria-label={!session||tabView.closed?"Bot 聊天内容":undefined}>
    {!selected&&loading?<div className="bot-empty" role="status">正在读取 bots…</div>:!selected?<div className="bot-empty"><Icon name="comment" size={28}/><h3>让 bot 接手当前任务</h3><p>选择一个 bot 继续，或创建新的 bot。</p><button className="primary" onClick={event=>void newBot(event.currentTarget).catch(()=>{})}>新建 bot</button></div>:!session&&working?<div className="bot-empty" role="status">正在读取原会话…</div>:!session?<div className="bot-empty"><span className="bot-avatar" aria-hidden="true">{Array.from(String(selected.bot.config.name))[0]}</span><h3>{selected.bot.config.name}</h3><p>{selected.bot.config.purpose}</p><button className="primary" disabled={working||selected.bot.status!=="active"} onClick={()=>void createSession(selected).catch(()=>{})}>开始聊天</button></div>:<>
     <div className="agent-session-view" hidden={tabView.closed}>
      {!canExecute&&<div className="bot-session-notice" role="status"><span>原聊天保留固定配置，可阅读、保留草稿和停止。</span>{selected.bot.status==="active"&&<button disabled={working} onClick={()=>void createSession(selected).catch(()=>{})}>使用新配置聊天</button>}</div>}
      {["idle","stopped"].includes(session.state)&&canExecute&&<div className="bot-session-notice"><button disabled={working} onClick={()=>void sessionCall("session_start").catch(()=>{})}>连接原会话</button></div>}
      {session.surface==="tui"?<><BotTerminal key={session.session_id+":"+session.generation} session={session} request={request} preferences={preferences} notify={notify} enabled={!!canExecute&&!working&&["ready","running"].includes(session.state)} registerFlush={value=>{terminalFlush.current=value;}} toolbarTarget={terminalTools}/><footer className="agent-session-location"><span><Icon name="terminal" size={12}/>本地{navigator.platform.includes("Mac")?" Mac":"电脑"}</span><span><Icon name="folder" size={12}/>{selected.bot.config.name}</span><span className="bot-connection-state" role="status">{botSessionStatus[session.state]??session.state}</span></footer></>:<AgentChat key={session.session_id} snapshot={chat} preferences={preferences} draft={message} busy={working||!canExecute||session.read_error} controls={pending} allowAttach={false} readResults={readResults} resultsDisabled={working} inputLabel="发送给助手"
       toolbar={<><CodexResults snapshot={chat} compact readResults={readResults} disabled={working||tabView.closed}/><AgentChatSettings preferences={preferences} notify={notify}/></>} location={<><span><Icon name="terminal" size={12}/>本地{navigator.platform.includes("Mac")?" Mac":"电脑"}</span><span><Icon name="folder" size={12}/>{selected.bot.config.name}</span><span className="bot-connection-state" role="status">{botSessionStatus[session.state]??session.state}</span></>}
       footer={canExecute?<BotExecutionPicker key={selected.bot_ref.bot_id} config={selected.bot.config} engines={engines} disabled={working} compact onSave={updateConfig} notify={notify}/>:<span className="bot-original-model"><AgentProviderIcon client={session.client} size={14}/>{session.model??session.external?.model??"原配置模型"}</span>}
       onDraft={text=>{draft.current={...draft.current,text,version:draft.current.version+1,dirty:true};setMessage(text);}} onSave={saveDraft} onSend={async()=>{await flushSession();const sent={...draft.current};await sessionCall("session_send",{data:sent.text});if(draft.current.id===sent.id&&draft.current.version===sent.version){draft.current={...draft.current,text:"",dirty:false,attempt:undefined};setMessage("");}}} onAttach={()=>{}} onRemove={()=>{}} onAnswer={()=>{}} onInterrupt={()=>void sessionCall("session_interrupt").catch(()=>{})} notify={notify}/>}
     </div>
     {tabView.closed&&<div className="agent-session-closed"><Icon name="comment" size={28}/><h2>打开聊天继续</h2><p>关闭标签后，原会话与后台执行保留。</p><button onClick={()=>void tabView.open(session.session_id).catch(()=>{})}>重新打开原聊天</button></div>}
    </>}
   </div>
  </section>
  {inspector&&<BotInspector key={selected?.bot_ref.bot_id??"empty"} selected={selected} session={session} sessions={sessionItems} engines={engines} view={inspectorView} onView={setInspectorView} onClose={()=>setInspector(false)} onOpenSession={id=>tabView.open(id)} onSave={updateConfig} onStatus={changeBot} requests={requests} onRequest={item=>void request({method:"session_interaction",session_id:session.session_id,request_id:String(item.id)}).then(value=>setInteraction(value.request)).catch(()=>{})} busy={working} notify={notify}/>}
  {editing&&<dialog ref={dialog} className="bot-create-dialog" aria-labelledby="bot-create-title" onCancel={event=>{event.preventDefault();event.stopPropagation();if(!working)setEditing(false);}} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==="Escape"){event.stopPropagation();return;}if(event.key==="Enter"&&(event.metaKey||event.ctrlKey)){event.preventDefault();void submit().catch(()=>{});}}}>
   <header><h2 id="bot-create-title">新建 bot</h2><IconButton icon="close" label="关闭 Bot 配置" disabled={working} onClick={()=>setEditing(false)}/></header>
   <form onSubmit={event=>{event.preventDefault();void submit().catch(()=>{});}}>
    <div className="bot-name-field"><span className="bot-avatar" aria-hidden="true">{Array.from(name)[0]||<Icon name="comment" size={28}/>}</span><input autoFocus aria-label="名称" placeholder="名称" maxLength={100} value={name} onChange={event=>setName(event.target.value)}/></div>
    <textarea aria-label="身份" placeholder="它是谁，负责做什么" rows={5} maxLength={8000} value={purpose} onChange={event=>setPurpose(event.target.value)}/>
    <div className="bot-runs-on"><div><span>电脑</span><div className="agent-launch-value"><Icon name="terminal" size={14}/>本地{navigator.platform.includes("Mac")?" Mac":"电脑"}</div></div><AgentLaunchPicker value={choice} onChange={value=>{setChoice({client:value.client,model:value.model});if(!engines.find(item=>item.id===value.client)?.chat)setSurface("tui");}} engines={engines.filter(item=>item.id!=="shell")} models={models.map(item=>({...item,efforts:[]}))} customModelLabel="助手模型" disabled={working} footer={<div className="bot-surface-choice" role="group" aria-label="运行方式"><button type="button" disabled={!engines.find(item=>item.id===choice.client)?.chat} aria-pressed={surface==="gui"} onClick={()=>setSurface("gui")}><Icon name="comment" size={14}/>聊天</button><button type="button" aria-pressed={surface==="tui"} onClick={()=>setSurface("tui")}><Icon name="terminal" size={14}/>终端</button></div>}/></div>
    <footer><span/>{!!templates.length&&newMode&&!name&&!purpose&&<details><summary><Icon name="grid" size={14}/>模板</summary><div>{templates.map(item=><button key={item.id??item.name} type="button" onClick={()=>{setName(item.name??item.label??"");setPurpose(item.purpose??item.config?.purpose??"");}}>{item.name??item.label}</button>)}</div></details>}<button className="primary" disabled={working||!name.trim()||!purpose.trim()||!choice.model?.trim()||!engines.find(item=>item.id===choice.client)?.available}>{working?"正在保存…":"创建"}<kbd aria-hidden>{navigator.platform.includes("Mac")?"⌘":"Ctrl"}↵</kbd></button></footer>
   </form>
  </dialog>}
 </div>;
}
