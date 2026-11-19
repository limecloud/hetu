import {mkdir,readFile,writeFile,unlink} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";

/** 两个工作台更新同一登记时串行落盘；崩溃遗留只按原PID和固定令牌核对。 */
export async function withLibraryLock<T>(file:string,action:()=>Promise<T>):Promise<T>{
 await mkdir(path.dirname(file),{recursive:true});
 const lock=file+".lock",token=randomUUID(),deadline=Date.now()+10000;
 while(true){
  try{await writeFile(lock,JSON.stringify({pid:process.pid,token}),{flag:"wx",mode:0o600});break;}
  catch(error:any){
   if(error.code!=="EEXIST")throw error;
   try{
    const bytes=await readFile(lock,"utf8"),owner=JSON.parse(bytes);
    if(!Number.isSafeInteger(owner.pid)||owner.pid<=0||typeof owner.token!=="string")throw new Error("创作库更新记录无效，请保留记录后检查。");
    let dead=false;try{process.kill(owner.pid,0);}catch(error:any){dead=error.code==="ESRCH";}
    if(dead&&await readFile(lock,"utf8")===bytes){await unlink(lock);continue;}
   }catch(error:any){if(error.code==="ENOENT")continue;if(error instanceof SyntaxError&&Date.now()<deadline){await delay(25);continue;}throw error;}
   if(Date.now()>=deadline)throw new Error("另一个工作台正在更新创作库，请稍后刷新。");
   await delay(25);
  }
 }
 try{return await action();}
 finally{try{if(JSON.parse(await readFile(lock,"utf8")).token===token)await unlink(lock);}catch(error:any){if(error.code!=="ENOENT")throw error;}}
}
