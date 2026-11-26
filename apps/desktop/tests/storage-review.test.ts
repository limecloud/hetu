import { test } from "node:test";
import assert from "node:assert/strict";
import { storageRequest } from "../src/main/storage-review.ts";

test("取消清理不登记批准，已批准或执行中的原方案恢复不重复确认", async () => {
  const plan: any = {operation_id:"localop-fixture",sha256:"sha",revision:1,state:"pending",fixed:{kind:"storage_cleanup",storage:{bytes:7,items:[{name:"已移除会话"}]}}};
  const actions: string[] = [];
  const call = async (action: string, input: any) => {
    actions.push(action);
    if(action.endsWith("get_operation"))return structuredClone(plan);
    if(action.endsWith("record_decision")){assert.equal(input.decision,"approve");plan.state="approved";return structuredClone(plan);}
    if(action.endsWith("execute")){plan.state="executing";throw new Error("回执丢失");}
  };
  const cancelled=await storageRequest("storage_execute",{operation_id:plan.operation_id},call,async()=>false);
  assert.equal(cancelled.cancelled,true);assert.deepEqual(actions,["hetu.local_settings.get_operation"]);
  let confirmations=0;
  await assert.rejects(storageRequest("storage_execute",{operation_id:plan.operation_id},call,async(message,detail)=>{confirmations++;assert.match(detail,/7 B/);assert.match(detail,/无法恢复/);return true;}),/回执丢失/);
  await assert.rejects(storageRequest("storage_execute",{operation_id:plan.operation_id},call,async()=>{confirmations++;return true;}),/回执丢失/);
  assert.equal(confirmations,1);assert.equal(actions.filter(action=>action.endsWith("record_decision")).length,1);
});

test("渲染端不能用清理入口执行其他方案或传入删除路径", async () => {
  const received: any[]=[];
  await storageRequest("storage_prepare",{selected_ids:["fixed"],storage_snapshot:"snapshot",operation_key:"key",path:"/private/data"},async(action,input)=>{received.push({action,input});return {};},async()=>true);
  assert.equal(received[0].input.path,undefined);
  await assert.rejects(storageRequest("storage_execute",{operation_id:"other"},async()=>({fixed:{kind:"preferences"}}),async()=>true),/不是存储清理/);
});

test("确定的过期选择允许重新准备，未知传输继续保留原操作", async () => {
  const failure=await storageRequest("storage_prepare",{},async()=>{throw Object.assign(new Error("明细变化"),{code:"revision_conflict"});},async()=>true);
  assert.equal(failure.preparation_failure.code,"revision_conflict");
  await assert.rejects(storageRequest("storage_prepare",{},async()=>{throw new Error("传输中断");},async()=>true),/传输中断/);
});

test("已批准但未执行的清理可以撤回，丢回执后取消仍可恢复", async () => {
  const plan:any={operation_id:"localop-fixture",sha256:"sha",revision:2,state:"approved",fixed:{kind:"storage_cleanup"}};
  let decisions=0;
  const call=async(action:string,input:any)=>{
    if(action.endsWith("get_operation"))return structuredClone(plan);
    assert.equal(action,"hetu.local_settings.record_decision");assert.equal(input.decision,"reject");assert.equal(input.revision,2);
    plan.state="rejected";decisions++;throw new Error("取消回执丢失");
  };
  await assert.rejects(storageRequest("storage_cancel",{operation_id:plan.operation_id},call,async()=>false),/回执丢失/);
  assert.equal((await storageRequest("storage_cancel",{operation_id:plan.operation_id},call,async()=>false)).state,"rejected");assert.equal(decisions,1);
  plan.state="executing";await assert.rejects(storageRequest("storage_cancel",{operation_id:plan.operation_id},call,async()=>false),/已开始执行/);
});
