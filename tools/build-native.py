#!/usr/bin/env python3
"""构建 Rust C ABI 和 Swift 入口；只使用本机已经安装的工具链。"""
import argparse
import os
from pathlib import Path
import shutil
import plistlib
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent

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

def package_app(channel):
    binary = ROOT / ".build/debug/HetuMac"
    app = ROOT / "build/native/Hetu.app"
    contents = app / "Contents"
    for name in ["MacOS", "Frameworks", "Resources", "Helpers"]:
        (contents / name).mkdir(parents=True, exist_ok=True)
    executable = contents / "MacOS/HetuMac"
    library = contents / "Frameworks/libhetu_core.dylib"
    shutil.copy2(binary, executable)
    shutil.copy2(ROOT / "build/native/lib/libhetu_core.dylib", library)
    shutil.copytree(ROOT / ".build/debug/Hetu_HetuNative.bundle", contents / "Resources/Hetu_HetuNative.bundle", dirs_exist_ok=True)
    shutil.copytree(ROOT / ".build/debug/Hetu_HetuArtwork.bundle", contents / "Resources/Hetu_HetuArtwork.bundle", dirs_exist_ok=True)
    shutil.copy2(ROOT / "assets/brand/icons/macos/Hetu.icns", contents / "Resources/Hetu.icns")
    mcp = contents / "Helpers/hetu-mcp"
    shutil.copy2(ROOT / "target/debug/hetu-mcp", mcp)
    standalone = ROOT / "build/native/bin/hetu-mcp"
    standalone.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(mcp, standalone)
    info = {
        "CFBundleName": "Hetu", "CFBundleDisplayName": "河图 Hetu", "CFBundleIdentifier": "run.limeai.hetu",
        "CFBundleExecutable": "HetuMac", "CFBundlePackageType": "APPL", "CFBundleIconFile": "Hetu",
        "CFBundleShortVersionString": "0.2.0", "CFBundleVersion": "2", "LSMinimumSystemVersion": "14.0",
        "NSHighResolutionCapable": True, "NSPrincipalClass": "NSApplication",
        "CFBundleDevelopmentRegion": "zh_CN", "CFBundleLocalizations": ["zh_CN", "en"],
        "NSSupportsAutomaticTermination": False,
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
    run(["codesign", "--force", "--sign", "-", str(app)], channel)
    run(["codesign", "--verify", "--deep", "--strict", str(app)], channel)
    run([str(mcp), "--help"], channel)
    print(f"Mac 开发包：{app}")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test", action="store_true", help="执行 Rust 与 Swift 桥接测试")
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("当前构建入口在 macOS 验证；其他平台使用各自的发行入口。")
    channel = rust_channel()
    run(["cargo", "build", "--locked"], channel)
    stage = ROOT / "build/native/lib"
    stage.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "target/debug/libhetu_core.dylib", stage)
    run(["install_name_tool", "-id", "@rpath/libhetu_core.dylib", str(stage / "libhetu_core.dylib")], channel)
    run(["codesign", "--force", "--sign", "-", str(stage / "libhetu_core.dylib")], channel)
    run([sys.executable, str(ROOT / "tools/generate-localization.py")], channel)
    run(["swift", "build", "--jobs", "2"], channel)
    package_app(channel)
    if args.test:
        run(["cargo", "test", "--locked", "-p", "hetu-core"], channel)
        # 每个 stdio 用例启动真实服务进程，限制并发以保留握手超时的诊断意义。
        run(["cargo", "test", "--locked", "-p", "hetu-mcp", "--", "--test-threads=2"], channel,
            {"HETU_MCP_TEST_BINARY": str(ROOT / "build/native/bin/hetu-mcp")})
        run(["swift", "run", "--skip-build", "hetu-bridge-tests"], channel)
        run(["swift", "run", "--skip-build", "hetu-native-tests"], channel)
        run([sys.executable, str(ROOT / "tools/verify-ffi.py"), "--cli"], channel)

if __name__ == "__main__":
    main()
