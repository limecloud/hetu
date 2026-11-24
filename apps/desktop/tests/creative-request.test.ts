import test from "node:test";
import assert from "node:assert/strict";
import {creativeRequest} from "../src/creative-request.ts";

const work={workspace_id:"test-workspace",kind:"novel" as const,object_id:"novel"};
test("不同参与程度保留目标、固定依据与修改限制",()=>{
  const goal="把第二章的冲突提前",preserve="第三章的和解与昨日对白保持不变",context="固定原文修订和来源";
  for(const intent of ["discuss","read","develop","revise","deliver"] as const){
    const prompt=creativeRequest({intent,goal,preserve,context,work});
    assert.ok(prompt.startsWith(goal));assert.ok(prompt.includes(preserve));assert.ok(prompt.includes(context));assert.ok(prompt.includes(JSON.stringify(work)));
  }
  assert.throws(()=>creativeRequest({intent:"read",goal:"  "}),/创作目标/);
  assert.throws(()=>creativeRequest({intent:"revise",goal,preserve:"字".repeat(3001)}),/创作目标/);
});
