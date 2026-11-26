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

for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 全部公开意见保留原图片位置，分页失败和并发不混合历史`,async({page},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");test.setTimeout(180000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-feedback-history-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration"),access=path.join(folder,"access"),source=path.join(folder,"source.png");
 const image=sampleImage(),pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));await writeFile(source,image);
 const seeded=spawnSync(path.join(root,"target/debug/examples/plugin_fixture"),[workspace,access,path.join(pkg.source,"plugin.json"),pkg.sha256,"0","--artwork",source,createHash("sha256").update(image).digest("hex")],{encoding:"utf8"});expect(seeded.status,seeded.error?.message??seeded.stderr).toBe(0);
 const refs=JSON.parse(seeded.stdout),task=refs.artwork.task_ref,batch=refs.artwork.submission_id;
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.work_ref.workspace_id,works:[{work_ref:refs.work_ref,title:"意见历史验收"}]}]}));
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_ACCESS_DIR:access,HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_NODE:process.execPath};
 const core=await AppServer.open(process.env.HETU_PACKAGED_APP?path.resolve(process.env.HETU_PACKAGED_APP,"../../Resources/bin/hetu-app-server"):path.join(root,"target/debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const original=await call("hetu.interactions.get",{task_ref:task,submission_id:batch});
 const first=original.submission.candidates[0],other=original.submission.candidates[1];
 let head:any=null;
 async function save(sequence:number,current:boolean){
  const target={kind:"candidate",candidate_ref:{task_ref:task,submission_id:batch,candidate_id:current?first.candidate_id:other.candidate_id},image_region:{x:sequence,y:5,width:20,height:30}};
  const saved=await call("hetu.task_feedback.save",{task_ref:task,target_refs:[target],expected_feedback_head:head,intent:"request_changes",public_comment:current?`原图第${sequence}处衣领意见。🌿${sequence===11?"保留衣领纹理。".repeat(500):""}`:`侧面第${sequence}处意见。${"保留侧面衣纹。".repeat(500)}`,selected_refs:[],operation_key:`history-feedback-${sequence}`});head=saved.feedback_ref;return head;
 }
 const initial=await save(1,true);await save(2,true);
 const next=structuredClone(refs.artwork.submit_input);next.operation_key="history-return";next.feedback_refs=[initial];next.candidates[0].title="返稿人物";await call("hetu.creative_tasks.submit_result",next);
 for(let i=3;i<=22;i++)await save(i,i===11||i>=13);
 let fail=false,failRefresh=false,reads=0,writes=0,hold=false,held=false,release:(()=>void)|undefined;
 const host=await openWorkbenchHost(surface,page,env,async(method,args,run)=>{
  if(method==="tasks"&&args[0]==="call"){
   if(args[2]?.name==="hetu_save_task_feedback")writes++;
   if(args[2]?.name==="hetu_list_task_feedback"){
    reads++;if(args[2].arguments?.after_cursor&&fail){fail=false;throw Error("隔离验收：意见分页读取中断。");}
    if(!args[2].arguments?.after_cursor&&failRefresh){failRefresh=false;throw Error("隔离验收：重新读取中断。");}
    if(hold){hold=false;const result=await run();held=true;await new Promise<void>(resolve=>{release=resolve;});return result;}
   }
  }
  return run();
 });page=host.page;const view=host.view;
 try{
  if(host.app)await host.app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:tasks"),state=globalThis as any;state.__historyReads=0;state.__historyWrites=0;
   handlers.set("desktop:tasks",async(event:any,method:string,ref:any,input:any)=>{
    if(method==="call"&&input?.name==="hetu_save_task_feedback")state.__historyWrites++;
    if(method==="call"&&input?.name==="hetu_list_task_feedback"){
     state.__historyReads++;if(input.arguments?.after_cursor&&state.__failHistoryPage){state.__failHistoryPage=false;throw Error("隔离验收：意见分页读取中断。");}
     if(!input.arguments?.after_cursor&&state.__failHistoryRefresh){state.__failHistoryRefresh=false;throw Error("隔离验收：重新读取中断。");}
     if(state.__holdHistoryOnce){state.__holdHistoryOnce=false;const result=await original(event,method,ref,input);state.__historyHeld=true;await new Promise<void>(resolve=>{state.__releaseHistory=resolve;});return result;}
    }
    return original(event,method,ref,input);
   });
  });
  await page.setViewportSize({width:1440,height:960});await view.getByRole("button",{name:"打开作品 插件集成测试",exact:true}).click();await expect(view.locator(".work-profile")).toBeVisible();await navigate(view,"图片成果");await view.getByRole("button",{name:/返稿人物/}).click();
  const detail=view.getByRole("dialog",{name:"固定图片详情",exact:true}),version=detail.getByRole("combobox",{name:"图片版本",exact:true});await version.selectOption(batch);await expect(version).toBeEnabled();await expect(version).toHaveValue(batch);
  const history=detail.getByRole("region",{name:"公开意见历史",exact:true,includeHidden:true});
  await detail.getByText("全部意见",{exact:true}).click();await expect(history).toBeVisible();
  await expect(history.getByText("原图第1处衣领意见。🌿",{exact:true})).toBeVisible({timeout:30000});await expect(history.getByText("原图第2处衣领意见。🌿",{exact:true})).toBeVisible();await expect(history.getByText(/^侧面第3处意见/)).toHaveCount(0);
  await expect(history.getByRole("article").getByText("已有返稿",{exact:true})).toHaveCount(1);await expect(history.getByRole("article").getByText("待返稿",{exact:true})).toHaveCount(9);
  await history.getByRole("combobox",{name:"意见状态",exact:true}).selectOption("returned");await expect(history.getByText("原图第2处衣领意见。🌿",{exact:true})).toHaveCount(0);await expect(history.getByText("原图第1处衣领意见。🌿",{exact:true})).toBeVisible();
  await history.getByRole("combobox",{name:"意见状态",exact:true}).selectOption("pending");await expect(history.getByText("原图第1处衣领意见。🌿",{exact:true})).toHaveCount(0);await expect(history.getByText("原图第2处衣领意见。🌿",{exact:true})).toBeVisible();await history.getByRole("combobox",{name:"意见状态",exact:true}).selectOption("all");
  if(host.app)await host.app.evaluate(()=>{(globalThis as any).__holdHistoryOnce=true;});else hold=true;
  await history.getByRole("button",{name:"重新读取意见",exact:true}).click();await expect.poll(async()=>host.app?await host.app.evaluate(()=>!!(globalThis as any).__historyHeld):held).toBe(true);
  const beforeClose=host.app?await host.app.evaluate(()=>(globalThis as any).__historyReads):reads;
  await detail.getByText("全部意见",{exact:true}).click();await expect(history).toBeHidden();
  if(host.app)await host.app.evaluate(()=>{(globalThis as any).__releaseHistory();});else release?.();
  await history.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  expect(host.app?await host.app.evaluate(()=>(globalThis as any).__historyReads):reads).toBe(beforeClose);await expect(history).toHaveAttribute("aria-busy","false");
  await detail.getByText("全部意见",{exact:true}).click();await expect(history.getByText("原图第1处衣领意见。🌿",{exact:true})).toBeVisible();
  if(host.app)await host.app.evaluate(()=>{(globalThis as any).__failHistoryPage=true;});else fail=true;
  await history.getByRole("button",{name:"更多意见",exact:true}).click();await expect(history.getByRole("alert")).toContainText("意见分页读取中断");await expect(history.getByText("原图第1处衣领意见。🌿",{exact:true})).toBeVisible();
  await history.getByRole("button",{name:"重试读取意见",exact:true}).click();await expect(history.getByText("原图第22处衣领意见。🌿",{exact:true})).toBeVisible({timeout:30000});
  if(host.app)await host.app.evaluate(()=>{(globalThis as any).__failHistoryRefresh=true;});else failRefresh=true;
  await history.getByRole("button",{name:"重新读取意见",exact:true}).click();await expect(history.getByRole("alert")).toContainText("重新读取中断");await expect(history.getByText("原图第22处衣领意见。🌿",{exact:true})).toBeVisible();
  await history.getByRole("button",{name:"重试读取意见",exact:true}).click();await expect(history.getByRole("button",{name:"更多意见",exact:true})).toBeEnabled({timeout:30000});await expect(history.getByText("原图第22处衣领意见。🌿",{exact:true})).toHaveCount(0);
  await history.getByRole("button",{name:"重新读取意见",exact:true}).click();await expect(history.getByRole("button",{name:"更多意见",exact:true})).toBeEnabled({timeout:30000});await save(23,true);
  await history.getByRole("button",{name:"更多意见",exact:true}).click();await expect(history.getByRole("alert")).toContainText("列表或筛选已变化");await expect(history.getByText("原图第23处衣领意见。🌿",{exact:true})).toHaveCount(0);
  await history.getByRole("button",{name:"重新读取意见",exact:true}).click();await history.getByRole("button",{name:"更多意见",exact:true}).click();await expect(history.getByText("原图第23处衣领意见。🌿",{exact:true})).toBeVisible({timeout:30000});
  const firstOpinion=history.getByRole("article",{name:"意见 1",exact:true});await firstOpinion.getByRole("button",{name:"查看原位置",exact:true}).click();await expect(detail.locator(".image-region-position")).toContainText("1, 5");
  await page.setViewportSize({width:760,height:900});await view.locator("body").evaluate(async()=>{const current=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:current.revision,patch:{appearance:"dark"}});});await expect(view.locator("html")).toHaveAttribute("data-appearance","dark");
  expect(await detail.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await history.screenshot({path:info.outputPath("history-dark-narrow.png")});await detail.screenshot({path:info.outputPath("dialog-history-dark-narrow.png")});
  const count=host.app?await host.app.evaluate(()=>(globalThis as any).__historyWrites):writes;expect(count).toBe(0);
  const saved=await call("hetu.task_feedback.list",{task_ref:task,limit:100});expect(saved.feedback).toHaveLength(23);expect(saved.feedback[0].feedback_ref).toEqual(initial);expect(saved.feedback[0].reported_result_refs).toHaveLength(1);expect(saved.feedback[0].author_acceptance).toBe("not_implied");
  await writeFile(info.outputPath("result.json"),JSON.stringify({surface,feedback_count:23,original_feedback_preserved:true,current_image_only:true,old_batch:true,original_position:true,page_failure_retry:true,concurrent_change_rejected:true,closed_read_stopped:true,read_only_ui:true,author_acceptance:"not_implied",reads:host.app?await host.app.evaluate(()=>(globalThis as any).__historyReads):reads,model_turns:0},null,2));
 }finally{release?.();if(host.app)await host.app.evaluate(()=>{(globalThis as any).__releaseHistory?.();}).catch(()=>{});await core.close();await host.close("app");}
});
