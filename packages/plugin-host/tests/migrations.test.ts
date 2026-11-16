import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PluginPackage } from "../src/package.ts";
import { BackendSupervisor } from "../src/backend.ts";
import { PluginMigrationReview } from "../../../apps/desktop/src/main/plugin-migrations.ts";

const work = { workspace_id: "workspace_00000000-0000-4000-8000-000000000000", kind: "novel" as const, object_id: "novel_00000000-0000-4000-8000-000000000000" };
test("只读插件动作不能通过数据迁移绕过效果与原键检查", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-migration-effect-"));
  await writeFile(path.join(directory,"plugin.json"),JSON.stringify({manifest_version:1,host_api:"1",id:"org.test.migration-probe",version:"1.0.0",display:{"zh-CN":"隔离测试",en:"Test"},description:{"zh-CN":"隔离测试",en:"Test"},license:"MIT",permissions:[],dependencies:[],runtime:{entry:"backend.mjs"},contributions:{views:[],data:[],actions:[{id:"probe",title:"探测",effect:"read",input_schema:{type:"object"}}]}}));
  await writeFile(path.join(directory,"backend.mjs"),'let context; export function apply(c) { context = c; } export function invoke(action, input) { return context.request(input.action, { operation_key: "forged" }); }');
  const pkg = await PluginPackage.inspect(directory);
  for (const action of ["hetu.extensions.objects.save","hetu.extensions.migrations.prepare","hetu.extensions.migrations.execute","hetu.extensions.index.rebuild"]) {
    let calls = 0;
    const backend = new BackendSupervisor({node:process.execPath,bootstrap:path.resolve(import.meta.dirname,"../src/worker.mjs"),snapshot:directory,pkg,work_ref:work,request:async()=>{calls++;throw new Error("不可到达Core");}});
    try {
      await backend.initialize();
      await assert.rejects(()=>backend.invoke("probe",{action}));
      assert.equal(calls,0,action);
    } finally { backend.close(); }
  }
});

test("开放迁移执行拒绝未经预览、旧token及上下文变化，丢回执后沿同一方案恢复", async () => {
  let active = true, lost = true, approvals = 0;
  const params: unknown[] = [];
  const plan = { owner_plugin_id:"org.test.migration",work_ref:{object_id:work.object_id,kind:work.kind,workspace_id:work.workspace_id},package_sha256:"a".repeat(64),operation_key:"migration-original" };
  const review = new PluginMigrationReview(async()=>({work,context:{plugin_id:"org.test.migration",work_ref:work},packageSha:"a".repeat(64),check(){if(!active)throw new Error("上下文变化");},async call(method,input){
    if(input.request?.action==="hetu.extensions.migrations.get")return {status:"succeeded",data:{plan,plan_sha256:"b".repeat(64),result:{data:{state:"prepared"}}}};
    approvals++;params.push(input);
    if(lost)throw new Error("批准回执丢失");
    return {status:"succeeded",data:{approved:true,executed:false}};
  }}));
  await assert.rejects(()=>review.approve("forged"),/先审阅/);
  await assert.rejects(()=>review.preview("org.test.migration","migration-test","c".repeat(64)),/已变化/);
  const first = await review.preview("org.test.migration","migration-test","b".repeat(64));
  const second = await review.preview("org.test.migration","migration-test","b".repeat(64));
  await assert.rejects(()=>review.approve(first.token),/先审阅/);
  active=false;await assert.rejects(()=>review.approve(second.token),/上下文变化/);assert.equal(approvals,0);
  active=true;await assert.rejects(()=>review.approve(second.token),/回执丢失/);
  lost=false;assert.deepEqual(await review.approve(second.token),{approved:true,executed:false});
  assert.deepEqual(params[0],params[1]);
});
