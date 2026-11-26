import {test,expect,_electron as electron,type ElectronApplication,type Page} from "@playwright/test";
import {mkdir,mkdtemp,readFile,writeFile,rename} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import path from "node:path";
import {closeApplication} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../.."),output=path.join(root,"output/desktop-crash-20261126");
const draft="桌面崩溃前已保存的草稿，重开后不要自动发送。🌿";
function processes(){
 return execFileSync("ps",["-axo","pid=,ppid=,pgid=,args="],{encoding:"utf8"}).split("\n").flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return m?[{pid:Number(m[1]),parent:Number(m[2]),group:Number(m[3]),command:m[4]}]:[];});
}
function groupMembers(group:number){return processes().filter(row=>row.group===group).map(({pid,parent,group})=>({pid,parent,group}));}

test("真实桌面主进程崩溃后退出旧引擎再恢复原线程和草稿，不发模型请求",async()=>{
 test.skip(process.env.HETU_LIVE_DESKTOP_CRASH!=="1","需显式启用隔离桌面主进程崩溃验收");test.skip(process.platform==="win32","当前实际进程核验使用Unix进程组，Windows另验");test.setTimeout(180000);
 await mkdir(output,{recursive:true});const journal=path.join(output,"private-state.json");let state:any;
 try{state=JSON.parse(await readFile(journal,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const save=async()=>{await writeFile(journal+".tmp",JSON.stringify(state,null,2)+"\n",{mode:0o600});await rename(journal+".tmp",journal);};
 if(!state){const folder=await mkdtemp(path.join(output,"sandbox-"));state={folder,profile:path.join(folder,"profile"),collaboration:path.join(folder,"collaboration")};await mkdir(state.profile);await save();}
 const source=process.env.HETU_DESKTOP_CRASH_SOURCE==="1",executable=process.env.HETU_PACKAGED_APP??"/Applications/Hetu.app/Contents/MacOS/Hetu";
 const stage=process.env.HETU_DESKTOP_CRASH_STAGE??(source?"source":"installed");
 if(state.crashed&&state.stage!==stage){state.completed_stages??=[];state.completed_stages.push({stage:state.stage??"source",before:state.before,after_main_kill:state.after_main_kill,verified:state.verified});for(const key of ["before","crash_intent","crashed","after_main_kill","old_engine_group_exited","verified"])delete state[key];}
 state.stage=stage;await save();
 const env={...process.env,HETU_DESKTOP_PROFILE:state.profile,HETU_COLLABORATION_DIR:state.collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(state.profile,"LocalSettings"),HETU_PLUGIN_STATE_DIR:state.profile,...source?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}:{}};delete env.ELECTRON_RUN_AS_NODE;
 let app:ElectronApplication|undefined,page:Page;
 const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
 async function open(){
  app=await electron.launch({...source?{args:[path.join(root,"apps/desktop")]}:{executablePath:executable,args:[]},env});page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();
  const preferences=await page.evaluate(()=>window.hetuDesktop.settings("preferences"));if(preferences.preferences.agent_session?.default_surface!=="gui")await page.evaluate(expected=>window.hetuDesktop.settings("update",{expected_revision:expected,patch:{agent_session:{default_surface:"gui"}}}),preferences.revision);
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();const dialog=page.getByRole("dialog",{name:"创建会话",exact:true});
  await expect.poll(async()=>await dialog.isVisible()||await page.locator(".agent-chat").isVisible()).toBe(true);if(await dialog.isVisible()){await dialog.getByRole("button",{name:/^引擎(?: |$)/}).click();await dialog.getByRole("button",{name:"打开聊天",exact:true}).click();await expect(dialog).toHaveCount(0,{timeout:60000});}
  await expect(page.locator(".agent-chat")).toBeVisible();
 }
 try{
  if(!state.crashed){
   await open();await expect.poll(async()=>(await get()).state,{timeout:60000}).toBe("ready");
   await page.getByRole("textbox",{name:"发送给 Agent",exact:true}).fill(draft);await page.getByRole("textbox",{name:"发送给 Agent",exact:true}).blur();await expect.poll(async()=>(await get()).draft).toBe(draft);
   const snapshot=await get();expect(snapshot.messages).toHaveLength(0);const owner=app!.process().pid!;
   const rows=processes(),engine=rows.filter(row=>row.parent===owner&&/\bapp-server\b/.test(row.command)&&/--listen\s/.test(row.command));expect(engine).toHaveLength(1);
   state.before={snapshot,owner,engine_pid:engine[0].pid,engine_group:engine[0].group,members:groupMembers(engine[0].group)};await save();await page.screenshot({path:path.join(output,"before-desktop-crash.png")});
   const child=app!.process();state.crash_intent=true;await save();child.kill("SIGKILL");await expect.poll(()=>child.signalCode,{timeout:10000}).toBe("SIGKILL");app=undefined;state.crashed=true;state.after_main_kill=groupMembers(state.before.engine_group);await save();
  }
  await expect.poll(()=>groupMembers(state.before.engine_group),{timeout:15000,message:"桌面主进程退出后旧受管引擎组仍存活，不能启动第二引擎"}).toEqual([]);state.old_engine_group_exited=true;await save();
  await open();await expect.poll(async()=>(await get()).state,{timeout:60000}).toBe("ready");const current=await get();expect(current.thread_id).toBe(state.before.snapshot.thread_id);expect(current.session_id).toBe(state.before.snapshot.session_id);expect(current.draft).toBe(draft);expect(current.messages).toHaveLength(0);expect(current.tools??[]).toHaveLength(0);
  await expect(page.getByRole("textbox",{name:"发送给 Agent",exact:true})).toHaveValue(draft);await page.screenshot({path:path.join(output,"same-thread-after-desktop-crash.png")});state.verified={original_thread_recovered:true,draft_preserved:true,old_engine_group_exited:true,model_requests:0};delete state.failure;await save();
  const evidenceFile=path.join(root,"docs/research/evidence/desktop-crash-2026-11-26.json");let previous:any={};try{previous=JSON.parse(await readFile(evidenceFile,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const runtime=await app!.evaluate(({app})=>({version:app.getVersion(),electron:process.versions.electron}));await writeFile(evidenceFile,JSON.stringify({...previous,date:"2026-11-26",...state.verified,verifications:[...(previous.verifications??[]).filter((item:any)=>item.stage!==stage),{stage,runtime,passed:true}],limits:["idle real engine and actual SIGKILL of desktop main process","not in-flight Core write, model quality, authentication or other platforms"]},null,2)+"\n");
 }catch(error){state.failure=String(error);await save();await page?.screenshot({path:path.join(output,"failure.png")}).catch(()=>{});throw error;}finally{if(app)await closeApplication(app);}
});
