#!/usr/bin/env python3
"""经公开 CLI 从分集入口核验固定交付，不改稿、不采纳、不定稿。"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def verify(cli, management_ref, project_id, client="codex", collaboration_dir=None):
    def call(action, fields):
        args = [str(cli), "--client", client]
        if collaboration_dir:
            args += ["--collaboration-dir", str(collaboration_dir)]
        args += ["call", "hetu." + action, "--input", "-"]
        request = {"management_ref": management_ref, **fields}
        result = subprocess.run(args, input=json.dumps(request, ensure_ascii=False), text=True, capture_output=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f"{action}: {result.stdout or result.stderr}")
        envelope = json.loads(result.stdout)
        if envelope.get("status") != "succeeded":
            raise RuntimeError(f"{action}: {envelope.get('error')}")
        return envelope["data"]

    project = call("drama.projects.get", {"project_id": project_id})
    episodes = []
    for row in project["episodes"]:
        episode_id = row["episode"]["episode_id"]
        reading = call("drama.episodes.get", {"episode_id": episode_id})
        manuscript = reading.get("manuscript")
        if manuscript is None:
            raise RuntimeError("当前 Core 缺少分集阅读投影，不能证明分集可读。")
        submitted = [r for r in manuscript["references"] if r["kind"] == "submitted"]
        if not submitted:
            raise RuntimeError(f"第 {row['episode_number']} 集缺少已提交参考稿。")
        candidates = []
        for ref in submitted:
            draft = call("drafts.get", {"draft_id": ref["draft_ref"]["draft_id"]})
            content = draft["content"]
            sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
            if not content.strip() or sha != ref["sha256"] or draft["draft"]["source_format"] != "fountain":
                raise RuntimeError(f"第 {row['episode_number']} 集正文为空、摘要不符或格式不符。")
            candidates.append({"task_ref": ref["task_ref"], "submission_id": ref["submission_id"], "draft_ref": ref["draft_ref"], "sha256": sha, "size_bytes": len(content.encode("utf-8"))})
        episodes.append({"episode_id": episode_id, "number": row["episode_number"], "author_state": manuscript["author_state"], "references": candidates})
    if not episodes:
        raise RuntimeError("项目尚无分集，不能作为剧本交付。")
    return {"status": "passed", "scope": "episode_entry_fixed_submission_readback", "project_id": project_id, "episodes": episodes,
            "limits": "只证明分集入口和固定正文可回读；不替代原著覆盖、改编质量、GUI、资产图像或正式交付审核。"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path)
    parser.add_argument("--management-ref", required=True, type=Path)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--collaboration-dir", type=Path)
    parser.add_argument("--client", default="codex")
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.cli, json.loads(args.management_ref.read_text()), args.project_id, args.client, args.collaboration_dir)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
        result = {"status": "failed", "scope": "episode_entry_fixed_submission_readback", "project_id": args.project_id, "error": str(error)}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    if result["status"] != "passed":
        print("分集交付核验失败：" + result["error"], file=sys.stderr)
        return 1
    print(f"分集入口与固定参考稿核验通过：{len(result['episodes'])}集。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
