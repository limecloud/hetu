import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {navigate,closeApplication,openDirectory} from "./navigation.ts";
import {AppServer} from "../src/main/rpc.ts";
const root=path.resolve(import.meta.dirname,"../../..");
async function launch(){
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-first-open-")),workspace=path.join(folder,"work"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
 const fixture=spawnSync(path.join(root,"target/debug/examples/baseline_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);
 const refs=JSON.parse(fixture.stdout);await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.novel.workspace_id,works:[{work_ref:refs.novel,title:"默认小说"}]}]}));
 const executable=process.env.HETU_PACKAGED_APP;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:collaboration,...(!executable?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp"),HETU_PLUGIN_NODE:process.execPath}:{})}});
 const page=await app.firstWindow();await page.setViewportSize({width:1280,height:820});await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();
 await expect(page.getByRole("heading",{name:"作品资料",exact:true})).toBeVisible();return {app,page,refs,workspace};
}
test("首次目录和稿件加载分别显示真实状态，失败可恢复且不闪现空作品",async({},info)=>{
 const {app,page}=await launch();
 try{
  await app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers,read=handlers.get("desktop:read"),state=globalThis as any;
   state.holdDirectory=true;state.holdDocument=true;
   handlers.set("desktop:read",async(event:any,action:string,input:any)=>{
    const result=await read(event,action,input);
    if(action==="hetu.documents.list"&&state.holdDirectory){state.holdDirectory=false;state.directoryHeld=true;await new Promise<void>(resolve=>{state.releaseDirectory=resolve;});if(state.failDirectory)throw Error("隔离目录读取失败");}
    if(action==="hetu.documents.get"){state.documentReads=(state.documentReads??0)+1;if(state.holdDocument){state.holdDocument=false;state.documentHeld=true;await new Promise<void>(resolve=>{state.releaseDocument=resolve;});}}
    return result;
   });
  });
  await navigate(page,"小说");
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).directoryHeld)).toBe(true);
  const surface=page.getByRole("region",{name:"正文工作区",exact:true});
  await expect(surface).toHaveAttribute("aria-busy","true");await expect(surface.getByRole("status")).toHaveText("正在读取文稿目录…");
  await expect(surface.getByText("从成果开始创作",{exact:true})).toHaveCount(0);await expect(page.locator(".directory-footer")).toHaveCount(0);
  await page.screenshot({path:info.outputPath("directory-loading.png")});
  await app.evaluate(()=>{const state=globalThis as any;state.failDirectory=true;state.releaseDirectory();});
  await expect(surface.getByRole("alert")).toContainText("隔离目录读取失败");await expect(page.getByRole("navigation",{name:"文稿目录",exact:true})).toHaveAttribute("aria-busy","false");
  // 首稿已独立开始读取；目录失败不把仍在途的稿件标为就绪。
  await expect(surface).toHaveAttribute("aria-busy","true");await expect(surface.getByText("从成果开始创作",{exact:true})).toHaveCount(0);
  await surface.getByRole("button",{name:"重新读取目录",exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).documentHeld)).toBe(true);
  await expect(surface.getByRole("status")).toHaveText("正在读取稿件…");await expect(surface).toHaveAttribute("aria-busy","true");
  await expect(surface.getByText("从成果开始创作",{exact:true})).toHaveCount(0);
  await app.evaluate(()=>(globalThis as any).releaseDocument());
  await expect(surface.getByRole("textbox",{name:"文稿编辑",exact:true})).toContainText("灯塔在黎明前亮起");await expect(surface).toHaveAttribute("aria-busy","false");
  expect(await app.evaluate(()=>(globalThis as any).documentReads)).toBe(1);
  await expect(page.locator(".directory-footer")).toHaveText("1 章");await page.screenshot({path:info.outputPath("first-document-ready.png")});
 }finally{await app.evaluate(()=>{(globalThis as any).releaseDirectory?.();(globalThis as any).releaseDocument?.();}).catch(()=>{});await closeApplication(app);}
});
test("离开首页后停止旧目录分页，正文完整读取并保留原稿",async({},info)=>{
 test.setTimeout(120000);
 const {app,page,workspace}=await launch();
 try{
  const core=await AppServer.open(process.env.HETU_PACKAGED_APP?path.resolve(process.env.HETU_PACKAGED_APP,"../../Resources/bin/hetu-app-server"):path.join(root,"target/debug/hetu-app-server"),workspace);
  try{for(let number=2;number<=105;number++){
   const result=await core.request("workspace/request",{action:"hetu.documents.create",contract_revision:"1",input:{kind:"novel_chapter",title:`目录分页第${number}章`,source_format:"markdown",content:`第${number}封海港来信。`,operation_key:`directory-cancel-${number}`}});
   expect(result.status,JSON.stringify(result)).toBe("succeeded");
  }}finally{await core.close();}
  await app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:read"),state=globalThis as any;state.directoryRequests=[];
   handlers.set("desktop:read",async(...args:any[])=>{
    if(args[1]!=="hetu.documents.list")return original(...args);
    state.directoryRequests.push(args[2].cursor??null);const value=await original(...args);
    if(state.directoryRequests.length===1)await new Promise<void>(resolve=>{state.releaseOldDirectory=resolve;});
    return value;
   });
  });
  await navigate(page,"返回创作库");await page.getByRole("button",{name:"打开作品 默认小说",exact:true}).click();await expect(page.getByRole("button",{name:"打开章节目录",exact:true})).toBeEnabled();
  await expect.poll(()=>app.evaluate(()=>typeof(globalThis as any).releaseOldDirectory)).toBe("function");
  await page.getByRole("button",{name:"打开章节目录",exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).directoryRequests.length)).toBeGreaterThanOrEqual(2);
  await app.evaluate(()=>(globalThis as any).releaseOldDirectory());
  await openDirectory(page);const directory=page.getByRole("navigation",{name:"文稿目录",exact:true});await expect(directory).toHaveAttribute("aria-busy","false");
  await expect(directory.locator(".chapter-group button")).toHaveCount(105);
  await expect(page.getByRole("textbox",{name:"文稿编辑",exact:true})).toContainText("灯塔在黎明前亮起");
  const cursors=await app.evaluate(()=>(globalThis as any).directoryRequests as (string|null)[]);
  await info.attach("directory-page-counts",{body:JSON.stringify({requests:cursors.length,first_pages:cursors.filter(cursor=>cursor===null).length,continued_pages:cursors.filter(cursor=>cursor!==null).length}),contentType:"application/json"});
  expect(cursors).toHaveLength(3);expect(cursors.filter(cursor=>cursor===null)).toHaveLength(2);
  await page.screenshot({path:info.outputPath("cancelled-old-directory.png")});
 }finally{await app.evaluate(()=>(globalThis as any).releaseOldDirectory?.()).catch(()=>{});await closeApplication(app);}
});
test("完整目录仍在读取时首稿可编辑，目录失败与重试不覆盖未保存稿",async({},info)=>{
 const {app,page,refs}=await launch();
 try{
  const original=await page.evaluate(async id=>(await window.hetuDesktop.read("hetu.documents.get",{document_id:id})).data,refs.document.document.document_id);
  await page.evaluate(async()=>{const preferences=await window.hetuDesktop.settings("preferences");await window.hetuDesktop.settings("update",{expected_revision:preferences.revision,patch:{autosave:false}});});
  await app.evaluate(({ipcMain})=>{
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:read"),state=globalThis as any;let held=false;
   handlers.set("desktop:read",async(...args:any[])=>{const value=await original(...args);if(args[1]==="hetu.documents.list"&&!held){held=true;await new Promise<void>(resolve=>{state.releaseFirstContentDirectory=resolve;});throw Error("隔离验收：完整目录暂不可读。");}return value;});
  });
  await navigate(page,"小说");await expect.poll(()=>app.evaluate(()=>typeof(globalThis as any).releaseFirstContentDirectory)).toBe("function");
  const editor=page.getByRole("textbox",{name:"文稿编辑",exact:true});await expect(editor).toContainText("灯塔在黎明前亮起");
  await expect(page.getByRole("navigation",{name:"文稿目录",exact:true})).toHaveAttribute("aria-busy","true");
  await editor.press(process.platform==="darwin"?"Meta+ArrowDown":"Control+End");await page.keyboard.insertText("目录读取期间保留输入");
  await app.evaluate(()=>(globalThis as any).releaseFirstContentDirectory());
  const directory=page.getByRole("navigation",{name:"文稿目录",exact:true});await expect(directory).toContainText("完整目录暂不可读");await expect(editor).toContainText("目录读取期间保留输入");
  await directory.getByRole("button",{name:"重新读取文稿目录",exact:true}).click();await expect(directory).toHaveAttribute("aria-busy","false");await expect(directory.locator(".chapter-group button")).toHaveCount(1);await expect(editor).toContainText("目录读取期间保留输入");
  const content=await page.evaluate(async id=>(await window.hetuDesktop.read("hetu.documents.get",{document_id:id})).data,refs.document.document.document_id);expect(content.content).toBe(original.content);expect(content.revision.revision_id).toBe(original.revision.revision_id);
  await editor.press("ControlOrMeta+z");await expect(page.locator(".save-state")).not.toContainText("有未保存修改");await page.screenshot({path:info.outputPath("first-content-before-directory.png")});
 }finally{await app.evaluate(()=>(globalThis as any).releaseFirstContentDirectory?.()).catch(()=>{});await closeApplication(app);}
});
test("专业工具长目录的名称说明对齐，查找及管理入口保持可见",async({},info)=>{
 const {app,page,refs}=await launch();
 try{
  // 展示规模使用目录投影；选择仍经过真实capabilities调用，不伪造专业成果。
  await app.evaluate(({ipcMain},work)=>{
   const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("desktop:professional");
   const names=["创作研究台","人物工坊","故事分析","世界书互通","互动叙事","系列组织","译稿工坊","朗读审阅","书稿交付","小说审校","场景规划","分镜检查","对白分析","角色档案","素材整理","版本比较"];
   handlers.set("desktop:professional",async(event:any,method:string,input:any)=>method==="catalog"?{work_ref:work,plugins:names.map((name,index)=>({id:"org.hetu.layout-"+index,package_sha256:"a".repeat(64),state:index===14?"disabled":"active",version:"1.0.0",supported:true,display:{"zh-CN":name},description:{"zh-CN":"围绕固定原文整理可核对的专业成果，保留来源、作者意见及修订，支持后续创作与检查。".repeat(index%3+1)}}))}:original(event,method,input));
  },refs.novel);
  await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"专业工具",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"专业工具",exact:true}),list=dialog.getByLabel("专业工具目录",{exact:true}),search=dialog.getByRole("searchbox",{name:"查找专业工具",exact:true}),manage=dialog.getByRole("button",{name:"管理创作插件",exact:true});
  await expect(list.getByRole("button")).toHaveCount(16);
  await page.screenshot({path:info.outputPath("tools-first-screen.png")});
  for(const [width,appearance] of [[1280,"light"],[800,"dark"],[520,"light"]] as const){
   await page.setViewportSize({width,height:760});await page.emulateMedia({colorScheme:appearance});
   const geometry=await list.evaluate(element=>{const rows=[...element.querySelectorAll("button")];return {heights:rows.map(row=>row.getBoundingClientRect().height),lefts:rows.map(row=>row.querySelector("strong")!.getBoundingClientRect().left),clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,overflow:getComputedStyle(element).overflowY,copy:[...element.querySelectorAll(".professional-tool-copy > span")].map(copy=>({whiteSpace:getComputedStyle(copy).whiteSpace,overflow:getComputedStyle(copy).textOverflow}))};});
   expect(new Set(geometry.heights).size).toBe(1);expect(new Set(geometry.lefts).size).toBe(1);expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);expect(geometry.overflow).toBe("auto");expect(geometry.copy.every(item=>item.whiteSpace==="nowrap"&&item.overflow==="ellipsis")).toBe(true);
   await list.evaluate(element=>{element.scrollTop=element.scrollHeight;});await expect(search).toBeInViewport();await expect(manage).toBeInViewport();await expect(dialog.getByRole("button",{name:"关闭上下文选择",exact:true})).toBeInViewport();
   expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
   await page.screenshot({path:info.outputPath(`tools-${width}-${appearance}.png`)});
  }
  await search.fill("人物");await expect(list.getByRole("button")).toHaveCount(1);await expect(list.getByRole("button",{name:"人物工坊",exact:true})).toBeVisible();await search.fill("找不到的工具");await expect(dialog).toContainText("没有匹配的工具。");
  await search.fill("");await dialog.getByRole("button",{name:"关闭上下文选择",exact:true}).focus();await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);
 }finally{await closeApplication(app);}
});
