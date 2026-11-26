import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readdir} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {AppServer} from "../../../apps/desktop/src/main/rpc.ts";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";

const root=path.resolve(import.meta.dirname,"../../..");
const resources=process.env.HETU_WORKSPACE_TEST_RESOURCES;
const binary=(name:string)=>path.join(resources??path.join(root,"target/debug"),resources?"bin":"",name+(process.platform==="win32"?".exe":""));
const manager=resources?path.join(resources,"app/dist/plugin-manager.mjs"):path.join(root,"apps/desktop/dist/plugin-manager.mjs");
test("当前工作区无需管理授权使用插件，confirm按实际动作分类且集中计划保留原键与Agent身份",{timeout:180000},async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),"hetu-workspace-plugin-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile");
  const env={...process.env,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"settings"),HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),
    HETU_PLUGIN_STATE_DIR:path.join(profile,"plugins"),HETU_PLUGIN_NODE:process.execPath,HETU_PLUGIN_MANAGER:manager};
  const call=(action:string,input:any={},client="codex")=>{
    const result=spawnSync(binary("hetu"),["--client",client,"call",action,"--input","-"],{env,input:JSON.stringify(input),encoding:"utf8",timeout:60000,maxBuffer:4*1024*1024});
    assert.ok(result.stdout,result.stderr);return JSON.parse(result.stdout);
  };
  const ok=(result:any)=>{assert.equal(result.status,"succeeded",JSON.stringify(result));return result.data;};
  const command=(action:string,input:any={})=>({action,contract_revision:"1",input});
  const execute=(action:string,input:any={},client="codex")=>call("hetu.execution.invoke",{workspace_path:workspace,command:command(action,input)},client);
  const data=(action:string,input:any={})=>ok(ok(execute(action,input)).result);
  ok(call("hetu.execution.initialize",{workspace_path:workspace,create:{title:"工作区专业接入",locale:"zh-CN",operation_key:"init"}}));
  const work=data("hetu.works.list").works[0].work_ref;
  const document=data("hetu.documents.create",{kind:"novel_chapter",title:"雾港",source_format:"markdown",content:"江岚守着灯塔。🌿",operation_key:"document"});
  const other=data("hetu.drama.projects.create",{title:"同根另一作品",mode:"original",operation_key:"drama"});
  const otherWork={workspace_id:work.workspace_id,kind:"drama",object_id:other.project.project_id};
  const project=data("hetu.drama.projects.get",{project_id:other.project.project_id});
  const episode=data("hetu.drama.episodes.create",{project_ref:{project_id:project.project.project_id,revision:project.project.revision,sha256:project.sha256},title:"另一作品分集",language_tag:"zh-CN",operation_key:"episode"});
  const pkg=ok(call("hetu.plugins.inspect_package",{package_directory:path.join(root,"plugins/relationships/dist")}));
  ok(call("hetu.plugins.apply",{action:"install",package_directory:path.join(root,"plugins/relationships/dist"),package_sha256:pkg.package_sha256,
    expected_sha256:ok(call("hetu.plugins.inspect")).state_sha256,authorization_note:"隔离测试明确选择随包关系图",operation_key:"install"}));
  const binding={work_ref:work,plugin_id:pkg.manifest.id,package_sha256:pkg.package_sha256};
  const cap=data("hetu.plugins.capabilities",binding);
  const invocation=(action:string,input:any)=>({...binding,capabilities_sha256:cap.capabilities_sha256,action,arguments:input});
  const source=invocation("hetu.documents.get",{document_id:document.document.document_id,revision_id:document.revision.revision_id});
  assert.equal(data("hetu.plugins.invoke",source).result.data.content,"江岚守着灯塔。🌿");
  const foreign=execute("hetu.plugins.invoke",invocation("hetu.documents.get",{document_id:episode.document.document_id}));
  assert.equal(foreign.error.code,"forbidden");
  const save=invocation("hetu.extensions.objects.save",{kind:"relationships",title:"固定规划",schema_version:"1",content:{nodes:[{id:"jianglan",label:"江岚",x:0,y:0}],edges:[]},
    source_refs:[{kind:"document",work_ref:work,document_id:document.document.document_id,revision_id:document.revision.revision_id,sha256:document.revision.sha256}],expected_revision:0,expected_sha256:"",operation_key:"save-once"});
  const oldSettings=process.env.HETU_LOCAL_SETTINGS_DIR;process.env.HETU_LOCAL_SETTINGS_DIR=env.HETU_LOCAL_SETTINGS_DIR;
  let local:AppServer;
  try{local=await AppServer.open(binary("hetu-app-server"));}
  finally{if(oldSettings===undefined)delete process.env.HETU_LOCAL_SETTINGS_DIR;else process.env.HETU_LOCAL_SETTINGS_DIR=oldSettings;}
  const machine=new Client({name:"hetu-workspace-plugin",version:"1"},{});
  const mcp=async(action:string,input:any)=>{
    const result=await machine.callTool({name:"hetu_call_action",arguments:{action:"hetu.execution.invoke",input:{workspace_path:workspace,command:command(action,input)}}});
    return result.structuredContent as any;
  };
  try{
    await machine.connect(new StdioClientTransport({command:binary("hetu-mcp"),args:["--client","codex","--collaboration-dir",env.HETU_COLLABORATION_DIR],env,stderr:"pipe"}));
    assert.equal(ok(ok(await mcp("hetu.plugins.invoke",source)).result).result.data.content,"江岚守着灯塔。🌿");
    const mcpSaved=ok(ok(await mcp("hetu.plugins.invoke",{...save,arguments:{...save.arguments,title:"MCP固定规划",operation_key:"mcp-auto-save"}})).result).result.data;
    assert.equal(mcpSaved.object.owner_plugin_id,pkg.manifest.id);
    const state=await local.request("local_settings/host",{method:"preferences",input:{}});
    await local.request("local_settings/host",{method:"update",input:{expected_revision:state.revision,patch:{execution_mode:"confirm"},operation_key:"confirm-mode"}});
    assert.equal(data("hetu.plugins.invoke",source).result.data.content,"江岚守着灯塔。🌿");
    assert.equal(execute("hetu.plugins.invoke",save).error.code,"hetu.execution_confirmation_required");
    assert.equal(ok(ok(await mcp("hetu.plugins.invoke",source)).result).result.data.content,"江岚守着灯塔。🌿");
    assert.equal((await mcp("hetu.plugins.invoke",save)).error.code,"hetu.execution_confirmation_required");
    const prepared=ok(call("hetu.execution.prepare",{workspace_path:workspace,commands:[command("hetu.plugins.invoke",save)],summary:"保存所展示的专业规划",operation_key:"fixed-plugin-plan"}));
    const ref={plan_id:prepared.plan_id,sha256:prepared.sha256};
    assert.equal(call("hetu.execution.execute",{plan_ref:ref}).error.code,"hetu.execution_confirmation_required");
    ok(call("hetu.execution.record_confirmation",{plan_ref:ref,decision:"confirm",user_instruction:"隔离验收：确认这份固定人物规划",operation_key:"confirm-plan"}));
    const done=ok(call("hetu.execution.execute",{plan_ref:ref})),saved=done.results[0].data.result.data;
    assert.equal(saved.object.actor_ref,pkg.manifest.id);
    assert.equal(saved.object.revision,1);assert.deepEqual(ok(call("hetu.execution.execute",{plan_ref:ref})),done);
    const conflict={...save,arguments:{...save.arguments,object_id:saved.object.object_id,operation_key:"stale-plugin-save"}};
    const conflictPlan=ok(call("hetu.execution.prepare",{workspace_path:workspace,commands:[command("hetu.plugins.invoke",conflict)],summary:"固定过期专业保存负例",operation_key:"stale-plugin-plan"}));
    const conflictRef={plan_id:conflictPlan.plan_id,sha256:conflictPlan.sha256};
    ok(call("hetu.execution.record_confirmation",{plan_ref:conflictRef,decision:"confirm",user_instruction:"隔离验收：确认过期基线负例并保留冲突",operation_key:"stale-plugin-confirm"}));
    const conflicted=call("hetu.execution.execute",{plan_ref:conflictRef});
    assert.equal(conflicted.status,"blocked");assert.equal(conflicted.error.code,"revision_conflict");
    assert.deepEqual(ok(call("hetu.execution.get_plan",{plan_ref:conflictRef})).results,[]);
    assert.deepEqual(call("hetu.execution.execute",{plan_ref:conflictRef}),conflicted);
    assert.equal(call("hetu.execution.get_plan",{plan_ref:ref},"generic").error.code,"forbidden");
    const stale=execute("hetu.plugins.invoke",{...source,capabilities_sha256:"0".repeat(64)});
    assert.equal(stale.error.code,"hetu.stale_evidence");
    const otherRead=execute("hetu.plugins.invoke",{...source,work_ref:otherWork});
    assert.notEqual(otherRead.status,"succeeded");
    assert.deepEqual((await readdir(path.join(env.HETU_COLLABORATION_DIR,"management","codex")).catch(()=>[])),[]);
    assert.equal((data("hetu.documents.get",{document_id:document.document.document_id})).revision.revision_id,document.revision.revision_id);
    // 既有精确连接独立验收：confirm动态读取直通，写入仍拒绝，撤权立即失效。
    const author=await AppServer.open(binary("hetu-app-server"),workspace);
    try{
      const control=async(action:string,input:any)=>ok(await author.request("workspace/request",command(action,input)));
      const connected=await control("hetu.collaboration.authorize_workspace",{client_adapter:"codex",work_ref:work,collaboration_path:env.HETU_COLLABORATION_DIR,operation_key:"exact-connection"});
      const managed={...binding,management_ref:connected.management_ref};
      const managedCap=ok(call("hetu.plugins.capabilities",managed));
      const stableRead={...source,management_ref:connected.management_ref,capabilities_sha256:managedCap.capabilities_sha256};
      assert.equal(ok(call("hetu.plugins.invoke",stableRead)).result.data.content,"江岚守着灯塔。🌿");
      assert.equal(call("hetu.plugins.invoke",{...save,management_ref:connected.management_ref,capabilities_sha256:managedCap.capabilities_sha256}).error.code,"hetu.execution_confirmation_required");
      await control("hetu.collaboration.revoke_management",{grant_id:connected.management_ref.grant_id,client_adapter:"codex",collaboration_path:env.HETU_COLLABORATION_DIR,operation_key:"revoke-exact"});
      assert.equal(call("hetu.plugins.invoke",stableRead).error.code,"forbidden");
    }finally{await author.close();}
    const contextFiles=await readdir(path.join(profile,"plugins"));
    assert.ok(contextFiles.includes("plugin-state.json"));
  }finally{await machine.close();await local.close();}
});
