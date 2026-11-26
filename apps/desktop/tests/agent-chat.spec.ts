import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,chmod,readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import path from "node:path";
import os from "node:os";
import {defaultSessionId,recordPath} from "../src/main/agent/session-storage.ts";
import {agentSessionSandbox} from "../src/main/agent/context.ts";
import {navigate,closeApplication,observeApplicationShutdown} from "./navigation.ts";
import {AppServer} from "../src/main/rpc.ts";
import {PluginPackage} from "../../../packages/plugin-host/src/package.ts";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";

const root=path.resolve(import.meta.dirname,"../../..");
test("GUI展示真实协议时间线，历史锚点、Markdown、输入与偏好保持一致",async({},info)=>{
 test.setTimeout(150000);
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-agent-chat-")),profile=path.join(folder,"profile"),workspace=path.join(folder,"作品"),collaboration=path.join(folder,"collaboration"),binary=path.join(folder,"codex"),log=path.join(folder,"turns.jsonl");
 const fixtures=process.env.HETU_ACCEPT_FIXTURE_DIRECTORY??path.join(root,"target/debug/examples");
 const fixture=spawnSync(path.join(fixtures,"baseline_fixture"+(process.platform==="win32"?".exe":"")),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.error?.message??fixture.stderr).toBe(0);
 const work=JSON.parse(fixture.stdout).novel;
 await mkdir(path.join(profile,"agent-sessions"),{recursive:true});
 await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"默认小说"}]}]}));
 await writeFile(recordPath(profile,work),JSON.stringify({schema_version:1,session_id:defaultSessionId(work),title:"历史创作对话",cwd:agentSessionSandbox(profile,work),work_ref:work,surface:"gui",thread_id:"gui-history",messages:[],updated_at:"2026-11-24T00:00:00Z"}));
 await writeFile(binary,`#!/bin/sh\nexec "${process.execPath}" "${binary}.mjs" "$@"\n`);await chmod(binary,0o755);
 await writeFile(binary+".mjs",`
 import http from "node:http";import {appendFileSync} from "node:fs";import WebSocket from ${JSON.stringify(createRequire(import.meta.url).resolve("ws"))};
 const turns=Array.from({length:210},(_,i)=>({id:"old-"+i,status:"completed",items:[{id:"user-"+i,type:"userMessage",content:[{type:"text",text:"历史问题"+i}]},{id:"reply-"+i,type:"agentMessage",text:"历史答复"+i+"\\n\\n"+"海风沿旧港口吹过。".repeat(12)}]}));
 const server=http.createServer(),wss=new WebSocket.WebSocketServer({server});server.listen(process.argv[process.argv.indexOf("--listen")+1].slice(7));let count=0;
 wss.on("connection",peer=>peer.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id===undefined)return;const reply=result=>peer.send(JSON.stringify({id:m.id,result})),notify=(method,params)=>peer.send(JSON.stringify({method,params:{threadId:"gui-history",...params}}));
 if(m.method==="account/read")reply({account:null,requiresOpenaiAuth:false});
 else if(m.method==="config/read")reply({config:{}});
 else if(m.method==="thread/resume"||m.method==="thread/read")reply({thread:{id:"gui-history",turns}});
 else if(m.method==="turn/start"){const id="new-"+(++count);appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+"\\n");reply({turn:{id}});notify("turn/started",{turn:{id}});notify("item/started",{turnId:id,item:{id:"user-"+id,type:"userMessage",content:m.params.input}});notify("item/started",{turnId:id,item:{id:"tool-"+id,type:"commandExecution",command:"检查固定来源",status:"inProgress"}});
 setTimeout(()=>{notify("item/completed",{turnId:id,item:{id:"tool-"+id,type:"commandExecution",command:"检查固定来源",status:"failed",exitCode:1,durationMs:450,aggregatedOutput:"隔离来源读取失败，未修改作品。"}});notify("item/agentMessage/delta",{turnId:id,itemId:"reply-"+id,delta:"## 固定答复\\n\\n- 已读取原文\\n- 保留既有表达\\n\\n| 章节 | 状态 |\\n| --- | --- |\\n| 第一章 | 待修订 |\\n\\n"+String.fromCharCode(96).repeat(3)+"js\\nconst chapter = 1;\\n"+String.fromCharCode(96).repeat(3)+"\\n\\n[公开来源](https://hetu.limeai.run/) [本机链接](file:///etc/passwd) ![不自动外发图片](https://invalid.test/private.png)"});notify("turn/completed",{turn:{id,status:"completed"}});},160);
 }else reply({});}));
 `);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const executable=process.env.HETU_PACKAGED_APP;
 const coreBinary=executable?path.resolve(path.dirname(executable),process.platform==="darwin"?"../Resources/bin/hetu-app-server":"resources/bin/hetu-app-server"+(process.platform==="win32"?".exe":"")):path.join(root,"target/debug/hetu-app-server");
 const core=await AppServer.open(coreBinary,workspace);
 const call=async(action:string,input:any)=>{const value=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data;};
 const currentDocuments=await call("hetu.documents.list",{work_ref:work});
 const formalItems=Array.from({length:23},(_,index)=>({id:`outline_00000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,title:index<2?"同名章纲":`第${index+1}章纲`,text:index===0?"保留灯塔，铺垫无线电。":index===1?"核对旧港口，保持另一条独立思路。":`正式大纲${index+1}`,level:"chapter",target_id:currentDocuments.documents[0].document_id}));
 const formal=await call("hetu.outlines.save",{expected:{revision:0,sha256:null},items:formalItems,operation_key:"chat-outline-first"});
 const initialCanon=await call("hetu.blueprints.get",{work_ref:work});
 const people=[{character_id:"character_00000000-0000-4000-8000-000000000001",name:"江岚",description:"守塔人，保留父亲的嘱托。",aliases:[],traits:[],facts:[],archived:false},{character_id:"character_00000000-0000-4000-8000-000000000002",name:"江岚",description:"同名访客，身份仍待核对。",aliases:[],traits:[],facts:[],archived:false}];
 const fixedCanon=await call("hetu.blueprints.save",{work_ref:work,expected:{blueprint_id:initialCanon.blueprint.blueprint_id,revision:initialCanon.revision,sha256:initialCanon.sha256},typed_changes:people.map(entity=>({type:"upsert_character",entity})),operation_key:"chat-canon-first"});
 const preparation=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"固定雾港参考稿",input_refs:[],client_adapter:"codex",language_tag:"zh-CN"});
 const task=await call("hetu.creative_tasks.prepare",{...preparation.prepare_input,operation_key:"chat-context-task"});
 const copy=await call("hetu.working_copies.create",{task_ref:task.task_ref,artifact_kind:"text",source_format:"markdown",title:"雾港工作稿",base_refs:[],content:"灯塔前的第一版参考。",operation_key:"chat-copy-first"});
 const feedback=await call("hetu.task_feedback.save",{task_ref:task.task_ref,target_refs:[{kind:"working_copy",working_copy_ref:copy.working_copy_ref}],expected_feedback_head:null,intent:"request_changes",public_comment:"保留灯塔，压缩动作。",selected_refs:[],operation_key:"chat-feedback-first"});
 const submit=(working_copy_ref:any,feedback_refs:any[],key:string)=>call("hetu.creative_tasks.submit_result",{task_ref:task.task_ref,request_sha256:task.request_sha256,working_copy_refs:[working_copy_ref],feedback_refs,complete:true,missing_items:[],provenance:{client:"context-test",skill_version:"1"},operation_key:key});
 const submitted=await submit(copy.working_copy_ref,[feedback.feedback_ref],"chat-submit-first");
 const pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist")),timelinePkg=await PluginPackage.inspect(path.join(root,"plugins/timeline/dist"));
 const pluginSave=async(input:any)=>{const value=await core.request("plugins/request",{context:{plugin_id:pkg.manifest.id,package_sha256:pkg.sha256,work_ref:work,types:pkg.manifest.contributions.data},request:{action:"hetu.extensions.objects.save",contract_revision:"1",input:{work_ref:work,kind:"relationships",title:"雾港人物关系",schema_version:"1",content:{nodes:[],edges:[]},...input}}});expect(value.status,JSON.stringify(value)).toBe("succeeded");return value.data;};
 const professional=await pluginSave({expected_revision:0,expected_sha256:"",operation_key:"chat-professional-first"});
 const timelineSaved=await core.request("plugins/request",{context:{plugin_id:timelinePkg.manifest.id,package_sha256:timelinePkg.sha256,work_ref:work,types:timelinePkg.manifest.contributions.data},request:{action:"hetu.extensions.objects.save",contract_revision:"1",input:{work_ref:work,kind:"timeline",title:"雾港时序",schema_version:"1",content:{events:[{id:"letter",title:"收到来信",time:"凌晨",description:"时序不替换人物关系。"}]},expected_revision:0,expected_sha256:"",operation_key:"chat-timeline-first"}}});expect(timelineSaved.status,JSON.stringify(timelineSaved)).toBe("succeeded");
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...env,HETU_DESKTOP_PROFILE:profile,HETU_PLUGIN_ACCESS_DIR:path.join(folder,"plugin-access"),HETU_COLLABORATION_DIR:collaboration,HETU_CODEX_BIN:binary,...(!executable?{HETU_PLUGIN_NODE:process.execPath,HETU_APP_SERVER:coreBinary,HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
 try{
  await observeApplicationShutdown(app,info.outputPath("shutdown.jsonl"));
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await navigate(page,"Agent 协作");
  await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});},pkg.source);
  await page.evaluate(()=>window.hetuDesktop.install());
  await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},timelinePkg.source);await page.evaluate(()=>window.hetuDesktop.install());
  const chat=page.locator(".agent-chat"),records=chat.getByRole("region",{name:"会话记录",exact:true});
  await expect(chat).toBeVisible();await expect(page.getByText("已连接",{exact:true})).toBeVisible({timeout:30000});
  const input=chat.getByRole("textbox",{name:"发送给 Agent",exact:true});
  await input.fill("核对固定来源");
  await page.getByRole("complementary",{name:"作品目录",exact:true}).getByRole("button",{name:"第一章 雾港",exact:true}).click();
  await page.locator(".agent-content-preview").getByRole("button",{name:"插入引用",exact:true}).click();
  const attached=chat.locator('.agent-chat-input [aria-label="附加的上下文"]');await expect(attached).toContainText("第一章 雾港");await expect(input).toHaveValue("核对固定来源");
  const attachment=(await page.evaluate(()=>window.hetuDesktop.agentSession("get"))).context_refs[0];
  await attached.locator(".agent-context-chip > details > summary").click();await expect(attached.locator("li").first()).toHaveText("文稿");await page.screenshot({path:info.outputPath("gui-context-preview.png")});await attached.locator("summary").filter({hasText:"完整引用"}).click();await expect(attached.getByLabel("第一章 雾港的固定引用",{exact:true})).toContainText('"revision_id"');await attached.locator(".agent-context-chip > details > summary").click();
  // 快捷附加作品资料后移除，发送范围只保留明确选择的固定章节。
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"作品资料",exact:true}).click();await expect(attached.locator(".agent-context-chip")).toHaveCount(2);
  await attached.getByRole("button",{name:"移除上下文 作品资料",exact:true}).click();await expect(attached.locator(".agent-context-chip")).toHaveCount(1);
  // 任务和专业成果的只读加载允许关闭，旧回包不能污染新选择器。
  await app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers,state=globalThis as any;
   for(const channel of ["desktop:tasks","desktop:state","desktop:fallback"]){
    const original=handlers.get(channel);handlers.set(channel,async(event:any,...args:any[])=>{
     const result=await original(event,...args),hold=state.__contextReadHold;
     if(hold?.channel===channel&&(!hold.method||hold.method===args[0])&&(!hold.tool||hold.tool===args[2]?.name)){
      state.__contextReadHold=undefined;await new Promise<void>(resolve=>{state.__releaseContextRead=()=>{state.__contextReadReleased=true;resolve();};});
     }
     if(channel==="desktop:state"&&state.__failContextOwners){state.__failContextOwners=false;return {...result,plugins:[],plugin_state_error:"隔离验收：插件目录暂时不可用。"};}
     if(channel==="desktop:tasks"&&args[2]?.name==="hetu_open_task_view"&&state.__failContextTask){state.__failContextTask=false;throw Error("隔离验收：任务详情暂时不可用。");}
     if(channel==="desktop:tasks"&&args[2]?.name==="hetu_list_working_copies"&&state.__failContextCopies){state.__failContextCopies=false;throw Error("隔离验收：下一页工作稿暂时不可用。");}
     return result;
    });
   }
   state.__contextReadHold={channel:"desktop:tasks",method:"list"};
  });
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"参考稿与公开意见",exact:true}).click();
  const loadingTask=page.getByRole("dialog",{name:"参考稿与公开意见",exact:true});
  await expect.poll(()=>app.evaluate(()=>typeof (globalThis as any).__releaseContextRead)).toBe("function");
  await expect(loadingTask.getByRole("button",{name:"关闭上下文选择",exact:true})).toBeEnabled();
  await page.keyboard.press("Escape");await expect(loadingTask).toHaveCount(0);await expect(chat.getByLabel("附加上下文",{exact:true})).toBeFocused();
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"专业成果",exact:true}).click();
  const loadingPlugin=page.getByRole("dialog",{name:"专业成果",exact:true});
  await expect(loadingPlugin.getByRole("combobox",{name:"成果所属插件",exact:true})).toBeEnabled();await app.evaluate(()=>(globalThis as any).__releaseContextRead());
  await expect(loadingPlugin).not.toContainText("固定雾港参考稿");await loadingPlugin.getByRole("button",{name:"关闭上下文选择",exact:true}).click();
  await app.evaluate(()=>{(globalThis as any).__failContextOwners=true;});
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"专业成果",exact:true}).click();
  await expect(loadingPlugin.getByRole("alert")).toContainText("插件目录暂时不可用");await expect(loadingPlugin).not.toContainText("没有匹配的专业成果");
  await loadingPlugin.getByRole("button",{name:"重新读取",exact:true}).click();
  const ownerChoice=loadingPlugin.getByRole("combobox",{name:"成果所属插件",exact:true});await expect(ownerChoice).toBeEnabled();await ownerChoice.selectOption(pkg.manifest.id);await expect(loadingPlugin.getByRole("button",{name:/雾港人物关系/})).toBeEnabled();
  await ownerChoice.selectOption(timelinePkg.manifest.id);await expect(loadingPlugin.getByRole("button",{name:/雾港时序/})).toBeEnabled();
  await app.evaluate((_,owner)=>{const state=globalThis as any;delete state.__releaseContextRead;state.__contextReadHold={channel:"desktop:fallback",method:owner};},pkg.manifest.id);
  await ownerChoice.selectOption(pkg.manifest.id);await expect.poll(()=>app.evaluate(()=>typeof (globalThis as any).__releaseContextRead)).toBe("function");
  await ownerChoice.selectOption(timelinePkg.manifest.id);await expect(loadingPlugin.getByRole("button",{name:/雾港时序/})).toBeEnabled();await app.evaluate(()=>(globalThis as any).__releaseContextRead());
  await expect(loadingPlugin.getByRole("button",{name:/雾港人物关系/})).toHaveCount(0);await expect(loadingPlugin.getByRole("button",{name:/雾港时序/})).toBeEnabled();
  await loadingPlugin.getByRole("button",{name:"关闭上下文选择",exact:true}).click();await expect(input).toHaveValue("核对固定来源");await expect(attached.locator(".agent-context-chip")).toHaveCount(1);
  // 目录回包经过真实Owner；关闭后即使旧目录迟到，也不能污染另一种来源选择。
  await app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers,read=handlers.get("desktop:read"),session=handlers.get("desktop:agent-session"),state=globalThis as any;
   state.__holdOutlineRead=true;
   handlers.set("desktop:read",async(event:any,action:string,input:any)=>{
    const value=await read(event,action,input);
    if(action==="hetu.outlines.get"&&state.__holdOutlineRead){state.__holdOutlineRead=false;await new Promise<void>(resolve=>{state.__releaseOutlineRead=()=>{state.__outlineReadReleased=true;resolve();};});}
    return value;
   });
   handlers.set("desktop:agent-session",async(event:any,method:string,input:any)=>{
    if(method==="attach_context"&&state.__holdOutlineAttach){state.__holdOutlineAttach=false;await new Promise<void>(resolve=>{state.__releaseOutlineAttach=resolve;});}
    try{return await session(event,method,input);}finally{if(method==="attach_context")state.__outlineAttachFinished=true;}
   });
  });
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"正式大纲",exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>typeof (globalThis as any).__releaseOutlineRead)).toBe("function");
  await expect(page.getByRole("dialog",{name:"正式大纲",exact:true}).getByRole("status")).toContainText("正在读取");
  await page.keyboard.press("Escape");await expect(page.getByRole("dialog",{name:"正式大纲",exact:true})).toHaveCount(0);await expect(chat.getByLabel("附加上下文",{exact:true})).toBeFocused();
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"人物与设定",exact:true}).click();
  const waitingCanon=page.getByRole("dialog",{name:"人物与设定",exact:true});await expect(waitingCanon.locator(".agent-context-picker-items > button")).toHaveCount(2);
  await app.evaluate(()=>(globalThis as any).__releaseOutlineRead());await expect(waitingCanon.locator(".agent-context-picker-items > button")).toHaveCount(2);await expect(waitingCanon).not.toContainText("同名章纲");
  await waitingCanon.getByRole("button",{name:"关闭上下文选择",exact:true}).click();await expect(attached.locator(".agent-context-chip")).toHaveCount(1);
  // 另一个入口在附加等待时切换当前会话，原请求不能写进新的会话。
  const originalSession=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));
  await app.evaluate(()=>{const state=globalThis as any;state.__holdOutlineAttach=true;state.__outlineAttachFinished=false;});
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"正式大纲",exact:true}).click();
  const delayedPicker=page.getByRole("dialog",{name:"正式大纲",exact:true});await delayedPicker.getByRole("button").filter({hasText:"保留灯塔，铺垫无线电。"}).click();
  await expect.poll(()=>app.evaluate(()=>typeof (globalThis as any).__releaseOutlineAttach)).toBe("function");
  const parallelSession=await page.evaluate(()=>window.hetuDesktop.agentSession("new"));expect(parallelSession.session_id).not.toBe(originalSession.session_id);
  await app.evaluate(()=>(globalThis as any).__releaseOutlineAttach());await expect.poll(()=>app.evaluate(()=>(globalThis as any).__outlineAttachFinished)).toBe(true);
  await expect(delayedPicker.getByRole("alert")).toContainText("会话已经切换");
  expect((await page.evaluate(()=>window.hetuDesktop.agentSession("get"))).context_refs??[]).toEqual([]);
  const restored=await page.evaluate(session_id=>window.hetuDesktop.agentSession("select",{session_id}),originalSession.session_id);expect(restored.context_refs).toEqual(originalSession.context_refs);
  await delayedPicker.getByRole("button",{name:"关闭上下文选择",exact:true}).click();await expect(input).toHaveValue("核对固定来源");
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"正式大纲",exact:true}).click();
  const outlinePicker=page.getByRole("dialog",{name:"正式大纲",exact:true});await expect(outlinePicker.locator(".agent-context-picker-items > button")).toHaveCount(20);
  await outlinePicker.getByRole("button",{name:"更多大纲",exact:true}).click();await expect(outlinePicker.locator(".agent-context-picker-items > button")).toHaveCount(23);
  await outlinePicker.getByRole("searchbox",{name:"查找正式大纲",exact:true}).fill("同名章纲");await outlinePicker.getByRole("button",{name:"查找",exact:true}).click();await expect(outlinePicker.locator(".agent-context-picker-items > button")).toHaveCount(2);
  await page.screenshot({path:info.outputPath("gui-outline-context-picker.png")});await outlinePicker.getByRole("button").filter({hasText:"保留灯塔，铺垫无线电。"}).click();await expect(outlinePicker).toHaveCount(0);
  const outlineAttachment=(await page.evaluate(()=>window.hetuDesktop.agentSession("get"))).context_refs[1];expect(outlineAttachment.reference.fixed_refs).toEqual([{kind:"outline",work_ref:work,outline_id:formalItems[0].id,revision:formal.revision,sha256:formal.sha256}]);
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"人物与设定",exact:true}).click();
  const canonPicker=page.getByRole("dialog",{name:"人物与设定",exact:true});await canonPicker.getByRole("searchbox",{name:"查找人物或设定",exact:true}).fill("江岚");await expect(canonPicker.locator(".agent-context-picker-items > button")).toHaveCount(2);
  await page.setViewportSize({width:800,height:760});expect(await canonPicker.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath("gui-canon-context-picker-narrow.png")});
  await canonPicker.getByRole("button").filter({hasText:"守塔人，保留父亲的嘱托。"}).click();await expect(canonPicker).toHaveCount(0);await page.setViewportSize({width:1440,height:900});
  const canonAttachment=(await page.evaluate(()=>window.hetuDesktop.agentSession("get"))).context_refs[2];expect(canonAttachment.reference.fixed_refs).toHaveLength(1);expect(canonAttachment.reference.fixed_refs[0]).toMatchObject({kind:"blueprint",entity_ref:people[0].character_id,revision:fixedCanon.revision,sha256:fixedCanon.sha256});
  await call("hetu.outlines.save",{expected:{revision:formal.revision,sha256:formal.sha256},items:formalItems.map((item,index)=>index===0?{...item,text:"已推进的新章纲，旧消息仍保留旧版本。"}:item),operation_key:"chat-outline-second"});
  await call("hetu.blueprints.save",{work_ref:work,expected:{blueprint_id:fixedCanon.blueprint.blueprint_id,revision:fixedCanon.revision,sha256:fixedCanon.sha256},typed_changes:[{type:"upsert_character",entity:{...people[0],description:"已推进的新人物资料。"}}],operation_key:"chat-canon-second"});
  const novel=await call("hetu.novels.get",{});await call("hetu.novels.update",{expected:{revision:novel.revision,sha256:novel.sha256},metadata:{...novel.novel.metadata,title:"作品已改名，旧文稿与设定仍固定"},operation_key:"chat-work-rename"});
  await expect(attached.locator(".agent-context-chip")).toHaveCount(3);
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"参考稿与公开意见",exact:true}).click();
  const taskPicker=page.getByRole("dialog",{name:"参考稿与公开意见",exact:true});await taskPicker.getByRole("button",{name:/固定雾港参考稿/}).click();await expect(taskPicker.getByRole("button",{name:/雾港工作稿/})).toBeEnabled();await page.screenshot({path:info.outputPath("gui-task-context-picker.png")});await taskPicker.getByRole("button",{name:/雾港工作稿/}).click();await expect(taskPicker).toHaveCount(0);
  await expect(attached.locator(".agent-context-chip")).toHaveCount(4);
  const taskAttachment=(await page.evaluate(()=>window.hetuDesktop.agentSession("get"))).context_refs[3];
  expect(taskAttachment.reference.fixed_refs.find((item:any)=>item.kind==="working_copy").working_copy_ref).toEqual(copy.working_copy_ref);
  expect(taskAttachment.reference.fixed_refs.find((item:any)=>item.kind==="task_feedback").feedback_ref).toEqual(feedback.feedback_ref);
  // 工作稿超过一页时，返回目录取消旧页；重试保留已有页和原游标。
  for(let index=1;index<=20;index++)await call("hetu.working_copies.create",{task_ref:task.task_ref,artifact_kind:"text",source_format:"markdown",title:`分页工作稿${index}`,base_refs:[],content:`独立工作稿${index}，不提交。`,operation_key:`chat-page-copy-${index}`});
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"参考稿与公开意见",exact:true}).click();
  await app.evaluate(()=>{(globalThis as any).__failContextTask=true;});await taskPicker.getByRole("button",{name:/固定雾港参考稿/}).click();
  await expect(taskPicker.getByRole("alert")).toContainText("任务详情暂时不可用");await expect(taskPicker.getByRole("button",{name:"附加已提交稿与意见",exact:true})).toHaveCount(0);
  await taskPicker.getByRole("button",{name:"重新读取",exact:true}).click();await expect(taskPicker.getByText("固定工作修订",{exact:true})).toHaveCount(20);
  await app.evaluate(()=>{const state=globalThis as any;delete state.__releaseContextRead;state.__contextReadHold={channel:"desktop:tasks",method:"call",tool:"hetu_list_working_copies"};});
  await taskPicker.getByRole("button",{name:"更多参考稿",exact:true}).click();await expect.poll(()=>app.evaluate(()=>typeof (globalThis as any).__releaseContextRead)).toBe("function");
  await taskPicker.getByRole("button",{name:"返回任务目录",exact:true}).click();await expect(taskPicker.getByRole("region",{name:"选择参考内容",exact:true})).toHaveCount(0);
  await app.evaluate(()=>(globalThis as any).__releaseContextRead());await expect(taskPicker.getByRole("button",{name:/固定雾港参考稿/})).toBeEnabled();await expect(taskPicker.getByText("固定工作修订",{exact:true})).toHaveCount(0);
  await taskPicker.getByRole("button",{name:/固定雾港参考稿/}).click();await expect(taskPicker.getByText("固定工作修订",{exact:true})).toHaveCount(20);
  await app.evaluate(()=>{(globalThis as any).__failContextCopies=true;});await taskPicker.getByRole("button",{name:"更多参考稿",exact:true}).click();
  await expect(taskPicker.getByRole("alert")).toContainText("下一页工作稿暂时不可用");await expect(taskPicker.getByText("固定工作修订",{exact:true})).toHaveCount(20);
  await taskPicker.getByRole("button",{name:"重新读取",exact:true}).click();await expect(taskPicker.getByText("固定工作修订",{exact:true})).toHaveCount(21);await expect(taskPicker.getByRole("alert")).toHaveCount(0);
  await expect(taskPicker.getByRole("button",{name:"关闭上下文选择",exact:true})).toBeInViewport();await expect(taskPicker.getByRole("heading",{name:"参考稿与公开意见",exact:true})).toBeInViewport();
  await page.screenshot({path:info.outputPath("gui-context-working-pagination.png")});await taskPicker.getByRole("button",{name:"关闭上下文选择",exact:true}).click();await expect(attached.locator(".agent-context-chip")).toHaveCount(4);await expect(input).toHaveValue("核对固定来源");
  const changedCopy=await call("hetu.working_copies.save",{task_ref:task.task_ref,working_copy_id:copy.working_copy_ref.working_copy_id,expected:copy.working_copy_ref,content:"推进后的第二版参考。",feedback_refs:[feedback.feedback_ref],operation_key:"chat-copy-second"});
  await submit(changedCopy.working_copy_ref,[feedback.feedback_ref],"chat-submit-second");
  const changedFeedback=await call("hetu.task_feedback.save",{task_ref:task.task_ref,target_refs:[{kind:"working_copy",working_copy_ref:changedCopy.working_copy_ref}],expected_feedback_head:feedback.feedback_ref,intent:"request_changes",public_comment:"新意见不替换旧引用。",selected_refs:[],operation_key:"chat-feedback-second"});
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"专业成果",exact:true}).click();
  const pluginPicker=page.getByRole("dialog",{name:"专业成果",exact:true});await pluginPicker.getByRole("combobox",{name:"成果所属插件",exact:true}).selectOption(pkg.manifest.id);
  await page.setViewportSize({width:800,height:760});expect(await pluginPicker.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath("gui-plugin-context-picker-narrow.png")});
  await pluginPicker.getByRole("button",{name:/雾港人物关系/}).click();await expect(pluginPicker).toHaveCount(0);await page.setViewportSize({width:1440,height:900});
  await expect(attached.locator(".agent-context-chip")).toHaveCount(5);const pluginAttachment=(await page.evaluate(()=>window.hetuDesktop.agentSession("get"))).context_refs[4];
  const changedProfessional=await pluginSave({object_id:professional.object.object_id,expected_revision:professional.object.revision,expected_sha256:professional.sha256,title:"新版人物关系",operation_key:"chat-professional-second"});
  await page.evaluate(owner=>window.hetuDesktop.toggle(owner,false),pkg.manifest.id);
  await chat.getByLabel("附加上下文",{exact:true}).click();await chat.getByRole("button",{name:"专业成果",exact:true}).click();
  await expect(pluginPicker.getByRole("combobox",{name:"成果所属插件",exact:true}).getByRole("option",{name:"人物关系图（已停用）",exact:true})).toHaveCount(1);
  await pluginPicker.getByRole("combobox",{name:"成果所属插件",exact:true}).selectOption(pkg.manifest.id);await expect(pluginPicker.getByRole("button",{name:/新版人物关系/})).toBeEnabled();
  await page.screenshot({path:info.outputPath("gui-disabled-plugin-context.png")});await pluginPicker.getByRole("button",{name:"关闭上下文选择",exact:true}).click();
  expect(pluginAttachment.reference.fixed_refs[0].revision).toBe(1);
  const access=await page.evaluate(()=>window.hetuDesktop.connection("status","codex"));
  const machine=new Client({name:"retained-source-check",version:"1"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
  try{
   await machine.connect(new StdioClientTransport({command:path.join(path.dirname(coreBinary),"hetu-mcp"+(process.platform==="win32"?".exe":"")),args:["--client","codex","--collaboration-dir",collaboration],stderr:"pipe"}));
   const result=await machine.callTool({name:"hetu_call_action",arguments:{action:"hetu.plugin_results.get",input:{management_ref:access.management_ref,work_ref:work,owner_plugin_id:pkg.manifest.id,object_id:professional.object.object_id,revision:1}}});
   expect((result.structuredContent as any).status,JSON.stringify(result)).toBe("succeeded");expect((result.structuredContent as any).data.sha256).toBe(professional.sha256);
  }finally{await machine.close();}
  await page.screenshot({path:info.outputPath("gui-source-contexts.png")});
  const source=attachment.reference.fixed_refs.find((item:any)=>item.kind==="document");
  const saved=await core.request("workspace/request",{action:"hetu.documents.save",contract_revision:"1",input:{document_id:source.document_id,base_revision_id:source.revision_id,source_format:"markdown",content:"已推进的新修订。此前附加的历史来源保持原义。",operation_key:"gui-context-new-head"}});expect(saved.status,JSON.stringify(saved)).toBe("succeeded");
  await expect(chat.locator("[data-entry]")).toHaveCount(60);await expect(records).toContainText("历史答复209");
  await records.evaluate(element=>{element.scrollTop=0;});await chat.getByRole("button",{name:"加载更早记录",exact:false}).click();await expect(chat.locator("[data-entry]")).toHaveCount(120);
  for(const count of [180,240,240]){await chat.getByRole("button",{name:"加载更早记录",exact:false}).click();await expect(chat.locator("[data-entry]")).toHaveCount(count);}
  // 加载前后原历史项仍在视口，流式新消息不把向上阅读的位置拉走。
  const anchor=await records.evaluate(element=>{const top=element.getBoundingClientRect().top,node=[...element.querySelectorAll<HTMLElement>("[data-entry]")].find(node=>node.getBoundingClientRect().bottom>top)!;return {key:node.dataset.entry,offset:node.getBoundingClientRect().top-top};});
  await page.getByRole("complementary",{name:"作品目录",exact:true}).getByRole("button",{name:"第一章 雾港",exact:true}).click();await expect(page.locator(".agent-content-preview")).toContainText("灯塔在黎明前亮起");await page.getByRole("tab",{name:"Codex",exact:true}).click();
  const returned=await records.evaluate((element,key)=>{const node=[...element.querySelectorAll<HTMLElement>("[data-entry]")].find(node=>node.dataset.entry===key)!;return node.getBoundingClientRect().top-element.getBoundingClientRect().top;},anchor.key);expect(Math.abs(returned-anchor.offset)).toBeLessThan(3);
  await page.evaluate(async()=>{const state=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:state.revision,patch:{agent_session:{scroll_on_send:false}}});});
  await input.fill("核对固定来源");await input.press("Shift+Enter");await expect(input).toHaveValue("核对固定来源\n");await input.press("Enter");
  await expect(chat.getByRole("button",{name:"有新记录，回到最新",exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(async()=>(await window.hetuDesktop.agentSession("get")).state)).toBe("ready");
  const after=await records.evaluate((element,key)=>{const node=[...element.querySelectorAll<HTMLElement>("[data-entry]")].find(node=>node.dataset.entry===key)!;return node.getBoundingClientRect().top-element.getBoundingClientRect().top;},anchor.key);
  expect(Math.abs(after-anchor.offset)).toBeLessThan(3);
  await chat.getByRole("button",{name:"有新记录，回到最新",exact:true}).click();await expect(chat.getByRole("heading",{name:"固定答复",exact:true})).toHaveCount(1);await expect(chat.getByRole("alert")).toContainText("隔离来源读取失败");
  await expect(chat.locator(".agent-chat-tool-state")).toHaveText("失败");await expect(chat.locator(".agent-chat-duration")).toHaveText("450 ms");
  await expect(chat.locator("table")).toContainText("第一章");await expect(chat.locator("a")).toHaveCount(1);await expect(chat.locator("img")).toHaveCount(0);
  await chat.getByRole("button",{name:"复制代码",exact:true}).click();expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe("const chapter = 1;\n");
  expect((await readFile(log,"utf8")).trim().split("\n")).toHaveLength(1);
  const sent=JSON.parse((await readFile(log,"utf8")).trim().split("\n")[0]).params.input[0].text;
  expect(sent).toContain(source.revision_id);expect(sent).not.toContain(saved.data.revision.revision_id);expect(sent).not.toContain("management_ref");expect(sent).not.toContain(workspace);
  expect(sent).toContain(copy.working_copy_ref.working_revision_id);expect(sent).not.toContain(changedCopy.working_copy_ref.working_revision_id);expect(sent).toContain(feedback.feedback_ref.feedback_id);expect(sent).not.toContain(changedFeedback.feedback_ref.feedback_id);expect(sent).toContain(professional.sha256);expect(sent).not.toContain(changedProfessional.sha256);
  expect(sent).toContain(formal.sha256);expect(sent).toContain(fixedCanon.sha256);
  const sentSnapshot=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));expect(sentSnapshot.context_refs).toHaveLength(0);expect(sentSnapshot.messages.find((item:any)=>item.text==="核对固定来源\n").context_refs).toEqual([attachment,outlineAttachment,canonAttachment,taskAttachment,pluginAttachment]);
  await page.screenshot({path:info.outputPath("gui-light.png")});
  // 偏好即时传播，不重建原线程；Enter换行和主修饰键发送分别生效。
  const before=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));
  await page.evaluate(async()=>{const state=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:state.revision,patch:{appearance:"dark",agent_session:{chat_font_size:18,code_font_size:14,chat_width:"wide",enter_sends:false,show_changes:false}}});});
  await expect(chat).toHaveCSS("font-size","18px");await expect(chat.locator("code").first()).toHaveCSS("font-size","14px");
  await input.fill("保留草稿");await input.press("Enter");await expect(input).toHaveValue("保留草稿\n");
  await input.dispatchEvent("compositionstart");await input.press("Control+Enter");await input.dispatchEvent("compositionend");expect((await readFile(log,"utf8")).trim().split("\n")).toHaveLength(1);
  const current=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));expect(current.thread_id).toBe(before.thread_id);expect(current.generation).toBe(before.generation);
  await page.setViewportSize({width:800,height:760});await expect(chat).toBeVisible();expect(await chat.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  const narrowTabs=page.getByRole("tablist",{name:"会话与预览",exact:true});
  await writeFile(info.outputPath("narrow-header-geometry.json"),JSON.stringify(await page.locator(".codex-session-header").evaluate(element=>Object.fromEntries([".agent-work-choice",".codex-session-picker","[role=status]",".codex-header-tabs",".codex-session-actions"].map(selector=>{const node=element.querySelector<HTMLElement>(selector)!,bounds=node.getBoundingClientRect();return [selector,{left:bounds.left,right:bounds.right,width:bounds.width}];}))),null,2)+"\n");
  expect(await narrowTabs.evaluate(element=>element.clientWidth)).toBeGreaterThanOrEqual(128);
  expect(await page.locator(".codex-session-header").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await expect(page.getByRole("button",{name:"关闭终端面板",exact:true})).toBeInViewport({ratio:1});
  await page.getByLabel("当前会话",{exact:true}).click();await expect(page.getByRole("searchbox",{name:"查找会话",exact:true})).toBeVisible();await page.getByLabel("当前会话",{exact:true}).click();
  const documentTab=narrowTabs.getByRole("tab",{name:"第一章 雾港（旧修订）",exact:true});await documentTab.click();
  await expect(documentTab).toHaveAttribute("aria-selected","true");await expect(documentTab).toBeInViewport({ratio:1-1/(await documentTab.boundingBox())!.width});
  const closePreview=page.getByRole("button",{name:"关闭预览 第一章 雾港（旧修订）",exact:true});await expect(closePreview).toBeInViewport({ratio:1});
  expect(await documentTab.evaluate(element=>element.clientWidth)).toBeGreaterThanOrEqual(80);
  await page.screenshot({path:info.outputPath("gui-narrow-preview-header.png")});
  const codexTab=narrowTabs.getByRole("tab",{name:"Codex",exact:true});await documentTab.press("Home");await expect(codexTab).toBeFocused();await expect(codexTab).toBeInViewport({ratio:1});
  await codexTab.press("End");await expect(documentTab).toBeFocused();await expect(closePreview).toBeInViewport({ratio:1});await documentTab.press("Home");await expect(chat).toBeVisible();
  await page.setViewportSize({width:1440,height:900});await page.getByRole("button",{name:"并排查看作品",exact:true}).click();
  const dock=page.getByRole("complementary",{name:"终端工作区",exact:true}),header=dock.locator(".codex-session-header");
  await expect(dock).toBeVisible();await expect(header).toHaveCSS("height","71px");
  await codexTab.press("End");await expect(documentTab).toBeInViewport({ratio:1});await expect(closePreview).toBeInViewport({ratio:1});
  expect(await header.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath("gui-docked-preview-header.png")});
  await dock.getByRole("separator",{name:"调整终端侧栏宽度",exact:true}).press("Home");await expect(header).toHaveCSS("height","106px");
  await expect(documentTab).toBeInViewport({ratio:1});await expect(closePreview).toBeInViewport({ratio:1});await expect(dock.getByRole("button",{name:"关闭终端面板",exact:true})).toBeInViewport({ratio:1});
  expect(await header.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath("gui-minimum-dock-header.png")});
  await dock.getByRole("button",{name:"展开终端工作区",exact:true}).click();await documentTab.press("Home");await page.setViewportSize({width:800,height:760});await expect(chat).toBeVisible();
  expect(await page.locator(".codex-session-header").evaluate(element=>{const status=element.querySelector('[role="status"]')!.getBoundingClientRect(),actions=element.querySelector('.codex-session-actions')!.getBoundingClientRect(),tabs=element.querySelector('.codex-header-tabs')?.getBoundingClientRect();return status.right<=(tabs?.left??actions.left)&&(!tabs||tabs.right<=actions.left);})).toBe(true);
  await page.screenshot({path:info.outputPath("gui-dark-narrow.png")});
  const failures=await page.locator(".agent-chat-tool details").getAttribute("open");expect(failures).toBeNull();
  // 来源损坏时不发第二轮，保留正文与引用，错误就在输入区可见。
  const invalid=structuredClone(attachment);invalid.reference.fixed_refs.find((item:any)=>item.kind==="document").sha256="0".repeat(64);
  await input.fill("请保留当前草稿");await input.blur();await expect.poll(()=>page.evaluate(async()=>(await window.hetuDesktop.agentSession("get")).draft)).toBe("请保留当前草稿");
  await page.evaluate(async ref=>{const value=await window.hetuDesktop.agentSession("get");await window.hetuDesktop.agentSession("draft",{session_id:value.session_id,generation:value.generation,surface:"gui",text:"请保留当前草稿",context_refs:[ref]});},invalid);
  await expect(input).toHaveValue("请保留当前草稿");await chat.getByRole("button",{name:"发送",exact:true}).click();await expect(chat.locator(".agent-chat-send-error")).toContainText("第一章 雾港");await expect(input).toHaveValue("请保留当前草稿");expect((await readFile(log,"utf8")).trim().split("\n")).toHaveLength(1);
  await page.screenshot({path:info.outputPath("gui-context-error.png")});await attached.getByRole("button",{name:"移除上下文 第一章 雾港",exact:true}).click();await expect(attached).toHaveCount(0);await expect(input).toHaveValue("请保留当前草稿");
 }catch(error){await app.windows()[0]?.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});throw error;}finally{await closeApplication(app);await core.close();}
});
