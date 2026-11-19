import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { navigate, openDirectory } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("空插件目录的小说大纲、剧本阅读、视频播放与区间反馈，经CLI/MCP回读并重开", async () => {
  test.setTimeout(180000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-baseline-")), workspace = path.join(folder, "作品"),
    collaboration = path.join(folder, "collaboration"), plugins = path.join(folder, "empty-plugins"), profile = path.join(folder, "desktop");
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, collaboration], { encoding: "utf8", timeout: 30000 });
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  let app: ElectronApplication | undefined, client: Client | undefined;
  const exported = path.join(folder, "导出视频.mp4");
  const screenshots = path.join(root, "output/baseline-qa");
  await mkdir(screenshots, { recursive: true });
  async function inspectLayout(page: import("@playwright/test").Page, name: string, selector: string) {
    for (const [width, appearance] of [[1360, "light"], [960, "dark"]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(appearance => { document.documentElement.dataset.appearance = appearance; document.documentElement.style.colorScheme = appearance; }, appearance);
      const surface = page.locator(selector);
      expect(await surface.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await surface.evaluate(element => element.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: path.join(screenshots, `${name}-${appearance}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.evaluate(() => { document.documentElement.dataset.appearance = "light"; document.documentElement.style.colorScheme = "light"; });
  }
  const cli = (action: string, input: any) => {
    const result = spawnSync(path.join(root, "target/debug/hetu"), ["--client", "codex", "--collaboration-dir", collaboration, "call", action, "--input", "-"], { input: JSON.stringify(input), encoding: "utf8", timeout: 30000, env: { ...process.env, HETU_PLUGIN_STATE_DIR: plugins } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout).data;
  };
  async function launch() {
    app = await electron.launch({ args: [path.join(root, "apps/desktop")], env: { ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_COLLABORATION_DIR: collaboration, HETU_PLUGIN_STATE_DIR: plugins, HETU_PLUGIN_ACCESS_DIR: path.join(folder, "access"), HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"), HETU_CLI: path.join(root, "target/debug/hetu") } });
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.workspace] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.exported });
    }, { workspace, exported });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1360, height: 900 });
    return page;
  }
  try {
    expect(cli("hetu.baseline.inspect", {}).status).toBe("contract_complete");
    let page = await launch();
    await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
    await page.getByRole("button", { name: /默认小说/ }).click();
    await expect(page.getByRole("button", { name: "卷章目录", exact: true })).toBeVisible();
    await navigate(page, "作品大纲");
    await page.getByRole("button", { name: "新增大纲", exact: true }).click();
    await page.getByRole("textbox", { name: "大纲标题 1" }).fill("渡口承诺");
    await page.getByRole("textbox", { name: "大纲内容 1" }).fill("江岚必须在天亮前决定是否登船。");
    await page.getByRole("button", { name: "保存大纲", exact: true }).click();
    await expect(page.getByText("江岚必须在天亮前决定是否登船。", { exact: true })).toBeVisible();
    expect(cli("hetu.outlines.get", { management_ref: context.grants.novel }).items[0].text).toContain("天亮前");
    await inspectLayout(page, "outlines", 'section[aria-label="作品大纲"]');
    await navigate(page, "小说");
    await openDirectory(page);
    await page.getByRole("button", { name: "第一章 雾港", exact: true }).click();
    await expect(page.locator(".manuscript-paper")).toContainText("江岚合上旧日记");
    await navigate(page, "返回创作库");
    await page.getByRole("button", { name: /默认剧本/ }).click();
    await navigate(page, "剧本");
    await openDirectory(page);
    await page.getByRole("button", { name: /雾港初见/ }).click();
    await expect(page.locator(".manuscript-paper")).toContainText("船还没来");
    await navigate(page, "返回创作库");
    await page.getByRole("button", { name: /默认视频/ }).click();
    await navigate(page, "视频");
    await page.getByRole("combobox", { name: "视频成果版本" }).selectOption(context.second.media_id);
    const video = page.locator('article.video-review-content video').first();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
    await video.evaluate((element: HTMLVideoElement) => element.play());
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.15);
    await video.evaluate((element: HTMLVideoElement) => element.pause());
    await page.getByRole("checkbox", { name: "指定片段", exact: true }).check();
    await page.getByRole("spinbutton", { name: "意见开始秒数" }).fill("0.2");
    await page.getByRole("spinbutton", { name: "意见结束秒数" }).fill("1.2");
    await page.getByRole("textbox", { name: "视频修改意见" }).fill("先听到脚步声，再切到门口。");
    await page.getByRole("button", { name: "保存意见", exact: true }).click();
    await expect(page.getByText("先听到脚步声，再切到门口。", { exact: true })).toBeVisible();
    const notes = cli("hetu.video.feedback.list", { management_ref: context.grants.video, work_ref: context.video, media_ref: context.second });
    expect(notes.items[0].feedback.range).toEqual({ start_tick: 200, end_tick: 1200 });
    expect(cli("hetu.video.feedback.list", { management_ref: context.grants.video, work_ref: context.video, media_ref: context.first }).total).toBe(0);
    await page.getByRole("button", { name: "查看前版", exact: true }).click();
    const previousVideo = page.getByRole("region", { name: "前版视频" }).locator("video");
    await expect(previousVideo).toHaveCount(1);
    await expect.poll(() => previousVideo.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
    await inspectLayout(page, "video", ".video-workbench");
    await page.getByRole("button", { name: "导出本版视频", exact: true }).click();
    await expect.poll(async () => (await readFile(exported).catch(() => Buffer.alloc(0))).length).toBe((await readFile(path.join(root, "apps/desktop/tests/fixtures/preview.mp4"))).length);
    expect(await readFile(exported)).toEqual(await readFile(path.join(root, "apps/desktop/tests/fixtures/preview.mp4")));
    client = new Client({ name: "baseline-e2e", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: path.join(root, "target/debug/hetu-mcp"), args: ["--client", "codex", "--collaboration-dir", collaboration], env: { ...process.env, HETU_PLUGIN_STATE_DIR: plugins } as Record<string, string> }));
    const result: any = await client.callTool({ name: "hetu_call_action", arguments: { action: "hetu.video.media.get", input: { management_ref: context.grants.video, work_ref: context.video, media_ref: context.second } } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const structured = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(structured.data.media.previous_media_ref).toEqual(context.first);
    expect((await page.evaluate(() => (window as any).hetuDesktop.state())).plugins).toEqual([]);
    await page.screenshot({ path: path.join(root, "output/baseline-video-review.png"), fullPage: true });
    await app.close(); app = undefined;
    await mkdir(plugins, { recursive: true });
    await writeFile(path.join(plugins, "plugin-state.json"), "损坏的可选插件登记");
    page = await launch();
    await page.getByRole("button", { name: /默认视频/ }).click();
    await navigate(page, "视频");
    await page.getByRole("combobox", { name: "视频成果版本" }).selectOption(context.second.media_id);
    await expect(page.getByText("先听到脚步声，再切到门口。", { exact: true })).toBeVisible();
    expect((await page.evaluate(() => (window as any).hetuDesktop.state())).plugin_state_error).toBeTruthy();
    expect(await readFile(path.join(plugins, "plugin-state.json"), "utf8")).toBe("损坏的可选插件登记");
    expect((await readdir(plugins).catch(() => [])).filter(name => name.endsWith(".plugin"))).toEqual([]);
  } finally { await client?.close(); await app?.close(); }
});
