import {expect,_electron as electron,type ElectronApplication,type Page,type FrameLocator} from "@playwright/test";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {build} from "esbuild";
import {createServer,type Server} from "node:http";
import path from "node:path";
import {codexWorkbench} from "./codex-workbench.ts";
import {closeApplication} from "../../desktop/tests/navigation.ts";

export type WorkbenchSurface="desktop"|"stdio"|"codex";
export type WorkbenchObserver=(method:string,args:any[],run:()=>Promise<any>)=>Promise<any>;

/** 三入口共用实际工作台，观察器仅控制测试边界，不替代业务执行。 */
export async function openWorkbenchHost(surface:WorkbenchSurface,page:Page,environment:NodeJS.ProcessEnv,observe:WorkbenchObserver=(_method,_args,run)=>run()) {
  const root=path.resolve("../..");
  const env=Object.fromEntries(Object.entries(environment).filter((entry):entry is [string,string]=>entry[1]!==undefined));
  let app:ElectronApplication|undefined,client:any,server:Server|undefined,view:Page|FrameLocator;
  async function close(via: "window" | "app" = "window") {
    if(app) {
      // 隔离夹具即使断言失败也保留恢复稿，沿正常关闭路径退出。
      await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});}).catch(()=>{});
      await closeApplication(app,via);
    }
    await client?.close();
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  }
  try {
    if(surface==="desktop") {
      app=await electron.launch(process.env.HETU_PACKAGED_APP?{executablePath:process.env.HETU_PACKAGED_APP,args:[],env}:{args:[path.join(root,"apps/desktop")],env:{...env,HETU_APP_SERVER:env.HETU_APP_SERVER??path.join(root,"target/debug/hetu-app-server")}});
      page=await app.firstWindow();view=page;
    } else {
      const binary=process.env.HETU_ACCEPT_MCP_BINARY??path.join(root,"target/debug/hetu-mcp");
      if(surface==="codex")client=await codexWorkbench(process.env.HETU_ACCEPT_CODEX_BINARY!,binary,env);
      else {
        client=new Client({name:"hetu-workbench-business",version:"1"},{capabilities:{extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}}});
        const transport=new StdioClientTransport({command:binary,args:["--client","codex","--collaboration-dir",env.HETU_COLLABORATION_DIR!],env:env as Record<string,string>,stderr:"pipe"});
        transport.stderr?.on("data",()=>{});
        await client.connect(transport);
      }
      const initial=await client.callTool({name:"hetu_open_app",arguments:{}}),tools=await client.listTools();
      const uri=tools.tools.find((item:any)=>item.name==="hetu_open_app")._meta.ui.resourceUri;
      const resource=await client.readResource({uri});
      const host=await build({entryPoints:["tests/host.ts"],bundle:true,write:false,format:"esm",target:"es2022"});
      server=createServer(async(request,response)=>{
        try {
          if(request.url==="/rpc") {
            const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
            const {method,params}=JSON.parse(Buffer.concat(chunks).toString());
            const result=method==="tools/call"?await observe(params.arguments?.method??params.name,params.arguments?.args??[],()=>client.callTool(params)):await client.readResource(params);
            response.setHeader("Content-Type","application/json");response.end(JSON.stringify(result));
          } else {
            response.setHeader("Content-Type",request.url==="/host.js"?"application/javascript":"text/html");
            response.end(request.url==="/host.js"?host.outputFiles[0].text:'<!doctype html><meta charset="utf-8"><script type="module" src="/host.js"></script>');
          }
        } catch(error) {response.writeHead(500);response.end(String(error));}
      });
      await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));
      await page.addInitScript(value=>Object.assign(window,value),{viewHtml:resource.contents[0].text,initialTask:initial,realTask:true,workbenchMode:true});
      await page.goto("http://127.0.0.1:"+(server.address() as {port:number}).port);view=page.frameLocator("iframe");
      await expect(view.locator("#root")).toBeVisible();
    }
    return {app,page,view,close};
  } catch(error) {await close();throw error;}
}
