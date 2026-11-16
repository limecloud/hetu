#!/usr/bin/env python3
"""装配、签名和公证 macOS arm64 Electron 发行包。"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("macos_release", ROOT / "tools/release-macos.py")
macos = importlib.util.module_from_spec(spec)
spec.loader.exec_module(macos)


def artifact_inventory(directory):
    result = {}
    for folder, directories, files in os.walk(directory, followlinks=False):
        for name in sorted(directories + files):
            file = Path(folder) / name
            relative = file.relative_to(directory).as_posix()
            if file.is_symlink():
                result[relative] = {"symlink": os.readlink(file)}
            elif file.is_file():
                result[relative] = {"sha256": macos.sha256(file), "size_bytes": file.stat().st_size}
    return result


def verify_package(app, version, team):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "run.limeai.hetu.electron" or info.get("CFBundleShortVersionString") != version:
        raise SystemExit("Electron 应用身份或版本与发行源码不一致。")
    macos.verify_signature(app, team)
    bin_dir = app / "Contents/Resources/bin"
    for name in ["hetu", "hetu-mcp", "hetu-app-server", "hetu-plugin", "node"]:
        binary = bin_dir / name
        if macos.run(["lipo", "-archs", str(binary)]).strip() != "arm64":
            raise SystemExit("随包助手架构不一致：" + name)
        macos.verify_signature(binary, team)
    if macos.run([str(bin_dir / "hetu"), "--version"]).strip() != "hetu " + version:
        raise SystemExit("随包 CLI 版本不一致。")
    macos.run([str(bin_dir / "hetu-mcp"), "--help"])
    macos.run([str(bin_dir / "node"), "--permission", "--input-type=module", "-e",
               'if(process.arch!=="arm64"||Number(process.versions.node.split(".")[0])!==25||'
               '!process.permission||process.permission.has("net"))process.exit(2)'])


def assemble(node, identity, keychain):
    env = {**os.environ, "HETU_SIGNING_IDENTITY": identity, "HETU_SIGNING_KEYCHAIN": str(keychain)}
    command = [node, str(ROOT / "apps/desktop/scripts/package.mjs"), "--release", "--distribution"]
    last_line = ""
    with subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True) as process:
        for line in process.stdout:
            print(line, end="", flush=True)
            if line.strip():
                last_line = line
        if process.wait():
            raise SystemExit("Electron 装配失败，请核对上方日志。")
    return json.loads(last_line)


def package(node, certificate, version):
    output = ROOT / "dist/electron/macos-arm64"
    evidence = ROOT / "build/electron-release-evidence"
    if output.exists() or evidence.exists():
        raise SystemExit("发行输出或公证证据已存在；保留原结果，在干净 checkout 中重建。")
    git_sha = macos.run(["git", "rev-parse", "HEAD"]).strip()
    if os.environ.get("GITHUB_SHA", git_sha) != git_sha:
        raise SystemExit("Checkout 与发布触发源码不一致。")
    team = os.environ["APPLE_TEAM_ID"]
    original_keychains = shlex.split(macos.run(["security", "list-keychains", "-d", "user"]))
    with tempfile.TemporaryDirectory(prefix="hetu-electron-signing-") as temporary:
        temporary = Path(temporary)
        keychain = temporary / "signing.keychain-db"
        p12 = temporary / "certificate.p12"
        p12.write_bytes(certificate)
        p12.chmod(0o600)
        password = secrets.token_urlsafe(32)
        try:
            macos.run(["security", "create-keychain", "-p", password, str(keychain)])
            macos.run(["security", "set-keychain-settings", "-lut", "21600", str(keychain)])
            macos.run(["security", "unlock-keychain", "-p", password, str(keychain)])
            macos.run(["security", "list-keychains", "-d", "user", "-s", str(keychain), *original_keychains])
            macos.run(["security", "import", str(p12), "-P", os.environ["APPLE_CERTIFICATE_PASSWORD"],
                       "-k", str(keychain), "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"])
            macos.run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:",
                       "-s", "-k", password, str(keychain)])
            identity = macos.signing_identity(keychain, os.environ["APPLE_SIGNING_IDENTITY"])
            assembled = assemble(node, identity, keychain)
            directory = Path(assembled["package_directory"])
            app = directory / "Hetu.app"
            verify_package(app, version, team)
            macos.run(["xcrun", "notarytool", "store-credentials", "hetu-notary", "--keychain", str(keychain),
                       "--apple-id", os.environ["APPLE_ID"], "--team-id", team, "--password", os.environ["APPLE_PASSWORD"]])
            archive = temporary / "Hetu-notarization.zip"
            macos.run(["ditto", "-c", "-k", "--keepParent", "--sequesterRsrc", str(app), str(archive)])
            submission = macos.notarize(archive, keychain, evidence / "app")
            macos.run(["xcrun", "stapler", "staple", str(app)])
            macos.run(["xcrun", "stapler", "validate", str(app)])
            macos.run(["spctl", "--assess", "--type", "execute", "--verbose=2", str(app)])
            verify_package(app, version, team)
            output.mkdir(parents=True)
            basename = "Hetu-" + version + "-macos-arm64"
            zipped = output / (basename + ".zip")
            macos.run(["ditto", "-c", "-k", "--keepParent", "--sequesterRsrc", str(app), str(zipped)])
            image = temporary / "image"
            image.mkdir()
            macos.run(["ditto", str(app), str(image / "Hetu.app")])
            (image / "Applications").symlink_to("/Applications")
            dmg = output / (basename + ".dmg")
            macos.run(["hdiutil", "create", "-volname", "Hetu Luoshu", "-srcfolder", str(image), "-format", "UDZO", str(dmg)])
            macos.run(["codesign", "--force", "--sign", identity, "--keychain", str(keychain), "--timestamp", str(dmg)])
            macos.run(["codesign", "--verify", "--strict", str(dmg)])
            dmg_submission = macos.notarize(dmg, keychain, evidence / "dmg")
            macos.run(["xcrun", "stapler", "staple", str(dmg)])
            macos.run(["xcrun", "stapler", "validate", str(dmg)])
            macos.run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", str(dmg)])
            manifest = json.loads(Path(assembled["manifest"]).read_text())
            manifest.update({
                "git_sha": git_sha, "platform": "macos", "architecture": "arm64", "minimum_macos": "14.0",
                "team_id": team, "notarization_id": submission, "notarization_status": "Accepted",
                "dmg_notarization_id": dmg_submission, "artifacts": artifact_inventory(directory),
                "files": {file.name: macos.sha256(file) for file in [zipped, dmg]},
                "signed_binary_sha256": {file.name: macos.sha256(file) for file in (app / "Contents/Resources/bin").iterdir()},
            })
            manifest_path = output / "release-manifest.json"
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
            (output / "SHA256SUMS").write_text("".join(
                macos.sha256(file) + "  " + file.name + "\n" for file in [zipped, dmg, manifest_path]))
            executable = app / "Contents/MacOS/Hetu"
            if os.environ.get("GITHUB_OUTPUT"):
                with Path(os.environ["GITHUB_OUTPUT"]).open("a") as destination:
                    destination.write(f"executable={executable}\nmanifest={manifest_path}\n")
            print(json.dumps({"executable": str(executable), "manifest": str(manifest_path), "output": str(output)}))
        finally:
            try:
                macos.run(["security", "list-keychains", "-d", "user", "-s", *original_keychains])
            finally:
                if keychain.exists():
                    macos.run(["security", "delete-keychain", str(keychain)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="仅检查版本、平台和必需 Secrets")
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("Electron 发行入口仅支持 macOS arm64。")
    node = shutil.which("node")
    if not node:
        raise SystemExit("缺少 Node.js 25。")
    macos.run([node, str(ROOT / "tools/verify-release.mjs")])
    if not macos.run([node, "--version"]).strip().startswith("v25."):
        raise SystemExit("Electron 发行需要独立 Node.js 25。")
    certificate = macos.validate_environment()
    version = macos.release_version()
    if args.check:
        print("Electron v" + version + " 发行配置检查通过。")
        return
    package(node, certificate, version)


if __name__ == "__main__":
    main()
