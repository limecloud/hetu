import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,writeFile,symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {SessionMachine} from "../src/main/agent/agent-machine-service.ts";
import {ProcessSession} from "../src/main/agent/process-session.ts";
import {ExternalExecutionJournal} from "../src/main/external-execution.ts";
import {acp} from "./fixtures/external-protocol-fixture.ts";
import {TerminalWriteQueue} from "../src/renderer/external-terminal-write-queue.ts";
import {readSessionToolReceipts} from "../src/main/agent/session-tool-receipts.ts";
import {recordPath} from "../src/main/agent/session-storage.ts";
import {externalSessionDirectory} from "../src/main/agent/terminal-workspace-state.ts";

test("原会话中继回执必须完整、有界且来自普通文件，不沿符号链接读取",async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-receipts-")),file=path.join(folder,"receipts.json"),receipt={id:"original",turn_id:"",kind:"mcp",title:"hetu_call_action",server:"hetu",state:"completed",output:JSON.stringify({structuredContent:{action:"hetu.documents.create",status:"succeeded",data:{}}})};
 assert.deepEqual(await readSessionToolReceipts(folder),[]);await writeFile(file,JSON.stringify([receipt]));assert.deepEqual(await readSessionToolReceipts(folder),[receipt]);
 for(const invalid of [[{...receipt,server:"other"}],[{...receipt,output:{}}],Array(65).fill(receipt),[{...receipt,output:"x".repeat(128001)}]]){await writeFile(file,JSON.stringify(invalid));await assert.rejects(readSessionToolReceipts(folder),/回执/);}
 await writeFile(file,"{" );await assert.rejects(readSessionToolReceipts(folder));
 const linked=path.join(folder,"linked");await mkdir(linked);await symlink(file,path.join(linked,"receipts.json"));await assert.rejects(readSessionToolReceipts(linked),/回执/);
});

test("会话读取保留工具来源，完整回执按条省略；原Bot范围和代次仍核对",async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-receipt-projection-")),profile=path.join(folder,"profile");
 const context={bot_ref:{bot_id:"bot_00000000-0000-4000-8000-000000000001",revision:1,sha256:"a".repeat(64)},name:"固定助手",purpose:"只验证有界投影，不发送模型。"};
 let machine=new SessionMachine({profile,bin:path.join(root,"target/debug"),directory:folder,client:"generic"});
 const created=await machine.request({method:"create",launch:{client:"shell",surface:"tui",bot_context:context},operation_key:"create"});await machine.close();
 // 隔离投影夹具；真实MCP回执及Core保存由公开入口与GUI旅程另验。
 const record=recordPath(profile,undefined,created.session_id),saved=JSON.parse(await readFile(record,"utf8"));
 const tool={id:"protocol",turn_id:"turn",kind:"mcp",title:"原工具",server:"hetu",name:"hetu_call_action",state:"completed",output:"{}"};saved.tools=[tool];await writeFile(record,JSON.stringify(saved));
 const sandbox=path.join(profile,"agent-sessions/sandbox/library",created.session_id);await mkdir(sandbox,{recursive:true});await writeFile(path.join(sandbox,"receipts.json"),JSON.stringify([{...tool,id:"receipt"}]));
 machine=new SessionMachine({profile,bin:path.join(root,"target/debug"),directory:folder,client:"generic"});
 try{
  const read={method:"read",session_id:created.session_id,work_ref:null,expected_bot_context:context,format:"conversation"},first=await machine.request(read);
  assert.equal(first.conversation.tools[0].server,"hetu");assert.equal(first.conversation.tools[0].name,"hetu_call_action");assert.equal(first.conversation.receipts_complete,true);
  const receipts=Array.from({length:4},(_,index)=>({...tool,id:"receipt-"+index,output:JSON.stringify({structuredContent:{action:"hetu.documents.create",status:"succeeded",data:{text:"x".repeat(30000)}}})}));
  await writeFile(path.join(sandbox,"receipts.json"),JSON.stringify(receipts));const bounded=await machine.request(read);
  assert(Buffer.byteLength(JSON.stringify(bounded))<64000);assert.equal(bounded.conversation.total_receipts,4);assert.equal(bounded.conversation.receipts_complete,false);assert(bounded.conversation.receipts.length>0);for(const receipt of bounded.conversation.receipts)assert.equal(JSON.parse(receipt.output).structuredContent.data.text.length,30000);
  await assert.rejects(machine.request({...read,expected_bot_context:{...context,purpose:"另一角色"}}),/原Bot/);await assert.rejects(machine.request({...read,work_ref:{workspace_id:"other",kind:"novel",object_id:"other"}}),/此作品/);await assert.rejects(machine.request({...read,generation:first.generation+1}),/代次/);
 }finally{await machine.close();}
});

const root=path.resolve(import.meta.dirname,"../../..");
const until=async(check:()=>Promise<boolean>)=>{const deadline=Date.now()+5000;while(!await check()){assert(Date.now()<deadline,"真实执行端未在期限内返回");await new Promise(resolve=>setTimeout(resolve,20));}};

test("终端输入仅合并未派发字节，尺寸保持顺序，关闭等待原回执",async()=>{
  const first=Promise.withResolvers<void>(),started=Promise.withResolvers<void>(),calls:any[]=[];
  const queue=new TerminalWriteQueue(async input=>{calls.push(structuredClone(input));if(calls.length===1){started.resolve();await first.promise;}return {state:"succeeded"};},error=>{throw error;});
  const target={session_id:"original",generation:1},initial=queue.enqueue({method:"session_input",...target,data:"先"});await started.promise;
  const pending=[queue.enqueue({method:"session_input",...target,data:"中文"}),queue.enqueue({method:"session_input",...target,data:"🍃\r"}),queue.enqueue({method:"session_resize",...target,cols:80,rows:24}),queue.enqueue({method:"session_resize",...target,cols:100,rows:30}),queue.enqueue({method:"session_input",...target,data:"后"})];
  let flushed=false;const flush=queue.flush().then(()=>{flushed=true;});await Promise.resolve();assert.equal(flushed,false);assert.equal(calls[0].data,"先");first.resolve();await Promise.all([initial,...pending,flush]);
  assert.deepEqual(calls.map(({operation_key,...input})=>input),[{method:"session_input",...target,data:"先"},{method:"session_input",...target,data:"中文🍃\r"},{method:"session_resize",...target,cols:100,rows:30},{method:"session_input",...target,data:"后"}]);assert.equal(new Set(calls.map(input=>input.operation_key)).size,4);assert.equal(flushed,true);
});

test("终端未知回执冻结后续输入，不换键重发",async()=>{
  const first=Promise.withResolvers<void>(),started=Promise.withResolvers<void>(),calls:any[]=[],errors:Error[]=[];
  const queue=new TerminalWriteQueue(async input=>{calls.push(input);started.resolve();await first.promise;return {state:"unknown"};},error=>errors.push(error));
  const target={session_id:"original",generation:1},initial=queue.enqueue({method:"session_input",...target,data:"原输入"});await started.promise;
  const next=queue.enqueue({method:"session_input",...target,data:"后续输入"}),settled=Promise.allSettled([initial,next]);first.resolve();assert((await settled).every(result=>result.status==="rejected"));
  await assert.rejects(queue.flush(),/待核对/);await assert.rejects(queue.enqueue({method:"session_input",...target,data:"再输入"}),/待核对/);assert.equal(calls.length,1);assert.equal(errors.length,1);
});

test("终端输入不跨代次合并，超预算不进入派发队列",async()=>{
  const first=Promise.withResolvers<void>(),started=Promise.withResolvers<void>(),calls:any[]=[],errors:Error[]=[];
  const queue=new TerminalWriteQueue(async input=>{calls.push(input);if(calls.length===1){started.resolve();await first.promise;}return {state:"succeeded"};},error=>errors.push(error));
  const target={session_id:"original"},initial=queue.enqueue({method:"session_input",...target,generation:1,data:"一"});await started.promise;
  const second=queue.enqueue({method:"session_input",...target,generation:2,data:"二"}),third=queue.enqueue({method:"session_input",...target,generation:3,data:"三"});
  await assert.rejects(queue.enqueue({method:"session_input",...target,generation:3,data:"超".repeat(30000)}),/预算/);first.resolve();await Promise.all([initial,second,third]);await queue.flush();assert.deepEqual(calls.map(input=>input.generation),[1,2,3]);assert.deepEqual(calls.map(input=>input.data),["一","二","三"]);assert.equal(errors.length,1);
});

test("GUI投影保留原消息，长草稿按原版本分页并在重开后回读",{skip:process.platform==="win32",timeout:20000},async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-bot-draft-")),binary=path.join(folder,"opencode"),profile=path.join(folder,"profile"),log=path.join(folder,"wire.jsonl");
  await writeFile(log,"");await writeFile(binary,acp.replace("NODE",process.execPath).replace("FIXTURE_VERSION","2.0.14"),{mode:0o700});
  const previousBinary=process.env.HETU_OPENCODE_BIN,previousLog=process.env.TEST_PROTOCOL_LOG;process.env.HETU_OPENCODE_BIN=binary;process.env.TEST_PROTOCOL_LOG=log;
  let machine=new SessionMachine({profile,bin:path.join(root,"target/debug"),directory:folder,client:"generic"});
  try{
    const created=await machine.request({method:"create",launch:{client:"opencode",surface:"gui",model:"test-model"},operation_key:"create"});
    const started=await machine.request({method:"start",session_id:created.session_id,generation:created.generation,operation_key:"start"});
    const draft="长草稿🍃\n".repeat(2500),write={method:"draft",session_id:started.session_id,generation:started.generation,operation_key:"draft",data:draft};
    const original=await machine.request(write),record=JSON.parse(await readFile(recordPath(profile,undefined,started.session_id),"utf8"));
    const directory=externalSessionDirectory(profile,{workspace:record.cwd,accessDirectory:folder,localSettings:true,title:"验收"},record.external_state.id,"opencode"),receipt={id:"original-receipt",turn_id:"",kind:"mcp",title:"hetu_call_action",server:"hetu",state:"completed",output:"{}"};
    await writeFile(path.join(directory,"receipts.json"),JSON.stringify([receipt]));await machine.close();machine=new SessionMachine({profile,bin:path.join(root,"target/debug"),directory:folder,client:"generic"});
    const view=await machine.request({method:"read",session_id:started.session_id,format:"conversation"});assert.equal(view.draft_complete,false);assert.equal(view.draft_read.method,"draft_read");assert.deepEqual(view.conversation.receipts,[receipt],"重开读取原协议目录，不回退沙箱或启动引擎");assert(Buffer.byteLength(JSON.stringify(view))<64000);
    let text="",offset=0;
    do{const page=await machine.request({method:"draft_read",session_id:started.session_id,expected_draft_version:view.draft_version,offset,limit:4000});text+=page.draft;offset=page.next_offset;}while(offset!==null);
    assert.equal(text,draft);await assert.rejects(machine.request({method:"draft_read",session_id:started.session_id,expected_draft_version:view.draft_version+1,offset:0}),/草稿版本已变化/);
    assert.deepEqual(await machine.request(write),JSON.parse(JSON.stringify(original)),"原草稿键回读不派发新输入");
    assert.equal((await readFile(log,"utf8")).split("\n").filter(line=>line.includes('"method":"session/prompt"')).length,0);
  }finally{await machine.close();if(previousBinary===undefined)delete process.env.HETU_OPENCODE_BIN;else process.env.HETU_OPENCODE_BIN=previousBinary;if(previousLog===undefined)delete process.env.TEST_PROTOCOL_LOG;else process.env.TEST_PROTOCOL_LOG=previousLog;}
});

test("无窗口PTY保持原身份与代次；restore不以新Shell冒充线程恢复",{skip:process.platform==="win32",timeout:15000},async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-machine-"));
  const machine=new SessionMachine({profile:path.join(folder,"profile"),bin:path.join(root,"target/debug"),directory:folder,client:"generic"});
  try{
    const created=await machine.request({method:"create",launch:{client:"shell",surface:"tui"},operation_key:"create"});
    await assert.rejects(machine.request({method:"restore",session_id:created.session_id,generation:created.generation,operation_key:"invalid-restore"}),/原生线程身份/);
    const started=await machine.request({method:"start",session_id:created.session_id,generation:created.generation,operation_key:"start"});
    const input={method:"input",session_id:started.session_id,generation:started.generation,data:"printf 'HETU-MACHINE-RESTORE-OK\\n'\r",operation_key:"input"};
    const delivered=await machine.request(input);assert.equal(delivered.delivery,"written");
    await until(async()=>String((await machine.request({method:"read",session_id:started.session_id})).output).includes("HETU-MACHINE-RESTORE-OK"));
    await machine.request({method:"stop",session_id:started.session_id,generation:started.generation,operation_key:"stop"});
    assert.deepEqual(await machine.request(input),JSON.parse(JSON.stringify(delivered)),"原键回读不受新输入代次影响");
    await assert.rejects(machine.request({...input,operation_key:"stale"}),/代次/);
    await assert.rejects(machine.request({...input,data:"different"}),/不能更换输入/);
  }finally{await machine.close();}
});

test("PTY重开保留固定模型和存储位置；配置选择器变化拒绝启动",{skip:process.platform==="win32",timeout:15000},async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-tui-config-")),binary=path.join(folder,"claude"),log=path.join(folder,"argv.json"),profile=path.join(folder,"profile"),cwd=path.join(folder,"sandbox");
  await writeFile(binary,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));setInterval(()=>{},1000);\n`,{mode:0o700});
  const oldBinary=process.env.HETU_CLAUDE_CODE_BIN,oldConfig=process.env.CLAUDE_CONFIG_DIR;
  process.env.HETU_CLAUDE_CODE_BIN=binary;process.env.CLAUDE_CONFIG_DIR=path.join(folder,"config-a");
  const options={id:"terminal-12345678-1234-4234-8234-123456789abc",launch:{client:"claude-code",surface:"tui" as const,model:"fixed-model"},profile,cwd,emit:()=>{}};
  let session=new ProcessSession(options);
  try{
    await session.start();await until(async()=>{try{return JSON.parse(await readFile(log,"utf8")).includes("fixed-model");}catch{return false;}});
    await session.stop();session=new ProcessSession({...options,launch:{client:"claude-code",surface:"tui"}});
    await session.start();assert.equal(session.snapshot().model,"fixed-model");await session.stop();
    process.env.CLAUDE_CONFIG_DIR=path.join(folder,"config-b");
    await assert.rejects(session.start(),/存储目录已变化/);
  }finally{await session.stop();if(oldBinary===undefined)delete process.env.HETU_CLAUDE_CODE_BIN;else process.env.HETU_CLAUDE_CODE_BIN=oldBinary;if(oldConfig===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldConfig;}
});

test("Hermes旧终端固定原profile，新活动选择不改写旧会话",{skip:process.platform==="win32",timeout:15000},async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-hermes-profile-")),home=path.join(folder,"hermes"),binary=path.join(folder,"hermes-cli"),log=path.join(folder,"home.txt");
  for(const name of ["first","second"])await mkdir(path.join(home,"profiles",name),{recursive:true});
  await writeFile(path.join(home,"active_profile"),"first\n");
  await writeFile(binary,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(log)},process.env.HERMES_HOME);setInterval(()=>{},1000);\n`,{mode:0o700});
  const priorBinary=process.env.HETU_HERMES_BIN,priorHome=process.env.HERMES_HOME;
  process.env.HETU_HERMES_BIN=binary;process.env.HERMES_HOME=home;
  const session=new ProcessSession({id:"terminal-12345678-1234-4234-8234-abcdef123456",launch:{client:"hermes",surface:"tui"},profile:path.join(folder,"profile"),cwd:path.join(folder,"sandbox"),emit:()=>{}});
  try{
    await session.start();await until(async()=>{try{return await readFile(log,"utf8")===path.join(home,"profiles","first");}catch{return false;}});await session.stop();
    await writeFile(path.join(home,"active_profile"),"second\n");await session.start();
    assert.equal(session.snapshot().storage_binding?.profile?.name,"first");
  }finally{await session.stop();if(priorBinary===undefined)delete process.env.HETU_HERMES_BIN;else process.env.HETU_HERMES_BIN=priorBinary;if(priorHome===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=priorHome;}
});

test("桌面原键与接管会话持久恢复，不缓存像素或把not_found当作成功",async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-execution-journal-")),journal=new ExternalExecutionJournal(folder);
  const session="computer-12345678-1234-4234-8234-abcdef123456";
  const input={method:"takeover",session_id:session,operation_key:"take"};
  await journal.before(undefined,"computer",input);await journal.after(undefined,"computer","take",{status:"unknown"});
  await assert.rejects(journal.before(undefined,"computer",{...input,method:"act",operation_key:"other"}),/待核对/);
  await journal.after(undefined,"computer","take",{status:"succeeded",data:{state:"not_found"}});
  assert.equal((await journal.read())[0].state,"unknown");
  await journal.observed(undefined,{session_id:session},{app:{pid:123},window:{window_id:456},control:{state:"active"},screenshot:{data:"not-persisted"}});
  await journal.controlled(undefined,input,{result:{state:"taken_over"}});
  const reopened=new ExternalExecutionJournal(folder);
  assert.deepEqual(await reopened.computerSession(),{session_id:session,pid:123,window_id:456,state:"taken_over"});
  await journal.after(undefined,"computer","take",{status:"succeeded",data:{state:"succeeded"}});
  await journal.before(undefined,"computer",{...input,method:"act",operation_key:"other"});
});

test("宿主跨工作面的同范围写入等待原回执，其他领域独立，未知不解除围栏",async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-host-dispatch-")),journal=new ExternalExecutionJournal(folder),gate=Promise.withResolvers<void>(),started=Promise.withResolvers<void>(),order:string[]=[];
 const write=(key:string)=>({method:"session_resize",session_id:"original",operation_key:key,cols:80,rows:24});
 const first=journal.dispatch(undefined,"bots",write("first"),async()=>{await journal.before(undefined,"bots",write("first"));order.push("first");started.resolve();await gate.promise;await journal.after(undefined,"bots","first",{status:"succeeded"});});await started.promise;
 const second=journal.dispatch(undefined,"bots",write("second"),async()=>{await journal.before(undefined,"bots",write("second"));order.push("second");await journal.after(undefined,"bots","second",{status:"succeeded"});});
 const stop={method:"session_stop",session_id:"original",operation_key:"stop"};await journal.dispatch(undefined,"bots",stop,async()=>{await journal.before(undefined,"bots",stop);order.push("stop");await journal.after(undefined,"bots","stop",{status:"succeeded"});});
 await journal.dispatch(undefined,"computer",{method:"act"},async()=>{order.push("computer");});assert.deepEqual(order,["first","stop","computer"]);gate.resolve();await Promise.all([first,second]);assert.deepEqual(order,["first","stop","computer","second"]);
 await journal.dispatch(undefined,"bots",write("unknown"),async()=>{await journal.before(undefined,"bots",write("unknown"));await journal.after(undefined,"bots","unknown",{status:"unknown"});});
 await assert.rejects(journal.dispatch(undefined,"bots",write("new"),()=>journal.before(undefined,"bots",write("new"))),/待核对/);assert.equal((await journal.read()).find(row=>row.operation_key==="unknown").state,"unknown");
});
