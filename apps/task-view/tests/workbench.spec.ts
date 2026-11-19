import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";

let server: Server, origin: string, html: string;
const work = { workspace_id: "workspace_11111111-1111-4111-8111-111111111111", kind: "novel", object_id: "novel_11111111-1111-4111-8111-111111111111" };
const management = { scope_ref: { kind: "workspace", id: work.workspace_id }, grant_id: "a".repeat(64), grant_revision: 1 };
const actions = {
  "hetu.works.get": { summary: { title: "雾港", work_ref: work }, record: { metadata: { title: "雾港", synopsis: "循着旧灯塔寻找失踪的人。" } } },
  "hetu.novels.get": { novel: { metadata: { title: "雾港" }, volumes: [{ title: "第一卷" }], chapters: [{ title: "潮水", document_id: "doc_first", current_revision_id: "rev_first" }] } },
  "hetu.documents.get": { document: { title: "潮水" }, content: "潮水退后，石阶上留下了一盏灯。", revision: { revision_id: "rev_first", sha256: "b".repeat(64) } },
  "hetu.outlines.get": { outline: { title: "灯塔的秘密", content: "失踪与归来。" } },
  "hetu.blueprints.get": { blueprint: { characters: [{ name: "沈砚", description: "旧灯塔的守护人。" }] } },
  "hetu.creative_tasks.list": { tasks: [] }, "hetu.resources.list": { resources: [{ title: "港口考据", body: "潮汐与航运。" }] },
  "hetu.assets.list": { assets: [] }, "hetu.cues.list": { cues: [] }, "hetu.reviews.list": { reviews: [] },
  "hetu.reports.list": { reports: [] }, "hetu.work_links.list": { links: [] }, "hetu.git.status": { dirty: false },
  "hetu.agent_operations.list": { operations: [{ summary: "固定交付方案", state: "pending" }] },
  "hetu.plugins.inspect": { packages: [{ name: "山海", version: "0.2.0", enabled: true }] },
  "hetu.local_settings.get": { preferences: { appearance: "dark", font_size: 18 } },
  "hetu.model_settings.inspect": { channels: [{ name: "作者渠道", configured: true }] },
};
test.beforeAll(async () => {
  html = await readFile("../mcp/resources/workbench.html", "utf8");
  const host = await build({ entryPoints: ["tests/host.ts"], bundle: true, write: false, format: "esm", target: "es2022" });
  server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/host.js" ? "application/javascript" : "text/html"); res.end(req.url === "/host.js" ? host.outputFiles[0].text : '<!doctype html><meta charset="utf-8"><script type="module" src="/host.js"></script>'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No host"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
async function open(page: Page, bound = true, deepLink?: string) {
  await page.addInitScript(value => Object.assign(window, value), { viewHtml: html, initialTask: { content: [], structuredContent: { status: "succeeded", data: { app: bound ? { route: "works", management_ref: management } : { route: "home" }, ...(bound ? { works: [{ title: "雾港", work_ref: work }] } : {}) } } }, testActions: actions, testExtensions: true, testMessages: true, testDeepLink: deepLink });
  await page.goto(origin);
  const view = page.frameLocator("iframe"); await expect(view.getByRole("heading", { name: "河图洛书", exact: true })).toBeVisible(); return view;
}
test("empty global entry does not enumerate works, grants or files", async ({ page }) => {
  const view = await open(page, false);
  await expect(view.getByText(/尚未打开获权作品/)).toBeVisible();
  expect(await page.evaluate(() => window.harness.calls)).toEqual([]);
  await expect(view.getByRole("button", { name: "本机设置", exact: true })).toBeVisible();
});
test("workbench follows exact work and fixed document references across domain views", async ({ page }) => {
  const view = await open(page);
  await view.getByRole("button", { name: "打开作品", exact: true }).click();
  await expect(view.getByText("循着旧灯塔寻找失踪的人。", { exact: true })).toBeVisible();
  await view.getByRole("button", { name: "正文与分集", exact: true }).click();
  await expect(view.getByText("第一卷", { exact: true })).toBeVisible();
  await view.getByRole("button", { name: "阅读正文", exact: true }).click();
  await expect(view.getByText("潮水退后，石阶上留下了一盏灯。", { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => window.harness.calls);
  const read = calls.find(c => c.name === "hetu_call_action" && c.arguments?.action === "hetu.documents.get");
  expect(read?.arguments?.input).toMatchObject({ document_id: "doc_first", revision_id: "rev_first", management_ref: management, work_ref: work });
});
test("drama episode with an empty author draft displays its fixed submitted reference", async ({ page }) => {
  const drama = { ...work, kind: "drama", object_id: "drama_fixture" };
  const reference = { kind: "submitted", title: "渡口参考稿", draft_ref: { draft_id: "draft_fixed", revision: 1 }, sha256: "b".repeat(64) };
  await page.addInitScript(value => Object.assign(window, value), {
    viewHtml: html, initialTask: { content: [], structuredContent: { status: "succeeded", data: { app: { route: "works", management_ref: management }, works: [{ title: "渡口剧本", work_ref: drama }] } } },
    testActions: { ...actions,
      "hetu.drama.projects.get": { episodes: [{ episode: { title: "渡口", episode_id: "depisode_fixed" } }] },
      "hetu.drama.episodes.get": { episode: { title: "渡口" }, manuscript: { author_has_content: false, author_state: "empty", references: [reference] } },
      "hetu.drafts.get": { draft: { revision: 1, content_sha256: reference.sha256 }, content: "INT. 渡口 - 夜\n\n江岚\n船还没来。" },
    },
  });
  await page.goto(origin); const view = page.frameLocator("iframe");
  await view.getByRole("button", { name: "打开作品", exact: true }).click();
  await view.getByRole("button", { name: "正文与分集", exact: true }).click();
  await view.getByRole("button", { name: "阅读分集", exact: true }).click();
  await expect(view.getByText(/船还没来/)).toBeVisible();
  await expect(view.getByRole("heading", { name: "最新提交参考稿", exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.harness.calls)).every(call => !/save|adopt|finalize/.test(String(call.arguments?.action)))).toBe(true);
});
test("all work areas use existing reads and explicit AI drafts without exposing grants", async ({ page }) => {
  const view = await open(page);
  await view.getByRole("button", { name: "打开作品", exact: true }).click();
  for (const name of ["大纲", "设定", "任务与参考稿", "资料", "图片与素材", "创作线索", "审核", "检查", "关联作品", "版本", "导入与交付", "操作方案", "插件", "本机设置", "模型渠道"]) {
    await view.getByRole("button", { name, exact: true }).click();
    await expect(view.locator(".workbench-content > h2")).toHaveText(name);
    await expect(view.getByRole("alert")).toHaveCount(0);
  }
  await view.getByRole("button", { name: "让 AI 处理", exact: true }).click();
  await view.getByLabel("创作目标").fill("检查连接状态，保留现有渠道。");
  await view.getByRole("button", { name: "放入当前草稿", exact: true }).click();
  await expect(view.getByText("请求已放入草稿，尚未发送。", { exact: true })).toBeVisible();
  const messages = await page.evaluate(() => window.harness.wireMessages);
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages)).not.toContain("grant_id");
  expect(JSON.stringify(messages)).not.toContain(management.grant_id);
  expect(messages[0]).toMatchObject({ _meta: { "openai/message": { target: "active", send: false } } });
});
test("malicious deep links never become task or file access", async ({ page }) => {
  const view = await open(page, false, "/tasks/workspace/../../private?management_ref=secret");
  await expect(view.getByText(/尚未打开获权作品/)).toBeVisible();
  expect(await page.evaluate(() => window.harness.calls)).toEqual([]);
});
for (const width of [375, 1180]) test(`workbench at ${width}px keeps scoped navigation and content in bounds`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  const view = await open(page);
  await view.getByRole("button", { name: "打开作品", exact: true }).click();
  expect(await view.locator("body").evaluate(node => node.scrollWidth <= innerWidth)).toBe(true);
  await mkdir("../../build/task-view/acceptance", { recursive: true });
  await page.screenshot({ path: `../../build/task-view/acceptance/workbench-${width}.png`, fullPage: true });
});
