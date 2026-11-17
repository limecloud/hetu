import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PluginPackage } from "../src/package.ts";
import { PluginInstallations } from "../src/installations.ts";
import { readSkill, skillSummaries } from "../src/skills.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(extra: any = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-plugin-skills-"));
  await mkdir(path.join(directory, "skills/planner/references"), { recursive: true });
  const text = "---\nname: planner\ndescription: 复盘并规划小说\n---\n\n先读已有小说，再规划后续。\n";
  await writeFile(path.join(directory, "skills/planner/SKILL.md"), text);
  await writeFile(path.join(directory, "skills/planner/references/flow.md"), "# 接续\n\n复盘→总纲→卷纲→章纲→场景。\n");
  await writeFile(path.join(directory, "backend.mjs"), "throw new Error('发现或读方法不得执行后端');");
  const skill = { id: "planner", name: "planner", description: "复盘并规划小说", entry: "skills/planner/SKILL.md" };
  const manifest = { manifest_version: 1, host_api: "1", id: "org.hetu.skill-test", version: "1.0.0",
    display: { "zh-CN": "方法测试", en: "Skill test" }, description: { "zh-CN": "方法测试", en: "Skill test" },
    license: "MIT", dependencies: [], runtime: { entry: "backend.mjs" },
    contributions: { views: [], data: [], actions: [], skills: [skill], ...extra } };
  await writeFile(path.join(directory, "plugin.json"), JSON.stringify(manifest));
  return { directory, manifest, skill, text };
}

test("Skill静态发现与同包引用固定摘要，不执行后端，拒绝越界与错误资源", async () => {
  const f = await fixture(), pkg = await PluginPackage.inspect(f.directory);
  assert.equal(skillSummaries(pkg)[0].content_sha256, digest(f.text));
  assert.equal(readSkill(pkg, { skill_id: "planner" }).content, f.text);
  const resource = readSkill(pkg, { skill_id: "planner", resource: "references/flow.md" });
  assert.match(resource.content, /复盘→总纲/);
  assert.equal(resource.package_sha256, pkg.sha256);
  for (const resource of ["../backend.mjs", "/etc/passwd", "references\\flow.md", "missing.md"])
    assert.throws(() => readSkill(pkg, { skill_id: "planner", resource }));
  assert.throws(() => readSkill(pkg, { skill_id: "missing" }));
  assert.throws(() => readSkill(pkg, { skill_id: "planner", file_path: "/etc/passwd" }));
  await writeFile(path.join(f.directory, f.skill.entry), f.text + "\n新版方法\n");
  assert.equal(readSkill(pkg, { skill_id: "planner" }).content, f.text);
  assert.notEqual((await PluginPackage.inspect(f.directory)).sha256, pkg.sha256);
});

test("安装启停移除后活动Skill随包生命周期变化，旧包与旧操作不混用", async () => {
  const f = await fixture(), pkg = await PluginPackage.inspect(f.directory);
  const store = new PluginInstallations(await mkdtemp(path.join(os.tmpdir(), "hetu-skill-state-")));
  const apply = async (action: string, key: string) => store.apply({ action, client_adapter: "codex",
    plugin_id: pkg.manifest.id, package_directory: f.directory, package_sha256: pkg.sha256,
    expected_sha256: (await store.inspect()).state_sha256, operation_key: key,
    authorization_note: "安装生命周期隔离测试" }, async () => {});
  assert.deepEqual((await store.inspect()).skills, []);
  await apply("install", "install");
  assert.equal((await store.inspect()).skills[0].package_sha256, pkg.sha256);
  await apply("disable", "disable"); assert.deepEqual((await store.inspect()).skills, []);
  await apply("enable", "enable"); assert.equal((await store.inspect()).skills.length, 1);
  await apply("uninstall", "uninstall"); assert.deepEqual((await store.inspect()).skills, []);
});

test("旧包无需Skill，重复贡献与非法入口在安装前拒绝", async () => {
  const f = await fixture({ skills: [] });
  assert.deepEqual(skillSummaries(await PluginPackage.inspect(f.directory)), []);
  for (const skills of [[f.skill, f.skill], [{ ...f.skill, entry: "../SKILL.md" }], [{ ...f.skill, entry: "missing/SKILL.md" }]]) {
    await writeFile(path.join(f.directory, "plugin.json"), JSON.stringify({ ...f.manifest, contributions: { ...f.manifest.contributions, skills } }));
    await assert.rejects(() => PluginPackage.inspect(f.directory));
  }
  await writeFile(path.join(f.directory, "plugin.json"), JSON.stringify(f.manifest));
  await writeFile(path.join(f.directory, f.skill.entry), Buffer.from([0xff]));
  // 无Skill的旧包不扫描非贡献资源。
  assert.deepEqual(skillSummaries(await PluginPackage.inspect(f.directory)), []);
  await writeFile(path.join(f.directory, "plugin.json"), JSON.stringify({ ...f.manifest, contributions: { ...f.manifest.contributions, skills: [f.skill] } }));
  await assert.rejects(() => PluginPackage.inspect(f.directory));
});

test("Skill文本预算、跨包同名与保留动作边界", async () => {
  const a = await fixture(), b = await fixture();
  await writeFile(path.join(b.directory, "plugin.json"), JSON.stringify({ ...b.manifest, id: "org.hetu.other-skill-test" }));
  const first = await PluginPackage.inspect(a.directory), second = await PluginPackage.inspect(b.directory);
  assert.equal(skillSummaries(first)[0].name, skillSummaries(second)[0].name);
  assert.notEqual(skillSummaries(first)[0].plugin_id, skillSummaries(second)[0].plugin_id);
  await writeFile(path.join(a.directory, "skills/planner/references/large.md"), "x".repeat(64 * 1024));
  assert.equal(readSkill(await PluginPackage.inspect(a.directory), { skill_id: "planner", resource: "references/large.md" }).content.length, 64 * 1024);
  await writeFile(path.join(a.directory, "skills/planner/references/large.md"), "x".repeat(64 * 1024 + 1));
  assert.throws(() => readSkill(first, { skill_id: "planner", resource: "references/large.md" }));
  assert.throws(() => readSkill(second, { skill_id: "planner", resource: "" }));
  const oversized = await PluginPackage.inspect(a.directory);
  assert.throws(() => readSkill(oversized, { skill_id: "planner", resource: "references/large.md" }), /64 KiB/);
  await writeFile(path.join(a.directory, a.skill.entry), "x".repeat(64 * 1024 + 1));
  await assert.rejects(() => PluginPackage.inspect(a.directory), /预算/);
  await writeFile(path.join(a.directory, a.skill.entry), a.text);
  await writeFile(path.join(a.directory, "plugin.json"), JSON.stringify({ ...a.manifest, contributions: { ...a.manifest.contributions,
    actions: [{ id: "skills.read", title: "覆盖宿主", effect: "read", input_schema: { type: "object" } }] } }));
  await assert.rejects(() => PluginPackage.inspect(a.directory), /覆盖核心动作/);
});

test("Skill元数据的必填、命名、重复及数量合同", async t => {
  const cases = [
    ["空id", (s: any) => [{ ...s, id: "" }]],
    ["非法名称", (s: any) => [{ ...s, name: "Planner_Name" }]],
    ["名称超限", (s: any) => [{ ...s, name: "a".repeat(65) }]],
    ["空描述", (s: any) => [{ ...s, description: "" }]],
    ["描述超限", (s: any) => [{ ...s, description: "a".repeat(1025) }]],
    ["重复id", (s: any) => [s, { ...s, name: "another" }]],
    ["重复name", (s: any) => [s, { ...s, id: "another" }]],
    ["贡献超限", (s: any) => Array.from({ length: 33 }, (_, i) => ({ ...s, id: "skill-" + i, name: "skill-" + i }))],
    ["额外权限字段", (s: any) => [{ ...s, permissions: ["all"] }]],
    ["非标准入口", (s: any) => [{ ...s, entry: "backend.mjs" }]],
  ] as const;
  for (const [name, skills] of cases) await t.test(name, async () => {
    const f = await fixture();
    await writeFile(path.join(f.directory, "plugin.json"), JSON.stringify({ ...f.manifest,
      contributions: { ...f.manifest.contributions, skills: skills(f.skill) } }));
    await assert.rejects(PluginPackage.inspect(f.directory));
  });
  const f = await fixture();
  const { skills: _, ...contributions } = f.manifest.contributions;
  await writeFile(path.join(f.directory, "plugin.json"), JSON.stringify({ ...f.manifest, contributions }));
  assert.deepEqual(skillSummaries(await PluginPackage.inspect(f.directory)), []);
});

test("Skill引用坏编码、NUL、链接和非法参数均不返回内容", async t => {
  for (const [name, bytes] of [["坏编码", Buffer.from([0xff])], ["NUL", Buffer.from("text\0secret")]] as const) {
    await t.test(name, async () => {
      const f = await fixture();
      await writeFile(path.join(f.directory, "skills/planner/references/invalid.md"), bytes);
      const pkg = await PluginPackage.inspect(f.directory);
      assert.throws(() => readSkill(pkg, { skill_id: "planner", resource: "references/invalid.md" }));
    });
  }
  const f = await fixture(), pkg = await PluginPackage.inspect(f.directory);
  for (const input of [null, [], {}, { skill_id: 1 }, { skill_id: "planner", resource: null },
    { skill_id: "planner", resource: "./SKILL.md" }, { skill_id: "planner", resource: "references//flow.md" },
    { skill_id: "planner", resource: "C:/SKILL.md" }, { skill_id: "planner", resource: "references/../../plugin.json" }])
    assert.throws(() => readSkill(pkg, input));
  await symlink(path.join(f.directory, "backend.mjs"), path.join(f.directory, "skills/planner/references/link.md"));
  await assert.rejects(PluginPackage.inspect(f.directory), /普通文件/);
});

test("同名Skill按包身份读取，返回内容及文件副本不会改变固定包", async () => {
  const a = await fixture(), b = await fixture();
  await writeFile(path.join(b.directory, "plugin.json"), JSON.stringify({ ...b.manifest, id: "org.hetu.another-planner" }));
  await writeFile(path.join(b.directory, b.skill.entry), b.text + "\n来自另一个插件。\n");
  const first = await PluginPackage.inspect(a.directory), second = await PluginPackage.inspect(b.directory);
  first.file(a.skill.entry).fill(0);
  first.entries().find(([name]) => name === a.skill.entry)![1].fill(0);
  const left = readSkill(first, { skill_id: "planner" }), right = readSkill(second, { skill_id: "planner" });
  assert.equal(left.content, a.text); assert.notEqual(left.content, right.content);
  assert.notEqual(left.plugin_id, right.plugin_id); assert.notEqual(left.content_sha256, right.content_sha256);
});
