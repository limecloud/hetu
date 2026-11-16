import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyRelease(root, tag) {
  const json = async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"));
  const source = await json("package.json");
  const version = source.version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || (tag && tag !== "v" + version))
    throw new Error("发行标签与源码版本不一致。");
  const lock = await json("package-lock.json");
  for (const directory of ["", ...source.workspaces]) {
    const pkg = directory ? await json(directory + "/package.json") : source;
    if (pkg.version !== version || lock.packages[directory]?.version !== version)
      throw new Error("Workspace 或 npm 锁文件版本不一致：" + (directory || "根目录"));
    for (const [name, value] of Object.entries(pkg.dependencies ?? {}))
      if (name.startsWith("@hetu/") && value !== version)
        throw new Error("内部依赖版本不一致：" + name);
  }
  if (lock.version !== version) throw new Error("npm 根锁文件版本不一致。");
  const cargo = await readFile(path.join(root, "Cargo.toml"), "utf8");
  if (cargo.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1] !== version)
    throw new Error("Cargo workspace 版本不一致。");
  const cargoLock = (await readFile(path.join(root, "Cargo.lock"), "utf8")).replace(/\r\n/g, "\n");
  for (const name of ["hetu-core", "hetu-cli", "hetu-mcp", "hetu-app-server", "hetu-plugin-cli"])
    if (!cargoLock.includes(`name = "${name}"\nversion = "${version}"`))
      throw new Error("Cargo 锁文件版本不一致：" + name);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const tag = process.env.GITHUB_REF?.startsWith("refs/tags/") ? process.env.GITHUB_REF_NAME : undefined;
  console.log("发行版本校验通过：v" + await verifyRelease(root, tag));
}
