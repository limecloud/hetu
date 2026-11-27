import path from "node:path";
import {realpath,lstat} from "node:fs/promises";

export function externalDirectoryPath(value:string){
  if(!path.isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value)||value.length>4096)throw Error("外部AI配置目录必须是本机绝对路径。");
  return path.normalize(value);
}

/** 缺失的末端目录不创建；规范化最近存在的父目录，断链明确失败。 */
export async function canonicalExternalDirectory(value:string){
  let current=value;const missing:string[]=[];
  while(true){
    try{await lstat(current);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;const parent=path.dirname(current);if(parent===current)throw Error("外部AI配置目录无法解析。");missing.push(path.basename(current));current=parent;continue;}
    return path.join(await realpath(current),...missing.reverse());
  }
}
