import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { navigate } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("无权限声明插件安装即用核心、重开、无新增授权及停用释放", async () => {
  test.setTimeout(180000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-computation-ui-"));
  const packageDirectory = path.join(folder, "package"), workspace = path.join(folder, "作品"), profile = path.join(folder, "profile"), access = path.join(folder, "access");
  await mkdir(packageDirectory);
  await writeFile(path.join(packageDirectory, "plugin.json"), JSON.stringify({
    manifest_version: 1, host_api: "1", id: "org.test.counter", version: "1.0.0", license: "MIT", dependencies: [],
    display: { "zh-CN": "文字计算器", en: "Text counter" }, description: { "zh-CN": "只统计作者明确输入的文字", en: "Counts explicitly supplied text" },
    contributions: { data: [], views: [{ id: "main", title: "字符统计", entry: "index.html", object_kinds: [] }], actions: [{ id: "count", title: "统计字符", effect: "read", input_schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 10000 } } } }] },
    runtime: { entry: "backend.mjs" },
  }));
  await writeFile(path.join(packageDirectory, "backend.mjs"), "export function apply() {}\nexport function invoke(action, input) { return { characters: Array.from(input.text).length }; }\n");
  await writeFile(path.join(packageDirectory, "index.html"), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>字符统计</title><h1>字符统计</h1><label>输入文字<textarea id="text"></textarea></label><button id="count">统计</button><output id="result" role="status"></output><script src="view.js"></script></html>');
  await writeFile(path.join(packageDirectory, "view.js"), 'document.querySelector("#count").onclick = async () => { try { const result = await window.hetu.invoke("count", { text: document.querySelector("#text").value }); document.querySelector("#result").textContent = result.characters + " 个字符"; } catch (error) { document.querySelector("#result").textContent = error.message; } };');
  const pkg = await PluginPackage.inspect(packageDirectory);
  const fixture = spawnSync(path.join(root, "target/debug/examples/plugin_fixture"), [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256], { encoding: "utf8", timeout: 30000 });
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  const originalGrants = await readdir(path.join(access, "grants"));
  let app: ElectronApplication | undefined;
  async function launch() {
    app = await electron.launch({ args: [path.join(root, "apps/desktop")], env: {
      ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_COLLABORATION_DIR: path.join(profile, "collaboration"), HETU_PLUGIN_ACCESS_DIR: access,
      HETU_PLUGIN_NODE: process.execPath, HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"),
    } });
    await app.evaluate(({ dialog }, directory) => {
      (globalThis as any).permissionPrompts = [];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      dialog.showMessageBox = async (_window: any, options: any) => { (globalThis as any).permissionPrompts.push(options.detail); return { response: 1, checkboxChecked: false }; };
    }, workspace);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
    await page.getByRole("button", { name: /插件集成测试/ }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).hetuDesktop.state())).work?.object_id).toBe(context.work_ref.object_id);
    return page;
  }
  async function pluginPage() {
    await expect.poll(() => app!.windows().find(p => p.url().startsWith("hetu-plugin://"))?.url()).toBeTruthy();
    return app!.windows().find(p => p.url().startsWith("hetu-plugin://"))!;
  }
  try {
    let page = await launch();
    await navigate(page, "创作插件");
    await app!.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, packageDirectory);
    await page.getByRole("button", { name: "安装插件包", exact: true }).click();
    await expect(page.getByRole("button", { name: "字符统计", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "字符统计", exact: true }).click();
    let view = await pluginPage();
    await expect(page.locator(".workbench-topbar")).toHaveCount(0);
    await expect(page.locator(".project-navigation")).toHaveCount(0);
    const area = await page.locator(".surface").boundingBox();
    expect(area?.x).toBe(0);
    expect(area?.y).toBe(88);
    await expect.poll(() => view.evaluate(() => innerWidth)).toBe(Math.round(area!.width));
    await view.getByRole("textbox", { name: "输入文字" }).fill("灯塔🌿");
    await view.getByRole("button", { name: "统计", exact: true }).click();
    await expect(view.getByRole("status")).toHaveText("3 个字符");
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    await expect(page.getByRole("heading", { name: "创作插件", exact: true })).toBeVisible();
    await expect(page.locator(".workbench-topbar")).toBeVisible();
    await expect(page.locator(".project-navigation")).toBeVisible();
    await page.getByRole("button", { name: "字符统计", exact: true }).click();
    view = await pluginPage();
    const snapshot = await view.evaluate(() => (window as any).hetu.request("hetu.novels.snapshot", {}));
    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.data.document_count).toBe(1);
    const objects = await view.evaluate(() => (window as any).hetu.request("hetu.extensions.objects.list", {}));
    expect(objects.status).toBe("succeeded");
    expect(objects.data.objects).toEqual([]);
    expect(JSON.parse(await app!.evaluate(() => JSON.stringify((globalThis as any).permissionPrompts)))).toHaveLength(1); // 只有安装选择。
    await app!.close(); app = undefined;
    page = await launch();
    await page.getByRole("button", { name: "字符统计", exact: true }).click();
    view = await pluginPage();
    expect(await app!.evaluate(() => JSON.stringify((globalThis as any).permissionPrompts))).toBe("[]");
    await view.getByRole("textbox", { name: "输入文字" }).fill("雾港");
    await view.getByRole("button", { name: "统计", exact: true }).click();
    await expect(view.getByRole("status")).toHaveText("2 个字符");
    const preferences = JSON.parse(await readFile(path.join(profile, "plugin-state.json"), "utf8"));
    expect(preferences.grants ?? {}).toEqual({});
    expect(await readdir(path.join(access, "grants"))).toEqual(originalGrants);
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    await expect(page.locator(".workbench-topbar")).toBeVisible();
    await navigate(page, "创作插件");
    await page.getByRole("button", { name: "停用", exact: true }).click();
    await expect(page.getByRole("button", { name: "启用", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "字符统计", exact: true })).toHaveCount(0);
  } finally { await app?.close(); }
});
