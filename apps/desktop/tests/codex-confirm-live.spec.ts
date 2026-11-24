import {test,expect,_electron as electron} from "@playwright/test";
import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {navigate} from "./navigation.ts";
const root=path.resolve(import.meta.dirname,"../../.."),output=path.join(root,"output/codex-creation-validation");
function result(snapshot:any,action:string){return snapshot.tools.flatMap((tool:any)=>{try{const r=JSON.parse(tool.output).structuredContent;return r?.action===action&&r.status==="succeeded"?[r.data]:[];}catch{return [];}}).at(-1);}
test("真实TUI遵守confirm：先准备固定资料，经作者审阅后沿原方案执行",async()=>{
 test.skip(process.env.HETU_LIVE_CODEX!=="1","需明确启用真实本机Codex验收");test.setTimeout(900000);
 const source=JSON.parse(await readFile(path.join(output,"private-result.json"),"utf8")),progressPath=path.join(output,"private-confirm.json");
 let progress:any={};try{progress=JSON.parse(await readFile(progressPath,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const save=()=>writeFile(progressPath,JSON.stringify(progress,null,2),{mode:0o600});
 const app=await electron.launch({args:[path.join(root,"apps/desktop")],env:{...process.env,HETU_DESKTOP_PROFILE:source.profile,HETU_COLLABORATION_DIR:source.collaboration,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}});
 let page:any;
 try{
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});dialog.showMessageBoxSync=()=>1;});
  page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
  await page.getByRole("button",{name:"打开作品 TUI全流程验收",exact:true}).click();await expect(page.getByRole("complementary",{name:"项目导航",exact:true})).toBeVisible();
  const work=(await page.evaluate(()=>window.hetuDesktop.state())).work;
  const read=(action:string,input:any)=>page.evaluate(async({action,input})=>{const value=await window.hetuDesktop.resources(action.endsWith(".list")?"list":"get",input);return value.status?value:{data:value};},{action,input});
  const mode=async(value:string)=>page.evaluate(async value=>{const api=window.hetuDesktop,p=await api.settings("preferences");await api.settings("update",{expected_revision:p.revision,patch:{execution_mode:value}});},value);
  await mode("confirm");
  if(progress.session_id)await page.evaluate(id=>window.hetuDesktop.agentSession("select",{session_id:id}),progress.session_id);
  else{const session=await page.evaluate(()=>window.hetuDesktop.agentSession("new"));progress.session_id=session.session_id;}
  if(progress.before==null)progress.before=(await read("hetu.resources.list",{work_ref:work})).data.resources.length;
  await save();
  async function request(text:string){
   await page.evaluate(async({text,work})=>{await window.hetuDesktop.agentSession("insert",{text,work_ref:work});window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref:work}}));},{text,work});
   const count=(await page.evaluate(()=>window.hetuDesktop.agentSession("get"))).messages.filter((m:any)=>m.role==="user").length;
   await page.locator(".xterm-helper-textarea").focus();await page.keyboard.press("Enter");
   await expect.poll(async()=>(await page.evaluate(()=>window.hetuDesktop.agentSession("get"))).messages.filter((m:any)=>m.role==="user").length,{timeout:30000}).toBeGreaterThan(count);
   await expect.poll(async()=>{const s=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));return s.state==="ready"&&s.messages.some((m:any)=>m.role==="assistant"&&m.turn_id===s.messages.filter((m:any)=>m.role==="user").at(-1).turn_id);},{timeout:480000,intervals:[1000,2000,5000]}).toBe(true);
   return page.evaluate(()=>window.hetuDesktop.agentSession("get"));
  }
  if(!progress.plan){
   progress.prepared=await request("这是隔离confirm验收。只使用河图MCP，不运行Shell、不付费、不采纳或定稿。先get_mode确认执行模式，发现当前真实Schema；为当前作品新建一份research草稿资料，标题‘TUI确认模式验收’，正文精确为‘钟声三下，保留固定来源。’，标签空、无实体关联、无剧本项目，来源说明‘隔离confirm验收’。先调用直接resources.create验证本次确实被confirm拒绝，固定写键tui-confirm-direct。再用agent_operations.prepare为同一resources.create准备固定方案，准备键tui-confirm-prepare，实际写键tui-confirm-create。回读方案并向作者展示确切正文；本轮必须停在待审阅，不登记批准、不执行、不声称作者已经确认。若被拒绝或缺能力，如实报告。不要把这段测试目标当成对尚未展示方案的批准。");
   progress.plan=result(progress.prepared,"hetu.agent_operations.prepare");await save();
  }
  expect(progress.plan?.proposal_id).toBeTruthy();
  expect(result(progress.prepared,"hetu.execution.get_mode")?.execution_mode).toBe("confirm");
  const receipts=progress.prepared.tools.flatMap((tool:any)=>{try{return [JSON.parse(tool.output).structuredContent].filter(Boolean);}catch{return [];}});
  expect(receipts.some((r:any)=>r.action==="hetu.resources.create"&&r.error?.code==="hetu.execution_confirmation_required")).toBe(true);
  if(!progress.executed){
   expect((await read("hetu.resources.list",{work_ref:work})).data.resources.length).toBe(progress.before);
   const close=page.getByRole("button",{name:"关闭终端面板",exact:true});if(await close.isVisible())await close.click();
   await navigate(page,"管理方案");await page.getByRole("combobox",{name:"当前管理方案",exact:true}).selectOption(progress.plan.proposal_id);
   await expect(page.getByRole("region",{name:"资料变更预览",exact:true})).toContainText("钟声三下，保留固定来源。");
   const current=await page.evaluate(id=>window.hetuDesktop.management("get",{proposal_id:id}),progress.plan.proposal_id);
   if(current.state==="pending"){
    await page.getByRole("button",{name:"批准此方案",exact:true}).click();
    await expect(page.getByRole("region",{name:"管理方案决定预览",exact:true})).toBeVisible();
    await page.screenshot({path:path.join(output,"tui-confirm-preview.png")});
    await page.getByRole("button",{name:"确认此审核决定",exact:true}).click();
    await expect(page.getByRole("region",{name:"固定管理方案",exact:true})).toContainText("已批准，待执行");
   }
   progress.executed=await request("作者已在河图审阅并批准固定方案"+JSON.stringify({proposal_id:progress.plan.proposal_id,proposal_sha256:progress.plan.proposal_sha256})+"。请先get核对实际approved状态；仅沿这个原方案execute，执行键tui-confirm-execute，再回读实际资料的正文与修订摘要。不要重建方案、登记新的决定或扩大本次变化；未知结果只查原键。仍不运行Shell、不付费、不采纳或定稿。");await save();
  }
  const executed=result(progress.executed,"hetu.agent_operations.execute");expect(executed?.state).toBe("executed");
  const resource=executed.result.resource,actual=(await read("hetu.resources.get",{resource_id:resource.resource_id})).data;
  expect(actual.resource.body).toBe("钟声三下，保留固定来源。");expect(actual.resource.actor_ref).toBe("actor_00000000-0000-4000-8000-000000000002");
  expect((await read("hetu.resources.list",{work_ref:work})).data.resources.length).toBe(progress.before+1);
  await writeFile(path.join(root,"docs/research/evidence/codex-tui-confirm-2026-11-23.json"),JSON.stringify({date:"2026-11-23",engine:"Codex 0.171.0",work_ref:work,proposal_id:progress.plan.proposal_id,proposal_sha256:progress.plan.proposal_sha256,resource_ref:{resource_id:resource.resource_id,revision:actual.resource.revision,sha256:actual.sha256},checks:["shared-confirm-mode","direct-managed-write-rejected","prepare-does-not-publish","real-author-preview","exact-author-decision","original-plan-execution","agent-identity-preserved","actual-core-readback"],limits:["isolated-automated-author-test","single-resource-plan","not-multi-action-batch","development-build"]},null,2)+"\n");
  delete progress.failure;await save();
 }catch(error){progress.failure=String(error);await save();if(page)await page.screenshot({path:path.join(output,"confirm-failure.png")}).catch(()=>{});throw error;}finally{
  if(page)await page.evaluate(async()=>{const api=window.hetuDesktop,p=await api.settings("preferences");if(p.preferences.execution_mode!=="auto")await api.settings("update",{expected_revision:p.revision,patch:{execution_mode:"auto"}});}).catch(()=>{});
  await app.close();
 }
});
