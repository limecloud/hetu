import { test, expect } from "@playwright/test";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";

let client: Client;
let server: Server;
let origin: string;
let html: string;
let initialTask: CallToolResult;
let taskRef: Record<string, unknown>;

test.beforeAll(async () => {
  test.setTimeout(60_000);
  const folder = await mkdtemp(join(tmpdir(), "hetu-apps-integration-"));
  const fixture = spawnSync(resolve("../../target/debug/examples/task_view_fixture"), [folder], { encoding: "utf8" });
  if (fixture.status !== 0) throw new Error(fixture.stderr || "Fixture failed");
  taskRef = JSON.parse(fixture.stdout).task_ref;
  client = new Client({ name: "hetu-browser-integration-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  await client.connect(new StdioClientTransport({ command: resolve("../../target/debug/hetu-mcp"), args: ["--workspace", folder, "--task", String(taskRef.task_id)], stderr: "pipe" }));
  const tools = await client.listTools();
  const uri = (tools.tools.find(tool => tool.name === "hetu_open_task_view")?._meta?.ui as { resourceUri?: string })?.resourceUri;
  if (!uri) throw new Error("Native server did not advertise an Apps resource");
  const resource = await client.readResource({ uri });
  if (!("text" in resource.contents[0])) throw new Error("Native UI resource has no HTML");
  html = resource.contents[0].text;
  initialTask = await client.callTool({ name: "hetu_open_task_view", arguments: { task_ref: taskRef } });
  const host = await build({ entryPoints: ["tests/host.ts"], bundle: true, write: false, format: "esm", target: "es2022" });
  server = createServer(async (request, response) => {
    try {
      if (request.url === "/rpc" && request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const { method, params } = JSON.parse(Buffer.concat(chunks).toString());
        const result = method === "tools/call" ? await client.callTool(params) : method === "resources/read" ? await client.readResource(params) : null;
        if (!result) throw new Error("Unexpected bridge method");
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
      } else if (request.url === "/host.js") {
        response.setHeader("Content-Type", "application/javascript"); response.end(host.outputFiles[0].text);
      } else {
        response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><head><meta charset="utf-8"><title>Native integration host</title></head><body><script type="module" src="/host.js"></script></body></html>');
      }
    } catch { response.writeHead(500); response.end("Integration bridge failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local integration address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (client) await client.close();
});

test("native stdio → SDK resource → sandboxed Apps → persisted preference → native readback", async ({ page }) => {
  await page.addInitScript(value => { Object.assign(window, value); }, { initialTask, viewHtml: html, realTask: true });
  await page.goto(origin);
  const view = page.frameLocator("iframe");
  await expect(view.getByRole("checkbox").first()).toBeEnabled();
  await expect(view.getByText("雾港听潮", { exact: true })).toBeVisible();
  await view.getByRole("checkbox").first().check();
  await view.getByLabel("补充要求或意见").fill("选第一项作为讨论方向，保留作者定稿权。🌿");
  await view.getByRole("button", { name: "保存选择与意见", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("已记录偏好，尚未采纳");
  const loaded = await client.callTool({ name: "hetu_read_creative_task", arguments: { task_ref: taskRef } });
  const data = (loaded.structuredContent as { data: { decision: { comment: string; candidate_refs: { task_ref: unknown }[]; effect: string } } }).data;
  expect(data.decision.comment).toBe("选第一项作为讨论方向，保留作者定稿权。🌿");
  expect(data.decision.effect).toBe("preference_only");
  expect(data.decision.candidate_refs).toHaveLength(1);
  expect(data.decision.candidate_refs[0].task_ref).toEqual(taskRef);
  const forbidden = await client.callTool({ name: "hetu_save_task_selection", arguments: { task_ref: taskRef, expected: { revision: 1, sha256: "a".repeat(64) }, candidate_refs: [], comment: "旧修订不能覆盖", operation_key: "stale-bridge-save" } });
  expect((forbidden.structuredContent as { error: { code: string } }).error.code).toBe("revision_conflict");
});
