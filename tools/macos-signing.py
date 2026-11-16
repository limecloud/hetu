"""macOS发行签名、凭据校验和可恢复公证工具。"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
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
