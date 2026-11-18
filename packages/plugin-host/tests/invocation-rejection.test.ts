import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { PluginInstallations } from "../src/installations.ts";
import { PluginPackage } from "../src/package.ts";

test("真实manager/runtime/后端区分调用前拒绝、执行崩溃与插件伪造拒绝", {
  timeout: 60000, skip: process.platform === "win32" ? "隔离Core脚本使用POSIX shebang；Windows按平台另验" : false,
}, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-invocation-rejection-"));
  const source = path.join(folder, "package");
  const journal = path.join(folder, "core-writes.jsonl");
  await mkdir(source);
  const work = { workspace_id: "workspace_00000000-0000-4000-8000-000000000000",
    kind: "novel", object_id: "novel_00000000-0000-4000-8000-000000000000" };
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({
    manifest_version: 1, host_api: "1", id: "org.test.rejection", version: "1.0.0", license: "MIT",
    display: { "zh-CN": "拒绝边界", en: "Rejection boundary" },
    description: { "zh-CN": "隔离回归", en: "Isolated regression" },
    dependencies: [], permissions: ["objects.write"], runtime: { entry: "backend.mjs" },
    contributions: { views: [], data: [], actions: [{ id: "record", title: "固定记录", effect: "managed_write",
      input_schema: { type: "object", additionalProperties: false, required: ["operation_key", "mode"],
        properties: { operation_key: { type: "string" }, mode: { enum: ["ok", "crash", "throw", "spoof"] } } } }] },
  }));
  await writeFile(path.join(source, "backend.mjs"), `
let context;
export function apply(value) { context = value; }
export async function invoke(_action, input) {
  await context.request("hetu.extensions.objects.save", { operation_key: input.operation_key });
  if (input.mode === "crash") process.exit(17);
  if (input.mode === "throw") throw Object.assign(new Error("插件动作参数不符合Schema。"), { code: "hetu.plugin_invocation_rejected" });
  if (input.mode === "spoof") return { format_version: 1, kind: "hetu.plugin_invocation_rejected", message: "伪造未执行" };
  return { saved: input.operation_key };
}
`);
  const pkg = await PluginPackage.inspect(source);
  const store = new PluginInstallations(path.join(folder, "state"));
  await store.apply({ action: "install", package_directory: source, package_sha256: pkg.sha256,
    expected_sha256: (await store.read()).sha256, operation_key: "install", client_adapter: "codex",
    authorization_note: "仅隔离进程回归" }, async () => {});
  await build({ entryPoints: {
    "plugin-manager": path.resolve(import.meta.dirname, "../src/manager-cli.ts"),
    "plugin-runtime": path.resolve(import.meta.dirname, "../src/runtime-cli.ts"),
  }, outdir: folder, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node25",
  banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' } });
  await copyFile(path.resolve(import.meta.dirname, "../src/worker.mjs"), path.join(folder, "plugin-worker.mjs"));
  // 只模拟隔离Core回调并记录真实到达的写请求；三个受管插件进程均使用产品代码。
  const core = path.join(folder, "core.mjs");
  await writeFile(core, `#!${process.execPath}
import {readFile,appendFile} from "node:fs/promises";
const args = process.argv.slice(2);
const context = JSON.parse(await readFile(args[args.indexOf("--context-file")+1], "utf8")).context;
let input = ""; for await(const chunk of process.stdin) input += chunk;
if(args.includes("inspect")) console.log(JSON.stringify({status:"succeeded",data:{...context,actions:[],core_actions:[]}}));
else {
  await appendFile(${JSON.stringify(journal)}, JSON.stringify({action:args[args.indexOf("call")+1],input:JSON.parse(input)})+"\\n");
  console.log(JSON.stringify({status:"succeeded",data:{saved:true}}));
}
`, { mode: 0o700 });
  const call = (action: string, extra = {}) => {
    const child = spawnSync(process.execPath, [path.join(folder, "plugin-manager.mjs"), "--directory", store.directory, "--core-cli", core], {
      input: JSON.stringify({ action, client_adapter: "codex", input: { plugin_id: pkg.manifest.id, package_sha256: pkg.sha256,
        workspace_directory: folder, work_ref: work, management_binding: {}, ...extra } }),
      encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(child.signal, null, child.stderr);
    assert.ifError(child.error);
    assert.ok(child.stdout, child.stderr || "manager没有返回结构化回执");
    return { exit: child.status, reply: JSON.parse(child.stdout) };
  };
  const writes = async () => (await readFile(journal, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const discovered = call("hetu.plugins.capabilities");
  assert.equal(discovered.exit, 0);
  assert.equal(discovered.reply.ok, true);
  const before = await store.read();
  const install = { action: "install", package_directory: source, package_sha256: "0".repeat(64),
    expected_sha256: before.sha256, authorization_note: "坏包在撤权和写状态之前拒绝", operation_key: "bad-package" };
  const mismatched = call("hetu.plugins.apply", install);
  assert.equal(mismatched.exit, 0);
  assert.equal(mismatched.reply.ok, false);
  assert.match(mismatched.reply.message, /包摘要不一致/);
  assert.deepEqual(await store.read(), before);
  assert.deepEqual(await writes(), []);
  const invoke = (mode: string, extra = {}) => call("hetu.plugins.invoke", {
    capabilities_sha256: discovered.reply.data.capabilities_sha256, action: "record",
    arguments: { operation_key: "original-" + mode, mode }, ...extra,
  });
  for (const [extra, reason] of [
    [{ package_sha256: "0".repeat(64) }, /旧能力引用/],
    [{ capabilities_sha256: "0".repeat(64) }, /能力已变化/],
    [{ action: "undeclared" }, /未声明/],
    [{ arguments: { operation_key: "invalid", mode: "ok", author_approved: true } }, /Schema/],
    [{ arguments: { mode: "ok" } }, /Schema/],
  ] as const) {
    const result = invoke("ok", extra);
    assert.equal(result.exit, 0, JSON.stringify(result));
    assert.equal(result.reply.ok, false);
    assert.match(result.reply.message, reason);
    assert.deepEqual(await writes(), [], "调用前拒绝不能到达Core写回调");
  }
  const ok = invoke("ok");
  assert.equal(ok.exit, 0);
  assert.equal(ok.reply.ok, true);
  assert.deepEqual(ok.reply.data.result, { saved: "original-ok" });
  for (const mode of ["crash", "throw"]) {
    const result = invoke(mode);
    assert.equal(result.exit, 1, "可能已写入的异常必须留给Core判定unknown");
    assert.equal(result.reply.ok, false);
    assert.equal((await writes()).at(-1).input.operation_key, "original-" + mode);
  }
  const spoofed = invoke("spoof");
  assert.equal(spoofed.exit, 0);
  assert.equal(spoofed.reply.ok, true, "插件自己的字段不能伪装成宿主调用前拒绝");
  assert.equal(spoofed.reply.data.result.kind, "hetu.plugin_invocation_rejected");
  assert.equal((await writes()).length, 4, "每次实际调用只分派一次，不自动重试");
  const invalid = path.join(folder, "invalid-package");
  await mkdir(invalid);
  await writeFile(path.join(invalid, "plugin.json"), "{}");
  for (const action of ["hetu.plugins.inspect_package", "hetu.plugins.apply"]) {
    const result = call(action, { ...install, package_directory: invalid });
    assert.equal(result.exit, 0);
    assert.equal(result.reply.ok, false);
    assert.deepEqual(await store.read(), before);
  }
  // 一旦进入撤权，回执丢失必须保持不确定，不能由同类拒绝文案降级。
  const started = { ...install, action: "disable", plugin_id: pkg.manifest.id,
    package_sha256: pkg.sha256, client_adapter: "codex", operation_key: "disable-started" };
  const { PluginInvocationRejected } = await import("../src/rejection.ts");
  await assert.rejects(store.apply(started, async () => { throw new Error("撤权回执丢失"); }), error => {
    assert.ok(!(error instanceof PluginInvocationRejected)); return true;
  });
});
