import { test, expect } from "@playwright/test";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { navigate } from "../../desktop/tests/navigation.ts";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {sampleImage} from "../../desktop/tests/fixtures/media.ts";

let client: Client;
let server: Server;
let origin: string;
let html: string;
let initialTask: CallToolResult;
let taskRef: Record<string, unknown>;
let managementClient: Client;
let managementRef: Record<string, unknown>;
let proposalID: string;
const sourceClients=new Map<string,Client>();

test("独立任务面板读取工作稿，关闭隔离迟到结果，重开保留原意见",async({page},info)=>{
 test.setTimeout(120000);
 const target=resolve(process.env.HETU_CARGO_TARGET_DIR??"../../target"),folder=await mkdtemp(join(tmpdir(),"hetu-working-panel-")),workspace=join(folder,"作品"),collaboration=join(folder,"collaboration");
 const fixture=spawnSync(join(target,"debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);
 const work=JSON.parse(fixture.stdout).novel,core=await AppServer.open(join(target,"debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 let machine:Client|undefined,task:any;
 try{
  const prepared=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"尚未提交的雾港工作稿",input_refs:[],client_adapter:"codex",language_tag:"zh-CN"});
  task=await call("hetu.creative_tasks.prepare",{...prepared.prepare_input,operation_key:"working-panel-task"});
  const working=await call("hetu.working_copies.create",{task_ref:task.task_ref,artifact_kind:"text",source_format:"markdown",title:"雾港工作稿",content:"江岚核对来信🌿。\r\n\r\n灯塔与结尾仍待比较。",base_refs:[],operation_key:"working-panel-copy"});
  machine=new Client({name:"working-panel-review",version:"1"},{});const transport=new StdioClientTransport({command:join(target,"debug/hetu-mcp"),args:["--workspace",workspace,"--task",task.task_ref.task_id],env:{...process.env,HETU_LOCAL_SETTINGS_DIR:join(folder,"settings"),HETU_COLLABORATION_DIR:collaboration},stderr:"pipe"});transport.stderr?.on("data",()=>{});await machine.connect(transport);sourceClients.set(task.task_ref.task_id,machine);
  const initial=await machine.callTool({name:"hetu_open_task_view",arguments:{task_ref:task.task_ref}});await page.addInitScript(value=>Object.assign(window,value),{initialTask:initial,viewHtml:html,realTask:true});await page.goto(origin);
  const view=page.frameLocator("iframe"),panel=view.getByRole("region",{name:"工作稿",exact:true});await expect(panel).toBeVisible();
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let calls=0;
  await page.route("**/rpc",async route=>{const request=route.request().postDataJSON();if(request.params?.name==="hetu_read_working_copy"){calls++;const response=await route.fetch();entered();await held;await route.fulfill({response});}else await route.continue();});
  await panel.getByRole("button",{name:"读取工作稿",exact:true}).click();await started;await page.evaluate(()=>window.harness.teardown());
  const delivered=page.waitForResponse(response=>response.url().endsWith("/rpc")&&response.request().postDataJSON().params?.name==="hetu_read_working_copy");release();await delivered;await view.locator("#app").evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
  expect(calls).toBe(1);await expect(view.getByRole("status")).toContainText("面板连接已结束");await expect(panel).toHaveCount(0);
  await page.unroute("**/rpc");await page.reload();await panel.getByRole("button",{name:"读取工作稿",exact:true}).click();await expect(panel.locator(".reference-content")).toContainText("江岚核对来信🌿。");
  await panel.getByRole("button",{name:"对整份工作稿提意见",exact:true}).click();await view.getByLabel("补充要求或意见",{exact:true}).fill("保留灯塔，继续核对来信。");await view.getByRole("button",{name:"保存工作稿意见",exact:true}).click();await expect(view.locator("#status")).toContainText("修改意见已保存");
  const feedback=await call("hetu.task_feedback.list",{task_ref:task.task_ref});expect(feedback.feedback).toHaveLength(1);expect(feedback.feedback[0].feedback.target_refs).toEqual([{kind:"working_copy",working_copy_ref:working.working_copy_ref}]);
  await page.reload();await view.getByText("全部意见",{exact:true}).click();await expect(view.getByText("保留灯塔，继续核对来信。",{exact:true})).toBeVisible();await page.screenshot({path:info.outputPath("working-panel.png")});
 }finally{if(task)sourceClients.delete(task.task_ref.task_id);await machine?.close();await core.close();}
});

test("专业来源保留原修订和未知字段，无插件运行时仍完整读取，失败与迟到响应不覆盖意见",async({page},info)=>{
 test.setTimeout(120000);
 const target=resolve(process.env.HETU_CARGO_TARGET_DIR??"../../target"),folder=await mkdtemp(join(tmpdir(),"hetu-professional-review-")),collaboration=join(folder,"collaboration"),workspace=join(folder,"作品");
 const seeded=spawnSync(join(target,"debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);
 const work=JSON.parse(seeded.stdout).novel,core=await AppServer.open(join(target,"debug/hetu-app-server"),workspace),owner="org.hetu.source-review";
 const call=async(action:string,input:any={})=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const content={description:"只认旧版线索，不替作者下结论。🌿".repeat(1800),checks:Array.from({length:26},(_,index)=>({title:`线索${index+1}`,note:index===0?"核对来信日期。".repeat(1200):"保留悬念。",verified:false,score:0})),"未来/字段~":{保留:null,["__proto__"]:"按原字段保留"}};
 let machine:Client|undefined,task:any;
 try{
  const documents=await call("hetu.documents.list",{work_ref:work}),document=await call("hetu.documents.get",{document_id:documents.documents[0].document_id});
  const save=async(input:any)=>{const result=await core.request("plugins/request",{context:{plugin_id:owner,package_sha256:"a".repeat(64),work_ref:work,types:[{kind:"notes",schema_version:"1",schema:{type:"object"}}]},request:{action:"hetu.extensions.objects.save",contract_revision:"1",input:{work_ref:work,kind:"notes",title:"雾港专业核对",schema_version:"1",content,...input}}});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
  const first=await save({expected_revision:0,expected_sha256:"",operation_key:"professional-source-first"});
  const reference={kind:"plugin_object",work_ref:work,owner_plugin_id:owner,object_id:first.object.object_id,revision:1,sha256:first.sha256};
  const preview=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"核对旧版专业来源，只读比较参考稿。",input_refs:[reference],client_adapter:"codex",language_tag:"zh-CN"});
  task=await call("hetu.creative_tasks.prepare",{...preview.prepare_input,operation_key:"professional-source-task"});
  await save({object_id:first.object.object_id,content:{description:"新版不替换旧引用。"},expected_revision:1,expected_sha256:first.sha256,operation_key:"professional-source-second"});
  // 此Owner没有安装包或运行时，读取只依赖Core保留的固定数据。
  machine=new Client({name:"professional-source-review",version:"1"},{});
  await machine.connect(new StdioClientTransport({command:join(target,"debug/hetu-mcp"),args:["--workspace",workspace,"--task",task.task_ref.task_id],env:{...process.env,HETU_LOCAL_SETTINGS_DIR:join(folder,"settings"),HETU_COLLABORATION_DIR:collaboration},stderr:"pipe"}));sourceClients.set(task.task_ref.task_id,machine);
  const initial=await machine.callTool({name:"hetu_open_task_view",arguments:{task_ref:task.task_ref}});
  await page.addInitScript(value=>Object.assign(window,value),{initialTask:initial,viewHtml:html,realTask:true});await page.goto(origin);
  const view=page.frameLocator("iframe"),source=view.getByRole("region",{name:"雾港专业核对",exact:true}),opinion=view.getByLabel("补充要求或意见",{exact:true});
  await opinion.fill("保留原意见，不自动保存。");await view.getByText("查看固定参考资料（只读）",{exact:true}).click();
  let reject=true;
  await page.route("**/rpc",async route=>{
   const body=route.request().postDataJSON();
   if(reject&&body.params?.name==="hetu_read_task_context"){reject=false;await route.fulfill({json:{content:[],structuredContent:{status:"blocked",error:{code:"workspace_busy",message:"暂时无法读取固定来源。"}}}});return;}
   await route.continue();
  });
  await source.getByRole("button",{name:"读取原文",exact:true}).click();await expect(view.getByRole("status")).toContainText("暂时无法读取固定来源。");await expect(opinion).toHaveValue("保留原意见，不自动保存。");
  await source.getByRole("button",{name:"读取原文",exact:true}).click();
  await expect.poll(()=>source.locator(".professional-source-content").textContent().then(text=>text?.includes(content.description)??false)).toBe(true);await expect(source).not.toContainText("新版不替换旧引用。");
  await source.getByText("26 项",{exact:true}).click();await expect(source.getByText("线索26",{exact:true})).toBeVisible();
  const raw=source.getByText("完整来源数据",{exact:true});await raw.click();
  expect(JSON.parse(await source.locator(".professional-source-raw pre").innerText())).toEqual(first.object);
  await expect(opinion).toHaveValue("保留原意见，不自动保存。");await expect(source.getByRole("button",{name:"读取原文",exact:true})).toHaveCount(0);
  await expect(view.getByRole("status")).toHaveAttribute("data-error","false");
  await source.evaluate(element=>element.scrollIntoView({block:"start"}));
  await page.screenshot({path:info.outputPath("professional-source-light.png"),fullPage:true});
  await raw.click();await page.evaluate(()=>window.harness.context({theme:"dark",locale:"en"}));await page.setViewportSize({width:420,height:900});await expect(source.getByText("Full source data",{exact:true})).toHaveCount(1);await expect(source.getByText("线索26",{exact:true})).toBeVisible();
  expect(await view.locator("body").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await source.evaluate(element=>element.scrollIntoView({block:"start"}));await page.screenshot({path:info.outputPath("professional-source-dark-narrow.png"),fullPage:true});
  const calls=await page.evaluate(()=>window.harness.calls);expect(calls.every(item=>item.name==="hetu_read_task_context")).toBe(true);expect(calls.some(item=>item.arguments?.result_path==="/content/description"&&Number(item.arguments?.offset)>0)).toBe(true);
  expect(calls.some(item=>item.arguments?.result_path==="/content/checks/0/note")).toBe(true);
  const after=await call("hetu.documents.get",{document_id:document.document.document_id});expect(after.revision).toEqual(document.revision);expect(after.content).toBe(document.content);
  // 重开原面板，在真实读取回包到达前关闭，迟到数据不得重新挂载。
  await page.reload();await view.getByText("查看固定参考资料（只读）",{exact:true}).click();
  let release!:()=>void,started!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  await page.route("**/rpc",async route=>{const body=route.request().postDataJSON();if(body.params?.name==="hetu_read_task_context"){const response=await route.fetch();started();await held;await route.fulfill({response});}else await route.continue();});
  await source.getByRole("button",{name:"读取原文",exact:true}).click();await entered;await page.evaluate(()=>window.harness.teardown());
  const received=page.waitForResponse(response=>response.url().endsWith("/rpc")&&response.request().postDataJSON().params?.name==="hetu_read_task_context");release();await received;
  await view.locator("#app").evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
  await expect(view.getByRole("status")).toContainText("面板连接已结束");await expect(view.locator(".task-source")).toHaveCount(0);
 }finally{if(task)sourceClients.delete(task.task_ref.task_id);await machine?.close();await core.close();}
});

test("固定长原文显示实际载入覆盖，前后阅读和失败重试保持原版本与意见",async({page},info)=>{
 test.setTimeout(120000);
 const target=resolve(process.env.HETU_CARGO_TARGET_DIR??"../../target"),folder=await mkdtemp(join(tmpdir(),"hetu-text-source-review-")),workspace=join(folder,"作品"),collaboration=join(folder,"collaboration");
 const seeded=spawnSync(join(target,"debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);
 const work=JSON.parse(seeded.stdout).novel,core=await AppServer.open(join(target,"debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any={})=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const content=Array.from({length:1100},(_,index)=>`第${index+1}段 江岚在灯塔核对来信🌿。`).join("\r\n\r\n");
 let machine:Client|undefined,task:any;
 try{
  const docs=await call("hetu.documents.list",{work_ref:work}),before=await call("hetu.documents.get",{document_id:docs.documents[0].document_id});
  const saved=await call("hetu.documents.save",{document_id:before.document.document_id,base_revision_id:before.revision.revision_id,source_format:"markdown",content,operation_key:"text-source-fixed"});
  const reference={kind:"document",document_id:saved.document.document_id,revision_id:saved.revision.revision_id};
  const empty=await call("hetu.documents.create",{kind:"novel_chapter",title:"空白来源",source_format:"markdown",content:"",operation_key:"text-source-empty"});
  const preview=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"只读核对固定原文的前后内容，不修改正式稿。",input_refs:[reference,{kind:"document",document_id:empty.document.document_id,revision_id:empty.revision.revision_id}],client_adapter:"codex",language_tag:"zh-CN"});
  task=await call("hetu.creative_tasks.prepare",{...preview.prepare_input,operation_key:"text-source-task"});
  const advanced=await call("hetu.documents.save",{document_id:saved.document.document_id,base_revision_id:saved.revision.revision_id,source_format:"markdown",content:content+"\r\n新修订不替换固定原文。",operation_key:"text-source-advance"});
  machine=new Client({name:"fixed-text-source-review",version:"1"},{});
  await machine.connect(new StdioClientTransport({command:join(target,"debug/hetu-mcp"),args:["--workspace",workspace,"--task",task.task_ref.task_id],env:{...process.env,HETU_LOCAL_SETTINGS_DIR:join(folder,"settings"),HETU_COLLABORATION_DIR:collaboration},stderr:"pipe"}));sourceClients.set(task.task_ref.task_id,machine);
  const initial=await machine.callTool({name:"hetu_open_task_view",arguments:{task_ref:task.task_ref}});
  await page.addInitScript(value=>Object.assign(window,value),{initialTask:initial,viewHtml:html,realTask:true});await page.goto(origin);
  const view=page.frameLocator("iframe"),source=view.getByRole("region",{name:saved.document.title,exact:true}),opinion=view.getByLabel("补充要求或意见",{exact:true});
  await opinion.fill("保留原意见，不把载入当作已审阅。");await view.getByText("查看固定参考资料（只读）",{exact:true}).click();
  await source.getByRole("button",{name:"读取原文",exact:true}).click();await expect(source.locator(".reference-content")).toContainText("第1段");
  const coverage=source.getByRole("group",{name:"原文读取范围",exact:true});
  await expect(coverage).toContainText("第1页");await expect(coverage).toContainText(/已载入\s+\d+%/);await expect(coverage).not.toContainText("全文已载入");
  const firstCoverage=await coverage.textContent();let reject=true;
  await page.route("**/rpc",async route=>{const request=route.request().postDataJSON();if(reject&&request.params?.name==="hetu_read_task_context"){reject=false;await route.fulfill({json:{content:[],structuredContent:{status:"blocked",error:{code:"workspace_busy",message:"隔离验收：下一页暂不可读。"}}}});return;}await route.continue();});
  await source.getByRole("button",{name:"下一页",exact:true}).click();await expect(view.getByRole("status")).toContainText("下一页暂不可读");
  await expect(coverage).toHaveText(firstCoverage!);await expect(source.getByRole("alert")).toContainText("下一页暂不可读");await expect(source.locator(".reference-content")).toContainText("第1段");await expect(opinion).toHaveValue("保留原意见，不把载入当作已审阅。");
  await source.getByRole("button",{name:"重新读取原文",exact:true}).click();await expect(coverage).toContainText("第2页");await expect(view.getByRole("status")).toHaveAttribute("data-error","false");
  const loaded=(await coverage.innerText()).match(/已载入\s+\d+%/)![0];
  await source.getByRole("button",{name:"上一页",exact:true}).click();await expect(coverage).toContainText("第1页");await expect(coverage).toContainText(loaded);
  await expect(source.locator(".reference-content")).toContainText("第1段");
  let pages=0;
  while(await source.getByRole("button",{name:"下一页",exact:true}).count()){
   expect(++pages).toBeLessThan(20);await source.getByRole("button",{name:"下一页",exact:true}).click();
   await expect(opinion).toBeEnabled();
  }
  expect(pages).toBeGreaterThanOrEqual(3);await expect(coverage).toContainText("全文已载入");await expect(source.locator(".reference-content")).toContainText("第1100段");
  await expect(source).not.toContainText("新修订不替换固定原文");await expect(opinion).toHaveValue("保留原意见，不把载入当作已审阅。");
  await source.getByText("原文位置与引用",{exact:true}).click();await expect(source.locator(".source-text-reference")).toContainText(saved.revision.revision_id);
  const emptySource=view.getByRole("region",{name:"空白来源",exact:true});await emptySource.getByRole("button",{name:"读取原文",exact:true}).click();await expect(emptySource).toContainText("原文为空");
  await source.evaluate(element=>element.scrollIntoView({block:"start"}));await page.screenshot({path:info.outputPath("fixed-text-coverage-light.png"),fullPage:true});
  await page.evaluate(()=>window.harness.context({theme:"dark",locale:"en"}));await page.setViewportSize({width:420,height:850});
  await expect(source.getByRole("group",{name:"Source reading coverage",exact:true})).toContainText("Full source loaded");expect(await view.locator("body").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:info.outputPath("fixed-text-coverage-dark-narrow.png"),fullPage:true});
  expect((await call("hetu.documents.get",{document_id:saved.document.document_id})).revision).toEqual(advanced.revision);
  // 原读取已到Core，在面板关闭后才返回；不得恢复来源、覆盖或加载状态。
  await page.reload();await view.getByText("查看固定参考资料（只读）",{exact:true}).click();
  let release!:()=>void,started!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  await page.route("**/rpc",async route=>{const request=route.request().postDataJSON();if(request.params?.name==="hetu_read_task_context"){const response=await route.fetch();started();await held;await route.fulfill({response});}else await route.continue();});
  await source.getByRole("button",{name:"读取原文",exact:true}).click();await entered;
  await expect(source).toContainText("正在读取原文");await page.evaluate(()=>window.harness.teardown());
  const received=page.waitForResponse(response=>response.url().endsWith("/rpc")&&response.request().postDataJSON().params?.name==="hetu_read_task_context");release();await received;
  await view.locator("#app").evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
  await expect(view.getByRole("status")).toContainText("面板连接已结束");await expect(view.locator(".task-source")).toHaveCount(0);
  await expect(view.locator("#app")).toHaveAttribute("aria-busy","false");
 }finally{if(task)sourceClients.delete(task.task_ref.task_id);await machine?.close();await core.close();}
});

test("安装版资料与正式大纲逐页读回原版本，载入覆盖不修改来源或任务",async({page},info)=>{
 test.setTimeout(120000);
 const target=resolve(process.env.HETU_CARGO_TARGET_DIR??"../../target"),folder=await mkdtemp(join(tmpdir(),"hetu-typed-text-source-")),workspace=join(folder,"作品"),collaboration=join(folder,"collaboration");
 const seeded=spawnSync(join(target,"debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);
 const work=JSON.parse(seeded.stdout).novel,core=await AppServer.open(join(target,"debug/hetu-app-server"),workspace),body=Array.from({length:700},(_,index)=>`资料第${index+1}段 江岚核对旧信🌿。`).join("\r\n\r\n"),outlineText=Array.from({length:700},(_,index)=>`章纲第${index+1}段 保留灯塔与悬念🌿。`).join("\n\n");
 const call=async(action:string,input:any={})=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 let machine:Client|undefined,task:any;
 try{
  const fields={work_ref:work,title:"来信考据",category:"research",body,tags:[],project_id:null,entity_refs:[],source_notes:"隔离测试资料"};
  const resource=await call("hetu.resources.create",{...fields,operation_key:"typed-text-resource"}),item={id:"outline_00000000-0000-4000-8000-000000000001",title:"来信章纲",text:outlineText,level:"book",target_id:null};
  const outline=await call("hetu.outlines.save",{expected:{revision:0,sha256:null},items:[item],operation_key:"typed-text-outline"});
  const references=[{kind:"resource",work_ref:work,resource_id:resource.resource.resource_id,revision:resource.resource.revision,sha256:resource.sha256},{kind:"outline",work_ref:work,outline_id:item.id,revision:outline.revision,sha256:outline.sha256}];
  const preview=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"只读原资料与正式大纲，不创建候选或修改来源。",input_refs:references,client_adapter:"codex",language_tag:"zh-CN"});
  task=await call("hetu.creative_tasks.prepare",{...preview.prepare_input,operation_key:"typed-text-task"});
  const resourceHead=await call("hetu.resources.update",{...fields,resource_id:resource.resource.resource_id,expected:{revision:resource.resource.revision,sha256:resource.sha256},body:body+"\n新资料不进入旧来源。",operation_key:"typed-text-resource-advance"});
  const outlineHead=await call("hetu.outlines.save",{expected:{revision:outline.revision,sha256:outline.sha256},items:[{...item,text:outlineText+"\n新章纲不进入旧来源。"}],operation_key:"typed-text-outline-advance"});
  machine=new Client({name:"typed-text-source-review",version:"1"},{capabilities:{extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}}});
  await machine.connect(new StdioClientTransport({command:process.env.HETU_ACCEPT_MCP_BINARY??join(target,"debug/hetu-mcp"),args:["--workspace",workspace,"--task",task.task_ref.task_id],env:{...process.env,HETU_LOCAL_SETTINGS_DIR:join(folder,"settings"),HETU_COLLABORATION_DIR:collaboration},stderr:"pipe"}));sourceClients.set(task.task_ref.task_id,machine);
  const initial=await machine.callTool({name:"hetu_open_task_view",arguments:{task_ref:task.task_ref}}),tools=await machine.listTools(),uri=(tools.tools.find(tool=>tool.name==="hetu_open_task_view")?._meta?.ui as {resourceUri?:string}|undefined)?.resourceUri;
  expect(uri,"已协商MCP Apps能力后应发现实际资源").toBeTruthy();
  const ui=await machine.readResource({uri:uri!});expect("text" in ui.contents[0]).toBe(true);
  await page.addInitScript(value=>Object.assign(window,value),{initialTask:initial,viewHtml:(ui.contents[0] as {text:string}).text,realTask:true});await page.goto(origin);
  const view=page.frameLocator("iframe"),opinion=view.getByLabel("补充要求或意见",{exact:true});await opinion.fill("先核对旧版，不保存意见。");await view.getByText("查看固定参考资料（只读）",{exact:true}).click();
  for(const [title,text,reference,index] of [[fields.title,body,references[0],0],[item.title,outlineText,references[1],1]] as const){
   const source=view.getByRole("region",{name:title,exact:true}),coverage=source.getByRole("group",{name:"原文读取范围",exact:true});
   await source.getByRole("button",{name:"读取原文",exact:true}).click();await expect(coverage).not.toContainText("全文已载入");
   const pieces:string[]=[];let count=0;
   for(;;){
    await source.getByRole("button",{name:"原稿",exact:true}).click();pieces.push(await source.locator(".reader").textContent()??"");
    expect(++count).toBeLessThan(20);const next=source.getByRole("button",{name:"下一页",exact:true});if(!await next.count())break;await next.click();await expect(opinion).toBeEnabled();
   }
   expect(pieces.join("")).toBe(text);expect(count).toBeGreaterThanOrEqual(3);await expect(coverage).toContainText("全文已载入");await expect(source).not.toContainText(index===0?"新资料不进入旧来源":"新章纲不进入旧来源");
   await source.getByText("原文位置与引用",{exact:true}).click();const fixed=JSON.parse(await source.locator(".source-text-reference pre").innerText());expect(fixed.reference).toEqual(reference);expect(fixed.size_bytes).toBe(Buffer.byteLength(text));
   await source.evaluate(element=>element.scrollIntoView({block:"start"}));await page.screenshot({path:info.outputPath(`typed-source-${index}.png`)});
  }
  await expect(opinion).toHaveValue("先核对旧版，不保存意见。");const calls=await page.evaluate(()=>window.harness.calls);expect(calls.every(item=>item.name==="hetu_read_task_context")).toBe(true);
  expect((await call("hetu.resources.get",{resource_id:resource.resource.resource_id})).sha256).toBe(resourceHead.sha256);expect((await call("hetu.outlines.get")).sha256).toBe(outlineHead.sha256);
  const after=await call("hetu.creative_tasks.get",{task_ref:task.task_ref});expect(after.expected).toEqual(task.expected);expect(after.submission).toBeNull();
 }finally{if(task)sourceClients.delete(task.task_ref.task_id);await machine?.close();await core.close();}
});

test("固定原文选区意见沿原键恢复，候选选区接续同一工作稿且不改正式来源",async({page},info)=>{
 test.setTimeout(120000);
 const target=resolve(process.env.HETU_CARGO_TARGET_DIR??"../../target"),folder=await mkdtemp(join(tmpdir(),"hetu-position-feedback-")),workspace=join(folder,"作品"),collaboration=join(folder,"collaboration");
 const seeded=spawnSync(join(target,"debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);
 const work=JSON.parse(seeded.stdout).novel,core=await AppServer.open(join(target,"debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any={})=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const content=Array.from({length:700},(_,index)=>`第${index+1}段 江岚核对来信🌿，不急于下结论。`).join("\r\n\r\n");let machine:Client|undefined,task:any;
 try{
  const docs=await call("hetu.documents.list",{work_ref:work}),before=await call("hetu.documents.get",{document_id:docs.documents[0].document_id});
  const saved=await call("hetu.documents.save",{document_id:before.document.document_id,base_revision_id:before.revision.revision_id,source_format:"markdown",content,operation_key:"feedback-source"});
  const preview=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"按原文依据完善参考稿，原文不改。",input_refs:[{kind:"document",document_id:saved.document.document_id,revision_id:saved.revision.revision_id}],client_adapter:"codex",language_tag:"zh-CN"});
  task=await call("hetu.creative_tasks.prepare",{...preview.prepare_input,operation_key:"feedback-task"});
  machine=new Client({name:"position-feedback-review",version:"1"},{});await machine.connect(new StdioClientTransport({command:join(target,"debug/hetu-mcp"),args:["--workspace",workspace,"--task",task.task_ref.task_id],env:{...process.env,HETU_COLLABORATION_DIR:collaboration,HETU_LOCAL_SETTINGS_DIR:join(folder,"settings")},stderr:"pipe"}));sourceClients.set(task.task_ref.task_id,machine);
  const initial=await machine.callTool({name:"hetu_open_task_view",arguments:{task_ref:task.task_ref}});await page.addInitScript(value=>Object.assign(window,value),{initialTask:initial,viewHtml:html,realTask:true});await page.goto(origin);
  const view=page.frameLocator("iframe"),source=view.getByRole("region",{name:saved.document.title,exact:true}),opinion=view.getByLabel("补充要求或意见",{exact:true}),quote=view.getByRole("region",{name:"意见所指原文",exact:true});
  await view.getByText("查看固定参考资料（只读）",{exact:true}).click();await source.getByRole("button",{name:"读取原文",exact:true}).click();await source.getByRole("button",{name:"下一页",exact:true}).click();await expect(source.getByRole("group",{name:"原文读取范围",exact:true})).toContainText("第2页");
  const select=async(reader:ReturnType<typeof source.locator>,needle:string)=>reader.evaluate((reader,needle)=>{
   const span=Array.from(reader.querySelectorAll<HTMLElement>("[data-source-from]")).find(span=>span.textContent?.includes(needle))!;
   const start=span.textContent!.indexOf(needle),range=document.createRange();range.setStart(span.firstChild!,start);range.setEnd(span.firstChild!,start+needle.length);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);reader.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));
   return {bottom:range.getBoundingClientRect().bottom};
  },needle);
  const selectionBounds=await select(source.locator(".reader"),"来信🌿");const selectionAction=source.getByRole("button",{name:"对此处提意见",exact:true});await expect(selectionAction).toBeVisible();
  const actionTop=await selectionAction.evaluate(element=>element.getBoundingClientRect().top);expect(actionTop).toBeGreaterThanOrEqual(selectionBounds.bottom);expect(actionTop-selectionBounds.bottom).toBeLessThan(40);expect(await page.evaluate(()=>window.harness.calls.filter(call=>call.name==="hetu_save_task_feedback").length)).toBe(0);
  await source.getByRole("button",{name:"对此处提意见",exact:true}).click();await expect(quote).toContainText("来信🌿");await expect(opinion).toBeFocused();await opinion.fill("参考这句来信，保留悬念，不改原文。");
  await quote.getByRole("button",{name:"移除原文引用",exact:true}).click();await expect(quote).toHaveCount(0);await expect(opinion).toHaveValue("参考这句来信，保留悬念，不改原文。");
  await select(source.locator(".reader"),"来信🌿");const quoteAgain=source.getByRole("button",{name:"对此处提意见",exact:true});await quoteAgain.focus();await page.keyboard.press("Enter");await expect(quote).toContainText("来信🌿");
  const fixedPage=JSON.parse((await source.locator(".source-text-reference pre").textContent())!);await source.getByRole("button",{name:"上一页",exact:true}).click();await expect(quote).toContainText("来信🌿");await expect(opinion).toHaveValue("参考这句来信，保留悬念，不改原文。");
  await page.evaluate(()=>window.harness.context({theme:"dark",locale:"en"}));await expect(view.getByRole("region",{name:"Passage for this feedback",exact:true})).toContainText("来信🌿");await page.evaluate(()=>window.harness.context({theme:"light",locale:"zh-CN"}));
  let lost=true;await page.route("**/rpc",async route=>{if(lost&&route.request().postDataJSON().params?.name==="hetu_save_task_feedback"){lost=false;await route.fetch();await route.abort("failed");return;}await route.continue();});
  await view.getByRole("button",{name:"保存位置意见",exact:true}).click();await expect(view.getByRole("status")).toContainText("保存结果尚未确认");await expect(quote).toContainText("来信🌿");await expect(opinion).toHaveValue("参考这句来信，保留悬念，不改原文。");
  const once=await call("hetu.task_feedback.list",{task_ref:task.task_ref}),first=once.feedback[0];expect(once.feedback).toHaveLength(1);const anchored=first.feedback.target_refs[0];expect(anchored.kind).toBe("context");expect(anchored.range.byte_start).toBeGreaterThanOrEqual(fixedPage.range.byte_start);expect(Buffer.from(content).subarray(anchored.range.byte_start,anchored.range.byte_end).toString()).toBe("来信🌿");
  await view.getByRole("button",{name:"查询原保存结果",exact:true}).click();await expect(view.getByRole("status")).toContainText("修改意见已保存");await expect(view.getByRole("region",{name:"已保存的位置意见",exact:true})).toContainText("来信🌿");expect((await page.evaluate(()=>window.harness.calls)).filter(call=>call.name==="hetu_save_task_feedback")).toHaveLength(1);
  const catalog=JSON.parse(await readFile("../../contracts/tools/catalog.json","utf8"));const offered=await machine.listTools();
  const agent=async(action:string,input:any)=>{const tool=catalog.tools.find((tool:any)=>tool.action===action);expect(offered.tools.some(item=>item.name===tool?.name),action).toBe(true);const result=await machine!.callTool({name:tool.name,arguments:{task_ref:task.task_ref,...input}});expect((result.structuredContent as any).status,JSON.stringify(result)).toBe("succeeded");return (result.structuredContent as any).data;};
  const copy=await agent("hetu.working_copies.create",{artifact_kind:"text",source_format:"markdown",title:"来信参考稿",base_refs:[],feedback_refs:[first.feedback_ref],content:"江岚重读来信🌿，仍不敢确信。",operation_key:"feedback-working"});
  const submitted=await agent("hetu.creative_tasks.submit_result",{request_sha256:task.request_sha256,working_copy_refs:[copy.working_copy_ref],feedback_refs:[first.feedback_ref],complete:true,missing_items:[],provenance:{client:"position-test",skill_version:"1"},operation_key:"feedback-submit"});
  await view.getByRole("button",{name:"读取最新结果",exact:true}).click();const candidate=view.locator(".candidate").filter({has:view.getByText("来信参考稿",{exact:true})});
  await select(source.locator(".reader"),"来信🌿");await expect(source.getByRole("button",{name:"对此处提意见",exact:true})).toBeVisible();await select(candidate.locator(".reader"),"来信🌿");await expect(source.getByRole("button",{name:"对此处提意见",exact:true})).toHaveCount(0);
  await candidate.getByRole("button",{name:"对此处提意见",exact:true}).click();await opinion.fill("保留这句，下一版只调整结尾。");await view.getByRole("button",{name:"保存位置意见",exact:true}).click();await expect(view.getByRole("status")).toContainText("修改意见已保存");
  const history=await agent("hetu.task_feedback.list",{});expect(history.feedback).toHaveLength(2);const second=history.feedback[1];expect(second.feedback.target_refs[0].candidate_ref).toEqual(submitted.candidate_refs[0]);expect(second.feedback.target_refs[0].range.quote).toBe("来信🌿");
  const revised=await agent("hetu.working_copies.save",{working_copy_id:copy.working_copy_ref.working_copy_id,expected:copy.working_copy_ref,content:"江岚重读来信🌿，把回答留到天明。",feedback_refs:[second.feedback_ref],operation_key:"feedback-revise"});expect(revised.working_copy_ref.working_copy_id).toBe(copy.working_copy_ref.working_copy_id);
  expect((await call("hetu.documents.get",{document_id:saved.document.document_id})).revision).toEqual(saved.revision);
  const published=view.getByRole("region",{name:"已保存的位置意见",exact:true});await published.screenshot({path:info.outputPath("fixed-position-feedback.png")});
  await page.evaluate(()=>window.harness.context({theme:"dark",locale:"en"}));await page.setViewportSize({width:420,height:850});
  const english=view.getByRole("region",{name:"Saved position feedback",exact:true});await expect(english).toContainText("来信🌿");expect(await view.locator("body").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await english.screenshot({path:info.outputPath("fixed-position-feedback-dark-narrow.png")});
 }finally{if(task)sourceClients.delete(task.task_ref.task_id);await machine?.close();await core.close();}
});

test("正式来源按原修订读取，单实体不扩大范围，整份设定保持六类导航与完整字段",async({page},info)=>{
 test.setTimeout(120000);
 const target=resolve(process.env.HETU_CARGO_TARGET_DIR??"../../target"),folder=await mkdtemp(join(tmpdir(),"hetu-source-review-")),collaboration=join(folder,"collaboration"),workspace=join(folder,"作品");
 const seeded=spawnSync(join(target,"debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);
 const work=JSON.parse(seeded.stdout).novel,core=await AppServer.open(join(target,"debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any={})=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const id=(kind:string,index=1)=>`${kind}_00000000-0000-4000-8000-${String(index).padStart(12,"0")}`;
 let machine:Client|undefined,task:any;
 try{
  const docs=await call("hetu.documents.list",{work_ref:work}),document=await call("hetu.documents.get",{document_id:docs.documents[0].document_id});
  const quote={document_id:document.document.document_id,revision_id:document.revision.revision_id,byte_start:0,byte_end:Buffer.byteLength(document.content),quote:document.content};
  const original=await call("hetu.blueprints.get",{work_ref:work});
  const character={character_id:id("character"),name:"江岚",description:"守塔人，先核对来信。",aliases:["阿岚"],traits:["谨慎"],archived:false,facts:[{fact_id:id("fact"),subject_ref:id("character"),predicate:"primary_faction",value:id("faction"),valid_from:id("event"),source_refs:[quote]}]};
  const worldDescription="雾港潮汐🌿".repeat(1600),entities=[
   ["character",character],
   ["faction",{faction_id:id("faction"),name:"引航会",description:"维持港口联络。",relations:[{target_ref:id("faction",2),type:"ally"}],archived:false}],
   ["faction",{faction_id:id("faction",2),name:"守望会",description:"对岸的联盟。",relations:[],archived:false}],
   ["location",{location_id:id("location"),name:"旧灯塔",description:"港口外的灯塔。",aliases:["北塔"],interior_exterior:"exterior",archived:false}],
   ["event",{event_id:id("event"),title:"来信之夜",time_anchor:{calendar:"潮汐纪",tick:0},before_refs:[],after_refs:[],source_refs:[quote]}],
   ["world",{entry_id:id("entry"),title:"雾港潮汐",description:worldDescription,source_refs:[quote]}],
   ["world",{entry_id:id("entry",2),title:"另一片海",description:"海面风向".repeat(1000),source_refs:[]}],
   ["rule",{rule_id:id("rule"),revision:1,type:"advisory",severity:"warning",exception_policy:"author_review",rationale:"先核对身份，保留作者判断。",scope:{packages:["novel"],document_ids:[document.document.document_id],entity_refs:[id("character")]},parameters:{text:"不要把悬念提前写成事实。"}}],
  ];
  const fixed=await call("hetu.blueprints.save",{work_ref:work,expected:{blueprint_id:original.blueprint.blueprint_id,revision:original.revision,sha256:original.sha256},typed_changes:entities.map(([kind,entity])=>({type:"upsert_"+kind,entity})),operation_key:"source-review-bible"});
  const outline={id:id("outline"),title:"固定章纲",text:"灯塔照亮来信，保留身份悬念。",level:"chapter",target_id:document.document.document_id};
  const outlines=await call("hetu.outlines.save",{expected:{revision:0,sha256:null},items:[outline],operation_key:"source-review-outline"});
  const bible={kind:"blueprint",work_ref:work,blueprint_id:fixed.blueprint.blueprint_id,revision:fixed.revision,sha256:fixed.sha256};
  const refs=[{kind:"document",document_id:document.document.document_id,revision_id:document.revision.revision_id},{kind:"outline",work_ref:work,outline_id:outline.id,revision:outlines.revision,sha256:outlines.sha256},{...bible,entity_ref:character.character_id},bible,{...bible,entity_ref:id("entry")}];
  const preview=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"核对固定资料后比较参考稿，不修改正式正文。",input_refs:refs,client_adapter:"codex",language_tag:"zh-CN"});
  task=await call("hetu.creative_tasks.prepare",{...preview.prepare_input,operation_key:"source-review-task"});
  const draft=await call("hetu.working_copies.create",{task_ref:task.task_ref,artifact_kind:"text",source_format:"markdown",title:"来信参考稿",content:"江岚将手从开关上移开。",base_refs:refs,operation_key:"source-review-draft"});
  await call("hetu.creative_tasks.submit_result",{task_ref:task.task_ref,request_sha256:task.request_sha256,working_copy_refs:[draft.working_copy_ref],complete:true,missing_items:[],provenance:{client:"source-review-fixture",skill_version:"1"},operation_key:"source-review-submit"});
  await call("hetu.blueprints.save",{work_ref:work,expected:{blueprint_id:fixed.blueprint.blueprint_id,revision:fixed.revision,sha256:fixed.sha256},typed_changes:[{type:"upsert_character",entity:{...character,description:"新头中的人物说明。",aliases:["新版别名"]}}],operation_key:"source-review-new-bible"});
  await call("hetu.outlines.save",{expected:{revision:outlines.revision,sha256:outlines.sha256},items:[{...outline,text:"新头章纲不替换旧任务。"}],operation_key:"source-review-new-outline"});
  machine=new Client({name:"fixed-source-review",version:"1"},{});
  await machine.connect(new StdioClientTransport({command:join(target,"debug/hetu-mcp"),args:["--workspace",workspace,"--task",task.task_ref.task_id],env:{...process.env,HETU_LOCAL_SETTINGS_DIR:join(folder,"settings"),HETU_COLLABORATION_DIR:collaboration},stderr:"pipe"}));
  sourceClients.set(task.task_ref.task_id,machine);
  const initial=await machine.callTool({name:"hetu_open_task_view",arguments:{task_ref:task.task_ref}});
  await page.addInitScript(value=>Object.assign(window,value),{initialTask:initial,viewHtml:html,realTask:true});await page.goto(origin);
  const view=page.frameLocator("iframe");await expect(view.getByText("来信参考稿",{exact:true})).toBeVisible();
  await view.getByLabel("补充要求或意见",{exact:true}).fill("意见仍保留，不自动保存。");
  await view.getByText("查看固定参考资料（只读）",{exact:true}).click();
  const read=view.getByRole("button",{name:"读取原文",exact:true});
  for(let count=5;count>0;count--){await expect(read).toHaveCount(count);await read.first().click();}
  const person=view.getByRole("region",{name:"江岚",exact:true}),whole=view.getByRole("region",{name:"设定集",exact:true});
  await expect(person.getByRole("heading",{name:"江岚",exact:true})).toHaveCount(1);await expect(person.getByRole("button",{name:"返回设定目录",exact:true})).toHaveCount(0);
  await expect(person).toContainText("阿岚");await expect(person).toContainText("谨慎");await expect(person.getByRole("heading",{name:"人物事实",exact:true})).toBeVisible();await expect(person).toContainText("所引设定未附加");
  await expect(person).not.toContainText("引航会");await expect(person).not.toContainText("新版别名");await expect(view.locator(".task-source").nth(1)).toContainText(outline.text);
  const large=view.getByRole("region",{name:"雾港潮汐",exact:true});await expect(large).toContainText(worldDescription);await expect(large.getByRole("button",{name:"返回设定目录",exact:true})).toHaveCount(0);
  await person.getByText("原文依据 1",{exact:true}).click();await expect(person).toContainText(document.revision.revision_id);
  await page.screenshot({path:info.outputPath("fixed-single-entity.png"),fullPage:true});
  for(const [category,title,needle] of [["人物","江岚","阿岚"],["势力","引航会","势力关系"],["地点","旧灯塔","北塔"],["时间线","来信之夜","潮汐纪"],["世界观","雾港潮汐","雾港潮汐🌿雾港潮汐🌿"],["规则","先核对身份，保留作者判断。","不要把悬念提前写成事实。"]]){
   await whole.getByRole("button",{name:category,exact:true}).click();await whole.getByRole("button",{name:title,exact:true}).click();await expect(whole).toContainText(needle);
   if(category==="时间线")await expect(whole.getByText("0",{exact:true})).toBeVisible();
   await expect(whole.getByRole("button",{name:"返回设定目录",exact:true})).toBeEnabled();await whole.getByRole("button",{name:"返回设定目录",exact:true}).click();
  }
  await whole.getByRole("button",{name:"规则",exact:true}).click();await whole.getByRole("button",{name:"先核对身份，保留作者判断。",exact:true}).click();
  await whole.getByText("1 篇文稿",{exact:true}).click();await expect(whole).toContainText(document.document.document_id);
  await expect(person.getByText(document.revision.revision_id,{exact:true})).toBeVisible();
  await view.getByRole("button",{name:"English",exact:true}).click();await expect(person.getByRole("heading",{name:"Character facts",exact:true})).toBeVisible();await expect(person.getByRole("button",{name:"Back to story bible index",exact:true})).toHaveCount(0);
  await expect(view.getByRole("region",{name:"Story bible",exact:true}).getByRole("button",{name:"Back to story bible index",exact:true})).toBeVisible();await expect(view.getByLabel("Requirements or feedback",{exact:true})).toHaveValue("意见仍保留，不自动保存。");
  await page.evaluate(()=>window.harness.context({theme:"dark"}));await page.setViewportSize({width:420,height:900});
  // 共享纸面合同在暗色使用Radix Gray 3。
  await expect(view.locator("#app")).toHaveCSS("color-scheme","dark");await expect(view.locator("#app")).toHaveCSS("background-color","rgb(34, 34, 34)");
  expect(await view.locator("body").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath("fixed-source-dark-narrow.png"),fullPage:true});
  const calls=await page.evaluate(()=>window.harness.calls);expect(calls.every(item=>item.name==="hetu_read_task_context")).toBe(true);
  const selectedCalls=calls.filter(item=>(item.arguments?.context_ref as any)?.context_id==="context_2");expect(selectedCalls).toHaveLength(1);expect(selectedCalls[0].arguments?.entity_id).toBeUndefined();
  expect(calls.some(item=>(item.arguments?.context_ref as any)?.context_id==="context_4"&&item.arguments?.result_path==="/description"&&Number(item.arguments?.offset)>0)).toBe(true);
  const after=await call("hetu.documents.get",{document_id:document.document.document_id});expect(after.revision).toEqual(document.revision);expect(after.content).toBe(document.content);
 }finally{if(task)sourceClients.delete(task.task_ref.task_id);await machine?.close();await core.close();}
});

test("长候选超预算仍打开固定批次，翻页保留意见并保存全文选区",async({page},info)=>{
 test.setTimeout(120000);
 const target=resolve(process.env.HETU_CARGO_TARGET_DIR??"../../target"),folder=await mkdtemp(join(tmpdir(),"hetu-long-candidate-")),workspace=join(folder,"work"),collaboration=join(folder,"collaboration");
 const seeded=spawnSync(join(target,"debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);
 const work=JSON.parse(seeded.stdout).novel,core=await AppServer.open(join(target,"debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const value=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data;};
 let machine:Client|undefined,task:any;
 try{
  const prepared=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"阅读长候选并按原位置提意见，不改正式稿。".repeat(700),input_refs:[],client_adapter:"codex",language_tag:"zh-CN"});
  task=await call("hetu.creative_tasks.prepare",{...prepared.prepare_input,operation_key:"long-candidate-task"});
  const content=Array.from({length:2400},(_,index)=>`第${index+1}段 江岚在灯塔核对来信🌿。保留旧版依据，不提前解释动机。`).join("\r\n\r\n");
  const submit={task_ref:task.task_ref,request_sha256:task.request_sha256,candidates:[{kind:"text",title:"长篇参考稿",source_format:"markdown",source_ref_indices:[],content}],complete:true,missing_items:[],provenance:{client:"long-candidate-test",skill_version:"1"},operation_key:"long-candidate-first"};
  const original=await call("hetu.creative_tasks.submit_result",submit);
  machine=new Client({name:"long-candidate-review",version:"1"},{});const transport=new StdioClientTransport({command:process.env.HETU_ACCEPT_MCP_BINARY??join(target,"debug/hetu-mcp"),args:["--workspace",workspace,"--task",task.task_ref.task_id],env:{...process.env,HETU_COLLABORATION_DIR:collaboration},stderr:"pipe"});transport.stderr?.on("data",()=>{});await machine.connect(transport);sourceClients.set(task.task_ref.task_id,machine);
  const initial=await machine.callTool({name:"hetu_open_task_view",arguments:{task_ref:task.task_ref,submission_id:original.submission.submission_id}});
  expect(JSON.stringify(initial)).not.toContain("第2400段");
  expect((initial.structuredContent as any).data?.response?.complete===false||(initial.structuredContent as any).error?.code==="hetu.budget_exceeded").toBe(true);
  await page.addInitScript(value=>Object.assign(window,value),{initialTask:initial,testTaskRef:task.task_ref,testSubmissionId:original.submission.submission_id,viewHtml:html,realTask:true});await page.goto(origin);
  const view=page.frameLocator("iframe"),candidate=view.getByRole("region",{name:"候选 长篇参考稿",exact:true}),opinion=view.getByLabel("补充要求或意见",{exact:true});
  await expect(candidate).toBeVisible({timeout:30000});await candidate.getByRole("button",{name:"读取参考稿",exact:true}).click();await expect(candidate.locator(".reference-content")).toContainText("第1段");await expect(candidate.locator(".reference-content")).not.toContainText("第2400段");
  await opinion.fill("保留尚未保存的意见。🌿");let fail=true;
  await page.route("**/rpc",async route=>{const request=route.request().postDataJSON();if(fail&&request.params?.name==="hetu_read_task_candidate"&&request.params?.arguments?.range?.byte_start>0){fail=false;await route.abort("failed");return;}await route.continue();});
  await candidate.getByRole("button",{name:"下一页",exact:true}).click();await expect(candidate.getByRole("alert")).toBeVisible();await expect(opinion).toHaveValue("保留尚未保存的意见。🌿");
  await candidate.getByRole("button",{name:"重新读取参考稿",exact:true}).click();await expect(candidate.getByRole("group",{name:"参考稿读取范围",exact:true})).toContainText("第2页");await expect(opinion).toHaveValue("保留尚未保存的意见。🌿");
  await call("hetu.creative_tasks.submit_result",{...submit,candidates:[{...submit.candidates[0],content:"新版不替换原批次。"}],operation_key:"long-candidate-newer"});
  await candidate.getByRole("button",{name:"下一页",exact:true}).click();await expect(candidate.getByRole("group",{name:"参考稿读取范围",exact:true})).toContainText("第3页");await expect(candidate).not.toContainText("新版不替换原批次");
  await candidate.locator(".reader").evaluate(reader=>{const span=Array.from(reader.querySelectorAll<HTMLElement>("[data-source-from]")).find(span=>span.textContent?.includes("来信🌿"))!,start=span.textContent!.indexOf("来信🌿"),range=document.createRange();range.setStart(span.firstChild!,start);range.setEnd(span.firstChild!,start+"来信🌿".length);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);reader.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));});
  await candidate.getByRole("button",{name:"对此处提意见",exact:true}).click();await view.getByRole("button",{name:"保存位置意见",exact:true}).click();await expect(view.locator("#status")).toContainText("修改意见已保存");
  const saved=await call("hetu.task_feedback.list",{task_ref:task.task_ref}),position=saved.feedback[0].feedback.target_refs[0];expect(position.candidate_ref).toEqual(original.candidate_refs[0]);expect(position.range.byte_start).toBeGreaterThan(16000);expect(position.range.quote).toBe("来信🌿");expect(Buffer.from(content).subarray(position.range.byte_start,position.range.byte_end).toString()).toBe("来信🌿");
  await page.screenshot({path:info.outputPath("long-candidate-feedback.png"),fullPage:true});
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  await page.route("**/rpc",async route=>{if(route.request().postDataJSON().params?.name==="hetu_read_task_candidate"){const response=await route.fetch();entered();await held;await route.fulfill({response});}else await route.fallback();});
  await candidate.getByRole("button",{name:"下一页",exact:true}).click();await started;await page.evaluate(()=>window.harness.teardown());release();
  await expect(view.locator("#app")).toHaveAttribute("aria-busy","false");await expect(candidate).toHaveCount(0);await expect(view.locator("#status")).toContainText("面板连接已结束");
 }finally{if(task)sourceClients.delete(task.task_ref.task_id);await machine?.close();await core.close();}
});

test("图片候选区域经独立MCP按原键恢复，新批次不继承旧像素",async({page},info)=>{
 test.setTimeout(120000);
 const target=resolve(process.env.HETU_CARGO_TARGET_DIR??"../../target"),folder=await mkdtemp(join(tmpdir(),"hetu-image-region-task-")),workspace=join(folder,"work"),collaboration=join(folder,"collaboration");
 const seeded=spawnSync(join(target,"debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);
 const work=JSON.parse(seeded.stdout).novel,core=await AppServer.open(join(target,"debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const value=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data;};
 let machine:Client|undefined,task:any;
 try{
  const prepared=await call("hetu.image_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"cover",brief:"只改标记衣领，保留其余部分。",input_refs:[],client_adapter:"codex",language_tag:"zh-CN"});
  task=await call("hetu.image_tasks.prepare",{...prepared.prepare_input,operation_key:"image-region-task"});
  const png=sampleImage();await writeFile(join(workspace,task.request.output_contract.relative_inbox,"region.png"),png);
  const submit={task_ref:task.task_ref,request_sha256:task.request_sha256,candidates:[{kind:"image",title:"原版人物图",source_format:"image",source_ref_indices:[],file_name:"region.png",sha256:createHash("sha256").update(png).digest("hex")}],complete:true,missing_items:[],provenance:{client:"image-region-test",skill_version:"1"},operation_key:"image-region-first"};
  const submitted=await call("hetu.creative_tasks.submit_result",submit);
  machine=new Client({name:"image-region-task-test",version:"1"},{});const transport=new StdioClientTransport({command:process.env.HETU_ACCEPT_MCP_BINARY??join(target,"debug/hetu-mcp"),args:["--workspace",workspace,"--task",task.task_ref.task_id],env:{...process.env,HETU_COLLABORATION_DIR:collaboration},stderr:"pipe"});transport.stderr?.on("data",()=>{});await machine.connect(transport);sourceClients.set(task.task_ref.task_id,machine);
  const initial=await machine.callTool({name:"hetu_open_task_view",arguments:{task_ref:task.task_ref}});await page.addInitScript(value=>Object.assign(window,value),{initialTask:initial,viewHtml:html,realTask:true});await page.goto(origin);
  let view=page.frameLocator("iframe");const candidate=view.locator(".candidate"),preview=candidate.locator(".image-region-preview"),canvas=preview.getByRole("group",{name:"图片意见区域",exact:true});
  await preview.getByRole("button",{name:"标记区域",exact:true}).click();await canvas.press("Enter");await canvas.press("ArrowRight");await canvas.press("Shift+ArrowDown");
  await preview.getByRole("button",{name:"对此区域提意见",exact:true}).click();const quote=view.getByRole("region",{name:"意见所指图片区域",exact:true});await expect(quote).toContainText("31, 45");
  await preview.getByRole("button",{name:"移除区域",exact:true}).click();await expect(quote).toHaveCount(0);
  await preview.getByRole("button",{name:"标记区域",exact:true}).click();await canvas.press("Enter");await canvas.press("ArrowRight");await canvas.press("Shift+ArrowDown");await preview.getByRole("button",{name:"对此区域提意见",exact:true}).click();await expect(quote).toContainText("31, 45");
  await view.getByLabel("补充要求或意见",{exact:true}).fill("只改标记衣领，保留表情。🌿");
  let lost=true;await page.route("**/rpc",async route=>{if(lost&&route.request().postDataJSON().params?.name==="hetu_save_task_feedback"){lost=false;await route.fetch();await route.abort("failed");return;}await route.continue();});
  await view.getByRole("button",{name:"保存位置意见",exact:true}).click();await expect(view.locator("#status")).toContainText("保存结果尚未确认");
  await view.getByRole("button",{name:"查询原保存结果",exact:true}).click();await expect(view.getByRole("region",{name:"已保存的位置意见",exact:true})).toContainText("31, 45");
  const feedback=await machine.callTool({name:"hetu_list_task_feedback",arguments:{task_ref:task.task_ref}});const first=(feedback.structuredContent as any).data.feedback[0];
  expect(first.feedback.target_refs[0]).toEqual({kind:"candidate",candidate_ref:submitted.candidate_refs[0],image_region:{x:31,y:45,width:60,height:91}});
  expect((await page.evaluate(()=>window.harness.calls)).filter(item=>item.name==="hetu_save_task_feedback")).toHaveLength(1);
  const returned=await machine.callTool({name:"hetu_submit_creative_result",arguments:{...submit,feedback_refs:[first.feedback_ref],operation_key:"image-region-second"}});expect((returned.structuredContent as any).status,JSON.stringify(returned)).toBe("succeeded");
  await view.getByRole("button",{name:"读取最新结果",exact:true}).click();await expect(preview.locator(".image-region-selection")).toHaveCount(0);
  const current=await machine.callTool({name:"hetu_open_task_view",arguments:{task_ref:task.task_ref}}),reopened=await page.context().newPage();
  await reopened.addInitScript(value=>Object.assign(window,value),{initialTask:current,viewHtml:html,realTask:true,testMessages:true,testExtensions:true});await reopened.goto(origin);await page.close();page=reopened;view=page.frameLocator("iframe");
  await expect(view.getByRole("region",{name:"已保存的位置意见",exact:true})).toContainText("31, 45");
  await page.evaluate(()=>window.harness.context({theme:"dark",locale:"en"}));await page.setViewportSize({width:420,height:900});await expect(view.getByRole("region",{name:"Saved position feedback",exact:true})).toContainText("31, 45");
  await page.screenshot({path:info.outputPath("task-image-region-dark-narrow.png"),fullPage:true});
  const history=await machine.callTool({name:"hetu_list_task_feedback",arguments:{task_ref:task.task_ref}});expect((history.structuredContent as any).data.feedback).toHaveLength(1);expect((history.structuredContent as any).data.feedback[0].reported_result_refs.length).toBeGreaterThan(0);
  const second=await machine.callTool({name:"hetu_save_task_feedback",arguments:{task_ref:task.task_ref,target_refs:[{kind:"candidate",candidate_ref:submitted.candidate_refs[0],image_region:{x:2,y:3,width:10,height:20}}],expected_feedback_head:first.feedback_ref,intent:"request_changes",public_comment:"另一个部位的意见，不替换先前衣领意见。",selected_refs:[],operation_key:"image-region-another-feedback"}});expect((second.structuredContent as any).status,JSON.stringify(second)).toBe("succeeded");
  await view.getByRole("button",{name:"Load latest results",exact:true}).click();await view.getByText("All feedback",{exact:true}).click();
  const all=view.getByRole("region",{name:"Public feedback history",exact:true});await expect(all.getByText("只改标记衣领，保留表情。🌿",{exact:true})).toBeVisible();await expect(all.getByText("另一个部位的意见，不替换先前衣领意见。",{exact:true})).toBeVisible();
  await expect(all.getByRole("article").getByText("Revision returned",{exact:true})).toHaveCount(1);await expect(all.getByRole("article").getByText("Awaiting revision",{exact:true})).toHaveCount(1);
  const old=all.getByRole("article",{name:"Feedback 1",exact:true}),newer=all.getByRole("article",{name:"Feedback 2",exact:true}),prompt=view.getByRole("textbox",{name:"Continuation prompt",exact:true});
  await old.getByRole("button",{name:"Continue this feedback",exact:true}).click();await expect(prompt).toHaveValue(new RegExp(first.feedback_ref.feedback_id));await expect(prompt).not.toHaveValue(new RegExp((second.structuredContent as any).data.feedback_ref.feedback_id));
  await page.evaluate(()=>{window.harness.messageMode="lost";});await view.getByRole("button",{name:"Add to current draft",exact:true}).click();await expect(view.getByText("Message delivery is unconfirmed. Check this conversation before resending.",{exact:true})).toBeVisible();
  await newer.getByRole("button",{name:"Continue this feedback",exact:true}).click();await expect(view.getByRole("button",{name:"Add to current draft",exact:true})).toBeEnabled();
  await old.getByRole("button",{name:"Continue this feedback",exact:true}).click();await expect(view.getByRole("button",{name:"Add to current draft",exact:true})).toBeDisabled();expect(await page.evaluate(()=>window.harness.messages)).toHaveLength(1);
  expect((await page.evaluate(()=>window.harness.calls)).filter(item=>item.name==="hetu_save_task_feedback")).toHaveLength(0);
  const selector=all.getByRole("combobox",{name:"Feedback status",exact:true});await selector.focus();
  expect(await selector.evaluate(element=>{const computed=getComputedStyle(element),probe=document.createElement("span");probe.style.cssText="background:var(--paper);color:var(--ink)";element.parentElement!.append(probe);const expected=getComputedStyle(probe),valid=computed.backgroundColor===expected.backgroundColor&&computed.color===expected.color&&computed.fontSize==="12px";probe.remove();return valid;})).toBe(true);
  await page.screenshot({path:info.outputPath("task-feedback-history-dark-narrow.png"),fullPage:true});
  await all.screenshot({path:info.outputPath("task-feedback-history-detail-dark-narrow.png")});
 }finally{if(task)sourceClients.delete(task.task_ref.task_id);await machine?.close();await core.close();}
});

test.beforeAll(async () => {
  test.setTimeout(60_000);
  const cargoTarget = resolve(process.env.HETU_CARGO_TARGET_DIR ?? "../../target");
  const folder = await mkdtemp(join(tmpdir(), "hetu-apps-integration-"));
  const collaboration = await mkdtemp(join(tmpdir(), "hetu-apps-collaboration-"));
  const fixture = spawnSync(resolve(cargoTarget, "debug/examples/task_view_fixture"), [folder, collaboration], { encoding: "utf8" });
  if (fixture.status !== 0) throw new Error(fixture.error?.message || fixture.stderr || "Fixture failed");
  taskRef = JSON.parse(fixture.stdout).task_ref;
  managementRef = JSON.parse(fixture.stdout).management_ref;
  proposalID = JSON.parse(fixture.stdout).proposal_id;
  const profile=join(collaboration,"profile");await mkdir(profile);
  const env=Object.fromEntries(Object.entries({...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_NODE:process.execPath,CODEX_HOME:join(profile,"codex")} as Record<string,string|undefined>).filter((entry):entry is [string,string]=>typeof entry[1]==="string"));

  managementClient = new Client({ name: "hetu-operation-integration-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  await managementClient.connect(new StdioClientTransport({ command: resolve(cargoTarget, "debug/hetu-mcp"), args: ["--client", "codex", "--collaboration-dir", collaboration], env, stderr: "pipe" }));
  client = new Client({ name: "hetu-browser-integration-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  await client.connect(new StdioClientTransport({ command: resolve(cargoTarget, "debug/hetu-mcp"), args: ["--workspace", folder, "--task", String(taskRef.task_id)], stderr: "pipe" }));
  const library=await managementClient.callTool({name:"hetu_call_action",arguments:{action:"hetu.works.list",input:{management_ref:managementRef,limit:100,include_archived:true}}});
  const works=(library.structuredContent as any).data.works;
  await writeFile(join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:folder,workspace_id:works[0].work_ref.workspace_id,works}]}));
  const tools = await client.listTools();
  const uri = (tools.tools.find(tool => tool.name === "hetu_open_task_view")?._meta?.ui as { resourceUri?: string })?.resourceUri;
  if (!uri) throw new Error("Native server did not advertise an Apps resource");
  const resource = await client.readResource({ uri });
  if (!("text" in resource.contents[0])) throw new Error("Native UI resource has no HTML");
  html = resource.contents[0].text;
  initialTask = await client.callTool({ name: "hetu_open_task_view", arguments: { task_ref: taskRef } });
  const host = await build({ entryPoints: ["tests/host.ts"], bundle: true, write: false, format: "esm", target: "es2022" });
  server = createServer(async (request, response) => {
    try {
      if (request.url === "/rpc" && request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const { method, params } = JSON.parse(Buffer.concat(chunks).toString());
        const sourceTask=params?.arguments?.task_ref?.task_id??params?.uri?.match(/^hetu:\/\/task\/[^/]+\/[^/]+\/([^/]+)\//)?.[1];
        const active = params?.name === "hetu_get_management_operation" || ["hetu_open_app", "hetu_app_request", "hetu_call_action", "hetu_inspect_collaboration"].includes(params?.name) ? managementClient : sourceClients.get(String(sourceTask))??client;
        const result = method === "tools/call" ? await active.callTool(params) : method === "resources/read" ? await active.readResource(params) : null;
        if (!result) throw new Error("Unexpected bridge method");
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
      } else if (request.url === "/host.js") {
        response.setHeader("Content-Type", "application/javascript"); response.end(host.outputFiles[0].text);
      } else {
        response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><head><meta charset="utf-8"><title>Native integration host</title></head><body><script type="module" src="/host.js"></script></body></html>');
      }
    } catch { response.writeHead(500); response.end("Integration bridge failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local integration address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (client) await client.close();
  if (managementClient) await managementClient.close();
});

test("real workbench opens authorized novel, drama and video through portable tools and plays verified bytes", async ({ page }) => {
  test.setTimeout(120_000);
  const initial = await managementClient.callTool({ name: "hetu_open_app", arguments: { management_ref: managementRef } });
  const tools = await managementClient.listTools();
  const entry=tools.tools.find(tool=>tool.name==="hetu_open_app") as { _meta?: {ui?: {resourceUri?: string}} } | undefined;
  const uri=entry?._meta?.ui?.resourceUri as string;
  const resource = await managementClient.readResource({ uri });
  if (!("text" in resource.contents[0])) throw new Error("Missing workbench");
  const manifest = JSON.parse(await readFile("../mcp/resources/workbench.manifest.json", "utf8"));
  expect(createHash("sha256").update(resource.contents[0].text).digest("hex")).toBe(manifest.sha256);
  await page.addInitScript(value => Object.assign(window, value), { initialTask: initial, viewHtml: resource.contents[0].text, realTask: true, workbenchMode: true });
  await page.goto(origin);
  const view = page.frameLocator("iframe");
  await view.getByRole("button", { name: "打开作品 河港视频", exact: true }).click();
  await expect(view.getByRole("alert")).toHaveCount(0);
  await navigate(view, "视频");
  await expect(view.getByRole("tablist", { name: "打开的文稿", exact: true })).toHaveCount(0);
  await expect(view.getByRole("combobox",{name:"视频分集",exact:true})).toBeVisible();
  await expect(view.getByRole("combobox",{name:"视频成果版本",exact:true})).toBeVisible();
  const player = view.locator("video");
  await expect(player).toBeVisible();
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => Number.isFinite(node.duration) && node.duration > 0)).toBe(true);
  await player.evaluate((node: HTMLVideoElement) => { node.muted = true; return node.play(); });
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0);
  await navigate(view, "返回创作库");
  await view.getByRole("button", { name: "打开作品 河港剧本", exact: true }).click();
  await navigate(view, "剧本");
  await expect(view.locator(".workspace-title")).toHaveText("河港剧本");
  await expect(view.getByRole("tablist", { name: "打开的文稿", exact: true })).toHaveCount(0);
  await expect(view.getByRole("alert")).toHaveCount(0);
});

test("stable management → real operation resource → sandboxed review keeps the author decision separate", async ({ page }) => {
  const initial = await managementClient.callTool({ name: "hetu_get_management_operation", arguments: { management_ref: managementRef, proposal_id: proposalID } });
  const resource = await managementClient.readResource({ uri: "ui://hetu/operation-view/1" });
  if (!("text" in resource.contents[0])) throw new Error("Missing operation view");
  await page.addInitScript(value => Object.assign(window, value), { initialTask: initial, viewHtml: resource.contents[0].text, realTask: true, operationInput: { management_ref: managementRef } });
  await page.goto(origin);
  const view = page.frameLocator("iframe");
  await expect(view.getByRole("heading", { name: "查看操作方案", exact: true })).toBeVisible();
  await expect(view.getByText("整理作品资料，等待作者确认", { exact: true })).toBeVisible();
  await expect(view.getByRole("button", { name: /批准|执行/ })).toHaveCount(0);
  await view.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(view.getByRole("button", { name: "刷新状态", exact: true })).toBeEnabled();
  await expect(view.getByText("整理作品资料，等待作者确认", { exact: true })).toBeVisible();
  const loaded = await managementClient.callTool({ name: "hetu_get_management_operation", arguments: { management_ref: managementRef, proposal_id: proposalID } });
  expect((loaded.structuredContent as { data: { state: string } }).data.state).toBe("pending");
  await page.screenshot({ path: resolve("../../output/ai-first-acceptance-20261115/mcp-operation-review.png"), fullPage: true });
});

test("native stdio → SDK resource → sandboxed Apps → persisted preference → native readback", async ({ page }) => {
  await page.addInitScript(value => { Object.assign(window, value); }, { initialTask, viewHtml: html, realTask: true });
  await page.goto(origin);
  const view = page.frameLocator("iframe");
  await expect(view.getByRole("checkbox").first()).toBeEnabled();
  await expect(view.getByText("雾港听潮", { exact: true })).toBeVisible();
  await view.getByRole("checkbox").first().check();
  await view.getByLabel("补充要求或意见").fill("选第一项作为讨论方向，保留作者定稿权。🌿");
  await view.getByRole("button", { name: "保存选择与意见", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("已记录偏好，尚未采纳");
  const loaded = await client.callTool({ name: "hetu_read_creative_task", arguments: { task_ref: taskRef } });
  const data = (loaded.structuredContent as { data: { decision: { comment: string; candidate_refs: { task_ref: unknown }[]; effect: string } } }).data;
  expect(data.decision.comment).toBe("选第一项作为讨论方向，保留作者定稿权。🌿");
  expect(data.decision.effect).toBe("preference_only");
  expect(data.decision.candidate_refs).toHaveLength(1);
  expect(data.decision.candidate_refs[0].task_ref).toEqual(taskRef);
  const forbidden = await client.callTool({ name: "hetu_save_task_selection", arguments: { task_ref: taskRef, expected: { revision: 1, sha256: "a".repeat(64) }, candidate_refs: [], comment: "旧修订不能覆盖", operation_key: "stale-bridge-save" } });
  expect((forbidden.structuredContent as { error: { code: string } }).error.code).toBe("revision_conflict");
});

test("real Apps feedback continues the original working reference and remains separate from adoption", async ({ page }) => {
  const current = await client.callTool({ name: "hetu_open_task_view", arguments: { task_ref: taskRef } });
  await page.addInitScript(value => { Object.assign(window, value); }, { initialTask: current, viewHtml: html, realTask: true });
  await page.goto(origin);
  const view = page.frameLocator("iframe");
  await view.getByRole("checkbox").first().check();
  await view.getByLabel("补充要求或意见").fill("保留河港意象，缩短书名。");
  await view.getByRole("button", { name: "按此修改", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("修改意见已保存");
  await expect(view.getByRole("button", { name: "发送给当前 Agent", exact: true })).toHaveCount(0);
  const feedback = await client.callTool({ name: "hetu_list_task_feedback", arguments: { task_ref: taskRef } });
  const items = (feedback.structuredContent as { data: { feedback: { feedback_ref: unknown; feedback: { public_comment: string } }[] } }).data.feedback;
  expect(items.at(-1)?.feedback.public_comment).toBe("保留河港意象，缩短书名。");
  const refs = [items.at(-1)!.feedback_ref];
  const created = await client.callTool({ name: "hetu_create_working_copy", arguments: { task_ref: taskRef, artifact_kind: "title", source_format: "plain", title: "书名返工", base_refs: [], content: "雾港", feedback_refs: refs, operation_key: "real-apps-followup" } });
  const copy = (created.structuredContent as { data: { working_copy_ref: unknown } }).data.working_copy_ref;
  expect(copy).toBeTruthy();
  const task = await client.callTool({ name: "hetu_read_creative_task", arguments: { task_ref: taskRef } });
  const requestSHA = (task.structuredContent as { data: { request_sha256: string } }).data.request_sha256;
  const submitted = await client.callTool({ name: "hetu_submit_creative_result", arguments: { task_ref: taskRef, request_sha256: requestSHA, working_copy_refs: [copy], feedback_refs: refs, complete: true, missing_items: [], provenance: { client: "real-apps-test", skill_version: "1" }, operation_key: "real-apps-submit" } });
  expect((submitted.structuredContent as { status: string }).status).toBe("succeeded");
  await view.getByRole("button", { name: "读取最新结果", exact: true }).click();
  await expect(view.getByText("雾港", { exact: true })).toBeVisible();
  await expect(view.getByText("已收到针对这条意见的新方案，请核对修改。", { exact: true })).toBeVisible();
});
