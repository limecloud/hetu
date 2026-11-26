import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {spawn,spawnSync} from "node:child_process";
import {createInterface} from "node:readline";
import path from "node:path";
import os from "node:os";
import {agentSessionSandbox} from "../src/main/agent/context.ts";
import {scopedCli} from "../src/main/cli.ts";
import {discoverEngines} from "../src/main/agent/engines.ts";
import {fixtureBinary} from "./acceptance-paths.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("从创作库选作品到原生终端，任务交接、真实MCP保存、成果审阅及类型切换",async({},info)=>{
  test.setTimeout(180000);
  const engines=await discoverEngines();
  test.skip(!["codex","claude-code"].every(id=>engines.some(engine=>engine.id===id&&engine.available)),"需本机已安装Codex与Claude Code以验证真实PTY和工具接入");
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-business-e2e-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
  const fixture=spawnSync(fixtureBinary("baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.error?.message??fixture.stderr).toBe(0);const context=JSON.parse(fixture.stdout);
  await mkdir(profile,{recursive:true});await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:context.novel.workspace_id,works:[{work_ref:context.novel,title:"默认小说"},{work_ref:context.drama,title:"默认剧本"},{work_ref:context.video,title:"默认视频"}]}]}));
  const executable=process.env.HETU_PACKAGED_APP;
  const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,...(!executable?{HETU_PLUGIN_NODE:process.execPath}:{}),HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,...(!executable?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
  let relay:ReturnType<typeof spawn>|undefined;
  try{
    const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
    await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled({timeout:30000});
    await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
    const launch=page.getByRole("dialog",{name:"创建会话",exact:true});await expect(launch).toBeVisible();
    await launch.getByRole("combobox",{name:"会话作品",exact:true}).selectOption({label:"默认小说"});
    await launch.getByRole("button",{name:/^引擎(?: |$)/}).click();await launch.getByRole("tab",{name:"Claude Code",exact:true}).click();await launch.getByRole("button",{name:"打开终端",exact:true}).click();
    await expect(launch).toHaveCount(0,{timeout:45000});
    const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get"));
    await expect.poll(async()=>(await get()).client).toBe("claude-code");const original=await get();expect(original.work_ref).toEqual(context.novel);expect(original.terminal_connected).toBe(true);
    const taskBox=await page.getByLabel("创作任务",{exact:true}).boundingBox(),newBox=await page.getByRole("button",{name:"新建会话",exact:true}).boundingBox();expect(taskBox!.x+taskBox!.width).toBeLessThanOrEqual(newBox!.x);
    const choose=page.getByRole("combobox",{name:"会话作品",exact:true});await expect(choose).toHaveValue(JSON.stringify([context.novel.workspace_id,"novel",context.novel.object_id]));
    // 临时讨论不准备领域交接；只读与返工请求分别保留停止条件和需保留内容。
    await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:handoff");(globalThis as any).__positioningHandoffs=0;handlers.set("desktop:handoff",(...args:any[])=>{(globalThis as any).__positioningHandoffs++;return original(...args);});});
    await page.getByLabel("创作任务",{exact:true}).click();await page.getByRole("button",{name:"讨论创作方向",exact:true}).click();
    const discussion=page.getByRole("dialog",{name:"讨论创作方向",exact:true});await discussion.getByRole("textbox",{name:"创作目标",exact:true}).fill("先想三个名字，不保存。");await discussion.getByRole("button",{name:"准备请求",exact:true}).click();await expect(discussion).toHaveCount(0);
    expect(await app.evaluate(()=>(globalThis as any).__positioningHandoffs)).toBe(0);expect((await get()).draft).toContain("不创建作品、章节、任务");
    await page.getByLabel("创作任务",{exact:true}).click();await page.getByRole("button",{name:"查阅作品",exact:true}).click();const reading=page.getByRole("dialog",{name:"查阅作品",exact:true});await reading.getByRole("button",{name:"准备请求",exact:true}).click();await expect(reading).toHaveCount(0);expect((await get()).draft).toContain("本次只读查阅");
    await page.getByLabel("创作任务",{exact:true}).click();await page.getByRole("button",{name:"按意见返工",exact:true}).click();const revising=page.getByRole("dialog",{name:"按意见返工",exact:true});await revising.getByRole("textbox",{name:"需要保留的内容",exact:true}).fill("第三章的和解与昨天的对白不动。");await revising.getByRole("button",{name:"准备请求",exact:true}).click();await expect(revising).toHaveCount(0);expect((await get()).draft).toContain("第三章的和解与昨天的对白不动。");await page.screenshot({path:info.outputPath("positioning-request.png")});
    const directory=page.getByRole("complementary",{name:"作品目录",exact:true});await expect(directory.getByRole("button",{name:"第一章 雾港",exact:true})).toBeVisible();
    await directory.getByRole("button",{name:"第一章 雾港",exact:true}).click();
    const sessionTab=page.getByRole("tab",{name:"Claude Code",exact:true});await expect(sessionTab).toBeVisible();await expect(page.getByRole("tab",{name:"Codex",exact:true})).toHaveCount(0);
    await sessionTab.click();expect((await get()).session_id).toBe(original.session_id);expect((await get()).generation).toBe(original.generation);
    const handoff=await page.evaluate(()=>window.hetuDesktop.handoff("work.resources",{},"draft"));expect(handoff?.prompt).toContain('"client_adapter": "claude-code"');expect(handoff?.prompt).not.toContain("management_ref");
    const writing=await page.evaluate(input=>window.hetuDesktop.writingPrompt(input),{work_ref:context.novel,tool_id:"continue",object_ref:{document_id:context.document.document.document_id,revision_id:context.document.revision.revision_id}});expect(writing.prompt).toContain('"client_adapter": "claude-code"');
    // 具体文稿固定引用由正式目录的引用入口验证，不依赖模型理解。
    await page.getByLabel("创作任务",{exact:true}).click();await page.getByRole("button",{name:"整理资料",exact:true}).click();const task=page.getByRole("dialog",{name:"整理资料",exact:true});await expect(task).toBeVisible();
    await task.getByRole("textbox",{name:"创作目标",exact:true}).fill("整理港口考据，保留当前作品及固定来源。");await page.screenshot({path:info.outputPath("business-task.png")});
    await task.getByRole("button",{name:"准备请求",exact:true}).click();await expect(task).toHaveCount(0);expect((await get()).draft).toContain("整理港口考据");expect((await get()).draft).toContain('"client_adapter": "claude-code"');expect((await get()).session_id).toBe(original.session_id);
    const cwd=path.join(agentSessionSandbox(profile,context.novel),original.session_id!);const config=JSON.parse(await readFile(path.join(cwd,"hetu-mcp.json"),"utf8"));expect(config.args[1]).toBe("claude-code");
    const appPath=await app.evaluate(({app})=>app.getAppPath()),runtime=executable?path.join(path.dirname(appPath),"bin/node"):process.execPath;
    const relayFile=path.join(appPath,"dist/agent-mcp-relay.mjs");
    relay=spawn(runtime,[relayFile,path.join(cwd,"hetu-mcp.json")],{stdio:["pipe","pipe","pipe"],env:{...process.env,HETU_COLLABORATION_DIR:collaboration}});
    const waiting=new Map<number,{resolve(value:any):void;reject(error:Error):void;timer:NodeJS.Timeout}>();let next=0;let stderr="";relay.stderr!.on("data",data=>stderr+=data);
    createInterface({input:relay.stdout!}).on("line",line=>{const message=JSON.parse(line),pending=waiting.get(message.id);if(pending){clearTimeout(pending.timer);waiting.delete(message.id);message.error?pending.reject(Error(JSON.stringify(message.error))):pending.resolve(message.result);}});
    const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{waiting.delete(id);reject(Error("MCP请求超时："+method+stderr));},30000);waiting.set(id,{resolve,reject,timer});relay!.stdin!.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});
    await rpc("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"hetu-business-acceptance",version:"1"}});relay.stdin!.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
    const tools=await rpc("tools/list",{});expect(tools.tools.some((item:any)=>item.name==="hetu_call_action")).toBe(true);
    const created=await rpc("tools/call",{name:"hetu_call_action",arguments:{action:"hetu.resources.create",input:{work_ref:context.novel,title:"业务接入考据",category:"research",body:"港口夜航应按潮汐安排行程。",tags:[],project_id:null,entity_refs:[],source_notes:"本对话隔离业务验收",operation_key:"business-resource"}}});
    expect(created.structuredContent.status,JSON.stringify(created)).toBe("succeeded");const resource=created.structuredContent.data.resource;
    const refused=await rpc("tools/call",{name:"hetu_call_action",arguments:{action:"hetu.resources.get",input:{work_ref:context.drama,resource_id:resource.resource_id}}});expect(refused.structuredContent.status).not.toBe("succeeded");
    const fixed=await page.evaluate(()=>window.hetuDesktop.connection("status","claude-code"));
    const reread=await scopedCli(executable?path.join(path.dirname(appPath),"bin/hetu"):path.join(root,"target/debug/hetu"),"claude-code",collaboration,"hetu.resources.get",{management_ref:fixed.management_ref,resource_id:resource.resource_id,revision:resource.revision});expect(reread.data.resource.body).toBe("港口夜航应按潮汐安排行程。");
    await page.getByRole("button",{name:"查看作品成果",exact:true}).click();const results=page.getByRole("region",{name:"作品成果",exact:true});
    await expect(results.getByRole("button",{name:"重新回读",exact:true})).toBeEnabled({timeout:30000});
    await expect(results.getByRole("button",{name:"业务接入考据",exact:true})).toBeEnabled();await expect(directory.getByRole("button",{name:"业务接入考据",exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath("business-results.png")});await results.getByRole("button",{name:"业务接入考据",exact:true}).click();await expect(page.getByRole("main",{name:"附件工作区",exact:true})).toContainText("港口夜航应按潮汐安排行程。");
    await page.evaluate(work_ref=>window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref}})),context.novel);await expect(choose).toBeVisible();await choose.selectOption({label:"默认剧本"});await expect(launch).toBeVisible();await launch.getByRole("button",{name:"关闭创建会话",exact:true}).click();
    await page.getByLabel("创作任务",{exact:true}).click();await expect(page.getByRole("button",{name:"整理分集大纲",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"整理卷章大纲",exact:true})).toHaveCount(0);await page.keyboard.press("Escape");
    for(const pageId of ["work.profile","novel.outlines","work.canon","work.resources","work.images","work.delivery"]){const request=await page.evaluate(pageId=>window.hetuDesktop.handoff(pageId,{},"draft"),pageId);expect(request?.work_ref).toEqual(context.drama);}
    await expect(page.evaluate(input=>window.hetuDesktop.agentSession("insert",input),{work_ref:context.novel,session_id:original.session_id,text:"旧作品请求"})).rejects.toThrow(/作品已切换/);
    await choose.selectOption({label:"默认视频"});await expect(launch).toBeVisible();await launch.getByRole("button",{name:"关闭创建会话",exact:true}).click();await page.getByLabel("创作任务",{exact:true}).click();await expect(page.getByRole("button",{name:"推进分镜与视频",exact:true})).toBeVisible();await page.keyboard.press("Escape");
    for(const pageId of ["work.profile","work.canon","work.resources","work.media","work.delivery"]){const request=await page.evaluate(pageId=>window.hetuDesktop.handoff(pageId,{},"draft"),pageId);expect(request?.work_ref).toEqual(context.video);}
    await choose.selectOption({label:"默认小说"});await expect.poll(async()=>(await get()).session_id).toBe(original.session_id);expect((await get()).generation).toBe(original.generation);
    // 同版Codex接收当前小说的固定任务，只放入草稿，不发模型轮次。
    await page.getByRole("button",{name:"新建会话",exact:true}).click();await launch.getByRole("button",{name:/^引擎(?: |$)/}).click();await launch.getByRole("tab",{name:"Codex",exact:true}).click();await launch.getByRole("button",{name:"打开终端",exact:true}).click();await expect(launch).toHaveCount(0,{timeout:45000});
    await expect.poll(async()=>{const value=await get();return value.client==="codex"&&value.terminal_connected&&value.terminal_replay?.includes("]7501;state=idle");},{timeout:45000}).toBe(true);
    for(const pageId of ["work.profile","novel.outlines","work.canon","work.resources","work.images","work.delivery"]){
      const request=await page.evaluate(pageId=>window.hetuDesktop.handoff(pageId,{},"draft"),pageId);expect(request?.prompt).toContain('"client_adapter": "codex"');expect(request?.work_ref).toEqual(context.novel);
    }
    await page.getByLabel("创作任务",{exact:true}).click();await page.getByRole("button",{name:"接续创作",exact:true}).click();const continuation=page.getByRole("dialog",{name:"接续创作",exact:true});await continuation.getByRole("button",{name:"放入终端",exact:true}).click();await expect(continuation).toHaveCount(0,{timeout:45000});expect((await get()).draft).toContain("当前作品");expect((await get()).messages).toHaveLength(0);
    await page.screenshot({path:info.outputPath("codex-business.png")});
    await choose.selectOption({label:"创作库"});await expect(launch).toBeVisible();await launch.getByRole("button",{name:"创建",exact:true}).click();await expect(launch).toHaveCount(0,{timeout:45000});
    await expect.poll(async()=>{const value=await page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));return value.terminal_connected&&value.terminal_replay?.includes("]7501;state=idle");},{timeout:45000}).toBe(true);
    await page.getByLabel("创作任务",{exact:true}).click();await page.getByRole("button",{name:"新建小说",exact:true}).click();const creation=page.getByRole("dialog",{name:"新建小说",exact:true});await creation.getByRole("button",{name:"放入终端",exact:true}).click();await expect(creation).toHaveCount(0,{timeout:45000});
    const libraryDraft=await page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));expect(libraryDraft.work_ref).toBeUndefined();expect(libraryDraft.draft).toContain('"work_type": "novel"');expect(libraryDraft.messages).toHaveLength(0);
    await page.screenshot({path:info.outputPath("creation-preparation.png")});
    await page.setViewportSize({width:980,height:720});await page.screenshot({path:info.outputPath("business-narrow.png")});
    expect(await page.locator(".codex-session-header").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    await writeFile(info.outputPath("result.json"),JSON.stringify({packaged:!!executable,client:"claude-code",work_types:["novel","drama","video"],resource:resource.resource_id,core_reread:true,cross_work_refused:true,model_turns:0,session_restored:true,writing_prompt_prepared:!!writing,codex_task_drafted:true,creation_task_drafted:true},null,2));
  }catch(error){await app.windows()[0]?.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});throw error;}finally{relay?.kill();await app.close();}
});
