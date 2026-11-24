import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { CodexTerminalBridge,passiveTerminalMessage } from "../src/main/agent/codex-terminal-bridge.ts";

test("原生TUI透传精确线程，归属持久化后才答复，外部线程在请求前拒绝",async()=>{
 const server=http.createServer(),upstream=new WebSocketServer({server}),received:string[]=[];
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 upstream.on("connection",peer=>peer.on("message",raw=>{
  const message=JSON.parse(raw.toString());received.push(message.method);
  const result=message.method==="thread/list"?{data:[{id:"owned"},{id:"foreign"}],nextCursor:"next"}:message.method==="thread/start"?{thread:{id:"new-owned"}}:message.method==="thread/resume"?{thread:{id:message.params.threadId}}:{turn:{id:"turn"}};
  peer.send(JSON.stringify({id:message.id,result}));
 }));
 const bridge=new CodexTerminalBridge();let thread="owned";let persisted=false;let owns=true;
 await bridge.open({endpoint:"ws://127.0.0.1:"+(server.address() as {port:number}).port,
  check:message=>{if(!owns&&!passiveTerminalMessage(message))throw new Error("终端仅可观察");if(message.method==="thread/resume"&&message.params.threadId!=="owned")throw new Error("线程不属于当前作品");},
  thread:async value=>{await new Promise(resolve=>setTimeout(resolve,25));thread=value.id;persisted=true;},
  list:result=>({...result,data:result.data.filter((value:any)=>value.id==="owned")}),
 });
 const peer=new WebSocket(bridge.endpoint.startsWith("unix://")?"ws+unix://"+bridge.endpoint.slice(7)+":/":bridge.endpoint,{...(bridge.token?{headers:{Authorization:"Bearer "+bridge.token}}:{})});
 let id=0;const replies=new Map<number,(value:any)=>void>();
 peer.on("message",raw=>{const value=JSON.parse(raw.toString());replies.get(value.id)?.(value);replies.delete(value.id);});
 const request=(method:string,params={})=>new Promise<any>(resolve=>{const key=++id;replies.set(key,resolve);peer.send(JSON.stringify({id:key,method,params}));});
 try {
  await new Promise<void>((resolve,reject)=>{peer.once("open",resolve);peer.once("error",reject);});
  const blocked=await request("thread/resume",{threadId:"foreign"});assert.match(blocked.error.message,/不属于/);assert.equal(received.length,0);
  const list=await request("thread/list");assert.deepEqual(list.result,{data:[{id:"owned"}],nextCursor:"next"});
  const started=await request("thread/start");await bridge.ready();assert.equal(started.result.thread.id,"new-owned");assert.equal(thread,"new-owned");assert.equal(persisted,true);
  const turn=await request("turn/start",{threadId:"new-owned"});assert.equal(turn.result.turn.id,"turn");
  owns=false;const count=received.length;
  assert.match((await request("turn/start",{threadId:"new-owned"})).error.message,/仅可观察/);
  assert.match((await request("thread/start")).error.message,/仅可观察/);
  peer.send(JSON.stringify({id:900,result:{decision:"accept"}}));
  await request("thread/read",{threadId:"owned"});
  assert.deepEqual(received.slice(count),["thread/read"]);
 }finally{peer.terminate();await bridge.close();for(const client of upstream.clients)client.terminate();upstream.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
