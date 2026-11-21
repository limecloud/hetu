import {test,expect} from "@playwright/test";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {build} from "esbuild";
import {mkdtemp,mkdir,writeFile,readdir,readFile,realpath} from "node:fs/promises";
import {createHash} from "node:crypto";
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
 test.setTimeout(300000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-shared-workbench-"));
 const mcp=process.env.HETU_ACCEPT_MCP_BINARY??path.join(root,"target/debug/hetu-mcp");
 const workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 await mkdir(profile);
 const pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
 const fixture=spawnSync(path.join(root,"target/debug/examples/plugin_fixture"),[workspace,path.join(folder,"access"),path.join(pkg.source,"plugin.json"),pkg.sha256,"3"],{encoding:"utf8"});
 expect(fixture.status,fixture.stderr).toBe(0);
 const context=JSON.parse(fixture.stdout);
 const resourceAuthor=await AppServer.open(path.join(root,"target/debug/hetu-app-server"),workspace);
 try {
  for (const title of ["渡口参考资料","另一份航海记录"]) {
   const result=await resourceAuthor.request("workspace/request",{action:"hetu.resources.create",contract_revision:"1",input:{work_ref:context.work_ref,project_id:null,title,category:"research",body:`# ${title}\n\n${title}的完整内容。\n\n`+"这段参考资料应在主工作面阅读。\n\n".repeat(30),tags:[],entity_refs:[],source_notes:"隔离验收",operation_key:title}});
   expect(result.status,JSON.stringify(result)).toBe("succeeded");
  }
 } finally {await resourceAuthor.close();}
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
 const client=transport === "codex" ? await codexWorkbench(process.env.HETU_ACCEPT_CODEX_BINARY!,mcp,env) : direct;
 if(transport === "stdio")await direct.connect(new StdioClientTransport({command:mcp,args:["--client","codex","--collaboration-dir",collaboration],stderr:"pipe",env:{...process.env,...env}}));
 const initial=await client.callTool({name:"hetu_open_app",arguments:{}});
 const token=initial._meta?.["hetu/workbenchSession"] as string;
 expect(token).toBeTruthy();
 const tools=await client.listTools();
 const entry=tools.tools.find((tool:any)=>tool.name==="hetu_open_app") as { _meta?: {ui?: {resourceUri?: string}} } | undefined;
 const resourceUri=entry?._meta?.ui?.resourceUri as string;
 expect(resourceUri).toMatch(/^ui:\/\/hetu\/workbench\/2\/[a-f0-9]{64}$/);
 // 宿主已有旧地址缓存时，新构建必须使用独立资源身份。
 const oldHtml="<!doctype html><title>旧版稿件页头</title>";
 const oldDigest=createHash("sha256").update(oldHtml).digest("hex");
 const resourceCache=new Map([["ui://hetu/workbench/2",oldHtml],[`ui://hetu/workbench/2/${oldDigest}`,oldHtml]]);
 expect(resourceCache.has(resourceUri)).toBe(false);
 const resource=await client.readResource({uri:resourceUri});
 const html=(resource.contents[0] as {text:string}).text;
 const digest=createHash("sha256").update(html).digest("hex");
 const manifest=JSON.parse(await readFile(path.join(root,"apps/mcp/resources/workbench.manifest.json"),"utf8"));
 expect(resourceUri).toBe(`ui://hetu/workbench/2/${digest}`);
 expect(resource.contents[0].uri).toBe(resourceUri);expect(manifest.resource_uri).toBe(resourceUri);
 expect(manifest.sha256).toBe(digest);resourceCache.set(resourceUri,html);
 await writeFile(testInfo.outputPath("resource-identity.json"),JSON.stringify({resource_uri:resourceUri,sha256:digest,source_sha256:manifest.source_sha256},null,2));
 expect(resourceCache.get("ui://hetu/workbench/2")).toBe(oldHtml);
 const host=await build({entryPoints:["tests/host.ts"],bundle:true,write:false,format:"esm",target:"es2022"});
 let releasePreferenceSave:(()=>void)|undefined;
 let failDocumentRead=false;
 let failSidebarTasks=true, failSidebarAttachments=true;
 let failResourceRead=true;
 let failFontRead=false;
 let taskResourceReads=0;
 const server=createServer(async(request,response)=>{
  try{
   if(request.url==="/rpc"){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const {method,params}=JSON.parse(Buffer.concat(chunks).toString());
    if(method==="resources/read"&&params.uri==="ui://hetu/task-view/1"&&++taskResourceReads===1){
     response.writeHead(503);response.end("验收模拟：审阅资源读取中断");return;
    }
    if(failSidebarTasks&&params.arguments?.method==="tasks"&&params.arguments.args[0]==="list"){
     failSidebarTasks=false;response.setHeader("Content-Type","application/json");response.end(JSON.stringify({isError:true,content:[{type:"text",text:"验收模拟：侧栏任务读取中断"}]}));return;
    }
    if(failSidebarAttachments&&params.arguments?.method==="resources"&&params.arguments.args[0]==="list"){
     failSidebarAttachments=false;response.setHeader("Content-Type","application/json");response.end(JSON.stringify({isError:true,content:[{type:"text",text:"验收模拟：侧栏附件读取中断"}]}));return;
    }
    if(failResourceRead&&params.arguments?.method==="resources"&&params.arguments.args[0]==="get"){
     failResourceRead=false;response.setHeader("Content-Type","application/json");response.end(JSON.stringify({isError:true,content:[{type:"text",text:"验收模拟：附件正文读取中断"}]}));return;
    }
    if(failFontRead&&params.arguments?.method==="fonts"){
     failFontRead=false;response.setHeader("Content-Type","application/json");response.end(JSON.stringify({isError:true,content:[{type:"text",text:"验收模拟：字体目录读取中断"}]}));return;
    }
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
   await nav.getByRole("button",{name:"显示项目导航",exact:true}).click();
   const button=nav.locator(".sidebar-project").getByRole("button",{name:label,exact:true,includeHidden:true});
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
  const sidebarTabs=view.getByRole("tablist",{name:"作品侧栏",exact:true});
  await expect(sidebarTabs).toBeVisible();
  const resize=view.getByRole("separator",{name:"调整侧栏宽度",exact:true});
  await resize.focus(); await resize.press("End"); await expect(resize).toHaveAttribute("aria-valuenow","390");
  await expect(view.locator(".project-navigation")).toHaveCSS("width","390px");
  await resize.press("Enter"); await expect(view.locator(".project-navigation")).toBeHidden();
  await view.getByRole("button",{name:"项目导航",exact:true}).click();
  await expect(resize).toHaveAttribute("aria-valuenow","390");
  await resize.focus(); await resize.press("Home");
  for(let i=0;i<10;i++)await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow","280");
  await sidebarTabs.getByRole("tab",{name:"任务",exact:true}).click();
  await expect(view.getByRole("region",{name:"作品任务",exact:true}).getByRole("alert")).toContainText("侧栏任务读取中断");
  await view.getByRole("button",{name:"重新读取任务",exact:true}).click();
  await expect(view.getByRole("region",{name:"作品任务",exact:true})).toContainText("比较雾港开篇的两个叙事方案");
  await page.screenshot({path:testInfo.outputPath(`${transport}-sidebar-tasks.png`)});
  await expect(editor).toBeVisible();
  await sidebarTabs.getByRole("tab",{name:"附件",exact:true}).click();
  await expect(view.getByRole("region",{name:"作品附件",exact:true}).getByRole("alert")).toContainText("侧栏附件读取中断");
  await view.getByRole("button",{name:"重新读取附件",exact:true}).click();
  await expect(view.getByRole("region",{name:"作品附件",exact:true}).getByRole("alert")).toHaveCount(0);
  await expect(view.getByRole("region",{name:"作品附件",exact:true})).toHaveAttribute("aria-busy","false");
  await expect(view.getByRole("region",{name:"作品附件",exact:true})).toContainText("资料与素材");
  await page.screenshot({path:testInfo.outputPath(`${transport}-sidebar-attachments.png`)});
  await expect(editor).toBeVisible();
  const attachmentList=view.getByRole("region",{name:"作品附件",exact:true});
  await attachmentList.getByRole("button",{name:"渡口参考资料",exact:true}).click();
  const attachment=view.getByRole("region",{name:"附件资料详情",exact:true});
  await expect(attachment.getByRole("alert")).toContainText("附件正文读取中断");
  await attachment.getByRole("button",{name:"重新读取资料",exact:true}).click();
  await expect(attachment).toContainText("渡口参考资料的完整内容。");
  await expect(attachment.getByRole("heading",{name:"渡口参考资料",exact:true})).toHaveCount(1);
  await expect(attachmentList).not.toContainText("完整内容");
  await expect(editor).toBeHidden();
  await page.screenshot({path:testInfo.outputPath(`${transport}-attachment-main.png`)});
  await attachmentList.getByRole("button",{name:"另一份航海记录",exact:true}).click();
  await expect(attachment).toContainText("另一份航海记录的完整内容。");
  await expect(attachment).not.toContainText("渡口参考资料的完整内容。");
  await attachment.getByRole("button",{name:"返回文稿",exact:true}).press("Escape");
  await expect(attachment).toHaveCount(0); await expect(editor).toBeVisible();
  await expect(attachmentList.getByRole("button",{name:"另一份航海记录",exact:true})).toBeFocused();
  await sidebarTabs.getByRole("tab",{name:"目录",exact:true}).click();
  await expect(view.getByRole("navigation",{name:"文稿目录",exact:true})).toBeVisible();
  await expect(view.locator("html")).not.toHaveAttribute("data-window-chrome", /.+/);
  await expect(view.locator(".cm-scroller")).toHaveCSS("line-height","24px");
  const searchWord=(await editor.innerText()).trim().slice(0,2);
  expect(searchWord.length).toBe(2);
  const textTop=(await view.locator(".manuscript-stage").boundingBox())!.y;
  await view.getByRole("button",{name:"搜索正文",exact:true}).click();
  const searchPanel=view.getByRole("region",{name:"正文查找",exact:true});
  await expect(view.getByRole("complementary",{name:"项目导航",exact:true}).getByRole("region",{name:"正文查找",exact:true})).toBeVisible();
  await searchPanel.getByRole("textbox",{name:"搜索正文内容",exact:true}).fill(searchWord);
  const currentResults=view.getByRole("navigation",{name:"当前稿件命中",exact:true});
  await expect(currentResults.getByRole("button",{name:"定位第 1 处",exact:true})).toBeVisible();
  expect((await view.locator(".manuscript-stage").boundingBox())!.y).toBe(textTop);
  await expect(view.locator(".manuscript-paper .manuscript-search")).toHaveCount(0);
  await currentResults.getByRole("button",{name:"定位第 1 处",exact:true}).click();
  await page.screenshot({path:testInfo.outputPath(`${transport}-search-sidebar.png`)});
  await searchPanel.getByRole("button",{name:"关闭正文搜索",exact:true}).click();
  await expect(editor).toBeFocused();
  await expect(view.getByRole("navigation",{name:"文稿目录",exact:true})).toBeVisible();
  const novelLayout=await view.locator(".manuscript-workspace").evaluate(el=>{const stage=el.querySelector<HTMLElement>(".manuscript-stage")!,paper=el.querySelector<HTMLElement>(".manuscript-paper")!,header=el.querySelector<HTMLElement>(".manuscript-header")!;return {width:el.clientWidth,height:el.clientHeight,stageWidth:stage.clientWidth,stageHeight:stage.clientHeight,paperWidth:paper.getBoundingClientRect().width,header:header.offsetHeight,border:getComputedStyle(paper).borderTopWidth,radius:getComputedStyle(paper).borderTopLeftRadius,overflow:getComputedStyle(el.querySelector(".manuscript-scroll")!).overflowY,cmOverflow:getComputedStyle(el.querySelector(".cm-scroller")!).overflowY};});
  expect(novelLayout.stageWidth).toBe(novelLayout.width);expect(Math.abs(novelLayout.stageHeight-(novelLayout.height-novelLayout.header))).toBeLessThanOrEqual(1);expect(novelLayout.paperWidth).toBe(novelLayout.width);expect(novelLayout.header).toBeLessThanOrEqual(72);expect(novelLayout.border).toBe("0px");expect(novelLayout.radius).toBe("0px");expect(novelLayout.overflow).toBe("visible");expect(novelLayout.cmOverflow).toBe("visible");
  await page.screenshot({path:testInfo.outputPath(`${transport}-novel-full-workspace.png`)});
  const preferenceSession=await client.callTool({name:"hetu_open_app",arguments:{}});
  const preferenceCall=async(action:string,input:Record<string,unknown>={})=>{
   const value=await client.callTool({name:"hetu_app_request",arguments:{session:preferenceSession._meta?.["hetu/workbenchSession"],method:"settings",args:[action,input]}});
   return (value.structuredContent as any).value;
  };
  const originalPreferences=await preferenceCall("preferences");
  await view.locator('summary[aria-label="更多操作"]').click();
  await expect(view.getByText("界面大小由当前宿主控制。",{exact:true})).toBeVisible();
  await expect(view.getByRole("combobox",{name:"界面大小",exact:true})).toHaveCount(0);
  await view.locator('summary[aria-label="更多操作"]').click();
  await view.locator('summary[aria-label="阅读排版"]').click();
  const readingTrigger=view.locator('summary[aria-label="阅读排版"]');
  const paperControl=view.getByRole("group",{name:"纸色",exact:true}).getByRole("button").first();
  await paperControl.focus();await paperControl.press("Escape");
  await expect(readingTrigger).toBeFocused();await expect(view.locator(".reading-menu")).not.toHaveAttribute("open","");
  await readingTrigger.press("Enter");
  await paperControl.dispatchEvent("keydown",{key:"Escape",code:"Escape",isComposing:true,bubbles:true,cancelable:true});
  await expect(view.locator(".reading-menu")).toHaveAttribute("open","");
  await view.getByRole("button",{name:"本机字体",exact:true}).click();
  failFontRead=true;
  await view.getByRole("button",{name:"本机字体目录",exact:true}).click();
  const fontPicker=view.getByRole("region",{name:"本机字体目录",exact:true});
  await expect(fontPicker.getByRole("alert")).toContainText("字体目录未能读取");
  await fontPicker.getByRole("button",{name:"重新读取字体",exact:true}).click();
  await expect(fontPicker.getByRole("status").filter({hasText:"个字体家族"})).toBeVisible({timeout:15000});
  await fontPicker.getByRole("searchbox",{name:"搜索本机字体",exact:true}).fill("Songti SC");
  expect((await fontPicker.getByRole("searchbox",{name:"搜索本机字体",exact:true}).boundingBox())!.width).toBeGreaterThan(120);
  await fontPicker.getByRole("button",{name:"选择字体 Songti SC",exact:true}).click();
  await expect(view.locator(".author-editor")).toHaveCSS("font-family",/Songti SC/);
  await page.screenshot({path:testInfo.outputPath(`${transport}-font-picker.png`)});
  await view.locator('summary[aria-label="阅读排版"]').click();
  const selectedFont=await preferenceCall("preferences");
  expect(selectedFont.preferences.reading_profiles.novel.font_name).toBe("Songti SC");
  expect(selectedFont.preferences.reading_profiles.novel.font_family).toBe("custom");
  await preferenceCall("update",{expected_revision:selectedFont.revision,patch:{reading_profiles:{novel:{font_size:24}},document_theme:"warm"}});
  await expect(view.locator(".author-editor")).toHaveCSS("font-size","24px",{timeout:10000});
  await expect(view.locator(".manuscript-workspace")).toHaveAttribute("data-document-theme","warm");
  await page.evaluate(()=>window.harness.context({theme:"dark"}));
  await expect(view.locator("html")).toHaveAttribute("data-effective-appearance","dark");
  expect(await view.locator(".manuscript-paper").evaluate(el=>getComputedStyle(el).colorScheme)).toBe("light");
  const changedPreferences=await preferenceCall("preferences");
  await preferenceCall("update",{expected_revision:changedPreferences.revision,patch:{reading_profiles:{novel:originalPreferences.preferences.reading_profiles.novel},document_theme:"system"}});
  await expect(view.locator(".author-editor")).toHaveCSS("font-size","16px",{timeout:10000});
  await page.evaluate(()=>window.harness.context({theme:"light"}));

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
  await editor.press("ControlOrMeta+Home"); await editor.press("Shift+ArrowRight"); await editor.press("Shift+ArrowRight");
  await editor.press("ControlOrMeta+b"); await expect(editor).toContainText("灯塔"); await expect(editor).not.toContainText("**灯塔**");
  const selectionToolbar=view.getByRole("toolbar",{name:"选区操作",exact:true});
  await expect(selectionToolbar).toBeVisible();
  await expect(selectionToolbar).toHaveCSS("height","35px");
  await expect(selectionToolbar.getByRole("button",{name:"删除线",exact:true})).toBeVisible();
  const formatTrigger=view.locator('summary[aria-label="文字操作"]');await formatTrigger.click();
  await expect(view.locator(".editor-style-grid")).toBeVisible();
  await expect(view.locator(".editor-inline-group").getByRole("button",{name:"加粗",exact:true})).toHaveAttribute("aria-pressed","true");
  await page.screenshot({path:testInfo.outputPath(`${transport}-text-format-panel.png`)});
  await formatTrigger.press("Escape");await expect(formatTrigger).toBeFocused();
  await editor.press("ControlOrMeta+z"); await expect(view.getByRole("button",{name:"保存修订",exact:true})).toBeDisabled();
  await editor.press("ControlOrMeta+End"); await editor.press("ControlOrMeta+b");
  await expect(view.getByRole("button",{name:"保存修订",exact:true})).toBeDisabled();
  await page.keyboard.insertText("光标粗体"); await editor.press("ControlOrMeta+b"); await page.keyboard.insertText("普通");
  await editor.press("Enter"); await page.keyboard.insertText("- 输入项目"); await editor.press("Enter");
  await page.keyboard.insertText("下一项"); await editor.press("Enter"); await editor.press("Enter"); await page.keyboard.insertText("列表结束");
  await editor.press("ControlOrMeta+s");
  await expect.poll(async()=>{
   const result=await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"read",args:["hetu.documents.get",{document_id:context.document.document_id}]}});
   return (result.structuredContent as any).value.data.content;
  }).toBe((read.structuredContent as any).value.data.content+"**光标粗体**普通\n- 输入项目\n- 下一项\n列表结束");
  const beforeGroup=await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"read",args:["hetu.documents.get",{document_id:context.document.document_id}]}});
  const groupedSource=(beforeGroup.structuredContent as any).value.data.content+'\n\n<div data-hetu-block="page">\n\n分组页\n\n页内文字。\n\n</div>';
  await editor.fill(groupedSource);await editor.press("ControlOrMeta+s");
  await expect(view.locator(".manuscript-group-link")).toContainText("分组页");
  expect(await view.locator(".manuscript-group-link").evaluate(element=>{
   const style=getComputedStyle(element),bounds=element.getBoundingClientRect(),icon=element.querySelector(".manuscript-group-icon")!;
   return Math.abs(icon.getBoundingClientRect().left-bounds.left-parseFloat(style.paddingLeft)-parseFloat(style.borderLeftWidth));
  })).toBeLessThan(1);
  await view.locator(".manuscript-group-link").click();
  await expect(view.locator(".manuscript-group-back")).toBeVisible();
  await expect(editor.locator(".cm-line").filter({hasText:"分组页"})).toHaveCSS("font-size","20px");
  const groupLine=editor.locator(".cm-line").filter({hasText:"页内文字。"});await groupLine.click({position:{x:10,y:10}});await editor.press("Home");await editor.press("Shift+End");
  await formatTrigger.click();
  const presentation=view.locator(".editor-command-menu");
  await presentation.getByRole("button",{name:"红色",exact:true}).click();await presentation.getByRole("button",{name:"等宽字体",exact:true}).click();
  await expect(presentation.getByRole("button",{name:"红色",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(presentation.getByRole("button",{name:"等宽字体",exact:true})).toHaveAttribute("aria-pressed","true");
  await editor.press("Escape");await editor.press("ControlOrMeta+s");
  await expect.poll(async()=>{
   const result=await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"read",args:["hetu.documents.get",{document_id:context.document.document_id}]}});
   return (result.structuredContent as any).value.data.content;
  }).toBe(groupedSource.replace("页内文字。",'<span data-hetu-color="red" data-hetu-font="mono">页内文字。</span>'));
  await page.screenshot({path:testInfo.outputPath(`${transport}-group-and-inline-presentation.png`)});
  await groupLine.click(); await formatTrigger.click();
  await presentation.getByRole("button",{name:"卡片",exact:true}).click();
  await presentation.getByRole("button",{name:"配置卡片",exact:true}).click();
  const cardConfiguration=view.getByRole("dialog",{name:"配置卡片",exact:true});await expect(cardConfiguration).toBeVisible();
  await cardConfiguration.getByRole("button",{name:"方形卡片",exact:true}).click();
  await cardConfiguration.getByRole("button",{name:"不显示预览",exact:true}).click();
  await cardConfiguration.getByRole("button",{name:"自定义",exact:true}).click();
  await cardConfiguration.getByRole("button",{name:"渐变",exact:true}).click();
  await cardConfiguration.getByRole("button",{name:"套用样式",exact:true}).click();
  await expect(cardConfiguration).not.toBeVisible();await editor.press("ControlOrMeta+s");
  await expect.poll(async()=>{
   const result=await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"read",args:["hetu.documents.get",{document_id:context.document.document_id}]}});
   return (result.structuredContent as any).value.data.content;
  }).toContain('data-hetu-card-layout="square" data-hetu-card-preview="none" data-hetu-card-gradient=');
  await view.locator(".manuscript-group-back").click();
  await expect(view.locator('.cm-card-preview > [data-card-layout="square"]')).toBeVisible();
  const manuscriptMenu=view.locator("details").filter({has:view.locator('summary[aria-label="文稿操作"]')});
  await manuscriptMenu.locator("summary").click(); await manuscriptMenu.getByRole("button",{name:"阅读",exact:true}).click();
  await view.getByRole("button",{name:"搜索正文",exact:true}).click();
  await view.getByRole("textbox",{name:"搜索正文内容",exact:true}).fill("新修订");
  await expect(view.getByRole("region",{name:"正文查找",exact:true})).toContainText("1 / 1 处");
  await expect(view.getByRole("textbox",{name:"文稿编辑",exact:true})).toHaveCount(0);
  await view.getByRole("button",{name:"关闭正文搜索",exact:true}).click();
  await manuscriptMenu.locator("summary").click(); await manuscriptMenu.getByRole("button",{name:"编辑",exact:true}).click();
  await editor.press("ControlOrMeta+Home");await editor.press("Shift+ArrowRight");await editor.press("Shift+ArrowRight");
  await expect(view.getByRole("button",{name:"检查器",exact:true})).toHaveCount(0);
  await view.getByRole("button",{name:"添加批注",exact:true}).click();
  await view.getByRole("textbox",{name:"原文批注意见",exact:true}).fill("在两端保留同一处灯塔伏笔。");
  await view.getByRole("button",{name:"保存批注",exact:true}).click();
  const marker=view.getByRole("button",{name:"查看原文批注 1",exact:true});await expect(marker).toBeVisible();await marker.click();
  await expect(view.getByRole("dialog",{name:"原文批注",exact:true})).toContainText("在两端保留同一处灯塔伏笔。");
  const noteRead=await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"read",args:["hetu.annotations.list",{document_id:context.document.document_id}]}});
  expect((noteRead.structuredContent as any).value.data.items).toMatchObject([{source_ref:{quote:"灯塔",byte_start:0,byte_end:6},resolved:false}]);
  await page.screenshot({path:testInfo.outputPath(`${transport}-floating-annotation.png`)});
  await view.getByRole("button",{name:"关闭批注",exact:true}).click();
  const buffer={comment:"尚未保存的批注意见"};
  await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"buffer",args:[context.document.document_id,buffer,"annotations"]}});
  const recovered=await view.locator("#root").evaluate(async(_element,id)=>(window as any).hetuDesktop.buffer(id,undefined,"annotations"),context.document.document_id);
  expect(recovered).toEqual(buffer);
  await view.locator("#root").evaluate(async(_element,id)=>(window as any).hetuDesktop.buffer(id,null,"annotations"),context.document.document_id);
  expect(await view.locator("#root").evaluate(async(_element,id)=>(window as any).hetuDesktop.buffer(id,undefined,"annotations"),context.document.document_id)).toBeNull();
  const other=await client.callTool({name:"hetu_open_app",arguments:{}});
  await expect(client.callTool({name:"hetu_app_request",arguments:{session:other._meta?.["hetu/workbenchSession"],method:"read",args:["hetu.documents.get",{document_id:context.document.document_id}]}})).rejects.toThrow("请选择当前作品");
  await expect(client.callTool({name:"hetu_app_request",arguments:{session:"invented",method:"read",args:[]}})).rejects.toThrow("工作台连接已关闭");
  await expect(view.locator(".workbench-topbar")).toHaveCSS("height","52px");
  await view.getByRole("button",{name:"本机设置",exact:true}).first().click();
  await view.getByRole("tab",{name:"通用",exact:true}).click();
  const executionMode=view.getByRole("combobox",{name:"执行模式",exact:true});
  await expect(executionMode).toHaveValue("auto");
  await executionMode.selectOption("confirm");
  const executionPolicy=async()=>((await client.callTool({name:"hetu_call_action",arguments:{action:"hetu.execution.get_mode",input:{}}})).structuredContent as any).data;
  await expect.poll(async()=>(await executionPolicy()).execution_mode).toBe("confirm");
  const executionRead=await view.locator("#root").evaluate(async(_element,document_id)=>(window as any).hetuDesktop.execution({action:"hetu.execution.invoke",contract_revision:"1",input:{command:{action:"hetu.documents.get",contract_revision:"1",input:{document_id}}}}),context.document.document_id);
  expect(executionRead.data.result.status).toBe("succeeded");
  const currentDocument=executionRead.data.result.data;
  const executionDenied=await view.locator("#root").evaluate(async(_element,document)=>(window as any).hetuDesktop.execution({action:"hetu.execution.invoke",contract_revision:"1",input:{command:{action:"hetu.documents.rename",contract_revision:"1",input:{document_id:document.document.document_id,base_revision_id:document.revision.revision_id,title:"不应执行的改名",operation_key:"confirm-denied"}}}}),currentDocument);
  expect(executionDenied.error.code).toBe("hetu.execution_confirmation_required");
  await page.screenshot({path:testInfo.outputPath(`${transport}-execution-confirm.png`)});
  await executionMode.selectOption("auto");
  await expect.poll(async()=>(await executionPolicy()).execution_mode).toBe("auto");
  await view.getByRole("tab",{name:"写作",exact:true}).click();
  const textSize=view.getByRole("spinbutton",{name:"文字大小",exact:true});
  const priorSize=await textSize.inputValue();await textSize.fill("31");await textSize.press("Escape");
  await expect(textSize).toHaveValue(priorSize);await expect(view.locator("dialog.embedded-settings")).toBeVisible();
  await textSize.dispatchEvent("keydown",{key:"Escape",code:"Escape",isComposing:true,bubbles:true,cancelable:true});
  await expect(view.locator("dialog.embedded-settings")).toBeVisible();
  await expect(view.getByRole("tab",{name:"AI 协作",exact:true})).toBeVisible();
  await view.getByRole("tab",{name:"AI 协作",exact:true}).click();
  await expect(view.getByRole("button",{name:"安装 MCP App",exact:true})).toBeVisible();
  await expect(view.getByRole("button",{name:"安装 Skills 套件",exact:true})).toBeVisible();
  await view.getByRole("tab",{name:"版本",exact:true}).click();
  const preferenceReads=await page.evaluate(()=>window.harness.calls.filter(call=>call.arguments?.method==="settings"&&(call.arguments.args as any[])?.[0]==="get").length);
  await view.getByRole("textbox",{name:"姓名",exact:true}).fill("共享工作台验收");
  await view.getByRole("button",{name:"关闭设置",exact:true}).click();
  await expect.poll(()=>!!releasePreferenceSave).toBe(true);
  await expect(view.locator("dialog.embedded-settings")).toBeVisible();
  releasePreferenceSave!();
  await expect(view.locator("dialog.embedded-settings")).toHaveCount(0);
  expect(await page.evaluate(()=>window.harness.calls.filter(call=>call.arguments?.method==="settings"&&(call.arguments.args as any[])?.[0]==="get").length)-preferenceReads).toBe(1);
  const preferencesAfterClose=await client.callTool({name:"hetu_app_request",arguments:{session:token,method:"settings",args:["get"]}});
  expect((preferencesAfterClose.structuredContent as any).value.preferences.git_author_name).toBe("共享工作台验收");
  expect(await readdir(path.join(collaboration,"management/codex")).catch(()=>[])).toEqual([]);
  for(const [label,selector] of [["作品资料",'.work-profile'],["作品大纲",'section[aria-label="作品大纲"]'],["作品设定",'.canon-workbench'],["图片成果",'.artwork-library'],["资料与素材",'.resources'],["素材与线索",'.media-library'],["关联作品",'.work-links'],["原稿导入",'.management-review'],["作品交付",'.management-review'],["文稿版本",'.version-review'],["管理方案",'.management-review'],["Agent 协作",'.agent-connection']] as const){
   await test.step(`${transport}工作面：${label}`,async()=>{
    await navigate(label);await expect(view.locator(selector)).toBeVisible();
    await expect(view.getByRole("complementary",{name:"项目导航",exact:true}).getByRole("button",{name:label,exact:true})).toHaveClass(/selected/);
   });
  }
  await navigate("作品资料");
  const profileDirectory=view.locator(".profile-structure");
  await expect(profileDirectory).toHaveAttribute("open","");
  const profileChapter=profileDirectory.getByRole("button",{name:"目录试读第003章",exact:true});
  await profileChapter.click();
  await expect(view.locator(".manuscript-title h1")).toHaveText("目录试读第003章");
  await expect(view.getByRole("navigation",{name:"文稿目录",exact:true}).getByRole("button",{name:"目录试读第003章",exact:true})).toHaveAttribute("aria-current","page");
  await navigate("作品大纲");
  await view.getByRole("button",{name:"新增大纲",exact:true}).click();
  await view.getByRole("textbox",{name:"大纲标题 1"}).fill("渡口承诺");
  await view.getByRole("textbox",{name:"大纲内容 1"}).fill("江岚必须在天亮前决定是否登船。");
  await view.getByRole("button",{name:"保存大纲",exact:true}).click();
  await expect(view.getByText("江岚必须在天亮前决定是否登船。",{exact:true})).toBeVisible();
  await navigate("小说");
  const directoryToggle=view.getByRole("button",{name:"卷章目录",exact:true});
  if(await directoryToggle.getAttribute("aria-pressed")!=="true")await directoryToggle.click();
  await view.getByRole("navigation",{name:"文稿目录",exact:true}).getByRole("button",{name:"第一章 雾港",exact:true}).click();
  await expect(editor).toContainText("这是在 MCP App 中保存的新修订");
  await navigate("参考稿审核");
  await view.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(context.task_ref.task_id);
  const taskView=view.frameLocator('iframe[title="任务候选审阅"]');
  // 两种传输都必须显示可重开的资源读取错误；宿主可能会包装底层失败文案。
  await expect(view.getByRole("alert")).toContainText(/审阅资源读取中断|Real MCP resource read failed/);
  await view.getByRole("button",{name:"重新打开面板",exact:true}).click();
  await expect(taskView.getByRole("heading").first()).toBeVisible({timeout:30000});
  await navigate("人物关系图");
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
  if (transport === "stdio") expect(taskResourceReads).toBe(2);
  await page.screenshot({path:testInfo.outputPath(`${transport}-shared-workbench.png`),fullPage:true});
  expect(errors).toEqual([]);
  const request=async(method:string,args:any[])=>{
   const result=await client.callTool({name:"hetu_app_request",arguments:{session:token,method,args}});
   expect(result.isError).not.toBe(true);return result.structuredContent as any;
  };
  const readingValue=(read.structuredContent as any).value.data;
  const savedReadingPosition={identity:JSON.stringify([context.document.document_id,readingValue.revision.revision_id]),top:240,inset:20};
  await request("readingState",["save",{work_ref:context.work_ref,patch:{selected_document_id:context.document.document_id,position:savedReadingPosition}}]);
  const readingState=await request("readingState",["get",{work_ref:context.work_ref}]);
  expect(readingState.value.positions[savedReadingPosition.identity]).toEqual(savedReadingPosition);
  const fixed=JSON.parse((await request("handoff",["novel",{document_id:context.document.document_id,revision_id:(read.structuredContent as any).value.data.revision.revision_id}])).copied.split("\n").slice(1).join("\n"));
  expect(fixed.work_ref).toEqual(context.work_ref);
  expect(fixed.fixed_ref).toBeTruthy();
  expect(fixed.fixed_refs.some((item:any)=>item.kind==="document"&&item.document_id===context.document.document_id)).toBe(true);
  expect(fixed.direct_actions.length).toBeGreaterThan(0);
  expect(fixed.proposal_actions.length).toBeGreaterThan(0);
  expect(fixed.management_ref).toBeUndefined();
  expect(await realpath(fixed.workspace_path)).toBe(await realpath(workspace));
  expect(fixed.execution_mode).toBe("auto");
  expect(fixed.execution_action).toBe("hetu.execution.invoke");
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
  await expect(view.getByRole("article",{name:"分集剧本",exact:true})).toContainText("船还没来");
  await sidebarTabs.getByRole("tab",{name:"任务",exact:true}).click();
  await expect(view.getByRole("region",{name:"作品任务",exact:true})).toHaveAttribute("aria-busy","false");
  await expect(view.getByRole("region",{name:"作品任务",exact:true})).not.toContainText("比较雾港开篇的两个叙事方案");
  await sidebarTabs.getByRole("tab",{name:"目录",exact:true}).click();
  const layout=await view.locator(".screenplay-workspace").evaluate(el=>({width:el.clientWidth,paper:el.querySelector(".manuscript-paper")!.getBoundingClientRect().width,header:el.querySelector<HTMLElement>(".manuscript-header")!.offsetHeight,overflow:getComputedStyle(el.querySelector(".manuscript-scroll")!).overflowY}));
  expect(layout.paper).toBe(layout.width);expect(layout.header).toBeLessThan(120);expect(layout.overflow).toBe("visible");
  await page.screenshot({path:testInfo.outputPath(`${transport}-updated-screenplay.png`)});
  for(const draft of drafts){
   await view.getByRole("navigation",{name:"文稿目录",exact:true}).getByRole("button",{name:draft.title,exact:true}).click();
   await expect(view.getByRole("article",{name:"剧本参考稿",exact:true})).toContainText(draft.content.split("\n").at(-1)!);
   await expect(view.locator(".screenplay-reader .screenplay-scene")).toHaveCount(1);
   await view.locator('summary[aria-label="文稿操作"]').click();await view.getByRole("button",{name:"查看原稿",exact:true}).click();
   await expect(view.getByRole("article",{name:"剧本参考稿",exact:true})).toHaveText(draft.content);
   await view.getByRole("tab",{name:"阅读",exact:true}).click();
   await expect(view.locator(".manuscript-title > span")).toHaveText("只读");
   await view.getByRole("combobox",{name:"分集稿件版本",exact:true}).selectOption("author");
   await expect(editor).toHaveText("");
   await view.getByRole("button",{name:"刷新当前稿件",exact:true}).click();
   await expect(view.getByRole("article",{name:"剧本参考稿",exact:true})).toContainText(draft.content.split("\n").at(-1)!);
  }
  await view.getByRole("navigation",{name:"文稿目录",exact:true}).getByRole("button",{name:"雾港初见",exact:true}).click();
  await expect(view.getByRole("article",{name:"分集剧本",exact:true})).toContainText("船还没来");
  await navigate("作品资料");await expect(view.getByRole("region",{name:"当前作品资料",exact:true})).toContainText("默认剧本");
  await navigate("剧本");await expect(view.getByRole("article",{name:"分集剧本",exact:true})).toContainText("船还没来");
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
  const newSession=reopened._meta?.["hetu/workbenchSession"];
  await client.callTool({name:"hetu_app_request",arguments:{session:newSession,method:"select",args:[context.work_ref]}});
  const reopenedPosition=await client.callTool({name:"hetu_app_request",arguments:{session:newSession,method:"readingState",args:["get",{work_ref:context.work_ref}]}});
  expect((reopenedPosition.structuredContent as any).value.positions[savedReadingPosition.identity]).toEqual(savedReadingPosition);
  expect(await page.evaluate(()=>window.harness.invalidToolArguments)).toBe(0);
  const calls=await page.evaluate(()=>window.harness.calls.map(item=>({method:item.arguments?.method,action:(item.arguments?.args as any[])?.[0]})).filter(item=>typeof item.method==="string").map(item=>({method:item.method,action:typeof item.action==="string"?item.action:undefined})));
  await testInfo.attach("严格宿主交互覆盖",{body:JSON.stringify({transport,calls,invalidToolArguments:0,modelTurnsStarted:0}),contentType:"application/json"});
 }finally{await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
