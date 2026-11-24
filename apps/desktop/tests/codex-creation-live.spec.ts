import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const root=path.resolve(import.meta.dirname,"../../..");
test("真实TUI从空创作库创建小说、章节和固定参考稿",async()=>{
 test.skip(process.env.HETU_LIVE_CODEX!=="1","需明确启用真实本机Codex验收");test.setTimeout(600000);
 const directory=await mkdtemp(path.join(os.tmpdir(),"hetu-codex-creation-")),profile=path.join(directory,"profile"),collaboration=path.join(directory,"collaboration");
 await mkdir(profile,{recursive:true});
 const app=await electron.launch({args:[path.join(root,"apps/desktop")],env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}});
 try {
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
  await page.getByRole("button",{name:"新建小说",exact:true}).click();
  await expect(page.getByRole("region",{name:"独立 Agent 会话",exact:true})).toBeVisible({timeout:45000});
  await expect.poll(()=>page.evaluate(async()=>{const s=await window.hetuDesktop.agentSession("get",{scope:"library"});const text=(s.terminal_replay??"").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,"");return /Pasted (?:Content|text)|creation_action/i.test(text);}),{timeout:45000}).toBe(true);
  const instructions="\n这是已授权的隔离全流程验收，只使用当前河图MCP，不运行Shell、不读取其他作品、不付费、不采纳或定稿。现在直接执行，不停留在计划，也不等待我重复填表：1.创建筹备项目和小说，书名TUI全流程验收，笔名隔离作者，简介雾港收到一封来自明天的信，悬疑，中文。2.建立题名第一章雨夜的空写作稿并回读目录。3.为这个确切文稿准备chapter_draft任务，用preview_prompt返回的prepare_input准备，沿返回task_locator打开任务。4.经working_copies保存一个约30字的参考稿，包含灯塔与明天的来信，再用working_copy_refs提交固定成果并回读。所有写动作使用可识别的固定operation_key前缀tui-creation-，同一动作失败先核对原键。先发现本次实际Schema，保留真实客户端身份；任务和结果引用使用实际回执。请一次完成以上步骤，最终给出公开WorkRef、document_id、task_ref、submission_ref和working_copy_ref。若某个环节不支持，明确报告真实失败，不伪造成功。";
  await page.evaluate(async text=>{const s=await window.hetuDesktop.agentSession("get",{scope:"library"});await window.hetuDesktop.agentSession("terminal_input",{scope:"library",session_id:s.session_id,generation:s.generation,data:"\u001b[200~"+text+"\u001b[201~"});},instructions);
  await page.locator(".xterm-helper-textarea").focus();await page.keyboard.press("Enter");
  await expect.poll(()=>page.evaluate(async()=>{const s=await window.hetuDesktop.agentSession("get",{scope:"library"});return s.messages.some((m:any)=>m.role==="user");}),{timeout:30000}).toBe(true);
  await expect.poll(()=>page.evaluate(async()=>{const s=await window.hetuDesktop.agentSession("get",{scope:"library"});return s.state==="ready"&&s.messages.some((m:any)=>m.role==="assistant")?s:undefined;}),{timeout:480000,intervals:[1000,2000,5000]}).toBeTruthy();
  const snapshot=await page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
  await mkdir(path.join(root,"output/codex-creation-validation"),{recursive:true});
  await writeFile(path.join(root,"output/codex-creation-validation/private-result.json"),JSON.stringify({directory,profile,collaboration,snapshot},null,2),{mode:0o600});
  const results=(snapshot.tools??[]).flatMap((tool:any)=>{try{const data=JSON.parse(tool.output??"").structuredContent;return data?[data]:[];}catch{return [];}});
  expect(results.some((value:any)=>value.action==="hetu.creation_projects.create_novel"&&value.status==="succeeded"),JSON.stringify(snapshot.messages.map((m:any)=>m.text))).toBe(true);
  expect(results.some((value:any)=>value.action==="hetu.creative_tasks.submit_result"&&value.status==="succeeded")).toBe(true);
  await page.getByRole("button",{name:"关闭终端面板",exact:true}).click();
  await expect(page.getByRole("button",{name:"打开作品 TUI全流程验收",exact:true})).toBeVisible({timeout:30000});
  await page.screenshot({path:path.join(root,"output/codex-creation-validation/created-library.png")});
 }catch(error){const page=app.windows()[0];await mkdir(path.join(root,"output/codex-creation-validation"),{recursive:true});const snapshot=await page?.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"})).catch(()=>undefined);await writeFile(path.join(root,"output/codex-creation-validation/failure.json"),JSON.stringify({directory,snapshot},null,2),{mode:0o600});if(page)await page.screenshot({path:path.join(root,"output/codex-creation-validation/failure.png")}).catch(()=>{});throw error;}finally{await app.close();}
});
