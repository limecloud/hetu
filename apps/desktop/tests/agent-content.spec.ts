import {createTerminal,switchAgentSurface} from "./navigation.ts";
import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {AppServer} from "../src/main/rpc.ts";
import {navigate} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("目录和预览完整键盘菜单、读取恢复、旧修订及迟到回包保持原会话",async()=>{
  test.setTimeout(120000);
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-agent-content-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
  const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);
  const context=JSON.parse(fixture.stdout),core=await AppServer.open(path.join(root,"target/debug/hetu-app-server"),workspace);
  const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,contract_revision:"1",input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
  const documents:any[]=[];
  for(const [index,title] of ["第二章 潮声","第三章 夜航","第四章 风雨","第五章 来信"].entries())documents.push(await call("hetu.documents.create",{kind:"novel_chapter",title,source_format:"markdown",content:title+"的固定原文。"+"\n\n海风从远方吹来。".repeat(80),operation_key:"content-"+index}));
  await mkdir(profile,{recursive:true});await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:context.novel.workspace_id,works:[{work_ref:context.novel,title:"默认小说"}]}]}));
  const executable=process.env.HETU_PACKAGED_APP,env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration};
  for(const key of ["HETU_APP_SERVER","HETU_CLI","HETU_MCP","HETU_PLUGIN_NODE","ELECTRON_RUN_AS_NODE"])delete (env as Record<string,string|undefined>)[key];
  const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...env,...(!executable?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
  try{
    const screenshots=path.join(root,"output/pty-codex-interactions");await mkdir(screenshots,{recursive:true});
    const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
    await page.getByRole("button",{name:"刷新创作库",exact:true}).click();await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await navigate(page,"Agent 协作");await page.getByRole("button",{name:"关闭创建会话",exact:true}).click();
    const before=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));
    const directory=page.getByRole("complementary",{name:"作品目录",exact:true}),preview=page.getByRole("region",{name:"作品内容预览",exact:true});
    const row=(title:string)=>directory.getByRole("button",{name:title,exact:true});
    const tab=(title:string)=>page.getByRole("tab",{name:title,exact:true});
    await expect(directory.locator(".agent-content-entry")).toHaveCount(5);
    await directory.getByRole("button",{name:"折叠全部目录",exact:true}).click();await expect(directory.locator(".agent-content-entry")).toHaveCount(0);
    const group=directory.locator(".agent-content-group");await group.focus();await group.press("ArrowRight");await expect(group).toHaveAttribute("aria-expanded","true");await group.press("ArrowRight");await expect(row("第一章 雾港")).toBeFocused();
    await row("第一章 雾港").press("ArrowDown");await expect(row("第二章 潮声")).toBeFocused();await row("第二章 潮声").press("Control+Enter");
    await expect(tab("第二章 潮声")).toBeVisible();await expect(page.locator(".agent-content-temporary")).toHaveCount(0);
    await row("第一章 雾港").click();await expect(page.locator(".agent-content-temporary")).toHaveCount(1);
    await tab("第一章 雾港").focus();await tab("第一章 雾港").press("Shift+F10");await page.getByRole("menuitem",{name:"保留标签",exact:true}).click();await expect(page.locator(".agent-content-temporary")).toHaveCount(0);
    await row("第三章 夜航").dblclick();await expect(tab("第三章 夜航")).toBeVisible();
    await tab("第一章 雾港").focus();await tab("第一章 雾港").press("ArrowLeft");await expect(tab("第二章 潮声")).toBeFocused();await expect(tab("第二章 潮声")).toHaveAttribute("aria-selected","true");
    await tab("第二章 潮声").press("Home");await expect(tab("Codex")).toBeFocused();await expect(page.locator(".agent-content-terminal")).toBeVisible();
    await tab("Codex").press("End");await expect(tab("第三章 夜航")).toBeFocused();
    await tab("第三章 夜航").click({button:"middle"});await expect(tab("第三章 夜航")).toHaveCount(0);await expect(tab("第一章 雾港")).toHaveAttribute("aria-selected","true");await expect(tab("第一章 雾港")).toBeFocused();
    await tab("第二章 潮声").click({button:"right"});await page.getByRole("menuitem",{name:"关闭右侧预览",exact:true}).click();await expect(tab("第一章 雾港")).toHaveCount(0);
    await row("第一章 雾港").dblclick();await tab("第二章 潮声").click({button:"right"});await page.getByRole("menuitem",{name:"关闭其他预览",exact:true}).click();await expect(tab("第一章 雾港")).toHaveCount(0);
    const windowIds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>window.id));
    await row("第三章 夜航").dblclick();await tab("第三章 夜航").focus();await tab("第三章 夜航").press(process.platform==="darwin"?"Meta+w":"Control+w");
    await expect(tab("第三章 夜航")).toHaveCount(0);expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>window.id))).toEqual(windowIds);
    await expect(tab("第二章 潮声")).toBeFocused();
    // 定位会清除筛选并展开对应分组，焦点回到该正式对象。
    await tab("第二章 潮声").click();await directory.getByRole("searchbox",{name:"查找作品内容",exact:true}).fill("不存在");await expect(directory.getByText("没有匹配的内容。",{exact:true})).toBeVisible();
    await directory.getByRole("button",{name:"定位当前预览",exact:true}).click();await expect(row("第二章 潮声")).toBeFocused();await expect(directory.getByRole("searchbox",{name:"查找作品内容",exact:true})).toHaveValue("");
    await row("第二章 潮声").press("ArrowLeft");await expect(group).toBeFocused();await group.press("ArrowLeft");await expect(group).toHaveAttribute("aria-expanded","false");
    await tab("第二章 潮声").click({button:"right"});await page.getByRole("menuitem",{name:"在目录中显示",exact:true}).click();await expect(row("第二章 潮声")).toBeFocused();
    // 各种服务故障仍经过真实Owner读取；只延后回包或注入一次错误。
    await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,read=handlers.get("desktop:read");(globalThis as any).__contentReads={};handlers.set("desktop:read",async(event:any,action:string,input:any)=>{
      if(action==="hetu.documents.list")(globalThis as any).__directoryReads=((globalThis as any).__directoryReads??0)+1;
      if(action==="hetu.documents.get"){
        const state=globalThis as any;state.__contentReads[input.document_id]=(state.__contentReads[input.document_id]??0)+1;
        if(state.__failDocument===input.document_id){delete state.__failDocument;throw Error("隔离读取故障");}
        const result=await read(event,action,input);
        if(state.__delayDocument===input.document_id){delete state.__delayDocument;state.__delayed=true;await new Promise(resolve=>{state.__releasePreview=resolve;});}
        return result;
      }return read(event,action,input);
    });});
    await app.evaluate((_,id)=>(globalThis as any).__failDocument=id,documents[2].document.document_id);
    await row("第四章 风雨").click();await expect(preview.getByRole("alert")).toContainText("隔离读取故障");await preview.getByRole("button",{name:"重新读取预览",exact:true}).click();await expect(preview).toContainText("第四章 风雨的固定原文");
    const reads=await app.evaluate((_,id)=>(globalThis as any).__contentReads[id],documents[2].document.document_id);
    await tab("Codex").click();await row("第四章 风雨").click();await expect(preview).toContainText("第四章 风雨的固定原文");expect(await app.evaluate((_,id)=>(globalThis as any).__contentReads[id],documents[2].document.document_id)).toBe(reads);
    await app.evaluate((_,id)=>(globalThis as any).__delayDocument=id,documents[3].document.document_id);
    await row("第五章 来信").click();await expect.poll(()=>app.evaluate(()=>(globalThis as any).__delayed)).toBe(true);
    await row("第一章 雾港").click();await expect(preview).toContainText("灯塔在黎明前亮起");await app.evaluate(()=>(globalThis as any).__releasePreview());await expect(preview).toContainText("灯塔在黎明前亮起");await expect(preview).not.toContainText("第五章 来信的固定原文");
    // 目录指向新修订，已经打开的旧修订保持原文，作者显式切到当前修订。
    await row("第二章 潮声").click();await call("hetu.documents.save",{document_id:documents[0].document.document_id,base_revision_id:documents[0].revision.revision_id,source_format:"markdown",content:"第二章的新修订正文。",operation_key:"content-revision"});
    const directoryReads=await app.evaluate(()=>(globalThis as any).__directoryReads??0);
    await page.evaluate(()=>{window.hetuDesktop.onAgentSession(event=>{if(event.type==="notification") (window as any).__lastContentNotification=event.session_id;});});
    await app.evaluate(({BrowserWindow},work)=>{BrowserWindow.getAllWindows()[0].webContents.send("desktop:agent-session",{type:"notification",method:"turn/completed",params:{},session_id:"background-other-work",work_ref:{...work,object_id:"other-work"}});},context.novel);
    await expect.poll(()=>page.evaluate(()=>(window as any).__lastContentNotification)).toBe("background-other-work");expect(await app.evaluate(()=>(globalThis as any).__directoryReads??0)).toBe(directoryReads);
    await app.evaluate(({BrowserWindow},work)=>{BrowserWindow.getAllWindows()[0].webContents.send("desktop:agent-session",{type:"notification",method:"turn/completed",params:{},session_id:"background-same-work",work_ref:work});},context.novel);
    await expect(preview.getByRole("status")).toContainText("正在查看旧修订");await expect(preview).toContainText("第二章 潮声的固定原文");
    expect(await app.evaluate(()=>(globalThis as any).__directoryReads??0)).toBeGreaterThan(directoryReads);
    await expect(tab("第二章 潮声（旧修订）")).toHaveAttribute("aria-selected","true");
    await page.screenshot({path:path.join(screenshots,"fixed-revision-preview.png")});
    await preview.getByRole("button",{name:"查看当前修订",exact:true}).click();await expect(preview).toContainText("第二章的新修订正文");await expect(preview.getByText("正在查看旧修订",{exact:true})).toHaveCount(0);
    await page.getByRole("tab",{name:"第二章 潮声",exact:true}).last().click({button:"right"});await page.screenshot({path:path.join(screenshots,"preview-tab-menu.png")});await page.getByRole("menuitem",{name:"关闭所有预览",exact:true}).click();await expect(page.getByRole("tab")).toHaveCount(0);await expect(page.locator(".agent-content-terminal")).toBeVisible();await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    const after=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));expect(after.session_id).toBe(before.session_id);expect(after.thread_id).toBe(before.thread_id);expect(after.state).toBe("idle");
    await page.screenshot({path:path.join(screenshots,"preview-keyboard-and-recovery.png")});
  }finally{await app.evaluate(()=>(globalThis as any).__releasePreview?.()).catch(()=>{});await app.close();await core.close();}
});
