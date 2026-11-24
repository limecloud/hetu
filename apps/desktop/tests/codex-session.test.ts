import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexSession } from "../src/main/agent/codex-session.ts";
import { loadRecord, atomicJson } from "../src/main/agent/session-storage.ts";
import { SessionLease } from "../src/main/agent/session-lease.ts";
import {TerminalStatus} from "../src/main/agent/terminal-status.ts";
import {toolOutput} from "../src/main/agent/tool-output.ts";
import type {AgentSessionEvent} from "../src/agent-session-contract.ts";
import type {WorkRef} from "@hetu/plugin-sdk";
import {createRequire} from "node:module";

test("socket先关闭而启动器稍后退出时，等待真实退出后恢复原线程",async()=>{
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-codex-wrapper-exit-")),binary=path.join(profile,"codex"),counter=path.join(profile,"runs");
 await writeFile(binary,`#!/bin/sh\nexec "${process.execPath}" "${binary}.mjs" "$@"\n`);await chmod(binary,0o755);
 await writeFile(binary+".mjs",`
 import {readFileSync,writeFileSync} from "node:fs";import http from "node:http";import WebSocket from ${JSON.stringify(createRequire(import.meta.url).resolve("ws"))};const {WebSocketServer}=WebSocket;
 const file=${JSON.stringify(counter)};let runs=0;try{runs=Number(readFileSync(file,"utf8"));}catch{}writeFileSync(file,String(++runs));
 const server=http.createServer(),wss=new WebSocketServer({server});server.listen(process.argv[process.argv.indexOf("--listen")+1].slice(7));
 wss.on("connection",socket=>socket.on("message",bytes=>{const m=JSON.parse(bytes);if(m.id===undefined)return;socket.send(JSON.stringify({id:m.id,result:m.method.startsWith("thread/")?{thread:{id:"wrapper-fixed",turns:[]}}:{}}));
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

async function fixture(mode: "normal" | "interrupt-fail" | "drop" | "resume-fail" | "ack-delay" | "accepted-drop" = "normal") {
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
      else if(m.method==="thread/start")reply({thread:{id:"thread-fixed",turns:[]}});
      else if(m.method==="thread/resume")mode==="resume-fail"?send({id:m.id,error:{message:"cannot resume"}}):reply({thread:{id:"thread-fixed",turns}});
      else if(m.method==="thread/read")reply({thread:{id:"thread-fixed",turns}});
      else if(m.method==="turn/start") {
        if(mode==="drop"){process.exit(1);return;}
        const id="turn-"+(turns.length+1);turns.push({id,status:"inProgress",items:[{type:"userMessage",id:"user-"+id,content:m.params.input}]});
        if(mode==="accepted-drop"){send({method:"item/started",params:{threadId:"thread-fixed",turnId:id,item:turns.at(-1).items[0]}});setTimeout(()=>process.exit(1),20);return;}
        if(mode==="ack-delay")setTimeout(()=>reply({turn:{id}}),120);else reply({turn:{id}});send({method:"turn/started",params:{threadId:"thread-fixed",turn:{id}}});
        send({method:"item/started",params:{threadId:"thread-fixed",turnId:id,item:{id:"tool-"+id,type:"mcpToolCall",server:"hetu",tool:"read",arguments:{}}}});
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
test("原线程已受理后响应连接断开，已受理消息不降为未知",async()=>{
 const {value,restore}=await session("accepted-drop");try{
  await value.updateDraft("受理后断线");await value.send("受理后断线","受理后断线",{attempt_id:"accepted-original"});
  assert.equal(value.snapshot().messages[0].delivery,"accepted");assert.equal(value.snapshot().messages[0].turn_id,"turn-1");assert.equal(value.snapshot().draft,"");assert.equal(value.snapshot().state,"disconnected");
 }finally{await value.stop();restore();}
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
   if(m.method==="thread/start")reply({thread:{id:"same-thread",turns}});
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
