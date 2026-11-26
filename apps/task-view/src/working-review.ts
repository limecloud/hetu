import {readWorkingCopyReview} from "@hetu/workbench-ui";
import {sameTask,type TaskRef} from "./task-reference.ts";
import type {FeedbackTarget} from "./feedback-target.ts";
import type {ReferenceText} from "./reference-reading.ts";

type WorkingRef={working_copy_id:string;working_revision_id:string;sha256:string};
export type WorkingCopy={working_copy_id:string;title:string;artifact_kind:string;source_format:string;task_ref:TaskRef;current_revision_ref:WorkingRef};
type Summary={working_copy:WorkingCopy;working_copy_ref:WorkingRef;current_revision_ref:WorkingRef;revision:{size_bytes:number};history:{working_copy_ref:WorkingRef}[]};
type Options={call:(name:string,input:Record<string,unknown>)=>Promise<any>;changed:()=>void;available:()=>boolean;language:()=>string;feedback:(target:FeedbackTarget,title:string)=>void;text:(card:HTMLElement,text:ReferenceText)=>void;readText:(text:ReferenceText)=>Promise<void>};
const sameRef=(a:WorkingRef,b:WorkingRef)=>a?.working_copy_id===b?.working_copy_id&&a?.working_revision_id===b?.working_revision_id&&a?.sha256===b?.sha256;

/** 目录和历史只作面板投影，正文及意见仍沿 Core 的固定引用。 */
export class WorkingCopyReview {
 private task?:TaskRef;
 private copies:WorkingCopy[]=[];
 private directoryVersion="";
 private cursor?:string;
 private selected?:string;
 private summary?:Summary;
 private revision?:WorkingRef;
 private error="";
 private retry?:()=>Promise<void>;
 private loading=false;
 private generation=0;
 private controller?:AbortController;
 constructor(private options:Options){}
 update(task:TaskRef,copies:WorkingCopy[],cursor?:string|null){
  if(this.task&&!sameTask(this.task,task))this.close();
  const version=JSON.stringify([copies,cursor??null]);
  this.task=task;if(version!==this.directoryVersion){
   const fixed=this.summary?.working_copy;
   this.copies=fixed&&fixed.working_copy_id===this.selected&&!copies.some(copy=>copy.working_copy_id===this.selected)?[...copies,fixed]:copies;
   this.cursor=cursor??undefined;this.directoryVersion=version;
  }
  if(!this.copies.some(copy=>copy.working_copy_id===this.selected))this.selected=copies[0]?.working_copy_id;
 }
 close(){this.generation++;this.controller?.abort();this.loading=false;this.task=undefined;this.copies=[];this.directoryVersion="";this.summary=undefined;this.revision=undefined;this.selected=undefined;this.cursor=undefined;this.error="";this.retry=undefined;}
 get busy(){return this.loading;}
 get count(){return this.copies.length;}
 private async run(read:()=>Promise<void>){
  if(!this.task||!this.options.available()||this.loading)return;
  const generation=this.generation;
  this.error="";this.retry=undefined;this.loading=true;this.options.changed();
  try{await read();}catch(error){if(this.task&&generation===this.generation){this.error=error instanceof Error?error.message:String(error);this.retry=()=>this.run(read);}}
  finally{if(generation===this.generation){this.loading=false;if(this.task)this.options.changed();}}
 }
 private more(){
  const task=this.task!,cursor=this.cursor,generation=this.generation;
  return this.run(async()=>{
   const result=await this.options.call("hetu_list_working_copies",{task_ref:task,cursor,limit:20});
   if(generation!==this.generation||!this.task||!sameTask(task,this.task))return;
   if(!Array.isArray(result.working_copies)||result.working_copies.some((copy:WorkingCopy)=>!sameTask(copy.task_ref,task)))throw Error("工作稿目录与当前任务不一致。");
   const known=new Set(this.copies.map(copy=>copy.working_copy_id));
   this.copies=[...this.copies,...result.working_copies.filter((copy:WorkingCopy)=>!known.has(copy.working_copy_id))];this.cursor=result.next_cursor??undefined;
  });
 }
 private async load(){
  const task=this.task!,copy=this.copies.find(copy=>copy.working_copy_id===this.selected);if(!copy)return;
  const generation=++this.generation,controller=new AbortController();this.controller?.abort();this.controller=controller;
  await this.run(async()=>{
   let value:Summary|undefined;
   try{
    const result=await this.options.call("hetu_read_working_copy",{task_ref:task,working_copy_ref:copy.current_revision_ref,detail:"summary"});
    controller.signal.throwIfAborted();if(result?.response?.complete!==false)value=result;
   }catch(error){if((error as {code?:string}).code!=="hetu.budget_exceeded")throw error;}
   value??=await readWorkingCopyReview(async input=>{
    const result=await this.options.call("hetu_read_working_copy",{task_ref:task,working_copy_ref:copy.current_revision_ref,...input});
    controller.signal.throwIfAborted();return result;
   },controller.signal) as unknown as Summary;
   if(generation!==this.generation||!this.task||!sameTask(task,this.task))return;
   if(!value.working_copy||!sameTask(value.working_copy.task_ref,task)||!sameRef(value.working_copy_ref,copy.current_revision_ref)||!value.history?.some(item=>sameRef(item.working_copy_ref,copy.current_revision_ref)))throw Error("工作稿与所选固定修订不一致。");
   this.summary=value;this.revision=value.working_copy_ref;
  });
  if(generation===this.generation&&this.summary?.working_copy.working_copy_id===copy.working_copy_id&&!this.error)await this.options.readText(this.reference());
 }
 private reference():ReferenceText{
  const task=this.task!,summary=this.summary!,ref=this.revision!,target:FeedbackTarget={kind:"working_copy",working_copy_ref:ref};
  return {key:`working:${JSON.stringify([task,ref])}`,title:summary.working_copy.title,kind:summary.working_copy.artifact_kind,target,
   expected:{context_ref:{context_id:ref.working_revision_id,sha256:ref.sha256},fixed_ref:ref,sha256:ref.sha256},
   read:async range=>{
    const result=await this.options.call("hetu_read_working_copy",{task_ref:task,working_copy_ref:ref,detail:"page",...(range?{range}:{}),max_bytes:16384});
    if(!sameTask(result.task_ref,task)||!sameRef(result.working_copy_ref,ref))throw Error("工作稿与所选固定修订不一致。");
    return result.content_page;
   }};
 }
 render(unsubmitted:boolean,feedbackAvailable=true){
  const en=this.options.language()==="en",el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const label=(zh:string,english:string)=>en?english:zh,section=el("section");section.className="detail working-review";section.setAttribute("aria-label",label("工作稿","Working copies"));
  section.setAttribute("aria-busy",String(this.loading));section.append(el("h2",label("工作稿","Working copies")));
  const button=(text:string,action:()=>void|Promise<void>)=>{const node=el("button",text);node.type="button";node.disabled=this.loading||!this.options.available();node.addEventListener("click",()=>void action());return node;};
  const row=el("div");row.className="source-text-actions";
  const selector=el("select");selector.setAttribute("aria-label",label("选择工作稿","Choose working copy"));selector.disabled=this.loading||!this.options.available();
  for(const copy of this.copies){const option=el("option",copy.title);option.value=copy.working_copy_id;selector.append(option);}
  selector.value=this.selected??"";selector.addEventListener("change",()=>{this.generation++;this.controller?.abort();this.selected=selector.value;this.summary=undefined;this.revision=undefined;this.error="";this.retry=undefined;this.options.changed();});
  row.append(selector,button(label("读取工作稿","Read working copy"),()=>this.load()));
  if(this.cursor)row.append(button(label("更多工作稿","More working copies"),()=>this.more()));section.append(row);
  if(this.loading){const note=el("p",label("正在读取工作稿…","Loading working copy…"));note.setAttribute("role","status");section.append(note);}
  if(this.error){const note=el("p",this.error);note.className="source-read-error";note.setAttribute("role","alert");section.append(note);if(this.retry)section.append(button(label("重试读取工作稿","Retry working copy"),this.retry));}
  if(this.summary&&this.revision){
   const controls=el("div");controls.className="source-text-actions";
   controls.append(el("span",unsubmitted?label("尚未提交","Not submitted"):label("已保存工作稿","Saved working copy")));
   const versions=el("select");versions.setAttribute("aria-label",label("工作稿修订","Working copy revision"));versions.disabled=this.loading||!this.options.available();
   for(const [index,item] of this.summary.history.entries()){const option=el("option",label(`第${this.summary.history.length-index}版`,`Revision ${this.summary.history.length-index}`));option.value=item.working_copy_ref.working_revision_id;versions.append(option);}
   versions.value=this.revision.working_revision_id;versions.addEventListener("change",()=>{this.revision=this.summary!.history.find(item=>item.working_copy_ref.working_revision_id===versions.value)!.working_copy_ref;this.options.changed();});
   const feedback=button(label("对整份工作稿提意见","Comment on whole working copy"),()=>this.options.feedback(this.reference().target,this.summary!.working_copy.title));feedback.disabled||=!feedbackAvailable;
   controls.append(versions,feedback);section.append(controls);
   this.options.text(section,this.reference());
  }
  return section;
 }
}
