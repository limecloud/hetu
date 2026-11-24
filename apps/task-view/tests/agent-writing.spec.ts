import {test, expect} from "@playwright/test";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {codexWorkbench} from "./codex-workbench.ts";

for (const transport of ["stdio", "codex"] as const) test(`${transport} Agent经公开机器入口准备写作任务、保存参考稿并回读`, async ({}, info) => {
  test.skip(transport === "codex" && !process.env.HETU_ACCEPT_CODEX_BINARY, "需指定官方Codex CLI");
  test.setTimeout(120000);
  const root = path.resolve("../.."), folder = await mkdtemp(path.join(tmpdir(), "hetu-agent-writing-"));
  const workspace = path.join(folder, "work"), collaboration = path.join(folder, "collaboration");
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, collaboration], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0);
  const fixed = JSON.parse(fixture.stdout), mcp = process.env.HETU_ACCEPT_MCP_BINARY ?? path.join(root, "target/debug/hetu-mcp");
  const env = {HETU_DESKTOP_PROFILE: path.join(folder, "profile"), HETU_LOCAL_SETTINGS_DIR: path.join(folder, "settings"), HETU_COLLABORATION_DIR: collaboration, HETU_PLUGIN_NODE: process.execPath};
  const direct = new Client({name: "agent-writing-acceptance", version: "1"}, {capabilities: {}});
  const client = transport === "codex" ? await codexWorkbench(process.env.HETU_ACCEPT_CODEX_BINARY!, mcp, env) : direct;
  if (transport === "stdio") await direct.connect(new StdioClientTransport({command: mcp, args: ["--client", "codex", "--collaboration-dir", collaboration], stderr: "pipe", env: {...process.env, ...env}}));
  const actions: string[] = [];
  try {
    const tools = await client.listTools();
    const appTool = tools.tools.find((tool: any) => tool.name === "hetu_app_request") as {_meta?: {ui?: {visibility?: string[]}}} | undefined;
    expect(appTool?._meta?.ui?.visibility).toEqual(["app"]);
    const call = async (action: string, input: any) => {
      actions.push(action);
      const result = await client.callTool({name: "hetu_call_action", arguments: {action, input}});
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const value = result.structuredContent as any;
      expect(value.status, JSON.stringify(value)).toBe("succeeded");
      return value.data;
    };
    const execute = async (action: string, input: any) => {
      actions.push(action);
      const value = await call("hetu.execution.invoke", {workspace_path: workspace, command: {action, contract_revision: "1", input}});
      expect(value.result.status, JSON.stringify(value)).toBe("succeeded");
      return value.result.data;
    };
    // 全程不创建App会话、不运行桌面，也不借用作者桥接。
    expect((await call("hetu.execution.get_mode", {})).execution_mode).toBe("auto");
    const discovery = await call("hetu.collaboration.inspect", {action: "hetu.execution.invoke", include_schema: true, limit: 1});
    expect(discovery.actions[0].name).toBe("hetu.execution.invoke");
    expect(discovery.actions[0].input_schema.properties.workspace_path).toBeTruthy();
    const source = await execute("hetu.documents.get", {document_id: fixed.document.document.document_id});
    const handoff = await call("hetu.handoffs.get", {management_ref: fixed.grants.novel, view_kind: fixed.novel.kind, object_ref: {work_ref: fixed.novel, document_id: source.document.document_id, revision_id: source.revision.revision_id}});
    expect(handoff.fixed_refs.find((item: any) => item.kind === "document").sha256).toBe(source.revision.sha256);
    const preview = await execute("hetu.creative_tasks.preview_prompt", {
      scope_ref: {kind: "workspace", id: fixed.novel.workspace_id}, work_ref: fixed.novel,
      task_kind: "chapter_draft", brief: "根据固定开篇续写隔离验收参考稿，不覆盖作者稿。",
      input_refs: [{kind: "document", document_id: source.document.document_id, revision_id: source.revision.revision_id}],
      target_ref: {document_id: source.document.document_id, revision_id: source.revision.revision_id, sha256: source.revision.sha256},
      client_adapter: "codex", language_tag: "zh-CN", candidate_limit: 1,
    });
    const prepared = await execute("hetu.creative_tasks.prepare", {...preview.prepare_input, operation_key: "agent-writing-prepare"});
    const task = prepared.task_ref;
    const content = "灯塔的光掠过海面。江岚把日记收进怀里，沿着潮声走向渡口。";
    const input = {task_ref: task, artifact_kind: "text", source_format: "markdown", title: "渡口续写参考稿", base_refs: [], feedback_refs: [], content, operation_key: "agent-writing-copy"};
    const copy = await execute("hetu.working_copies.create", input);
    const replay = await execute("hetu.working_copies.create", input);
    expect(replay.working_copy_ref).toEqual(copy.working_copy_ref);
    const submitted = await execute("hetu.creative_tasks.submit_result", {task_ref: task, request_sha256: prepared.request_sha256, working_copy_refs: [copy.working_copy_ref], complete: true, missing_items: [], feedback_refs: [], provenance: {client: "codex", skill_version: "acceptance"}, operation_key: "agent-writing-submit"});
    const result = await execute("hetu.creative_tasks.get", {task_ref: task});
    expect(JSON.stringify(result)).toContain(copy.working_copy_ref.working_copy_id);
    const saved = await execute("hetu.working_copies.get", {task_ref: task, working_copy_ref: copy.working_copy_ref});
    expect(saved.revision.content).toBe(content);
    expect((await execute("hetu.documents.get", {document_id: source.document.document_id})).content).toBe(source.content);
    await info.attach("machine-writing-receipt", {body: JSON.stringify({transport, actions, task_ref: task, working_copy_ref: copy.working_copy_ref, submitted}, null, 2), contentType: "application/json"});
  } finally {await client.close();}
});
