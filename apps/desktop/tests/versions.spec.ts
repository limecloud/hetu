import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { VersionReview } from "../src/main/versions.ts";
import { RecoveryStore } from "../src/main/recovery.ts";
import { navigate } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
function data(result: any) {
  expect(["succeeded", "pending"], JSON.stringify(result)).toContain(result.status);
  return result.data;
}
test("长文批准逐页核验完整两侧，拒绝截断或变化的依据", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-version-pages-"));
  const work = { workspace_id: "workspace_00000000-0000-4000-8000-000000000000", kind: "novel" as const, object_id: "novel_00000000-0000-4000-8000-000000000000" };
  const id = "gitsnapshot_00000000-0000-4000-8000-000000000000", sha = "a".repeat(64);
  const before = "旧稿🌿。".repeat(100000), after = "新稿🪷加长。".repeat(100000);
  const slice = (text: string, offset: number) => {
    const bytes = Buffer.from(text); let end = Math.min(bytes.length, offset + 262144);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return { content: bytes.subarray(offset, end).toString(), end, next: end < bytes.length ? end : null };
  };
  let calls = 0, corrupt = false;
  const service = new VersionReview(work, directory, new RecoveryStore(), async (action, input) => {
    if (action === "hetu.git.get_snapshot") return { status: "succeeded", data: { snapshot: { selection: [{ path: "文稿" }] }, snapshot_sha256: sha, is_current: true } };
    calls++;
    const left = slice(before, input.before_offset_bytes), right = slice(after, input.after_offset_bytes);
    return { status: "succeeded", data: { path: "文稿", snapshot_sha256: corrupt ? "b".repeat(64) : sha, before: left.content, after: right.content, before_end_offset_bytes: left.end, after_end_offset_bytes: right.end, before_next_offset_bytes: left.next, after_next_offset_bytes: right.next } };
  }, () => true);
  const preview = await service.prepare(id, sha);
  expect(calls).toBeGreaterThan(4);
  expect(preview.diffs[0].before).toBe(before); expect(preview.diffs[0].after).toBe(after);
  corrupt = true;
  await expect(service.prepare(id, sha)).rejects.toThrow("无法完整核对");
});
test("版本批准发送前及提交后中断沿原键恢复，不重复批准或扩大作品", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-version-recovery-"));
  const work = { workspace_id: "workspace_00000000-0000-4000-8000-000000000000", kind: "novel" as const, object_id: "novel_00000000-0000-4000-8000-000000000000" };
  const id = "gitsnapshot_00000000-0000-4000-8000-000000000000", sha = "a".repeat(64);
  let stage = "before", approvals = 0;
  const keys: string[] = [], receipts = new Map<string, any>();
  const call = async (action: string, input: any) => {
    expect(input.work_ref).toEqual(work);
    if (action === "hetu.git.get_snapshot") return { status: "succeeded", data: { snapshot: { selection: [{ path: "文稿" }] }, snapshot_sha256: sha, is_current: true } };
    if (action === "hetu.git.snapshot_diff") return { status: "succeeded", data: { before: "旧稿", after: "新稿", snapshot_sha256: sha } };
    expect(action).toBe("hetu.git.approve_snapshot"); keys.push(input.operation_key);
    if (stage === "before") throw new Error("发送前中断");
    if (receipts.has(input.operation_key)) return receipts.get(input.operation_key);
    receipts.set(input.operation_key, { status: "succeeded", data: { approval_state: "approved" } }); approvals++;
    throw new Error("提交后回执丢失");
  };
  const service = new VersionReview(work, directory, new RecoveryStore(), call, () => true);
  const preview = await service.prepare(id, sha);
  await expect(service.commit(preview.token)).rejects.toThrow("发送前");
  await expect(service.prepare(id, sha)).rejects.toThrow("核对原");
  stage = "after";
  await expect(service.recover()).rejects.toThrow("回执丢失");
  const reopened = new VersionReview(work, directory, new RecoveryStore(), call, () => true);
  await reopened.recover();
  expect(approvals).toBe(1); expect(new Set(keys).size).toBe(1);
  await reopened.acknowledge((await reopened.journal())!.input.operation_key);
  expect(await reopened.journal()).toBeNull();
});

test("CLI准备独立文稿快照、Electron审阅批准、无窗口提交及真实MCP历史回读", async () => {
  test.setTimeout(180000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-work-versions-")), workspace = path.join(folder, "作品"), profile = path.join(folder, "desktop"), collaboration = path.join(folder, "collaboration"), access = path.join(folder, "access");
  const pkg = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  const fixture = spawnSync(path.join(root, "target/debug/examples/plugin_fixture"), [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256], { encoding: "utf8", timeout: 30000 });
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout), executable = process.env.HETU_PACKAGED_APP;
  let app: ElectronApplication | undefined, page: Page, client: Client | undefined, machine = path.join(root, "target/debug"), work: any;
  const binary = (name: string) => path.join(machine, name + (process.platform === "win32" ? ".exe" : ""));
  async function launch() {
    const env = { ...process.env };
    for (const key of ["HETU_APP_SERVER", "HETU_CLI", "HETU_PLUGIN_NODE", "HETU_PLUGIN_CLI", "ELECTRON_RUN_AS_NODE"]) delete env[key];
    app = await electron.launch({ ...(executable ? { executablePath: executable, args: [] } : { args: [path.join(root, "apps/desktop")] }), env: {
      ...env, HETU_DESKTOP_PROFILE: profile, HETU_COLLABORATION_DIR: collaboration, HETU_PLUGIN_ACCESS_DIR: access,
      ...(!executable ? { HETU_APP_SERVER: binary("hetu-app-server"), HETU_PLUGIN_NODE: process.execPath } : {}),
    } });
    if (executable) machine = path.join(await app.evaluate(() => process.resourcesPath), "bin");
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, workspace);
    page = await app.firstWindow();
    await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
    await page.getByRole("button", { name: /插件集成测试/ }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).hetuDesktop.state())).work?.object_id).toBe(context.work_ref.object_id);
    work = (await page.evaluate(() => (window as any).hetuDesktop.state())).work;
  }
  function cli(grant: any, action: string, input: any) {
    const result = spawnSync(binary("hetu"), ["--client", "codex", "--collaboration-dir", collaboration, "call", action, "--input", "-"], { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024, input: JSON.stringify({ ...input, management_ref: grant }) });
    expect(result.error?.message ?? "", result.stderr).toBe("");
    return JSON.parse(result.stdout);
  }
  try {
    await launch();
    const longContent = "灯塔在黎明前亮起。\n" + "雾港的来信🌿。\n".repeat(60000) + "分页长文结束。";
    expect(Buffer.byteLength(longContent)).toBeGreaterThan(1024 * 1024);
    const longVersion = data(await page!.evaluate(async ({ document, content }) => {
      const current = await (window as any).hetuDesktop.read("hetu.documents.get", { document_id: document });
      return (window as any).hetuDesktop.read("hetu.documents.save", {
        document_id: document, base_revision_id: current.data.revision.revision_id, source_format: "markdown", content, operation_key: "version-long-chapter",
      });
    }, { document: context.document.document_id, content: longContent }));
    const grant = (await page!.evaluate(() => (window as any).hetuDesktop.connection("authorize", "codex"))).management_ref;
    const init = data(cli(grant, "hetu.agent_operations.prepare", { action: "hetu.git.init", input: { work_ref: work, branch: "main", operation_key: "version-init" }, summary: "建立作品文稿版本库", operation_key: "prepare-init" }));
    await navigate(page!, "管理方案");
    await page!.getByRole("combobox", { name: "当前管理方案" }).selectOption(init.proposal_id);
    await page!.getByRole("button", { name: "批准此方案", exact: true }).click();
    await page!.getByRole("button", { name: "确认此审核决定", exact: true }).click();
    await expect(page!.getByRole("status")).toContainText("方案已批准");
    data(cli(grant, "hetu.agent_operations.execute", { proposal_id: init.proposal_id, proposal_sha256: init.proposal_sha256, operation_key: "execute-init" }));
    const status = data(cli(grant, "hetu.git.status", { work_ref: work }));
    expect(status.head.commit_id).toBeNull();
    const prepared = data(cli(grant, "hetu.git.snapshot", { work_ref: work, phase: "prepare", expected_head: status.head, message: "雾港开篇定点", author: { name: "测试作者", email: "author@hetu.test" }, operation_key: "snapshot-prepare" }));
    const id = prepared.snapshot.snapshot_id;
    await navigate(page!, "文稿版本");
    await page!.getByRole("region", { name: "已准备快照", exact: true }).getByRole("button", { name: "雾港开篇定点", exact: true }).click();
    await page!.getByRole("button", { name: "审阅完整快照差异", exact: true }).click();
    await expect(page!.getByRole("region", { name: "版本批准预览", exact: true })).toContainText("灯塔在黎明前亮起");
    await expect(page!.getByRole("region", { name: "版本批准预览", exact: true })).toContainText("分页长文结束。");
    await page!.getByRole("button", { name: "确认批准此快照", exact: true }).click();
    await expect(page!.getByRole("region", { name: "固定文稿快照", exact: true })).toContainText("等待 Agent 执行");
    expect(data(cli(grant, "hetu.git.get_snapshot", { work_ref: work, snapshot_id: id })).approval_state).toBe("approved");
    expect(data(cli(grant, "hetu.git.status", { work_ref: work })).head.commit_id).toBeNull();
    await page!.getByRole("button", { name: "让 AI 接续此版本", exact: true }).click();
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toContain(id);
    await app!.close(); app = undefined;
    const dir = path.join(profile, "version-decisions"), file = path.join(dir, (await readdir(dir))[0]);
    const recovery = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...recovery, status: "pending" }));
    const execution = { work_ref: work, phase: "execute", snapshot_id: id, operation_key: "snapshot-execute" };
    const done = data(cli(grant, "hetu.git.snapshot", execution));
    expect(data(cli(grant, "hetu.git.snapshot", execution))).toEqual(done);
    client = new Client({ name: "hetu-version-e2e", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StdioClientTransport({ command: binary("hetu-mcp"), args: ["--client", "codex", "--collaboration-dir", collaboration], stderr: "pipe" }));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain("hetu_commit_snapshot"); expect(names).not.toContain("hetu_git_approve_snapshot");
    const mcp = await client.callTool({ name: "hetu_managed_git_log", arguments: { management_ref: grant, work_ref: work } });
    expect(data(mcp.structuredContent).commits[0].commit_id).toBe(done.commit_id);
    await launch();
    await navigate(page!, "文稿版本");
    await page!.getByRole("button", { name: "恢复原版本批准", exact: true }).click();
    await expect(page!.getByRole("status")).toContainText("原版本批准已核对");
    await page!.getByRole("region", { name: "文稿版本历史", exact: true }).getByRole("button", { name: "雾港开篇定点", exact: true }).click();
    const fixed = await page!.evaluate((commit) => (window as any).hetuDesktop.versions("version", { commit_id: commit }), done.commit_id);
    const bodyFiles = fixed.files.filter((item: any) => /\.(md|fountain)$/.test(item.path));
    const index = bodyFiles.findIndex((item: any) => item.path === longVersion.revision.content_path);
    expect(index).toBeGreaterThanOrEqual(0);
    await page!.getByRole("button", { name: /第一章 雾港 文稿/ }).nth(index).click();
    await expect(page!.getByRole("article", { name: "历史正文", exact: true })).toContainText("灯塔在黎明前亮起");
    while (await page!.getByRole("button", { name: "继续阅读历史正文", exact: true }).isVisible()) {
      await page!.getByRole("button", { name: "继续阅读历史正文", exact: true }).click();
      await expect(page!.getByRole("button", { name: "刷新版本", exact: true })).toBeEnabled();
    }
    await expect(page!.getByRole("article", { name: "历史正文", exact: true })).toContainText("分页长文结束。");
    const current = data(await page!.evaluate((doc) => (window as any).hetuDesktop.read("hetu.documents.get", { document_id: doc }), context.document.document_id));
    expect(current.content).toContain("灯塔在黎明前亮起");
    await page!.screenshot({ path: path.join(root, "output/plugin-doc-qa/electron-versions.png") });
  } finally { await client?.close(); await app?.close(); }
});
