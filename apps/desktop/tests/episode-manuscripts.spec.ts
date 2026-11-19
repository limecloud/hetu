import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { AppServer } from "../src/main/rpc.ts";
import { navigate, openDirectory } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("分集直接阅读已提交参考稿和工作稿，原任务分页审阅不采纳，重开后保留作者正文", async () => {
  test.setTimeout(180_000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-episode-manuscripts-"));
  const workspace = path.join(folder, "作品"), collaboration = path.join(folder, "collaboration"), profile = path.join(folder, "desktop");
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, collaboration], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  const server = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  const call = async (action: string, input: any) => {
    const result = await server.request("workspace/request", { action, input, contract_revision: "1" });
    expect(result.status, JSON.stringify(result)).toBe("succeeded"); return result.data;
  };
  let project: any, empty: any, working: any, authoredTask: any, submittedTask: any, workingTask: any, foreignEpisode: any;
  async function prepare(document: any, brief: string) {
    const value = await call("hetu.documents.get", { document_id: document.document_id });
    const preview = await call("hetu.creative_tasks.preview_prompt", {
      scope_ref: { kind: "workspace", id: context.drama.workspace_id }, work_ref: context.drama,
      target_ref: { document_id: document.document_id, revision_id: value.revision.revision_id, sha256: value.revision.sha256 },
      task_kind: "drama_draft", brief, input_refs: [], client_adapter: "codex", language_tag: "zh-CN", candidate_limit: 4,
    });
    return call("hetu.creative_tasks.prepare", { ...preview.prepare_input, operation_key: brief });
  }
  try {
    project = await call("hetu.drama.projects.get", { project_id: context.drama.object_id });
    authoredTask = await prepare({ document_id: project.episodes[0].episode.document_id }, "作者稿的备选");
    const add = async (title: string) => {
      project = await call("hetu.drama.projects.get", { project_id: context.drama.object_id });
      return call("hetu.drama.episodes.create", { project_ref: { project_id: context.drama.object_id, revision: project.project.revision, sha256: project.sha256 }, title, language_tag: "zh-CN", operation_key: title });
    };
    empty = await add("第二集 参考稿已到"); working = await add("第三集 尚在写作");
    submittedTask = await prepare(empty.document, "第二集待审剧本");
    workingTask = await prepare(working.document, "第三集工作稿");
    // 确保从分集进入审核时，目标任务位于首批30条之后。
    for (let index = 0; index < 31; index++) await prepare({ document_id: project.episodes[0].episode.document_id }, `其他任务${index}`);
    const other = await call("hetu.drama.projects.create", { title: "另一部剧本", mode: "original", operation_key: "other" });
    foreignEpisode = await call("hetu.drama.episodes.create", { project_ref: { project_id: other.project.project_id, revision: other.project.revision, sha256: other.sha256 }, title: "异作分集", language_tag: "zh-CN", operation_key: "foreign" });
  } finally { await server.close(); }
  const agent = (task: any, action: string, input: any) => {
    const result = spawnSync(path.join(root, "target/debug/hetu"), ["--workspace", workspace, "--task", task.task_ref.task_id, "call", action, "--input", "-"], { input: JSON.stringify({ task_ref: task.task_ref, ...input }), encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).data;
  };
  const save = (task: any, title: string, content: string, submit: boolean) => {
    const copy = agent(task, "hetu.working_copies.create", { artifact_kind: "text", title, source_format: "fountain", base_refs: [], feedback_refs: [], content, operation_key: title });
    if (submit) agent(task, "hetu.creative_tasks.submit_result", { request_sha256: task.request_sha256, working_copy_refs: [copy.working_copy_ref], complete: true, missing_items: [], feedback_refs: [], provenance: { client: "acceptance", skill_version: "1" }, operation_key: title + "-submit" });
    return copy;
  };
  save(authoredTask, "作者稿的备选参考稿", "INT. 灯塔 - 夜\n\n这是另一个备选。", true);
  const submitted = save(submittedTask, "正式提交的参考稿", "INT. 渡口 - 夜\n\n江岚\n先把那封信交给我。", true);
  const pending = save(submittedTask, "更新但未提交的工作稿", "INT. 渡口 - 晨\n\n这是仍在修改的另一版。", false);
  save(workingTask, "只有工作稿", "EXT. 山路 - 日\n\n江岚停下脚步。", false);
  let app: ElectronApplication | undefined;
  const processes = new WeakMap<ElectronApplication, ReturnType<ElectronApplication["process"]>>();
  function cleanup(application: ElectronApplication) {
    const child = processes.get(application);
    if (!child || child.exitCode !== null) return;
    const pid = child.pid!;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else { try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  }
  async function close() {
    const closing = app!, child = processes.get(closing)!;
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()));
    await closing.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), 100); });
    await expect.poll(() => closing.windows().length).toBe(0);
    // 已验证窗口关闭；保留启动时的进程引用，断连后不再调用Playwright进程接口。
    cleanup(closing); await exited; app = undefined;
  }
  async function launch() {
    app = await electron.launch({ args: [path.join(root, "apps/desktop")], env: { ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_COLLABORATION_DIR: collaboration, HETU_PLUGIN_STATE_DIR: path.join(folder, "empty-plugins"), HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server") } });
    processes.set(app, app.process());
    processes.get(app)!.stderr?.on("data", chunk => { if (chunk.toString().includes("验收退出")) console.error(chunk.toString()); });
    await app.evaluate(({ dialog, app }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      dialog.showMessageBoxSync = () => 1;
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      dialog.showErrorBox = (title, message) => console.error("验收退出错误", title, message);
    }, workspace);
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1360, height: 900 }); return page;
  }
  try {
    let page = await launch();
    await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
    await page.getByRole("button", { name: /默认剧本/ }).click();
    await expect(page.locator(".workspace-switcher .workspace-title")).toHaveText("默认剧本", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "剧本", exact: true })).toBeEnabled({ timeout: 30_000 });
    await navigate(page, "剧本"); await openDirectory(page);
    await expect(page.getByRole("textbox", { name: "文稿编辑", exact: true })).toContainText("船还没来");
    await page.getByRole("button", { name: "第二集 参考稿已到", exact: true }).click();
    await expect(page.getByRole("article", { name: "剧本参考稿" })).toHaveText("INT. 渡口 - 夜\n\n江岚\n先把那封信交给我。");
    await expect(page.getByRole("textbox", { name: "文稿编辑", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存修订", exact: true })).toBeDisabled();
    await expect(page.locator(".manuscript-title > span")).toHaveText("参考稿");
    const read = (action: string, input: any) => page.evaluate(({ action, input }) => (window as any).hetuDesktop.read(action, input), { action, input });
    const denied = (action: string, input: any) => page.evaluate(async ({ action, input }) => { try { await (window as any).hetuDesktop.read(action, input); return false; } catch { return true; } }, { action, input });
    expect(await denied("hetu.drama.episodes.get", { episode_id: foreignEpisode.episode.episode_id })).toBe(true);
    expect(await denied("hetu.working_copies.get", { episode_id: working.episode.episode_id, task_ref: submittedTask.task_ref, working_copy_ref: pending.working_copy_ref })).toBe(true);
    expect((await read("hetu.documents.get", { document_id: empty.document.document_id })).data.content).toBe("");
    await page.getByRole("combobox", { name: "分集稿件版本" }).selectOption({ label: "未提交工作稿 更新但未提交的工作稿" });
    await expect(page.getByRole("article", { name: "剧本参考稿" })).toContainText("仍在修改的另一版");
    await page.getByRole("combobox", { name: "分集稿件版本" }).selectOption("author");
    await expect(page.getByRole("textbox", { name: "文稿编辑", exact: true })).toHaveText("");
    await page.getByRole("button", { name: "刷新当前稿件", exact: true }).click();
    await expect(page.getByRole("article", { name: "剧本参考稿" })).toContainText("先把那封信交给我");
    for (const [width, appearance] of [[1360, "light"], [760, "dark"]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(value => { document.documentElement.dataset.appearance = value; document.documentElement.style.colorScheme = value; }, appearance);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(appearance);
      expect(await page.locator(".manuscript-paper").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await mkdir(path.join(root, "output/episode-manuscripts"), { recursive: true });
      await page.screenshot({ path: path.join(root, `output/episode-manuscripts/reference-${appearance}-${width}.png`) });
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.getByRole("button", { name: "审阅与提意见", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "当前审阅任务" })).toHaveValue(submittedTask.task_ref.task_id);
    const panel = page.frameLocator('iframe[title="任务候选审阅"]');
    await expect(panel.getByText(/先把那封信交给我/)).toBeVisible();
    await panel.getByRole("textbox", { name: "补充要求或意见", exact: true }).fill("保留对白，压缩开场动作。");
    await panel.getByRole("button", { name: "按此修改", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("修改意见已保存");
    expect((await read("hetu.documents.get", { document_id: empty.document.document_id })).data.content).toBe("");
    if (!await page.getByRole("complementary", { name: "项目导航", exact: true }).isVisible()) await page.getByRole("button", { name: "项目导航", exact: true }).click();
    await navigate(page, "剧本"); await openDirectory(page);
    await page.getByRole("button", { name: "第三集 尚在写作", exact: true }).click();
    await expect(page.getByRole("article", { name: "剧本参考稿" })).toContainText("江岚停下脚步");
    await close();
    page = await launch(); await page.getByRole("button", { name: /默认剧本/ }).click();
    await expect(page.locator(".workspace-switcher .workspace-title")).toHaveText("默认剧本", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "剧本", exact: true })).toBeEnabled({ timeout: 30_000 });
    await navigate(page, "剧本"); await openDirectory(page);
    await page.getByRole("button", { name: "第二集 参考稿已到", exact: true }).click();
    await expect(page.getByRole("article", { name: "剧本参考稿" })).toContainText("先把那封信交给我");
    expect((await read("hetu.documents.get", { document_id: empty.document.document_id })).data.document.finalization_ref ?? null).toBeNull();
    expect(submitted.working_copy_ref.sha256).not.toBe(pending.working_copy_ref.sha256);
    await close();
  } finally {
    if (app) cleanup(app);
  }
});
