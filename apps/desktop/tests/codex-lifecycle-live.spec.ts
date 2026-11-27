import {test,expect,_electron as electron} from "@playwright/test";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {navigate, workspaceAction} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../.."),output=path.join(root,"output/codex-creation-validation");
const receipts=(snapshot:any)=>snapshot.tools.flatMap((tool:any)=>{try{return [JSON.parse(tool.output).structuredContent].filter(Boolean);}catch{return [];}});
const success=(snapshot:any,action:string)=>receipts(snapshot).filter((value:any)=>value.action===action&&value.status==="succeeded").at(-1)?.data;

// 接续真实建书记录，不因重跑测试重复建立作品或任务。
test("真实TUI接续原作品的反馈、返工、比较、确切采纳与固定交付",async()=>{
 test.skip(process.env.HETU_LIVE_CODEX!=="1","需明确启用真实本机Codex验收");test.setTimeout(900000);
 const source=JSON.parse(await readFile(path.join(output,"private-result.json"),"utf8"));
 const created=success(source.snapshot,"hetu.creation_projects.create_novel"),submitted=success(source.snapshot,"hetu.creative_tasks.submit_result");
 expect(created).toBeTruthy();expect(submitted).toBeTruthy();
 let task=submitted.task_ref;
 const work={workspace_id:created.created_workspace_ref.workspace_id,kind:"novel",object_id:created.created_workspace_ref.novel_id};
 const documentId=success(source.snapshot,"hetu.documents.create").document.document_id;
 const progressPath=path.join(output,"private-lifecycle.json");
 let progress:any={};try{progress=JSON.parse(await readFile(progressPath,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const save=()=>writeFile(progressPath,JSON.stringify(progress,null,2),{mode:0o600});
 const app=await electron.launch({args:[path.join(root,"apps/desktop")],env:{...process.env,HETU_DESKTOP_PROFILE:source.profile,HETU_COLLABORATION_DIR:source.collaboration,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}});
 try{
  await app.evaluate(({dialog})=>{dialog.showMessageBoxSync=()=>1;dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
  await page.getByRole("button",{name:"打开作品 TUI全流程验收",exact:true}).click();
  await expect(page.getByRole("complementary",{name:"项目导航",exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.hetuDesktop.state()).then(value=>value.work)).toEqual(work);
  const directory=await page.evaluate(()=>window.hetuDesktop.tasks("list"));
  task=directory.data.tasks.find((item:any)=>item.task_ref.task_id===task.task_id).task_ref;
  const read=(action:string,input:any)=>page.evaluate(({action,input})=>window.hetuDesktop.read(action,input),{action,input});
  const view=()=>page.evaluate(task=>window.hetuDesktop.tasks("call",task,{name:"hetu_open_task_view",arguments:{task_ref:task}}),task).then(result=>result.structuredContent.data);
  const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get"));
  const before=await read("hetu.documents.get",{document_id:documentId});
  await navigate(page,"参考稿审核");await page.getByRole("combobox",{name:"当前审阅任务"}).selectOption(task.task_id);
  let frame=page.frameLocator('iframe[title="任务候选审阅"]');
  await expect(frame.getByLabel("补充要求或意见",{exact:true})).toBeVisible();
  if(!progress.prompt){
   await frame.getByLabel("补充要求或意见",{exact:true}).fill("保留灯塔与明天的来信，加入‘钟声三下’，保持约三十字。只返工原参考稿，不修改作者正文。");
   await frame.getByRole("button",{name:"按此修改",exact:true}).click();
   const prompt=frame.getByLabel("继续提示词",{exact:true});await expect(prompt).toHaveValue(/feedback_/);
   progress.prompt=await prompt.inputValue();progress.original_submission=submitted.submission_ref;await save();
   await expect(frame.getByRole("button",{name:"发送给当前 Agent",exact:true})).toHaveCount(0);
   await frame.getByRole("button",{name:"放入当前草稿",exact:true}).click();
   await expect(page.getByRole("region",{name:"独立 Agent 会话",exact:true})).toBeVisible({timeout:45000});
  }
  async function request(text:string,alreadyDrafted=false){
   if(!alreadyDrafted)await page.evaluate(async({text,work})=>{await window.hetuDesktop.agentSession("insert",{text,work_ref:work});window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref:work}}));},{text,work});
   const snapshot=await get();
   if(alreadyDrafted)await page.evaluate(async({text,snapshot})=>window.hetuDesktop.agentSession("terminal_input",{session_id:snapshot.session_id,generation:snapshot.generation,data:"\u001b[200~\n"+text+"\u001b[201~"}),{text,snapshot});
   const count=snapshot.messages.filter((m:any)=>m.role==="user").length;
   await page.locator(".xterm-helper-textarea").focus();await page.keyboard.press("Enter");
   await expect.poll(async()=>(await get()).messages.filter((m:any)=>m.role==="user").length,{timeout:30000}).toBeGreaterThan(count);
   await expect.poll(async()=>{const s=await get();return s.state==="ready"&&s.messages.some((m:any)=>m.role==="assistant"&&m.turn_id===s.messages.filter((m:any)=>m.role==="user").at(-1).turn_id);},{timeout:480000,intervals:[1000,2000,5000]}).toBe(true);
   return get();
  }
  if(!progress.revised){
   const alreadyDrafted=(await get()).draft===progress.prompt;
   const instructions="本次为隔离验收。直接读取这条公开意见，沿原working_copy保存返工稿并提交新的固定成果，保存和提交都引用实际feedback_refs，保留旧提交。不运行Shell、不付费、不采纳或定稿，不重建任务。写动作使用tui-lifecycle-revise前缀固定键，未知结果查原键；完成后回读任务和候选。";
   progress.revised=await request(alreadyDrafted?instructions:progress.prompt+"\n"+instructions,alreadyDrafted);await save();
  }
  const revised=await view();
  expect(revised.submission.submission_id).not.toBe(submitted.submission_ref.submission_id);
  expect(revised.submission.feedback_refs.length).toBeGreaterThan(0);
  const original=await page.evaluate(({task,id})=>window.hetuDesktop.tasks("call",task,{name:"hetu_open_task_view",arguments:{task_ref:task,submission_id:id}}),{task,id:submitted.submission_ref.submission_id});
  expect(original.structuredContent.data.submission.candidates).toMatchObject(submitted.submission.candidates);
  for(const candidate of original.structuredContent.data.submission.candidates)expect(createHash("sha256").update(candidate.content).digest("hex")).toBe(candidate.sha256);
  expect((await read("hetu.documents.get",{document_id:documentId})).data.content).toBe(before.data.content);
  const panel=page.getByRole("region",{name:"独立 Agent 会话",exact:true});
  if(await panel.isVisible())await workspaceAction(page,"关闭终端面板");
  await page.getByRole("button",{name:"刷新任务目录",exact:true}).click();
  await page.getByRole("combobox",{name:"当前审阅任务"}).selectOption(task.task_id);
  frame=page.frameLocator('iframe[title="任务候选审阅"]');
  await frame.getByRole("button",{name:"读取最新结果",exact:true}).click();
  await expect(frame.locator("body")).toContainText("钟声三下");
  if(!progress.adopted){
   await page.getByText("采纳到作者正文",{exact:true}).click();
   await page.getByRole("combobox",{name:"采纳参考方案",exact:true}).selectOption(revised.submission.candidates[0].candidate_id);
   await page.getByRole("button",{name:"预览采纳变化",exact:true}).click();
   const preview=page.getByRole("region",{name:"作者决定预览",exact:true});
   await expect(preview).toContainText("钟声三下");
   await expect(preview).toContainText("明天的来信");
   expect((await read("hetu.documents.get",{document_id:documentId})).data.content).toBe("");
   await preview.screenshot({path:path.join(output,"tui-revision-adoption.png")});
   await page.getByRole("button",{name:"确认此预览",exact:true}).click();
   await expect(page.locator(".notice[role=status]")).toContainText("尚未定稿");
   progress.adopted=(await read("hetu.documents.get",{document_id:documentId})).data;await save();
  }
  expect(progress.adopted.content).toContain("钟声三下");
  const revision=progress.adopted.revision;
  if(!progress.exported){
   const fixed={document_id:documentId,revision_id:revision.revision_id,sha256:revision.sha256};
   const prompt="继续当前隔离作品的固定交付。作者已审阅并采纳本次正文，尚未定稿；不要定稿或改写。为确切文稿修订"+JSON.stringify(fixed)+"准备review_delivery审阅包，reading_formats仅txt。先发现实际Schema，获取当前作品设定固定引用，使用bundles.preview固定选集，再按Core当前auto模式准备并执行bundles.export，最后bundles.verify核验实际包并回读。使用tui-lifecycle-delivery前缀固定operation_key，未知结果查原键，不调用Shell、不付费、不导出其他作品。";
   progress.exported=await request(prompt);await save();
  }
  const exported=success(progress.exported,"hetu.bundles.export")??receipts(progress.exported).filter((item:any)=>item.action==="hetu.agent_operations.execute"&&item.status==="succeeded").at(-1)?.data.result;
  expect(exported?.bundle_id,JSON.stringify(progress.exported.messages.map((m:any)=>m.text))).toBeTruthy();
  expect(success(progress.exported,"hetu.bundles.verify")?.verified).toBe(true);
  const bytes=await readFile(path.join(created.target_path,exported.path));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(exported.sha256);
  const lifecycle=(await read("hetu.documents.lifecycle",{document_id:documentId})).data;
  expect(lifecycle.adoptions).toHaveLength(1);expect(lifecycle.finalizations??[]).toHaveLength(0);
  expect((await read("hetu.documents.get",{document_id:documentId})).data.revision).toEqual(revision);
  await mkdir(path.join(root,"docs/research/evidence"),{recursive:true});
  await writeFile(path.join(root,"docs/research/evidence/codex-tui-lifecycle-2026-11-23.json"),JSON.stringify({date:"2026-11-23",engine:"Codex 0.171.0",surface:"embedded TUI",work_ref:work,task_id:task.task_id,original_submission:submitted.submission_ref,revised_submission:revised.submission.submission_id,feedback_refs:revised.submission.feedback_refs,document_revision:fixedRevision(progress.adopted),adoptions:lifecycle.adoptions.length,finalizations:0,export:{bundle_id:exported.bundle_id,sha256:exported.sha256,verified:true},checks:["original-work-and-task-reused","feedback-via-real-review-UI","draft-without-auto-enter","real-agent-working-copy-revision","old-submission-preserved","author-preview-before-adoption","exact-revision-export-verified"],limits:["isolated-short-text","macOS-development-build","not-author-creative-acceptance"]},null,2)+"\n");
  delete progress.failure;await save();
 }catch(error){const page=app.windows()[0];progress.failure=String(error);await save();if(page)await page.screenshot({path:path.join(output,"lifecycle-failure.png")}).catch(()=>{});throw error;}finally{await app.close();}
});
function fixedRevision(value:any){return {document_id:value.document.document_id,revision_id:value.revision.revision_id,sha256:value.revision.sha256};}
