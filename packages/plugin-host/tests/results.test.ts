import { test } from "node:test";
import assert from "node:assert/strict";
import { pluginResultHandoff } from "../../../apps/desktop/src/main/plugin-results.ts";

const work = { workspace_id: "workspace_00000000-0000-4000-8000-000000000000", kind: "novel" as const, object_id: "novel_00000000-0000-4000-8000-000000000000" };
test("插件成果交接只固定获权版本，拒绝错误摘要、对象、迟到上下文与多余字段", async () => {
  const selected={object_id:"ext_00000000-0000-4000-8000-000000000000",revision:2,sha256:"a".repeat(64)};
  const calls: any[]=[];
  let stale=false, mismatch=false;
  const context={work,grant:"grant-test",packageSha:"b".repeat(64),check(){if(stale)throw new Error("上下文变化");},async call(method: string,params: any): Promise<any> {
    calls.push({method,params});
    return {status:"succeeded",data:{object:{...selected,work_ref:work,owner_plugin_id:mismatch?"org.test.other":"org.test.result"},sha256:selected.sha256}};
  }};
  assert.deepEqual(await pluginResultHandoff(context,"org.test.result",{}),{work_ref:work,fixed_refs:[]});
  assert.equal(calls.length,0);
  const result=await pluginResultHandoff(context,"org.test.result",selected);
  assert.deepEqual(result.fixed_refs,[{kind:"plugin_object",work_ref:work,owner_plugin_id:"org.test.result",...selected}]);
  assert.deepEqual(calls[0].params.request.input,{work_ref:work,object_id:selected.object_id,revision:2});
  await assert.rejects(()=>pluginResultHandoff(context,"org.test.result",{...selected,sha256:"c".repeat(64)}),/不一致/);
  await assert.rejects(()=>pluginResultHandoff(context,"org.test.result",{...selected,approved:true}),/确切版本/);
  mismatch=true; await assert.rejects(()=>pluginResultHandoff(context,"org.test.result",selected),/不一致/);
  mismatch=false;
  context.call=async()=>{stale=true;return {status:"succeeded",data:{}};};
  await assert.rejects(()=>pluginResultHandoff(context,"org.test.result",selected),/上下文变化/);
});
