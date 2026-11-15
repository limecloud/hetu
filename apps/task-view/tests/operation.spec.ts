import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
let server: Server, origin: string, html: string;
test.beforeAll(async () => {
  html = await readFile("../mcp/resources/operation-view.html", "utf8");
  const host = await build({ entryPoints: ["tests/host.ts"], bundle: true, write: false, format: "esm", target: "es2022" });
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/host.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/host.js" ? host.outputFiles[0].text : '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/host.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No host");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
for (const locale of ["zh-CN", "en"]) for (const kind of ["work", "local"]) {
  test(locale + " " + kind + " operation reads exact identity without authority", async ({ page }) => {
    const management = { grant_id: "a".repeat(64), grant_revision: 2, scope_ref: { kind: "workspace", id: "workspace_test" } };
    const data = kind === "work"
      ? { proposal_id: "proposal_test", state: "pending", summary: "整理第二章", changes: [{ before: "旧章名", after: "第二章 渡口" }], input: { title: "第二章 渡口" } }
      : { operation_id: "localop_test", state: "pending", fixed: { summary: "调整阅读字号", patch: { font_size: 20 } } };
    await page.addInitScript(payload => Object.assign(window, payload), {
      initialTask: { content: [], structuredContent: { status: "succeeded", data } },
      viewHtml: html, testLocale: locale, operationInput: kind === "work" ? { management_ref: management } : {},
    });
    await page.goto(origin);
    const view = page.frameLocator("iframe");
    await expect(view.getByRole("heading", { level: 1 })).toHaveText(locale === "en" ? "Inspect operation" : "查看操作方案");
    await expect(view.getByRole("button", { name: locale === "en" ? "Refresh status" : "刷新状态" })).toBeEnabled();
    await expect(view.getByRole("button", { name: /approve|批准|执行/i })).toHaveCount(0);
    await view.getByRole("button", { name: locale === "en" ? "Refresh status" : "刷新状态" }).click();
    await expect.poll(() => page.evaluate(() => window.harness.calls)).toHaveLength(1);
    const calls = await page.evaluate(() => window.harness.calls);
    expect({ name: calls[0].name, arguments: calls[0].arguments }).toEqual(kind === "work"
      ? { name: "hetu_get_management_operation", arguments: { management_ref: management, proposal_id: "proposal_test" } }
      : { name: "hetu_local_settings_get_operation", arguments: { operation_id: "localop_test" } });
    await page.evaluate(() => window.harness.send({ content: [], structuredContent: { status: "blocked", error: { code: "forbidden" } } }));
    await expect(view.getByRole("alert")).toBeVisible();
    await expect(view.getByRole("heading", { level: 2 })).toHaveCount(0);
  });
}
