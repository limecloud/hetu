#!/usr/bin/env python3
"""检查本机工具链，构建并打开 Mac 开发版，不启动官网或其他平台。"""
import argparse
import fcntl
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "build/native/HetuDev.app"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只检查开发工具，不构建或启动")
    parser.add_argument("--build-only", action="store_true", help="构建开发包，不启动应用")
    parser.add_argument("--node-runtime", help="指定已有 Node.js 的可执行文件")
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("此脚本只启动 macOS 原生客户端。")
    for name in ["swift", "cargo", "rustup", "codesign", "install_name_tool"]:
        if not shutil.which(name):
            raise SystemExit(f"缺少 {name}，请先安装项目要求的本机开发工具。")
    spec = importlib.util.spec_from_file_location("hetu_native_build", ROOT / "tools/build-native.py")
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    channel = native.rust_channel()
    node, _, version = native.node_runtime(args.node_runtime)
    env = {**os.environ, "PATH": str(node.parent) + os.pathsep + os.environ.get("PATH", ""), "RUSTUP_TOOLCHAIN": channel, "RUSTUP_AUTO_INSTALL": "0"}
    npm = shutil.which("npm", path=env["PATH"])
    if not npm:
        raise SystemExit("缺少 npm，请使用同时包含 npm 的本机 Node.js 安装。")
    print(f"开发工具检查通过：Rust {channel}，Node.js {version}。", flush=True)
    if args.check:
        return
    # 开发版使用独立应用身份；再次启动只激活当前会话，不强制退出或覆盖运行中的程序。
    if subprocess.run(["/usr/bin/pgrep", "-f", str(APP / "Contents/MacOS/HetuMac")], stdout=subprocess.DEVNULL).returncode == 0:
        print("Mac 开发版正在运行。保留当前会话；需要重新编译时，请正常退出开发版后再运行本脚本。", flush=True)
        if not args.build_only:
            subprocess.run(["open", str(APP)], check=True)
        return
    lock_path = ROOT / "build/native/dev-mac.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("已有 Mac 开发构建正在运行，请等待该次构建完成。")
        dependencies = ["node_modules/typescript/bin/tsc", "node_modules/esbuild/bin/esbuild", "node_modules/@modelcontextprotocol/ext-apps/package.json"]
        if not all((ROOT / path).is_file() for path in dependencies):
            print("安装本地任务页面的锁定依赖。", flush=True)
            subprocess.run([npm, "ci", "--workspace", "@hetu/task-view", "--include-workspace-root=false"], cwd=ROOT, env=env, check=True)
        subprocess.run([npm, "run", "build:task-view"], cwd=ROOT, env=env, check=True)
        subprocess.run([sys.executable, str(ROOT / "tools/build-native.py"), "--mac-only", "--development", "--node-runtime", str(node)], cwd=ROOT, env=env, check=True)
        if args.build_only:
            print(f"Mac 开发包已构建：{APP}", flush=True)
        else:
            subprocess.run(["open", str(APP)], check=True)
            print("已打开河图洛书 Mac 开发版。", flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"开发启动失败（退出码 {error.returncode}），请查看上方具体错误。")
