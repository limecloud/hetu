import {spawn} from "node:child_process";
import path from "node:path";
import {createHash} from "node:crypto";
import {lstat} from "node:fs/promises";
import type {WorkRef} from "@hetu/plugin-sdk";
import {RecoveryStore} from "./recovery.ts";
const immediateMethods=new Set(["stop","interrupt","session_stop","session_interrupt","takeover"]);

export class ExternalExecutionJournal {
  #store=new RecoveryStore();
  #queue=Promise.resolve();
  #dispatches=new Map<string,Promise<void>>();
  private profile:string;
  constructor(profile:string){this.profile=profile;}
  dispatch<T>(work:WorkRef|undefined,domain:string,input:Record<string,any>,run:()=>Promise<T>):Promise<T>{
    if(immediateMethods.has(input.method))return run();
    const key=JSON.stringify([work?[work.workspace_id,work.kind,work.object_id]:null,domain]);
    const pending=(this.#dispatches.get(key)??Promise.resolve()).then(run),settled=pending.then(()=>{},()=>{});
    this.#dispatches.set(key,settled);
    return pending.finally(()=>{if(this.#dispatches.get(key)===settled)this.#dispatches.delete(key);});
  }
  #file(work?:WorkRef){return path.join(this.profile,"external-execution",createHash("sha256").update(JSON.stringify(work??null)).digest("hex")+".json");}
  #computerFile(work?:WorkRef){return this.#file(work).replace(/\.json$/,".computer.json");}
  async computerSession(work?:WorkRef):Promise<any|undefined>{
    const file=this.#computerFile(work);
    try{const metadata=await lstat(file);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>4096)throw Error("电脑会话恢复记录无效。");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
    const value:any=await this.#store.read(file);
    if(!value||typeof value.session_id!=="string"||!/^computer-[a-zA-Z0-9-]{16,64}$/.test(value.session_id)||![value.pid,value.window_id].every(n=>Number.isSafeInteger(n)&&n>0)||!["active","taken_over"].includes(value.state))throw Error("原电脑会话记录损坏，已保留原文件。");
    return value;
  }
  observed(work:WorkRef|undefined,input:Record<string,any>,data:any){return this.#serialize(async()=>{
    if(typeof input.session_id!=="string"||!/^computer-[a-zA-Z0-9-]{16,64}$/.test(input.session_id))return;
    const previous=await this.computerSession(work),pid=data.app?.pid,window_id=data.window?.window_id;
    if(![pid,window_id].every(n=>Number.isSafeInteger(n)&&n>0))throw Error("电脑观察缺少原窗口身份。");
    const state=["active","taken_over"].includes(data.control?.state)?data.control.state:previous?.session_id===input.session_id&&previous.pid===pid&&previous.window_id===window_id?previous.state:"active";
    await this.#store.write(this.#computerFile(work),{session_id:input.session_id,pid,window_id,state},4096);
  });}
  controlled(work:WorkRef|undefined,input:Record<string,any>,data:any){return this.#serialize(async()=>{
    const previous=await this.computerSession(work);if(!previous||previous.session_id!==input.session_id)return;
    const state=data.result?.state;if(!["active","taken_over"].includes(state))return;
    await this.#store.write(this.#computerFile(work),{...previous,state},4096);
  });}
  async read(work?:WorkRef):Promise<any[]>{
    const file=this.#file(work);
    try{const metadata=await lstat(file);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>64000)throw Error("外部执行恢复记录无效。");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
    const rows=await this.#store.read(file);if(!Array.isArray(rows)||rows.length>32||rows.some(row=>!row||!["bots","computer","sessions"].includes(row.domain)||typeof row.operation_key!=="string"||!["pending","unknown","succeeded","rejected"].includes(row.state)))throw Error("外部执行恢复记录损坏，已保留原文件。");return rows;
  }
  before(work:WorkRef|undefined,domain:string,input:Record<string,any>){return this.#serialize(()=>this.#before(work,domain,input));}
  #serialize(run:()=>Promise<void>){const promise=this.#queue.then(run);this.#queue=promise.catch(()=>{});return promise;}
  async #before(work:WorkRef|undefined,domain:string,input:Record<string,any>){
    const rows=await this.read(work),digest=createHash("sha256").update(JSON.stringify(input)).digest("hex"),prior=rows.find(row=>row.domain===domain&&row.operation_key===input.operation_key);
    if(prior){if(prior.sha256!==digest)throw Error("原操作键不能更换输入。");return;}
    if(!immediateMethods.has(input.method)&&rows.some(row=>row.domain===domain&&["pending","unknown"].includes(row.state)))throw Error("原操作结果待核对，请先查询原操作。");
    const kept=rows.filter(row=>["pending","unknown"].includes(row.state)).concat(rows.filter(row=>!["pending","unknown"].includes(row.state)).slice(-8));
    if(kept.length>=32)throw Error("外部操作恢复记录达到预算。");
    kept.push({domain,operation_key:input.operation_key,sha256:digest,session_id:input.session_id,state:"pending"});await this.#store.write(this.#file(work),kept,64000);
  }
  after(work:WorkRef|undefined,domain:string,key:string,result:any){return this.#serialize(()=>this.#after(work,domain,key,result));}
  async #after(work:WorkRef|undefined,domain:string,key:string,result:any){
    const rows=await this.read(work),entry=rows.find(row=>row.domain===domain&&row.operation_key===key);if(!entry)return;
    entry.state=result?.status==="unknown"||["unknown","dispatching","not_found"].includes(result?.data?.state)?"unknown":result?.data?.state==="rejected"?"rejected":result?.status==="succeeded"?"succeeded":"rejected";
    entry.session_id=result?.data?.session_id??result?.data?.result?.session_id??entry.session_id;
    await this.#store.write(this.#file(work),rows,64000);
  }
}

/** 桌面组装固定机器请求；配置、电脑操作及原键由共享Rust用例拥有。 */
export function externalExecution(binary:string,directory:string,action:string,input:Record<string,unknown>,client="generic"):Promise<any>{
  return new Promise((resolve,reject)=>{
    const writing=typeof input.operation_key==="string"&&input.method!=="operation";
    const child=spawn(binary,["--client",client,"--collaboration-dir",directory,"call",action,"--input","-"],{stdio:["pipe","pipe","pipe"],windowsHide:true,shell:false});
    const output:Buffer[]=[];let size=0,finished=false;
    const finish=(error?:Error,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Error(writing?"机器回执待核对，请查询原operation_key；没有自动重发。":"读取超时，请重试原读取请求。"));},45000);
    child.stderr.resume();child.stdout.on("data",chunk=>{size+=chunk.length;if(size>8*1024*1024){child.kill();finish(Error(writing?"机器结果超过读取预算，请查询原操作。":"读取结果超过预算，请缩小原读取范围。"));}else output.push(chunk);});
    child.on("error",()=>finish(Error("当前制品无法启动河图机器入口。")));
    child.on("close",()=>{try{finish(undefined,JSON.parse(Buffer.concat(output).toString("utf8")));}catch{finish(Error(writing?"机器回执无效，请查询原operation_key。":"读取回包无法核对，请重试原读取请求。"));}});
    child.stdin.on("error",()=>finish(Error(writing?"机器输入未取得回执，请核对原操作。":"读取请求未送达，请重试原读取请求。")));child.stdin.end(JSON.stringify(input));
  });
}
