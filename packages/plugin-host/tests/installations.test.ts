import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PluginInstallations } from "../src/installations.ts";
import { PluginPackage } from "../src/package.ts";
const root = path.resolve(import.meta.dirname, "../../..");

test("无窗口安装、停用和卸载共用状态；原键恢复，拒绝旧基线和包替换", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-installations-"));
  const store = new PluginInstallations(directory), other = new PluginInstallations(directory);
  const pkg = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  let revoked = 0;
  const revoke = async () => { revoked++; };
  const input = { action: "install", package_directory: path.join(root, "plugins/relationships/dist"),
    package_sha256: pkg.sha256, expected_sha256: (await store.read()).sha256,
    operation_key: "install", client_adapter: "codex", authorization_note: "测试用户明确要求安装关系图。" };
  const installed = await store.apply(input, revoke);
  assert.equal((await other.inspect()).states[0].state, "active");
  assert.deepEqual(await other.apply(input, revoke), installed);
  assert.deepEqual(await other.getOperation("codex", "install"), installed);
  assert.equal(revoked, 0);
  await assert.rejects(other.apply({ ...input, package_sha256: "0".repeat(64) }, revoke), /原操作键/);
  await assert.rejects(other.apply({ ...input, operation_key: "stale" }, revoke), /状态已变化/);
  const current = await other.read();
  await other.apply({ ...input, action: "disable", plugin_id: pkg.manifest.id,
    operation_key: "disable", expected_sha256: current.sha256 }, revoke);
  assert.equal(revoked, 1);
  assert.equal((await store.inspect()).states[0].state, "disabled");
  await assert.rejects(store.save(current.state, current.sha256), /另一入口/);
  await other.apply({ ...input, action: "uninstall", plugin_id: pkg.manifest.id,
    operation_key: "uninstall", expected_sha256: (await store.read()).sha256 }, revoke);
  assert.equal((await store.inspect()).states.length, 0);
  assert.equal((await store.read()).state.packages[0].removed, true);
});

test("并行安装入口只有一个事务可提交，不覆盖对方状态", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-install-race-"));
  const a = new PluginInstallations(directory), b = new PluginInstallations(directory);
  const before = await a.read();
  const results = await Promise.allSettled([
    a.save({ ...before.state, grants: { a: "fixture-a" } }, before.sha256),
    b.save({ ...before.state, grants: { b: "fixture-b" } }, before.sha256),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(Object.keys((await a.read()).state.grants).length, 1);
});
