import {buildWorkbench} from "./build-workbench.mjs";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { verifyBaseline } from "./baseline.mjs";
const baseline = await verifyBaseline(fileURLToPath(new URL("../../../", import.meta.url)));
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";
import {preparePtyHelpers} from "./pty-helper.mjs";
import {buildComputerHelper} from "./computer-helper.mjs";
import { createHash } from "node:crypto";
const buildMain = (file, out) =>
  build({
    entryPoints: ["src/main/" + file + ".ts"],
    outfile: "dist/" + out + ".cjs",
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["electron", "node-pty"],
    sourcemap: true,
  });
await preparePtyHelpers(path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json")));
await mkdir("dist/renderer", { recursive: true });
await buildComputerHelper(process.cwd());
await writeFile("dist/baseline.json", JSON.stringify(baseline, null, 2) + "\n");
await buildMain("main", "main");
await buildMain("shell-preload", "shell-preload");
await buildMain("plugin-preload", "plugin-preload");
await build({entryPoints:["src/main/agent/mcp-relay.mjs"],outfile:"dist/agent-mcp-relay.mjs",bundle:true,platform:"node",target:"node24",format:"esm"});
await copyFile("src/main/agent/engine-guard.mjs","dist/agent-engine-guard.mjs");
await build({entryPoints:["src/main/agent/agent-machine-service.ts"],outfile:"dist/agent-machine-service.mjs",bundle:true,platform:"node",target:"node24",format:"esm",external:["node-pty","ws"]});
await buildWorkbench();
await copyFile(
  "../../packages/plugin-host/src/worker.mjs",
  "dist/plugin-worker.mjs",
);
await build({
  entryPoints: ["src/renderer/index.tsx"],
  outfile: "dist/renderer/app.js",
  bundle: true,
  platform: "browser",
  target: "chrome140",
  format: "iife",
  sourcemap: true,
});
await copyFile("src/renderer/index.html", "dist/renderer/index.html");
const sharedStyle = await build({ entryPoints: ["src/renderer/style.css"], bundle: true, write: false });
await writeFile("dist/renderer/style.css", sharedStyle.outputFiles[0].text);
const radixCSS = await readFile("../../assets/styles/radix-workbench.css", "utf8");
await writeFile("dist/renderer/radix-workbench.css", radixCSS);
await copyFile("../../assets/brand/app-icon-1024.png", "dist/renderer/app-icon.png");
for (const name of ["cover-river-jade", "cover-cloud-rose", "cover-stars-ink"]) {
  await copyFile(`../../assets/illustrations/library/${name}.jpg`, `dist/renderer/${name}.jpg`);
}
for (const name of ["river-dawn-v1", "river-night-v1"]) {
  await copyFile(`../../assets/illustrations/workbench/${name}.webp`, `dist/renderer/${name}.webp`);
}
const taskView = await readFile("../mcp/resources/task-view.html");
const taskManifest = JSON.parse(
  await readFile("../mcp/resources/task-view.manifest.json", "utf8"),
);
if (
  createHash("sha256").update(taskView).digest("hex") !== taskManifest.sha256 ||
  taskView.length !== taskManifest.size_bytes
)
  throw new Error("任务审阅资源摘要校验失败，请先构建共享 MCP Apps 面板。");
await writeFile("dist/renderer/task-view.html", taskView);
for (const name of ["relationships", "timeline"]) {
  const source = "../../plugins/" + name;
  await mkdir(source + "/dist", { recursive: true });
  await copyFile(source + "/plugin.json", source + "/dist/plugin.json");
  await copyFile(source + "/CAPABILITIES.md", source + "/dist/CAPABILITIES.md");
  await build({
    entryPoints: [source + "/src/view.tsx"],
    outfile: source + "/dist/view.js",
    bundle: true,
    platform: "browser",
    target: "chrome140",
    format: "iife",
    jsx: "automatic",
  });
  await writeFile(
    source + "/dist/index.html",
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>${radixCSS}</style><div id="root"></div><script src="view.js"></script></html>`,
  );
  try {
    await copyFile(source + "/src/backend.mjs", source + "/dist/backend.mjs");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
await build({
  entryPoints: ["../../packages/plugin-host/src/runtime-cli.ts"],
  outfile: "dist/plugin-runtime.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
await build({
  entryPoints: ["../../packages/plugin-host/src/dev-cli.ts"],
  outfile: "dist/plugin-dev.mjs", bundle: true, platform: "node", target: "node24", format: "esm",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
await copyFile("../../packages/plugin-sdk/src/index.ts", "dist/developer-sdk.ts");
await copyFile("../../LICENSE", "dist/developer-LICENSE.txt");

await build({
  entryPoints: ["../../packages/plugin-host/src/manager-cli.ts"],
  outfile: "dist/plugin-manager.mjs", bundle: true, platform: "node", target: "node24", format: "esm",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
