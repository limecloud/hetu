import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { navigate, openDirectory, openSettings, closeSettings, closeApplication } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");

test("启动页浅暗中性表面、紧凑页头及无障碍实色降级", async ({}, testInfo) => {
  // 覆盖独立应用冷启动与退出，不与单页交互共用较短预算。
  test.setTimeout(240000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "hetu-startup-layout-"));
  const executable = process.env.HETU_PACKAGED_APP;
  const application = await electron.launch({
    ...(executable ? { executablePath: executable, args: process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [] } : { args: [path.join(root, "apps/desktop")] }),
    env: { ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_COLLABORATION_DIR: path.join(profile, "collaboration") },
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.getByRole("button", { name: "刷新创作库", exact: true })).toBeEnabled({ timeout: 30000 });
    const settings = await openSettings(application, page);
    await settings.getByRole("radio", { name: "跟随系统", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "system");
    await closeSettings(settings);
    if (process.platform === "darwin") {
      expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isResizable())).toBe(true);
      await expect(page.locator("html")).toHaveAttribute("data-window-chrome", "inset");
      expect(await page.locator(".workbench-topbar").evaluate(node => getComputedStyle(node).getPropertyValue("-webkit-app-region"))).toBe("drag");
      expect(await page.getByRole("button", {name: "本机设置", exact: true}).evaluate(node => getComputedStyle(node).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
      for (const value of [80, 200, 100]) {
        await page.evaluate(value => (window as any).hetuDesktop.interfaceScale("set", {value}), value);
        await expect.poll(() => page.locator(".workbench-topbar").evaluate(node => parseFloat(getComputedStyle(node).paddingLeft))).toBeCloseTo(84 / (value / 100), 1);
        const chrome = await application.evaluate(({ BrowserWindow }) => {
          const view = BrowserWindow.getAllWindows()[0];
          return {buttons: view.getWindowButtonPosition(), outer: view.getBounds(), content: view.getContentBounds()};
        });
        expect(chrome.buttons).toEqual({x: 20, y: Math.round((52 * value / 100 - 14) / 2)});
        expect(chrome.outer.height).toBe(chrome.content.height);
      }
      const enteredFullscreen = await page.evaluate(() => window.hetuDesktop.fullscreen!("set", true));
      expect(enteredFullscreen).toBe(true);
      await expect(page.locator("html")).toHaveAttribute("data-window-chrome", "fullscreen");
      await expect(page.locator(".workbench-topbar")).toHaveCSS("padding-left", "16px");
      await page.evaluate(() => window.hetuDesktop.fullscreen!("set", false));
      await expect(page.locator("html")).toHaveAttribute("data-window-chrome", "inset");
      if (!await page.getByRole("complementary", {name: "创作库导航", exact: true}).isVisible()) await page.getByRole("button", {name: "创作库导航", exact: true}).click();
    }
    const cdp = await page.context().newCDPSession(page);
    const alpha = (color: string) => {
      if (color.includes("/")) return Number(color.split("/").at(-1)!.replace(")", ""));
      return color.startsWith("rgba") ? Number(color.split(",").at(-1)!.replace(")", "")) : 1;
    };
    for (const [width, height, appearance] of [[1360, 850, "light"], [960, 800, "light"], [1360, 850, "dark"], [960, 800, "dark"]] as const) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
      await page.setViewportSize({ width, height });
      // 仅模拟当前页面，不改系统外观或辅助功能偏好。
      await cdp.send("Emulation.setEmulatedMedia", { features: [
        { name: "prefers-color-scheme", value: appearance },
        { name: "prefers-reduced-transparency", value: "no-preference" },
        { name: "prefers-contrast", value: "no-preference" },
      ] });
      await expect(page.locator("main")).toHaveCSS("background-color", appearance === "dark" ? "rgb(34, 34, 34)" : "rgb(255, 255, 255)");
      await expect(page.locator("#root")).toHaveCSS("background-image", "none");
      await expect(page.locator("#root")).toHaveCSS("background-color", appearance === "dark" ? "rgb(25, 25, 25)" : "rgb(240, 240, 240)");
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator(".library-intro-art")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`startup-${appearance}-${width}.png`) });
      if (process.platform === "darwin" && process.env.HETU_CAPTURE_NATIVE_WINDOWS === "1") {
        const id = await application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.focus();
          return window.getMediaSourceId().split(":")[1];
        });
        const capture = spawnSync("/usr/sbin/screencapture", ["-x", "-o", "-l", id, testInfo.outputPath(`native-${appearance}-${width}.png`)], { encoding: "utf8" });
        expect(capture.status, capture.stderr).toBe(0);
      }
      const layout = await page.evaluate(() => {
        const icon = document.querySelector<HTMLImageElement>(".brand-icon")!;
        const bar = document.querySelector(".workbench-topbar")!;
        const nav = document.querySelector(".project-navigation")!;
        const button = [...document.querySelectorAll("button")].find(element => element.textContent === "打开作品")!;
        const rectangle = (element: Element) => {
          const value = element.getBoundingClientRect();
          return { x: value.x, y: value.y, width: value.width, height: value.height };
        };
        return {
          icon: rectangle(icon), decoded: icon.complete && icon.naturalWidth > 0,
          bar: rectangle(bar), nav: rectangle(nav), button: rectangle(button),
          background: getComputedStyle(nav).backgroundColor,
          backdrop: getComputedStyle(document.querySelector("#root")!).backgroundImage,
          border: getComputedStyle(bar).borderBottomWidth,
          overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
        };
      });
      await testInfo.attach(`layout-${appearance}`, { body: JSON.stringify(layout), contentType: "application/json" });
      expect(layout.decoded).toBe(true);
      expect(layout.icon.width).toBe(32);
      expect(layout.icon.height).toBe(32);
      expect(layout.bar.height).toBe(52);
      expect(layout.icon.y).toBeGreaterThanOrEqual(0);
      expect(layout.icon.y + layout.icon.height).toBeLessThanOrEqual(layout.bar.height);
      expect(layout.nav.y).toBe(layout.bar.height);
      expect(layout.nav.width).toBe(280);
      expect(layout.button.height).toBeGreaterThanOrEqual(32);
      expect(layout.button.x + layout.button.width).toBeLessThanOrEqual(width);
      expect(Number.parseFloat(layout.border)).toBe(0);
      expect(alpha(layout.background)).toBeCloseTo(0.18, 2);
      expect(layout.overflow).toBe(false);
      await page.locator(".create-work-menu > summary").click();
      const menu = page.locator(".create-work-menu .menu-panel");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveCSS("backdrop-filter", "blur(20px)");
      expect(alpha(await menu.evaluate(el => getComputedStyle(el).backgroundColor))).toBeCloseTo(0.97, 2);
      await page.screenshot({ path: testInfo.outputPath(`menu-${appearance}-${width}.png`) });
      for (const [feature, value] of [["prefers-reduced-transparency", "reduce"], ["prefers-contrast", "more"]]) {
        await cdp.send("Emulation.setEmulatedMedia", { features: [
          { name: "prefers-color-scheme", value: appearance },
          { name: feature, value },
        ] });
        expect(await page.evaluate(([name, setting]) => matchMedia(`(${name}: ${setting})`).matches, [feature, value])).toBe(true);
        await expect(menu).toHaveCSS("backdrop-filter", "none");
        expect(alpha(await menu.evaluate(el => getComputedStyle(el).backgroundColor))).toBe(1);
        await expect(page.locator("#root")).toHaveCSS("background-image", "none");
        expect(alpha(await page.locator("html").evaluate(el => getComputedStyle(el).backgroundColor))).toBe(1);
        await expect(page.locator(".project-navigation")).toHaveCSS("background-color", appearance === "dark" ? "rgb(25, 25, 25)" : "rgb(249, 249, 249)");
        await page.screenshot({ path: testInfo.outputPath(`${feature}-${appearance}-${width}.png`) });
      }
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
    // 作者手动选择的外观优先于系统。
    for (const appearance of ["dark", "light"] as const) {
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: appearance === "dark" ? "light" : "dark" }] });
      const settings = await openSettings(application, page);
      await settings.getByRole("radio", { name: {system: "跟随系统", light: "浅色", dark: "深色"}[appearance], exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance);
      await closeSettings(settings);
      await expect(page.locator("html")).toHaveAttribute("data-effective-appearance", appearance);
      await page.screenshot({ path: testInfo.outputPath(`manual-appearance-${appearance}.png`) });
    }
    expect(errors).toEqual([]);
  } finally {
    await closeApplication(application);
  }
});

test("作品首页与文稿共用中性窗口和连续阅读工作面", async ({}, testInfo) => {
  test.setTimeout(240000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "hetu-gradient-work-"));
  const workspace = path.join(profile, "作品"), access = path.join(profile, "access");
  const pkg = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  const fixture = spawnSync(path.join(root, "target/debug/examples/plugin_fixture"), [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  const executable = process.env.HETU_PACKAGED_APP;
  const application = await electron.launch({
    ...(executable ? { executablePath: executable, args: process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [] } : { args: [path.join(root, "apps/desktop")] }),
    env: {
    ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_PLUGIN_ACCESS_DIR: access, HETU_COLLABORATION_DIR: path.join(profile, "collaboration"),
  } });
  try {
    await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, workspace);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
    await page.getByRole("button", { name: /插件集成测试/ }).click();
    await expect(page.getByRole("complementary", { name: "项目导航", exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.workbench-page[data-surface="work.profile"]')).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    for (const [width, appearance] of [[1360, "light"], [960, "light"], [1360, "dark"], [960, "dark"]] as const) {
      await page.setViewportSize({ width, height: 850 });
      const settings = await openSettings(application, page);
      await settings.getByRole("radio", { name: {system: "跟随系统", light: "浅色", dark: "深色"}[appearance], exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance, { timeout: 30000 });
      await closeSettings(settings);
      await cdp.send("Emulation.setEmulatedMedia", { features: [
        { name: "prefers-color-scheme", value: appearance },
        { name: "prefers-reduced-transparency", value: "no-preference" },
        { name: "prefers-contrast", value: "no-preference" },
      ] });
      await navigate(page, "作品资料");
      const profilePage = page.locator('.workbench-page[data-surface="work.profile"]');
      await expect(profilePage.locator(".profile-overview")).toBeVisible();
      await expect(profilePage.getByRole("button", { name: "让 AI 完善资料", exact: true })).toBeEnabled();
      await expect(profilePage.locator(".work-agent")).toHaveCount(0);
      await expect(profilePage.getByRole("region", { name: "封面候选", exact: true })).toHaveCount(0);
      await expect(profilePage.locator(".profile-timestamps")).toBeHidden();
      await expect(page.locator("#root")).toHaveCSS("background-image", "none");
      for (const position of ["top", "middle", "bottom"] as const) {
        await profilePage.evaluate((element, position) => {
          element.scrollTop = position === "top" ? 0 : position === "middle" ? element.scrollHeight / 2 : element.scrollHeight;
        }, position);
        await page.screenshot({ path: testInfo.outputPath(`profile-${appearance}-${width}-${position}.png`) });
      }
      if (width === 1360 && appearance === "light") {
        await profilePage.locator(".profile-collaboration > summary").click();
        await expect(profilePage.getByRole("combobox", { name: "本作品客户端", exact: true })).toBeEnabled({ timeout: 30000 });
        await expect(profilePage.getByRole("button", { name: "让 AI 调整", exact: true })).toBeEnabled();
        await profilePage.locator(".profile-collaboration > summary").click();
        await expect(profilePage.locator(".work-agent")).toHaveCount(0);
      }
      await navigate(page, "小说");
      await openDirectory(page);
      await page.getByRole("button", { name: "第一章 雾港", exact: true }).click();
      await expect(page.locator(".manuscript-paper")).toHaveCSS("background-color", appearance === "dark" ? "rgb(34, 34, 34)" : "rgb(255, 255, 255)");
      await expect(page.locator(".manuscript-paper")).toContainText("雾港");
      await page.screenshot({ path: testInfo.outputPath(`manuscript-${appearance}-${width}.png`) });
      const metrics = await page.evaluate(() => {
        const fonts = [...new Set([...document.querySelectorAll<HTMLElement>("body *")].filter(el => el.checkVisibility() && [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())).map(el => Number.parseFloat(getComputedStyle(el).fontSize)))];
        return { fonts, overflow: document.documentElement.scrollWidth > innerWidth, bar: document.querySelector(".workbench-topbar")!.getBoundingClientRect().height };
      });
      // 界面、目录和文稿分别采用共享字号；正文不受旧的界面四档限制。
      expect(metrics.fonts.every(size => [12, 13, 14, 16, 20, 24].includes(size))).toBe(true);
      await expect(page.locator(".reader, .author-editor")).toHaveCSS("font-size", "16px");
      await expect(page.locator(".manuscript-title h1")).toHaveCSS("font-size", "24px");
      expect(metrics.overflow).toBe(false);
      expect(metrics.bar).toBe(52);
      await testInfo.attach(`manuscript-${appearance}-${width}`, { body: JSON.stringify(metrics), contentType: "application/json" });
    }
  } finally {
    await closeApplication(application);
  }
});
