import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {sampleImage} from "../../desktop/tests/fixtures/media.ts";
import {PluginPackage} from "../../../packages/plugin-host/src/package.ts";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost,type WorkbenchSurface} from "./workbench-host.ts";

for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 图片意见冲突保留输入和区域，重开后沿确切旧意见接续`,async({page},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");test.setTimeout(180000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-feedback-continuation-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration"),access=path.join(folder,"access"),source=path.join(folder,"source.png");
 const image=sampleImage(),pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));await writeFile(source,image);
 const seeded=spawnSync(path.join(root,"target/debug/examples/plugin_fixture"),[workspace,access,path.join(pkg.source,"plugin.json"),pkg.sha256,"0","--artwork",source,createHash("sha256").update(image).digest("hex")],{encoding:"utf8"});expect(seeded.status,seeded.error?.message??seeded.stderr).toBe(0);
 const refs=JSON.parse(seeded.stdout),task=refs.artwork.task_ref,batch=refs.artwork.submission_id;
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.work_ref.workspace_id,works:[{work_ref:refs.work_ref,title:"意见接续验收"}]}]}));
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_ACCESS_DIR:access,HETU_COLLABORATION_DIR:collaboration,...(!process.env.HETU_PACKAGED_APP?{HETU_PLUGIN_NODE:process.execPath}:{})};
 const core=await AppServer.open(process.env.HETU_PACKAGED_APP?path.resolve(process.env.HETU_PACKAGED_APP,"../../Resources/bin/hetu-app-server"):path.join(root,"target/debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const original=await call("hetu.interactions.get",{task_ref:task,submission_id:batch}),candidate=original.submission.candidates[0];
 let head:any=null;
 async function save(comment:string,x:number){const result=await call("hetu.task_feedback.save",{task_ref:task,target_refs:[{kind:"candidate",candidate_ref:{task_ref:task,submission_id:batch,candidate_id:candidate.candidate_id},image_region:{x,y:9,width:20,height:30}}],expected_feedback_head:head,intent:"request_changes",public_comment:comment,selected_refs:[],operation_key:`continuation-${x}`});head=result.feedback_ref;return head;}
 const first=await save("第一条原图意见，保留衣领。",4);await save("后来的意见，不替换第一条。",7);
 const revised=structuredClone(refs.artwork.submit_input);revised.operation_key="continuation-new-batch";revised.candidates[0].title="新版接续人物";await call("hetu.creative_tasks.submit_result",revised);
 await page.addInitScript(value=>Object.assign(window,value),{testMessages:surface==="codex",testExtensions:surface==="codex"});
 let failRead=false,copied="",continuations=0;
 const host=await openWorkbenchHost(surface,page,env,async(method,args,run)=>{
  if(method==="copy"){copied=args[0];return {content:[],structuredContent:{value:null,events:[]}};}
  if(method==="tasks"&&args[0]==="continuation")continuations++;
  if(method==="tasks"&&args[0]==="call"&&args[2]?.name==="hetu_open_task_view"&&failRead){failRead=false;throw Error("隔离验收：当前批次读取中断。");}
  return run();
 });page=host.page;const view=host.view;
 try{
  if(host.app)await host.app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:tasks"),state=globalThis as any;state.__continuations=0;handlers.set("desktop:tasks",async(event:any,method:string,...args:any[])=>{
   if(method==="continuation")state.__continuations++;
   if(method==="call"&&args[1]?.name==="hetu_open_task_view"&&state.__failContinuationRead){state.__failContinuationRead=false;throw Error("隔离验收：当前批次读取中断。");}
   return original(event,method,...args);
  });});
  await page.setViewportSize({width:1440,height:960});await view.getByRole("button",{name:"打开作品 插件集成测试",exact:true}).click();await expect(view.locator(".work-profile")).toBeVisible();await navigate(view,"图片成果");
  const detail=view.getByRole("dialog",{name:"固定图片详情",exact:true});
  async function open(){await view.getByRole("button",{name:/新版接续人物/}).click();const version=detail.getByRole("combobox",{name:"图片版本",exact:true});await expect(version).toBeEnabled();await version.selectOption(batch);await expect(version).toBeEnabled();await expect(version).toHaveValue(batch);}
  await open();await expect(detail.locator(".image-region-position")).toContainText("7, 9");
  await detail.getByRole("button",{name:"标记区域",exact:true}).click();await detail.getByRole("group",{name:"图片意见区域",exact:true}).press("ArrowRight");await expect(detail.locator(".image-region-position")).toContainText("8, 9");
  const comment=detail.getByRole("textbox",{name:"图片修改意见",exact:true}),saveButton=detail.getByRole("button",{name:"按此修改",exact:true}),reload=detail.getByRole("button",{name:"重新读取当前批次",exact:true});
  await comment.fill("我的意见和区域不能被并发更新覆盖。🌿");await save("另一个窗口追加的意见。",11);await saveButton.click();await expect(detail.getByRole("alert")).toContainText("已有新的公开意见");await expect(reload).toBeEnabled();await expect(saveButton).toBeDisabled();
  await expect(comment).toHaveValue("我的意见和区域不能被并发更新覆盖。🌿");await expect(detail.locator(".image-region-position")).toContainText("8, 9");
  await detail.screenshot({path:info.outputPath("conflict-preserved.png")});
  if(host.app)await host.app.evaluate(()=>{(globalThis as any).__failContinuationRead=true;});else failRead=true;
  await reload.click();await expect(detail.getByRole("alert")).toContainText("当前批次读取中断");await expect(reload).toBeEnabled();await expect(comment).toHaveValue("我的意见和区域不能被并发更新覆盖。🌿");
  await reload.click();await expect(saveButton).toBeEnabled();await expect(detail.locator(".image-region-position")).toContainText("8, 9");await saveButton.click();await expect(comment).toHaveValue("");await expect(comment).toBeEnabled();
  const saved=await call("hetu.task_feedback.list",{task_ref:task});expect(saved.feedback).toHaveLength(4);expect(saved.feedback[3].feedback.public_comment).toBe("我的意见和区域不能被并发更新覆盖。🌿");expect(saved.feedback[3].feedback.target_refs).toHaveLength(1);expect(saved.feedback[3].feedback.target_refs[0].image_region).toEqual({x:8,y:9,width:20,height:30});
  await detail.getByRole("button",{name:"关闭图片详情",exact:true}).click();await expect(detail).toHaveCount(0);await open();await detail.getByText("全部意见",{exact:true}).click();
  const history=detail.getByRole("region",{name:"公开意见历史",exact:true}),old=history.getByRole("article",{name:"意见 1",exact:true});await expect(old).toContainText("第一条原图意见");
  await old.getByRole("button",{name:"查看原位置",exact:true}).click();await expect(detail.locator(".image-region-position")).toContainText("4, 9");
  await detail.screenshot({path:info.outputPath("old-feedback-before-continuation.png")});
  if(surface==="stdio"){
   await expect(old.getByRole("button",{name:"放入当前草稿",exact:true})).toHaveCount(0);await old.getByRole("button",{name:"复制继续提示词",exact:true}).click();await expect(detail.getByRole("status").filter({hasText:"已复制继续提示词"})).toBeVisible();expect(copied).toContain(first.feedback_id);expect(copied).not.toContain(saved.feedback_head.feedback_id);expect(await page.evaluate(()=>window.harness.messages)).toHaveLength(0);
  }else{
   await old.getByRole("button",{name:"放入当前草稿",exact:true}).click();
   if(host.app){
    await expect(detail).toHaveCount(0,{timeout:45000});const session=await page.evaluate(work=>window.hetuDesktop.agentSession("get",{work_ref:work}),refs.work_ref);expect(session.draft).toContain(first.feedback_id);expect(session.draft).not.toContain(saved.feedback_head.feedback_id);expect(session.messages).toHaveLength(0);expect(session.send_attempt).toBeUndefined();expect(session.requests??[]).toHaveLength(0);
   }else{
    await expect(detail.getByRole("status").filter({hasText:"已放入当前草稿，尚未发送"})).toBeVisible();const messages=await page.evaluate(()=>window.harness.wireMessages);expect(messages).toHaveLength(1);expect(JSON.stringify(messages)).toContain(first.feedback_id);expect(JSON.stringify(messages)).not.toContain(saved.feedback_head.feedback_id);expect(messages[0]).toMatchObject({_meta:{"openai/message":{target:"active",send:false}}});
   }
  }
  expect(host.app?await host.app.evaluate(()=>(globalThis as any).__continuations):continuations).toBe(1);
  const final=await call("hetu.task_feedback.list",{task_ref:task});expect(final.feedback).toHaveLength(4);expect(final.feedback[0].feedback_ref).toEqual(first);expect(final.feedback.every((entry:any)=>entry.author_acceptance==="not_implied")).toBe(true);
  await page.screenshot({path:info.outputPath("continued-old-feedback.png")});await writeFile(info.outputPath("result.json"),JSON.stringify({surface,conflict_preserved:true,reload_failure_retry:true,feedback_count:4,old_feedback_selected:true,model_turns:0,duplicate_feedback:0},null,2));
 }finally{await core.close();await host.close("app");}
});
