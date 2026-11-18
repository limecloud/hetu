import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { PluginInstallations } from "../src/installations.ts";
import { PluginPackage } from "../src/package.ts";

test("管理管道跨UTF-8字节分块保留中文大清单、能力摘要与调用结果", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-manager-stream-"));
  const source = path.join(folder, "package");
  await mkdir(source);
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({
    manifest_version: 1, host_api: "1", id: "org.test.stream", version: "1.0.0",
    license: "MIT", dependencies: [], display: { "zh-CN": "中文管道", en: "Stream" },
    description: { "zh-CN": "隔离回归", en: "Isolated regression" },
    contributions: { views: [], data: [], actions: [] },
  }));
  const pkg = await PluginPackage.inspect(source);
  const store = new PluginInstallations(path.join(folder, "state"));
  await store.apply({ action: "install", package_directory: source, package_sha256: pkg.sha256,
    expected_sha256: (await store.read()).sha256, operation_key: "install", client_adapter: "codex",
    authorization_note: "隔离中文管道回归测试" }, async () => {});
  const manager = path.join(folder, "plugin-manager.mjs");
  await build({ entryPoints: [path.resolve(import.meta.dirname, "../src/manager-cli.ts")],
    outfile: manager, bundle: true, platform: "node", format: "esm", target: "node25",
    banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' } });
  const capabilities = { description: "中文🌿".repeat(20000), actions: [{ id: "read", title: "读取固定作品" }] };
  const expected = createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
  // 确定性拆开首个汉字，并让后续输出越过普通管道缓冲区。
  await writeFile(path.join(folder, "plugin-runtime.mjs"), `
import {createHash} from 'node:crypto';
const cap=${JSON.stringify(capabilities)};
let value=cap;
if(process.argv.includes('dispatch')) {
  let input=''; for await(const chunk of process.stdin) input+=chunk;
  const request=JSON.parse(input);
  if(request.capabilities_sha256!==createHash('sha256').update(JSON.stringify(cap)).digest('hex')) throw Error('摘要变化');
  value={result:'中文调用结果🌿'};
}
const bytes=Buffer.from(JSON.stringify(value));
const first=bytes.findIndex(b=>b>=128);
process.stdout.write(bytes.subarray(0,first+1));
await new Promise(resolve=>setTimeout(resolve,20));
for(let offset=first+1;offset<bytes.length;offset+=4095) {
  process.stdout.write(bytes.subarray(offset,offset+4095));
  await new Promise(resolve=>setTimeout(resolve,1));
}
`);
  const request = (action: string, extra = {}) => {
    const child = spawnSync(process.execPath, [manager, "--directory", store.directory, "--core-cli", "unused"], {
      input: JSON.stringify({ action, input: { plugin_id: pkg.manifest.id, package_sha256: pkg.sha256,
        workspace_directory: folder, work_ref: {}, management_binding: {}, ...extra } }),
      encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout).data;
  };
  const discovered = request("hetu.plugins.capabilities");
  assert.equal(discovered.description, capabilities.description);
  assert.equal(discovered.capabilities_sha256, expected);
  assert.deepEqual(request("hetu.plugins.invoke", { capabilities_sha256: expected, action: "read", arguments: {} }),
    { result: "中文调用结果🌿" });
});
