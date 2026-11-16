import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginPackage } from "../src/package.ts";
import { PluginHost, EffectScope, SlotRegistry } from "../src/registry.ts";
const root = path.resolve(import.meta.dirname, "../../..");
test("独立包的注册、依赖和清理不需要修改宿主路由", async () => {
  const graph = await PluginPackage.inspect(
    path.join(root, "plugins/relationships/dist"),
  );
  const timeline = await PluginPackage.inspect(
    path.join(root, "plugins/timeline/dist"),
  );
  const host = new PluginHost();
  host.add(graph);
  host.add(timeline);
  await host.enable(graph.manifest.id);
  await host.enable(timeline.manifest.id);
  assert.equal(host.views.list().length, 2);
  assert.equal(host.actions.list().length, 1);
  await host.disable(graph.manifest.id);
  assert.equal(host.views.list().length, 1);
  assert.equal(host.actions.list().length, 0);
  assert.equal(host.active(timeline.manifest.id), true);
});
test("固定快照不会执行校验后被改写的源文件，越界与软链接包失败", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-package-test-"));
  const original = await PluginPackage.inspect(
    path.join(root, "plugins/timeline/dist"),
  );
  for (const [name, bytes] of original.entries())
    await writeFile(path.join(directory, name), bytes);
  const pkg = await PluginPackage.inspect(directory);
  const before = pkg.file("view.js");
  await writeFile(path.join(directory, "view.js"), "throw new Error()");
  assert.deepEqual(pkg.file("view.js"), before);
  assert.notEqual((await PluginPackage.inspect(directory)).sha256, pkg.sha256);
  assert.throws(() => pkg.file("../secret"));
  const copy = pkg.file("view.js");
  copy.fill(0);
  assert.deepEqual(pkg.file("view.js"), before);
  await symlink(path.join(root, "Cargo.toml"), path.join(directory, "escape"));
  await assert.rejects(() => PluginPackage.inspect(directory), /普通文件/);
});
test("依赖缺失与环不会留下半注册贡献；清理失败仍继续释放其他资源", async () => {
  const base = await PluginPackage.inspect(
    path.join(root, "plugins/timeline/dist"),
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hetu-dependency-test-"),
  );
  for (const [name, bytes] of base.entries())
    await writeFile(path.join(directory, name), bytes);
  await writeFile(
    path.join(directory, "plugin.json"),
    JSON.stringify({
      ...base.manifest,
      dependencies: [{ id: "org.missing.plugin", version: "1.0.0" }],
    }),
  );
  const pkg = await PluginPackage.inspect(directory);
  const host = new PluginHost();
  host.add(pkg);
  await host.enable(pkg.manifest.id);
  assert.equal(host.states()[0].state, "blocked");
  assert.equal(host.views.list().length, 0);
  const effects = new EffectScope();
  const released: string[] = [];
  effects.effect(() => {
    released.push("first");
  });
  effects.effect(() => {
    released.push("second");
    throw new Error("test");
  });
  await assert.rejects(() => effects.dispose());
  assert.deepEqual(released, ["second", "first"]);
  await effects.dispose();
  const slots = new SlotRegistry();
  const scope = new EffectScope();
  slots.register("a", "view", {}, scope);
  assert.throws(() => slots.register("b", "view", {}, scope));
  await scope.dispose();
  assert.equal(slots.list().length, 0);
});

test("真实依赖环、替换和卸载会清理依赖贡献", async () => {
  const base = await PluginPackage.inspect(
    path.join(root, "plugins/timeline/dist"),
  );
  async function copy(id: string, dep?: string, version = "1.0.0") {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-cycle-"));
    for (const [name, bytes] of base.entries())
      await writeFile(path.join(directory, name), bytes);
    await writeFile(
      path.join(directory, "plugin.json"),
      JSON.stringify({
        ...base.manifest,
        id,
        version,
        dependencies: dep ? [{ id: dep, version: "1.0.0" }] : [],
      }),
    );
    return PluginPackage.inspect(directory);
  }
  const a = await copy("org.test.alpha", "org.test.beta"),
    b = await copy("org.test.beta", "org.test.alpha");
  const cyclic = new PluginHost();
  cyclic.add(a);
  cyclic.add(b);
  await cyclic.enable(a.manifest.id);
  assert.equal(cyclic.views.list().length, 0);
  assert.ok(cyclic.states().every((s) => s.state === "blocked"));
  const host = new PluginHost(),
    free = await copy("org.test.beta");
  host.add(a);
  host.add(free);
  await host.enable(a.manifest.id);
  assert.equal(host.views.list().length, 2);
  await host.replace(await copy("org.test.beta", undefined, "2.0.0"));
  assert.equal(host.views.list().length, 0);
  await host.enable(a.manifest.id);
  assert.equal(
    host.states().find((s) => s.id === a.manifest.id)?.state,
    "blocked",
  );
  await host.remove(free.manifest.id);
  assert.equal(host.has(free.manifest.id), false);
  const dead = new EffectScope();
  await dead.dispose();
  assert.throws(() =>
    host.views.register(
      "test",
      "late",
      base.manifest.contributions.views[0],
      dead,
    ),
  );
  assert.equal(host.views.list().length, 0);
});
