import path from "node:path";
import type {PluginPackage} from "@hetu/plugin-host";

/** 将已核验插件包装配为离线沙箱页面；相对资源只从同一包读取。 */
export function pluginViewHTML(pkg:PluginPackage,entry:string,channel:string){
 const file=(name:string,base=entry)=>{
  if(/^[a-z]+:|^[/\\]|[?#]/i.test(name))throw new Error("插件页面只能引用当前包内的相对资源。");
  const relative=path.posix.normalize(path.posix.join(path.posix.dirname(base),name));
  if(relative.startsWith("../"))throw new Error("插件资源超出包范围。");
  return {relative,bytes:pkg.file(relative)};
 };
 let html=pkg.file(entry).toString("utf8");
 const data=(name:string,base?:string)=>{const value=file(name,base),ext=path.posix.extname(name);const mime=({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".svg":"image/svg+xml",".woff2":"font/woff2"} as Record<string,string>)[ext]??"application/octet-stream";return "data:"+mime+";base64,"+value.bytes.toString("base64");};
 const scripts:string[]=[];
 html=html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi,(_all,attributes,content)=>{
  const source=/\bsrc=["']([^"']+)["']/i.exec(attributes);
  const code=source?file(source[1]).bytes.toString("utf8"):content;
  const index=scripts.push("<script>"+code.replaceAll("</script","<\\/script")+"</script>")-1;
  return "<!--hetu-script-"+index+"-->";
 });
 html=html.replace(/<link\b[^>]*\bhref=["']([^"']+\.css)["'][^>]*>/gi,(_all,src)=>{const value=file(src);const css=value.bytes.toString("utf8").replace(/url\(["']?([^)"']+)["']?\)/g,(_all,url)=>url.startsWith("data:")?"url("+url+")":"url("+data(url,value.relative)+")");return "<style>"+css+"</style>";});
 html=html.replace(/\bsrc=["']([^"']+)["']/gi,(_all,src)=>'src="'+(src.startsWith("data:")?src:data(src))+'"');
 html=html.replace(/<!--hetu-script-(\d+)-->/g,(_all,index)=>scripts[Number(index)]);
 const bootstrap='(()=>{const channel='+JSON.stringify(channel)+';let next=0;const pending=new Map(),close=new Set(),preferences=new Set(),media=new Map();const call=(method,args=[])=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});parent.postMessage({hetuPlugin:channel,id,method,args},"*");});addEventListener("message",async event=>{if(event.source!==parent||event.data?.hetuPlugin!==channel)return;const value=event.data;if(value.preferences){for(const handler of preferences)handler(value.preferences);return;}if(value.flush){try{for(const handler of close)await handler();parent.postMessage({hetuPlugin:channel,flushed:value.flush},"*");}catch(error){parent.postMessage({hetuPlugin:channel,flushed:value.flush,error:error.message},"*");}return;}const request=pending.get(value.id);if(request){pending.delete(value.id);value.error?request.reject(new Error(value.error)):request.resolve(value.value);}});window.hetu=Object.freeze({context:()=>call("context"),buffer:(...args)=>call("buffer",args),request:(...args)=>call("request",args),invoke:(...args)=>call("invoke",args),host:async(action,input={})=>{if(action==="media_release"&&media.has(input.url)){const source=media.get(input.url);URL.revokeObjectURL(input.url);media.delete(input.url);return call("host",[action,{url:source}]);}const value=await call("host",[action,input]);if(action==="media_open"&&value.blob){const url=URL.createObjectURL(value.blob);media.set(url,value.url);return {url,media_type:value.media_type,size_bytes:value.size_bytes};}return value;},onBeforeClose:handler=>{close.add(handler);return()=>close.delete(handler);},onPreferences:handler=>{preferences.add(handler);return()=>preferences.delete(handler);}});})();';
 const csp="<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data: blob:;media-src blob:;font-src data:;connect-src 'none';frame-src 'none';object-src 'none';base-uri 'none';form-action 'none'\">";
 const prefix=csp+"<script>"+bootstrap+"</script>";
 return /<head[^>]*>/i.test(html)?html.replace(/<head[^>]*>/i,match=>match+prefix):prefix+html;
}
