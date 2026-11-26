import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost,type WorkbenchSurface} from "./workbench-host.ts";

for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 长参考稿按固定候选翻页，意见及页内选区保持`,async({page},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");test.setTimeout(150000);
 const root=path.resolve("../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-long-review-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.error?.message??fixture.stderr).toBe(0);const work=JSON.parse(fixture.stdout).novel;
 const core=await AppServer.open(process.env.HETU_PACKAGED_APP?path.resolve(process.env.HETU_PACKAGED_APP,"../../Resources/bin/hetu-app-server"):path.join(root,"target/debug/hetu-app-server"),workspace);
 const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const prepared=await call("hetu.creative_tasks.preview_prompt",{scope_ref:{kind:"workspace",id:work.workspace_id},work_ref:work,task_kind:"chapter_draft",brief:"长参考稿审阅，不修改正式章节。",input_refs:[],client_adapter:"codex",language_tag:"zh-CN"});
 const task=await call("hetu.creative_tasks.prepare",{...prepared.prepare_input,operation_key:"long-task"}),content=Array.from({length:1800},(_,index)=>`第${index+1}段 江岚核对来信🌿，保留旧版线索和结尾。`).join("\r\n\r\n");
 const original=await call("hetu.creative_tasks.submit_result",{task_ref:task.task_ref,request_sha256:task.request_sha256,candidates:[{kind:"text",title:"长参考稿候选",source_format:"markdown",source_ref_indices:[],content}],complete:true,missing_items:[],provenance:{client:"long-review","skill_version":"1"},operation_key:"long-submit"});
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"长参考稿验收"}]}]}));
 const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_PLUGIN_ACCESS_DIR:path.join(folder,"access"),HETU_COLLABORATION_DIR:collaboration,...(!process.env.HETU_PACKAGED_APP?{HETU_PLUGIN_NODE:process.execPath}:{})};
 const host=await openWorkbenchHost(surface,page,env);page=host.page;const view=host.view;
 try{
  await page.setViewportSize({width:1440,height:960});await view.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(view.locator(".work-profile")).toBeVisible();await navigate(view,"参考稿审核");await view.getByRole("combobox",{name:"当前审阅任务",exact:true}).selectOption(task.task_ref.task_id);
  const panel=view.frameLocator('iframe[title="任务候选审阅"]'),candidate=panel.getByRole("region",{name:"候选 长参考稿候选",exact:true}),opinion=panel.getByLabel("补充要求或意见",{exact:true});
  await expect(candidate).toBeVisible({timeout:30000});await candidate.getByRole("button",{name:"读取参考稿",exact:true}).click();await expect(candidate.locator(".reference-content")).toContainText("第1段");await candidate.getByRole("checkbox").check();await opinion.fill("先阅读，不清除我的意见。🌿");
  const next=candidate.getByRole("button",{name:"下一页",exact:true});await candidate.getByRole("button",{name:"继续阅读下一页",exact:true}).focus();await page.keyboard.press("Enter");await expect(candidate.getByRole("group",{name:"参考稿读取范围",exact:true})).toContainText("第2页");await expect(opinion).toHaveValue("先阅读，不清除我的意见。🌿");await expect(candidate.getByRole("checkbox")).toBeChecked();await expect(next).toBeFocused();
  await candidate.getByRole("button",{name:"上一页",exact:true}).click();await expect(candidate.locator(".reference-content")).toContainText("第1段");await expect(opinion).toBeEnabled();await next.click();await expect(candidate.getByRole("group",{name:"参考稿读取范围",exact:true})).toContainText("第2页");await expect(opinion).toBeEnabled();
  await candidate.locator(".reader").evaluate(reader=>{const span=Array.from(reader.querySelectorAll<HTMLElement>("[data-source-from]")).find(span=>span.textContent?.includes("来信🌿"))!,start=span.textContent!.indexOf("来信🌿"),range=document.createRange();range.setStart(span.firstChild!,start);range.setEnd(span.firstChild!,start+"来信🌿".length);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);reader.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));});
  await candidate.getByRole("button",{name:"对此处提意见",exact:true}).click();await panel.getByRole("button",{name:"保存位置意见",exact:true}).click();await expect(panel.locator("#status")).toContainText("修改意见已保存");
  const saved=await call("hetu.task_feedback.list",{task_ref:task.task_ref}),position=saved.feedback[0].feedback.target_refs[0];expect(saved.feedback).toHaveLength(1);expect(position.candidate_ref).toEqual(original.candidate_refs[0]);expect(position.range.byte_start).toBeGreaterThan(0);expect(Buffer.from(content).subarray(position.range.byte_start,position.range.byte_end).toString()).toBe("来信🌿");
  expect(await candidate.evaluate(element=>element.getBoundingClientRect().width>=element.parentElement!.getBoundingClientRect().width*.95)).toBe(true);
  await candidate.evaluate(element=>element.scrollIntoView({block:"start"}));await page.screenshot({path:info.outputPath("long-reference-feedback.png")});
  await page.setViewportSize({width:760,height:900});await view.locator("body").evaluate(async()=>{const current=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:current.revision,patch:{appearance:"dark"}});});await expect(panel.locator("#app")).toHaveCSS("color-scheme","dark");expect(await panel.locator("body").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath("long-reference-dark-narrow.png")});
  await writeFile(info.outputPath("result.json"),JSON.stringify({surface,original_candidate:true,utf8_position:position.range.byte_start,feedback_count:1,selection_and_comment_preserved:true,single_candidate_full_width:true,narrow_no_horizontal_overflow:true,model_turns:0},null,2));
 }finally{await core.close();await host.close("app");}
});
