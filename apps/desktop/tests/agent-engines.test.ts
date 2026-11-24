import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {ProcessSession} from "../src/main/agent/process-session.ts";
import {AgentSessions} from "../src/main/agent/session-manager.ts";
import {EngineCatalog,discoverEngines} from "../src/main/agent/engines.ts";

test("引擎发现不启动会话，拒绝未知引擎、表面和伪造模型",async()=>{
  const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-engine-catalog-")),catalog=new EngineCatalog({directory:profile});
  assert.ok((await discoverEngines()).some(item=>item.id==="shell"&&item.available));
  await assert.rejects(catalog.validate({client:"made-up",surface:"tui"}),/无效/);
  await assert.rejects(catalog.validate({client:"shell",surface:"gui"}),/原生终端/);
  await assert.rejects(catalog.validate({client:"shell",surface:"tui",model:"invented"}),/不可用/);
  assert.deepEqual(await catalog.validate({client:"shell",surface:"tui",title:"  本机  "}),{client:"shell",surface:"tui",title:"本机"});
});
test("原生PTY并发启动一次、拒绝旧代次，关闭重开不伪造模型线程",async()=>{
  const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-engine-process-"));let replay="";
  const session=new ProcessSession({id:"terminal-12345678-1234-1234",launch:{client:"shell",surface:"tui"},profile,cwd:path.join(profile,"sandbox"),emit:event=>{if(event.type==="terminal")replay+=event.data;}});
  try{
    const [first,second]=await Promise.all([session.start(),session.start()]);assert.equal(first.generation,second.generation);assert.equal(first.terminal_connected,true);
    session.terminalInput("printf 'ENGINE-PTY-READY\\n'\r",first.generation!);
    const deadline=Date.now()+5000;while(!replay.includes("ENGINE-PTY-READY")&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.match(replay,/ENGINE-PTY-READY/);
    session.terminalResize(90,24,first.generation!);await assert.rejects(session.insertDraft("never execute this"),/Agent终端/);
    await session.stop();assert.throws(()=>session.terminalInput("old",first.generation!),/旧输入/);
    const next=await session.start();assert.ok(next.generation!>first.generation!);assert.equal(next.thread_id,undefined);assert.deepEqual(next.messages,[]);
  }finally{await session.stop();}
});
test("会话选择按真实引擎重开，保留旧Codex记录及跨进程执行权",async()=>{
  const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-engine-selection-")),sessions=new AgentSessions({profile,emit:()=>{}});
  try{
    const codex=await sessions.get();const original=codex.snapshot().session_id;
    const shell=await sessions.create(undefined,"tui",{client:"shell",surface:"tui",title:"独立终端"});await shell.start();
    assert.equal((await sessions.get()).snapshot().client,"shell");
    await sessions.get(undefined,"tui",original,true);assert.equal((await sessions.get()).snapshot().client,"codex");
    await sessions.get(undefined,"tui",shell.snapshot().session_id,true);
    const other=new AgentSessions({profile,emit:()=>{}}),loaded=await other.get();assert.equal(loaded.snapshot().client,"shell");
    await assert.rejects(loaded.start(),/占用/);
    await sessions.stopAll();await loaded.start();await other.stopAll();
  }finally{await sessions.stopAll();}
});
