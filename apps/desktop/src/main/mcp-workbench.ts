import { storageRequest, storageAction } from "./storage-review.ts";
import {localFontCatalog} from "./font-catalog.ts";
import { pluginPreferences } from "./plugin-preferences.ts";
import { ensureWorkConnection } from "./work-connection.ts";
import { creationHandoff, workHandoff, pluginResultText, pluginWorkText, migrationText, settingsHandoff } from "./workbench-handoff.ts";
import { validateWritingPrompt, writingPrompt } from "./writing-prompt.ts";
import { pluginResultHandoff } from "./plugin-results.ts";
import { readLibraryWorks as readWorks } from "./library-works.ts";
import { pluginViewHTML } from "./mcp-plugin-view.ts";
import { pluginService } from "./plugin-services.ts";
import { exportPluginFile } from "./plugin-export.ts";
import { savePluginArtifact } from "./plugin-artifact.ts";
import { PluginMigrationReview } from "./plugin-migrations.ts";
import { nativeDialog, cancelNativeDialogs } from "./native-dialog.ts";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID, createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { AppServer } from "./rpc.ts";
import { CreativeLibrary } from "./library.ts";
import {ReadingStateStore} from "./reading-state.ts";
import { RecoveryStore } from "./recovery.ts";
import { createWorkSession, type WorkSession } from "./work-session.ts";
import { SettingsReview } from "./settings.ts";
import { workAgentRequest, workAssociation } from "./work-agent.ts";
import { AgentConnectionInstall } from "./agent-connection-install.ts";
import { scopedCli } from "./cli.ts";
import { sameWork, supportsWork, type WorkRef } from "@hetu/plugin-sdk";
import { PluginInstallations, PluginPackage, BackendSupervisor, PluginHost, pluginSummaries, type InstallationState } from "@hetu/plugin-host";

const bin = process.env.HETU_WORKBENCH_BIN!;
const profile = process.env.HETU_WORKBENCH_PROFILE!;
if(!profile||!path.isAbsolute(profile))throw new Error("工作台资料目录无效，请重新打开当前连接。");
const client = process.env.HETU_WORKBENCH_CLIENT ?? "codex";
const collaboration = process.env.HETU_COLLABORATION_DIR;
const suffix = process.platform === "win32" ? ".exe" : "";
const binary = process.env.HETU_APP_SERVER ?? path.join(bin,"hetu-app-server"+suffix);
const cli = process.env.HETU_CLI ?? path.join(bin,"hetu"+suffix);
const recovery = new RecoveryStore();
const write = (value: unknown) => process.stdout.write(JSON.stringify(value)+"\n");
async function ask(kind:string,value:any):Promise<any> { return nativeDialog(kind,["confirm","reveal","copy","paste","external"].includes(kind)?value:value.options); }
if(process.env.HETU_DESKTOP_PROFILE){process.env.HETU_LOCAL_SETTINGS_DIR??=path.join(profile,"local-settings");process.env.HETU_MODEL_SERVICE_DIR??=path.join(profile,"model-service");process.env.HETU_PLUGIN_STATE_DIR??=profile;}
const local=await AppServer.open(binary);
const settings=new SettingsReview((method,input)=>local.request("local_settings/host",{method,input}),recovery,path.join(profile,"local-settings-journal.json"));
function unwrap(value:any){if(value.status!=="succeeded")throw new Error(value.error?.message??"操作未完成。");return value.data;}
let localState=await settings.get();
function agentClient(){const value=workAssociation(localState,selected).client;return ({claudeCode:"claude-code",other:"generic",none:"generic"} as Record<string,string>)[value]??value;}
const agentSettings=async(action:string,input:any,adapter=agentClient())=>unwrap(await local.request("local_settings/request",{client_adapter:adapter,request:{action,contract_revision:"1",input}}));
const library=new CreativeLibrary(path.join(profile,"creative-library.json"),recovery,async directory=>{const server=await AppServer.open(binary,directory,path.join(profile,"git-authorizations"));try{return await readWorks(server);}finally{await server.close();}});
await library.load();
let selected:WorkRef|undefined,server:AppServer|undefined,session:WorkSession|undefined,epoch=0,dirty=false;
let copied:string|undefined;
let events:any[]=[];
let pluginView:{owner:string;view:string;channel:string;epoch:number;package_sha256:string}|undefined;
let pluginBackend:BackendSupervisor|undefined;
const pluginMedia=new Set<string>();
const installations=new PluginInstallations((await local.request("plugins/directory",{})).directory);
let pluginError="",installationSha="",preferenceSnapshot="";
let pluginHost:PluginHost;
let pluginState:InstallationState={packages:[],grants:{}};
let pluginFileIdentity="";
try{const record=await installations.read();installationSha=record.sha256;pluginState=record.state;pluginHost=await installations.host(record.state);}catch(error){pluginError=(error as Error).message;pluginHost=new PluginHost();}
function handoffEnvironment(){return {client:agentClient(),coreCli:cli,collaborationDirectory:collaboration,localSettingsDirectory:process.env.HETU_LOCAL_SETTINGS_DIR};}
function pluginConnection(owner:string,work:WorkRef){const pkg=pluginHost.package(owner);return {plugin_id:owner,package_sha256:pkg.sha256,access_mode:"open",work_ref:work,workspace_path:library.resolve(work),package_path:pkg.source,state_directory:installations.directory,access_directory:process.env.HETU_PLUGIN_ACCESS_DIR??null,core_cli:process.env.HETU_PLUGIN_CLI??path.join(bin,"hetu-plugin"+suffix),runtime:path.join(import.meta.dirname,"plugin-runtime.mjs"),node_executable:process.execPath};}
async function refreshPlugins(){
 let record:Awaited<ReturnType<PluginInstallations["read"]>>;
 try{
  const identity=await stat(installations.file,{bigint:true}).then(value=>[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(":"),error=>{if(error.code==="ENOENT")return "missing";throw error;});
  // 安装Owner原子替换文件；元数据只控制展示投影的刷新，不参与授权或业务执行。
  if(identity===pluginFileIdentity)return false;
  record=await installations.read();pluginFileIdentity=identity;
 }catch(error){
  pluginFileIdentity="";
  const message=(error as Error).message;if(pluginError===message)return false;
  await closePlugin();for(const state of pluginHost.states())await pluginHost.disable(state.id);
  pluginHost=new PluginHost();pluginState={packages:[],grants:{}};installationSha="";pluginError=message;return true;
 }
 if(record.sha256===installationSha)return false;
 await closePlugin();for(const state of pluginHost.states())await pluginHost.disable(state.id);
 pluginHost=await installations.host(record.state);pluginState=record.state;installationSha=record.sha256;pluginError="";return true;
}
async function overview(){
 const changed=await refreshPlugins();const state=await settings.get();localState=state;
 const snapshot=JSON.stringify(state.preferences);if(snapshot!==preferenceSnapshot){preferenceSnapshot=snapshot;events.push({name:"onPreferences",value:{...state.preferences,settings_revision:state.revision}});}
 const result={plugin_state_error:pluginError||undefined,works:library.rows(),work:selected,epoch,agentClient:agentClient(),preferences:{...state.preferences,settings_revision:state.revision},
  plugins:pluginSummaries(pluginHost,pluginState),views:pluginHost.views.list().filter(view=>selected&&supportsWork(pluginHost.package(view.owner).manifest,selected)).map(view=>({key:view.id,owner:view.owner,...view.value}))};
 if(changed)events.push({name:"onPluginsChanged",value:result});return result;
}
function check(){if(!server||!selected)throw new Error("请选择当前作品。");}
function context(adapter:string){check();const current=server!,work=selected!,ticket=epoch;
  const active=()=>{if(server!==current||epoch!==ticket||!selected||!sameWork(selected,work))throw new Error("作品已切换，请重新读取。");};
  const call=(action:string,input:any)=>current.request("workspace/request",{action,contract_revision:"1",input});
  const base={client_adapter:adapter,work_ref:work,...(collaboration?{collaboration_path:collaboration}:{})};
  return {client:adapter,work,base,check:active,call:async(action:string,input:any)=>unwrap(await call(action,input)),status:async()=>{active();return unwrap(await call("hetu.collaboration.workspace_access",base));}};
}
async function machineAccess(adapter=agentClient()){const ctx=context(adapter),status=await ensureWorkConnection(ctx);return {...ctx,management_ref:status.management_ref};}
async function select(work:WorkRef){if(dirty)throw new Error("请先保存当前修改，再切换作品。");const directory=library.resolve(work);
  const next=await AppServer.open(binary,directory,path.join(profile,"git-authorizations"));
  try{const value=unwrap(await next.request("workspace/request",{action:"hetu.works.get",contract_revision:"1",input:{work_ref:work}}));if(!sameWork(value.summary.work_ref,work))throw new Error("作品身份与登记不一致。");}catch(error){await next.close();throw error;}
  epoch++;await closePlugin();await session?.dispose();await server?.close();server=next;selected=work;const ticket=epoch;
  session=createWorkSession(work,next,{profile,recovery,active:()=>epoch===ticket&&server===next,
    workspacePath: directory,
    scopedReview:async(action,input)=>{const current=await context(agentClient()).status();if(!current.authorized&&current.management_ref)throw new Error("当前作品的 Agent 连接已断开，请重新连接或发起协作。");const access=await machineAccess();return scopedCli(cli,agentClient(),collaboration,action,{...input,management_ref:access.management_ref});},
    confirm:async(message,detail,accept)=>await ask("confirm",{message,detail,accept})===true,
    chooseFile:options=>ask("choose_file",{options}),saveFile:options=>ask("save_file",{options}),
    agentClient,collaborationContext:context,coreCliBinary:()=>cli,copy:text=>{copied=text;},
    executionPolicy:()=>settings.preferences(),
    professionalPlugins:async()=>{await refreshPlugins();return {plugins:pluginSummaries(pluginHost,pluginState),plugin_state_error:pluginError||undefined};},
  });return overview();
}
async function install(kind:"agent_connection"|"agent_suite",input:any={}){
 const state=await settings.get(),association=workAssociation(state,input.work_ref);
 if(input.work_ref&&(!selected||!sameWork(input.work_ref,selected)))throw new Error("作品已切换，请重新安装。");
 const target={kind,agent_client:kind==="agent_connection"?"codex":association.client,...(kind==="agent_suite"?{suite_id:association.suite,...(input.work_ref?{work_ref:input.work_ref}:{})}:{})};
 const key=createHash("sha256").update(JSON.stringify(target)).digest("hex");
 const installer=new AgentConnectionInstall((action,input)=>agentSettings(action,input,target.agent_client),async plan=>{
 const preview=await settings.prepare(plan.operation_id,plan.sha256,plan.revision,true);
 if(!await ask("confirm",{message:kind==="agent_connection"?"安装河图 MCP App 到 Codex Desktop？":"安装当前 Skills 套件？",detail:plan.fixed.suite.name+" "+plan.fixed.suite.version+"\n只安装当前固定包，不修改作品。"}))throw new Error("已取消安装。");
 await settings.commit(preview.token);await settings.acknowledge();},recovery,path.join(profile,kind==="agent_connection"?"codex-connection-journal.json":"suite-install-"+key+".json"));
 return installer.run(target);
}
async function pluginContext(owner:string){
 check();const current=server!,work=selected!,ticket=epoch,pkg=pluginHost.package(owner);
 const active=()=>{if(server!==current||epoch!==ticket||!selected||!sameWork(selected,work)||!pluginHost.active(owner)||pluginHost.package(owner).sha256!==pkg.sha256)throw new Error("作品或插件包已变化。");};
 return {work,packageSha:pkg.sha256,context:{plugin_id:owner,package_sha256:pkg.sha256,work_ref:work,types:pkg.manifest.contributions.data},call:(method:string,params:any)=>current.request(method,params),check:active};
}
const migrations=new PluginMigrationReview(pluginContext);
async function closePlugin(){await pluginBackend?.dispose();pluginBackend=undefined;pluginView=undefined;for(const url of pluginMedia)await session?.media.release(url);pluginMedia.clear();}
async function pluginRequest(action:string,input:any){
 const current=pluginView;if(!current||current.epoch!==epoch)throw new Error("插件工作面已关闭。");
 const context=await pluginContext(current.owner);context.check();
 return context.call("plugins/request",{context:context.context,request:{action,contract_revision:"1",input}});
}
async function pluginInvoke(action:string,input:any){
 if(!pluginView)throw new Error("插件工作面已关闭。");const current=pluginView,pkg=pluginHost.package(current.owner);
 if(!pluginBackend){pluginBackend=new BackendSupervisor({node:process.execPath,electron:true,bootstrap:path.join(import.meta.dirname,"plugin-worker.mjs"),snapshot:await installations.snapshot(pkg),pkg,work_ref:selected!,request:pluginRequest,core_actions:unwrap(await pluginRequest("hetu.capabilities.get",{})).actions});await pluginBackend.initialize();}
 return pluginBackend.invoke(action,input);
}
async function pluginCall(channel:string,method:string,args:any[]){
 if(!pluginView||pluginView.channel!==channel||pluginView.epoch!==epoch)throw new Error("插件视图连接不可用。");
 const current=pluginView,ctx=await pluginContext(current.owner),check=ctx.check;
 if(method==="context")return {work_ref:selected,package_sha256:current.package_sha256,view_id:current.view,navigation:pluginHost.package(current.owner).manifest.contributions.views.find(view=>view.id===current.view)?.navigation??"host"};
 if(method==="request")return pluginRequest(args[0],args[1]);
 if(method==="invoke")return pluginInvoke(args[0],args[1]);
 if(method==="buffer"){const file=path.join(profile,"plugin-buffers",selected!.workspace_id,selected!.object_id,current.owner,current.view+".json");if(args[0]===undefined)return recovery.read(file);await recovery.write(file,args[0],8*1024*1024);return true;}
 if(method==="host")return pluginService(args[0],args[1]??{},{work:selected!,check,request:pluginRequest,preferences:()=>(pluginPreferences(localState)),
  handoff:async input=>{const access=await machineAccess();check();copied=pluginWorkText(input,selected!,current.owner,access.management_ref,pluginConnection(current.owner,selected!),agentClient());},
  openDocument:async document_id=>{events.push({name:"onOpenDocument",value:{work_ref:selected,document_id}});},
  openWork:async target=>{events.push({name:"onOpenWork",value:{work_ref:selected,epoch,target}});},
  closeView:()=>{events.push({name:"onClosePlugin",value:{owner:current.owner,view:current.view,epoch}});},
  mediaOpen:async input=>{const value=await session!.media.open(input);pluginMedia.add(value.url);return value;},mediaRelease:url=>{pluginMedia.delete(url);return session!.media.release(url);},
  exportFile:input=>{
   if(pluginHost.package(current.owner).manifest.contributions.actions.find(action=>action.id===input.action)?.effect!=="read")throw new Error("只能导出声明的只读动作。");
   return exportPluginFile(input as any,{check,invoke:pluginInvoke,choose:name=>ask("save_file",{options:{title:"导出插件成果",defaultPath:name}})});
  },
  saveArtifact:input=>savePluginArtifact(input as any,{check,choose:name=>ask("save_file",{options:{title:"导出插件成果",defaultPath:name}})}),
 });
 throw new Error("未知插件视图用例。");
}
async function applyPlugin(input:any){
 if(pluginError)throw new Error(pluginError+" 请保留插件状态记录并修复。");
 const previous=await installations.read();
 await closePlugin();
 await installations.apply({...input,client_adapter:"desktop",expected_sha256:previous.sha256,operation_key:randomUUID(),authorization_note:"作者在河图工作台选择此固定插件操作"},async pkg=>{const connection=server??local;await connection.request("extensions/disable",{plugin_id:pkg.manifest.id,package_sha256:pkg.sha256});});
 return overview();
}
async function dispatch(method:string,args:any[]){
 if(method!=="state"&&await refreshPlugins())events.push({name:"onPluginsChanged",value:await overview()});
 if(method==="readingState") {
  const [action,input={}]=args;check();if(!sameWork(input.work_ref,selected!))throw new Error("阅读位置不属于当前作品。");
  const store=new ReadingStateStore(path.join(profile,"reading-state"),recovery);
  if(action==="get")return store.get(selected!);if(action==="save")return store.save(selected!,input.patch);throw new Error("未知阅读位置操作。");
 }
 if(method==="fonts"){if(args.length>1||args[0]!==undefined&&typeof args[0]!=="boolean")throw new Error("字体目录请求无效。");return localFontCatalog(args[0]===true);}
 if(method==="state")return overview();
 if(method==="library") {const [kind,input={}]=args;if(kind==="refresh"){
  if(input.work_ref){check();if(!sameWork(input.work_ref,selected!))throw new Error("作品已切换，请重新读取当前作品。");await library.refresh([],selected);return overview();}
  const discovered:any[]=[];let cursor;do{const value=unwrap(await scopedCli(cli,agentClient(),collaboration,"hetu.collaboration.created_works",{limit:100,...(cursor?{cursor}:{})}));discovered.push(...value.works);cursor=value.next_cursor;}while(cursor);await library.refresh(discovered);return overview();
 }if(kind==="open")return select(input.work_ref);if(kind==="bootstrap"){copied=creationHandoff(input.kind,handoffEnvironment());return {copied:true};}if(kind==="client"){
  const value=({codex:"codex","claude-code":"claudeCode",workbuddy:"workbuddy",generic:"other"} as Record<string,string>)[input.client];
  if(!value)throw new Error("请选择支持的外部 Agent 客户端。");
  const state=await settings.get();
  if(selected)await settings.selection("associate",{expected_revision:state.revision,work_ref:selected,agent_client:value,suite_id:workAssociation(state,selected).suite});
  else{const preview=await settings.manual(state.revision,{agent_client:value});await settings.commit(preview.token);}
  await settings.acknowledge();return overview();
 }throw new Error("未知创作库操作。");}
 if(method==="select"){if(selected&&sameWork(selected,args[0]))return overview();return select(args[0]);}
 if(method==="dirty"){dirty=args[0]===true;return null;}
 if(method==="closeSurface"){if(dirty){if(!await ask("confirm",{message:"修改尚未保存到作品。",detail:"保留恢复稿并离开？"}))throw new Error("已保留当前编辑。");dirty=false;}await closePlugin();return null;}
 if(method==="bounds"||method==="zoom")return null;
 if(method==="pluginCall")return pluginCall(args[0],args[1],args[2]);
 if(method==="view"){check();const [owner,id]=args,pkg=pluginHost.package(owner),view=pkg.manifest.contributions.views.find(view=>view.id===id);if(!pluginHost.active(owner)||!view||!supportsWork(pkg.manifest,selected!))throw new Error("插件或作品工作面不可用。");await closePlugin();const channel=randomUUID();pluginView={owner,view:id,channel,epoch,package_sha256:pkg.sha256};return {channel,html:pluginViewHTML(pkg,view.entry,channel)};}
 if(method==="fallback"){check();return server!.request("extensions/host",{method:"read",params:{plugin_id:args[0],work_ref:selected,request:{action:args[1],contract_revision:"1",input:{...args[2],work_ref:selected}}}});}
 if(method==="migrations"){const [action,input]=args;if(action==="preview")return migrations.preview(input.owner,input.migration_id,input.plan_sha256);if(action==="approve")return migrations.approve(input.token);if(action==="continue"){const fixed=await migrations.handoff(input.owner,input.migration_id,input.plan_sha256);copied=migrationText(fixed,pluginConnection(input.owner,fixed.work_ref),agentClient());return {copied:true};}}
 if(method==="install"){const directory=await ask("choose_file",{options:{title:"选择河图插件包",properties:["openDirectory"]}});if(!directory)return overview();const pkg=await PluginPackage.inspect(directory);if(!await ask("confirm",{message:(pluginHost.has(pkg.manifest.id)?"替换":"安装")+pkg.manifest.display["zh-CN"]+" "+pkg.manifest.version+"？",detail:pkg.manifest.description["zh-CN"]+"\n许可："+pkg.manifest.license+"\n"+(pkg.manifest.runtime?"包含Node后端代码，仅安装可信来源。":"使用隔离Web界面。")+"\n启用后可使用宿主核心能力；现有成果和历史继续保留。"}))return overview();return applyPlugin({action:"install",package_directory:directory,package_sha256:pkg.sha256});}
 if(method==="toggle"||method==="uninstall"){const pkg=pluginHost.package(args[0]);if(method==="uninstall"&&!await ask("confirm",{message:"卸载"+pkg.manifest.display["zh-CN"]+"？",detail:"作品成果、历史修订和通用导出将继续保留。插件运行将停止，依赖插件会停用。"}))return overview();return applyPlugin({action:method==="uninstall"?"uninstall":args[1]?"enable":"disable",plugin_id:args[0],package_sha256:pkg.sha256});}
 if(method==="paste"){return ask("paste",{format:args[0]});}
 if(method==="copy"){await ask("copy",{text:args[0],html:args[1]});return null;}
 if(method==="installConnection")return install("agent_connection");
 if(method==="installSuite")return install("agent_suite",args[0]);
 if(method==="models"){
  if(args[0]==="account"||args[0]==="verify"){const value=unwrap(await local.request("model_service/host",{action:"inspect",input:{}}));await ask("external",{url:args[0]==="account"?"https://hetu.limeai.run/console/":value.pending?.verification_uri});return {opened:true};}
  return unwrap(await local.request("model_service/host",{action:args[0],input:args[1]??{}}));
 }
 if(method==="settings"){
 const [action,input={}]=args;
 if(action.startsWith("storage_"))return storageRequest(action,input,(action,params)=>storageAction(params=>local.request("local_settings/request",params),action,params),(message,detail)=>ask("confirm",{message,detail}));
 if(action==="get"){localState=await settings.get();return {...localState,journal:await settings.journal()};}if(action==="list")return settings.list(input.cursor);if(action==="operation")return settings.operation(input.operation_id);
 if(action==="preferences"){const snapshot=await settings.preferences();if(snapshot.revision!==localState.revision)localState=await settings.get();return snapshot;}
 if(action==="prepare")return settings.prepare(input.operation_id,input.sha256,input.revision,input.approve);
 if(action==="manual")return settings.manual(input.expected_revision,input.patch);
 if(action==="update"){const preview=await settings.manual(input.expected_revision,input.patch);const value=await settings.commit(preview.token);await settings.acknowledge();return value;}
 if(action==="commit"){const preview=settings.prepared(input.token);if(!await ask("confirm",{message:preview.title+"？",detail:"只提交刚才审阅的固定变化。批准方案后，由外部 Agent 执行；不会在此安装或执行生成。"}))throw new Error("已取消本机设置决定。");return settings.commit(input.token);}
 if(action==="recover")return settings.recover();if(action==="acknowledge")return settings.acknowledge();
 if(action==="select_suite")return agentSettings("hetu.local_settings.prepare",{kind:"agent_suite",suite_id:input.suite_id,agent_client:input.agent_client,install:input.install===true,summary:"选择创作方法套件",operation_key:randomUUID()});
 if(action==="handoff"||action==="continue"){copied=await settingsHandoff(action,input,{work:selected,settings,environment:handoffEnvironment(),check:()=>{}});return {copied:true};}
 throw new Error("未知本机设置用例。");}
 if(method==="settingsAgent"||method==="workAgent")return workAgentRequest(args[0],args[1]??{},{work:method==="workAgent"?selected:undefined,directory:selected?library.resolve(selected):"",settings,check:()=>{},refresh:overview,inspect:input=>local.request("local_settings/host",{method:"inspect_suite",input}),prepare:input=>agentSettings("hetu.local_settings.prepare",input),choose:async()=>await ask("choose_file",{options:{properties:["openDirectory"]}})??undefined,reveal:directory=>{void ask("reveal",{directory});}});
 if(method==="connection"){const [action,adapter]=args;const ctx=context(adapter);if(action==="status")return ctx.status();if(action==="authorize")return machineAccess(adapter);if(action==="select")return dispatch("library",["client",{client:adapter}]);if(action==="revoke"){const value=await ctx.status();if(!value.authorized)return value;if(await ask("confirm",{message:"撤销当前作品的 Agent 协作连接？",detail:"旧管理引用及派生任务将失效，作品内容保留。"}))await ctx.call("hetu.collaboration.revoke_management",{...ctx.base,grant_id:value.management_ref.grant_id,operation_key:randomUUID()});return ctx.status();}}
 if(method==="writingPrompt"){
  check();const [input]=args,work=selected!,authoring=session!.authoring,currentServer=server!;
  validateWritingPrompt(input,work);
  const access=await machineAccess(client);access.check();
  return writingPrompt(input,{work,authoring,environment:{...handoffEnvironment(),client},workspacePath:library.resolve(work),executionPolicy:()=>settings.get(),summary:async()=>unwrap(await currentServer.request("workspace/request",{action:"hetu.works.get",contract_revision:"1",input:{work_ref:work}})).summary,check:access.check,managementRef:access.management_ref});
 }
 if(method==="handoff"){
  check();const [page,object={}]=args;
  if(page.startsWith("fallback:")){const owner=page.slice(9),ctx=await pluginContext(owner);const fixed=await pluginResultHandoff(ctx,owner,object);ctx.check();copied=pluginResultText(fixed,pluginConnection(owner,ctx.work),agentClient());}
  else {const access=await machineAccess();copied=await workHandoff(page,object,{work:selected!,authoring:session!.authoring,environment:handoffEnvironment(),workspacePath:library.resolve(selected!),executionPolicy:()=>settings.get(),summary:async()=>unwrap(await server!.request("workspace/request",{action:"hetu.works.get",contract_revision:"1",input:{work_ref:selected}})).summary,check:access.check,managementRef:access.management_ref,pluginConnection:pluginView?pluginConnection(pluginView.owner,selected!):undefined});}
  return {copied:true};
 }
 if(method==="mediaChunk"){check();const [url,offset,length]=args;if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||length<1||length>512*1024)throw new Error("媒体读取预算无效。");const response=await session!.media.handle(new Request(url,{headers:{range:`bytes=${offset}-${offset+length-1}`}}));if(response.status!==206)throw new Error("固定媒体读取失败。");return {base64:Buffer.from(await response.arrayBuffer()).toString("base64")};}
 if(method==="open"){
  if(dirty&&!await ask("confirm",{message:"当前修改尚未保存。",accept:"保留恢复稿并打开"}))return null;
  const directory=await ask("choose_file",{options:{properties:["openDirectory"],title:"打开河图作品目录"}});if(!directory)return null;
  const connection=await AppServer.open(binary,directory,path.join(profile,"git-authorizations"));try{await library.register(directory,await readWorks(connection));}finally{await connection.close();}
  await closePlugin();await session?.dispose();await server?.close();session=undefined;server=undefined;selected=undefined;epoch++;dirty=false;return overview();
 }
 check();return session!.call(method,args);
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
let queue=Promise.resolve();
input.on("line",line=>{let message:any;try{message=JSON.parse(line);for(const index of message.undefined_args??[])message.args[index]=undefined;}catch{return;}
 queue=queue.catch(()=>{}).then(async()=>{copied=undefined;events=[];try{const value=await dispatch(message.method,message.args??[]);write({id:message.id,ok:true,value:value??null,events,...(copied?{copied}:{})});}catch(error){write({id:message.id,ok:false,message:(error as Error).message});}});
});
input.on("close",()=>{cancelNativeDialogs();void queue.finally(async()=>{await closePlugin();await session?.dispose();await server?.close();await local.close();process.exit(0);});});
