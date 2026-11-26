import {test,expect,_electron as electron,type Locator} from "@playwright/test";
import {mkdtemp,writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {createTerminal,switchAgentSurface,closeApplication,observeApplicationShutdown} from "./navigation.ts";
import {selectedKeyboardSources,nativeImeInput,inspectImeCandidate,selectImeCandidate} from "./fixtures/native-ime.ts";

const root=path.resolve(import.meta.dirname,"../../..");

test("系统拼音确认不发送，GUI与原生TUI切换保持中文草稿和原线程",async({},info)=>{
 test.skip(process.env.HETU_LIVE_IME!=="1"||process.platform!=="darwin","需显式启用macOS系统输入法验收");
 const sources=selectedKeyboardSources();
 test.skip(!sources.some((source:Record<string,string>)=>source["Bundle ID"]==="com.sogou.inputmethod.sogou"),"当前未选择Sogou拼音；不改系统输入法设置");
 expect(process.env.HETU_NATIVE_IME_HELPER,"需编译只读候选探针并指定HETU_NATIVE_IME_HELPER").toBeTruthy();
 test.setTimeout(180000);
 const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-agent-native-ime-")),executable=process.env.HETU_PACKAGED_APP;
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"LocalSettings"),HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),HETU_PLUGIN_STATE_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env});
 const pid=app.process().pid!;
 const native=(action:string)=>nativeImeInput(pid,action);
 const get=()=>app.windows()[0].evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
 let report:Record<string,unknown>={packaged:!!executable,input_method:"Sogou Pinyin",system_settings_changed:false};
 const confirmations:{stage:string;key:string;committed:string}[]=[];
 const candidateChecks:unknown[]=[];
 let restoreLatinMode=false;
 try{
  await observeApplicationShutdown(app,info.outputPath("shutdown.jsonl"));
  const page=await app.firstWindow();await page.setViewportSize({width:1280,height:900});
  await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();await createTerminal(page);
  await expect.poll(async()=>{const value=await get();return value.state==="ready"&&value.terminal_connected&&value.terminal_replay?.includes("]7501;state=idle");},{timeout:60000}).toBe(true);
  const before=await get();
  await page.evaluate(()=>{
   const events:any[]=[];(window as any).__nativeImeEvents=events;
   for(const type of ["compositionstart","compositionupdate","compositionend","keydown","input"])document.addEventListener(type,event=>{
    const target=event.target as HTMLElement;
    if(!target.matches('.xterm-helper-textarea, textarea[aria-label="发送给 Agent"]'))return;
    const value=event as KeyboardEvent&CompositionEvent&InputEvent;
    events.push({type:document.querySelector('.agent-content-terminal:not([hidden]) .agent-chat')?"gui":"tui",event:type,key:value.key,keyCode:value.keyCode,isComposing:value.isComposing,data:type.startsWith("composition")?value.data:undefined});
   },true);
  });
  const activate=async(input:Locator)=>{
   await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows().find(window=>!window.webContents.getURL().endsWith("?view=settings"))?.focus();});
   await input.focus();await expect.poll(()=>Number(execFileSync("osascript",["-e",'tell application "System Events" to get unix id of first application process whose frontmost is true'],{encoding:"utf8"}).trim())).toBe(pid);
  };
  const compose=async(input:Locator,confirm:"space"|"enter"|"candidate",stage:string)=>{
   await activate(input);const previous=await page.evaluate(()=>(window as any).__nativeImeEvents.filter((event:any)=>event.event==="compositionend").length);
   native('keystroke "zhongwen"');
   if(stage==="tui-candidate"){
    const composing=()=>page.evaluate(()=>(window as any).__nativeImeEvents.filter((event:any)=>event.event==="compositionstart").length);
    await expect.poll(composing,{timeout:1000}).toBeGreaterThan(previous).catch(()=>{});
    if(await composing()===previous){
     // 输入法已选中仍可能处于英文态；只在本隔离窗口切换并在结束前恢复。
     native('keystroke "u" using control down');native("key code 56");restoreLatinMode=true;await activate(input);native('keystroke "zhongwen"');
    }
   }
   await expect.poll(()=>page.evaluate(()=>(window as any).__nativeImeEvents.filter((event:any)=>event.event==="compositionstart").length)).toBeGreaterThan(previous);
   let candidateIndex:number|null=null;
   if(confirm==="candidate")await expect.poll(()=>{
    const check=inspectImeCandidate(pid,"中文");
    candidateChecks.push({stage,...check});expect(check.frontmost_matches).toBe(true);
    candidateIndex=check.candidate_index;return check.candidate_ready;
   },{timeout:15000}).toBe(true);
   await page.screenshot({path:info.outputPath(stage+"-composing.png")});
   if(confirm==="candidate")selectImeCandidate(pid,candidateIndex!);else native("key code "+({enter:36,space:49}[confirm]));
   await expect.poll(()=>page.evaluate(()=>(window as any).__nativeImeEvents.filter((event:any)=>event.event==="compositionend").length)).toBeGreaterThan(previous);
   const committed=await page.evaluate(()=>(window as any).__nativeImeEvents.filter((event:any)=>event.event==="compositionend").at(-1).data as string);
   confirmations.push({stage,key:confirm,committed});expect(committed.length).toBeGreaterThan(0);
   expect((await get()).messages).toHaveLength(0);expect((await get()).tools??[]).toHaveLength(0);
   return committed;
  };
  const terminal=page.locator(".xterm-helper-textarea");expect(await compose(terminal,"candidate","tui-candidate")).toBe("中文");
  await expect(page.locator(".xterm-accessibility-tree")).toContainText("中文");
  await page.screenshot({path:info.outputPath("tui-chinese-unsubmitted.png")});
  await switchAgentSurface(page,"gui");
  const chat=page.getByRole("textbox",{name:"发送给 Agent",exact:true});await expect(chat).toHaveValue("");await compose(chat,"enter","gui-enter");await expect(chat).toHaveValue("zhongwen");
  // 空格遵循输入法实际选词；明确数字选词用于中文链路，两种确认都不能触发发送。
  await chat.fill("");const spaceCommit=await compose(chat,"space","gui-space-native");await expect(chat).toHaveValue(spaceCommit);
  await chat.fill("");expect(await compose(chat,"candidate","gui-candidate-first")).toBe("中文");await expect(chat).toHaveValue("中文");
  // 换行使用浏览器键盘链；真实Shift松开会触发部分Sogou配置的中英切换。
  await chat.press("Shift+Enter");await expect(chat).toHaveValue("中文\n");
  expect(await compose(chat,"candidate","gui-candidate")).toBe("中文");await expect(chat).toHaveValue("中文\n中文");await chat.blur();
  await expect.poll(async()=>(await get()).gui_draft).toBe("中文\n中文");
  await switchAgentSurface(page,"tui");await expect(page.locator(".xterm-accessibility-tree")).toContainText("中文");
  await switchAgentSurface(page,"gui");await expect(chat).toHaveValue("中文\n中文");
  const after=await get();expect(after.thread_id).toBe(before.thread_id);expect(after.messages).toHaveLength(0);expect(after.tools??[]).toHaveLength(0);
  const events=await page.evaluate(()=>(window as any).__nativeImeEvents);
  report={...report,thread_preserved:true,gui_draft:"中文\n中文",terminal_chinese_retained:true,model_requests:0,confirmations,candidateChecks,events};
  await writeFile(info.outputPath("result.json"),JSON.stringify(report,null,2)+"\n");await page.screenshot({path:info.outputPath("gui-chinese-draft.png")});
 }catch(error){
  const page=app.windows()[0];await page?.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});
  report={...report,error:String(error),confirmations,candidateChecks,events:await page?.evaluate(()=>(window as any).__nativeImeEvents).catch(()=>undefined)};
  await writeFile(info.outputPath("failure.json"),JSON.stringify(report,null,2)+"\n");
  const current=await get().catch(()=>undefined);if(current?.state==="running")await page.evaluate(()=>window.hetuDesktop.agentSession("interrupt",{scope:"library"})).catch(()=>{});
  throw error;
 }finally{
  try{
  if(restoreLatinMode){
   await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0]?.focus();});
   await expect.poll(()=>Number(execFileSync("osascript",["-e",'tell application "System Events" to get unix id of first application process whose frontmost is true'],{encoding:"utf8"}).trim())).toBe(pid);
   native("key code 56");
  }
  expect(selectedKeyboardSources()).toEqual(sources);
  await writeFile(info.outputPath("input-method-restored.json"),JSON.stringify({selected_source_unchanged:true,temporary_language_toggle:restoreLatinMode,temporary_toggle_reversed:restoreLatinMode})+"\n");
  }finally{await closeApplication(app);}
 }
});
