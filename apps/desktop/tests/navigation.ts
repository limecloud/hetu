import { expect, type Page, type ElectronApplication } from "@playwright/test";

/** 走作者关闭窗口的路径，保留恢复稿落盘期间的调试连接。 */
export async function closeApplication(application: ElectronApplication, via: "window" | "app" = "app") {
  const process = application.process();
  if (process.exitCode !== null) {expect(process.exitCode).toBe(0); return;}
  if (via === "app") {
    // 官方关闭路径在quit被恢复稿落盘暂缓后释放调试连接，再等待真实进程退出。
    await application.close(); expect(process.exitCode).toBe(0); return;
  }
  await application.evaluate(({BrowserWindow, app}, via) => {
    const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("?view=settings"));
    // closed在恢复稿落盘后触发；随后释放Node调试器，不改变应用退出路径。
    window?.once("closed", () => setImmediate(() => process.getBuiltinModule("node:inspector").close()));
    if (via === "app") app.quit(); else window?.close();
  }, via).catch(error => {if (process.exitCode !== 0) throw error;});
  try {await expect.poll(() => process.exitCode, {timeout: 30000}).toBe(0);}
  catch (error) {
    const state = await application.evaluate(({BrowserWindow, app}) => ({ready: app.isReady(), windows: BrowserWindow.getAllWindows().map(window => ({url: window.webContents.getURL(), visible: window.isVisible(), modal: window.isModal(), destroyed: window.isDestroyed()}))})).catch(() => ({disconnected: true}));
    throw new Error(`${(error as Error).message}\n关闭状态：${JSON.stringify(state)}`);
  }
}

/** 设置使用独立窗口，重复打开复用同一窗口。 */
export async function openSettings(application: ElectronApplication, page: Page) {
  await page.getByRole("button", { name: "本机设置", exact: true }).first().click();
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
  const toggle = page.getByRole("button", { name: /^(卷章目录|分集目录)$/ });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await expect(page.getByRole("navigation", { name: "文稿目录", exact: true })).toBeVisible();
}

/** 沿作者可见的创作库或项目导航展开分组。 */
export async function navigate(page: Page, label: string) {
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
  if (await projectLayer.count()) await projectLayer.click();
  await expect(button).toBeEnabled();
  const group = navigation.locator("details.navigation-group").filter({ has: page.getByRole("button", options) });
  if (await group.count() && !(await group.evaluate((element) => (element as HTMLDetailsElement).open)))
    await group.locator(":scope > summary").click();
  await button.click();
}

export async function documentAction(page: Page, label: string) {
  const menu = page.locator("details").filter({ has: page.locator('summary[aria-label="文稿操作"]') });
  if (!(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await menu.locator("summary").click();
  await menu.getByRole("button", { name: label, exact: true }).click();
}
