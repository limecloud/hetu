import test from "node:test";
import assert from "node:assert/strict";
import type {AgentTool} from "../src/agent-session-contract.ts";
import {readSessionResults,readLibrarySessionResults} from "../src/main/agent/session-results.ts";
const work={workspace_id:"workspace",kind:"novel" as const,object_id:"novel"};
const tool=(action:string,data:any,server="hetu"):AgentTool=>({id:"tool",turn_id:"turn",kind:"mcpToolCall",title:"test",server,state:"completed",output:JSON.stringify({structuredContent:{action,status:"succeeded",data}})});
const reference={document_id:"doc",revision_id:"revision",sha256:"sha"};
test("保存回执必须独立回读Core；读操作和其他MCP不能伪装写入成果",async()=>{
 let reads=0;
 const data={document:{document_id:"doc"},revision:{revision_id:"revision",sha256:"sha"}};
 const value=await readSessionResults([tool("hetu.documents.create",data),tool("hetu.documents.get",data),tool("hetu.documents.create",data,"other")],work,async(action,input)=>{
  reads++;assert.equal(action,"hetu.documents.get");assert.deepEqual(input,{document_id:"doc",revision_id:"revision"});
  return {document:{work_ref:work,title:"雨夜",current_revision_id:"newer"},revision:{revision_id:"revision",sha256:"sha"}};
 });
 assert.equal(reads,1);assert.equal(value.items.length,1);assert.equal(value.items[0].state,"verified");assert.deepEqual(value.items[0].reference,reference);assert.match(value.items[0].message!,/已有更新/);
});
test("错作品、伪造摘要、撤权和Core读取失败保留待核对，不产生可打开成果",async()=>{
 const data={document:{document_id:"doc"},revision:{revision_id:"revision",sha256:"sha"}};
 for(const result of [{document:{work_ref:{...work,object_id:"other"}},revision:{revision_id:"revision",sha256:"sha"}},{document:{work_ref:work},revision:{revision_id:"revision",sha256:"wrong"}},undefined]){
  const value=await readSessionResults([tool("hetu.documents.save",data)],work,async()=>{if(!result)throw new Error("授权已撤回");return result;});
  assert.equal(value.items[0].state,"unavailable");assert.ok(value.items[0].message);
 }
});
test("参考稿须匹配Core固定批次摘要，交付须核验实际文件",async()=>{
 const task_ref={task_id:"task",sha256:"request-fixed"},submission_ref={submission_id:"submission",sha256:"fixed"};
 const candidate=tool("hetu.creative_tasks.submit_result",{task_ref,submission_ref});
 const value=await readSessionResults([candidate],work,async(_,input)=>{
  assert.equal(input.submission_id,"submission");assert.deepEqual(input.task_ref,{task_id:"task"});return {request_sha256:"request-fixed",request:{brief:"返工稿",input_snapshot:{scope_context:{work_ref:work}}},observation:{submission_refs:[submission_ref]},submission:{submission_id:"submission"}};
 });assert.equal(value.items[0].state,"verified");
 const failed=await readSessionResults([tool("hetu.bundles.export",{bundle_id:"bundle",sha256:"fixed"})],work,async()=>({verified:true,sha256:"other"}));
 assert.equal(failed.items[0].state,"unavailable");
});
test("资料修改使用实际update动作回读固定修订，沿原资料入口打开",async()=>{
 const value=await readSessionResults([tool("hetu.resources.update",{resource:{resource_id:"resource",revision:2},sha256:"fixed"})],work,async(action,input)=>{
  assert.equal(action,"hetu.resources.get");assert.deepEqual(input,{resource_id:"resource",revision:2});return {resource:{resource_id:"resource",revision:2,work_ref:work,title:"更新的资料"},sha256:"fixed"};
 });
 assert.equal(value.items[0].state,"verified");assert.equal(value.items[0].kind,"resource");assert.equal(value.items[0].title,"更新的资料");
});
test("新作品成果只取本客户端已登记且Core核验的身份，忽略回执中的路径和名称",()=>{
 const receipt=tool("hetu.creation_projects.create_novel",{created_workspace_ref:{workspace_id:work.workspace_id,novel_id:work.object_id},target_path:"/untrusted/path",novel:{metadata:{title:"回执伪标题"}}});
 const actual=[{work_ref:work,title:"Core当前作品名称"}];
 assert.equal(readLibrarySessionResults([receipt],actual,new Set()).items.length,0);
 const value=readLibrarySessionResults([receipt],actual,new Set([work.workspace_id]));assert.equal(value.items[0].title,"Core当前作品名称");assert.equal(value.items[0].state,"verified");assert.doesNotMatch(JSON.stringify(value),/untrusted|回执伪标题/);
 assert.equal(readLibrarySessionResults([receipt],[{...actual[0],unavailable:true}],new Set([work.workspace_id])).items[0].state,"unavailable");
});
