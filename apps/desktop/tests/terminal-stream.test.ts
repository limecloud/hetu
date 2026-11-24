import test from "node:test";
import assert from "node:assert/strict";
import {TerminalStream} from "../src/renderer/terminal-stream.ts";
import type {SessionSnapshot} from "../src/agent-session-contract.ts";
const initial:SessionSnapshot={session_id:"session-one",generation:1,state:"ready",client:"codex",messages:[],updated_at:"",terminal_connected:true,terminal_sequence:1,terminal_replay:"A"};
test("回放期间实时输出仅呈现一次，缺段回读原宿主，旧代次不能污染新屏幕",async()=>{
  let output="",reads=0,release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let snapshot={...initial};
  const stream=new TerminalStream({read:async()=>{reads++;return {...snapshot};},reset:async replay=>{output=replay;if(reads===1)await gate;},write:data=>{output+=data;},error:error=>{throw error;}});
  const syncing=stream.sync();await Promise.resolve();await Promise.resolve();
  stream.receive({type:"terminal",session_id:"session-one",generation:1,sequence:2,data:"B"});assert(!stream.acceptsInput);release();await syncing;assert.equal(output,"AB");assert(stream.acceptsInput);
  stream.receive({type:"terminal",session_id:"session-one",generation:1,sequence:2,data:"B"});assert.equal(output,"AB");
  snapshot={...initial,terminal_sequence:4,terminal_replay:"ABCD"};stream.receive({type:"terminal",session_id:"session-one",generation:1,sequence:4,data:"D"});await stream.sync();assert.equal(output,"ABCD");
  snapshot={...initial,generation:2,terminal_sequence:1,terminal_replay:"NEW"};await stream.sync();stream.receive({type:"terminal",session_id:"session-one",generation:1,sequence:100,data:"OLD"});assert.equal(output,"NEW");assert.equal(reads,3);
});
test("回读失败或元数据不完整时关闭输入，核对成功才恢复",async()=>{
  let snapshot={...initial};const stream=new TerminalStream({read:async()=>snapshot,reset:async()=>{},write:()=>{},error:()=>{}});
  await stream.sync();assert(stream.acceptsInput);snapshot={...initial,terminal_sequence:undefined};await assert.rejects(stream.sync(),/不完整/);assert(!stream.acceptsInput);snapshot={...initial};await stream.sync();assert(stream.acceptsInput);
});
test("旧页面关闭后迟到回放不再写入已释放终端",async()=>{
  let release:(value:SessionSnapshot)=>void=()=>{},resets=0;
  const pending=new Promise<SessionSnapshot>(resolve=>{release=resolve;}),stream=new TerminalStream({read:()=>pending,reset:async()=>{resets++;},write:()=>{throw Error("旧页面不应收到输出");},error:()=>{}});
  const syncing=stream.sync();stream.dispose();release(initial);await syncing;
  stream.receive({type:"terminal",session_id:"session-one",generation:1,sequence:2,data:"late"});assert.equal(resets,0);assert(!stream.acceptsInput);
});
