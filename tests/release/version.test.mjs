import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyRelease } from "../../tools/verify-release.mjs";

test("发行拒绝标签、子包、内部依赖及锁文件版本漂移", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hetu-release-version-"));
  const version = "0.8.0";
  const json = (name, value) => writeFile(path.join(root, name), JSON.stringify(value));
  const cargoLock = ["hetu-core", "hetu-cli", "hetu-mcp", "hetu-app-server", "hetu-plugin-cli"]
    .map(name => `[[package]]\nname = "${name}"\nversion = "${version}"\n`).join("\n");
  const lock = { version, packages: { "": { version }, desktop: { version } } };
  try {
    await mkdir(path.join(root, "desktop"));
    await json("package.json", { version, workspaces: ["desktop"] });
    await json("desktop/package.json", { version });
    await json("package-lock.json", lock);
    await writeFile(path.join(root, "Cargo.toml"), `[workspace.package]\nversion = "${version}"\n`);
    await writeFile(path.join(root, "Cargo.lock"), cargoLock);
    assert.equal(await verifyRelease(root, "v0.8.0"), version);
    await assert.rejects(verifyRelease(root, "v0.7.0"), /标签/);
    await json("desktop/package.json", { version: "0.7.0" });
    await assert.rejects(verifyRelease(root), /Workspace/);
    await json("desktop/package.json", { version, dependencies: { "@hetu/plugin-sdk": "0.7.0" } });
    await assert.rejects(verifyRelease(root), /内部依赖/);
    await json("desktop/package.json", { version });
    await json("package-lock.json", { ...lock, packages: { ...lock.packages, desktop: { version: "0.7.0" } } });
    await assert.rejects(verifyRelease(root), /锁文件/);
    await json("package-lock.json", lock);
    await writeFile(path.join(root, "Cargo.lock"), cargoLock.replace('version = "0.8.0"', 'version = "0.7.0"'));
    await assert.rejects(verifyRelease(root), /Cargo 锁文件/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
