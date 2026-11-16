import { openDirectory } from "./navigation.ts";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { Authoring } from "../src/main/authoring.ts";
import { RecoveryStore } from "../src/main/recovery.ts";
import { AppServer } from "../src/main/rpc.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("新稿发送前连接中断：阻止另一采纳，重开后仅以原输入和原键补执行", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-unsent-adoption-")),
    workspace = path.join(folder, "作品");
  const pkg = await PluginPackage.inspect(
    path.join(root, "plugins/relationships/dist"),
  );
  const fixture = spawnSync(
    path.join(root, "target/debug/examples/plugin_fixture"),
    [
      workspace,
      path.join(folder, "access"),
      path.join(pkg.source, "plugin.json"),
      pkg.sha256,
      "0",
      "--new-targets",
    ],
    { encoding: "utf8" },
  );
  expect(fixture.status, fixture.stderr).toBe(0);
  const target = JSON.parse(fixture.stdout).new_adoptions.novel;
  const server = await AppServer.open(
    path.join(root, "target/debug/hetu-app-server"),
    workspace,
  );
  const call = (action: string, input: any) =>
    server.request("workspace/request", {
      action,
      input,
      contract_revision: "1",
    });
  const buffers = path.join(folder, "author-buffers");
  let disconnected = true;
  const first = new Authoring(
    target.work_ref,
    buffers,
    new RecoveryStore(),
    (action, input) => {
      if (action === "hetu.drafts.adopt" && disconnected)
        throw new Error("模拟发送前连接中断");
      return call(action, input);
    },
    () => true,
  );
  try {
    const preview = await first.adoption(target.candidate, target.task_ref);
    await expect(first.commit(preview.token)).rejects.toThrow(
      "模拟发送前连接中断",
    );
    const saved = await first.journal(target.task_ref);
    expect(saved.status).toBe("pending");
    expect(
      (
        await call("hetu.operations.get", {
          action: "hetu.drafts.adopt",
          key: saved.input.operation_key,
        })
      ).error.code,
    ).toBe("not_found");
    disconnected = false;
    const other = await first.adoption(target.candidate, target.task_ref);
    await expect(first.commit(other.token)).rejects.toThrow("请先恢复");
    expect(
      (await call("hetu.documents.list", { work_ref: target.work_ref })).data
        .documents,
    ).toHaveLength(1);
    const reopened = new Authoring(
      target.work_ref,
      buffers,
      new RecoveryStore(),
      call,
      () => true,
    );
    const restored = await reopened.recover(target.task_ref);
    expect(restored.status).toBe("succeeded");
    expect(restored.operation.key).toBe(saved.input.operation_key);
    expect((await reopened.recover(target.task_ref)).data).toEqual(
      restored.data,
    );
    expect(
      (await call("hetu.documents.list", { work_ref: target.work_ref })).data
        .documents,
    ).toHaveLength(2);
    await reopened.acknowledge(target.task_ref, restored.operation.key);
    expect(await reopened.journal(target.task_ref)).toBeNull();
  } finally {
    await server.close();
  }
});
test(
  "新章节与分集先预览后创建、精确归属，旧批次回执丢失后原键恢复不重复", async () => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-new-adoption-")),
      workspace = path.join(folder, "作品"),
      access = path.join(folder, "access"),
      profile = path.join(folder, "profile");
    const pkg = await PluginPackage.inspect(
      path.join(root, "plugins/relationships/dist"),
    );
    const fixture = spawnSync(
      path.join(root, "target/debug/examples/plugin_fixture"),
      [
        workspace,
        access,
        path.join(pkg.source, "plugin.json"),
        pkg.sha256,
        "1",
        "--new-targets",
      ],
      { encoding: "utf8" },
    );
    expect(fixture.status, fixture.stderr).toBe(0);
    const context = JSON.parse(fixture.stdout),
      novel = context.new_adoptions.novel,
      drama = context.new_adoptions.drama;
    let application: ElectronApplication | undefined;
    async function launch() {
      application = await electron.launch({
        args: [path.join(root, "apps/desktop")],
        env: {
          ...process.env,
          HETU_DESKTOP_PROFILE: profile,
          HETU_COLLABORATION_DIR: path.join(folder, "collaboration"),
          HETU_PLUGIN_ACCESS_DIR: access,
          HETU_PLUGIN_NODE: process.execPath,
          HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"),
        },
      });
      await application.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [directory],
        });
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      }, workspace);
      const page = await application.firstWindow();
      await page.setViewportSize({ width: 1024, height: 768 });
      return page;
    }
    let page = await launch();
    const read = (action: string, input: any) =>
      page.evaluate(
        ({ action, input }) => (window as any).hetuDesktop.read(action, input),
        { action, input },
      );
    const author = (method: string, input: any) =>
      page.evaluate(
        ({ method, input }) =>
          (window as any).hetuDesktop.author(method, input),
        { method, input },
      );
    async function openTask(target: any) {
      await page
        .getByRole("button", { name: "参考稿审核", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "当前审阅任务" })
        .selectOption(target.task_ref.task_id);
      await page.getByText("采纳到作者正文", { exact: true }).click();
    }
    try {
      await page
        .getByRole("button", { name: "打开作品", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      await expect(
        page.getByRole("complementary", { name: "项目导航", exact: true }),
      ).toBeVisible();
      const before = (
        await read("hetu.documents.list", { work_ref: novel.work_ref })
      ).data.documents.length;
      await openTask(novel);
      await page
        .getByRole("combobox", { name: "采纳参考方案" })
        .selectOption({ label: "潮汐来信" });
      await expect(
        page.getByRole("button", { name: "预览采纳变化", exact: true }),
      ).toBeEnabled();
      await page.getByText("调整新章节位置与标题", { exact: true }).click();
      await expect(page.getByRole("textbox", { name: "新稿标题" })).toHaveValue(
        "潮汐来信",
      );
      await page
        .getByRole("textbox", { name: "新稿标题" })
        .fill("第三章 潮汐来信");
      await page
        .getByRole("combobox", { name: "新稿所属分卷" })
        .selectOption({ label: "第一卷 海上" });
      await page
        .getByRole("button", { name: "预览采纳变化", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "采纳为新章节「第三章 潮汐来信」" }),
      ).toBeVisible();
      expect(
        (await read("hetu.documents.list", { work_ref: novel.work_ref })).data
          .documents,
      ).toHaveLength(before);
      await application!.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 0,
          checkboxChecked: false,
        });
      });
      await page
        .getByRole("button", { name: "确认此预览", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("已取消");
      expect(
        (await read("hetu.documents.list", { work_ref: novel.work_ref })).data
          .documents,
      ).toHaveLength(before);
      await application!.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      });
      await page
        .getByRole("button", { name: "确认此预览", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("尚未定稿");
      const novelState = (
        await read("hetu.works.get", { work_ref: novel.work_ref })
      ).data;
      const chapters = (
        await read("hetu.documents.list", { work_ref: novel.work_ref })
      ).data.documents;
      expect(chapters).toHaveLength(before + 1);
      const chapter = chapters.find(
        (item: any) => item.title === "第三章 潮汐来信",
      );
      const volume = novelState.record.volumes.find(
        (item: any) => item.title === "第一卷 海上",
      );
      expect(
        novelState.record.chapters.find(
          (item: any) => item.document_id === chapter.document_id,
        ).volume_id,
      ).toBe(volume.volume_id);
      const savedChapter = (
        await read("hetu.documents.get", { document_id: chapter.document_id })
      ).data;
      expect(savedChapter.content).toBe(
        novel.submit_input.candidates[0].content,
      );
      expect(savedChapter.document.finalization_ref ?? null).toBeNull();

      // 当前小说不能读取另一个剧本任务的作者恢复记录。
      expect(
        await page.evaluate(async (task_ref) => {
          try {
            await (window as any).hetuDesktop.author("new_adoption_journal", {
              task_ref,
            });
            return false;
          } catch {
            return true;
          }
        }, drama.task_ref),
      ).toBe(true);
      await page.getByRole("button", { name: "返回创作库", exact: true }).click();
      await page.getByRole("button", { name: /独立剧本/ }).click();
      await expect(
        page.locator(".workspace-switcher .workspace-title"),
      ).toHaveText("独立剧本");
      await openTask(drama);
      await page
        .getByRole("combobox", { name: "采纳参考方案" })
        .selectOption({ label: "第二集 潮汐" });
      await page
        .getByRole("button", { name: "预览采纳变化", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "采纳为新分集「第二集 潮汐」" }),
      ).toBeVisible();
      const beforeProject = (
        await read("hetu.drama.projects.get", {
          project_id: drama.work_ref.object_id,
        })
      ).data;
      expect(beforeProject.episodes).toHaveLength(1);
      await page.screenshot({
        path: path.join(root, "output/plugin-doc-qa/new-episode-preview.png"),
      });
      // 提交已审阅预览但不消费回执，模拟确认写入后的窗口中断。
      const fixed = await author("adoption", {
        task_ref: drama.task_ref,
        candidate_id: drama.candidate.candidate_id,
      });
      const committed = await author("commit", { token: fixed.token });
      expect(committed.status).toBe("succeeded");
      expect(committed.data.episode.project_id).toBe(drama.work_ref.object_id);
      const documentId = committed.data.document.document_id;
      const journalDirectory = path.join(profile, "author-buffers");
      const names = await readdir(journalDirectory);
      let journalFile = "";
      for (const name of names) {
        const file = path.join(journalDirectory, name),
          record = JSON.parse(await readFile(file, "utf8"));
        if (record?.task_ref?.task_id === drama.task_ref.task_id) {
          journalFile = file;
          await writeFile(
            file,
            JSON.stringify({ ...record, status: "pending" }),
          );
        }
      }
      expect(journalFile).not.toBe("");
      const next = structuredClone(drama.submit_input);
      next.operation_key = "new-batch-after-adoption";
      next.candidates[0].title = "后续批次方案";
      const submitted = spawnSync(
        path.join(root, "target/debug/hetu"),
        [
          "--workspace",
          workspace,
          "--task",
          drama.task_ref.task_id,
          "call",
          "hetu.creative_tasks.submit_result",
          "--input",
          "-",
        ],
        { input: JSON.stringify(next), encoding: "utf8" },
      );
      expect(submitted.status, submitted.stderr).toBe(0);
      await application!.close();
      application = undefined;
      page = await launch();
      await page.getByRole("button", { name: /独立剧本/ }).click();
      await expect(
        page.locator(".workspace-switcher .workspace-title"),
      ).toHaveText("独立剧本");
      await openTask(drama);
      await expect(
        page.getByText(/采纳为新分集「第二集 潮汐」 结果待确认/),
      ).toBeVisible();
      await page
        .getByRole("combobox", { name: "采纳参考方案" })
        .selectOption({ label: "后续批次方案" });
      await expect(
        page.getByRole("button", { name: "预览采纳变化", exact: true }),
      ).toBeDisabled();
      const reordered = {
        request_revision: drama.task_ref.request_revision,
        task_id: drama.task_ref.task_id,
        scope_ref: {
          id: drama.task_ref.scope_ref.id,
          kind: drama.task_ref.scope_ref.kind,
        },
      };
      expect(
        (await author("new_adoption_journal", { task_ref: reordered })).input
          .operation_key,
      ).toBe(committed.operation.key);
      await page
        .getByRole("button", { name: "恢复原新稿采纳", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "已恢复「第二集 潮汐」",
      );
      const project = (
        await read("hetu.drama.projects.get", {
          project_id: drama.work_ref.object_id,
        })
      ).data;
      expect(project.episodes).toHaveLength(2);
      expect(project.episodes[1].episode.document_id).toBe(documentId);
      const lifecycle = (
        await read("hetu.documents.lifecycle", { document_id: documentId })
      ).data;
      expect(lifecycle.adoptions).toHaveLength(1);
      expect(lifecycle.adoptions[0].draft_ref).toEqual(
        drama.candidate.draft_ref,
      );
      expect(JSON.parse(await readFile(journalFile, "utf8"))).toBeNull();
      await page
        .getByRole("button", { name: "剧本", exact: true })
        .click();
      await openDirectory(page);
      await page
        .getByRole("button", { name: "第二集 潮汐", exact: true })
        .click();
      await expect(page.getByRole("textbox", { name: "文稿编辑", exact: true })).toContainText("信是你写的？");
      await page.screenshot({
        path: path.join(root, "output/plugin-doc-qa/new-episode-recovered.png"),
      });
    } finally {
      await application?.close();
    }
  },
);
