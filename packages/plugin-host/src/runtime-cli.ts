/** 同一插件宿主的无窗口入口；仅运行明确指定且摘要匹配的包。 */
import { PluginPackage } from "./package.ts";
import { BackendSupervisor } from "./backend.ts";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import type { PluginBridge } from "@hetu/plugin-sdk";
import { sameWork } from "@hetu/plugin-sdk";
import Ajv from "ajv";
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
const coreArgs = [
  "--workspace",
  required("--workspace"),
  "--grant",
  required("--grant"),
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
const actions = pkg.manifest.contributions.actions.filter(
  (action) =>
    action.effect === "read" || context.permissions.includes("objects.write"),
);
const request: PluginBridge["request"] = (action, input) => {
  if (input.work_ref && !sameWork(input.work_ref, context.work_ref))
    return Promise.reject(new Error("插件不能切换作品。"));
  return core(["call", action, "--input", "-"], {
    ...input,
    work_ref: context.work_ref,
  });
};
let backend: BackendSupervisor | undefined, snapshot: string | undefined;
async function cleanup() {
  await backend?.dispose().catch(() => {});
  if (snapshot) await rm(snapshot, { recursive: true, force: true });
}

async function invoke(action: string, input: unknown) {
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
  permissions: context.permissions,
});
if (args[0] === "capabilities" && args.length === 1) {
  console.log(JSON.stringify(capabilities()));
} else if (
  args[0] === "invoke" &&
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
    console.log(JSON.stringify(await invoke(args[1], JSON.parse(input))));
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
  ];
  if (new Set(tools.map((t) => t.name)).size !== tools.length)
    throw new Error("动作映射产生MCP名称冲突。");
  const validators = tools.map((tool) =>
    new Ajv({ strict: false }).compile(tool.inputSchema),
  );
  const createServer = () => {
    const server = new Server(
      { name: "hetu-plugin-runtime", version: "0.8.0" },
      {
        capabilities: { tools: {} },
        supportedProtocolVersions: ["2026-07-28", "2025-06-18"],
      },
    );
    let busy = false;
    server.setRequestHandler("tools/list", async () => ({
      tools:
        (await core(["inspect"])).status === "succeeded" ? (tools as any) : [],
    }));
    server.setRequestHandler("tools/call", async (request) => {
      const index = tools.findIndex(
        (tool) => tool.name === request.params.name,
      );
      if (index < 0 || busy) throw new Error("工具不可用或前一操作尚未完成。");
      if (!validators[index](request.params.arguments ?? {}))
        throw new Error("工具参数不符合当前Schema。");
      if ((await core(["inspect"])).status !== "succeeded")
        throw new Error("插件授权已撤销。");
      busy = true;
      try {
        const declaration = context.actions.find(
          (action: any) => action.tool_name === request.params.name,
        );
        const value = declaration
          ? await core(["call", declaration.name, "--input", "-"], {
              ...request.params.arguments,
              work_ref: context.work_ref,
            })
          : await invoke(actions[index].id, request.params.arguments ?? {});
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
  throw new Error("使用 capabilities、invoke <action> --input - 或 --mcp。");
