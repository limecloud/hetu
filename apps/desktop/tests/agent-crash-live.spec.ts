import {test,expect,_electron as electron,type ElectronApplication,type Page} from "@playwright/test";
import {mkdir,mkdtemp,readFile,writeFile,rename} from "node:fs/promises";
import {spawnSync,execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import path from "node:path";
import {navigate,closeApplication} from "./navigation.ts";
import {dispatchLiveAgentRound,liveAgentRound} from "./fixtures/live-agent-round.ts";

const root=path.resolve(import.meta.dirname,"../../.."),desktopFault=process.env.HETU_CRASH_TARGET==="desktop",output=path.join(root,desktopFault?"output/gui-desktop-inflight-20261126":"output/gui-crash-20261126");
const resourceBody="虚构雾港的灯塔以钟声为船只报时。🌿\r\n这是隔离验收资料。";
const savedDraft="未发送草稿：先核对原计划和已保存资料，不要重复创建。";
const successful=(snapshot:any,action:string)=>(snapshot.tools??[]).flatMap((tool:any)=>{try{const value=JSON.parse(tool.output).structuredContent;return value.action===action&&value.status==="succeeded"?[value.data]:[];}catch{return [];}}).at(-1);

test(`真实GUI在Core已提交而回执未返回时${desktopFault?"桌面":"引擎"}崩溃，沿原线程和原计划恢复`,async()=>{
 test.skip(process.env.HETU_LIVE_CRASH!=="1","仅在明确启用隔离真实模型崩溃验收时运行");test.skip(process.platform==="win32","当前故障定位使用Unix受管进程组，Windows单独验收");test.setTimeout(1500000);
 await mkdir(output,{recursive:true});const journal=path.join(output,"private-state.json");let state:any;
 try{state=JSON.parse(await readFile(journal,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const save=async()=>{await writeFile(journal+".tmp",JSON.stringify(state,null,2)+"\n",{mode:0o600});await rename(journal+".tmp",journal);};
 if(!state){
  const folder=await mkdtemp(path.join(output,"sandbox-")),profile=path.join(folder,"profile"),workspace=path.join(folder,"作品"),collaboration=path.join(folder,"collaboration");
  const seeded=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);const fixture=JSON.parse(seeded.stdout);
  await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:fixture.novel.workspace_id,works:[{work_ref:fixture.novel,title:"在途崩溃恢复验收"}]}]}));
  state={folder,profile,workspace,collaboration,work:fixture.novel,rounds:{}};await save();
 }
 const resumedFault=!!state.crash_observed,previousRounds=Object.keys(state.rounds).length;
 const suffix=state.case_suffix??"",operationKey="gui-crash-resource-save"+suffix,resourceTitle="在途崩溃后保留的夜航资料"+(suffix?"（复验）":""),writeKey="write"+suffix,recoveryKey="recover"+suffix;
 const executable=process.env.HETU_PACKAGED_APP??"/Applications/Hetu.app/Contents/MacOS/Hetu",source=process.env.HETU_CRASH_SOURCE==="1",bin=source?path.join(root,"target/debug"):path.resolve(executable,"../../Resources/bin");
 const control=path.join(output,"private-fault.json"),proxy=path.join(output,"mcp-proxy");
 try{JSON.parse(await readFile(control,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await writeFile(control,JSON.stringify({enabled:true,used:false,hold_operation_key:operationKey,executions:{},reads:{}}),{mode:0o600});}
 await writeFile(proxy,`#!${process.execPath}\nimport {proxyMcp} from ${JSON.stringify(pathToFileURL(path.join(root,"apps/desktop/tests/fixtures/execution-receipt-proxy.mjs")).href)};\nproxyMcp({command:${JSON.stringify(path.join(bin,"hetu-mcp"))},control:${JSON.stringify(control)},args:process.argv.slice(2)});\n`,{mode:0o700});
 const env={...process.env,HETU_DESKTOP_PROFILE:state.profile,HETU_LOCAL_SETTINGS_DIR:path.join(state.profile,"LocalSettings"),HETU_COLLABORATION_DIR:state.collaboration,HETU_PLUGIN_STATE_DIR:state.profile,HETU_APP_SERVER:path.join(bin,"hetu-app-server"),HETU_CLI:path.join(bin,"hetu"),HETU_MCP:proxy};delete env.ELECTRON_RUN_AS_NODE;
 let app:ElectronApplication|undefined,page:Page;
 const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get"));
 const call=(action:string,input:any)=>{
  const result=spawnSync(path.join(bin,"hetu"),["--client","codex","--collaboration-dir",state.collaboration,"call",action,"--input","-","--json"],{env,input:JSON.stringify(input),encoding:"utf8",maxBuffer:8*1024*1024});const value=JSON.parse(result.stdout);expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data;
 };
 const read=(action:string,input:any={})=>{const result=call("hetu.execution.invoke",{workspace_path:state.workspace,command:{action,contract_revision:"1",input}}).result;expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 async function open(){
  app=await electron.launch({...source?{args:[path.join(root,"apps/desktop")]}:{executablePath:executable,args:[]},env});page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});
  await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect.poll(()=>page.evaluate(async()=>(await window.hetuDesktop.state()).work)).toEqual(state.work);
  const preferences=await page.evaluate(()=>window.hetuDesktop.settings("preferences"));if(preferences.preferences.execution_mode!=="auto"||preferences.preferences.agent_session?.default_surface!=="gui")await page.evaluate(expected=>window.hetuDesktop.settings("update",{expected_revision:expected,patch:{execution_mode:"auto",agent_session:{default_surface:"gui"}}}),preferences.revision);
  await navigate(page,"Agent 协作");const dialog=page.getByRole("dialog",{name:"创建会话",exact:true});await expect.poll(async()=>await dialog.isVisible()||await page.locator(".agent-chat").isVisible()).toBe(true);
  if(await dialog.isVisible()){await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();await dialog.getByRole("button",{name:"打开聊天",exact:true}).click();await expect(dialog).toHaveCount(0,{timeout:60000});}
  await expect(page.locator(".agent-chat")).toBeVisible();await expect.poll(async()=>["ready","running","uncertain"].includes((await get()).state),{timeout:60000}).toBe(true);
  const current=await get();if(state.thread_id){expect(current.thread_id).toBe(state.thread_id);expect(current.session_id).toBe(state.session_id);}else{state.thread_id=current.thread_id;state.session_id=current.session_id;await save();}
 }
 const crashEngine=()=>app!.evaluate(()=>{
  const rows=process.getBuiltinModule("node:child_process").execFileSync("ps",["-axo","pid=,ppid=,args="],{encoding:"utf8"}).split("\n").flatMap(line=>{const match=line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);return match?[{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}]:[];});
  const engines=rows.filter(row=>row.parent===process.pid&&/\bapp-server\b/.test(row.command)&&/--listen\s/.test(row.command));if(engines.length!==1)throw Error("未找到本隔离应用唯一受管引擎组，未终止任何进程。");
  process.kill(-engines[0].pid,"SIGKILL");return {engine_pid:engines[0].pid,owner_pid:process.pid};
 });
 const boundary="这是隔离引擎崩溃验收，只使用当前河图MCP，禁止Shell、任意文件读取、联网、付费、其他作品、采纳和定稿。保留原线程、计划、固定输入及operation_key；未知时只查原计划和领域对象，不能重发执行、改键或重建内容。请按实际Schema执行，不停在计划。";
 const command={action:"hetu.resources.create",contract_revision:"1",input:{work_ref:state.work,title:resourceTitle,category:"research",body:resourceBody,tags:[],project_id:null,entity_refs:[],source_notes:"虚构资料，隔离软件验收",operation_key:operationKey}};
 try{
  await open();
  if(state.restore_qa_draft){
   const current=await get();await page.evaluate(input=>window.hetuDesktop.agentSession("draft",input),{text:savedDraft,session_id:current.session_id,generation:current.generation,surface:"gui"});state.restore_qa_draft=false;await save();
  }
  if(!state.baseline){state.baseline={message_count:(await get()).messages.filter((item:any)=>item.role==="user").length,resources:read("hetu.resources.list",{work_ref:state.work}).resources,documents:read("hetu.documents.list",{work_ref:state.work}).documents,tasks:read("hetu.creative_tasks.list",{work_ref:state.work}).tasks};state.baseline.contents=state.baseline.documents.map((item:any)=>read("hetu.documents.get",{document_id:item.document_id}));await save();}
  const initialPrompt=boundary+"\n请先读实际execution.get_mode，应为auto。对明确工作区"+JSON.stringify(state.workspace)+"准备唯一单步execution计划，commands必须逐字段等于"+JSON.stringify([command])+"，summary‘隔离崩溃：保存唯一夜航资料’，prepare键"+"gui-crash-fixed-plan"+suffix+"。auto下不需要record_confirmation，准备后execute一次并回读原计划。现有同键计划就接续，不新建其他计划、创作任务或文稿。执行回执若迟迟未到，不重试或换入口重复写入。";
  if(!state.crash_observed){
   await dispatchLiveAgentRound({page,get,rounds:state.rounds,save,prefix:"隔离在途崩溃验收"},writeKey,initialPrompt);
   await expect.poll(async()=>JSON.parse(await readFile(control,"utf8")).held,{timeout:600000,intervals:[500,1000,2000]}).toBe(true);
   const fault=JSON.parse(await readFile(control,"utf8"));expect(fault.completed_steps).toBe(1);state.plan_ref=fault.plan_ref;state.resource_ref=fault.held_receipt.data.results[0].data;await save();
   const plan=call("hetu.execution.get_plan",{plan_ref:state.plan_ref});expect(plan.fixed.commands).toEqual([command]);expect(plan.state).toBe("completed");expect(plan.results).toHaveLength(1);
   expect(read("hetu.resources.get",{resource_id:state.resource_ref.resource.resource_id,revision:state.resource_ref.resource.revision}).resource.body).toBe(resourceBody);
   await expect.poll(async()=>(await get()).tools?.some((tool:any)=>tool.state==="running"&&tool.server==="hetu")).toBe(true);
   await page.getByRole("textbox",{name:"发送给 Agent",exact:true}).fill(savedDraft);await page.getByRole("textbox",{name:"发送给 Agent",exact:true}).blur();await expect.poll(async()=>(await get()).draft).toBe(savedDraft);
   state.before_crash=await get();await save();await page.screenshot({path:path.join(output,"committed-receipt-held.png")});
   if(desktopFault){
    const owner=app!.process().pid!,rows=execFileSync("ps",["-axo","pid=,ppid=,pgid=,args="],{encoding:"utf8"}).split("\n").flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return m?[{pid:Number(m[1]),parent:Number(m[2]),group:Number(m[3]),command:m[4]}]:[];});const engines=rows.filter(row=>row.parent===owner&&/\bapp-server\b/.test(row.command)&&/--listen\s/.test(row.command));expect(engines).toHaveLength(1);
    state.desktop_crash_intent={owner,engine_group:engines[0].group};await save();const child=app!.process();child.kill("SIGKILL");await expect.poll(()=>child.signalCode,{timeout:10000}).toBe("SIGKILL");app=undefined;
    await expect.poll(()=>{try{process.kill(-engines[0].group,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return true;throw error;}},{timeout:15000}).toBe(true);state.crash_observed={kind:"desktop-main-SIGKILL",old_engine_group_exited:true};await save();await open();
   }else{
    const engine=await crashEngine();state.killed_engine=engine;await save();
    await expect.poll(async()=>(await get()).state,{timeout:30000}).toBe("disconnected");const disconnected=await get();expect(disconnected.draft).toBe(savedDraft);expect(disconnected.tools?.some((tool:any)=>tool.state==="unknown"&&tool.server==="hetu")).toBe(true);
    expect(disconnected.messages.filter((item:any)=>item.role==="user")).toHaveLength(state.baseline.message_count+1);state.crash_observed=disconnected;await save();await page.screenshot({path:path.join(output,"engine-crashed-unknown.png")});
   }
  }
  if(!state.reconnected){
   const before=await get();if(before.state==="disconnected"||before.state==="failed")await page.getByRole("button",{name:"重新连接",exact:true}).click();
   await expect.poll(async()=>(await get()).state,{timeout:60000}).toBe("ready");
   const current=await get();expect(current.thread_id).toBe(state.thread_id);expect(current.draft).toBe(savedDraft);expect(current.messages.filter((item:any)=>item.role==="user")).toHaveLength(state.baseline.message_count+1);
   const uncertain=current.tools?.filter((tool:any)=>tool.id===state.before_crash.tools.findLast((tool:any)=>tool.state==="running")?.id);expect(uncertain).toHaveLength(1);expect(uncertain![0].state).not.toBe("completed");
   const refused=await page.evaluate(async prior=>{try{await window.hetuDesktop.agentSession("draft",{session_id:prior.session_id,generation:prior.generation,surface:"gui",text:"旧代次迟到草稿"});return "accepted";}catch(error){return (error as Error).message;}},state.before_crash);expect(refused).toContain("终端已重新连接");
   state.reconnected={generation:current.generation,stale_draft_rejected:true,thread_preserved:true};await save();
   await closeApplication(app!);app=undefined;await open();expect((await get()).draft).toBe(savedDraft);state.desktop_reopened=true;await save();
  }
  const recovery=await liveAgentRound({page,get,rounds:state.rounds,save,prefix:"隔离在途崩溃验收"},recoveryKey,boundary+"\n上轮执行过程中受管引擎崩溃。测试独立回读确认原Core计划已完成，唯一资料已保存，但成功回执未返回给你。现在仅查询原execution.get_plan，plan_ref="+JSON.stringify(state.plan_ref)+"，核对固定commands、唯一成功步骤和实际资料原修订，再用resources.get及原operations.get按实际Schema回读。不得execute、创建新计划、重复保存资料或创建任务。确认真实资料内容、公开引用、修订及摘要后停止。");
  const recovered=successful(recovery,"hetu.execution.get_plan");expect(recovered?.state,JSON.stringify(recovery.messages)).toBe("completed");expect(recovered.results).toHaveLength(1);
  const fault=JSON.parse(await readFile(control,"utf8"));expect(fault.executions[state.plan_ref.plan_id]).toBe(1);expect(fault.reads_after_drop[state.plan_ref.plan_id]).toBeGreaterThan(0);
  const originalReceipt=fault.held_receipt.data.results[0],operation=originalReceipt.operation;
  const originalRoute=await liveAgentRound({page,get,rounds:state.rounds,save,prefix:"隔离在途崩溃验收"},"recover-operation-original-route",boundary+"\n上轮原计划及资料回读已成功；operations.get走旧精确management入口被拒绝，是不同操作命名空间，不需要扩大权限。现在只做一次只读核验：用execution.invoke，workspace_path="+JSON.stringify(state.workspace)+"，command={action:'hetu.operations.get',contract_revision:'1',input:"+JSON.stringify({operation_id:operation.id,action:originalReceipt.action,key:operation.key,input_digest:operation.input_digest,detail:"full"})+"}，发现准确Schema后调用，读取original_result并与原计划成功步骤及资料引用核对。禁止execute、写入、换键及新建计划。完成原操作完整回读后停止。");
  const originalResult=successful(originalRoute,"hetu.execution.invoke")?.result?.data?.original_result;expect(originalResult,JSON.stringify(originalRoute.messages)).toEqual(originalReceipt);expect(JSON.parse(await readFile(control,"utf8")).executions[state.plan_ref.plan_id]).toBe(1);
  const resource=read("hetu.resources.get",{resource_id:state.resource_ref.resource.resource_id,revision:state.resource_ref.resource.revision});expect(resource.resource.revision).toBe(1);expect(resource.sha256).toBe(state.resource_ref.sha256);expect(resource.resource.body).toBe(resourceBody);
  expect(read("hetu.resources.list",{work_ref:state.work}).resources).toHaveLength(state.baseline.resources.length+1);expect(read("hetu.creative_tasks.list",{work_ref:state.work}).tasks).toEqual(state.baseline.tasks);
  for(const original of state.baseline.contents)expect(read("hetu.documents.get",{document_id:original.document.document_id})).toEqual(original);
  const results=await page.evaluate(()=>window.hetuDesktop.agentSession("results"));const saved=results.items.find((item:any)=>item.kind==="resource"&&item.reference.resource_id===resource.resource.resource_id);expect(saved?.state,JSON.stringify(results)).toBe("verified");
  await page.getByRole("button",{name:"查看作品成果",exact:true}).click();const region=page.getByRole("region",{name:"作品成果",exact:true});await region.getByRole("button",{name:resourceTitle,exact:true}).click();await expect(page.getByRole("main",{name:"附件工作区",exact:true})).toContainText(resourceBody.split("\r\n")[0]);
  const stage=process.env.HETU_CRASH_STAGE??(source?"source":"installed");
  const beforeStaleProbe=await get();
  const staleProbe=await page.evaluate(async prior=>{try{await window.hetuDesktop.agentSession("draft",{session_id:prior.session_id,generation:prior.generation,surface:"gui",text:"旧进程的迟到草稿，不应覆盖当前输入"});return "accepted";}catch(error){return (error as Error).message;}},state.before_crash);
  expect(staleProbe).toContain("终端已重新连接");expect((await get()).draft).toBe(beforeStaleProbe.draft);expect((await get()).thread_id).toBe(state.thread_id);
  if(process.env.HETU_ASSERT_SEND_GUARD==="1"&&!state.send_guards?.[stage]){
   await navigate(page,"Agent 协作");await expect.poll(async()=>(await get()).state).toBe("ready");
   const input=page.getByRole("textbox",{name:"发送给 Agent",exact:true});await input.fill(savedDraft);await input.blur();await expect.poll(async()=>(await get()).draft).toBe(savedDraft);const before=await get();
   await crashEngine();await expect.poll(async()=>(await get()).state).toBe("disconnected");await expect(page.getByRole("button",{name:"发送",exact:true})).toBeDisabled();await expect(input).toBeEnabled();await input.press("Enter");
   const refused=await page.evaluate(async()=>{try{await window.hetuDesktop.agentSession("send",{text:"离线不得隐式连接并发送",attempt_id:"offline-crash-probe"});return "sent";}catch(error){return (error as Error).message;}});expect(refused).toContain("请先重新连接或核对原线程");expect((await get()).messages).toEqual(before.messages);
   await page.screenshot({path:path.join(output,stage+"-disconnected-send-blocked.png")});await page.getByRole("button",{name:"重新连接",exact:true}).click();await expect.poll(async()=>(await get()).state,{timeout:60000}).toBe("ready");await expect(page.getByRole("button",{name:"发送",exact:true})).toBeEnabled();expect((await get()).draft).toBe(savedDraft);expect((await get()).thread_id).toBe(state.thread_id);expect((await get()).messages).toEqual(before.messages);
   state.send_guards??={};state.send_guards[stage]={passed:true,new_model_requests:0};await save();
  }
  await page.screenshot({path:path.join(output,"recovered-resource.png")});state.verified={thread_id:state.thread_id,plan_ref:state.plan_ref,executions:1,model_rounds:Object.keys(state.rounds).length,resource_id:resource.resource.resource_id,resource_revision:1,sha256:resource.sha256,unknown_tool_preserved:true,draft_preserved:true,desktop_reopened:state.desktop_reopened,stale_draft_rejected:true,original_operation_reread:true,original_documents_unchanged:true,no_task_created:true,result_opened:true};delete state.failure;await save();
  const evidenceFile=path.join(root,desktopFault?"docs/research/evidence/gui-desktop-inflight-crash-2026-11-26.json":"docs/research/evidence/gui-inflight-crash-2026-11-26.json");let evidence:any={};try{evidence=JSON.parse(await readFile(evidenceFile,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const runtime=await app!.evaluate(({app})=>({version:app.getVersion(),electron:process.versions.electron}));
  await writeFile(evidenceFile,JSON.stringify({...evidence,date:"2026-11-26",...state.verified,whole_desktop_crash:desktopFault,verifications:[...(evidence.verifications??[]).filter((item:any)=>item.stage!==stage),{stage,runtime,passed:true,fault_injected_this_run:!resumedFault,original_operation_reverified:true,stale_draft_probe:true,new_model_rounds:Object.keys(state.rounds).length-previousRounds,disconnected_send_guard:!!state.send_guards?.[stage]?.passed}],limits:[desktopFault?"isolated actual desktop main-process SIGKILL after committed Core plan with receipt held":"isolated real model and engine process-group crash after committed Core plan",desktopFault?"guardian exits original engine group before resuming the original thread":"desktop was closed normally and reopened after engine recovery; whole-desktop crash is separate",...(resumedFault?["this stage reverified the preserved original fault sample; no new in-flight fault was injected"]:[]),"not authentication, system IME, creative quality or cross-platform validation"]},null,2)+"\n");
 }catch(error){state.failure=String(error);state.last_snapshot=await page?.evaluate(()=>window.hetuDesktop.agentSession("get")).catch(()=>undefined);await save();await page?.screenshot({path:path.join(output,"failure.png")}).catch(()=>{});throw error;}finally{if(app)await closeApplication(app);}
});
