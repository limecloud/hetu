import {test,expect,_electron as electron,type ElectronApplication,type Page} from "@playwright/test";
import {mkdir,mkdtemp,readFile,writeFile,rename,access} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import path from "node:path";
import {navigate,closeApplication} from "./navigation.ts";
import {liveAgentRound} from "./fixtures/live-agent-round.ts";

const root=path.resolve(import.meta.dirname,"../../.."),output=path.join(root,"output/gui-creation-20261126");
const title="雾港明日来信",chapterTitle="第一章 雨夜来信",resourceTitle="雾港夜航资料";
const digest=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
function receipts(snapshot:any):any[]{
 const expand=(value:any,depth=0):any[]=>{
  if(!value||depth>6)return [];
  const values=[value];
  if(value.action==="hetu.execution.invoke")values.push(...expand(value.data?.result,depth+1));
  if(value.action==="hetu.execution.execute")for(const item of value.data?.results??[])values.push(...expand(item,depth+1));
  return values;
 };
 return (snapshot?.tools??[]).flatMap((tool:any)=>{try{return expand(JSON.parse(tool.output).structuredContent);}catch{return [];}});
}
const successful=(snapshot:any,action:string)=>receipts(snapshot).filter(value=>value.action===action&&value.status==="succeeded").at(-1)?.data;

test("真实GUI从空创作库讨论、创建作品、原任务返工、确切QA采纳并交付",async()=>{
 test.skip(process.env.HETU_LIVE_GUI_CREATION!=="1","仅在明确启用真实空库GUI验收时运行");test.setTimeout(2400000);
 await mkdir(output,{recursive:true});const journal=path.join(output,"private-state.json");let state:any;
 try{state=JSON.parse(await readFile(journal,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const save=async()=>{await writeFile(journal+".tmp",JSON.stringify(state,null,2)+"\n",{mode:0o600});await rename(journal+".tmp",journal);};
 if(!state){const folder=await mkdtemp(path.join(output,"sandbox-"));state={folder,profile:path.join(folder,"profile"),collaboration:path.join(folder,"collaboration"),workspace:path.join(folder,"新作品"),rounds:{}};await mkdir(state.profile);await save();}
 const executable=process.env.HETU_PACKAGED_APP??"/Applications/Hetu.app/Contents/MacOS/Hetu",resources=path.resolve(executable,"../../Resources"),bin=path.join(resources,"bin");
 const source=process.env.HETU_GUI_CREATION_SOURCE==="1";
 const env={...process.env,HETU_DESKTOP_PROFILE:state.profile,HETU_COLLABORATION_DIR:state.collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(state.profile,"local-settings"),HETU_PLUGIN_STATE_DIR:state.profile,HETU_PLUGIN_NODE:path.join(bin,"node"),HETU_PLUGIN_MANAGER:path.join(resources,"app/dist/plugin-manager.mjs"),...(source?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})};delete env.ELECTRON_RUN_AS_NODE;
 let app:ElectronApplication|undefined,page:Page;
 const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
 const round=(key:string,text:string)=>liveAgentRound({page,get,rounds:state.rounds,save,prefix:"隔离空库GUI验收"},key,text);
 const read=async(action:string,input:any={})=>{const value=await page.evaluate(({action,input})=>window.hetuDesktop.read(action,input),{action,input});expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data;};
 const taskView=async(submission_id?:string)=>{
  const directory=await page.evaluate(()=>window.hetuDesktop.tasks("list"));expect(directory.status,JSON.stringify(directory)).toBe("succeeded");
  expect(directory.data.tasks).toHaveLength(1);
  const task=directory.data.tasks.find((item:any)=>item.task_ref.task_id===state.task_ref.task_id)?.task_ref;expect(task).toBeTruthy();
  const result=await page.evaluate(({task,submission_id})=>window.hetuDesktop.tasks("call",task,{name:"hetu_open_task_view",arguments:{task_ref:task,...submission_id?{submission_id}:{}}}),{task,submission_id});expect(result.structuredContent.status,JSON.stringify(result)).toBe("succeeded");return result.structuredContent.data;
 };
 async function openLibraryChat(){
  if(await page.getByRole("button",{name:"关闭终端面板",exact:true}).isVisible())await page.getByRole("button",{name:"关闭终端面板",exact:true}).click();
  const projectLayer=page.getByRole("button",{name:"显示项目导航",exact:true});if(await projectLayer.isVisible())await projectLayer.click();
  const back=page.getByRole("button",{name:"返回创作库",exact:true}).first();if(await back.isVisible())await back.click();
  await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"创建会话",exact:true});await expect.poll(async()=>await dialog.isVisible()||await page.locator(".agent-chat").isVisible()).toBe(true);
  if(await dialog.isVisible()){await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();await dialog.getByRole("button",{name:"打开聊天",exact:true}).click();await expect(dialog).toHaveCount(0,{timeout:60000});}
  await expect(page.locator(".agent-chat")).toBeVisible();await expect.poll(async()=>(await get()).state,{timeout:60000}).toBe("ready");
  const snapshot=await get();expect(snapshot.work_ref).toBeUndefined();
  if(state.thread_id){expect(snapshot.thread_id).toBe(state.thread_id);expect(snapshot.session_id).toBe(state.session_id);}else{state.thread_id=snapshot.thread_id;state.session_id=snapshot.session_id;await save();}
 }
 async function openWork(){
  if(await page.getByRole("button",{name:"关闭终端面板",exact:true}).isVisible())await page.getByRole("button",{name:"关闭终端面板",exact:true}).click();
  await page.getByRole("button",{name:"刷新创作库",exact:true}).click();
  await page.getByRole("button",{name:"打开作品 "+title,exact:true}).click();await expect.poll(()=>page.evaluate(async()=>(await window.hetuDesktop.state()).work)).toEqual(state.work);
  await navigate(page,"作品资料");
 }
 const boundary="这是隔离软件验收，自动化QA决定仅对本测试材料有效，不是真实作者创作认可。只使用当前河图MCP，禁止Shell、任意本机文件读取、联网、付费、其他作品、采纳及定稿。保留原线程、原任务及操作键；unknown只查原操作，不能新键重发。请发现本次准确Schema后实际执行并回读，不停在计划，也不要求重复填表。";
 try{
  app=await electron.launch({...source?{args:[path.join(root,"apps/desktop")]}:{executablePath:executable,args:[]},env});page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});
  await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();
  const preferences=await page.evaluate(()=>window.hetuDesktop.settings("preferences"));
  if(preferences.preferences.execution_mode!=="auto"||preferences.preferences.agent_session?.default_surface!=="gui")await page.evaluate(expected=>window.hetuDesktop.settings("update",{expected_revision:expected,patch:{execution_mode:"auto",agent_session:{default_surface:"gui"}}}),preferences.revision);
  if(!state.empty_verified){
   const initial=await page.evaluate(()=>window.hetuDesktop.state());expect(initial.works??[]).toHaveLength(0);await expect(access(state.workspace)).rejects.toThrow();
   state.empty_verified={works:0,workspace_exists:false};await save();
  }
  await openLibraryChat();
  await round("discuss",boundary+"\n只和我讨论一个雾港灯塔收到明日来信的故事方向，给出一句故事冲突。本次不创建筹备、作品、目录、文稿、参考稿、计划或长期记录，也不写任何业务数据。");
  if(!state.rounds.create){
   const after=await page.evaluate(()=>window.hetuDesktop.library("refresh"));expect(after.works??[]).toHaveLength(0);await expect(access(state.workspace)).rejects.toThrow();
  }
  if(!state.creation_prompt){
   await page.getByLabel("创作任务",{exact:true}).click();await page.getByRole("button",{name:"新建小说",exact:true}).click();
   const dialog=page.getByRole("dialog",{name:"新建小说",exact:true});
   await dialog.getByRole("textbox",{name:"创作目标",exact:true}).fill(boundary+"\n我已决定保留并创建这部中文悬疑小说。书名‘"+title+"’，笔名‘隔离作者’，简介‘雾港灯塔收到一封来自明天的信’，请在新目录"+JSON.stringify(state.workspace)+"建立唯一筹备与小说。创建后建立唯一的空写作稿‘"+chapterTitle+"’，建立资料‘"+resourceTitle+"’，资料内容‘虚构雾港的夜航船以灯塔钟声计时。’，类别research，不虚构现实来源。只为第一章准备chapter_draft任务，brief固定‘空库GUI：雨夜来信’，按preview_prompt返回的prepare_input和实际task_locator继续。通过working_copies保存约80字参考稿并提交固定候选，内容必须含灯塔、明日来信和‘潮声三下’；正式正文保持空稿，暂不反馈、不采纳。操作键统一gui-empty-create-前缀，已有同名本次对象则查原操作接续。回读公开WorkRef、正文和资料目录、task_ref、submission_ref及工作副本引用。创建后不调用其他插件。");
   await dialog.getByRole("button",{name:"放入对话草稿",exact:true}).click();await expect(dialog).toHaveCount(0);state.creation_prompt=(await get()).draft;expect(state.creation_prompt).toContain("creation_action");await save();
  }
  const created=await round("create",state.creation_prompt),workReceipt=successful(created,"hetu.creation_projects.create_novel"),initialized=successful(created,"hetu.execution.initialize"),submitted=successful(created,"hetu.creative_tasks.submit_result");
  expect(workReceipt??initialized,"没有成功的新建业务回执").toBeTruthy();expect(submitted,"没有成功的候选提交回执").toBeTruthy();
  if(initialized&&!workReceipt){
   if(!state.mapping_recovery_request){
    const requests=(created.tools??[]).flatMap((tool:any)=>{try{const input=JSON.parse(tool.input),receipt=JSON.parse(tool.output).structuredContent;return receipt?.status==="succeeded"&&(input.action==="hetu.execution.initialize"||input.action==="hetu.execution.invoke"&&input.input?.command?.action==="hetu.creative_tasks.prepare")?[input]:[];}catch{return [];}});
    expect(requests).toHaveLength(2);state.mapping_recovery_request=boundary+"\n宿主已修复统一执行与稳定入口之间缺失的本机映射。上轮作品、原任务、参考稿均已成功，不要创建任何新对象或新键。请只重放下面两项原请求的完全相同参数，以补全新建目录及任务locator映射；然后从稳定collaboration.created_works与collaboration.open核对同一作品、原任务及首批候选。不得再次保存或提交候选。原请求="+JSON.stringify(requests);await save();
   }
   const recovered=await round("recover-mappings",state.mapping_recovery_request);expect(successful(recovered,"hetu.collaboration.open"),"原任务仍未接通稳定入口").toBeTruthy();
  }
  const registered=await page.evaluate(()=>window.hetuDesktop.library("refresh"));expect(registered.works).toHaveLength(1);state.work??=registered.works[0].work_ref;
  expect(state.work.workspace_id).toBe(workReceipt?.created_workspace_ref.workspace_id??initialized.result.data.workspace.workspace_id);
  if(workReceipt)expect(state.work.object_id).toBe(workReceipt.created_workspace_ref.novel_id);
  state.task_ref??=submitted.task_ref??successful(created,"hetu.creative_tasks.prepare")?.task_ref;expect(state.task_ref).toBeTruthy();state.first_submission??=submitted.submission_ref;await save();
  const libraryResults=await page.evaluate(()=>window.hetuDesktop.agentSession("results",{scope:"library"}));expect(libraryResults.items.some((item:any)=>item.kind==="work"&&item.state==="verified"&&JSON.stringify(item.work_ref)===JSON.stringify(state.work))).toBe(true);state.library_result_verified=true;await save();
  await page.screenshot({path:path.join(output,"created-in-chat.png")});await openWork();
  const documents=await read("hetu.documents.list",{work_ref:state.work});expect(documents.documents).toHaveLength(1);expect(documents.documents[0].title).toBe(chapterTitle);
  const document=await read("hetu.documents.get",{document_id:documents.documents[0].document_id});state.baseline??=document;expect(document.revision.sha256).toBe(state.adopted?.revision.sha256??state.baseline.revision.sha256);
  const resourcesResult=await page.evaluate(()=>window.hetuDesktop.resources("list",{}));expect(resourcesResult.status,JSON.stringify(resourcesResult)).toBe("succeeded");const resourcesList=resourcesResult.data;expect(resourcesList.resources).toHaveLength(1);expect(resourcesList.resources[0].title).toBe(resourceTitle);
  const original=await taskView(state.first_submission.submission_id);expect(original.submission.candidates).toHaveLength(1);expect(original.submission.candidates[0].content).toContain("潮声三下");
  await save();
  if(!state.feedback_prompt){
   await navigate(page,"参考稿审核");await page.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(state.task_ref.task_id);
   const frame=page.frameLocator('iframe[title="任务候选审阅"]');await frame.getByLabel("补充要求或意见",{exact:true}).fill("隔离QA意见：将‘潮声三下’改为‘钟声三下’，除此之外逐字保留本版参考稿；沿同一任务同一工作副本返工，不修改正式正文。");
   await frame.getByRole("button",{name:"按此修改",exact:true}).click();const prompt=frame.getByLabel("继续提示词",{exact:true});await expect(prompt).toHaveValue(/feedback_/);state.feedback_prompt=await prompt.inputValue();await save();
  }
  await openLibraryChat();
  const revisedRound=await round("revise",boundary+"\n"+state.feedback_prompt+"\n当前创作库原线程继续我刚才创建的确切作品，不创建新会话或任务。沿实际公开反馈、原task_locator和working_copy保存第二版并提交feedback_refs；只将‘潮声三下’换为‘钟声三下’，其余逐字保持。操作键gui-empty-revise-前缀，完成后回读两批候选、原工作副本和正式正文。");
  expect(successful(revisedRound,"hetu.creative_tasks.submit_result"),JSON.stringify(revisedRound.messages)).toBeTruthy();
  await openWork();const revised=await taskView();expect(revised.submission.submission_id).not.toBe(state.first_submission.submission_id);expect(revised.submission.feedback_refs).toHaveLength(1);
  expect(original.submission.working_copy_refs).toHaveLength(1);expect(revised.submission.working_copy_refs).toHaveLength(1);expect(revised.submission.working_copy_refs[0].working_copy_id).toBe(original.submission.working_copy_refs[0].working_copy_id);expect(revised.submission.working_copy_refs[0].working_revision_id).not.toBe(original.submission.working_copy_refs[0].working_revision_id);
  expect(revised.submission.candidates[0].content).toBe(original.submission.candidates[0].content.replaceAll("潮声三下","钟声三下"));
  expect((await taskView(state.first_submission.submission_id)).submission).toEqual(original.submission);
  const current=await read("hetu.documents.get",{document_id:state.baseline.document.document_id});
  if(current.revision.revision_id!==state.baseline.revision.revision_id){
   const history=await read("hetu.documents.lifecycle",{document_id:state.baseline.document.document_id});expect(history.adoptions).toHaveLength(1);expect(history.adoptions[0].draft_ref).toEqual(revised.submission.candidates[0].draft_ref);expect(current.content).toBe(revised.submission.candidates[0].content);state.adopted=current;await save();
  }
  if(!state.adopted){
   expect(current.revision.sha256).toBe(state.baseline.revision.sha256);await navigate(page,"参考稿审核");await page.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(state.task_ref.task_id);
   await page.getByText("采纳到作者正文",{exact:true}).click();await page.getByRole("combobox",{name:"采纳参考方案",exact:true}).selectOption(revised.submission.candidates[0].candidate_id);await page.getByRole("button",{name:"预览采纳变化",exact:true}).click();
   const preview=page.getByRole("region",{name:"作者决定预览",exact:true});await expect(preview).toContainText("钟声三下");await page.screenshot({path:path.join(output,"qa-adoption-preview.png")});
   expect((await read("hetu.documents.get",{document_id:state.baseline.document.document_id})).revision.sha256).toBe(state.baseline.revision.sha256);
   await page.getByRole("button",{name:"确认此预览",exact:true}).click();await expect(page.locator(".notice[role=status]")).toContainText("已采纳为新的作者修订",{timeout:30000});
   await expect.poll(async()=>(await read("hetu.documents.get",{document_id:state.baseline.document.document_id})).revision.sha256).toBe(revised.submission.candidates[0].sha256);
   state.adopted=await read("hetu.documents.get",{document_id:state.baseline.document.document_id});await save();
  }
  await openLibraryChat();const fixed={document_id:state.adopted.document.document_id,revision_id:state.adopted.revision.revision_id,sha256:state.adopted.revision.sha256};
  const exportedRound=await round("export",boundary+"\n隔离QA已在实际预览对确切候选执行一次采纳，尚未定稿。为刚才同一作品的固定文稿"+JSON.stringify(fixed)+"准备review_delivery审阅交付包，reading_formats仅txt，沿实际bundles.preview、获权export和verify完成。不写正文、不采纳、不定稿，不导出其他对象；操作键gui-empty-delivery-前缀。回读实际交付引用、核验状态和摘要。");
  const exported=successful(exportedRound,"hetu.bundles.export");expect(exported?.bundle_id,JSON.stringify(exportedRound.messages)).toBeTruthy();expect(successful(exportedRound,"hetu.bundles.verify")?.verified).toBe(true);
  expect(digest(await readFile(path.join(state.workspace,exported.path)))).toBe(exported.sha256);state.exported=exported;await save();
  await page.screenshot({path:path.join(output,"fixed-delivery.png")});await closeApplication(app,"window");app=undefined;
  app=await electron.launch({...source?{args:[path.join(root,"apps/desktop")]}:{executablePath:executable,args:[]},env});page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});
  await openLibraryChat();expect((await get()).messages.filter((item:any)=>item.role==="user")).toHaveLength(Object.keys(state.rounds).length);
  await openWork();const final=await read("hetu.documents.get",{document_id:fixed.document_id}),history=await read("hetu.documents.lifecycle",{document_id:fixed.document_id});expect(final.revision).toEqual(state.adopted.revision);expect(history.adoptions).toHaveLength(1);expect(history.finalizations??[]).toHaveLength(0);
  const cli=spawnSync(source?path.join(root,"target/debug/hetu"):path.join(bin,"hetu"),["--client","codex","--collaboration-dir",state.collaboration,"call","hetu.execution.invoke","--input","-","--json"],{env,input:JSON.stringify({workspace_path:state.workspace,command:{action:"hetu.documents.get",contract_revision:"1",input:{document_id:fixed.document_id,revision_id:fixed.revision_id}}}),encoding:"utf8"});const reread=JSON.parse(cli.stdout);expect(reread.status,JSON.stringify(reread)).toBe("succeeded");expect(reread.data.result.data.revision.sha256).toBe(fixed.sha256);
  await navigate(page,"参考稿审核");await page.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(state.task_ref.task_id);await expect(page.frameLocator('iframe[title="任务候选审阅"]').locator("body")).toContainText("钟声三下");
  await expect(page.getByRole("button",{name:"查询并恢复原保存",exact:true})).toHaveCount(0);await page.screenshot({path:path.join(output,"confirmed-review.png")});
  state.verified={empty_library:true,discussion_without_creation:true,work:state.work,thread_id:state.thread_id,model_rounds:Object.keys(state.rounds).length,documents:1,resources:1,tasks:1,task_ref:state.task_ref,first_submission:state.first_submission,latest_submission_id:revised.submission.submission_id,same_working_copy:true,document_revision:state.adopted.revision,adoptions:1,finalizations:0,bundle_id:exported.bundle_id,bundle_sha256:exported.sha256,independent_cli_reread:true,original_thread_reopened:true,library_result_verified:true,confirmed_save_without_warning:true};delete state.failure;await save();
  const evidenceFile=path.join(root,"docs/research/evidence/gui-empty-creation-2026-11-26.json");let previous:any={};try{previous=JSON.parse(await readFile(evidenceFile,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const stage=process.env.HETU_GUI_CREATION_STAGE??(source?"source":"packaged"),runtime=await app.evaluate(({app})=>({version:app.getVersion(),electron:process.versions.electron}));
  const verification={stage,runtime,original_thread_reopened:true,new_model_rounds:0,library_result_verified:true,confirmed_save_without_warning:true,adoptions:history.adoptions.length,finalizations:(history.finalizations??[]).length};
  await writeFile(evidenceFile,JSON.stringify({...previous,date:"2026-11-26",surface:"embedded GUI",source,...state.verified,verifications:[...(previous.verifications??[]).filter((item:any)=>item.stage!==stage),verification],first_failures:["installed baseline: initialization saved actual work but creation discovery and stable task mapping were missing","source test used unsupported generic resources.read bridge and expected task_ref on submit receipt; corrected to actual Owner contracts","repeated deterministic verification initially missed project sidebar layer before returning to library","first package rejected stale derived MCP workbench resource before assembly"],limits:["isolated short Chinese novel, not full-length author production","automation records an exact QA decision, not the real author's creative approval","not literary quality, full visual, accessibility or other platform validation"]},null,2)+"\n");
 }catch(error){state.failure=String(error);state.last_snapshot=await page?.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"})).catch(()=>undefined);await save();await page?.screenshot({path:path.join(output,"failure.png")}).catch(()=>{});throw error;}finally{if(app)await closeApplication(app);}
});
