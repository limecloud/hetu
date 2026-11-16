#!/usr/bin/env python3
"""发布前三平台附件核验；缺包、错源码、摘要变化或开发包均失败关闭。"""
import argparse
import hashlib
import json
from pathlib import Path


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def verify(root, git_sha, tag):
    names = set()
    for platform, architecture in [("macos", "arm64"), ("windows", "x64"), ("linux", "x64")]:
        target = f"{platform}-{architecture}"
        directory = root / f"hetu-electron-{target}"
        suffix = "" if platform == "macos" else f"-{target}"
        manifest_name = f"release-manifest{suffix}.json"
        sums = directory / f"SHA256SUMS{suffix}"
        checksums = {}
        for line in sums.read_text().splitlines():
            digest, name = line.split("  ", 1)
            assert len(digest) == 64 and all(c in "0123456789abcdef" for c in digest), "无效摘要"
            assert Path(name).name == name and name not in checksums and name not in names, "重复或不安全附件名"
            assert sha256(directory / name) == digest, f"附件摘要不一致：{name}"
            checksums[name] = digest
            names.add(name)
        manifest = json.loads((directory / manifest_name).read_text())
        assert manifest_name in checksums, "清单未被摘要覆盖"
        assert manifest["kind"] == "electron-release-package", "拒绝开发或本机安装包"
        assert manifest["git_sha"] == git_sha and "v" + manifest["version"] == tag, "源码或版本不一致"
        assert manifest["platform"] == platform and manifest["architecture"] == architecture, "平台不一致"
        expected_files = {f"Hetu-{manifest['version']}-{target}{extension}" for extension in (
            [".dmg", ".zip"] if platform == "macos" else [".zip"] if platform == "windows" else [".tar.gz"]
        )}
        assert set(manifest["files"]) == expected_files, "下载包缺失或名称不一致"
        assert set(checksums) == expected_files | {manifest_name}, "附件清单不完整"
        assert set(p.name for p in directory.iterdir()) == set(checksums) | {sums.name}, "存在未核验附件"
        assert all(checksums[name] == digest for name, digest in manifest["files"].items()), "清单摘要不一致"
        if platform == "macos":
            assert manifest["signing"] == "developer-id" and manifest["notarization_status"] == "Accepted", "Mac 签名或公证未通过"
            assert manifest.get("dmg_notarization_id"), "缺少 DMG 公证证据"
        else:
            assert manifest["signing"] == "unsigned" and manifest["notarization_status"] == "not-applicable", "签名状态不一致"
    return sorted(names)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--git-sha", required=True)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    files = verify(args.directory, args.git_sha, args.tag)
    print(f"三平台下载核验通过：{len(files)} 个文件。")
