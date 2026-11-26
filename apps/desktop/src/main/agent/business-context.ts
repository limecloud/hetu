import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import type {WorkRef} from "@hetu/plugin-sdk";
import type {AgentEngineId} from "../../agent-session-contract.ts";
import {machineClient} from "./engines.ts";
import {creativeParticipation} from "../../creative-request.ts";
import {machineEnvironment} from "./machine-environment.ts";

/** 原生客户端配置只写本会话沙箱，账号和用户级偏好由原生客户端管理。 */
export async function prepareBusinessContext(options:{client:AgentEngineId;cwd:string;binary:string;directory:string;work?:WorkRef;node:string;relay:string;environment?:Record<string,string|undefined>}){
  const {client,cwd,work}=options;
  const mcpArgs=["--client",machineClient(client),"--collaboration-dir",options.directory,...(work?["--work-ref",JSON.stringify(work)]:[])];
  const config=path.join(cwd,"hetu-mcp.json");
  await writeFile(config,JSON.stringify({binary:options.binary,args:mcpArgs,receipts:path.join(cwd,"receipts.json")}),{mode:0o600});
  const mcpEnvironment=machineEnvironment({...options.environment,HETU_COLLABORATION_DIR:options.directory});
  const mcp={command:options.node,args:[options.relay,config],env:mcpEnvironment};
  const instruction="# 河图创作工作区\n\n"+creativeParticipation+"\n\n需要作品能力时，通过hetu MCP发现实际能力和已启用的方法。先读取执行模式与领域Schema，再读取固定修订和已有成果。作品文件只经机器入口访问，不直接写.hetu。保留真实身份、CAS及原操作键；结果未知查询原操作。生成参考稿与作者采纳、定稿分开。\n当前范围："+JSON.stringify(work??{scope:"creation_preparation"})+"\n";
  const args:string[]=[],env:NodeJS.ProcessEnv={};
  if(client==="claude-code"){
    args.push("--mcp-config",JSON.stringify({mcpServers:{hetu:mcp}}));
    await writeFile(path.join(cwd,"CLAUDE.md"),instruction,{mode:0o600});
  }else if(client==="gemini"){
    await mkdir(path.join(cwd,".gemini"),{recursive:true,mode:0o700});
    await writeFile(path.join(cwd,".gemini/settings.json"),JSON.stringify({mcpServers:{hetu:mcp}}),{mode:0o600});
    await writeFile(path.join(cwd,"GEMINI.md"),instruction,{mode:0o600});
  }else if(client==="opencode"){
    env.OPENCODE_CONFIG_CONTENT=JSON.stringify({mcp:{hetu:{type:"local",command:[mcp.command,...mcp.args],environment:mcpEnvironment,enabled:true}},instructions:[path.join(cwd,"AGENTS.md")]});
    await writeFile(path.join(cwd,"AGENTS.md"),instruction,{mode:0o600});
  }
  return {args,env};
}
