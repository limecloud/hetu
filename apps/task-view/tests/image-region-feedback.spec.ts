import {test,expect,type Page,type FrameLocator} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {sampleImage} from "../../desktop/tests/fixtures/media.ts";
import {PluginPackage} from "../../../packages/plugin-host/src/package.ts";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost,type WorkbenchSurface} from "./workbench-host.ts";
import {fixtureBinary,machineBinary} from "../../desktop/tests/acceptance-paths.ts";

for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 图片区域固定原像素，旧批次意见恢复后沿原任务返工`,async({page},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");test.setTimeout(150000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-image-region-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration"),access=path.join(folder,"access"),source=path.join(folder,"source.png");
 const image=sampleImage(),pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));await writeFile(source,image);
 const seeded=spawnSync(fixtureBinary("plugin_fixture"),[workspace,access,path.join(pkg.source,"plugin.json"),pkg.sha256,"0","--artwork",source,createHash("sha256").update(image).digest("hex")],{encoding:"utf8"});expect(seeded.status,seeded.error?.message??seeded.stderr).toBe(0);
 const refs=JSON.parse(seeded.stdout),task=refs.artwork.task_ref;
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.work_ref.workspace_id,works:[{work_ref:refs.work_ref,title:"图片区域验收"}]}]}));
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_ACCESS_DIR:access,HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_NODE:process.execPath};
 let lose=false,writes=0;
 const host=await openWorkbenchHost(surface,page,env,async(method,args,run)=>{
  if(method==="tasks"&&args[0]==="call"&&args[2]?.name==="hetu_save_task_feedback"){
   writes++;const result=await run();if(lose){lose=false;throw Error("隔离验收：图片意见回执中断。");}return result;
  }
  return run();
 });page=host.page;const view=host.view;
 const core=await AppServer.open(machineBinary("hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 try{
  if(host.app)await host.app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:tasks"),state=globalThis as any;state.__imageWrites=0;
   handlers.set("desktop:tasks",async(event:any,method:string,ref:any,input:any)=>{
    if(method!=="call"||input?.name!=="hetu_save_task_feedback")return original(event,method,ref,input);
    state.__imageWrites++;const result=await original(event,method,ref,input);if(state.__loseImageReceipt){state.__loseImageReceipt=false;throw Error("隔离验收：图片意见回执中断。");}return result;
   });
  });
  await page.setViewportSize({width:1440,height:960});await view.getByRole("button",{name:"打开作品 插件集成测试",exact:true}).click();await expect(view.locator(".work-profile")).toBeVisible();
  await view.locator("body").evaluate(()=>{
   (window as any).__regionNavigationEvents=[];
   for(const type of ["pointerdown","pointerup","click"])document.addEventListener(type,event=>{const target=event.target as HTMLElement;(window as any).__regionNavigationEvents.push({type,label:target.closest("button")?.getAttribute("aria-label"),tag:target.tagName,at:performance.now()});},true);
  });
  try{await navigate(view,"图片成果");}catch(error){await writeFile(info.outputPath("navigation-events.json"),JSON.stringify(await view.locator("body").evaluate(()=>({events:(window as any).__regionNavigationEvents,buttons:[...document.querySelectorAll(".sidebar-levels button")].map(element=>({html:element.outerHTML,rect:element.getBoundingClientRect().toJSON()})),height:innerHeight})),null,2));throw error;}
  await view.getByRole("button",{name:/雾中的旅人/}).click();
  const detail=view.getByRole("dialog",{name:"固定图片详情",exact:true}),preview=detail.locator(".image-region-preview"),canvas=preview.getByRole("group",{name:"图片意见区域",exact:true});
  await expect(preview.getByRole("button",{name:"标记区域",exact:true})).toBeEnabled();
  await preview.getByRole("button",{name:"标记区域",exact:true}).click();await expect(canvas).toBeFocused();
  const bounds=(await canvas.boundingBox())!;
  await page.mouse.move(bounds.x+bounds.width*.25,bounds.y+bounds.height*.25);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.75,bounds.y+bounds.height*.75);
  await expect.poll(async()=>{const current=(await canvas.boundingBox())!;return Math.max(...(["x","y","width","height"] as const).map(key=>Math.abs(current[key]-bounds[key])));}).toBeLessThan(.1);
  await page.mouse.up();
  const regionStatus=preview.getByRole("status");await expect(regionStatus).toContainText("原图区域");
  const selected=await preview.locator(".image-region-selection").evaluate(element=>({left:(element as HTMLElement).style.left,top:(element as HTMLElement).style.top}));
  // 指针坐标取整后矩形向外覆盖原像素，误差界限是一原图像素。
  expect(Math.abs(Number.parseFloat(selected.left)-25)).toBeLessThanOrEqual(100/120);
  expect(Math.abs(Number.parseFloat(selected.top)-25)).toBeLessThanOrEqual(100/180);
  const text=await regionStatus.innerText();const digits=text.match(/\d+/g)!.map(Number);const region={x:digits[0],y:digits[1],width:digits[2],height:digits[3]};
  await canvas.press("ArrowRight");await canvas.press("Shift+ArrowDown");
  const fixed={...region,x:region.x+1,height:region.height+1};await expect(regionStatus).toContainText(`${fixed.x}, ${fixed.y}`);
  await page.mouse.move(bounds.x+20,bounds.y+20);await page.mouse.down();await page.mouse.move(bounds.x+40,bounds.y+40);await canvas.press("Escape");await page.mouse.up();
  await expect(regionStatus).toContainText(`${fixed.x}, ${fixed.y}`);
  await detail.getByRole("button",{name:"旧外套的侧面",exact:true}).click();await expect(preview.locator(".image-region-selection")).toHaveCount(0);
  await detail.getByRole("button",{name:"雾中的旅人",exact:true}).click();
  await preview.getByRole("button",{name:"标记区域",exact:true}).click();await canvas.press("Enter");
  await canvas.press("ArrowRight");await canvas.press("Shift+ArrowDown");
  const savedRegion={x:31,y:45,width:60,height:91};await expect(regionStatus).toContainText("31, 45");
  const next=structuredClone(refs.artwork.submit_input);next.operation_key="region-next-batch";next.candidates[0].title="新版人物不替换旧坐标";
  await call("hetu.creative_tasks.submit_result",next);
  const opinion="只调整原图标记内的衣领，保留原神态。🌿";await detail.getByRole("textbox",{name:"图片修改意见",exact:true}).fill(opinion);
  if(host.app)await host.app.evaluate(()=>{(globalThis as any).__loseImageReceipt=true;});else lose=true;
  await detail.getByRole("button",{name:"按此修改",exact:true}).click();await expect(detail.getByRole("button",{name:"查询并恢复原保存",exact:true})).toBeVisible();
  await expect(detail.getByRole("button",{name:"按此修改",exact:true})).toBeDisabled();await expect(detail.getByRole("textbox",{name:"图片修改意见",exact:true})).toHaveValue(opinion);
  await detail.getByRole("button",{name:"查询并恢复原保存",exact:true}).click();await expect(detail.getByRole("status").filter({hasText:"原保存操作已确认"})).toBeVisible();
  const feedback=await call("hetu.task_feedback.list",{task_ref:task}),first=feedback.feedback[0];expect(feedback.feedback).toHaveLength(1);
  expect(first.feedback.target_refs).toHaveLength(1);
  const target=first.feedback.target_refs.find((item:any)=>item.image_region);expect(target.image_region).toEqual(savedRegion);expect(target.candidate_ref.submission_id).toBe(refs.artwork.submission_id);expect(first.feedback.schema_version).toBe("1.2.0");
  const writeCount=host.app?await host.app.evaluate(()=>(globalThis as any).__imageWrites):writes;expect(writeCount).toBe(1);
  await page.setViewportSize({width:760,height:900});
  await view.locator("body").evaluate(async()=>{const current=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:current.revision,patch:{appearance:"dark"}});});
  await expect(view.locator("html")).toHaveAttribute("data-appearance","dark");await expect(regionStatus).toContainText("31, 45");
  expect(await preview.evaluate(element=>{const host=element.closest(".artwork-preview-stage")!.getBoundingClientRect();return [...element.querySelectorAll(".image-region-tools,.image-region-position")].every(child=>{const rect=child.getBoundingClientRect();return rect.top>=host.top&&rect.bottom<=host.bottom+1&&rect.left>=host.left&&rect.right<=host.right+1;});})).toBe(true);
  expect(await detail.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await detail.screenshot({path:info.outputPath("fixed-region-narrow.png")});
  await detail.getByRole("button",{name:"关闭图片详情",exact:true}).click();
  await view.getByRole("button",{name:"刷新图片",exact:true}).click();await view.getByRole("button",{name:/新版人物不替换旧坐标/}).click();
  await expect(preview.locator(".image-region-selection")).toHaveCount(0);await detail.getByRole("combobox",{name:"图片版本",exact:true}).selectOption(refs.artwork.submission_id);await expect(regionStatus).toContainText("31, 45");
  const revised=structuredClone(next);revised.operation_key="region-revised";revised.feedback_refs=[first.feedback_ref];const returned=await call("hetu.creative_tasks.submit_result",revised);
  const history=await call("hetu.task_feedback.list",{task_ref:task});expect(history.feedback).toHaveLength(1);expect(history.feedback[0].feedback).toEqual(first.feedback);expect(history.feedback[0].reported_result_refs.length).toBeGreaterThan(0);expect(returned.submission.feedback_refs).toEqual([first.feedback_ref]);
  await writeFile(info.outputPath("result.json"),JSON.stringify({surface,region:savedRegion,feedback_count:1,save_calls:writeCount,fixed_old_batch:true,keyboard:true,drag_cancel:true,resize_preserved:true,original_operation_recovered:true,same_task_returned:true,model_turns:0},null,2));
 }finally{await core.close();await host.close("app");}
});
