import {spawn,spawnSync,execFile} from "node:child_process";

// 私有fork IPC只交接启动许可；本进程是受管组成员，不按磁盘上的旧PID清理。
if(!process.send||!process.connected)process.exit(1);
let child,closing=false,started=false;
function othersRunning(){
 const result=spawnSync("ps",["-axo","pid=,pgid=,stat="],{encoding:"utf8",timeout:1000});
 if(result.status!==0)return true;
 return result.stdout.split("\n").some(line=>{
  const row=line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)/);
  return row&&Number(row[2])===process.pid&&Number(row[1])!==process.pid&&Number(row[1])!==result.pid&&!row[3].startsWith("Z");
 });
}
async function stop(code=0){
 if(closing)return;closing=true;
 if(!started||!child){process.exit(code);return;}
 child.stdin.end();
 if(process.platform==="win32"){
  if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>execFile("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true},()=>resolve()));
  process.exit(code);return;
 }
 // 自身保留SIGTERM处理器，组宽限期间保持组身份，避免复用旧PID。
 process.kill(-process.pid,"SIGTERM");
 const deadline=Date.now()+1200;
 while(Date.now()<deadline){if(!othersRunning()){process.exit(code);return;}await new Promise(resolve=>setTimeout(resolve,25));}
 process.kill(-process.pid,"SIGKILL");
}
process.on("disconnect",()=>void stop());
process.on("SIGTERM",()=>void stop());
process.on("SIGINT",()=>void stop());
process.stdin.on("error",()=>void stop(1));
process.stdout.on("error",()=>void stop(1));
process.stderr.on("error",()=>void stop(1));
process.on("message",message=>{
 if(message?.type!=="start"||started||closing)return;
 if(!process.connected){void stop(1);return;}
 const [binary,...args]=process.argv.slice(2);
 if(!binary){void stop(1);return;}
 started=true;
 child=spawn(binary,args,{cwd:process.cwd(),env:process.env,stdio:"pipe",windowsHide:true,shell:false});
 child.on("error",()=>void stop(1));child.on("exit",code=>void stop(code??1));
 child.stdin.on("error",()=>{});
 process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
});
