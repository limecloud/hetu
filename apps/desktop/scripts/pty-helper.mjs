import {stat,chmod} from "node:fs/promises";
import path from "node:path";

/** node-pty既支持本机编译也支持预构建，helper跟随实际安装布局。 */
export async function preparePtyHelpers(directory,platform=process.platform,arch=process.arch){
 if(platform==="win32")return [];
 const candidates=["build/Release","build/Debug",`prebuilds/${platform}-${arch}`].map(folder=>path.join(directory,folder,"spawn-helper"));
 const found=[];
 for(const candidate of candidates){
  try{if(!(await stat(candidate)).isFile())throw Error("PTY helper不是普通文件："+candidate);await chmod(candidate,0o755);found.push(candidate);}
  catch(error){if(error.code!=="ENOENT")throw error;}
 }
 if(!found.length)throw Error("node-pty缺少当前平台的spawn-helper，请先完成原生模块安装或编译。");
 return found;
}
