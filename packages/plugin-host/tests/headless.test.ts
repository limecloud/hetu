import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PluginPackage } from "../src/package.ts";
import { PluginInstallations } from "../src/installations.ts";
const root = path.resolve(import.meta.dirname, "../../..");
test("开放无窗口插件无需权限声明，MCP复用核心且停用立即失效", {timeout:120000}, async () => {
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-open-runtime-"));
  const source=path.join(folder,"package"),workspace=path.join(folder,"作品"),access=path.join(folder,"access");
  await mkdir(source);
  await writeFile(path.join(source,"plugin.json"),JSON.stringify({
    manifest_version:1,host_api:"1",id:"org.test.open",version:"1.0.0",license:"MIT",dependencies:[],
    display:{"zh-CN":"开放统计",en:"Open statistics"},description:{"zh-CN":"复用核心统计",en:"Reuses core statistics"},
    contributions:{views:[],data:[],actions:[{id:"statistics",title:"实际统计",effect:"read",input_schema:{type:"object",additionalProperties:false}}]},
    runtime:{entry:"backend.mjs"},
  }));
  await writeFile(path.join(source,"backend.mjs"),'let context; export function apply(value) { context=value; }\nexport async function invoke() { return context.request("hetu.novels.snapshot",{}); }\n');
  const pkg=await PluginPackage.inspect(source);
  const fixture=json(path.join(root,"target/debug/examples/plugin_fixture"),[workspace,access,path.join(source,"plugin.json"),pkg.sha256]);
  const before=await readdir(path.join(access,"grants"));
  const installations=new PluginInstallations(path.join(folder,"state"));
  const apply=async(action:string)=>installations.apply({client_adapter:"codex",action,plugin_id:pkg.manifest.id,
    package_directory:source,package_sha256:pkg.sha256,expected_sha256:(await installations.read()).sha256,
    authorization_note:"隔离开放运行验收",operation_key:action},async()=>{});
  await apply("install");
  const runtime=[path.join(root,"apps/desktop/dist/plugin-runtime.mjs"),"--package",source,"--workspace",workspace,
    "--work-ref",JSON.stringify(fixture.work_ref),"--state-dir",installations.directory,"--package-sha256",pkg.sha256,
    "--core-cli",path.join(root,"target/debug/hetu-plugin")];
  const cap=json(process.execPath,[...runtime,"capabilities"]);
  assert.equal(cap.access_mode,"open");assert.equal(cap.permissions,undefined);
  assert.ok(cap.core_actions.some((a:any)=>a.name==="hetu.novels.snapshot"));
  const client=new Client({name:"open-runtime",version:"1"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[...runtime,"--mcp"],stderr:"pipe"}));
    const tools=(await client.listTools()).tools.map(t=>t.name);assert.ok(tools.includes("hetu_core_request"));
    const result=await client.callTool({name:"hetu_core_request",arguments:{action:"hetu.novels.snapshot",input:{}}});
    assert.equal((result.structuredContent as any).data.document_count,1);
    const throughBackend=await client.callTool({name:"plugin_statistics",arguments:{}});
    assert.equal((throughBackend.structuredContent as any).data.word_count,(result.structuredContent as any).data.word_count);
    assert.deepEqual(await readdir(path.join(access,"grants")),before);
    await apply("disable");
    await assert.rejects(client.listTools(),/停用|变化/);
    await assert.rejects(client.callTool({name:"hetu_core_request",arguments:{action:"hetu.novels.snapshot",input:{}}}),/停用|变化/);
  } finally {await client.close();}
});
test("无数据类型的独立计算插件可经CLI和MCP执行，且不发现作品数据工具", { timeout: 90000 }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-computation-"));
  const packageDirectory = path.join(folder, "package"), workspace = path.join(folder, "作品"), access = path.join(folder, "private");
  await mkdir(packageDirectory);
  const manifest = {
    manifest_version: 1, host_api: "1", id: "org.test.counter", version: "1.0.0",
    display: { "zh-CN": "字符统计", en: "Character counter" },
    description: { "zh-CN": "只统计明确提供的文字", en: "Counts explicitly supplied text" },
    license: "MIT", dependencies: [], permissions: [],
    contributions: { views: [], data: [], actions: [{ id: "count", title: "统计输入字符", effect: "read", input_schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 10000 } } } }] },
    runtime: { entry: "backend.mjs" },
  };
  await writeFile(path.join(packageDirectory, "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(packageDirectory, "backend.mjs"), 'export function apply() {}\nexport function invoke(action, input) { return { characters: Array.from(input.text).length }; }\n');
  const pkg = await PluginPackage.inspect(packageDirectory);
  const context = json(path.join(root, "target/debug/examples/plugin_fixture"), [workspace, access, path.join(packageDirectory, "plugin.json"), pkg.sha256]);
  const core = path.join(root, "target/debug/hetu-plugin");
  const connection = ["--workspace", workspace, "--access-dir", access, "--grant", context.grant_id, "--package-sha256", pkg.sha256];
  const runtime = [path.join(root, "apps/desktop/dist/plugin-runtime.mjs"), "--package", packageDirectory, ...connection, "--core-cli", core];
  const capabilities = json(process.execPath, [...runtime, "capabilities"]);
  assert.deepEqual(capabilities.permissions, []);
  assert.deepEqual(capabilities.data_actions, []);
  assert.deepEqual(capabilities.types, []);
  assert.deepEqual(capabilities.actions.map((a: any) => a.id), ["count"]);
  assert.deepEqual(json(process.execPath, [...runtime, "invoke", "count", "--input", "-"], { text: "灯塔🌿" }), { characters: 3 });
  const client = new Client({ name: "hetu-counter-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [...runtime, "--mcp"], stderr: "pipe" }));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["plugin_count"]);
    assert.deepEqual((await client.callTool({ name: "plugin_count", arguments: { text: "灯塔🌿" } })).structuredContent, { characters: 3 });
  } finally { await client.close(); }
  const denied = spawnSync(core, [...connection, "call", "hetu.extensions.objects.list", "--input", "-"], { encoding: "utf8", input: JSON.stringify({ work_ref: context.work_ref }) });
  assert.equal(JSON.parse(denied.stdout).error.code, "forbidden");
});
function json(command: string, args: string[], input?: unknown) {
  const result = spawnSync(command, args, {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    // Node组合入口还要串行核验授权、启动后端及执行Core；直接Core调用仍限30秒。
    timeout: command === process.execPath ? 120000 : 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}
test(
  "无Electron窗口的独立TS插件动作、Core保存和真实MCP工具回读",
  { timeout: 300000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-headless-")),
      workspace = path.join(directory, "中文 空格作品"),
      access = path.join(directory, "private");
    const pkg = await PluginPackage.inspect(
      path.join(root, "plugins/relationships/dist"),
    );
    const fixture = json(
      path.join(root, "target/debug/examples/plugin_fixture"),
      [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256],
    );
    const cli = path.join(root, "target/debug/hetu-plugin"),
      connection = [
        "--workspace",
        workspace,
        "--grant",
        fixture.grant_id,
        "--package-sha256",
        pkg.sha256,
        "--access-dir",
        access,
      ];
    const read = (action: string, input: unknown) =>
      json(
        cli,
        [...connection, "call", "hetu.extensions." + action, "--input", "-"],
        input,
      );
    const saved = read("objects.save", {
      work_ref: fixture.work_ref,
      kind: "relationships",
      title: "雾港人物网",
      schema_version: "1",
      source_refs: fixture.source_refs,
      content: {
        nodes: [
          { id: "a", label: "江岚", x: 10, y: 20 },
          { id: "b", label: "叶渡", x: 30, y: 40 },
        ],
        edges: [{ source: "a", target: "b", label: "旧友" }],
      },
      expected_revision: 0,
      expected_sha256: "",
      operation_key: "headless-create",
    });
    assert.equal(saved.status, "succeeded");
    const objectId = saved.data.object.object_id;
    const runtime = path.join(root, "apps/desktop/dist/plugin-runtime.mjs"),
      args = [
        "--package",
        pkg.source,
        "--workspace",
        workspace,
        "--grant",
        fixture.grant_id,
        "--package-sha256",
        pkg.sha256,
        "--access-dir",
        access,
        "--core-cli",
        cli,
      ];
    const capabilities = json(process.execPath, [
      runtime,
      ...args,
      "capabilities",
    ]);
    assert.equal(capabilities.actions[0].id, "arrange");
    const result = json(
      process.execPath,
      [runtime, ...args, "invoke", "arrange", "--input", "-"],
      { object_id: objectId, operation_key: "arrange-cli" },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.data.object.revision, 2);
    assert.deepEqual(result.data.object.source_refs, fixture.source_refs);
    assert.equal(result.data.object.content.nodes[0].x, 150);
    const replay = json(
      process.execPath,
      [runtime, ...args, "invoke", "arrange", "--input", "-"],
      { object_id: objectId, operation_key: "arrange-cli" },
    );
    assert.deepEqual(replay, result);
    const client = new Client(
      { name: "hetu-plugin-integration", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [runtime, ...args, "--mcp"],
          stderr: "pipe",
        }),
      );
      const tools = await client.listTools();
      assert.ok(tools.tools.some((t) => t.name === "plugin_arrange"));
      assert.ok(tools.tools.some((t) => t.name === "plugin_objects_get"));
      const readback = await client.callTool({
        name: "plugin_objects_get",
        arguments: { object_id: objectId },
      });
      assert.equal((readback.structuredContent as any).data.object.revision, 2);
      assert.deepEqual(
        (readback.structuredContent as any).data.object.source_refs,
        fixture.source_refs,
      );
      const called = await client.callTool({
        name: "plugin_arrange",
        arguments: { object_id: objectId, operation_key: "arrange-mcp" },
      });
      assert.equal(called.isError, false);
      assert.equal((called.structuredContent as any).data.object.revision, 3);
    } finally {
      await client.close();
    }
    const final = read("objects.get", {
      work_ref: fixture.work_ref,
      object_id: objectId,
    });
    assert.equal(final.data.object.revision, 3);
    const historic = read("objects.get", {
      work_ref: fixture.work_ref,
      object_id: objectId,
      revision: 1,
    });
    assert.equal(historic.data.object.content.nodes[0].x, 10);
    assert.deepEqual(historic.data.object.source_refs, fixture.source_refs);
  },
);
