import path from "node:path";
import type { WorkRef } from "@hetu/plugin-sdk";
import type {AgentContextRef} from "../../agent-session-contract.ts";
import {machineEnvironment} from "./machine-environment.ts";

export type AgentSessionContext = {
  schema_version: "1";
  work_ref?: WorkRef;
  scope: "current_work_only" | "creation_preparation";
  machine_entrypoint: "hetu CLI/MCP";
  first_action: string;
  fixed_context?:AgentContextRef[];
};

export function serializeAgentSessionContext(context: AgentSessionContext): string {
  return JSON.stringify(context);
}

export function buildAgentSessionPrompt(context: AgentSessionContext, request: string): string {
  const message = request.trim();
  if (!message) throw new Error("请输入要发送给 Agent 的内容。");
  return `你正在河图独立桌面中工作。当前作品上下文如下：${serializeAgentSessionContext(context)}\n请保持该作品范围，读取固定来源并回读结果。不要读取未由机器入口固定交接的本机文件。作者请求：${message}`;
}

/** Codex 引擎只在本机私有会话沙箱中启动；作品文件由稳定 CLI/MCP 交接。 */
export function agentSessionSandbox(profile: string, work: WorkRef): string {
  const segment = (value: string) => encodeURIComponent(value).replaceAll("%", "_");
  return path.join(profile, "agent-sessions", "sandbox", segment(work.workspace_id), segment(work.kind), segment(work.object_id));
}

export function agentSessionPersistPath(profile: string, work: WorkRef): string {
  const segment = (value: string) => encodeURIComponent(value).replaceAll("%", "_");
  return path.join(profile, "agent-sessions", `${segment(work.workspace_id)}-${segment(work.kind)}-${segment(work.object_id)}.json`);
}

/** 为 Codex App Server 注入本机会话专用的河图 MCP；认证仍由用户全局 Codex 配置管理。 */
export function buildCodexAppServerArgs(machineMcpBinary?: string, machineDirectory?: string, workRef?: WorkRef,localSettingsDirectory?:string,environment:Record<string,string|undefined>={}): string[] {
  const args = ["app-server"];
  if (!machineMcpBinary || !machineDirectory) return args;
  const mcpArgs = ["--client", "codex", "--collaboration-dir", machineDirectory, ...(workRef ? ["--work-ref", JSON.stringify(workRef)] : [])];
  args.push(
    "-c", `mcp_servers.hetu.command=${JSON.stringify(machineMcpBinary)}`,
    "-c", `mcp_servers.hetu.args=${JSON.stringify(mcpArgs)}`,
    "-c", 'mcp_servers.hetu.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.hetu.startup_timeout_sec=45",
    "-c", "mcp_servers.hetu.tool_timeout_sec=360",
  );
  for(const [key,value]of Object.entries(machineEnvironment({...environment,HETU_COLLABORATION_DIR:machineDirectory,...(localSettingsDirectory?{HETU_LOCAL_SETTINGS_DIR:localSettingsDirectory}:{})})))args.push("-c",`mcp_servers.hetu.env.${key}=${JSON.stringify(value)}`);
  return args;
}
