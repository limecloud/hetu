import assert from "node:assert/strict";
import { test } from "node:test";
import { publicationAction, verifyNpmRuntime } from "../../tools/publish-npm.mjs";

test("npm 发布拒绝未公开、不完整或其他源码的运行时", () => {
  const version = "0.12.0", sha = "a".repeat(40);
  const release = { isDraft: false, isPrerelease: false, tagName: `v${version}`,
    assets: [`Hetu-${version}-macos-arm64.zip`, "SHA256SUMS", "release-manifest.json"].map(name => ({ name })) };
  const manifest = { kind: "electron-release-package", version, git_sha: sha, platform: "macos",
    architecture: "arm64", signing: "developer-id", notarization_status: "Accepted" };
  verifyNpmRuntime(release, manifest, version, sha);
  for (const change of [{ isDraft: true }, { isPrerelease: true }, { tagName: "v0.11.11" }, { assets: [] }])
    assert.throws(() => verifyNpmRuntime({ ...release, ...change }, manifest, version, sha));
  for (const change of [{ kind: "electron-development-package" }, { version: "0.11.11" },
    { git_sha: "b".repeat(40) }, { platform: "linux" }, { architecture: "x64" },
    { signing: "ad-hoc" }, { notarization_status: "Rejected" }])
    assert.throws(() => verifyNpmRuntime(release, { ...manifest, ...change }, version, sha));
});

test("npm 丢回执后按原包摘要恢复，拒绝已有不同版本字节", () => {
  const packed = { name: "@limecloud/hetu", version: "0.12.0", integrity: "sha512-YWJjZA==" };
  const existing = { name: packed.name, version: packed.version, dist: { integrity: packed.integrity } };
  assert.equal(publicationAction(null, packed), "publish");
  assert.equal(publicationAction(existing, packed), "already_published");
  for (const changed of [{ ...existing, name: "@other/hetu" }, { ...existing, version: "0.11.11" },
    { ...existing, dist: { integrity: "sha512-ZWZn" } }, { ...existing, dist: {} }])
    assert.throws(() => publicationAction(changed, packed), /已有版本/);
  assert.throws(() => publicationAction(null, { ...packed, name: "other" }), /身份/);
  assert.throws(() => publicationAction(null, { ...packed, integrity: "" }), /摘要/);
});
