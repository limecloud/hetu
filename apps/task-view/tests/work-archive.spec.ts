import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {fixtureBinary,machineBinary} from "../../desktop/tests/acceptance-paths.ts";
import {openWorkbenchHost,type WorkbenchSurface} from "./workbench-host.ts";
import {navigate} from "../../desktop/tests/navigation.ts";

for(const surface of ["desktop","stdio","codex"] as WorkbenchSurface[])test(`${surface} 创作库右键归档与恢复三类作品，取消零写且同根资料保持`,async({page},info)=>{
  test.skip(surface==="codex"&&!process.env.HETU_ACCEPT_CODEX_BINARY,"需指定官方Codex CLI");
  test.skip(surface!=="desktop"&&process.platform==="win32","独立MCP原生确认需要Windows实机验收，不运行POSIX启动器");
  test.setTimeout(120000);
  const folder=await mkdtemp(path.join(tmpdir(),"hetu-archive-surfaces-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
  const fixture=spawnSync(fixtureBinary("baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});
  expect(fixture.status,fixture.error?.message??fixture.stderr).toBe(0);const refs=JSON.parse(fixture.stdout);
  await mkdir(profile);
  await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.novel.workspace_id,works:["novel","drama","video"].map(kind=>({work_ref:refs[kind],title:{novel:"默认小说",drama:"默认剧本",video:"默认视频"}[kind]}))}]}));
  const choice=path.join(folder,"choice.json"),dialogFixture=path.join(folder,"archive-decision.cjs"),calls=path.join(folder,"dialogs.jsonl");
  await writeFile(choice,"false");
  const detail="作品正文、历史、任务和关联资料会保留；此操作可从创作库的已归档状态恢复。";
  await writeFile(dialogFixture,`#!${process.execPath}
const fs=require("node:fs");let text="";
process.stdin.on("data",bytes=>text+=bytes);
process.stdin.on("end",()=>{
  const {kind,options}=JSON.parse(text);
  const valid=kind==="confirm"&&options?.detail===${JSON.stringify(detail)}&&["默认小说","默认剧本","默认视频"].some(title=>options.message==="将「"+title+"」移入废纸篓？"||options.message==="恢复「"+title+"」？")&&["移入废纸篓","恢复作品"].includes(options.accept);
  if(!valid){process.stdout.write(JSON.stringify({ok:false,message:"非预期归档确认"}));return;}
  fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(options)+"\\n");
  process.stdout.write(JSON.stringify({ok:true,value:JSON.parse(fs.readFileSync(${JSON.stringify(choice)},"utf8"))}));
});
`,{mode:0o700});
  const environment={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_NODE:process.execPath,HETU_DESKTOP_EXECUTABLE:dialogFixture};
  const core=await AppServer.open(machineBinary("hetu-app-server"),workspace);
  const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;};
  const read=(work_ref:any)=>call("hetu.works.get",{work_ref});
  const host=await openWorkbenchHost(surface,page,environment);page=host.page;const {view,app}=host;
  const decide=async(accepted:boolean)=>{
    await writeFile(choice,JSON.stringify(accepted));
    if(app)await app.evaluate(({dialog},{accepted,detail})=>{dialog.showMessageBox=async(...args:any[])=>{
      const options=args.find(value=>value&&typeof value.message==="string");
      if(options?.detail!==detail||!["移入废纸篓","恢复作品"].includes(options.buttons?.[1]))throw Error("非预期归档确认");
      return {response:accepted?1:0,checkboxChecked:false};
    };},{accepted,detail});
  };
  try {
    await page.setViewportSize({width:1200,height:850});
    const filter=view.getByRole("combobox",{name:"创作状态筛选",exact:true});
    const document=await call("hetu.documents.get",{document_id:refs.document.document.document_id});
    for(const [kind,title] of [["novel","默认小说"],["drama","默认剧本"],["video","默认视频"]] as const){
      const work=refs[kind],before=await read(work),siblings=await Promise.all(["novel","drama","video"].filter(value=>value!==kind).map(value=>read(refs[value])));
      const card=view.getByRole("button",{name:"打开作品 "+title,exact:true});
      await expect(card).toBeVisible();
      await decide(false);await card.click({button:"right"});await view.getByRole("menuitem",{name:"移入废纸篓",exact:true}).click();
      await expect(card).toBeEnabled();await expect(view.getByRole("menu")).toHaveCount(0);
      expect(await read(work)).toEqual(before);
      await decide(true);await card.click({button:"right"});await view.getByRole("menuitem",{name:"移入废纸篓",exact:true}).click();
      await expect.poll(async()=>(await read(work)).summary.archived).toBe(true);
      await filter.selectOption("archived");await expect(card).toBeVisible();
      await card.click({button:"right"});await view.getByRole("menuitem",{name:"从废纸篓恢复",exact:true}).click();await expect(card).toHaveCount(0);
      expect((await read(work)).summary.archived).toBe(false);
      expect(await Promise.all(["novel","drama","video"].filter(value=>value!==kind).map(value=>read(refs[value])))).toEqual(siblings);
      await filter.selectOption("all");await expect(card).toBeVisible();
      // 打开恢复的原作品，继续使用原工作区，不能只核对列表缓存。
      await card.click();await expect(view.locator(".work-profile")).toBeVisible();
      const state=await view.locator("#root").evaluate(()=>window.hetuDesktop.state());expect(state.work).toEqual(work);
      await navigate(view,"返回创作库");await expect(filter).toBeVisible();
    }
    expect(await call("hetu.documents.get",{document_id:document.document.document_id})).toEqual(document);
    if(!app)expect((await readFile(calls,"utf8")).trim().split("\n")).toHaveLength(9);
    await page.screenshot({path:info.outputPath("library-restored.png")});
    await writeFile(info.outputPath("result.json"),JSON.stringify({surface,kinds:["novel","drama","video"],cancel_zero_write:true,same_root_siblings_preserved:true,formal_document_unchanged:true,restored_work_opened:true,model_turns:0},null,2));
  } finally {try{await host.close("app");}finally{await core.close();}}
});
