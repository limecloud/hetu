import {spawn} from "node:child_process";
import {externalCliVersion,externalMinimumVersion,compareExternalVersions,type ExternalInstallation} from "../../shared/external-installation.ts";
import {terminateExternalChild} from "./external-child-lifecycle.ts";

/** 版本探测不发送业务输入、保留原输出或改变用户安装，返回独立于协议握手的事实。 */
export async function probeExternalVersion(options:{binary:string;cwd:string;env:NodeJS.ProcessEnv;minimumVersions:readonly string[];timeoutMs?:number;args?:readonly string[]}):Promise<ExternalInstallation>{
  const base={minimum_versions:[...options.minimumVersions]};
  const child=spawn(options.binary,options.args??["--version"],{cwd:options.cwd,env:options.env,stdio:["ignore","pipe","pipe"],shell:false,windowsHide:true,detached:process.platform!=="win32"});
  let closed=false,started=false,stdout="",stderr="",bytes=0,reason:ExternalInstallation["reason"],code:number|null=null;
  child.on("spawn",()=>{started=true;});child.on("error",()=>{});
  let failed!:()=>void;
  const failure=new Promise<void>(resolve=>{failed=resolve;});
  const capture=(stream:"stdout"|"stderr",chunk:Buffer)=>{
    bytes+=chunk.length;if(bytes>4096){reason="output_limit";failed();return;}
    if(stream==="stdout")stdout+=chunk.toString("utf8");else stderr+=chunk.toString("utf8");
  };
  child.stdout!.on("data",chunk=>capture("stdout",chunk));child.stderr!.on("data",chunk=>capture("stderr",chunk));
  const exit=new Promise<void>(resolve=>child.once("close",value=>{closed=true;code=value;resolve();}));
  const timer=setTimeout(()=>{reason="timeout";failed();},options.timeoutMs??5000);
  try{await Promise.race([exit,failure]);if(!closed)await terminateExternalChild(child,exit,()=>closed);}finally{clearTimeout(timer);}
  if(!started)return {status:"missing",...base};
  if(reason)return {status:"unknown",reason,...base};
  if(code!==0)return {status:"unknown",reason:"exit",...base};
  const version=externalCliVersion(stdout.trim()?stdout:stderr);
  if(!version)return {status:"unknown",reason:"unrecognized",...base};
  const minimum=externalMinimumVersion(version,options.minimumVersions);
  return {status:minimum&&compareExternalVersions(version,minimum)<0?"too_old":"supported",installed_version:version,...base,...(minimum?{minimum_version:minimum}:{})};
}
