import { openDirectory } from "./navigation.ts";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
const root = path.resolve(import.meta.dirname, "../../..");
test(
  "整部作品103章跨页读取、真实卷章顺序及独立剧本分集目录", async () => {
    test.setTimeout(180000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-structure-")),
      workspace = path.join(folder, "作品"),
      profile = path.join(folder, "profile"),
      access = path.join(folder, "plugin-access");
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
        "102",
      ],
      { encoding: "utf8", timeout: 90000 },
    );
    expect(fixture.status, fixture.stderr).toBe(0);
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
      }, workspace);
      await page
        .getByRole("button", { name: "打开作品", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      await openDirectory(page);
      const directory = page.getByRole("navigation", {
        name: "文稿目录",
        exact: true,
      });
      const chapters = directory.locator(".chapter-group").getByRole("button");
      await expect(chapters).toHaveCount(103);
      await expect(chapters.first()).toHaveText(
        "目录试读第102章",
      );
      await expect(chapters.last()).toHaveText(
        "第一章 雾港",
      );
      await expect(
        directory.locator("summary", { hasText: "第一卷 海上" }),
      ).toBeVisible();
      await expect(
        directory.locator("summary", { hasText: "未分卷" }),
      ).toBeVisible();
      await chapters.first().click();
      await expect(
        page.getByText("江岚在第102个清晨抵达雾港。", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "作品资料", exact: true })
        .click();
      const structure = page.locator(".profile-structure");
      await structure.locator("summary").click();
      await expect(structure.getByRole("listitem")).toHaveCount(103);
      await expect(structure.getByRole("listitem").first()).toHaveText(
        "目录试读第102章",
      );
      await page.getByRole("button", { name: "返回创作库", exact: true }).click();
      await page.getByRole("button", { name: /独立剧本/ }).click();
      await expect(page.locator(".workspace-switcher .workspace-title")).toHaveText("独立剧本");
      await expect(page.getByRole("button", { name: "剧本", exact: true })).toBeEnabled();
      await expect(
        page.getByRole("complementary", { name: "项目导航", exact: true }),
      ).toBeVisible();
      await openDirectory(page);
      await expect(chapters).toHaveCount(1);
      await expect(
        directory.locator(".chapter-group > summary"),
      ).toHaveText(["第一集"]);
      await expect(
        directory.getByRole("button", { name: "第一章 雾港", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "作品资料", exact: true })
        .click();
      await structure.locator("summary").click();
      await expect(structure.getByRole("listitem")).toHaveCount(1);
      await page.screenshot({
        path: path.join(root, "output/plugin-doc-qa/work-structure.png"),
      });
    } finally {
      await application.close();
    }
  },
);
