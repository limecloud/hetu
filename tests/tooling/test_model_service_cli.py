"""用隔离用户目录核验模型服务 CLI 的连接恢复与凭据边界，不访问线上服务。"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
CLI = Path(os.environ.get("HETU_TEST_CLI", ROOT / ".build/debug/hetu")).resolve()


class ModelServiceCLITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hetu-model-cli-")
        self.addCleanup(self.directory.cleanup)
        self.user_directory = Path(self.directory.name)
        self.connection = self.user_directory / "Library/Application Support/Hetu/ModelService/connection.json"

    def run_cli(self, *arguments):
        return subprocess.run(
            [str(CLI), "model-service", *arguments], text=True, capture_output=True,
            env={**os.environ, "HOME": str(self.user_directory)}, timeout=30,
        )

    def seed(self, **fields):
        self.connection.parent.mkdir(parents=True)
        self.connection.write_text(json.dumps(fields))

    def test_disconnected_status_requires_no_workspace_or_network(self):
        result = self.run_cli("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["status"], "succeeded")
        self.assertEqual(value["data"]["connection_state"], "disconnected")
        self.assertFalse(value["data"]["connected"])

    def test_status_exposes_pairing_instructions_but_never_credentials(self):
        self.seed(token="private-device-token", refresh_token="private-refresh-token",
                  pending={"verification_uri": "https://hetu.limeai.run/console/?connect=" + "a" * 64,
                           "verification_code": "AAAAAAAA", "secret": "private-pairing-secret"},
                  custom_channels={"private": {"api_key": "private-provider-key"}})
        result = self.run_cli("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)["data"]
        self.assertEqual(value["connection_state"], "pending")
        self.assertEqual(value["pending"]["verification_code"], "AAAAAAAA")
        for secret in ["private-device-token", "private-refresh-token", "private-pairing-secret", "private-provider-key"]:
            self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertNotIn("custom_channels", value)

    def test_completed_poll_replays_locally_without_starting_another_login(self):
        self.seed(token="private-device-token", account_ref="a" * 64, origin="https://hetu.limeai.run",
                  environment="sandbox", expires_at=int(time.time()) + 600)
        before = self.connection.read_bytes()
        results = [self.run_cli("poll") for _ in range(2)]
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["data"]["connection_state"], "connected")
        self.assertEqual(results[0].stdout, results[1].stdout)
        self.assertEqual(before, self.connection.read_bytes())

    def test_poll_without_pending_connection_has_no_network_side_effect(self):
        result = self.run_cli("poll")
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)["data"]
        self.assertEqual(value["connection_state"], "disconnected")
        self.assertEqual(value["next_action"], "hetu model-service login")
        self.assertFalse(self.connection.exists())

    def test_expired_connection_guides_login_without_polling_or_changing_credentials(self):
        self.seed(token="private-device-token", account_ref="a" * 64, expires_at=int(time.time()) - 60)
        before = self.connection.read_bytes()
        for command in ["status", "poll"]:
            result = self.run_cli(command)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)["data"]
            self.assertEqual(value["connection_state"], "expired")
            self.assertEqual(value["next_action"], "hetu model-service login")
            self.assertNotIn("private-device-token", result.stdout + result.stderr)
        self.assertEqual(before, self.connection.read_bytes())

    def test_commands_cannot_set_keys_disconnect_or_approve_model_usage(self):
        self.seed(token="private-device-token", expires_at=0)
        before = self.connection.read_bytes()
        for arguments in [("disconnect",), ("custom_save",), ("approve",),
                          ("login", "--author"), ("login", "--key", "forged-key"),
                          ("status", "--input", "-")]:
            with self.subTest(arguments=arguments):
                result = self.run_cli(*arguments)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(before, self.connection.read_bytes())


if __name__ == "__main__":
    unittest.main()
