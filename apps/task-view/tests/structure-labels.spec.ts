import {test,expect,_electron as electron,type ElectronApplication,type Page,type FrameLocator} from "@playwright/test";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {build} from "esbuild";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createServer,type Server} from "node:http";
import {PluginPackage} from "../../../packages/plugin-host/src/package.ts";
import {codexWorkbench} from "./codex-workbench.ts";
import {closeApplication} from "../../desktop/tests/navigation.ts";

for(const surface of ["desktop","stdio","codex"] as const)test(`${surface} 资料页按需读取103章真实名称，卷章失败可重试、关闭隔离迟到回包`,async({page},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");test.setTimeout(180000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-structure-names-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 await mkdir(profile);const pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
 const fixture=spawnSync(path.join(root,"target/debug/examples/plugin_fixture"),[workspace,path.join(folder,"access"),path.join(pkg.source,"plugin.json"),pkg.sha256,"102"],{encoding:"utf8",timeout:90000});
 expect(fixture.status,fixture.stderr).toBe(0);const refs=JSON.parse(fixture.stdout),work=refs.work_ref;
 await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"插件集成测试"}]}]}));
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_PLUGIN_STATE_DIR:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_NODE:process.execPath,HETU_CODEX_BIN:path.join(folder,"no-agent")};
 let app:ElectronApplication|undefined,client:any,server:Server|undefined,view:Page|FrameLocator,mode:"normal"|"hold"|"fail"="normal",release:(()=>void)|undefined,failed=false;
 const unhold=async()=>{if(app)await app.evaluate(()=>{const state=globalThis as any;state.__structureReadMode="normal";state.__releaseStructure?.();state.__releaseStructure=undefined;});else{mode="normal";release?.();release=undefined;}};
 const readMode=async(value:"normal"|"hold"|"fail")=>{if(app)await app.evaluate((_electron,mode)=>{(globalThis as any).__structureReadMode=mode;},value);else mode=value;};
 const held=async()=>app?app.evaluate(()=>typeof(globalThis as any).__releaseStructure==="function"):!!release;
 try{
  if(surface==="desktop"){
   app=await electron.launch(process.env.HETU_PACKAGED_APP?{executablePath:process.env.HETU_PACKAGED_APP,args:[],env}:{args:[path.join(root,"apps/desktop")],env:{...env,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server")}});page=await app.firstWindow();view=page;
  }else{
   const binary=process.env.HETU_ACCEPT_MCP_BINARY??path.join(root,"target/debug/hetu-mcp");
   if(surface==="codex")client=await codexWorkbench(process.env.HETU_ACCEPT_CODEX_BINARY!,binary,env);
   else{client=new Client({name:"hetu-structure-names",version:"1"},{capabilities:{extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}}});await client.connect(new StdioClientTransport({command:binary,args:["--client","codex","--collaboration-dir",collaboration],env,stderr:"pipe"}));}
   const opened=await client.callTool({name:"hetu_open_app",arguments:{}}),tools=await client.listTools(),resource=await client.readResource({uri:tools.tools.find((tool:any)=>tool.name==="hetu_open_app")._meta.ui.resourceUri});
   const host=await build({entryPoints:["tests/host.ts"],bundle:true,write:false,format:"esm",target:"es2022"});
   server=createServer(async(request,response)=>{try{
    if(request.url==="/rpc"){
     const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const {method,params}=JSON.parse(Buffer.concat(chunks).toString()),reading=params.arguments?.method==="read"&&params.arguments.args[0]==="hetu.documents.list";
     if(reading&&mode==="fail"){mode="normal";failed=true;response.setHeader("Content-Type","application/json");response.end(JSON.stringify({content:[],structuredContent:{value:{status:"blocked",error:{message:"验收模拟：卷章名称读取中断"}},events:[]}}));return;}
     const result=method==="tools/call"?await client.callTool(params):await client.readResource(params);
     if(reading&&mode==="hold")await new Promise<void>(resolve=>{release=resolve;});
     response.setHeader("Content-Type","application/json");response.end(JSON.stringify(result));
    }else{response.setHeader("Content-Type",request.url==="/host.js"?"application/javascript":"text/html");response.end(request.url==="/host.js"?host.outputFiles[0].text:'<!doctype html><meta charset="utf-8"><script type="module" src="/host.js"></script>');}
   }catch(error){response.writeHead(500);response.end(String(error));}});
   await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));await page.addInitScript(value=>Object.assign(window,value),{viewHtml:resource.contents[0].text,initialTask:opened,realTask:true,workbenchMode:true});await page.goto("http://127.0.0.1:"+(server.address() as {port:number}).port);view=page.frameLocator("iframe");
  }
  await page.setViewportSize({width:1440,height:1000});await view.getByRole("button",{name:"打开作品 插件集成测试",exact:true}).click();
  await expect(view.getByRole("button",{name:"整理卷章",exact:true})).toBeEnabled();await expect(view.getByRole("region",{name:"当前作品资料",exact:true})).toContainText("103 章");
  if(app)await app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:read"),state=globalThis as any;
   handlers.set("desktop:read",async(event:unknown,action:string,input:any)=>{
    if(action==="hetu.documents.list"&&state.__structureReadMode==="fail"){state.__structureReadMode="normal";state.__structureReadFailed=true;return {status:"blocked",error:{message:"验收模拟：卷章名称读取中断"}};}
    const result=await original(event,action,input);if(action==="hetu.documents.list"&&state.__structureReadMode==="hold")await new Promise<void>(resolve=>{state.__releaseStructure=resolve;});return result;
   });
  });
  let before=await view.locator("#root").evaluate(async()=>window.hetuDesktop.novel("get"));
  await readMode("hold");await view.getByRole("button",{name:"整理卷章",exact:true}).click();const dialog=view.getByRole("dialog",{name:"整理卷章结构",exact:true});
  await expect(dialog).toBeVisible();
  await expect.poll(held).toBe(true);await expect(dialog.getByRole("status")).toContainText("正在读取卷章");await expect(dialog.getByRole("button",{name:"关闭编辑窗口",exact:true})).toBeEnabled();await dialog.getByRole("button",{name:"关闭编辑窗口",exact:true}).click();await expect(dialog).toHaveCount(0);await unhold();
  await readMode("hold");await view.getByRole("button",{name:"整理卷章",exact:true}).click();await expect.poll(held).toBe(true);
  await view.locator("#root").evaluate(async()=>{const api=window.hetuDesktop,value=await api.novel("get");await api.novel("save",{kind:"metadata",expected:{revision:value.revision,sha256:value.sha256},metadata:{...value.novel.metadata,author_name:"读取期间的并发作者"}});await api.novel("acknowledge");});
  await unhold();await expect(dialog.getByRole("alert")).toContainText("作品结构在读取期间已有变化");await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog.getByRole("button",{name:"关闭编辑窗口",exact:true}).click();await expect(dialog).toHaveCount(0);
  before=await view.locator("#root").evaluate(async()=>window.hetuDesktop.novel("get"));
  await readMode("fail");await view.getByRole("button",{name:"整理卷章",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("卷章名称读取中断");
  await expect(dialog.getByRole("status")).toHaveCount(0);await expect(dialog.getByRole("combobox")).toHaveCount(0);await expect(dialog.getByRole("button",{name:"保存结构",exact:true})).toHaveCount(0);
  expect(app?await app.evaluate(()=>(globalThis as any).__structureReadFailed):failed).toBe(true);
  await dialog.getByRole("button",{name:"重新读取卷章",exact:true}).click();await expect(dialog.getByRole("combobox")).toHaveCount(103,{timeout:30000});
  await expect(dialog).not.toContainText("未命名章节");await expect(dialog.getByRole("combobox",{name:"目录试读第102章所属卷",exact:true})).toBeVisible();
  const original=dialog.getByRole("combobox",{name:"第一章 雾港所属卷",exact:true});await expect(original).toHaveCount(1);
  await dialog.getByRole("textbox",{name:"新卷标题",exact:true}).fill("第二卷 潮汐");await dialog.getByRole("button",{name:"添加分卷",exact:true}).click();const volume=await original.locator("option").last().getAttribute("value");await original.selectOption(volume!);
  await page.screenshot({path:info.outputPath("real-chapter-names.png")});await dialog.getByRole("button",{name:"保存结构",exact:true}).click();await expect(dialog).toHaveCount(0);
  const after=await view.locator("#root").evaluate(async()=>window.hetuDesktop.novel("get"));expect(after.novel.chapters).toHaveLength(103);expect(after.novel.chapters.find((chapter:any)=>chapter.document_id===refs.document.document_id).volume_id).toBe(volume);expect(after.revision).toBe(before.revision+1);
  const actual=await view.locator("#root").evaluate(async(_element,id)=>window.hetuDesktop.read("hetu.documents.get",{document_id:id}),refs.document.document_id);expect(actual.data.revision.sha256).toBe(refs.source_refs[0].sha256);
  await writeFile(info.outputPath("structure-labels.json"),JSON.stringify({surface,chapters:103,real_names:true,read_failure_retry:true,close_during_read:true,late_reply_does_not_reopen:true,concurrent_read_rejected:true,structure_revision_increment:1,formal_unchanged:true,model_turns:0},null,2));
 }catch(error){await page.screenshot({path:info.outputPath("actual-surface-failure.png")}).catch(()=>{});throw error;}
 finally{await unhold().catch(()=>{});if(app)await closeApplication(app,"window");await client?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));}
});
