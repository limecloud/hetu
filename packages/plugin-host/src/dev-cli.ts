/** 插件开发入口不接触作品、授权或运行时；校验不执行包内代码。 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { PluginPackage } from "./package.ts";
import { scaffold } from "./scaffold.ts";

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { help: { type: "boolean" }, id: { type: "string" }, title: { type: "string" } } });
  const [command, directory] = positionals;
  if (values.help) {
    console.log(JSON.stringify({ usage: ["plugin-dev.mjs create <absolute-directory> --id <reverse-domain-id> --title <name>", "plugin-dev.mjs validate <absolute-package-directory>"], permissions: "不读取作品、不授权、不执行插件代码" }));
    return;
  }
  if (positionals.length !== 2 || !directory) throw new Error("用法：plugin-dev.mjs create <绝对目录> --id <插件ID> --title <名称>，或 validate <绝对分发目录>");
  if (command === "create") {
    if (!values.id || !values.title) throw new Error("创建插件需要 --id 与 --title。");
    console.log(JSON.stringify(await scaffold(directory, values.id, values.title, fileURLToPath(new URL(".", import.meta.url)))));
  } else if (command === "validate") {
    if (values.id || values.title) throw new Error("校验不接受创建参数。");
    const pkg = await PluginPackage.inspect(directory);
    console.log(JSON.stringify({ status: "valid", plugin_id: pkg.manifest.id, version: pkg.manifest.version, package_sha256: pkg.sha256, permissions: pkg.manifest.permissions, files: pkg.entries().length, contributions: { views: pkg.manifest.contributions.views.map(v => v.id), data: pkg.manifest.contributions.data.map(d => d.kind), actions: pkg.manifest.contributions.actions.map(a => a.id) } }));
  } else throw new Error("未知开发命令，只支持 create 和 validate。");
}
try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: { code: "plugin_development_failed", message: (error as Error).message } }));
  process.exitCode = 1;
}
