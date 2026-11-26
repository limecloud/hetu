import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile,chmod} from "node:fs/promises";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import path from "node:path";
import os from "node:os";
import {defaultSessionId,recordPath} from "../src/main/agent/session-storage.ts";
import {switchAgentSurface,closeApplication,observeApplicationShutdown} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../..");

test("双向界面切换失败保留各自草稿，原终端与原线程可继续并关闭重开",async({},info)=>{
 test.skip(process.platform==="win32","此协议夹具使用Unix启动脚本，Windows另行验收");
 test.setTimeout(120000);
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-surface-recovery-"));
 const profile=path.join(folder,"profile"),binary=path.join(folder,"codex"),mode=path.join(folder,"mode"),log=path.join(folder,"protocol.jsonl");
 const thread="surface-"+randomUUID(),guiDraft="GUI保留的修改意见",tuiDraft="TUI尚未发送的创作请求";
 await mkdir(path.dirname(recordPath(profile)),{recursive:true});
 await writeFile(recordPath(profile),JSON.stringify({schema_version:1,client:"codex",session_id:defaultSessionId(),cwd:path.join(profile,"agent-sessions/sandbox/library"),surface:"gui",title:"切换恢复验收",thread_id:thread,messages:[],draft:guiDraft,gui_draft:guiDraft,tui_draft:tuiDraft}));
 await writeFile(mode,"fail-terminal");
 await writeFile(binary,`#!/bin/sh\nexec "${process.execPath}" "${binary}.mjs" "$@"\n`);await chmod(binary,0o755);
 await writeFile(binary+".mjs",`
 import http from "node:http";import {readFileSync,appendFileSync} from "node:fs";import WebSocket from ${JSON.stringify(createRequire(import.meta.url).resolve("ws"))};
 const thread=${JSON.stringify(thread)},mode=${JSON.stringify(mode)},log=${JSON.stringify(log)};
 if(process.argv[2]==="resume"){
  const endpoint=process.argv[process.argv.indexOf("--remote")+1],key=process.argv[process.argv.indexOf("--remote-auth-token-env")+1];
  const peer=new WebSocket(endpoint.startsWith("unix://")?"ws+unix://"+endpoint.slice(7)+":/":endpoint,{...(process.env[key]?{headers:{Authorization:"Bearer "+process.env[key]}}:{})});
  peer.on("open",()=>peer.send(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"fixture-terminal",version:"1"}}})));
  peer.on("message",raw=>{const value=JSON.parse(raw.toString());if(value.id===1)peer.send(JSON.stringify({id:2,method:"thread/resume",params:{threadId:thread}}));else if(value.id===2){if(value.error)process.exit(1);process.stdout.write("\\u001b]7501;state=idle:app=codex\\u0007恢复原线程");}});
  peer.on("error",()=>process.exit(1));peer.on("close",()=>process.exit(0));process.stdin.resume();
 }else{
  appendFileSync(log,JSON.stringify({event:"engine-start"})+"\\n");
  const server=http.createServer(),wss=new WebSocket.WebSocketServer({server});server.listen(process.argv[process.argv.indexOf("--listen")+1].slice(7));
  wss.on("connection",peer=>{let client="";peer.on("message",raw=>{const value=JSON.parse(raw.toString());if(value.id===undefined)return;if(value.method==="initialize")client=value.params?.clientInfo?.name??"";
   appendFileSync(log,JSON.stringify({method:value.method,client})+"\\n");
   const current=readFileSync(mode,"utf8"),failed=value.method==="thread/resume"&&(current==="fail-terminal"&&client==="fixture-terminal"||current==="fail-gui"&&client!=="fixture-terminal");
   if(current==="drop-observer"&&value.method==="thread/read"){peer.close();return;}
   peer.send(JSON.stringify({id:value.id,...(failed?{error:{code:-32000,message:client==="fixture-terminal"?"隔离终端恢复失败":"隔离聊天恢复失败"}}:{result:value.method==="account/read"?{account:null,requiresOpenaiAuth:false}:value.method==="config/read"?{config:{}}:value.method.startsWith("thread/")?{thread:{id:thread,turns:[]}}:{}})}));
  });});
 }
 `);
 const executable=process.env.HETU_PACKAGED_APP,env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:path.join(folder,"collaboration"),HETU_CODEX_BIN:binary};
 for(const key of ["ELECTRON_RUN_AS_NODE","HETU_APP_SERVER","HETU_CLI","HETU_MCP","HETU_PLUGIN_NODE"])delete (env as Record<string,string|undefined>)[key];
 if(!executable)Object.assign(env,{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp"),HETU_PLUGIN_NODE:process.execPath});
 let opening=0;
 const launch=async()=>{const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env});await observeApplicationShutdown(app,info.outputPath("shutdown-"+(++opening)+".jsonl"));return app;};
 let app=await launch();
 const enter=async()=>{
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
  await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled({timeout:30000});
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
  await expect(page.locator(".agent-chat")).toBeVisible();
  await expect.poll(()=>page.evaluate(async()=>(await window.hetuDesktop.agentSession("get",{scope:"library"})).state)).toBe("ready");
  return page;
 };
 try{
  let page=await enter();
  const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
  const initial=await get();
  await expect(page.getByRole("textbox",{name:"发送给 Agent",exact:true})).toHaveValue(guiDraft);
  await switchAgentSurface(page,"tui");
  await expect(page.getByRole("alert")).toContainText("隔离终端恢复失败",{timeout:10000});
  const failedTui=await get();
  expect(failedTui.surface).toBe("gui");expect(failedTui.draft).toBe(guiDraft);expect(failedTui.tui_draft).toBe(tuiDraft);
  expect(failedTui.thread_id).toBe(thread);expect(failedTui.terminal_connected).toBe(false);expect(failedTui.messages).toHaveLength(0);
  await expect(page.getByRole("textbox",{name:"发送给 Agent",exact:true})).toHaveValue(guiDraft);
  await page.screenshot({path:info.outputPath("gui-after-terminal-failure.png")});
  await writeFile(mode,"");
  await page.evaluate(()=>window.hetuDesktop.agentSession("recover",{scope:"library"}));
  await switchAgentSurface(page,"tui");
  await expect.poll(async()=>{const value=await get();return value.terminal_connected&&value.terminal_replay?.includes("]7501;state=idle");}).toBe(true);
  const terminal=await get();
  await writeFile(mode,"fail-gui");
  await switchAgentSurface(page,"gui");
  await expect(page.getByRole("alert")).toContainText("隔离聊天恢复失败");
  const failedGui=await get();
  expect(failedGui.surface).toBe("tui");expect(failedGui.draft).toBe(tuiDraft);expect(failedGui.gui_draft).toBe(guiDraft);
  expect(failedGui.terminal_connected).toBe(true);expect(failedGui.thread_id).toBe(thread);expect(failedGui.messages).toHaveLength(0);
  expect(failedGui.terminal_sequence).toBe(terminal.terminal_sequence);
  const oldInput=await page.evaluate(async generation=>{try{await window.hetuDesktop.agentSession("draft",{scope:"library",text:"迟到输入",generation,surface:"gui"});return "accepted";}catch(error){return (error as Error).message;}},initial.generation);
  expect(oldInput).toContain("终端已重新连接，请重新准备输入");expect((await get()).draft).toBe(tuiDraft);
  await page.screenshot({path:info.outputPath("terminal-after-gui-failure.png")});
  await writeFile(mode,"");
  await page.evaluate(()=>window.hetuDesktop.agentSession("recover",{scope:"library"}));
  await switchAgentSurface(page,"gui");
  await expect(page.getByRole("textbox",{name:"发送给 Agent",exact:true})).toHaveValue(guiDraft);
  await writeFile(mode,"drop-observer");
  const disconnect=await page.evaluate(async()=>{try{await window.hetuDesktop.agentSession("recover",{scope:"library"});return "connected";}catch(error){return (error as Error).message;}});expect(disconnect).toContain("连接中断");
  await expect.poll(async()=>(await get()).state).toBe("disconnected");
  const composer=page.getByRole("textbox",{name:"发送给 Agent",exact:true}),send=page.getByRole("button",{name:"发送",exact:true});await expect(composer).toBeEnabled();await expect(send).toBeDisabled();
  await composer.press("Enter");expect((await get()).messages).toHaveLength(0);expect((await get()).draft).toBe(guiDraft);
  const sendError=await page.evaluate(async()=>{try{await window.hetuDesktop.agentSession("send",{scope:"library",text:"不应隐式恢复并发送",attempt_id:"offline-probe"});return "sent";}catch(error){return (error as Error).message;}});expect(sendError).toContain("请先重新连接或核对原线程");
  expect((await get()).state).toBe("disconnected");expect((await get()).messages).toHaveLength(0);
  await page.screenshot({path:info.outputPath("disconnected-send-blocked.png")});
  await writeFile(mode,"");await page.getByRole("button",{name:"重新连接",exact:true}).click();await expect.poll(async()=>(await get()).state).toBe("ready");await expect(send).toBeEnabled();await expect(composer).toHaveValue(guiDraft);
  const events=(await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  expect(events.filter(event=>event.event==="engine-start")).toHaveLength(1);
  expect(events.filter(event=>event.method==="turn/start")).toHaveLength(0);
  await closeApplication(app);
  const saved=JSON.parse(await readFile(recordPath(profile),"utf8"));
  expect(saved.gui_draft).toBe(guiDraft);expect(saved.tui_draft).toBe(tuiDraft);expect(saved.thread_id).toBe(thread);
  app=await launch();page=await enter();
  await expect(page.getByRole("textbox",{name:"发送给 Agent",exact:true})).toHaveValue(guiDraft);
  const reopened=await get();expect(reopened.thread_id).toBe(thread);expect(reopened.tui_draft).toBe(tuiDraft);expect(reopened.messages).toHaveLength(0);
  await writeFile(info.outputPath("result.json"),JSON.stringify({packaged:!!executable,gui_to_tui_failure:true,tui_to_gui_failure:true,drafts_preserved:true,thread_preserved:true,disconnected_send_blocked:true,explicit_reconnect_restored_send:true,engine_restarts_during_switch:0,model_turns:0,reopened:true},null,2));
 }finally{await closeApplication(app);}
});
