import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {pluginService} from '../../../apps/desktop/src/main/plugin-services.ts';
import {exportPluginFile} from '../../../apps/desktop/src/main/plugin-export.ts';
const work={workspace_id:'workspace_11111111-1111-4111-8111-111111111111',kind:'novel' as const,object_id:'novel_11111111-1111-4111-8111-111111111111'};
const ref={object_id:'ext_11111111-1111-4111-8111-111111111111',revision:1,sha256:'a'.repeat(64)};
const ok=(data:unknown)=>({status:'succeeded',data});
test('可信交接核验固定作品节点与工作归属，插件只收到已复制状态',async()=>{
 let handoff:any;
 const context={work,check(){},preferences:()=>({theme:'dark',language:'en'}),openDocument:async()=>{},handoff:async(input:any)=>{handoff=input;},request:async()=>ok({object:{object_id:ref.object_id,work_ref:work,content:{nodes:[{id:'volume'}]}},sha256:ref.sha256})};
 assert.deepEqual(await pluginService('handoff',{goal:'展开当前卷',object_ref:ref,node_id:'volume'},context),{copied:true});assert.equal(handoff.node_id,'volume');
 await assert.rejects(pluginService('handoff',{goal:'越界',object_ref:ref,node_id:'other'},context),/不属于/);
 await assert.rejects(pluginService('handoff',{goal:'伪造',object_ref:{...ref,sha256:'b'.repeat(64)}},context),/摘要/);
 await assert.rejects(pluginService('handoff',{goal:'越权',management_ref:{}},context),/无效/);
 await assert.rejects(pluginService('open_document',{source_ref:{kind:'document',work_ref:{...work,object_id:'other'}}},context),/当前作品/);
 await assert.rejects(pluginService('handoff',{goal:'工作',object_ref:ref,run_ref:ref},context),/工作记录/);
});
test('插件导出收齐固定分段后原子替换；缺段、换清单和坏摘要保留旧文件',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'hetu-export-')),target=path.join(directory,'成果.json');
 const parts=['{"a":1}','{"b":2}'].map((content,index)=>({index,total:2,manifest:[ref,ref],plan_ref:ref,media_type:'application/json',content,content_sha256:createHash('sha256').update(content).digest('hex'),next_cursor:index===0?'second':null}));
 const context={check(){},choose:async()=>target,invoke:async(_a:string,input:any)=>ok(parts[input.cursor?1:0])};
 const input={action:'export',input:{revision:1},suggested_name:'成果.json'};
 await exportPluginFile(input,context);assert.deepEqual(JSON.parse(await readFile(target,'utf8')),[{a:1},{b:2}]);
 await writeFile(target,'保留原文件');
 for(const changed of [{...parts[0],next_cursor:null},{...parts[0],content_sha256:'0'.repeat(64)}]){
  await assert.rejects(exportPluginFile(input,{...context,invoke:async()=>ok(changed)}));assert.equal(await readFile(target,'utf8'),'保留原文件');
 }
 await assert.rejects(exportPluginFile(input,{...context,invoke:async(_a,i)=>ok(i.cursor?{...parts[1],plan_ref:{...ref,revision:2}}:parts[0])}),/清单改变/);assert.equal(await readFile(target,'utf8'),'保留原文件');
 assert.deepEqual(await exportPluginFile(input,{...context,choose:async()=>undefined}),{saved:false,cancelled:true});
});
