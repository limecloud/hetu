import {test,expect,_electron as electron} from "@playwright/test";
import {readFile,writeFile,mkdtemp} from "node:fs/promises";
import {cpus,totalmem,release,version} from "node:os";
import path from "node:path";
import {navigate,openDirectory,closeApplication,documentAction} from "./navigation.ts";

test("千章千万汉字作品冷进程首屏、完整目录和末章读取",async({},info)=>{
  test.skip(!process.env.HETU_SCALE_FIXTURE||!process.env.HETU_PACKAGED_APP,"需要公开Core生成的固定千章资料及同版优化应用");
  test.setTimeout(180000);
  const fixture=JSON.parse(await readFile(process.env.HETU_SCALE_FIXTURE!,"utf8"));
  const manifest=process.env.HETU_PACKAGE_MANIFEST?JSON.parse(await readFile(process.env.HETU_PACKAGE_MANIFEST,"utf8")):undefined;
  expect(fixture.chapters).toBe(1000);expect(fixture.documents).toHaveLength(1000);
  expect((fixture.content.match(/\p{Script=Han}/gu)??[]).length*fixture.chapters).toBe(10000000);
  const profile=await mkdtemp(path.join(path.dirname(fixture.profile),"cold-profile-"));
  await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:fixture.workspace,workspace_id:fixture.work_ref.workspace_id,works:[{work_ref:fixture.work_ref,title:"默认小说"}]}]}));
  const started=performance.now();
  const app=await electron.launch({executablePath:process.env.HETU_PACKAGED_APP!,args:[],env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_PLUGIN_STATE_DIR:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_COLLABORATION_DIR:fixture.collaboration}});
  try{
    const page=await app.firstWindow(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await page.setViewportSize({width:1440,height:960});
    await app.evaluate(({ipcMain})=>{
      const handlers=(ipcMain as any)._invokeHandlers;(globalThis as any).__scaleTimings=[];
      for(const channel of ["desktop:library","desktop:select","desktop:read","desktop:settings","desktop:reading-state"]){
        const original=handlers.get(channel);if(!original)continue;
        handlers.set(channel,async(...args:any[])=>{const start=performance.now();try{return await original(...args);}finally{(globalThis as any).__scaleTimings.push({channel,method:typeof args[1]==="string"?args[1]:"object",started:start,ms:performance.now()-start});}});
      }
    });
    const open=page.getByRole("button",{name:"打开作品 默认小说",exact:true});await expect(open).toBeEnabled({timeout:30000});
    const libraryReady=performance.now();await open.click();
    await expect(page.getByRole("button",{name:"打开章节目录",exact:true})).toBeEnabled({timeout:30000});
    const profileReady=performance.now();await navigate(page,"小说");
    await expect(page.locator(".manuscript-title h1")).toBeVisible({timeout:30000});
    await expect(page.getByText(fixture.content.slice(0,200),{exact:true}).first()).toBeVisible({timeout:30000});
    const contentReady=performance.now();
    await info.attach("first-content-ipc-timings",{body:JSON.stringify(await app.evaluate(()=>(globalThis as any).__scaleTimings)),contentType:"application/json"});
    await writeFile(info.outputPath("first-content-ipc-timings.json"),JSON.stringify(await app.evaluate(()=>(globalThis as any).__scaleTimings),null,2));
    await openDirectory(page);const directory=page.getByRole("navigation",{name:"文稿目录",exact:true});
    await expect(directory).toHaveAttribute("aria-busy","false");await expect(directory.locator(".chapter-group button")).toHaveCount(1000);
    const directoryReady=performance.now(),last=directory.getByRole("button",{name:"第1000章 海港来信",exact:true});await last.click();
    await expect(page.locator(".manuscript-title h1")).toHaveText("第1000章 海港来信");
    await expect(page.getByText(fixture.content.slice(0,200),{exact:true}).first()).toBeVisible();
    const lastReady=performance.now();
    const actual=await page.evaluate(async id=>{const result=await window.hetuDesktop.read("hetu.documents.get",{document_id:id});if(result.status!=="succeeded")throw Error(JSON.stringify(result));return result.data;},fixture.documents.at(-1));
    expect(actual.content).toBe(fixture.content);expect(errors).toEqual([]);
    await page.evaluate(async()=>{const preferences=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:preferences.revision,patch:{autosave:false}});});
    await app.evaluate(({ipcMain})=>{
      const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:read");
      (globalThis as any).__scaleSearchReads=0;
      handlers.set("desktop:read",async(...args:any[])=>{
        if(args[1]!=="hetu.documents.get")return original(...args);
        (globalThis as any).__scaleSearchReads++;const value=await original(...args);
        if((globalThis as any).__scaleSearchReads===1)await new Promise<void>(resolve=>{(globalThis as any).__releaseScaleSearch=()=>{(globalThis as any).__scaleSearchReleased=true;resolve();};});
        return value;
      });
    });
    await page.getByRole("button",{name:"搜索正文",exact:true}).click();
    const search=page.getByRole("region",{name:"正文查找",exact:true});await search.getByRole("textbox",{name:"搜索正文内容",exact:true}).fill("没有出现的航标标记");
    await search.locator("details.search-filter > summary").click();await search.getByRole("menuitemradio",{name:"本作品已保存正文",exact:true}).click();
    await expect.poll(()=>app.evaluate(()=>typeof(globalThis as any).__releaseScaleSearch)).toBe("function");
    await documentAction(page,"编辑");const editor=page.getByRole("textbox",{name:"文稿编辑",exact:true});await editor.press(process.platform==="darwin"?"Meta+ArrowDown":"Control+End");
    await page.keyboard.insertText("规模验收输入");await expect(editor).toContainText("规模验收输入");
    const cancelStart=performance.now();await page.getByRole("button",{name:"取消查询",exact:true}).click();
    const results=page.getByRole("region",{name:"作品正文查询结果",exact:true});await expect(results).toContainText("查询已取消");const cancelMs=performance.now()-cancelStart;
    await app.evaluate(()=>(globalThis as any).__releaseScaleSearch());
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    expect(await app.evaluate(()=>(globalThis as any).__scaleSearchReads)).toBe(1);await expect(results).toContainText("查询已取消");
    await editor.press("ControlOrMeta+z");await expect(page.locator(".save-state")).not.toContainText("有未保存修改");
    await page.getByRole("button",{name:"关闭正文搜索",exact:true}).click();
    const unchanged=await page.evaluate(async id=>(await window.hetuDesktop.read("hetu.documents.get",{document_id:id})).data,fixture.documents.at(-1));expect(unchanged.revision.revision_id).toBe(actual.revision.revision_id);expect(unchanged.content).toBe(fixture.content);
    const result={platform:process.platform,os_release:release(),os_version:version(),architecture:process.arch,cpu:cpus()[0]?.model,logical_cpus:cpus().length,memory_bytes:totalmem(),fixture_han_characters:fixture.han_characters,chapters:1000,source_sha256:manifest?.source.sha256??fixture.installed_source_sha256,fixture_created_with_source:fixture.installed_source_sha256,executable:process.env.HETU_PACKAGED_APP,viewport:{width:1440,height:960},launch_to_library_ms:libraryReady-started,work_to_profile_ms:profileReady-libraryReady,work_to_content_ms:contentReady-libraryReady,launch_to_content_ms:contentReady-started,complete_directory_ms:directoryReady-libraryReady,last_chapter_ms:lastReady-directoryReady,background_cancel_ms:cancelMs,background_read_started:true,input_during_background_read:true,no_additional_reads_after_cancel:true,formal_revision_unchanged:true,model_turns:0,method:"全新应用进程和新资料偏好；OS文件缓存未清空，播种产生的磁盘缓存可能仍热；进程启动／作品点击分别计时，实际首段可见且完整目录和末章Core字节核对；后台取消另在真实读取完成暂扣回执时验证"};
    await writeFile(info.outputPath("project-scale.json"),JSON.stringify(result,null,2));await info.attach("project-scale",{body:JSON.stringify(result),contentType:"application/json"});await page.screenshot({path:info.outputPath("project-scale.png")});
    expect(result.work_to_content_ms).toBeLessThanOrEqual(5000);
    expect(cancelMs).toBeLessThanOrEqual(1000);
  }finally{await app.evaluate(()=>(globalThis as any).__releaseScaleSearch?.()).catch(()=>{});await closeApplication(app);}
});
