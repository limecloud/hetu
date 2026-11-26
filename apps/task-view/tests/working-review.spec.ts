import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost,type WorkbenchSurface} from "./workbench-host.ts";

for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 尚未提交工作稿可读，历史原位意见沿原副本返工`,async({page},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");test.setTimeout(180000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-working-review-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const seeded=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.error?.message??seeded.stderr).toBe(0);const work=JSON.parse(seeded.stdout).novel;
 const core=await AppServer.open(process.env.HETU_PACKAGED_APP?path.resolve(process.env.HETU_PACKAGED_APP,"../../Resources/bin/hetu-app-server"):path.join(root,"target/debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const baseline=(await call("hetu.documents.list",{work_ref:work})).documents[0],before=await call("hetu.documents.get",{document_id:baseline.document_id});
 const preview=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"工作稿持续阅读与原任务返工",input_refs:[],client_adapter:"codex",language_tag:"zh-CN"});
 const task=await call("hetu.creative_tasks.prepare",{...preview.prepare_input,operation_key:"working-task"}),content=Array.from({length:900},(_,index)=>`第${index+1}段 江岚核对来信🌿，保留第一版的叙述。`).join("\r\n\r\n");
 const copies=[];for(let index=0;index<21;index++)copies.push(await call("hetu.working_copies.create",{task_ref:task.task_ref,artifact_kind:"text",source_format:"markdown",title:index===0?"雾港工作稿":`其他工作稿${index}`,content:index===0?content:"其他已保存稿。",base_refs:[],operation_key:`working-${index}`}));
 const first=copies[0],second=await call("hetu.working_copies.save",{task_ref:task.task_ref,working_copy_id:first.working_copy_ref.working_copy_id,expected:first.working_copy_ref,content:content+"\r\n第二版结尾。",feedback_refs:[],operation_key:"working-second"});
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"工作稿验收"}]}]}));
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_ACCESS_DIR:path.join(folder,"access"),HETU_COLLABORATION_DIR:collaboration,...(!process.env.HETU_PACKAGED_APP?{HETU_PLUGIN_NODE:process.execPath}:{})};
 let failMore=true,failPage=false,dropFeedback=true;const cursors:string[]=[],readingCalls:any[]=[];
 const host=await openWorkbenchHost(surface,page,env,async(method,args,run)=>{
  const tool=method==="tasks"&&args[0]==="call"?args[2]:undefined;
  if(tool?.name==="hetu_read_working_copy")readingCalls.push({detail:tool.arguments.detail,result_path:tool.arguments.result_path});
  if(tool?.name==="hetu_list_working_copies"){cursors.push(tool.arguments.cursor);if(failMore){failMore=false;throw Error("隔离验收：工作稿目录读取中断。");}}
  if(tool?.name==="hetu_read_working_copy"&&tool.arguments.detail==="page"&&failPage){failPage=false;throw Error("隔离验收：原工作稿正文读取中断。");}
  const result=await run();
  if(tool?.name==="hetu_save_task_feedback"&&dropFeedback){dropFeedback=false;throw Error("隔离验收：意见已保存，回执中断。");}
  return result;
 });page=host.page;const view=host.view;

 try{
  if(host.app)await host.app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:tasks"),state=globalThis as any;state.__working={failMore:true,failPage:false,dropFeedback:true,cursors:[],readingCalls:[]};handlers.set("desktop:tasks",async(event:any,method:string,...args:any[])=>{
   const tool=method==="call"?args[1]:undefined,value=state.__working;
   if(tool?.name==="hetu_read_working_copy")value.readingCalls.push({detail:tool.arguments.detail,result_path:tool.arguments.result_path});
   if(tool?.name==="hetu_list_working_copies"){value.cursors.push(tool.arguments.cursor);if(value.failMore){value.failMore=false;throw Error("隔离验收：工作稿目录读取中断。");}}
   if(tool?.name==="hetu_read_working_copy"&&tool.arguments.detail==="page"&&value.failPage){value.failPage=false;throw Error("隔离验收：原工作稿正文读取中断。");}
   const result=await original(event,method,...args);
   if(tool?.name==="hetu_save_task_feedback"&&value.dropFeedback){value.dropFeedback=false;throw Error("隔离验收：意见已保存，回执中断。");}return result;
  });});
  await page.setViewportSize({width:1440,height:960});await view.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(view.locator(".work-profile")).toBeVisible();await navigate(view,"参考稿审核");await view.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(task.task_ref.task_id);
  const panel=view.frameLocator('iframe[title="任务候选审阅"]'),working=panel.getByRole("region",{name:"工作稿",exact:true}),opinion=panel.getByLabel("补充要求或意见",{exact:true});await expect(working).toBeVisible({timeout:30000});await expect(panel.getByText(/^暂未收到参考方案/)).toHaveCount(0);
  const selector=working.getByRole("combobox",{name:"选择工作稿",exact:true});await expect(selector.locator("option")).toHaveCount(20);await working.getByRole("button",{name:"更多工作稿",exact:true}).click();await expect(working.getByRole("alert")).toContainText("工作稿目录读取中断");await expect(selector.locator("option")).toHaveCount(20);
  await working.getByRole("button",{name:"重试读取工作稿",exact:true}).click();await expect(selector.locator("option")).toHaveCount(21);const requestedCursors=host.app?await host.app.evaluate(()=>(globalThis as any).__working.cursors):cursors;expect(requestedCursors).toHaveLength(2);expect(requestedCursors[1]).toBe(requestedCursors[0]);await selector.selectOption(first.working_copy_ref.working_copy_id);
  const readStarted=Date.now();await working.getByRole("button",{name:"读取工作稿",exact:true}).click();await expect(working.locator(".reference-content")).toContainText("第1段");const firstReadMs=Date.now()-readStarted;await expect(working.getByText("尚未提交",{exact:true})).toBeVisible();
  const firstReads=host.app?await host.app.evaluate(()=>(globalThis as any).__working.readingCalls):readingCalls;expect(firstReads.map((item:any)=>item.detail)).toEqual(["summary","page"]);expect(firstReads.every((item:any)=>item.result_path===undefined)).toBe(true);

  await working.getByRole("button",{name:"对整份工作稿提意见",exact:true}).click();await opinion.fill("整稿保留灯塔，只调整结尾。");await panel.getByRole("button",{name:"保存工作稿意见",exact:true}).click();await expect(panel.locator("#status")).toContainText("保存结果尚未确认");await panel.getByRole("button",{name:"查询原保存结果",exact:true}).click();await expect(panel.locator("#status")).toContainText("修改意见已保存");
  let history=await call("hetu.task_feedback.list",{task_ref:task.task_ref});expect(history.feedback).toHaveLength(1);expect(history.feedback[0].feedback.target_refs).toEqual([{kind:"working_copy",working_copy_ref:second.working_copy_ref}]);
  await opinion.fill("未保存的补充不能因换历史而丢失。");
  await call("hetu.working_copies.save",{task_ref:task.task_ref,working_copy_id:first.working_copy_ref.working_copy_id,expected:second.working_copy_ref,content:content+"\r\n第三版不能替换旧稿。",feedback_refs:[],operation_key:"working-third"});
  const version=working.getByRole("combobox",{name:"工作稿修订",exact:true});await version.selectOption(first.working_copy_ref.working_revision_id);await expect(opinion).toHaveValue("未保存的补充不能因换历史而丢失。");await expect(version).toHaveValue(first.working_copy_ref.working_revision_id);
  await working.getByRole("button",{name:"读取参考稿",exact:true}).click();await expect(working.locator(".reference-content")).toContainText("第1段");await expect(opinion).toBeEnabled();
  if(host.app)await host.app.evaluate(()=>(globalThis as any).__working.failPage=true);else failPage=true;
  await working.getByRole("button",{name:"下一页",exact:true}).click();await expect(working.getByRole("alert")).toContainText("正文读取中断");await expect(working.locator(".reference-content")).toContainText("第1段");await expect(opinion).toHaveValue("未保存的补充不能因换历史而丢失。");
  await working.getByRole("button",{name:"重新读取参考稿",exact:true}).click();await expect(working.getByRole("group",{name:"参考稿读取范围",exact:true})).toContainText("第2页");await expect(opinion).toBeEnabled();
  await working.locator(".reader").evaluate(reader=>{const span=Array.from(reader.querySelectorAll<HTMLElement>("[data-source-from]")).find(span=>span.textContent?.includes("来信🌿"))!,start=span.textContent!.indexOf("来信🌿"),range=document.createRange();range.setStart(span.firstChild!,start);range.setEnd(span.firstChild!,start+"来信🌿".length);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);reader.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));});
  await working.getByRole("button",{name:"对此处提意见",exact:true}).click();await panel.getByRole("button",{name:"保存位置意见",exact:true}).click();await expect(panel.locator("#status")).toContainText("修改意见已保存");
  history=await call("hetu.task_feedback.list",{task_ref:task.task_ref});expect(history.feedback).toHaveLength(2);const fixed=history.feedback[1],target=fixed.feedback.target_refs[0];expect(target.working_copy_ref).toEqual(first.working_copy_ref);expect(target.range.byte_start).toBeGreaterThan(0);expect(Buffer.from(content).subarray(target.range.byte_start,target.range.byte_end).toString()).toBe("来信🌿");
  const current=await call("hetu.working_copies.get",{task_ref:task.task_ref,working_copy_ref:first.working_copy_ref,detail:"summary"});
  const revised=await call("hetu.working_copies.save",{task_ref:task.task_ref,working_copy_id:first.working_copy_ref.working_copy_id,expected:current.current_revision_ref,content:"江岚按旧版来信🌿继续，保留灯塔与结尾。",feedback_refs:[fixed.feedback_ref],operation_key:"working-revised"});
  await call("hetu.creative_tasks.submit_result",{task_ref:task.task_ref,request_sha256:task.request_sha256,working_copy_refs:[revised.working_copy_ref],feedback_refs:[fixed.feedback_ref],complete:true,missing_items:[],provenance:{client:"working-review-test",skill_version:"1"},operation_key:"working-submit"});
  expect((await call("hetu.working_copies.get",{task_ref:task.task_ref,working_copy_ref:first.working_copy_ref})).revision.content).toBe(content);expect((await call("hetu.documents.get",{document_id:baseline.document_id})).revision).toEqual(before.revision);
  await expect(selector).toHaveValue(first.working_copy_ref.working_copy_id);await expect(selector.locator("option:checked")).toHaveText("雾港工作稿");
  await working.evaluate(element=>element.scrollIntoView({block:"start"}));await page.screenshot({path:info.outputPath("working-review.png")});
  await page.setViewportSize({width:760,height:900});await view.locator("body").evaluate(async()=>{const current=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:current.revision,patch:{appearance:"dark"}});});await expect(panel.locator("#app")).toHaveCSS("color-scheme","dark");expect(await panel.locator("body").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath("working-review-dark-narrow.png")});
  await writeFile(info.outputPath("result.json"),JSON.stringify({surface,working_copies:21,feedback:2,first_read_ms:firstReadMs,first_read_calls:2,pagination_retry_same_cursor:true,read_failure_keeps_page:true,unknown_save_recovered_once:true,old_working_ref:true,selected_copy_visible_after_save:true,narrow_no_overflow:true,same_working_copy:true,author_document_unchanged:true,model_turns:0},null,2));
 }finally{await core.close();await host.close("app");}
});
