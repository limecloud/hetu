import {test,expect,_electron as electron,type ElectronApplication,type Page} from "@playwright/test";
import {mkdir,mkdtemp,readFile,writeFile,rename} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import path from "node:path";
import {navigate,closeApplication} from "./navigation.ts";
import {liveAgentRound} from "./fixtures/live-agent-round.ts";

const root=path.resolve(import.meta.dirname,"../../.."),output=path.join(root,"output/professional-gui-20261126");
const ids=["org.wordflowlab.prose-studio","org.wordflowlab.novel-review"];
const opening="# 第三封信\r\n\r\n灯塔的门闩上挂着一条湿围巾。江岚把旧日记压在桌角，约定天亮后将第三封信交给守灯人；前两封信的封蜡都没有破。🌿\r\n\r\n";
const selection="海雾像一堵无形的墙，压得江岚几乎喘不过气。他心里十分紧张，非常担忧，非常害怕，不知道该怎么办。他觉得自己仿佛置身于命运的十字路口，前途一片迷茫。\r\n\r\n他拿起信，又放下信，重复了同样的动作。他知道这封信非常重要，对所有人来说都很重要，可是他不知道为什么重要。门外传来脚步声，他的心怦怦直跳，犹如擂鼓一般。";
const ending="\r\n\r\n门缝里先伸进来一只沾盐的手。信封背面的日期，比今晚晚了整整一年。\r\n";
const source=opening+selection+ending,hash=(text:string)=>createHash("sha256").update(text).digest("hex");

function receipts(snapshot:any):any[]{
 const expand=(value:any,depth=0):any[]=>{
  if(!value||depth>6)return [];
  const values=[value];
  if(value.action==="hetu.execution.invoke")values.push(...expand(value.data?.result,depth+1));
  if(value.action==="hetu.execution.execute")for(const item of value.data?.results??[])values.push(...expand(item,depth+1));
  if(value.action==="hetu.plugins.invoke"){
   values.push({action:`plugin:${value.data?.plugin_id}:${value.data?.invocation?.action}`,status:value.data?.result?.status,data:value.data?.result?.data});
   if(value.data?.result?.action)values.push(...expand(value.data.result,depth+1));
  }
  return values;
 };
 return (snapshot?.tools??[]).flatMap((tool:any)=>{try{return expand(JSON.parse(tool.output).structuredContent);}catch{return [];}});
}
const success=(snapshot:any,action:string)=>receipts(snapshot).filter(value=>value.action===action&&value.status==="succeeded").at(-1)?.data;

test("真实安装GUI组合文风与审校，原任务局部返工后停用插件仍读固定成果",async()=>{
 test.skip(process.env.HETU_LIVE_PROFESSIONAL!=="1","仅在明确启用真实专业模型组合验收时运行");test.setTimeout(2400000);
 await mkdir(output,{recursive:true});const journal=path.join(output,"private-state.json");let state:any;
 try{state=JSON.parse(await readFile(journal,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const save=async()=>{await writeFile(journal+".tmp",JSON.stringify(state,null,2)+"\n",{mode:0o600});await rename(journal+".tmp",journal);};
 const sourceDesktop=process.env.HETU_PROFESSIONAL_SOURCE==="1";
 const executable=process.env.HETU_PACKAGED_APP??"/Applications/Hetu.app/Contents/MacOS/Hetu",resources=path.resolve(executable,"../../Resources"),bin=path.join(resources,"bin");
 if(!state){
  const folder=await mkdtemp(path.join(output,"sandbox-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
  const seeded=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);const fixture=JSON.parse(seeded.stdout);
  await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:fixture.novel.workspace_id,works:[{work_ref:fixture.novel,title:"真实专业组合"}]}]}));
  state={folder,workspace,profile,collaboration,work:fixture.novel,seed_document:fixture.document,rounds:{}};await save();
 }
 const env={...process.env,HETU_DESKTOP_PROFILE:state.profile,HETU_PLUGIN_STATE_DIR:state.profile,HETU_LOCAL_SETTINGS_DIR:path.join(state.profile,"local-settings"),HETU_COLLABORATION_DIR:state.collaboration,HETU_PLUGIN_NODE:path.join(bin,"node"),HETU_PLUGIN_MANAGER:path.join(resources,"app/dist/plugin-manager.mjs")};delete env.ELECTRON_RUN_AS_NODE;
 const cli=(action:string,input:any,isolated=true)=>{
  const result=spawnSync(path.join(bin,"hetu"),["--client","codex",...isolated?["--collaboration-dir",state.collaboration]:[],"call",action,"--input","-","--json"],{input:JSON.stringify(input),encoding:"utf8",env:isolated?env:process.env,maxBuffer:32*1024*1024});
  const value=JSON.parse(result.stdout);expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data;
 };
 if(!state.packages){
  const installed=cli("hetu.plugins.inspect",{},false),packages=installed.packages.filter((pkg:any)=>ids.includes(pkg.manifest?.id));expect(packages).toHaveLength(2);
  state.packages=packages.map((pkg:any)=>({id:pkg.manifest.id,path:pkg.path,sha256:pkg.sha256,version:pkg.manifest.version}));await save();
 }
 if(!state.plugins_installed){
  for(const pkg of state.packages){
   const inspected=cli("hetu.plugins.inspect_package",{package_directory:pkg.path});expect(inspected.package_sha256).toBe(pkg.sha256);
   const actual=cli("hetu.plugins.inspect",{});
   if(!actual.packages.some((item:any)=>item.manifest?.id===pkg.id&&item.enabled&&item.sha256===pkg.sha256))cli("hetu.plugins.apply",{action:"install",plugin_id:pkg.id,package_directory:pkg.path,package_sha256:pkg.sha256,expected_sha256:actual.state_sha256,authorization_note:"隔离产品验收明确安装两款已核验专业包，不改变正常作者安装。",operation_key:"professional-gui-install-"+pkg.id});
  }
  state.plugins_installed=true;await save();
 }
 if(!state.baseline){
  const initial=state.seed_document;
  state.seed_command??={action:"hetu.documents.save",contract_revision:"1",input:{document_id:initial.document.document_id,base_revision_id:initial.revision.revision_id,source_format:"markdown",content:source,operation_key:"professional-gui-fixed-source"}};await save();
  const seeded=cli("hetu.execution.invoke",{workspace_path:state.workspace,command:state.seed_command});expect(seeded.result.status).toBe("succeeded");
  state.baseline=seeded.result.data;state.range={byte_start:Buffer.byteLength(opening),byte_end:Buffer.byteLength(opening+selection),quote:selection};await save();
 }
 let app:ElectronApplication|undefined,page:Page;
 const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get"));
 const read=async(action:string,input:any={})=>{
  if(action==="hetu.plugin_results.get"){
   const {sha256,...reference}=input;
   const value=cli("hetu.execution.invoke",{workspace_path:state.workspace,command:{action,contract_revision:"1",input:reference}});expect(value.result.status,JSON.stringify(value)).toBe("succeeded");if(sha256)expect(value.result.data.sha256).toBe(sha256);return value.result.data;
  }
  const result=await page.evaluate(({action,input})=>window.hetuDesktop.read(action,input),{action,input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;
 };
 const tasks=async()=>{const value=await page.evaluate(()=>window.hetuDesktop.tasks("list"));expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data.tasks;};
 const taskView=async(submission_id?:string)=>{
  const task=(await tasks()).find((item:any)=>item.task_ref.task_id===state.task_ref.task_id)?.task_ref;expect(task).toBeTruthy();
  const value=await page.evaluate(({task,submission_id})=>window.hetuDesktop.tasks("call",task,{name:"hetu_open_task_view",arguments:{task_ref:task,...submission_id?{submission_id}:{}}}),{task,submission_id});expect(value.structuredContent.status,JSON.stringify(value)).toBe("succeeded");return value.structuredContent.data;
 };
 const round=(key:string,text:string)=>liveAgentRound({page,get,rounds:state.rounds,save,prefix:"隔离专业组合验收"},key,text);
 async function open(){
  app=await electron.launch({...sourceDesktop?{args:[path.join(root,"apps/desktop")]}:{executablePath:executable,args:[]},env});page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});
  await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect.poll(()=>page.evaluate(async()=>(await window.hetuDesktop.state()).work)).toEqual(state.work);
  const preferences=await page.evaluate(()=>window.hetuDesktop.settings("preferences"));if(preferences.preferences.execution_mode!=="auto"||preferences.preferences.agent_session?.default_surface!=="gui")await page.evaluate(expected=>window.hetuDesktop.settings("update",{expected_revision:expected,patch:{execution_mode:"auto",agent_session:{default_surface:"gui"}}}),preferences.revision);
  await navigate(page,"Agent 协作");const dialog=page.getByRole("dialog",{name:"创建会话",exact:true});await expect.poll(async()=>await dialog.isVisible()||await page.locator(".agent-chat").isVisible()).toBe(true);
  if(await dialog.isVisible()){await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();await dialog.getByRole("button",{name:"打开聊天",exact:true}).click();await expect(dialog).toHaveCount(0,{timeout:60000});}
  await expect(page.locator(".agent-chat")).toBeVisible();await expect.poll(async()=>(await get()).state,{timeout:60000}).toBe("ready");await expect(page.locator(".codex-session-header").getByRole("status")).toHaveText("已连接");
  const snapshot=await get();if(state.thread_id){expect(snapshot.thread_id).toBe(state.thread_id);expect(snapshot.session_id).toBe(state.session_id);}else{state.thread_id=snapshot.thread_id;state.session_id=snapshot.session_id;await save();}
 }
 const boundary="这是隔离专业组合验收，所有意见只对测试材料有效，不是真实作者创作认可。只用当前河图MCP，禁止Shell、任意本机文件、网络、付费及图片工具，禁止采纳、定稿及修改正式正文。保留原作品、原任务、操作键及固定引用；unknown只查询原操作，不换键重发。专业方案与方法不能替代正文事实或扩大范围。";
 try{
  await open();
  const fixed={kind:"document",work_ref:state.work,document_id:state.baseline.document.document_id,revision_id:state.baseline.revision.revision_id,sha256:state.baseline.revision.sha256};
  const draftRequest=boundary+"\n任务：只精修固定小说原稿的指定中段，使动作与环境承载紧张，减少重复解释和套话；原稿开头、结尾、人物、第三封信及日期悬念保持。先发现执行模式、已启用的文风工坊与小说审校及准确Schema；本轮先读取文风工坊同包Skill及相关workflow／operations，能力目录摘要要沿原结果读取，不当作缺失。实际调用文风工坊创建专业方案、preview_refinement，随后用Core creative_tasks.preview_prompt返回的prepare_input创建唯一revision任务，brief固定‘GUI专业组合：第三封信’，通过working_copies保存并提交完整参考稿，不直接保存作者文稿。原稿固定引用="+JSON.stringify(fixed)+"，允许修改范围="+JSON.stringify(state.range)+"，workspace_path="+JSON.stringify(state.workspace)+"。候选除该选区外必须逐字节保持原稿，包括CRLF和Emoji；使用preview_refinement的真实完整输出，不凭记忆拼接。实际候选先由Core回读，再以其虚拟文稿证据加入原专业方案并调用verify_refinement、put_refinement保存真实核验。本次偏好仅用于当前试写，不自动建立长期active规则。操作键统一professional-gui-draft-前缀；已有同brief任务或方案就接续，不重建。完成后回读任务、候选及专业对象，报告真实引用并停止，暂不审校。";
  let drafted=await round("draft",draftRequest);
  if(!success(drafted,"hetu.creative_tasks.submit_result"))drafted=await round("draft-after-host-environment",boundary+"\n上轮已明确发现插件目录为空且没有业务写入。宿主现已修复MCP本机Owner目录绑定并重开原线程，请重新读取当前插件状态；能发现正确包后沿原请求继续。保留上轮结果，不重发未知写入，也不新建会话。\n"+draftRequest);
  const submitted=success(drafted,"hetu.creative_tasks.submit_result");expect(submitted,JSON.stringify(drafted.messages)).toBeTruthy();
  state.task_ref??=submitted.task_ref;state.original_submission??=submitted.submission_ref;await save();
  const original=await taskView(state.original_submission.submission_id),first=original.submission.candidates[0];expect(first.content.startsWith(opening)).toBe(true);expect(first.content.endsWith(ending)).toBe(true);expect(first.content).not.toBe(source);expect(first.working_copy_ref).toBeTruthy();state.first_candidate=first;await save();
  for(const action of ["preview_refinement","verify_refinement","put_refinement"])expect(success(drafted,`plugin:${ids[0]}:${action}`),action).toBeTruthy();
  expect(success(drafted,`plugin:${ids[0]}:verify_refinement`).verified).toBe(true);expect(success(drafted,`plugin:${ids[0]}:verify_refinement`).unchanged_outside).toBe(true);
  const reviewed=await round("review",boundary+"\n沿同一任务"+JSON.stringify(state.task_ref)+"的固定首批候选"+JSON.stringify(state.original_submission)+"做专业审校。读取小说审校同包Skill、workflow／operations及准确Schema；实际读取原稿与候选的固定证据，保存同一作品的专业报告并调用get_coverage及export_project回读。明确两条来源和source_indices，检查依据不能引用未登记来源。至少给出文风表达、连贯与人物行动的具体依据；设定、整书承诺和跨章历史材料不足时保持inconclusive／unchecked，不自动通过；不编造缺陷。不要修改、重新提交候选或正式稿，不创建其他创作任务。本轮操作键professional-gui-review-前缀，回读真正报告与覆盖后停止。");
  expect(success(reviewed,`plugin:${ids[1]}:get_coverage`)).toBeTruthy();const report=receipts(reviewed).filter(item=>item.action?.startsWith(`plugin:${ids[1]}:`)&&item.status==="succeeded"&&item.data?.object?.owner_plugin_id===ids[1]).at(-1)?.data;expect(report?.object).toBeTruthy();
  state.review_ref??={owner_plugin_id:ids[1],object_id:report.object.object_id,revision:report.object.revision,sha256:report.sha256};await save();
  const actualReport=await read("hetu.plugin_results.get",{work_ref:state.work,...state.review_ref});expect(actualReport.sha256).toBe(state.review_ref.sha256);expect(actualReport.object.source_refs.length).toBeGreaterThanOrEqual(2);expect(actualReport.object.content.checks.some((item:any)=>["canon","promises"].includes(item.domain)&&["inconclusive","unchecked"].includes(item.status))).toBe(true);
  if(!state.feedback_prompt){
   await page.getByRole("button",{name:"关闭终端面板",exact:true}).click();await navigate(page,"参考稿审核");await page.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(state.task_ref.task_id);
   const frame=page.frameLocator('iframe[title="任务候选审阅"]');await expect(frame.getByLabel("补充要求或意见",{exact:true})).toBeVisible();
   await frame.getByLabel("补充要求或意见",{exact:true}).fill("隔离QA意见：沿这份参考稿再改一次，只在原许可中段增加一次‘江岚将信推到灯下，封蜡擦过桌面的盐粒’的具体动作。删去为这次动作解释心理的句子，保持原开头、结尾、日期悬念和其他范围字节；不采纳或定稿。");await frame.getByRole("button",{name:"按此修改",exact:true}).click();
   const prompt=frame.getByLabel("继续提示词",{exact:true});await expect(prompt).toHaveValue(/feedback_/);state.feedback_prompt=await prompt.inputValue();await save();await frame.getByRole("button",{name:"放入当前草稿",exact:true}).click();await expect(page.locator(".agent-chat")).toBeVisible({timeout:60000});
  }
  const revised=await round("revise",boundary+"\n"+state.feedback_prompt+"\n只沿原任务和原working_copy返工，引用真实feedback_refs提交第二批候选。保持原文许可选区外字节，保留第一批和旧专业报告；实际调用文风工坊对新候选verify_refinement并保存新专业修订；小说审校对新固定候选核对具体动作及范围，保留旧报告版本，记录缺失覆盖。操作键professional-gui-revise-前缀。不要新建同义任务、工作副本或把一次QA意见变成长期规则。回读两批候选、公开意见及专业对象后停止。");
  const latest=await taskView(),second=latest.submission.candidates[0];expect(latest.submission.submission_id).not.toBe(state.original_submission.submission_id);expect(second.content).toContain("江岚将信推到灯下，封蜡擦过桌面的盐粒");expect(second.content.startsWith(opening)).toBe(true);expect(second.content.endsWith(ending)).toBe(true);expect(second.working_copy_ref.working_copy_id).toBe(first.working_copy_ref.working_copy_id);expect(latest.submission.feedback_refs.length).toBeGreaterThan(0);expect((await taskView(state.original_submission.submission_id)).submission.candidates[0].content).toBe(first.content);expect(success(revised,`plugin:${ids[0]}:verify_refinement`)).toBeTruthy();state.latest_submission=latest.submission.submission_id;await save();
  if(!state.reopened){await closeApplication(app!);app=undefined;await open();state.reopened=true;await save();}
  if(!state.plugins_disabled){for(const pkg of state.packages)await page.evaluate(id=>window.hetuDesktop.toggle(id,false),pkg.id);state.plugins_disabled=true;await save();}
  await round("retained",boundary+"\n两款专业插件已被隔离测试明确停用，不能执行或重新启用它们。请通过当前MCP重新读取插件状态，并用Core hetu.plugin_results.get读取这份旧固定报告"+JSON.stringify(state.review_ref)+"，沿原任务读取第一批"+JSON.stringify(state.original_submission)+"及当前第二批候选。确认旧引用仍解释旧稿、修改稿有指定动作，正式文稿仍为原固定版本。不得写入、创建任务或调用停用插件专业动作；只给出实际读取的身份、摘要和未覆盖范围。");
  if(!sourceDesktop){
   const probe=await round("installed-owner-check",boundary+"\n本轮已重开包含目录绑定修复的同版应用。只读取当前MCP的hetu.plugins.inspect，实际应发现文风工坊和小说审校两个已停用包；报告两个包的准确ID和摘要，不把停用当未安装。然后通过Core固定读取这份历史报告"+JSON.stringify(state.review_ref)+"，核对原摘要。严禁启用插件、专业执行或任何写入，不重做此前候选或模型轮次。");
   const inspectionReceipts=receipts(probe).filter(item=>item.action==="hetu.plugins.inspect"&&item.status==="succeeded");
   const inspected=inspectionReceipts.find(item=>typeof item.data?.state_directory==="string")?.data;expect(inspected?.state_directory).toBe(state.profile);expect(inspected.states.map((item:any)=>item.id).sort()).toEqual([...ids].sort());expect(inspected.states.every((item:any)=>item.installed&&item.state==="disabled")).toBe(true);
   if(inspected.packages){expect(inspected.packages).toHaveLength(2);for(const pkg of inspected.packages)expect(pkg.sha256).toBe(state.packages.find((item:any)=>item.id===pkg.manifest.id).sha256);}
   else{
    const views=inspectionReceipts.map(item=>item.data?.view).filter(view=>view?.page?.complete&&view.source_result_sha256===inspected.response.source_result_sha256),packages=new Map<string,any>();
    for(const view of views){const match=/^\/packages\/(\d+)\/(manifest\/id|sha256)$/.exec(view.result_path);if(match){const item=packages.get(match[1])??{};item[match[2]==="sha256"?"sha256":"id"]=view.page.content;packages.set(match[1],item);}}
    expect(packages.size).toBe(2);for(const item of packages.values())expect(item.sha256).toBe(state.packages.find((pkg:any)=>pkg.id===item.id)?.sha256);
   }
   const retained=success(probe,"hetu.plugin_results.get"),fixedReport=retained?.view?.value??retained;expect(fixedReport?.sha256).toBe(state.review_ref.sha256);expect(fixedReport?.object?.object_id).toBe(state.review_ref.object_id);expect(fixedReport?.object?.revision).toBe(state.review_ref.revision);
  }
  const current=await read("hetu.documents.get",{document_id:fixed.document_id});expect(current.content).toBe(source);expect(current.revision).toEqual(state.baseline.revision);expect(await tasks()).toHaveLength(1);expect((await read("hetu.plugin_results.get",{work_ref:state.work,...state.review_ref})).sha256).toBe(state.review_ref.sha256);
  expect(success(revised,`plugin:${ids[0]}:verify_refinement`).verified).toBe(true);expect(success(revised,`plugin:${ids[0]}:verify_refinement`).unchanged_outside).toBe(true);
  const prose=success(revised,`plugin:${ids[0]}:put_refinement`);expect(prose.object.content.rules.some((rule:any)=>rule.status==="active")).toBe(false);
  expect((await read("hetu.documents.list",{work_ref:state.work})).documents).toHaveLength(1);
  const lifecycle=await read("hetu.documents.lifecycle",{document_id:fixed.document_id});expect(lifecycle.adoptions??[]).toHaveLength(0);expect(lifecycle.finalizations??[]).toHaveLength(0);
  await page.screenshot({path:path.join(output,"professional-model-finished.png")});
  const results=await page.evaluate(()=>window.hetuDesktop.agentSession("results")),reportIndex=results.items.findIndex((item:any)=>item.kind==="plugin"&&item.reference.object_id===state.review_ref.object_id&&item.reference.revision===state.review_ref.revision);expect(reportIndex,JSON.stringify(results)).toBeGreaterThanOrEqual(0);expect(results.items[reportIndex].state).toBe("verified");
  const changes=page.getByRole("region",{name:"作品变更",exact:true});await changes.getByRole("button",{name:"核对成果",exact:true}).click();await expect(changes.locator(".codex-result")).toHaveCount(results.items.length,{timeout:30000});await changes.locator(".codex-result").nth(reportIndex).getByRole("button").click();
  const retainedView=page.getByRole("region",{name:"固定插件成果导出",exact:true});await expect(retainedView).toBeVisible({timeout:30000});await expect(retainedView).toContainText("inconclusive");await expect(page.getByRole("region",{name:"插件成果",exact:true})).toContainText("插件未启用");await page.screenshot({path:path.join(output,"professional-retained-report.png")});
  state.complete=true;state.retained_report_opened=true;delete state.failure;await save();
  await writeFile(path.join(root,"docs/research/evidence/professional-gui-model-2026-11-26.json"),JSON.stringify({date:"2026-11-26",installed:!sourceDesktop,work_ref:state.work,task_ref:state.task_ref,thread_id:state.thread_id,original_submission:state.original_submission,latest_submission:state.latest_submission,review_ref:state.review_ref,packages:state.packages.map(({id,version,sha256}:any)=>({id,version,sha256})),rounds:Object.keys(state.rounds),fixed_outside_bytes_preserved:true,formal_unchanged:true,same_working_copy:true,old_candidate_preserved:true,old_report_read_after_disable:true,adoptions:0,finalizations:0,limits:["isolated QA source and explicit QA feedback","actual plugin operations and fixed readback, not a literary-quality certification","macOS arm64 installed development build; no other platforms or native Codex Desktop host"]},null,2)+"\n");
 }catch(error){state.failure=String(error);if(page!)state.last_snapshot=await get().catch(()=>undefined);await save();await page!?.screenshot({path:path.join(output,"failure.png")}).catch(()=>{});throw error;}
 finally{if(app)await closeApplication(app);}
});
