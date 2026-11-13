import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("src/app.ts", root))],
  bundle: true,
  write: false,
  minify: true,
  legalComments: "inline",
  format: "iife",
  target: "es2022",
  metafile: true,
});
const css = await readFile(new URL("src/app.css", root), "utf8");
const notices = await readFile(new URL("THIRD-PARTY-NOTICES.txt", root), "utf8");
const script = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script");
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const html = `<!doctype html><!-- Third-party notices\n${notices.replaceAll("--", "- -")}\n--><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>河图洛书 参考方案 / Hetu Luoshu References</title><style>${css}</style></head><body><main id="app" aria-busy="true"><p role="status">正在连接任务… / Connecting to task…</p></main><script>${script}</script></body></html>\n`;
const destination = new URL("../mcp/resources/task-view.html", root);
const manifestPath = new URL("../mcp/resources/task-view.manifest.json", root);
const sourceHashes = {};
for (const source of ["src/app.ts", "src/app.css", "scripts/build.mjs", "package.json", "THIRD-PARTY-NOTICES.txt"]) {
  sourceHashes[source] = createHash("sha256").update(await readFile(new URL(source, root))).digest("hex");
}
const manifest = JSON.stringify({
  schema_version: "1.0.0",
  resource_uri: "ui://hetu/task-view/1",
  mime_type: "text/html;profile=mcp-app",
  sdk: "@modelcontextprotocol/ext-apps@2.0.4",
  sha256: createHash("sha256").update(html).digest("hex"),
  size_bytes: Buffer.byteLength(html),
  source_sha256: sourceHashes,
  inputs: Object.keys(bundle.metafile.inputs).sort(),
}, null, 2) + "\n";
const localOutputs = new Map();
for (const [source, name, platform] of [["src/local/host.ts", "host.js", "browser"], ["src/local/server.ts", "server.mjs", "node"]]) {
  const output = await build({ entryPoints: [fileURLToPath(new URL(source, root))], bundle: true, write: false, minify: true, legalComments: "inline", format: "esm", platform, target: platform === "node" ? "node24" : "es2022" });
  localOutputs.set(name, output.outputFiles[0].text);
}
localOutputs.set("index.html", await readFile(new URL("src/local/index.html", root), "utf8"));
localOutputs.set("task-view.html", html);
localOutputs.set("THIRD-PARTY-NOTICES.txt", notices);
const localSources = {};
for (const source of ["src/local/host.ts", "src/local/server.ts", "src/local/index.html"]) localSources[source] = createHash("sha256").update(await readFile(new URL(source, root))).digest("hex");
localOutputs.set("manifest.json", JSON.stringify({ schema_version: "1.0.0", ipc_revision: "1", source_sha256: { ...sourceHashes, ...localSources }, files: Object.fromEntries([...localOutputs].map(([name, text]) => [name, createHash("sha256").update(text).digest("hex")])) }, null, 2) + "\n");
if (process.argv.includes("--check")) {
  if (await readFile(destination, "utf8") !== html || await readFile(manifestPath, "utf8") !== manifest) {
    throw new Error("任务面板产物与源码不一致，请执行 npm run build:task-view。");
  }
  for (const [name, text] of localOutputs) if (await readFile(new URL(`resources/local/${name}`, root), "utf8") !== text) throw new Error(`本地任务页面产物与源码不一致：${name}`);
} else {
  await mkdir(new URL("../mcp/resources/", root), { recursive: true });
  await writeFile(destination, html);
  await writeFile(manifestPath, manifest);
  await mkdir(new URL("resources/local/", root), { recursive: true });
  for (const [name, text] of localOutputs) await writeFile(new URL(`resources/local/${name}`, root), text);
}
console.log(`MCP Apps resource: ${Buffer.byteLength(html)} bytes ${process.argv.includes("--check") ? "verified" : "built"}`);
