import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,stat,chmod} from "node:fs/promises";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import path from "node:path";
import os from "node:os";
import {prepareBusinessContext} from "../src/main/agent/business-context.ts";
import {creationHandoff,workHandoff} from "../src/main/workbench-handoff.ts";
import {ProcessSession} from "../src/main/agent/process-session.ts";

const work={workspace_id:"workspace",kind:"novel" as const,object_id:"novel"};
test("原生提示前只保存业务请求，明确放入拒绝旧草稿且不补提交",async()=>{
  const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-business-draft-")),binary=path.join(profile,"native");
  await writeFile(binary,"#!/bin/sh\nexec /bin/cat\n");await chmod(binary,0o755);
  const previous=process.env.HETU_CLAUDE_CODE_BIN;process.env.HETU_CLAUDE_CODE_BIN=binary;
  const session=new ProcessSession({id:"terminal-12345678-1111-2222",launch:{client:"claude-code",surface:"tui"},cwd:path.join(profile,"sandbox"),profile,emit:()=>{}});
  try{
    const staged=await session.insertDraft("PRIVATE-BUSINESS-REQUEST");assert.equal(staged.draft,"PRIVATE-BUSINESS-REQUEST");assert.doesNotMatch(staged.terminal_replay??"",/PRIVATE-BUSINESS/);
    await assert.rejects(session.pasteDraft(staged.draft_version!-1),/已变化/);
    await session.pasteDraft(staged.draft_version!);assert.equal(session.snapshot().draft,"");await assert.rejects(session.pasteDraft(staged.draft_version!),/已变化/);
  }finally{await session.stop();if(previous===undefined)delete process.env.HETU_CLAUDE_CODE_BIN;else process.env.HETU_CLAUDE_CODE_BIN=previous;}
});
test("三种原生引擎注入确切作品MCP，不改认证或全局配置",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"hetu-business-config-"));
  const environment={HETU_PLUGIN_STATE_DIR:"/private/plugins",HETU_LOCAL_SETTINGS_DIR:"/private/settings",HETU_PLUGIN_NODE:"/runtime/node",HETU_PLUGIN_MANAGER:"/runtime/plugin-manager.mjs",HETU_DESKTOP_PROFILE:"/private/profile",OPENAI_API_KEY:"private-key",OTHER_TOKEN:"private-token"};
  for(const client of ["claude-code","gemini","opencode"] as const){
    const cwd=path.join(root,client);await import("node:fs/promises").then(fs=>fs.mkdir(cwd));
    const value=await prepareBusinessContext({client,cwd,binary:"/runtime/hetu-mcp",directory:"/private/collaboration",work,node:"/runtime/node",relay:"/runtime/relay.mjs",environment});
    const actual=JSON.parse(await readFile(path.join(cwd,"hetu-mcp.json"),"utf8"));
    assert.deepEqual(JSON.parse(actual.args.at(-1)),work);assert.equal(actual.args[1],client==="claude-code"?"claude-code":"generic");
    assert.doesNotMatch(JSON.stringify(value),/GEMINI_CLI_HOME|HOME|api_key|authorization|private-key|private-token/);
    if(client==="claude-code")assert.equal(JSON.parse(value.args[1]).mcpServers.hetu.command,"/runtime/node");
    if(client==="gemini")assert.equal(JSON.parse(await readFile(path.join(cwd,".gemini/settings.json"),"utf8")).mcpServers.hetu.args[1],path.join(cwd,"hetu-mcp.json"));
    const mcp=client==="claude-code"?JSON.parse(value.args[1]).mcpServers.hetu:client==="gemini"?JSON.parse(await readFile(path.join(cwd,".gemini/settings.json"),"utf8")).mcpServers.hetu:JSON.parse(value.env.OPENCODE_CONFIG_CONTENT!).mcp.hetu;
    assert.deepEqual(client==="opencode"?mcp.environment:mcp.env,{HETU_COLLABORATION_DIR:"/private/collaboration",HETU_LOCAL_SETTINGS_DIR:environment.HETU_LOCAL_SETTINGS_DIR,HETU_PLUGIN_STATE_DIR:environment.HETU_PLUGIN_STATE_DIR,HETU_PLUGIN_NODE:environment.HETU_PLUGIN_NODE,HETU_PLUGIN_MANAGER:environment.HETU_PLUGIN_MANAGER,HETU_DESKTOP_PROFILE:environment.HETU_DESKTOP_PROFILE});
    if(client==="opencode")assert.equal(mcp.enabled,true);
  }
});
test("受管领域交接使用实际客户端且不向请求暴露授权材料",async()=>{
  for(const client of ["codex","claude-code","generic"]){
    const environment={client,coreCli:"/private/cli"};
    assert.equal(JSON.parse(creationHandoff("drama",environment,true).split("\n").slice(1).join("\n")).client_adapter,client);
    const prompt=await workHandoff("work.resources",{}, {work,environment,managedSession:true,workspacePath:"/private/workspace",managementRef:{secret:true},executionPolicy:async()=>({preferences:{execution_mode:"auto"}}),summary:async()=>({fixed_ref:{revision:1}}),check:()=>{},authoring:{handoff:async()=>({status:"succeeded",data:{fixed_refs:[],direct_actions:[],proposal_actions:[]}})} as any});
    assert.equal(JSON.parse(prompt.split("\n").slice(1).join("\n")).client_adapter,client);assert.doesNotMatch(prompt,/management_ref|private\/workspace|private\/cli/);
  }
});
test("MCP中继保持原响应，只记录匹配请求的脱敏有界回执",async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),"hetu-business-relay-")),config=path.join(cwd,"config.json"),receipts=path.join(cwd,"receipts.json"),server=path.join(cwd,"server.mjs");
  await writeFile(server,`import {createInterface} from "node:readline";const result={structuredContent:{action:"hetu.resources.create",status:"succeeded",data:{api_key:"private-key",management_ref:{id:"private-grant"},resource:{resource_id:"r",revision:1},sha256:"fixed"}},content:[{type:"text",text:JSON.stringify({password:"private-password"})}]};process.stdout.write(JSON.stringify({id:"unsolicited",result})+"\\n");createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,result})+"\\n");});`);
  await writeFile(config,JSON.stringify({binary:process.execPath,args:[server],receipts}));
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,"../dist/agent-mcp-relay.mjs"),config],{stdio:["pipe","pipe","pipe"]});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();let stderr="";child.stderr.on("data",data=>stderr+=data);
  try{
    const unsolicited=await lines.next();assert.equal(JSON.parse(unsolicited.value!).id,"unsolicited");await assert.rejects(stat(receipts),{code:"ENOENT"});
    child.stdin.write(JSON.stringify({id:1,method:"tools/call",params:{name:"hetu_call_action",arguments:{action:"hetu.resources.create"}}})+"\n");
    const reply=JSON.parse((await lines.next()).value!);assert.equal(reply.result.structuredContent.data.api_key,"private-key");
    const stored=await readFile(receipts,"utf8");assert.doesNotMatch(stored,/private-key|private-grant|private-password/);assert.equal(JSON.parse(stored).length,1);assert.equal(stderr,"");
    for(let id=2;id<=75;id++){child.stdin.write(JSON.stringify({id,method:"tools/call",params:{name:"hetu_call_action"}})+"\n");await lines.next();}
    assert.equal(JSON.parse(await readFile(receipts,"utf8")).length,64);
  }finally{child.stdin.end();child.kill();}
});
