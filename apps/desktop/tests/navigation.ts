import { expect, type Page, type FrameLocator, type ElectronApplication } from "@playwright/test";

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

/** 走作者关闭窗口的路径，保留恢复稿落盘期间的调试连接。 */
export async function closeApplication(application: ElectronApplication, via: "window" | "app" = "app") {
  const child = application.process();
  if (child.exitCode !== null) {expect(child.exitCode).toBe(0); return;}
  if (via === "app") {
    // 官方关闭路径在quit被恢复稿落盘暂缓后释放调试连接，再等待真实进程退出。
    await application.close(); expect(child.exitCode).toBe(0); return;
  }
  await application.evaluate(({BrowserWindow}) => {
    const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("?view=settings"));
    // closed在恢复稿落盘后触发；随后释放Node调试器，不改变应用退出路径。
    window?.once("closed", () => setImmediate(() => process.getBuiltinModule("node:inspector").close()));
    window?.close();
  }).catch(error => {if (child.exitCode !== 0) throw error;});
  try {await expect.poll(() => child.exitCode, {timeout: 30000}).toBe(0);}
  catch (error) {
    const state = await application.evaluate(({BrowserWindow, app}) => ({ready: app.isReady(), windows: BrowserWindow.getAllWindows().map(window => ({url: window.webContents.getURL(), visible: window.isVisible(), modal: window.isModal(), destroyed: window.isDestroyed()}))})).catch(() => ({disconnected: true}));
    throw new Error(`${(error as Error).message}\n关闭状态：${JSON.stringify(state)}`);
  }
}

/** 设置使用独立窗口，重复打开复用同一窗口。 */
export async function openSettings(application: ElectronApplication, page: Page) {
  let trigger=page.getByRole("button",{name:"本机设置",exact:true}).first();
  if(!await trigger.isVisible()){await page.getByLabel("会话操作",{exact:true}).click();trigger=page.getByRole("button",{name:"本机设置",exact:true}).first();}
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
}

export async function documentAction(page: Page, label: string) {
  const menu = page.locator("details").filter({ has: page.locator('summary[aria-label="文稿操作"]') });
  if (!(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await menu.locator("summary").click();
  await menu.getByRole("button", { name: label, exact: true }).click();
}
