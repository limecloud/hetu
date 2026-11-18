import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "./verify-release.mjs";

const packageName = "@limecloud/hetu";
const registry = "https://registry.npmjs.org";

export function verifyNpmRuntime(release, manifest, version, sha) {
  if (release.isDraft !== false || release.isPrerelease !== false || release.tagName !== `v${version}`)
    throw new Error("npm 只能发布已公开的对应正式 Release。");
  for (const name of [`Hetu-${version}-macos-arm64.zip`, "SHA256SUMS", "release-manifest.json"])
    if (!release.assets?.some(asset => asset.name === name))
      throw new Error("正式运行时附件不完整：" + name);
  if (manifest.kind !== "electron-release-package" || manifest.version !== version ||
      manifest.git_sha !== sha || manifest.platform !== "macos" || manifest.architecture !== "arm64" ||
      manifest.signing !== "developer-id" || manifest.notarization_status !== "Accepted")
    throw new Error("npm 运行时的源码、版本、平台或签名公证状态不一致。");
}

export function publicationAction(existing, packed) {
  if (packed.name !== packageName || !/^\d+\.\d+\.\d+$/.test(packed.version) ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packed.integrity ?? ""))
    throw new Error("npm 打包身份或摘要无效。");
  if (existing === null) return "publish";
  if (existing.name !== packed.name || existing.version !== packed.version ||
      existing.dist?.integrity !== packed.integrity)
    throw new Error("npm 已有版本与固定包不同，拒绝覆盖或冒充发布成功。");
  return "already_published";
}

async function registryVersion(version) {
  const response = await fetch(`${registry}/${encodeURIComponent(packageName)}/${version}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("npm 回读失败：HTTP " + response.status);
  return response.json();
}

async function publish() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const tag = process.env.GITHUB_REF_NAME;
  const sha = process.env.GITHUB_SHA;
  if (process.env.GITHUB_REPOSITORY !== "limecloud/hetu" ||
      process.env.GITHUB_REF !== `refs/tags/${tag}` || !/^v\d+\.\d+\.\d+$/.test(tag ?? "") ||
      !/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("npm 发布必须来自官方仓库的固定发行标签。");
  const version = await verifyRelease(root, tag);
  const run = (program, args) => execFileSync(program, args, { cwd: root, encoding: "utf8" });
  if (run("git", ["rev-parse", "HEAD"]).trim() !== sha ||
      run("gh", ["api", `repos/limecloud/hetu/commits/${tag}`, "--jq", ".sha"]).trim() !== sha)
    throw new Error("发行标签或检出源码已变化。");
  const release = JSON.parse(run("gh", ["release", "view", tag, "--repo", "limecloud/hetu",
    "--json", "isDraft,isPrerelease,tagName,assets"]));
  const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "hetu-npm-"));
  run("gh", ["release", "download", tag, "--repo", "limecloud/hetu", "--pattern",
    "release-manifest.json", "--dir", directory]);
  const manifest = JSON.parse(await readFile(path.join(directory, "release-manifest.json"), "utf8"));
  verifyNpmRuntime(release, manifest, version, sha);
  const [packed] = JSON.parse(run("npm", ["pack", "--workspace", packageName,
    "--pack-destination", directory, "--json"]));
  if (packed.version !== version || path.basename(packed.filename) !== packed.filename)
    throw new Error("npm 固定包与发行版本不一致。");
  const action = publicationAction(await registryVersion(version), packed);
  if (action === "publish") {
    execFileSync("npm", ["publish", path.join(directory, packed.filename), "--access", "public",
      "--tag", "latest", "--provenance", "--registry", registry], { cwd: root, stdio: "inherit" });
  }
  let verified = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await registryVersion(version);
    if (existing !== null) {
      publicationAction(existing, packed);
      verified = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!verified) throw new Error("npm 发布结果尚未可读；重跑同一任务，不能改版本重复发布。");
  const latest = await registryVersion("latest");
  if (latest?.version !== version) throw new Error("npm latest 未指向本次版本，未自动改动其他版本标签。");
  console.log(JSON.stringify({ package: packageName, version, action, integrity: packed.integrity,
    git_sha: sha, registry, latest: version }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await publish();
