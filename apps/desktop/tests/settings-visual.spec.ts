import { test, expect as baseExpect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openSettings, closeSettings } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const expect = baseExpect.configure({ timeout: 30000 });
test("独立设置六分类截图、即时保存、浮层和窗口权限", async () => {
  test.setTimeout(600000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "hetu-settings-visual-"));
  const output = path.join(root, "output/settings-native-20261116", process.env.HETU_SETTINGS_ROUND ?? "round-1");
  await mkdir(output, { recursive: true });
  const app = await electron.launch({ args: [path.join(root, "apps/desktop")], env: {
    ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "local-settings"),
    HETU_MODEL_SERVICE_DIR: path.join(profile, "models"), HETU_COLLABORATION_DIR: path.join(profile, "collaboration"),
  } });
  const errors: string[] = [], metrics: unknown[] = [];
  try {
    const main = await app.firstWindow();
    const page = await openSettings(app, main);
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.getByRole("combobox", { name: "外观", exact: true })).toBeVisible();
    expect(await openSettings(app, main)).toBe(page);
    await expect(page.getByRole("tab")).toHaveCount(6);
    await expect(page.evaluate(() => window.hetuDesktop.read("hetu.works.list", {}))).rejects.toThrow();
    await expect(page.evaluate(() => window.hetuDesktop.author("journal", {}))).rejects.toThrow();
    await expect(page.evaluate(() => window.hetuDesktop.install())).rejects.toThrow();
    const categories = [["通用", "general"], ["写作", "writing"], ["模型服务", "models"], ["AI 协作", "agents"], ["版本", "versions"], ["关于", "about"]];
    async function ready(id: string) {
      if (id === "models") await expect(page.getByRole("button", { name: "添加渠道", exact: true })).toBeEnabled();
      if (id === "agents") await expect(page.locator(".work-agent-inspection")).toBeVisible();
      await expect(page.getByRole("button", { name: "让 AI 处理与审阅", exact: true })).toBeEnabled();
    }
    async function capture(name: string) {
      await page.screenshot({ path: path.join(output, name + ".png"), scale: "css" });
      const value = await page.evaluate(() => {
        const panel = document.querySelector(".settings-panel")!;
        const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
        const fonts = [...new Set(Array.from(document.querySelectorAll<HTMLElement>("body *")).filter(el => el.checkVisibility() && [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())).map(el => parseFloat(getComputedStyle(el).fontSize)))].sort((a, b) => a - b);
        return { width: innerWidth, height: innerHeight, fonts, horizontalOverflow: document.documentElement.scrollWidth > innerWidth || panel.scrollWidth > panel.clientWidth + 1,
          dialog: dialog && { width: dialog.clientWidth, height: dialog.clientHeight, overflow: dialog.scrollWidth > dialog.clientWidth, backdrop: getComputedStyle(dialog, "::backdrop").backgroundColor },
          tabs: Array.from(document.querySelectorAll('[role="tab"]')).map(el => ({ text: el.textContent, ...JSON.parse(JSON.stringify(el.getBoundingClientRect())), font: getComputedStyle(el).fontSize })),
          groups: Array.from(document.querySelectorAll(".settings-group")).map(el => ({ text: el.querySelector("h3")?.textContent, x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, width: el.getBoundingClientRect().width })),
        };
      });
      metrics.push({ name, ...value });
      expect(value.horizontalOverflow, name).toBe(false);
      expect(value.fonts.length, name).toBeLessThanOrEqual(4);
      expect(value.fonts.every(size => size >= 12), name).toBe(true);
      if (value.dialog) expect(value.dialog.overflow, name).toBe(false);
    }
    await capture("initial-general");
    for (const appearance of ["light", "dark"]) {
      await page.getByRole("tab", { name: "通用", exact: true }).click();
      await page.getByRole("combobox", { name: "外观", exact: true }).selectOption(appearance);
      await expect.poll(() => page.evaluate(async () => (await window.hetuDesktop.settings("get")).preferences.appearance), { timeout: 30000 }).toBe(appearance);
      await expect(page.getByRole("combobox", { name: "外观", exact: true })).toHaveValue(appearance, { timeout: 30000 });
      await expect(page.getByRole("combobox", { name: "外观", exact: true })).toBeEnabled({ timeout: 30000 });
      for (const [label, id] of categories) {
        await page.getByRole("tab", { name: label, exact: true }).click();
        await ready(id);
        await capture(id + "-" + appearance);
        if (id === "models") {
          await page.getByRole("button", { name: "添加渠道", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "添加渠道", exact: true })).toBeVisible();
          await capture("model-dialog-" + appearance);
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog", { name: "添加渠道", exact: true })).toBeHidden();
        }
        if (["models", "agents"].includes(id)) {
          await page.locator(".settings-panel").evaluate(el => { el.scrollTop = el.scrollHeight; });
          await capture(id + "-" + appearance + "-bottom");
        }
      }
    }
    await page.getByRole("tab", { name: "通用", exact: true }).click();
    await page.getByRole("combobox", { name: "外观", exact: true }).selectOption("light");
    await page.getByRole("tab", { name: "写作", exact: true }).click();
    await page.getByRole("button", { name: "增大字号", exact: true }).click();
    await expect(page.getByLabel("字号当前值", { exact: true })).toHaveText("19 px", { timeout: 30000 });
    await expect(page.getByRole("switch", { name: "自动保存正文", exact: true })).toBeEnabled();
    await page.getByRole("switch", { name: "自动保存正文", exact: true }).uncheck();
    await expect.poll(() => page.evaluate(async () => (await window.hetuDesktop.settings("get")).preferences.autosave), { timeout: 30000 }).toBe(false);
    await page.getByRole("tab", { name: "版本", exact: true }).click();
    await page.getByLabel("姓名", { exact: true }).fill("隔离验收作者");
    await page.getByLabel("邮箱", { exact: true }).fill("writer@fixture.test");
    await page.getByRole("tab", { name: "关于", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.hetuDesktop.settings("get")).preferences.git_author_email), { timeout: 30000 }).toBe("writer@fixture.test");
    expect((await page.evaluate(() => window.hetuDesktop.settings("get"))).preferences.git_author_name).toBe("隔离验收作者");
    await page.getByRole("tab", { name: "模型服务", exact: true }).click();
    await page.getByRole("button", { name: "添加渠道", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "添加渠道", exact: true });
    await expect(dialog).toBeVisible();
    const saveBounds = await page.getByRole("button", { name: "保存渠道", exact: true }).boundingBox();
    expect(saveBounds!.y + saveBounds!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    await capture("model-channel-dialog");
    await page.getByLabel("渠道名称", { exact: true }).fill("测试渠道");
    await page.getByLabel("服务地址", { exact: true }).fill("https://provider.fixture.test/v1");
    await page.getByLabel("API Key", { exact: true }).fill("isolated-test-secret");
    await page.getByLabel("文字模型", { exact: true }).fill("text-one");
    await page.getByLabel("图片模型", { exact: true }).fill("image-one");
    await page.getByRole("button", { name: "保存渠道", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(JSON.stringify(await page.evaluate(() => window.hetuDesktop.models("inspect")))).not.toContain("isolated-test-secret");
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
    await page.keyboard.press("Escape");
    expect(page.isClosed()).toBe(false);
    await page.getByRole("tab", { name: "AI 协作", exact: true }).click();
    await page.locator(".work-agent-finder summary").click();
    await page.getByRole("textbox", { name: "搜索题材套件", exact: true }).fill("历史");
    await capture("agents-finder");
    await page.getByRole("textbox", { name: "搜索题材套件", exact: true }).fill("");
    await page.getByRole("button", { name: "安装与接入说明", exact: true }).click();
    await capture("agents-guide"); await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "让 AI 处理与审阅", exact: true }).click();
    await expect(page.getByRole("button", { name: "让 AI 调整设置", exact: true })).toBeEnabled();
    await capture("settings-review-empty");
    await page.getByRole("button", { name: "返回设置", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(view => view.webContents.getURL().endsWith("?view=settings"))!.setContentSize(520, 588));
    for (const [label, id] of categories) {
      await page.getByRole("tab", { name: label, exact: true }).click(); await ready(id); await capture(id + "-narrow");
      if (id === "models") {
        await page.getByRole("button", { name: "添加渠道", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "添加渠道", exact: true })).toBeVisible();
        await capture("model-dialog-narrow");
        await page.keyboard.press("Escape");
      }
    }
    await page.getByRole("tab", { name: "通用", exact: true }).click();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "写作", exact: true })).toBeFocused();
    await expect(page.getByRole("tab", { name: "写作", exact: true })).toHaveAttribute("aria-selected", "true");
    await capture("keyboard-focus");
    expect(errors).toEqual([]);
    await page.getByRole("tab", { name: "版本", exact: true }).click();
    await page.getByLabel("姓名", { exact: true }).fill("关闭前的署名");
    await closeSettings(page);
    const reopened = await openSettings(app, main);
    expect((await reopened.evaluate(() => window.hetuDesktop.settings("get"))).preferences.font_size).toBe(19);
    expect((await reopened.evaluate(() => window.hetuDesktop.settings("get"))).preferences.git_author_name).toBe("关闭前的署名");
    await writeFile(path.join(output, "metrics.json"), JSON.stringify(metrics, null, 2));
  } finally {
    await writeFile(path.join(output, "metrics.json"), JSON.stringify(metrics, null, 2));
    await writeFile(path.join(output, "renderer-errors.json"), JSON.stringify(errors, null, 2));
    await app.close();
  }
});

test("模型渠道错误保留输入并先回读原保存", async () => {
  test.setTimeout(180000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "hetu-settings-error-"));
  const executable = process.env.HETU_PACKAGED_APP;
  const output = path.join(root, "output/settings-native-20261116", executable ? "error-states-packaged" : "error-states");
  await mkdir(output, { recursive: true });
  const app = await electron.launch({ ...(executable ? { executablePath: executable, args: [] } : { args: [path.join(root, "apps/desktop")] }), env: {
    ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "settings"),
    HETU_MODEL_SERVICE_DIR: path.join(profile, "models"), HETU_COLLABORATION_DIR: path.join(profile, "collaboration"),
  } });
  try {
    const page = await openSettings(app, await app.firstWindow());
    await page.getByRole("combobox", { name: "外观", exact: true }).selectOption("dark");
    await expect.poll(() => page.evaluate(async () => (await window.hetuDesktop.settings("get")).preferences.appearance)).toBe("dark");
    await page.getByRole("tab", { name: "模型服务", exact: true }).click();
    await page.getByRole("button", { name: "添加渠道", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "添加渠道", exact: true });
    await dialog.getByLabel("渠道名称", { exact: true }).fill("错误恢复验收渠道");
    await dialog.getByLabel("服务地址", { exact: true }).fill("ftp://provider.fixture.test/v1");
    await dialog.getByLabel("API Key", { exact: true }).fill("isolated-error-secret");
    await dialog.getByLabel("文字模型", { exact: true }).fill("text-one");
    await dialog.getByRole("button", { name: "保存渠道", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("HTTPS");
    await expect(dialog.getByLabel("渠道名称", { exact: true })).toHaveValue("错误恢复验收渠道");
    await page.screenshot({ path: path.join(output, "error-dark.png"), scale: "css" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(view => view.webContents.getURL().endsWith("?view=settings"))!.setContentSize(520, 460));
    await dialog.getByRole("alert").scrollIntoViewIfNeeded();
    const action = await dialog.getByRole("button", { name: "检查本次保存", exact: true }).boundingBox();
    expect(action!.y + action!.height).toBeLessThanOrEqual(460);
    await page.screenshot({ path: path.join(output, "error-narrow.png"), scale: "css" });
    expect(Object.keys((await page.evaluate(() => window.hetuDesktop.models("inspect"))).custom_channels ?? {})).toHaveLength(0);
    await dialog.getByRole("button", { name: "检查本次保存", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "保存渠道", exact: true })).toBeEnabled();
    expect(Object.keys((await page.evaluate(() => window.hetuDesktop.models("inspect"))).custom_channels ?? {})).toHaveLength(0);
    await dialog.getByLabel("服务地址", { exact: true }).fill("https://provider.fixture.test/v1");
    await dialog.getByRole("button", { name: "保存渠道", exact: true }).click();
    await expect(dialog).toBeHidden();
    const state = await page.evaluate(() => window.hetuDesktop.models("inspect"));
    expect(Object.keys(state.custom_channels)).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain("isolated-error-secret");
  } finally { await app.close(); }
});
