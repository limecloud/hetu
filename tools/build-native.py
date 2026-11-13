#!/usr/bin/env python3
"""构建 Rust C ABI 和 Swift 入口；只使用本机已经安装的工具链。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import plistlib
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent

def tree_hashes(directory):
    result = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise SystemExit(f"资源目录不能包含符号链接：{path}")
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result

def copy_tree_exact(source, destination):
    """先准备独立副本再替换受管构建资源，不与旧目录合并。"""
    expected = tree_hashes(source)
    if destination.exists() and not destination.is_symlink() and tree_hashes(destination) == expected:
        return
    if destination.is_symlink():
        raise SystemExit(f"资源目标不能是符号链接：{destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".hetu-resource-", dir=destination.parent) as temporary:
        stage = Path(temporary) / "prepared"
        backup = Path(temporary) / "previous"
        shutil.copytree(source, stage)
        if tree_hashes(stage) != expected:
            raise SystemExit(f"资源复制摘要不符：{source}")
        if destination.exists():
            destination.rename(backup)
        try:
            stage.rename(destination)
        except BaseException:
            if backup.exists():
                backup.rename(destination)
            raise
    if tree_hashes(destination) != expected:
        raise SystemExit(f"资源装配摘要不符：{destination}")

def refresh_swift_resources():
    # SwiftPM 的目录资源缓存不能作为发行事实源；从已校验的受管源精确装配。
    debug = ROOT / ".build/debug"
    integration = debug / "Hetu_HetuIntegrationAssets.bundle"
    shutil.copy2(ROOT / "integrations/catalog.json", integration / "catalog.json")
    copy_tree_exact(ROOT / "integrations/codex", integration / "codex")
    copy_tree_exact(ROOT / "apps/task-view/resources/local", debug / "Hetu_HetuTaskViewAssets.bundle/local")
    copy_tree_exact(ROOT / "assets/illustrations/library", debug / "Hetu_HetuArtwork.bundle/library")
    shutil.copy2(ROOT / "apps/macos/Sources/HetuNative/Resources/NativeStrings.json", debug / "Hetu_HetuNative.bundle/NativeStrings.json")

def verify_packaged_resources(contents):
    debug = ROOT / ".build/debug"
    report = {"schema_version": "1.0.0", "skills": {}}
    catalog = json.loads((ROOT / "integrations/catalog.json").read_text())
    for suite in catalog["suites"]:
        name = suite["pluginName"]
        source = ROOT / "integrations/codex" / name
        expected = tree_hashes(source)
        for root in [debug / "Hetu_HetuIntegrationAssets.bundle/codex", contents / "Resources/Hetu_HetuIntegrationAssets.bundle/codex"]:
            if tree_hashes(root / name) != expected:
                raise SystemExit(f"方法资源文件集或摘要不符：{root / name}")
        report["skills"][name] = {"version": json.loads((source / "plugin.json").read_text())["version"], "files": expected}
    for name in ["HetuNative", "HetuArtwork", "HetuIntegrationAssets", "HetuTaskViewAssets"]:
        bundle = f"Hetu_{name}.bundle"
        if tree_hashes(debug / bundle) != tree_hashes(contents / "Resources" / bundle):
            raise SystemExit(f"App 与 Swift 资源不一致：{bundle}")
    manifest_name = "resource-manifest-development.json" if contents.parent.name == "HetuDev.app" else "resource-manifest.json"
    (ROOT / "build/native" / manifest_name).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

def verify_task_view():
    resources = ROOT / "apps/mcp/resources"
    manifest = json.loads((resources / "task-view.manifest.json").read_text())
    files = {resources / "task-view.html": manifest["sha256"]}
    for relative, expected in manifest["source_sha256"].items():
        files[ROOT / "apps/task-view" / relative] = expected
    if any(hashlib.sha256(path.read_bytes()).hexdigest() != expected for path, expected in files.items()):
        raise SystemExit("MCP Apps 资源与源码摘要不一致，请先执行 npm run build:task-view。")
    local = ROOT / "apps/task-view/resources/local"
    manifest = json.loads((local / "manifest.json").read_text())
    files = {local / name: sha for name, sha in manifest["files"].items()}
    files.update({ROOT / "apps/task-view" / name: sha for name, sha in manifest["source_sha256"].items()})
    if any(hashlib.sha256(path.read_bytes()).hexdigest() != expected for path, expected in files.items()):
        raise SystemExit("本地任务页面资源与源码摘要不一致，请先执行 npm run build:task-view。")

def node_runtime(explicit=None):
    candidates = [Path(explicit)] if explicit else [Path(shutil.which("node"))] if shutil.which("node") else []
    if not explicit:
        candidates += sorted((Path.home() / ".nvm/versions/node").glob("v*/bin/node"), reverse=True)
    for candidate in candidates:
        if not candidate.is_file():
            continue
        version = subprocess.check_output([str(candidate), "--version"], text=True, env={"PATH": "/usr/bin:/bin"}).strip()
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", version)
        if match and (24, 21, 0) <= tuple(map(int, match.groups())) < (26, 0, 0):
            license_path = candidate.resolve().parent.parent / "LICENSE"
            if license_path.is_file():
                return candidate.resolve(), license_path, version
    raise SystemExit("本地页面分发需要 Node.js >=24.21.0 <26 及同一运行时的 LICENSE；可用 --node-runtime 指定。不会自动安装 Node。")

def run(args, channel, extra_env=None):
    subprocess.run(args, cwd=ROOT, env={**os.environ, "RUSTUP_TOOLCHAIN": channel, **(extra_env or {}), "RUSTUP_AUTO_INSTALL": "0"}, check=True)

def rust_channel():
    version = "1.93.1"
    installed = subprocess.check_output(["rustup", "toolchain", "list"], cwd=ROOT.parent, text=True, env={**os.environ, "RUSTUP_AUTO_INSTALL": "0"})
    if any(line.startswith(version + "-") for line in installed.splitlines()):
        return version
    if any(line.startswith("stable-") for line in installed.splitlines()):
        actual = subprocess.check_output(["rustup", "run", "stable", "rustc", "--version"], cwd=ROOT.parent, text=True, env={**os.environ, "RUSTUP_AUTO_INSTALL": "0"})
        if actual.split()[1] == version:
            return "stable"
    raise SystemExit(f"需要已安装的 Rust {version}；本脚本不会安装或更新系统工具链。")

def package_app(channel, runtime, development=False):
    binary = ROOT / ".build/debug/HetuMac"
    app = ROOT / "build/native" / ("HetuDev.app" if development else "Hetu.app")
    contents = app / "Contents"
    for name in ["MacOS", "Frameworks", "Resources", "Helpers"]:
        (contents / name).mkdir(parents=True, exist_ok=True)
    executable = contents / "MacOS/HetuMac"
    library = contents / "Frameworks/libhetu_core.dylib"
    shutil.copy2(binary, executable)
    shutil.copy2(ROOT / "build/native/lib/libhetu_core.dylib", library)
    refresh_swift_resources()
    for name in ["HetuNative", "HetuArtwork", "HetuIntegrationAssets", "HetuTaskViewAssets"]:
        bundle = f"Hetu_{name}.bundle"
        copy_tree_exact(ROOT / ".build/debug" / bundle, contents / "Resources" / bundle)
    verify_packaged_resources(contents)
    shutil.copy2(ROOT / "assets/brand/icons/macos/Hetu.icns", contents / "Resources/Hetu.icns")
    mcp = contents / "Helpers/hetu-mcp"
    shutil.copy2(ROOT / "target/debug/hetu-mcp", mcp)
    standalone = ROOT / "build/native/bin/hetu-mcp"
    standalone.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(mcp, standalone)
    node_source, node_license, node_version = runtime
    node = contents / "Helpers/node"
    shutil.copy2(node_source, node)
    notices = contents / "Resources/ThirdParty"
    notices.mkdir(parents=True, exist_ok=True)
    shutil.copy2(node_license, notices / "Node.js-LICENSE.txt")
    info = {
        "CFBundleName": "Hetu Luoshu Dev" if development else "Hetu Luoshu",
        "CFBundleDisplayName": "河图洛书 开发版" if development else "河图洛书",
        "CFBundleIdentifier": "run.limeai.hetu.dev" if development else "run.limeai.hetu",
        "CFBundleExecutable": "HetuMac", "CFBundlePackageType": "APPL", "CFBundleIconFile": "Hetu",
        "CFBundleShortVersionString": "0.3.0", "CFBundleVersion": "3", "LSMinimumSystemVersion": "14.0",
        "NSHighResolutionCapable": True, "NSPrincipalClass": "NSApplication",
        "CFBundleDevelopmentRegion": "zh_CN", "CFBundleLocalizations": ["zh_CN", "en"],
        "NSSupportsAutomaticTermination": False,
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    }
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))
    load_commands = subprocess.check_output(["otool", "-l", str(executable)], text=True)
    for path in re.findall(r"cmd LC_RPATH\n.*?path (.*?) \(offset", load_commands, re.S):
        if path.startswith("/") and path != "/usr/lib/swift":
            run(["install_name_tool", "-delete_rpath", path, str(executable)], channel)
    # 开发包只做 ad-hoc 签名，不是 Developer ID 签名或公证发行包。
    run(["codesign", "--force", "--sign", "-", str(library)], channel)
    run(["codesign", "--force", "--sign", "-", str(mcp)], channel)
    run(["codesign", "--force", "--sign", "-", str(standalone)], channel)
    run(["codesign", "--force", "--sign", "-", str(node)], channel)
    (notices / "node-runtime.json").write_text(json.dumps({
        "version": node_version, "architecture": subprocess.check_output([str(node), "-p", "process.arch"], text=True, env={"PATH": "/usr/bin:/bin"}).strip(),
        "sha256": hashlib.sha256(node.read_bytes()).hexdigest(), "license_sha256": hashlib.sha256(node_license.read_bytes()).hexdigest(),
    }, indent=2) + "\n")
    run(["codesign", "--force", "--sign", "-", str(app)], channel)
    run(["codesign", "--verify", "--deep", "--strict", str(app)], channel)
    run([str(mcp), "--help"], channel)
    run([str(node), "--version"], channel)
    print(f"Mac 开发包：{app}")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test", action="store_true", help="执行 Rust 与 Swift 桥接测试")
    parser.add_argument("--mac-only", action="store_true", help="只构建 Mac 应用及所需内核、MCP 和资源")
    parser.add_argument("--development", action="store_true", help="装配独立的 HetuDev.app，不覆盖普通开发包")
    parser.add_argument("--node-runtime", help="随开发包装配的本机 Node.js 路径；不修改系统 Node")
    args = parser.parse_args()
    if args.mac_only and args.test:
        parser.error("--mac-only 不执行全量测试，请单独使用 --test。")
    if sys.platform != "darwin":
        raise SystemExit("当前构建入口在 macOS 验证；其他平台使用各自的发行入口。")
    channel = rust_channel()
    runtime = node_runtime(args.node_runtime)
    verify_task_view()
    run([sys.executable, str(ROOT / "tools/verify-skills.py")], channel)
    run(["cargo", "build", "--locked"], channel)
    stage = ROOT / "build/native/lib"
    stage.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "target/debug/libhetu_core.dylib", stage)
    run(["install_name_tool", "-id", "@rpath/libhetu_core.dylib", str(stage / "libhetu_core.dylib")], channel)
    run(["codesign", "--force", "--sign", "-", str(stage / "libhetu_core.dylib")], channel)
    run([sys.executable, str(ROOT / "tools/generate-localization.py")], channel)
    swift_args = ["swift", "build", "--jobs", "2", "-Xswiftc", "-disable-batch-mode"]
    if args.mac_only:
        swift_args += ["--product", "HetuMac"]
    run(swift_args, channel)
    package_app(channel, runtime, args.development)
    if args.test:
        run(["cargo", "test", "--locked", "-p", "hetu-core"], channel)
        # 每个 stdio 用例启动真实服务进程，限制并发以保留握手超时的诊断意义。
        run(["cargo", "test", "--locked", "-p", "hetu-mcp", "--", "--test-threads=2"], channel,
            {"HETU_MCP_TEST_BINARY": str(ROOT / "build/native/bin/hetu-mcp")})
        run(["swift", "run", "--skip-build", "hetu-bridge-tests"], channel)
        run(["swift", "run", "--skip-build", "hetu-native-tests"], channel,
            {"HETU_TEST_NODE": str(ROOT / "build/native" / ("HetuDev.app" if args.development else "Hetu.app") / "Contents/Helpers/node")})
        run([sys.executable, str(ROOT / "tools/verify-ffi.py"), "--cli"], channel)

if __name__ == "__main__":
    main()
