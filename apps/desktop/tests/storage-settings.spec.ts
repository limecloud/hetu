import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, mkdir, writeFile, readFile, access} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {openSettings, closeSettings} from "./navigation.ts";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";

const root=path.resolve(import.meta.dirname,"../../..");
function fixtureEnvironment(extra:Record<string,string>){
 const env=Object.fromEntries(Object.entries(process.env).filter(([,value])=>value!==undefined)) as Record<string,string>;
 for(const key of ["HETU_APP_SERVER","HETU_CLI","HETU_PLUGIN_CLI","HETU_PLUGIN_NODE","ELECTRON_RUN_AS_NODE","HETU_INTEGRATIONS_DIR"])delete env[key];
 return {...env,...extra};
}
test("统计未返回时先显示完整清理页面，数字loading且可导航，失败重试与刷新不跳动",async()=>{
 test.setTimeout(180000);
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-storage-loading-"));
 await mkdir(path.join(profile,"GPUCache"));await writeFile(path.join(profile,"GPUCache/loading-fixture"),"cache for delayed inspection");
 const env=fixtureEnvironment({HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),HETU_MODEL_SERVICE_DIR:path.join(profile,"models"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_ACCESS_DIR:path.join(profile,"plugin-access")});
 const app=await electron.launch(process.env.HETU_PACKAGED_APP?{executablePath:process.env.HETU_PACKAGED_APP,args:[],env}:{args:[path.join(root,"apps/desktop")],env});
 try{
  const main=await app.firstWindow();await expect(main.getByRole("button",{name:"本机设置",exact:true})).toBeVisible();
  await app.evaluate(({ipcMain})=>{
   const state=(globalThis as any).__storageLoading={requests:0,gates:[]};
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:settings");
   handlers.set("desktop:settings",async(event:any,method:string,input:any)=>{
    if(method==="storage_inspect"){
     state.requests++;
     const fail=await new Promise<boolean>(resolve=>state.gates.push(resolve));
     if(fail)throw new Error("隔离统计失败，请重试。");
    }
    return original(event,method,input);
   });
  });
  const page=await openSettings(app,main);await page.getByRole("tab",{name:"存储空间",exact:true}).click();
  const quick=page.getByRole("button",{name:"一键清理",exact:true}),summary=page.locator(".storage-summary"),groups=page.locator(".storage-categories > button");
  await expect(quick).toBeVisible();await expect(quick).toBeDisabled();
  await expect(summary.locator(".storage-number-loading")).toHaveCount(2);await expect(summary).not.toContainText("0 B");await expect(groups).toHaveCount(8);
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).__storageLoading.requests)).toBeGreaterThan(0);
  await page.getByRole("button",{name:/^界面缓存/}).click();await expect(page.getByRole("heading",{name:"界面缓存",exact:true})).toBeVisible();
  await expect(page.getByText("正在读取清理项目…",{exact:true})).toBeVisible();await expect(page.getByText("没有符合条件的可清理项目。",{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"返回存储概览",exact:true}).click();await expect(summary).toBeVisible();
  await page.getByRole("tab",{name:"关于",exact:true}).click();await expect(page.getByRole("heading",{name:"关于",exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"存储空间",exact:true}).click();await expect(summary.locator(".storage-number-loading")).toHaveCount(2);
  const output=path.join(root,"output/storage-loading-20261126");await mkdir(output,{recursive:true});
  for(const [appearance,width] of [["light",1000],["dark",560]] as const){
   await page.getByRole("tab",{name:"通用",exact:true}).click();await page.getByRole("radio",{name:appearance==="light"?"浅色":"深色",exact:true}).click();
   await page.getByRole("tab",{name:"存储空间",exact:true}).click();await expect(summary.locator(".storage-number-loading")).toHaveCount(2);
   await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)).toBe(appearance);
   await app.evaluate(({BrowserWindow},width)=>{BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith("?view=settings"))!.setSize(width,820);},width);
   await page.screenshot({path:path.join(output,`loading-${appearance}-${width}.png`)});
   expect(await page.evaluate(()=>{const el=document.querySelector(".settings-panel")!;return el.scrollWidth>el.clientWidth+1;})).toBe(false);
  }
  await app.evaluate(()=>{for(const resolve of (globalThis as any).__storageLoading.gates.splice(0))resolve(true);});
  await expect(page.getByRole("alert")).toContainText("隔离统计失败");await expect(summary.locator(".storage-number-loading")).toHaveCount(0);
  await expect(summary).not.toContainText("0 B");await expect(quick).toBeDisabled();await expect(groups).toHaveCount(8);
  await page.getByRole("button",{name:"重试统计",exact:true}).click();await expect(summary.locator(".storage-number-loading")).toHaveCount(2);
  const before=(await quick.boundingBox())!;
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).__storageLoading.gates.length)).toBeGreaterThan(0);
  await app.evaluate(()=>{for(const resolve of (globalThis as any).__storageLoading.gates.splice(0))resolve(false);});
  await expect(quick).toBeEnabled();await expect(summary.locator(".storage-number-loading")).toHaveCount(0);await expect(summary.locator("strong").first()).toContainText("B");await expect(groups).toHaveCount(8);
  const after=(await quick.boundingBox())!;expect(Math.abs(before.y-after.y)).toBeLessThanOrEqual(1);
  await page.getByRole("button",{name:"重新统计",exact:true}).click();await expect(summary.locator(".storage-number-loading")).toHaveCount(2);await expect(quick).toBeDisabled();await expect(groups).toHaveCount(8);
  await app.evaluate(()=>{for(const resolve of (globalThis as any).__storageLoading.gates.splice(0))resolve(false);});await expect(quick).toBeEnabled();
 }finally{
  test.info().annotations.push({type:"scope",description:"仅终止隔离测试实例，未清理真实资料"});
  const pid=app.process().pid!;try{process.kill(pid,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
  await expect.poll(()=>{try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==="ESRCH";}},{timeout:10000}).toBe(true);
 }
});
test("概览一键清理刷新全部候选，只确认一次，取消不删并保护草稿及未知会话",async()=>{
 test.setTimeout(180000);
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-storage-oneclick-"));
 const settings=path.join(profile,"local-settings"),removed=path.join(profile,"agent-sessions/removed");
 await mkdir(removed,{recursive:true});await mkdir(path.join(profile,"GPUCache"));await mkdir(path.join(profile,"Recovery"));
 const record={schema_version:1,session_id:"codex-1234567890123456",title:"一键清理隔离会话",messages:[],tools:[],draft:""};
 const cleanRecord=path.join(removed,"codex-1234567890123456-1234567890123.json"),cache=path.join(profile,"GPUCache/oneclick-fixture");
 const draft=path.join(removed,"codex-draft123456789012-1234567890123.json"),unknown=path.join(removed,"codex-unknown123456789-1234567890123.json"),recovery=path.join(profile,"Recovery/unsaved.txt");
 await writeFile(cleanRecord,JSON.stringify(record));await writeFile(cache,"one click cache");
 const protectedFiles=new Map([[draft,JSON.stringify({...record,draft:"未发送草稿"})],[unknown,JSON.stringify({...record,messages:[{role:"user",text:"未知请求",delivery:"unknown"}]})],[recovery,"未保存稿保留"]]);
 for(const [file,value] of protectedFiles)await writeFile(file,value);
 const env=fixtureEnvironment({HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:settings,HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),HETU_MODEL_SERVICE_DIR:path.join(profile,"models"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_ACCESS_DIR:path.join(profile,"plugin-access")});
 const app=await electron.launch(process.env.HETU_PACKAGED_APP?{executablePath:process.env.HETU_PACKAGED_APP,args:[],env}:{args:[path.join(root,"apps/desktop")],env});
 try{
  const main=await app.firstWindow();await expect(main.getByRole("button",{name:"本机设置",exact:true})).toBeVisible();
  await app.evaluate(({dialog,ipcMain})=>{
   const state=(globalThis as any).__oneclick={approve:false,confirmations:[],inspections:[],prepares:[],empty:false};
   dialog.showMessageBox=async(_window:any,options:any)=>{state.confirmations.push(options);return {response:state.approve?1:0,checkboxChecked:false};};
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:settings");
   handlers.set("desktop:settings",async(event:any,method:string,input:any)=>{
    if(method==="storage_prepare")state.prepares.push(input);
    const result=await original(event,method,input);
    if(method==="storage_inspect"){
     if(state.empty)return {...result,candidates:[],cleanable_bytes:0};
     state.inspections.push(result);
    }
    return result;
   });
  });
  const page=await openSettings(app,main);await page.getByRole("tab",{name:"存储空间",exact:true}).click();
  const quick=page.getByRole("button",{name:"一键清理",exact:true}),region=page.getByRole("region",{name:"存储空间明细",exact:true});
  await expect(quick).toBeEnabled();await expect(page.locator(".storage-items")).toHaveCount(0);
  // 进入页面后出现的新文件应进入一键清理的最新固定清单。
  const added=path.join(profile,"GPUCache/new-after-open");await writeFile(added,"new cache");
  await quick.click();await expect(region).toHaveAttribute("aria-busy","false");
  const cancelled=await app.evaluate(()=>(globalThis as any).__oneclick);
  expect(cancelled.confirmations).toHaveLength(1);expect(cancelled.prepares).toHaveLength(1);
  expect([...cancelled.prepares[0].selected_ids].sort()).toEqual(cancelled.inspections.at(-1).candidates.map((v:any)=>v.id).sort());
  const plan=await page.evaluate(async()=>{const value=await window.hetuDesktop.settings("list");return value.operations.find((p:any)=>p.fixed.kind==="storage_cleanup"&&p.state==="pending");});
  expect(plan.fixed.storage.items.some((v:any)=>v.path==="GPUCache/new-after-open")).toBe(true);
  expect(cancelled.confirmations[0].detail).toContain(`${plan.fixed.storage.items.length} 项`);
  for(const file of [cleanRecord,cache,added])await access(file);
  await page.getByRole("button",{name:"返回选择",exact:true}).click();await expect(quick).toBeEnabled();
  await app.evaluate(()=>{(globalThis as any).__oneclick.approve=true;});
  await quick.click();await expect(page.getByRole("heading",{name:"清理结果",exact:true})).toBeVisible();
  expect((await app.evaluate(()=>(globalThis as any).__oneclick.confirmations)).length).toBe(2);
  for(const file of [cleanRecord,cache,added])await expect(access(file)).rejects.toThrow();
  for(const [file,value] of protectedFiles)expect(await readFile(file,"utf8")).toBe(value);
  await page.getByRole("button",{name:"完成",exact:true}).click();
  const output=path.join(root,"output/storage-oneclick-20261126");await mkdir(output,{recursive:true});
  for(const appearance of ["light","dark"]){
   await page.getByRole("tab",{name:"通用",exact:true}).click();await page.getByRole("radio",{name:appearance==="light"?"浅色":"深色",exact:true}).click();
   await page.getByRole("tab",{name:"存储空间",exact:true}).click();await expect(page.locator(".storage-summary")).toBeVisible();await expect(region).toHaveAttribute("aria-busy","false");
   for(const width of [1000,560]){
    await app.evaluate(({BrowserWindow},width)=>{BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith("?view=settings"))!.setSize(width,820);},width);
    await page.screenshot({path:path.join(output,`oneclick-${appearance}-${width}.png`)});
    expect(await page.evaluate(()=>{const el=document.querySelector(".settings-panel")!;return el.scrollWidth>el.clientWidth+1;})).toBe(false);
   }
  }
  await app.evaluate(()=>{(globalThis as any).__oneclick.empty=true;});await page.getByRole("button",{name:"重新统计",exact:true}).click();
  await expect(region).toHaveAttribute("aria-busy","false");await expect(quick).toBeDisabled();
 }finally{
  test.info().annotations.push({type:"scope",description:"仅终止隔离测试实例，正常退出由原生安装版单独验收"});
  const pid=app.process().pid!;try{process.kill(pid,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
  await expect.poll(()=>{try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==="ESRCH";}},{timeout:10000}).toBe(true);
 }
});
test("独立CLI和真实MCP共享占用、固定清理与原键回读",async()=>{
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-storage-machine-"));const settings=path.join(profile,"LocalSettings");
 await mkdir(path.join(profile,"GPUCache"));await writeFile(path.join(profile,"GPUCache/fixture.bin"),"machine cache");
 const env=fixtureEnvironment({HETU_LOCAL_SETTINGS_DIR:settings,HETU_COLLABORATION_DIR:path.join(profile,"Collaboration")});
 const bin=process.env.HETU_PACKAGED_APP?path.resolve(process.env.HETU_PACKAGED_APP,"../../Resources/bin"):path.join(root,"target/debug");
 const cli=spawnSync(path.join(bin,"hetu"),["--local","--client","generic","call","hetu.local_settings.inspect_storage","--input","-"],{env,input:JSON.stringify({}),encoding:"utf8"});
 expect(cli.status,cli.stderr).toBe(0);const scan=JSON.parse(cli.stdout).data;expect(scan.cleanable_bytes).toBe(13);
 const client=new Client({name:"hetu-storage-test",version:"1"});
 await client.connect(new StdioClientTransport({command:path.join(bin,"hetu-mcp"),args:["--client","generic","--collaboration-dir",env.HETU_COLLABORATION_DIR],env,stderr:"pipe"}));
 async function action(action:string,input:any){const result:any=await client.callTool({name:"hetu_call_action",arguments:{action:"hetu.local_settings."+action,input}});return result.structuredContent;}
 try{
  const read=await action("inspect_storage",{});expect(read.status).toBe("succeeded");expect(read.data.storage_snapshot).toBe(scan.storage_snapshot);
  const prepared=await action("prepare",{kind:"storage_cleanup",selected_ids:[scan.candidates[0].id],storage_snapshot:scan.storage_snapshot,summary:"机器入口清理隔离缓存",operation_key:"prepare-machine"});expect(prepared.status).toBe("succeeded");
  const plan=prepared.data;
  const input={operation_id:plan.operation_id,sha256:plan.sha256,operation_key:"execute-machine"};
  expect((await action("execute",input)).error.code).toBe("hetu.author_confirmation_required");
  expect((await action("record_decision",{operation_id:plan.operation_id,sha256:plan.sha256,revision:plan.revision,decision:"approve",authorization_note:"测试作者明确确认此隔离缓存清单",operation_key:"decide-machine"})).status).toBe("succeeded");
  const done=await action("execute",input);expect(done.status).toBe("succeeded");expect(done.data.result.deleted_bytes).toBe(13);
  await writeFile(path.join(profile,"GPUCache/fixture.bin"),"new file");await action("execute",input);expect(await readFile(path.join(profile,"GPUCache/fixture.bin"),"utf8")).toBe("new file");
 }finally{await client.close();}
});
test("存储分类、筛选、取消、确认、重开恢复与浅暗窄窗使用隔离资料",async()=>{
 test.setTimeout(300000);
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-storage-ui-"));
 const settings=path.join(profile,"local-settings");
 const record=path.join(profile,"agent-sessions/removed/codex-1234567890123456-1234567890123.json");
 await mkdir(path.dirname(record),{recursive:true});
 await writeFile(record,JSON.stringify({schema_version:1,session_id:"codex-1234567890123456",title:"存储清理验收会话",messages:[],tools:[],draft:""}));
 const protectedPath=path.join(profile,"Recovery/unsaved.txt");await mkdir(path.dirname(protectedPath),{recursive:true});await writeFile(protectedPath,"必须保留的未保存稿");
 const env=fixtureEnvironment({HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:settings,HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),HETU_MODEL_SERVICE_DIR:path.join(profile,"models"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_ACCESS_DIR:path.join(profile,"plugin-access")});
 const app=await electron.launch(process.env.HETU_PACKAGED_APP?{executablePath:process.env.HETU_PACKAGED_APP,args:[],env}:{args:[path.join(root,"apps/desktop")],env});
 const errors:string[]=[];
 try{
  await app.evaluate(({dialog,clipboard})=>{(globalThis as any).__storageConfirm=false;dialog.showMessageBox=async()=>({response:(globalThis as any).__storageConfirm?1:0,checkboxChecked:false});clipboard.writeText=text=>{(globalThis as any).__storageHandoff=text;};});
  const main=await app.firstWindow();let page=await openSettings(app,main);page.on("pageerror",error=>errors.push(error.message));
  await page.getByRole("tab",{name:"存储空间",exact:true}).click();
  const region=page.getByRole("region",{name:"存储空间明细",exact:true});await expect(region).toHaveAttribute("aria-busy","false");
  await page.getByRole("button",{name:"让 AI 整理",exact:true}).click();
  const handoff=await app.evaluate(()=>(globalThis as any).__storageHandoff as string);expect(handoff).toContain("hetu.local_settings.inspect_storage");expect(handoff).toContain(settings);
  await page.getByRole("button",{name:/^全部可清理项目/}).click();
  await expect(page.getByRole("checkbox",{name:/存储清理验收会话/})).toBeVisible();
  await page.getByRole("searchbox",{name:"搜索清理项目"}).fill("存储清理验收");
  await expect(page.locator(".storage-items li")).toHaveCount(1);
  await page.getByRole("combobox",{name:"清理时间筛选"}).selectOption("90");await expect(page.locator(".storage-items li")).toHaveCount(0);
  await page.getByRole("combobox",{name:"清理时间筛选"}).selectOption("0");
  await page.locator(".storage-items input[type=checkbox]").check();
  await writeFile(record,(await readFile(record,"utf8"))+"\n");
  await page.getByRole("button",{name:"查看清理清单",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("存储明细已变化");
  await page.getByRole("button",{name:"重试统计",exact:true}).click();
  await expect(page.getByRole("region",{name:"存储空间明细",exact:true})).toHaveAttribute("aria-busy","false");
  await page.locator(".storage-items input[type=checkbox]").check();
  await page.getByRole("button",{name:"查看清理清单",exact:true}).click();
  await expect(page.getByRole("region",{name:"清理确认清单"})).toBeVisible();
  await page.getByRole("button",{name:"确认清理…",exact:true}).click();await expect(region).toHaveAttribute("aria-busy","false");await access(record);
  await closeSettings(page);page=await openSettings(app,main);await page.getByRole("tab",{name:"存储空间",exact:true}).click();
  await expect(page.getByRole("region",{name:"清理确认清单"})).toBeVisible();
  const pending=await page.evaluate(async()=>{const value=await window.hetuDesktop.settings("list");return value.operations.find((v:any)=>v.fixed.kind==="storage_cleanup"&&v.state==="pending");});
  const bin=process.env.HETU_PACKAGED_APP?path.resolve(process.env.HETU_PACKAGED_APP,"../../Resources/bin/hetu"):path.join(root,"target/debug/hetu");
  const approved=spawnSync(bin,["--local","--client","generic","call","hetu.local_settings.record_decision","--input","-"],{env,input:JSON.stringify({operation_id:pending.operation_id,sha256:pending.sha256,revision:pending.revision,decision:"approve",authorization_note:"测试作者批准隔离清单后决定撤回，尚未执行","operation_key":"approve-before-withdraw"}),encoding:"utf8"});
  expect(approved.status,approved.stderr).toBe(0);
  await page.getByRole("button",{name:"返回选择",exact:true}).click();await expect(page.getByRole("region",{name:"清理确认清单"})).toHaveCount(0);await access(record);
  const withdrawn=await page.evaluate(operation_id=>window.hetuDesktop.settings("storage_operation",{operation_id}),pending.operation_id);expect(withdrawn.state).toBe("rejected");
  await page.getByRole("button",{name:/^全部可清理项目/}).click();await page.getByRole("checkbox",{name:/存储清理验收会话/}).check();
  await page.getByRole("button",{name:"查看清理清单",exact:true}).click();await expect(page.getByRole("region",{name:"清理确认清单"})).toBeVisible();
  await app.evaluate(()=>{(globalThis as any).__storageConfirm=true;});
  await page.getByRole("button",{name:"确认清理…",exact:true}).click();
  await expect(page.getByRole("heading",{name:"清理结果",exact:true})).toBeVisible();
  await expect(access(record)).rejects.toThrow();expect(await readFile(protectedPath,"utf8")).toBe("必须保留的未保存稿");
  await writeFile(record,"同路径的新文件");
  const op=await page.evaluate(async()=>{const page=await window.hetuDesktop.settings("list");return page.operations.find((v:any)=>v.fixed.kind==="storage_cleanup"&&v.state==="executed").operation_id;});
  await page.evaluate(operation_id=>window.hetuDesktop.settings("storage_execute",{operation_id}),op);
  expect(await readFile(record,"utf8")).toBe("同路径的新文件");
  const output=path.join(root,"output/storage-management-20261126");await mkdir(output,{recursive:true});
  for(const appearance of ["light","dark"]){
   await page.getByRole("tab",{name:"通用",exact:true}).click();await page.getByRole("radio",{name:appearance==="light"?"浅色":"深色",exact:true}).click();
   await page.getByRole("tab",{name:"存储空间",exact:true}).click();
   await expect(page.locator(".storage-summary")).toBeVisible();
   await expect(page.getByRole("region",{name:"存储空间明细"})).toHaveAttribute("aria-busy","false");
   for(const width of [1000,560]){
    await app.evaluate(({BrowserWindow},width)=>{BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith("?view=settings"))!.setSize(width,820);},width);
    await page.screenshot({path:path.join(output,`storage-${appearance}-${width}.png`)});
    expect(await page.evaluate(()=>{const el=document.querySelector(".settings-panel")!;return el.scrollWidth>el.clientWidth+1;})).toBe(false);
   }
  }
  expect(errors).toEqual([]);
  const cli=spawnSync(bin,["--local","--client","generic","call","hetu.local_settings.inspect_storage","--input","-"],{env,input:JSON.stringify({}),encoding:"utf8"});
  expect(cli.status,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).data.total_bytes).toBeGreaterThan(0);
 }catch(error){console.error("存储旅程断言失败：",error);throw error;}finally{
  // 清理结果已回读；主进程退出由生命周期专项和安装后的原生窗口单独验收。
  test.info().annotations.push({type:"scope",description:"仅终止隔离测试实例，不将调试器下的主进程正常退出计为通过"});
  const pid=app.process().pid!;
  try{process.kill(pid,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
  await expect.poll(()=>{try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==="ESRCH";}},{timeout:10000}).toBe(true);
 }
});
