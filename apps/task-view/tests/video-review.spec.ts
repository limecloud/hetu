import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost,type WorkbenchSurface} from "./workbench-host.ts";

type Fault={action:string;mode:"fail"|"hold-error"|"lost";media_id?:string};
for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 视频读取有终态，迟到旧版本不覆盖，丢回执沿原意见恢复`,async({page},info)=>{
  test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");test.setTimeout(180000);
  const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-video-review-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
  const seeded=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);const refs=JSON.parse(seeded.stdout);
  const core=await AppServer.open(path.join(root,"target/debug/hetu-app-server"),workspace);
  let emptyEpisode:string;
  try {
    const read=await core.request("workspace/request",{action:"hetu.video.projects.get",contract_revision:"1",input:{video_project_id:refs.video.object_id}});expect(read.status).toBe("succeeded");
    const value=read.data;
    const added=await core.request("workspace/request",{action:"hetu.video.episodes.create",contract_revision:"1",input:{project_ref:{video_project_id:refs.video.object_id,revision:value.project.revision,sha256:value.sha256},title:"下一集",brief:"尚无媒体",operation_key:"empty-episode"}});expect(added.status,JSON.stringify(added)).toBe("succeeded");emptyEpisode=added.data.episode.video_episode_id;
  }finally{await core.close();}
  await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.video.workspace_id,works:[{work_ref:refs.video,title:"默认视频"}]}]}));
  const dialogFixture=path.join(folder,"keep-recovery-draft.cjs");
  // 与桌面隔离夹具的对话框选择相同；只接受保留恢复稿离开，不代理业务决定。
  await writeFile(dialogFixture,`#!${process.execPath}\nlet text="";process.stdin.on("data",bytes=>text+=bytes);process.stdin.on("end",()=>{const value=JSON.parse(text);if(value.kind!=="confirm"||value.options?.message!=="修改尚未保存到作品。"||value.options?.detail!=="保留恢复稿并离开？")process.stdout.write(JSON.stringify({ok:false,message:"非预期测试对话框"}));else process.stdout.write(JSON.stringify({ok:true,value:true}));});\n`,{mode:0o700});
  const reopen=surface==="desktop"||process.platform!=="win32";
  const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_NODE:process.execPath,HETU_COLLABORATION_DIR:collaboration,HETU_CODEX_BIN:path.join(folder,"no-agent"),...(process.platform!=="win32"?{HETU_DESKTOP_EXECUTABLE:dialogFixture}:{})};
  let fault:Fault|undefined,release:(()=>void)|undefined,completed=0;
  const host=await openWorkbenchHost(surface,page,env,async(method,args,run)=>{
    const current=fault;
    if(method!=="video"||!current||args[0]!==current.action||(current.media_id&&args[1]?.media_ref?.media_id!==current.media_id))return run();
    fault=undefined;
    if(current.mode==="fail"){completed++;throw Error("隔离验收：本版视频暂不可读。");}
    await run();
    if(current.mode==="hold-error")await new Promise<void>(resolve=>{release=resolve;});
    completed++;throw Error(current.mode==="lost"?"隔离验收：意见回执中断。":"隔离验收：旧版本迟到失败。");
  });
  const {app,view}=host;page=host.page;
  const arm=async(value:Fault)=>{if(app)await app.evaluate((_electron,value)=>{(globalThis as any).__videoFault=value;},value);else fault=value;};
  const held=async()=>app?app.evaluate(()=>typeof(globalThis as any).__releaseVideo==="function"):!!release;
  const resume=async()=>{if(app)await app.evaluate(()=>{const state=globalThis as any;state.__releaseVideo?.();state.__releaseVideo=undefined;});else{release?.();release=undefined;}};
  const finished=async()=>app?app.evaluate(()=>(globalThis as any).__videoFaultCompleted??0):completed;
  try {
    if(app)await app.evaluate(({ipcMain,dialog})=>{
      dialog.showMessageBox=async(...args:any[])=>{
        const options=args.find(value=>value&&typeof value==="object"&&typeof value.message==="string");
        if(options?.message!=="修改尚未保存到作品。"||!options.buttons?.includes("保留恢复稿并离开"))throw Error("非预期测试对话框");
        return {response:1,checkboxChecked:false};
      };
      const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:video"),state=globalThis as any;
      handlers.set("desktop:video",async(event:unknown,method:string,input:any)=>{
        const fault=state.__videoFault;
        if(!fault||method!==fault.action||(fault.media_id&&input?.media_ref?.media_id!==fault.media_id))return original(event,method,input);
        state.__videoFault=undefined;
        if(fault.mode==="fail"){state.__videoFaultCompleted=(state.__videoFaultCompleted??0)+1;throw Error("隔离验收：本版视频暂不可读。");}
        await original(event,method,input);
        if(fault.mode==="hold-error")await new Promise<void>(resolve=>{state.__releaseVideo=resolve;});
        state.__videoFaultCompleted=(state.__videoFaultCompleted??0)+1;throw Error(fault.mode==="lost"?"隔离验收：意见回执中断。":"隔离验收：旧版本迟到失败。");
      });
    });
    await page.setViewportSize({width:1200,height:900});await view.getByRole("button",{name:"打开作品 默认视频",exact:true}).click();
    await arm({action:"media",mode:"hold-error",media_id:refs.second.media_id});await navigate(view,"视频");
    const surfaceView=view.getByRole("region",{name:"视频作品",exact:true}),versions=view.getByRole("combobox",{name:"视频成果版本",exact:true});
    await expect.poll(held).toBe(true);await expect(surfaceView).toHaveAttribute("aria-busy","true");
    await versions.selectOption(refs.first.media_id);await expect(surfaceView.getByRole("heading",{name:"雨夜第一版 片段",exact:true})).toBeVisible();await expect(surfaceView).toHaveAttribute("aria-busy","false");
    await resume();await expect.poll(finished).toBe(1);await expect(surfaceView.getByRole("alert")).toHaveCount(0);
    await arm({action:"media",mode:"fail",media_id:refs.second.media_id});await versions.selectOption(refs.second.media_id);
    await expect(surfaceView.getByRole("alert")).toContainText("本版视频暂不可读");await expect(surfaceView).toHaveAttribute("aria-busy","false");
    await surfaceView.getByRole("button",{name:"重新读取本版视频",exact:true}).click();await expect(surfaceView.getByRole("heading",{name:"雨夜第二版 片段",exact:true})).toBeVisible();
    const video=surfaceView.locator("article.video-review-content > .media-preview video");
    await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>element.readyState)).toBeGreaterThan(0);
    await video.evaluate((element:HTMLVideoElement)=>{element.muted=true;return element.play();});await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>element.currentTime)).toBeGreaterThan(.1);await video.evaluate((element:HTMLVideoElement)=>element.pause());
    await video.evaluate((element:HTMLVideoElement)=>new Promise<void>(resolve=>{element.addEventListener("seeked",()=>resolve(),{once:true});element.currentTime=.75;}));
    await surfaceView.getByRole("checkbox",{name:"指定片段",exact:true}).check();await surfaceView.getByRole("button",{name:"以当前位置为开始",exact:true}).click();await expect(surfaceView.getByRole("spinbutton",{name:"意见开始秒数",exact:true})).toHaveValue("0.750");
    await surfaceView.getByRole("spinbutton",{name:"意见结束秒数",exact:true}).fill("1.25");const comment="仅调整这段转场，保留前版。🌿";const field=surfaceView.getByRole("textbox",{name:"视频修改意见",exact:true});await field.fill(comment);
    await surfaceView.getByRole("spinbutton",{name:"意见结束秒数",exact:true}).fill("0.5");await surfaceView.getByRole("button",{name:"保存意见",exact:true}).click();
    await expect(surfaceView.getByRole("alert")).toContainText("意见区间超出固定媒体时长");await expect(field).toBeEnabled();await expect(field).toHaveValue(comment);await expect(surfaceView.getByRole("button",{name:"恢复原操作",exact:true})).toHaveCount(0);
    await surfaceView.getByRole("spinbutton",{name:"意见结束秒数",exact:true}).fill("1.25");
    await arm({action:"save_feedback",mode:"lost"});await surfaceView.getByRole("button",{name:"保存意见",exact:true}).click();
    await expect(surfaceView.getByRole("button",{name:"恢复原操作",exact:true})).toBeVisible();await expect(surfaceView.getByRole("button",{name:"保存意见",exact:true})).toBeDisabled();await expect(field).toHaveValue(comment);
    if(reopen){
      // Windows的独立MCP原生确认另行实机验收，不执行POSIX启动器。
      await navigate(view,"作品资料");await navigate(view,"视频");
      await expect(field).toHaveValue(comment);await expect(surfaceView.getByRole("button",{name:"恢复原操作",exact:true})).toBeVisible();await expect(surfaceView.getByRole("button",{name:"保存意见",exact:true})).toBeDisabled();
    }
    await surfaceView.getByRole("button",{name:"恢复原操作",exact:true}).click();await expect(field).toHaveValue("");await expect(surfaceView.getByText(comment,{exact:true})).toBeVisible();
    await surfaceView.getByRole("button",{name:"查看前版",exact:true}).click();await expect(surfaceView.getByRole("region",{name:"前版视频",exact:true}).locator("video")).toHaveCount(1);
    await arm({action:"list",mode:"fail"});await view.getByRole("combobox",{name:"视频分集",exact:true}).selectOption(emptyEpisode!);
    await expect(surfaceView.getByRole("alert")).toContainText("本版视频暂不可读");await expect(surfaceView).not.toContainText("本集还没有视频成果");await expect(surfaceView).toHaveAttribute("aria-busy","false");
    await view.getByRole("button",{name:"刷新视频作品",exact:true}).click();await expect(surfaceView).toContainText("本集还没有视频成果");await expect(surfaceView.locator("video")).toHaveCount(0);await expect(surfaceView).toHaveAttribute("aria-busy","false");
    await view.getByRole("combobox",{name:"视频分集",exact:true}).selectOption(refs.episode_id);await expect(surfaceView.getByText(comment,{exact:true})).toBeVisible();await expect(field).toHaveValue("");
    const notes=await view.locator("#root").evaluate((_element,media_ref)=>window.hetuDesktop.video("feedback",{media_ref}),refs.second);expect(notes.items).toHaveLength(1);expect(notes.items[0].feedback.range).toEqual({start_tick:750,end_tick:1250});
    const before=await view.locator("#root").evaluate((_element,media_ref)=>window.hetuDesktop.video("feedback",{media_ref}),refs.first);expect(before.total).toBe(0);
    for(const [width,theme] of [[1200,"light"],[800,"dark"]] as const){
      await page.setViewportSize({width,height:900});
      await view.locator("#root").evaluate(async(_element,appearance)=>{const api=window.hetuDesktop,current=await api.settings("preferences");await api.settings("update",{expected_revision:current.revision,patch:{appearance}});},theme);
      await expect(view.locator("html")).toHaveAttribute("data-appearance",theme);expect(await surfaceView.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
      await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>element.readyState)).toBeGreaterThan(1);await surfaceView.getByRole("heading",{name:"雨夜第二版 片段",exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`video-${theme}-${width}.png`)});
      await surfaceView.getByText(comment,{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`feedback-${theme}-${width}.png`)});
    }
    await writeFile(info.outputPath("video-review.json"),JSON.stringify({surface,actual_media_played:true,media_loading_terminal:true,late_error_ignored:true,read_retry:true,list_error_not_empty:true,invalid_range_is_definitive:true,feedback_range:{start_tick:750,end_tick:1250},feedback_count:notes.items.length,lost_receipt_recovered:true,reopened_unknown_feedback:reopen,previous_feedback_count:before.total,empty_episode_clears_media:true,native_dialog_fixture:"only preserve recovery draft and leave; no business approval",model_turns:0},null,2));
  }finally{await resume().catch(()=>{});await host.close();}
});
