// Windows、Linux 在对应系统构建；保留随包 CLI/MCP，不要求用户安装 Node 或 Rust。
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, access, mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const platform = { win32: "windows", linux: "linux" }[process.platform];
if (!platform || process.arch !== "x64") throw new Error("仅支持目标 Windows x64 或 Linux x64。");
function run(command, args, cwd = root, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", data => { process.stdout.write(data); output += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} 退出码 ${code}`)));
  });
}
const sha256 = async file => createHash("sha256").update(await readFile(file)).digest("hex");
await run(process.execPath, ["tools/verify-release.mjs"]);
const gitSha = (await run("git", ["rev-parse", "HEAD"])).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== gitSha) throw new Error("源码与触发修订不一致。");
const output = path.join(root, "dist/electron", `${platform}-x64`);
try { await access(output); throw new Error("发行目录已存在，请保留原结果并使用干净 checkout。"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const assembled = JSON.parse((await run(process.execPath, ["apps/desktop/scripts/package.mjs", "--release", "--distribution"])).split(/\r?\n/).at(-1));
const manifest = JSON.parse(await readFile(assembled.manifest, "utf8"));
const directory = assembled.package_directory;
let executable = path.join(directory, process.platform === "win32" ? "Hetu.exe" : "Hetu");
const bin = path.join(directory, "resources/bin");
const suffix = process.platform === "win32" ? ".exe" : "";
if (await run(path.join(bin, "hetu" + suffix), ["--version"]) !== "hetu " + manifest.version) throw new Error("随包 CLI 版本不一致。");
await run(path.join(bin, "hetu-mcp" + suffix), ["--help"]);
await run(path.join(bin, "node" + suffix), ["--permission", "--input-type=module", "-e",
  'if(process.arch!=="x64"||Number(process.versions.node.split(".")[0])!==25||!process.permission||process.permission.has("net"))process.exit(2)']);
await mkdir(output, { recursive: true });
const basename = `Hetu-${manifest.version}-${platform}-x64`;
const archive = path.join(output, basename + (platform === "windows" ? ".zip" : ".tar.gz"));
if (platform === "windows") {
  // PowerShell 从环境读取原路径，避免空格、非 ASCII 或单引号被解释为代码。
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:HETU_ARCHIVE_SOURCE -DestinationPath $env:HETU_ARCHIVE_TARGET -CompressionLevel Optimal"], directory,
    { HETU_ARCHIVE_SOURCE: directory, HETU_ARCHIVE_TARGET: archive });
} else {
  await run("tar", ["-czf", archive, "-C", path.dirname(directory), path.basename(directory)]);
  const libraries = await run("ldd", [path.join(bin, "hetu")]);
  if (libraries.includes("not found")) throw new Error("Linux 包存在缺失的动态库。");
}
const manifestName = `release-manifest-${platform}-x64.json`;
const manifestPath = path.join(output, manifestName);
Object.assign(manifest, { git_sha: gitSha, platform, architecture: "x64", signing: "unsigned",
  notarization_status: "not-applicable", files: { [path.basename(archive)]: await sha256(archive) } });
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(output, `SHA256SUMS-${platform}-x64`),
  `${await sha256(archive)}  ${path.basename(archive)}\n${await sha256(manifestPath)}  ${manifestName}\n`);
// 后续旅程从最终下载包解压的副本启动，覆盖遗漏文件、权限及归档损坏。
const extracted = await mkdtemp(path.join(os.tmpdir(), "hetu-release-check-"));
if (platform === "windows") {
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:HETU_ARCHIVE_SOURCE -DestinationPath $env:HETU_ARCHIVE_TARGET"], root,
    { HETU_ARCHIVE_SOURCE: archive, HETU_ARCHIVE_TARGET: extracted });
} else {
  await run("tar", ["-xzf", archive, "-C", extracted]);
}
executable = path.join(extracted, path.basename(directory), process.platform === "win32" ? "Hetu.exe" : "Hetu");
if (process.env.GITHUB_OUTPUT) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_OUTPUT, `executable=${executable}\nmanifest=${manifestPath}\n`);
}
process.stdout.write(JSON.stringify({ executable, manifest: manifestPath, output }) + "\n");
