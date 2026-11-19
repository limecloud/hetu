import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, readFile, writeFile, chmod, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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
    if (!lost) {
      // 旧版本也只有Codex专用清单时，升级仍须核验来源和缓存，保留旧字节。
      const statePath = join(codexHome, "fixture-state.json"), state = JSON.parse(await readFile(statePath, "utf8"));
      const market = state.marketplaces[0].root, marketPath = join(market, ".agents/plugins/marketplace.json");
      const catalog = JSON.parse(await readFile(marketPath, "utf8")), oldVersion = "0.0.1";
      const source = join(market, catalog.plugins[0].source.path), oldSource = join(market, "versions", oldVersion, "hetu-workbench");
      const oldCache = join(codexHome, "plugins/cache/hetu-luoshu-machine-connection/hetu-workbench", oldVersion);
      await mkdir(join(market, "versions", oldVersion), { recursive: true });
      await rename(source, oldSource); await rename(installed.directory, oldCache);
      const manifest = JSON.parse(await readFile(join(oldSource, ".codex-plugin/plugin.json"), "utf8"));
      manifest.version = oldVersion;
      const oldBytes = JSON.stringify(manifest);
      for (const directory of [oldSource, oldCache]) await writeFile(join(directory, ".codex-plugin/plugin.json"), oldBytes);
      catalog.plugins[0].source.path = `./versions/${oldVersion}/hetu-workbench`;
      await writeFile(marketPath, JSON.stringify(catalog));
      state.installed[0].version = oldVersion; state.installed[0].source.path = oldSource;
      await writeFile(statePath, JSON.stringify(state));
      const upgrade = await invoke("prepare", { kind: "agent_connection", agent_client: "codex", summary: "升级Codex专用格式连接", operation_key: "prepare-upgrade" });
      expect(upgrade.status).toBe("succeeded"); const fixed = upgrade.data;
      expect((await invoke("record_decision", { operation_id: fixed.operation_id, sha256: fixed.sha256, revision: fixed.revision, decision: "approve", authorization_note: "隔离测试中升级旧连接，保留旧版本缓存。", operation_key: "approve-upgrade" })).status).toBe("succeeded");
      const upgraded = await invoke("execute", { operation_id: fixed.operation_id, sha256: fixed.sha256, operation_key: "execute-upgrade" });
      expect(upgraded.status, JSON.stringify(upgraded)).toBe("succeeded");
      expect(upgraded.data.installation.version).toBe(plan.fixed.suite.version);
      expect(await readFile(join(oldSource, ".codex-plugin/plugin.json"), "utf8")).toBe(oldBytes);
      expect(await readFile(join(oldCache, ".codex-plugin/plugin.json"), "utf8")).toBe(oldBytes);
    }
  } finally { await client.close(); }
});

test("installed official Codex CLI accepts the connection package in an isolated home", async () => {
  const binary = process.env.HETU_ACCEPT_CODEX_BINARY;
  test.skip(!binary, "指定HETU_ACCEPT_CODEX_BINARY才验收已安装的官方CLI，不依赖开发者真实配置。");
  test.setTimeout(90_000);
  const folder = await mkdtemp(join(tmpdir(), "hetu-official-codex-install-"));
  const codexHome = join(folder, "codex"); await mkdir(codexHome);
  const client = new Client({ name: "Hetu official CLI isolated acceptance", version: "1" });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  await client.connect(new StdioClientTransport({ command: resolve(process.env.HETU_CARGO_TARGET_DIR ?? "../../target", "debug/hetu-mcp"), args: ["--client", "codex", "--collaboration-dir", join(folder, "collaboration")], env: { ...env, HETU_CODEX_BINARY: binary!, CODEX_HOME: codexHome, HETU_LOCAL_SETTINGS_DIR: join(folder, "settings") }, stderr: "pipe" }));
  const invoke = async (action: string, input: Record<string, unknown>) => (await client.callTool({ name: "hetu_call_action", arguments: { action: `hetu.local_settings.${action}`, input } })).structuredContent as { status: string; data: Record<string, any> };
  try {
    const prepared = await invoke("prepare", { kind: "agent_connection", agent_client: "codex", summary: "官方Codex隔离连接验收", operation_key: "official-prepare" });
    expect(prepared.status).toBe("succeeded"); const plan = prepared.data;
    expect((await invoke("record_decision", { operation_id: plan.operation_id, sha256: plan.sha256, revision: plan.revision, decision: "approve", authorization_note: "本次用户授权的官方CLI隔离安装验收，仅修改临时CODEX_HOME。", operation_key: "official-decision" })).status).toBe("succeeded");
    const installed = await invoke("execute", { operation_id: plan.operation_id, sha256: plan.sha256, operation_key: "official-execute" });
    expect(installed.status, JSON.stringify(installed)).toBe("succeeded");
    const current = await invoke("inspect_connection", { agent_client: "codex" });
    expect(current.status).toBe("succeeded"); expect(current.data.registered).toBe(true); expect(current.data.session_loaded).toBe(false);
    const mcp = JSON.parse(await readFile(join(current.data.directory, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.hetu.args).toEqual(["--client", "codex"]);
    const suite=await invoke("prepare",{kind:"agent_suite",agent_client:"codex",suite_id:"general",install:true,summary:"官方Codex隔离安装当前Skills",operation_key:"official-suite-prepare"});
    expect(suite.status).toBe("succeeded");const fixed=suite.data;
    expect((await invoke("record_decision",{operation_id:fixed.operation_id,sha256:fixed.sha256,revision:fixed.revision,decision:"approve",authorization_note:"用户授权本次隔离环境中核对MCP App与所选Skills均实际安装，不使用真实Codex配置。",operation_key:"official-suite-decision"})).status).toBe("succeeded");
    const executed=await invoke("execute",{operation_id:fixed.operation_id,sha256:fixed.sha256,operation_key:"official-suite-execute"});
    expect(executed.status,JSON.stringify(executed)).toBe("succeeded");
    const skills=await invoke("inspect_suite",{agent_client:"codex",suite_id:"general"});
    expect(skills.data.state).toBe("found");expect(skills.data.registration).toBe("enabled");
    expect((await invoke("inspect_connection",{agent_client:"codex"})).data.registered).toBe(true);
  } finally { await client.close(); }
});

test("official Codex loads the installed plugin and discovers the App before UI negotiation", async () => {
  const binary = process.env.HETU_ACCEPT_CODEX_BINARY;
  test.skip(!binary, "指定HETU_ACCEPT_CODEX_BINARY才验收真实Codex App Server的目录发现。");
  test.setTimeout(60_000);
  const folder = await mkdtemp(join(tmpdir(), "hetu-codex-app-catalog-"));
  const command = resolve(process.env.HETU_CARGO_TARGET_DIR ?? "../../target", "debug/hetu-mcp");
  const client = new Client({ name: "Hetu plugin catalog acceptance", version: "1" });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  await client.connect(new StdioClientTransport({ command, args: ["--client", "codex", "--collaboration-dir", join(folder, "access")], env: { ...env, CODEX_HOME: folder, HETU_CODEX_BINARY: binary!, HETU_LOCAL_SETTINGS_DIR: join(folder, "settings") }, stderr: "pipe" }));
  try {
    const invoke = async (action: string, input: Record<string, unknown>) => (await client.callTool({ name: "hetu_call_action", arguments: { action: `hetu.local_settings.${action}`, input } })).structuredContent as { status: string; data: Record<string, any> };
    const prepared = await invoke("prepare", { kind: "agent_connection", agent_client: "codex", summary: "实际插件加载与全局入口验收", operation_key: "catalog-prepare" });
    expect(prepared.status).toBe("succeeded"); const plan = prepared.data;
    expect((await invoke("record_decision", { operation_id: plan.operation_id, sha256: plan.sha256, revision: plan.revision, decision: "approve", authorization_note: "用户授权的本次隔离插件加载验收，仅修改临时Codex目录。", operation_key: "catalog-decision" })).status).toBe("succeeded");
    const installed = await invoke("execute", { operation_id: plan.operation_id, sha256: plan.sha256, operation_key: "catalog-install" });
    expect(installed.status, JSON.stringify(installed)).toBe("succeeded");
  } finally { await client.close(); }
  const child = spawn(binary!, ["app-server"], { env: { ...process.env, CODEX_HOME: folder }, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  let next = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  lines.on("line", line => {
    const response = JSON.parse(line), request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer);
    response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result);
  });
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method}超时`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await call("initialize", { clientInfo: { name: "hetu-app-catalog-acceptance", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const catalog = await call("mcpServerStatus/list", { limit: 100 });
    const server = catalog.data.find((entry: any) => entry.name === "hetu");
    expect(server?.toolsError).toBeNull();
    expect(server?.pluginId).toBe("hetu-workbench@hetu-luoshu-machine-connection");
    expect(server.tools.hetu_app_request?._meta?.ui?.visibility).toEqual(["app"]);
    const entry = server.tools.hetu_open_app;
    expect(entry?._meta?.["openai/ui"]?.entrypoints).toEqual([{ type: "global" }, { type: "thread" }]);
    expect(entry?._meta?.ui?.resourceUri).toBe("ui://hetu/workbench/2");
    // Codex额外协商elicitation时会暴露固定模型确认工具。
    expect(Object.keys(server.tools).length).toBeLessThanOrEqual(15);
    expect(server.resources.some((resource: any) => resource.uri === "ui://hetu/workbench/2")).toBe(true);
    const resource = await call("mcpServer/resource/read", { server: "hetu", uri: "ui://hetu/workbench/2" });
    expect(resource.contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(resource.contents[0].text).toContain("<!doctype html>");
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    lines.close(); child.stdin.end(); child.kill();
  }
});
