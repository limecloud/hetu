import { navigate } from "./navigation.ts";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";

const root = path.resolve(import.meta.dirname, "../../..");
function data(result: any) {
  expect(result.status, JSON.stringify(result)).toBe("succeeded");
  return result.data;
}
test(
  "CLI固定素材导入、真实MCP回读、作品隔离与Electron线索历史审阅", async () => {
    test.setTimeout(120000);
    const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-media-")),
      workspace = path.join(folder, "作品"),
      access = path.join(folder, "access"),
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
    let app: ElectronApplication | undefined,
      client: Client | undefined,
      page: Page;
    async function launch() {
      app = await electron.launch({
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
      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [dir],
        });
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      }, workspace);
      page = await app.firstWindow();
      await page
        .getByRole("button", { name: "打开作品", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      await expect(page.locator(".workspace-switcher .workspace-title")).toHaveText("插件集成测试");
    }
    const cli = (grant: any, action: string, input: any) => {
      const r = spawnSync(
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
          encoding: "utf8",
          input: JSON.stringify({ ...input, management_ref: grant }),
        },
      );
      return JSON.parse(r.stdout);
    };
    try {
      await launch();
      await navigate(page!, "素材与线索");
      await expect(
        page!.getByText(
          "还没有这类素材。",
        ),
      ).toBeVisible();
      const work = (
        await page!.evaluate(() => (window as any).hetuDesktop.state())
      ).work;
      const grant = (
        await page!.evaluate(() =>
          (window as any).hetuDesktop.connection("authorize", "codex"),
        )
      ).management_ref;
      async function approve(p: any) {
        await navigate(page, "素材与线索");
        await navigate(page, "管理方案");
        await page
          .getByRole("combobox", { name: "当前管理方案" })
          .selectOption(p.proposal_id);
        await page
          .getByRole("button", { name: "批准此方案", exact: true })
          .click();
        await page
          .getByRole("button", { name: "确认此审核决定", exact: true })
          .click();
        await expect(page.getByRole("region", { name: "固定管理方案", exact: true }))
          .toContainText("已批准，待执行");
        return cli(grant, "hetu.agent_operations.execute", {
          proposal_id: p.proposal_id,
          proposal_sha256: p.proposal_sha256,
          operation_key: `execute-${p.proposal_id}`,
        });
      }
      const raw = Buffer.from(
        "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082",
        "hex",
      );
      const inline = {
        filename: "渡口参考🌿.png",
        base64: raw.toString("base64"),
        sha256: createHash("sha256").update(raw).digest("hex"),
      };
      const scan = data(
        cli(grant, "hetu.assets.inspect", {
          work_ref: work,
          inline_source: inline,
        }),
      );
      const input = {
        work_ref: work,
        inline_source: inline,
        expected_file: { sha256: scan.sha256, size_bytes: scan.size_bytes },
        title: "渡口参考",
        source: {
          source_type: "author_supplied",
          creator_statement: "作者提供的渡口参考🌿",
        },
        rights_status: "unknown",
        redistribution_allowed: false,
        rights_statement: "",
        operation_key: "import",
      };
      const proposal = data(
        cli(grant, "hetu.agent_operations.prepare", {
          action: "hetu.assets.import",
          input,
          summary: "导入渡口参考",
          operation_key: "import-plan",
        }),
      );
      expect(
        cli(grant, "hetu.agent_operations.execute", {
          proposal_id: proposal.proposal_id,
          proposal_sha256: proposal.proposal_sha256,
          operation_key: "before-approval",
        }).error.code,
      ).toBe("hetu.author_confirmation_required");
      expect(
        data(cli(grant, "hetu.assets.list", { work_ref: work })).assets,
      ).toEqual([]);
      const receipt = await approve(proposal),
        asset = data(receipt).result;
      expect(asset.asset.work_ref).toEqual(work);
      expect(
        cli(grant, "hetu.agent_operations.execute", {
          proposal_id: proposal.proposal_id,
          proposal_sha256: proposal.proposal_sha256,
          operation_key: `execute-${proposal.proposal_id}`,
        }),
      ).toEqual(receipt);
      client = new Client(
        { name: "hetu-media-e2e", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(
        new StdioClientTransport({
          command: path.join(root, "target/debug/hetu-mcp"),
          args: ["--client", "codex", "--collaboration-dir", collaboration],
          stderr: "pipe",
        }),
      );
      const tool = async (name: string, args: any) =>
        (
          await client!.callTool({
            name,
            arguments: { ...args, management_ref: grant },
          })
        ).structuredContent as any;
      expect(
        data(await tool("hetu_managed_assets_list", { work_ref: work })).assets,
      ).toHaveLength(1);
      expect(
        data(
          await tool("hetu_managed_assets_get", {
            asset_id: asset.asset.asset_id,
            revision: 1,
          }),
        ).asset,
      ).toEqual(asset.asset);
      expect((await tool("hetu_managed_assets_list", {})).error.code).toBe(
        "forbidden",
      );
      await navigate(page!, "素材与线索");
      await page!.getByRole("button", { name: "渡口参考 权利待确认" }).click();
      await expect(
        page!.getByRole("heading", { name: "渡口参考", exact: true }),
      ).toBeVisible();
      await expect(
        page!.getByText("作者提供的渡口参考🌿", { exact: true }),
      ).toBeVisible();
      await expect(
        page!.getByText("尚无再分发声明", { exact: true }),
      ).toBeVisible();
      await page!
        .getByRole("button", { name: "让 AI 处理此版本", exact: true })
        .click();
      await expect
        .poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()))
        .toContain(asset.asset.asset_id);
      const handoff = await app!.evaluate(({ clipboard }) =>
        clipboard.readText(),
      );
      expect(handoff).toContain(asset.asset.asset_id);
      expect(handoff).toContain(asset.sha256);
      const updated = {
        ...input,
        title: "渡口参考新版",
        rights_status: "reference_only",
        rights_statement: "仅作本作品创作参考",
        asset_id: asset.asset.asset_id,
        expected: { revision: 1, sha256: asset.sha256 },
        operation_key: "update",
      } as any;
      delete updated.inline_source;
      delete updated.expected_file;
      const updatePlan = data(
        cli(grant, "hetu.agent_operations.prepare", {
          action: "hetu.assets.update",
          input: updated,
          summary: "补充素材权利声明",
          operation_key: "update-plan",
        }),
      );
      const revised = data(await approve(updatePlan)).result;
      expect(revised.asset.revision).toBe(2);
      const cueInput = {
        work_ref: work,
        kind: "visual",
        title: "雨夜渡口",
        description: "冷色灯光与雨中的渡口🌿",
        narrative_refs: [],
        asset_refs: [
          { asset_id: asset.asset.asset_id, revision: 1, sha256: asset.sha256 },
        ],
        archived: false,
        operation_key: "cue",
      };
      const cuePlan = data(
        cli(grant, "hetu.agent_operations.prepare", {
          action: "hetu.cues.save",
          input: cueInput,
          summary: "保存雨夜线索",
          operation_key: "cue-plan",
        }),
      );
      const cue = data(await approve(cuePlan)).result;
      expect(
        data(
          await tool("hetu_managed_cues_get", {
            cue_id: cue.cue.cue_id,
            revision: 1,
          }),
        ).cue.work_ref,
      ).toEqual(work);
      await navigate(page!, "素材与线索");
      await page!
        .getByRole("button", { name: "渡口参考新版 仅供参考" })
        .click();
      await page!
        .getByRole("button", { name: "前一版素材", exact: true })
        .click();
      await expect(
        page!.getByRole("heading", { name: "渡口参考", exact: true }),
      ).toBeVisible();
      await expect(
        page!.getByText("第 1 版 历史版本", { exact: true }),
      ).toBeVisible();
      await page!
        .getByRole("button", { name: "刷新素材列表", exact: true })
        .click();
      await expect(
        page!.getByText("第 1 版 历史版本", { exact: true }),
      ).toBeVisible();
      await expect(
        page!.getByRole("definition").filter({ hasText: "仅供参考" }),
      ).toBeVisible();
      await page!
        .getByRole("button", { name: "创作线索", exact: true })
        .click();
      await page!.getByRole("button", { name: "雨夜渡口 创作线索" }).click();
      await expect(
        page!.getByText("冷色灯光与雨中的渡口🌿", { exact: true }),
      ).toBeVisible();
      await expect(
        page!.getByText("素材资料已有新版", { exact: false }),
      ).toBeVisible();
      await page!
        .getByRole("button", { name: "渡口参考", exact: true })
        .click();
      await expect(
        page!.getByText("第 1 版 历史版本", { exact: true }),
      ).toBeVisible();
      await expect(
        page!.getByRole("heading", { name: "渡口参考", exact: true }),
      ).toBeVisible();
      await page!.screenshot({
        path: path.join(root, "output/plugin-doc-qa/media-review.png"),
        fullPage: true,
      });
      await page!.getByRole("button", { name: "返回创作库", exact: true }).click();
      await page!.getByRole("button", { name: /独立剧本/ }).click();
      await expect(page!.locator(".workspace-switcher .workspace-title")).toHaveText("独立剧本");
      await navigate(page!, "素材与线索");
      await expect(
        page!.getByText(
          "还没有这类素材。",
        ),
      ).toBeVisible();
      await expect(
        page!.evaluate(
          (id) =>
            (window as any).hetuDesktop.read("hetu.assets.get", {
              asset_id: id,
            }),
          asset.asset.asset_id,
        ),
      ).rejects.toThrow("不属于当前作品");
      await app!.close();
      app = undefined;
      await launch();
      await navigate(page!, "素材与线索");
      await page!
        .getByRole("button", { name: "渡口参考新版 仅供参考" })
        .click();
      await expect(
        page!.getByRole("heading", { name: "渡口参考新版", exact: true }),
      ).toBeVisible();
      expect(
        data(await tool("hetu_managed_assets_list", { work_ref: work })).assets,
      ).toHaveLength(1);
    } catch (error) {
      console.error(await page!.locator("body").innerText());
      throw error;
    } finally {
      await client?.close();
      await app?.close();
    }
  },
);
