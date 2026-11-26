import {test} from "node:test";
import assert from "node:assert/strict";
import {ProfessionalTools} from "../src/main/professional-tools.ts";
import type {ProfessionalInput} from "../src/professional-contract.ts";

const work={kind:"novel" as const,workspace_id:"workspace-test",object_id:"novel-test"};
const binding={plugin_id:"org.hetu.professional-test",package_sha256:"a".repeat(64),capabilities_sha256:"b".repeat(64)};
const selection={skill_id:"planning",skill_sha256:"c".repeat(64)};
function fixture(){
 const state={active:true,enabled:true,package:binding.package_sha256,capability:binding.capabilities_sha256,body:"先核对固定原文。",skillHash:selection.skill_sha256,
  calls:[] as {action:string;input:Record<string,unknown>}[],handoffs:[] as unknown[],duringHandoff:()=>{},duringMethod:()=>{}};
 const refs=[{kind:"document",document_id:"doc-1",revision_id:"rev-1",sha256:"d".repeat(64)},{kind:"source_range",document_id:"doc-1",revision_id:"rev-1",byte_start:0,byte_end:6,quote:"原文"}];
 const tools=new ProfessionalTools(work,{
  check(){if(!state.active)throw Error("作品已切换");},client:()=>"codex",workspacePath:"/isolated/workspace",
  plugins:async()=>({plugins:[{id:binding.plugin_id,package_sha256:state.package,state:state.enabled?"active":"disabled",version:"1.0.0",display:{"zh-CN":"专业方法"},description:{"zh-CN":"核对固定来源"},work_kinds:["novel"]}]}),
  read:async(action,input)=>{
   state.calls.push({action,input});
   if(action==="hetu.plugins.capabilities")return {...binding,package_sha256:state.package,capabilities_sha256:state.capability,work_ref:work,
    actions:[{id:"arrange",title:"整理布局"}],skills:[{id:selection.skill_id,content_sha256:selection.skill_sha256}],types:[]};
   assert.equal(action,"hetu.plugins.invoke");assert.equal(input.action,"skills.read");state.duringMethod();
   return {result:{status:"succeeded",data:{...binding,skill_id:selection.skill_id,content_sha256:state.skillHash,content:state.body}}};
  },
  handoff:async(kind,object)=>{state.handoffs.push({kind,object});state.duringHandoff();return {status:"succeeded",data:{fixed_refs:refs}};},
 });
 const input:ProfessionalInput={work_ref:work,plugin:binding,selection,target:{page:"novel.reader",object:{document_id:"doc-1",revision_id:"rev-1",byte_start:0,byte_end:6,quote:"原文"}},goal:"核对人物行动，保持原文。"};
 return {tools,state,input,refs};
}

test("目录、方法及固定请求只读原Owner，不执行专业动作或创建任务",async()=>{
 const {tools,state,input,refs}=fixture();
 const catalog=await tools.call("catalog",{work_ref:work});assert.equal(catalog.plugins[0].supported,true);assert.equal(state.calls.length,0);
 const method=await tools.call("method",input);assert.equal(method.content,state.body);assert.equal(state.handoffs.length,0);
 const prepared=await tools.call("prepare",input),context=JSON.parse(prepared.prompt.slice(prepared.prompt.indexOf("\n{")+1));
 assert.deepEqual(context.fixed_refs,refs);assert.equal(context.workspace_path,"/isolated/workspace");assert.equal(context.first_action,"hetu.execution.get_mode");
 assert.deepEqual(prepared.professional,{...binding,...selection});assert.equal(state.handoffs.length,1);
 assert.deepEqual(state.handoffs[0],{kind:"novel",object:input.target!.object});
 assert(state.calls.every(call=>call.action==="hetu.plugins.capabilities"||call.input.action==="skills.read"));
 assert(!prepared.prompt.includes("management_ref"));
});

test("方法读取或来源准备期间停用及升级，拒绝旧专业选择",async()=>{
 const {tools,state,input}=fixture();
 state.duringMethod=()=>{state.enabled=false;};await assert.rejects(tools.call("method",input),/未启用/);
 state.enabled=true;state.duringHandoff=()=>{state.package="e".repeat(64);};await assert.rejects(tools.call("prepare",input),/已更新/);
 state.package=binding.package_sha256;state.duringHandoff=()=>{state.capability="f".repeat(64);};await assert.rejects(tools.call("prepare",input),/能力已变化/);
});

test("跨作品、失效范围、无效方法和混合选择不能准备交接",async()=>{
 const {tools,state,input}=fixture();
 await assert.rejects(tools.call("catalog",{work_ref:{...work,object_id:"other"}}),/不属于/);assert.equal(state.calls.length,0);
 for(const picked of [{skill_sha256:selection.skill_sha256},{action_id:"arrange",skill_id:"planning"},{skill_id:"planning",skill_sha256:"bad"},{action_id:42}])
  await assert.rejects(tools.call("prepare",{...input,selection:picked as any}),/请选择/);
 await assert.rejects(tools.call("prepare",{...input,selection:{action_id:"missing"}}),/已变化/);
 state.skillHash="f".repeat(64);await assert.rejects(tools.call("method",input),/资源.*不一致/);
 state.active=false;await assert.rejects(tools.call("prepare",input),/作品已切换/);
});

test("目标、来源读取失败与请求预算保留明确错误",async()=>{
 const {tools,state,input}=fixture();
 await assert.rejects(tools.call("prepare",{...input,goal:" "}),/填写本次目标/);
 await assert.rejects(tools.call("prepare",{...input,target:{page:"not-a-page",object:{}}}),/固定目标/);
 state.duringHandoff=()=>{throw Error("原文选区已变化");};await assert.rejects(tools.call("prepare",input),/原文选区已变化/);
 const long=fixture();long.refs.push({kind:"source_range",quote:"字".repeat(21_000)} as any);
 await assert.rejects(long.tools.call("prepare",long.input),/固定选区过长/);
});
