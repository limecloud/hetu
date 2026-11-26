import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {closeApplication} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("多引擎创建直接进入PTY，模型发现、会话切换及重开保持原记录",async({},testInfo)=>{
  test.setTimeout(180000);
  const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-launch-")),executable=process.env.HETU_PACKAGED_APP;
  const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),...(!executable?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
  try{
    const page=await app.firstWindow();await page.setViewportSize({width:2560,height:1285});
    await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled({timeout:30000});
    await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:agent-session");let once=true;handlers.set("desktop:agent-session",(event:any,method:string,input:any)=>{if(method==="model_options"&&input.client==="codex"&&once){once=false;throw Error("隔离模型读取失败");}return original(event,method,input);});});
    await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"创建会话",exact:true});await expect(dialog).toBeVisible();
    await expect(page.getByRole("button",{name:"TUI",exact:true})).toHaveCount(0);await expect(page.getByRole("button",{name:"开始会话",exact:true})).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toContainText("隔离模型读取失败");await dialog.getByRole("button",{name:"重新读取模型",exact:true}).click();await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByRole("button",{name:"创建",exact:true})).toBeEnabled();
    await page.screenshot({path:testInfo.outputPath("create-session.png")});
    await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();
    await expect(dialog.getByRole("tab",{name:"Codex",exact:true})).toBeEnabled();
    const models=await page.evaluate(()=>window.hetuDesktop.agentSession("model_options",{client:"codex"}));expect(models.length).toBeGreaterThan(0);
    const firstModel=dialog.getByRole("option",{name:models[0].name,exact:true});await expect(firstModel).toBeVisible({timeout:45000});const modelName=await firstModel.innerText();await firstModel.click();
    await expect(dialog.getByRole("group",{name:"推理强度",exact:true})).toBeVisible();
    await dialog.getByRole("searchbox",{name:"搜索模型",exact:true}).fill("not-a-real-model");await expect(dialog.getByRole("status")).toHaveText("没有匹配的模型");
    await dialog.getByRole("searchbox",{name:"搜索模型",exact:true}).fill("");
    await dialog.getByRole("searchbox",{name:"搜索模型",exact:true}).press("ArrowDown");await expect(dialog.getByRole("option",{name:"使用已配置的默认模型",exact:true})).toBeFocused();
    await page.keyboard.press("ArrowDown");await expect(firstModel).toBeFocused();await page.keyboard.press("Enter");
    const more=dialog.getByRole("button",{name:/^更多模型/});if(await more.count()){await more.click();await expect(dialog.getByRole("option")).toHaveCount((await page.evaluate(()=>window.hetuDesktop.agentSession("model_options",{client:"codex"}))).length+1);await dialog.getByRole("button",{name:"收起更多模型",exact:true}).click();}
    await page.screenshot({path:testInfo.outputPath("engine-model-picker.png")});
    await dialog.getByRole("tab",{name:"终端",exact:true}).click();
    await dialog.getByRole("button",{name:"打开终端",exact:false}).click();await expect(dialog).toHaveCount(0);
    const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
    await expect.poll(async()=>(await get()).terminal_connected).toBe(true);const shell=await get();expect(shell.client).toBe("shell");
    const input=page.locator(".xterm-helper-textarea");await input.focus();await page.keyboard.type("printf 'HETU-PTY-OK\\n'");await page.keyboard.press("Enter");await expect(page.locator(".xterm-accessibility-tree")).toContainText("HETU-PTY-OK");
    await page.screenshot({path:testInfo.outputPath("shell-pty.png")});
    await page.getByRole("button",{name:"新建会话",exact:true}).click();await expect(dialog).toBeVisible();await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();
    await dialog.getByRole("tab",{name:"Codex",exact:true}).click();await dialog.getByRole("option",{name:modelName,exact:true}).click();await dialog.getByRole("button",{name:"打开终端",exact:false}).click();await expect(dialog).toHaveCount(0,{timeout:45000});
    await expect.poll(async()=>{const value=await get();return value.client==="codex"&&value.terminal_connected&&value.terminal_replay?.includes("]7501;state=idle");},{timeout:45000}).toBe(true);
    const codex=await get();expect(codex.messages).toHaveLength(0);expect(codex.model).toBeTruthy();expect(codex.reasoning_effort).toBeTruthy();
    await page.getByRole("button",{name:"关闭终端面板",exact:true}).click();await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"创建会话",exact:true})).toHaveCount(0);expect((await get()).thread_id).toBe(codex.thread_id);expect((await get()).generation).toBe(codex.generation);
    await page.getByLabel("当前会话",{exact:true}).click();await page.getByRole("button",{name:"终端",exact:true}).click();
    await expect.poll(async()=>(await get()).session_id).toBe(shell.session_id);expect((await get()).generation).toBe(shell.generation);await expect(page.locator(".xterm-accessibility-tree")).toContainText("HETU-PTY-OK");
    await page.getByRole("button",{name:"新建会话",exact:true}).click();await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();
    await dialog.getByRole("tab",{name:"Claude Code",exact:true}).click();await dialog.getByRole("button",{name:"打开终端",exact:false}).click();await expect(dialog).toHaveCount(0,{timeout:45000});
    await expect.poll(async()=>{const value=await get();return value.client==="claude-code"&&value.terminal_connected&&value.terminal_replay.length>0;},{timeout:45000}).toBe(true);
    await page.screenshot({path:testInfo.outputPath("other-cli-pty.png")});
    for(const client of [{id:"gemini",name:"Gemini CLI"},{id:"opencode",name:"OpenCode"}]){
      await page.getByRole("button",{name:"新建会话",exact:true}).click();await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();await dialog.getByRole("tab",{name:client.name,exact:true}).click();await dialog.getByRole("button",{name:"打开终端",exact:true}).click();await expect(dialog).toHaveCount(0,{timeout:45000});
      await expect.poll(async()=>{const value=await get();return value.client===client.id&&value.terminal_connected&&value.terminal_replay.length>0;},{timeout:45000}).toBe(true);
      await page.screenshot({path:testInfo.outputPath(client.id+"-pty.png")});
    }
    await page.setViewportSize({width:980,height:720});await page.getByRole("button",{name:"新建会话",exact:true}).click();await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element=>element.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath("create-session-narrow.png")});await dialog.getByRole("button",{name:"关闭创建会话",exact:true}).click();
    await writeFile(testInfo.outputPath("result.json"),JSON.stringify({packaged:!!executable,engines:["shell","codex","claude-code","gemini","opencode"],modelName,codex_thread:codex.thread_id,model_messages:0,switch_preserved_shell_generation:true,model_read_failure_retry:true},null,2));
  }catch(error){await app.windows()[0]?.screenshot({path:testInfo.outputPath("failure.png")}).catch(()=>{});throw error;}finally{await closeApplication(app);}
});
