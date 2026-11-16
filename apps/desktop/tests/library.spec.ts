import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
const root = path.resolve(import.meta.dirname, "../../..");

test(
  "空创作库交接真实Agent新建、自动接纳、重开与路径身份替换拒绝", async () => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-library-")),
      profile = path.join(folder, "desktop"),
      collaboration = path.join(folder, "collaboration"),
      access = path.join(folder, "plugin-access");
    let application: ElectronApplication | undefined;
    async function launch() {
      application = await electron.launch({
        args: [path.join(root, "apps/desktop")],
        env: {
          ...process.env,
          HETU_DESKTOP_PROFILE: profile,
          HETU_COLLABORATION_DIR: collaboration,
          HETU_PLUGIN_ACCESS_DIR: access,
          HETU_PLUGIN_NODE: process.execPath,
          HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"),
        },
      });
      return application.firstWindow();
    }
    const cli = (action: string, input: any) => {
      const result = spawnSync(
        path.join(root, "target/debug/hetu"),
        [
          "--client",
          "codex",
          "--collaboration-dir",
          collaboration,
          "call",
          action,
          "--input",
          "-",
        ],
        { input: JSON.stringify(input), encoding: "utf8" },
      );
      expect(result.status, result.stderr + result.stdout).toBe(0);
      return JSON.parse(result.stdout).data;
    };
    try {
      let page = await launch();
      await page.getByText("新建作品", { exact: true }).click();
      await page
        .getByRole("button", { name: "让 AI 新建小说", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("作品尚未创建");
      const handoff = await application!.evaluate(({ clipboard }) =>
        JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")),
      );
      expect(handoff.work_type).toBe("novel");
      expect(handoff.collaboration_directory).toBe(collaboration);
      const start = cli(handoff.creation_action, {
        brief: "末班船的一张票。",
        locale: "zh-CN",
        operation_key: "start-book",
      });
      const created = cli("hetu.creation_projects.create_novel", {
        management_ref: start.management_ref,
        project_id: start.project.project_id,
        expected: { revision: start.revision, sha256: start.sha256 },
        target_path: start.target_path,
        metadata: {
          title: "雾港末班船",
          author_name: "测试作者",
          synopsis: "一张来自明天的船票。",
          genre: "悬疑",
          language_tag: "zh-CN",
          status: "planning",
        },
        operation_key: "create-book",
      });
      const works = cli("hetu.works.list", {
        management_ref: created.workspace_management_ref,
      });
      const reference = works.works[0].work_ref;
      await page
        .getByRole("button", { name: "刷新创作库", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: /雾港末班船/ }),
      ).toBeVisible();
      await page.getByRole("button", { name: /雾港末班船/ }).click();
      await expect(
        page.getByRole("complementary", { name: "项目导航", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "从成果开始创作", exact: true }),
      ).toBeVisible();
      // 库的登记不授予另一个客户端管理权。
      const denied = spawnSync(
        path.join(root, "target/debug/hetu"),
        [
          "--client",
          "claude-code",
          "--collaboration-dir",
          collaboration,
          "call",
          "hetu.works.get",
          "--input",
          "-",
        ],
        {
          input: JSON.stringify({
            management_ref: created.workspace_management_ref,
            work_ref: reference,
          }),
          encoding: "utf8",
        },
      );
      expect(denied.status).not.toBe(0);
      await application!.close();
      application = undefined;
      page = await launch();
      await expect(
        page.getByRole("button", { name: /雾港末班船/ }),
      ).toBeEnabled();
      await page.getByRole("complementary", { name: "创作库导航" }).getByRole("button", { name: "剧本", exact: true }).click();
      await expect(
        page.getByRole("button", { name: /雾港末班船/ }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "全部作品", exact: true }).click();
      await expect(
        page.getByRole("button", { name: /雾港末班船/ }),
      ).toBeEnabled();
      await application!.close();
      application = undefined;
      const pkg = await PluginPackage.inspect(
        path.join(root, "plugins/relationships/dist"),
      );
      await rename(start.target_path, start.target_path + "-preserved");
      const replacement = spawnSync(
        path.join(root, "target/debug/examples/plugin_fixture"),
        [
          start.target_path,
          access,
          path.join(pkg.source, "plugin.json"),
          pkg.sha256,
        ],
        { encoding: "utf8" },
      );
      expect(replacement.status, replacement.stderr).toBe(0);
      page = await launch();
      await expect(
        page.getByRole("button", { name: /雾港末班船/ }),
      ).toBeDisabled();
      await expect(
        page.getByText("此位置的工作区身份已变化，不能沿旧登记打开。", {
          exact: true,
        }),
      ).toBeVisible();
      const rejected = await page.evaluate(async (ref) => {
        try {
          await (window as any).hetuDesktop.library("open", { work_ref: ref });
          return false;
        } catch {
          return true;
        }
      }, reference);
      expect(rejected).toBe(true);
      await page.screenshot({
        path: path.join(root, "output/plugin-doc-qa/library-identity.png"),
      });
    } finally {
      await application?.close();
    }
  },
);
