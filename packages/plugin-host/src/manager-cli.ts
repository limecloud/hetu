/** 由稳定CLI/MCP和桌面共享的安装管理入口；不启动插件后端。 */
import { PluginInstallations } from "./installations.ts";
import { PluginPackage } from "./package.ts";
import { spawn } from "node:child_process";
const flags = process.argv.slice(2);
if (flags.length !== 4 || flags[0] !== "--directory" || flags[2] !== "--core-cli") throw new Error("插件管理连接参数无效。");
let wire = "";
for await (const chunk of process.stdin) {
  wire += chunk;
  if (Buffer.byteLength(wire) > 1024 * 1024) throw new Error("插件管理输入超过预算。");
}
const request = JSON.parse(wire), store = new PluginInstallations(flags[1]);
const revoke = async (pkg: PluginPackage) => new Promise<void>((resolve, reject) => {
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
    case "hetu.plugins.inspect": data = { ...(await store.inspect()), state_directory: store.directory }; break;
    case "hetu.plugins.inspect_package": {
      const pkg = await PluginPackage.inspect(request.input.package_directory);
      data = { package_sha256: pkg.sha256, manifest: pkg.manifest,
        code_execution: !!pkg.manifest.runtime, note: "安装可信来源；升级须重新授予作品权限。" };
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
