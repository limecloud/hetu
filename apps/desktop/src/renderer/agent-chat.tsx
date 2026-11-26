import React,{memo,useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {agentPreferences,Icon} from "@hetu/workbench-ui";
import type {AgentTool,SessionSnapshot,AgentContextRef} from "../agent-session-contract.ts";
import {sessionTranscript,toolDuration,shouldSendKey} from "../session-transcript.ts";
import {desktop} from "./bridge.ts";
import {CodexRequest} from "./codex-request.tsx";
import {CodexResults} from "./codex-results.tsx";
import {AgentContextList} from "./agent-context-list.tsx";
import "./agent-chat.css";

type View={count:number;key?:string;end?:string;offset:number;bottom:boolean};
const views=new Map<string,View>();
const PAGE=60,MAX_WINDOW=240;
async function copy(text:string,notify:(message:string)=>void){try{await desktop.copy(text);notify("已复制");}catch(error){notify((error as Error).message);}}
const MessageBody=memo(function MessageBody({text,notify}:{text:string;notify:(message:string)=>void}){
 return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
  a:({href,children})=>href&&/^https?:\/\//i.test(href)?<a href={href} onClick={event=>{event.preventDefault();void desktop.agentSession("open_link",{url:href}).catch(error=>notify(error.message));}}>{children}</a>:<span>{children}</span>,
  img:({alt})=><span className="agent-chat-image">{alt||"图片"}（请在作品素材中查看）</span>,
  pre:({children})=><CodeBlock notify={notify}>{children}</CodeBlock>,
  table:({children})=><div className="agent-chat-table"><table>{children}</table></div>,
 }}>{text}</ReactMarkdown>;
});
function CodeBlock({children,notify}:{children:React.ReactNode;notify:(message:string)=>void}){
 const node=useRef<HTMLPreElement>(null);
 return <div className="agent-chat-code"><button onClick={()=>void copy(node.current?.textContent??"",notify)}>复制代码</button><pre ref={node}>{children}</pre></div>;
}
function ToolItem({tool,notify}:{tool:AgentTool;notify:(message:string)=>void}){
 const duration=toolDuration(tool),labels={running:"进行中",completed:"已完成",failed:"失败",unknown:"待核对"};
 let failure=tool.output||"执行失败，请展开查看具体过程。";
 try{const value=JSON.parse(failure);failure=value.error?.message??value.message??value.structuredContent?.error?.message??failure;}catch{/* 普通命令输出保留可读摘要。 */}
 failure=String(failure).slice(0,600);
 return <div className="agent-chat-tool" data-state={tool.state}>
  <details><summary><span className="agent-chat-tool-state">{labels[tool.state]}</span><span className="agent-chat-tool-title">{tool.title}</span>{duration&&<span className="agent-chat-duration">{duration}</span>}</summary>
   <div>{tool.input&&<><strong>输入</strong><pre>{tool.input}</pre></>}{tool.output&&<><strong>输出</strong><pre>{tool.output}</pre></>}<button onClick={()=>void copy([tool.title,tool.input,tool.output].filter(Boolean).join("\n\n"),notify)}>复制过程</button></div>
  </details>
  {tool.state==="failed"&&<p role="alert">{failure}</p>}
  {tool.state==="unknown"&&<p>执行结果待核对，请通过“核对原线程”恢复。</p>}
 </div>;
}
type Props={snapshot:SessionSnapshot;preferences:any;draft:string;busy:boolean;error?:string;onDraft(text:string):void;onSave():Promise<void>;onSend():Promise<void>;onAttach(page:string):void;onRemove(reference:AgentContextRef):void;onAnswer(request:NonNullable<SessionSnapshot["pending_request"]>,result:unknown):void;notify(message:string):void};
/** 消息、原生工具与待答共用阅读流；作品成果仍由Core回读。 */
export function AgentChat({snapshot,preferences,draft,busy,error,onDraft,onSave,onSend,onAttach,onRemove,onAnswer,notify}:Props){
 const settings=agentPreferences(preferences),key=JSON.stringify([snapshot.session_id,snapshot.thread_id]);
 const entries=useMemo(()=>sessionTranscript(snapshot),[snapshot.messages,snapshot.tools]);
 const [count,setCount]=useState(()=>views.get(key)?.count??PAGE),[newMessages,setNewMessages]=useState(false);
 const [,redrawHistory]=useState(0);
 const scroll=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),bottom=useRef(views.get(key)?.bottom??true),restoring=useRef(false),composing=useRef(false),sending=useRef(false);
 const windowEnd=useRef(views.get(key)?.end?entries.findIndex(entry=>entry.key===views.get(key)?.end)+1:entries.length);
 if(!windowEnd.current&&entries.length){const index=entries.findIndex(entry=>entry.key===views.get(key)?.end);windowEnd.current=index<0?entries.length:index+1;}
 if(bottom.current&&!restoring.current)windowEnd.current=entries.length;
 const end=Math.min(entries.length,Math.max(windowEnd.current,0)),start=Math.max(0,end-count);
 const saveView=()=>{
  const element=scroll.current;if(!element||!element.clientHeight)return;
  const top=element.getBoundingClientRect().top,anchor=[...element.querySelectorAll<HTMLElement>("[data-entry]")].find(node=>node.getBoundingClientRect().bottom>top);
  views.delete(key);views.set(key,{count,key:anchor?.dataset.entry,end:entries[end-1]?.key,offset:anchor?anchor.getBoundingClientRect().top-top:0,bottom:bottom.current});
  while(views.size>50)views.delete(views.keys().next().value!);
 };
 const saveCurrent=useRef(saveView);saveCurrent.current=saveView;
 const revision=JSON.stringify([entries.length,snapshot.messages.at(-1)?.text,(snapshot.tools??[]).slice(-8).map(tool=>[tool.id,tool.state,tool.output])]);
 const seenRevision=useRef(revision);
 useLayoutEffect(()=>{
  const element=scroll.current;if(!element)return;
  const view=views.get(key);bottom.current=view?.bottom??true;
  if(view&&!view.bottom){const anchor=[...element.querySelectorAll<HTMLElement>("[data-entry]")].find(node=>node.dataset.entry===view.key);if(anchor)element.scrollTop+=anchor.getBoundingClientRect().top-element.getBoundingClientRect().top-view.offset;}
  else element.scrollTop=element.scrollHeight;
  return()=>saveCurrent.current();
 },[]);
 useLayoutEffect(()=>{
  const element=scroll.current;if(!element||!element.clientHeight||restoring.current)return;
  if(bottom.current){element.scrollTop=element.scrollHeight;setNewMessages(false);}else if(seenRevision.current!==revision)setNewMessages(true);
  seenRevision.current=revision;
 },[revision,newMessages]);
 useEffect(()=>{
  const element=scroll.current;if(!element)return;
  const observer=new ResizeObserver(()=>{if(bottom.current&&element.clientHeight)element.scrollTop=element.scrollHeight;});observer.observe(element);
  return()=>observer.disconnect();
 },[]);
 useEffect(()=>{const element=input.current;if(element){element.style.height="auto";element.style.height=Math.min(200,Math.max(72,element.scrollHeight))+"px";}},[draft]);
 const latest=()=>{const element=scroll.current;if(element){bottom.current=true;windowEnd.current=entries.length;setNewMessages(false);requestAnimationFrame(()=>{element.scrollTop=element.scrollHeight;saveCurrent.current();});}};
 const earlier=()=>{
  const element=scroll.current;if(!element)return;
  const top=element.getBoundingClientRect().top,anchor=[...element.querySelectorAll<HTMLElement>("[data-entry]")].find(node=>node.getBoundingClientRect().bottom>top),anchorKey=anchor?.dataset.entry,offset=anchor?anchor.getBoundingClientRect().top-top:0;
  restoring.current=true;bottom.current=false;
  if(count>=MAX_WINDOW)windowEnd.current=Math.max(MAX_WINDOW,windowEnd.current-PAGE);
  setCount(value=>Math.min(MAX_WINDOW,value+PAGE));redrawHistory(value=>value+1);
  requestAnimationFrame(()=>{const target=[...element.querySelectorAll<HTMLElement>("[data-entry]")].find(node=>node.dataset.entry===anchorKey);if(target)element.scrollTop+=target.getBoundingClientRect().top-element.getBoundingClientRect().top-offset;restoring.current=false;saveCurrent.current();});
 };
 const running=["starting","running","stopping","switching"].includes(snapshot.state),blocked=snapshot.state!=="ready";
 async function send(){if(sending.current||busy||blocked||!draft.trim()||composing.current)return;sending.current=true;try{await onSend();if(settings.scroll_on_send)latest();}finally{sending.current=false;}}
 const size=settings.match_terminal?settings.terminal_font_size:settings.chat_font_size;
 const style={colorScheme:settings.match_terminal&&settings.terminal_theme!=="system"?settings.terminal_theme:undefined,"--agent-chat-font":settings.match_terminal?settings.terminal_font_family||"ui-monospace, monospace":settings.chat_font_family||"system-ui, sans-serif","--agent-chat-size":`${size}px`,"--agent-chat-leading":`${Math.round(size*20/13)}px`,"--agent-code-size":`${settings.code_font_size}px`,"--agent-chat-width":settings.chat_width==="wide"?"960px":settings.chat_width==="full"?"100%":"736px","--agent-chat-ink":`color-mix(in srgb, var(--ink) ${Math.min(100,Math.max(85,85+(settings.chat_contrast-50)*.3))}%, var(--page))`,"--agent-chat-muted":`color-mix(in srgb, var(--ink) ${Math.min(90,Math.max(65,settings.chat_contrast*.65))}%, var(--page))`} as React.CSSProperties;
 return <div className="agent-chat" style={style} data-follow-terminal={settings.match_terminal}>
  <div ref={scroll} className="codex-messages agent-chat-scroll" role="region" aria-label="会话记录" tabIndex={0} onScroll={()=>{if(restoring.current)return;const element=scroll.current!;if(!element.clientHeight)return;bottom.current=element.scrollHeight-element.scrollTop-element.clientHeight<48;if(bottom.current)setNewMessages(false);saveView();}}>
   <div className="agent-chat-column">
    {start>0&&<button className="agent-chat-earlier" onClick={earlier}>加载更早记录（{start}）</button>}
    {!entries.length&&<p className="agent-chat-empty">从一个想法开始，或从目录插入固定引用。</p>}
    {entries.slice(start,end).map(entry=><div key={entry.key} data-entry={entry.key}>{entry.kind==="tool"?<ToolItem tool={entry.tool} notify={notify}/>:<article className="agent-chat-message" data-role={entry.message.role}>
     <header><strong>{entry.message.role==="user"?"你":entry.message.role==="assistant"?"Codex":"系统"}</strong><button onClick={()=>void copy(entry.message.text,notify)}>复制消息</button></header>
     {entry.message.role==="user"?<p className="agent-chat-user-text">{entry.message.text}</p>:<MessageBody text={entry.message.text} notify={notify}/>}
     {entry.message.context_refs&&<AgentContextList references={entry.message.context_refs}/>}
     {entry.message.delivery==="unknown"&&<p className="agent-chat-delivery" role="status">投递结果待核对，请先核对原线程。</p>}
     {entry.message.delivery==="rejected"&&<p className="agent-chat-delivery" role="alert">{entry.message.error||"消息未被受理，草稿已保留。"}</p>}
    </article>}</div>)}
    {(snapshot.requests??(snapshot.pending_request?[snapshot.pending_request]:[])).map(request=><CodexRequest key={request.generation+":"+request.id} request={request} busy={busy||["failed","disconnected","stopped","uncertain"].includes(snapshot.state)} notify={notify} onAnswer={result=>onAnswer(request,result)}/>)}
    {running&&<p className="agent-chat-progress" role="status">{snapshot.requests?.length?"等待答复":"正在处理…"}</p>}
    {settings.show_changes&&<CodexResults snapshot={snapshot} inline/>}
   </div>
  </div>
  {newMessages&&<button className="agent-chat-latest" onClick={latest}>{settings.mark_new_messages?"有新记录，回到最新":"回到最新"}</button>}
  <div className="agent-chat-input"><AgentContextList references={snapshot.context_refs??[]} disabled={busy} onRemove={onRemove}/>{error&&<p className="agent-chat-send-error" role="alert">{error}</p>}<div className="codex-composer">
   <textarea ref={input} aria-label="发送给 Agent" placeholder="描述创作目标" value={draft} onChange={event=>onDraft(event.target.value)} onBlur={()=>void onSave().catch(error=>notify(error.message))} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(shouldSendKey({...event,isComposing:event.nativeEvent.isComposing||composing.current},settings.enter_sends)){event.preventDefault();void send();}}}/>
   {snapshot.work_ref&&<details className="popover-menu agent-chat-attach"><summary aria-label="附加上下文" title="附加上下文"><Icon name="attachment"/></summary><div className="menu-panel">{[["work.profile","作品资料"],["work.canon","人物与设定"],...(snapshot.work_ref.kind==="novel"?[["novel.outlines","正式大纲"]]:snapshot.work_ref.kind==="drama"?[["drama.scenes","剧本场次"]]:[["video.sources","视频分集与成果"]]),["work.tasks","参考稿与公开意见"],["plugin.results","专业成果"]].map(([page,label])=><button key={page} disabled={busy} onClick={event=>{event.currentTarget.closest("details")!.open=false;onAttach(page);}}>{label}</button>)}</div></details>}
   <button className="primary" disabled={busy||blocked||!draft.trim()} onClick={()=>void send()}>发送</button>
  </div></div>
 </div>;
}
