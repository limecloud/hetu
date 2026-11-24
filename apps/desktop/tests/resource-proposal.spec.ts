import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {navigate} from "./navigation.ts";
const root=path.resolve(import.meta.dirname,"../../..");
test("资料固定方案展示正文和旧修订对照，决定文案在宽窄窗口保持完整",async()=>{
 test.setTimeout(120000);
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-resource-proposal-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"hub");
 const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);
 const context=JSON.parse(fixture.stdout),work=context.novel;
 await mkdir(profile,{recursive:true});await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"默认小说"}]}]}));
 const app=await electron.launch({args:[path.join(root,"apps/desktop")],env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu")}});
 try{
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
  await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(page.getByRole("complementary",{name:"项目导航",exact:true})).toBeVisible();
  const grant=(await page.evaluate(()=>window.hetuDesktop.connection("authorize","codex"))).management_ref;
  const cli=(action:string,input:any)=>{
   const result=spawnSync(path.join(root,"target/debug/hetu"),["--client","codex","--collaboration-dir",collaboration,"call",action,"--input","-"],{input:JSON.stringify({...input,management_ref:grant}),encoding:"utf8",env:{...process.env,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings")}});
   const receipt=JSON.parse(result.stdout);expect(receipt.status,receipt.error?.message).toBe("succeeded");return receipt.data;
  };
  const input={work_ref:work,title:"灯塔考据",category:"research",body:"旧稿：灯塔亮起。",tags:["灯塔"],project_id:null,entity_refs:[],source_notes:"固定原始资料",operation_key:"resource"};
  const original=cli("hetu.resources.create",input);
  await page.evaluate(async()=>{const api=window.hetuDesktop,p=await api.settings("preferences");await api.settings("update",{expected_revision:p.revision,patch:{execution_mode:"confirm"}});});
  const summary="准备本次固定资料变更，并保留作品身份、原始来源与旧修订。".repeat(8);
  const create=cli("hetu.agent_operations.prepare",{action:"hetu.resources.create",input:{...input,title:"雨夜资料",body:"新资料：钟声三下，来信抵达。",operation_key:"create-planned"},summary,operation_key:"create-plan"});
  const update=cli("hetu.agent_operations.prepare",{action:"hetu.resources.update",input:{...input,resource_id:original.resource.resource_id,expected:{revision:original.resource.revision,sha256:original.sha256},body:"新稿：灯塔回应钟声三下。",operation_key:"update-planned"},summary,operation_key:"update-plan"});
  await navigate(page,"管理方案");await page.getByRole("combobox",{name:"当前管理方案",exact:true}).selectOption(create.proposal_id);
  await expect(page.getByRole("heading",{name:"新建资料「雨夜资料」",exact:true})).toBeVisible();
  const preview=page.getByRole("region",{name:"资料变更预览",exact:true});await expect(preview).toContainText("新资料：钟声三下，来信抵达。");
  await page.getByRole("button",{name:"批准此方案",exact:true}).click();
  const decision=page.getByRole("region",{name:"管理方案决定预览",exact:true});
  await expect(decision.getByRole("heading")).toHaveText("批准新建资料「雨夜资料」");
  const fits=()=>decision.getByRole("button").evaluateAll(elements=>elements.every(element=>element.scrollWidth<=element.clientWidth+1));
  expect(await fits()).toBe(true);
  await mkdir(path.join(root,"output/codex-creation-validation"),{recursive:true});
  await page.screenshot({path:path.join(root,"output/codex-creation-validation/resource-plan-light.png")});
  await page.getByRole("button",{name:"返回审阅",exact:true}).click();
  await page.getByRole("combobox",{name:"当前管理方案",exact:true}).selectOption(update.proposal_id);
  await expect(preview).toContainText("旧稿：灯塔亮起。");await expect(preview).toContainText("新稿：灯塔回应钟声三下。");
  await page.evaluate(async()=>{const api=window.hetuDesktop,p=await api.settings("preferences");await api.settings("update",{expected_revision:p.revision,patch:{appearance:"dark"}});});
  await page.setViewportSize({width:700,height:800});
  await page.getByRole("button",{name:"批准此方案",exact:true}).click();await expect(decision).toBeVisible();await expect(decision.getByRole("button")).toHaveCount(2);expect(await fits()).toBe(true);
  await page.screenshot({path:path.join(root,"output/codex-creation-validation/resource-plan-dark-narrow.png")});
  expect(cli("hetu.resources.get",{resource_id:original.resource.resource_id}).resource.body).toBe(input.body);
  expect(cli("hetu.resources.list",{work_ref:work}).resources).toHaveLength(1);
 }finally{await app.close();}
});
