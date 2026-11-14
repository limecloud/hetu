"""验证发行凭据边界、公证回执和混合配置构建。"""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load_tool("release-macos")
native = load_tool("build-native")


def credentials():
    return {
        "APPLE_CERTIFICATE": base64.b64encode(b"test-p12").decode(),
        "APPLE_CERTIFICATE_PASSWORD": "test-password",
        "APPLE_SIGNING_IDENTITY": "Developer ID Application: Test (ABCDEFGHIJ)",
        "APPLE_TEAM_ID": "ABCDEFGHIJ", "APPLE_ID": "test-account", "APPLE_PASSWORD": "test-app-password",
    }


class ReleaseBoundaryTests(unittest.TestCase):
    def test_incomplete_credentials_fail_closed(self):
        with self.assertRaisesRegex(SystemExit, "APPLE_CERTIFICATE"):
            release.validate_environment({})
        env = credentials()
        env["APPLE_CERTIFICATE"] = "invalid-base64"
        with self.assertRaisesRegex(SystemExit, "Base64"):
            release.validate_environment(env)

    def test_wrong_certificate_type_or_team_is_rejected(self):
        for identity in ["Apple Distribution: Test (ABCDEFGHIJ)", "Developer ID Application: Test (0123456789)"]:
            env = {**credentials(), "APPLE_SIGNING_IDENTITY": identity}
            with self.assertRaisesRegex(SystemExit, "同团队"):
                release.validate_environment(env)

    def test_subprocess_failure_does_not_disclose_credentials(self):
        env = credentials()
        failed = subprocess.CompletedProcess([], 1, "rejected " + env["APPLE_PASSWORD"])
        with patch.dict(release.os.environ, env), patch.object(release.subprocess, "run", return_value=failed):
            with self.assertRaises(SystemExit) as caught:
                release.run(["test-command", "--password", env["APPLE_PASSWORD"]])
        self.assertNotIn(env["APPLE_PASSWORD"], str(caught.exception))
        self.assertIn("[REDACTED]", str(caught.exception))

    def test_development_or_unhardened_signature_is_rejected(self):
        details = "TeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Test\nflags=0x10000(runtime)\nTimestamp=now\n"
        for invalid in [details.replace("ABCDEFGHIJ", "0123456789"), details.replace("Timestamp=now\n", ""),
                        details.replace("flags=0x10000(runtime)", "flags=0x2(adhoc)")]:
            with patch.object(release, "run", side_effect=["", invalid]):
                with self.assertRaisesRegex(SystemExit, "发行签名"):
                    release.verify_signature(Path("Hetu.app"), "ABCDEFGHIJ")

    def test_certificate_fingerprint_resolves_same_name_identities(self):
        name = credentials()["APPLE_SIGNING_IDENTITY"]
        fingerprint = "A" * 40
        row = f'  1) {fingerprint} "{name}"\n'
        with patch.object(release, "run", return_value=row + "     1 valid identities found\n"):
            self.assertEqual(release.signing_identity(Path("keychain"), name), fingerprint)
        for invalid in ["0 valid identities found", row + row]:
            with patch.object(release, "run", return_value=invalid):
                with self.assertRaisesRegex(SystemExit, "唯一"):
                    release.signing_identity(Path("keychain"), name)

    def test_notarization_acceptance_and_timeout_preserve_original_id(self):
        submission = "12345678-1234-1234-1234-123456789abc"
        receipt = {"id": submission, "status": "In Progress"}
        for outcome in [{"id": submission, "status": "Accepted"}, {"id": submission, "status": "Invalid"}, None]:
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                evidence = Path(directory) / "evidence"
                outputs = [json.dumps(receipt), json.dumps(outcome) if outcome else SystemExit("等待超时")]
                with patch.object(release, "run", side_effect=outputs) as run, contextlib.redirect_stdout(io.StringIO()):
                    if outcome and outcome["status"] == "Accepted":
                        self.assertEqual(release.notarize(Path("app.zip"), Path("keychain"), evidence), submission)
                    else:
                        with self.assertRaises(SystemExit):
                            release.notarize(Path("app.zip"), Path("keychain"), evidence)
                self.assertEqual(json.loads((evidence / "submission.json").read_text())["id"], submission)
                self.assertEqual(run.call_count, 2)
                self.assertIn("wait", run.call_args.args[0])
                self.assertIn(submission, run.call_args.args[0])

    def test_version_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "package.json").write_text('{"version":"1.2.3"}')
            (root / "Cargo.toml").write_text('[workspace.package]\nversion = "1.2.4"\n')
            with self.assertRaisesRegex(SystemExit, "相同"):
                release.release_version(root)


class NativeConfigurationTests(unittest.TestCase):
    def test_release_uses_same_profile_for_rust_swift_tests_and_packaging(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            scratch = root / "swift-cache"
            with patch.object(native, "ROOT", root), patch.object(native.sys, "platform", "darwin"), \
                    patch.object(native.sys, "argv", ["build-native.py", "--configuration", "release", "--test", "--swift-scratch-path", str(scratch)]), \
                    patch.object(native, "rust_channel", return_value="1.93.1"), \
                    patch.object(native, "node_runtime", return_value=()), patch.object(native, "verify_task_view"), \
                    patch.object(native.shutil, "copy2") as copy, patch.object(native, "run") as run, \
                    patch.object(native, "package_app") as package:
                native.main()
            self.assertEqual(copy.call_args.args[0], root / "target/release/libhetu_core.dylib")
            self.assertEqual(package.call_args.args[-2:], (scratch / "release", "release"))
            commands = [call.args[0] for call in run.call_args_list]
            self.assertIn(["cargo", "build", "--locked", "--release"], commands)
            for command in commands:
                if command[:2] == ["cargo", "test"]:
                    self.assertIn("--release", command)
                if command[0] == "swift":
                    self.assertEqual(command[command.index("--configuration") + 1], "release")
                    self.assertEqual(command[command.index("--scratch-path") + 1], str(scratch))
            ffi = next(command for command in commands if any("verify-ffi.py" in arg for arg in command))
            self.assertEqual(ffi[-1], str(scratch / "release/hetu"))


if __name__ == "__main__":
    unittest.main()
