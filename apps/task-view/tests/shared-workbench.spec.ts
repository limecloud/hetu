import {test,expect} from "@playwright/test";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {build} from "esbuild";
import {mkdtemp,mkdir,writeFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createServer} from "node:http";
import {PluginPackage} from "../../../packages/plugin-host/src/package.ts";
import {PluginInstallations} from "../../../packages/plugin-host/src/installations.ts";

test.use({actionTimeout:15000});

test("MCP App直接打开未授权作品，复用桌面编辑保存及设置，独立面板不串作品",async({page})=>{
 test.setTimeout(180000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-shared-workbench-"));
 const workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 await mkdir(profile);
 const pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
 const fixture=spawnSync(path.join(root,"target/debug/examples/plugin_fixture"),[workspace,path.join(folder,"access"),path.join(pkg.source,"plugin.json"),pkg.sha256],{encoding:"utf8"});
 expect(fixture.status,fixture.stderr).toBe(0);
 const context=JSON.parse(fixture.stdout);
 const installs=new PluginInstallations(profile);
 await installs.apply({client_adapter:"desktop",operation_key:"fixture-plugin-install",authorization_note:"隔离验收安装人物关系插件",expected_sha256:(await installs.read()).sha256,action:"install",package_directory:pkg.source,package_sha256:pkg.sha256},async()=>{});

 await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:context.work_ref.workspace_id,works:[{work_ref:context.work_ref,title:"插件集成测试"}]}]}));
 const client=new Client({name:"hetu-shared-workbench-acceptance",version:"1"},{capabilities:{extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}}});
 await client.connect(new StdioClientTransport({command:path.join(root,"target/debug/hetu-mcp"),args:["--client","codex","--collaboration-dir",collaboration],stderr:"pipe",env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_PLUGIN_NODE:process.execPath,HETU_PLUGIN_ACCESS_DIR:path.join(folder,"access")}}));
 const initial=await client.callTool({name:"hetu_open_app",arguments:{}});
 const token=initial._meta?.["hetu/workbenchSession"] as string;
 expect(token).toBeTruthy();
 const resource=await client.readResource({uri:"ui://hetu/workbench/2"});
 const html=(resource.contents[0] as {text:string}).text;
 const host=await build({entryPoints:["tests/host.ts"],bundle:true,write:false,format:"esm",target:"es2022"});
 let releasePreferenceSave:(()=>void)|undefined;
 const server=createServer(async(request,response)=>{
  try{
   if(request.url==="/rpc"){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const {method,params}=JSON.parse(Buffer.concat(chunks).toString());
    if(params.name==="hetu_app_request"&&params.arguments.method==="settings"&&params.arguments.args[0]==="update"&&params.arguments.args[1].patch?.git_author_name==="共享工作台验收")await new Promise<void>(resolve=>{releasePreferenceSave=resolve;});
    response.setHeader("Content-Type","application/json");
    response.end(JSON.stringify(method==="tools/call"?await client.callTool(params):await client.readResource(params)));
   }else if(request.url==="/host.js"){response.setHeader("Content-Type","application/javascript");response.end(host.outputFiles[0].text);}
   else {response.setHeader("Content-Type","text/html");response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/host.js"></script>');}
  }catch(error){response.writeHead(500);response.end(String(error));}
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();if(!address||typeof address==="string")throw new Error("No test server");
 try{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.setViewportSize({width:1440,height:1000});
  await page.addInitScript(value=>Object.assign(window,value),{viewHtml:html,initialTask:initial,realTask:true,workbenchMode:true,testMessages:true,testExtensions:true});
  await page.goto("http://127.0.0.1:"+address.port);
  const view=page.frameLocator("iframe");
  const card=view.getByRole("button",{name:"打开作品 插件集成测试",exact:true});
  await expect(card).toBeEnabled({timeout:60000});
  await expect.poll(async()=>{
   const state=await view.locator("#root").evaluate(()=>(window as any).hetuDesktop.state());
   return state.works.find((row:any)=>row.work_ref.object_id===context.work_ref.object_id)?.chapter_count;
  },{timeout:30000}).toBe(1);
  await card.click();
  const editor=view.getByRole("textbox",{name:"文稿编辑",exact:true});
  await expect(editor).toBeVisible({timeout:30000});
  await expect(view.getByText(/尚未授权|精确作品接入请求/)).toHaveCount(0);
  await expect(view.getByRole("button",{name:"放入当前草稿",exact:true})).toHaveCount(0);
  await editor.fill("灯塔在黎明前亮起。\n这是在 MCP App 中保存的新修订。");
  await editor.press("ControlOrMeta+s");
  await expect(view.getByText("已保存新修订。",{exact:true})).toBeVisible({timeout:30000});
  const read=await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"read",args:["hetu.documents.get",{document_id:context.document.document_id}]}});
  expect((read.structuredContent as any).value.data.content).toContain("这是在 MCP App 中保存的新修订");
  const buffer={comment:"尚未保存的批注意见"};
  await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"buffer",args:[context.document.document_id,buffer,"annotations"]}});
  const recovered=await view.locator("#root").evaluate(async(_element,id)=>(window as any).hetuDesktop.buffer(id,undefined,"annotations"),context.document.document_id);
  expect(recovered).toEqual(buffer);
  const other=await client.callTool({name:"hetu_open_app",arguments:{}});
  await expect(client.callTool({name:"hetu_app_request",arguments:{session:other._meta?.["hetu/workbenchSession"],method:"read",args:["hetu.documents.get",{document_id:context.document.document_id}]}})).rejects.toThrow("请选择当前作品");
  await expect(client.callTool({name:"hetu_app_request",arguments:{session:"invented",method:"read",args:[]}})).rejects.toThrow("工作台连接已关闭");
  await expect(view.locator(".workbench-topbar")).toHaveCSS("height","56px");
  await view.getByRole("button",{name:"本机设置",exact:true}).first().click();
  await expect(view.getByRole("tab",{name:"AI 协作",exact:true})).toBeVisible();
  await view.getByRole("tab",{name:"AI 协作",exact:true}).click();
  await expect(view.getByRole("button",{name:"安装 MCP App",exact:true})).toBeVisible();
  await expect(view.getByRole("button",{name:"安装 Skills 套件",exact:true})).toBeVisible();
  await view.getByRole("tab",{name:"版本",exact:true}).click();
  await view.getByRole("textbox",{name:"姓名",exact:true}).fill("共享工作台验收");
  await view.getByRole("button",{name:"关闭设置",exact:true}).click();
  await expect.poll(()=>!!releasePreferenceSave).toBe(true);
  await expect(view.locator("dialog.embedded-settings")).toBeVisible();
  releasePreferenceSave!();
  await expect(view.locator("dialog.embedded-settings")).toHaveCount(0);
  const preferencesAfterClose=await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"settings",args:["get"]}});
  expect((preferencesAfterClose.structuredContent as any).value.preferences.git_author_name).toBe("共享工作台验收");
  await view.getByRole("button",{name:"参考稿审核",exact:true}).click();
  await view.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(context.task_ref.task_id);
  const taskView=view.frameLocator('iframe[title="任务候选审阅"]');
  await expect(taskView.getByRole("heading").first()).toBeVisible({timeout:30000});
  await view.getByRole("button",{name:"人物关系图",exact:true}).click();
  const plugin=view.frameLocator('iframe[title="创作插件"]');
  await expect(plugin.getByRole("heading",{name:"人物关系图",exact:true})).toBeVisible({timeout:30000});
  await plugin.getByRole("textbox",{name:"新增条目",exact:true}).fill("江岚");
  await plugin.getByRole("button",{name:"添加并保存",exact:true}).click();
  await expect(plugin.getByText(/已保存修订/)).toBeVisible({timeout:30000});
  await view.getByRole("button",{name:"返回工作台",exact:true}).click();
  await expect(view.getByRole("button",{name:"参考稿审核",exact:true})).toBeVisible();
  await expect(taskView.getByText("旧日记里夹着一张通往雾港的船票。",{exact:true})).toBeVisible({timeout:30000});
  await page.screenshot({path:path.join(root,"build/task-view/shared-workbench.png"),fullPage:true});
  expect(errors).toEqual([]);
  expect(await readdir(path.join(collaboration,"management/codex")).catch(()=>[])).toEqual([]);
  const request=async(method:string,args:any[])=>{
   const result=await client.callTool({name:"hetu_app_request",arguments:{session:token,method,args}});
   expect(result.isError).not.toBe(true);return result.structuredContent as any;
  };
  const fixed=JSON.parse((await request("handoff",["novel",{document_id:context.document.document_id,revision_id:(read.structuredContent as any).value.data.revision.revision_id}])).copied.split("\n").slice(1).join("\n"));
  expect(fixed.work_ref).toEqual(context.work_ref);
  expect(fixed.fixed_ref).toBeTruthy();
  expect(fixed.fixed_refs.some((item:any)=>item.kind==="document"&&item.document_id===context.document.document_id)).toBe(true);
  expect(fixed.direct_actions.length).toBeGreaterThan(0);
  expect(fixed.proposal_actions.length).toBeGreaterThan(0);
  expect(fixed.management_ref.grant_revision).toBe(1);
  const bootstrap=JSON.parse((await request("library",["bootstrap",{kind:"video"}])).copied.split("\n").slice(1).join("\n"));
  expect(bootstrap.work_type).toBe("video");expect(bootstrap.creation_action).toBe("hetu.creation_projects.create");
  const preferences=JSON.parse((await request("settings",["handoff",{section:"preferences"}])).copied.split("\n").slice(1).join("\n"));
  expect(preferences.action).toBe("hetu.local_settings.get");expect(preferences.core_cli).toBeTruthy();
  const objects=(await request("fallback",[pkg.manifest.id,"hetu.extensions.objects.list",{}])).value.data.objects;
  const object=(await request("fallback",[pkg.manifest.id,"hetu.extensions.objects.get",{object_id:objects[0].object_id}])).value.data;
  const pluginFixed=JSON.parse((await request("handoff",["fallback:"+pkg.manifest.id,{object_id:object.object.object_id,revision:object.object.revision,sha256:object.sha256}])).copied.split("\n").slice(1).join("\n"));
  expect(pluginFixed.fixed_refs[0].owner_plugin_id).toBe(pkg.manifest.id);
  expect(pluginFixed.plugin_connection.runtime).toMatch(/plugin-runtime\.mjs$/);
  expect(pluginFixed.management_ref).toBeUndefined();
  await view.getByRole("button",{name:"本机设置",exact:true}).first().click();
  await view.getByRole("tab",{name:"版本",exact:true}).click();
  await view.getByRole("textbox",{name:"姓名",exact:true}).fill("退出保存验收");
  await page.evaluate(()=>window.harness.teardown());
  const reopened=await client.callTool({name:"hetu_open_app",arguments:{}});
  const restored=await client.callTool({name:"hetu_app_request",arguments:{session:reopened._meta?.["hetu/workbenchSession"],method:"settings",args:["get"]}});
  expect((restored.structuredContent as any).value.preferences.git_author_name).toBe("退出保存验收");
 }finally{await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
