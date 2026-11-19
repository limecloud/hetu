import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const lost of [false, true]) test(`fixed connection installation ${lost ? "recovers a lost receipt" : "registers once"} using isolated Codex state`, async () => {
  test.skip(process.platform === "win32", "本夹具使用Unix可执行脚本；Windows制品另验。");
  const folder = await mkdtemp(join(tmpdir(), "hetu-connection-install-"));
  const codexHome = join(folder, "codex"), fake = join(folder, "codex-test");
  await mkdir(codexHome);
  await writeFile(fake, await readFile("../../core/tests/fixtures/codex-settings.py")); await chmod(fake, 0o700);
  const client = new Client({ name: "Hetu connection installation acceptance", version: "1" });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  await client.connect(new StdioClientTransport({ command: resolve(process.env.HETU_CARGO_TARGET_DIR ?? "../../target", "debug/hetu-mcp"), args: ["--client", "codex", "--collaboration-dir", join(folder, "collaboration")], env: { ...env, HETU_CODEX_BINARY: fake, CODEX_HOME: codexHome, HETU_LOCAL_SETTINGS_DIR: join(folder, "settings") }, stderr: "pipe" }));
  const invoke = async (action: string, input: Record<string, unknown>) => (await client.callTool({ name: "hetu_call_action", arguments: { action: `hetu.local_settings.${action}`, input } })).structuredContent as { status: string; data: Record<string, any>; error?: { code: string } };
  try {
    const prepared = await invoke("prepare", { kind: "agent_connection", agent_client: "codex", summary: "隔离环境安装河图MCP App", operation_key: "prepare-connection" });
    expect(prepared.status).toBe("succeeded"); const plan = prepared.data;
    const execution = { operation_id: plan.operation_id, sha256: plan.sha256, operation_key: "execute-connection" };
    expect((await invoke("execute", execution)).error?.code).toBe("hetu.author_confirmation_required");
    const approved = await invoke("record_decision", { operation_id: plan.operation_id, sha256: plan.sha256, revision: plan.revision, decision: "approve", authorization_note: "用户要求在隔离测试环境验收本次固定连接安装；不触碰真实Codex配置。", operation_key: "approve-connection" });
    expect(approved.status).toBe("succeeded");
    if (lost) await writeFile(join(codexHome, "drop-receipt"), "lose the registration reply");
    const first = await invoke("execute", execution);
    if (lost) { expect(first.status).toBe("unknown"); expect(first.error).toBeDefined(); } else expect(first.data.state).toBe("executed");
    const recovered = await invoke("execute", execution);
    expect(recovered.status).toBe("succeeded"); expect(recovered.data.state).toBe("executed");
    const installed = recovered.data.installation;
    expect(installed.session_loaded).toBe(false);
    const inspected = await invoke("inspect_connection", { agent_client: "codex" });
    expect(inspected.data.registered).toBe(true); expect(inspected.data.session_loaded).toBe(false);
    const mcp = JSON.parse(await readFile(join(installed.directory, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.hetu.args).toEqual(["--client", "codex"]);
    expect(mcp.mcpServers.hetu.command).toMatch(/hetu-mcp$/);
    expect(JSON.stringify(mcp)).not.toMatch(/management_ref|author|workspace_path|token|secret/);
    const log = await readFile(join(codexHome, "calls.log"), "utf8");
    expect(log.split("\n").filter(line => line.startsWith("plugin add "))).toHaveLength(1);
    expect(log.split("\n").filter(line => line.startsWith("plugin marketplace add "))).toHaveLength(1);
    expect(log).not.toContain("plugin marketplace list");
  } finally { await client.close(); }
});
