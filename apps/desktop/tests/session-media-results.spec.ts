import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {agentSessionSandbox} from "../src/main/agent/context.ts";
import {discoverEngines} from "../src/main/agent/engines.ts";
import {fixtureBinary} from "./acceptance-paths.ts";
import {closeApplication} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("原会话真实MCP保存后打开确切历史视频与停用插件成果，返回仍沿原PTY",async({},info)=>{
 test.setTimeout(240000);
 test.skip(!(await discoverEngines()).some(engine=>engine.id==="claude-code"&&engine.available),"需本机原生CLI验证PTY，不发送模型请求");
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-session-media-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const seeded=spawnSync(fixtureBinary("baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(seeded.status,seeded.error?.message??seeded.stderr).toBe(0);const refs=JSON.parse(seeded.stdout),work=refs.video;
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"默认视频"}]}]}));
 const owner="org.hetu.session-review",pkg=path.join(folder,"review-plugin");await mkdir(pkg);
 await writeFile(path.join(pkg,"plugin.json"),JSON.stringify({manifest_version:1,host_api:"1",id:owner,version:"1.0.0",license:"MIT",dependencies:[],work_kinds:["video"],display:{"zh-CN":"视频审阅记录",en:"Video review notes"},description:{"zh-CN":"隔离会话成果验收",en:"Isolated session result acceptance"},runtime:{entry:"backend.mjs"},contributions:{views:[],skills:[],data:[{kind:"review_notes",schema_version:"1",schema:{type:"object",additionalProperties:false,required:["note"],properties:{note:{type:"string"}}}}],actions:[{id:"save_note",title:"保存审阅记录",effect:"managed_write",input_schema:{type:"object",additionalProperties:false,required:["title","note","expected_revision","expected_sha256","operation_key"],properties:{object_id:{type:"string"},title:{type:"string"},note:{type:"string"},expected_revision:{type:"integer"},expected_sha256:{type:"string"},operation_key:{type:"string"}}}}]}}));
 await writeFile(path.join(pkg,"backend.mjs"),`let context;export function apply(value){context=value;}export async function invoke(action,input){if(action!=="save_note")throw Error("未知动作");return context.request("hetu.extensions.objects.save",{work_ref:context.work_ref,kind:"review_notes",schema_version:"1",...(input.object_id?{object_id:input.object_id}:{}),title:input.title,content:{note:input.note},expected_revision:input.expected_revision,expected_sha256:input.expected_sha256,operation_key:input.operation_key});}`);
 const executable=process.env.HETU_PACKAGED_APP;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),...(!executable?{HETU_PLUGIN_NODE:process.execPath,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
 const client=new Client({name:"hetu-session-media-acceptance",version:"1"},{});let connected=false;
 try{
  const page=await app.firstWindow(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await page.setViewportSize({width:1440,height:960});
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
  const launch=page.getByRole("dialog",{name:"创建会话",exact:true});await launch.getByRole("combobox",{name:"会话作品",exact:true}).selectOption({label:"默认视频"});
  await launch.getByRole("button",{name:/^引擎(?: |$)/}).click();await launch.getByRole("tab",{name:"Claude Code",exact:true}).click();await launch.getByRole("button",{name:"打开终端",exact:true}).click();await expect(launch).toHaveCount(0,{timeout:45000});
  const session=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));expect(session.client).toBe("claude-code");expect(session.terminal_connected).toBe(true);
  await page.evaluate(input=>window.hetuDesktop.agentSession("draft",input),{session_id:session.session_id,work_ref:work,text:"保留会话草稿，不发送模型。"});
  const appPath=await app.evaluate(({app})=>app.getAppPath()),runtime=executable?path.join(path.dirname(appPath),"bin/node"):process.execPath;
  const config=path.join(agentSessionSandbox(profile,work),session.session_id!,"hetu-mcp.json");expect(JSON.parse(await readFile(config,"utf8")).args[1]).toBe("claude-code");
  const transport=new StdioClientTransport({command:runtime,args:[path.join(appPath,"dist/agent-mcp-relay.mjs"),config],env:Object.fromEntries(Object.entries({...process.env,HETU_COLLABORATION_DIR:collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_NODE:runtime,HETU_PLUGIN_MANAGER:path.join(appPath,"dist/plugin-manager.mjs")}).filter((entry):entry is [string,string]=>typeof entry[1]==="string")),stderr:"pipe"});
  let transportError="";transport.stderr?.on("data",value=>{transportError+=String(value).slice(0,2000);});await client.connect(transport);connected=true;
  const call=async(action:string,input:any)=>{const result=await client.callTool({name:"hetu_call_action",arguments:{action,input}});const envelope=result.structuredContent as any;expect(envelope?.status,JSON.stringify(envelope)+transportError).toBe("succeeded");return envelope.data;};
  const execute=async(action:string,input:any={})=>{const outer=await page.evaluate(command=>window.hetuDesktop.execution({action:"hetu.execution.invoke",contract_revision:"1",input:{command}}),{action,contract_revision:"1",input});expect(outer.status,JSON.stringify(outer)).toBe("succeeded");expect(outer.data.result.status,JSON.stringify(outer)).toBe("succeeded");return outer.data.result.data;};
  const project=await execute("hetu.video.projects.get",{video_project_id:work.object_id});
  const episode=(await execute("hetu.video.episodes.create",{project_ref:{video_project_id:work.object_id,revision:project.project.revision,sha256:project.sha256},title:"第二集固定成果",brief:"验证原会话精确定位",operation_key:"second-episode"})).episode.video_episode_id;
  const original=await execute("hetu.video.media.get",{work_ref:work,media_ref:refs.first});
  const base={work_ref:work,video_episode_id:episode,asset_ref:original.media.asset_ref,purpose:"clip",stream_index:original.media.stream_index,time_base:original.media.time_base,duration_ticks:original.media.duration_ticks};
  for(let i=0;i<26;i++)await execute("hetu.video.media.save",{...base,title:`其他视频${i}`,operation_key:`other-${i}`});
  const saved=await call("hetu.execution.invoke",{workspace_path:workspace,command:{action:"hetu.video.media.save",contract_revision:"1",input:{...base,title:"会话指定历史视频",operation_key:"session-video"}}});
  const fixed=saved.result.data;expect(saved.result.status).toBe("succeeded");
  const latest=await execute("hetu.video.media.save",{...base,title:"后来保存的视频",previous_media_ref:fixed.media_ref,operation_key:"later-video"});
  const firstPage=await execute("hetu.video.media.list",{work_ref:work,video_episode_id:episode});expect(firstPage.items.some((row:any)=>row.media_ref.media_id===fixed.media_ref.media_id)).toBe(false);
  await app.evaluate(({dialog},pkg)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[pkg]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});},pkg);await page.evaluate(()=>window.hetuDesktop.install());
  const packageInfo=await call("hetu.plugins.inspect_package",{package_directory:pkg});
  const binding={work_ref:work,plugin_id:owner,package_sha256:packageInfo.package_sha256};
  const cap=await execute("hetu.plugins.capabilities",binding);
  const invoke=async(input:any)=>{
   const outer=await call("hetu.execution.invoke",{workspace_path:workspace,command:{action:"hetu.plugins.invoke",contract_revision:"1",input:{...binding,capabilities_sha256:cap.capabilities_sha256,action:"save_note",arguments:input}}});
   expect(outer.result.data.result.status,JSON.stringify(outer)).toBe("succeeded");return outer.result.data.result.data;
  };
  const noteInput={title:"会话指定历史审阅",note:"只属于第一版的审阅意见。",expected_revision:0,expected_sha256:"",operation_key:"session-note"};
  const note=await invoke(noteInput);await invoke(noteInput);
  await invoke({object_id:note.object.object_id,title:"新版审阅",note:"这是第二版，不应替换旧成果。",expected_revision:1,expected_sha256:note.sha256,operation_key:"later-note"});
  await page.evaluate(owner=>window.hetuDesktop.toggle(owner,false),owner);
  const results=await page.evaluate(()=>window.hetuDesktop.agentSession("results"));expect(results.items.filter((item:any)=>item.kind==="plugin")).toHaveLength(2);expect(results.items.every((item:any)=>item.state==="verified")).toBe(true);
  await page.getByRole("button",{name:"查看作品成果",exact:true}).click();const panel=page.getByRole("region",{name:"作品成果",exact:true});await expect(panel.getByRole("button",{name:"会话指定历史视频",exact:true})).toBeEnabled({timeout:30000});await panel.getByRole("button",{name:"会话指定历史视频",exact:true}).click();
  const video=page.getByRole("region",{name:"视频作品",exact:true});await expect(video.getByRole("heading",{name:"会话指定历史视频 片段",exact:true})).toBeVisible();await expect(video).toHaveAttribute("aria-busy","false");
  await expect(page.getByRole("combobox",{name:"视频分集",exact:true})).toHaveValue(episode);await expect(page.getByRole("combobox",{name:"视频成果版本",exact:true})).toHaveValue(fixed.media_ref.media_id);
  await app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers;
   (globalThis as any).__sessionMediaReads={library:0,list:0};
   for(const [channel,method,key] of [["desktop:library","refresh","library"],["desktop:video","list","list"]]){
    const original=handlers.get(channel);
    handlers.set(channel,async(...args:any[])=>{const value=await original(...args);if(args[1]===method)(globalThis as any).__sessionMediaReads[key]++;return value;});
   }
  });
  const agentRefresh=async(method:string)=>{
   const before=await app.evaluate(()=>(globalThis as any).__sessionMediaReads);
   await app.evaluate(({BrowserWindow},{method,work})=>BrowserWindow.getAllWindows().find(window=>!window.webContents.getURL().includes("?view=settings"))!.webContents.send("desktop:agent-session",{type:"notification",method,work_ref:work,params:{}}),{method,work});
   await expect.poll(()=>app.evaluate(()=>(globalThis as any).__sessionMediaReads.library)).toBeGreaterThan(before.library);
   await expect.poll(()=>app.evaluate(()=>(globalThis as any).__sessionMediaReads.list)).toBeGreaterThan(before.list);
   await expect(video).toHaveAttribute("aria-busy","false");
  };
  for(const method of ["results/verified","turn/completed"]){
   await agentRefresh(method);await expect(video.getByRole("heading",{name:"会话指定历史视频 片段",exact:true})).toBeVisible();
   await expect(page.getByRole("combobox",{name:"视频成果版本",exact:true})).toHaveValue(fixed.media_ref.media_id);
  }
  for(let refresh=0;refresh<4;refresh++){
   await page.getByRole("button",{name:"刷新视频作品",exact:true}).click();await expect(video.getByRole("heading",{name:"会话指定历史视频 片段",exact:true})).toBeVisible();await expect(video).toHaveAttribute("aria-busy","false");
   await expect(video.locator("video")).toBeVisible();await expect.poll(()=>video.locator("video").evaluate((element:HTMLVideoElement)=>element.readyState),{timeout:30000}).toBeGreaterThanOrEqual(2);
   await expect(page.getByRole("combobox",{name:"视频成果版本",exact:true})).toHaveValue(fixed.media_ref.media_id);
  }
  const player=video.locator("video");await expect.poll(()=>player.evaluate((element:HTMLVideoElement)=>element.readyState),{timeout:30000}).toBeGreaterThanOrEqual(2);
  await player.evaluate((element:HTMLVideoElement)=>{(window as any).__mediaPlaybackElement=element;(window as any).__mediaPlaybackEvents=[];for(const name of ["play","playing","pause","ended","waiting","stalled","error","emptied","timeupdate"])element.addEventListener(name,()=>{const events=(window as any).__mediaPlaybackEvents;events.push({type:name,time:element.currentTime,paused:element.paused,ready:element.readyState});if(events.length>40)events.shift();});});
  await player.evaluate((element:HTMLVideoElement)=>element.play());
  try{await expect.poll(()=>player.evaluate((element:HTMLVideoElement)=>element.currentTime)).toBeGreaterThan(0.1);}
  catch(error){await info.attach("playback-state",{body:JSON.stringify(await page.evaluate(()=>{const element=(window as any).__mediaPlaybackElement as HTMLVideoElement;return {time:element?.currentTime,duration:element?.duration,ready:element?.readyState,network:element?.networkState,paused:element?.paused,ended:element?.ended,error:element?.error?.code,visibility:document.visibilityState,connected:element?.isConnected,visible_player:!!document.querySelector(".video-workbench video"),events:(window as any).__mediaPlaybackEvents};})),contentType:"application/json"});throw error;}
  await player.evaluate((element:HTMLVideoElement)=>element.pause());
  await page.screenshot({path:info.outputPath("fixed-video.png")});
  await video.getByRole("button",{name:"更多成果",exact:true}).click();
  await expect(page.getByRole("combobox",{name:"视频成果版本",exact:true}).locator(`option[value="${latest.media_ref.media_id}"]`)).toHaveCount(1);
  await page.getByRole("combobox",{name:"视频成果版本",exact:true}).selectOption(latest.media_ref.media_id);
  await expect(video.getByRole("heading",{name:"后来保存的视频 片段",exact:true})).toBeVisible();
  await agentRefresh("results/verified");await expect(page.getByRole("combobox",{name:"视频成果版本",exact:true})).toHaveValue(latest.media_ref.media_id);
  const firstEpisode=project.episodes[0].episode.video_episode_id;
  await page.getByRole("combobox",{name:"视频分集",exact:true}).selectOption(firstEpisode);await expect(video).toHaveAttribute("aria-busy","false");
  await expect(page.getByRole("combobox",{name:"视频分集",exact:true})).toHaveValue(firstEpisode);
  await expect(page.getByRole("combobox",{name:"视频成果版本",exact:true})).not.toHaveValue(latest.media_ref.media_id);
  await agentRefresh("turn/completed");await expect(page.getByRole("combobox",{name:"视频分集",exact:true})).toHaveValue(firstEpisode);
  const returnSession=async()=>{await page.evaluate(work_ref=>window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref}})),work);const current=await page.evaluate(()=>window.hetuDesktop.agentSession("get"));expect(current.session_id).toBe(session.session_id);expect(current.generation).toBe(session.generation);expect(current.draft).toBe("保留会话草稿，不发送模型。");await page.getByRole("button",{name:"查看作品成果",exact:true}).click();};
  await returnSession();
  await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:fallback");let failed=false;handlers.set("desktop:fallback",async(event:any,owner:string,action:string,input:any)=>{if(!failed&&action==="hetu.extensions.objects.export"&&input.revision===1){failed=true;throw Error("隔离验收：原专业版本暂不可读。");}return original(event,owner,action,input);});});
  await panel.getByRole("button",{name:"会话指定历史审阅",exact:true}).click();await expect(page.getByRole("alert")).toContainText("原专业版本暂不可读");await page.getByRole("button",{name:"重新读取成果",exact:true}).click();
  const preview=page.getByRole("region",{name:"固定插件成果导出",exact:true});await expect(preview).toContainText("只属于第一版的审阅意见。");await expect(preview).not.toContainText("这是第二版");await expect(page.getByRole("region",{name:"插件成果",exact:true})).toContainText("插件未启用");await page.screenshot({path:info.outputPath("fixed-retained-note.png")});
  await returnSession();expect(errors).toEqual([]);await writeFile(info.outputPath("result.json"),JSON.stringify({packaged:!!executable,model_turns:0,actual_mcp:true,video_reference:fixed.media_ref,second_episode:true,not_on_first_page:true,refresh_retained:true,agent_notification_retained:true,explicit_selection_retained:true,explicit_episode_retained:true,decoded_and_played:true,plugin_revision:note.object.revision,disabled_plugin_read:true,fixed_read_retry:true,duplicate_saved_once:true,same_session:true,draft_retained:true},null,2));
 }catch(error){await app.windows()[0]?.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});throw error;}
 finally{if(connected)await client.close();await closeApplication(app,"window");}
});
