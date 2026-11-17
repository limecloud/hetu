import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(import.meta.dirname, "../../..");
const bin = path.resolve(process.env.HETU_MACHINE_BIN_DIR ?? path.join(root, "target/debug"));
test("稳定CLI与同一MCP连接读取插件Skill，启停升级与卸载不依赖客户端插件", { timeout: 300000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-skill-hotplug-"));
  const source = path.join(directory, "package");
  await mkdir(path.join(source, "skills/planner/references"), { recursive: true });
  const skill = { id: "planner", name: "hetu-planner-test", description: "复盘既有小说再规划", entry: "skills/planner/SKILL.md" };
  const manifest = { manifest_version: 1, host_api: "1", id: "org.hetu.skill-hotplug", version: "1.0.0",
    display: { "zh-CN": "方法验收", en: "Skill acceptance" }, description: { "zh-CN": "方法验收", en: "Skill acceptance" },
    license: "MIT", dependencies: [], contributions: { views: [], data: [], actions: [], skills: [skill] },
    runtime: { entry: "backend.mjs" } };
  const text = "---\nname: hetu-planner-test\ndescription: 复盘既有小说再规划\n---\n\n先梳理过去，再规划将来。\n";
  await writeFile(path.join(source, "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(source, skill.entry), text);
  await writeFile(path.join(source, "skills/planner/references/flow.md"), "总纲→卷纲→章纲→场景→参考稿→返工");
  await writeFile(path.join(source, "backend.mjs"), "throw new Error('读取Skill不允许执行后端');");
  const env = { ...process.env, HETU_PLUGIN_STATE_DIR: path.join(directory, "state"), HETU_PLUGIN_ACCESS_DIR: path.join(directory, "access"),
    HETU_PLUGIN_NODE: process.execPath, HETU_PLUGIN_CLI: path.join(bin, "hetu-plugin"),
    HETU_PLUGIN_MANAGER: path.join(root, "apps/desktop/dist/plugin-manager.mjs") };
  const hub = path.join(directory, "hub");
  const client = new Client({ name: "hetu-skill-acceptance", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StdioClientTransport({ command: path.join(bin, "hetu-mcp"), args: ["--client", "codex", "--collaboration-dir", hub], env, stderr: "pipe" }));
  const call = async (name: string, args: any = {}) => (await client.callTool({ name, arguments: args })).structuredContent as any;
  const ok = async (name: string, args: any = {}) => { const r = await call(name, args); assert.equal(r.status, "succeeded", JSON.stringify(r)); return r.data; };
  let serial = 0, pkg: any, binding: any, cap: any;
  const apply = async (action: string) => ok("hetu_plugins_apply", { action, plugin_id: manifest.id, package_directory: source,
    package_sha256: pkg.package_sha256, expected_sha256: (await ok("hetu_plugins_inspect")).state_sha256,
    authorization_note: "隔离测试明确选择固定插件包", operation_key: "skill-install-" + ++serial });
  const discover = async () => { binding.package_sha256 = pkg.package_sha256; cap = await ok("hetu_plugins_capabilities", binding); };
  const readInput = (args = { skill_id: "planner" }) => ({ ...binding, capabilities_sha256: cap.capabilities_sha256, action: "skills.read", arguments: args });
  try {
    const tools = (await client.listTools()).tools.map(t => t.name);
    assert.deepEqual((await ok("hetu_plugins_inspect")).skills, []);
    const project = await ok("hetu_begin_creation", { brief: "插件方法隔离验收", locale: "zh-CN", operation_key: "begin" });
    const created = await ok("hetu_create_novel_from_project", { management_ref: project.management_ref, project_id: project.project.project_id,
      expected: { revision: project.revision, sha256: project.sha256 }, target_path: project.target_path,
      metadata: { title: "方法验收", author_name: "演示", synopsis: "隔离资料", genre: "", language_tag: "zh-CN", status: "writing" }, operation_key: "create" });
    binding = { management_ref: created.workspace_management_ref, plugin_id: manifest.id,
      work_ref: { workspace_id: created.workspace_management_ref.scope_ref.id, kind: "novel", object_id: created.novel.novel_id } };
    pkg = await ok("hetu_plugins_inspect_package", { package_directory: source });
    assert.equal(pkg.skills[0].name, skill.name);
    await apply("install"); await discover();
    assert.equal((await ok("hetu_plugins_inspect")).skills[0].package_sha256, pkg.package_sha256);
    assert.equal(cap.skills[0].id, "planner");
    assert.ok(cap.resource_actions.some((a: any) => a.name === "skills.read"));
    const input = readInput(), result = await ok("hetu_plugins_invoke", input);
    assert.equal(result.result.data.content, text);
    assert.equal(result.result.data.content_sha256, createHash("sha256").update(text).digest("hex"));
    const cli = spawnSync(path.join(bin, "hetu"), ["--client", "codex", "--collaboration-dir", hub, "call", "hetu.plugins.invoke", "--input", "-"],
      { env, input: JSON.stringify(input), encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout).data.result, result.result);
    const resource = await ok("hetu_plugins_invoke", readInput({ skill_id: "planner", resource: "references/flow.md" } as any));
    assert.match(resource.result.data.content, /总纲→卷纲/);
    assert.notEqual((await call("hetu_plugins_invoke", readInput({ skill_id: "planner", resource: "../backend.mjs" } as any))).status, "succeeded");
    await apply("disable"); assert.deepEqual((await ok("hetu_plugins_inspect")).skills, []);
    assert.notEqual((await call("hetu_plugins_invoke", input)).status, "succeeded");
    await apply("enable"); await discover();
    assert.equal((await ok("hetu_plugins_invoke", readInput())).result.data.content, text);
    const old = readInput();
    await writeFile(path.join(source, "plugin.json"), JSON.stringify({ ...manifest, version: "1.0.1" }));
    await writeFile(path.join(source, skill.entry), text + "\n新增方法。\n");
    pkg = await ok("hetu_plugins_inspect_package", { package_directory: source });
    await apply("install"); await discover();
    assert.notEqual((await call("hetu_plugins_invoke", old)).status, "succeeded");
    assert.match((await ok("hetu_plugins_invoke", readInput())).result.data.content, /新增方法/);
    await apply("uninstall"); assert.deepEqual((await ok("hetu_plugins_inspect")).skills, []);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), tools);
    await mkdir(path.join(root, "output/plugin-skill-research-20261117"), { recursive: true });
    await writeFile(path.join(root, "output/plugin-skill-research-20261117/machine-acceptance.json"), JSON.stringify({
      status: "passed", platform: process.platform, recorded_at: new Date().toISOString(),
      checks: ["MCP连接早于安装", "静态摘要及全文", "CLI与MCP同内容同摘要", "相对引用", "越界拒绝", "启停", "同连接升级旧包失效", "卸载", "后端未执行", "客户端工具不变"],
      boundaries: ["隔离真实Core和公开机器入口", "不证明Codex原生Skill选择器或整书语义规划", "未覆盖Windows"], directory,
    }, null, 2));
  } finally { await client.close(); }
});
