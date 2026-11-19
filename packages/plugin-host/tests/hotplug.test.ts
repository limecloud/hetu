import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Ajv2020 from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import workSchema from "../../../contracts/schemas/work.schema.json" with { type: "json" };
import capabilitiesSchema from "../../../contracts/schemas/plugin-capabilities.schema.json" with { type: "json" };
import objectSchema from "../../../contracts/schemas/plugin-object.schema.json" with { type: "json" };
import resultSchema from "../../../contracts/schemas/result.schema.json" with { type: "json" };

const root = path.resolve(import.meta.dirname, "../../..");
const bin = path.resolve(process.env.HETU_MACHINE_BIN_DIR ?? path.join(root, "target/debug"));
const ajv = new Ajv2020({ strict: false }).addSchema(workSchema);
const validCapabilities = ajv.compile(capabilitiesSchema), validObject = ajv.compile(objectSchema), validResult = ajv.compile(resultSchema);

test("同一河图MCP连接动态发现、调用和热插拔专业插件，无需客户端插件安装", { timeout: 300000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-hotplug-"));
  const packageDirectory = path.join(directory, "独立包");
  await mkdir(packageDirectory);
  const manifest: any = {
    manifest_version: 1, host_api: "1", id: "org.test.hotplug", version: "1.0.0",
    display: { "zh-CN": "动态能力验收", en: "Hotplug test" },
    description: { "zh-CN": "独立插件", en: "Independent plugin" }, license: "MIT", dependencies: [],
    permissions: ["objects.read", "objects.write"],
    contributions: { views: [], data: [{ kind: "note", schema_version: "1", schema: {
      type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "integer" } },
    } }], actions: [{ id: "count", title: "字符统计", effect: "read", input_schema: {
      type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } },
    } }] }, runtime: { entry: "backend.mjs" },
  };
  await writeFile(path.join(packageDirectory, "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(packageDirectory, "backend.mjs"), 'export function apply() {}\nexport function invoke(action,input) { return { characters:Array.from(input.text).length }; }\n');
  const env = { ...process.env, HETU_PLUGIN_STATE_DIR: path.join(directory, "installations"),
    HETU_PLUGIN_ACCESS_DIR: path.join(directory, "access"), HETU_PLUGIN_NODE: process.execPath,
    HETU_PLUGIN_CLI: path.join(bin, "hetu-plugin"),
    HETU_PLUGIN_MANAGER: process.env.HETU_PLUGIN_MANAGER ?? path.join(root, "apps/desktop/dist/plugin-manager.mjs") };
  const client = new Client({ name: "hetu-stable-hotplug-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StdioClientTransport({ command: path.join(bin, "hetu-mcp"),
    args: ["--client", "codex", "--collaboration-dir", path.join(directory, "hub")], env, stderr: "pipe" }));
  async function call(name: string, args: any = {}) {
    const response = await client.callTool({ name, arguments: args });
    const value: any = response.structuredContent;
    assert.ok(validResult(value), JSON.stringify(validResult.errors));
    return value;
  }
  async function ok(name: string, args: any = {}) {
    const value = await call(name, args);
    assert.equal(value.status, "succeeded", JSON.stringify(value));
    return value.data;
  }
  const initialTools = (await client.listTools()).tools.map(tool => tool.name).sort();
  let operation = 0, pkg: any, work: any, management: any, grant: any, capabilities: any, object: any;
  async function createWork(key: string) {
    const start = await ok("hetu_begin_creation", { brief: "独立热插拔测试作品", locale: "zh-CN", operation_key: "begin-" + key });
    const created = await ok("hetu_create_novel_from_project", { management_ref: start.management_ref,
      project_id: start.project.project_id, expected: { revision: start.revision, sha256: start.sha256 }, target_path: start.target_path,
      metadata: { title: "动态插件测试", author_name: "测试作者", synopsis: "隔离测试", genre: "", language_tag: "zh-CN", status: "writing" }, operation_key: "create-" + key });
    return { management: created.workspace_management_ref,
      work: { workspace_id: created.workspace_management_ref.scope_ref.id, kind: "novel", object_id: created.novel.novel_id } };
  }
  const binding = () => ({ management_ref: management, work_ref: work, grant_id: grant.grant_id, package_sha256: pkg.package_sha256 });
  async function apply(action: string) {
    return ok("hetu_plugins_apply", { action, plugin_id: pkg.manifest.id, package_directory: packageDirectory,
      package_sha256: pkg.package_sha256, expected_sha256: (await ok("hetu_plugins_inspect")).state_sha256,
      authorization_note: "测试作者明确选择" + action + "本插件。", operation_key: "install-operation-" + ++operation });
  }
  async function authorize(key: string, permissions = manifest.permissions, types = manifest.contributions.data) {
    grant = await ok("hetu_plugin_access_authorize", { management_ref: management, work_ref: work,
      plugin_id: pkg.manifest.id, package_sha256: pkg.package_sha256, permissions, types,
      authorization_note: "测试作者明确授权该固定包在本作品使用所列专业能力。", operation_key: key });
    capabilities = await ok("hetu_plugin_access_capabilities", binding());
    // 管理连接附加原management_ref；专业能力Schema只校验自己的投影。
    const { management_ref: _, ...projection } = capabilities;
    assert.ok(validCapabilities(projection), JSON.stringify(validCapabilities.errors));
    assert.equal(projection.invocation_projection_version, 1);
    assert.equal(validCapabilities({ ...projection, invocation_projection_version: 2 }), false);
  }
  const invoke = (action: string, args: any, extra = {}) => call("hetu_call_action", {
    action: "hetu.plugin_access.invoke", input: {
      ...binding(), capabilities_sha256: capabilities.capabilities_sha256, action, arguments: args, ...extra,
    },
  });
  try {
    await t.test("HP-01 连接先建立，再安装和发现，工具目录保持稳定", async () => {
      assert.ok(initialTools.includes("hetu_call_action"));
      assert.ok(initialTools.length <= 13);
      assert.deepEqual((await ok("hetu_plugins_inspect")).packages, []);
      ({ work, management } = await createWork("first"));
      pkg = await ok("hetu_plugins_inspect_package", { package_directory: packageDirectory });
      await apply("install");
      assert.equal((await ok("hetu_plugins_inspect")).states[0].state, "active");
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), initialTools);
    });
    await t.test("HP-02 未授权与伪造grant不可发现作品能力", async () => {
      const denied = await call("hetu_plugin_access_capabilities", { management_ref: management, work_ref: work,
        grant_id: "0".repeat(64), package_sha256: pkg.package_sha256 });
      assert.notEqual(denied.status, "succeeded");
    });
    await t.test("HP-03 获权后发现Schema并通过稳定入口执行", async () => {
      await authorize("authorize-v1");
      assert.equal(capabilities.actions[0].id, "count");
      assert.deepEqual((await invoke("count", { text: "河图🌿" })).data.result, { characters: 3 });
    });
    await t.test("HP-04 未声明动作、错误参数、旧能力摘要均拒绝", async () => {
      for (const [action, args, extra] of [["missing", {}, {}], ["count", { text: 3 }, {}],
        ["count", { text: "河图" }, { capabilities_sha256: "0".repeat(64) }]] as const)
        assert.notEqual((await invoke(action, args, extra)).status, "succeeded");
    });
    await t.test("HP-05 另一作品和管理授权不能借用当前插件grant", async () => {
      const other = await createWork("other");
      const denied = await invoke("count", { text: "河图" }, { management_ref: other.management, work_ref: other.work });
      assert.notEqual(denied.status, "succeeded");
      const sameRoot = await call("hetu_plugin_access_authorize", { management_ref: management,
        work_ref: { ...work, object_id: other.work.object_id }, plugin_id: pkg.manifest.id,
        package_sha256: pkg.package_sha256, permissions: manifest.permissions, types: manifest.contributions.data,
        authorization_note: "测试新建引用不得扩为同根其他对象。", operation_key: "authorize-wrong-object" });
      assert.equal(sameRoot.error.message, "插件能力只覆盖当前作品。");
    });
    await t.test("HP-13 同一入口保存专业修订、原键回读与重放", async () => {
      const input = { kind: "note", title: "固定成果", schema_version: "1", content: { value: 7 },
        expected_revision: 0, expected_sha256: "", operation_key: "save-note" };
      const saved = await invoke("hetu.extensions.objects.save", input);
      assert.equal(saved.data.result.status, "succeeded", JSON.stringify(saved));
      object = saved.data.result.data;
      assert.ok(validObject(object.object), JSON.stringify(validObject.errors));
      assert.deepEqual((await invoke("hetu.extensions.objects.save", input)).data.result, saved.data.result);
      assert.deepEqual((await invoke("hetu.extensions.operations.get", { operation_key: "save-note" })).data.result.data, object);
      assert.notEqual((await invoke("hetu.extensions.objects.save", { ...input, content: { value: 8 } })).data.result.status, "succeeded");
    });
    await t.test("HP-06 停用撤权后，旧调用失败", async () => {
      await apply("disable");
      assert.notEqual((await invoke("count", { text: "河图" })).status, "succeeded");
    });
    await t.test("HP-07 重新启用不复活旧grant，重新授权后可用", async () => {
      await apply("enable");
      assert.notEqual((await invoke("count", { text: "河图" })).status, "succeeded");
      await authorize("authorize-reenabled");
      assert.equal((await invoke("count", { text: "河图" })).data.result.characters, 2);
    });
    await t.test("HP-08 升级更换Schema与动作，旧引用失败，成果保持", async () => {
      manifest.version = "2.0.0"; manifest.contributions.actions[0].id = "count_v2";
      await writeFile(path.join(packageDirectory, "plugin.json"), JSON.stringify(manifest));
      const old = { ...binding(), capabilities_sha256: capabilities.capabilities_sha256, action: "count", arguments: { text: "河图" } };
      pkg = await ok("hetu_plugins_inspect_package", { package_directory: packageDirectory });
      await apply("install");
      assert.notEqual((await call("hetu_plugin_access_invoke", old)).status, "succeeded");
      await authorize("authorize-v2");
      assert.equal(capabilities.actions[0].id, "count_v2");
      assert.equal((await invoke("count_v2", { text: "河图🌿" })).data.result.characters, 3);
      assert.equal((await invoke("hetu.extensions.objects.get", { object_id: object.object.object_id })).data.result.data.sha256, object.sha256);
    });
    await t.test("HP-09 卸载重装仍需新授权，安装原操作可回读", async () => {
      await apply("uninstall");
      assert.notEqual((await invoke("count_v2", { text: "河图" })).status, "succeeded");
      assert.equal((await ok("hetu_plugins_get_operation", { operation_key: "install-operation-" + operation })).action, "uninstall");
      await apply("install");
      assert.notEqual((await invoke("count_v2", { text: "河图" })).status, "succeeded");
      await authorize("authorize-reinstalled");
      assert.equal((await invoke("hetu.extensions.objects.get", { object_id: object.object.object_id })).data.result.data.sha256, object.sha256);
    });
    await t.test("HP-17 空权限仅可运行显式输入计算，不发现或调用数据", async () => {
      await authorize("authorize-computation-only", [], []);
      assert.deepEqual(capabilities.data_actions, []);
      assert.equal((await invoke("count_v2", { text: "河图" })).data.result.characters, 2);
      assert.notEqual((await invoke("hetu.extensions.objects.list", {})).status, "succeeded");
    });
    await t.test("整个旅程只用原MCP连接，未新增客户端插件或工具", async () => {
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), initialTools);
    });
  } finally { await client.close(); }
});
