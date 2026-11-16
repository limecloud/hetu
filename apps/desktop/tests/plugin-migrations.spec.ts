import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { navigate } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("插件Schema升级经CLI准备、作者审阅、关窗MCP执行及原键恢复", async () => {
  test.setTimeout(180000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-plugin-migration-"));
  const workspace = path.join(folder, "作品"), profile = path.join(folder, "profile"), access = path.join(folder, "access");
  async function pkg(version: string) {
    const directory = path.join(folder, "package-" + version);
    await mkdir(directory);
    const field = version === "1" ? "names" : "characters";
    await writeFile(path.join(directory, "plugin.json"), JSON.stringify({
      manifest_version: 1, host_api: "1", id: "org.test.relationships", version: version + ".0.0", license: "MIT", dependencies: [],
      display: { "zh-CN": "人物关系样本", en: "Relationships sample" }, description: { "zh-CN": "固定版本的人物关系", en: "Versioned relationships" },
      permissions: ["objects.read", "objects.write"], contributions: {
        views: [{ id: "main", title: "人物关系样本", entry: "index.html", object_kinds: [] }], actions: [],
        data: [{ kind: "relationships", schema_version: version, schema: { type: "object", additionalProperties: false, required: [field], properties: { [field]: { type: "array", items: { type: "string" } } } } }],
      },
    }));
    await writeFile(path.join(directory, "index.html"), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>人物关系</title><h1>人物关系样本</h1></html>');
    return PluginPackage.inspect(directory);
  }
  const originalPackage = await pkg("1"), newPackage = await pkg("2");
  const fixture = spawnSync(path.join(root, "target/debug/examples/plugin_fixture"), [workspace, access, path.join(originalPackage.source, "plugin.json"), originalPackage.sha256], { encoding: "utf8", timeout: 30000 });
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  const binary = process.env.HETU_PACKAGED_APP;
  let machine = path.join(root, "target/debug");
  function cli(grant: string, sha: string, action: string, input: any) {
    const result = spawnSync(path.join(machine, "hetu-plugin"), ["--workspace", workspace, "--access-dir", access, "--grant", grant, "--package-sha256", sha, "call", "hetu.extensions." + action, "--input", "-"], { encoding: "utf8", timeout: 30000, input: JSON.stringify({ ...input, work_ref: context.work_ref }) });
    expect(result.error?.message ?? "", result.stderr).toBe("");
    return JSON.parse(result.stdout);
  }
  const before = cli(context.grant_id, originalPackage.sha256, "objects.save", { kind: "relationships", title: "雾港人物", schema_version: "1", content: { names: ["江岚", "叶渡"] }, source_refs: context.source_refs, expected_revision: 0, expected_sha256: "", operation_key: "old-object" }).data;
  const env = { ...process.env };
  for (const key of ["HETU_APP_SERVER", "HETU_CLI", "HETU_PLUGIN_NODE", "HETU_PLUGIN_CLI", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  const app = await electron.launch({ ...(binary ? { executablePath: binary, args: [] } : { args: [path.join(root, "apps/desktop")] }), env: { ...env,
    HETU_DESKTOP_PROFILE: profile, HETU_PLUGIN_ACCESS_DIR: access, HETU_COLLABORATION_DIR: path.join(folder, "collaboration"),
    ...(!binary ? { HETU_APP_SERVER: path.join(machine, "hetu-app-server"), HETU_PLUGIN_NODE: process.execPath } : {}),
  } });
  let client: Client | undefined, closed = false;
  try {
    let runtime = path.join(root, "apps/desktop/dist/plugin-runtime.mjs"), node = process.execPath;
    if (binary) {
      const resources = await app.evaluate(() => process.resourcesPath);
      machine = path.join(resources, "bin"); runtime = path.join(resources, "app/dist/plugin-runtime.mjs"); node = path.join(machine, "node");
    }
    const page = await app.firstWindow();
    await app.evaluate(({ dialog, clipboard }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      // 验证真实交接处理器的写入，隔离其他桌面会话对系统剪贴板的修改。
      let copied = "";
      clipboard.writeText = value => { copied = value; };
      clipboard.readText = () => copied;
    }, workspace);
    await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
    await page.getByRole("button", { name: /插件集成测试/ }).click();
    await navigate(page, "创作插件");
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, newPackage.source);
    await page.getByRole("button", { name: "安装插件包", exact: true }).click();
    await page.getByRole("button", { name: "人物关系样本", exact: true }).click();
    await expect.poll(() => app.windows().some(view => view.url().startsWith("hetu-plugin://"))).toBe(true);
    const preferences = JSON.parse(await readFile(path.join(profile, "plugin-state.json"), "utf8"));
    const grant = Object.entries(preferences.grants).find(([key]) => key.includes(newPackage.sha256))![1] as string;
    await navigate(page, "创作插件");
    const prepared = cli(grant, newPackage.sha256, "migrations.prepare", { object_id: before.object.object_id, expected_revision: 1, expected_sha256: before.sha256, target_schema_version: "2", content: { characters: before.object.content.names }, operation_key: "upgrade-characters" });
    expect(prepared.status).toBe("succeeded");
    const plan = prepared.data;
    const execution = { migration_id: plan.plan.migration_id, plan_sha256: plan.plan_sha256, operation_key: "upgrade-characters" };
    expect(cli(grant, newPackage.sha256, "migrations.execute", execution).error.code).toBe("permission_denied");
    const panel = page.getByRole("region", { name: "人物关系样本数据升级", exact: true });
    await panel.getByRole("button", { name: "查看数据升级", exact: true }).click();
    await panel.getByRole("button", { name: "审阅升级内容", exact: true }).click();
    const preview = panel.getByRole("region", { name: "固定插件数据升级预览", exact: true });
    await expect(preview).toContainText('"names"'); await expect(preview).toContainText('"characters"');
    await expect(preview).toContainText("江岚"); await expect(preview).toContainText("叶渡");
    await preview.getByRole("button", { name: "批准此数据升级", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("已批准此数据升级，等待原 Agent 执行。");
    await preview.getByRole("button", { name: "让 AI 接续此升级", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("已复制此升级的固定交接，交给原 Agent 继续。");
    const handoff = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(handoff).toContain(plan.plan.migration_id);
    const fixedHandoff = JSON.parse(handoff.slice(handoff.indexOf("{")));
    expect(fixedHandoff.plugin_connection.grant_id).toBe(grant);
    expect(fixedHandoff.plugin_connection.operation_key).toBe("upgrade-characters");
    expect(fixedHandoff.plugin_connection.plan_sha256).toBe(plan.plan_sha256);
    expect(fixedHandoff.plugin_connection.work_ref).toEqual(context.work_ref);
    expect(cli(grant,newPackage.sha256,"objects.get",{object_id:before.object.object_id}).data.object.revision).toBe(1);
    await page.screenshot({ path: path.join(root, "output/plugin-doc-qa/plugin-migration-review.png") });
    await app.close(); closed = true;
    client = new Client({ name: "hetu-migration-e2e", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StdioClientTransport({ command: node, args: [runtime, "--package", newPackage.source, "--workspace", workspace, "--access-dir", access, "--grant", grant, "--package-sha256", newPackage.sha256, "--core-cli", path.join(machine, "hetu-plugin"), "--mcp"], stderr: "pipe" }));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain("plugin_migrations_execute"); expect(names).not.toContain("approve_migration");
    const done: any = (await client.callTool({ name: "plugin_migrations_execute", arguments: execution })).structuredContent;
    expect(done.status).toBe("succeeded"); expect(done.data.object.revision).toBe(2);
    const recovered = cli(grant,newPackage.sha256,"operations.get",{operation_key:"upgrade-characters"});
    expect(recovered).toEqual(done);
    expect(cli(grant,newPackage.sha256,"migrations.execute",execution)).toEqual(done);
    const history: any = (await client.callTool({ name: "plugin_objects_get", arguments: { object_id: before.object.object_id, revision: 1 } })).structuredContent;
    expect(history.data).toEqual(before);
  } finally { await client?.close(); if (!closed) await app.close(); }
});
