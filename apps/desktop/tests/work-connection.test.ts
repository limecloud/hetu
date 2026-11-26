import test from "node:test";
import assert from "node:assert/strict";
import {ensureWorkConnection} from "../src/main/work-connection.ts";

const work={workspace_id:"workspace_00000000-0000-4000-8000-000000000001",kind:"novel" as const,object_id:"novel_00000000-0000-4000-8000-000000000001"};
test("已连接的作品在批准目录变化后沿原用例绑定当前目录",async()=>{
 let current=false,calls=0;
 const result=await ensureWorkConnection({work,base:{client_adapter:"codex"},check(){},
  status:async()=>({authorized:true,git_authorization_current:current,management_ref:{grant_revision:current?2:1}}),
  call:async(action,input)=>{calls++;assert.equal(action,"hetu.collaboration.authorize_workspace");assert.deepEqual(input.work_ref,work);assert.equal(typeof input.operation_key,"string");current=true;}
 });
 assert.equal(calls,1);assert.equal(result.management_ref.grant_revision,2);
});
test("绑定未变化的读取不修改授权",async()=>{
 const status={authorized:true,git_authorization_current:true};
 assert.equal(await ensureWorkConnection({work,base:{},check(){},status:async()=>status,call:async()=>{assert.fail("不应修改当前连接");}}),status);
});
test("目录绑定更新回执未知时只查结果，不重复更新",async()=>{
 let current=false,calls=0;
 const result=await ensureWorkConnection({work,base:{},check(){},status:async()=>({authorized:true,git_authorization_current:current}),
  call:async()=>{calls++;current=true;throw Error("回执未知");}
 });
 assert.equal(result.git_authorization_current,true);assert.equal(calls,1);
});
test("原连接仍有作品权限但目录更新失败，不能误报接续成功",async()=>{
 let calls=0;
 await assert.rejects(ensureWorkConnection({work,base:{},check(){},status:async()=>({authorized:true,git_authorization_current:false}),
  call:async()=>{calls++;throw Error("目录绑定更新未完成");}
 }),/目录绑定更新未完成/);
 assert.equal(calls,1);
});
