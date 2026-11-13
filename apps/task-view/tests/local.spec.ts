import { test, expect, type BrowserContext } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

type Message = Record<string, unknown>;
// 每例建立独立的 Rust 文件事务及 MCP 进程；预算包含夹具初始化和真实传输。
test.setTimeout(60_000);
class LocalFixture {
  child!: ChildProcessWithoutNullStreams;
  client!: Client;
  ref!: Record<string, unknown>;
  origin = "";
  viewID = randomUUID();
  messages: Message[] = [];
  calls: Message[] = [];
  loseSave = false;
  async start(options: { locale?: string; lifetime?: number } = {}) {
    const folder = await mkdtemp(join(tmpdir(), "hetu-local-view-"));
    const fixture = spawnSync(resolve("../../target/debug/examples/task_view_fixture"), [folder], { encoding: "utf8" });
    if (fixture.status !== 0) throw new Error(fixture.stderr);
    this.ref = JSON.parse(fixture.stdout).task_ref;
    this.client = new Client({ name: "local-page-native-adapter-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await this.client.connect(new StdioClientTransport({ command: resolve("../../target/debug/hetu-mcp"), args: ["--workspace", folder, "--task", String(this.ref.task_id)], stderr: "pipe" }));
    this.child = spawn(process.execPath, [resolve("resources/local/server.mjs")], { stdio: "pipe", env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } });
    createInterface({ input: this.child.stdout }).on("line", line => {
      const message = JSON.parse(line) as Message;
      this.messages.push(message);
      if (message.type === "request") { this.calls.push(message); void this.respond(message); }
    });
    this.send({ type: "start", task_ref: this.ref, locale: options.locale ?? "zh-CN", theme: "light", lifetime_ms: options.lifetime });
    await expect.poll(() => this.messages.find(message => message.type === "ready"), { timeout: 5000 }).toBeTruthy();
    this.origin = String(this.messages.find(message => message.type === "ready")!.url).replace(/\/$/, "");
  }
  send(value: Message) { this.child.stdin.write(JSON.stringify({ ...value, view_id: this.viewID }) + "\n"); }
  async respond(message: Message) {
    const input = message.input as Record<string, unknown>;
    let result;
    if (message.action === "hetu.interactions.get" || message.action === "hetu.interactions.save_selection") {
      const called = await this.client.callTool({ name: message.action === "hetu.interactions.get" ? "hetu_open_task_view" : "hetu_save_task_selection", arguments: input });
      result = called.structuredContent;
      if (message.action === "hetu.interactions.save_selection" && this.loseSave) return;
    } else if (message.action === "hetu.operations.get") {
      const scope = this.ref.scope_ref as { kind: string; id: string };
      const uri = `hetu://task/${scope.kind}/${scope.id}/${this.ref.task_id}/operations/by-key?action=${input.action}&key=${encodeURIComponent(String(input.key))}`;
      const resource = await this.client.readResource({ uri });
      result = JSON.parse((resource.contents[0] as { text: string }).text);
    } else throw new Error("Native adapter received a forbidden action");
    this.send({ type: "response", id: message.id, result });
  }
  async pair(context: BrowserContext) {
    const bootstrap = await context.request.get(this.origin + "/api/session");
    const session = await bootstrap.json();
    const response = await context.request.post(this.origin + "/api/pair", { headers: { Origin: this.origin, "X-Hetu-CSRF": session.csrf }, data: {} });
    expect(response.ok()).toBe(true);
    await expect.poll(() => this.messages.filter(message => message.type === "pair_request").length).toBeGreaterThan(0);
    const request = this.messages.filter(message => message.type === "pair_request").at(-1)!;
    this.send({ type: "authorize", request_id: request.request_id });
    await expect.poll(async () => (await (await context.request.get(this.origin + "/api/session")).json()).state).toBe("paired");
    return session.csrf as string;
  }
  async close() {
    if (this.child && this.child.exitCode === null) {
      const exited = once(this.child, "exit"); this.child.stdin.end();
      await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Local process failed to stop on stdin EOF")), 5000).unref())]);
    }
    await this.client?.close();
  }
}

let fixture: LocalFixture;
test.afterEach(async () => { await fixture?.close(); });

test("local page requires native pairing, rejects forged origins and bounds every RPC", async ({ context }) => {
  fixture = new LocalFixture(); await fixture.start();
  const origin = fixture.origin;
  const denied = await context.request.get(origin + "/api/session", { headers: { Host: "localhost:1234" } });
  expect(denied.status()).toBe(403);
  expect((await context.request.get(origin + "/api/session", { headers: { Origin: "https://attacker.invalid" } })).status()).toBe(403);
  const bootstrap = await context.request.get(origin + "/api/session");
  expect(bootstrap.headers()["set-cookie"]).toMatch(/HttpOnly; SameSite=Strict/);
  const session = await bootstrap.json(); expect(session.task_ref).toBeUndefined();
  expect((await context.request.get(origin + "/view.html")).status()).toBe(404);
  expect((await context.request.post(origin + "/api/pair", { headers: { Origin: origin }, data: {} })).status()).toBe(403);
  const headers = { Origin: origin, "X-Hetu-CSRF": session.csrf };
  expect((await context.request.post(origin + "/api/rpc", { headers, data: { method: "tools/call", params: { name: "hetu_open_task_view", arguments: { task_ref: fixture.ref } } } })).status()).toBe(403);
  expect(fixture.calls).toHaveLength(0);
  const csrf = await fixture.pair(context);
  for (const params of [
    { name: "hetu_finalize_document", arguments: { task_ref: fixture.ref } },
    { name: "hetu_open_task_view", arguments: { task_ref: { ...fixture.ref, task_id: "task_" + randomUUID() } } },
    { name: "hetu_open_task_view", arguments: { task_ref: fixture.ref, actor: "author" } },
  ]) expect((await context.request.post(origin + "/api/rpc", { headers: { Origin: origin, "X-Hetu-CSRF": csrf }, data: { method: "tools/call", params } })).status()).toBe(400);
  expect((await context.request.post(origin + "/api/rpc", { headers: { Origin: origin, "X-Hetu-CSRF": csrf }, data: { method: "resources/read", params: { uri: "file:///etc/passwd" } } })).status()).toBe(400);
  expect(fixture.calls).toHaveLength(0);
  expect((await context.request.get(origin + "/../../shared/blueprint.json")).status()).toBe(404);
});

test("paired local AppBridge saves into the real task and clears the frame on stop", async ({ page, context }) => {
  fixture = new LocalFixture(); await fixture.start({ locale: "en" });
  await page.goto(fixture.origin);
  await expect(page.getByRole("button", { name: "Request pairing" })).toBeEnabled();
  await page.getByRole("button", { name: "Request pairing" }).click();
  await expect(page.locator("#code code")).toHaveText(/^\d{6}$/);
  const request = fixture.messages.find(message => message.type === "pair_request")!;
  expect(request.code).toBe(await page.locator("#code code").textContent());
  expect(fixture.calls).toHaveLength(0);
  fixture.send({ type: "authorize", request_id: request.request_id });
  const view = page.frameLocator("iframe");
  await expect(view.getByRole("checkbox").first()).toBeEnabled({ timeout: 20_000 });
  // Agent 的任务语言为中文；宿主仍应将首屏 UI 语言设置为英文。
  await expect(view.getByRole("button", { name: "Save preferences", exact: true })).toBeVisible();
  await view.getByRole("checkbox").first().check();
  await view.getByLabel("Requirements or feedback").fill("保留中文正文，只保存参考选择。🌿");
  await view.getByRole("button", { name: "Save preferences", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("Preferences saved");
  const loaded = await fixture.client.callTool({ name: "hetu_read_creative_task", arguments: { task_ref: fixture.ref } });
  expect((loaded.structuredContent as { data: { decision: { comment: string; effect: string } } }).data.decision).toMatchObject({ comment: "保留中文正文，只保存参考选择。🌿", effect: "preference_only" });
  fixture.send({ type: "stop" });
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByRole("status").first()).toContainText("Access has ended");
  const cookies = await context.cookies(); expect(cookies.every(cookie => cookie.httpOnly)).toBe(true);
});

test("local view recovers an unconfirmed save by its original key", async ({ page, context }) => {
  test.setTimeout(75_000);
  fixture = new LocalFixture(); await fixture.start(); await fixture.pair(context);
  await page.goto(fixture.origin);
  const view = page.frameLocator("iframe");
  await view.getByRole("checkbox").first().check();
  await view.getByLabel("补充要求或意见").fill("失回执后只查询原操作");
  fixture.loseSave = true;
  await view.getByRole("button", { name: "保存选择与意见", exact: true }).click();
  await expect(view.getByRole("button", { name: "查询原保存结果", exact: true })).toBeEnabled({ timeout: 18000 });
  await view.getByRole("button", { name: "查询原保存结果", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("已记录偏好");
  expect(fixture.calls.filter(call => call.action === "hetu.interactions.save_selection")).toHaveLength(1);
  expect(fixture.calls.some(call => call.action === "hetu.operations.get")).toBe(true);
});

test("expired view and parent EOF release the local port", async ({ context }) => {
  fixture = new LocalFixture(); await fixture.start({ lifetime: 1500 });
  await expect.poll(() => fixture.messages.some(message => message.type === "stopped"), { timeout: 5000 }).toBe(true);
  await expect.poll(async () => { try { await context.request.get(fixture.origin, { timeout: 500 }); return false; } catch { return true; } }).toBe(true);
  await fixture.close();
});
