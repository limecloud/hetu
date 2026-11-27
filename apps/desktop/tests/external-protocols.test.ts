import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {externalProviders} from "../src/shared/external-ai.ts";
import {StructuredExternalSession} from "../src/main/agent/structured-external-session.ts";
import {prepareExternalLaunch} from "../src/main/agent/external-ai-launch.ts";
import {createConversationDriver} from "../src/main/agent/external-conversation-registry.ts";
import {acp,claude,pi} from "./fixtures/external-protocol-fixture.ts";
import type {TerminalMethod} from "../src/shared/codex-terminal.ts";

const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){assert(Date.now()<end,"协议状态未在期限内收敛");await new Promise(resolve=>setTimeout(resolve,10));}};
async function rig(providerId:string,fixture:string){
  const root=await mkdtemp(path.join(os.tmpdir(),"hetu-protocol-")),bin=path.join(root,"bin"),log=path.join(root,"wire.jsonl"),provider=externalProviders.find(value=>value.id===providerId)!;
  await mkdir(bin);const binary=path.join(bin,provider.commands[0]);
  await writeFile(binary,fixture.replace("NODE",process.execPath).replace("FIXTURE_VERSION",provider.structured!.minimumVersions?.at(-1)??"1.0.0"),{mode:0o700});await writeFile(log,"");
  const binding={workspace:root,accessDirectory:root,title:"隔离协议范围"};
  const session=new StructuredExternalSession({profile:root,providerId,emit:()=>{},driver:async(directory,binding,event,storage,bindStorage)=>{
    const launch=await prepareExternalLaunch({providerId,mode:"structured",directory,binding,mcp:path.join(root,"hetu-mcp"),cli:path.join(root,"hetu"),binary,codexBinary:"unused",env:{...process.env,PATH:bin,HETU_PLUGIN_NODE:process.execPath,CLAUDE_CONFIG_DIR:path.join(root,"claude-config"),TEST_PROTOCOL_LOG:log},expectedStorage:storage,bindStorage});
    return createConversationDriver(provider.structured!.protocol,{...launch,cwd:directory,event});
  }});
  const request=(method:TerminalMethod,input:Record<string,unknown>={})=>session.request(method,["start","resume","reconnect"].includes(method)?{}:{session_id:session.snapshot(false).session_id,generation:session.snapshot(false).generation,...input},binding);
  return {root,log,session,request};
}

test("ACP启动合同逐提供方握手，原权限、模型、错会话事件与恢复身份保持",{timeout:60000,skip:process.platform==="win32"},async t=>{
  for(const provider of externalProviders.filter(value=>value.structured?.protocol==="acp"))await t.test(provider.id,async()=>{
    const r=await rig(provider.id,acp);try{
      const first=await r.request("start");assert.equal(first.provider_session_id,"session-fixed");
      await r.request("model",{model_id:"test-model"});await r.request("send",{data:"固定请求"});await until(()=>r.session.snapshot().conversation!.status==="blocked");
      await assert.rejects(r.request("approve",{approval_id:"permission-fixed",option_id:"forged"}));
      await r.request("approve",{approval_id:"permission-fixed",option_id:"allow-once"});await until(()=>r.session.snapshot().conversation!.status==="ready");
      assert.match(r.session.snapshot().replay,/ACP运行完成🌿/);assert.doesNotMatch(r.session.snapshot().replay,/CROSS_SESSION/);
      const wire=(await readFile(r.log,"utf8")).trim().split("\n").map(line=>JSON.parse(line)),init=wire.find(value=>value.method==="initialize");
      assert.equal(init.params.clientCapabilities.fs.writeTextFile,false);assert.equal(init.params.clientCapabilities.terminal,false);
      const created=wire.find(value=>value.method==="session/new");assert.equal(created.params.cwd,first.directory);assert.equal(created.params.mcpServers[0].name,"hetu");
      await r.request("stop");const restored=await r.request("reconnect");assert.equal(restored.provider_session_id,first.provider_session_id);
    }finally{await r.session.close();}
  });
});

test("Claude原工具许可与恢复保持UUID，流式与完整消息合并",{timeout:15000,skip:process.platform==="win32"},async()=>{
  const r=await rig("claude-code",claude);try{
    const first=await r.request("start");assert(first.provider_session_id);
    await r.request("send",{data:"请求"});await until(()=>r.session.snapshot().conversation!.status==="blocked");await r.request("approve",{approval_id:"permission-fixed",option_id:"allow"});await until(()=>r.session.snapshot().conversation!.status==="ready");
    assert.equal(r.session.snapshot().conversation!.messages.filter(value=>value.role==="assistant").length,1);
    await r.request("stop");const restored=await r.request("reconnect");assert.equal(restored.provider_session_id,first.provider_session_id);
    const wire=(await readFile(r.log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));assert.deepEqual(wire.find(value=>value.type==="control_response").response.response,{behavior:"allow",updatedInput:{fixed:true}});
  }finally{await r.session.close();}
});

test("Pi的agent_end只有原状态空闲后才结束，固定会话文件可恢复",{timeout:15000,skip:process.platform==="win32"},async()=>{
  const r=await rig("pi",pi);try{
    const first=await r.request("start");assert.equal(first.provider_session_id,"pi-fixed");await r.request("send",{data:"请求"});await until(()=>r.session.snapshot().replay.includes("Pi流式完成🌿"));
    assert.equal(r.session.snapshot().conversation!.status,"running");await r.request("interrupt");await until(()=>r.session.snapshot().conversation!.status==="ready");
    await r.request("stop");const restored=await r.request("reconnect");assert.equal(restored.provider_session_id,"pi-fixed");assert.match(restored.replay,/Pi原会话历史/);
  }finally{await r.session.close();}
});
