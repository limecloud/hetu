import { spawn } from "node:child_process";
import path from "node:path";
import { access } from "node:fs/promises";

const dialogs=new Set<ReturnType<typeof spawn>>();
export function cancelNativeDialogs(){for(const child of dialogs)child.kill();}

/** MCP工作台仅在文件选择或固定决定时请求原生交互；作品执行不依赖桌面窗口。 */
export async function nativeDialog(kind: string, options: any): Promise<any> {
  const bin=process.env.HETU_WORKBENCH_BIN!;
  const packaged=process.platform==="darwin"?path.resolve(bin,"../../MacOS/Hetu"):path.resolve(bin,"../..",process.platform==="win32"?"Hetu.exe":"Hetu");
  const executable=process.env.HETU_DESKTOP_EXECUTABLE??packaged;
  let command=executable,args=["--hetu-dialog"];
  try{await access(executable);}catch{
    const root=path.resolve(import.meta.dirname,"../../..");
    command=path.join(root,"node_modules/electron/dist",process.platform==="darwin"?"Electron.app/Contents/MacOS/Electron":process.platform==="win32"?"electron.exe":"electron");
    args=[path.join(root,"apps/desktop"),"--hetu-dialog"];
  }
  return new Promise((resolve,reject)=>{
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(command,args,{stdio:"pipe",shell:false,windowsHide:false,env});
    dialogs.add(child);
    let output=Buffer.alloc(0);
    const timer=setTimeout(()=>{child.kill();reject(new Error("原生确认未完成，原操作保留。"));},300000);
    child.stdout.on("data",bytes=>{output=Buffer.concat([output,bytes]);if(output.length>65536){child.kill();}});
    child.stderr.on("data",()=>{});child.stdin.on("error",()=>{});
    child.on("error",()=>{clearTimeout(timer);reject(new Error("无法打开原生文件选择或确认窗口。"));});
    child.on("close",()=>{dialogs.delete(child);clearTimeout(timer);try{const result=JSON.parse(output.toString());if(!result.ok)throw new Error(result.message??"原生交互未完成。");resolve(result.value);}catch(error){reject(error);}});
    child.stdin.end(JSON.stringify({kind,options}));
  });
}
