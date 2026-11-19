import { test, expect } from "@playwright/test";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";

let client: Client;
let server: Server;
let origin: string;
let html: string;
let initialTask: CallToolResult;
let taskRef: Record<string, unknown>;
let managementClient: Client;
let managementRef: Record<string, unknown>;
let proposalID: string;

test.beforeAll(async () => {
  test.setTimeout(60_000);
  const cargoTarget = resolve(process.env.HETU_CARGO_TARGET_DIR ?? "../../target");
  const folder = await mkdtemp(join(tmpdir(), "hetu-apps-integration-"));
  const collaboration = await mkdtemp(join(tmpdir(), "hetu-apps-collaboration-"));
  const fixture = spawnSync(resolve(cargoTarget, "debug/examples/task_view_fixture"), [folder, collaboration], { encoding: "utf8" });
  if (fixture.status !== 0) throw new Error(fixture.stderr || "Fixture failed");
  taskRef = JSON.parse(fixture.stdout).task_ref;
  managementRef = JSON.parse(fixture.stdout).management_ref;
  proposalID = JSON.parse(fixture.stdout).proposal_id;
  managementClient = new Client({ name: "hetu-operation-integration-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  await managementClient.connect(new StdioClientTransport({ command: resolve(cargoTarget, "debug/hetu-mcp"), args: ["--client", "codex", "--collaboration-dir", collaboration], stderr: "pipe" }));
  client = new Client({ name: "hetu-browser-integration-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  await client.connect(new StdioClientTransport({ command: resolve(cargoTarget, "debug/hetu-mcp"), args: ["--workspace", folder, "--task", String(taskRef.task_id)], stderr: "pipe" }));
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
        const active = params?.name === "hetu_get_management_operation" || ["hetu_open_app", "hetu_call_action", "hetu_inspect_collaboration"].includes(params?.name) ? managementClient : client;
        const result = method === "tools/call" ? await active.callTool(params) : method === "resources/read" ? await active.readResource(params) : null;
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
  if (managementClient) await managementClient.close();
});

test("real workbench opens authorized novel, drama and video through portable tools and plays verified bytes", async ({ page }) => {
  test.setTimeout(60_000);
  const initial = await managementClient.callTool({ name: "hetu_open_app", arguments: { management_ref: managementRef } });
  const resource = await managementClient.readResource({ uri: "ui://hetu/workbench/1" });
  if (!("text" in resource.contents[0])) throw new Error("Missing workbench");
  const manifest = JSON.parse(await readFile("../mcp/resources/workbench.manifest.json", "utf8"));
  expect(createHash("sha256").update(resource.contents[0].text).digest("hex")).toBe(manifest.sha256);
  await page.addInitScript(value => Object.assign(window, value), { initialTask: initial, viewHtml: resource.contents[0].text, realTask: true, workbenchMode: true });
  await page.goto(origin);
  const view = page.frameLocator("iframe");
  await view.getByRole("button", { name: "打开作品 河港视频", exact: true }).click();
  await expect(view.getByRole("alert")).toHaveCount(0);
  await view.getByRole("button", { name: "视频", exact: true }).click();
  await view.getByRole("button", { name: "查看分集成果", exact: true }).click();
  await view.getByRole("button", { name: "查看固定媒体", exact: true }).click();
  await view.getByRole("button", { name: "预览媒体", exact: true }).click();
  const player = view.locator("video");
  await expect(player).toBeVisible();
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => Number.isFinite(node.duration) && node.duration > 0)).toBe(true);
  await player.evaluate((node: HTMLVideoElement) => { node.muted = true; return node.play(); });
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0);
  await view.getByRole("button", { name: "返回创作库", exact: true }).click();
  await view.getByRole("button", { name: "打开作品 河港剧本", exact: true }).click();
  await view.getByRole("button", { name: "剧本", exact: true }).click();
  await expect(view.getByText("河港剧本", { exact: true }).last()).toBeVisible();
  await expect(view.getByRole("alert")).toHaveCount(0);
});

test("stable management → real operation resource → sandboxed review keeps the author decision separate", async ({ page }) => {
  const initial = await managementClient.callTool({ name: "hetu_get_management_operation", arguments: { management_ref: managementRef, proposal_id: proposalID } });
  const resource = await managementClient.readResource({ uri: "ui://hetu/operation-view/1" });
  if (!("text" in resource.contents[0])) throw new Error("Missing operation view");
  await page.addInitScript(value => Object.assign(window, value), { initialTask: initial, viewHtml: resource.contents[0].text, realTask: true, operationInput: { management_ref: managementRef } });
  await page.goto(origin);
  const view = page.frameLocator("iframe");
  await expect(view.getByRole("heading", { name: "查看操作方案", exact: true })).toBeVisible();
  await expect(view.getByText("整理作品资料，等待作者确认", { exact: true })).toBeVisible();
  await expect(view.getByRole("button", { name: /批准|执行/ })).toHaveCount(0);
  await view.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(view.getByRole("button", { name: "刷新状态", exact: true })).toBeEnabled();
  await expect(view.getByText("整理作品资料，等待作者确认", { exact: true })).toBeVisible();
  const loaded = await managementClient.callTool({ name: "hetu_get_management_operation", arguments: { management_ref: managementRef, proposal_id: proposalID } });
  expect((loaded.structuredContent as { data: { state: string } }).data.state).toBe("pending");
  await page.screenshot({ path: resolve("../../output/ai-first-acceptance-20261115/mcp-operation-review.png"), fullPage: true });
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

test("real Apps feedback continues the original working reference and remains separate from adoption", async ({ page }) => {
  const current = await client.callTool({ name: "hetu_open_task_view", arguments: { task_ref: taskRef } });
  await page.addInitScript(value => { Object.assign(window, value); }, { initialTask: current, viewHtml: html, realTask: true });
  await page.goto(origin);
  const view = page.frameLocator("iframe");
  await view.getByRole("checkbox").first().check();
  await view.getByLabel("补充要求或意见").fill("保留河港意象，缩短书名。");
  await view.getByRole("button", { name: "按此修改", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("修改意见已保存");
  await expect(view.getByRole("button", { name: "发送给当前 Agent", exact: true })).toHaveCount(0);
  const feedback = await client.callTool({ name: "hetu_list_task_feedback", arguments: { task_ref: taskRef } });
  const items = (feedback.structuredContent as { data: { feedback: { feedback_ref: unknown; feedback: { public_comment: string } }[] } }).data.feedback;
  expect(items.at(-1)?.feedback.public_comment).toBe("保留河港意象，缩短书名。");
  const refs = [items.at(-1)!.feedback_ref];
  const created = await client.callTool({ name: "hetu_create_working_copy", arguments: { task_ref: taskRef, artifact_kind: "title", source_format: "plain", title: "书名返工", base_refs: [], content: "雾港", feedback_refs: refs, operation_key: "real-apps-followup" } });
  const copy = (created.structuredContent as { data: { working_copy_ref: unknown } }).data.working_copy_ref;
  expect(copy).toBeTruthy();
  const task = await client.callTool({ name: "hetu_read_creative_task", arguments: { task_ref: taskRef } });
  const requestSHA = (task.structuredContent as { data: { request_sha256: string } }).data.request_sha256;
  const submitted = await client.callTool({ name: "hetu_submit_creative_result", arguments: { task_ref: taskRef, request_sha256: requestSHA, working_copy_refs: [copy], feedback_refs: refs, complete: true, missing_items: [], provenance: { client: "real-apps-test", skill_version: "1" }, operation_key: "real-apps-submit" } });
  expect((submitted.structuredContent as { status: string }).status).toBe("succeeded");
  await view.getByRole("button", { name: "读取最新结果", exact: true }).click();
  await expect(view.getByText("雾港", { exact: true })).toBeVisible();
  await expect(view.getByText("已收到针对这条意见的新方案，请核对修改。", { exact: true })).toBeVisible();
});
