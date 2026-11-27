import {test,expect as baseExpect,_electron as electron,type Page} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile,symlink} from "node:fs/promises";
import {spawn,spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {closeApplication} from "./navigation.ts";
import {launchExecutionWorkspace,createExecutionChat} from "./fixtures/execution-workspace.ts";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {agentSessionSandbox} from "../src/main/agent/context.ts";
import {externalSessionDirectory} from "../src/main/agent/terminal-workspace-state.ts";
import {recordPath} from "../src/main/agent/session-storage.ts";

const root=path.resolve(import.meta.dirname,"../../..");
const evidence=process.env.HETU_TEST_OUTPUT??path.join(root,"output/verification/external-execution-2026-11-27");
const node=process.env.HETU_TEST_NODE??process.execPath;
const expect=baseExpect.configure({timeout:30000});

const launch=(seedWork=false)=>launchExecutionWorkspace({seedWork,evidence,node});
const createChat=createExecutionChat;

async function openBots(page:Page) {
  if(!await page.getByRole("button",{name:"Bots",exact:true}).isVisible())await page.getByRole("button",{name:"展开左侧栏",exact:true}).click();
  await page.getByRole("button",{name:"Bots",exact:true}).click();
}

async function closeBot(bots: ReturnType<Page["getByRole"]>) {
  const menu=bots.getByLabel("聊天操作",{exact:true});if(!await menu.evaluate(element=>(element.closest("details") as HTMLDetailsElement).open))await menu.click();
  await bots.getByRole("button",{name:"关闭外部工作面",exact:true}).click();
  await expect(bots).toHaveCount(0);
}
async function openBotSettings(bots: ReturnType<Page["getByRole"]>) {
  let trigger=bots.getByRole("button",{name:"Bot 设置",exact:true});
  if(!await trigger.isVisible()){const menu=bots.getByLabel("聊天操作",{exact:true});if(!await menu.evaluate(element=>(element.closest("details") as HTMLDetailsElement).open))await menu.click();trigger=bots.getByRole("button",{name:"Bot 设置",exact:true});}
  await trigger.click();await expect(bots.getByText(/\/ 设置$/)).toBeVisible();
}

async function assertPanelFits(page:Page){
  const layout=await page.locator(".external-runtime-panel").evaluate(panel=>{
    const bounds=panel.getBoundingClientRect(),body=panel.querySelector(".external-runtime-body")!;
    return {width:bounds.width,right:bounds.right,viewport:innerWidth,overflow:body.scrollWidth-body.clientWidth,border:getComputedStyle(panel).borderTopWidth};
  });
  expect(layout.right).toBeLessThanOrEqual(layout.viewport);expect(layout.overflow).toBeLessThanOrEqual(1);expect(layout.border).toBe("0px");
  await expect(page.locator(".project-navigation")).not.toBeVisible();
}

test("多引擎GUI保留原问题/表单和草稿，Bots固定配置及窄窗浅暗可用",async({},testInfo)=>{
  test.setTimeout(180000);test.skip(process.platform==="win32","协议夹具使用Unix可执行入口。");
  const r=await launch(),errors:string[]=[],metrics:any[]=[];r.page.on("pageerror",error=>errors.push(error.message));
  let failed=false;
  try{
    await createChat(r.page,"opencode");
    const input=r.page.getByRole("textbox",{name:"发送给 Agent",exact:true});
    await input.fill("核对当前审阅重点。");await r.page.getByRole("button",{name:"发送",exact:true}).click();
    const form=r.page.getByRole("form",{name:"外部AI需要你的回答",exact:true});await expect(form).toBeVisible();
    await expect(form.getByRole("combobox",{name:"审阅重点",exact:true})).toHaveValue("");
    await form.getByRole("combobox",{name:"审阅重点",exact:true}).selectOption("value:structure");
    await form.getByRole("combobox",{name:"保留作者意见",exact:true}).selectOption("true");
    await r.page.screenshot({path:path.join(evidence,"gui-form-light.png")});
    await form.getByRole("button",{name:"提交表单",exact:true}).click();
    await expect(r.page.getByText("ACP运行完成🌿",{exact:true})).toBeVisible();
    await createChat(r.page,"claude-code");
    await input.fill("核对下一轮创作方向。");await r.page.getByRole("button",{name:"发送",exact:true}).click();
    const questions=r.page.getByRole("form",{name:"Claude需要你的回答",exact:true});await expect(questions).toBeVisible();
    await expect(questions.getByRole("radio").first()).not.toBeChecked();
    await input.fill("保留下一轮的中文草稿。\n等待作者继续。 ");
    await questions.getByRole("textbox",{name:"创作方向：自由回答",exact:true}).fill("先核对人物选择。 ");
    await questions.getByRole("button",{name:"提交回答",exact:true}).click();
    await expect(r.page.getByText("Claude流式完成🌿",{exact:true})).toBeVisible();
    await expect(input).toHaveValue("保留下一轮的中文草稿。\n等待作者继续。 ");
    await openBots(r.page);
    let bots=r.page.getByRole("region",{name:"Bots",exact:true});await expect(bots).toBeVisible();
    const createBot=async(name:string,purpose:string,provider:string,surface:"gui"|"tui")=>{
      if(!await bots.getByRole("button",{name:"新建 bot",exact:true}).first().isVisible())await bots.getByRole("button",{name:"展开左侧栏",exact:true}).click();
      await bots.getByRole("button",{name:"新建 bot",exact:true}).first().click();
      const config=r.page.getByRole("dialog",{name:"新建 bot",exact:true});await expect(config).toBeVisible();await expect(config.getByRole("textbox",{name:"名称",exact:true})).toBeFocused();
      await config.getByRole("textbox",{name:"名称",exact:true}).fill(name);await config.getByRole("textbox",{name:"身份",exact:true}).fill(purpose);
      await config.getByRole("button",{name:/^智能体(?: |$)/}).click();const picker=config.getByRole("dialog",{name:"选择引擎与模型",exact:true}),catalog=await r.page.evaluate(()=>window.hetuDesktop.agentSession("catalog"));
      await picker.getByRole("tab",{name:catalog.find((item:any)=>item.id===provider).name,exact:true}).click();await picker.getByRole("textbox",{name:"助手模型",exact:true}).fill("test-model");
      const pickerGeometry=await picker.evaluate(element=>{const tab=element.querySelector<HTMLElement>('[role="tab"]')!.getBoundingClientRect();return {width:element.getBoundingClientRect().width,tab_width:tab.width,tab_height:tab.height};});expect(pickerGeometry).toEqual({width:Math.min(416,await r.page.evaluate(()=>innerWidth)-32),tab_width:34,tab_height:36});metrics.push({kind:"picker",surface,...pickerGeometry});
      await r.page.screenshot({path:path.join(evidence,surface==="gui"?"bot-picker-orca.png":"bot-picker-tui.png")});
      await picker.getByRole("group",{name:"运行方式",exact:true}).getByRole("button",{name:surface==="gui"?"聊天":"终端",exact:true}).click();await r.page.keyboard.press("Escape");
      const geometry=await config.evaluate(element=>({width:element.getBoundingClientRect().width,padding:getComputedStyle(element).paddingLeft,height:(element.querySelector('textarea[aria-label="身份"]') as HTMLElement).getBoundingClientRect().height,avatar_width:element.querySelector('.bot-avatar')!.getBoundingClientRect().width}));expect(geometry).toEqual({width:Math.min(480,await r.page.evaluate(()=>innerWidth)-32),padding:"20px",height:120,avatar_width:64});metrics.push({kind:"form",surface,...geometry});
      await r.page.screenshot({path:path.join(evidence,surface==="gui"?"bot-create-orca.png":"bot-create-tui.png")});await config.getByRole("button",{name:"创建",exact:true}).click();await expect(config).toHaveCount(0,{timeout:45000});if(surface==="gui")await expect(bots.getByRole("status").filter({hasText:"已连接"})).toBeVisible({timeout:30000});
    };
    await createBot("固定审阅助手","围绕作者选择核对当前材料，保留意见与原稿。","kilo","gui");
    await expect(bots.getByRole("tablist",{name:"Bot 聊天",exact:true}).getByRole("tab",{name:"主聊天",exact:true})).toHaveAttribute("aria-controls","bot-chat-panel");
    await expect(bots.getByRole("tabpanel",{name:"主聊天",exact:true})).toBeVisible();
    const newBot=bots.getByRole("button",{name:"新建 bot",exact:true}).first();await newBot.click();
    const cancelled=r.page.getByRole("dialog",{name:"新建 bot",exact:true});await expect(cancelled.getByRole("textbox",{name:"名称",exact:true})).toBeFocused();await r.page.keyboard.press("Escape");await expect(cancelled).toHaveCount(0);await expect(newBot).toBeFocused();await expect(bots.getByRole("tabpanel",{name:"主聊天",exact:true})).toBeVisible();
    await bots.getByRole("textbox",{name:"发送给助手",exact:true}).fill("核对隔离会话。");await bots.getByRole("button",{name:"发送",exact:true}).click();
    await bots.getByRole("region",{name:"会话记录",exact:true}).getByRole("button",{name:"固定工具",exact:true}).click();await bots.getByRole("button",{name:"允许一次",exact:true}).click();
    await expect(bots.locator(".agent-chat-message")).toContainText(["核对隔离会话。","ACP运行完成🌿"]);
    const savedDraft="保留下一轮的中文草稿。\n继续核对固定来源。 ";
    await bots.getByRole("textbox",{name:"发送给助手",exact:true}).fill(savedDraft);await closeBot(bots);await expect(bots).toHaveCount(0);
    await openBots(r.page);bots=r.page.getByRole("region",{name:"Bots",exact:true});await expect(bots.getByRole("textbox",{name:"发送给助手",exact:true})).toHaveValue(savedDraft);
    for(const [width,appearance] of [[1200,"light"],[520,"light"],[1200,"dark"],[520,"dark"]] as const){
      const state=await r.page.evaluate(()=>window.hetuDesktop.settings("preferences"));await r.page.evaluate(({revision,appearance})=>window.hetuDesktop.settings("update",{expected_revision:revision,patch:{appearance}}),{revision:state.revision,appearance});
      await r.page.setViewportSize({width,height:850});await expect(r.page.locator("html")).toHaveAttribute("data-effective-appearance",appearance);await assertPanelFits(r.page);await r.page.screenshot({path:path.join(evidence,`bots-${appearance}-${width}.png`)});
      metrics.push({kind:"workspace",width,appearance,...await bots.locator('.bot-workspace').evaluate(element=>({background:getComputedStyle(element.querySelector('.bot-main')!).backgroundColor,foreground:getComputedStyle(element).color,columns:getComputedStyle(element).gridTemplateColumns,chat_height:element.querySelector('.agent-chat')!.getBoundingClientRect().height}))});
    }
    await openBotSettings(bots);await bots.getByRole("switch",{name:"已启用",exact:true}).click();await bots.getByRole("button",{name:"关闭 Bot 详情",exact:true}).click();
    await bots.getByRole("textbox",{name:"发送给助手",exact:true}).fill("停用后保留草稿。");await expect(bots.getByRole("button",{name:"发送",exact:true})).toBeDisabled();
    await bots.getByLabel("聊天操作",{exact:true}).click();await bots.getByRole("button",{name:"停止",exact:true}).click();
    await createBot("终端审阅助手","保留固定角色与模型，使用原生终端继续。","claude-agent-teams","tui");
    const terminal=bots.locator(".external-bot-terminal");await expect(terminal.locator(".xterm-accessibility-tree")).toContainText("REAL-BOT-PTY-READY");
    await expect(terminal.locator('[data-terminal-input-ready="true"]')).toBeVisible();await terminal.locator(".codex-terminal").click({position:{x:20,y:20}});await r.page.keyboard.type("TUI-BOT-OK");
    await expect.poll(async()=>{const rows=(await readFile(r.wire,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));return rows.filter(item=>item.kind==="tui-input").map(item=>item.data).join("");},{timeout:30000,message:"原PTY受理完整输入后核对界面，没有重发输入。"}).toBe("TUI-BOT-OK");
    await expect(bots.locator(".bot-chat-header").getByRole("button",{name:"查找",exact:true})).toBeVisible();await expect(terminal.locator(".codex-terminal-toolbar")).toHaveCount(0);
    await expect(terminal.locator(".xterm-accessibility-tree")).toContainText("TUI-BOT-OK");await assertPanelFits(r.page);await r.page.screenshot({path:path.join(evidence,"bot-tui-520.png")});
    await closeBot(bots);await openBots(r.page);bots=r.page.getByRole("region",{name:"Bots",exact:true});
    await expect(bots.locator(".external-bot-terminal .xterm-accessibility-tree")).toContainText("TUI-BOT-OK");await expect(bots.locator('[data-terminal-input-ready="true"]')).toBeVisible();
    await expect(bots.getByRole("complementary",{name:"会话导航",exact:true})).not.toBeVisible();
    await bots.getByLabel("聊天操作",{exact:true}).click();await bots.getByRole("button",{name:"停止",exact:true}).click();await closeBot(bots);
    const wire=(await readFile(r.wire,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(wire.find(item=>item.id==="form-fixed")?.result).toEqual({action:"accept",content:{direction:"structure",includeNotes:true}});
    expect(wire.find(item=>item.type==="control_response"&&item.response?.request_id==="permission-fixed")?.response.response.updatedInput.answers).toEqual({"下一轮先处理哪个问题？":"先核对人物选择。 "});
    expect(wire.find(item=>item.kind==="tui-start")?.model).toBe("test-model");
    expect(wire.find(item=>item.kind==="tui-start")?.role_present).toBe(true);
    expect(wire.filter(item=>item.kind==="tui-start")).toHaveLength(1);const inputs=wire.filter(item=>item.kind==="tui-input").map(item=>item.data);expect(inputs.join("")).toBe("TUI-BOT-OK");metrics.push({kind:"terminal",input_chunks:inputs.length,original_pty_preserved_on_reopen:true});
    expect(errors).toEqual([]);await writeFile(path.join(evidence,"gui-acceptance.json"),JSON.stringify({packaged:!!process.env.HETU_PACKAGED_APP,protocol_fixtures:true,real_bot_pty:true,paid_model_calls:0,checks:["Orca icon tabs/480px form/workspace geometry","Bot create/cancel restores focus and original chat","Bot draft closes/reopens on original session","GUI model selection","original ACP form","original Claude question and independent draft","Bot session/approval/pause","Bot xterm keyboard/resize/original PTY","light/dark each at 1200/520 layout"],metrics,page_errors:errors},null,2)+"\n");
  }catch(error){failed=true;await writeFile(path.join(evidence,"gui-failure.json"),JSON.stringify({error:String(error)},null,2)+"\n");await r.page.screenshot({path:path.join(evidence,"gui-failure.png")}).catch(()=>{});throw error;}
  finally{try{await closeApplication(r.application);}catch(error){if(!failed)throw error;await writeFile(path.join(evidence,"gui-shutdown-failure.json"),JSON.stringify({error:String(error)},null,2)+"\n");}}
});

test("Bot GUI与TUI真实MCP保存后打开固定历史并返回原Bot，停用仍可回读",async({},testInfo)=>{
 test.setTimeout(240000);test.skip(process.platform==="win32","协议夹具使用Unix可执行入口。");
 const r=await launch(true),checks:any[]=[],errors:string[]=[];r.page.on("pageerror",error=>errors.push(error.message));let failed=false;
 await r.application.evaluate(({ipcMain})=>{
  const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:agent-session");(globalThis as any).__botResultCalls=[];
  handlers.set("desktop:agent-session",async(event:unknown,method:string,input:any)=>{
   if(!["runtime","runtime_results"].includes(method))return original(event,method,input);
   const value=method==="runtime"?input.input:input,record:any={route:method,method:value.method,session_id:value.session_id,bot_id:value.bot_id??value.bot_ref?.bot_id,started_at:Date.now()};(globalThis as any).__botResultCalls.push(record);
   try{const result=await original(event,method,input);record.status=result?.status;record.error=result?.error?.message;record.returned_session_id=result?.data?.session_id;return result;}catch(error){record.error=(error as Error).message;throw error;}finally{record.finished_at=Date.now();}
  });
 });
 const request=async(input:Record<string,unknown>)=>{
  const response=await r.page.evaluate(({work,input})=>window.hetuDesktop.agentSession("runtime",{domain:"bots",work_ref:work,input}),{work:r.work,input});expect(response.status,JSON.stringify(response)).toBe("succeeded");return response.data;
 };
 try{
  await r.page.getByRole("dialog",{name:"创建会话",exact:true}).getByRole("combobox",{name:"会话作品",exact:true}).selectOption({label:"外部执行隔离小说"});await createChat(r.page,"kilo");
  for(const surface of ["gui","tui"] as const){
   const provider=surface==="gui"?"kilo":"claude-agent-teams",name="Bot成果助手 "+surface;
   const bot=await request({method:"create",config:{name,purpose:"保留固定角色与模型，使用原生终端继续。",execution:{provider_id:provider,surface,model_id:"test-model"}},operation_key:"result-bot-"+surface});
   const created=(await request({method:"session_create",expected_ref:bot.bot_ref,operation_key:"result-session-"+surface})).result;
   const started=(await request({method:"session_start",session_id:created.session_id,generation:created.generation,operation_key:"result-start-"+surface})).result;
   const savedDraft="保留Bot成果核对后的草稿 "+surface;
   await request({method:"session_draft",session_id:started.session_id,generation:started.generation,data:savedDraft,operation_key:"result-draft-"+surface});
   await openBots(r.page);let bots=r.page.getByRole("region",{name:"Bots",exact:true});
   await bots.locator(".external-bot-row").filter({hasText:name}).click();await expect(bots.locator(".bot-main").getByRole("button",{name:"查看作品成果",exact:true})).toBeEnabled({timeout:45000});
   const appPath=await r.application.evaluate(({app})=>app.getAppPath()),profile=path.join(r.collaboration,"sessions","generic","profile"),record=JSON.parse(await readFile(recordPath(profile,r.work,started.session_id),"utf8"));
   const directory=surface==="tui"?path.join(agentSessionSandbox(profile,r.work),started.session_id):externalSessionDirectory(profile,{workspace:record.cwd,accessDirectory:r.collaboration,workRef:record.work_ref,title:name},record.external_state.id,provider),config=path.join(directory,"hetu-mcp.json");
   const client=new Client({name:"hetu-bot-results-acceptance",version:"1"},{});
   const transport=new StdioClientTransport({command:node,args:[path.join(appPath,"dist/agent-mcp-relay.mjs"),config],env:Object.fromEntries(Object.entries({...process.env,HETU_COLLABORATION_DIR:r.collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(r.profile,"local-settings"),HETU_PLUGIN_NODE:node,HETU_PLUGIN_STATE_DIR:r.profile,HETU_PLUGIN_MANAGER:path.join(appPath,"dist/plugin-manager.mjs")}).filter((entry):entry is [string,string]=>typeof entry[1]==="string")),stderr:"pipe"});transport.stderr?.on("data",()=>{});
   let original:any;
   try{
    await client.connect(transport);
    const response=await client.callTool({name:"hetu_call_action",arguments:{action:"hetu.execution.invoke",input:{workspace_path:r.workspace,command:{action:"hetu.documents.create",contract_revision:"1",input:{kind:"novel_chapter",title:"Bot固定历史 "+surface,source_format:"markdown",content:"# 灯塔\n\n这是Bot原回执的保存修订 "+surface+"。🌿",operation_key:"bot-result-document-"+surface}}}}});
    const receipt=response.structuredContent as any;expect(receipt.status,JSON.stringify(receipt)).toBe("succeeded");expect(receipt.data.result.status).toBe("succeeded");original=receipt.data.result.data;
   }finally{await client.close();}
   const fixed={document_id:original.document.document_id,revision_id:original.revision.revision_id,sha256:original.revision.sha256};
   const conversation=await request({method:"session_read",session_id:started.session_id,format:"conversation"});expect(conversation.conversation.receipts_complete).toBe(true);expect(conversation.conversation.receipts.some((tool:any)=>tool.server==="hetu"&&tool.output.includes(fixed.revision_id))).toBe(true);
   const currentContent="# 灯塔\n\n这是后来改写的当前稿 "+surface+"。";
   const updated=await r.page.evaluate(command=>window.hetuDesktop.execution({action:"hetu.execution.invoke",contract_revision:"1",input:{command}}),{action:"hetu.documents.save",contract_revision:"1",input:{document_id:fixed.document_id,base_revision_id:fixed.revision_id,source_format:"markdown",content:currentContent,operation_key:"bot-result-later-"+surface}});expect(updated.data.result.status).toBe("succeeded");
   await bots.locator(".bot-main").getByRole("button",{name:"查看作品成果",exact:true}).click();let results=bots.getByRole("region",{name:"作品成果",exact:true});await expect(results.getByRole("button",{name:"Bot固定历史 "+surface,exact:true})).toBeEnabled();await expect(results).toContainText("当前写作稿已有更新");
   await r.page.keyboard.press("Escape");await expect(results).toHaveCount(0);await expect(bots).toBeVisible();await expect(bots.locator(".bot-main").getByRole("button",{name:"查看作品成果",exact:true})).toBeFocused();
   await bots.locator(".bot-main").getByRole("button",{name:"查看作品成果",exact:true}).click();results=bots.getByRole("region",{name:"作品成果",exact:true});await results.getByRole("button",{name:"Bot固定历史 "+surface,exact:true}).click();
   const saved=r.page.getByRole("region",{name:"已保存文稿",exact:true});await expect(saved).toHaveAttribute("data-revision-id",fixed.revision_id);await expect(saved).toContainText("这是Bot原回执的保存修订 "+surface);await expect(saved).not.toContainText("这是后来改写的当前稿");
   await saved.getByRole("button",{name:"与当前稿比较",exact:true}).click();const comparison=r.page.getByRole("dialog",{name:"比较修订 Bot固定历史 "+surface,exact:true});await expect(comparison).toContainText("这是Bot原回执的保存修订");await expect(comparison).toContainText("这是后来改写的当前稿");await comparison.getByRole("button",{name:"关闭修订比较",exact:true}).click();await r.page.screenshot({path:testInfo.outputPath("bot-fixed-"+surface+".png")});
   await r.page.evaluate(work_ref=>window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref}})),r.work);bots=r.page.getByRole("region",{name:"Bots",exact:true});if(!await bots.isVisible())await openBots(r.page);await expect(bots).toBeVisible();
   const returned=await request({method:"session_read",session_id:started.session_id,format:"conversation"});expect(returned.session_id).toBe(started.session_id);expect(returned.generation).toBe(started.generation);expect(returned.draft).toBe(savedDraft);if(surface==="tui")expect(returned.terminal_connected).toBe(true);else await expect(bots.getByRole("textbox",{name:"发送给助手",exact:true})).toHaveValue(savedDraft);
   if(!await bots.getByRole("switch",{name:"已启用",exact:true}).isVisible())await openBotSettings(bots);await bots.getByRole("switch",{name:"已启用",exact:true}).click();await expect(bots.getByRole("switch",{name:"已启用",exact:true})).toHaveAttribute("aria-checked","false");await closeBot(bots);await openBots(r.page);bots=r.page.getByRole("region",{name:"Bots",exact:true});
   await bots.locator(".bot-main").getByRole("button",{name:"查看作品成果",exact:true}).click();await expect(bots.getByRole("region",{name:"作品成果",exact:true}).getByRole("button",{name:"Bot固定历史 "+surface,exact:true})).toBeEnabled();await r.page.keyboard.press("Escape");
   const rejected=await r.page.evaluate(input=>window.hetuDesktop.agentSession("runtime_results",input).then(()=>false,()=>true),{domain:"bots",work_ref:r.work,session_id:started.session_id,generation:started.generation,bot_ref:{...bot.bot_ref,revision:bot.bot_ref.revision+1}});expect(rejected).toBe(true);
   const actual=await r.page.evaluate(id=>window.hetuDesktop.read("hetu.documents.get",{document_id:id}),fixed.document_id);expect(actual.data.content).toBe(currentContent);expect(actual.data.revision.revision_id).toBe(updated.data.result.data.revision.revision_id);
   await bots.getByLabel("聊天操作",{exact:true}).click();await bots.getByRole("button",{name:"停止",exact:true}).click();await expect(bots.locator(".bot-connection-state")).toHaveText("已停止");await closeBot(bots);
   checks.push({surface,real_mcp:true,core_verified_fixed_reference:fixed,current_revision:actual.data.revision.revision_id,compared_current:true,same_bot_session:true,draft_retained:true,paused_results_read:true,wrong_bot_rejected:true});
  }
  const wire=(await readFile(r.wire,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));expect(wire.filter(item=>item.method==="session/prompt"||item.type==="user")).toHaveLength(0);expect(errors).toEqual([]);
  await writeFile(testInfo.outputPath("result.json"),JSON.stringify({packaged:!!process.env.HETU_PACKAGED_APP,paid_model_calls:0,checks,page_errors:errors},null,2)+"\n");
 }catch(error){failed=true;await r.page.screenshot({path:testInfo.outputPath("failure.png")}).catch(()=>{});await writeFile(testInfo.outputPath("runtime-calls.json"),JSON.stringify(await r.application.evaluate(()=>(globalThis as any).__botResultCalls).catch(()=>[]),null,2));throw error;}
 finally{try{await closeApplication(r.application);}catch(error){if(!failed)throw error;await writeFile(testInfo.outputPath("shutdown-failure.json"),JSON.stringify({error:String(error)}));}}
});

test("原生电脑工作面关闭重开沿原接管会话恢复",async()=>{
  test.setTimeout(120000);test.skip(process.platform!=="darwin","当前原生电脑helper为macOS。");
  const r=await launch(),binary=path.join(r.folder,"computer-fixture");
  const compiled=spawnSync("xcrun",["swiftc",path.join(root,"apps/desktop/tests/fixtures/computer-window.swift"),"-o",binary],{encoding:"utf8"});expect(compiled.status,compiled.stderr).toBe(0);
  const fixture=spawn(binary,[],{stdio:["ignore","ignore","ignore"]});
  try{
    await r.page.getByRole("button",{name:"关闭创建会话",exact:true}).click();const openComputer=async()=>{await r.page.getByRole("button",{name:"计算机控制",exact:true}).click();};await openComputer();
    let panel=r.page.getByRole("region",{name:"计算机控制",exact:true});await panel.getByRole("button",{name:"查看应用窗口",exact:true}).click();
    await expect.poll(async()=>panel.getByRole("combobox",{name:"电脑应用",exact:true}).locator(`option[value="${fixture.pid}"]`).count()).toBe(1);
    await panel.getByRole("combobox",{name:"电脑应用",exact:true}).selectOption(String(fixture.pid));
    await panel.getByRole("combobox",{name:"电脑窗口",exact:true}).selectOption({label:"HETU-COMPUTER-FIXTURE"});
    const windowId=Number(await panel.getByRole("combobox",{name:"电脑窗口",exact:true}).inputValue());let readinessChecks=0;
    await expect.poll(async()=>{readinessChecks++;const result=await r.page.evaluate(input=>window.hetuDesktop.agentSession("runtime",{scope:"library",domain:"computer",input}),{method:"snapshot",session_id:"computer-ready-"+fixture.pid,app:{pid:fixture.pid},window_id:windowId});return result.status==="succeeded"&&result.data.elements.some((item:any)=>item.identifier==="hetu-fixture-input")?"ready":result.error?.code??result.status;},{timeout:10000}).toBe("ready");
    await panel.getByRole("button",{name:"更新观察",exact:true}).click();await expect(panel.getByRole("img",{name:"当前窗口的固定观察",exact:true})).toBeVisible();
    await panel.getByText("窗口元素",{exact:true}).click();await panel.getByRole("button",{name:/AXTextField/}).first().click();
    await panel.getByRole("textbox",{name:"电脑输入文字",exact:true}).fill("SAFE-UI-AX-VALUE");await panel.getByRole("button",{name:"填入所选元素",exact:true}).click();
    await expect(panel.getByText("动作已送达，请更新观察核对。",{exact:true})).toBeVisible();
    await panel.getByRole("button",{name:"更新观察",exact:true}).click();await panel.getByRole("button",{name:"交给我操作",exact:true}).click();
    await expect(panel.getByText("已交给你操作，机器输入已冻结。恢复前请更新观察。",{exact:true})).toBeVisible();
    const original=await r.page.evaluate(()=>window.hetuDesktop.agentSession("runtime_computer_state",{scope:"library"}));expect(original.state).toBe("taken_over");
    await panel.getByRole("button",{name:"关闭外部工作面",exact:true}).click();await openComputer();panel=r.page.getByRole("region",{name:"计算机控制",exact:true});
    await expect(panel.getByText("原窗口由你接管，机器输入仍已冻结。请先更新观察。",{exact:true})).toBeVisible();
    expect((await r.page.evaluate(()=>window.hetuDesktop.agentSession("runtime_computer_state",{scope:"library"}))).session_id).toBe(original.session_id);
    await panel.getByRole("button",{name:"更新观察",exact:true}).click();await expect(panel.getByRole("button",{name:"恢复机器操作",exact:true})).toBeEnabled();
    await panel.getByText("窗口元素",{exact:true}).click();await panel.getByRole("button",{name:/AXTextField/}).first().click();await expect(panel.getByRole("button",{name:"填入所选元素",exact:true})).toBeDisabled();
    await r.page.setViewportSize({width:520,height:850});await assertPanelFits(r.page);await r.page.screenshot({path:path.join(evidence,"computer-takeover-520.png")});
    await panel.getByRole("button",{name:"恢复机器操作",exact:true}).click();await expect(panel.getByText("已恢复输入，请更新观察后操作。",{exact:true})).toBeVisible();
    await expect(panel.getByRole("img",{name:"当前窗口的固定观察",exact:true})).not.toBeVisible();
    await panel.getByRole("button",{name:"关闭外部工作面",exact:true}).click();
    await writeFile(path.join(evidence,"computer-ui-acceptance.json"),JSON.stringify({packaged:!!process.env.HETU_PACKAGED_APP,native_fixture:true,paid_model_calls:0,readiness_checks:readinessChecks,checks:["original AX window ready before interaction","real screenshot","background AX set value","takeover panel reopen preserves session","frozen input","resume invalidates old observation","520px layout"]},null,2)+"\n");
  }finally{fixture.kill("SIGTERM");await closeApplication(r.application);}
});

test("仅截图窗口保留原观察和接管，辅助功能动作失败关闭",async({},info)=>{
  test.setTimeout(120000);test.skip(process.platform!=="darwin","当前截图helper为macOS。");
  const r=await launch(),binary=path.join(r.folder,"computer-image-fixture");
  const compiled=spawnSync("xcrun",["swiftc",path.join(root,"apps/desktop/tests/fixtures/computer-window.swift"),"-o",binary],{encoding:"utf8"});expect(compiled.status,compiled.stderr).toBe(0);
  const fixture=spawn(binary,["--screenshot-only"],{stdio:["ignore","pipe","ignore"]});
  try{
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("窗口未就绪")),10000);fixture.stdout!.once("data",()=>{clearTimeout(timer);resolve();});});
    await r.page.getByRole("dialog",{name:"创建会话",exact:true}).getByRole("button",{name:"关闭创建会话",exact:true}).click();await r.page.getByRole("button",{name:"计算机控制",exact:true}).click();
    let panel=r.page.getByRole("region",{name:"计算机控制",exact:true});await panel.getByRole("button",{name:"查看应用窗口",exact:true}).click();
    await expect(panel.getByRole("combobox",{name:"电脑应用",exact:true})).toBeEnabled();await panel.getByRole("combobox",{name:"电脑应用",exact:true}).selectOption(String(fixture.pid));
    await panel.getByRole("combobox",{name:"电脑窗口",exact:true}).selectOption({label:"HETU-COMPUTER-FIXTURE"});await panel.getByRole("button",{name:"更新观察",exact:true}).click();
    await expect(panel.getByRole("img",{name:"当前窗口的固定观察",exact:true})).toBeVisible();await expect(panel.getByText("当前窗口仅可观察截图，辅助功能操作保持停用。",{exact:true})).toBeVisible();await expect(panel.getByRole("button",{name:"填入所选元素",exact:true})).toHaveCount(0);
    const original=await r.page.evaluate(()=>window.hetuDesktop.agentSession("runtime_computer_state",{scope:"library"}));
    await panel.getByRole("button",{name:"返回计算机控制",exact:true}).click();await expect(panel.getByRole("region",{name:"计算机控制权限",exact:true})).toBeVisible();await r.page.setViewportSize({width:2560,height:1283});await r.page.screenshot({path:info.outputPath("computer-permissions-reference-viewport.png")});await panel.getByRole("button",{name:"查看应用窗口",exact:true}).click();await expect(panel.getByRole("img",{name:"当前窗口的固定观察",exact:true})).toBeVisible();expect((await r.page.evaluate(()=>window.hetuDesktop.agentSession("runtime_computer_state",{scope:"library"}))).session_id).toBe(original.session_id);await r.page.setViewportSize({width:1200,height:850});
    const observation=await r.page.evaluate(input=>window.hetuDesktop.agentSession("runtime",{scope:"library",domain:"computer",input}),{method:"snapshot",session_id:original.session_id,app:{pid:fixture.pid},window_id:original.window_id});
    expect(observation.status).toBe("succeeded");expect(observation.data.accessibility_status.state).toBe("unavailable");expect(observation.data.elements).toEqual([]);
    const rejected=await r.page.evaluate(input=>window.hetuDesktop.agentSession("runtime",{scope:"library",domain:"computer",input}),{method:"act",session_id:original.session_id,snapshot_ref:observation.data.snapshot_ref,element_index:0,action:{kind:"set_value",text:"MUST-NOT-BE-WRITTEN"},operation_key:"image-only-reject"});expect(rejected.status).not.toBe("succeeded");
    await panel.getByRole("button",{name:"更新观察",exact:true}).click();await panel.getByRole("button",{name:"交给我操作",exact:true}).click();await panel.getByRole("button",{name:"关闭外部工作面",exact:true}).click();await r.page.getByRole("button",{name:"计算机控制",exact:true}).click();
    panel=r.page.getByRole("region",{name:"计算机控制",exact:true});await expect(panel.getByText("原窗口由你接管，机器输入仍已冻结。请先更新观察。",{exact:true})).toBeVisible();await panel.getByRole("button",{name:"更新观察",exact:true}).click();await panel.getByRole("button",{name:"恢复机器操作",exact:true}).click();await panel.getByRole("button",{name:"更新观察",exact:true}).click();
    await expect(panel.getByRole("img",{name:"当前窗口的固定观察",exact:true})).toBeVisible();await expect(panel.getByRole("button",{name:"更新观察",exact:true})).toBeEnabled();
    await r.page.setViewportSize({width:520,height:850});await assertPanelFits(r.page);await r.page.screenshot({path:path.join(evidence,"computer-image-only-520.png")});
    await writeFile(path.join(evidence,"computer-image-only-acceptance.json"),JSON.stringify({packaged:!!process.env.HETU_PACKAGED_APP,native_fixture:true,paid_model_calls:0,checks:["real fixed-window image","no forged AX elements","AX write refused","takeover reopen retains original session","resume reobserves original window","520px layout"]},null,2)+"\n");
  }catch(error){await r.page.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});await writeFile(info.outputPath("failure-ax.yaml"),await r.page.locator("body").ariaSnapshot().catch(()=>"页面已关闭"));throw error;}finally{fixture.kill("SIGTERM");await closeApplication(r.application);}
});
