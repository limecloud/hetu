import path from "node:path";
import {constants} from "node:fs";
import {open,stat,lstat} from "node:fs/promises";
import {validExternalProfileBinding,type ExternalProfileBinding} from "../../shared/external-storage-binding.ts";
import {externalDirectoryPath,canonicalExternalDirectory} from "./external-storage-paths.ts";

const namePattern=/^[a-z0-9][a-z0-9_-]{0,63}$/;
async function isDirectory(value:string){try{return (await stat(value)).isDirectory();}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}

/** 原生默认位置；不创建目录、不导入配置或凭据。 */
export async function defaultHermesHome(home:string,env:NodeJS.ProcessEnv,platform=process.platform){
  const suffix=env.HERMES_DATA_DIR_SUFFIX??"";if(!/^[a-zA-Z0-9._-]{0,64}$/.test(suffix))throw Error("Hermes数据目录后缀无效。");
  const dot=path.join(home,".hermes"+suffix);if(platform!=="win32")return dot;
  const local=env.LOCALAPPDATA===undefined?path.join(home,"AppData","Local"):externalDirectoryPath(env.LOCALAPPDATA),native=path.join(local,"hermes"+suffix);
  return !await isDirectory(native)&&await isDirectory(dot)?dot:native;
}

/** 只读至多512字节的原生profile选择；损坏或未知目标不回退到另一存储。 */
async function activeProfile(home:string){
  let file:Awaited<ReturnType<typeof open>>;
  const choice=path.join(home,"active_profile");let expected:Awaited<ReturnType<typeof lstat>>;
  try{expected=await lstat(choice);if(!expected.isFile()||expected.isSymbolicLink())throw Error("profile记录不是普通文件");file=await open(choice,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw Error("Hermes活动profile无法安全读取，请核对原生CLI配置。");}
  try{
    const info=await file.stat();if(!info.isFile()||info.ino!==expected.ino||info.dev!==expected.dev||info.size>512)throw Error("Hermes活动profile记录无效或超过预算。");
    const buffer=Buffer.alloc(513),{bytesRead}=await file.read(buffer,0,513,0);if(bytesRead>512)throw Error("Hermes活动profile记录超过预算。");
    let value:string;try{value=new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,bytesRead)).replace(/^\uFEFF/,"").trim().toLowerCase();}catch{throw Error("Hermes活动profile记录不是有效UTF-8。");}
    if(!value)return undefined;if(!namePattern.test(value))throw Error("Hermes活动profile名称无效，未回退默认存储。");return value;
  }finally{await file.close();}
}

/** 初次跟随原生选择；已固定标签沿原profile，新标签才采用新的活动选择。 */
export async function resolveHermesProfile(home:string,pinned?:ExternalProfileBinding):Promise<ExternalProfileBinding>{
  const direct=path.basename(path.dirname(home))==="profiles";
  if(pinned&&!validExternalProfileBinding(pinned))throw Error("Hermes固定profile记录无效。");
  let name:string,source:ExternalProfileBinding["source"],selected:string;
  if(pinned){
    name=pinned.name;source=pinned.source;selected=source==="home"?home:name==="default"?home:path.join(home,"profiles",name);
    if(source==="home"&&(!direct||path.basename(home)!==name)||source!=="home"&&direct||source==="default"&&name!=="default"||selected!==pinned.selected)throw Error("Hermes固定profile不属于原目录，未启动外部会话。");
  }else if(direct){name=path.basename(home);source="home";selected=home;}
  else{const active=await activeProfile(home);name=active??"default";source=active?"active_profile":"default";selected=name==="default"?home:path.join(home,"profiles",name);}
  if(!namePattern.test(name))throw Error("Hermes固定profile名称无效。");
  if((direct||name!=="default")&&!await isDirectory(selected))throw Error("Hermes固定profile目录不存在，未回退默认存储。");
  return {kind:"hermes",name,selected,canonical:await canonicalExternalDirectory(selected),source};
}

/** 显式default防止根目录进程重新跟随活动profile；命名目录由HERMES_HOME固定。 */
export function hermesProfileArgs(profile:ExternalProfileBinding){return profile.name==="default"&&profile.source!=="home"?["-p","default"]:[];}
