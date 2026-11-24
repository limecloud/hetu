import {spawn} from "node:child_process";
import {readFile,writeFile,rename,stat} from "node:fs/promises";
import {createInterface} from "node:readline";
import {randomUUID} from "node:crypto";

// 透传真实MCP响应；投影只是待核验引用，不能代替Core保存事实。
import {toolOutput} from "./tool-output.ts";
const config=JSON.parse(await readFile(process.argv[2],"utf8"));
const child=spawn(config.binary,config.args,{stdio:["pipe","pipe","inherit"],windowsHide:true});
child.on("error",()=>{process.stderr.write("河图MCP未能启动。\n");process.exitCode=1;});
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>child.kill(signal));
process.on("exit",()=>child.kill());
const pending=new Map();let receipts=[],writing=Promise.resolve();
try{if((await stat(config.receipts)).size>2_000_000)throw Error("回执超过预算");receipts=JSON.parse(await readFile(config.receipts,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
function record(message){
  const request=pending.get(message.id);if(!request)return;pending.delete(message.id);
  if(Buffer.byteLength(JSON.stringify(message.result??message.error))>128_000)return;
  const output=toolOutput(message.result??message.error);
  // 只记录完整、有界的业务结果，不截断JSON制造伪回执。
  if(output.length>128_000||!message.result?.structuredContent?.action)return;
  receipts.push({id:randomUUID(),turn_id:"",kind:"mcp",title:request.name,server:"hetu",name:request.name,state:message.error||message.result.isError?"failed":"completed",output,completed_at:new Date().toISOString()});
  while(receipts.length>64||Buffer.byteLength(JSON.stringify(receipts))>1_000_000)receipts.shift();
  const value=JSON.stringify(receipts),temporary=config.receipts+"."+randomUUID()+".tmp";
  writing=writing.then(async()=>{await writeFile(temporary,value,{mode:0o600,flag:"wx"});await rename(temporary,config.receipts);});
}
const incoming=createInterface({input:process.stdin,crlfDelay:Infinity});
incoming.on("close",()=>child.stdin.end());
child.stdin.on("error",()=>incoming.close());
child.on("exit",code=>{if(code)process.exitCode=code;});
incoming.on("line",line=>{
  try{const message=JSON.parse(line);if(message.method==="tools/call"&&message.id!==undefined){if(pending.size>=256)throw Error("在途请求超过预算");pending.set(message.id,{name:message.params?.name??"hetu_call_action"});}}catch(error){if(!(error instanceof SyntaxError)){process.stderr.write("河图MCP请求超过预算。\n");child.kill();return;}}
  if(!child.stdin.write(line+"\n"))incoming.pause(),child.stdin.once("drain",()=>incoming.resume());
});
const outgoing=createInterface({input:child.stdout,crlfDelay:Infinity});
for await(const line of outgoing){
  try{record(JSON.parse(line));await writing;}catch{process.stderr.write("河图成果回执暂未记录，请从作品核对。\n");}
  if(!process.stdout.write(line+"\n"))await new Promise(resolve=>process.stdout.once("drain",resolve));
}
await writing.catch(()=>{});
incoming.close();process.stdin.pause();
