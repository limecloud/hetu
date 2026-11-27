import {test,expect,_electron as electron} from "@playwright/test";
import {mkdir,mkdtemp,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {execFileSync} from "node:child_process";
import {closeApplication} from "./navigation.ts";
import {NativeVoiceOver} from "./fixtures/native-voiceover.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("引擎选择朗读当前值，图标标签、候选导航与Escape焦点保持一致",async({},info)=>{
 test.setTimeout(90000);
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-agent-accessibility-")),executable=process.env.HETU_PACKAGED_APP;
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"LocalSettings"),HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),HETU_PLUGIN_STATE_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env});
 let failed=false,reader:NativeVoiceOver|undefined;
 try{
  const page=await app.firstWindow();await page.setViewportSize({width:1280,height:900});await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();
  await app.evaluate(({ipcMain,app})=>{
   app.setAccessibilitySupportEnabled(true);
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:agent-session");
   handlers.set("desktop:agent-session",(event:any,method:string,input:any)=>{
    if(method==="catalog")return [{id:"shell",name:"终端",available:true,models:false,chat:false},{id:"codex",name:"Codex",available:true,models:true,chat:true},{id:"gemini",name:"Gemini CLI",available:false,models:false,chat:false}];
    if(method==="model_options")return input.client==="codex"?Array.from({length:7},(_,index)=>({id:"test-model-"+index,name:"测试模型"+(index+1),efforts:["low","high"],default_effort:"high"})):[];
    return original(event,method,input);
   });
  });
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"创建会话",exact:true}),trigger=dialog.getByRole("button",{name:/^引擎(?: |$)/});await expect(dialog).toBeVisible();
  const before=await page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
  await writeFile(info.outputPath("initial-ax.yaml"),await dialog.ariaSnapshot());
  await expect(trigger).toHaveAccessibleName("引擎 Codex");
  if(process.env.HETU_NATIVE_AX_HELPER){
   await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0]?.focus();});await trigger.focus();
   const native=JSON.parse(execFileSync(process.env.HETU_NATIVE_AX_HELPER,[String(app.process().pid)],{encoding:"utf8",timeout:15000}));
   await writeFile(info.outputPath("native-ax.json"),JSON.stringify(native,null,2)+"\n");
   expect(native.trusted).toBe(true);expect(native.matches.some((row:any)=>row.role==="AXPopUpButton"&&row.title==="引擎 Codex")).toBe(true);
  }
  if(process.env.HETU_LIVE_VOICEOVER==="1"){
   const diagnostics=info.outputPath("voiceover-captions");await mkdir(diagnostics,{recursive:true});
   reader=new NativeVoiceOver(app.process().pid!,diagnostics);await reader.start();
   await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0]?.focus();});await trigger.focus();
   await reader.read(["引擎","Codex"]);
  }
  await trigger.focus();await trigger.press("Enter");
  const picker=dialog.getByRole("dialog",{name:"选择引擎与模型",exact:true}),search=picker.getByRole("searchbox",{name:"搜索模型",exact:true});await expect(search).toBeFocused();
  const engines=picker.getByRole("tablist",{name:"引擎",exact:true});
  await expect(engines.getByRole("tab",{name:"Codex",exact:true})).toHaveAttribute("aria-selected","true");await expect(engines.getByRole("tab",{name:"Gemini CLI",exact:true})).toHaveAttribute("data-available","false");
  await search.fill("测试模型");await search.press("Home");await expect(search).toBeFocused();expect(await search.evaluate(element=>(element as HTMLInputElement).selectionStart)).toBe(0);
  await search.press("End");await expect(search).toBeFocused();await search.press("ArrowDown");
  const defaultModel=picker.getByRole("option",{name:"使用已配置的默认模型",exact:true});await expect(defaultModel).toBeFocused();
  await defaultModel.press("ArrowDown");const first=picker.getByRole("option",{name:"测试模型1",exact:true});await expect(first).toBeFocused();await first.press("Enter");await expect(first).toHaveAttribute("aria-selected","true");
  await first.press("Escape");await expect(picker).toHaveCount(0);await expect(trigger).toBeFocused();await expect(trigger).toHaveAccessibleName(/引擎.*测试模型1.*高/);
  if(reader){await reader.read(["引擎","测试模型1","高"]);await reader.restore();}
  await page.screenshot({path:info.outputPath("selected-engine-value.png")});
  await trigger.press("Enter");
  const codex=engines.getByRole("tab",{name:"Codex",exact:true}),shell=engines.getByRole("tab",{name:"终端",exact:true}),missing=engines.getByRole("tab",{name:"Gemini CLI",exact:true});
  await codex.focus();await codex.press("ArrowRight");await expect(missing).toBeFocused();await missing.press("Home");await expect(shell).toBeFocused();await shell.press("End");await expect(missing).toBeFocused();
  await shell.press("Enter");await expect(shell).toHaveAttribute("aria-selected","true");await expect(picker.getByRole("option",{name:"系统默认 Shell",exact:true})).toBeVisible();
  await codex.click();await expect(codex).toHaveAttribute("aria-selected","true");await expect(search).toBeFocused();await expect(picker.getByRole("option",{name:"测试模型1",exact:true})).toHaveAttribute("aria-selected","true");
  await page.setViewportSize({width:760,height:720});await picker.getByRole("button",{name:/^更多模型/}).click();await expect(picker.getByRole("listbox",{name:"可用模型",exact:true}).getByRole("option")).toHaveCount(8);
  await expect.poll(()=>picker.evaluate(element=>{const bounds=element.getBoundingClientRect();return bounds.left>=0&&bounds.right<=innerWidth&&bounds.top>=0&&bounds.bottom<=innerHeight;})).toBe(true);
  await writeFile(info.outputPath("picker-ax.yaml"),await picker.ariaSnapshot());await page.screenshot({path:info.outputPath("engine-picker-narrow.png")});
  await page.keyboard.press("Escape");await expect(trigger).toBeFocused();await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(page.getByRole("button",{name:"新建会话",exact:true})).toBeFocused();
  const after=await page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));expect(after.session_id).toBe(before.session_id);expect(after.state).toBe("idle");expect(after.thread_id).toBeUndefined();expect(after.messages).toHaveLength(0);
  await writeFile(info.outputPath("result.json"),JSON.stringify({packaged:!!executable,current_value_in_accessible_name:true,orca_icon_engine_tabs:true,search_editing_preserved:true,nested_escape_restores_focus:true,no_engine_or_model_started:true},null,2)+"\n");
 }catch(error){failed=true;await writeFile(info.outputPath("failure.json"),JSON.stringify({error:String(error)},null,2)+"\n");await app.windows()[0]?.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});throw error;}
 finally{
  try{
   if(reader){try{await reader.restore();}catch(error){await writeFile(info.outputPath("voiceover-restoration-error.json"),JSON.stringify({error:String(error)})+"\n");if(!failed)throw error;}finally{await writeFile(info.outputPath("voiceover.json"),JSON.stringify(reader.audit,null,2)+"\n");}}
  }finally{try{await closeApplication(app);}catch(error){if(!failed)throw error;await writeFile(info.outputPath("shutdown-failure.json"),JSON.stringify({error:String(error)},null,2)+"\n");}}
 }
});
