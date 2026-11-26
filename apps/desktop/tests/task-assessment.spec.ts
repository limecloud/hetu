import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {PluginPackage} from "../../../packages/plugin-host/src/package.ts";
import {AppServer} from "../src/main/rpc.ts";
import {navigate} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("任务按固定候选区分交付、专业报告和采纳，停用可读，历史批次与迟到响应不混用",async({},info)=>{
 test.setTimeout(240000);
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-assessment-ui-")),workspace=path.join(folder,"作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const pkg=await PluginPackage.inspect(path.join(root,"plugins/relationships/dist"));
 const fixture=spawnSync(path.join(root,"target/debug/examples/plugin_fixture"),[workspace,path.join(folder,"access"),path.join(pkg.source,"plugin.json"),pkg.sha256,"0"],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);const context=JSON.parse(fixture.stdout);
 const types=[{kind:"novel_review",schema_version:"1.0.0",schema:{type:"object"}}];
 const reportDirectory=path.join(folder,"report-package");await mkdir(reportDirectory);
 const manifest={manifest_version:1,host_api:"1",id:"org.wordflowlab.novel-review",version:"0.0.1",license:"MIT",dependencies:[],display:{"zh-CN":"报告验收",en:"Report acceptance"},description:{"zh-CN":"只读报告夹具",en:"Read-only report fixture"},contributions:{views:[],actions:[],data:types}};
 await writeFile(path.join(reportDirectory,"plugin.json"),JSON.stringify(manifest));const reportPkg=await PluginPackage.inspect(reportDirectory);
 const core=await AppServer.open(path.join(root,"target/debug/hetu-app-server"),workspace);
 let assessment:any,report:any,task:any;
 try{
  const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,contract_revision:"1",input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
  task=await call("hetu.creative_tasks.get",{task_ref:context.task_ref});assessment=await call("hetu.creative_tasks.assess",{task_ref:context.task_ref});
  const source={...assessment.delivery.candidates[0].evidence_source,work_ref:context.work_ref};
  const saved=await core.request("plugins/request",{context:{plugin_id:manifest.id,package_sha256:reportPkg.sha256,work_ref:context.work_ref,types},request:{action:"hetu.extensions.objects.save",contract_revision:"1",input:{work_ref:context.work_ref,kind:"novel_review",title:"原候选局部审校",schema_version:"1.0.0",source_refs:[source],content:{format_version:1,title:"原候选局部审校",framework_version:"1",scope_indices:[0],checks:["continuity","characters","promises","pacing","prose","canon"].map(domain=>({id:domain,domain,status:domain==="canon"?"inconclusive":"pass",source_indices:[0],summary:domain==="canon"?"未读取完整设定，保持不确定。":"仅核对固定候选的已读范围。"})),issues:[]},expected_revision:0,expected_sha256:"",operation_key:"report"}}});expect(saved.status,JSON.stringify(saved)).toBe("succeeded");report=saved.data;
 }finally{await core.close();}
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:context.work_ref.workspace_id,works:[{work_ref:context.work_ref,title:"插件集成测试"}]}]}));
 const executable=process.env.HETU_PACKAGED_APP;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_ACCESS_DIR:path.join(folder,"access"),HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_CODEX_BIN:path.join(folder,"no-agent"),...(!executable?{HETU_PLUGIN_NODE:process.execPath,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
 try{
  const page=await app.firstWindow();await page.setViewportSize({width:1200,height:850});await page.getByRole("button",{name:"打开作品 插件集成测试",exact:true}).click();await expect(page.getByRole("heading",{name:"作品资料",exact:true})).toBeVisible();
  await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});},reportDirectory);await page.evaluate(()=>window.hetuDesktop.install());
  await page.evaluate(id=>window.hetuDesktop.toggle(id,false),manifest.id);
  await navigate(page,"参考稿审核");await page.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(context.task_ref.task_id);
  const summary=page.locator(".task-assessment > summary"),region=page.getByRole("region",{name:"交付与检查",exact:true});await summary.click();await expect(region).toContainText("2 份固定候选");await expect(region).toContainText("未附加专业报告");await expect(region).toContainText("尚未采纳");
  await region.getByRole("button",{name:"选择专业报告",exact:true}).click();const picker=page.getByRole("dialog",{name:"专业成果",exact:true});
  await expect(picker.getByRole("combobox",{name:"成果所属插件",exact:true})).toContainText("停用");await picker.getByRole("button",{name:/原候选局部审校/}).click();
  await expect(region.getByRole("article",{name:"原候选局部审校",exact:true})).toContainText("仍有不确定项",{timeout:30000});await expect(region).toContainText("报告未检查当前候选");await expect(region).toContainText("未读取完整设定，保持不确定");
  const fixed={kind:"plugin_object",work_ref:context.work_ref,owner_plugin_id:manifest.id,object_id:report.object.object_id,revision:report.object.revision,sha256:report.sha256};
  const old=await page.evaluate(input=>window.hetuDesktop.tasks("assessment",input.task_ref,{submission_id:input.submission_id,professional_refs:[input.fixed]}),{task_ref:context.task_ref,submission_id:task.submission.submission_id,fixed});expect(old.status,JSON.stringify(old)).toBe("succeeded");expect(old.data.delivery.candidates.map((item:any)=>item.candidate_ref)).toEqual(assessment.delivery.candidates.map((item:any)=>item.candidate_ref));
  const metrics=[];
  for(const [width,theme] of [[1200,"light"],[800,"dark"]] as const){
   await page.setViewportSize({width,height:850});await page.emulateMedia({colorScheme:theme});
   await page.evaluate(()=>document.fonts.ready);
   await expect(page.locator("main")).toHaveCSS("background-color",theme==="dark"?"rgb(34, 34, 34)":"rgb(255, 255, 255)");
   const measured=await region.evaluate(element=>({overflow:element.scrollWidth>element.clientWidth,fonts:[...new Set(Array.from(element.querySelectorAll("*"),node=>getComputedStyle(node).fontSize))],border:getComputedStyle(element.parentElement!).borderTopWidth}));
   expect(measured.overflow).toBe(false);expect(measured.fonts.every(size=>parseFloat(size)>=12)).toBe(true);
   metrics.push({width,theme,...measured});await page.screenshot({path:info.outputPath(`assessment-${theme}-${width}.png`)});
  }
  await info.attach("assessment-layout",{contentType:"application/json",body:JSON.stringify(metrics)});
  await page.evaluate(async()=>{const current=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:current.revision,patch:{language:"en"}});});
  await expect(page.getByRole("region",{name:"Delivery and checks",exact:true})).toContainText("Some checks remain inconclusive");
  await page.screenshot({path:info.outputPath("assessment-english.png")});
  await page.evaluate(async()=>{const current=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:current.revision,patch:{language:"zh-CN"}});});
  // 读取失败保留所选报告；旧请求返回不能复活已移除的选择。
  await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:tasks"),state=globalThis as any;handlers.set("desktop:tasks",async(event:any,method:string,...args:any[])=>{if(method==="assessment"&&state.__failAssessment){state.__failAssessment=false;throw Error("隔离验收：专业核对暂不可用。");}const value=await original(event,method,...args);if(method==="assessment"&&state.__holdAssessment){state.__holdAssessment=false;await new Promise<void>(resolve=>state.__releaseAssessment=resolve);}return value;});state.__failAssessment=true;});
  await region.getByRole("button",{name:"重新核对交付",exact:true}).click();await expect(region.getByRole("alert")).toContainText("专业核对暂不可用");await expect(region).toContainText("原候选局部审校");await region.getByRole("button",{name:"重新核对",exact:true}).click();await expect(region.getByRole("alert")).toHaveCount(0);await expect(region.getByRole("button",{name:"重新核对交付",exact:true})).toBeEnabled();
  await app.evaluate(()=>{(globalThis as any).__holdAssessment=true;});await region.getByRole("button",{name:"重新核对交付",exact:true}).click();await expect.poll(()=>app.evaluate(()=>typeof(globalThis as any).__releaseAssessment)).toBe("function");
  await region.getByRole("button",{name:"移除报告 原候选局部审校",exact:true}).click();await app.evaluate(()=>(globalThis as any).__releaseAssessment());await expect(region).toContainText("未附加专业报告");await expect(region.getByRole("article")).toHaveCount(0);
  await page.setViewportSize({width:800,height:700});await page.screenshot({path:info.outputPath("assessment-narrow.png")});
  const changed=await page.evaluate(input=>window.hetuDesktop.tasks("assessment",input.task_ref,{professional_refs:[{...input.fixed,sha256:"0".repeat(64)}]}),{task_ref:context.task_ref,fixed});expect(changed.status).not.toBe("succeeded");
  expect((await page.evaluate(id=>window.hetuDesktop.read("hetu.documents.get",{document_id:id}),context.document.document_id)).data.revision.sha256).toBe(context.source_refs[0].sha256);
  await expect(page.evaluate(work_ref=>window.hetuDesktop.tasks("assessment",{scope_ref:{kind:"workspace",id:work_ref.workspace_id},task_id:"task_00000000-0000-4000-8000-000000000000",request_revision:1}),context.work_ref)).rejects.toThrow(/任务目录/);
 }finally{await app.close();}
});
