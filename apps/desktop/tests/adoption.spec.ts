import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { navigate } from "./navigation.ts";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("局部采纳固定中文与emoji选区、拒绝伪造和旧坐标、保留选区外正文", async () => {
  const folder = await mkdtemp(
      path.join(os.tmpdir(), "hetu-partial-adoption-"),
    ),
    workspace = path.join(folder, "作品"),
    access = path.join(folder, "access"),
    profile = path.join(folder, "profile");
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
  const application = await electron.launch({
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
  try {
    const page = await application.firstWindow();
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
    await page
      .getByRole("button", { name: "打开作品", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: /插件集成测试/ }).click();
    const read = (action: string, input: any) =>
      page.evaluate(
        ({ action, input }) => (window as any).hetuDesktop.read(action, input),
        { action, input },
      );
    await navigate(page, "参考稿审核");
    await page
      .getByRole("combobox", { name: "当前审阅任务" })
      .selectOption(context.task_ref.task_id);
    await page.getByText("采纳到作者正文", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "采纳参考方案" })
      .selectOption({ label: "从旧日记开始" });
    await page.getByText("只采纳部分内容", { exact: true }).click();
    await page
      .getByRole("button", { name: "读取局部采纳对照", exact: true })
      .click();
    async function select(label: string, quote: string) {
      await page
        .getByLabel(label, { exact: true })
        .evaluate((element, quote) => {
          const text = [...element.querySelectorAll<HTMLElement>("[data-source-from]")].find(node => node.textContent?.includes(quote))?.firstChild;
          if (!text) throw new Error("测试选区不存在。");
          const start = text.textContent!.indexOf(quote);
          const range = document.createRange();
          range.setStart(text, start); range.setEnd(text, start + quote.length);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          text.parentElement!.closest("article")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        }, quote);
    }
    await select("局部采纳参考稿", "旧日记");
    await select("局部采纳目标正文", "🌿");
    await expect(
      page.getByText("已选替换片段：🌿", { exact: true }),
    ).toBeVisible();
    const original = (
      await read("hetu.documents.get", {
        document_id: context.document.document_id,
      })
    ).data;
    const concurrent = original.content + "\n作者从另一入口补充的结尾。";
    await read("hetu.documents.save", {
      document_id: context.document.document_id,
      base_revision_id: original.revision.revision_id,
      source_format: "markdown",
      content: concurrent,
      operation_key: "partial-concurrent",
    });
    await page
      .getByRole("button", { name: "预览选中片段", exact: true })
      .click();
    await expect(page.locator(".notice[role=status]")).toContainText("写作稿已变化");
    await page
      .getByRole("button", { name: "重新读取局部采纳对照", exact: true })
      .click();
    await select("局部采纳参考稿", "旧日记");
    await select("局部采纳目标正文", "🌿");
    await page
      .getByRole("button", { name: "预览选中片段", exact: true })
      .click();
    const expected = concurrent.replace("🌿", "旧日记");
    const preview = page.getByRole("region", {name: "作者决定预览", exact: true});
    await preview.getByRole("button", {name: "全部正文", exact: true}).click();
    const resultText = preview.getByRole("region", {name: "采纳后正文", exact: true});
    await resultText.getByRole("button", {name: "原稿", exact: true}).click();
    await expect(resultText.locator("article")).toHaveText(expected);
    expect(
      (
        await read("hetu.documents.get", {
          document_id: context.document.document_id,
        })
      ).data.content,
    ).toBe(concurrent);
    await page.getByRole("region", { name: "作者决定预览" }).screenshot({
      path: path.join(
        root,
        "output/plugin-doc-qa/partial-adoption-preview.png",
      ),
    });
    await page.getByRole("button", { name: "确认此预览", exact: true }).click();
    await expect(page.locator(".notice[role=status]")).toContainText("尚未定稿");
    expect(
      (
        await read("hetu.documents.get", {
          document_id: context.document.document_id,
        })
      ).data.content,
    ).toBe(expected);
    const lifecycle = (
      await read("hetu.documents.lifecycle", {
        document_id: context.document.document_id,
      })
    ).data;
    expect(lifecycle.adoptions).toHaveLength(1);
    const saved = lifecycle.adoptions[0].selected_ranges[0];
    expect(saved.source.quote).toBe("旧日记");
    expect(saved.target.quote).toBe("🌿");
    expect(saved.target.byte_end - saved.target.byte_start).toBe(4);
    const forged = await page.evaluate(async (task_ref) => {
      const api = (window as any).hetuDesktop;
      const value = (
        await api.tasks("call", task_ref, {
          name: "hetu_open_task_view",
          arguments: { task_ref },
        })
      ).structuredContent.data;
      const candidate = value.submission.candidates.find(
        (item: any) => item.title === "从旧日记开始",
      );
      const fixed = await api.author("adoption_context", {
        task_ref,
        candidate_id: candidate.candidate_id,
      });
      const badRange = { byte_start: 1, byte_end: 9, quote: "旧日记" };
      try {
        await api.author("adoption_partial", {
          token: fixed.token,
          source: badRange,
          target: { byte_start: 0, byte_end: 0, quote: "" },
        });
        return false;
      } catch {
        return true;
      }
    }, context.task_ref);
    expect(forged).toBe(true);
    expect(
      (
        await read("hetu.documents.get", {
          document_id: context.document.document_id,
        })
      ).data.content,
    ).toBe(expected);
    await page.screenshot({
      path: path.join(root, "output/plugin-doc-qa/partial-adoption.png"),
    });
  } finally {
    await application.close();
  }
});
