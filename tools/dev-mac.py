#!/usr/bin/env python3
"""检查本机工具链，构建并打开 Electron Mac 开发版。"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = ROOT / "output/electron-packages"


def node_runtime(explicit=None):
    candidates = [Path(explicit).expanduser()] if explicit else []
    if not explicit:
        if current := shutil.which("node"):
            candidates.append(Path(current))
        candidates += sorted((Path.home() / ".nvm/versions/node").glob("v*/bin/node"), reverse=True)
    for candidate in candidates:
        if not candidate.is_file():
            continue
        candidate = candidate.resolve()
        version = subprocess.check_output([str(candidate), "--version"], text=True).strip()
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", version)
        if not match or not (25, 0, 0) <= tuple(map(int, match.groups())) < (26, 0, 0):
            continue
        if not any((directory / "LICENSE").is_file() for directory in [candidate.parent, candidate.parent.parent]):
            continue
        subprocess.run([str(candidate), "--permission", "--input-type=module", "-e",
                        'if(process.versions.electron||!process.permission||process.permission.has("net"))process.exit(2)'], check=True)
        return candidate, version
    raise SystemExit("Electron 插件后端需要 Node.js >=25 <26 及同一安装的 LICENSE；可用 --node-runtime 指定。不会自动安装 Node。")


def toolchain(explicit_node):
    env = {**os.environ, "PATH": os.pathsep.join([os.environ.get("PATH", ""), str(Path.home() / ".cargo/bin")]),
           "RUSTUP_AUTO_INSTALL": "0"}
    for name in ["cargo", "rustup", "cc", "codesign"]:
        if not shutil.which(name, path=env["PATH"]):
            raise SystemExit(f"缺少 {name}，请先安装项目要求的本机开发工具。")
    channel = re.search(r'^channel\s*=\s*"([^"]+)"', (ROOT / "rust-toolchain.toml").read_text(), re.MULTILINE).group(1)
    env["RUSTUP_TOOLCHAIN"] = channel
    subprocess.run(["rustup", "run", channel, "rustc", "--version"], cwd=ROOT, env=env, check=True)
    node, version = node_runtime(explicit_node)
    env["PATH"] = str(node.parent) + os.pathsep + env["PATH"]
    npm = shutil.which("npm", path=env["PATH"])
    if not npm:
        raise SystemExit("缺少 npm，请使用同时包含 npm 的本机 Node.js 安装。")
    print(f"开发工具检查通过：Electron，Rust {channel}，Node.js {version}。", flush=True)
    return node, npm, env


def running_app():
    apps = sorted(PACKAGES.glob("hetu-dev-*/package/*/*.app"),
                  key=lambda app: app.stat().st_mtime_ns, reverse=True)
    for app in apps:
        binary = app / "Contents/MacOS/HetuElectronDev"
        if subprocess.run(["/usr/bin/pgrep", "-f", "^" + re.escape(str(binary)) + r"($| )"],
                          stdout=subprocess.DEVNULL).returncode == 0:
            return app
    return None


def package_app(node, npm, env):
    command = [npm, "run", "package:desktop", "--", "--node", str(node)]
    # 保留实时构建日志，仅以装配入口成功返回的最后一行定位本次制品。
    last_line = ""
    with subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True) as process:
        for line in process.stdout:
            print(line, end="", flush=True)
            if line.strip():
                last_line = line
        if process.wait():
            raise subprocess.CalledProcessError(process.returncode, command)
    try:
        result = json.loads(last_line)
        apps = list(Path(result["package_directory"]).glob("*.app"))
        if len(apps) == 1 and (apps[0] / "Contents/MacOS/HetuElectronDev").is_file() and Path(result["manifest"]).is_file():
            return apps[0]
    except (ValueError, KeyError, TypeError):
        pass
    raise SystemExit("Electron 装配未返回有效的应用与清单，请查看上方具体错误。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只检查开发工具，不构建或启动")
    parser.add_argument("--build-only", action="store_true", help="构建 Electron 开发包，不启动应用")
    parser.add_argument("--node-runtime", help="指定已有 Node.js 的可执行文件")
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("此脚本只在 macOS 构建和启动 Electron 客户端。")
    node, npm, env = toolchain(args.node_runtime)
    if args.check:
        return
    lock_path = ROOT / "build/electron/dev-mac.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("已有 Electron 开发构建正在运行，请等待该次构建完成。")
        # 再次启动只激活当前会话，不强制退出或覆盖运行中的程序。
        app = running_app()
        if app:
            print("Electron 开发版正在运行。保留当前会话；需要重新编译时，请正常退出开发版后再运行本脚本。", flush=True)
            if not args.build_only:
                subprocess.run(["open", str(app)], check=True)
            return
        dependencies = ["node_modules/typescript/bin/tsc", "node_modules/esbuild/bin/esbuild",
                        "node_modules/@modelcontextprotocol/ext-apps/package.json", "node_modules/@electron/packager/package.json",
                        "node_modules/electron/package.json", "node_modules/react/package.json",
                        "node_modules/@hetu/plugin-host/package.json", "node_modules/@hetu/plugin-sdk/package.json"]
        if not all((ROOT / path).is_file() for path in dependencies):
            print("安装 Electron 工作台与共享页面的锁定依赖。", flush=True)
            subprocess.run([npm, "ci"], cwd=ROOT, env=env, check=True)
        if not (ROOT / "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron").is_file():
            subprocess.run([str(node), str(ROOT / "node_modules/electron/install.js")], cwd=ROOT, env=env, check=True)
        subprocess.run([npm, "run", "build:task-view"], cwd=ROOT, env=env, check=True)
        app = package_app(node, npm, env)
        if args.build_only:
            print(f"Electron 开发包已构建：{app}", flush=True)
        else:
            subprocess.run(["open", str(app)], check=True)
            print(f"已打开河图洛书 Electron 开发版：{app}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"开发启动失败（退出码 {error.returncode}），请查看上方具体错误。")
