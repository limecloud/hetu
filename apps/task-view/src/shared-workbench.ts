import { createAppHost } from "./host/bridge.ts";
import { libraryAssets } from "./workbench/assets.ts";
import type { DesktopBridge } from "../../desktop/src/renderer/bridge.ts";

const host=createAppHost("Hetu Luoshu shared workbench");
const listeners=new Map<string,Set<(value:any)=>void>>();
const emit=(name:string,value:any)=>{
 listeners.get(name)?.forEach(listener=>listener(value));
 if(name==="onPreferences")pluginFrame?.contentWindow?.postMessage({hetuPlugin:pluginChannel,preferences:{theme:value.appearance,language:value.language??"zh-CN"}},"*");
};
let session="",started=false;
const ready:Promise<void>=new Promise(resolve=>{
 host.ontoolresult=async result=>{
  const token=(result as any)._meta?.["hetu/workbenchSession"];
  if(typeof token!=="string"){if(!started){started=true;await host.close();document.getElementById("legacy-style")?.removeAttribute("media");document.getElementById("root")!.hidden=true;await import("./workbench.ts");}return;}
  if(started)return;
  const data=((result.structuredContent as any)?.data??{}),rows=data.works??[];
  (window as any).hetuWorkbenchInitial={work_ref:data.request?.work_ref??data.work_ref??(data.app?.route==="works"&&rows.length===1?rows[0].work_ref:undefined),task_id:data.task_ref?.task_id};
  session=token;document.getElementById("app")!.style.display="none";started=true;resolve();
 };
});
const media=new Map<string,{source:string}>();
let pluginFrame:HTMLIFrameElement|undefined,pluginChannel="";
const flushes=new Map<string,{resolve():void;reject(error:Error):void}>();
async function releasePlugin(){
 if(pluginFrame){const id=crypto.randomUUID();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{flushes.delete(id);reject(new Error("插件恢复稿未完成，请保留当前工作面。"));},10000);flushes.set(id,{resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}});pluginFrame!.contentWindow!.postMessage({hetuPlugin:pluginChannel,flush:id},"*");});pluginFrame.remove();pluginFrame=undefined;}
}
addEventListener("message",async event=>{
 if(!pluginFrame||event.source!==pluginFrame.contentWindow||event.data?.hetuPlugin!==pluginChannel)return;
 const value=event.data;
 if(value.flushed){const pending=flushes.get(value.flushed);flushes.delete(value.flushed);value.error?pending?.reject(new Error(value.error)):pending?.resolve();return;}
 if(!Number.isSafeInteger(value.id)||!["context","buffer","request","invoke","host"].includes(value.method)||!Array.isArray(value.args))return;
 try{const args=value.method==="buffer"&&value.args[0]===undefined?[]:value.args;let result=await call("pluginCall",[pluginChannel,value.method,args]);if(value.method==="host"&&value.args[0]==="media_open")result={...result,blob:await mediaFile(result)};pluginFrame?.contentWindow?.postMessage({hetuPlugin:pluginChannel,id:value.id,value:result},"*");}
 catch(error){pluginFrame?.contentWindow?.postMessage({hetuPlugin:pluginChannel,id:value.id,error:(error as Error).message},"*");}
});
async function releaseMedia(url:string){const entry=media.get(url);if(entry){URL.revokeObjectURL(url);media.delete(url);return call("media",["release",{url:entry.source}]);}}
async function mediaFile(opened:any){
 const parts:Uint8Array[]=[];
 try{for(let offset=0;offset<opened.size_bytes;offset+=512*1024){const length=Math.min(512*1024,opened.size_bytes-offset);const value=await call("mediaChunk",[opened.url,offset,length]);parts.push(Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0)));}return new Blob(parts as BlobPart[],{type:opened.media_type});}catch(error){await call("media",["release",{url:opened.url}]);throw error;}
}
async function mediaBlob(opened:any){const blob=await mediaFile(opened),url=URL.createObjectURL(blob);media.set(url,{source:opened.url});return {...opened,url};}
async function call(method:string,args:any[]=[]):Promise<any>{
 await ready;
 // postMessage保留undefined，Codex会在转发前拒绝非JSON值；省略与显式null仍须分别恢复。
 const parameters=JSON.parse(JSON.stringify({session,method,args,undefined_args:Array.from(args).flatMap((value,index)=>value===undefined?[index]:[])}));
 const response=await host.callServerTool({name:"hetu_app_request",arguments:parameters});
 if(response.isError)throw new Error(response.content?.find(value=>value.type==="text")?.text??"操作未完成，请沿原操作回读。");
 const result=(response.structuredContent??{}) as any;
 for(const event of result.events??[])emit(event.name,event.value);
 if(typeof result.copied==="string"){
   if(host.features().drafts){const delivered=await host.sendText(result.copied,"active",false);if(delivered.isError)throw new Error("宿主未接受协作请求，请核对当前草稿后继续。");}
   else await call("copy",[result.copied]);
 }
 if(method==="settings"&&["update","commit","recover"].includes(args[0])){const state=await call("settings",["get"]);emit("onPreferences",state.preferences);}
 return result.value;
}
const bridge=new Proxy({} as DesktopBridge,{
 get(_target,method:string){
  if(method==="windowControls"){const modes=host.getHostContext()?.availableDisplayModes;return {zoom:!!(modes?.includes("fullscreen")&&modes.includes("inline"))};}
  if(method==="bounds")return async()=>{};
  if(method==="zoom")return async()=>{const context=host.getHostContext(),mode=context?.displayMode==="fullscreen"?"inline":"fullscreen";if(context?.availableDisplayModes?.includes(mode))await host.requestDisplayMode({mode});};
  if(method.startsWith("on"))return (listener:(value:any)=>void)=>{const group=listeners.get(method)??new Set();listeners.set(method,group);group.add(listener);return()=>group.delete(listener);};
  if(method==="settingsWindow")return async(action:string)=>{window.dispatchEvent(new CustomEvent("hetu:settings-window",{detail:action}));};
  if(method==="closeSurface")return async()=>{await releasePlugin();return call(method);};
  if(method==="view")return async(...args:any[])=>{await releasePlugin();const value=await call(method,args);pluginChannel=value.channel;await new Promise(requestAnimationFrame);const target=document.querySelector(".surface");if(!target)throw new Error("插件工作面未能装配。");pluginFrame=document.createElement("iframe");pluginFrame.title="创作插件";pluginFrame.setAttribute("sandbox","allow-scripts");pluginFrame.style.cssText="width:100%;height:100%;border:0;display:block";target.append(pluginFrame);pluginFrame.srcdoc=value.html;};
  if(method==="media")return async(action:string,input:any)=>action==="release"?releaseMedia(input.url):mediaBlob(await call("media",[action,input]));
  return (...args:any[])=>call(method,args);
 }
});
window.hetuDesktop=bridge;
(window as any).hetuWorkbenchAssets=libraryAssets;
(window as any).hetuTaskViewResource=async()=>{const result=await host.readServerResource({uri:"ui://hetu/task-view/1"});return result.contents.find(item=>"text"in item)?.text;};
host.onhostcontextchanged=context=>{if(context.theme)document.documentElement.dataset.theme=context.theme;};
async function closeSettings(){
 if(!document.querySelector("dialog.embedded-settings"))return;
 await new Promise<void>((resolve,reject)=>{
  const finished=(event:Event)=>{if((event as CustomEvent).detail!=="close")return;clearTimeout(timer);window.removeEventListener("hetu:settings-window",finished);resolve();};
  const timer=setTimeout(()=>{window.removeEventListener("hetu:settings-window",finished);reject(new Error("设置保存尚未完成，请保留当前面板并沿原操作恢复。"));},10000);
  window.addEventListener("hetu:settings-window",finished);
  window.dispatchEvent(new Event("hetu:settings-close-request"));
 });
}
host.onteardown=async()=>{await closeSettings();await releasePlugin();if(session)await call("close");for(const url of media.keys())URL.revokeObjectURL(url);media.clear();return {};};
await host.connect();
await ready;
await import("../../desktop/src/renderer/index.tsx");
