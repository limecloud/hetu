import React,{useEffect,useRef,useState} from "react";
import {sameWork,type WorkRef} from "@hetu/plugin-sdk";
import {Icon,IconButton} from "@hetu/workbench-ui";
import type {SessionSnapshot} from "../agent-session-contract.ts";
import {desktop} from "./bridge.ts";
import {creativeRequest,type CreativeIntent} from "../creative-request.ts";

export type AgentWorkChoice={work_ref:WorkRef;title:string;unavailable?:boolean;archived?:boolean};
export const workChoiceKey=(work?:WorkRef)=>work?JSON.stringify([work.workspace_id,work.kind,work.object_id]):"library";
export function WorkChoice({work,works,disabled,onChange}:{work?:WorkRef;works:AgentWorkChoice[];disabled?:boolean;onChange(work?:WorkRef):void}){
  const choices=works.filter(item=>!item.archived&&(!item.unavailable||work&&sameWork(item.work_ref,work)));
  return <select className="agent-work-choice" aria-label="会话作品" value={workChoiceKey(work)} disabled={disabled} onChange={event=>onChange(choices.find(item=>workChoiceKey(item.work_ref)===event.target.value)?.work_ref)}>
    <option value="library">创作库</option>{choices.map(item=><option key={workChoiceKey(item.work_ref)} value={workChoiceKey(item.work_ref)} disabled={item.unavailable}>{item.title}</option>)}
  </select>;
}
type Task={label:string;page?:string;kind?:string;goal:string;intent?:CreativeIntent};
const tasks=(work?:WorkRef):Task[]=>!work?[
  {label:"讨论创作方向",intent:"discuss",goal:"先和我讨论一个故事想法，暂时不用建立作品。"},
  {label:"新建小说",kind:"novel",goal:"和我一起筹备一部新小说，先讨论目标；我决定保留时再建立作品。"},
  {label:"新建剧本",kind:"drama",goal:"和我一起筹备一部原创剧本，先讨论人物与冲突；我决定保留时再建立作品。"},
  {label:"新建视频",kind:"video",goal:"和我一起筹备一个叙事视频，先讨论内容与已有材料；需要持续制作时再建立项目。"},
]:[
  {label:"查阅作品",intent:"read",page:"work.profile",goal:"查找我需要的原文、设定或已有决定，附上引用；本次不修改作品。"},
  {label:"讨论创作方向",intent:"discuss",goal:"根据我提供的内容讨论下一步写法，先不要保存或改变作品。"},
  {label:"接续创作",page:"work.profile",goal:"先阅读当前作品及已有成果，和我讨论下一步创作安排。"},
  {label:"按意见返工",intent:"revise",page:"work.tasks",goal:"沿已有稿件和修改意见继续，先核对需要改动与保留的内容。"},
  ...(work.kind!=="video"?[{label:work.kind==="novel"?"整理卷章大纲":"整理分集大纲",page:"novel.outlines",goal:"阅读现有结构与文稿，整理大纲，保留当前内容与固定依据。"}]:[]),
  {label:"完善作品设定",page:"work.canon",goal:"核对现有设定与文稿，补充缺失和冲突，保留来源。"},
  {label:"整理资料",page:"work.resources",goal:"阅读已有资料，按当前创作目标整理可引用的依据。"},
  {label:work.kind==="video"?"推进分镜与视频":"准备图片",page:work.kind==="video"?"work.media":"work.images",goal:work.kind==="video"?"核对当前项目、分镜和媒体成果，按现有方法推进制作；费用与成片认可分别处理。":"根据当前作品和已有设定准备图片候选，保留来源与版本。"},
  {label:"准备交付",intent:"deliver",page:"work.delivery",goal:"核对当前作品的固定成果，按我的交付目标准备交付包，完成后验证真实文件。"},
];
/** 任务只固定上下文并递送意图，领域执行仍经过已有CLI/MCP。 */
export function AgentBusiness({snapshot,notify}:{snapshot:SessionSnapshot;notify(message:string):void}){
  const [task,setTask]=useState<Task>(),[goal,setGoal]=useState(""),[preserve,setPreserve]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const dialog=useRef<HTMLDialogElement>(null),current=useRef(snapshot);current.current=snapshot;
  const fixed=useRef(snapshot);
  useEffect(()=>{if(task)dialog.current?.showModal();},[task]);
  useEffect(()=>{setTask(undefined);setError("");},[snapshot.session_id]);
  const open=(value:Task)=>{fixed.current=current.current;setTask(value);setGoal(value.goal);setPreserve("");setError("");};
  async function prepare(){
    if(!task||busy)return;setBusy(true);setError("");
    const original=fixed.current,scope=original.work_ref?{work_ref:original.work_ref}:{scope:"library"};
    const check=()=>{if(current.current.session_id!==original.session_id||current.current.generation!==original.generation)throw Error("会话已变化，请重新选择创作任务。");};
    try{
      check();const request=task.intent==="discuss"?undefined:task.kind?await desktop.library("bootstrap",{kind:task.kind,delivery:"draft"}):await desktop.handoff(task.page!,{},"draft");check();
      if(task.intent!=="discuss"&&!request?.prompt)throw Error("未能准备当前作品的固定依据。");
      const text=creativeRequest({intent:task.intent??"develop",goal,preserve,work:original.work_ref,context:request?.prompt});
      await desktop.agentSession("insert",{...scope,session_id:original.session_id,generation:original.generation,text});check();
      setTask(undefined);notify(original.client==="codex"?"创作请求已放入当前会话，请核对后发送。":"创作请求已准备，请在终端就绪后放入。");
      requestAnimationFrame(()=>document.querySelector<HTMLTextAreaElement>(".agent-workspace:not([hidden]) .xterm-helper-textarea, .codex-composer textarea")?.focus());
    }catch(error){setError((error as Error).message);}finally{setBusy(false);}
  }
  return <>
    <details className="popover-menu"><summary aria-label="创作任务" title="创作任务"><Icon name="sparkles"/><span>创作任务</span></summary><div className="menu-panel">{tasks(snapshot.work_ref).map(item=><button key={item.label} disabled={snapshot.client==="shell"} onClick={event=>{event.currentTarget.closest("details")!.open=false;open(item);}}>{item.label}</button>)}</div></details>
    {task&&<dialog ref={dialog} className="agent-business-dialog" aria-label={task.label} onCancel={event=>{event.preventDefault();if(!busy)setTask(undefined);}}><form onSubmit={event=>{event.preventDefault();void prepare();}}>
      <header><h2>{task.label}</h2><IconButton icon="close" label="关闭创作任务" disabled={busy} onClick={()=>setTask(undefined)}/></header>
      <label>创作目标<textarea autoFocus aria-label="创作目标" value={goal} maxLength={6000} onChange={event=>setGoal(event.target.value)}/></label>
      {task.intent==="revise"&&<label>需要保留的内容 <span>可选</span><textarea className="agent-preserve" aria-label="需要保留的内容" value={preserve} maxLength={3000} onChange={event=>setPreserve(event.target.value)} placeholder="例如：第三章和昨天选定的对白保持不变"/></label>}
      {snapshot.client!=="codex"&&<p>请先完成终端中的登录或信任提示。</p>}
      {error&&<p role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={()=>setTask(undefined)}>取消</button><button className="primary" disabled={busy||!goal.trim()}>{busy?"正在准备…":snapshot.client!=="codex"?"准备请求":snapshot.surface==="gui"?"放入对话草稿":"放入终端"}</button></footer>
    </form></dialog>}
  </>;
}
