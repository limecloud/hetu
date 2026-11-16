import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("electron_release", ROOT / "tools/release-electron.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ElectronReleaseTests(unittest.TestCase):
    def test_final_inventory_tracks_signed_bytes_and_framework_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "binary").write_bytes(b"signed")
            (root / "Current").symlink_to("binary")
            inventory = release.artifact_inventory(root)
            self.assertEqual(inventory["Current"], {"symlink": "binary"})
            self.assertEqual(inventory["binary"]["size_bytes"], 6)
            (root / "binary").write_bytes(b"stapled")
            self.assertNotEqual(inventory["binary"]["sha256"], release.artifact_inventory(root)["binary"]["sha256"])

    def test_development_identity_and_wrong_version_fail_before_signing_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Hetu.app"
            (app / "Contents").mkdir(parents=True)
            for identity, version in [("run.limeai.hetu.electron.dev", "0.8.0"), ("run.limeai.hetu.electron", "0.7.0")]:
                (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
                    "CFBundleIdentifier": identity, "CFBundleShortVersionString": version,
                }))
                with patch.object(release.macos, "verify_signature") as verify:
                    with self.assertRaisesRegex(SystemExit, "身份或版本"):
                        release.verify_package(app, "0.8.0", "ABCDEFGHIJ")
                    verify.assert_not_called()

    def test_existing_notarization_receipt_prevents_rebuilding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "build/electron-release-evidence").mkdir(parents=True)
            with patch.object(release, "ROOT", root), patch.object(release, "assemble") as assemble:
                with self.assertRaisesRegex(SystemExit, "保留原结果"):
                    release.package("node", b"certificate", "0.8.0")
                assemble.assert_not_called()
