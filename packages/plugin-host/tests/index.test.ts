import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PluginPackage } from "../src/package.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const resources = process.env.HETU_PLUGIN_TEST_RESOURCES;
const node = resources ? path.join(resources, "bin", process.platform === "win32" ? "node.exe" : "node") : process.execPath;
function json(command: string, args: string[], input?: unknown) {
  const result = spawnSync(command, args, {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("无窗口CLI与真实MCP共享标题检索、重建及过期游标拒绝", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-plugin-index-"));
  const workspace = path.join(directory, "中文 空格作品"), access = path.join(directory, "private");
  const pkg = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  const fixture = json(path.join(root, "target/debug/examples/plugin_fixture"), [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256]);
  const cli = resources ? path.join(resources, "bin", process.platform === "win32" ? "hetu-plugin.exe" : "hetu-plugin") : path.join(root, "target/debug/hetu-plugin");
  const connection = ["--workspace", workspace, "--access-dir", access, "--grant", fixture.grant_id, "--package-sha256", pkg.sha256];
  const call = (action: string, input: Record<string, unknown> = {}) => json(cli,
    [...connection, "call", "hetu.extensions." + action, "--input", "-"], { ...input, work_ref: fixture.work_ref });
  const save = (title: string, key: string) => call("objects.save", {
    kind: "relationships", title, schema_version: "1", source_refs: fixture.source_refs,
    content: { nodes: [], edges: [] }, expected_revision: 0, expected_sha256: "", operation_key: key,
  }).data;
  save("雾港人物甲", "create-one");
  const second = save("雾港人物乙", "create-two");
  assert.equal(call("index.status").data.state, "missing");
  const page = call("objects.search", { query: "雾港", limit: 1 }).data;
  assert.equal(page.index_state, "missing");
  assert.equal(page.objects.length, 1);
  assert.equal(typeof page.next_cursor, "string");
  const runtime = [resources ? path.join(resources, "app/dist/plugin-runtime.mjs") : path.join(root, "apps/desktop/dist/plugin-runtime.mjs"), "--package", pkg.source,
    ...connection, "--core-cli", cli];
  const capabilities = json(node, [...runtime, "capabilities"]);
  for (const name of ["hetu.extensions.objects.search", "hetu.extensions.index.status", "hetu.extensions.index.rebuild"])
    assert.ok(capabilities.data_actions.some((action: any) => action.name === name), name);
  const client = new Client({ name: "hetu-index-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    await client.connect(new StdioClientTransport({ command: node, args: [...runtime, "--mcp"], stderr: "pipe" }));
    const tools = (await client.listTools()).tools;
    for (const name of ["plugin_objects_search", "plugin_index_status", "plugin_index_rebuild"])
      assert.ok(tools.some((tool) => tool.name === name), name);
    const rebuilt = await client.callTool({ name: "plugin_index_rebuild", arguments: {} });
    assert.equal(rebuilt.isError, false);
    assert.equal((rebuilt.structuredContent as any).data.authority_changed, false);
    assert.equal(call("index.status").data.state, "ready");
    const continued = await client.callTool({ name: "plugin_objects_search", arguments: { query: "雾港", limit: 1, cursor: page.next_cursor } });
    assert.equal(continued.isError, false);
    const next = (continued.structuredContent as any).data;
    assert.equal(next.index_state, "ready");
    assert.equal(next.next_cursor, null);
    assert.notEqual(next.objects[0].object_id, page.objects[0].object_id);
    const saved = call("objects.save", { object_id: second.object.object_id, kind: second.object.kind,
      schema_version: second.object.schema_version, title: "新标题 Harbor", content: second.object.content,
      source_refs: second.object.source_refs, expected_revision: second.object.revision,
      expected_sha256: second.sha256, operation_key: "update-title" });
    assert.equal(saved.status, "succeeded");
    const status = await client.callTool({ name: "plugin_index_status", arguments: {} });
    assert.equal((status.structuredContent as any).data.state, "stale");
    const stale = await client.callTool({ name: "plugin_objects_search", arguments: { query: "雾港", limit: 1, cursor: page.next_cursor } });
    assert.equal(stale.isError, true);
    assert.equal((stale.structuredContent as any).error.code, "hetu.stale_evidence");
    const fresh = await client.callTool({ name: "plugin_objects_search", arguments: { query: "harbor" } });
    assert.equal((fresh.structuredContent as any).data.index_state, "stale");
    assert.equal((fresh.structuredContent as any).data.objects[0].object_id, second.object.object_id);
    assert.equal((fresh.structuredContent as any).data.objects[0].revision, 2);
  } finally { await client.close(); }
  // 新进程仍读取同一缓存与权威修订，不依赖运行中的桌面。
  assert.equal(call("index.status").data.state, "stale");
  assert.equal(call("objects.get", { object_id: second.object.object_id, revision: 1 }).data.object.title, "雾港人物乙");
  assert.equal(call("index.rebuild").data.indexed_objects, 2);
  assert.equal(call("index.status").data.state, "ready");
});
