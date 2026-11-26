import {access,constants,open,readdir} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export function executableCandidates(name:string,directories:string[],platform=process.platform){
 const paths=platform==="win32"?path.win32:path;
 if(paths.isAbsolute(name))return [name];
 const names=platform==="win32"&&!/\.(exe|cmd|bat|com)$/i.test(name)?[name+".exe",name+".cmd"]:[name];
 return directories.flatMap(directory=>names.map(value=>paths.join(directory,value)));
}

/** Finder不继承登录Shell；仅探测已知安装目录，不运行Shell初始化文件。 */
export async function engineSearchPaths(runtimeDirectory?:string){
 let nodePaths:string[]=[];
 try{nodePaths=(await readdir(path.join(os.homedir(),".nvm/versions/node"))).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(version=>path.join(os.homedir(),".nvm/versions/node",version,"bin"));}
 catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 return [...new Set([...(process.env.PATH??"").split(path.delimiter),...(runtimeDirectory?[runtimeDirectory]:[]),path.join(os.homedir(),".local/bin"),...(process.platform==="win32"?[]:["/opt/homebrew/bin","/usr/local/bin"]),...nodePaths].filter(Boolean))];
}
/** 执行位不代表脚本可启动：旧安装器可能仍指向已移除的绝对解释器。 */
export async function runnableCommand(candidate:string,platform=process.platform){
 try{
  await access(candidate,platform==="win32"?constants.F_OK:constants.X_OK);
  if(platform==="win32")return true;
  const handle=await open(candidate,"r");
  try{
   if(!(await handle.stat()).isFile())return false;
   const bytes=Buffer.alloc(512),{bytesRead}=await handle.read(bytes,0,bytes.length,0),header=bytes.subarray(0,bytesRead).toString("utf8");
   if(header.startsWith("#!")){
    const interpreter=header.split("\n",1)[0].match(/^#!\s*(\/[^\s]+)/)?.[1];
    if(!interpreter)return false;
    await access(interpreter,constants.X_OK);
   }
   return true;
  }finally{await handle.close();}
 }catch(error){if(["ENOENT","EACCES","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??""))return false;throw error;}
}
