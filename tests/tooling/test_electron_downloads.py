import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("electron_downloads", ROOT / "tools/verify-electron-downloads.py")
downloads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloads)


class DownloadTests(unittest.TestCase):
    def fixture(self, root):
        for platform, architecture in [("macos", "arm64"), ("windows", "x64"), ("linux", "x64")]:
            target = f"{platform}-{architecture}"
            directory = root / f"hetu-electron-{target}"
            directory.mkdir()
            suffix = "" if platform == "macos" else f"-{target}"
            files = {}
            for extension in ([".zip", ".dmg"] if platform == "macos" else [".zip"] if platform == "windows" else [".tar.gz"]):
                file = directory / f"Hetu-0.9.0-{target}{extension}"
                file.write_bytes(b"fixed-release")
                files[file.name] = downloads.sha256(file)
            manifest = directory / f"release-manifest{suffix}.json"
            manifest.write_text(json.dumps({"kind": "electron-release-package", "git_sha": "fixed-sha", "version": "0.9.0",
                "platform": platform, "architecture": architecture, "files": files,
                "signing": "developer-id" if platform == "macos" else "unsigned",
                "notarization_status": "Accepted" if platform == "macos" else "not-applicable", "dmg_notarization_id": "receipt"}))
            files[manifest.name] = downloads.sha256(manifest)
            (directory / f"SHA256SUMS{suffix}").write_text("".join(f"{digest}  {name}\n" for name, digest in files.items()))

    def test_requires_all_three_platforms_with_matching_source_and_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.fixture(root)
            self.assertEqual(len(downloads.verify(root, "fixed-sha", "v0.9.0")), 7)
            with self.assertRaises(AssertionError):
                downloads.verify(root, "other-sha", "v0.9.0")
            file = root / "hetu-electron-windows-x64/Hetu-0.9.0-windows-x64.zip"
            file.write_bytes(b"changed")
            with self.assertRaisesRegex(AssertionError, "摘要"):
                downloads.verify(root, "fixed-sha", "v0.9.0")

    def test_missing_platform_cannot_publish_partial_release(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(FileNotFoundError):
                downloads.verify(Path(folder), "fixed-sha", "v0.9.0")
