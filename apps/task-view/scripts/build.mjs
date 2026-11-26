import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const bundle = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: [fileURLToPath(new URL("src/app.ts", root))],
  bundle: true,
  write: false,
  minify: true,
  legalComments: "inline",
  format: "iife",
  target: "es2022",
  metafile: true,
});
const radixSource = "../../assets/styles/radix-workbench.css";
const radixCSS = await readFile(new URL(radixSource, root), "utf8");
const readingSource = "../../packages/workbench-ui/src/reading.css";
const reviewSource = "../../packages/workbench-ui/src/manuscript-review.css";
const canonSource = "../../packages/workbench-ui/src/canon-details.css";
const imageRegionSource = "../../packages/workbench-ui/src/image-region.css";
const feedbackHistorySource = "../../packages/workbench-ui/src/task-feedback-history.css";
const reviewCSS = await readFile(new URL(reviewSource, root), "utf8");
const css = reviewCSS + radixCSS + await readFile(new URL(readingSource, root), "utf8") + await readFile(new URL(canonSource,root),"utf8") + await readFile(new URL(imageRegionSource,root),"utf8") + await readFile(new URL(feedbackHistorySource,root),"utf8") + await readFile(new URL("src/app.css", root), "utf8");
const notices = await readFile(new URL("THIRD-PARTY-NOTICES.txt", root), "utf8");
const script = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script");
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const taskCSP = csp.replace("frame-src 'none';", "frame-src 'none'; worker-src blob:;");
const html = `<!doctype html><!-- Third-party notices\n${notices.replaceAll("--", "- -")}\n--><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${taskCSP}"><title>河图洛书 参考方案 / Hetu Luoshu References</title><style>${css}</style></head><body><main id="app" aria-busy="true"><p role="status">正在连接任务… / Connecting to task…</p></main><script>${script}</script></body></html>\n`;
const destination = new URL("../mcp/resources/task-view.html", root);
const manifestPath = new URL("../mcp/resources/task-view.manifest.json", root);
const sourceHashes = {};
for (const source of [...new Set([...Object.keys(bundle.metafile.inputs).filter(path => !path.includes("node_modules/")), "src/app.css", radixSource, readingSource, reviewSource, canonSource, imageRegionSource, feedbackHistorySource, "scripts/build.mjs", "package.json", "THIRD-PARTY-NOTICES.txt"])]) {
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
const operationBundle = await build({ absWorkingDir: fileURLToPath(root), entryPoints: [fileURLToPath(new URL("src/operation.ts", root))], bundle: true, write: false, minify: true, legalComments: "inline", format: "iife", target: "es2022", metafile: true });
const operationCSS = radixCSS + await readFile(new URL("src/operation.css", root), "utf8");
const operationHTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>河图洛书 操作方案 / Hetu Luoshu Operation</title><style>${operationCSS}</style></head><body><main id="app"></main><script>${operationBundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>\n`;
const operationPath = new URL("../mcp/resources/operation-view.html", root);
const operationManifestPath = new URL("../mcp/resources/operation-view.manifest.json", root);
const operationHashes = {};
for (const source of [...new Set([...Object.keys(operationBundle.metafile.inputs).filter(path => !path.includes("node_modules/")), "src/operation.css", radixSource, "scripts/build.mjs", "package.json", "THIRD-PARTY-NOTICES.txt"])]) operationHashes[source] = createHash("sha256").update(await readFile(new URL(source, root))).digest("hex");
const operationManifest = JSON.stringify({ schema_version: "1.0.0", resource_uri: "ui://hetu/operation-view/1", mime_type: "text/html;profile=mcp-app", sdk: "@modelcontextprotocol/ext-apps@2.0.4", sha256: createHash("sha256").update(operationHTML).digest("hex"), size_bytes: Buffer.byteLength(operationHTML), source_sha256: operationHashes }, null, 2) + "\n";
const workbenchBundle = await build({ loader: {".png":"dataurl",".jpg":"dataurl",".webp":"dataurl"}, absWorkingDir: fileURLToPath(root), entryPoints: [fileURLToPath(new URL("src/shared-workbench.ts", root))], outfile:"workbench.js", bundle: true, write: false, minify: true, legalComments: "inline", format: "esm", target: "es2022", metafile: true });
const sharedWorkbenchCSS = await readFile(new URL("../../packages/workbench-ui/src/workbench.css", root), "utf8");
const desktopStyle = await build({absWorkingDir:fileURLToPath(root),entryPoints:["../desktop/src/renderer/style.css"],bundle:true,write:false,metafile:true});
const workbenchCSS = radixCSS + desktopStyle.outputFiles[0].text + (workbenchBundle.outputFiles.find(file=>file.path.endsWith(".css"))?.text ?? "");
const legacyCSS=radixCSS + sharedWorkbenchCSS + "\n.task-review {\n" + await readFile(new URL("src/app.css",root),"utf8") + "\n}\n" + await readFile(new URL("src/workbench.css",root),"utf8");
const workbenchCSP=csp.replace("frame-src 'none';","frame-src blob: data:; worker-src blob:;");
const workbenchHTML = `<!doctype html><!-- Third-party notices\n${notices.replaceAll("--", "- -")}\n--><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${workbenchCSP}"><title>河图洛书</title><style>${workbenchCSS}</style><style id="legacy-style" media="not all">${legacyCSS}</style></head><body><div id="root"></div><div id="app" class="hetu-workbench" aria-busy="true"></div><script type="module">${workbenchBundle.outputFiles.find(file=>file.path.endsWith(".js")).text.replaceAll("</script", "<\\/script")}</script></body></html>\n`;
const workbenchHashes = {};
for (const source of Object.keys(desktopStyle.metafile.inputs)) workbenchHashes[source] = createHash("sha256").update(await readFile(new URL(source,root))).digest("hex");
for (const source of [...new Set([...Object.keys(workbenchBundle.metafile.inputs).filter(path => !path.includes("node_modules/")), "src/app.css", "src/workbench.css", "../../packages/workbench-ui/src/workbench.css", radixSource, "scripts/build.mjs", "package.json", "THIRD-PARTY-NOTICES.txt"])]) workbenchHashes[source] = createHash("sha256").update(await readFile(new URL(source, root))).digest("hex");
const workbenchPath = new URL("../mcp/resources/workbench.html", root);
const workbenchManifestPath = new URL("../mcp/resources/workbench.manifest.json", root);
const workbenchDigest = createHash("sha256").update(workbenchHTML).digest("hex");
const workbenchManifest = JSON.stringify({ schema_version: "1.0.0", resource_uri: `ui://hetu/workbench/2/${workbenchDigest}`, mime_type: "text/html;profile=mcp-app", sdk: "@modelcontextprotocol/ext-apps@2.0.4", sha256: workbenchDigest, size_bytes: Buffer.byteLength(workbenchHTML), source_sha256: workbenchHashes }, null, 2) + "\n";
const localOutputs = new Map();
for (const [source, name, platform] of [["src/local/host.ts", "host.js", "browser"], ["src/local/server.ts", "server.mjs", "node"]]) {
  const output = await build({ absWorkingDir: fileURLToPath(root), entryPoints: [fileURLToPath(new URL(source, root))], bundle: true, write: false, minify: true, legalComments: "inline", format: "esm", platform, target: platform === "node" ? "node24" : "es2022" });
  localOutputs.set(name, output.outputFiles[0].text);
}
localOutputs.set("index.html", (await readFile(new URL("src/local/index.html", root), "utf8")).replace("/* shared-radix */", radixCSS));
localOutputs.set("task-view.html", html);
localOutputs.set("THIRD-PARTY-NOTICES.txt", notices);
const localSources = {};
for (const source of ["src/local/host.ts", "src/local/server.ts", "src/local/index.html"]) localSources[source] = createHash("sha256").update(await readFile(new URL(source, root))).digest("hex");
localOutputs.set("manifest.json", JSON.stringify({ schema_version: "1.0.0", ipc_revision: "1", source_sha256: { ...sourceHashes, ...localSources }, files: Object.fromEntries([...localOutputs].map(([name, text]) => [name, createHash("sha256").update(text).digest("hex")])) }, null, 2) + "\n");
if (process.argv.includes("--check")) {
  if (await readFile(workbenchPath, "utf8") !== workbenchHTML || await readFile(workbenchManifestPath, "utf8") !== workbenchManifest) throw new Error("工作台产物与源码不一致。");
  if (await readFile(operationPath, "utf8") !== operationHTML || await readFile(operationManifestPath, "utf8") !== operationManifest) throw new Error("操作面板产物与源码不一致。");
  if (await readFile(destination, "utf8") !== html || await readFile(manifestPath, "utf8") !== manifest) {
    throw new Error("任务面板产物与源码不一致，请执行 npm run build:task-view。");
  }
  for (const [name, text] of localOutputs) if (await readFile(new URL(`resources/local/${name}`, root), "utf8") !== text) throw new Error(`本地任务页面产物与源码不一致：${name}`);
} else {
  await mkdir(new URL("../mcp/resources/", root), { recursive: true });
  await writeFile(workbenchPath, workbenchHTML);
  await writeFile(workbenchManifestPath, workbenchManifest);
  await writeFile(destination, html);
  await writeFile(manifestPath, manifest);
  await writeFile(operationPath, operationHTML);
  await writeFile(operationManifestPath, operationManifest);
  await mkdir(new URL("resources/local/", root), { recursive: true });
  for (const [name, text] of localOutputs) await writeFile(new URL(`resources/local/${name}`, root), text);
}
console.log(`MCP Apps resource: ${Buffer.byteLength(html)} bytes ${process.argv.includes("--check") ? "verified" : "built"}`);
