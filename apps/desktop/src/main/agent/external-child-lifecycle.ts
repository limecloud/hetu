import type {ChildProcess} from "node:child_process";

/** 仅回收本次创建的私有进程组；等待退出，不触碰CLI的共享后台服务。 */
export async function terminateExternalChild(child:ChildProcess,exit:Promise<void>,closed:()=>boolean){
  if(closed())return;
  const signal=(name:NodeJS.Signals)=>{try{if(process.platform!=="win32"&&child.pid)process.kill(-child.pid,name);else child.kill(name);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}};
  let timer:NodeJS.Timeout|undefined;
  signal("SIGTERM");
  try{await Promise.race([exit,new Promise<void>(resolve=>{timer=setTimeout(resolve,1500);})]);}finally{clearTimeout(timer);}
  if(!closed()){
    signal("SIGKILL");
    try{await Promise.race([exit,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("外部进程退出仍待核对。")),1500);})]);}finally{clearTimeout(timer);}
  }
}
