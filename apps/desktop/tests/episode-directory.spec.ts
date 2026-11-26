import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {AppServer} from "../src/main/rpc.ts";
import {navigate,closeApplication} from "./navigation.ts";
const root=path.resolve(import.meta.dirname,"../../..");
test("作品资料、正文及会话目录每集只显示一个入口，保留独立稿件和场次",async({},info)=>{
 test.setTimeout(90000);
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-episode-directory-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);const refs=JSON.parse(fixture.stdout);
 const core=await AppServer.open(path.join(root,"target/debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,contract_revision:"1",input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const documents:string[]=[];
 for(const [index,title] of ["归航","归航"].entries()){
  const project=await call("hetu.drama.projects.get",{project_id:refs.drama.object_id});
  const created=await call("hetu.drama.episodes.create",{project_ref:{project_id:project.project.project_id,revision:project.project.revision,sha256:project.sha256},title,language_tag:"zh-CN",operation_key:"episode-"+index});
  documents.push(created.document.document_id);
  await call("hetu.documents.save",{document_id:created.document.document_id,base_revision_id:created.document.current_revision_id,source_format:"fountain",content:"INT. 渡口 - 夜\n\n第"+(index+2)+"集独立正文。",operation_key:"script-"+index});
 }
 await core.close();await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.drama.workspace_id,works:[{work_ref:refs.drama,title:"默认剧本"},{work_ref:refs.novel,title:"默认小说"}]}]}));
 const executable=process.env.HETU_PACKAGED_APP;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_STATE_DIR:profile,...(!executable?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp"),HETU_PLUGIN_NODE:process.execPath}:{})}});
 try{
  const page=await app.firstWindow();await page.setViewportSize({width:1360,height:900});
  await page.getByRole("button",{name:"打开作品 默认剧本",exact:true}).click();
  const sidebar=page.getByRole("region",{name:"分集目录",exact:true});await expect(sidebar.locator("li button")).toHaveCount(3);
  await expect(sidebar.locator("h4")).toHaveCount(0);await expect(sidebar.getByText("第2集 归航",{exact:true})).toHaveCount(1);await expect(sidebar.getByText("第3集 归航",{exact:true})).toHaveCount(1);
  await page.screenshot({path:info.outputPath("profile-episode-directory.png")});
  await page.setViewportSize({width:760,height:900});await page.emulateMedia({colorScheme:"dark"});
  await expect(sidebar).toBeHidden();await page.getByRole("button",{name:"项目导航",exact:true}).click();
  await expect(sidebar.getByRole("button",{name:"第3集 归航",exact:true})).toBeVisible();
  expect(await sidebar.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:info.outputPath("profile-episode-directory-dark-760.png")});
  await page.setViewportSize({width:1360,height:900});await page.emulateMedia({colorScheme:"light"});
  await sidebar.getByRole("button",{name:"第2集 归航",exact:true}).focus();await page.keyboard.press("Enter");
  const reader=page.getByRole("article",{name:"分集剧本",exact:true});await expect(reader).toContainText("第2集独立正文。");
  const directory=page.getByRole("navigation",{name:"文稿目录",exact:true});await expect(directory.locator(".episode-entry > button")).toHaveCount(3);await expect(directory.locator(".chapter-group > summary")).toHaveCount(0);
  await directory.getByRole("button",{name:"归航",exact:true}).last().click();await expect(reader).toContainText("第3集独立正文。");await expect(directory.getByLabel("当前分集场次")).toContainText("INT. 渡口 - 夜");
  const reread=await page.evaluate(async ids=>Promise.all(ids.map(document_id=>window.hetuDesktop.read("hetu.documents.get",{document_id}))),documents);expect(reread.map(value=>value.data.content)).toEqual(["INT. 渡口 - 夜\n\n第2集独立正文。","INT. 渡口 - 夜\n\n第3集独立正文。"]);
  await navigate(page,"Agent 协作");await page.getByRole("button",{name:"关闭创建会话",exact:true}).click();
  const agent=page.getByRole("complementary",{name:"作品目录",exact:true});await expect(agent.locator(".agent-content-entry")).toHaveCount(3);await expect(agent.locator(".agent-content-group")).toHaveCount(0);
  await agent.getByRole("button",{name:"第3集 归航",exact:true}).click();await expect(page.getByRole("region",{name:"作品内容预览",exact:true})).toContainText("第3集独立正文。");await page.screenshot({path:info.outputPath("session-episode-directory.png")});
 }finally{await closeApplication(app);}
});
