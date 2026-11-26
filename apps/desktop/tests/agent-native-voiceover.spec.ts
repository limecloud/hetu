import {test,expect,_electron as electron,type Locator} from "@playwright/test";
import {mkdir,mkdtemp,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createTerminal,switchAgentSurface,closeApplication} from "./navigation.ts";
import {NativeVoiceOver} from "./fixtures/native-voiceover.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("系统旁白朗读GUI输入与原生TUI查找，双表面草稿和线程保持",async({},info)=>{
 test.skip(process.env.HETU_LIVE_VOICEOVER!=="1"||process.platform!=="darwin","需显式启用当前macOS真实读屏验收");
 test.setTimeout(150000);
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-agent-voiceover-")),executable=process.env.HETU_PACKAGED_APP;
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"LocalSettings"),HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),HETU_PLUGIN_STATE_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env});
 const readers:NativeVoiceOver[]=[];
 let failed=false;
 try{
  const page=await app.firstWindow();await page.setViewportSize({width:1280,height:900});await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();
  await app.evaluate(({app})=>app.setAccessibilitySupportEnabled(true));
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();await createTerminal(page);
  const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
  await expect.poll(async()=>{const s=await get();return s.state==="ready"&&s.terminal_connected&&s.terminal_replay?.includes("]7501;state=idle");},{timeout:60000}).toBe(true);
  const before=await get();
  const spoken=async(stage:string,input:Locator,words:string[])=>{
   const diagnostics=info.outputPath(stage+"-captions");await mkdir(diagnostics,{recursive:true});
   const reader=new NativeVoiceOver(app.process().pid!,diagnostics);readers.push(reader);
   let readingFailed=false;
   try{
    await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0]?.focus();});await input.focus();
    await reader.start();await input.focus();await reader.read(words);
    await page.screenshot({path:info.outputPath(stage+"-workbench.png")});
   }catch(error){readingFailed=true;await writeFile(info.outputPath(stage+"-failure.json"),JSON.stringify({error:String(error)},null,2)+"\n");throw error;}
   finally{try{await reader.restore();}catch(error){await writeFile(info.outputPath(stage+"-restoration-failure.json"),JSON.stringify({error:String(error)},null,2)+"\n");if(!readingFailed)throw error;}finally{await writeFile(info.outputPath(stage+"-voiceover.json"),JSON.stringify(reader.audit,null,2)+"\n");}}
  };
  await switchAgentSurface(page,"gui");
  const composer=page.getByRole("textbox",{name:"发送给 Agent",exact:true}),draft="这段文字仅保留在草稿，不发起模型请求。";
  await composer.fill(draft);await spoken("gui-composer",composer,["发送给","Agent"]);await expect(composer).toHaveValue(draft);
  await switchAgentSurface(page,"tui");
  await page.getByRole("button",{name:"查找",exact:true}).click();
  const search=page.getByRole("textbox",{name:"查找终端内容",exact:true});await expect(search).toBeFocused();
  await search.fill("未提交的查询");await spoken("tui-search",search,["查找终端内容"]);await expect(search).toHaveValue("未提交的查询");
  await search.press("Escape");await expect(search).toHaveCount(0);await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await switchAgentSurface(page,"gui");await expect(composer).toHaveValue(draft);
  const after=await get();expect(after.session_id).toBe(before.session_id);expect(after.thread_id).toBe(before.thread_id);expect(after.messages).toHaveLength(0);expect(after.tools??[]).toHaveLength(0);expect(after.gui_draft).toBe(draft);
  await writeFile(info.outputPath("result.json"),JSON.stringify({packaged:!!executable,actual_voiceover_caption_values:true,gui_draft_preserved:true,search_value_preserved:true,escape_restores_terminal_focus:true,original_session_and_thread:true,model_requests:0,reader_restored:readers.every(reader=>reader.audit.restored)},null,2)+"\n");
 }catch(error){failed=true;await writeFile(info.outputPath("failure.json"),JSON.stringify({error:String(error)},null,2)+"\n");await app.windows()[0]?.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});throw error;}
 finally{
  try{for(const reader of readers)try{await reader.restore();}catch(error){await writeFile(info.outputPath("restoration-failure.json"),JSON.stringify({error:String(error)},null,2)+"\n");if(!failed)throw error;}}
  finally{try{await closeApplication(app);}catch(error){if(!failed)throw error;await writeFile(info.outputPath("shutdown-failure.json"),JSON.stringify({error:String(error)},null,2)+"\n");}}
 }
});
