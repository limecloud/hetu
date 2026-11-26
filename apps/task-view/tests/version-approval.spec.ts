import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost,type WorkbenchSurface} from "./workbench-host.ts";

for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 文稿版本批准绑定资料目录，另一资料只读不继承，关窗后原键执行与恢复`,async({page,browser},info)=>{
 test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");
 test.setTimeout(180000);
 const root=path.resolve(import.meta.dirname,"../../.."),folder=await mkdtemp(path.join(tmpdir(),"hetu-version-approval-"));
 const workspace=path.join(folder,"work"),collaboration=path.join(folder,"collaboration"),profile=path.join(folder,"profile"),otherProfile=path.join(folder,"other-profile");
 const suffix=process.platform==="win32"?".exe":"",fixtures=process.env.HETU_ACCEPT_FIXTURE_DIRECTORY??path.join(root,"target/debug/examples");
 const seeded=spawnSync(path.join(fixtures,"baseline_fixture"+suffix),[workspace,collaboration],{encoding:"utf8"});
 expect(seeded.status,seeded.error?.message??seeded.stderr).toBe(0);const work=JSON.parse(seeded.stdout).novel;
 const bin=process.env.HETU_ACCEPT_MCP_BINARY?path.dirname(process.env.HETU_ACCEPT_MCP_BINARY):process.env.HETU_PACKAGED_APP?path.resolve(process.env.HETU_PACKAGED_APP,"../../Resources/bin"):path.join(root,"target/debug");
 const core=await AppServer.open(path.join(bin,"hetu-app-server"+suffix),workspace,path.join(profile,"git-authorizations"));
 const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,contract_revision:"1",input});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
 const cli=(action:string,input:any)=>{
  const value=spawnSync(path.join(bin,"hetu"+suffix),["--client","codex","--collaboration-dir",collaboration,"call",action,"--input","-"],{input:JSON.stringify(input),encoding:"utf8",env:{...process.env,HETU_COLLABORATION_DIR:collaboration,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile}});
  const pending=action==="hetu.git.snapshot"&&input.phase==="prepare";
  expect(value.status,value.stdout+value.stderr).toBe(pending?5:0);const result=JSON.parse(value.stdout);expect(result.status,JSON.stringify(result)).toBe(pending?"pending":"succeeded");return result.data;
 };
 const envFor=(directory:string)=>({...process.env,HETU_DESKTOP_PROFILE:directory,HETU_LOCAL_SETTINGS_DIR:path.join(directory,"local-settings"),HETU_PLUGIN_STATE_DIR:directory,HETU_PLUGIN_ACCESS_DIR:path.join(directory,"access"),HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_NODE:process.execPath,HETU_APP_SERVER:path.join(bin,"hetu-app-server"+suffix),HETU_CLI:path.join(bin,"hetu"+suffix),HETU_MCP:path.join(bin,"hetu-mcp"+suffix)});
 let host:Awaited<ReturnType<typeof openWorkbenchHost>>|undefined,other:typeof host,shared:typeof host;
 const otherPage=await browser.newPage(),sharedPage=await browser.newPage();
 try{
  for(const directory of [profile,otherProfile]){await mkdir(directory,{recursive:true});await writeFile(path.join(directory,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"默认小说"}]}]}));}
  const doc=(await call("hetu.documents.list",{work_ref:work})).documents[0],before=await call("hetu.documents.get",{document_id:doc.document_id});
  await call("hetu.git.init",{work_ref:work,branch:"main",operation_key:"version-init"});
  host=await openWorkbenchHost(surface,page,envFor(profile));page=host.page;let view=host.view;
  await view.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(view.locator(".work-profile")).toBeVisible();
  const grant=(await view.locator("#root").evaluate(()=>window.hetuDesktop.connection("authorize","codex"))).management_ref;
  expect((await view.locator("#root").evaluate(()=>window.hetuDesktop.connection("status","codex"))).git_authorization_current).toBe(true);
  const head=cli("hetu.git.status",{management_ref:grant,work_ref:work}).head;
  const prepared=cli("hetu.git.snapshot",{management_ref:grant,work_ref:work,phase:"prepare",expected_head:head,message:"渡口创作节点",author:{name:"验收作者",email:"author@hetu.test"},operation_key:"prepare-version"});
  const id=prepared.snapshot.snapshot_id;
  expect(JSON.stringify(prepared)).not.toContain(profile);
  await navigate(view,"文稿版本");await view.getByRole("button",{name:"渡口创作节点",exact:true}).click();
  await view.getByRole("button",{name:"审阅完整快照差异",exact:true}).click();
  for(const paragraph of before.content.split(/\r?\n/).filter(Boolean))await expect(view.getByRole("region",{name:"版本批准预览",exact:true})).toContainText(paragraph);
  await view.getByRole("button",{name:"确认批准此快照",exact:true}).click();await expect(view.getByRole("region",{name:"固定文稿快照",exact:true})).toContainText("等待 Agent 执行");
  const approvalFile=path.join(profile,"git-authorizations",prepared.snapshot.repository_instance,id+".json"),approvalBytes=await readFile(approvalFile);
  expect(cli("hetu.git.get_snapshot",{management_ref:grant,work_ref:work,snapshot_id:id}).approval_state).toBe("approved");
  expect(cli("hetu.git.status",{management_ref:grant,work_ref:work}).head.commit_id).toBeNull();

  shared=await openWorkbenchHost(surface==="desktop"?"stdio":"desktop",sharedPage,envFor(profile));
  await shared.view.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(shared.view.locator(".work-profile")).toBeVisible();
  await navigate(shared.view,"文稿版本");await shared.view.getByRole("button",{name:"渡口创作节点",exact:true}).click();
  await expect(shared.view.getByRole("region",{name:"固定文稿快照",exact:true})).toContainText("等待 Agent 执行");
  const sameProfile=await shared.view.locator("#root").evaluate(()=>window.hetuDesktop.connection("status","codex"));
  expect(sameProfile.management_ref).toEqual(grant);expect(sameProfile.git_authorization_current).toBe(true);
  await shared.close("app");shared=undefined;

  other=await openWorkbenchHost(surface,otherPage,envFor(otherProfile));const otherView=other.view;
  await otherView.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(otherView.locator(".work-profile")).toBeVisible();
  const previous=await otherView.locator("#root").evaluate(()=>window.hetuDesktop.connection("status","codex"));
  expect(previous.authorized).toBe(true);expect(previous.git_authorization_current).toBe(false);
  await navigate(otherView,"文稿版本");await otherView.getByRole("button",{name:"渡口创作节点",exact:true}).click();
  await expect(otherView.getByRole("region",{name:"固定文稿快照",exact:true})).toContainText("等待作者审阅");
  expect((await otherView.locator("#root").evaluate(()=>window.hetuDesktop.connection("status","codex"))).management_ref).toEqual(grant);
  expect((await readdir(path.join(otherProfile,"git-authorizations"),{recursive:true}).catch(()=>[])).some(name=>name.endsWith(id+".json"))).toBe(false);
  expect(await readFile(approvalFile)).toEqual(approvalBytes);
  await other.close("app");other=undefined;
  await host.close("app");host=undefined;

  const journalDirectory=path.join(profile,"version-decisions"),journalFile=path.join(journalDirectory,(await readdir(journalDirectory))[0]);
  const journal=JSON.parse(await readFile(journalFile,"utf8"));
  // 仅注入宿主恢复记录未确认的边界；不改Core批准文件或伪造业务成功。
  await writeFile(journalFile,JSON.stringify({...journal,status:"pending"}));
  const command={management_ref:grant,work_ref:work,phase:"execute",snapshot_id:id,operation_key:"execute-version"};
  const saved=cli("hetu.git.snapshot",command);expect(cli("hetu.git.snapshot",command)).toEqual(saved);
  host=await openWorkbenchHost(surface,page,envFor(profile));page=host.page;view=host.view;
  await view.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(view.locator(".work-profile")).toBeVisible();await navigate(view,"文稿版本");
  await view.getByRole("button",{name:"恢复原版本批准",exact:true}).click();await expect(view.getByRole("button",{name:"已阅批准结果",exact:true})).toBeVisible();
  await view.getByRole("region",{name:"文稿版本历史",exact:true}).getByRole("button",{name:"渡口创作节点",exact:true}).click();
  const files=await view.locator("#root").evaluate((_root,commit)=>window.hetuDesktop.versions("version",{commit_id:commit}),saved.commit_id);
  const body=files.files.find((item:any)=>item.path===before.revision.content_path);expect(body).toBeTruthy();
  const historical=cli("hetu.git.read_version",{management_ref:grant,work_ref:work,commit_id:saved.commit_id,path:body.path});expect(historical.content).toBe(before.content);
  expect((await call("hetu.documents.get",{document_id:doc.document_id})).revision).toEqual(before.revision);
  expect(await readFile(approvalFile)).toEqual(approvalBytes);
  await page.screenshot({path:info.outputPath("version-private-approval.png")});
  await writeFile(info.outputPath("result.json"),JSON.stringify({surface,private_approval_verified:true,same_profile_cross_surface_shared:true,other_profile_not_inherited:true,read_only_does_not_rebind:true,window_closed_before_execution:true,original_execution_key_preserved:true,original_approval_unchanged:true,formal_revision_unchanged:true,model_turns:0})+"\n");
 }finally{await shared?.close("app");await other?.close("app");await host?.close("app");await sharedPage.close();await otherPage.close();await core.close();}
});
