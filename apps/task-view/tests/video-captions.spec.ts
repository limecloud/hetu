import {test, expect} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost, type WorkbenchSurface} from "./workbench-host.ts";

for (const surface of ["desktop", "stdio", "codex"] as WorkbenchSurface[]) test(`${surface} 固定字幕原生播放、语言切换、关闭和重试保持原视频`, async ({page}, info) => {
  test.skip(surface === "codex" && !process.env.HETU_ACCEPT_CODEX_BINARY, "需指定官方Codex CLI");
  test.setTimeout(180000);
  const root = path.resolve("../.."), folder = await mkdtemp(path.join(tmpdir(), "hetu-caption-review-"));
  const workspace = path.join(folder,"work"), profile = path.join(folder,"profile"), collaboration = path.join(folder,"collaboration");
  const seeded = spawnSync(path.join(root,"target/debug/examples/baseline_fixture"), [workspace,collaboration,"--captions"], {encoding:"utf8"});
  expect(seeded.status,seeded.stderr).toBe(0); const refs = JSON.parse(seeded.stdout);
  await mkdir(profile); await writeFile(path.join(profile,"creative-library.json"), JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.video.workspace_id,works:[{work_ref:refs.video,title:"默认视频"}]}]}));
  const env = {...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_NODE:process.execPath,HETU_COLLABORATION_DIR:collaboration,HETU_CODEX_BIN:path.join(folder,"no-agent")};
  let fault: "fail" | "hold" | undefined, release: (()=>void) | undefined, held = false;
  const host = await openWorkbenchHost(surface,page,env,async (method,args,run) => {
    if(method !== "read" || args[0] !== "hetu.assets.read_blob" || !fault) return run();
    const current = fault; fault = undefined;
    if(current === "fail") throw Error("隔离字幕读取失败");
    const value = await run(); held = true; await new Promise<void>(resolve => {release = resolve;}); return value;
  });
  const {app,view} = host; page = host.page;
  const child = app?.process();
  let processExit: {code: number | null; signal: string | null} | undefined;
  child?.on("exit", (code,signal) => {processExit={code,signal};});
  async function arm(value:"fail"|"hold") {
    if(app) await app.evaluate((_electron,value) => {(globalThis as any).__captionFault=value;(globalThis as any).__captionHeld=false;},value);
    else {fault=value;held=false;}
  }
  async function resume() {
    if(app) await app.evaluate(() => {(globalThis as any).__releaseCaption?.(); (globalThis as any).__releaseCaption=undefined;});
    else {release?.(); release=undefined;}
  }
  try {
    if(app) await app.evaluate(({ipcMain}) => {
      const handlers=(ipcMain as any)._invokeHandlers, original=handlers.get("desktop:read"), state=globalThis as any;
      handlers.set("desktop:read", async(event:any,action:string,input:any) => {
        if(action !== "hetu.assets.read_blob" || !state.__captionFault) return original(event,action,input);
        const current=state.__captionFault; state.__captionFault=undefined;
        if(current === "fail") throw Error("隔离字幕读取失败");
        const value=await original(event,action,input); state.__captionHeld=true;
        await new Promise<void>(resolve=>{state.__releaseCaption=resolve;}); return value;
      });
    });
    await page.setViewportSize({width:1200,height:900});
    await view.locator("#root").evaluate(root => {
      const events:any[]=[];(window as any).__captionPointerEvents=events;
      for(const type of ["pointerdown","pointerup","click"]) root.ownerDocument.addEventListener(type,event=>{
        const target=(event.target as Element).closest("button");
        events.push({type,label:target?.getAttribute("aria-label")??target?.textContent,tag:(event.target as Element).tagName,pressed:target?.getAttribute("aria-pressed"),x:(event as PointerEvent).clientX,y:(event as PointerEvent).clientY,time:performance.now()});
      },true);
    });
    await view.getByRole("button",{name:"打开作品 默认视频",exact:true}).click();
    await expect(view.getByRole("region",{name:"当前作品资料",exact:true})).toBeVisible({timeout:30000});
    await expect(view.locator("main:not([hidden])")).not.toHaveAttribute("aria-busy","true",{timeout:30000});
    await navigate(view,"视频");
    const review=view.getByRole("region",{name:"视频作品",exact:true}), video=review.locator("article.video-review-content > .media-preview video");
    const language=review.getByRole("combobox",{name:"字幕语言",exact:true});
    await expect(language).toHaveValue("zh");
    await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThan(0);
    await video.evaluate((v:HTMLVideoElement)=>{(v as any).__captionIdentity="original-video";v.muted=true;return v.play();});
    await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(.25);
    await video.evaluate((v:HTMLVideoElement)=>v.pause());
    const cues=()=>video.evaluate((v:HTMLVideoElement)=>Array.from(v.textTracks).filter(t=>t.mode==="showing").flatMap(t=>Array.from(t.activeCues??[]).map(c=>(c as VTTCue).text)));
    await expect.poll(cues).toContain("渡口的灯亮了。🌿");
    await expect(review.getByRole("group",{name:"视频字幕",exact:true})).toHaveAttribute("aria-busy","false");
    const position=await video.evaluate((v:HTMLVideoElement)=>v.currentTime);
    await language.selectOption("en"); await expect.poll(cues).toContain("The ferry light is on.");
    await expect(review.getByRole("group",{name:"视频字幕",exact:true})).toHaveAttribute("aria-busy","false");
    expect(await video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeCloseTo(position,2);
    expect(await video.evaluate((v:any)=>v.__captionIdentity)).toBe("original-video");
    await page.screenshot({path:info.outputPath("native-caption-english.png")});
    await language.selectOption(""); await expect(video.locator("track")).toHaveCount(0);
    const field=review.getByRole("textbox",{name:"视频修改意见",exact:true}); await field.fill("字幕切换后保留这条意见。🌿");
    await arm("fail"); await language.selectOption("zh");
    await expect(review.getByRole("alert")).toContainText("隔离字幕读取失败");
    await expect(review.getByRole("group",{name:"视频字幕",exact:true})).toHaveAttribute("aria-busy","false");
    await review.getByRole("button",{name:"重新加载字幕",exact:true}).click(); await expect.poll(cues).toContain("渡口的灯亮了。🌿");
    await expect(field).toHaveValue("字幕切换后保留这条意见。🌿");
    await video.evaluate((v:HTMLVideoElement)=>new Promise<void>(resolve=>{v.addEventListener("seeked",()=>resolve(),{once:true});v.currentTime=2;}));
    await expect.poll(cues).toContain("渡口的灯亮了。🌿");
    await page.screenshot({path:info.outputPath("native-caption-chinese.png")});
    await language.selectOption(""); await arm("hold"); await language.selectOption("en");
    await expect.poll(async()=>app?app.evaluate(()=>(globalThis as any).__captionHeld===true):held).toBe(true);
    await language.selectOption(""); await resume();
    await expect(video.locator("track")).toHaveCount(0); await expect(review.getByRole("alert")).toHaveCount(0);
    await expect(review.getByRole("group",{name:"视频字幕",exact:true})).toHaveAttribute("aria-busy","false");
    await review.getByRole("button",{name:"清除草稿",exact:true}).click();
    await language.selectOption("zh");await expect.poll(cues).toContain("渡口的灯亮了。🌿");
    await arm("hold");await language.selectOption("en");
    await expect.poll(async()=>app?app.evaluate(()=>(globalThis as any).__captionHeld===true):held).toBe(true);
    await view.getByRole("combobox",{name:"视频成果版本",exact:true}).selectOption(refs.first.media_id);
    await expect(language).toHaveCount(0);await resume();await expect(video.locator("track")).toHaveCount(0);
    await view.getByRole("combobox",{name:"视频成果版本",exact:true}).selectOption(refs.second.media_id);
    await expect(language).toHaveValue("zh");
    await video.evaluate((v:HTMLVideoElement)=>new Promise<void>(resolve=>{v.addEventListener("seeked",()=>resolve(),{once:true});v.currentTime=.75;}));
    await expect.poll(cues).toContain("渡口的灯亮了。🌿");
    await page.setViewportSize({width:800,height:900});
    await view.locator("#root").evaluate(async()=>{const api=window.hetuDesktop,current=await api.settings("preferences");await api.settings("update",{expected_revision:current.revision,patch:{appearance:"dark"}});});
    await expect(view.locator("html")).toHaveAttribute("data-appearance","dark");expect(await review.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    await video.scrollIntoViewIfNeeded();await expect.poll(cues).toContain("渡口的灯亮了。🌿");await page.screenshot({path:info.outputPath("native-caption-dark-narrow.png")});
    await writeFile(info.outputPath("caption-review.json"),JSON.stringify({surface,model_turns:0,real_core:true,native_active_cues:true,english_chinese_switch:true,native_screenshots:true,seek:true,video_identity_preserved:true,position_preserved:true,draft_preserved:true,read_failure_retry:true,late_response_after_off_ignored:true,late_response_after_media_switch_ignored:true,old_media_without_captions:true,reopened_media_same_fixed_tracks:true,dark_narrow:true},null,2));
  } catch(error) {
    const events=await view.locator("#root").evaluate(()=>(window as any).__captionPointerEvents).catch(()=>[]);
    await writeFile(info.outputPath("pointer-events.json"),JSON.stringify(events,null,2));throw error;
  } finally {
    await resume().catch(()=>{});
    try {await host.close();} finally {
      if(child)await writeFile(info.outputPath("desktop-exit.json"),JSON.stringify({event:processExit,exit_code:child.exitCode,signal:child.signalCode,killed:child.killed},null,2));
    }
  }
});
