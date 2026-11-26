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

async function open(page: Page, value = fixture(), theme: "light" | "dark" = "light", messages = false, extensions = false, context = false,localDrafts=false) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const testLocale = (value.structuredContent as { data: { request: { prompt_language: string } } }).data.request.prompt_language;
  await page.addInitScript(payload => { Object.assign(window, payload); }, { initialTask: value, viewHtml: html, testTheme: theme, testLocale, testMessages: messages, testExtensions: extensions, testContext: context,testLocalDrafts:localDrafts });
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

test("只读候选共用语义排版和可终止查找，不产生业务写入", async ({page}) => {
  const value = fixture();
  const payload = value.structuredContent as any;
  payload.data.submission.candidates = [{candidate_id: "reference", kind: "text", title: "固定参考稿", content: "# 固定参考稿\n\n**灯塔**照亮海面。\n\n灯塔回应🌿。"}];
  const {view, errors} = await open(page, value);
  const reader = view.getByRole("region", {name: "固定参考稿", exact: true});
  await expect(reader.locator(".manuscript-strong")).toHaveText("灯塔");
  await expect(reader.locator("article")).not.toContainText("# 固定参考稿");
  await reader.getByRole("button", {name: "正文查找", exact: true}).click();
  await reader.getByRole("textbox", {name: "搜索正文内容", exact: true}).fill("灯塔");
  await expect(reader).toContainText("1 / 2 处");
  await reader.getByRole("button", {name: "下一处", exact: true}).click();
  await expect(reader).toContainText("2 / 2 处");
  await expect(reader.getByRole("button", {name: "替换", exact: true})).toHaveCount(0);
  await reader.getByRole("button", {name: "原稿", exact: true}).click();
  await expect(reader.locator("article")).toContainText("**灯塔**");
  await expect(reader.locator("article")).toHaveCSS("font-family", /Courier/);
  expect(await page.evaluate(() => window.harness.calls)).toEqual([]);
  expect(errors).toEqual([]);
});

test("文稿候选共用小说和剧本排版，表现更新保留未保存意见及原稿", async ({ page }) => {
  const value = fixture(), source = ".INT. 灯塔 - NIGHT\r\n\r\n江岚合上日记。\r\n\r\n@江岚\r\n船来了吗？🌿";
  (value.structuredContent as any).data.submission.candidates = [{candidate_id: "text_reference", kind: "text", title: "夜航", content: source}];
  const {view, errors} = await open(page, value);
  await expect(view.locator(".reader")).toHaveCSS("font-size", "20px");
  await view.getByRole("checkbox").check();
  await view.getByLabel("补充要求或意见").fill("保留这个动作，尚未提交。");
  await page.evaluate(() => window.harness.context({theme: "dark", locale: "zh-CN", "hetu/reading": {kind: "screenplay", preferences: {
    document_theme: "paper", reading_profiles: {screenplay: {font_size: 22, line_height: 1.8}},
  }}}));
  await expect(view.locator(".screenplay-reader")).toHaveCSS("font-size", "22px");
  await expect(view.locator(".screenplay-character")).toHaveText("江岚");
  await expect(view.locator(".screenplay-dialogue")).toHaveText("船来了吗？🌿");
  await expect(view.getByRole("checkbox")).toBeChecked();
  await expect(view.getByLabel("补充要求或意见")).toHaveValue("保留这个动作，尚未提交。");
  expect(await view.locator("#app").evaluate(el => getComputedStyle(el).colorScheme)).toBe("light");
  expect(await page.evaluate(() => window.harness.calls)).toEqual([]);
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

test("stable task references retain their digest through nested choices and receipt recovery", async ({ page }) => {
  const value = fixture();
  const reference = { ...taskRef, sha256: "d".repeat(64) };
  (value.structuredContent as { data: Record<string, unknown> }).data.task_ref = reference;
  const { view, errors } = await open(page, value);
  await page.evaluate(() => { window.harness.saveMode = "lost"; });
  await view.getByRole("checkbox").first().check();
  await view.getByLabel("补充要求或意见").fill("保留原任务与这一版候选。");
  await view.getByRole("button", { name: "保存选择与意见", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("保存结果尚未确认");
  await view.getByRole("button", { name: "查询原保存结果", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("已记录偏好");
  const result = await page.evaluate(() => ({ calls: window.harness.calls, reads: window.harness.reads }));
  const writes = result.calls.filter(item => item.name === "hetu_save_task_selection");
  expect(writes).toHaveLength(1);
  expect(writes[0].arguments?.task_ref).toEqual(reference);
  expect(writes[0].arguments?.candidate_refs).toEqual([{ task_ref: reference, submission_id: "submission_test", candidate_id: "candidate_one" }]);
  expect(result.calls.find(item => item.name === "hetu_read_task_operation")?.arguments).toEqual({ task_ref: reference, action: "hetu.interactions.save_selection", key: writes[0].arguments?.operation_key });
  expect(result.reads).toEqual([]);
  await expect(view.getByRole("checkbox").first()).toBeChecked();
  expect(errors).toEqual([]);
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

for (const passage of [false, true]) test(`${passage ? "位置意见" : "方案偏好"}在指针按下后收到相同任务投影，抬起仍只保存一次`, async ({ page }) => {
  const value = fixture(), payload = value.structuredContent as any;
  payload.data.allowed_actions = ["hetu.task_feedback.save"];
  payload.data.submission.candidates = [{candidate_id: "reference", kind: "text", title: "固定参考稿", content: "江岚核对来信🌿，保留原句。"}];
  const {view, errors} = await open(page, value);
  const opinion = view.getByLabel("补充要求或意见", {exact: true});
  if (passage) {
    const candidate = view.locator(".candidate");
    await candidate.locator(".reader").evaluate(reader => {
      const span = Array.from(reader.querySelectorAll<HTMLElement>("[data-source-from]")).find(item => item.textContent?.includes("来信🌿"))!;
      const start = span.textContent!.indexOf("来信🌿"), range = document.createRange();
      range.setStart(span.firstChild!, start); range.setEnd(span.firstChild!, start + "来信🌿".length);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      reader.dispatchEvent(new MouseEvent("mouseup", {bubbles: true}));
    });
    await candidate.getByRole("button", {name: "对此处提意见", exact: true}).click();
    await expect(view.getByRole("region", {name: "意见所指原文", exact: true})).toContainText("来信🌿");
  }
  await opinion.fill("保留原句与意见，不重复保存。");
  const save = view.getByRole("button", {name: passage ? "保存位置意见" : "保存选择与意见", exact: true});
  await expect(save).toBeEnabled(); await save.scrollIntoViewIfNeeded();
  const bounds = await save.boundingBox(); expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await view.locator("body").evaluate(() => {
    const state = window as any; state.__projectionDelivered = false;
    const received = (event: MessageEvent) => {
      if (event.data?.method !== "ui/notifications/tool-result") return;
      window.removeEventListener("message", received);
      requestAnimationFrame(() => { state.__projectionDelivered = true; });
    };
    window.addEventListener("message", received);
  });
  await page.evaluate(value => window.harness.send(value), value);
  await expect.poll(() => view.locator("body").evaluate(() => (window as any).__projectionDelivered)).toBe(true);
  expect(await page.evaluate(() => window.harness.calls)).toEqual([]);
  await page.mouse.up();
  await expect(view.getByRole("status")).toContainText(passage ? "修改意见已保存" : "已记录偏好");
  const calls = await page.evaluate(() => window.harness.calls);
  const writes = calls.filter(item => item.name === (passage ? "hetu_save_task_feedback" : "hetu_save_task_selection"));
  expect(writes).toHaveLength(1);
  expect(writes[0].arguments?.[passage ? "public_comment" : "comment"]).toBe("保留原句与意见，不重复保存。");
  if (passage) expect((writes[0].arguments?.target_refs as any[])[0].range.quote).toBe("来信🌿");
  expect(errors).toEqual([]);
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
  await expect(view.locator(".candidate .badge")).toHaveText("图片候选");
  await image.evaluate(async image => { await (image as HTMLImageElement).decode(); });
  const dimensions = await image.evaluate(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, fit: getComputedStyle(image).objectFit }));
  expect(dimensions.width / dimensions.height).toBeCloseTo(2 / 3, 2);
  expect(dimensions.fit).toBe("contain");
  await expect(view.getByText("部分结果", { exact: true })).toBeVisible();
  await expect(view.getByText("缺少的结果: 第二张参考封面")).toBeVisible();
  await page.evaluate(async () => { await window.harness.teardown(); });
  await expect(view.getByRole("status")).toContainText("面板连接已结束");
  await expect(view.locator("#app")).toHaveAttribute("aria-busy", "false");
  await expect(view.getByRole("button", { name: "保存选择与意见", exact: true })).toHaveCount(0);
  await expect(view.locator("img")).toHaveCount(0);
});

test("a missing host ends loading and explains how to reopen the task", async ({ page }) => {
  await page.route(`${origin}/standalone`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/standalone`);
  await expect(page.getByRole("status")).toContainText("MCP Apps");
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
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
    await expect(view.locator("#app")).toHaveCSS("color-scheme",width===375?"light":"dark");
    expect(await view.locator("body").evaluate(body => body.scrollWidth > innerWidth)).toBe(false);
    expect(errors).toEqual([]);
    await mkdir("../../build/task-view/screenshots", { recursive: true });
    await page.screenshot({ path: `../../build/task-view/screenshots/${locale}-${width}.png`, fullPage: true });
  });
}

test("revision feedback is fixed before sending and host acceptance is not author approval", async ({ page }) => {
  const value = fixture();
  const content = value.structuredContent as { data: Record<string, unknown> };
  content.data.allowed_actions = ["hetu.task_feedback.save"];
  const reference = { ...taskRef, sha256: "d".repeat(64) }; content.data.task_ref = reference;
  const { view, errors } = await open(page, value, "light", true);
  await view.getByRole("checkbox").first().check();
  await view.getByLabel("补充要求或意见").fill("保留结尾，重写争执。");
  await view.getByRole("button", { name: "按此修改", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("修改意见已保存，尚未发送给 Agent");
  expect(await page.evaluate(() => window.harness.messages)).toEqual([]);
  const calls = await page.evaluate(() => window.harness.calls);
  const feedback = calls.find(item => item.name === "hetu_save_task_feedback")!;
  expect(feedback.arguments?.task_ref).toEqual(reference);
  expect(feedback.arguments?.selected_refs).toEqual([{ kind: "candidate", candidate_ref: { task_ref: reference, submission_id: "submission_test", candidate_id: "candidate_one" } }]);
  await expect(view.getByLabel("继续提示词")).toHaveValue(/feedback_test/);
  await view.getByRole("button", { name: "发送给当前 Agent", exact: true }).click();
  await expect(view.getByText("宿主已接收继续请求，等待后续稿。", { exact: true })).toBeVisible();
  await expect(view.getByRole("button", { name: "发送给当前 Agent", exact: true })).toBeDisabled();
  const messages = await page.evaluate(() => window.harness.messages);
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages)).toContain("feedback_test");
  expect(JSON.stringify(messages)).not.toContain("雾港听潮");
  expect((await page.evaluate(() => window.harness.calls)).filter(item => item.name === "hetu_save_task_feedback")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("lost feedback receipt recovers the same feedback and a host without messages offers a copy prompt", async ({ page }) => {
  const value = fixture();
  (value.structuredContent as { data: Record<string, unknown> }).data.allowed_actions = ["hetu.task_feedback.save"];
  const { view } = await open(page, value);
  await page.evaluate(() => { window.harness.saveMode = "lost"; });
  await view.getByLabel("补充要求或意见").fill("只重写争执。");
  await view.getByRole("button", { name: "按此修改", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("保存结果尚未确认");
  await view.getByRole("button", { name: "查询原保存结果", exact: true }).click();
  await expect(view.getByLabel("继续提示词")).toHaveValue(/feedback_test/);
  await expect(view.getByRole("button", { name: "发送给当前 Agent", exact: true })).toHaveCount(0);
  expect((await page.evaluate(() => window.harness.reads))[0]).toContain("action=hetu.task_feedback.save");
  expect((await page.evaluate(() => window.harness.calls)).filter(item => item.name === "hetu_save_task_feedback")).toHaveLength(1);
});

for (const target of ["active", "new"] as const) {
  test(`OpenAI ${target} draft preserves metadata without sending or adopting`, async ({ page }) => {
    const value = fixture();
    (value.structuredContent as { data: Record<string, unknown> }).data.allowed_actions = ["hetu.task_feedback.save"];
    const { view, errors } = await open(page, value, "light", true, true);
    await view.getByLabel("补充要求或意见").fill("保留人物动机，调整节奏。");
    await view.getByRole("button", { name: "按此修改", exact: true }).click();
    await view.getByRole("button", { name: target === "active" ? "放入当前草稿" : "在新对话中准备", exact: true }).click();
    await expect(view.getByText("已放入宿主草稿，尚未发送。", { exact: true })).toBeVisible();
    const wire = await page.evaluate(() => window.harness.wireMessages);
    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({ _meta: { "openai/message": { target, send: false } } });
    expect(JSON.stringify(wire)).toContain("feedback_test");
    expect(JSON.stringify(wire)).not.toContain("雾港听潮");
    await expect(view.getByRole("button", { name: "发送给当前 Agent", exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
  });
}

test("explicit model context attaches fixed references after revalidation without a message", async ({ page }) => {
  const value = fixture();
  const reference = { ...taskRef, sha256: "d".repeat(64) };
  (value.structuredContent as { data: Record<string, unknown> }).data.task_ref = reference;
  const { view, errors } = await open(page, value, "dark", true, true, true);
  expect(await page.evaluate(() => window.harness.contexts)).toEqual([]);
  await view.getByRole("checkbox").first().check();
  await view.getByRole("button", { name: "附加当前任务", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("当前任务引用已附加");
  const context = await page.evaluate(() => ({ contexts: window.harness.contexts, messages: window.harness.messages, calls: window.harness.calls }));
  expect(context.contexts).toHaveLength(1);
  expect(context.messages).toEqual([]);
  expect(JSON.stringify(context.contexts)).toContain(reference.sha256);
  expect(JSON.stringify(context.contexts)).toContain("candidate_one");
  expect(JSON.stringify(context.contexts)).not.toContain("雾港听潮");
  expect(context.calls.at(-1)).toMatchObject({ name: "hetu_open_task_view", arguments: { task_ref: reference } });
  expect(errors).toEqual([]);
});

for (const mode of ["rejected", "lost"] as const) {
  test(`host message ${mode} preserves the saved feedback without automatic resend`, async ({ page }) => {
    const value = fixture("en");
    (value.structuredContent as { data: Record<string, unknown> }).data.allowed_actions = ["hetu.task_feedback.save"];
    const { view } = await open(page, value, "light", true);
    await page.evaluate(value => { window.harness.messageMode = value; }, mode);
    await view.getByLabel("Requirements or feedback").fill("Keep the ending; rewrite the argument.");
    await view.getByRole("button", { name: "Request changes", exact: true }).click();
    await view.getByRole("button", { name: "Send to current agent", exact: true }).click();
    await expect(view.getByText(mode === "rejected" ? "The host did not accept the request. Copy the prompt below." : "Message delivery is unconfirmed. Check this conversation before resending.", { exact: true })).toBeVisible();
    await expect(view.getByLabel("Continuation prompt")).toHaveValue(/feedback_test/);
    expect(await page.evaluate(() => window.harness.messages.length)).toBe(1);
    await expect(view.getByRole("button", { name: "Send to current agent", exact: true })).toBeDisabled();
  });
}

for(const target of ["active","new"] as const)test(`本机${target}反馈交接仅建立草稿，不暴露直接发送`,async({page})=>{
 const value=fixture();(value.structuredContent as any).data.allowed_actions=["hetu.task_feedback.save"];
 const {view,errors}=await open(page,value,"light",true,false,false,true);
 await view.getByLabel("补充要求或意见").fill("保留原任务，加入钟声。");
 await view.getByRole("button",{name:"按此修改",exact:true}).click();
 await expect(view.getByRole("button",{name:"发送给当前 Agent",exact:true})).toHaveCount(0);
 await view.getByRole("button",{name:target==="active"?"放入当前草稿":"在新对话中准备",exact:true}).click();
 await expect(view.getByText("已放入宿主草稿，尚未发送。",{exact:true})).toBeVisible();
 const wire=await page.evaluate(()=>window.harness.wireMessages);
 expect(wire).toHaveLength(1);expect(wire[0]).toMatchObject({_meta:{"hetu/message":{target,send:false}}});
 expect(JSON.stringify(wire)).toContain("feedback_test");expect(errors).toEqual([]);
});
