import { navigate, captureAgentDraft } from "./navigation.ts";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";
import { AppServer } from "../src/main/rpc.ts";
import { ResourceReview } from "../src/main/resources.ts";
import { RecoveryStore } from "../src/main/recovery.ts";
const root = path.resolve(import.meta.dirname, "../../..");
const fields = (key: string) => ({
  title: "渡口考据",
  category: "research",
  body: "渡口🌿\r\n按潮汐停航。",
  tags: ["水文"],
  project_id: null,
  entity_refs: [],
  source_notes: "渡口访谈记录",
  operation_key: key,
});
const data = (r: any) => {
  expect(r.status, JSON.stringify(r)).toBe("succeeded");
  return r.data;
};
async function fixture() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-resources-")),
    workspace = path.join(folder, "作品"),
    access = path.join(folder, "access");
  const pkg = await PluginPackage.inspect(
    path.join(root, "plugins/relationships/dist"),
  );
  const made = spawnSync(
    path.join(root, "target/debug/examples/plugin_fixture"),
    [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256],
    { encoding: "utf8" },
  );
  expect(made.status, made.stderr).toBe(0);
  return { folder, workspace, access };
}

test("资料发送前中断沿原键补执行，CAS冲突保留人工恢复稿", async () => {
  const { folder, workspace } = await fixture();
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
  try {
    const work = data(await call("hetu.works.list", {})).works.find(
      (w: any) => w.work_ref.kind === "novel",
    ).work_ref;
    const r = data(
      await call("hetu.resources.create", {
        ...fields("resource"),
        work_ref: work,
      }),
    );
    let cut = true;
    const review = new ResourceReview(
      work,
      path.join(folder, "journals"),
      new RecoveryStore(),
      async (action, input) => {
        if (action === "hetu.resources.adopt" && cut) {
          cut = false;
          throw new Error("发送前中断");
        }
        return call(action, input);
      },
      () => true,
    );
    const id = r.resource.resource_id;
    const p = await review.prepare(id, 1, r.sha256, "adopt");
    await expect(review.commit(p.token)).rejects.toThrow("发送前中断");
    expect((await review.journal(id))?.status).toBe("pending");
    await expect(review.prepare(id, 1, r.sha256, "archive")).rejects.toThrow(
      "原资料操作",
    );
    const recovered = data(await review.recover(id));
    expect(recovered.resource.revision).toBe(2);
    expect(data(await review.recover(id))).toEqual(recovered);
    await review.acknowledge(
      id,
      (await review.journal(id))!.input.operation_key,
    );
    const draft = {
      base: { revision: 2, sha256: recovered.sha256 },
      edits: {
        title: "人工笔记",
        body: "未保存修改🌿",
        source_notes: "自己的笔记",
      },
    };
    await review.draft(id, draft);
    const update = await review.prepare(
      id,
      2,
      recovered.sha256,
      "update",
      draft.edits,
    );
    data(
      await call("hetu.resources.update", {
        ...fields("concurrent"),
        resource_id: id,
        expected: { revision: 2, sha256: recovered.sha256 },
      }),
    );
    expect((await review.commit(update.token)).error.code).toBe(
      "revision_conflict",
    );
    expect((await review.get(id)).buffer.edits.body).toBe("未保存修改🌿");
    expect((await review.get(id)).resource.revision).toBe(3);
  } finally {
    await server.close();
  }
});

test(
  "CLI准备资料任务、作者审核、真实MCP整理、Electron历史审阅与重开恢复", async () => {
    test.setTimeout(120000);
    const { folder, workspace, access } = await fixture(),
      profile = path.join(folder, "desktop"),
      collaboration = path.join(folder, "collaboration");
    let app: ElectronApplication | undefined, client: Client | undefined;
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
      const page = await app.firstWindow();
      await page
        .getByRole("button", { name: "打开作品", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: /插件集成测试/ }).click();
      return page;
    }
    const cli = (ref: any, action: string, input: any) => {
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
          input: JSON.stringify({ ...input, management_ref: ref }),
        },
      );
      return JSON.parse(r.stdout);
    };
    try {
      let page = await launch();
      const invoke = (method: string, input: any) =>
        page.evaluate(
          ({ method, input }) =>
            (window as any).hetuDesktop.resources(method, input),
          { method, input },
        );
      await navigate(page, "资料与素材");
      await expect(
        page.getByText("当前筛选没有资料。可让 AI 根据作品整理。"),
      ).toBeVisible();
      const work = (
        await page.evaluate(() => (window as any).hetuDesktop.state())
      ).work;
      const connection = await page.evaluate(() =>
        (window as any).hetuDesktop.connection("authorize", "codex"),
      );
      const grant = connection.management_ref;
      async function approve(proposal: any) {
        await navigate(page, "管理方案");
        await page
          .getByRole("combobox", { name: "当前管理方案" })
          .selectOption(proposal.proposal_id);
        await page
          .getByRole("button", { name: "批准此方案", exact: true })
          .click();
        await page
          .getByRole("button", { name: "确认此审核决定", exact: true })
          .click();
        await expect(page.getByRole("status")).toContainText("方案已批准");
        return data(
          cli(grant, "hetu.agent_operations.execute", {
            proposal_id: proposal.proposal_id,
            proposal_sha256: proposal.proposal_sha256,
            operation_key: `execute-${proposal.proposal_id}`,
          }),
        );
      }
      const bp = data(cli(grant, "hetu.blueprints.get", { work_ref: work }));
      const character = "character_11111111-1111-4111-8111-111111111111";
      const canonProposal = data(
        cli(grant, "hetu.agent_operations.prepare", {
          action: "hetu.blueprints.save",
          input: {
            work_ref: work,
            expected: {
              blueprint_id: bp.blueprint.blueprint_id,
              revision: bp.revision,
              sha256: bp.sha256,
            },
            typed_changes: [
              {
                type: "upsert_character",
                entity: {
                  character_id: character,
                  name: "江岚",
                  aliases: [],
                  description: "渡口的访客",
                  traits: [],
                  facts: [],
                  archived: false,
                },
              },
            ],
            operation_key: "canon",
          },
          summary: "准备人物依据",
          operation_key: "canon-proposal",
        }),
      );
      const savedCanon = (await approve(canonProposal)).result;
      await navigate(page, "资料与素材");
      const preview = data(
        cli(grant, "hetu.creative_tasks.preview_prompt", {
          scope_ref: { kind: "workspace", id: work.workspace_id },
          work_ref: work,
          task_kind: "resource_organize",
          brief: "整理渡口考据，注明来源",
          input_refs: [],
          client_adapter: "codex",
          language_tag: "zh-CN",
          resource_scope: {
            resource_refs: [],
            editable_resource_ids: [],
            allow_create: true,
          },
        }),
      );
      const proposal = data(
        cli(grant, "hetu.agent_operations.prepare", {
          action: "hetu.creative_tasks.prepare",
          input: { ...preview.prepare_input, operation_key: "task" },
          summary: "整理渡口资料",
          operation_key: "proposal",
        }),
      );
      const done = await approve(proposal);
      client = new Client(
        { name: "hetu-reference-e2e", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(
        new StdioClientTransport({
          command: path.join(root, "target/debug/hetu-mcp"),
          args: ["--client", "codex", "--collaboration-dir", collaboration],
          stderr: "pipe",
        }),
      );
      async function tool(name: string, input: any) {
        return (await client!.callTool({ name, arguments: input }))
          .structuredContent as any;
      }
      const opened = data(
        await tool("hetu_open_collaboration_task", {
          task_locator: done.task_locator,
        }),
      );
      const task_ref = opened.task_ref;
      expect(task_ref).toBeTruthy();
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "hetu_call_action")).toBe(
        true,
      );
      const createInput = {
        ...fields("create"),
        task_ref,
        entity_refs: [
          {
            kind: "character",
            entity_id: character,
            work_ref: work,
            blueprint_id: savedCanon.blueprint.blueprint_id,
            blueprint_revision: savedCanon.revision,
            blueprint_sha256: savedCanon.sha256,
          },
        ],
      };
      const first = data(await tool("hetu_call_action", { action: "hetu.resources.create", input: createInput }));
      expect(data(await tool("hetu_call_action", { action: "hetu.resources.create", input: createInput }))).toEqual(
        first,
      );
      expect(first.resource.work_ref).toEqual(work);
      const id = first.resource.resource_id;
      const second = data(
        await tool("hetu_update_resource", {
          ...fields("update"),
          entity_refs: createInput.entity_refs,
          body: "渡口🌿\r\n大潮期间停航，旅人改走北岸。",
          task_ref,
          resource_id: id,
          expected: { revision: 1, sha256: first.sha256 },
        }),
      );
      expect(second.resource.revision).toBe(2);
      const directory = data(
        cli(grant, "hetu.documents.list", { work_ref: work }),
      );
      const doc = data(
        cli(grant, "hetu.documents.get", {
          document_id: directory.documents[0].document_id,
        }),
      );
      const usageProposal = data(
        cli(grant, "hetu.agent_operations.prepare", {
          action: "hetu.resource_usages.save",
          input: {
            resource_ref: {
              resource_id: id,
              revision: 2,
              sha256: second.sha256,
            },
            target_ref: {
              document_id: doc.document.document_id,
              revision_id: doc.revision.revision_id,
              byte_start: 0,
              byte_end: Buffer.byteLength("灯塔"),
              quote: "灯塔",
            },
            role: "渡口地理参考",
            archived: false,
            operation_key: "usage",
          },
          summary: "关联第一章固定位置",
          operation_key: "usage-proposal",
        }),
      );
      await navigate(page, "资料与素材");
      await approve(usageProposal);
      await navigate(page, "资料与素材");
      await page
        .getByRole("navigation", { name: "资料目录" })
        .getByRole("button", { name: /渡口考据/ })
        .click();
      await expect(page.getByLabel("资料全文")).toContainText("旅人改走北岸");
      await expect(
        page.getByText("渡口访谈记录", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("关联设定：江岚（第 2 版设定）", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("第一章 雾港 渡口地理参考", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "上一版资料", exact: true })
        .click();
      await expect(page.getByLabel("资料全文")).not.toContainText(
        "旅人改走北岸",
      );
      await expect(page.getByText(/第 1 版（历史修订）/)).toBeVisible();
      await page
        .getByRole("button", { name: "读取最新资料", exact: true })
        .click();
      const capturedDraft=await captureAgentDraft(app,page);
      await page
        .getByRole("button", { name: "让 AI 整理资料", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "已放入当前会话草稿",
      );
      const handoff = JSON.parse((await capturedDraft())!.split("\n").slice(1).join("\n"));
      expect(handoff.management_ref).toBeUndefined();expect(handoff.workspace_path).toBeUndefined();
      expect(
        handoff.fixed_refs.some(
          (r: any) =>
            r.kind === "resource" &&
            r.revision === 2 &&
            r.sha256 === second.sha256,
        ),
      ).toBe(true);
      await page
        .getByRole("button", { name: "采用此版资料", exact: true })
        .click();
      expect(
        data(cli(grant, "hetu.resources.get", { resource_id: id })).resource
          .state,
      ).toBe("draft");
      await page.evaluate(async () => {
        const current = await window.hetuDesktop.settings("preferences");
        await window.hetuDesktop.settings("update", {
          expected_revision: current.revision,
          patch: { execution_mode: "confirm" },
        });
      });
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 0,
          checkboxChecked: false,
        });
      });
      await page
        .getByRole("button", { name: "确认此资料决定", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("已取消资料决定");
      expect(
        data(cli(grant, "hetu.resources.get", { resource_id: id })).resource
          .revision,
      ).toBe(2);
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      });
      await page
        .getByRole("button", { name: "采用此版资料", exact: true })
        .click();
      await page
        .getByRole("button", { name: "确认此资料决定", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "资料操作恢复" }),
      ).toContainText("已成功");
      expect(
        data(cli(grant, "hetu.resources.get", { resource_id: id })).resource
          .revision,
      ).toBe(3);
      await app.close();
      app = undefined;
      const buffers = path.join(profile, "resource-buffers");
      const dir = path.join(buffers, (await readdir(buffers))[0]),
        file = (await readdir(dir)).find((x) => x.endsWith(".json"))!;
      const journal = JSON.parse(await readFile(path.join(dir, file), "utf8"));
      journal.status = "pending";
      await writeFile(path.join(dir, file), JSON.stringify(journal));
      page = await launch();
      await navigate(page, "资料与素材");
      await page
        .getByRole("navigation", { name: "资料目录" })
        .getByRole("button", { name: /渡口考据/ })
        .click();
      await page
        .getByRole("button", { name: "查询并恢复原资料操作", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "资料操作恢复" }),
      ).toContainText("已成功");
      expect(
        data(cli(grant, "hetu.resources.get", { resource_id: id })).resource
          .revision,
      ).toBe(3);
      await page
        .getByRole("button", { name: "已核对资料结果", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "资料操作恢复" }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "手工编辑资料", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "资料正文", exact: true })
        .fill("作者自己的补充🌿\n保留恢复稿。");
      await navigate(page, "作品设定");
      await navigate(page, "资料与素材");
      await page
        .getByRole("navigation", { name: "资料目录" })
        .getByRole("button", { name: /渡口考据/ })
        .click();
      await page
        .getByRole("button", { name: "恢复资料编辑", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "资料正文", exact: true }),
      ).toHaveValue("作者自己的补充🌿\n保留恢复稿。");
      await page
        .getByRole("button", { name: "预览资料修改", exact: true })
        .click();
      await page
        .getByRole("button", { name: "确认此资料决定", exact: true })
        .click();
      await expect(page.getByLabel("资料全文")).toContainText("作者自己的补充");
      await page
        .getByRole("heading", { name: "资料与素材", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(root, "output/plugin-doc-qa/resource-review.png"),
      });
      await page
        .getByRole("button", { name: "已核对资料结果", exact: true })
        .click();
      await page
        .getByRole("button", { name: "归档此版资料", exact: true })
        .click();
      await page
        .getByRole("button", { name: "确认此资料决定", exact: true })
        .click();
      await expect(
        page
          .getByRole("navigation", { name: "资料目录" })
          .getByRole("button", { name: /渡口考据/ }),
      ).toHaveCount(0);
      await page
        .getByRole("combobox", { name: "资料状态", exact: true })
        .selectOption("archived");
      await expect(
        page
          .getByRole("navigation", { name: "资料目录" })
          .getByRole("button", { name: /渡口考据/ }),
      ).toBeVisible();
      const final = data(cli(grant, "hetu.resources.get", { resource_id: id }));
      expect(final.resource.revision).toBe(5);
      expect(final.resource.state).toBe("archived");
      const forbidden = await tool("hetu_update_resource", {
        ...fields("late"),
        task_ref,
        resource_id: id,
        expected: { revision: 5, sha256: final.sha256 },
      });
      expect(forbidden.error.code).toBe("forbidden");
      await app.close();
      app = undefined;
      const archivedJournal = JSON.parse(
        await readFile(path.join(dir, file), "utf8"),
      );
      archivedJournal.status = "pending";
      await writeFile(path.join(dir, file), JSON.stringify(archivedJournal));
      page = await launch();
      await navigate(page, "资料与素材");
      await page
        .getByRole("button", {
          name: "核对保留操作：归档「渡口考据」",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "查询并恢复原资料操作", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "资料操作恢复" }),
      ).toContainText("已成功");
      expect(
        data(cli(grant, "hetu.resources.get", { resource_id: id })).resource
          .revision,
      ).toBe(5);
    } finally {
      await client?.close();
      await app?.close();
    }
  },
);
