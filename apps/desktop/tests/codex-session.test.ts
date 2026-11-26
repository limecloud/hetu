import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexSession } from "../src/main/agent/codex-session.ts";
import { loadRecord, atomicJson,recordPath } from "../src/main/agent/session-storage.ts";
import { SessionLease } from "../src/main/agent/session-lease.ts";
import {TerminalStatus} from "../src/main/agent/terminal-status.ts";
import {toolOutput} from "../src/main/agent/tool-output.ts";
import type {AgentSessionEvent} from "../src/agent-session-contract.ts";
import type {WorkRef} from "@hetu/plugin-sdk";
import {createRequire} from "node:module";

test("认证通知等待初始化，原生登录并发合并，核对中的身份变化不投递",async()=>{
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-codex-identity-")),binary=path.join(profile,"codex"),state=path.join(profile,"identity.json");
 const configuration={config:{model_provider:"openai"}},identity={account:{account:{type:"chatgpt",email:"qa@test.invalid"},userId:"first-account",requiresOpenaiAuth:true},configuration,early_account_update:true};
 await atomicJson(state,{...identity,account:{account:null,requiresOpenaiAuth:true},login_delay_ms:80});
 const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 await writeFile(binary,"#!/bin/sh\nexec "+[process.execPath,createRequire(import.meta.url).resolve("./fixtures/identity-engine.mjs"),profile].map(quote).join(" ")+" \"$@\"\n");await chmod(binary,0o755);
 const previous=process.env.HETU_CODEX_BIN;process.env.HETU_CODEX_BIN=binary;
 const events:AgentSessionEvent[]=[];
 const value=new CodexSession({client:"codex",profile,cwd:path.join(profile,"sandbox"),defaultSurface:"gui",timeout:5000,emit:event=>events.push(event)});
 const count=async(method:string)=>(await readFile(path.join(profile,"protocol.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line)).filter(row=>row.method===method).length;
 const until=async(check:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+5000;while(!await check()){assert(Date.now()<deadline,"未到达预期协议边界");await new Promise(resolve=>setTimeout(resolve,10));}};
 try{
  await assert.rejects(value.start(),/登录/);assert.equal(value.snapshot().authentication?.state,"required");assert.equal(await count("thread/start"),0);
  const logins=await Promise.all([value.login(),value.login(),value.login()]);assert.deepEqual(logins,[logins[0],logins[0],logins[0]]);assert.equal(await count("account/login/start"),1);
  await atomicJson(state,{...identity,login_completed:true});await until(()=>value.snapshot().state==="ready");await value.start();assert.equal(value.snapshot().authentication?.state,"ready");
  const first=value.snapshot(),reads=await count("config/read");await atomicJson(state,{...identity,configuration_hold:true});await until(async()=>await count("config/read")>reads);
  const send=assert.rejects(value.send("旧身份不能发送"),/账号或渠道/);
  await atomicJson(state,{...identity,account:{...identity.account,userId:"other-account"},late_completion:true});await send;
  await until(()=>events.some(event=>event.type==="notification"&&event.method==="turn/completed"));assert.equal(value.snapshot().state,"failed");
  assert.equal(value.snapshot().authentication?.state,"changed");assert.equal(value.snapshot().thread_id,first.thread_id);assert(value.snapshot().generation!>first.generation!);assert.equal(await count("turn/start"),0);
  await atomicJson(state,identity);await value.start();assert.equal(value.snapshot().state,"ready");
  await atomicJson(state,{...identity,thread_hold:true});
  const threadReads=await count("thread/read");const recovery=assert.rejects(value.recover(),/账号或渠道/);await until(async()=>await count("thread/read")>threadReads);
  await atomicJson(state,{...identity,account:{...identity.account,userId:"changed-during-thread-read"}});await recovery;
  assert.equal(value.snapshot().authentication?.state,"changed");assert.equal(value.snapshot().state,"failed");assert.equal(value.snapshot().thread_id,first.thread_id);assert.equal(await count("turn/start"),0);
 }finally{await value.stop();if(previous===undefined)delete process.env.HETU_CODEX_BIN;else process.env.HETU_CODEX_BIN=previous;}
});

test("socket先关闭而启动器稍后退出时，等待真实退出后恢复原线程",async()=>{
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-codex-wrapper-exit-")),binary=path.join(profile,"codex"),counter=path.join(profile,"runs");
 await writeFile(binary,`#!/bin/sh\nexec "${process.execPath}" "${binary}.mjs" "$@"\n`);await chmod(binary,0o755);
 await writeFile(binary+".mjs",`
 import {readFileSync,writeFileSync} from "node:fs";import http from "node:http";import WebSocket from ${JSON.stringify(createRequire(import.meta.url).resolve("ws"))};const {WebSocketServer}=WebSocket;
 const file=${JSON.stringify(counter)};let runs=0;try{runs=Number(readFileSync(file,"utf8"));}catch{}writeFileSync(file,String(++runs));
 const server=http.createServer(),wss=new WebSocketServer({server});server.listen(process.argv[process.argv.indexOf("--listen")+1].slice(7));
 wss.on("connection",socket=>socket.on("message",bytes=>{const m=JSON.parse(bytes);if(m.id===undefined)return;socket.send(JSON.stringify({id:m.id,result:m.method==="account/read"?{account:null,requiresOpenaiAuth:false}:m.method==="config/read"?{config:{}}:m.method.startsWith("thread/")?{thread:{id:"wrapper-fixed",turns:[]}}:{}}));
 if(runs===1&&m.method==="thread/name/set")setTimeout(()=>{socket.close();server.close();setTimeout(()=>process.exit(0),300);},20);
 }));`);
 const previous=process.env.HETU_CODEX_BIN;process.env.HETU_CODEX_BIN=binary;
 const session=new CodexSession({client:"codex",profile,cwd:path.join(profile,"sandbox"),defaultSurface:"gui",timeout:5000,emit:()=>{}});
 try{
  const first=await session.start();const deadline=Date.now()+5000;while(session.snapshot().state!=="disconnected"&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(session.snapshot().state,"disconnected");
  const restored=await session.start();assert.equal(restored.thread_id,first.thread_id);assert.equal(restored.state,"ready");assert.deepEqual(restored.messages,[]);assert.equal(await readFile(counter,"utf8"),"2");
 }finally{await session.stop();if(previous===undefined)delete process.env.HETU_CODEX_BIN;else process.env.HETU_CODEX_BIN=previous;}
});

test("工具过程递归去除JSON文本块中的授权材料，保留公开成果引用",()=>{
 const result={management_ref:{token:"private-ref"},work_ref:{object_id:"work"},data:{workspace_management_ref:{grant_id:"private-grant"},document_id:"doc"}};
 const output=toolOutput({content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result});
 assert.doesNotMatch(output,/private-ref|private-grant|management_ref/);
 assert.match(output,/document_id/);assert.match(output,/work_ref/);
 assert.equal(toolOutput("普通灯塔文字"),"普通灯塔文字");
});

test("终端输入就绪只消费完整OSC状态，分块与普通文字不伪装就绪",()=>{
 const state=new TerminalStatus();state.write("state=idle");assert.equal(state.state,undefined);state.write("\u001b]7501;state=idle:app=codex\u001b");assert.equal(state.state,undefined);state.write("\\");assert.equal(state.state,"idle");state.write("\u001b]7501;state=working:app=codex\u0007");assert.equal(state.state,"working");state.write("\u001b]7501;state=clear\u001b\\");assert.equal(state.state,"clear");
});

async function fixture(mode: "normal" | "interrupt-fail" | "drop" | "resume-fail" | "ack-delay" | "accepted-drop" | "tool-failure" = "normal") {
  const profile = await mkdtemp(path.join(os.tmpdir(), "hetu-codex-contract-"));
  const binary = path.join(profile, "codex");
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${binary}.mjs"\n`); await chmod(binary, 0o755);
  await writeFile(binary + ".mjs", `
    import readline from "node:readline";
    const mode=${JSON.stringify(mode)};let turns=[];
    const rl=readline.createInterface({input:process.stdin});
    const send=(value)=>process.stdout.write(JSON.stringify(value)+"\\n");
    rl.on("line", line=>{
      const m=JSON.parse(line);if(m.id===undefined)return;
      const reply=(result)=>send({id:m.id,result});
      if(m.method==="initialize")reply({});
      else if(m.method==="account/read")reply({account:null,requiresOpenaiAuth:false});
      else if(m.method==="config/read")reply({config:{}});
      else if(m.method==="thread/start")reply({thread:{id:"thread-fixed",turns:[]}});
      else if(m.method==="thread/resume")mode==="resume-fail"?send({id:m.id,error:{message:"cannot resume"}}):reply({thread:{id:"thread-fixed",turns}});
      else if(m.method==="thread/read")reply({thread:{id:"thread-fixed",turns}});
      else if(m.method==="turn/start") {
        if(mode==="drop"){process.exit(1);return;}
        const id="turn-"+(turns.length+1);turns.push({id,status:"inProgress",items:[{type:"userMessage",id:"user-"+id,content:m.params.input}]});
        if(mode==="accepted-drop"){send({method:"item/started",params:{threadId:"thread-fixed",turnId:id,item:turns.at(-1).items[0]}});setTimeout(()=>process.exit(1),20);return;}
        if(mode==="ack-delay")setTimeout(()=>reply({turn:{id}}),120);else reply({turn:{id}});send({method:"turn/started",params:{threadId:"thread-fixed",turn:{id}}});
        send({method:"item/started",params:{threadId:"thread-fixed",turnId:id,item:{id:"tool-"+id,type:"mcpToolCall",server:"hetu",tool:"read",arguments:{}}}});
        if(mode==="tool-failure")send({method:"item/completed",params:{threadId:"thread-fixed",turnId:id,item:{id:"tool-"+id,type:"mcpToolCall",server:"hetu",tool:"read",status:"failed",error:{message:"固定来源读取失败"},durationMs:340}}});
        send({method:"item/agentMessage/delta",params:{threadId:"thread-fixed",turnId:id,itemId:"assistant-"+id,delta:"真实投影"}});
        if(mode!=="interrupt-fail")setTimeout(()=>{turns.at(-1).status="completed";send({method:"turn/completed",params:{threadId:"thread-fixed",turn:{id,status:"completed"}}});},80);
      } else if(m.method==="turn/interrupt")send({id:m.id,error:{message:"interrupt rejected"}});
      else reply({});
    });
  `);
  return { profile, binary };
}
async function session(mode?: Parameters<typeof fixture>[0],work?:WorkRef) {
  const { profile, binary } = await fixture(mode);
  const previous = process.env.HETU_CODEX_BIN; process.env.HETU_CODEX_BIN = binary;
  const events:AgentSessionEvent[]=[];
  const value = new CodexSession({ client: "codex", profile,work, cwd: path.join(profile,"sandbox"), transport:"stdio", timeout:5000, emit:event=>events.push(event) });
  return { value, profile,events, restore:()=> { if(previous===undefined) delete process.env.HETU_CODEX_BIN;else process.env.HETU_CODEX_BIN=previous; } };
}
test("完成通知携带真实作品身份，后台会话可按领域范围刷新目录",async()=>{
 const work:WorkRef={workspace_id:"workspace-notification",kind:"novel",object_id:"novel-notification"};
 const {value,events,restore}=await session(undefined,work);try{
  await value.send("固定作品通知");const deadline=Date.now()+5000;while(!events.some(event=>event.type==="notification"&&event.method==="turn/completed")&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  const completed=events.find(event=>event.type==="notification"&&event.method==="turn/completed");assert(completed?.type==="notification");assert.deepEqual(completed.work_ref,work);assert.equal(completed.session_id,value.snapshot().session_id);
 }finally{await value.stop();restore();}
});
test("轮次结束但工具缺完成回执时显示待核对，明确工具错误不伪装成功",async()=>{
 for(const mode of ["normal","tool-failure"] as const){
  const {value,restore}=await session(mode);try{
   await value.send("核对真实工具状态");const deadline=Date.now()+5000;while(value.snapshot().state!=="ready"&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
   const tool=value.snapshot().tools![0];assert.equal(tool.state,mode==="normal"?"unknown":"failed");
   if(mode==="tool-failure"){assert.match(tool.output!,/固定来源读取失败/);assert.equal(tool.duration_ms,340);}
  }finally{await value.stop();restore();}
 }
});
test("发送前保存原尝试，重复attempt不会创建第二轮，旧轮次和工具有稳定身份", async()=>{
 const {value,restore}=await session();try{
  await value.start();await value.send("固定请求","固定请求",{attempt_id:"attempt-one"});
  await assert.doesNotReject(async () => { const deadline=Date.now()+5000;while(value.snapshot().state!=="ready" && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(value.snapshot().state,"ready"); });
  await value.send("固定请求","固定请求",{attempt_id:"attempt-one"});
  const snapshot=value.snapshot();assert.equal(snapshot.messages.filter(m=>m.role==="user").length,1);assert.equal(snapshot.messages[0].delivery,"accepted");assert.equal(snapshot.state,"ready");assert.equal(snapshot.tools?.length,1);
  await assert.rejects(value.send("其他请求","其他请求",{attempt_id:"attempt-one"}),/不同内容/);
 }finally{await value.stop();restore();}
});
test("取消被拒绝不会伪装ready，保留原轮次供核对",async()=>{
 const {value,restore}=await session("interrupt-fail");try{await value.send("保持运行");await assert.rejects(value.interrupt(),/interrupt rejected/);assert.equal(value.snapshot().state,"uncertain");assert.equal(value.snapshot().turn_id,"turn-1");}finally{await value.stop();restore();}
});
test("传输断开保持unknown，不能自动重发或替换原线程",async()=>{
 const {value,restore}=await session("drop");try{await assert.rejects(value.send("不能重复写入"));assert.equal(value.snapshot().messages[0].delivery,"unknown");assert.equal(value.snapshot().thread_id,"thread-fixed");}finally{await value.stop();restore();}
});
test("恢复失败保留原线程，不隐式新建",async()=>{
 const {value,restore}=await session("resume-fail");try{await value.start();await value.stop();await assert.rejects(value.start(),/cannot resume/);assert.equal(value.snapshot().thread_id,"thread-fixed");}finally{await value.stop();restore();}
});
test("损坏记录不静默清空，原子存储保留固定字节",async()=>{
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-session-record-")),file=path.join(profile,"record.json");
 await writeFile(file,"broken");await assert.rejects(loadRecord(file,undefined,"sandbox"),/保留原文件/);assert.equal(await readFile(file,"utf8"),"broken");
 await atomicJson(file,{schema_version:1,cwd:"sandbox",messages:[]});assert.ok(await loadRecord(file,undefined,"sandbox"));
});
test("同会话第二个执行端失败，原owner释放后才能取得",async()=>{
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-session-lease-"));const first=new SessionLease(profile,"same-thread"),second=new SessionLease(profile,"same-thread");
 await first.acquire();await assert.rejects(second.acquire(),/占用/);await first.release();await second.acquire();await second.release();
});
test("不同本机记录不能同时接管相同Codex配置中的同一线程",async()=>{
 const {value,profile,restore}=await session();
 const second=new CodexSession({client:"codex",profile,cwd:path.join(profile,"sandbox"),id:"codex-duplicate-thread-record",transport:"stdio",timeout:5000,emit:()=>{}});
 try {await value.start();await assert.rejects(second.start(),/占用/);await value.stop();await second.start();assert.equal(second.snapshot().thread_id,"thread-fixed");}
 finally{await second.stop();await value.stop();restore();}
});
test("请求草稿不触发模型轮次，控制字符在启动前被拒绝",async()=>{
 const {value,restore}=await session();
 try {
  await assert.rejects(value.insertDraft("不能逃出粘贴\u001b[201~\n"),/控制字符/);assert.equal(value.snapshot().state,"idle");
  await value.insertDraft("固定草稿\n等待作者发送");assert.equal(value.snapshot().state,"ready");assert.equal(value.snapshot().draft,"固定草稿\n等待作者发送");assert.equal(value.snapshot().messages.length,0);
 }finally{await value.stop();restore();}
});
test("草稿落盘期间选择变化时拒绝迟到插入，原草稿留在原会话",async()=>{
 const {value,restore}=await session();let selected=true;
 const save=value.updateDraft.bind(value);
 value.updateDraft=async(text,refs)=>{const result=await save(text,refs);selected=false;return result;};
 try{
  await assert.rejects(value.insertDraft("只属于原会话的草稿",()=>{if(!selected)throw Error("会话已切换");}),/会话已切换/);
  assert.equal(value.snapshot().draft,"只属于原会话的草稿");assert.equal(value.snapshot().messages.length,0);
 }finally{await value.stop();restore();}
});
test("迟到的GUI草稿携带旧代次，不能覆盖切回后的TUI输入",async()=>{
 const {value,restore}=await session();try{
  await value.updateDraft("GUI独立草稿");const generation=value.snapshot().generation;
  await value.switchSurface("tui");
  await assert.rejects(value.updateDraft("迟到内容",undefined,{surface:"gui",generation:(generation??0)-1}),/输入界面已切换/);
  assert.equal(value.snapshot().gui_draft,"GUI独立草稿");
 }finally{await value.stop();restore();}
});
test("切换TUI失败恢复原GUI草稿，两端草稿关闭重开后仍独立",async()=>{
 const {value,profile,restore}=await session();
 try{
  await value.switchSurface("tui");await value.updateDraft("TUI尚未发送的请求");
  await value.switchSurface("gui");await value.updateDraft("GUI尚未发送的意见");
  const original=await value.start();
  await assert.rejects(value.switchSurface("tui"),/不支持共享TUI/);
  const failed=value.snapshot();
  assert.equal(failed.surface,"gui");assert.equal(failed.state,"uncertain");
  assert.equal(failed.thread_id,original.thread_id);
  assert.equal(failed.draft,"GUI尚未发送的意见");
  assert.equal(failed.gui_draft,"GUI尚未发送的意见");
  assert.equal(failed.tui_draft,"TUI尚未发送的请求");
  assert.equal(failed.messages.length,0);
  await assert.rejects(value.updateDraft("迟到的原代次输入",undefined,{surface:"gui",generation:original.generation}),/输入界面已切换/);
  await value.stop();
  const reopened=new CodexSession({client:"codex",profile,cwd:path.join(profile,"sandbox"),transport:"stdio",timeout:5000,emit:()=>{}});
  try{
   const saved=await reopened.load();
   assert.equal(saved.surface,"gui");assert.equal(saved.draft,failed.draft);
   assert.equal(saved.gui_draft,failed.gui_draft);assert.equal(saved.tui_draft,failed.tui_draft);
   assert.equal(saved.thread_id,original.thread_id);
   const resumed=await reopened.start();assert.equal(resumed.thread_id,original.thread_id);
   assert.equal(resumed.draft,"GUI尚未发送的意见");assert.equal(resumed.messages.length,0);
  }finally{await reopened.stop();}
 }finally{await value.stop();restore();}
});
test("相同文本的新草稿有独立修订，旧受理和历史回读均不能清除",async()=>{
 const {value,restore}=await session("ack-delay");try{
  await value.updateDraft("相同文本的新草稿");
  const sending=value.send("相同文本的新草稿");
  const deadline=Date.now()+5000;while(value.snapshot().state!=="running"&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  await value.updateDraft("相同文本的新草稿");const version=value.snapshot().draft_version;
  await sending;assert.equal(value.snapshot().draft,"相同文本的新草稿");assert.equal(value.snapshot().draft_version,version);
  await value.recover();assert.equal(value.snapshot().draft,"相同文本的新草稿");
 }finally{await value.stop();restore();}
});
test("附加上下文原子去重和移除，不覆盖草稿；旧发送版本拒绝且历史保留原引用",async()=>{
 const {value,restore}=await session("ack-delay");
 const first={label:"第一章",reference:{kind:"document",revision_id:"old"}},second={label:"第二章",reference:{kind:"document",revision_id:"new"}};
 try{
  await value.start();await value.updateDraft("读取所附原文");const generation=value.snapshot().generation;
  await assert.rejects(value.updateDraft("无效请求不覆盖旧稿",[{label:"来源",reference:{api_key:"secret"}}]),/不能包含/);assert.equal(value.snapshot().draft,"读取所附原文");
  await value.attachContext(first,{generation});await value.attachContext(first,{generation});assert.equal(value.snapshot().context_refs?.length,1);
  await value.attachContext(second,{generation});await value.removeContext(second.reference,{generation});assert.deepEqual(value.snapshot().context_refs,[first]);assert.equal(value.snapshot().draft,"读取所附原文");
  const version=value.snapshot().draft_version!;await assert.rejects(value.send("旧请求","旧请求",{draft_version:version-1}),/草稿或附加上下文已变化/);
  const pending=value.send("读取所附原文","读取所附原文",{draft_version:version,context_refs:[first]});
  const deadline=Date.now()+5000;while(!value.snapshot().messages.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(value.snapshot().messages[0]?.text,"读取所附原文");
  await value.updateDraft("下一轮请求",[second]);await pending;
  assert.equal(value.snapshot().draft,"下一轮请求");assert.deepEqual(value.snapshot().context_refs,[second]);assert.deepEqual(value.snapshot().messages[0].context_refs,[first]);
  await assert.rejects(value.attachContext(first,{generation:generation!-1}),/输入界面已变化/);
 }finally{await value.stop();restore();}
});
test("原线程已受理后断开保留真实消息，发送不隐式重启或投递新请求",async()=>{
 const {value,restore}=await session("accepted-drop");try{
  await value.updateDraft("受理后断线");await value.send("受理后断线","受理后断线",{attempt_id:"accepted-original"});
  assert.equal(value.snapshot().messages[0].delivery,"accepted");assert.equal(value.snapshot().messages[0].turn_id,"turn-1");assert.equal(value.snapshot().draft,"");assert.equal(value.snapshot().state,"disconnected");
  await value.updateDraft("只核对原操作的下一条草稿");const before=value.snapshot();
  await assert.rejects(value.send("只核对原操作的下一条草稿"),/请先重新连接或核对原线程/);
  const after=value.snapshot();assert.equal(after.state,"disconnected");assert.equal(after.generation,before.generation);assert.equal(after.thread_id,before.thread_id);assert.deepEqual(after.messages,before.messages);assert.equal(after.draft,before.draft);
 }finally{await value.stop();restore();}
});
test("会话输入和待答代次在新实例启动前持久推进，旧记录保持原线程与草稿",async()=>{
 const {value,profile,restore}=await session();let reopened;
 try{
  const first=await value.start();await value.updateDraft("重启前的原草稿");const original=JSON.parse(await readFile(recordPath(profile),"utf8"));assert.equal(original.input_generation,first.generation);assert(Number.isSafeInteger(original.request_generation));
  await value.stop();
  reopened=new CodexSession({client:"codex",profile,cwd:path.join(profile,"sandbox"),transport:"stdio",emit:()=>{}});const next=await reopened.start();
  assert(next.generation>first.generation);assert.equal(next.thread_id,first.thread_id);assert.equal(next.draft,"重启前的原草稿");
  await assert.rejects(reopened.updateDraft("旧代次覆盖",undefined,{surface:"gui",generation:first.generation}),/输入界面已切换/);
  await assert.rejects(reopened.respond(77,{decision:"cancel"},original.request_generation),/答复权/);
  const saved=JSON.parse(await readFile(recordPath(profile),"utf8"));assert.equal(saved.input_generation,next.generation);assert(saved.request_generation>original.request_generation);assert.equal(saved.draft,"重启前的原草稿");
  await value.stop();assert.deepEqual(JSON.parse(await readFile(recordPath(profile),"utf8")),saved,"旧实例重复关闭不覆盖新实例代次");
 }finally{await reopened?.stop();await value.stop();restore();}
});
test("非法输入代次不覆盖原记录，最大安全代次拒绝启动",async()=>{
 for(const input_generation of [-1,1.5,Number.MAX_SAFE_INTEGER]){
  const {value,profile,restore}=await session();const original={schema_version:1,client:"codex",cwd:path.join(profile,"sandbox"),surface:"gui",thread_id:"thread-fixed",messages:[],draft:"原草稿",input_generation,request_generation:input_generation};
  await atomicJson(recordPath(profile),original);
  try{await assert.rejects(value.start(),input_generation===Number.MAX_SAFE_INTEGER?/输入代次已达上限/:/记录与当前范围不一致/);assert.deepEqual(JSON.parse(await readFile(recordPath(profile),"utf8")),original);}finally{restore();}
 }
});
test("原生线程接管期间冻结输入，失败回到原线程也不复活旧代次",{skip:process.platform==="win32",timeout:30000},async()=>{
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-native-owner-")),binary=path.join(profile,"codex"),control=path.join(profile,"control"),stage=path.join(profile,"stage");
 const first=path.basename(profile)+"-first",second=path.basename(profile)+"-second";
 const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 await writeFile(path.join(profile,"threads.json"),JSON.stringify({first,second}));await writeFile(control,"hold");
 await writeFile(binary,"#!/bin/sh\nexec "+[process.execPath,createRequire(import.meta.url).resolve("./fixtures/native-thread-engine.mjs"),profile].map(quote).join(" ")+" \"$@\"\n");await chmod(binary,0o755);
 const previous=process.env.HETU_CODEX_BIN;process.env.HETU_CODEX_BIN=binary;
 const options={client:"codex",profile,cwd:path.join(profile,"sandbox"),defaultSurface:"tui" as const,timeout:5000,emit:()=>{}};
 const value=new CodexSession(options);let reopened:CodexSession|undefined;
 const wait=async(check:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+10000;while(!await check()){assert(Date.now()<deadline,"线程接管没有到达预期边界");await new Promise(resolve=>setTimeout(resolve,10));}};
 const held=async()=>{try{return await readFile(stage,"utf8")==="held";}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}};
 try{
  const original=await value.start();assert.equal(original.thread_id,first);await value.updateDraft("原线程草稿");
  value.terminalInput("native-new\r",original.generation!);await wait(held);
  assert.equal(value.snapshot().state,"switching");assert.equal(value.snapshot().thread_id,first);assert(value.snapshot().generation!>original.generation!);
  await assert.rejects(value.updateDraft("旧输入不应覆盖",undefined,{surface:"tui",generation:original.generation}),/交接/);
  await assert.rejects(value.send("不能在交接期间发模型轮次"),/切换/);await assert.rejects(value.switchSurface("gui"),/切换/);
  assert.throws(()=>value.terminalInput("旧终端输入",original.generation!),/旧终端/);assert.throws(()=>value.terminalResize(90,24,original.generation!),/执行权/);
  await writeFile(control,"release");await wait(()=>value.snapshot().thread_id===second&&value.snapshot().state==="ready");
  const created=value.snapshot();assert.equal(created.draft,"");assert(created.generation!>original.generation!);
  assert.equal(JSON.parse(await readFile(recordPath(profile),"utf8")).input_generation,created.generation);
  await value.updateDraft("新线程草稿");value.terminalInput("native-old\r",created.generation!);await wait(()=>value.snapshot().thread_id===first&&value.snapshot().state==="ready");
  const restored=value.snapshot();assert.equal(restored.draft,"原线程草稿");assert(restored.generation!>created.generation!);
  await writeFile(control,"hold");await writeFile(stage,"");const outputBeforeReject=value.snapshot().terminal_sequence??0;value.terminalInput("native-second\r",restored.generation!);await wait(held);
  // 原生客户端收到拒绝回执时，宿主的接管清理才已结束。
  assert.equal(value.snapshot().state,"switching");await writeFile(control,"reject");await wait(()=>value.snapshot().state==="uncertain"&&(value.snapshot().terminal_sequence??0)>outputBeforeReject);
  const failed=value.snapshot();assert.equal(failed.thread_id,first);assert.equal(failed.draft,"原线程草稿");assert(failed.generation!>restored.generation!);
  await assert.rejects(value.updateDraft("失败前旧代次不能复活",undefined,{surface:"tui",generation:restored.generation}),/输入界面已切换/);
  const saved=JSON.parse(await readFile(recordPath(profile),"utf8"));assert.equal(saved.thread_id,first);assert.equal(saved.input_generation,failed.generation);assert.equal(saved.threads[second].tui_draft,"新线程草稿");
  const requests=(await readFile(path.join(profile,"protocol.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));assert.equal(requests.filter(item=>item.method==="turn/start").length,0);
  await value.stop();reopened=new CodexSession(options);const next=await reopened.start();assert.equal(next.thread_id,first);assert.equal(next.draft,"原线程草稿");assert(next.generation!>failed.generation!);
 }finally{
  await writeFile(control,"release");await reopened?.stop();await value.stop();if(previous===undefined)delete process.env.HETU_CODEX_BIN;else process.env.HETU_CODEX_BIN=previous;
 }
});
test("引擎关闭时切换GUI可阅读原对话和独立草稿，不启动进程",async()=>{
 const {value,profile,restore}=await session();try{
  const {recordPath,defaultSessionId}=await import("../src/main/agent/session-storage.ts");
  await atomicJson(recordPath(profile),{schema_version:1,session_id:defaultSessionId(),cwd:path.join(profile,"sandbox"),surface:"tui",messages:[{role:"assistant",text:"已经保存的对话",at:"2026-11-23"}],gui_draft:"待发送GUI稿",tui_draft:"待发送TUI请求",draft:"待发送TUI请求"});
  const snapshot=await value.switchSurface("gui");assert.equal(snapshot.state,"idle");assert.equal(snapshot.surface,"gui");assert.equal(snapshot.thread_id,undefined);assert.equal(snapshot.draft,"待发送GUI稿");assert.equal(snapshot.messages[0].text,"已经保存的对话");
 }finally{await value.stop();restore();}
});

test("会话切换保留各自草稿和范围，读取后台会话不改变当前选择", async()=>{
 const { AgentSessions }=await import("../src/main/agent/session-manager.ts");
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-session-directory-"));
 const sessions=new AgentSessions({profile,emit:()=>{}});
 const first=await sessions.get(undefined,"tui");await first.updateDraft("第一份草稿");
 const second=await sessions.create(undefined,"tui");await second.updateDraft("第二份草稿");
 await sessions.get(undefined,"tui",first.snapshot().session_id);
 assert.equal((await sessions.get()).snapshot().session_id,second.snapshot().session_id);
 const chosen=await sessions.get(undefined,"tui",first.snapshot().session_id,true);
 assert.equal(chosen.snapshot().draft,"第一份草稿");assert.equal((await sessions.list()).length,2);
 const reopened=new AgentSessions({profile,emit:()=>{}});assert.equal((await reopened.get()).snapshot().session_id,first.snapshot().session_id);assert.equal((await reopened.get()).snapshot().draft,"第一份草稿");
 const next=await reopened.remove(undefined,first.snapshot().session_id!,"tui");assert.notEqual(next.snapshot().session_id,first.snapshot().session_id);assert.equal((await reopened.list()).length,2);
 await assert.rejects(sessions.get({workspace_id:"other",kind:"novel",object_id:"other"},"tui",first.snapshot().session_id),/不属于/);
 await sessions.stopAll();
});

test("观察连接断开后重连同一引擎，原投递沿线程核对而不重复发送", async()=>{
 const {createRequire}=await import("node:module");
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-codex-socket-recovery-")),binary=path.join(profile,"codex"),marker=path.join(profile,"spawns");
 await writeFile(binary,`#!/bin/sh\nexec "${process.execPath}" "${binary}.mjs" "$@"\n`);await chmod(binary,0o755);
 await writeFile(binary+".mjs",`
  import http from "node:http";import {appendFileSync} from "node:fs";
  import WebSocket from ${JSON.stringify(createRequire(import.meta.url).resolve("ws"))};const {WebSocketServer}=WebSocket;
  appendFileSync(${JSON.stringify(marker)},"spawn\\n");let turns=[];
  const server=http.createServer(),ws=new WebSocketServer({server});
  server.listen(process.argv[process.argv.indexOf("--listen")+1].slice(7));
  ws.on("connection",socket=>socket.on("message",raw=>{const m=JSON.parse(raw);if(m.id===undefined)return;
   const reply=(result)=>socket.send(JSON.stringify({id:m.id,result}));
   if(m.method==="account/read")reply({account:null,requiresOpenaiAuth:false});
   else if(m.method==="config/read")reply({config:{}});
   else if(m.method==="thread/start")reply({thread:{id:"same-thread",turns}});
   else if(m.method==="thread/resume"||m.method==="thread/read")reply({thread:{id:"same-thread",turns}});
   else if(m.method==="turn/start"){turns=[{id:"same-turn",status:"completed",items:[{id:"same-user",type:"userMessage",content:m.params.input}]}];socket.close();}
   else reply({});
  }));
 `);
 const previous=process.env.HETU_CODEX_BIN;process.env.HETU_CODEX_BIN=binary;
 const session=new CodexSession({client:"codex",profile,cwd:path.join(profile,"sandbox"),defaultSurface:"gui",emit:()=>{}});
 try{
  await session.start();
  await assert.rejects(session.send("原请求必须唯一","原请求必须唯一",{attempt_id:"original-attempt"}));
  assert.equal(session.snapshot().messages[0].delivery,"unknown");
  const restored=await session.recover();assert.equal(restored.state,"ready");assert.equal(restored.thread_id,"same-thread");assert.equal(restored.messages.length,1);assert.equal(restored.messages[0].delivery,"accepted");assert.equal(restored.messages[0].turn_id,"same-turn");assert.equal((await readFile(marker,"utf8")).trim(),"spawn");
 }finally{await session.stop();if(previous===undefined)delete process.env.HETU_CODEX_BIN;else process.env.HETU_CODEX_BIN=previous;}
});
