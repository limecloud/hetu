import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";

const root=path.resolve(import.meta.dirname,"../../..");
test("两个专业工具共享固定正文，规划不改正式目录，卸载后保留来源且基本创作可继续",{timeout:180000},async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),"hetu-creative-composition-"));
  const workspace=path.join(folder,"作品"),collaboration=path.join(folder,"collaboration"),profile=path.join(folder,"profile");
  const fixture=spawnSync(path.join(root,"target/debug/examples/task_view_fixture"),[workspace,collaboration],{encoding:"utf8"});
  assert.equal(fixture.status,0,fixture.stderr);const context=JSON.parse(fixture.stdout);
  const env={...process.env,HETU_PLUGIN_STATE_DIR:profile,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),
    HETU_PLUGIN_NODE:process.execPath,HETU_PLUGIN_MANAGER:path.join(root,"apps/desktop/dist/plugin-manager.mjs"),HETU_COLLABORATION_DIR:collaboration};
  const client=new Client({name:"hetu-creative-composition",version:"1"},{});
  await client.connect(new StdioClientTransport({command:path.join(root,"target/debug/hetu-mcp"),args:["--client","codex","--collaboration-dir",collaboration],env,stderr:"pipe"}));
  const call=async(name:string,input:any={})=>(await client.callTool({name,arguments:input})).structuredContent as any;
  const ok=async(name:string,input:any={})=>{const result=await call(name,input);assert.equal(result.status,"succeeded",JSON.stringify(result));return result.data;};
  const core=(action:string,input:any={})=>ok("hetu_call_action",{action,input:{management_ref:context.management_ref,...input}});
  let sequence=0;
  try{
    const tools=(await client.listTools()).tools.map(tool=>tool.name);
    const work=(await core("hetu.works.list",{include_archived:false})).works.find((row:any)=>row.work_ref.kind==="novel").work_ref;
    const formal=await core("hetu.documents.list",{work_ref:work});
    const before=await core("hetu.documents.get",{document_id:formal.documents[0].document_id});
    const source={kind:"document",work_ref:work,document_id:before.document.document_id,revision_id:before.revision.revision_id,sha256:before.revision.sha256};
    const bindings:any[]=[];
    const apply=async(pkg:any,action:string)=>ok("hetu_plugins_apply",{action,plugin_id:pkg.manifest.id,package_directory:pkg.directory,package_sha256:pkg.package_sha256,
      expected_sha256:(await ok("hetu_plugins_inspect")).state_sha256,authorization_note:"隔离专业组合验收的明确安装选择",operation_key:action+"-"+(++sequence)});
    for(const name of ["relationships","timeline"]){
      const directory=path.join(root,"plugins",name,"dist"),pkg=await ok("hetu_plugins_inspect_package",{package_directory:directory});pkg.directory=directory;
      await apply(pkg,"install");
      const binding={management_ref:context.management_ref,plugin_id:pkg.manifest.id,package_sha256:pkg.package_sha256,work_ref:work};
      const capability=await ok("hetu_plugins_capabilities",binding);
      // MCP的大能力目录先返回摘要，沿原结果摘要分页，不把省略误判成缺少能力。
      const containsAction=async(group:string,target:string)=>{
        if(Array.isArray(capability[group]))return capability[group].some((action:any)=>action.name===target);
        const read=capability.response.read;let offset:number|null=0;
        while(offset!==null){
          const projection=await ok("hetu_call_action",{...read.input,view:{...read.input.view,result_path:"/"+group,offset,limit:100,max_bytes:12000}});
          const view=projection.view;
          if(view.items?.some((action:any)=>action.name===target))return true;
          if(view.next_path){
            const item=await ok("hetu_call_action",{...read.input,view:{...read.input.view,result_path:view.next_path+"/name",max_bytes:1000}});
            if(item.view.page.text===target)return true;
            offset=Number(view.next_path.split("/").at(-1))+1;
          }else offset=view.next_offset;
        }
        return false;
      };
      assert.ok(await containsAction("core_actions","hetu.documents.get"));
      assert.ok(await containsAction("data_actions","hetu.extensions.objects.save"));
      assert.ok(capability.types.some((type:any)=>type.kind===name));
      const invoke=async(action:string,input:any)=>ok("hetu_plugins_invoke",{...binding,capabilities_sha256:capability.capabilities_sha256,action,arguments:input});
      const shared=await invoke("hetu.documents.get",{document_id:source.document_id,revision_id:source.revision_id});
      assert.equal(shared.result.data.content,before.content);assert.equal(shared.result.data.revision.sha256,source.sha256);
      const content=name==="relationships"?{nodes:[{id:"jianglan",label:"江岚",x:0,y:0}],edges:[]}:
        {events:[{id:"dawn",title:"黎明前的约定",time:"第一日黎明",description:"保留原稿中的时间依据"}]};
      const saved=(await invoke("hetu.extensions.objects.save",{kind:name,title:"雾港专业规划",schema_version:"1",content,source_refs:[source],expected_revision:0,expected_sha256:"",operation_key:"save-"+name})).result.data;
      assert.equal(saved.object.owner_plugin_id,pkg.manifest.id);assert.deepEqual(saved.object.source_refs,[source]);
      if(name==="relationships"){
        assert.ok(capability.actions.some((action:any)=>action.id==="arrange"));
        const arranged=await invoke("arrange",{object_id:saved.object.object_id,operation_key:"arrange-once"});
        assert.equal(arranged.result.data.object.revision,2);
        assert.equal(arranged.result.data.object.content.nodes[0].x,150);
      }
      bindings.push({pkg,binding,capability,saved});
    }
    assert.deepEqual(await core("hetu.documents.list",{work_ref:work}),formal);
    const unchanged=await core("hetu.documents.get",{document_id:source.document_id});
    assert.equal(unchanged.content,before.content);assert.deepEqual(unchanged.revision,before.revision);
    for(const item of bindings){
      await apply(item.pkg,"uninstall");
      const stale=await call("hetu_plugins_invoke",{...item.binding,capabilities_sha256:item.capability.capabilities_sha256,action:"hetu.documents.get",arguments:{document_id:source.document_id}});
      assert.notEqual(stale.status,"succeeded");
      const retained=await ok("hetu_read_plugin_result",{management_ref:context.management_ref,work_ref:work,owner_plugin_id:item.pkg.manifest.id,object_id:item.saved.object.object_id,revision:1});
      assert.equal(retained.sha256,item.saved.sha256);assert.deepEqual(retained.object.source_refs,[source]);
    }
    const execution=await ok("hetu_call_action",{action:"hetu.execution.invoke",input:{workspace_path:workspace,command:{action:"hetu.documents.save",contract_revision:"1",input:{document_id:source.document_id,base_revision_id:source.revision_id,source_format:before.revision.source_format,content:before.content+"\n\n基本创作继续。",operation_key:"basic-writing-after-uninstall"}}}});
    assert.equal(execution.result.status,"succeeded");const edited=execution.result.data;
    assert.notEqual(edited.revision.revision_id,source.revision_id);
    assert.equal((await core("hetu.documents.get",{document_id:source.document_id,revision_id:source.revision_id})).content,before.content);
    assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),tools);
  }finally{await client.close();}
});
