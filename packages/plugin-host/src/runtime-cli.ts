/** 同一插件宿主的无窗口入口；仅运行明确指定且摘要匹配的包。 */
import { readFile } from "node:fs/promises";
import { PluginInstallations } from "./installations.ts";
import { PluginPackage } from "./package.ts";
import { BackendSupervisor } from "./backend.ts";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import type { PluginBridge } from "@hetu/plugin-sdk";
import { sameWork } from "@hetu/plugin-sdk";
import Ajv from "ajv";
import { skillSummaries, skillReadAction, readSkill } from "./skills.ts";
import { dispatchPlugin } from "./dispatch.ts";
const args = process.argv.slice(2);
const flags = new Map<string, string>();
while (args[0]?.startsWith("--") && args[0] !== "--mcp") {
  const key = args.shift()!,
    value = args.shift();
  if (
    !value ||
    ![
      "--package",
      "--workspace",
      "--grant",
      "--package-sha256",
      "--access-dir",
      "--core-cli",
      "--work-ref",
      "--state-dir",
      "--management-context-file",
    ].includes(key) ||
    flags.has(key)
  )
    throw new Error("插件运行参数无效。");
  flags.set(key, value);
}
const required = (key: string) => {
  const value = flags.get(key);
  if (!value) throw new Error("缺少参数：" + key);
  return value;
};
const pkg = await PluginPackage.inspect(required("--package"));
if (pkg.sha256 !== required("--package-sha256"))
  throw new Error("插件包摘要与授权不一致。");
const openMode = flags.has("--work-ref");
let sessionDirectory: string | undefined;
const installed = openMode ? new PluginInstallations(required("--state-dir")) : undefined;
async function checkInstalled() {
  if (!installed) return;
  const {state} = await installed.read(), host = await installed.host(state);
  if (!host.active(pkg.manifest.id) || host.package(pkg.manifest.id).sha256 !== pkg.sha256)
    throw new Error("插件已停用或包已变化，请重新发现。");
}
await checkInstalled();
if (openMode) {
  sessionDirectory = await mkdtemp(path.join(os.tmpdir(), "hetu-plugin-context-"));
  const management = flags.has("--management-context-file")
    ? JSON.parse(await readFile(required("--management-context-file"), "utf8")) : undefined;
  await writeFile(path.join(sessionDirectory,"context.json"), JSON.stringify({
    context: {plugin_id:pkg.manifest.id,package_sha256:pkg.sha256,
      work_ref:JSON.parse(required("--work-ref")),types:pkg.manifest.contributions.data},
    ...(management ? {management_binding:management} : {}),
  }), {mode:0o600});
}
const coreArgs = [
  "--workspace",
  required("--workspace"),
  ...(openMode ? ["--context-file", path.join(sessionDirectory!, "context.json")] : ["--grant", required("--grant")]),
  "--package-sha256",
  pkg.sha256,
  ...(flags.has("--access-dir")
    ? ["--access-dir", flags.get("--access-dir")!]
    : []),
];
function core(command: string[], input?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(required("--core-cli"), [...coreArgs, ...command], {
      stdio: "pipe",
      windowsHide: true,
      shell: false,
    });
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Core结果未知，请按原操作键回读。"));
    }, 30000);
    child.stdout.on("data", (data: Buffer) => {
      bytes = Buffer.concat([bytes, data]);
      if (bytes.length > 2 * 1024 * 1024) {
        child.kill();
        reject(new Error("Core输出超过预算。"));
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(bytes.toString("utf8")));
      } catch {
        reject(new Error("Core调用失败，请核对授权与原操作。"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}
const inspected = await core(["inspect"]);
if (inspected.status !== "succeeded")
  throw new Error(inspected.error?.message ?? "授权不可用。");
const context = inspected.data;
if (
  context.plugin_id !== pkg.manifest.id ||
  context.package_sha256 !== pkg.sha256
)
  throw new Error("授权身份与固定插件包不一致。");
if (!openMode && (context.permissions.some((permission: any) => !(pkg.manifest.permissions ?? []).includes(permission)) ||
    context.types.some((type: any) => !pkg.manifest.contributions.data.some(declared => isDeepStrictEqual(type, declared)))))
  throw new Error("插件授权超出固定包声明，请重新核对类型与权限。");
const actions = pkg.manifest.contributions.actions.filter(
  (action) =>
    openMode || action.effect === "read" || context.permissions.includes("objects.write"),
);
const request: PluginBridge["request"] = async (action, input) => {
  await checkInstalled();
  if (input.work_ref && !sameWork(input.work_ref, context.work_ref))
    return Promise.reject(new Error("插件不能切换作品。"));
  return core(["call", action, "--input", "-"], {
    ...input,
    ...(!openMode || action.startsWith("hetu.extensions.") ? {work_ref:context.work_ref} : {}),
  });
};
let backend: BackendSupervisor | undefined, snapshot: string | undefined;
async function cleanup() {
  await backend?.dispose().catch(() => {});
  if (snapshot) await rm(snapshot, { recursive: true, force: true });
  if (sessionDirectory) await rm(sessionDirectory, {recursive:true,force:true});
}

async function invoke(action: string, input: unknown) {
  await checkInstalled();
  if (action === "skills.read") return {
    spec_version: "0.2.1", status: "succeeded", data: readSkill(pkg, input),
  };
  if (
    !actions.some((a) => a.id === action) ||
    (await core(["inspect"])).status !== "succeeded"
  )
    throw new Error("插件动作未获权或授权已撤销。");
  if (!backend) {
    snapshot = await mkdtemp(path.join(os.tmpdir(), "hetu-plugin-runtime-"));
    for (const [name, bytes] of pkg.entries()) {
      const target = path.join(snapshot, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o600 });
    }
    backend = new BackendSupervisor({
      node: process.execPath,
      bootstrap: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "plugin-worker.mjs",
      ),
      snapshot,
      pkg,
      work_ref: context.work_ref,
      request,
      core_actions: context.core_actions,
    });
    await backend.initialize();
  }
  return backend.invoke(action, input);
}
const capabilities = () => ({
  plugin_id: pkg.manifest.id,
  package_sha256: pkg.sha256,
  work_ref: context.work_ref,
  actions,
  data_actions: context.actions,
  types: context.types,
  skills: skillSummaries(pkg),
  resource_actions: [skillReadAction],
  ...(openMode ? {access_mode:"open", core_actions:context.core_actions} : {permissions:context.permissions}),
});
if (args[0] === "capabilities" && args.length === 1) {
  console.log(JSON.stringify(capabilities()));
  await cleanup();
} else if (args.length === 3 && args[0] === "dispatch" && args[1] === "--input" && args[2] === "-") {
  // 稳定入口在同一进程完成发现核验和调用，不重复启动完整运行时。
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("输入超过预算。");
    }
    console.log(JSON.stringify(await dispatchPlugin(capabilities(), JSON.parse(input), { request, invoke })));
  } finally { await cleanup(); }
} else if (
  ["invoke", "call"].includes(args[0]) &&
  args.length === 4 &&
  args[2] === "--input" &&
  args[3] === "-"
) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024)
      throw new Error("输入超过预算。");
  }
  try {
    const value = JSON.parse(input);
    if (args[0] === "call" && !openMode && !context.actions.some((action: any) => action.name === args[1]))
      throw new Error("插件数据动作未获权。");
    console.log(JSON.stringify(args[0] === "call" ? await request(args[1], value) : await invoke(args[1], value)));
  } finally {
    await cleanup();
  }
} else if (args.length === 1 && args[0] === "--mcp") {
  const toolName = (id: string) =>
    "plugin_" + id.replace(/[^a-zA-Z0-9_]/g, "_");
  const tools = [
    ...actions.map((action) => ({
      name: toolName(action.id),
      description: action.title,
      inputSchema: action.input_schema,
    })),
    ...context.actions.map((action: any) => ({
      name: action.tool_name,
      description: action.title,
      inputSchema: action.input_schema,
    })),
    ...(openMode ? [{
      name: "hetu_core_request",
      description: "按已发现的核心动作与Schema调用宿主；保持当前作品和执行身份。",
      inputSchema: {type:"object",additionalProperties:false,required:["action","input"],properties:{
        action:{type:"string",enum:context.core_actions.map((a:any)=>a.name)},input:{type:"object"},
      }},
    }] : []),
  ];
  if (new Set(tools.map((t) => t.name)).size !== tools.length)
    throw new Error("动作映射产生MCP名称冲突。");
  const validators = tools.map((tool) =>
    new Ajv({ strict: false }).compile(tool.inputSchema),
  );
  const bridgeRequest = request;
  const createServer = () => {
    const server = new Server(
      { name: "hetu-plugin-runtime", version: "0.9.0" },
      {
        capabilities: { tools: {} },
        supportedProtocolVersions: ["2026-07-28", "2025-06-18"],
      },
    );
    let busy = false;
    server.setRequestHandler("tools/list", async () => {
      await checkInstalled();
      return {tools:(await core(["inspect"])).status === "succeeded" ? (tools as any) : []};
    });
    server.setRequestHandler("tools/call", async (request) => {
      const index = tools.findIndex(
        (tool) => tool.name === request.params.name,
      );
      if (index < 0 || busy) throw new Error("工具不可用或前一操作尚未完成。");
      if (!validators[index](request.params.arguments ?? {}))
        throw new Error("工具参数不符合当前Schema。");
      await checkInstalled();
      if ((await core(["inspect"])).status !== "succeeded")
        throw new Error("插件授权已撤销。");
      busy = true;
      try {
        const declaration = context.actions.find(
          (action: any) => action.tool_name === request.params.name,
        );
        const input = request.params.arguments ?? {};
        const value = request.params.name === "hetu_core_request" && openMode
          ? await bridgeRequest(input.action as string, input.input as Record<string, unknown>)
          : declaration
            ? await bridgeRequest(declaration.name, input)
            : await invoke(actions[index].id, input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: (value && typeof value === "object"
            ? value
            : { value }) as any,
          isError:
            typeof value === "object" &&
            value !== null &&
            "status" in value &&
            (value as any).status !== "succeeded",
        };
      } finally {
        busy = false;
      }
    });
    server.onclose = () => {
      void cleanup();
    };
    return server;
  };
  serveStdio(createServer, {
    transport: new StdioServerTransport(undefined, undefined, {
      maxBufferSize: 1024 * 1024,
    }),
  });
} else
  throw new Error("使用 capabilities、dispatch --input -、invoke/call <action> --input - 或 --mcp。");
