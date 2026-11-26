import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost,type WorkbenchSurface} from "./workbench-host.ts";

for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 固定视频选用、撤回及历史，丢回执只恢复原决定且意见与播放器保持`,async({page},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");test.setTimeout(180000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-video-decisions-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const seeded=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);const refs=JSON.parse(seeded.stdout);
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.video.workspace_id,works:[{work_ref:refs.video,title:"默认视频"}]}]}));
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_NODE:process.execPath,HETU_COLLABORATION_DIR:collaboration,HETU_CODEX_BIN:path.join(folder,"no-agent")};
 let lose=false,lost=0;
 const host=await openWorkbenchHost(surface,page,env,async(method,args,run)=>{if(method!=="video"||args[0]!=="save_decision"||!lose)return run();lose=false;const result=await run();lost++;throw Error("隔离验收：决定已经保存但回执丢失。");});
 const {app,view}=host;page=host.page;
 const arm=async()=>{if(app)await app.evaluate(()=>(globalThis as any).__loseVideoDecision=true);else lose=true;};
 try{
  if(app)await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:video");handlers.set("desktop:video",async(event:unknown,method:string,input:any)=>{const value=await original(event,method,input);if(method==="save_decision"&&(globalThis as any).__loseVideoDecision){(globalThis as any).__loseVideoDecision=false;throw Error("隔离验收：决定已经保存但回执丢失。");}return value;});});
  await page.setViewportSize({width:1200,height:900});await view.getByRole("button",{name:"打开作品 默认视频",exact:true}).click();await expect(view.getByRole("region",{name:"当前作品资料",exact:true})).toBeVisible();await navigate(view,"视频");
  const review=view.getByRole("region",{name:"视频作品",exact:true}),decision=review.getByRole("region",{name:"视频认可",exact:true}),player=review.locator("article.video-review-content > .media-preview video"),field=review.getByRole("textbox",{name:"视频修改意见",exact:true});
  await expect(decision).toHaveAttribute("aria-busy","false");await expect(decision).toContainText("本版尚未认可");
  const history=()=>view.locator("#root").evaluate((_root,video_episode_id)=>window.hetuDesktop.video("decision_history",{video_episode_id,purpose:"clip"}),refs.episode_id);
  await decision.getByRole("button",{name:"选用片段",exact:true}).click();const confirm=view.getByRole("dialog",{name:"选用片段",exact:true});await expect(confirm).toContainText("雨夜第二版");await confirm.getByRole("textbox",{name:"决定说明",exact:true}).fill("取消的决定不能保存。");await page.screenshot({path:info.outputPath("fixed-decision-preview.png")});await confirm.getByRole("button",{name:"取消",exact:true}).click();await expect(decision.getByRole("button",{name:"选用片段",exact:true})).toBeFocused();expect((await history()).total).toBe(0);
  await expect.poll(()=>player.evaluate((video:HTMLVideoElement)=>video.readyState)).toBeGreaterThan(0);await player.evaluate((video:HTMLVideoElement)=>{(video as any).__decisionIdentity="original";video.currentTime=.75;});const position=await player.evaluate((video:HTMLVideoElement)=>video.currentTime);
  await field.fill("选用与撤回期间保持本条意见。🌿");
  await decision.getByRole("button",{name:"选用片段",exact:true}).click();await confirm.getByRole("textbox",{name:"决定说明",exact:true}).fill("隔离验收：选用雨夜第二版样本。🌿");await confirm.getByRole("button",{name:"确认本版",exact:true}).click();await expect(confirm).toHaveCount(0);await expect(decision).toContainText("本版片段已选用");
  await expect(field).toHaveValue("选用与撤回期间保持本条意见。🌿");expect(await player.evaluate((video:any)=>video.__decisionIdentity)).toBe("original");expect(await player.evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeCloseTo(position,2);
  await decision.getByRole("button",{name:"认可历史",exact:true}).click();await expect(decision.getByRole("region",{name:"认可历史",exact:true})).toContainText("隔离验收：选用雨夜第二版样本。🌿");
  const first=(await history()).items[0];expect(first.decision_ref.revision).toBe(1);
  await decision.getByRole("button",{name:"撤回本版认可",exact:true}).click();const withdraw=view.getByRole("dialog",{name:"撤回本版认可",exact:true});await withdraw.getByRole("textbox",{name:"决定说明",exact:true}).fill("隔离验收：撤回原第二版选用，保留其他内容。");await arm();await withdraw.getByRole("button",{name:"撤回本版",exact:true}).click();
  await expect(withdraw.getByRole("alert")).toContainText("回执丢失");await expect(withdraw.getByRole("button",{name:"恢复原决定",exact:true})).toBeVisible();await expect(withdraw.getByRole("button",{name:"撤回本版",exact:true})).toBeDisabled();await withdraw.getByRole("button",{name:"恢复原决定",exact:true}).click();await expect(withdraw).toHaveCount(0);await expect(decision).toContainText("本版片段选用已撤回");
  const after=await history();expect(after.total).toBe(2);expect(after.items[1]).toEqual(first);expect(after.items[0].decision.previous_ref).toEqual(first.decision_ref);await expect(decision.getByRole("region",{name:"认可历史",exact:true})).toContainText("撤回原第二版选用");
  await expect(field).toHaveValue("选用与撤回期间保持本条意见。🌿");expect(await player.evaluate((video:any)=>video.__decisionIdentity)).toBe("original");expect(await player.evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeCloseTo(position,2);
  for(const [width,appearance]of [[1200,"light"],[800,"dark"]]as const){await page.setViewportSize({width,height:900});await view.locator("#root").evaluate(async(_root,appearance)=>{const current=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:current.revision,patch:{appearance}});},appearance);await expect(view.locator("html")).toHaveAttribute("data-appearance",appearance);await decision.scrollIntoViewIfNeeded();expect(await review.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath(`video-decision-${appearance}-${width}.png`)});}
  await review.getByRole("button",{name:"清除草稿",exact:true}).click();await view.getByRole("combobox",{name:"视频成果版本",exact:true}).selectOption(refs.first.media_id);await expect(decision).toContainText("认可记录属于本集另一版本");
  await navigate(view,"作品资料");await navigate(view,"视频");await expect(decision).toContainText("本版片段选用已撤回");expect((await history()).total).toBe(2);
  await writeFile(info.outputPath("video-decisions.json"),JSON.stringify({surface,model_turns:0,real_core:true,cancel_no_write:true,confirmed_fixed_media:true,withdrawn_fixed_media:true,lost_receipt_recovered_original:true,history_count:2,old_decision_unchanged:true,other_media_not_approved:true,video_identity_and_position_preserved:true,unsaved_feedback_preserved:true,return_state_preserved:true,dark_narrow:true},null,2));
 }finally{await host.close();}
});
