"""全书导出验收的固定样本与文件辅助函数。"""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/fixtures/book-journey"


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def manuscript() -> tuple[dict, list[dict]]:
    book = json.loads((FIXTURE / "book.json").read_text())
    source = (FIXTURE / "manuscript.md").read_text()
    chapters = []
    volume = None
    for section in re.split(r"(?=^#{1,2} )", source, flags=re.M):
        heading, _, body = section.partition("\n")
        if heading.startswith("# "):
            volume = heading[2:]
        elif heading.startswith("## "):
            chapters.append({"title": heading[3:], "volume": volume,
                             "content": body.strip() + "\n"})
    assert len(chapters) == 10 and len({c["volume"] for c in chapters}) == 2
    assert sum(len(c["content"]) for c in chapters) > 9000
    assert chapters[-1]["content"].endswith("（完）\n")
    return book, chapters
