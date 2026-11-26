import test from "node:test";
import assert from "node:assert/strict";
import {prepareAgentContext,verifyAgentContexts} from "../src/main/agent/fixed-context.ts";
import {validateContextRefs} from "../src/agent-context.ts";
import {taskSourceContext,pluginSourceContext} from "../src/main/agent/source-context.ts";
import {TaskReview} from "../src/main/task-review.ts";
import {RecoveryStore} from "../src/main/recovery.ts";
import type {WorkRef} from "@hetu/plugin-sdk";
const work:WorkRef={workspace_id:"workspace-context",kind:"novel",object_id:"novel-context"};

test("上下文拒绝私有字段但不把小说里的password字样误判为凭据",()=>{
 const content={label:"固定原文",reference:{quote:"他将password写在纸上。"}};
 assert.deepEqual(validateContextRefs([content]),[content]);
 for(const key of ["management_ref","workspace_management_ref","api_key","authorization","workspace_path","file_path"]){
  assert.throws(()=>validateContextRefs([{label:"来源",reference:{source:[{[key]:"private"}]}}]),/不能包含/);
 }
 assert.throws(()=>validateContextRefs([{label:"来源",reference:{quote:"文".repeat(22000)}}]),/超过预算/);
});
test("附加文稿固定真实修订和摘要，作品改名不使历史章节失效",async()=>{
 let titleRevision=1,head="chapter-old";
 const handoff=async(_:string,object:Record<string,unknown>)=>({fixed_refs:[{kind:"work",fixed_ref:{revision:titleRevision}},{kind:"document",document_id:"document",revision_id:object.revision_id??head,sha256:"sha-old"},{kind:"blueprint",revision:2,sha256:"blueprint-sha"}]});
 const context=await prepareAgentContext({page:"novel.reader",object:{document_id:"document"},label:"第一章"},work,handoff);
 assert.equal((context.reference.object_ref as any).revision_id,"chapter-old");assert.equal((context.reference.object_ref as any).blueprint_revision,2);
 titleRevision=2;head="chapter-new";
 assert.deepEqual(await verifyAgentContexts([context],work,handoff),[context]);
 await assert.rejects(verifyAgentContexts([context],{...work,object_id:"other"},handoff),/不属于当前作品/);
 await assert.rejects(verifyAgentContexts([context],work,async()=>({fixed_refs:[{kind:"document",document_id:"document",revision_id:"chapter-new",sha256:"new"}]})),/暂时无法核对/);
});
test("作品上下文保留实际来源覆盖，旧资料变化必须明确修复而非静默替换",async()=>{
 let revision=1;
 const handoff=async()=>({fixed_refs:[{kind:"work",fixed_ref:{revision}},{kind:"blueprint",revision:2,sha256:"blueprint-sha"}]});
 const context=await prepareAgentContext({page:"work.profile"},work,handoff);
 assert.deepEqual(await verifyAgentContexts([context],work,handoff),[context]);
 revision=2;await assert.rejects(verifyAgentContexts([context],work,handoff),/作品资料.*暂时无法核对/);
 await assert.rejects(prepareAgentContext({page:"not-a-page"},work,handoff),/尚不支持/);
 await assert.rejects(prepareAgentContext({page:"novel.reader",object:{document_id:"missing"}},work,async()=>({fixed_refs:[{kind:"work"}]})),/没有可附加/);
});

test("正式大纲按条目和旧修订固定，不随作品资料或同名新条目替换",async()=>{
 let head=1,workRevision=1;
 const handoff=async(_:string,object:Record<string,unknown>)=>{
  const revision=object.outline_revision??head;
  if(object.outline_sha256&&object.outline_sha256!==`outline-sha-${revision}`)throw Error("摘要不一致");
  return {fixed_refs:[{kind:"work",fixed_ref:{revision:workRevision}},{kind:"outline",work_ref:work,outline_id:object.outline_id,revision,sha256:`outline-sha-${revision}`}]};
 };
 const context=await prepareAgentContext({page:"novel.outlines",object:{outline_id:"outline-first"},label:"同名章纲"},work,handoff);
 assert.equal(context.reference.fixed_refs[0].kind,"outline");assert.equal(context.reference.fixed_refs.length,1);
 assert.deepEqual(context.reference.object_ref,{outline_id:"outline-first",outline_revision:1,outline_sha256:"outline-sha-1"});
 head=2;workRevision=2;assert.deepEqual(await verifyAgentContexts([context],work,handoff),[context]);
 const damaged=structuredClone(context);(damaged.reference.object_ref as any).outline_sha256="wrong";
 await assert.rejects(verifyAgentContexts([damaged],work,handoff),/摘要不一致/);
});

test("整份设定与具体文稿排除无关小说资料，旧引用保留原覆盖",async()=>{
 let metadata=1;
 const handoff=async(kind:string,object:Record<string,unknown>)=>({fixed_refs:[{kind:"work",fixed_ref:{revision:metadata}},
  ...(kind==="bible"?[{kind:"blueprint",revision:object.blueprint_revision??2,sha256:"canon-sha"}]:[{kind:"document",document_id:object.document_id,revision_id:object.revision_id??"old",sha256:"doc-sha"},{kind:"novel",revision:metadata,sha256:`metadata-${metadata}`}])]});
 const canon=await prepareAgentContext({page:"work.canon",object:{blueprint_revision:2}},work,handoff);
 assert.deepEqual(canon.reference.fixed_refs,[{kind:"blueprint",revision:2,sha256:"canon-sha"}]);
 const document=await prepareAgentContext({page:"novel.reader",object:{document_id:"doc"}},work,handoff);
 assert.equal(document.reference.fixed_refs.length,1);assert.equal(document.reference.fixed_refs[0].kind,"document");
 const legacy=structuredClone(document);legacy.reference.fixed_refs.push({kind:"novel",revision:1,sha256:"metadata-1"});
 assert.deepEqual(await verifyAgentContexts([legacy],work,handoff),[legacy]);
 metadata=2;assert.deepEqual(await verifyAgentContexts([canon,document],work,handoff),[canon,document]);
 await assert.rejects(verifyAgentContexts([legacy],work,handoff),/固定来源已变化/);
});

test("任务上下文固定旧批次和公开意见，拒绝异作、关闭任务及换入的意见",async()=>{
 const task_ref={scope_ref:{kind:"workspace",id:work.workspace_id},task_id:"task-context",request_revision:1};
 const first={feedback_id:"feedback-first",sha256:"a".repeat(64)},second={feedback_id:"feedback-next",sha256:"b".repeat(64)};
 let submission="first",feedback=first,owner=work,closed=false;
 const read=async(action:string,input:Record<string,any>)=>{
  if(action==="hetu.task_feedback.list"){
   assert.equal(input.limit,1);assert.equal(input.result_path,"/feedback/0/feedback_ref");assert.equal(input.max_bytes,1024);
   return {feedback_page:{value:[first,second].find(ref=>JSON.stringify(ref)===JSON.stringify(input.feedback_ref))}};
  }
  assert.equal(input.detail,"review");
  const id=input.submission_id??submission;
  return {request:{...task_ref,input_snapshot:{scope_context:{work_ref:owner}}},request_sha256:"c".repeat(64),observation:{state:closed?"closed":"ready",submission_refs:[{submission_id:"first",sha256:"d".repeat(64)},{submission_id:"second",sha256:"e".repeat(64)}]},submission:{submission_id:id},submission_ref:{submission_id:id,sha256:(id==="first"?"d":"e").repeat(64)},feedback_head:feedback};
 };
 const handoff=(_:string,input:Record<string,unknown>)=>taskSourceContext(work,input,read);
 const context=await prepareAgentContext({page:"work.tasks",object:{task_ref}},work,handoff);
 assert.equal((context.reference.object_ref as any).submission_id,"first");assert.deepEqual((context.reference.object_ref as any).feedback_ref,first);
 submission="second";feedback=second;
 assert.deepEqual(await verifyAgentContexts([context],work,handoff),[context]);
 owner={...work,object_id:"foreign"};await assert.rejects(verifyAgentContexts([context],work,handoff),/不属于当前作品/);owner=work;
 closed=true;await assert.rejects(verifyAgentContexts([context],work,handoff),/任务已关闭/);closed=false;
 await assert.rejects(taskSourceContext(work,{task_ref,feedback_ref:{...first,sha256:"0".repeat(64)}},read),/没有这条固定公开意见/);
 const bareHandoff=async(_:string,input:Record<string,unknown>)=>taskSourceContext(work,input,async(action,request)=>{
  const value=await read(action,request);
  return action==="hetu.creative_tasks.get"?{...value,submission:null,feedback_head:null}:value;
 });
 const bare=await prepareAgentContext({page:"work.tasks",object:{task_ref}},work,bareHandoff);
 assert.deepEqual((bare.reference.object_ref as any).feedback_ref,null);
 assert.deepEqual(await verifyAgentContexts([bare],work,handoff),[bare]);
});

test("专业固定来源只读原修订，Owner、作品、摘要和多余输入各自核验",async()=>{
 const object={owner_plugin_id:"plugin-a",object_id:"object-a",revision:1,sha256:"a".repeat(64)};
 const result={object:{work_ref:work,...object},sha256:object.sha256};
 const handoff=(_:string,input:Record<string,unknown>)=>pluginSourceContext(work,input,async()=>result);
 const context=await prepareAgentContext({page:"plugin.results",object},work,handoff);
 assert.deepEqual(await verifyAgentContexts([context],work,handoff),[context]);
 for(const changed of [{object:{...result.object,owner_plugin_id:"other"}},{object:{...result.object,work_ref:{...work,object_id:"foreign"}}},{sha256:"b".repeat(64)}])
  await assert.rejects(pluginSourceContext(work,object,async()=>({...result,...changed})),/版本、摘要或作品不一致/);
 await assert.rejects(pluginSourceContext(work,{...object,package_path:"private"},async()=>result),/不支持的来源字段/);
});

test("历史意见继续只读核对原请求和确切引用，任务关闭、错摘要与迟到响应不产生交接",async()=>{
 const task_ref={scope_ref:{kind:"workspace",id:work.workspace_id},task_id:"task-continuation",request_revision:1 as const};
 const feedback_ref={feedback_id:"feedback-original",sha256:"f".repeat(64)},reads:string[]=[];
 let active=true,closed=false,hold=false,release:()=>void=()=>{};
 const review=new TaskReview(work,"/unused-continuation-journal",new RecoveryStore(),async(action,input:any)=>{
  reads.push(action);
  if(action==="hetu.creative_tasks.list")return {status:"succeeded",data:{tasks:[{work_ref:work,task_ref}]}};
  if(action==="hetu.creative_tasks.get")return {status:"succeeded",data:{request:{...task_ref,input_snapshot:{scope_context:{work_ref:work}}},request_sha256:"c".repeat(64),observation:{state:closed?"closed":"ready",submission_refs:[]},submission:null,feedback_head:{feedback_id:"feedback-newer",sha256:"a".repeat(64)}}};
  assert.equal(action,"hetu.task_feedback.list");assert.deepEqual(input.feedback_ref,feedback_ref);assert.equal(input.result_path,"/feedback/0/feedback_ref");
  if(hold)await new Promise<void>(resolve=>{release=resolve;});
  return {status:"succeeded",data:{feedback_page:{value:feedback_ref}}};
 },()=>active);
 await assert.rejects(review.continuation(task_ref,{feedback_ref}),/任务目录/);
 await review.list();const prepared=await review.continuation(task_ref,{feedback_ref});
 assert.equal(prepared.work_ref,work);assert.ok(prepared.prompt.includes(feedback_ref.feedback_id));assert.ok(prepared.prompt.includes("c".repeat(64)));assert.ok(!prepared.prompt.includes("feedback-newer"));
 assert.deepEqual(prepared.fixed_refs.map(item=>item.kind),["task_request","task_feedback"]);assert.ok(reads.every(action=>action.endsWith(".list")||action.endsWith(".get")));
 closed=true;await assert.rejects(review.continuation(task_ref,{feedback_ref}),/任务已关闭/);closed=false;
 hold=true;const pending=review.continuation(task_ref,{feedback_ref});
 await new Promise<void>(resolve=>setImmediate(resolve));active=false;release();await assert.rejects(pending,/上下文已结束/);
});
