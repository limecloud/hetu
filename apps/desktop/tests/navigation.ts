import { expect, type Page, type FrameLocator, type ElectronApplication } from "@playwright/test";
import {execFile} from "node:child_process";

export async function createTerminal(page:Page){
  const dialog=page.getByRole("dialog",{name:"创建会话",exact:true});await expect(dialog).toBeVisible();
  await dialog.getByRole("button",{name:"创建",exact:true}).click();await expect(dialog).toHaveCount(0,{timeout:45000});
}
export async function switchAgentSurface(page:Page,surface:"gui"|"tui"){
  const menu=page.getByLabel("会话操作",{exact:true});await menu.click();
  await page.getByRole("button",{name:surface==="gui"?"切换到聊天":"切换到终端",exact:true}).click();
  if(await menu.evaluate(element=>(element.closest("details") as HTMLDetailsElement).open))await menu.click();
}

/** 资料专项只检查真实固定请求；引擎与导航由会话E2E及真实TUI专项验证。 */
export async function captureAgentDraft(application: ElectronApplication, page: Page) {
  await application.evaluate(({ipcMain}) => {
    const handlers=(ipcMain as any)._invokeHandlers, original=handlers.get("desktop:agent-session");
    handlers.set("desktop:agent-session", (event: unknown, method: string, input: any) => {
      if(method==="insert") {(globalThis as any).__capturedAgentDraft=input;return;}
      return original(event,method,input);
    });
  });
  await page.evaluate(() => { const dispatch=window.dispatchEvent.bind(window);window.dispatchEvent=event=>event.type==="hetu:agent-open" || dispatch(event); });
  return () => application.evaluate(() => (globalThis as any).__capturedAgentDraft?.text as string | undefined);
}

/** 仅记录生命周期与句柄类型，不记录环境、正文、请求或进程参数。 */
export async function observeApplicationShutdown(application:ElectronApplication,file:string){
  await application.evaluate(({app,BrowserWindow},file)=>{
    const fs=process.getBuiltinModule("node:fs");
    const record=(event:string)=>fs.appendFileSync(file,JSON.stringify({event,at:Date.now(),pid:process.pid,windows:BrowserWindow.getAllWindows().length,active_handles:(process as any)._getActiveHandles().map((handle:any)=>({type:handle.constructor?.name??"unknown",...(handle.constructor?.name==="ChildProcess"?{pid:handle.pid,exit_code:handle.exitCode,signal:handle.signalCode,killed:handle.killed}: {})}))})+"\n");
    record("observing");
    let timer:ReturnType<typeof setInterval>|undefined;
    app.once("before-quit",()=>{timer=setInterval(()=>record("shutdown-pending"),1000);timer.unref();});
    app.on("before-quit",()=>record("before-quit"));app.on("will-quit",()=>record("will-quit"));app.on("quit",()=>record("quit"));app.on("window-all-closed",()=>record("window-all-closed"));
    for(const window of BrowserWindow.getAllWindows())window.once("closed",()=>record("window-closed"));
  },file);
}

/** 走作者关闭窗口的路径，保留恢复稿落盘期间的调试连接。 */
export async function closeApplication(application: ElectronApplication, via: "window" | "app" = "app") {
  const child = application.process();
  const exitCode = () => child.exitCode;
  if (exitCode() !== null) {expect(exitCode()).toBe(0); return;}
  await application.evaluate(({dialog})=>{
    const original=dialog.showMessageBoxSync;
    // 隔离验收关闭时明确选择保留恢复稿；其他作者决定继续走原确认。
    dialog.showMessageBoxSync=((...args:any[])=>args.some(value=>value?.message==="修改尚未保存到作品。")?1:(original as any)(...args)) as typeof original;
  }).catch(async error=>{
    // 正常关窗可能先断开调试连接，再派发子进程exit；仍须核对真实退出码。
    if(!String(error).includes("Target page, context or browser has been closed"))throw error;
    await expect.poll(()=>child.exitCode,{timeout:30000}).toBe(0);
  });
  if(exitCode()!==null){expect(exitCode()).toBe(0);return;}
  let requestError:unknown;
  let nativeState:unknown;
  if(process.env.HETU_TEST_NATIVE_CLOSE==="1"){
    if(process.platform!=="darwin"||!Number.isSafeInteger(child.pid)||child.pid!<2)throw Error("原生窗口关闭专项需要macOS及确切的隔离应用PID。");
    const title=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>!window.webContents.getURL().includes("?view=settings"))?.getTitle());
    nativeState={via,pid:child.pid,main_window:title};
    // 本机调试器可能妨碍退出；先断开，再向确切PID请求正常退出或关闭主窗口。
    await application.evaluate(()=>{setImmediate(()=>process.getBuiltinModule("node:inspector").close());}).catch(error=>{if(!String(error).includes("closed"))throw error;});
    const script=via==="app"?`ObjC.import("AppKit");
function run(argv){
const target=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
if(target.isNil())throw Error("隔离应用已不在运行。");
if(!target.terminate)throw Error("隔离应用拒绝正常退出请求。");
}`:`on run argv
tell application "System Events" to tell (first application process whose unix id is (item 1 of argv as integer))
repeat 100 times
if exists window (item 2 of argv) then exit repeat
delay 0.1
end repeat
perform action "AXPress" of (first button of window (item 2 of argv) whose subrole is "AXCloseButton")
end tell
end run`;
    if(via==="window"&&!title)throw Error("找不到隔离应用主窗口，未关闭其他窗口。");
    await new Promise<void>((resolve,reject)=>execFile("osascript",[...(via==="app"?["-l","JavaScript"]:[]),"-e",script,String(child.pid),...(via==="window"?[title!]:[])],{timeout:15000},error=>error?reject(error):resolve())).catch(error=>{requestError=error;});
  }else{
  await application.evaluate(({BrowserWindow,app},via) => {
    const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("?view=settings"));
    // will-quit在恢复稿与引擎清理完成后触发；此后不保证再运行setImmediate。
    app.once("will-quit",()=>process.getBuiltinModule("node:inspector").close());
    if(via==="app")app.quit();else window?.close();
  },via).catch(error => {requestError=error;});
  }
  try {await expect.poll(() => child.exitCode, {timeout: 30000}).toBe(0);}
  catch (error) {
    const state = nativeState??await application.evaluate(({BrowserWindow, app}) => ({ready: app.isReady(), windows: BrowserWindow.getAllWindows().map(window => ({url: window.webContents.getURL(), visible: window.isVisible(), modal: window.isModal(), destroyed: window.isDestroyed()}))})).catch(() => ({disconnected: true}));
    throw new Error(`${(error as Error).message}\n关闭状态：${JSON.stringify({state,pid:child.pid,exit_code:child.exitCode,signal:child.signalCode,killed:child.killed,...(requestError?{request_error:(requestError as Error).message}:{})})}`);
  }
}

/** 设置使用独立窗口，重复打开复用同一窗口。 */
export async function openSettings(application: ElectronApplication, page: Page) {
  let trigger=page.getByRole("button",{name:"本机设置",exact:true}).first();
  const menu=page.getByLabel("会话操作",{exact:true});
  await expect.poll(async()=>await trigger.isVisible()||await menu.isVisible(),{timeout:30000}).toBe(true);
  if(!await trigger.isVisible()){await menu.click();trigger=page.getByRole("button",{name:"本机设置",exact:true}).first();}
  await trigger.click();
  await expect.poll(() => application.windows().some(window => window.url().endsWith("?view=settings"))).toBe(true);
  const settings = application.windows().find(window => window.url().endsWith("?view=settings"))!;
  await expect(settings.getByRole("region", { name: "本机设置", exact: true })).toBeVisible();
  return settings;
}

/** Escape可能先销毁窗口，再返回键盘回执；仍须确认实际关闭。 */
export async function closeSettings(page: Page) {
  await page.keyboard.press("Escape").catch(error => {
    if (!page.isClosed()) throw error;
  });
  await expect.poll(() => page.isClosed(), { timeout: 30000 }).toBe(true);
}

/** 窄窗口会自动收起目录，沿作者可见的入口重新打开。 */
export async function openDirectory(page: Page) {
  await expect(page.locator("main:not([hidden])")).not.toHaveAttribute("aria-busy", "true");
  let toggle = page.getByRole("button", { name: /^(卷章目录|分集目录)$/ });
  // 作品入口固定先到资料页；正文目录必须由项目导航明确进入对应工作面。
  if (!(await toggle.isVisible())) {
    const navigation = page.getByRole("complementary", { name: "项目导航", exact: true });
    const projectLayer = navigation.getByRole("button", { name: "显示项目导航", exact: true });
    if (await projectLayer.isVisible()) await projectLayer.click();
    const reader = page.getByRole("button", { name: /^(小说|剧本|视频)$/ }).first();
    if (await reader.isVisible()) await reader.click();
    toggle = page.getByRole("button", { name: /^(卷章目录|分集目录)$/ });
  }
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await expect(page.getByRole("navigation", { name: "文稿目录", exact: true })).toBeVisible();
}

/** 沿作者可见的创作库或项目导航展开分组。 */
export async function navigate(page: Page | FrameLocator, label: string) {
  await expect(page.locator("main:not([hidden])")).not.toHaveAttribute("aria-busy", "true");
  const back = page.getByRole("button", { name: "返回工作台", exact: true });
  if (await back.isVisible()) {
    await back.click();
    await expect(back).toHaveCount(0);
  }
  const navigation = page.getByRole("complementary", { name: /^(创作库导航|项目导航)$/ });
  await expect(navigation).toBeVisible();
  const projectLayer = navigation.getByRole("button", {name: "显示项目导航", exact: true});
  const options = { name: label, exact: true, includeHidden: true };
  const scope = page.locator('.project-navigation .sidebar-project, .project-navigation[aria-label="创作库导航"]');
  const button = scope.getByRole("button", options);
  await expect(button).toBeAttached();
  if (await projectLayer.count()) {
    await projectLayer.click();
    await expect(navigation.locator(".sidebar-project")).toBeVisible();
  }
  await expect(button).toBeEnabled();
  const group = navigation.locator("details.navigation-group").filter({ has: page.getByRole("button", options) });
  if (await group.count() && !(await group.evaluate((element) => (element as HTMLDetailsElement).open)))
    await group.locator(":scope > summary").click();
  await button.click();
  await expect(page.locator("main:not([hidden])")).not.toHaveAttribute("aria-busy", "true");
  if (label === "Agent 协作") await expect(page.getByRole("main", {name: "终端工作区", exact: true})).toBeVisible();
  else await expect(page.locator(".layout > main:not([hidden])")).toBeVisible();
}

export async function documentAction(page: Page, label: string) {
  const menu = page.locator("details").filter({ has: page.locator('summary[aria-label="文稿操作"]') });
  if (!(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await menu.locator("summary").click();
  await menu.getByRole("button", { name: label, exact: true }).click();
}

/** 专业工作面按当前作品呈现在资料页，插件管理页只负责生命周期。 */
export async function openCreativePlugin(page: Page, title: string) {
  await navigate(page, "作品资料");
  const group = page.locator("details.profile-plugins");
  await expect(group).toBeVisible();
  if (!await group.evaluate(element => (element as HTMLDetailsElement).open))
    await group.locator(":scope > summary").click();
  await group.getByRole("button", {name: title, exact: true}).click();
}
