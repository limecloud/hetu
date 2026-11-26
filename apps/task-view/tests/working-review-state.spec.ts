import {test,expect} from "@playwright/test";
import {build} from "esbuild";

for(const result of ["success","failure"])test(`关闭并切换任务后，迟到的工作稿${result}不能复活旧阅读`,async({page})=>{
 const script=await build({entryPoints:["src/working-review.ts"],bundle:true,write:false,format:"iife",globalName:"workingReview",target:"es2022"});
 await page.setContent('<main id="root"></main>');await page.addScriptTag({content:script.outputFiles[0].text});
 await page.evaluate(()=>{
  const state:any=(window as any).__working={changes:0,reads:0,calls:0};
  const task={scope_ref:{kind:"workspace",id:"workspace"},task_id:"task_first",request_revision:1},ref={working_copy_id:"copy_first",working_revision_id:"revision_first",sha256:"a".repeat(64)};
  state.task=task;state.copy={working_copy_id:ref.working_copy_id,title:"原任务工作稿",artifact_kind:"text",source_format:"markdown",task_ref:task,current_revision_ref:ref};
  state.review=new (window as any).workingReview.WorkingCopyReview({
   call:()=>{state.calls++;return new Promise((resolve,reject)=>{state.resolve=resolve;state.reject=reject;});},available:()=>true,language:()=>"zh-CN",feedback:()=>{},text:()=>{},readText:async()=>{state.reads++;},
   changed:()=>{state.changes++;document.getElementById("root")!.replaceChildren(state.review.render(true));},
  });state.review.update(task,[state.copy]);document.getElementById("root")!.append(state.review.render(true));
 });
 await page.getByRole("button",{name:"读取工作稿",exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__working.calls)).toBe(1);
 const initial=await page.evaluate(()=>{const state=(window as any).__working;state.review.close();state.review.update({...state.task,task_id:"task_second"},[{...state.copy,title:"新任务工作稿",task_ref:{...state.task,task_id:"task_second"}}]);document.getElementById("root")!.replaceChildren(state.review.render(true));return state.changes;});
 await page.evaluate(value=>{const state=(window as any).__working;
  if(value==="failure")state.reject(Error("原任务迟到错误"));
  else{const ref=state.copy.current_revision_ref;state.resolve({working_copy:state.copy,working_copy_ref:ref,current_revision_ref:ref,revision:{size_bytes:20},history:[{working_copy_ref:ref}]});}
 },result);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 expect(await page.evaluate(()=>{const state=(window as any).__working;return {changes:state.changes,reads:state.reads,busy:state.review.busy};})).toEqual({changes:initial,reads:0,busy:false});
 await expect(page.getByRole("combobox",{name:"选择工作稿"})).toContainText("新任务工作稿");await expect(page.getByRole("alert")).toHaveCount(0);await expect(page.getByRole("combobox",{name:"工作稿修订"})).toHaveCount(0);
});

for(const large of [false,true])test(`工作稿元数据${large?"超预算才展开":"小结果直接读取"}，不重复传输正文`,async({page})=>{
 const script=await build({entryPoints:["src/working-review.ts"],bundle:true,write:false,format:"iife",globalName:"workingReview",target:"es2022"});
 await page.setContent('<main id="root"></main>');await page.addScriptTag({content:script.outputFiles[0].text});
 await page.evaluate(large=>{
  const task={scope_ref:{kind:"workspace",id:"workspace"},task_id:"task",request_revision:1},ref={working_copy_id:"copy",working_revision_id:"revision",sha256:"a".repeat(64)},copy={working_copy_id:ref.working_copy_id,title:"雾港工作稿",artifact_kind:"text",source_format:"markdown",task_ref:task,current_revision_ref:ref};
  const summary={working_copy:copy,working_copy_ref:ref,current_revision_ref:ref,revision:{size_bytes:20},history:[{working_copy_ref:ref}]},state:any=(window as any).__working={calls:[],reads:0};
  state.review=new (window as any).workingReview.WorkingCopyReview({available:()=>true,language:()=>"zh-CN",feedback:()=>{},text:()=>{},readText:async()=>{state.reads++;},
   call:async(_name:string,input:any)=>{state.calls.push(input);if(!large)return summary;if(input.result_path===undefined)throw Object.assign(Error("元数据超过传输预算"),{code:"hetu.budget_exceeded"});return {working_page:{result_path:"",summary:{kind:"object",size_bytes:JSON.stringify(summary).length},value:summary},working_page_sha256:"b".repeat(64)};},
   changed:()=>document.getElementById("root")!.replaceChildren(state.review.render(true)),
  });state.review.update(task,[copy]);document.getElementById("root")!.append(state.review.render(true));
 },large);
 await page.getByRole("button",{name:"读取工作稿",exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__working.reads)).toBe(1);
 const calls=await page.evaluate(()=>(window as any).__working.calls);expect(calls).toHaveLength(large?2:1);expect(calls[0].detail).toBe("summary");expect(calls[0].result_path).toBeUndefined();if(large)expect(calls[1].result_path).toBe("");
 await expect(page.getByRole("combobox",{name:"工作稿修订",exact:true})).toBeVisible();await expect(page.getByRole("alert")).toHaveCount(0);
});
