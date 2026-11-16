import { packager } from "@electron/packager";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  lstat,
  writeFile,
  copyFile,
  readlink,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const desktop = path.join(root, "apps/desktop");
const { values } = parseArgs({
  options: {
    node: { type: "string" },
    out: { type: "string" },
    release: { type: "boolean", default: false },
    distribution: { type: "boolean", default: false },
  },
});
if (!["darwin", "win32"].includes(process.platform))
  throw new Error("开发应用只在目标 macOS 或 Windows 系统装配。");
if (values.distribution && (!values.release || process.platform !== "darwin" || process.arch !== "arm64"))
  throw new Error("正式发行仅接受 macOS arm64 与优化构建。");
if (values.distribution && (!process.env.HETU_SIGNING_IDENTITY || !process.env.HETU_SIGNING_KEYCHAIN))
  throw new Error("正式发行必须由发行入口提供临时签名身份与钥匙串。");
const productName = values.distribution ? "Hetu" : "Hetu Luoshu Electron Dev";
const runtime = path.resolve(values.node ?? process.execPath);
const out = path.resolve(
  values.out ?? path.join(root, "output/electron-packages"),
);
await mkdir(out, { recursive: true });
const stage = await mkdtemp(path.join(out, "hetu-dev-"));
const stageApp = path.join(stage, "app"),
  bin = path.join(stage, "bin"),
  licenses = path.join(stage, "licenses");
await Promise.all([mkdir(stageApp), mkdir(bin), mkdir(licenses)]);
function run(command, args, cwd = root, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (capture)
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(command + " 未完成，退出码 " + code)),
    );
  });
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function files(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name, "en"),
  )) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(name)));
    else result.push(name);
  }
  return result;
}
const sourceRoots = [
  "core/src",
  "apps/cli/src",
  "apps/mcp/src",
  "apps/mcp/resources",
  "apps/app-server/src",
  "apps/app-server/examples",
  "apps/plugin-cli/src",
  "apps/desktop/src",
  "apps/desktop/scripts",
  "packages/plugin-host/src",
  "packages/plugin-sdk/src",
  "plugins",
  "contracts",
  "integrations/codex",
];
async function sourceSnapshot() {
  const inputs = [
    "Cargo.toml",
    "Cargo.lock",
    "package.json",
    "package-lock.json",
    "apps/desktop/package.json",
    "apps/desktop/tsconfig.json",
    "packages/plugin-host/package.json",
    "packages/plugin-sdk/package.json",
    "core/Cargo.toml",
    "apps/cli/Cargo.toml",
    "apps/mcp/Cargo.toml",
    "apps/app-server/Cargo.toml",
    "apps/plugin-cli/Cargo.toml",
    "assets/localization/native.json",
    "assets/styles/radix-workbench.css",
    "assets/licenses/radix-colors-MIT.txt",
    "assets/fonts/HetuExportSansSC-Regular.ttf",
    "assets/fonts/OFL-NotoSansSC.txt",
    "assets/fonts/NotoSansSC-source.json",
    "LICENSE",
    "assets/brand/app-icon-1024.png",
    "assets/illustrations/library/cover-river-jade.jpg",
    "assets/illustrations/library/cover-cloud-rose.jpg",
    "assets/illustrations/library/cover-stars-ink.jpg",
    "integrations/catalog.json",
    process.platform === "darwin"
      ? "assets/brand/icons/macos/Hetu.icns"
      : "assets/brand/icons/windows/hetu.ico",
  ];
  for (const directory of sourceRoots)
    for (const name of await files(path.join(root, directory))) {
      if (
        !name
          .split(path.sep)
          .some((part) => ["dist", "node_modules"].includes(part))
      )
        inputs.push(path.relative(root, name));
    }
  const hashes = {};
  for (const input of inputs.sort())
    hashes[input.split(path.sep).join("/")] = digest(
      await readFile(path.join(root, input)),
    );
  return { sha256: digest(JSON.stringify(hashes)), files: hashes };
}
const runtimeInfo = JSON.parse(
  await run(
    runtime,
    [
      "--permission",
      "--input-type=module",
      "-e",
      'if(Number(process.versions.node.split(".")[0])<25||process.versions.electron||!process.permission||process.permission.has("net"))process.exit(2);console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch}))',
    ],
    root,
    true,
  ),
);
if (
  runtimeInfo.platform !== process.platform ||
  runtimeInfo.arch !== process.arch
)
  throw new Error("Node 运行时与当前装配目标不一致。");
const before = await sourceSnapshot();
await run("cargo", [
  "build",
  "--locked",
  "--jobs",
  "2",
  ...(values.release ? ["--release"] : []),
  "-p",
  "hetu-app-server",
  "-p",
  "hetu-cli",
  "-p",
  "hetu-mcp",
  "-p",
  "hetu-plugin-cli",
  "--bins",
]);
await run(
  process.execPath,
  [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
  desktop,
);
await run(process.execPath, [path.join(desktop, "scripts/build.mjs")], desktop);
const metadata = JSON.parse(
  await run(
    "cargo",
    ["metadata", "--locked", "--format-version", "1"],
    root,
    true,
  ),
);
const after = await sourceSnapshot();
if (before.sha256 !== after.sha256)
  throw new Error("构建期间相关源码发生变化，请保留本次产物并重新装配。");
const manifest = JSON.parse(
  await readFile(path.join(desktop, "package.json"), "utf8"),
);
const extension = process.platform === "win32" ? ".exe" : "";
const binaries = {};
for (const name of ["hetu-app-server", "hetu", "hetu-mcp", "hetu-plugin"]) {
  const source = path.join(
    metadata.target_directory,
    values.release ? "release" : "debug",
    name + extension,
  );
  await copyFile(source, path.join(bin, name + extension));
  binaries[name + extension] = digest(await readFile(source));
}
await copyFile(runtime, path.join(bin, "node" + extension));
binaries["node" + extension] = digest(await readFile(runtime));
await cp(path.join(desktop, "dist"), path.join(stageApp, "dist"), {
  recursive: true,
});
const integrations = path.join(stage, "integrations");
await mkdir(integrations);
await copyFile(path.join(root, "integrations/catalog.json"), path.join(integrations, "catalog.json"));
await cp(path.join(root, "integrations/codex"), path.join(integrations, "codex"), { recursive: true });
await writeFile(
  path.join(stageApp, "package.json"),
  JSON.stringify({
    name: values.distribution ? "hetu-electron" : "hetu-electron-dev",
    productName,
    version: manifest.version,
    main: "dist/main.cjs",
    private: true,
  }),
);
await copyFile(
  path.join(root, "LICENSE"),
  path.join(licenses, "Hetu-LICENSE.txt"),
);
await copyFile(
  path.join(root, "assets/fonts/OFL-NotoSansSC.txt"),
  path.join(licenses, "OFL-NotoSansSC.txt"),
);
await copyFile(
  path.join(root, "assets/fonts/NotoSansSC-source.json"),
  path.join(licenses, "NotoSansSC-source.json"),
);
await copyFile(
  path.join(root, "assets/licenses/radix-colors-MIT.txt"),
  path.join(licenses, "Radix-Colors-MIT.txt"),
);
let runtimeLicense;
for (const candidate of [
  path.join(path.dirname(runtime), "LICENSE"),
  path.join(path.dirname(runtime), "../LICENSE"),
]) {
  try {
    if ((await lstat(candidate)).isFile()) {
      runtimeLicense = candidate;
      break;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (!runtimeLicense) throw new Error("独立 Node 运行时缺少随包 LICENSE 文件。");
await copyFile(runtimeLicense, path.join(licenses, "Node-LICENSE.txt"));
for (const name of ["LICENSE", "LICENSES.chromium.html"])
  await copyFile(
    path.join(root, "node_modules/electron/dist", name),
    path.join(licenses, "Electron-" + name),
  );
const notices = [],
  inventory = [];
async function notice(kind, name, version, license, directory, declared) {
  const texts = [];
  for (const entry of await readdir(directory)) {
    if (/^(licen[cs]e|copying|notice|copyright)([.\-_].*)?$/i.test(entry)) {
      const file = path.join(directory, entry);
      if ((await lstat(file)).isFile())
        texts.push({ name: entry, text: await readFile(file, "utf8") });
    }
  }
  if (
    declared &&
    !texts.some((entry) => entry.name === path.basename(declared))
  ) {
    try {
      texts.push({
        name: path.basename(declared),
        text: await readFile(path.resolve(directory, declared), "utf8"),
      });
    } catch {
      /* 许可元数据与文本缺项保留在清单，发布时另作审查。 */
    }
  }
  inventory.push({
    kind,
    name,
    version,
    license,
    license_files: texts.map((entry) => entry.name),
  });
  notices.push(
    `\n${kind}: ${name}@${version}\nLicense: ${license ?? "未声明"}\n` +
      texts.map((entry) => `\n${entry.name}\n${entry.text}`).join("\n"),
  );
}
const lock = JSON.parse(
  await readFile(path.join(root, "package-lock.json"), "utf8"),
);
for (const [relative, info] of Object.entries(lock.packages)) {
  if (!relative.startsWith("node_modules/") || info.link) continue;
  try {
    await lstat(path.join(root, relative));
  } catch (error) {
    if (error.code !== "ENOENT" || !info.optional) throw error;
    inventory.push({
      kind: "npm",
      name: info.name ?? relative.split("node_modules/").at(-1),
      version: info.version,
      license: info.license,
      installed: false,
      license_files: [],
    });
    continue;
  }
  await notice(
    "npm",
    info.name ?? relative.split("node_modules/").at(-1),
    info.version,
    info.license,
    path.join(root, relative),
  );
}
for (const pkg of metadata.packages)
  await notice(
    "cargo",
    pkg.name,
    pkg.version,
    pkg.license,
    path.dirname(pkg.manifest_path),
    pkg.license_file,
  );
await writeFile(
  path.join(licenses, "THIRD-PARTY-NOTICES.txt"),
  notices.join("\n"),
);
await writeFile(
  path.join(licenses, "dependency-inventory.json"),
  JSON.stringify(inventory, null, 2),
);
const paths = await packager({
  dir: stageApp,
  out: path.join(stage, "package"),
  tmpdir: path.join(stage, "packager-tmp"),
  overwrite: false,
  name: productName,
  executableName: values.distribution ? "Hetu" : "HetuElectronDev",
  appBundleId: values.distribution ? "run.limeai.hetu.electron" : "run.limeai.hetu.electron.dev",
  appCategoryType: "public.app-category.productivity",
  ...(process.platform === "darwin" ? { extendInfo: { LSMinimumSystemVersion: "14.0" } } : {}),
  appVersion: manifest.version,
  electronVersion: manifest.devDependencies.electron,
  platform: process.platform,
  arch: process.arch,
  icon: path.join(
    root,
    process.platform === "darwin"
      ? "assets/brand/icons/macos/Hetu.icns"
      : "assets/brand/icons/windows/hetu.ico",
  ),
  asar: false,
  prune: false,
  extraResource: [bin, licenses, integrations],
  ...(process.platform === "darwin"
    ? {
        osxSign: values.distribution ? {
          identity: process.env.HETU_SIGNING_IDENTITY,
          keychain: process.env.HETU_SIGNING_KEYCHAIN,
          identityValidation: false,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: (file) => ({
            hardenedRuntime: true,
            entitlements: file.endsWith("/bin/node") || file.includes("Helper") || file.endsWith(".app")
              ? ["com.apple.security.cs.allow-jit"] : [],
          }),
        } : {
          identity: "-",
          identityValidation: false,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
        },
      }
    : {}),
});
if (paths.length !== 1) throw new Error("没有生成唯一目标应用。");
if ((await sourceSnapshot()).sha256 !== after.sha256)
  throw new Error("装配或签名期间相关源码发生变化，请保留本次产物并重新装配。");
const artifacts = {};
for (const file of await files(paths[0])) {
  const stat = await lstat(file);
  artifacts[path.relative(paths[0], file).split(path.sep).join("/")] =
    stat.isSymbolicLink()
      ? { symlink: await readlink(file) }
      : { sha256: digest(await readFile(file)), size_bytes: stat.size };
}
const evidence = {
  schema_version: 1,
  kind: values.distribution ? "electron-release-package" : "electron-development-package",
  created_at: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  version: manifest.version,
  rust_profile: values.release ? "release" : "dev",
  electron: manifest.devDependencies.electron,
  node: runtimeInfo,
  source: after,
  source_binary_sha256: binaries,
  artifacts,
  signing:
    process.platform === "darwin"
      ? (values.distribution ? "developer-id" : "ad-hoc-development")
      : "unsigned-development",
  ...(values.distribution ? {} : { production_verified: false }),
};
await writeFile(
  path.join(stage, "manifest.json"),
  JSON.stringify(evidence, null, 2),
);
process.stdout.write(
  JSON.stringify({
    package_directory: paths[0],
    manifest: path.join(stage, "manifest.json"),
    source_sha256: after.sha256,
  }) + "\n",
);
