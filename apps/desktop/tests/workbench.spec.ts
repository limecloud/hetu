import { documentAction, navigate } from "./navigation.ts";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile, writeFile, cp, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
const root = path.resolve(import.meta.dirname, "../../..");
let application: ElectronApplication;
test.afterEach(async () => {
  if (application) await application.close();
});
test("Electron作品授权、精确页面交接与无窗口Rust CLI在撤权后失效", async () => {
    test.setTimeout(120000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-connection-")), workspace = path.join(folder, "作品"), access = path.join(folder, "private"), profile = path.join(folder, "desktop"), collaboration = path.join(profile, "collaboration");
  const pkg = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  const fixture = spawnSync(path.join(root, "target/debug/examples/plugin_fixture"), [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  application = await electron.launch({ args: [path.join(root, "apps/desktop")], env: { ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_COLLABORATION_DIR: collaboration, HETU_PLUGIN_NODE: process.execPath, HETU_PLUGIN_ACCESS_DIR: access, HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server") } });
  await application.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, workspace);
  const page = await application.firstWindow();
  await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
  await page.getByRole("button", { name: /插件集成测试/ }).click();
  await navigate(page, "Agent 协作");
  await expect(page.getByText("尚未授权当前作品。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "授权当前作品", exact: true }).click();
  await expect(page.getByText("已授权当前作品。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制作品协作请求", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已复制当前作品");
  const handoff = await application.evaluate(({ clipboard }) => JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")));
  expect(handoff.work_ref).toEqual(context.work_ref);
  expect(handoff.management_ref.grant_revision).toBe(1);
  const cli = (action: string, input: any, ref = handoff.management_ref) => spawnSync(path.join(root, "target/debug/hetu"), ["--client", "codex", "--collaboration-dir", collaboration, "call", action, "--input", "-"], { input: JSON.stringify({ ...input, management_ref: ref }), encoding: "utf8" });
  const listed = cli("hetu.documents.list", { work_ref: context.work_ref });
  expect(listed.status, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).data.documents.map((d: any) => d.document_id)).toEqual([context.document.document_id]);
  expect(cli("hetu.documents.get", { document_id: context.other_document }).status).not.toBe(0);
  await page.getByRole("button", { name: "撤销当前作品授权", exact: true }).click();
  await expect(page.getByText("尚未授权当前作品。", { exact: true })).toBeVisible();
  expect(cli("hetu.documents.list", { work_ref: context.work_ref }).status).not.toBe(0);
  await page.getByRole("button", { name: "授权当前作品", exact: true }).click();
  await expect(page.getByText("已授权当前作品。", { exact: true })).toBeVisible();
  const current = await page.evaluate(() => (window as any).hetuDesktop.connection("status", "codex"));
  expect(current.management_ref.grant_revision).toBeGreaterThan(handoff.management_ref.grant_revision);
  expect(cli("hetu.documents.list", { work_ref: context.work_ref }).status).not.toBe(0);
  expect(cli("hetu.documents.list", { work_ref: context.work_ref }, current.management_ref).status).toBe(0);
  await page.getByRole("button", { name: "小说", exact: true }).click();
  await page.getByRole("button", { name: "第一章 雾港", exact: true }).click();
  await page.locator("summary[aria-label='文稿操作']").click();
  await documentAction(page, "让 AI 处理本稿");
  await expect(page.getByRole("status")).toContainText("已复制当前作品");
  const fixed = await application.evaluate(({ clipboard }) => JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")));
  expect(fixed.fixed_refs.find((r: any) => r.kind === "document").document_id).toBe(context.document.document_id);
  expect(fixed.management_ref).toEqual(current.management_ref);
});
test(
  "作者采纳预览防并发覆盖、独立定稿与撤回、作品范围及未知检查恢复", async () => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-decisions-")),
      workspace = path.join(folder, "作品"),
      access = path.join(folder, "private"),
      profile = path.join(folder, "desktop");
    const pkg = await PluginPackage.inspect(
      path.join(root, "plugins/relationships/dist"),
    );
    const fixture = spawnSync(
      path.join(root, "target/debug/examples/plugin_fixture"),
      [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256],
      { encoding: "utf8" },
    );
    expect(fixture.status, fixture.stderr).toBe(0);
    const context = JSON.parse(fixture.stdout);
    async function launch() {
      application = await electron.launch({
        args: [path.join(root, "apps/desktop")],
        env: {
          ...process.env,
          HETU_DESKTOP_PROFILE: profile,
          HETU_COLLABORATION_DIR: path.join(profile, "collaboration"),
          HETU_PLUGIN_NODE: process.execPath,
          HETU_PLUGIN_ACCESS_DIR: access,
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
      await page
        .getByRole("button", { name: "打开作品", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      return page;
    }
    let page = await launch();
    const call = (method: string, input: any) =>
      page.evaluate(
        async ({ method, input }) =>
          (window as any).hetuDesktop.author(method, input),
        { method, input },
      );
    const read = (action: string, input: any) =>
      page.evaluate(
        async ({ action, input }) =>
          (window as any).hetuDesktop.read(action, input),
        { action, input },
      );
    expect(
      await page.evaluate(async (id) => {
        try {
          await (window as any).hetuDesktop.read("hetu.documents.get", {
            document_id: id,
          });
          return false;
        } catch {
          return true;
        }
      }, context.other_document),
    ).toBe(true);
    await page.getByRole("button", { name: "参考稿审核", exact: true }).click();
    await page
      .getByRole("combobox", { name: "当前审阅任务" })
      .selectOption(context.task_ref.task_id);
    await page.getByText("采纳到作者正文", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "采纳参考方案" })
      .selectOption({ label: "从旧日记开始" });
    await page
      .getByRole("button", { name: "预览采纳变化", exact: true })
      .click();
    const preview = page.getByRole("region", { name: "作者决定预览" });
    await expect(
      preview.getByText("旧日记里夹着一张通往雾港的船票。", { exact: true }),
    ).toBeVisible();
    const original = await read("hetu.documents.get", {
      document_id: context.document.document_id,
    });
    expect(original.data.content).toContain("灯塔在黎明前亮起");
    await read("hetu.documents.save", {
      document_id: context.document.document_id,
      base_revision_id: original.data.revision.revision_id,
      source_format: "markdown",
      content: "作者在另一个入口保留的修改。",
      operation_key: "concurrent-author",
    });
    await page.getByRole("button", { name: "确认此预览", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("写作稿已变化");
    expect(
      (
        await read("hetu.documents.get", {
          document_id: context.document.document_id,
        })
      ).data.content,
    ).toBe("作者在另一个入口保留的修改。");
    await page
      .getByRole("button", { name: "预览采纳变化", exact: true })
      .click();
    await expect(
      preview.getByText("作者在另一个入口保留的修改。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "确认此预览", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("尚未定稿");
    const adopted = await read("hetu.documents.get", {
      document_id: context.document.document_id,
    });
    expect(adopted.data.content).toBe("旧日记里夹着一张通往雾港的船票。");
    expect(adopted.data.document.finalization_ref ?? null).toBeNull();
    // 检查已提交但UI未接到回执，重开后只查询原键，不创建第二份报告。
    const checked = await call("check", {
      document_id: context.document.document_id,
    });
    expect(["succeeded", "partial"]).toContain(checked.status);
    await application.close();
    const journalFile = path.join(
      profile,
      "author-buffers",
      (await readdir(path.join(profile, "author-buffers")))[0],
    );
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    await writeFile(
      journalFile,
      JSON.stringify({ ...journal, status: "pending" }),
    );
    page = await launch();
    await page
      .getByRole("button", { name: "第一章 雾港", exact: true })
      .click();
    await page
      .getByRole("button", { name: "恢复原作者操作", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("原作者操作已确认");
    await page.getByText("检查与定稿 尚未定稿", { exact: true }).click();
    await page
      .getByRole("textbox", { name: "定稿理由", exact: true })
      .fill("这版开篇符合本次创作取舍。");
    await page
      .getByRole("textbox", { name: "人工核对说明", exact: true })
      .fill("已通读全文，并核对人物动作、叙事语境和规则覆盖范围。");
    await page.getByRole("button", { name: "预览定稿", exact: true }).click();
    await page.getByRole("button", { name: "确认此预览", exact: true }).click();
    await expect(
      page.getByText("检查与定稿 当前修订已定稿", { exact: true }),
    ).toBeVisible();
    const finalized = await read("hetu.documents.get", {
      document_id: context.document.document_id,
    });
    expect(finalized.data.document.approved_revision_id).toBe(
      adopted.data.revision.revision_id,
    );
    await page
      .getByText("检查与定稿 当前修订已定稿", { exact: true })
      .click();
    await page.getByText("撤回当前定稿决定", { exact: true }).click();
    await page
      .getByRole("textbox", { name: "撤回定稿理由", exact: true })
      .fill("继续调整叙事节奏。");
    await page
      .getByRole("button", { name: "预览撤回定稿", exact: true })
      .click();
    await page.getByRole("button", { name: "确认此预览", exact: true }).click();
    await expect(
      page.getByText("检查与定稿 尚未定稿", { exact: true }),
    ).toBeVisible();
    const lifecycle = await read("hetu.documents.lifecycle", {
      document_id: context.document.document_id,
    });
    expect(lifecycle.data.adoptions).toHaveLength(1);
    expect(lifecycle.data.finalizations).toHaveLength(2);
    expect(
      (
        await read("hetu.documents.get", {
          document_id: context.document.document_id,
        })
      ).data.content,
    ).toBe(adopted.data.content);
    await page.screenshot({
      path: path.join(root, "output/plugin-doc-qa/author-decisions.png"),
    });
  },
);
test(
  "当前作品的真实候选比较、固定任务意见、隔离和重开恢复", async () => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-task-review-")),
      workspace = path.join(folder, "雾港"),
      access = path.join(folder, "private"),
      profile = path.join(folder, "desktop");
    const pkg = await PluginPackage.inspect(
      path.join(root, "plugins/relationships/dist"),
    );
    const fixture = spawnSync(
      path.join(root, "target/debug/examples/plugin_fixture"),
      [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256],
      { encoding: "utf8" },
    );
    expect(fixture.status, fixture.stderr).toBe(0);
    const context = JSON.parse(fixture.stdout);
    async function launch() {
      application = await electron.launch({
        args: [path.join(root, "apps/desktop")],
        env: {
          ...process.env,
          HETU_DESKTOP_PROFILE: profile,
          HETU_COLLABORATION_DIR: path.join(profile, "collaboration"),
          HETU_PLUGIN_NODE: process.execPath,
          HETU_PLUGIN_ACCESS_DIR: access,
          HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"),
        },
      });
      await application.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [directory],
        });
      }, workspace);
      const page = await application.firstWindow();
      await page
        .getByRole("button", { name: "打开作品", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      await page
        .getByRole("button", { name: "参考稿审核", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "当前审阅任务" })
        .selectOption(context.task_ref.task_id);
      await expect(
        page
          .frameLocator('iframe[title="任务候选审阅"]')
          .getByRole("heading", { name: "比较参考方案" }),
      ).toBeVisible();
      return page;
    }
    let page = await launch();
    const panel = page.frameLocator('iframe[title="任务候选审阅"]');
    await expect(
      panel.getByText("旧日记里夹着一张通往雾港的船票。", { exact: true }),
    ).toBeVisible();
    const sandbox = await page
      .frames()
      .find((f) => f.url().endsWith("task-view.html"))!
      .evaluate(() => {
        let parentBlocked = false;
        try {
          void (window.parent as any).hetuDesktop;
        } catch {
          parentBlocked = true;
        }
        return {
          parentBlocked,
          node: typeof (window as any).require,
          author: typeof (window as any).hetuDesktop,
        };
      });
    expect(sandbox).toEqual({
      parentBlocked: true,
      node: "undefined",
      author: "undefined",
    });
    await panel.getByRole("checkbox", { name: /从旧日记开始/ }).check();
    await panel
      .getByRole("textbox", { name: "补充要求或意见", exact: true })
      .fill("保留船票的悬念，补足人物动作。");
    await panel.getByRole("button", { name: "按此修改", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText(
      "修改意见已保存，尚未发送给 Agent",
    );
    await expect(
      panel.getByRole("button", { name: "发送给当前 Agent" }),
    ).toHaveCount(0);
    const read = await page.evaluate(
      async (ref) =>
        (window as any).hetuDesktop.tasks("call", ref, {
          name: "hetu_open_task_view",
          arguments: { task_ref: ref },
        }),
      context.task_ref,
    );
    expect(read.structuredContent.data.last_feedback.public_comment).toBe(
      "保留船票的悬念，补足人物动作。",
    );
    const denied = await page.evaluate(async (ref) => {
      const api = (window as any).hetuDesktop;
      const attempts = [
        ["hetu.documents.finalize", { task_ref: ref }],
        [
          "hetu_open_task_view",
          {
            task_ref: {
              ...ref,
              task_id: "task_00000000-0000-4000-8000-000000000000",
            },
          },
        ],
        [
          "hetu_read_task_operation",
          {
            task_ref: ref,
            action: "hetu.documents.save",
            key: "fixture-chapter",
          },
        ],
      ];
      return Promise.all(
        attempts.map(async ([name, input]) => {
          try {
            await api.tasks("call", ref, { name, arguments: input });
            return false;
          } catch {
            return true;
          }
        }),
      );
    }, context.task_ref);
    expect(denied).toEqual([true, true, true]);
    const saved = await page.evaluate(
      async (id) =>
        (window as any).hetuDesktop.read("hetu.documents.get", {
          document_id: id,
        }),
      context.document.document_id,
    );
    expect(saved.data.content).toContain("灯塔在黎明前亮起");
    await page.screenshot({
      path: path.join(root, "output/plugin-doc-qa/task-review.png"),
    });
    await application.close();
    const journalFile = path.join(
      profile,
      "task-buffers",
      (await readdir(path.join(profile, "task-buffers")))[0],
    );
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    await writeFile(
      journalFile,
      JSON.stringify({ ...journal, status: "pending" }),
    );
    page = await launch();
    await expect(page.getByText("发现未确认的保存操作")).toBeVisible();
    await page
      .getByRole("button", { name: "查询并恢复原保存", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("原保存操作已确认");
    const reread = await page.evaluate(
      async (ref) =>
        (window as any).hetuDesktop.tasks("call", ref, {
          name: "hetu_open_task_view",
          arguments: { task_ref: ref },
        }),
      context.task_ref,
    );
    expect(reread.structuredContent.data.feedback_head).toEqual(
      read.structuredContent.data.feedback_head,
    );
  },
);
test(
  "独立插件安装、授权、保存、机器回读、重开和停用后导出", async () => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-electron-")),
      workspace = path.join(folder, "中文 空格作品"),
      access = path.join(folder, "private"),
      profile = path.join(folder, "desktop");
    const pkg = await PluginPackage.inspect(
      path.join(root, "plugins/relationships/dist"),
    );
    const fixture = spawnSync(
      path.join(root, "target/debug/examples/plugin_fixture"),
      [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256],
      { encoding: "utf8", timeout: 30000 },
    );
    expect(fixture.status, fixture.stderr).toBe(0);
    const context = JSON.parse(fixture.stdout);
    async function launch() {
      application = await electron.launch({
        args: [path.join(root, "apps/desktop")],
        env: {
          ...process.env,
          HETU_DESKTOP_PROFILE: profile,
          HETU_COLLABORATION_DIR: path.join(profile, "collaboration"),
          HETU_PLUGIN_NODE: process.execPath,
          HETU_PLUGIN_ACCESS_DIR: access,
          HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"),
        },
      });
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
        dialog.showMessageBoxSync = () => 1;
      });
      return application.firstWindow();
    }
    let page = await launch();
    await expect(
      page.getByRole("heading", { name: "创作库", exact: true }),
    ).toBeVisible();
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, workspace);
    await page
      .getByRole("button", { name: "打开作品", exact: true })
      .first()
      .click();
    await expect
      .poll(async () => await page.locator("body").innerText(), {
        timeout: 35000,
      })
      .toContain("插件集成测试");
    await page.getByRole("button", { name: "插件集成测试" }).click();
    await expect(
      page.getByRole("navigation", { name: "文稿目录", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "第一章 雾港" }).click();
    await expect(
      page.getByText("灯塔在黎明前亮起。", { exact: false }),
    ).toBeVisible();
    await navigate(page, "创作插件");
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, pkg.source);
    await page.getByRole("button", { name: "安装插件包" }).click();
    await expect(
      page.getByRole("button", { name: "人物关系图", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "人物关系图", exact: true }).click();
    const plugin = await expect
      .poll(async () => {
        const pages = application.windows();
        return pages.find((p) => p.url().startsWith("hetu-plugin://"))?.url();
      })
      .toBeTruthy();
    const pluginPage = application
      .windows()
      .find((p) => p.url().startsWith("hetu-plugin://"))!;
    await expect(
      pluginPage.getByRole("heading", { name: "人物关系图" }),
    ).toBeVisible();
    expect(
      await pluginPage.evaluate(() => ({
        node: typeof (window as any).require,
        author: typeof (window as any).hetuDesktop,
      })),
    ).toEqual({ node: "undefined", author: "undefined" });
    expect(await application.evaluate(async ({ webContents }) => {
      const plugin = webContents.getAllWebContents().find(w => w.getURL().startsWith("hetu-plugin://"))!;
      return plugin.session.protocol.isProtocolHandled("hetu-media");
    })).toBe(false);
    await pluginPage.getByRole("textbox", { name: "新增条目" }).fill("江岚");
    await pluginPage.getByRole("button", { name: "添加并保存" }).click();
    await expect(pluginPage.getByRole("status")).toContainText("已保存修订 1");
    await expect(pluginPage.getByText("江岚").first()).toBeVisible();
    const state = JSON.parse(
        await readFile(path.join(profile, "plugin-state.json"), "utf8"),
      ),
      grant = Object.values(state.grants)[0] as string;
    const cliArgs = [
      "--workspace",
      workspace,
      "--grant",
      grant,
      "--package-sha256",
      pkg.sha256,
      "--access-dir",
      access,
      "call",
      "hetu.extensions.objects.list",
      "--input",
      "-",
    ];
    const result = spawnSync(
      path.join(root, "target/debug/hetu-plugin"),
      cliArgs,
      {
        input: JSON.stringify({ work_ref: context.work_ref }),
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.objects).toHaveLength(1);
    const denied = await pluginPage.evaluate(async () => {
      const c = await (window as any).hetu.context();
      try {
        await (window as any).hetu.request("hetu.documents.save", {
          work_ref: c.work_ref,
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(denied).toBe(true);
    await pluginPage.getByRole("button", { name: "自动排列" }).click();
    await expect(pluginPage.getByRole("status")).toContainText("已重新排列");
    await page.screenshot({
      path: path.join(root, "output/plugin-doc-qa/electron-shell.png"),
    });
    await pluginPage.screenshot({
      path: path.join(root, "output/plugin-doc-qa/relationships.png"),
    });
    // 模拟 Core 已提交但客户端未收到回执：本机保留同一原键和固定输入。
    await pluginPage.evaluate(async () => {
      const api = (window as any).hetu,
        c = await api.context();
      const listed = await api.request("hetu.extensions.objects.list", {
        work_ref: c.work_ref,
      });
      const read = await api.request("hetu.extensions.objects.get", {
        work_ref: c.work_ref,
        object_id: listed.data.objects[0].object_id,
      });
      const input = {
        work_ref: c.work_ref,
        object_id: read.data.object.object_id,
        kind: read.data.object.kind,
        title: read.data.object.title,
        schema_version: "1",
        content: {
          ...read.data.object.content,
          nodes: [
            ...read.data.object.content.nodes,
            { id: "recovered", label: "待恢复人物", x: 390, y: 110 },
          ],
        },
        expected_revision: read.data.object.revision,
        expected_sha256: read.data.sha256,
        operation_key: "lost-reply-e2e",
      };
      await api.buffer({
        type: "save",
        package_sha256: c.package_sha256,
        input,
      });
      const saved = await api.request("hetu.extensions.objects.save", input);
      if (saved.status !== "succeeded") throw new Error(JSON.stringify(saved));
    });
    await page.getByRole("button", { name: "让 AI 处理", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "已复制当前作品的协作请求",
    );
    const handed = await application.evaluate(({ clipboard }) =>
      JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")),
    );
    expect(handed.plugin_connection.grant_id).toBe(grant);
    expect(handed.work_ref).toEqual(context.work_ref);
    await application.close();
    page = await launch();
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, workspace);
    await page
      .getByRole("button", { name: "打开作品", exact: true })
      .first()
      .click();
    await expect
      .poll(async () => await page.locator("body").innerText(), {
        timeout: 35000,
      })
      .toContain("插件集成测试");
    await page.getByRole("button", { name: "插件集成测试" }).click();
    await page.getByRole("button", { name: "人物关系图", exact: true }).click();
    await expect
      .poll(() =>
        application
          .windows()
          .find((p) => p.url().startsWith("hetu-plugin://"))
          ?.url(),
      )
      .toBeTruthy();
    const reopened = application
      .windows()
      .find((p) => p.url().startsWith("hetu-plugin://"))!;
    await expect(reopened.getByText("江岚").first()).toBeVisible();
    await reopened.getByRole("button", { name: "查询并恢复原操作" }).click();
    await expect(reopened.getByRole("status")).toContainText("已保存修订 3");
    await expect(reopened.getByText("待恢复人物").first()).toBeVisible();
    const verify = spawnSync(
      path.join(root, "target/debug/hetu-plugin"),
      cliArgs,
      {
        input: JSON.stringify({ work_ref: context.work_ref }),
        encoding: "utf8",
      },
    );
    expect(JSON.parse(verify.stdout).data.objects[0].revision).toBe(3);
    // 替换为另一固定包：旧连接撤权，新包重新授权，作品数据继续读取。
    const upgrade = path.join(folder, "upgrade");
    await cp(pkg.source, upgrade, { recursive: true });
    await writeFile(
      path.join(upgrade, "plugin.json"),
      JSON.stringify({ ...pkg.manifest, version: "0.2.0" }),
    );
    await navigate(page, "创作插件");
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, upgrade);
    await page.getByRole("button", { name: "安装插件包" }).click();
    await expect(page.getByText(/0\.2\.0/)).toBeVisible();
    const old = spawnSync(
      path.join(root, "target/debug/hetu-plugin"),
      cliArgs,
      {
        input: JSON.stringify({ work_ref: context.work_ref }),
        encoding: "utf8",
      },
    );
    expect(old.status).not.toBe(0);
    await page.getByRole("button", { name: "人物关系图", exact: true }).click();
    await expect
      .poll(() =>
        application
          .windows()
          .find((p) => p.url().startsWith("hetu-plugin://"))
          ?.url(),
      )
      .toBeTruthy();
    await expect(
      application
        .windows()
        .find((p) => p.url().startsWith("hetu-plugin://"))!
        .getByText("待恢复人物")
        .first(),
    ).toBeVisible();

    await navigate(page, "创作插件");
    await page.getByRole("button", { name: "停用", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "人物关系图", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "读取成果" }).click();
    await page.getByRole("button", { name: "查看导出" }).click();
    await expect(page.locator("pre")).toContainText("江岚");
    const revoked = spawnSync(
      path.join(root, "target/debug/hetu-plugin"),
      cliArgs,
      {
        input: JSON.stringify({ work_ref: context.work_ref }),
        encoding: "utf8",
      },
    );
    expect(revoked.status).not.toBe(0);
    await navigate(page, "创作插件");
    await page.getByRole("button", { name: "卸载", exact: true }).click();
    await expect(page.getByText("已卸载", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "读取成果" }).click();
    await page.getByRole("button", { name: "查看导出" }).click();
    await expect(page.locator("pre")).toContainText("待恢复人物");
    const http = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><title>参考资料测试</title><h1>普通参考网页</h1>",
      );
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      await navigate(page, "参考浏览器");
      const address = "http://127.0.0.1:" + (http.address() as any).port + "/";
      await page.getByRole("textbox", { name: "参考网页地址" }).fill(address);
      await page.getByRole("button", { name: "打开参考", exact: true }).click();
      await expect
        .poll(() =>
          application
            .windows()
            .find((p) => p.url() === address)
            ?.url(),
        )
        .toBe(address);
      const browser = application.windows().find((p) => p.url() === address)!;
      await expect(
        browser.getByRole("heading", { name: "普通参考网页" }),
      ).toBeVisible();
      expect(
        await browser.evaluate(() => ({
          node: typeof (window as any).require,
          plugin: typeof (window as any).hetu,
          author: typeof (window as any).hetuDesktop,
        })),
      ).toEqual({
        node: "undefined",
        plugin: "undefined",
        author: "undefined",
      });
      await page.getByRole("button", { name: "关闭网页", exact: true }).click();
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
);

test(
  "中文编辑撤销、组合输入保护、固定UTF8批注及原键恢复", async () => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-authoring-")),
      workspace = path.join(folder, "中文作品"),
      access = path.join(folder, "private"),
      profile = path.join(folder, "desktop");
    const pkg = await PluginPackage.inspect(
      path.join(root, "plugins/relationships/dist"),
    );
    const made = spawnSync(
      path.join(root, "target/debug/examples/plugin_fixture"),
      [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256],
      { encoding: "utf8" },
    );
    expect(made.status, made.stderr).toBe(0);
    const context = JSON.parse(made.stdout);
    async function open() {
      application = await electron.launch({
        args: [path.join(root, "apps/desktop")],
        env: {
          ...process.env,
          HETU_DESKTOP_PROFILE: profile,
          HETU_COLLABORATION_DIR: path.join(profile, "collaboration"),
          HETU_PLUGIN_NODE: process.execPath,
          HETU_PLUGIN_ACCESS_DIR: access,
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
        dialog.showMessageBoxSync = () => 1;
      }, workspace);
      const page = await application.firstWindow();
      await page
        .getByRole("button", { name: "打开作品", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      await page
        .getByRole("button", { name: "第一章 雾港", exact: true })
        .click();
      await page.locator("summary[aria-label='文稿操作']").click();
      await documentAction(page, "阅读");
      await expect(page.locator(".reader")).toBeVisible();
      return page;
    }
    let page = await open();
    const original = await page.locator(".reader").textContent();
    await page.locator(".reader").evaluate((element) => {
      const body = element.firstChild!,
        value = body.textContent!,
        start = value.indexOf("江岚"),
        range = document.createRange();
      range.setStart(body, start);
      range.setEnd(body, value.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page
      .getByRole("textbox", { name: "原文批注意见" })
      .fill("保留人物动作，补足日记的伏笔。");
    await page.getByRole("button", { name: "保存批注", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已记录固定原文批注");
    const read = (action: string, input: unknown) =>
      page.evaluate(
        async ({ action, input }) =>
          (window as any).hetuDesktop.read(action, input),
        { action, input },
      );
    const annotations = await read("hetu.annotations.list", {
      document_id: context.document.document_id,
    });
    const source = annotations.data.items[0].source_ref;
    expect(source.quote).toBe("江岚合上旧日记。🌿");
    expect(source.byte_start).toBe(
      Buffer.byteLength(original!.slice(0, original!.indexOf("江岚"))),
    );
    expect(source.byte_end).toBe(Buffer.byteLength(original!));
    await page.getByRole("button", { name: "关闭检查器", exact: true }).click();
    await page.locator("summary[aria-label='文稿操作']").click();
    await documentAction(page, "编辑");
    const editor = page.getByRole("textbox", { name: "文稿编辑", exact: true });
    await editor.click();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(modifier + "+a");
    await page.keyboard.insertText("雨落在纸上。🌧️");
    await expect(editor).toContainText("雨落在纸上");
    await page.keyboard.press(modifier + "+z");
    await expect(editor).toContainText("灯塔在黎明前亮起");
    await page.keyboard.press(modifier + "+a");
    await page.keyboard.insertText("雨落在纸上。🌧️");
    const before = await read("hetu.documents.get", {
      document_id: context.document.document_id,
    });
    await editor.dispatchEvent("compositionstart", { data: "中文" });
    await page
      .getByRole("button", { name: "保存修订", exact: true })
      .dispatchEvent("click");
    expect(
      (
        await read("hetu.documents.get", {
          document_id: context.document.document_id,
        })
      ).data.revision.revision_id,
    ).toBe(before.data.revision.revision_id);
    await editor.dispatchEvent("compositionend", { data: "中文" });
    await page.getByRole("button", { name: "保存修订", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已保存新修订");
    expect(
      (
        await read("hetu.documents.get", {
          document_id: context.document.document_id,
        })
      ).data.content,
    ).toBe("雨落在纸上。🌧️");
    await page.evaluate(
      async ({ document_id, work_ref }) => {
        const api = (window as any).hetuDesktop,
          base = (await api.read("hetu.documents.get", { document_id })).data;
        const pending = {
          document_id,
          base_revision_id: base.revision.revision_id,
          source_format: base.revision.source_format,
          content: "已提交但尚未收到回执。",
          operation_key: "document-lost-reply",
        };
        await api.buffer(document_id, {
          content: pending.content,
          base,
          pending,
          work_ref,
        });
        const result = await api.read("hetu.documents.save", pending);
        if (result.status !== "succeeded")
          throw new Error(JSON.stringify(result));
      },
      { document_id: context.document.document_id, work_ref: context.work_ref },
    );
    await application.close();
    page = await open();
    await page.getByRole("button", { name: "恢复编辑", exact: true }).click();
    await page.getByRole("button", { name: "保存修订", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已保存新修订");
    const recovered = await read("hetu.documents.history", {
      document_id: context.document.document_id,
    });
    expect(recovered.data.revisions).toHaveLength(3);
    await page.locator("summary[aria-label='文稿操作']").click();
    await documentAction(page, "阅读");
    await page.getByRole("button", { name: "检查器", exact: true }).click();
    await page.getByText("原文批注 1", { exact: true }).click();
    await expect(
      page.getByText("历史修订，保留原位置", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(root, "output/plugin-doc-qa/author-review.png"),
    });
  },
);
