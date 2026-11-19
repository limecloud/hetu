import { navigate } from "./navigation.ts";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";

const root = path.resolve(import.meta.dirname, "../../..");
function data(result: any) {
  expect(result.status, JSON.stringify(result)).toBe("succeeded");
  return result.data;
}
for (const kind of ["novel", "drama"] as const) test(`${kind} CLI/MCP固定导入、作者审阅与原键交付核验`, async () => {
    test.setTimeout(120000);
  const folder = await mkdtemp(path.join(os.tmpdir(), `hetu-transfer-${kind}-`)),
    workspace = path.join(folder, "作品"), access = path.join(folder, "access"),
    profile = path.join(folder, "desktop"), collaboration = path.join(folder, "collaboration");
  const pkg = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  const fixture = spawnSync(path.join(root, "target/debug/examples/plugin_fixture"),
    [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  let app: ElectronApplication | undefined, client: Client | undefined, page: Page, work: any;
  const executable = process.env.HETU_PACKAGED_APP;
  let machineBin = path.join(root, "target/debug");
  const binary = (name: string) => path.join(machineBin, name + (process.platform === "win32" ? ".exe" : ""));
  async function launch() {
    const env = { ...process.env };
    for (const key of ["HETU_APP_SERVER", "HETU_CLI", "HETU_PLUGIN_CLI", "HETU_PLUGIN_NODE", "ELECTRON_RUN_AS_NODE"]) delete env[key];
    app = await electron.launch({ ...(executable ? { executablePath: executable, args: [] } : { args: [path.join(root, "apps/desktop")] }), env: {
      ...env, HETU_DESKTOP_PROFILE: profile, HETU_COLLABORATION_DIR: collaboration,
      HETU_PLUGIN_ACCESS_DIR: access,
      ...(!executable ? { HETU_APP_SERVER: binary("hetu-app-server"), HETU_PLUGIN_NODE: process.execPath } : {}),
    } });
    if (executable) machineBin = path.join(await app.evaluate(() => process.resourcesPath), "bin");
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, workspace);
    page = await app.firstWindow();
    await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
    await page.getByRole("button", { name: kind === "novel" ? /插件集成测试/ : /独立剧本/ }).click();
    await expect(page.getByRole("complementary", { name: "项目导航", exact: true })).toBeVisible();
    work = (await page.evaluate(() => (window as any).hetuDesktop.state())).work;
    expect(work.kind).toBe(kind);
  }
  const cli = (grant: any, action: string, input: any) => {
    const r = spawnSync(binary("hetu"), ["--client", "codex", "--collaboration-dir", collaboration, "call", action, "--input", "-"], {
      encoding: "utf8", input: JSON.stringify({ ...input, management_ref: grant }),
    });
    expect(r.error?.message ?? "", r.stderr).toBe("");
    return JSON.parse(r.stdout);
  };
  async function approve(proposal: any, surface: string, loseReceipt = false) {
    await page.getByRole("button", { name: surface, exact: true }).click();
    await page.getByRole("button", { name: "刷新管理方案", exact: true }).click();
    await page.getByRole("combobox", { name: "当前管理方案" }).selectOption(proposal.proposal_id);
    await page.getByRole("button", { name: "批准此方案", exact: true }).click();
    await expect(page.getByRole("region", { name: "管理方案决定预览" })).toBeVisible();
    if (loseReceipt) {
      await page.evaluate(async (proposal) => {
        const api = (window as any).hetuDesktop;
        const fixed = await api.management("prepare", {
          proposal_id: proposal.proposal_id, proposal_sha256: proposal.proposal_sha256,
          state_revision: proposal.state_revision, decision: "approve",
        });
        const result = await api.management("commit", { token: fixed.token });
        if (result.status !== "succeeded") throw new Error(JSON.stringify(result));
      }, proposal);
      return;
    }
    await page.getByRole("button", { name: "确认此审核决定", exact: true }).click();
    await expect(page.getByRole("region", { name: "固定管理方案", exact: true }))
      .toContainText("已批准，待执行");
  }
  try {
    await launch();
    const grant = (await page!.evaluate(() => (window as any).hetuDesktop.connection("authorize", "codex"))).management_ref;
    client = new Client({ name: "hetu-transfer-e2e", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StdioClientTransport({ command: binary("hetu-mcp"), args: ["--client", "codex", "--collaboration-dir", collaboration], stderr: "pipe" }));
    const catalog = (await client.listTools()).tools;
    const exposed = catalog.filter(tool => JSON.stringify((tool._meta?.ui as any)?.visibility) !== '["app"]').map((tool) => tool.name);
    expect(catalog.find(tool => tool.name === "hetu_app_request")?._meta).toMatchObject({ui:{visibility:["app"]}});
    expect(exposed).toContain("hetu_call_action");
    expect(exposed.length).toBeLessThanOrEqual(13);
    const tool = async (name: string, args: any) => (await client!.callTool({ name, arguments: { ...args, management_ref: grant } })).structuredContent as any;
    const text = kind === "novel" ? "# 潮汐来信\n\n潮汐带回了那封信🌿。\n" : "INT. 灯塔 - NIGHT\n\n江岚\n潮汐带回了那封信🌿。\n";
    const source = { work_ref: work, inline_source: { filename: "原稿.txt", base64: Buffer.from(text).toString("base64"), sha256: createHash("sha256").update(text).digest("hex") }, format: kind === "novel" ? "markdown" : "fountain", profile: "source/1" };
    const preview = data((await client.callTool({ name: "hetu_call_action", arguments: {
      action: "hetu.documents.preview_import", input: { ...source, management_ref: grant },
    } })).structuredContent).preview;
    let target: any;
    if (kind === "novel") {
      const novel = data(cli(grant, "hetu.novels.get", {}));
      target = { novel_expected: { revision: novel.revision, sha256: novel.sha256 } };
    } else {
      const project = data(cli(grant, "hetu.drama.projects.get", { project_id: work.object_id }));
      target = { drama_project_ref: { project_id: work.object_id, revision: project.project.revision, sha256: project.sha256 } };
    }
    const before = data(cli(grant, "hetu.documents.list", { work_ref: work })).documents.length;
    const proposal = data(cli(grant, "hetu.agent_operations.prepare", { action: "hetu.documents.import", input: {
      work_ref: work, preview, kind: kind === "novel" ? "novel_chapter" : "drama_script", title: "潮汐来信", language_tag: "zh-CN", acknowledgement: "核对原稿与格式损失。", operation_key: "import", ...target,
    }, summary: "导入潮汐来信", operation_key: "import-plan" }));
    await navigate(page!, "原稿导入");
    await page!.getByRole("combobox", { name: "当前管理方案" }).selectOption(proposal.proposal_id);
    await expect(page!.getByRole("region", { name: "固定导入内容" })).toContainText(text.trim());
    await page!.getByRole("button", { name: "让 AI 准备导入", exact: true }).click();
    await expect(page!.getByRole("status")).toContainText("已准备当前作品的协作请求");
    const handoff = await app!.evaluate(({ clipboard }) => JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")));
    expect(handoff.page).toBe("work.import");
    expect(handoff.management_ref).toEqual(grant);
    expect(handoff.core_cli).toBe(binary("hetu"));
    expect(handoff.proposal_actions).toContain("hetu.documents.import");
    await approve(proposal, "原稿导入", true);
    expect(data(cli(grant, "hetu.documents.list", { work_ref: work })).documents).toHaveLength(before);
    // 模拟批准已提交但回执丢失，重开后在专用工作面恢复同一决定。
    await app!.close(); app = undefined;
    const journalDir = path.join(profile, "management-buffers");
    for (const file of await readdir(journalDir)) {
      const name = path.join(journalDir, file), record = JSON.parse(await readFile(name, "utf8"));
      if (record?.proposal_id === proposal.proposal_id) {
        record.status = "pending";
        await writeFile(name, JSON.stringify(record));
      }
    }
    await launch();
    await navigate(page!, "原稿导入");
    await page!.getByRole("combobox", { name: "当前管理方案" }).selectOption(proposal.proposal_id);
    const recovery = page!.getByRole("button", { name: "恢复原审核决定", exact: true });
    await recovery.click();
    await expect(page!.getByRole("status")).toContainText("原审核决定已确认");
    const execute = { proposal_id: proposal.proposal_id, proposal_sha256: proposal.proposal_sha256, operation_key: "execute-import" };
    const imported = data(cli(grant, "hetu.agent_operations.execute", execute)).result;
    expect(data(cli(grant, "hetu.agent_operations.execute", execute)).result).toEqual(imported);
    expect(data(cli(grant, "hetu.documents.list", { work_ref: work })).documents).toHaveLength(before + 1);
    const read = data(await tool("hetu_get_document", { document_id: imported.document.document_id }));
    expect(read.content).toBe(text);
    expect(read.revision.origin_kind).toBe("import");
    if (kind === "drama") expect(imported.document.drama_episode_id).toBeTruthy();
    const reference = { document_id: imported.document.document_id, revision_id: imported.revision.revision_id, sha256: imported.revision.sha256 };
    const bp = data(cli(grant, "hetu.blueprints.get", { work_ref: work }));
    const fixed = data(await tool("hetu_managed_bundles_preview", { work_ref: work, selection: { blueprint_ref: { revision: bp.revision, sha256: bp.sha256 }, document_refs: [reference] }, profile: "review_delivery", reading_formats: ["txt"] })).preview;
    const delivery = data(cli(grant, "hetu.agent_operations.prepare", { action: "hetu.bundles.export", input: { preview: fixed, acknowledgement: "确认审阅包与排除范围。", operation_key: "bundle" }, summary: "潮汐来信审阅交付", operation_key: "bundle-plan" }));
    await navigate(page!, "作品交付");
    await page!.getByRole("combobox", { name: "当前管理方案" }).selectOption(delivery.proposal_id);
    await expect(page!.getByRole("region", { name: "固定交付选集" })).toContainText("审阅交付包");
    await expect(page!.getByRole("combobox", { name: "当前管理方案" })).not.toContainText("导入潮汐来信");
    await approve(delivery, "作品交付");
    const args = { proposal_id: delivery.proposal_id, proposal_sha256: delivery.proposal_sha256, operation_key: "execute-delivery" };
    const exported = data(cli(grant, "hetu.agent_operations.execute", args)).result;
    const bytes = await readFile(path.join(workspace, exported.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(exported.sha256);
    expect(data(cli(grant, "hetu.agent_operations.execute", args)).result).toEqual(exported);
    expect(data(await tool("hetu_managed_bundles_verify", { work_ref: work, bundle_id: exported.bundle_id })).verified).toBe(true);
    await page!.getByRole("button", { name: "刷新管理方案", exact: true }).click();
    await expect(page!.getByRole("region", { name: "实际交付结果" })).toContainText(exported.path);
    await page!.getByRole("button", { name: "核验实际交付包", exact: true }).click();
    await expect(page!.getByRole("status").filter({ hasText: "实际文件完整性核验通过" })).toBeVisible();
    await page!.screenshot({ path: path.join(root, `output/plugin-doc-qa/transfer-${kind}${executable ? "-packaged" : ""}.png`) });
    await page!.evaluate(() => (window as any).hetuDesktop.connection("revoke", "codex"));
    await page!.getByRole("button", { name: "核验实际交付包", exact: true }).click();
    await expect(page!.getByRole("alert")).toContainText("当前作品的 Agent 连接已断开");
  } finally {
    await client?.close();
    await app?.close();
  }
});
