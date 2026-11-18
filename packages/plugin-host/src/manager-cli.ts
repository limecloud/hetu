/** 稳定CLI/MCP和桌面共享安装Owner；发现仅读声明，调用才按需启动插件后端。 */
import { PluginInstallations, type InstalledPackageIdentity } from "./installations.ts";
import { PluginPackage } from "./package.ts";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillSummaries } from "./skills.ts";
import { capabilitiesSha } from "./dispatch.ts";
const flags = process.argv.slice(2);
if (flags.length !== 4 || flags[0] !== "--directory" || flags[2] !== "--core-cli") throw new Error("插件管理连接参数无效。");
let wire = "";
for await (const chunk of process.stdin) {
  wire += chunk;
  if (Buffer.byteLength(wire) > 1024 * 1024) throw new Error("插件管理输入超过预算。");
}
const request = JSON.parse(wire), store = new PluginInstallations(flags[1]);
async function runtime() {
  const input = request.input, { state } = await store.read(), host = await store.host(state);
  if (!host.active(input.plugin_id)) throw new Error("插件未启用、包已变化或依赖不可用，请重新发现。");
  const pkg = host.package(input.plugin_id);
  if (pkg.sha256 !== input.package_sha256) throw new Error("插件包已更新，旧能力引用不可继续使用。");
  const openMode = request.action.startsWith("hetu.plugins.");
  const privateDirectory = openMode ? await mkdtemp(path.join(os.tmpdir(),"hetu-plugin-connection-")) : undefined;
  if (privateDirectory) await writeFile(path.join(privateDirectory,"management.json"),JSON.stringify(input.management_binding),{mode:0o600});
  try {
  const connection = [path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-runtime.mjs"),
    "--package", pkg.source, "--workspace", input.workspace_directory,
    ...(openMode ? ["--work-ref",JSON.stringify(input.work_ref),"--state-dir",store.directory,"--management-context-file",path.join(privateDirectory!,"management.json")]
      : ["--access-dir",input.access_directory,"--grant",input.grant_id]),
    "--package-sha256", pkg.sha256, "--core-cli", flags[3]];
  const run = (args: string[], value?: unknown) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [...connection, ...args], { stdio: "pipe", shell: false, windowsHide: true });
    // 保留跨管道分块的 UTF-8 字符，否则中文 Schema 会改变能力摘要。
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "", error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("插件结果未知，请保留原键回读。")); }, 35000);
    child.stdout.on("data", chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) { child.kill(); reject(new Error("插件输出超过预算。")); }
    });
    child.stderr.on("data", chunk => { if (error.length < 8000) error += chunk; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || "插件调用未完成，请按原键回读。"));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("插件回执无效，请保留原键。")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(value === undefined ? "" : JSON.stringify(value));
  });
  if (["hetu.plugins.capabilities","hetu.plugin_access.capabilities"].includes(request.action)) {
    const capabilities = await run(["capabilities"]);
    const capabilities_sha256 = capabilitiesSha(capabilities);
    return { format_version: 1, ...capabilities, capabilities_sha256 };
  }
  return await run(["dispatch", "--input", "-"], {capabilities_sha256:input.capabilities_sha256,
    action:input.action, arguments:input.arguments});
  } finally {if(privateDirectory)await rm(privateDirectory,{recursive:true,force:true});}
}
const revoke = async (pkg: InstalledPackageIdentity) => new Promise<void>((resolve, reject) => {
  const child = spawn(flags[3], ["disable-package", "--input", "-"], { stdio: "pipe", shell: false, windowsHide: true });
  const timer = setTimeout(() => { child.kill(); reject(new Error("撤权结果未知，请按原键回读。")); }, 30000);
  child.stdout.resume(); child.stderr.resume();
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("插件授权撤销未完成。")); });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ plugin_id: pkg.manifest.id, package_sha256: pkg.sha256,
    authorization_note: request.input.authorization_note, operation_key: request.input.operation_key }));
});
try {
  let data: unknown;
  switch (request.action) {
    case "hetu.plugins.capabilities":
    case "hetu.plugins.invoke":
    case "hetu.plugin_access.capabilities":
    case "hetu.plugin_access.invoke": data = await runtime(); break;
    case "hetu.plugins.inspect": data = { ...(await store.inspect()), state_directory: store.directory }; break;
    case "hetu.plugins.inspect_package": {
      const pkg = await PluginPackage.inspect(request.input.package_directory);
      data = { package_sha256: pkg.sha256, manifest: pkg.manifest, skills: skillSummaries(pkg),
        code_execution: !!pkg.manifest.runtime, note: "安装并启用后可使用宿主公开核心能力。" };
      break;
    }
    case "hetu.plugins.apply": data = await store.apply({ ...request.input, client_adapter: request.client_adapter }, revoke); break;
    case "hetu.plugins.get_operation": data = await store.getOperation(request.client_adapter, request.input.operation_key); break;
    default: throw new Error("未知插件管理动作。");
  }
  process.stdout.write(JSON.stringify({ ok: true, data }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : "插件管理未完成。" }));
  process.exitCode = 1;
}
