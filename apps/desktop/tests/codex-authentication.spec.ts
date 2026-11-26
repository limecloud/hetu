import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,writeFile,readFile,rename,chmod,mkdir} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import {closeApplication,observeApplicationShutdown} from "./navigation.ts";
import {recordPath} from "../src/main/agent/session-storage.ts";
import {machineBinary} from "./acceptance-paths.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("登录前保留草稿，原生登录接续原会话，账号或渠道变化拒绝投递",async({},info)=>{
 test.skip(process.platform==="win32","当前隔离引擎夹具使用Unix启动脚本");test.setTimeout(150000);
 const directory=await mkdtemp(path.join(os.tmpdir(),"hetu-identity-")),profile=path.join(directory,"profile"),binary=path.join(directory,"codex"),stateFile=path.join(directory,"identity.json");
 const setIdentity=async(value:unknown)=>{await writeFile(stateFile+".next",JSON.stringify(value));await rename(stateFile+".next",stateFile);};
 await mkdir(profile);const configuration={config:{model_provider:"openai",model_providers:{openai:{base_url:"https://api.openai.com/v1",requires_openai_auth:true,wire_api:"responses",experimental_bearer_token:"private-key-not-for-projection"}}}};
 const identity={account:{account:{type:"chatgpt",email:"qa@test.invalid",planType:"plus",workspaceName:"QA"},userId:"qa-first",requiresOpenaiAuth:true},configuration,login_completed:true};
 await setIdentity({account:{account:null,requiresOpenaiAuth:true},configuration});
 const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 await writeFile(binary,"#!/bin/sh\nexec "+[process.execPath,createRequire(import.meta.url).resolve("./fixtures/identity-engine.mjs"),directory].map(quote).join(" ")+" \"$@\"\n");await chmod(binary,0o755);
 const executable=process.env.HETU_PACKAGED_APP;
 const args=executable?[]:[path.join(root,"apps/desktop")];
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:path.join(directory,"collaboration"),HETU_LOCAL_SETTINGS_DIR:path.join(profile,"LocalSettings"),HETU_PLUGIN_STATE_DIR:profile,HETU_CODEX_BIN:binary,HETU_APP_SERVER:machineBinary("hetu-app-server"),HETU_CLI:machineBinary("hetu"),HETU_MCP:machineBinary("hetu-mcp"),HETU_PLUGIN_NODE:process.execPath};delete env.ELECTRON_RUN_AS_NODE;
 let app=await electron.launch({...(executable?{executablePath:executable}:{}),args,env});
 let opening=0;
 const observeLogin=async()=>{
  await observeApplicationShutdown(app,info.outputPath("shutdown-"+(++opening)+".jsonl"));
  const page=await app.firstWindow();await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();
  await app.evaluate(({shell,ipcMain})=>{
   const state=globalThis as any;state.openedLogins=[];state.reconnectAttempts=[];
   shell.openExternal=async url=>{state.openedLogins.push(url);};
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:agent-session");
   if(typeof original!=="function")throw Error("会话入口尚未初始化。");
   handlers.set("desktop:agent-session",async(event:any,method:string,input:any)=>{
    if(method!=="start")return original(event,method,input);
    const attempt:{settled:boolean;outcome?:string}={settled:false};state.reconnectAttempts.push(attempt);
    try{
     if(state.holdNextReconnect){state.holdNextReconnect=false;await new Promise<void>(resolve=>{state.releaseReconnect=resolve;});}
     const value=await original(event,method,input);attempt.outcome="returned";return value;
    }catch(error){attempt.outcome="rejected";throw error;}finally{attempt.settled=true;}
   });
  });
 };
 let report:Record<string,unknown>={packaged:!!executable};
 try{
  await observeLogin();
  let page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"创建会话",exact:true});await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();await dialog.getByRole("button",{name:"打开聊天",exact:true}).click();
  const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
  await expect.poll(async()=>(await get()).authentication?.state).toBe("required");
  const before=await get();expect(before.thread_id).toBeUndefined();
  // 首次启动失败仍可关闭创建面板，保留已建立的原会话。
  if(await dialog.isVisible())await dialog.getByRole("button",{name:"关闭创建会话",exact:true}).click();
  await expect(page.getByText(before.error!,{exact:true})).toHaveCount(1);await expect(page.getByRole("status").filter({hasText:"需要登录"})).toBeVisible();
  await expect(page.getByRole("button",{name:"发送",exact:true})).toBeDisabled();
  const input=page.getByRole("textbox",{name:"发送给 Agent",exact:true});await input.fill("登录前的未发送草稿🌿");await input.blur();await expect.poll(async()=>(await get()).draft).toBe("登录前的未发送草稿🌿");
  await page.screenshot({path:info.outputPath("login-required.png")});
  await closeApplication(app,"window");app=await electron.launch({...(executable?{executablePath:executable}:{}),args,env});await observeLogin();page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();await expect.poll(async()=>(await get()).authentication?.state).toBe("required");
  expect((await get()).session_id).toBe(before.session_id);expect((await get()).thread_id).toBeUndefined();await expect(page.getByRole("dialog",{name:"创建会话",exact:true})).toHaveCount(0);await expect(page.getByRole("textbox",{name:"发送给 Agent",exact:true})).toHaveValue("登录前的未发送草稿🌿");
  await page.getByRole("button",{name:"登录 Codex",exact:true}).click();await expect.poll(async()=>(await get()).authentication?.state).toBe("signing_in");
  expect(await app.evaluate(()=>(globalThis as any).openedLogins.length)).toBe(1);
  await page.getByRole("button",{name:"打开登录页面",exact:true}).click();expect(await app.evaluate(()=>(globalThis as any).openedLogins.length)).toBe(2);
  await setIdentity(identity);await expect.poll(async()=>(await get()).state).toBe("ready");const connected=await get();
  expect(connected.session_id).toBe(before.session_id);expect(connected.thread_id).toBe("identity-original-thread");await expect(page.getByRole("textbox",{name:"发送给 Agent",exact:true})).toHaveValue("登录前的未发送草稿🌿");
  const count=async(method:string)=>(await readFile(path.join(directory,"protocol.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line)).filter(row=>row.method===method).length;
  const threadCount=await count("thread/start");expect(threadCount).toBe(1);
  const reconnect=async(authentication:"changed"|"ready"|"unavailable")=>{
   const attempts=await app.evaluate(()=>(globalThis as any).reconnectAttempts.length);
   await page.getByRole("button",{name:"重新连接",exact:true}).click();
   // 鼠标抬起不代表异步重连完成；同一个changed状态也不能证明本次回包。
   await expect.poll(()=>app.evaluate(()=>(globalThis as any).reconnectAttempts.filter((attempt:any)=>attempt.settled).length)).toBe(attempts+1);
   await expect.poll(async()=>(await get()).authentication?.state).toBe(authentication);
   if(authentication!=="ready")await expect(page.getByRole("button",{name:"重新连接",exact:true})).toBeEnabled();
  };
  await setIdentity({...identity,account:{...identity.account,userId:"qa-other"}});await expect.poll(async()=>(await get()).authentication?.state).toBe("changed");await expect(page.getByRole("button",{name:"发送",exact:true})).toBeDisabled();
  await page.screenshot({path:info.outputPath("identity-changed.png")});
  expect((await get()).generation).toBeGreaterThan(connected.generation!);expect((await get()).thread_id).toBe(connected.thread_id);
  await app.evaluate(()=>(globalThis as any).holdNextReconnect=true);
  const firstRetry=reconnect("changed");void firstRetry.catch(()=>{});
  try{
   await expect.poll(()=>app.evaluate(()=>typeof (globalThis as any).releaseReconnect)).toBe("function");
   await expect(page.getByRole("button",{name:"重新连接",exact:true})).toBeDisabled();
   expect(JSON.parse(await readFile(stateFile,"utf8")).account.userId).toBe("qa-other");
  }finally{await app.evaluate(()=>(globalThis as any).releaseReconnect?.());}
  await firstRetry;expect(await count("thread/start")).toBe(threadCount);expect(await count("turn/start")).toBe(0);
  await setIdentity(identity);await reconnect("ready");await expect.poll(async()=>(await get()).state).toBe("ready");
  await setIdentity({...identity,configuration:{config:{...configuration.config,model_provider:"different"}}});await expect.poll(async()=>(await get()).authentication?.state).toBe("changed");
  await setIdentity({...identity,read_failure:true});await reconnect("unavailable");expect((await get()).error).not.toContain("private-source");
  await setIdentity(identity);await reconnect("ready");await expect.poll(async()=>(await get()).state).toBe("ready");
  const saved=await readFile(recordPath(profile,undefined,connected.session_id),"utf8");expect(saved).not.toMatch(/qa@test|qa-first|private-key|private-test-login|authUrl|loginId/);expect(JSON.stringify(await get())).not.toContain("engine_identity");
  const reconnectAttempts=await app.evaluate(()=>(globalThis as any).reconnectAttempts);
  await writeFile(info.outputPath("before-reopen.json"),JSON.stringify({authentication: (await get()).authentication,original_thread_preserved:true,private_identity_absent:true,reconnect_attempts:reconnectAttempts},null,2)+"\n");
  await closeApplication(app,"window");app=await electron.launch({...(executable?{executablePath:executable}:{}),args,env});await observeLogin();page=await app.firstWindow();await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();await expect.poll(async()=>(await get()).state).toBe("ready");expect((await get()).thread_id).toBe(connected.thread_id);expect((await get()).draft).toBe("登录前的未发送草稿🌿");
  report={...report,required_login_blocks_thread_creation:true,unauthenticated_session_reopened:true,login_owned_by_engine:true,same_session_after_login:true,original_thread_reopened:true,draft_preserved:true,account_change_blocked:true,provider_change_blocked:true,failed_read_blocked:true,original_identity_recovered:true,no_private_identity_in_snapshot_or_record:true,reconnect_attempts:reconnectAttempts,reconnect_pending_keeps_account_fixed:true,model_requests:await count("turn/start")};
  await writeFile(info.outputPath("result.json"),JSON.stringify(report,null,2)+"\n");await page.screenshot({path:info.outputPath("identity-restored.png")});
 }finally{await closeApplication(app,"window");}
});
