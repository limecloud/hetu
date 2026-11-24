import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { navigate } from "./navigation.ts";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
const root = path.resolve(import.meta.dirname, "../../..");
test(
  "关联依据保留固定资料与历史、刷新不漂移、交接含确切关系修订", async () => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-links-")),
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
        "0",
        "--link-history",
      ],
      { encoding: "utf8" },
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
      await page
        .getByRole("button", { name: "打开作品", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: /独立剧本/ }).click();
      await navigate(page, "关联作品");
      await page
        .getByRole("button", { name: "查看固定依据", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "雾港新版资料", exact: true }),
      ).toHaveCount(2);
      await expect(
        page.getByText("关联作品资料已有新版，当前依据继续保留。", {
          exact: true,
        }),
      ).toBeVisible();
      const history = page.getByRole("combobox", {
        name: "关联历史修订",
        exact: true,
      });
      await page.getByText("关联历史与版本", { exact: true }).click();
      await history.selectOption("1");
      await expect(
        page.getByRole("heading", { name: "插件集成测试", exact: true }),
      ).toHaveCount(2);
      await expect(
        page.getByRole("article", { name: "固定关联作品资料", exact: true }),
      ).not.toContainText("雾港第三版资料");
      await page
        .getByRole("button", { name: "刷新关联作品", exact: true })
        .click();
      await expect(history).toHaveValue("1");
      await expect(
        page.getByRole("heading", { name: "插件集成测试", exact: true }),
      ).toHaveCount(2);
      await page
        .getByRole("button", { name: "让 AI 处理此关联", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("已准备当前作品");
      const handoff = await application.evaluate(({ clipboard }) =>
        JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")),
      );
      expect(
        handoff.fixed_refs.find((item: any) => item.kind === "work_link")
          .revision,
      ).toBe(1);
      expect(handoff.proposal_actions).toContain(
        "hetu.work_links.update_source",
      );
      await page.screenshot({
        path: path.join(root, "output/plugin-doc-qa/work-link-history.png"),
      });
      await page
        .getByRole("button", { name: "返回关联列表", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "查看固定依据", exact: true }),
      ).toBeVisible();
    } finally {
      await application.close();
    }
  },
);
