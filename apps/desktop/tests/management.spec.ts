import { navigate } from "./navigation.ts";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test(
  "管理方案按作品隔离、固定审核冲突、未知恢复与Agent独立执行", async () => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-management-")),
      workspace = path.join(folder, "作品"),
      access = path.join(folder, "plugin-access"),
      profile = path.join(folder, "desktop"),
      collaboration = path.join(folder, "collaboration");
    const pkg = await PluginPackage.inspect(
      path.join(root, "plugins/relationships/dist"),
    );
    const fixture = spawnSync(
      path.join(root, "target/debug/examples/plugin_fixture"),
      [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256],
      { encoding: "utf8" },
    );
    expect(fixture.status, fixture.stderr).toBe(0);
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
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      return page;
    }
    const cli = (ref: any, action: string, input: any) => {
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
        {
          input: JSON.stringify({ ...input, management_ref: ref }),
          encoding: "utf8",
        },
      );
      expect(
        result.error,
        `${action}: ${result.error?.message ?? result.stderr}`,
      ).toBeUndefined();
      return { code: result.status, result: JSON.parse(result.stdout) };
    };
    const ok = (response: ReturnType<typeof cli>) => {
      expect(response.code, JSON.stringify(response.result)).toBe(0);
      return response.result.data;
    };
    try {
      let page = await launch();
      await navigate(page, "管理方案");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await navigate(page, "Agent 协作");
      await expect(page.getByText("已连接当前作品。", {exact:true})).toBeVisible();
      const connection = await page.evaluate(() =>
        (window as any).hetuDesktop.connection("status", "codex"),
      );
      const ref = connection.management_ref;
      const before = ok(cli(ref, "hetu.novels.get", {}));
      const metadata = {
        ...before.novel.metadata,
        synopsis: "江岚在雾港等待一封迟到的信。",
      };
      const proposal = ok(
        cli(ref, "hetu.agent_operations.prepare", {
          action: "hetu.novels.update",
          input: {
            expected: { revision: before.revision, sha256: before.sha256 },
            metadata,
            operation_key: "update-profile",
          },
          summary: "补充雾港故事简介",
          operation_key: "prepare-profile",
        }),
      );
      expect(
        cli(ref, "hetu.agent_operations.decide", {
          proposal_id: proposal.proposal_id,
          proposal_sha256: proposal.proposal_sha256,
          expected_state_revision: 1,
          decision: "approve",
          operation_key: "forged-author",
        }).code,
      ).not.toBe(0);
      expect(
        cli(ref, "hetu.agent_operations.execute", {
          proposal_id: proposal.proposal_id,
          proposal_sha256: proposal.proposal_sha256,
          operation_key: "early-execute",
        }).code,
      ).not.toBe(0);
      // 同根的独立剧本也有方案，小说工作面不得读取或决定它。
      await navigate(page, "返回创作库");
      await page.getByRole("button", { name: /独立剧本/ }).click();
      await expect(
        page.getByRole("complementary", { name: "项目导航", exact: true }),
      ).toBeVisible();
      const dramaState = await page.evaluate(() =>
        (window as any).hetuDesktop.state(),
      );
      const dramaConnection = await page.evaluate(() =>
        (window as any).hetuDesktop.connection("authorize", "codex"),
      );
      const drama = ok(
        cli(dramaConnection.management_ref, "hetu.drama.projects.get", {
          project_id: dramaState.work.object_id,
        }),
      );
      const other = ok(
        cli(dramaConnection.management_ref, "hetu.agent_operations.prepare", {
          action: "hetu.drama.projects.update",
          input: {
            project_ref: {
              project_id: drama.project.project_id,
              revision: drama.project.revision,
              sha256: drama.sha256,
            },
            title: drama.project.title,
            description: "另一部作品的简介",
            archived: false,
            operation_key: "drama-profile",
          },
          summary: "独立剧本资料方案",
          operation_key: "prepare-drama",
        }),
      );
      await navigate(page, "返回创作库");
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      await expect(
        page.getByRole("complementary", { name: "项目导航", exact: true }),
      ).toBeVisible();
      await navigate(page, "管理方案");
      const picker = page.getByRole("combobox", { name: "当前管理方案" });
      await expect(picker.locator("option")).toHaveCount(2);
      await expect(picker).not.toContainText("独立剧本资料方案");
      expect(
        await page.evaluate(async (id) => {
          try {
            await (window as any).hetuDesktop.management("get", {
              proposal_id: id,
            });
            return false;
          } catch {
            return true;
          }
        }, other.proposal_id),
      ).toBe(true);
      await picker.selectOption(proposal.proposal_id);
      await expect(
        page.getByRole("cell", { name: metadata.synopsis, exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "批准此方案", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "管理方案决定预览" }),
      ).toBeVisible();
      // 模拟另一个作者入口已经决定，旧预览不能覆盖它。
      await page.evaluate(async (proposal) => {
        const api = (window as any).hetuDesktop;
        const preview = await api.management("prepare", {
          proposal_id: proposal.proposal_id,
          proposal_sha256: proposal.proposal_sha256,
          state_revision: proposal.state_revision,
          decision: "reject",
        });
        await api.management("commit", { token: preview.token });
        const view = await api.management("get", {
          proposal_id: proposal.proposal_id,
        });
        await api.management("acknowledge", {
          proposal_id: proposal.proposal_id,
          operation_key: view.journal.input.operation_key,
        });
      }, proposal);
      await page
        .getByRole("button", { name: "确认此审核决定", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("审核状态已有变化");
      expect(
        ok(
          cli(ref, "hetu.agent_operations.get", {
            proposal_id: proposal.proposal_id,
          }),
        ).state,
      ).toBe("rejected");
      await page
        .getByRole("button", { name: "刷新管理方案", exact: true })
        .click();
      const approved = await page.evaluate(async (proposal) => {
        const api = (window as any).hetuDesktop;
        const current = await api.management("get", {
          proposal_id: proposal.proposal_id,
        });
        const preview = await api.management("prepare", {
          proposal_id: current.proposal_id,
          proposal_sha256: current.proposal_sha256,
          state_revision: current.state_revision,
          decision: "approve",
        });
        return api.management("commit", { token: preview.token });
      }, proposal);
      expect(approved.status).toBe("succeeded");
      expect(ok(cli(ref, "hetu.novels.get", {})).novel.metadata).toEqual(
        before.novel.metadata,
      );
      await application!.close();
      application = undefined;
      // Core 已提交，客户端没有收到成功回执的本机状态。
      const journalDir = path.join(profile, "management-buffers");
      const journalFile = path.join(journalDir, (await readdir(journalDir))[0]);
      const journal = JSON.parse(await readFile(journalFile, "utf8"));
      journal.status = "pending";
      await writeFile(journalFile, JSON.stringify(journal));
      page = await launch();
      await navigate(page, "管理方案");
      await page
        .getByRole("combobox", { name: "当前管理方案" })
        .selectOption(proposal.proposal_id);
      await page
        .getByRole("button", { name: "恢复原审核决定", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("原审核决定已确认");
      const current = ok(
        cli(ref, "hetu.agent_operations.get", {
          proposal_id: proposal.proposal_id,
        }),
      );
      expect(current.state_revision).toBe(3);
      await page
        .getByRole("button", { name: "复制方案执行请求", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("尚未发送给 Agent");
      const handoff = await application!.evaluate(({ clipboard }) =>
        JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")),
      );
      expect(handoff.management_ref).toEqual(ref);
      const executed = ok(cli(ref, handoff.action, handoff.input));
      expect(executed.state).toBe("executed");
      expect(ok(cli(ref, handoff.action, handoff.input))).toEqual(executed);
      expect(ok(cli(ref, "hetu.novels.get", {})).novel.metadata).toEqual(
        metadata,
      );
      await page
        .getByRole("button", { name: "刷新管理方案", exact: true })
        .click();
      await expect(
        page.getByText(
          "方案已执行。返回对应工作面回读成果；正文采纳与定稿另行决定。",
          { exact: true },
        ),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(root, "output/plugin-doc-qa/management-review.png"),
      });
      await navigate(page, "Agent 协作");
      await page
        .getByRole("button", { name: "断开当前作品连接", exact: true })
        .click();
      await navigate(page, "管理方案");
      await expect(page.getByRole("alert")).toContainText(
        "当前作品的 Agent 连接已断开",
      );
    } finally {
      await application?.close();
    }
  },
);
