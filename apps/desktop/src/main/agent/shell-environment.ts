import {spawn} from "node:child_process";
import os from "node:os";
import path from "node:path";

type ShellEnvironment = Partial<Pick<NodeJS.ProcessEnv,"PATH"|"__MISE_DIFF">>;
const pathMarker="\0HETU_ENGINE_PATH\0",miseMarker="\0HETU_ENGINE_MISE\0",endMarker="\0HETU_ENGINE_END\0";
// 使用外部printenv和printf，只采集寻址所需变量，不依赖Shell的变量或列表语法。
const probe="/usr/bin/printf '\\0HETU_ENGINE_PATH\\0'; /usr/bin/printenv PATH; /usr/bin/printf '\\0HETU_ENGINE_MISE\\0'; /usr/bin/printenv __MISE_DIFF; /usr/bin/printf '\\0HETU_ENGINE_END\\0'";
let cached:{key:string;running:boolean;result:Promise<ShellEnvironment>}|undefined;

function loginShell(){
 if(process.env.SHELL&&path.isAbsolute(process.env.SHELL))return process.env.SHELL;
 try{const shell=os.userInfo().shell;if(shell&&path.isAbsolute(shell))return shell;}catch{/* 账号信息不可用时使用平台Shell。 */}
 return process.platform==="darwin"?"/bin/zsh":"/bin/bash";
}

function capture(shell:string):Promise<ShellEnvironment>{
 return new Promise(resolve=>{
  const child=spawn(shell,["-ilc",probe],{cwd:os.homedir(),env:{...process.env,HETU_SHELL_PATH_PROBE:"1"},stdio:["ignore","pipe","ignore"],detached:true});
  let output="",settled=false;
  const kill=()=>{try{if(child.pid)process.kill(-child.pid,"SIGKILL");}catch{/* 探测进程可能已自行退出。 */}};
  const finish=(environment:ShellEnvironment)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(environment);};
  const timer=setTimeout(()=>{kill();finish({});},5000);
  child.on("error",()=>finish({}));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data",(chunk:string)=>{
   if(settled)return;
   output+=chunk;
   if(Buffer.byteLength(output)>64*1024){kill();finish({});}
  });
  child.on("close",code=>{
   if(settled)return;
   const start=output.indexOf(pathMarker),middle=output.indexOf(miseMarker,start+pathMarker.length),end=output.indexOf(endMarker,middle+miseMarker.length);
   if(code!==0||start<0||middle<0||end<0){finish({});return;}
   const shellPath=output.slice(start+pathMarker.length,middle).replace(/\r?\n$/,""),mise=output.slice(middle+miseMarker.length,end).replace(/\r?\n$/,"");
   finish(shellPath?{PATH:shellPath,...(mise?{__MISE_DIFF:mise}:{})}:{});
  });
 });
}

/** 登录Shell的顺序是用户选择；探测只影响引擎子进程，并发发现不重复启动Shell。 */
export function readLoginShellEnvironment(refresh=false):Promise<ShellEnvironment>{
 if(process.platform!=="darwin"&&process.platform!=="linux")return Promise.resolve({});
 const shell=loginShell(),key=JSON.stringify([shell,os.homedir(),process.env.HOME,process.env.ZDOTDIR,process.env.PATH,process.env.__MISE_DIFF]);
 if(cached?.key===key&&(!refresh||cached.running))return cached.result;
 const entry={key,running:true,result:Promise.resolve({}) as Promise<ShellEnvironment>};
 entry.result=capture(shell).finally(()=>{entry.running=false;});cached=entry;
 return entry.result;
}
