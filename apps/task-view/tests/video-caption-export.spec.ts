import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost,type WorkbenchSurface} from "./workbench-host.ts";

for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 字幕按当前轨导出原字节，取消与撤权保持文件和意见`,async({page},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");
 test.skip(surface!=="desktop"&&process.platform==="win32","Windows独立MCP原生保存选择需另行实机验证");
 test.setTimeout(180000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-caption-export-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const seeded=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration,"--captions"],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);const refs=JSON.parse(seeded.stdout);
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.video.workspace_id,works:[{work_ref:refs.video,title:"默认视频"}]}]}));
 const core=await AppServer.open(path.join(root,"target/debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const value=await core.request("workspace/request",{action,contract_revision:"1",input});expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data;};
 let host:Awaited<ReturnType<typeof openWorkbenchHost>>|undefined;
 try{
 const media=await call("hetu.video.media.get",{work_ref:refs.video,media_ref:refs.second});
 const tracks=media.media.caption_tracks,bytes=new Map<string,Buffer>();
 for(const track of tracks){const file=await call("hetu.assets.read_blob",{work_ref:refs.video,asset_ref:track.asset_ref,offset:0,length:12000});bytes.set(track.id,Buffer.from(file.base64,"base64"));}
 const target=path.join(folder,"本版字幕.vtt"),choice=path.join(folder,"choice.json"),requests=path.join(folder,"dialogs.jsonl"),fixture=path.join(folder,"native-save.cjs");
 await writeFile(target,"原目标文件");await writeFile(choice,JSON.stringify({path:null}));await writeFile(requests,"");
 // 仅代替原生保存路径选择，不替代文件流、Core权利核验或实际落盘。
 await writeFile(fixture,`#!${process.execPath}\nconst fs=require("node:fs");let bytes="";process.stdin.on("data",value=>bytes+=value);process.stdin.on("end",()=>{const request=JSON.parse(bytes);if(request.kind!=="save_file"||request.options?.title!=="导出本版字幕"){process.stdout.write(JSON.stringify({ok:false,message:"非预期原生交互"}));return;}fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify(request.options)+"\\n");process.stdout.write(JSON.stringify({ok:true,value:JSON.parse(fs.readFileSync(${JSON.stringify(choice)},"utf8")).path}));});\n`,{mode:0o700});
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_NODE:process.execPath,HETU_COLLABORATION_DIR:collaboration,HETU_CODEX_BIN:path.join(folder,"no-agent"),HETU_DESKTOP_EXECUTABLE:fixture};
 host=await openWorkbenchHost(surface,page,env);const {app,view}=host;page=host.page;
 let choices=0;
 const dialogRequests=async()=>{const text=await readFile(requests,"utf8");return text.trim()?text.trim().split("\n").map(line=>JSON.parse(line)):[];};
  if(app)await app.evaluate(({dialog},paths)=>{dialog.showSaveDialog=async(...args:any[])=>{const options=args.find(value=>value&&typeof value==="object"&&value.title==="导出本版字幕");if(!options)throw Error("非预期保存选择");const fs=process.getBuiltinModule("node:fs");fs.appendFileSync(paths.requests,JSON.stringify(options)+"\n");const value=JSON.parse(fs.readFileSync(paths.choice,"utf8")).path;return {canceled:!value,filePath:value??undefined};};},{requests,choice});
  await page.setViewportSize({width:1200,height:900});await view.getByRole("button",{name:"打开作品 默认视频",exact:true}).click();await expect(view.getByRole("region",{name:"当前作品资料",exact:true})).toBeVisible();await navigate(view,"视频");
  const review=view.getByRole("region",{name:"视频作品",exact:true}),player=review.locator("article.video-review-content > .media-preview video"),language=review.getByRole("combobox",{name:"字幕语言",exact:true}),save=review.getByRole("button",{name:"导出字幕",exact:true}),field=review.getByRole("textbox",{name:"视频修改意见",exact:true});
  await expect(language).toHaveValue("zh");await expect.poll(()=>player.evaluate((video:HTMLVideoElement)=>video.readyState)).toBeGreaterThan(0);
  await player.evaluate((video:HTMLVideoElement)=>{(video as any).__exportIdentity="same-video";video.currentTime=.75;});
  const cues=()=>player.evaluate((video:HTMLVideoElement)=>Array.from(video.textTracks).filter(track=>track.mode==="showing").flatMap(track=>Array.from(track.activeCues??[]).map(cue=>(cue as VTTCue).text)));
  await expect.poll(cues).toContain("渡口的灯亮了。🌿");
  const position=await player.evaluate((video:HTMLVideoElement)=>video.currentTime);await field.fill("导出字幕时保留本条意见。🌿");
  const exportTo=async(file:string|null)=>{await writeFile(choice,JSON.stringify({path:file}));await save.click();choices++;await expect.poll(async()=>(await dialogRequests()).length).toBe(choices);await expect(review).toHaveAttribute("aria-busy","false");};
  await exportTo(null);expect(await readFile(target,"utf8")).toBe("原目标文件");
  await exportTo(target+".srt");await expect(review.getByRole("alert")).toContainText("vtt扩展名");expect(await readFile(target,"utf8")).toBe("原目标文件");
  await exportTo(target);await expect(review.getByText("本版字幕已导出。",{exact:true})).toBeVisible();await expect(view.locator(".notice")).toHaveCount(0);expect(await readFile(target)).toEqual(bytes.get("zh"));
  await language.selectOption("en");await expect(review.getByText("本版字幕已导出。",{exact:true})).toHaveCount(0);await expect.poll(cues).toContain("The ferry light is on.");await exportTo(target);expect(await readFile(target)).toEqual(bytes.get("en"));
  const beforeChoices=choices;
  await expect(view.locator("#root").evaluate((_root,input)=>window.hetuDesktop.video("export_caption",input),{media_ref:refs.first,caption_ref:tracks[0].asset_ref})).rejects.toThrow(/不属于本版视频/);expect((await dialogRequests()).length).toBe(beforeChoices);expect(await readFile(target)).toEqual(bytes.get("en"));
  const asset=await call("hetu.assets.get",{asset_id:tracks[1].asset_ref.asset_id});
  const updated=await call("hetu.assets.update",{work_ref:refs.video,asset_id:asset.asset.asset_id,expected:{revision:asset.asset.revision,sha256:asset.sha256},title:asset.asset.title,source:asset.asset.source,rights_status:"reference_only",redistribution_allowed:false,rights_statement:"隔离验收暂时撤回交付",operation_key:"deny-caption-export"});
  await save.click();await expect(review.getByRole("alert")).toContainText("字幕权利未允许交付");await expect(review).toHaveAttribute("aria-busy","false");expect((await dialogRequests()).length).toBe(beforeChoices);expect(await readFile(target)).toEqual(bytes.get("en"));
  await call("hetu.assets.update",{work_ref:refs.video,asset_id:asset.asset.asset_id,expected:{revision:updated.asset.revision,sha256:updated.sha256},title:asset.asset.title,source:asset.asset.source,rights_status:asset.asset.rights_status,redistribution_allowed:asset.asset.redistribution_allowed,rights_statement:asset.asset.rights_statement,operation_key:"restore-caption-export"});
  await exportTo(target);expect(await readFile(target)).toEqual(bytes.get("en"));await expect(field).toHaveValue("导出字幕时保留本条意见。🌿");expect(await player.evaluate((video:any)=>video.__exportIdentity)).toBe("same-video");expect(await player.evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeCloseTo(position,2);
  const dialogs=await dialogRequests();expect(dialogs[0].defaultPath).toBe("zh.vtt");expect(dialogs[3].defaultPath).toBe("en.vtt");expect(dialogs.every(value=>value.filters?.[0]?.extensions?.[0]==="vtt")).toBe(true);
  for(const [width,appearance]of [[1200,"light"],[800,"dark"]]as const){await page.setViewportSize({width,height:900});await view.locator("#root").evaluate(async(_element,appearance)=>{const current=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:current.revision,patch:{appearance}});},appearance);await expect(view.locator("html")).toHaveAttribute("data-appearance",appearance);expect(await review.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await save.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`caption-export-${appearance}-${width}.png`)});}
  await language.selectOption("");await expect(save).toHaveCount(0);await review.getByRole("button",{name:"清除草稿",exact:true}).click();await view.getByRole("combobox",{name:"视频成果版本",exact:true}).selectOption(refs.first.media_id);await expect(language).toHaveCount(0);await expect(save).toHaveCount(0);
  expect((await readdir(folder)).some(name=>name.startsWith(".hetu-export-"))).toBe(false);
  await writeFile(info.outputPath("caption-export.json"),JSON.stringify({surface,model_turns:0,real_core:true,zh_sha256:createHash("sha256").update(bytes.get("zh")!).digest("hex"),en_sha256:createHash("sha256").update(bytes.get("en")!).digest("hex"),exact_original_bytes:true,cancel_preserves_file:true,wrong_extension_preserves_file:true,unrelated_track_refused:true,current_rights_denied:true,restored_rights_exports_same_fixed_track:true,video_identity_and_position_retained:true,draft_retained:true,off_and_old_video_hide_export:true,native_io:"deterministic path choice only",dark_narrow:true,temporary_files_removed:true},null,2));
 }finally{try{await host?.close();}finally{await core.close();}}
});
