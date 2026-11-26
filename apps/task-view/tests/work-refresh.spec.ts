import {test,expect,_electron as electron,type ElectronApplication,type Page,type FrameLocator} from "@playwright/test";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {build} from "esbuild";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createServer,type Server} from "node:http";
import {codexWorkbench} from "./codex-workbench.ts";
import {navigate,closeApplication} from "../../desktop/tests/navigation.ts";

type Call={method:string;action?:string;work_ref?:unknown;started:number;read_finished?:number;finished?:number};
for(const surface of ["desktop","stdio","codex"] as const)test(`${surface} 复制只刷新当前工作区，延迟回包不重载正文或覆盖新作品`,async({page},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");test.setTimeout(180000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-local-refresh-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 await mkdir(profile);
 const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});
 expect(fixture.status,fixture.stderr).toBe(0);const refs=JSON.parse(fixture.stdout),source=refs.document;
 await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.novel.workspace_id,works:[{work_ref:refs.novel,title:"默认小说"},{work_ref:refs.drama,title:"默认剧本"},{work_ref:refs.video,title:"默认视频"}]}]}));
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_PLUGIN_STATE_DIR:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_NODE:process.execPath,HETU_CODEX_BIN:path.join(folder,"no-agent")};
 let app:ElectronApplication|undefined,client:{callTool(input:any):Promise<any>;readResource(input:any):Promise<any>;close():Promise<any>}|undefined,server:Server|undefined;
 let view:Page|FrameLocator,calls:Call[]=[],hold=false,release:(()=>void)|undefined,invalidReply=false;
 const observe=async(method:string,args:any[],run:()=>Promise<any>)=>{
  const item:Call={method,action:typeof args[0]==="string"?args[0]:undefined,work_ref:args[1]?.work_ref,started:performance.now()};calls.push(item);
  let result=await run();item.read_finished=performance.now();
  if(hold&&method==="library"&&args[0]==="refresh")await new Promise<void>(resolve=>{release=resolve;});
  if(invalidReply&&method==="library"&&args[0]==="refresh"){
   invalidReply=false;const value=result.structuredContent.value;
   result={...result,structuredContent:{...result.structuredContent,value:{...value,epoch:value.epoch+1,work:refs.drama,works:value.works.map((row:any)=>({...row,title:"不应显示的刷新回包"}))}}};
  }
  item.finished=performance.now();return result;
 };
 const stats=async():Promise<Call[]>=>surface==="desktop"?app!.evaluate(()=>structuredClone((globalThis as any).__refreshCalls)):structuredClone(calls);
 const pause=async()=>{
  if(surface==="desktop")await app!.evaluate(()=>{(globalThis as any).__refreshCalls=[];(globalThis as any).__holdWorkRefresh=true;});
  else{calls=[];hold=true;}
 };
 const held=async()=>surface==="desktop"?app!.evaluate(()=>typeof(globalThis as any).__releaseWorkRefresh==="function"):!!release;
 const resume=async()=>{
  if(surface==="desktop")await app!.evaluate(()=>{const state=globalThis as any;state.__holdWorkRefresh=false;state.__releaseWorkRefresh?.();state.__releaseWorkRefresh=undefined;});
  else{hold=false;release?.();release=undefined;}
 };
 try{
  if(surface==="desktop"){
   app=await electron.launch(process.env.HETU_PACKAGED_APP?{executablePath:process.env.HETU_PACKAGED_APP,args:[],env}:{args:[path.join(root,"apps/desktop")],env:{...env,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server")}});
   page=await app.firstWindow();view=page;
  }else{
   const binary=process.env.HETU_ACCEPT_MCP_BINARY??path.join(root,"target/debug/hetu-mcp");
   if(surface==="codex")client=await codexWorkbench(process.env.HETU_ACCEPT_CODEX_BINARY!,binary,env);
   else{const direct=new Client({name:"hetu-local-refresh",version:"1"},{capabilities:{extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}}});await direct.connect(new StdioClientTransport({command:binary,args:["--client","codex","--collaboration-dir",collaboration],env,stderr:"pipe"}));client=direct;}
   const opened=await client.callTool({name:"hetu_open_app",arguments:{}}),tools=await (client as any).listTools();
   const resource=await client.readResource({uri:tools.tools.find((tool:any)=>tool.name==="hetu_open_app")._meta.ui.resourceUri}),html=resource.contents[0].text;
   const host=await build({entryPoints:["tests/host.ts"],bundle:true,write:false,format:"esm",target:"es2022"});
   server=createServer(async(request,response)=>{
    try{
     if(request.url==="/rpc"){
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const {method,params}=JSON.parse(Buffer.concat(chunks).toString());
      const value=method==="tools/call"?await observe(params.arguments?.method??params.name,params.arguments?.args??[],()=>client!.callTool(params)):await client!.readResource(params);
      response.setHeader("Content-Type","application/json");response.end(JSON.stringify(value));
     }else{response.setHeader("Content-Type",request.url==="/host.js"?"application/javascript":"text/html");response.end(request.url==="/host.js"?host.outputFiles[0].text:'<!doctype html><meta charset="utf-8"><script type="module" src="/host.js"></script>');}
    }catch(error){response.writeHead(500);response.end(String(error));}
   });
   await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));
   await page.addInitScript(value=>Object.assign(window,value),{viewHtml:html,initialTask:opened,realTask:true,workbenchMode:true});
   await page.goto("http://127.0.0.1:"+(server.address() as {port:number}).port);view=page.frameLocator("iframe");
  }
  await page.setViewportSize({width:1440,height:1000});
  await view.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await navigate(view,"小说");
  await view.locator("#root").evaluate(async()=>{const state=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:state.revision,patch:{autosave:false}});});
  await expect(view.getByRole("button",{name:"刷新当前稿件",exact:true})).toBeEnabled();
  if(app)await app.evaluate(({ipcMain})=>{
   const state=globalThis as any;state.__refreshCalls=[];
   for(const method of ["library","read","author"]){const name="desktop:"+method,handlers=(ipcMain as any)._invokeHandlers,original=handlers.get(name);handlers.set(name,async(event:unknown,...args:any[])=>{
    const item={method,action:args[0],work_ref:args[1]?.work_ref,started:performance.now()};state.__refreshCalls.push(item);let result=await original(event,...args);(item as any).read_finished=performance.now();
    if(state.__holdWorkRefresh&&method==="library"&&args[0]==="refresh")await new Promise<void>(resolve=>{state.__releaseWorkRefresh=resolve;});
    if(state.__invalidRefreshWork&&method==="library"&&args[0]==="refresh"){
     result={...result,epoch:result.epoch+1,work:state.__invalidRefreshWork,works:result.works.map((row:any)=>({...row,title:"不应显示的刷新回包"}))};state.__invalidRefreshWork=undefined;
    }
    (item as any).finished=performance.now();return result;
   });}
  });
  await pause();
  const directory=view.getByRole("navigation",{name:"文稿目录",exact:true});
  await directory.getByRole("button",{name:source.document.title,exact:true}).click({button:"right"});await view.getByRole("menuitem",{name:"复制文稿",exact:true}).click();
  const title=source.document.title+" 副本";
  await expect(directory.getByRole("button",{name:title,exact:true})).toBeVisible({timeout:30000});
  await expect(view.getByRole("button",{name:"刷新当前稿件",exact:true})).toBeEnabled();await expect.poll(held).toBe(true);
  const refresh=(await stats()).filter(item=>item.method==="library"&&item.action==="refresh");
  expect(refresh).toHaveLength(1);expect(refresh[0].work_ref).toEqual(refs.novel);
  const menu=view.locator("details").filter({has:view.locator('summary[aria-label="文稿操作"]')});await menu.locator("summary").click();await menu.getByRole("button",{name:"编辑",exact:true}).click();
  const editor=view.getByRole("textbox",{name:"文稿编辑",exact:true});await editor.press("ControlOrMeta+End");await page.keyboard.insertText("保留回包期间的新输入🌿");
  await expect(view.getByRole("button",{name:"保存修订",exact:true})).toBeEnabled();
  await resume();await expect.poll(async()=>!!(await stats()).find(item=>item.method==="library"&&item.action==="refresh")?.finished).toBe(true);
  // 连续真实绘制帧核对迟到刷新，不能只在回包前读取一次输入或计数。
  await view.locator("#root").evaluate(()=>new Promise<void>(resolve=>{let frames=0;const step=()=>++frames===20?resolve():requestAnimationFrame(step);requestAnimationFrame(step);}));
  const copyDirectoryReads=(await stats()).filter(item=>item.method==="read"&&item.action==="hetu.documents.list").length;
  expect(copyDirectoryReads).toBe(1);
  await expect(editor).toContainText("保留回包期间的新输入🌿");await expect(view.getByRole("button",{name:"保存修订",exact:true})).toBeEnabled();
  await view.getByRole("button",{name:"保存修订",exact:true}).click();
  await expect(view.getByRole("status").filter({hasText:"已保存新修订。"})).toBeVisible();
  await expect(view.getByRole("button",{name:"刷新当前稿件",exact:true})).toBeEnabled();
  await expect(view.getByRole("button",{name:"保存修订",exact:true})).toBeDisabled();
  const saved=await view.locator("#root").evaluate(async(_element,{work,title,originalId})=>{
   const api=window.hetuDesktop,list=await api.read("hetu.documents.list",{work_ref:work}),copies=list.data.documents.filter((item:any)=>item.title===title);
   if(copies.length!==1)throw Error("副本数量不唯一");
   return {copy:(await api.read("hetu.documents.get",{document_id:copies[0].document_id})).data,original:(await api.read("hetu.documents.get",{document_id:originalId})).data,state:await api.state()};
  },{work:refs.novel,title,originalId:source.document.document_id});
  expect(saved.copy.content).toContain("保留回包期间的新输入🌿");expect(saved.original.revision.sha256).toBe(source.revision.sha256);
  expect(saved.state.works.find((item:any)=>item.work_ref.object_id===refs.novel.object_id).chapter_count).toBe(2);
  const beforeSwitch=await stats();await pause();
  await view.locator("#root").evaluate((_element,work)=>window.dispatchEvent(new CustomEvent("hetu:work-changed",{detail:{work_ref:work}})),refs.novel);await expect.poll(held).toBe(true);
  // 回包自身换成另一个会话及作品时，即使页面还未切换，也不能混入其状态。
  if(app)await app.evaluate((_electron,work)=>{(globalThis as any).__invalidRefreshWork=work;},refs.drama);else invalidReply=true;
  await resume();await view.locator("#root").evaluate(()=>new Promise<void>(resolve=>{let frames=0;const step=()=>++frames===20?resolve():requestAnimationFrame(step);requestAnimationFrame(step);}));
  await expect(view.locator("body")).not.toContainText("不应显示的刷新回包");
  await pause();
  await view.locator("#root").evaluate((_element,work)=>window.dispatchEvent(new CustomEvent("hetu:work-changed",{detail:{work_ref:work}})),refs.novel);await expect.poll(held).toBe(true);
  await navigate(view,"返回创作库");await view.getByRole("button",{name:"打开作品 默认剧本",exact:true}).click();
  await expect(view.getByRole("region",{name:"当前作品资料",exact:true})).toContainText("默认剧本");
  await resume();await view.locator("#root").evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(view.getByRole("region",{name:"当前作品资料",exact:true})).toContainText("默认剧本");
  const rejected=await view.locator("#root").evaluate(async(_element,work)=>{try{await window.hetuDesktop.library("refresh",{work_ref:work});return false;}catch{return true;}},refs.novel);
  expect(rejected).toBe(true);
  await page.screenshot({path:info.outputPath("scoped-refresh-return.png")});
  await writeFile(info.outputPath("refresh-timing.json"),JSON.stringify({surface,calls:beforeSwitch,copy_directory_reads:copyDirectoryReads,injection:"refresh response intentionally held after actual backend completion; read_finished excludes this gate; one response deliberately has another work and epoch; final readback separately enumerates documents",formal_unchanged:true,unique_copy:true,new_input_saved:true,mismatched_result_ignored:true,late_refresh_keeps_new_work:true,model_turns:0},null,2));
 }finally{
  await resume().catch(()=>{});if(app){await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});}).catch(()=>{});await closeApplication(app,"window");}await client?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
 }
});
