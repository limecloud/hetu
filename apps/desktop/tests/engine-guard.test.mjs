import test from "node:test";
import assert from "node:assert/strict";
import {fork,spawn} from "node:child_process";
import {mkdtemp,writeFile,readFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {CodexRpc} from "../src/main/agent/codex-rpc.ts";

const guard=fileURLToPath(new URL("../src/main/agent/engine-guard.mjs",import.meta.url));
async function until(check,message){const deadline=Date.now()+7000;while(!await check()){assert(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,25));}}
function aliveGroup(pid){assert(Number.isSafeInteger(pid)&&pid>1,"守护必须有确切PID");try{process.kill(-pid,0);return true;}catch(error){if(error.code==="ESRCH")return false;if(error.code==="EPERM")return true;throw error;}}
const forkGuard=(binary,args,cwd)=>fork(guard,[binary,...args],{execPath:process.execPath,execArgv:[],cwd,stdio:["pipe","pipe","pipe","ipc"],detached:true});

test("受管引擎等待占用提交后的启动许可，并透传原输入输出",{skip:process.platform==="win32",timeout:15000},async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-guard-start-")),marker=path.join(folder,"started"),binary=path.join(folder,"engine.mjs");
 await writeFile(binary,`import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"started");process.stdout.write("ready\\n");process.stderr.write("diagnostic\\n");process.stdin.on("data",data=>process.stdout.write(data));`);
 const child=forkGuard(process.execPath,[binary],folder);let output="",error="";child.stdout.on("data",value=>output+=value);child.stderr.on("data",value=>error+=value);
 try{
  await assert.rejects(readFile(marker));child.send({type:"unrelated"});await assert.rejects(readFile(marker));
  child.send({type:"start"});await until(()=>output.includes("ready")&&error.includes("diagnostic"),"引擎输出未完整透传");child.stdin.write("原始中文🌿\r\n");await until(()=>output.includes("原始中文🌿\r\n"),"原始输入没有透传");
 }finally{child.disconnect();await until(()=>!aliveGroup(child.pid),"组未退出");}
});

test("占用落盘失败时不创建真实引擎，关闭保留原错误",{skip:process.platform==="win32",timeout:15000},async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-guard-grant-")),marker=path.join(folder,"unexpected-engine");
 const rpc=new CodexRpc({binary:process.execPath,args:["--input-type=module","--eval",`import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"wrong");process.stdin.resume();`],cwd:folder,env:process.env,transport:"stdio",guardian:{node:process.execPath,script:guard},spawned:async()=>{throw Error("原占用保存失败");},message:()=>{},disconnected:()=>{}});
 try{await assert.rejects(rpc.open(),/原占用保存失败/);await assert.rejects(readFile(marker));}finally{await rpc.close();}
});

test("父进程SIGKILL后仅结束原受管组，忽略TERM的后代也退出",{skip:process.platform==="win32",timeout:15000},async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-guard-parent-")),marker=path.join(folder,"owner.json"),engine=path.join(folder,"engine.mjs");
 await writeFile(engine,`import {spawn} from "node:child_process";const child=spawn(process.execPath,["--eval","process.on('SIGTERM',()=>{});process.stdin.resume()"],{stdio:["pipe","ignore","ignore"]});process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");process.stdin.resume();`);
 const sentinel=spawn(process.execPath,["--eval","process.stdin.resume()"],{stdio:["pipe","ignore","ignore"],detached:true});
 const owner=spawn(process.execPath,["--input-type=module","--eval",`import {fork} from "node:child_process";import {writeFileSync} from "node:fs";const child=fork(${JSON.stringify(guard)},[process.execPath,${JSON.stringify(engine)}],{execPath:process.execPath,execArgv:[],cwd:${JSON.stringify(folder)},stdio:["pipe","pipe","pipe","ipc"],detached:true});child.stdout.on("data",data=>{if(data.toString().includes("ready"))writeFileSync(${JSON.stringify(marker)},JSON.stringify({guard:child.pid}));});child.stderr.resume();child.send({type:"start"});process.stdin.resume();`],{stdio:["pipe","ignore","ignore"]});
 let pid;
 try{
  await until(async()=>{try{pid=JSON.parse(await readFile(marker,"utf8")).guard;return true;}catch{return false;}},"原父进程未启动真实组");
  assert(aliveGroup(pid));owner.kill("SIGKILL");await until(()=>!aliveGroup(pid),"父进程退出后受管组仍存活");process.kill(sentinel.pid,0);
 }finally{owner.kill("SIGKILL");sentinel.kill("SIGTERM");if(pid&&aliveGroup(pid))process.kill(-pid,"SIGKILL");}
});

test("许可前父IPC断开不启动引擎；正常引擎退出不遗留同组后代",{skip:process.platform==="win32",timeout:15000},async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-guard-exit-")),marker=path.join(folder,"must-not-start");
 const pending=forkGuard(process.execPath,["--eval",`require('node:fs').writeFileSync(${JSON.stringify(marker)},'wrong')`],folder);pending.stdout.resume();pending.stderr.resume();pending.disconnect();await until(()=>!aliveGroup(pending.pid),"未启动的守护未退出");await assert.rejects(readFile(marker));
 const child=forkGuard(process.execPath,["--eval","const p=require('node:child_process').spawn(process.execPath,['--eval',\"process.on('SIGTERM',()=>{});process.stdin.resume()\"],{stdio:['pipe','ignore','ignore']});setTimeout(()=>process.exit(0),100)"],folder);child.stdout.resume();child.stderr.resume();child.send({type:"start"});await until(()=>!aliveGroup(child.pid),"正常引擎退出后组后代仍存活");
});
