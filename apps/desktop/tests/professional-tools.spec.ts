import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {navigate,closeApplication} from "./navigation.ts";
import {PluginPackage} from "../../../packages/plugin-host/src/package.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("专业入口读取真实包与方法，固定文稿且只读准备，过期及未知交接不重发",async({},info)=>{
 test.setTimeout(240000);
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-professional-ui-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);
 const context=JSON.parse(fixture.stdout),work=context.novel;
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"默认小说"}]}]}));
 const staticDirectory=path.join(folder,"static-method");await mkdir(path.join(staticDirectory,"skills/inspect"),{recursive:true});
 const method="---\nname: hetu-fixed-source-inspection\ndescription: 核对人物行动\n---\n\n先读固定原文，再核对人物行动；仅有事实依据时才提出修改。\n";
 await writeFile(path.join(staticDirectory,"plugin.json"),JSON.stringify({manifest_version:1,host_api:"1",id:"org.hetu.static-inspection",version:"1.0.0",license:"MIT",dependencies:[],work_kinds:["novel"],display:{"zh-CN":"行动核对",en:"Action inspection"},description:{"zh-CN":"核对固定人物行动",en:"Inspect fixed character actions"},runtime:{entry:"backend.mjs"},contributions:{views:[],data:[],actions:[],skills:[{id:"inspect",name:"hetu-fixed-source-inspection",description:"核对人物行动",entry:"skills/inspect/SKILL.md"}]}}));
 await writeFile(path.join(staticDirectory,"skills/inspect/SKILL.md"),method);await writeFile(path.join(staticDirectory,"backend.mjs"),"throw new Error('静态读取不得启动专业后端');");
 const pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
 const executable=process.env.HETU_PACKAGED_APP;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_CODEX_BIN:path.join(folder,"no-agent"),...(!executable?{HETU_PLUGIN_NODE:process.execPath,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
 try{
  const page=await app.firstWindow(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await page.setViewportSize({width:1200,height:800});
  await app.evaluate(({clipboard})=>{let text="";clipboard.write=value=>{text=value.text??"";};clipboard.writeText=value=>{text=value;};clipboard.readText=()=>text;});
  await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(page.getByRole("heading",{name:"作品资料",exact:true})).toBeVisible();
  const open=async()=>{await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"专业工具",exact:true}).click();};
  const dialog=page.getByRole("dialog",{name:"专业工具",exact:true}),close=()=>dialog.getByRole("button",{name:"关闭上下文选择",exact:true}).click();
  await open();await expect(dialog).toContainText("当前作品没有可用的专业工具。");await close();
  const install=async(directory:string)=>{await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});},directory);await page.evaluate(()=>window.hetuDesktop.install());};
  await install(staticDirectory);await install(pkg.source);
  const before=(await page.evaluate(id=>window.hetuDesktop.read("hetu.documents.get",{document_id:id}),context.document.document.document_id)).data;
  const tasksBefore=await page.evaluate(()=>window.hetuDesktop.tasks("list"));
  await app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:professional"),state=globalThis as any;
   handlers.set("desktop:professional",async(event:any,method:string,input:any)=>{
    if(state.__failProfessionalCatalog&&method==="catalog"){state.__failProfessionalCatalog=false;throw Error("隔离验收：工具目录暂时不可用。");}
    const started=Date.now();let value;
    try{value=await original(event,method,input);}
    catch(error){if(method==="prepare")state.__professionalPrepareError=String(error);throw error;}
    if(method==="prepare")state.__professionalPrepareDuration=Date.now()-started;
    if(state.__holdProfessionalPrepare&&method==="prepare"){state.__holdProfessionalPrepare=false;await new Promise<void>(resolve=>{state.__releaseProfessional=resolve;});}
    return value;
   });state.__failProfessionalCatalog=true;
  });
  await open();await expect(dialog.getByRole("alert")).toContainText("工具目录暂时不可用");await expect(dialog).not.toContainText("没有可用");await dialog.getByRole("button",{name:"重新读取",exact:true}).click();
  await dialog.getByRole("button",{name:/行动核对/}).click();await dialog.getByRole("combobox",{name:"专业处理方式",exact:true}).selectOption("skill:inspect");
  await dialog.getByRole("button",{name:"查看创作方法",exact:true}).click();await expect(dialog.getByLabel("创作方法",{exact:true})).toHaveText(method,{timeout:30000});
  const goal=dialog.getByRole("textbox",{name:"专业处理目标",exact:true});await goal.fill("核对人物行动，保留第一章。");
  await app.evaluate(()=>{(globalThis as any).__holdProfessionalPrepare=true;});await dialog.getByRole("button",{name:"准备请求",exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>{const state=globalThis as any;return state.__professionalPrepareError??typeof state.__releaseProfessional;}),{timeout:30000,message:"等待原专业准备完成读取后再注入迟到响应"}).toBe("function");
  await info.attach("professional-prepare-duration",{contentType:"application/json",body:JSON.stringify({duration_ms:await app.evaluate(()=>(globalThis as any).__professionalPrepareDuration)})});
  await goal.fill("只读核对，不保存。");await app.evaluate(()=>(globalThis as any).__releaseProfessional());
  await expect(dialog.getByRole("region",{name:"专业请求预览",exact:true})).toHaveCount(0);
  await dialog.getByRole("button",{name:"准备请求",exact:true}).click();await dialog.getByRole("button",{name:"复制请求",exact:true}).click();
  await expect(dialog.getByRole("status")).toContainText("请求已复制");const prompt=await app.evaluate(({clipboard})=>clipboard.readText());expect(prompt).toContain("只读核对，不保存。");expect(prompt).not.toContain("management_ref");
  const fixed=JSON.parse(prompt.slice(prompt.indexOf("\n{")+1));expect(fixed.professional.skill_id).toBe("inspect");expect(fixed.professional.skill_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect((await page.evaluate(()=>window.hetuDesktop.tasks("list")))).toEqual(tasksBefore);await page.screenshot({path:info.outputPath("static-method.png")});
  await close();await navigate(page,"小说");await expect(page.getByRole("textbox",{name:"文稿编辑",exact:true})).toBeVisible();
  await page.getByLabel("外部 Agent 写作工具",{exact:true}).click();await page.getByRole("menuitem",{name:"专业工具",exact:true}).click();
  await dialog.getByRole("button",{name:/人物关系图/}).click();await expect(dialog).toContainText("此插件未提供创作方法。");
  await dialog.getByRole("combobox",{name:"专业处理方式",exact:true}).selectOption("action:arrange");await goal.fill("整理人物关系布局，保持正式原文。");
  await dialog.getByRole("button",{name:"准备请求",exact:true}).click();await dialog.getByRole("button",{name:"复制请求",exact:true}).click();
  await expect(dialog.getByRole("status")).toContainText("请求已复制");const arrangedPrompt=await app.evaluate(({clipboard})=>clipboard.readText()),arrangedContext=JSON.parse(arrangedPrompt.slice(arrangedPrompt.indexOf("\n{")+1));
  expect(arrangedContext.professional.action_id).toBe("arrange");expect(arrangedContext.fixed_refs).toContainEqual(expect.objectContaining({kind:"document",document_id:before.document.document_id,revision_id:before.revision.revision_id,sha256:before.revision.sha256}));
  // 只在测试隔离作品执行原公开动作，验证选择确实能交给原插件Owner使用。
  const execute=async(action:string,input:any)=>{const result=await page.evaluate(command=>window.hetuDesktop.execution({action:"hetu.execution.invoke",contract_revision:"1",input:{command}}),{action,contract_revision:"1",input});expect(result.status,JSON.stringify(result)).toBe("succeeded");expect(result.data.result.status,JSON.stringify(result)).toBe("succeeded");return result.data.result.data;};
  const binding={work_ref:work,plugin_id:arrangedContext.professional.plugin_id,package_sha256:arrangedContext.professional.package_sha256,capabilities_sha256:arrangedContext.professional.capabilities_sha256};
  const invoke=async(action:string,args:any)=>{const data=await execute("hetu.plugins.invoke",{...binding,action,arguments:args});expect(data.result.status,JSON.stringify(data)).toBe("succeeded");return data.result.data;};
  const saved=await invoke("hetu.extensions.objects.save",{kind:"relationships",title:"固定行动规划",schema_version:"1",content:{nodes:[{id:"keeper",label:"守塔人",x:0,y:0}],edges:[]},expected_revision:0,expected_sha256:"",operation_key:"professional-ui-save"});
  const arranged=await invoke("arrange",{object_id:saved.object.object_id,operation_key:"professional-ui-arrange"});expect(arranged.object.content.nodes[0]).toMatchObject({x:150,y:110});
  const reread=await execute("hetu.plugin_results.get",{work_ref:work,owner_plugin_id:pkg.manifest.id,object_id:arranged.object.object_id,revision:arranged.object.revision});
  expect(reread.object.content.nodes[0]).toMatchObject({x:150,y:110});
  expect((await page.evaluate(id=>window.hetuDesktop.read("hetu.documents.get",{document_id:id}),before.document.document_id)).data).toEqual(before);
  // 模拟宿主在收到草稿时丢回执；不启动外部引擎或模型轮次。
  await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:agent-session");(globalThis as any).__professionalDeliveries=0;handlers.set("desktop:agent-session",(event:any,method:string,input:any)=>{if(method==="insert"){(globalThis as any).__professionalDeliveries++;throw Error("隔离验收：投递回执丢失");}return original(event,method,input);});});
  await dialog.getByRole("button",{name:"放入当前会话",exact:true}).click();await expect(dialog.getByRole("status")).toContainText("发送结果尚未确认");
  await expect(dialog.getByRole("button",{name:"放入当前会话",exact:true})).toBeDisabled();await expect(dialog.getByRole("button",{name:"准备请求",exact:true})).toBeDisabled();
  await dialog.getByRole("button",{name:"复制请求",exact:true}).click();await expect(dialog.getByRole("status").filter({hasText:"请求已复制"})).toBeVisible();expect(await app.evaluate(()=>(globalThis as any).__professionalDeliveries)).toBe(1);expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(arrangedPrompt);
  await page.setViewportSize({width:800,height:700});await page.screenshot({path:info.outputPath("unknown-delivery-narrow.png")});await close();
  await page.evaluate(id=>window.hetuDesktop.toggle(id,false),pkg.manifest.id);
  await expect(page.evaluate(input=>window.hetuDesktop.professional("prepare",input),{work_ref:work,plugin:arrangedContext.professional,target:{page:"work.profile",object:{}},goal:"旧包请求"})).rejects.toThrow(/未启用|不可用/);
  expect(errors).toEqual([]);await writeFile(info.outputPath("result.json"),JSON.stringify({packaged:!!executable,static_backend_not_executed:true,preparation_did_not_create_tasks:true,core_saved_and_reread:true,formal_document_unchanged:true,unknown_delivery_not_repeated:true,model_turns:0},null,2));
 }finally{await closeApplication(app,"window");}
});
