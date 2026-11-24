import {test,expect,_electron as electron} from "@playwright/test";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {navigate} from "./navigation.ts";
const root=path.resolve(import.meta.dirname,"../../..");
test("真实TUI保存回执回读Core，直接打开固定参考稿批次及交付页面",async()=>{
 test.skip(process.env.HETU_LIVE_CODEX!=="1","接续隔离真实TUI业务验收记录，不发模型请求");test.setTimeout(120000);
 const source=JSON.parse(await readFile(path.join(root,"output/codex-creation-validation/private-result.json"),"utf8"));
 const executable=process.env.HETU_PACKAGED_APP;
 const env={...process.env};for(const key of ["HETU_APP_SERVER","HETU_CLI","HETU_MCP","HETU_PLUGIN_NODE","ELECTRON_RUN_AS_NODE"])delete env[key];
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...env,HETU_DESKTOP_PROFILE:source.profile,HETU_COLLABORATION_DIR:source.collaboration,...(!executable?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
 try{
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
  await page.getByRole("button",{name:"打开作品 TUI全流程验收",exact:true}).click();
  await expect(page.getByRole("complementary",{name:"项目导航",exact:true})).toBeVisible();
  const lifecycle=JSON.parse(await readFile(path.join(root,"output/codex-creation-validation/private-lifecycle.json"),"utf8"));
  await page.evaluate(id=>window.hetuDesktop.agentSession("select",{session_id:id}),lifecycle.revised.session_id);
  await navigate(page,"Agent 协作");await page.getByRole("button",{name:"查看作品成果",exact:true}).click();
  const panel=page.getByRole("region",{name:"作品成果",exact:true});
  await expect(page.getByRole("button",{name:"查看作品成果",exact:true})).toBeEnabled({timeout:45000});
  const outcomes=await page.evaluate(()=>window.hetuDesktop.agentSession("results"));
  expect(outcomes.items.map((item:any)=>item.kind)).toEqual(expect.arrayContaining(["bundle","submission"]));
  expect(outcomes.items.map((item:any)=>({kind:item.kind,state:item.state,message:item.message}))).toEqual(expect.arrayContaining([{kind:"bundle",state:"verified",message:undefined},{kind:"submission",state:"verified",message:undefined}]));
  await expect(panel.getByText("已回读",{exact:true})).toHaveCount(outcomes.items.length);
  await page.screenshot({path:path.join(root,"output/codex-creation-validation",executable?"tui-results-packaged.png":"tui-results.png")});
  const fixed=outcomes.items.find((item:any)=>item.kind==="submission");
  await panel.getByRole("button",{name:fixed.title,exact:true}).click();
  await expect(page.getByText("正在查看固定成果批次",{exact:true})).toBeVisible();
  await expect(page.frameLocator('iframe[title="任务候选审阅"]').locator("body")).toContainText("钟声三下");
  await expect(page.getByText("采纳到作者正文",{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"查看最新成果",exact:true}).click();
  await expect(page.getByText("采纳到作者正文",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"打开终端会话",exact:true}).click();
  await page.getByRole("button",{name:"查看作品成果",exact:true}).click();
  await page.getByRole("region",{name:"作品成果",exact:true}).getByRole("button",{name:"审阅交付包",exact:true}).click();
  await expect(page.getByRole("heading",{name:"作品交付",exact:true})).toBeVisible();
  const s=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));expect(s.state).toBe("idle");
 }finally{await app.close();}
});
