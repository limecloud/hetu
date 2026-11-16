import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("损坏固定包隔离失败，无关包仍可用且可沿机器入口停用卸载坏包", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-broken-install-"));
  const store = new PluginInstallations(directory);
  const good = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  const broken = await PluginPackage.inspect(path.join(root, "plugins/timeline/dist"));
  const goodPath = await store.snapshot(good), brokenPath = await store.snapshot(broken);
  await store.save({ packages: [good, broken].map((pkg, index) => ({
    path: index ? brokenPath : goodPath, manifest: pkg.manifest, sha256: pkg.sha256, enabled: true,
  })), grants: {} }, (await store.read()).sha256);
  await writeFile(path.join(brokenPath, "index.html"), "被改写的固定包");
  const status = await store.inspect();
  assert.equal(status.states.find(s => s.id === good.manifest.id)?.state, "active");
  assert.equal(status.states.find(s => s.id === broken.manifest.id)?.state, "failed");
  assert.match(status.states.find(s => s.id === broken.manifest.id)?.reason ?? "", /摘要不一致/);
  let revocations = 0;
  for (const action of ["disable", "uninstall"]) {
    await store.apply({ action, plugin_id: broken.manifest.id, package_sha256: broken.sha256,
      expected_sha256: (await store.read()).sha256, operation_key: action, client_adapter: "codex",
      authorization_note: `测试作者明确要求${action}损坏插件。` }, async identity => {
      assert.equal(identity.sha256, broken.sha256); revocations++;
    });
    assert.equal((await store.inspect()).states.find(s => s.id === good.manifest.id)?.state, "active");
  }
  assert.equal(revocations, 2);
  assert.ok(!(await store.inspect()).states.some(s => s.id === broken.manifest.id));
});

test("安装格式读取保留旧v1字节，写入显式版本，未知版本与控制字段失败关闭", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-install-format-"));
  const store = new PluginInstallations(directory), legacy = JSON.stringify({ packages: [], grants: {} });
  await writeFile(store.file, legacy);
  const before = await store.read();
  assert.equal(await readFile(store.file, "utf8"), legacy);
  await store.save(before.state, before.sha256);
  assert.equal((await store.read()).state.format_version, 1);
  for (const invalid of [{ format_version: 2, packages: [], grants: {} }, { packages: [], grants: {}, author: true }]) {
    const bytes = JSON.stringify(invalid);
    await writeFile(store.file, bytes);
    await assert.rejects(store.read(), /状态无效/);
    assert.equal(await readFile(store.file, "utf8"), bytes);
  }
});
