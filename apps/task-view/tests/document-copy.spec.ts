import {test, expect} from "@playwright/test";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {codexWorkbench} from "./codex-workbench.ts";

for (const transport of ["stdio", "codex"] as const) test(`${transport} 长文复制只传固定引用，完整源字节留在共享事务中`, async () => {
  test.skip(transport === "codex" && !process.env.HETU_ACCEPT_CODEX_BINARY, "需指定官方Codex CLI");
  test.setTimeout(120000);
  const root = path.resolve("../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-large-copy-"));
  const workspace = path.join(directory, "work"), profile = path.join(directory, "profile"), collaboration = path.join(directory, "collaboration");
  await mkdir(profile);
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, collaboration], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0); const refs = JSON.parse(fixture.stdout);
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "长文副本验收"}]}]}));
  const source = "正文🌿\r\n".repeat(180000), bytes = Buffer.byteLength(source);
  const author = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  let client: {callTool(input: any): Promise<any>; close(): Promise<any>} | undefined;
  try {
    const saved = await author.request("workspace/request", {action: "hetu.documents.save", contract_revision: "1", input: {document_id: refs.document.document.document_id, base_revision_id: refs.document.revision.revision_id, source_format: "markdown", content: source, operation_key: "large-source"}});
    expect(saved.status, JSON.stringify(saved)).toBe("succeeded");
    const env = {HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "local-settings"), HETU_PLUGIN_STATE_DIR: profile, HETU_PLUGIN_NODE: process.execPath, HETU_COLLABORATION_DIR: collaboration};
    const binary = process.env.HETU_ACCEPT_MCP_BINARY ?? path.join(root, "target/debug/hetu-mcp");
    if (transport === "codex") client = await codexWorkbench(process.env.HETU_ACCEPT_CODEX_BINARY!, binary, env);
    else {
      const direct = new Client({name: "large-copy-acceptance", version: "1"}, {capabilities: {extensions: {"io.modelcontextprotocol/ui": {mimeTypes: ["text/html;profile=mcp-app"]}}}});
      await direct.connect(new StdioClientTransport({command: binary, args: ["--client", "codex", "--collaboration-dir", collaboration], stderr: "pipe", env: {...process.env, ...env}})); client = direct;
    }
    const opened = await client.callTool({name: "hetu_open_app", arguments: {}}), session = opened._meta["hetu/workbenchSession"];
    const call = async (method: string, args: any[]) => {
      const result = await client!.callTool({name: "hetu_app_request", arguments: {session, method, args}});
      expect(result.isError, JSON.stringify(result)).not.toBe(true); return result.structuredContent.value;
    };
    await call("select", [refs.novel]);
    const prepared = await call("author", ["duplicate", {document_id: refs.document.document.document_id, base_revision_id: saved.data.revision.revision_id}]);
    expect(prepared.size_bytes).toBe(bytes); expect(prepared).not.toHaveProperty("source");
    expect(Buffer.byteLength(JSON.stringify(prepared))).toBeLessThan(4096);
    const copied = await call("author", ["commit", {token: prepared.token}]);
    expect(copied.status, JSON.stringify(copied)).toBe("succeeded");
    const actual = await author.request("workspace/request", {action: "hetu.documents.get", contract_revision: "1", input: {document_id: copied.data.document.document_id}});
    expect(actual.status).toBe("succeeded"); expect(actual.data.content).toBe(source);
    expect(actual.data.revision.sha256).toBe(saved.data.revision.sha256);
  } finally {await client?.close(); await author.close();}
});
