import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginPackage } from "../src/package.ts";
import { PluginHost, EffectScope, SlotRegistry } from "../src/registry.ts";
import { supportsWork, type WorkRef } from "@hetu/plugin-sdk";
const root = path.resolve(import.meta.dirname, "../../..");
test("插件作品范围由清单声明，数据类型不参与判断，旧通用包保持兼容", async () => {
  const base = await PluginPackage.inspect(path.join(root, "plugins/timeline/dist"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-work-kinds-"));
  for (const [name, bytes] of base.entries()) await writeFile(path.join(directory, name), bytes);
  const work = (kind: WorkRef["kind"]): WorkRef => ({ workspace_id: "workspace", object_id: "work", kind });
  for (const kind of ["novel", "drama", "video"] as const) assert.equal(supportsWork(base.manifest, work(kind)), true);
  await writeFile(path.join(directory, "plugin.json"), JSON.stringify({ ...base.manifest, work_kinds: ["drama", "video"] }));
  const pkg = await PluginPackage.inspect(directory);
  assert.equal(supportsWork(pkg.manifest, work("novel")), false);
  assert.equal(supportsWork(pkg.manifest, work("drama")), true);
  assert.equal(supportsWork(pkg.manifest, work("video")), true);
  assert.notEqual(pkg.sha256, base.sha256);
  for (const work_kinds of [[], ["novel", "novel"], ["screenplay"], "video", null]) {
    await writeFile(path.join(directory, "plugin.json"), JSON.stringify({ ...base.manifest, work_kinds }));
    await assert.rejects(() => PluginPackage.inspect(directory), /插件清单不兼容/);
  }
});
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
  await assert.rejects(() => effects.dispose(), /插件清理失败/);
  const slots = new SlotRegistry();
  const scope = new EffectScope();
  slots.register("a", "view", {}, scope);
  assert.throws(() => slots.register("b", "view", {}, scope));
  await scope.dispose();
  assert.equal(slots.list().length, 0);
});

test("并发启用、停用和替换按依赖图过渡顺序完成", async () => {
  const base = await PluginPackage.inspect(path.join(root, "plugins/timeline/dist"));
  async function pkg(id: string, dependency?: string, version = "1.0.0") {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-lifecycle-"));
    for (const [name, bytes] of base.entries()) await writeFile(path.join(directory, name), bytes);
    await writeFile(path.join(directory, "plugin.json"), JSON.stringify({ ...base.manifest, id, version,
      dependencies: dependency ? [{ id: dependency, version: "1.0.0" }] : [] }));
    return PluginPackage.inspect(directory);
  }
  const a = await pkg("org.test.consumer", "org.test.provider"), b = await pkg("org.test.provider");
  const host = new PluginHost(); host.add(a); host.add(b);
  await Promise.all([host.enable(a.manifest.id), host.enable(a.manifest.id)]);
  assert.equal(host.views.list().length, 2);
  assert.equal(host.active(a.manifest.id), true);
  await host.disable(b.manifest.id);
  await Promise.all([host.enable(a.manifest.id), host.disable(b.manifest.id)]);
  assert.equal(host.views.list().length, 0);
  assert.ok(host.states().every(state => state.state === "disabled"));
  const replacement = await pkg(b.manifest.id, undefined, "2.0.0");
  await Promise.all([host.enable(a.manifest.id), host.replace(replacement)]);
  assert.equal(host.views.list().length, 0);
  assert.equal(host.package(b.manifest.id).manifest.version, "2.0.0");
  await Promise.all([host.enable(a.manifest.id), host.remove(b.manifest.id)]);
  assert.equal(host.active(a.manifest.id), false);
  assert.equal(host.has(b.manifest.id), false);
});

test("重复清理等待同一次完成且拒绝晚到注册", async () => {
  const scope = new EffectScope();
  let finish!: () => void, released = 0;
  scope.effect(() => new Promise<void>(resolve => { finish = () => { released++; resolve(); }; }));
  const first = scope.dispose(), second = scope.dispose();
  assert.equal(first, second);
  assert.throws(() => scope.effect(() => {}), /生命周期已结束/);
  await Promise.resolve(); finish();
  await Promise.all([first, second]);
  assert.equal(released, 1);
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
