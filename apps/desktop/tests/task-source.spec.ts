import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {AppServer} from "../src/main/rpc.ts";
import {navigate,closeApplication} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../..");

test("桌面固定来源显示去重覆盖，原范围重试和返回不改正式稿，离开隔离迟到回包",async({},info)=>{
 test.setTimeout(180000);
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-desktop-source-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const seeded=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);
 const work=JSON.parse(seeded.stdout).novel,core=await AppServer.open(path.join(root,"target/debug/hetu-app-server"),workspace);
 let task:any,fixed:any,advanced:any;
 try{
  const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,contract_revision:"1",input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
  const docs=await call("hetu.documents.list",{work_ref:work}),before=await call("hetu.documents.get",{document_id:docs.documents[0].document_id});
  const content=Array.from({length:1100},(_,index)=>`第${index+1}段 江岚在灯塔核对来信🌿。`).join("\r\n\r\n");
  fixed=await call("hetu.documents.save",{document_id:before.document.document_id,base_revision_id:before.revision.revision_id,source_format:"markdown",content,operation_key:"desktop-text-source"});
  const preview=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"核对旧版来信的固定来源，不采纳或修改正式稿。",input_refs:[{kind:"document",document_id:fixed.document.document_id,revision_id:fixed.revision.revision_id}],client_adapter:"codex",language_tag:"zh-CN"});
  task=await call("hetu.creative_tasks.prepare",{...preview.prepare_input,operation_key:"desktop-text-task"});
  advanced=await call("hetu.documents.save",{document_id:fixed.document.document_id,base_revision_id:fixed.revision.revision_id,source_format:"markdown",content:content+"\r\n新版不替换固定原文。",operation_key:"desktop-text-advance"});
 }finally{await core.close();}
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"默认小说"}]}]}));
 const executable=process.env.HETU_PACKAGED_APP;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_ACCESS_DIR:path.join(folder,"access"),HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_CODEX_BIN:path.join(folder,"no-agent"),...(!executable?{HETU_PLUGIN_NODE:process.execPath,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
 try{
  const page=await app.firstWindow();await page.setViewportSize({width:1200,height:850});await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(page.getByRole("heading",{name:"作品资料",exact:true})).toBeVisible();
  await navigate(page,"参考稿审核");await page.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(task.task_ref.task_id);
  const view=page.frameLocator('iframe[title="任务候选审阅"]'),source=view.getByRole("region",{name:fixed.document.title,exact:true}),coverage=source.getByRole("group",{name:"原文读取范围",exact:true}),opinion=view.getByLabel("补充要求或意见",{exact:true});
  await view.getByText("查看固定参考资料（只读）",{exact:true}).click();await source.getByRole("button",{name:"读取原文",exact:true}).click();
  await expect(coverage).toContainText("第1页");await expect(coverage).not.toContainText("全文已载入");await expect(source.locator(".reference-content")).toContainText("第1段");await opinion.fill("保留旧版依据，读完再判断。");
  await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:tasks"),state=globalThis as any;state.__sourceReads=[];handlers.set("desktop:tasks",async(event:any,method:string,...args:any[])=>{
   state.__taskMethods??=[];state.__taskMethods.push({method,tool:method==="call"?args[1]?.name:undefined,at:performance.now()});
   const sourceRead=method==="call"&&args[1]?.name==="hetu_read_task_context";
   if(sourceRead){state.__sourceReads.push(args[1].arguments);if(state.__failSource){state.__failSource=false;throw Error("隔离验收：原文暂不可读。");}}
   const result=await original(event,method,...args);
   if(sourceRead&&state.__holdSource){state.__holdSource=false;await new Promise<void>(resolve=>state.__releaseSource=resolve);}
   return result;
  });state.__failSource=true;});
  await source.getByRole("button",{name:"下一页",exact:true}).focus();await page.keyboard.press("Enter");
  await expect(source.getByRole("alert")).toContainText("原文暂不可读");await expect(coverage).toContainText("第1页");await expect(opinion).toHaveValue("保留旧版依据，读完再判断。");
  const retry=source.getByRole("button",{name:"重新读取原文",exact:true});await retry.focus();await page.keyboard.press("Enter");await expect(coverage).toContainText("第2页");await expect(source.getByRole("alert")).toHaveCount(0);
  const calls=await app.evaluate(()=>(globalThis as any).__sourceReads);expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);
  const loaded=(await coverage.innerText()).match(/已载入\s+\d+%/)![0];await source.getByRole("button",{name:"上一页",exact:true}).click();await expect(coverage).toContainText("第1页");await expect(coverage).toContainText(loaded);
  await source.getByRole("button",{name:"下一页",exact:true}).focus();await page.keyboard.press("Enter");await expect(coverage).toContainText("第2页");await expect(source.getByRole("button",{name:"下一页",exact:true})).toBeFocused();
  let pages=0;while(await source.getByRole("button",{name:"下一页",exact:true}).count()){expect(++pages).toBeLessThan(20);await source.getByRole("button",{name:"下一页",exact:true}).click();await expect(opinion).toBeEnabled();}
  await expect(coverage).toContainText("全文已载入");await expect(source.locator(".reference-content")).toContainText("第1100段");await expect(source).not.toContainText("新版不替换固定原文");
  for(const [width,theme] of [[1200,"light"],[800,"dark"]] as const){
   await page.setViewportSize({width,height:850});await page.emulateMedia({colorScheme:theme});await source.evaluate(element=>element.scrollIntoView({block:"start"}));
   expect(await view.locator("body").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await expect(coverage).toContainText("全文已载入");await page.screenshot({path:info.outputPath(`source-${theme}-${width}.png`)});
  }
  // 同一桌面桥接保存确切页中的意见，来源仍只读；不是把页内偏移当全文偏移。
  await source.locator(".reader").evaluate(reader=>{
   const span=Array.from(reader.querySelectorAll<HTMLElement>("[data-source-from]")).find(span=>span.textContent?.includes("来信🌿"))!,start=span.textContent!.indexOf("来信🌿"),range=document.createRange();
   range.setStart(span.firstChild!,start);range.setEnd(span.firstChild!,start+"来信🌿".length);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);reader.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));
  });
  await source.getByRole("button",{name:"对此处提意见",exact:true}).click();await expect(view.getByRole("region",{name:"意见所指原文",exact:true})).toContainText("来信🌿");
  await view.locator("body").evaluate(()=>{
   const state=window as any;state.__feedbackEvents=[];
   for(const type of ["pointerdown","pointerup","click"])document.addEventListener(type,event=>{const button=(event.target as Element)?.closest("button");if(button?.id==="request-changes")state.__feedbackEvents.push({type,disabled:button.disabled,connected:button.isConnected,at:performance.now()});},true);
  });
  await opinion.fill("沿这句来信继续参考稿，原文不改。");
  const saveFeedback=view.getByRole("button",{name:"保存位置意见",exact:true});await expect(saveFeedback).toBeEnabled();await saveFeedback.click();
  const diagnostic=info.outputPath("position-feedback-events.json");
  await writeFile(diagnostic,JSON.stringify({events:await view.locator("body").evaluate(()=>(window as any).__feedbackEvents),calls:await app.evaluate(()=>(globalThis as any).__taskMethods)},null,2)+"\n");
  await info.attach("位置意见点击与宿主调用",{path:diagnostic,contentType:"application/json"});
  await expect(view.getByRole("status")).toContainText("修改意见已保存");
  await expect(view.getByRole("region",{name:"已保存的位置意见",exact:true})).toContainText("来信🌿");
  const reader=await AppServer.open(path.join(root,"target/debug/hetu-app-server"),workspace);
  try{
   const result=await reader.request("workspace/request",{action:"hetu.task_feedback.list",contract_revision:"1",input:{task_ref:task.task_ref}});expect(result.status,JSON.stringify(result)).toBe("succeeded");expect(result.data.feedback).toHaveLength(1);
   const target=result.data.feedback[0].feedback.target_refs[0];expect(target.kind).toBe("context");expect(target.range.byte_start).toBeGreaterThan(0);expect(target.range.quote).toBe("来信🌿");
   expect(target.context_ref.sha256).toBe(task.request.input_snapshot.sources[0].sha256);
  }finally{await reader.close();}
  const unchanged=await page.evaluate(document_id=>window.hetuDesktop.read("hetu.documents.get",{document_id}),fixed.document.document_id);expect(unchanged.data.revision).toEqual(advanced.revision);
  await app.evaluate(()=>{(globalThis as any).__holdSource=true;});await source.getByRole("button",{name:"上一页",exact:true}).click();await expect.poll(()=>app.evaluate(()=>typeof(globalThis as any).__releaseSource)).toBe("function");
  await navigate(page,"作品资料");await app.evaluate(()=>(globalThis as any).__releaseSource());await expect(page.getByRole("heading",{name:"作品资料",exact:true})).toBeVisible();await expect(page.locator('iframe[title="任务候选审阅"]')).toHaveCount(0);
  await navigate(page,"参考稿审核");await page.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(task.task_ref.task_id);await view.getByText("查看固定参考资料（只读）",{exact:true}).click();await expect(coverage).toHaveCount(0);await expect(source.getByRole("button",{name:"读取原文",exact:true})).toBeEnabled();await expect(view.getByRole("region",{name:"已保存的位置意见",exact:true})).toContainText("沿这句来信继续参考稿");
  expect((await page.evaluate(document_id=>window.hetuDesktop.read("hetu.documents.get",{document_id}),fixed.document.document_id)).data.revision).toEqual(advanced.revision);
 }finally{await closeApplication(app,"window");}
});
