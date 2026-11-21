import {test,expect} from "@playwright/test";
import type {PluginPackage} from "../../../packages/plugin-host/src/package.ts";
import {pluginViewHTML} from "../../desktop/src/main/mcp-plugin-view.ts";

for(const head of [false,true])for(const external of [false,true])test(`插件HTML ${head?"显式":"省略"}head ${external?"相对":"内联"}脚本中的标签不影响桥接`,async({page})=>{
 const script='const template="<header>标题</header><head>字面量</head>";window.hetu.context().then(value=>{document.getElementById("root").textContent=value.title;});';
 const source=`<!doctype html><html lang="zh-CN">${head?'<head><meta charset="utf-8"></head>':""}<div id="root"></div><script${external?' src="view.js"':""}>${external?"":script}</script></html>`;
 const files=new Map([["index.html",Buffer.from(source)],["view.js",Buffer.from(script)]]);
 const pkg={file:(name:string)=>{const bytes=files.get(name);if(!bytes)throw Error(name);return bytes;}} as PluginPackage;
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 await page.setContent("<!doctype html><div id=host></div>");
 await page.evaluate(html=>{
  addEventListener("message",event=>{if(event.data?.hetuPlugin==="regression")(event.source as Window)?.postMessage({hetuPlugin:"regression",id:event.data.id,value:{title:"插件已读取当前作品"}},"*");});
  const frame=document.createElement("iframe");frame.title="插件";frame.setAttribute("sandbox","allow-scripts");document.body.append(frame);frame.srcdoc=html;
 },pluginViewHTML(pkg,"index.html","regression"));
 await expect(page.frameLocator("iframe").locator("#root")).toHaveText("插件已读取当前作品");
 expect(errors).toEqual([]);
 expect(await page.frameLocator("iframe").locator("head meta[http-equiv]").count()).toBe(1);
});
