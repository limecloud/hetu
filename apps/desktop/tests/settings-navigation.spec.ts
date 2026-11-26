import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {openSettings, closeSettings, closeApplication} from "./navigation.ts";

test("独立设置窗口的分类按视觉顺序循环，200%界面仍可操作并返回主窗口", async ({}, info) => {
  test.setTimeout(180000);
  const root = path.resolve(import.meta.dirname, "../../.."), profile = await mkdtemp(path.join(os.tmpdir(), "hetu-settings-navigation-"));
  const env = {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "LocalSettings"), HETU_MODEL_SERVICE_DIR: path.join(profile, "models"), HETU_PLUGIN_STATE_DIR: profile, HETU_COLLABORATION_DIR: path.join(profile, "collaboration")};
  for (const key of ["ELECTRON_RUN_AS_NODE", "HETU_APP_SERVER", "HETU_CLI", "HETU_PLUGIN_CLI", "HETU_PLUGIN_NODE", "HETU_INTEGRATIONS_DIR"]) delete (env as Record<string, string | undefined>)[key];
  const app = await electron.launch(process.env.HETU_PACKAGED_APP ? {executablePath: process.env.HETU_PACKAGED_APP, args: [], env} : {args: [path.join(root, "apps/desktop")], env});
  const measurements: unknown[] = [];
  try {
    const main = await app.firstWindow(), page = await openSettings(app, main);
    const settings = page.getByRole("region", {name: "本机设置", exact: true}), tablist = settings.getByRole("tablist", {name: "设置分类", exact: true});
    const labels = ["通用", "写作", "存储空间", "模型服务", "AI 协作", "版本", "关于"];
    for (const scale of [100, 200]) {
      await app.evaluate(({BrowserWindow}) => {const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith("?view=settings"))!; window.setContentSize(840, 1000);});
      await page.evaluate(scale => window.hetuDesktop.interfaceScale("set", {value: scale}), scale);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(840 / (scale / 100));
      const horizontal = scale === 200;
      await expect(tablist).toHaveAttribute("aria-orientation", horizontal ? "horizontal" : "vertical");
      await expect(tablist.getByRole("tab")).toHaveText(labels);
      for (const direction of [1, -1]) for (const [index, label] of labels.entries()) {
        const current = tablist.getByRole("tab", {name: label, exact: true}); await current.focus();
        await current.press(horizontal ? direction === 1 ? "ArrowRight" : "ArrowLeft" : direction === 1 ? "ArrowDown" : "ArrowUp");
        const next = tablist.getByRole("tab", {name: labels[(index + direction + labels.length) % labels.length], exact: true});
        await expect(next).toBeFocused(); await expect(next).toHaveAttribute("aria-selected", "true"); await expect(next).toHaveAttribute("tabindex", "0");
        await expect(settings.getByRole("tabpanel", {name: labels[(index + direction + labels.length) % labels.length], exact: true})).toBeVisible();
        expect(await next.evaluate(node => {const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1;})).toBe(true);
      }
      await tablist.getByRole("tab", {name: "通用", exact: true}).press("End"); await expect(tablist.getByRole("tab", {name: "关于", exact: true})).toBeFocused();
      await tablist.getByRole("tab", {name: "关于", exact: true}).press("Home"); await expect(tablist.getByRole("tab", {name: "通用", exact: true})).toBeFocused();
      const measured = await page.evaluate(scale => ({scale, width: innerWidth, height: innerHeight, orientation: document.querySelector('[aria-label="设置分类"]')?.getAttribute("aria-orientation"), rootOverflow: document.documentElement.scrollWidth > innerWidth + 1}), scale);
      expect(measured.rootOverflow).toBe(false); measurements.push(measured);
      const image = await app.evaluate(async ({BrowserWindow}) => {
        const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith("?view=settings"))!;
        return (await window.webContents.capturePage()).toPNG().toString("base64");
      });
      await writeFile(info.outputPath(`settings-${scale}.png`), Buffer.from(image, "base64"));
    }
    await tablist.getByRole("tab", {name: "AI 协作", exact: true}).click();
    await settings.getByText("外部客户端、MCP App与Skills接入", {exact: true}).click();
    const integration = settings.getByRole("region", {name: "默认AI协作", exact: true});
    await expect(integration).toHaveAttribute("aria-busy", "false");
    const guide = integration.getByRole("button", {name: "安装与接入说明", exact: true});
    for (const via of ["escape", "button"]) {
      await guide.click(); await expect(integration.getByRole("dialog", {name: "安装与接入说明", exact: true})).toBeVisible();
      if (via === "escape") await page.keyboard.press("Escape"); else await integration.getByRole("button", {name: "关闭接入窗口", exact: true}).click();
      await expect(integration.getByRole("dialog")).toHaveCount(0); await expect(guide).toBeFocused(); await expect(settings).toBeVisible();
    }
    await closeSettings(page); await expect(main.getByRole("button", {name: "本机设置", exact: true})).toBeVisible();
    const reopened = await openSettings(app, main); await expect(reopened.getByRole("tab", {name: "通用", exact: true})).toHaveAttribute("aria-selected", "true"); await closeSettings(reopened);
  } finally {
    await writeFile(info.outputPath("settings-navigation.json"), JSON.stringify(measurements, null, 2) + "\n");
    await closeApplication(app);
  }
});
