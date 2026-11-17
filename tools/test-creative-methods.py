#!/usr/bin/env python3
"""核验剧本／视频方法导航；不把文本覆盖当作业务或创作质量验收。"""
import json
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
LINK = re.compile(r"\[[^\]\n]+\]\(([^)]+)\)")
ACTION = re.compile(r"`(hetu\.[a-z0-9_.]+)`")


def local_links(package, path):
    targets = set()
    for link in LINK.findall(path.read_text(encoding="utf-8")):
        url = urlsplit(link.strip("<>"))
        if url.scheme or url.netloc:
            continue
        target = (path.parent / unquote(url.path)).resolve()
        if not target.is_relative_to(package.resolve()) or not target.is_file():
            raise ValueError(f"引用缺失或越界：{path.name}: {link}")
        targets.add(target)
    return targets


def audit(package, actions, skill, prefix, count):
    entry = package / "skills" / skill / "SKILL.md"
    links = local_links(package, entry)
    plan = package / "references/workflows" / f"{skill[5:]}-planning.md"
    operations = plan.with_name(f"{skill[5:]}-operations.md")
    for path in [plan, operations]:
        if path.resolve() not in links:
            raise ValueError(f"Skill入口未直接导航：{path.name}")
        local_links(package, path)
    journeys = set(re.findall(rf"\b{prefix}-\d{{2}}\b", plan.read_text(encoding="utf-8")))
    expected = {f"{prefix}-{index:02}" for index in range(1, count + 1)}
    if journeys != expected:
        raise ValueError(f"旅程覆盖不符：{sorted(expected - journeys)}")
    rows = [row for row in operations.read_text(encoding="utf-8").splitlines() if row.startswith("|")]
    for action in actions:
        if action["skill"] != skill:
            continue
        matching = [row for row in rows if action["action"] in ACTION.findall(row)]
        if not matching:
            raise ValueError(f"动作未导航：{action['action']}")
        if "fixed_proposal" in action["routes"] and not all("固定方案" in row for row in matching):
            raise ValueError(f"动作缺少固定方案边界：{action['action']}")
    return {"skill": skill, "journeys": len(journeys), "actions": sum(a["skill"] == skill for a in actions)}


class CreativeMethodsTest(unittest.TestCase):
    def test_generated_drama_methods_cover_actual_contract(self):
        actions = json.loads((ROOT / "contracts/capability-map.json").read_text())["actions"]
        result = audit(ROOT / "integrations/codex/hetu", actions, "hetu-drama", "DRM", 12)
        self.assertGreaterEqual(result["actions"], 28)

    def test_generated_video_methods_cover_actual_contract(self):
        actions = json.loads((ROOT / "contracts/capability-map.json").read_text())["actions"]
        result = audit(ROOT / "integrations/codex/hetu", actions, "hetu-video", "VID", 14)
        self.assertGreaterEqual(result["actions"], 7)

    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        entry = root / "skills/hetu-drama/SKILL.md"
        entry.parent.mkdir(parents=True)
        entry.write_text("[规划](../../references/workflows/drama-planning.md)\n[操作](../../references/workflows/drama-operations.md)\n")
        plan = root / "references/workflows/drama-planning.md"
        plan.parent.mkdir(parents=True)
        plan.write_text("DRM-01\n")
        ops = plan.with_name("drama-operations.md")
        ops.write_text("| 维护 | `hetu.drama.projects.update` | 固定方案 |\n")
        actions = [{"action": "hetu.drama.projects.update", "skill": "hetu-drama", "routes": ["fixed_proposal"]}]
        return root, entry, plan, ops, actions

    def test_missing_or_prefix_only_action_is_rejected(self):
        root, _, _, ops, actions = self.fixture()
        ops.write_text("| 维护 | `hetu.drama.projects.update_extra` | 固定方案 |\n")
        with self.assertRaisesRegex(ValueError, "动作未导航"):
            audit(root, actions, "hetu-drama", "DRM", 1)

    def test_direct_author_action_without_proposal_is_rejected(self):
        root, _, _, ops, actions = self.fixture()
        ops.write_text("| 维护 | `hetu.drama.projects.update` | 直接执行 |\n")
        with self.assertRaisesRegex(ValueError, "固定方案边界"):
            audit(root, actions, "hetu-drama", "DRM", 1)

    def test_missing_journey_is_rejected(self):
        root, _, _, _, actions = self.fixture()
        with self.assertRaisesRegex(ValueError, "旅程覆盖"):
            audit(root, actions, "hetu-drama", "DRM", 2)

    def test_unreachable_method_is_rejected(self):
        root, entry, _, _, actions = self.fixture()
        entry.write_text("[规划](../../references/workflows/drama-planning.md)")
        with self.assertRaisesRegex(ValueError, "未直接导航"):
            audit(root, actions, "hetu-drama", "DRM", 1)

    def test_missing_link_target_is_rejected(self):
        root, _, plan, _, actions = self.fixture()
        plan.write_text("DRM-01\n[缺失](missing.md)")
        with self.assertRaisesRegex(ValueError, "引用缺失或越界"):
            audit(root, actions, "hetu-drama", "DRM", 1)

    def test_existing_file_outside_package_is_rejected(self):
        root, _, plan, _, actions = self.fixture()
        outside = ROOT / "tools/test-creative-methods.py"
        plan.write_text(f"DRM-01\n[越界]({outside})")
        with self.assertRaisesRegex(ValueError, "引用缺失或越界"):
            audit(root, actions, "hetu-drama", "DRM", 1)


if __name__ == "__main__":
    unittest.main()
