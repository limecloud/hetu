import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 创建独立工程；不安装依赖、不执行生成代码、不覆盖已有目录。 */
export async function scaffold(directory: string, id: string, title: string, kit: string) {
  if (!path.isAbsolute(directory) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(id) || id.length > 120 || !title.trim() || title.length > 120)
    throw new Error("请提供绝对目标目录、规范反向域名ID及1至120字的名称。");
  const sdk = await readFile(path.join(kit, "developer-sdk.ts"));
  const license = await readFile(path.join(kit, "developer-LICENSE.txt"));
  await mkdir(directory); // 已存在即拒绝；不对用户目录进行覆盖或清理。
  await mkdir(path.join(directory, "src"));
  const manifest = {
    manifest_version: 1, host_api: "1", id, version: "0.1.0", license: "Apache-2.0", dependencies: [], permissions: [],
    display: { "zh-CN": title, en: title }, description: { "zh-CN": "统计明确输入的文字，不读取作品数据。", en: "Counts explicit input without accessing work data." },
    contributions: {
      views: [{ id: "main", title, entry: "index.html", object_kinds: [] }], data: [],
      actions: [{ id: "count", title: "统计字符", effect: "read", input_schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 10000 } } } }],
    }, runtime: { entry: "backend.mjs" },
  };
  const files: Record<string, string | Uint8Array> = {
    "plugin.json": JSON.stringify(manifest, null, 2) + "\n",
    "package.json": JSON.stringify({ name: id, version: "0.1.0", private: true, type: "module", scripts: { check: "tsc --noEmit", build: "npm run check && node build.mjs" }, dependencies: { react: "18.3.1", "react-dom": "18.3.1" }, devDependencies: { esbuild: "0.28.2", typescript: "6.0.3", "@types/react": "18.3.28", "@types/react-dom": "18.3.7" } }, null, 2) + "\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2023", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, lib: ["ES2023", "DOM"] }, include: ["src"] }, null, 2) + "\n",
    "build.mjs": `import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["src/view.tsx"], outfile: "dist/view.js", bundle: true, platform: "browser", format: "iife", target: "chrome140", jsx: "automatic" });
for (const [source, target] of [["plugin.json", "plugin.json"], ["CAPABILITIES.md", "CAPABILITIES.md"], ["index.html", "index.html"], ["src/backend.mjs", "backend.mjs"], ["LICENSE", "LICENSE"]]) await copyFile(source, "dist/" + target);
`,
    "CAPABILITIES.md": `# ${title.replace(/[\r\n]/g, " ")}

统计调用方明确提供的文字，不读取作品内容。

| 功能 | 入口 | 权限 |
| --- | --- | --- |
| 输入文字与查看结果 | 视图 main | 无作品数据权限 |
| 统计 Unicode 字符 | 动作 count，参数 text | read，仅显式输入 |

机器合同以本包 plugin.json 的 contributions 为准；安装在河图并获权后，经稳定 hetu.plugin_access.capabilities/invoke 发现和调用，无需在Codex安装同名插件。独立插件运行时也提供 capabilities 与 MCP。

开发：npm install → npm run build → plugin-dev.mjs validate <本工程绝对路径>/dist。安装、启停和卸载由宿主公共机器入口执行，作品授权另行核验。

变更功能时同步更新本文件与 plugin.json；功能验证记录由本插件维护，不复制到宿主功能清单。
`,
    "index.html": '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>创作插件</title><div id="root"></div><script src="view.js"></script></html>\n',
    "src/backend.mjs": 'export function apply() {}\nexport function invoke(action, input) { if (action !== "count") throw new Error("未知动作"); return { characters: Array.from(input.text).length }; }\n',
    "src/view.tsx": `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { PluginBridge } from "./sdk.ts";
declare global { interface Window { hetu?: PluginBridge & { invoke(action: string, input: unknown): Promise<unknown> }; } }
function View() {
  const [text, setText] = useState(""), [result, setResult] = useState(""), [busy, setBusy] = useState(false);
  async function count() {
    setBusy(true);
    try {
      if (!window.hetu) throw new Error("请在河图中安装并打开此插件。");
      const value = await window.hetu.invoke("count", { text }) as { characters: number };
      setResult(value.characters + " 个字符");
    } catch (error) { setResult((error as Error).message); }
    finally { setBusy(false); }
  }
  return <main><h1>{${JSON.stringify(title)}}</h1><label>输入文字<textarea value={text} maxLength={10000} onChange={event => setText(event.target.value)}/></label><button disabled={busy} onClick={() => void count()}>统计</button><p role="status">{result}</p></main>;
}
createRoot(document.getElementById("root")!).render(<View/>);
`,
    "src/sdk.ts": sdk,
    "LICENSE": license,
    ".gitignore": "node_modules/\ndist/\n",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content, { flag: "wx" });
  return { directory, plugin_id: id, status: "created", next_steps: ["npm install", "npm run build", "validate <directory>/dist"], permissions: [] };
}
