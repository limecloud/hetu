import {test,expect,_electron as electron,type ElectronApplication,type Page} from "@playwright/test";
import {mkdir,mkdtemp,readFile,writeFile,rename} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import path from "node:path";
import {navigate,closeApplication} from "./navigation.ts";
import {liveAgentRound} from "./fixtures/live-agent-round.ts";

const root=path.resolve(import.meta.dirname,"../../.."),output=path.join(root,"output/gui-confirm-20261126");
const receipts=(snapshot:any)=>(snapshot?.tools??[]).flatMap((tool:any)=>{try{return [JSON.parse(tool.output).structuredContent].filter(Boolean);}catch{return [];}});
const receipt=(snapshot:any,action:string)=>receipts(snapshot).filter((value:any)=>value.action===action&&value.status==="succeeded").at(-1)?.data;

test("真实GUI集中确认、部分完成后重开原会话，提交丢回执沿原计划恢复",async()=>{
 test.skip(process.env.HETU_LIVE_CONFIRM!=="1","仅在明确启用真实内嵌模型确认验收时运行");test.setTimeout(1500000);
 await mkdir(output,{recursive:true});const journal=path.join(output,"private-state.json");let state:any;
 try{state=JSON.parse(await readFile(journal,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const save=async()=>{await writeFile(journal+".tmp",JSON.stringify(state,null,2)+"\n",{mode:0o600});await rename(journal+".tmp",journal);};
 if(!state){
  const folder=await mkdtemp(path.join(output,"sandbox-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
  const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);const work=JSON.parse(fixture.stdout).novel;
  await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"真实确认与恢复验收"}]}]}));
  state={folder,workspace,profile,collaboration,work,rounds:{}};await save();
 }
 const executable=process.env.HETU_PACKAGED_APP,bin=executable?path.resolve(executable,"../../Resources/bin"):path.join(root,"target/debug");
 const control=path.join(output,"private-fault.json"),proxy=path.join(output,"mcp-proxy");
 try{JSON.parse(await readFile(control,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await writeFile(control,JSON.stringify({enabled:false,used:false,executions:{},reads:{}}),{mode:0o600});}
 await writeFile(proxy,`#!${process.execPath}\nimport {proxyMcp} from ${JSON.stringify(pathToFileURL(path.join(root,"apps/desktop/tests/fixtures/execution-receipt-proxy.mjs")).href)};\nproxyMcp({command:${JSON.stringify(path.join(bin,"hetu-mcp"))},control:${JSON.stringify(control)},args:process.argv.slice(2)});\n`,{mode:0o700});
 const env={...process.env,HETU_DESKTOP_PROFILE:state.profile,HETU_LOCAL_SETTINGS_DIR:path.join(state.profile,"LocalSettings"),HETU_PLUGIN_STATE_DIR:state.profile,HETU_COLLABORATION_DIR:state.collaboration,HETU_APP_SERVER:path.join(bin,"hetu-app-server"),HETU_CLI:path.join(bin,"hetu"),HETU_MCP:proxy};delete env.ELECTRON_RUN_AS_NODE;
 let app:ElectronApplication|undefined,page:Page;
 const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get"));
 const read=async(action:string,input:any={})=>{const result=await page.evaluate(({action,input})=>window.hetuDesktop.read(action,input),{action,input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const execution=async(action:string,input:any)=>page.evaluate(({action,input})=>window.hetuDesktop.execution({action,contract_revision:"1",input}),{action,input});
 const getPlan=async(plan_ref:any)=>{const result=await execution("hetu.execution.get_plan",{plan_ref});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 async function open(){
  app=await electron.launch({...executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]},env});page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});
  await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect.poll(()=>page.evaluate(async()=>(await window.hetuDesktop.state()).work)).toEqual(state.work);
  const preferences=await page.evaluate(()=>window.hetuDesktop.settings("preferences"));
  if(preferences.preferences.execution_mode!=="confirm"||preferences.preferences.agent_session?.default_surface!=="gui")await page.evaluate(async expected=>window.hetuDesktop.settings("update",{expected_revision:expected,patch:{execution_mode:"confirm",agent_session:{default_surface:"gui"}}}),preferences.revision);
  await navigate(page,"Agent 协作");const dialog=page.getByRole("dialog",{name:"创建会话",exact:true});
  await expect.poll(async()=>await dialog.isVisible()||await page.locator(".agent-chat").isVisible(),{timeout:45000}).toBe(true);
  if(await dialog.isVisible()){await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();await dialog.getByRole("button",{name:"打开聊天",exact:true}).click();await expect(dialog).toHaveCount(0,{timeout:60000});}
  await expect(page.locator(".agent-chat")).toBeVisible({timeout:45000});await expect.poll(async()=>(await get()).state,{timeout:60000}).toBe("ready");
  await expect(page.locator(".codex-session")).not.toHaveAttribute("aria-busy","true");await expect(page.locator(".codex-session-header").getByRole("status")).toHaveText("已连接");
  const current=await get();if(state.session_id){expect(current.session_id).toBe(state.session_id);expect(current.thread_id).toBe(state.thread_id);}else{state.session_id=current.session_id;state.thread_id=current.thread_id;await save();}
 }
 const round=(key:string,text:string)=>liveAgentRound({page,get,rounds:state.rounds,save,prefix:"隔离确认验收"},key,text);
 try{
  await open();
  if(!state.baseline){const docs=await read("hetu.documents.list",{work_ref:state.work}),baseline=await read("hetu.documents.get",{document_id:docs.documents[0].document_id}),tasks=await page.evaluate(()=>window.hetuDesktop.tasks("list"));state.baseline={document:baseline.document,revision:baseline.revision,content:baseline.content,count:docs.documents.length,tasks:tasks.data.tasks.length};await save();}
  const baseline=state.baseline,id=baseline.document.document_id,base_revision_id=baseline.revision.revision_id;
  const commands=[
   {action:"hetu.documents.create",contract_revision:"1",input:{kind:"novel_chapter",title:"确认批次新增稿",source_format:"markdown",content:"江岚保留来信🌿。\r\n本稿只创建一次。",operation_key:"gui-confirm-create"}},
   {action:"hetu.documents.rename",contract_revision:"1",input:{document_id:id,base_revision_id,title:"确认批次已改名",operation_key:"gui-confirm-rename"}},
   {action:"hetu.documents.save",contract_revision:"1",input:{document_id:id,base_revision_id,source_format:"markdown",content:"过期基线不得写入。",operation_key:"gui-confirm-stale"}},
  ];
  const boundary="这是隔离产品验收。仅使用当前河图MCP，禁止Shell、任意文件读取、付费、图片、采纳和定稿。保持当前确切作品，不新建创作任务。执行结果未知只查询原计划／原操作，不重发写入。";
  if(!state.plan_ref){
   const prepared=await round("prepare",boundary+"\n先发现并读取真实execution.get_mode和相关Schema，当前应为confirm。为明确工作区"+JSON.stringify(state.workspace)+"准备以下完整三步固定计划，commands必须逐字段保持，第三步故意使用同一旧基线，后续将验证CAS冲突："+JSON.stringify(commands)+"。prepare的summary用‘隔离确认：创建、改名与旧基线负例’，operation_key用gui-confirm-plan。本轮未获确切计划确认，不得record_confirmation；prepare后尝试execute一次验证被拒绝且无业务写入，然后get_plan并展示准确plan_ref和完整变更，停止等待决定。不要绕过策略或改变第三步使其成功。");
   const plan=receipt(prepared,"hetu.execution.prepare");expect(plan,JSON.stringify(prepared.messages)).toBeTruthy();state.plan_ref={plan_id:plan.plan_id,sha256:plan.sha256};await save();
  }
  const plan=await getPlan(state.plan_ref);expect(plan.fixed.commands).toEqual(commands);
  if(!state.rounds.execute?.complete){
   expect(plan.state).toBe("prepared");expect(plan.confirmation).toBeUndefined();expect((await read("hetu.documents.list",{work_ref:state.work})).documents).toHaveLength(baseline.count);expect((await read("hetu.documents.get",{document_id:id})).revision).toEqual(baseline.revision);
   expect(receipts(state.rounds.prepare.snapshot).some((item:any)=>item.error?.code==="hetu.execution_confirmation_required")).toBe(true);
   await page.screenshot({path:path.join(output,"confirm-plan-before-decision.png")});
   await round("execute",boundary+"\n隔离自动化QA已核对本计划的三步确切变化，现明确确认仅执行这个固定计划："+JSON.stringify({plan_ref:state.plan_ref,commands})+"。这是隔离测试决定，不代表真实作者创作认可。请先get_plan核对同一prepared计划；依据这条真实QA决定record_confirmation（operation_key=gui-confirm-qa-one），再execute。预期前两步成功、第三步revision_conflict；失败后get_plan核对实际成功数和原文，不重做成功步骤，不改计划、不另建后续计划，准确报告并停止。");
  }
  const partial=await getPlan(state.plan_ref);expect(partial.state).toBe("blocked");expect(partial.results).toHaveLength(2);expect(partial.last_error.error.code).toBe("revision_conflict");
  const renamed=await read("hetu.documents.get",{document_id:id,...(state.renamed_revision?{revision_id:state.renamed_revision.revision_id}:{})});expect(renamed.document.title).toBe("确认批次已改名");expect(renamed.content).toBe(baseline.content);expect(renamed.revision.actor_ref).toBe("actor_00000000-0000-4000-8000-000000000002");
  state.renamed_revision??=renamed.revision;expect(renamed.revision).toEqual(state.renamed_revision);await save();
  if(!state.reopened){await closeApplication(app!);app=undefined;await open();state.reopened=true;await save();}
  const finalContent=baseline.content+"\r\n\r\n来信已经核对🌿，保留原稿的其他内容。";
  if(!state.followup_ref){
   const recovery=await round("recover-and-prepare",boundary+"\n已重新打开同一个原生线程。先get_plan读取原固定计划"+JSON.stringify(state.plan_ref)+"，核对只有两步成功；沿原execute再恢复一次验证成功步骤不会重做，第三步仍应CAS拒绝。不要声称该原计划已全部完成。再读取当前document_id="+id+"的确切修订，只为这个文稿准备一份新的后续单步documents.save计划，正文必须精确为"+JSON.stringify(finalContent)+"，source_format=markdown，使用刚读取的当前base_revision_id，实际写键gui-confirm-followup-save，prepare键gui-confirm-followup-plan，summary‘隔离确认：沿当前修订完成后续保存’。原计划及其所有键保持不变。新计划尚未批准，不登记确认、不执行，只展示确切plan_ref和变化并停止。");
   const followup=receipt(recovery,"hetu.execution.prepare");expect(followup,JSON.stringify(recovery.messages)).toBeTruthy();state.followup_ref={plan_id:followup.plan_id,sha256:followup.sha256};await save();
  }
  const followup=await getPlan(state.followup_ref);expect(followup.fixed.commands).toEqual([{action:"hetu.documents.save",contract_revision:"1",input:{document_id:id,base_revision_id:state.renamed_revision.revision_id,source_format:"markdown",content:finalContent,operation_key:"gui-confirm-followup-save"}}]);
  if(!state.rounds.finish?.complete){
   expect(followup.state).toBe("prepared");expect((await read("hetu.documents.get",{document_id:id})).revision).toEqual(state.renamed_revision);
   const fault=JSON.parse(await readFile(control,"utf8"));if(!fault.used)await writeFile(control,JSON.stringify({...fault,enabled:true,plan_ref:state.followup_ref}),{mode:0o600});
   await page.screenshot({path:path.join(output,"followup-plan-before-decision.png")});
   await round("finish",boundary+"\n隔离自动化QA现明确确认这个后续固定计划及其唯一文稿变更："+JSON.stringify({plan_ref:state.followup_ref,commands:followup.fixed.commands})+"。请get_plan核对后record_confirmation（operation_key=gui-confirm-qa-two）并execute一次。若回执未知，请只get_plan查询原计划及documents.get回读实际内容和修订，不再次execute、不重建计划、不换操作键。核对已完成后给出确切修订和摘要，不能把消息受理当保存成功。原先blocked计划保持原记录。");
  }
  const fault=JSON.parse(await readFile(control,"utf8"));expect(fault.used).toBe(true);expect(fault.executions[state.followup_ref.plan_id]).toBe(1);expect(fault.reads_after_drop[state.followup_ref.plan_id]).toBeGreaterThan(0);
  const completed=await getPlan(state.followup_ref);expect(completed.state).toBe("completed");expect(completed.results).toHaveLength(1);
  const actual=await read("hetu.documents.get",{document_id:id});expect(actual.content).toBe(finalContent);expect(actual.revision).toEqual(completed.results[0].data.revision);
  expect((await read("hetu.documents.list",{work_ref:state.work})).documents).toHaveLength(baseline.count+1);expect((await read("hetu.documents.get",{document_id:id,revision_id:base_revision_id})).content).toBe(baseline.content);
  const tasks=await page.evaluate(()=>window.hetuDesktop.tasks("list"));expect(tasks.data.tasks).toHaveLength(baseline.tasks);expect((await getPlan(state.plan_ref)).results).toEqual(partial.results);
  const verified=await page.evaluate(()=>window.hetuDesktop.agentSession("results"));state.verified_results=verified;await save();expect(verified.items.some((item:any)=>item.reference.document_id===id&&item.reference.revision_id===actual.revision.revision_id&&item.state==="verified")).toBe(true);
  await page.screenshot({path:path.join(output,"confirmed-recovered-gui.png")});
  const changes=page.getByRole("region",{name:"作品变更",exact:true});await expect(changes.getByRole("button",{name:"确认批次已改名",exact:true})).toBeEnabled({timeout:45000});await changes.getByRole("button",{name:"确认批次已改名",exact:true}).click();
  const savedDocument=page.getByRole("region",{name:"已保存文稿",exact:true});await expect(savedDocument).toHaveAttribute("data-revision-id",actual.revision.revision_id);await expect(savedDocument).toContainText("来信已经核对");await page.screenshot({path:path.join(output,"confirmed-fixed-document.png")});
  state.completed=true;state.final_revision=actual.revision;delete state.failure;await save();
  const evidencePath=path.join(root,"docs/research/evidence/gui-confirm-recovery-2026-11-26.json");let prior:any={};try{prior=JSON.parse(await readFile(evidencePath,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  delete prior.installed;
  const stage=executable?path.resolve(executable)==="/Applications/Hetu.app/Contents/MacOS/Hetu"?"installed":"packaged":"source";
  await writeFile(evidencePath,JSON.stringify({...prior,date:"2026-11-26",surface:"embedded GUI",work_ref:state.work,thread_id:state.thread_id,plan_ref:state.plan_ref,followup_ref:state.followup_ref,partial_steps:2,followup_steps:1,fault:{execute_count:1,queries_after_drop:fault.reads_after_drop[state.followup_ref.plan_id]},same_thread_after_reopen:true,old_revision_preserved:true,no_new_creative_tasks:true,core_results_verified:true,runs:{...prior.runs,[stage]:{passed:true,fixed_document_opened:true,reused_original_rounds:true}},limits:["isolated automatic QA decisions, not real creative approval","one successful receipt replaced by an unknown-result tool response","not whole-transport crash or cross-platform validation"]},null,2)+"\n");
 }catch(error){state.failure=String(error);state.last_snapshot=await page!?.evaluate(()=>window.hetuDesktop.agentSession("get")).catch(()=>undefined);await save();await page!?.screenshot({path:path.join(output,"failure.png")}).catch(()=>{});throw error;}
 finally{if(app)await closeApplication(app);}
});
