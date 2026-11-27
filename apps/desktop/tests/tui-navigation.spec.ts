import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {navigate,closeApplication, workspaceAction} from "./navigation.ts";
import {AppServer} from "../src/main/rpc.ts";

const root=path.resolve(import.meta.dirname,"../../..");
for(const [client,width] of [["codex",2560],["shell",980]] as const)test(`${client}铺满时导航恢复真实小说页面，重开及并排保持原执行端 ${width}px`,async({},info)=>{
 test.skip(client==="codex"&&process.env.HETU_LIVE_ENGINES!=="1","真实Codex需要显式启用及已安装认证，Shell导航始终验收");
 test.setTimeout(150000);
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-tui-navigation-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const executable=process.env.HETU_PACKAGED_APP;
 const bin=executable?path.resolve(executable,"../../Resources/bin"):process.env.HETU_TEST_BIN_DIR??path.join(root,"target/debug");
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"LocalSettings"),HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_STATE_DIR:profile};
 const initialized=spawnSync(path.join(bin,"hetu"),["--client","codex","call","hetu.execution.initialize","--input","-"],{env,input:JSON.stringify({workspace_path:workspace,create:{title:"默认小说",locale:"zh-CN",operation_key:"initialize"}}),encoding:"utf8",timeout:30000});
 expect(initialized.status,initialized.error?.message??initialized.stderr+initialized.stdout).toBe(0);
 const core=await AppServer.open(path.join(bin,"hetu-app-server"),workspace);
 const call=async(action:string,input:any={})=>{const result=await core.request("workspace/request",{action,contract_revision:"1",input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 let refs:any;
 try{
  await call("hetu.documents.create",{kind:"novel_chapter",title:"第一章 雾港",source_format:"markdown",content:"灯塔在黎明前亮起。\n江岚合上旧日记。",operation_key:"chapter"});
  await call("hetu.drama.projects.create",{title:"默认剧本",mode:"original",operation_key:"drama"});
  const works=(await call("hetu.works.list")).works;refs={novel:works.find((item:any)=>item.work_ref.kind==="novel").work_ref,drama:works.find((item:any)=>item.work_ref.kind==="drama").work_ref};
 }finally{await core.close();}
 await mkdir(profile,{recursive:true});await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.novel.workspace_id,works:[{work_ref:refs.novel,title:"默认小说"},{work_ref:refs.drama,title:"默认剧本"}]}]}));
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...env,...(!executable?{HETU_APP_SERVER:path.join(bin,"hetu-app-server"),HETU_CLI:path.join(bin,"hetu"),HETU_MCP:path.join(bin,"hetu-mcp"),HETU_PLUGIN_NODE:process.execPath}:{})}});
 try{
  const page=await app.firstWindow();await page.setViewportSize({width,height:900});
  const get=(work=false)=>page.evaluate(async scope=>window.hetuDesktop.agentSession("get",scope),work?{work_ref:refs.novel}:{scope:"library"});
  const create=async()=>{
   const dialog=page.getByRole("dialog",{name:"创建会话",exact:true});await expect(dialog).toBeVisible();
   if(client==="shell"){await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();await dialog.getByRole("tab",{name:"终端",exact:true}).click();await dialog.getByRole("button",{name:"打开终端",exact:true}).click();}
   else await dialog.getByRole("button",{name:"创建",exact:true}).click();
   await expect(dialog).toHaveCount(0,{timeout:45000});
  };
  const connected=async(work=false)=>{
   await expect.poll(async()=>{const s=await get(work);return s.client===client&&s.terminal_connected&&(client!=="codex"||s.terminal_replay?.includes("]7501;state=idle"));},{timeout:45000}).toBe(true);
   return get(work);
  };
  const identity=(s:any)=>({session_id:s.session_id,thread_id:s.thread_id,generation:s.generation});
  const typeDraft=async(text:string)=>{await page.locator(".xterm-helper-textarea").focus();await page.keyboard.type(text);await expect(page.locator(".xterm-accessibility-tree")).toContainText(text);};
  const reopenLibrary=async()=>{await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();};
  const library=page.locator("main:has(.library-content)"),terminal=page.getByRole("main",{name:"终端工作区",exact:true}),sessionNavigation=page.getByRole("complementary",{name:"会话导航",exact:true});
  await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();await reopenLibrary();await create();
  const librarySession=await connected();await typeDraft("library-navigation-draft");
  // 经作品范围选择返回创作库会话，覆盖真实会话入口置为展开状态的路径。
  await sessionNavigation.getByRole("button",{name:"默认小说",exact:true}).click();
  await page.getByRole("button",{name:"关闭创建会话",exact:true}).click();
  await sessionNavigation.getByRole("button",{name:"创作库筹备",exact:true}).click();expect(identity(await connected())).toEqual(identity(librarySession));
  await sessionNavigation.getByRole("button",{name:"创作库",exact:true}).click();await page.getByRole("complementary",{name:"创作库导航",exact:true}).getByRole("button",{name:"小说",exact:true}).click();
  await expect(terminal).toBeHidden();await expect(library).toBeVisible();await expect(page.getByRole("button",{name:"打开作品 默认小说",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"打开作品 默认剧本",exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath("library-restored.png")});
  if(client==="shell")for(const label of ["全部作品","剧本","视频","小说"]){
   await reopenLibrary();await connected();
   await sessionNavigation.getByRole("button",{name:"创作库",exact:true}).click();await page.getByRole("complementary",{name:"创作库导航",exact:true}).getByRole("button",{name:label,exact:true}).click();
   await expect(terminal).toBeHidden();await expect(library).toBeVisible();await expect(library.getByRole("heading",{name:label==="全部作品"?"创作库":label,exact:true})).toBeVisible();
  }
  await reopenLibrary();expect(identity(await connected())).toEqual(identity(librarySession));await expect(page.locator(".xterm-accessibility-tree")).toContainText("library-navigation-draft");
  await workspaceAction(page,"关闭终端面板");await expect(library).toBeVisible();
  await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(page.getByRole("region",{name:"当前作品资料",exact:true})).toBeVisible();
  await navigate(page,"小说");const reader=page.getByRole("region",{name:"正文工作区",exact:true});await expect(reader).toContainText("灯塔在黎明前亮起");
  await page.getByRole("button",{name:"打开终端会话",exact:true}).click();await create();const workSession=await connected(true);await typeDraft("work-navigation-draft");
  await sessionNavigation.getByRole("button",{name:"小说",exact:true}).click();
  await expect(terminal).toBeHidden();await expect(reader).toBeVisible();await expect(reader).toContainText("灯塔在黎明前亮起");
  await page.getByRole("button",{name:"打开终端会话",exact:true}).click();expect(identity(await connected(true))).toEqual(identity(workSession));await expect(page.locator(".xterm-accessibility-tree")).toContainText("work-navigation-draft");
  await sessionNavigation.getByRole("button",{name:"创作库",exact:true}).click();await expect(library).toBeVisible();await expect(terminal).toBeHidden();
  await reopenLibrary();expect(identity(await connected())).toEqual(identity(librarySession));await expect(page.locator(".xterm-accessibility-tree")).toContainText("library-navigation-draft");
  await workspaceAction(page,"关闭终端面板");await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await navigate(page,"小说");await expect(reader).toBeVisible();
  await navigate(page,"Agent 协作");expect(identity(await connected(true))).toEqual(identity(workSession));
  await page.setViewportSize({width:1600,height:900});await workspaceAction(page,"并排查看作品");
  await expect(reader).toBeVisible();await expect(page.getByRole("complementary",{name:"终端工作区",exact:true})).toBeVisible();
  expect(identity(await get(true))).toEqual(identity(workSession));await expect(page.locator(".xterm-accessibility-tree")).toContainText("work-navigation-draft");
  await page.screenshot({path:info.outputPath("novel-and-original-terminal.png")});
  expect((await get(true)).messages).toHaveLength(0);expect((await get()).messages).toHaveLength(0);
 }finally{await closeApplication(app);}
});
