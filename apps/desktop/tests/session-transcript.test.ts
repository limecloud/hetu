import test from "node:test";
import assert from "node:assert/strict";
import {sessionTranscript,toolDuration,shouldSendKey} from "../src/session-transcript.ts";
import type {SessionSnapshot,AgentTool} from "../src/agent-session-contract.ts";

test("消息和工具按实际事件顺序混排，流式追加保持原键",()=>{
 const snapshot:SessionSnapshot={client:"codex",state:"running",updated_at:"",messages:[{id:"user",role:"user",text:"读稿",at:"",sequence:1},{item_id:"reply",role:"assistant",text:"正文",at:"",sequence:3}],tools:[{id:"read",turn_id:"turn",kind:"mcpToolCall",title:"读取",state:"running",sequence:2}]};
 const before=sessionTranscript(snapshot);assert.deepEqual(before.map(item=>item.key),["message:user","tool:read","message:reply"]);
 snapshot.messages[1].text+="增量";snapshot.tools![0].state="completed";
 assert.deepEqual(sessionTranscript(snapshot).map(item=>item.key),before.map(item=>item.key));
 assert.equal(sessionTranscript(snapshot)[1].kind,"tool");
});
test("旧会话无序号的消息仍有独立稳定键，同文消息不会合并",()=>{
 const snapshot={messages:[{role:"user" as const,text:"同文",at:"old"},{role:"user" as const,text:"同文",at:"old"}]};
 const entries=sessionTranscript(snapshot);assert.equal(new Set(entries.map(entry=>entry.key)).size,2);
 assert.deepEqual(entries.map(entry=>entry.kind),["message","message"]);
});
test("耗时只消费有效原生时长或真实起止，不为历史缺项编造",()=>{
 const tool:AgentTool={id:"tool",turn_id:"turn",kind:"commandExecution",title:"检查",state:"completed"};
 assert.equal(toolDuration(tool),undefined);assert.equal(toolDuration({...tool,duration_ms:1234}),"1.2 s");assert.equal(toolDuration({...tool,duration_ms:-1}),undefined);
 assert.equal(toolDuration({...tool,started_at:"2026-11-24T00:00:00.000Z",completed_at:"2026-11-24T00:00:00.450Z"}),"450 ms");
});
test("Enter偏好与换行、组合输入、长按互不混淆",()=>{
 const event={key:"Enter",shiftKey:false,metaKey:false,ctrlKey:false,altKey:false,repeat:false,isComposing:false};
 assert.equal(shouldSendKey(event,true),true);assert.equal(shouldSendKey(event,false),false);assert.equal(shouldSendKey({...event,metaKey:true},false),true);
 for(const patch of [{shiftKey:true},{isComposing:true},{repeat:true},{altKey:true},{key:"Escape"}])assert.equal(shouldSendKey({...event,...patch},true),false);
});
