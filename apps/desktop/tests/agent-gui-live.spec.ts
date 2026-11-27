import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,readFile,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {navigate, workspaceAction} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../.."),output=path.join(root,"output/gui-lifecycle-20261125");
const receipts=(snapshot:any)=>(snapshot?.tools??[]).flatMap((tool:any)=>{try{const receipt=JSON.parse(tool.output).structuredContent;return receipt?[receipt]:[];}catch{return [];}});
const successful=(snapshot:any,action:string)=>receipts(snapshot).filter((value:any)=>value.action===action&&value.status==="succeeded").at(-1)?.data;

test("真实GUI按固定章节只读，再保存参考稿并核对Core成果",async()=>{
 test.skip(process.env.HETU_LIVE_GUI!=="1","仅在明确启用真实内嵌GUI业务时运行");test.setTimeout(900000);
 await mkdir(output,{recursive:true});const journal=path.join(output,"private-state.json");
 let state:any;try{state=JSON.parse(await readFile(journal,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const save=()=>writeFile(journal,JSON.stringify(state,null,2)+"\n",{mode:0o600});
 if(!state){
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-gui-live-")),profile=path.join(folder,"profile"),workspace=path.join(folder,"作品"),collaboration=path.join(folder,"collaboration");
  const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);
  const context=JSON.parse(fixture.stdout);await mkdir(profile,{recursive:true});await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:context.novel.workspace_id,works:[{work_ref:context.novel,title:"GUI业务验证"}]}]}));
  state={folder,profile,workspace,collaboration,work:context.novel};await save();
 }
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[path.join(root,"apps/desktop")],env:{...env,HETU_DESKTOP_PROFILE:state.profile,HETU_COLLABORATION_DIR:state.collaboration,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}});
 let page:any;
 try{
  page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();
  await expect.poll(()=>page.evaluate(async()=>(await window.hetuDesktop.state()).work)).toEqual(state.work);
  const read=async(action:string,input:any={})=>{const result=await page.evaluate(({action,input}:any)=>window.hetuDesktop.read(action,input),{action,input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
  const documents=await read("hetu.documents.list",{work_ref:state.work}),document=documents.documents[0];expect(document).toBeTruthy();
  const baseline=await read("hetu.documents.get",{document_id:document.document_id,...(state.baseline?{revision_id:state.baseline.revision.revision_id}:{})});
  if(!state.baseline){state.baseline={document_id:document.document_id,revision:baseline.revision,content:baseline.content};await save();}
  expect(baseline.revision.sha256).toBe(state.baseline.revision.sha256);
  const listTasks=()=>page.evaluate(()=>window.hetuDesktop.tasks("list")).then((value:any)=>{expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data.tasks;});
  const taskCount=(await listTasks()).length;
  await page.evaluate(async()=>{const state=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:state.revision,patch:{agent_session:{default_surface:"gui"}}});});
  await navigate(page,"Agent 协作");const launch=page.getByRole("dialog",{name:"创建会话",exact:true});
  await expect.poll(async()=>await launch.isVisible()||await page.locator(".agent-chat").isVisible(),{timeout:30000}).toBe(true);
  if(await launch.isVisible()){await launch.getByRole("button",{name:/^引擎(?: |$)/}).click();await launch.getByRole("button",{name:"打开聊天",exact:true}).click();}
  const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get"));
  await expect(page.locator(".agent-chat")).toBeVisible({timeout:45000});await expect.poll(async()=>(await get()).state,{timeout:45000}).toBe("ready");
  async function request(text:string){
   const before=await get();if(before.state!=="ready")throw Error("原轮次尚未核对完成，未重发请求。");
   const input=page.getByRole("textbox",{name:"发送给 Agent",exact:true});await input.fill(text);await page.getByRole("button",{name:"发送",exact:true}).click();
   await expect.poll(async()=>(await get()).messages.filter((item:any)=>item.role==="user").length,{timeout:30000}).toBeGreaterThan(before.messages.filter((item:any)=>item.role==="user").length);
   await expect.poll(async()=>{const value=await get(),last=value.messages.filter((item:any)=>item.role==="user").at(-1);return value.state==="ready"&&value.messages.some((item:any)=>item.role==="assistant"&&item.turn_id===last.turn_id);},{timeout:480000,intervals:[1000,2000,5000]}).toBe(true);
   return get();
  }
  if(!state.readonly){
   const snapshot=await get();await page.evaluate(async({work,document,snapshot}:any)=>window.hetuDesktop.agentSession("attach_context",{work_ref:work,session_id:snapshot.session_id,generation:snapshot.generation,page:"novel.reader",object:{document_id:document.document_id,revision_id:document.current_revision_id},label:document.title}),{work:state.work,document,snapshot});
   state.readonly=await request("这是隔离GUI只读验收。请只通过当前河图MCP发现并读取所附固定章节，概括一句情节并给出真实document_id、revision_id和sha256。不调用Shell、不写文件、不建立任务、参考稿、计划或任何作品内容。按需发现准确Schema，完成读取后停止，不要求用户确认。");await save();
   expect(await listTasks()).toHaveLength(taskCount);
   expect((await read("hetu.documents.get",{document_id:document.document_id})).revision.sha256).toBe(state.baseline.revision.sha256);
   expect(receipts(state.readonly).some((item:any)=>item.action==="hetu.documents.get"&&item.status==="succeeded")).toBe(true);
  }
  if(!successful(state.submitted,"hetu.creative_tasks.submit_result")){
   if(state.submitted){state.attempts=[...(state.attempts??[]),state.submitted];await save();}
   state.submitted=await request("现在进行已授权的隔离GUI参考稿业务验收。仅处理当前作品中document_id="+document.document_id+"、revision_id="+state.baseline.revision.revision_id+"的章节。先发现当前实际Schema并查找是否已有本次brief为‘GUI固定来源参考稿验收’的任务，有就接续。没有时用creative_tasks.preview_prompt返回的prepare_input准备chapter_draft任务，input_refs使用准确固定原文引用，client_adapter=codex，brief=GUI固定来源参考稿验收；沿实际任务引用打开。使用working_copies保存约30至50字的参考稿，保留灯塔和信，加入‘潮声三下’，然后用真实working_copy_refs提交一个固定候选并回读任务。不要直接修改作者正文，不采纳、不定稿，不调用Shell、不生成图片、不付费。写入使用gui-lifecycle-20261125前缀固定operation_key，未知只查询原操作，沿同一任务完成，不新建重复任务。输出公开task_ref、working_copy_ref、submission_ref及真实内容摘要。请实际执行并回读，不停留在计划。无法执行时准确报告失败。");await save();
  }
  const submitted=successful(state.submitted,"hetu.creative_tasks.submit_result");expect(submitted,JSON.stringify(state.submitted.messages.map((item:any)=>item.text))).toBeTruthy();
  expect(submitted.submission_ref?.sha256).toBeTruthy();state.task_ref=submitted.task_ref;state.submission_ref=submitted.submission_ref;await save();
  if(!state.lifecycle?.adopted)expect((await read("hetu.documents.get",{document_id:document.document_id})).revision.sha256).toBe(state.baseline.revision.sha256);
  const verified=await page.evaluate(()=>window.hetuDesktop.agentSession("results"));const fixed=verified.items.find((item:any)=>item.kind==="submission");expect(fixed?.state,JSON.stringify(verified)).toBe("verified");
  await expect(page.getByRole("region",{name:"作品变更",exact:true})).toContainText("已回读");await page.screenshot({path:path.join(output,"gui-live-reference.png")});
  state.verified_results=verified;state.thread_id=(await get()).thread_id;state.final_snapshot=await get();delete state.failure;await save();
  await writeFile(path.join(root,"docs/research/evidence/embedded-gui-business-2026-11-25.json"),JSON.stringify({date:"2026-11-25",surface:"embedded GUI",work_ref:state.work,thread_id:state.thread_id,readonly_task_count_unchanged:true,author_document_unchanged_before_adoption:true,task_ref:submitted.task_ref,submission_ref:submitted.submission_ref,core_verified_result:true,initial_stage_model_rounds:state.final_snapshot.messages.filter((item:any)=>item.role==="user").length,reference_sha256:createHash("sha256").update(JSON.stringify(submitted.submission_ref)).digest("hex"),limits:["isolated short Chinese reference","not full feedback-adoption-export lifecycle yet","macOS source build, not installed release","not creative quality approval"]},null,2)+"\n");
 }catch(error){state.failure=String(error);state.last_snapshot=await page?.evaluate(()=>window.hetuDesktop.agentSession("get")).catch(()=>undefined);await save();await page?.screenshot({path:path.join(output,"failure.png")}).catch(()=>{});throw error;}finally{await app.close();}
});

test("真实GUI沿原任务反馈返工、比较采纳并交付固定文稿",async()=>{
 test.skip(process.env.HETU_LIVE_GUI!=="1","仅在明确启用真实内嵌GUI业务时运行");test.setTimeout(1200000);
 const journal=path.join(output,"private-state.json"),state=JSON.parse(await readFile(journal,"utf8"));
 expect(state.task_ref).toBeTruthy();expect(state.verified_results).toBeTruthy();
 const progress=state.lifecycle??={};const save=()=>writeFile(journal,JSON.stringify(state,null,2)+"\n",{mode:0o600});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[path.join(root,"apps/desktop")],env:{...env,HETU_DESKTOP_PROFILE:state.profile,HETU_COLLABORATION_DIR:state.collaboration,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}});
 let page:any;
 try{
  page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect.poll(()=>page.evaluate(async()=>(await window.hetuDesktop.state()).work)).toEqual(state.work);
  const read=async(action:string,input:any={})=>{const result=await page.evaluate(({action,input}:any)=>window.hetuDesktop.read(action,input),{action,input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
  const directory=await page.evaluate(()=>window.hetuDesktop.tasks("list"));expect(directory.status).toBe("succeeded");const task=directory.data.tasks.find((item:any)=>item.task_ref.task_id===state.task_ref.task_id)?.task_ref;expect(task).toBeTruthy();
  const view=async(submission?:string)=>{const result=await page.evaluate(({task,submission}:any)=>window.hetuDesktop.tasks("call",task,{name:"hetu_open_task_view",arguments:{task_ref:task,...(submission?{submission_id:submission}:{})}}),{task,submission});expect(result.structuredContent.status,JSON.stringify(result)).toBe("succeeded");return result.structuredContent.data;};
  const before=await view();
  await navigate(page,"参考稿审核");await page.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(task.task_id);
  let frame=page.frameLocator('iframe[title="任务候选审阅"]');await expect(frame.getByLabel("补充要求或意见",{exact:true})).toBeVisible();
  if(!progress.feedback_prompt){
   await frame.getByLabel("补充要求或意见",{exact:true}).fill("保留灯塔和来信，将‘潮声三下’改为‘钟声三下’，保留其他叙述，只返工同一个参考稿。不要修改作者正文。");await frame.getByRole("button",{name:"按此修改",exact:true}).click();
   const prompt=frame.getByLabel("继续提示词",{exact:true});await expect(prompt).toHaveValue(/feedback_/);progress.feedback_prompt=await prompt.inputValue();progress.original_submission=state.submission_ref;await save();
   await frame.getByRole("button",{name:"放入当前草稿",exact:true}).click();await expect(page.locator(".agent-chat")).toBeVisible({timeout:45000});
  }else await navigate(page,"Agent 协作");
  const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get"));await expect.poll(async()=>(await get()).state,{timeout:45000}).toBe("ready");
  async function request(text:string){
   const before=await get();if(before.state!=="ready")throw Error("原轮次尚未核对完成，未重发请求。");
   await page.getByRole("textbox",{name:"发送给 Agent",exact:true}).fill(text);await page.getByRole("button",{name:"发送",exact:true}).click();
   await expect.poll(async()=>(await get()).messages.filter((item:any)=>item.role==="user").length,{timeout:30000}).toBeGreaterThan(before.messages.filter((item:any)=>item.role==="user").length);
   await expect.poll(async()=>{const value=await get(),last=value.messages.filter((item:any)=>item.role==="user").at(-1);return value.state==="ready"&&value.messages.some((item:any)=>item.role==="assistant"&&item.turn_id===last.turn_id);},{timeout:480000,intervals:[1000,2000,5000]}).toBe(true);return get();
  }
  if(!progress.revised){
   const snapshot=await get();expect(snapshot.messages.filter((item:any)=>item.role==="user")).toHaveLength(state.final_snapshot.messages.filter((item:any)=>item.role==="user").length);
   progress.revised=await request(progress.feedback_prompt+"\n本次隔离GUI验收已授权继续。只通过当前河图MCP读取公开反馈，沿原working_copy保存修改稿并引用实际feedback_refs提交新的固定成果，保留旧提交及未改叙述。不要新建任务、修改作者正文、采纳或定稿，不运行Shell、不付费。写入使用gui-lifecycle-revise-20261125前缀固定键，未知查询原键。完成后回读原任务、公开反馈和真实候选摘要。");await save();
  }
  const revised=await view();expect(revised.submission.submission_id).not.toBe(state.submission_ref.submission_id);expect(revised.submission.feedback_refs.length).toBeGreaterThan(0);expect(revised.submission.candidates[0].content).toContain("钟声三下");
  const original=await view(state.submission_ref.submission_id);expect(original.submission.submission_id).toBe(state.submission_ref.submission_id);expect(original.submission.candidates[0].content).toContain("潮声三下");
  // A click completes before the asynchronous commit. Recover its actual receipt before another decision.
  const current=await read("hetu.documents.get",{document_id:state.baseline.document_id});
  if(current.revision.revision_id!==state.baseline.revision.revision_id){
   const history=await read("hetu.documents.lifecycle",{document_id:state.baseline.document_id});
   expect(history.adoptions).toHaveLength(1);expect(history.finalizations??[]).toHaveLength(0);
   expect(history.adoptions[0].draft_ref).toEqual(revised.submission.candidates[0].draft_ref);
   expect(history.adoptions[0].document_ref.revision_id).toBe(current.revision.revision_id);
   expect(current.content).toBe(revised.submission.candidates[0].content);
   if(progress.adopted?.revision.revision_id!==current.revision.revision_id){
    if(progress.adopted)progress.adoption_observations=[...(progress.adoption_observations??[]),progress.adopted];
    progress.adopted=current;await save();
   }
  }else expect(progress.adopted).toBeFalsy();
  if(!progress.adopted){
   expect((await read("hetu.documents.get",{document_id:state.baseline.document_id})).revision.sha256).toBe(state.baseline.revision.sha256);
   await workspaceAction(page,"关闭终端面板");await page.getByRole("button",{name:"刷新任务目录",exact:true}).click();await page.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(task.task_id);frame=page.frameLocator('iframe[title="任务候选审阅"]');await frame.getByRole("button",{name:"读取最新结果",exact:true}).click();await expect(frame.locator("body")).toContainText("钟声三下");
   await page.getByText("采纳到作者正文",{exact:true}).click();await page.getByRole("combobox",{name:"采纳参考方案",exact:true}).selectOption(revised.submission.candidates[0].candidate_id);await page.getByRole("button",{name:"预览采纳变化",exact:true}).click();
   const preview=page.getByRole("region",{name:"作者决定预览",exact:true});await expect(preview).toContainText("钟声三下");expect((await read("hetu.documents.get",{document_id:state.baseline.document_id})).revision.sha256).toBe(state.baseline.revision.sha256);await page.screenshot({path:path.join(output,"gui-adoption-preview.png")});await page.getByRole("button",{name:"确认此预览",exact:true}).click();
   await expect(page.locator(".notice[role=status]")).toContainText("已采纳为新的作者修订",{timeout:30000});
   await expect.poll(async()=>(await read("hetu.documents.get",{document_id:state.baseline.document_id})).revision.sha256,{timeout:30000}).toBe(revised.submission.candidates[0].sha256);
   progress.adopted=await read("hetu.documents.get",{document_id:state.baseline.document_id});await save();
  }
  expect(progress.adopted.content).toContain("钟声三下");
  if(!progress.exported){
   if(!await page.locator(".agent-chat").isVisible())await page.getByRole("button",{name:"打开终端会话",exact:true}).click();await expect(page.locator(".agent-chat")).toBeVisible();
   const fixed={document_id:state.baseline.document_id,revision_id:progress.adopted.revision.revision_id,sha256:progress.adopted.revision.sha256};
   progress.exported=await request("仅为当前隔离作品的确切文稿修订"+JSON.stringify(fixed)+"准备review_delivery审阅交付包，reading_formats仅txt。作者已在实际预览确认采纳，但尚未定稿；不要定稿或改写。发现准确Schema并固定必要设定引用，用bundles.preview准备固定选集，按当前auto策略经公开机器能力导出bundles.export，再用bundles.verify核验真实文件并回读。不能运行Shell、付费、导出其他作品或更换修订；使用gui-lifecycle-delivery-20261125前缀固定operation_key，未知查询原操作。直接执行并给出真实包引用与摘要。");await save();
  }
  const exported=successful(progress.exported,"hetu.bundles.export")??receipts(progress.exported).filter((item:any)=>item.action==="hetu.agent_operations.execute"&&item.status==="succeeded").at(-1)?.data.result;
  expect(exported?.bundle_id,JSON.stringify(progress.exported.messages.map((item:any)=>item.text))).toBeTruthy();expect(successful(progress.exported,"hetu.bundles.verify")?.verified).toBe(true);
  expect(createHash("sha256").update(await readFile(path.join(state.workspace,exported.path))).digest("hex")).toBe(exported.sha256);
  const lifecycle=await read("hetu.documents.lifecycle",{document_id:state.baseline.document_id});expect(lifecycle.adoptions).toHaveLength(1);expect(lifecycle.finalizations??[]).toHaveLength(0);
  expect((await read("hetu.documents.get",{document_id:state.baseline.document_id})).revision).toEqual(progress.adopted.revision);
  await page.screenshot({path:path.join(output,"gui-fixed-delivery.png")});progress.verified={original_submission:state.submission_ref,revised_submission:revised.submission.submission_id,feedback_refs:revised.submission.feedback_refs,document_revision:progress.adopted.revision,adoptions:lifecycle.adoptions.length,finalizations:0,bundle_id:exported.bundle_id,bundle_sha256:exported.sha256,thread_id:(await get()).thread_id};delete progress.failure;await save();
  const evidencePath=path.join(root,"docs/research/evidence/embedded-gui-business-2026-11-25.json"),evidence=JSON.parse(await readFile(evidencePath,"utf8"));evidence.lifecycle=progress.verified;evidence.limits=evidence.limits.filter((item:string)=>!item.includes("not full feedback"));evidence.limits.push("isolated automation records an exact author QA decision; not the real author's creative approval");await writeFile(evidencePath,JSON.stringify(evidence,null,2)+"\n");
 }catch(error){progress.failure=String(error);progress.last_snapshot=await page?.evaluate(()=>window.hetuDesktop.agentSession("get")).catch(()=>undefined);await save();await page?.screenshot({path:path.join(output,"lifecycle-failure.png")}).catch(()=>{});throw error;}finally{await app.close();}
});
