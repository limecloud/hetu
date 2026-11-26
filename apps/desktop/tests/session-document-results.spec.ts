import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {agentSessionSandbox} from "../src/main/agent/context.ts";
import {discoverEngines} from "../src/main/agent/engines.ts";
import {closeApplication} from "./navigation.ts";

test("原会话保存文稿后打开固定历史、原范围重试及比较，当前稿与PTY保持",async({},info)=>{
 test.setTimeout(180000);
 test.skip(!(await discoverEngines()).some(engine=>engine.id==="claude-code"&&engine.available),"需本机原生CLI验证PTY，不发送模型请求");
 const root=path.resolve(import.meta.dirname,"../../.."),folder=await mkdtemp(path.join(os.tmpdir(),"hetu-session-document-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const seeded=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.stderr).toBe(0);const work=JSON.parse(seeded.stdout).novel;
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"默认小说"}]}]}));
 const executable=process.env.HETU_PACKAGED_APP;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),...(!executable?{HETU_PLUGIN_NODE:process.execPath,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
 const client=new Client({name:"hetu-session-document-acceptance",version:"1"},{});let connected=false;
 try{
  const page=await app.firstWindow(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await page.setViewportSize({width:1440,height:960});
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
  const launch=page.getByRole("dialog",{name:"创建会话",exact:true});await launch.getByRole("combobox",{name:"会话作品",exact:true}).selectOption({label:"默认小说"});
  await launch.getByRole("button",{name:/^引擎(?: |$)/}).click();await launch.getByRole("tab",{name:"Claude Code",exact:true}).click();await launch.getByRole("button",{name:"打开终端",exact:true}).click();await expect(launch).toHaveCount(0,{timeout:45000});
  const session=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));expect(session.terminal_connected).toBe(true);
  await page.evaluate(input=>window.hetuDesktop.agentSession("draft",input),{session_id:session.session_id,work_ref:work,text:"保留文稿会话草稿，不发送模型。"});
  const appPath=await app.evaluate(({app})=>app.getAppPath()),runtime=executable?path.join(path.dirname(appPath),"bin/node"):process.execPath;
  const config=path.join(agentSessionSandbox(profile,work),session.session_id!,"hetu-mcp.json");
  const transport=new StdioClientTransport({command:runtime,args:[path.join(appPath,"dist/agent-mcp-relay.mjs"),config],env:Object.fromEntries(Object.entries({...process.env,HETU_COLLABORATION_DIR:collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_NODE:runtime,HETU_PLUGIN_MANAGER:path.join(appPath,"dist/plugin-manager.mjs")}).filter((entry):entry is [string,string]=>typeof entry[1]==="string")),stderr:"pipe"});
  transport.stderr?.on("data",()=>{});await client.connect(transport);connected=true;
  const oldContent="# 雨夜来信\n\n只属于保存修订的来信🌿。\r\n\n阿青把原件收好。",newContent="# 雨夜来信\n\n这是后来改写的当前稿。";
  const result=await client.callTool({name:"hetu_call_action",arguments:{action:"hetu.execution.invoke",input:{workspace_path:workspace,command:{action:"hetu.documents.create",contract_revision:"1",input:{kind:"novel_chapter",title:"会话历史来信",source_format:"markdown",content:oldContent,operation_key:"session-document"}}}}});
  const outer=result.structuredContent as any;expect(outer.status,JSON.stringify(outer)).toBe("succeeded");expect(outer.data.result.status).toBe("succeeded");const original=outer.data.result.data,fixed={document_id:original.document.document_id,revision_id:original.revision.revision_id,sha256:original.revision.sha256};
  const updated=await page.evaluate(command=>window.hetuDesktop.execution({action:"hetu.execution.invoke",contract_revision:"1",input:{command}}),{action:"hetu.documents.save",contract_revision:"1",input:{document_id:fixed.document_id,base_revision_id:fixed.revision_id,source_format:"markdown",content:newContent,operation_key:"later-document"}});expect(updated.data.result.status).toBe("succeeded");
  await page.getByRole("button",{name:"查看作品成果",exact:true}).click();const panel=page.getByRole("region",{name:"作品成果",exact:true});const link=panel.getByRole("button",{name:"会话历史来信",exact:true});await expect(link).toBeEnabled({timeout:30000});await expect(panel).toContainText("当前写作稿已有更新");
  await app.evaluate(({ipcMain},reference)=>{const handlers=(ipcMain as any)._invokeHandlers,read=handlers.get("desktop:read");let failed=false;(globalThis as any).__fixedDocumentReads=[];handlers.set("desktop:read",async(event:any,action:string,input:any)=>{if(action==="hetu.documents.get"&&input.document_id===reference.document_id){(globalThis as any).__fixedDocumentReads.push(input.revision_id??"current");if(!failed&&input.revision_id===reference.revision_id){failed=true;throw Error("隔离验收：保存修订暂不可读。");}}return read(event,action,input);});},fixed);
  await link.click();const saved=page.getByRole("region",{name:"已保存文稿",exact:true});await expect(saved.getByRole("alert")).toContainText("保存修订暂不可读");
  await saved.getByRole("button",{name:"重新读取保存修订",exact:true}).last().click();await expect(saved).toHaveAttribute("data-revision-id",fixed.revision_id);await expect(saved).toHaveAttribute("aria-busy","false");
  await expect(saved).toContainText("只属于保存修订的来信");await expect(saved).not.toContainText("这是后来改写的当前稿");await expect(saved).toContainText("历史修订");expect(await saved.locator(".cm-editor").count()).toBe(0);
  await saved.getByRole("button",{name:"重新读取保存修订",exact:true}).click();await expect(saved).toHaveAttribute("aria-busy","false");await expect(saved).toHaveAttribute("data-revision-id",fixed.revision_id);
  expect(await app.evaluate(()=>(globalThis as any).__fixedDocumentReads)).toEqual([fixed.revision_id,fixed.revision_id,fixed.revision_id]);
  await saved.getByRole("button",{name:"与当前稿比较",exact:true}).click();const comparison=page.getByRole("dialog",{name:"比较修订 会话历史来信",exact:true});await expect(comparison).toBeVisible();await expect(comparison).toContainText("只属于保存修订的来信");await expect(comparison).toContainText("这是后来改写的当前稿");await comparison.getByRole("button",{name:"关闭修订比较",exact:true}).click();
  await page.screenshot({path:info.outputPath("fixed-document.png")});
  const preferences=await page.evaluate(()=>window.hetuDesktop.settings("preferences"));await page.evaluate(expected=>window.hetuDesktop.settings("update",{expected_revision:expected,patch:{appearance:"dark"}}),preferences.revision);await expect(page.locator("html")).toHaveAttribute("data-effective-appearance","dark");await page.setViewportSize({width:760,height:900});
  await expect.poll(()=>saved.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await expect(saved.getByRole("button",{name:"打开当前稿",exact:true})).toBeInViewport();await page.screenshot({path:info.outputPath("fixed-document-dark-narrow.png")});
  await saved.getByRole("button",{name:"打开当前稿",exact:true}).click();const current=page.getByRole("region",{name:"正文工作区",exact:true});await expect(current).toContainText("这是后来改写的当前稿");await expect(current.locator(".cm-editor")).toBeVisible();
  const actual=await page.evaluate(id=>window.hetuDesktop.read("hetu.documents.get",{document_id:id}),fixed.document_id);expect(actual.data.content).toBe(newContent);expect(actual.data.revision).toEqual(updated.data.result.data.revision);
  await page.evaluate(work_ref=>window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref}})),work);const resumed=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));expect(resumed.session_id).toBe(session.session_id);expect(resumed.generation).toBe(session.generation);expect(resumed.draft).toBe("保留文稿会话草稿，不发送模型。");expect(errors).toEqual([]);
  await writeFile(info.outputPath("result.json"),JSON.stringify({packaged:!!executable,model_turns:0,actual_mcp:true,fixed_reference:fixed,historical_read:true,retry_same_revision:true,refresh_same_revision:true,compared_current:true,current_head_unchanged:true,explicit_current_edit:true,dark_narrow:true,same_session:true,draft_retained:true},null,2));
 }catch(error){await app.windows()[0]?.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});throw error;}
 finally{if(connected)await client.close();await closeApplication(app,"window");}
});
