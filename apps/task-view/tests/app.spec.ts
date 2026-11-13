import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { CallToolResult } from "@modelcontextprotocol/client";

const taskRef = { scope_ref: { kind: "workspace", id: "workspace_test" }, task_id: "task_test", request_revision: 1 };
const fixture = (locale = "zh-CN"): CallToolResult => ({ content: [], structuredContent: { status: "succeeded", data: {
  request: { ...taskRef, task_kind: "book_concept", brief: locale === "en" ? "A mystery set in a riverside town." : "一座河港的悬疑故事，保持我的叙述风格。", prompt_language: locale, input_snapshot: { sources: [] } },
  expected: { revision: 2, sha256: "a".repeat(64) }, observation: { state: "result_received" }, decision: null,
  submission: { submission_id: "submission_test", complete: true, missing_items: [], candidates: [
    { candidate_id: "candidate_one", kind: "title", title: locale === "en" ? "Option one" : "方案一", content: locale === "en" ? "The River Lights" : "雾港听潮" },
    { candidate_id: "candidate_two", kind: "text", title: locale === "en" ? "Revision reference" : "局部改稿参考", patches: [{ byte_start: 6, byte_end: 15, quote: "灯亮了", replacement: "灯影轻晃" }] },
  ] }, image_previews: [], effect: "preference_only",
} } });
let server: Server;
let origin: string;
let html: string;

test.beforeAll(async () => {
  html = await readFile("../mcp/resources/task-view.html", "utf8");
  const host = await build({ entryPoints: ["tests/host.ts"], bundle: true, write: false, format: "esm", target: "es2022" });
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/host.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/host.js" ? host.outputFiles[0].text : '<!doctype html><html><head><meta charset="utf-8"><title>Contract host</title></head><body><script type="module" src="/host.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing host address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

async function open(page: Page, value = fixture(), theme: "light" | "dark" = "light") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const testLocale = (value.structuredContent as { data: { request: { prompt_language: string } } }).data.request.prompt_language;
  await page.addInitScript(payload => { Object.assign(window, payload); }, { initialTask: value, viewHtml: html, testTheme: theme, testLocale });
  await page.goto(origin);
  const view = page.frameLocator("iframe");
  await expect(view.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(view.getByRole("checkbox").first()).toBeEnabled();
  return { view, errors };
}

test("Chinese preferences persist through the official Apps bridge without adoption", async ({ page }) => {
  const { view, errors } = await open(page);
  await expect(view.locator("del")).toContainText("灯亮了");
  await expect(view.locator("ins")).toContainText("灯影轻晃");
  await view.getByRole("checkbox").first().check();
  await view.getByLabel("补充要求或意见").fill("保留悬念，暂不采纳。🌿");
  await view.getByRole("button", { name: "保存选择与意见", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("已记录偏好，尚未采纳");
  const calls = await page.evaluate(() => window.harness.calls);
  expect(calls.map(item => item.name)).toEqual(["hetu_save_task_selection", "hetu_open_task_view"]);
  expect(calls[0].arguments?.task_ref).toEqual(taskRef);
  expect(calls[0].arguments?.candidate_refs).toEqual([{ task_ref: taskRef, submission_id: "submission_test", candidate_id: "candidate_one" }]);
  await expect(view.getByRole("checkbox").first()).toBeChecked();
  expect(errors).toEqual([]);
});

test("lost save receipts are queried by their original key, not resubmitted", async ({ page }) => {
  const { view } = await open(page);
  await page.evaluate(() => { window.harness.saveMode = "lost"; });
  await view.getByRole("checkbox").first().check();
  await view.getByRole("button", { name: "保存选择与意见", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("保存结果尚未确认");
  await expect(view.getByLabel("补充要求或意见")).toBeDisabled();
  await view.getByRole("button", { name: "查询原保存结果", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("已记录偏好");
  const result = await page.evaluate(() => ({ calls: window.harness.calls, reads: window.harness.reads }));
  expect(result.calls.filter(item => item.name === "hetu_save_task_selection")).toHaveLength(1);
  expect(result.reads).toHaveLength(1);
  expect(result.reads[0]).toContain(encodeURIComponent(String(result.calls[0].arguments?.operation_key)));
});

test("unsaved choices survive new results and cannot be applied against a stale revision", async ({ page }) => {
  const { view } = await open(page);
  await view.getByLabel("补充要求或意见").fill("我的意见保留");
  const next = fixture();
  (next.structuredContent as { data: { expected: { sha256: string } } }).data.expected.sha256 = "c".repeat(64);
  await page.evaluate(value => window.harness.send(value), next);
  await expect(view.getByRole("status")).toContainText("任务收到新结果");
  await expect(view.getByLabel("补充要求或意见")).toHaveValue("我的意见保留");
  await expect(view.getByRole("button", { name: "保存选择与意见", exact: true })).toBeDisabled();
  await view.getByRole("button", { name: "放弃未保存选择并读取最新结果" }).click();
  await expect(view.getByLabel("补充要求或意见")).toHaveValue("");
  await expect(view.getByRole("button", { name: "保存选择与意见", exact: true })).toBeEnabled();
});

test("missing receipts retry with the same operation key, and conflicts preserve feedback", async ({ page }) => {
  const { view } = await open(page);
  await page.evaluate(() => { window.harness.saveMode = "absent"; });
  await view.getByLabel("补充要求或意见").fill("等待作者核对");
  await view.getByRole("button", { name: "保存选择与意见", exact: true }).click();
  await view.getByRole("button", { name: "查询原保存结果", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("尚未找到原操作");
  await page.evaluate(() => { window.harness.saveMode = "conflict"; });
  await view.getByRole("button", { name: "沿原键重试保存", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("revision_conflict");
  await expect(view.getByLabel("补充要求或意见")).toHaveValue("等待作者核对");
  const writes = await page.evaluate(() => window.harness.calls.filter(item => item.name === "hetu_save_task_selection"));
  expect(writes).toHaveLength(2);
  expect(writes[0].arguments).toEqual(writes[1].arguments);
});

test("cover previews decode locally and preserve the original aspect ratio", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 1000 });
  const value = fixture();
  const data = (value.structuredContent as { data: Record<string, unknown> }).data;
  data.submission = { submission_id: "submission_test", complete: false, missing_items: ["第二张参考封面"], candidates: [{ candidate_id: "candidate_cover", kind: "image", title: "封面参考", width: 768, height: 1152 }] };
  data.image_previews = [{ candidate_id: "candidate_cover", media_type: "image/jpeg", base64: (await readFile("../../assets/illustrations/library/cover-river-jade.jpg")).toString("base64"), width: 768, height: 1152 }];
  const { view } = await open(page, value);
  const image = view.getByRole("img", { name: "封面参考" });
  await image.evaluate(async image => { await (image as HTMLImageElement).decode(); });
  const dimensions = await image.evaluate(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, fit: getComputedStyle(image).objectFit }));
  expect(dimensions.width / dimensions.height).toBeCloseTo(2 / 3, 2);
  expect(dimensions.fit).toBe("contain");
  await expect(view.getByText("部分结果", { exact: true })).toBeVisible();
  await expect(view.getByText("缺少的结果: 第二张参考封面")).toBeVisible();
  await page.evaluate(async () => { await window.harness.teardown(); });
  await expect(view.getByRole("button", { name: "保存选择与意见", exact: true })).toBeDisabled();
});

test("task changes and untrusted candidate markup cannot escape the bound view", async ({ page }) => {
  const value = fixture();
  const data = (value.structuredContent as { data: { submission: { candidates: { content?: string }[] } } }).data;
  data.submission.candidates[0].content = '<img src="https://invalid.test/leak" onerror="window.evil=true">';
  const network: string[] = [];
  page.on("request", request => { if (!request.url().startsWith(origin)) network.push(request.url()); });
  const { view } = await open(page, value);
  await expect(view.locator(".content").first()).toContainText("<img src=");
  expect(await view.locator("img").count()).toBe(0);
  const other = fixture();
  (other.structuredContent as { data: { request: { task_id: string } } }).data.request.task_id = "task_other";
  await page.evaluate(next => window.harness.send(next), other);
  await expect(view.getByRole("status")).toContainText("不能切换作品或任务");
  expect(network).toEqual([]);
});

for (const locale of ["zh-CN", "en"]) for (const width of [375, 1180]) {
  test(`${locale} ${width}px view remains readable without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { view, errors } = await open(page, fixture(locale), width === 375 ? "light" : "dark");
    await expect(view.getByRole("heading", { level: 1 })).toHaveText(locale === "en" ? "Compare references" : "比较参考方案");
    expect(await view.locator("body").evaluate(body => body.scrollWidth > innerWidth)).toBe(false);
    expect(errors).toEqual([]);
    await mkdir("../../build/task-view/screenshots", { recursive: true });
    await page.screenshot({ path: `../../build/task-view/screenshots/${locale}-${width}.png`, fullPage: true });
  });
}
