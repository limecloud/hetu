import test from "node:test";
import assert from "node:assert/strict";
import type {AgentTool} from "../src/agent-session-contract.ts";
import {readSessionResults,readLibrarySessionResults,readBotSessionResults} from "../src/main/agent/session-results.ts";
const work={workspace_id:"workspace",kind:"novel" as const,object_id:"novel"};
const tool=(action:string,data:any,server="hetu"):AgentTool=>({id:"tool",turn_id:"turn",kind:"mcpToolCall",title:"test",server,state:"completed",output:JSON.stringify({structuredContent:{action,status:"succeeded",data}})});
const reference={document_id:"doc",revision_id:"revision",sha256:"sha"};
const botRef={bot_id:"bot_00000000-0000-4000-8000-000000000001",revision:1,sha256:"a".repeat(64)};
const botIdentity={session_id:"terminal-00000000-0000-4000-8000-000000000001",bot_ref:botRef,generation:7,client:"generic",work_ref:work};
const botDescriptor={session_id:botIdentity.session_id,client:"generic",bot_ref:botRef,bot:{status:"paused",work_ref:work,config:{name:"固定助手",purpose:"核对当前稿，保留作者意见。",execution:{provider_id:"kilo",surface:"gui",model_id:"fixed"}}}};
const botConversation={session_id:botIdentity.session_id,client:"kilo",bot_ref:botRef,generation:7,work_ref:work,conversation:{tools:[],receipts:[tool("hetu.documents.create",{document:{document_id:"doc"},revision:{document_id:"doc",revision_id:"revision",sha256:"sha"}})],total_tools:0,total_receipts:3,receipts_complete:false}};

test("Bot停用后仍从原会话真实回执核对固定成果，省略回执保持待核对",async()=>{
 const calls:any[]=[];
 const result=await readBotSessionResults(botIdentity,async input=>{calls.push(input);return input.method==="session_get"?botDescriptor:botConversation;},async(tools,provider)=>{
  assert.equal(provider,"kilo");return readSessionResults(tools,work,async(action,input)=>{assert.equal(action,"hetu.documents.get");assert.deepEqual(input,{document_id:"doc",revision_id:"revision"});return {work_ref:work,document:{document_id:"doc",title:"Core固定稿",current_revision_id:"newer"},revision:{document_id:"doc",revision_id:"revision",sha256:"sha"}};});
 });
 assert.deepEqual(calls,[{method:"session_get",session_id:botIdentity.session_id,work_ref:work},{method:"session_read",session_id:botIdentity.session_id,generation:7,format:"conversation",work_ref:work}]);
 assert.equal(result.items[0].title,"Core固定稿");assert.equal(result.items[0].state,"verified");assert.match(result.items[0].message!,/已有更新/);assert.equal(result.unread,2);
});

test("Bot成果拒绝错误原配置、客户端、作品及迟到会话，不回退普通会话或最新稿",async()=>{
 const descriptions=[{...botDescriptor,client:"codex"},{...botDescriptor,bot_ref:{...botRef,revision:2}},{...botDescriptor,bot:{...botDescriptor.bot,work_ref:{...work,object_id:"other"}}},{...botDescriptor,bot:{...botDescriptor.bot,config:{...botDescriptor.bot.config,name:""}}}];
 const views=[{...botConversation,session_id:"other"},{...botConversation,generation:8},{...botConversation,client:"opencode"},{...botConversation,bot_ref:{...botRef,revision:2}},{...botConversation,work_ref:{...work,object_id:"other"}},{...botConversation,conversation:undefined}];
 for(const [description,view]of [...descriptions.map(value=>[value,botConversation]),...views.map(value=>[botDescriptor,value])]){
  let verified=false;await assert.rejects(readBotSessionResults(botIdentity,async input=>input.method==="session_get"?description:view,async()=>{verified=true;return {items:[],unread:0};}),/原Bot/);assert.equal(verified,false);
 }
 await assert.rejects(readBotSessionResults(botIdentity,async()=>{throw Error("原作品已撤权");},async()=>{throw Error("不能回退");}),/撤权/);
});
test("保存回执必须独立回读Core；读操作和其他MCP不能伪装写入成果",async()=>{
 let reads=0;
 const data={document:{document_id:"doc"},revision:{document_id:"doc",revision_id:"revision",sha256:"sha"}};
 const value=await readSessionResults([tool("hetu.documents.create",data),tool("hetu.documents.get",data),tool("hetu.documents.create",data,"other")],work,async(action,input)=>{
  reads++;assert.equal(action,"hetu.documents.get");assert.deepEqual(input,{document_id:"doc",revision_id:"revision"});
  return {work_ref:work,document:{document_id:"doc",title:"雨夜",current_revision_id:"newer"},revision:{document_id:"doc",revision_id:"revision",sha256:"sha"}};
 });
 assert.equal(reads,1);assert.equal(value.items.length,1);assert.equal(value.items[0].state,"verified");assert.deepEqual(value.items[0].reference,reference);assert.match(value.items[0].message!,/已有更新/);
});
test("错作品、伪造摘要、撤权和Core读取失败保留待核对，不产生可打开成果",async()=>{
 const data={document:{document_id:"doc"},revision:{document_id:"doc",revision_id:"revision",sha256:"sha"}};
 const actual={work_ref:work,document:{document_id:"doc"},revision:{document_id:"doc",revision_id:"revision",sha256:"sha"}};
 for(const result of [
  {...actual,work_ref:{...work,object_id:"other"}},
  {...actual,work_ref:null},
  {...actual,work_ref:undefined,document:{...actual.document,work_ref:work}},
  {...actual,document:{document_id:"other"}},
  {...actual,revision:{...actual.revision,document_id:"other"}},
  {...actual,revision:{...actual.revision,revision_id:"newer"}},
  {...actual,revision:{...actual.revision,sha256:"wrong"}},
  undefined,
 ]){
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

const videoWork={...work,kind:"video" as const,object_id:"video"};
const videoRef={media_id:"old-media",revision:1,sha256:"fixed-video"};
const videoData={media:{work_ref:videoWork,video_episode_id:"episode",media_id:videoRef.media_id,revision:1,title:"Core原视频"},media_ref:videoRef,sha256:videoRef.sha256};
const pluginRef={owner_plugin_id:"org.hetu.video",object_id:"edit",revision:1,sha256:"fixed-edit"};
const pluginData={object:{work_ref:videoWork,...pluginRef,title:"Core原剪辑"},sha256:pluginRef.sha256};
const receipt=(action:string,data:any,status="succeeded")=>({action,data,status});
const wrapped=(value:any):AgentTool=>({...tool("unused",{}),output:JSON.stringify({structuredContent:value})});
const pluginReceipt=(result:any,effect="managed_write")=>receipt("hetu.plugins.invoke",{format_version:1,plugin_id:pluginRef.owner_plugin_id,invocation:{action:"save_edit",effect},result});

test("统一初始化和集中执行的新建成果沿已登记身份核验，失败与普通读取不能冒充新建",()=>{
 const actual=[{work_ref:work,title:"Core新作品"}],ids=new Set([work.workspace_id]);
 const workspace={workspace_id:work.workspace_id,work_type:"novel",title:"忽略回执标题"};
 const result={...receipt("hetu.workspaces.get",{workspace}),context:{scope_id:work.workspace_id}};
 const initialization=receipt("hetu.execution.initialize",{result});
 for(const value of [initialization,receipt("hetu.execution.execute",{results:[initialization]})]){
  const saved=readLibrarySessionResults([wrapped(value)],actual,ids);assert.equal(saved.items.length,1);assert.equal(saved.items[0].title,"Core新作品");assert.deepEqual(saved.items[0].work_ref,work);
  assert.equal(readLibrarySessionResults([wrapped(value)],actual,new Set()).items.length,0);
 }
 for(const value of [result,receipt("hetu.execution.initialize",{result:{...result,status:"blocked"}}),receipt("hetu.execution.initialize",{result:{...result,context:{scope_id:"other"}}}),receipt("hetu.execution.initialize",{result},"pending"),receipt("hetu.execution.initialize",{result},"unknown")])assert.equal(readLibrarySessionResults([wrapped(value)],actual,ids).items.length,0);
 assert.equal(readLibrarySessionResults([wrapped(initialization)],[...actual,{work_ref:{...work,object_id:"other"},title:"同根另一作品"}],ids).items.length,0,"初始化回执不猜测同类型多个对象中的目标");
});

test("统一执行与插件保存同一批多成果，逐个回读固定版本且不按tool ID或标题覆盖",async()=>{
 const saved=receipt("hetu.execution.execute",{results:[
  receipt("hetu.video.media.save",videoData),
  pluginReceipt({spec_version:"0.2.1",status:"succeeded",data:pluginData}),
  receipt("hetu.video.media.save",videoData),
 ]});
 const reads:string[]=[];
 const result=await readSessionResults([wrapped(saved)],videoWork,async(action,input)=>{
  reads.push(action);
  if(action==="hetu.video.media.get"){assert.deepEqual(input,{work_ref:videoWork,media_ref:videoRef});return videoData;}
  assert.equal(action,"hetu.plugin_results.get");const {sha256,...fixed}=pluginRef;assert.deepEqual(input,{work_ref:videoWork,...fixed});return pluginData;
 });
 assert.deepEqual(reads,["hetu.video.media.get","hetu.plugin_results.get"]);assert.equal(result.items.length,2);
 assert.equal(new Set(result.items.map(item=>item.id)).size,2);assert.ok(result.items.every(item=>item.state==="verified"));
 assert.deepEqual(result.items[0].reference,{video_episode_id:"episode",media_ref:videoRef});assert.deepEqual(result.items[1].reference,pluginRef);
 assert.deepEqual(result.items.map(item=>item.title),["Core原视频","Core原剪辑"]);
});
test("auto统一执行保留内层Core和插件动作；只读及unknown内层均不产生保存成果",async()=>{
 const doc={document:{document_id:"doc"},revision:{document_id:"doc",revision_id:"revision",sha256:"sha"}};
 const values=[
  receipt("hetu.execution.invoke",{result:receipt("hetu.documents.create",doc)}),
  receipt("hetu.execution.invoke",{result:pluginReceipt(receipt("hetu.extensions.objects.save",pluginData))}),
  receipt("hetu.execution.invoke",{result:pluginReceipt({status:"succeeded",data:pluginData},"read")}),
  receipt("hetu.execution.invoke",{result:pluginReceipt({status:"pending",data:pluginData})}),
  receipt("hetu.execution.invoke",{result:receipt("hetu.documents.create",doc,"failed")}),
  receipt("hetu.execution.get_plan",{results:[receipt("hetu.documents.create",doc)]}),
  receipt("hetu.video.media.get",videoData),
 ];
 let count=0;
 const result=await readSessionResults(values.map(wrapped),videoWork,async(action)=>{
  count++;return action==="hetu.plugin_results.get"?pluginData:{work_ref:videoWork,document:{document_id:"doc",title:"固定稿",current_revision_id:"revision"},revision:doc.revision};
 });
 assert.equal(count,2);assert.equal(result.items.length,2);assert.ok(result.items.every(item=>item.state==="verified"));
});
test("视频回读拒绝同根他作、错误分集、媒体身份、修订、摘要及撤权，不读取最新替代",async()=>{
 const variants=[
  {...videoData,media:{...videoData.media,work_ref:{...videoWork,object_id:"other-video"}}},
  {...videoData,media:{...videoData.media,video_episode_id:"other-episode"}},
  {...videoData,media:{...videoData.media,media_id:"newest-media"}},
  {...videoData,media:{...videoData.media,revision:2}},
  {...videoData,sha256:"wrong"},
  {...videoData,media_ref:{...videoRef,media_id:"newest-media"}},
  undefined,
 ];
 for(const value of variants){
  let reads=0;
  const result=await readSessionResults([tool("hetu.video.media.save",videoData)],videoWork,async()=>{reads++;if(!value)throw Error("当前作品的连接已撤回");return value;});
  assert.equal(reads,1);assert.equal(result.items[0].state,"unavailable");assert.ok(result.items[0].message);assert.deepEqual(result.items[0].reference.media_ref,videoRef);
 }
});
test("专业成果固定Owner和历史，停用不启动插件；错误Owner、身份、修订及摘要不可打开",async()=>{
 for(const object of [{...pluginData.object,owner_plugin_id:"org.hetu.other"},{...pluginData.object,object_id:"other"},{...pluginData.object,revision:2},{...pluginData.object,work_ref:work}]){
  const result=await readSessionResults([wrapped(pluginReceipt({status:"succeeded",data:pluginData}))],videoWork,async(action)=>{
   assert.equal(action,"hetu.plugin_results.get");return {object,sha256:pluginRef.sha256};
  });assert.equal(result.items[0].state,"unavailable");
 }
 const forged={...pluginData,object:{...pluginData.object,owner_plugin_id:"org.hetu.other"}};
 const ignored=await readSessionResults([wrapped(pluginReceipt({status:"succeeded",data:forged}))],videoWork,async()=>{throw Error("不应调用插件");});assert.equal(ignored.items.length,0);
 const badSha=await readSessionResults([wrapped(pluginReceipt({status:"succeeded",data:pluginData}))],videoWork,async()=>({...pluginData,sha256:"wrong"}));assert.equal(badSha.items[0].state,"unavailable");
});
test("有界成果读取保留不同固定媒体，多次保存去重，摘要回执只显示未完整读取",async()=>{
 const tools=Array.from({length:14},(_,i)=>tool("hetu.video.media.save",{...videoData,media_ref:{...videoRef,media_id:`media-${i}`}}));
 const summary=wrapped({...receipt("hetu.execution.invoke",{}),response:{read:{action:"hetu.collaboration.invoke",input:{}}}});
 let reads=0;
 const result=await readSessionResults([...tools,tools.at(-1)!,summary],videoWork,async(_,input)=>{reads++;return {...videoData,media:{...videoData.media,media_id:(input.media_ref as any).media_id},media_ref:input.media_ref};});
 assert.equal(reads,12);assert.equal(result.items.length,12);assert.equal(result.unread,3);assert.ok(result.items.every(item=>item.state==="verified"));
});

test("原计划查询须经Core重验，恢复实际成功步骤的固定成果并忽略回执内伪造条目",async()=>{
 const plan_ref={plan_id:"execution_00000000-0000-4000-8000-000000000001",sha256:"a".repeat(64)},document={document:{document_id:"doc"},revision:{document_id:"doc",revision_id:"revision",sha256:"c".repeat(64)}};
 const plan={...plan_ref,state:"blocked",fixed:{workspace_identity:{kind:"workspace",id:work.workspace_id},commands:[{action:"hetu.documents.create"},{action:"hetu.documents.save"}]},results:[receipt("hetu.documents.create",document)]};
 const fromChat={...plan,results:[receipt("hetu.documents.create",{document:{document_id:"forged"},revision:{revision_id:"forged",sha256:"f".repeat(64)}})]},reads:string[]=[];
 const result=await readSessionResults([wrapped(receipt("hetu.execution.get_plan",fromChat)),wrapped(receipt("hetu.execution.get_plan",fromChat))],work,async(action,input)=>{
  reads.push(action);
  if(action==="hetu.execution.get_plan"){assert.deepEqual(input,{plan_ref});return plan;}
  assert.equal(action,"hetu.documents.get");assert.deepEqual(input,{document_id:"doc",revision_id:"revision"});return {work_ref:work,document:{document_id:"doc",title:"原计划创建的稿件",current_revision_id:"revision"},revision:document.revision};
 });
 assert.deepEqual(reads,["hetu.execution.get_plan","hetu.documents.get"]);assert.equal(result.items.length,1);assert.equal(result.items[0].state,"verified");assert.equal(result.items[0].title,"原计划创建的稿件");assert.match(result.items[0].message!,/原计划/);
});

test("原计划未执行、错范围、错摘要、错位步骤与撤权均不能成为可打开成果",async()=>{
 const ref={plan_id:"execution_00000000-0000-4000-8000-000000000001",sha256:"a".repeat(64)},document={document:{document_id:"doc"},revision:{document_id:"doc",revision_id:"revision",sha256:"c".repeat(64)}};
 const plan={...ref,state:"completed",fixed:{workspace_identity:{kind:"workspace",id:work.workspace_id},commands:[{action:"hetu.documents.create"}]},results:[receipt("hetu.documents.create",document)]};
 const variants=[
  {...plan,state:"prepared",results:[]},
  {...plan,state:"confirmed",results:[]},
  {...plan,fixed:{...plan.fixed,workspace_identity:{kind:"workspace",id:"other"}}},
  {...plan,sha256:"b".repeat(64)},
  {...plan,plan_id:"execution_00000000-0000-4000-8000-000000000002"},
  {...plan,results:[receipt("hetu.documents.save",document)]},
  {...plan,results:[receipt("hetu.documents.create",document,"pending")]},
  {...plan,results:[]},
  {...plan,state:"blocked"},
  {...plan,fixed:{...plan.fixed,commands:Array(101).fill({action:"hetu.documents.create"})}},
  undefined,
 ];
 for(const actual of variants){
  let planReads=0;
  const result=await readSessionResults([wrapped(receipt("hetu.execution.get_plan",plan))],work,async action=>{assert.equal(action,"hetu.execution.get_plan");planReads++;if(!actual)throw Error("当前客户端无权读取该原计划");return actual;});
  assert.equal(planReads,1);assert.equal(result.items.length,0);
 }
 const unread=await readSessionResults([wrapped(receipt("hetu.execution.get_plan",plan))],work,async action=>{if(action==="hetu.execution.get_plan")return plan;throw Error("原文稿访问已撤回");});
 assert.equal(unread.items[0].state,"unavailable");assert.match(unread.items[0].message!,/撤回/);
});

test("原计划恢复只回读成功前缀，部分结果不标保存并保持读取预算",async()=>{
 const reference={plan_id:"execution_00000000-0000-4000-8000-000000000001",sha256:"a".repeat(64)},document={document:{document_id:"doc"},revision:{document_id:"doc",revision_id:"revision",sha256:"c".repeat(64)}};
 const plan={...reference,state:"executing",fixed:{workspace_identity:{kind:"workspace",id:work.workspace_id},commands:[{action:"hetu.documents.create"},{action:"hetu.documents.save"},{action:"hetu.documents.save"}]},results:[receipt("hetu.documents.create",document),receipt("hetu.documents.save",document,"partial")]};
 const before=structuredClone(plan),result=await readSessionResults([wrapped(receipt("hetu.execution.get_plan",plan))],work,async action=>action==="hetu.execution.get_plan"?plan:{work_ref:work,document:{document_id:"doc",title:"成功步骤",current_revision_id:"revision"},revision:document.revision});
 assert.equal(result.items.length,1);assert.equal(result.items[0].state,"verified");assert.equal(result.unread,1);assert.deepEqual(plan,before);
 let count=0;
 const queries=Array.from({length:14},(_,i)=>wrapped(receipt("hetu.execution.get_plan",{...reference,plan_id:`execution_00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`})));
 const bounded=await readSessionResults(queries,work,async action=>{assert.equal(action,"hetu.execution.get_plan");count++;throw Error("隔离验收：只计读取调用");});
 assert.equal(count,12);assert.equal(bounded.items.length,0);assert.equal(bounded.unread,14);
});
