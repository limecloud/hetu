import { openDirectory } from "./navigation.ts";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test(
  "长篇中文正文使用有界编辑行、末尾定位保存与完整Core回读",
  async ({}, testInfo) => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-long-text-")),
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
      await page.setViewportSize({ width: 1024, height: 768 });
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
      await expect(
        page.getByRole("textbox", { name: "文稿编辑", exact: true }),
      ).toBeVisible();
      const read = (action: string, input: any) =>
        page.evaluate(
          ({ action, input }) =>
            (window as any).hetuDesktop.read(action, input),
          { action, input },
        );
      const original = (
        await read("hetu.documents.get", {
          document_id: context.document.document_id,
        })
      ).data;
      const content =
        Array.from(
          { length: 12000 },
          (_, index) =>
            `第${index + 1}段：江岚在雾港读完了旧日记，沿着海岸寻找灯塔。每一封信都有自己的来处。🌿`,
        ).join("\n\n") + "\n\n长篇试读结束。";
      const saved = await read("hetu.documents.save", {
        document_id: context.document.document_id,
        base_revision_id: original.revision.revision_id,
        source_format: "markdown",
        content,
        operation_key: "long-text-prepare",
      });
      expect(saved.status).toBe("succeeded");
      const start = performance.now();
      await openDirectory(page);
      await page
        .getByRole("button", { name: "第一章 雾港", exact: true })
        .click();
      const editor = page.getByRole("textbox", {
        name: "文稿编辑",
        exact: true,
      });
      await expect(editor).toBeVisible();
      await expect(page.locator(".cm-line").first()).toContainText("第1段：江岚在雾港");
      const rendered = await page.locator(".cm-line").count();
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(500);
      const editorReadyMs = performance.now() - start;
      await editor.focus();
      await editor.press(
        process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
      );
      const tail = "作者继续保留的结尾。";
      await page.keyboard.insertText(tail);
      await editor.press(
        process.platform === "darwin" ? "Meta+s" : "Control+s",
      );
      await expect(page.getByRole("status")).toContainText("已保存新修订");
      const actual = (
        await read("hetu.documents.get", {
          document_id: context.document.document_id,
        })
      ).data.content;
      expect(actual).toBe(content + tail);
      await testInfo.attach("long-text-sample.json", {
        body: JSON.stringify({
          platform: process.platform,
          utf8_bytes: Buffer.byteLength(content),
          paragraphs: 12001,
          rendered_editor_lines: rendered,
          editor_ready_ms: editorReadyMs,
        }),
        contentType: "application/json",
      });
    } finally {
      await application.close();
    }
  },
);
