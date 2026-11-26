import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createTerminal,closeApplication,observeApplicationShutdown} from "./navigation.ts";
import {recordPath} from "../src/main/agent/session-storage.ts";

const root=path.resolve(import.meta.dirname,"../../..");

test("原生新建和恢复线程推进输入代次，旧页面不能改写新线程草稿",async({},info)=>{
 test.skip(process.env.HETU_LIVE_CODEX!=="1","需显式启用真实Codex原生线程验收");
 test.setTimeout(180000);
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-native-thread-owner-")),executable=process.env.HETU_PACKAGED_APP;
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),HETU_LOCAL_SETTINGS_DIR:path.join(profile,"LocalSettings"),HETU_PLUGIN_STATE_DIR:profile};
 delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env});
 let report:Record<string,unknown>={packaged:!!executable,model_requests:0};
 try{
  await observeApplicationShutdown(app,info.outputPath("shutdown.jsonl"));
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});
  await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();await createTerminal(page);
  const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
  const ready=(offset=0)=>expect.poll(async()=>{const value=await get();return value.state==="ready"&&value.terminal_connected&&value.terminal_replay?.slice(offset).includes("]7501;state=idle");},{timeout:60000}).toBe(true);
  await ready();const before=await get();expect(before.authentication?.state).toBe("ready");report={...report,authentication:before.authentication};
  const clients=()=>app.evaluate(()=>process.getBuiltinModule("node:child_process").execFileSync("ps",["-axo","pid=,ppid=,args="],{encoding:"utf8"}).split("\n").flatMap(line=>{const row=line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);return row&&Number(row[2])===process.pid&&/\bresume\b.*--remote/.test(row[3])?[Number(row[1])]:[]}));
  const originalClients=await clients();expect(originalClients).toHaveLength(1);
  await page.evaluate(value=>window.hetuDesktop.agentSession("draft",value),{scope:"library",session_id:before.session_id,generation:before.generation,surface:"tui",text:"原线程的独立未发送草稿🌿"});
  const input=page.locator(".xterm-helper-textarea"),newOffset=(await get()).terminal_replay?.length??0;await input.focus();await page.keyboard.type("/new",{delay:30});await page.keyboard.press("Enter");
  await expect.poll(async()=>(await get()).thread_id,{timeout:30000}).not.toBe(before.thread_id);await ready(newOffset);const created=await get();
  const stale=await page.evaluate(async value=>{try{await window.hetuDesktop.agentSession("draft",value);return "accepted";}catch(error){return (error as Error).message;}},{scope:"library",session_id:before.session_id,generation:before.generation,surface:"tui",text:"旧线程迟到的草稿，不应进入新线程"});
  report={...report,before:{thread:before.thread_id,generation:before.generation},created:{thread:created.thread_id,generation:created.generation},stale_draft_result:stale,created_draft_after_probe:(await get()).draft};
  await writeFile(info.outputPath("result.json"),JSON.stringify(report,null,2)+"\n");
  expect(stale).toContain("终端已重新连接");expect(created.generation).toBeGreaterThan(before.generation!);expect((await get()).draft).toBe("");
  for(const method of ["terminal_input","terminal_resize"]){
   const result=await page.evaluate(async value=>{try{await window.hetuDesktop.agentSession(value.method,value.input);return "accepted";}catch(error){return (error as Error).message;}},{method,input:{scope:"library",session_id:before.session_id,generation:before.generation,data:"旧线程输入",cols:90,rows:24}});
   expect(result).toContain("终端已重新连接");
  }
  await page.evaluate(value=>window.hetuDesktop.agentSession("draft",value),{scope:"library",session_id:created.session_id,generation:created.generation,surface:"tui",text:"新线程的独立草稿"});
  await input.focus();await page.keyboard.type("/resume "+before.thread_id,{delay:30});await page.keyboard.press("Enter");
  await expect.poll(async()=>(await get()).thread_id,{timeout:30000}).toBe(before.thread_id);await ready();const restored=await get();
  expect(restored.generation).toBeGreaterThan(created.generation!);expect(restored.draft).toBe("原线程的独立未发送草稿🌿");expect(restored.messages).toHaveLength(0);expect(restored.tools??[]).toHaveLength(0);
  const saved=JSON.parse(await readFile(recordPath(profile,undefined,restored.session_id),"utf8"));expect(saved.input_generation).toBe(restored.generation);expect(saved.threads[created.thread_id!].tui_draft).toBe("新线程的独立草稿");
  await expect(page.locator(".codex-terminal")).toHaveAttribute("data-terminal-generation",String(restored.generation));await expect(page.locator(".codex-terminal")).toHaveAttribute("data-terminal-input-ready","true");await input.focus();await page.keyboard.type("resumed-input-remains-available");await expect(page.locator(".xterm-accessibility-tree")).toContainText("resumed-input-remains-available");await page.keyboard.press("Control+u");expect((await get()).messages).toHaveLength(0);expect(await clients()).toEqual(originalClients);
  const clipboard=await app.evaluate(({clipboard})=>clipboard.readText());
  try{
   await app.evaluate(({clipboard})=>clipboard.writeText("恢复后的中文输入🌿\n第二行仍是未发送草稿"));
   await input.focus();await page.keyboard.press(process.platform==="darwin"?"Meta+v":"Control+Shift+v");
   await expect(page.locator(".xterm-accessibility-tree")).toContainText("第二行仍是未发送草稿");
   expect((await get()).messages).toHaveLength(0);await page.keyboard.press("Control+u");
  }finally{await app.evaluate(({clipboard},text)=>clipboard.writeText(text),clipboard);}
  report={...report,restored:{thread:restored.thread_id,generation:restored.generation},old_input_and_resize_rejected:true,drafts_independent:true,generation_persisted:true,original_native_client_preserved:true,resumed_input_verified:true,resumed_chinese_multiline_paste:true};
  await writeFile(info.outputPath("result.json"),JSON.stringify(report,null,2)+"\n");await page.screenshot({path:info.outputPath("native-thread-restored.png")});
 }catch(error){
  const page=app.windows()[0];
  const failed=await page?.evaluate(async()=>{const value=await window.hetuDesktop.agentSession("get",{scope:"library"});return {state:value.state,thread_id:value.thread_id,generation:value.generation,error:value.error,draft:value.draft,terminal_connected:value.terminal_connected,terminal_tail:value.terminal_replay?.slice(-8000)};}).catch(()=>undefined);
  await writeFile(info.outputPath("failure-state.json"),JSON.stringify(failed??{unavailable:true},null,2)+"\n");await page?.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});throw error;
 }finally{await closeApplication(app);}
});
