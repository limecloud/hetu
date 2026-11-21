import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { AppServer } from "../src/main/rpc.ts";
import { navigate } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("作品插件按小说、剧本和视频筛选，管理保留全集，错误直开保留当前工作面", async ({}, testInfo) => {
  test.setTimeout(120000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-plugin-kinds-"));
  const workspace = path.join(folder, "作品"), access = path.join(folder, "access"), profile = path.join(folder, "profile");
  const base = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  const fixture = spawnSync(path.join(root, "target/debug/examples/plugin_fixture"), [workspace, access, path.join(base.source, "plugin.json"), base.sha256], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  const server = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  try {
    const result = await server.request("workspace/request", { action: "hetu.video.projects.create", contract_revision: "1", input: { title: "独立视频", brief: "隔离验收", language_tag: "zh-CN", operation_key: "plugin-kind-video" } });
    expect(result.status).toBe("succeeded");
  } finally { await server.close(); }
  const packages = [
    { id: "novel", title: "小说专用", kinds: ["novel"] },
    { id: "drama", title: "剧本专用", kinds: ["drama"] },
    { id: "video", title: "视频专用", kinds: ["video"] },
    { id: "shared", title: "剧本与视频", kinds: ["drama", "video"] },
    { id: "general", title: "通用插件", kinds: undefined },
  ];
  for (const pkg of packages) {
    const directory = path.join(folder, pkg.id);
    await mkdir(directory);
    await writeFile(path.join(directory, "plugin.json"), JSON.stringify({ manifest_version: 1, host_api: "1", id: "org.test." + pkg.id, version: "0.1.0", display: { "zh-CN": pkg.title, en: pkg.id }, description: { "zh-CN": "范围验收", en: "Scope verification" }, license: "MIT", dependencies: [], work_kinds: pkg.kinds, contributions: { views: [{ id: "main", title: pkg.title, entry: "index.html", object_kinds: ["professional_data"] }], data: [], actions: [] } }));
    await writeFile(path.join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><h1>' + pkg.title + "</h1>");
  }
  const application = await electron.launch({ args: [path.join(root, "apps/desktop")], env: { ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_PLUGIN_ACCESS_DIR: access, HETU_COLLABORATION_DIR: path.join(folder, "collaboration"), HETU_PLUGIN_NODE: process.execPath, HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server") } });
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1360, height: 900 });
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, workspace);
    await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
    await page.locator(".library-works .work").filter({ has: page.getByText("插件集成测试", { exact: true }) }).click();
    await navigate(page, "创作插件");
    for (const pkg of packages) {
      await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, path.join(folder, pkg.id));
      await page.getByRole("button", { name: "安装插件包", exact: true }).click();
      await expect(page.locator(".plugin-content .row").filter({ has: page.getByText(pkg.title, { exact: true }) })).toBeVisible();
    }
    const sidebar = page.getByRole("complementary", { name: "项目导航", exact: true });
    async function check(kind: string) {
      for (const pkg of packages) await expect(sidebar.getByRole("button", { name: pkg.title, exact: true })).toHaveCount(!pkg.kinds || pkg.kinds.includes(kind) ? 1 : 0);
      const state = await page.evaluate(() => (window as any).hetuDesktop.state());
      expect(state.views.map((view: any) => view.title).sort()).toEqual(packages.filter(pkg => !pkg.kinds || pkg.kinds.includes(kind)).map(pkg => pkg.title).sort());
    }
    async function select(title: string) {
      await page.locator(".workspace-switcher > summary").click();
      await page.locator(".workspace-switcher").getByRole("button", { name: title, exact: true }).click();
      await expect(page.locator(".workspace-title")).toHaveText(title);
    }
    await check("novel");
    await sidebar.getByRole("button", { name: "小说专用", exact: true }).click();
    await expect.poll(() => application.windows().some(p => p.url().startsWith("hetu-plugin://"))).toBe(true);
    const pluginPage = application.windows().find(p => p.url().startsWith("hetu-plugin://"))!;
    await expect(pluginPage.getByRole("heading", { name: "小说专用", exact: true })).toBeVisible();
    if (process.platform === "darwin") {
      await expect(page.locator(".plugin-window-chrome")).toHaveCSS("height", "52px");
      const surface = await page.locator(".surface").boundingBox();
      expect(surface!.y).toBeGreaterThanOrEqual(88);
      expect(await page.locator(".plugin-window-chrome").evaluate(node => getComputedStyle(node).getPropertyValue("-webkit-app-region"))).toBe("drag");
    }
    const originalURL = pluginPage.url();
    expect(await page.evaluate(async () => {
      try { await (window as any).hetuDesktop.view("org.test.video", "main"); return "opened"; }
      catch (error) { return (error as Error).message; }
    })).toContain("此插件不适用于当前作品");
    expect(pluginPage.url()).toBe(originalURL);
    await expect(pluginPage.getByRole("heading", { name: "小说专用", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    await select("独立剧本");
    await check("drama");
    await select("独立视频");
    await check("video");
    await page.screenshot({ path: testInfo.outputPath("video-plugins-light-1360.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 960, height: 768 });
    await page.screenshot({ path: testInfo.outputPath("video-plugins-dark-960.png") });
    await navigate(page, "创作插件");
    await expect(page.locator(".plugin-content .row")).toHaveCount(packages.length);
    await expect(page.locator(".plugin-content .row").filter({ has: page.getByText("小说专用", { exact: true }) })).toContainText("小说");
    await expect(page.locator(".plugin-content .row").filter({ has: page.getByText("通用插件", { exact: true }) })).toContainText("全部作品");
    await select("插件集成测试");
    await check("novel");
  } finally { await application.close(); }
});
