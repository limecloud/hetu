#!/usr/bin/env python3
"""为已测试的 Mac release 构建签名、公证并制作独立下载包。"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parent.parent
REQUIRED_SECRETS = (
    "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID", "APPLE_ID", "APPLE_PASSWORD",
)


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def release_version(root=ROOT):
    version = json.loads((root / "package.json").read_text())["version"]
    rust = tomllib.loads((root / "Cargo.toml").read_text())["workspace"]["package"]["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or version != rust:
        raise SystemExit("package.json 与 Cargo.toml 必须使用相同的三段发行版本。")
    return version


def validate_environment(env=os.environ):
    missing = [name for name in REQUIRED_SECRETS if not env.get(name, "").strip()]
    if missing:
        raise SystemExit("缺少签名／公证 Secrets：" + ", ".join(missing))
    team = env["APPLE_TEAM_ID"]
    if not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise SystemExit("APPLE_TEAM_ID 必须是 10 位团队标识。")
    identity = env["APPLE_SIGNING_IDENTITY"]
    if not identity.startswith("Developer ID Application: ") or not identity.endswith(f"({team})"):
        raise SystemExit("APPLE_SIGNING_IDENTITY 必须是同团队的 Developer ID Application 名称。")
    try:
        certificate = base64.b64decode(env["APPLE_CERTIFICATE"], validate=True)
    except ValueError:
        raise SystemExit("APPLE_CERTIFICATE 必须是 PKCS#12 文件的单行 Base64。") from None
    if not certificate:
        raise SystemExit("APPLE_CERTIFICATE 不能为空。")
    return certificate


def run(args):
    result = subprocess.run(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        # subprocess 的异常默认包含完整参数，不能将凭据带入 CI 日志。
        message = result.stdout
        for name in REQUIRED_SECRETS:
            value = os.environ.get(name)
            if value:
                message = message.replace(value, "[REDACTED]")
        raise SystemExit(f"{Path(args[0]).name} 执行失败（{result.returncode}）：\n{message}")
    return result.stdout


def verify_signature(path, team):
    run(["codesign", "--verify", "--deep", "--strict", str(path)])
    details = run(["codesign", "--display", "--verbose=4", str(path)])
    lines = details.splitlines()
    if (f"TeamIdentifier={team}" not in lines
            or not any(line.startswith("Authority=Developer ID Application:") for line in lines)
            or not any("flags=" in line and "runtime" in line for line in lines)
            or not any(line.startswith("Timestamp=") for line in lines)):
        raise SystemExit(f"发行签名缺少正确团队、Developer ID、时间戳或 Hardened Runtime：{path.name}")


def signing_identity(keychain, name):
    identities = run(["security", "find-identity", "-v", "-p", "codesigning", str(keychain)])
    matches = re.findall(r'^\s*\d+\) ([A-Fa-f0-9]{40}) "' + re.escape(name) + r'"$', identities, re.MULTILINE)
    if len(matches) != 1:
        raise SystemExit("导入证书必须包含唯一的指定签名身份及私钥。")
    # 同一团队可能已有多张同名证书，codesign 通过指纹选择本次导入的证书。
    return matches[0]


def notarize(archive, keychain, evidence):
    # 先保留提交 ID；等待超时后沿原 ID 查询，不重新上传。
    auth = ["--keychain-profile", "hetu-notary", "--keychain", str(keychain)]
    receipt = json.loads(run(["xcrun", "notarytool", "submit", str(archive), *auth, "--output-format", "json"]))
    submission = receipt.get("id", "")
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", submission):
        raise SystemExit("Apple 未返回有效的公证提交 ID。")
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "submission.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"Apple 公证提交：{submission}", flush=True)
    response = json.loads(run(["xcrun", "notarytool", "wait", submission, *auth,
                               "--timeout", "25m", "--output-format", "json"]))
    (evidence / "result.json").write_text(json.dumps(response, indent=2) + "\n")
    if response.get("id") != submission or response.get("status") != "Accepted":
        raise SystemExit(f"公证未通过；保留原提交 {submission}，请核查 Apple 公证日志。")
    return submission


def package(app, certificate, version):
    env = os.environ
    team = env["APPLE_TEAM_ID"]
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info["CFBundleIdentifier"] != "run.limeai.hetu" or info["CFBundleShortVersionString"] != version:
        raise SystemExit("App 身份或版本与当前源码不符，请重新构建 release。")
    contents = app / "Contents"
    binaries = [contents / name for name in [
        "Frameworks/libhetu_core.dylib", "Helpers/hetu-mcp", "Helpers/node", "MacOS/HetuMac",
    ]]
    for binary in binaries:
        if run(["lipo", "-archs", str(binary)]).strip() != "arm64":
            raise SystemExit(f"只接受已验证的 arm64 发行产物：{binary.name}")
    spec = importlib.util.spec_from_file_location("native", ROOT / "tools/build-native.py")
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    native.verify_packaged_resources(contents, ROOT / "build/release-swift/release")
    output = ROOT / "dist/macos"
    evidence = ROOT / "build/release-evidence"
    if output.exists() or evidence.exists():
        raise SystemExit("发行输出或公证证据目录已存在；请保留原结果，并在干净 checkout 中重建。")
    original_keychains = shlex.split(run(["security", "list-keychains", "-d", "user"]))
    with tempfile.TemporaryDirectory(prefix="hetu-signing-") as temporary:
        temporary = Path(temporary)
        keychain = temporary / "signing.keychain-db"
        p12 = temporary / "certificate.p12"
        p12.write_bytes(certificate)
        p12.chmod(0o600)
        password = secrets.token_urlsafe(32)
        try:
            run(["security", "create-keychain", "-p", password, str(keychain)])
            run(["security", "set-keychain-settings", "-lut", "21600", str(keychain)])
            run(["security", "unlock-keychain", "-p", password, str(keychain)])
            run(["security", "list-keychains", "-d", "user", "-s", str(keychain), *original_keychains])
            run(["security", "import", str(p12), "-P", env["APPLE_CERTIFICATE_PASSWORD"],
                 "-k", str(keychain), "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"])
            run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:",
                 "-s", "-k", password, str(keychain)])
            identity = signing_identity(keychain, env["APPLE_SIGNING_IDENTITY"])
            sign = ["codesign", "--force", "--sign", identity,
                    "--keychain", str(keychain), "--timestamp", "--options", "runtime"]
            entitlements = temporary / "node-entitlements.plist"
            entitlements.write_bytes(plistlib.dumps({"com.apple.security.cs.allow-jit": True}))
            print("签名内核、MCP、Node.js 和 Mac 应用。", flush=True)
            for binary in binaries:
                options = ["--entitlements", str(entitlements)] if binary.name == "node" else []
                run([*sign, *options, str(binary)])
                verify_signature(binary, team)
            runtime_path = contents / "Resources/ThirdParty/node-runtime.json"
            runtime = json.loads(runtime_path.read_text())
            runtime["sha256"] = sha256(contents / "Helpers/node")
            runtime_path.write_text(json.dumps(runtime, indent=2) + "\n")
            run([*sign, str(app)])
            verify_signature(app, team)
            run([str(contents / "Helpers/node"), "-e", "for(let i=0;i<100000;i++)Math.sqrt(i);console.log(process.arch)"])
            run([str(contents / "Helpers/hetu-mcp"), "--help"])
            run(["xcrun", "notarytool", "store-credentials", "hetu-notary", "--keychain", str(keychain),
                 "--apple-id", env["APPLE_ID"], "--team-id", team, "--password", env["APPLE_PASSWORD"]])
            archive = temporary / "Hetu-notarization.zip"
            run(["ditto", "-c", "-k", "--keepParent", "--sequesterRsrc", str(app), str(archive)])
            submission = notarize(archive, keychain, evidence / "app")
            run(["xcrun", "stapler", "staple", str(app)])
            run(["xcrun", "stapler", "validate", str(app)])
            verify_signature(app, team)
            run(["spctl", "--assess", "--type", "execute", "--verbose=2", str(app)])
            output.mkdir(parents=True)
            basename = f"Hetu-{version}-macos-arm64"
            zipped = output / f"{basename}.zip"
            run(["ditto", "-c", "-k", "--keepParent", "--sequesterRsrc", str(app), str(zipped)])
            image = temporary / "image"
            image.mkdir()
            run(["ditto", str(app), str(image / "Hetu.app")])
            (image / "Applications").symlink_to("/Applications")
            dmg = output / f"{basename}.dmg"
            run(["hdiutil", "create", "-volname", "Hetu Luoshu", "-srcfolder", str(image),
                 "-format", "UDZO", str(dmg)])
            run(["codesign", "--force", "--sign", identity,
                 "--keychain", str(keychain), "--timestamp", str(dmg)])
            run(["codesign", "--verify", "--strict", str(dmg)])
            dmg_submission = notarize(dmg, keychain, evidence / "dmg")
            run(["xcrun", "stapler", "staple", str(dmg)])
            run(["xcrun", "stapler", "validate", str(dmg)])
            run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", str(dmg)])
            manifest = {
                "version": version, "git_sha": run(["git", "rev-parse", "HEAD"]).strip(),
                "platform": "macos", "architecture": "arm64", "minimum_macos": info["LSMinimumSystemVersion"],
                "team_id": team, "notarization_id": submission, "notarization_status": "Accepted",
                "dmg_notarization_id": dmg_submission,
                "node": runtime, "files": {path.name: sha256(path) for path in [zipped, dmg]},
            }
            manifest_path = output / "release-manifest.json"
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
            files = [zipped, dmg, manifest_path]
            (output / "SHA256SUMS").write_text("".join(f"{sha256(path)}  {path.name}\n" for path in files))
            print(f"已验证的签名／公证下载包：{output}", flush=True)
        finally:
            # 独立 runner 结束前恢复搜索列表并移除临时私钥，不触碰用户登录钥匙串。
            try:
                run(["security", "list-keychains", "-d", "user", "-s", *original_keychains])
            finally:
                if keychain.exists():
                    run(["security", "delete-keychain", str(keychain)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="仅检查版本、平台和必需 Secrets")
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("当前发行入口只接受 macOS arm64 runner。")
    certificate = validate_environment()
    version = release_version()
    if args.check:
        print(f"Hetu {version} 签名配置检查通过。")
        return
    package(ROOT / "build/native/Hetu.app", certificate, version)


if __name__ == "__main__":
    main()
