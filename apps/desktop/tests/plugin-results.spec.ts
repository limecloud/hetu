import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { navigate } from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../..");
function json(command: string,args: string[],input?: unknown,timeout=30000) {
  const result=spawnSync(command,args,{encoding:"utf8",timeout,input:input===undefined?undefined:JSON.stringify(input)});
  expect(result.status,result.error?.message??result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
test("插件成果搜索分页、固定导出与精确AI交接，停用后可读且不混入其他作品", async()=>{
  test.setTimeout(300000);
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-plugin-results-"));
  const workspace=path.join(folder,"中文 作品"),access=path.join(folder,"private");
  const pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
  const fixture=json(path.join(root,"target/debug/examples/plugin_fixture"),[workspace,access,path.join(pkg.source,"plugin.json"),pkg.sha256,"0","--plugin-results"],undefined,120000);
  const executable=process.env.HETU_PACKAGED_APP;
  const env: Record<string,string|undefined>={...process.env,HETU_DESKTOP_PROFILE:path.join(folder,"profile"),HETU_COLLABORATION_DIR:path.join(folder,"collaboration"),HETU_PLUGIN_ACCESS_DIR:access};
  for(const key of ["HETU_APP_SERVER","HETU_CLI","HETU_PLUGIN_NODE","HETU_PLUGIN_CLI","ELECTRON_RUN_AS_NODE"])delete env[key];
  if(!executable)Object.assign(env,{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_PLUGIN_NODE:process.execPath});
  const app=await electron.launch({...executable?{executablePath:executable}:{args:[path.join(root,"apps/desktop")]},env});
  let client: Client|undefined;
  try {
    await app.evaluate(({dialog,clipboard},directory)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});
      dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});
      let copied="";clipboard.writeText=value=>{copied=value;};clipboard.readText=()=>copied;
    },workspace);
    const page=await app.firstWindow();
    await page.getByRole("button",{name:"打开作品",exact:true}).first().click();
    await page.getByRole("button",{name:/插件集成测试/}).click();
    const resources=executable?await app.evaluate(()=>process.resourcesPath):undefined;
    const cli=resources?path.join(resources,"bin/hetu-plugin"):path.join(root,"target/debug/hetu-plugin");
    function update(index: number,title: string) {
      const before=fixture.plugin_objects[index];
      return json(cli,["--workspace",workspace,"--access-dir",access,"--grant",fixture.grant_id,"--package-sha256",pkg.sha256,"call","hetu.extensions.objects.save","--input","-"],{
        work_ref:fixture.work_ref,object_id:before.object.object_id,kind:"relationships",title,schema_version:"1",content:before.object.content,
        expected_revision:1,expected_sha256:before.sha256,operation_key:"update-result-"+index,
      });
    }
    await navigate(page,"创作插件");
    await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},pkg.source);
    await page.getByRole("button",{name:"安装插件包",exact:true}).click();
    const pluginRow=()=>page.locator(".row").filter({has:page.getByText(pkg.manifest.display["zh-CN"],{exact:true})}).first();
    await pluginRow().getByRole("button",{name:"读取成果",exact:true}).click();
    const panel=page.getByRole("region",{name:"插件成果",exact:true});
    await expect(page.getByRole("button",{name:"让 AI 处理",exact:true})).toHaveCount(1);
    const rows=panel.locator('[aria-label="插件成果列表"]').locator(".row");
    await expect(rows).toHaveCount(20);
    update(0,"新版成果01");
    await panel.getByRole("button",{name:"继续读取成果",exact:true}).click();
    await expect(panel.getByRole("alert")).toContainText("从第一页重新读取");
    await panel.getByRole("button",{name:"重新读取成果",exact:true}).click();
    await expect(rows).toHaveCount(20);
    await panel.getByRole("button",{name:"继续读取成果",exact:true}).click();
    await expect(rows).toHaveCount(22);
    await expect(panel.getByRole("button",{name:"继续读取成果",exact:true})).toHaveCount(0);
    // 只延迟真实Core的响应，保持原数据和业务入口；检验旧查询回包不能覆盖新结果。
    await app.evaluate(({ipcMain})=>{
      const handlers=(ipcMain as any)._invokeHandlers, original=handlers.get("desktop:fallback");
      handlers.set("desktop:fallback",async(...args: any[])=>{
        const value=await original(...args);
        if(args[2]==="hetu.extensions.objects.search"&&args[3]?.query==="雾港")
          await new Promise<void>(resolve=>{(globalThis as any).__releaseResultSearch=resolve;});
        return value;
      });
    });
    const search=panel.getByRole("textbox",{name:"搜索插件成果"});
    await search.fill("雾港");await panel.getByRole("button",{name:"搜索",exact:true}).click();
    await expect.poll(()=>app.evaluate(()=>!!(globalThis as any).__releaseResultSearch)).toBe(true);
    await search.fill("没有这个成果");await search.press("Enter");
    await expect(panel).toContainText("没有匹配的成果。");
    await app.evaluate(()=>{(globalThis as any).__releaseResultSearch();});
    await page.evaluate(async(owner)=>{await window.hetuDesktop.fallback(owner,"hetu.extensions.index.status",{});},pkg.manifest.id);
    await expect(rows).toHaveCount(0);
    await search.fill("雾港成果22");await search.press("Enter");await expect(rows).toHaveCount(1);
    await rows.getByRole("button",{name:"查看导出",exact:true}).click();
    const preview=panel.getByRole("region",{name:"固定插件成果导出",exact:true});
    await expect(preview.getByRole("heading")).toHaveText("雾港成果22 第1版");
    update(21,"新版成果22");
    await panel.getByRole("button",{name:"让 AI 处理",exact:true}).click();
    await expect(panel.getByRole("status")).toHaveText("已复制插件成果的协作请求。");
    const handoff=await app.evaluate(({clipboard})=>JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")));
    expect(handoff.management_ref).toBeUndefined();
    expect(handoff.fixed_refs[0]).toMatchObject({kind:"plugin_object",owner_plugin_id:pkg.manifest.id,object_id:fixture.plugin_objects[21].object.object_id,revision:1,sha256:fixture.plugin_objects[21].sha256});
    expect(handoff.plugin_connection.work_ref).toEqual(fixture.work_ref);
    const connection=handoff.plugin_connection;
    client=new Client({name:"hetu-result-handoff",version:"1"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
    await client.connect(new StdioClientTransport({command:connection.node_executable,args:[connection.runtime,"--package",connection.package_path,"--workspace",connection.workspace_path,"--access-dir",access,"--grant",connection.grant_id,"--package-sha256",connection.package_sha256,"--core-cli",connection.core_cli,"--mcp"],stderr:"pipe"}));
    const historic=await client.callTool({name:"plugin_objects_get",arguments:{object_id:handoff.fixed_refs[0].object_id,revision:1}});
    expect((historic.structuredContent as any).data.sha256).toBe(handoff.fixed_refs[0].sha256);
    expect((historic.structuredContent as any).data.object.title).toBe("雾港成果22");
    await preview.getByRole("button",{name:"复制导出内容",exact:true}).focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("status")).toHaveText("已复制此版本的导出内容。");
    expect(await app.evaluate(({clipboard})=>clipboard.readText())).toContain('"title": "雾港成果22"');
    await app.browserWindow(page).then(window=>window.evaluate(win=>win.setSize(960,740)));
    await expect.poll(()=>panel.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    const sizes=await panel.evaluate(element=>[...new Set(Array.from(element.querySelectorAll("*"),node=>getComputedStyle(node).fontSize))]);
    expect(sizes.every(size=>["12px","14px","18px","20px"].includes(size))).toBe(true);
    await page.emulateMedia({colorScheme:"light"});
    await page.screenshot({path:path.join(root,"output/plugin-doc-qa/transfer/plugin-results-narrow.png")});
    await page.emulateMedia({colorScheme:"dark"});
    await page.screenshot({path:path.join(root,"output/plugin-doc-qa/transfer/plugin-results-narrow-dark.png")});
    await app.browserWindow(page).then(window=>window.evaluate(win=>win.setSize(1280,900)));
    await panel.getByRole("button",{name:"返回创作插件",exact:true}).click();
    await pluginRow().getByRole("button",{name:"停用",exact:true}).click();
    await pluginRow().getByRole("button",{name:"读取成果",exact:true}).click();
    await expect(panel.getByRole("button",{name:"让 AI 处理",exact:true})).toBeDisabled();
    await search.fill("新版成果22");await search.press("Enter");await expect(rows).toHaveCount(1);
    await rows.getByRole("button",{name:"查看导出",exact:true}).click();
    await expect(preview.getByRole("heading")).toHaveText("新版成果22 第2版");
    await page.getByRole("button",{name:"返回创作库",exact:true}).click();
    await page.getByRole("button",{name:/独立剧本/}).click();
    await navigate(page,"创作插件");await pluginRow().getByRole("button",{name:"读取成果",exact:true}).click();
    await expect(panel).toContainText("还没有保存的插件成果。");
    await expect(preview).toHaveCount(0);
  } finally {await client?.close();await app.close();}
});
