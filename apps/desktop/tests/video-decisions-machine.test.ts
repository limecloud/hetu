import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";

const root=path.resolve(import.meta.dirname,"../../..");
test("本对话真实CLI与MCP共用固定成片决定、撤回、历史和原键恢复",{timeout:120000},async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),"hetu-video-decision-machine-")),workspace=path.join(folder,"作品"),collaboration=path.join(folder,"collaboration");
 const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});assert.equal(fixture.status,0,fixture.stderr);const refs=JSON.parse(fixture.stdout),work=refs.video;
 const resources=process.env.HETU_VIDEO_DECISION_RESOURCES;
 const bin=(name:string)=>path.join(resources??path.join(root,"target/debug"),resources?"bin":"",name+(process.platform==="win32"?".exe":""));
 const env={...process.env,HETU_COLLABORATION_DIR:collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(folder,"settings")};
 const command=(action:string,input:any)=>({action,contract_revision:"1",input});
 const ok=(value:any)=>{assert.equal(value.status,"succeeded",JSON.stringify(value));return value.data;};
 const cli=(action:string,input:any)=>{const result=spawnSync(bin("hetu"),["--client","codex","call",action,"--input","-"],{env,input:JSON.stringify(input),encoding:"utf8",timeout:30000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 const exec=(action:string,input:any)=>ok(ok(cli("hetu.execution.invoke",{workspace_path:workspace,command:command(action,input)})).result);
 const client=new Client({name:"hetu-video-decision-acceptance",version:"1"},{});
 const transport=new StdioClientTransport({command:bin("hetu-mcp"),args:["--client","codex","--collaboration-dir",collaboration],env:Object.fromEntries(Object.entries(env).filter((entry):entry is [string,string]=>typeof entry[1]==="string")),stderr:"pipe"});transport.stderr?.on("data",()=>{});
 try{
  await client.connect(transport);
  const call=async(action:string,input:any)=>{const value=await client.callTool({name:"hetu_call_action",arguments:{action,input}});return value.structuredContent as any;};
  const invoke=async(action:string,input:any)=>ok(ok(await call("hetu.execution.invoke",{workspace_path:workspace,command:command(action,input)})).result);
  assert.equal(ok(await call("hetu.execution.get_mode",{})).execution_mode,"auto");
  const base=exec("hetu.video.media.get",{work_ref:work,media_ref:refs.second});
  const media=await invoke("hetu.video.media.save",{work_ref:work,video_episode_id:refs.episode_id,asset_ref:base.media.asset_ref,title:"机器隔离成片样本",purpose:"final",stream_index:base.media.stream_index,time_base:base.media.time_base,duration_ticks:base.media.duration_ticks,operation_key:"machine-final"});
  const request={work_ref:work,media_ref:media.media_ref,purpose:"final",decision:"confirmed",expected_decision_ref:null,author_statement:"隔离验收：确认这条固定测试样本，不表示作者认可真实影片。"};
  const preview=await invoke("hetu.video.decisions.preview",request),input={work_ref:work,preview:preview.preview,operation_key:"machine-confirm"};
  const first=await invoke("hetu.video.decisions.save",input);assert.equal(first.decision.actor_ref,"actor_00000000-0000-4000-8000-000000000002");
  assert.deepEqual(exec("hetu.video.decisions.save",input),first);assert.deepEqual(exec("hetu.video.decisions.get",{work_ref:work,video_episode_id:refs.episode_id,purpose:"final"}).decision_ref,first.decision_ref);
  const withdraw=exec("hetu.video.decisions.preview",{...request,decision:"withdrawn",expected_decision_ref:first.decision_ref,author_statement:"隔离验收：撤回同一条固定测试样本。"});
  const second=await invoke("hetu.video.decisions.save",{work_ref:work,preview:withdraw.preview,operation_key:"machine-withdraw"});assert.equal(second.decision.revision,2);
  assert.equal(exec("hetu.video.media.get",{work_ref:work,media_ref:media.media_ref}).author_decision.state,"withdrawn");
  assert.deepEqual((await invoke("hetu.video.decisions.get",{work_ref:work,video_episode_id:refs.episode_id,purpose:"final",decision_ref:first.decision_ref})).decision,first.decision);
  const history=await invoke("hetu.video.decisions.history",{work_ref:work,video_episode_id:refs.episode_id,purpose:"final",limit:1});assert.equal(history.items[0].decision_ref.revision,2);
  assert.equal(exec("hetu.video.decisions.history",{work_ref:work,video_episode_id:refs.episode_id,purpose:"final",limit:1,cursor:history.next_cursor}).items[0].decision_ref.revision,1);
  const other=exec("hetu.video.projects.create",{title:"同根他作",brief:"拒绝跨作品决定",language_tag:"zh-CN",operation_key:"other"});
  const refused=await call("hetu.execution.invoke",{workspace_path:workspace,command:command("hetu.video.decisions.get",{work_ref:other.work_ref,video_episode_id:refs.episode_id,purpose:"final"})});assert.notEqual(refused.status,"succeeded");
  const original=exec("hetu.video.media.get",{work_ref:work,media_ref:refs.second});assert.equal(original.author_decision.state,"not_recorded");assert.equal(original.media.adoption,"not_recorded");
  await writeFile(path.join(folder,"result.json"),JSON.stringify({real_cli:true,real_stdio_mcp:true,model_turns:0,work_ref:work,media_ref:media.media_ref,first_decision_ref:first.decision_ref,withdrawn_decision_ref:second.decision_ref,original_operation_replayed_once:true,old_history_retained:true,cross_work_refused:true,other_purpose_unchanged:true,agent_identity_retained:true},null,2));
  if(process.env.HETU_VIDEO_DECISION_EVIDENCE)await writeFile(process.env.HETU_VIDEO_DECISION_EVIDENCE,JSON.stringify({runtime_resources:resources?"package":"source",model_turns:0,real_cli:true,real_mcp:true,first_revision:1,withdrawn_revision:2,history_fixed:true,cross_work_refused:true,original_operation_once:true,actor:"agent"},null,2));
 }finally{await client.close();}
});
