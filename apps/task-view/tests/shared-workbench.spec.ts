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
import {codexWorkbench} from "./codex-workbench.ts";
import {AppServer} from "../../desktop/src/main/rpc.ts";

test.use({actionTimeout:15000});

for (const transport of ["stdio", "codex"] as const) test(`${transport} MCP App直接打开未授权作品，复用桌面编辑保存及设置，独立面板不串作品`,async({page},testInfo)=>{
 test.skip(transport === "codex" && !process.env.HETU_ACCEPT_CODEX_BINARY, "需指定官方Codex CLI执行同一完整UI旅程");
 test.setTimeout(180000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-shared-workbench-"));
 const workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 await mkdir(profile);
 const pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
 const fixture=spawnSync(path.join(root,"target/debug/examples/plugin_fixture"),[workspace,path.join(folder,"access"),path.join(pkg.source,"plugin.json"),pkg.sha256,"3"],{encoding:"utf8"});
 expect(fixture.status,fixture.stderr).toBe(0);
 const context=JSON.parse(fixture.stdout);
 const baselineWorkspace=path.join(folder,"three-kinds");
 const baselineFixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[baselineWorkspace,path.join(folder,"baseline-access")],{encoding:"utf8"});
 expect(baselineFixture.status,baselineFixture.stderr).toBe(0);
 const baseline=JSON.parse(baselineFixture.stdout);
 const author=await AppServer.open(path.join(root,"target/debug/hetu-app-server"),baselineWorkspace);
 const drafts:{title:string;content:string;submitted:boolean}[]=[];
 try{
  const call=async(action:string,input:any)=>{const result=await author.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
  for(const [title,content,submitted] of [["第二集 已提交","INT. 渡口 - 夜\n\n江岚\n先把那封信交给我。",true],["第三集 工作稿","EXT. 山路 - 日\n\n江岚停下脚步。",false]] as const){
   const project=await call("hetu.drama.projects.get",{project_id:baseline.drama.object_id});
   const episode=await call("hetu.drama.episodes.create",{project_ref:{project_id:baseline.drama.object_id,revision:project.project.revision,sha256:project.sha256},title,language_tag:"zh-CN",operation_key:title});
   const document=await call("hetu.documents.get",{document_id:episode.document.document_id});
   const preview=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:baseline.drama.workspace_id},work_ref:baseline.drama,target_ref:{document_id:document.document.document_id,revision_id:document.revision.revision_id,sha256:document.revision.sha256},task_kind:"drama_draft",brief:title,input_refs:[],client_adapter:"codex",language_tag:"zh-CN",candidate_limit:2});
   const task=await call("hetu.creative_tasks.prepare",{...preview.prepare_input,operation_key:title});
   const agent=(action:string,input:any)=>{const result=spawnSync(path.join(root,"target/debug/hetu"),["--workspace",baselineWorkspace,"--task",task.task_ref.task_id,"call",action,"--input","-"],{input:JSON.stringify({task_ref:task.task_ref,...input}),encoding:"utf8"});expect(result.status,result.stdout+result.stderr).toBe(0);return JSON.parse(result.stdout).data;};
   const copy=agent("hetu.working_copies.create",{artifact_kind:"text",title,source_format:"fountain",base_refs:[],feedback_refs:[],content,operation_key:title});
   if(submitted)agent("hetu.creative_tasks.submit_result",{request_sha256:task.request_sha256,working_copy_refs:[copy.working_copy_ref],complete:true,missing_items:[],feedback_refs:[],provenance:{client:"acceptance",skill_version:"1"},operation_key:title+"-submit"});
   drafts.push({title,content,submitted});
  }
 }finally{await author.close();}
 const installs=new PluginInstallations(profile);
 await installs.apply({client_adapter:"desktop",operation_key:"fixture-plugin-install",authorization_note:"隔离验收安装人物关系插件",expected_sha256:(await installs.read()).sha256,action:"install",package_directory:pkg.source,package_sha256:pkg.sha256},async()=>{});

 await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:context.work_ref.workspace_id,works:[{work_ref:context.work_ref,title:"插件集成测试"}]},{path:baselineWorkspace,workspace_id:baseline.novel.workspace_id,works:[{work_ref:baseline.novel,title:"默认小说"},{work_ref:baseline.drama,title:"默认剧本"},{work_ref:baseline.video,title:"默认视频"}]}]}));
 const env={HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_NODE:process.execPath,HETU_PLUGIN_ACCESS_DIR:path.join(folder,"access"),HETU_COLLABORATION_DIR:collaboration};
 const direct=new Client({name:"hetu-shared-workbench-acceptance",version:"1"},{capabilities:{extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}}});
 const client=transport === "codex" ? await codexWorkbench(process.env.HETU_ACCEPT_CODEX_BINARY!,path.join(root,"target/debug/hetu-mcp"),env) : direct;
 if(transport === "stdio")await direct.connect(new StdioClientTransport({command:path.join(root,"target/debug/hetu-mcp"),args:["--client","codex","--collaboration-dir",collaboration],stderr:"pipe",env:{...process.env,...env}}));
 const initial=await client.callTool({name:"hetu_open_app",arguments:{}});
 const token=initial._meta?.["hetu/workbenchSession"] as string;
 expect(token).toBeTruthy();
 const resource=await client.readResource({uri:"ui://hetu/workbench/2"});
 const html=(resource.contents[0] as {text:string}).text;
 const host=await build({entryPoints:["tests/host.ts"],bundle:true,write:false,format:"esm",target:"es2022"});
 let releasePreferenceSave:(()=>void)|undefined;
 let failDocumentRead=false;
 const server=createServer(async(request,response)=>{
  try{
   if(request.url==="/rpc"){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const {method,params}=JSON.parse(Buffer.concat(chunks).toString());
    if(failDocumentRead&&params.arguments?.method==="read"&&params.arguments.args[0]==="hetu.documents.get"){
     failDocumentRead=false;response.setHeader("Content-Type","application/json");response.end(JSON.stringify({isError:true,content:[{type:"text",text:"验收模拟：稿件读取暂时中断"}]}));return;
    }
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
  const navigate=async(label:string)=>{
   const nav=view.getByRole("complementary",{name:"项目导航",exact:true});
   const button=nav.getByRole("button",{name:label,exact:true,includeHidden:true});
   const group=nav.locator("details.navigation-group").filter({has:view.getByRole("button",{name:label,exact:true,includeHidden:true})});
   if(await group.count()&&!await group.evaluate(element=>(element as HTMLDetailsElement).open))await group.locator(":scope > summary").click();
   await button.click();
  };
  const card=view.getByRole("button",{name:"打开作品 插件集成测试",exact:true});
  await expect(card).toBeEnabled({timeout:60000});
  await expect.poll(async()=>{
   const state=await view.locator("#root").evaluate(()=>(window as any).hetuDesktop.state());
   return state.works.find((row:any)=>row.work_ref.object_id===context.work_ref.object_id)?.chapter_count;
  },{timeout:30000}).toBe(4);
  expect(await view.locator("#root").evaluate(async()=>{
   const state=await (window as any).hetuDesktop.state();return state.works.map((row:any)=>row.work_ref.workspace_id);
  })).toEqual(expect.arrayContaining([context.work_ref.workspace_id,baseline.novel.workspace_id]));
  expect(await view.locator("#root").evaluate(async(_element,ids)=>{
   const state=await (window as any).hetuDesktop.state();return state.works.every((row:any)=>ids.includes(row.work_ref.workspace_id));
  },[context.work_ref.workspace_id,baseline.novel.workspace_id])).toBe(true);
  await card.click();
  const editor=view.getByRole("textbox",{name:"文稿编辑",exact:true});
  await expect(editor).toBeVisible({timeout:30000});
  const directory=view.getByRole("navigation",{name:"文稿目录",exact:true});
  for(const title of ["第一章 雾港","目录试读第001章","目录试读第002章","目录试读第003章","第一章 雾港"]){
   await directory.getByRole("button",{name:title,exact:true}).click();
   await expect(view.locator(".manuscript-title h1")).toHaveText(title);
  }
  failDocumentRead=true;
  await directory.getByRole("button",{name:"目录试读第001章",exact:true}).click();
  await expect(view.getByRole("alert").filter({hasText:"稿件读取暂时中断"})).toBeVisible();
  await view.getByRole("button",{name:"重新读取稿件",exact:true}).click();
  await expect(view.locator(".manuscript-title h1")).toHaveText("目录试读第001章");
  await directory.getByRole("button",{name:"第一章 雾港",exact:true}).click();
  await expect(view.locator(".manuscript-title h1")).toHaveText("第一章 雾港");
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
  await view.locator("#root").evaluate(async(_element,id)=>(window as any).hetuDesktop.buffer(id,null,"annotations"),context.document.document_id);
  expect(await view.locator("#root").evaluate(async(_element,id)=>(window as any).hetuDesktop.buffer(id,undefined,"annotations"),context.document.document_id)).toBeNull();
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
  expect(await readdir(path.join(collaboration,"management/codex")).catch(()=>[])).toEqual([]);
  for(const [label,selector] of [["作品资料",'.work-profile'],["作品大纲",'section[aria-label="作品大纲"]'],["作品设定",'.canon-workbench'],["图片成果",'.artwork-library'],["资料与素材",'.resources'],["素材与线索",'.media-library'],["关联作品",'.work-links'],["原稿导入",'.management-review'],["作品交付",'.management-review'],["文稿版本",'.version-review'],["管理方案",'.management-review'],["Agent 协作",'.agent-connection']] as const){
   await test.step(`${transport}工作面：${label}`,async()=>{
    await navigate(label);await expect(view.locator(selector)).toBeVisible();
    await expect(view.getByRole("complementary",{name:"项目导航",exact:true}).getByRole("button",{name:label,exact:true})).toHaveClass(/selected/);
   });
  }
  await navigate("作品大纲");
  await view.getByRole("button",{name:"新增大纲",exact:true}).click();
  await view.getByRole("textbox",{name:"大纲标题 1"}).fill("渡口承诺");
  await view.getByRole("textbox",{name:"大纲内容 1"}).fill("江岚必须在天亮前决定是否登船。");
  await view.getByRole("button",{name:"保存大纲",exact:true}).click();
  await expect(view.getByText("江岚必须在天亮前决定是否登船。",{exact:true})).toBeVisible();
  await navigate("小说");
  await expect(editor).toContainText("这是在 MCP App 中保存的新修订");
  await view.getByRole("button",{name:"参考稿审核",exact:true}).click();
  await view.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(context.task_ref.task_id);
  const taskView=view.frameLocator('iframe[title="任务候选审阅"]');
  await expect(taskView.getByRole("heading").first()).toBeVisible({timeout:30000});
  await view.getByRole("button",{name:"人物关系图",exact:true}).click();
  const plugin=view.frameLocator('iframe[title="创作插件"]');
  await expect(plugin.getByRole("heading",{name:"人物关系图",exact:true})).toBeVisible({timeout:30000});
  await plugin.locator("body").evaluate(async()=>{await (window as any).hetu.buffer({note:"插件恢复稿"});});
  expect(await plugin.locator("body").evaluate(async()=>(window as any).hetu.buffer(undefined))).toEqual({note:"插件恢复稿"});
  expect(await plugin.locator("body").evaluate(async()=>(window as any).hetu.buffer())).toEqual({note:"插件恢复稿"});
  await plugin.locator("body").evaluate(async()=>{await (window as any).hetu.buffer(null);});
  expect(await plugin.locator("body").evaluate(async()=>(window as any).hetu.buffer())).toBeNull();
  await plugin.getByRole("textbox",{name:"新增条目",exact:true}).fill("江岚");
  await plugin.getByRole("button",{name:"添加并保存",exact:true}).click();
  await expect(plugin.getByText(/已保存修订/)).toBeVisible({timeout:30000});
  await view.getByRole("button",{name:"返回工作台",exact:true}).click();
  await expect(view.getByRole("button",{name:"参考稿审核",exact:true})).toBeVisible();
  await expect(taskView.getByText("旧日记里夹着一张通往雾港的船票。",{exact:true})).toBeVisible({timeout:30000});
  await page.screenshot({path:path.join(root,"build/task-view/shared-workbench.png"),fullPage:true});
  expect(errors).toEqual([]);
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
  await navigate("返回创作库");
  await view.getByRole("button",{name:"打开作品 默认剧本",exact:true}).click();
  await expect(editor).toContainText("船还没来");
  for(const draft of drafts){
   await view.getByRole("navigation",{name:"文稿目录",exact:true}).getByRole("button",{name:draft.title,exact:true}).click();
   await expect(view.getByRole("article",{name:"剧本参考稿",exact:true})).toHaveText(draft.content);
   await expect(view.locator(".manuscript-title > span")).toHaveText(draft.submitted?"参考稿":"未提交工作稿");
   await view.getByRole("combobox",{name:"分集稿件版本",exact:true}).selectOption("author");
   await expect(editor).toHaveText("");
   await view.getByRole("button",{name:"刷新当前稿件",exact:true}).click();
   await expect(view.getByRole("article",{name:"剧本参考稿",exact:true})).toHaveText(draft.content);
  }
  await view.getByRole("navigation",{name:"文稿目录",exact:true}).getByRole("button",{name:"雾港初见",exact:true}).click();
  await expect(editor).toContainText("船还没来");
  await navigate("作品资料");await expect(view.getByRole("region",{name:"当前作品资料",exact:true})).toContainText("默认剧本");
  await navigate("剧本");await expect(editor).toContainText("船还没来");
  await navigate("返回创作库");
  await view.getByRole("button",{name:"打开作品 默认视频",exact:true}).click();
  await view.getByRole("combobox",{name:"视频成果版本"}).selectOption(baseline.second.media_id);
  const video=view.locator("article.video-review-content video").first();
  await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>element.readyState)).toBeGreaterThan(0);
  await video.evaluate((element:HTMLVideoElement)=>{element.muted=true;return element.play();});
  await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>element.currentTime)).toBeGreaterThan(0.15);
  await video.evaluate((element:HTMLVideoElement)=>element.pause());
  await view.getByRole("checkbox",{name:"指定片段",exact:true}).check();
  await view.getByRole("spinbutton",{name:"意见开始秒数"}).fill("0.2");
  await view.getByRole("spinbutton",{name:"意见结束秒数"}).fill("1.2");
  await view.getByRole("textbox",{name:"视频修改意见"}).fill("保留脚步声，再切到门口。");
  await view.getByRole("button",{name:"保存意见",exact:true}).click();
  await expect(view.getByText("保留脚步声，再切到门口。",{exact:true})).toBeVisible();
  await view.getByRole("button",{name:"查看前版",exact:true}).click();
  await expect.poll(()=>view.getByRole("region",{name:"前版视频"}).locator("video").evaluate((element:HTMLVideoElement)=>element.readyState)).toBeGreaterThan(0);
  await view.getByRole("button",{name:"本机设置",exact:true}).first().click();
  for(const tab of ["通用","写作","AI 协作","模型服务","版本","关于"]){
   await view.getByRole("tab",{name:tab,exact:true}).click();
   await expect(view.getByRole("tab",{name:tab,exact:true})).toHaveAttribute("aria-selected","true");
  }
  await view.getByRole("tab",{name:"版本",exact:true}).click();
  await view.getByRole("textbox",{name:"姓名",exact:true}).fill("退出保存验收");
  await page.evaluate(()=>window.harness.teardown());
  const reopened=await client.callTool({name:"hetu_open_app",arguments:{}});
  const restored=await client.callTool({name:"hetu_app_request",arguments:{session:reopened._meta?.["hetu/workbenchSession"],method:"settings",args:["get"]}});
  expect((restored.structuredContent as any).value.preferences.git_author_name).toBe("退出保存验收");
  expect(await page.evaluate(()=>window.harness.invalidToolArguments)).toBe(0);
  const calls=await page.evaluate(()=>window.harness.calls.map(item=>({method:item.arguments?.method,action:(item.arguments?.args as any[])?.[0]})).filter(item=>typeof item.method==="string").map(item=>({method:item.method,action:typeof item.action==="string"?item.action:undefined})));
  await testInfo.attach("严格宿主交互覆盖",{body:JSON.stringify({transport,calls,invalidToolArguments:0,modelTurnsStarted:0}),contentType:"application/json"});
 }finally{await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
