import {stat,chmod} from "node:fs/promises";
import path from "node:path";

/** node-pty仅在macOS使用spawn-helper，路径跟随本机编译或预构建布局。 */
export async function preparePtyHelpers(directory,platform=process.platform,arch=process.arch){
 if(platform!=="darwin")return [];
 const candidates=["build/Release","build/Debug",`prebuilds/${platform}-${arch}`].map(folder=>path.join(directory,folder,"spawn-helper"));
 const found=[];
 for(const candidate of candidates){
  try{if(!(await stat(candidate)).isFile())throw Error("PTY helper不是普通文件："+candidate);await chmod(candidate,0o755);found.push(candidate);}
  catch(error){if(error.code!=="ENOENT")throw error;}
 }
 if(!found.length)throw Error("node-pty缺少当前平台的spawn-helper，请先完成原生模块安装或编译。");
 return found;
}
