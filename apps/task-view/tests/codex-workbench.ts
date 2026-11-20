import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/client";

/** 使用隔离配置转发真实App交互，不启动模型轮次或读取开发者的Codex配置。 */
export async function codexWorkbench(binary: string, command: string, env: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), "hetu-codex-workbench-"));
  await writeFile(path.join(directory, "config.toml"), [
    "[mcp_servers.hetu]", `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(["--client", "codex", "--collaboration-dir", env.HETU_COLLABORATION_DIR])}`, "startup_timeout_sec = 45", "tool_timeout_sec = 360",
    "[mcp_servers.hetu.env]", ...Object.entries(env).map(([name, value]) => `${name} = ${JSON.stringify(value)}`),
  ].join("\n"));
  const child = spawn(binary, ["app-server"], { env: { ...process.env, CODEX_HOME: directory }, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  let next = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  lines.on("line", line => {
    const response = JSON.parse(line), request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer);
    response.error ? request.reject(new Error(response.error.message)) : request.resolve(response.result);
  });
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method}超时`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const close = async () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("验收连接已关闭")); }
    pending.clear(); lines.close(); child.stdin.end(); child.kill();
  };
  try {
    await call("initialize", { clientInfo: { name: "hetu-full-workbench-acceptance", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
    const thread = (await call("thread/start", { cwd: directory, ephemeral: true })).thread.id;
    return {
      callTool: (params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> =>
        call("mcpServer/tool/call", { threadId: thread, server: "hetu", tool: params.name, arguments: params.arguments }),
      readResource: (params: { uri: string }): Promise<ReadResourceResult> => call("mcpServer/resource/read", { server: "hetu", ...params }),
      close,
    };
  } catch (error) { await close(); throw error; }
}
