#!/usr/bin/env python3
"""用独立 MuPDF 解析器核对全书 PDF，并输出逐页预览与联系表。"""

import argparse
import json
import struct
import zlib
from pathlib import Path

import pymupdf

from book_journey import FIXTURE, manuscript, write_json


def png(path, width, height, pixels):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + pixels[y * width * 3:(y + 1) * width * 3] for y in range(height))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def inspect(workspace):
    out = workspace.parent / (workspace.name + "-验收")
    state = json.loads((out / "state.json").read_text())
    _, chapters = manuscript()
    reports = {}
    for tag in ["novel-pdf", "drama-pdf"]:
        path = workspace / state.get("latest_exports", {}).get(tag, state[tag])["path"]
        folder = out / tag
        folder.mkdir(exist_ok=True)
        with pymupdf.open(path) as document:
            texts, thumbs, errors = [], [], []
            font_names = set()
            for index, page in enumerate(document):
                # 页码属于页脚，按位置排除；不能删除正文里的数字。
                body = pymupdf.Rect(0, 0, page.rect.width, page.rect.height - 62.362)
                text = page.get_text(clip=body)
                texts.append(text)
                footer = page.get_text(clip=pymupdf.Rect(0, body.y1, page.rect.width, page.rect.height)).strip()
                assert footer == str(index + 1), f"页码错误：{index + 1}，{footer!r}"
                if "\ufffd" in text or "\x00" in text:
                    errors.append({"page": index + 1, "reason": "replacement glyph"})
                for block in page.get_text("dict")["blocks"]:
                    for line in block.get("lines", []):
                        for span in line["spans"]:
                            x0, y0, x1, y1 = span["bbox"]
                            if x0 < -1 or y0 < -1 or x1 > page.rect.width + 1 or y1 > page.rect.height + 1:
                                errors.append({"page": index + 1, "reason": "text outside page", "span": span})
                for font in page.get_fonts(full=True):
                    font_names.add(font[3])
                    assert document.extract_font(font[0])[3], f"字体未嵌入：{font}"
                preview = page.get_pixmap(matrix=pymupdf.Matrix(0.4, 0.4), alpha=False)
                thumbs.append(preview)
                page.get_pixmap(matrix=pymupdf.Matrix(1.2, 1.2), alpha=False).save(folder / f"page-{index + 1:02d}.png")
            text = "\n".join(texts)
            (folder / "text.txt").write_text(text)
            compact = lambda value: "".join(value.split())
            if tag == "novel-pdf":
                positions = [text.index(c["title"]) for c in chapters]
                assert positions == sorted(positions)
                assert all(compact(c["content"]) in compact(text) for c in chapters), "PDF 全文与原著不一致"
                assert "后续写作稿：这里还未重新定稿" not in text
                if state.get("latest_exports"):
                    for chapter in chapters:
                        page_text = next(t for t in texts if chapter["title"] in t)
                        assert page_text.lstrip().startswith(chapter["title"]), "章节没有另起一页"
            else:
                assert all(f"第{i}集" in text for i in range(1, 6))
                assert "沈砚" in text and "许禾" in text and "曹岑" in text
                expected = []
                for line in (FIXTURE / "drama.fountain").read_text().splitlines():
                    if line.startswith(("Title: ", "Author: ")):
                        expected.append(line.split(": ", 1)[1])
                    elif line.startswith("Language:"):
                        continue
                    elif line.startswith("# "):
                        expected.append(line[2:])
                    elif line.startswith("@"):
                        expected.append(line[1:])
                    else:
                        expected.append(line)
                assert compact("\n".join(expected)) == compact(text), "剧本 PDF 的场次、动作或对白不一致"
            assert not errors, errors
            columns = 5
            cell_width = max(p.width for p in thumbs) + 8
            cell_height = max(p.height for p in thumbs) + 8
            width = columns * cell_width
            height = ((len(thumbs) + columns - 1) // columns) * cell_height
            pixels = bytearray(b"\xff" * width * height * 3)
            for index, pixmap in enumerate(thumbs):
                x = (index % columns) * cell_width
                y = (index // columns) * cell_height
                source = pixmap.samples
                for row in range(pixmap.height):
                    start = ((y + row) * width + x) * 3
                    pixels[start:start + pixmap.width * 3] = source[row * pixmap.stride:row * pixmap.stride + pixmap.width * 3]
            png(folder / "contact-sheet.png", width, height, pixels)
            reports[tag] = {"path": str(path), "pages": len(document), "fonts": sorted(font_names),
                            "text_matches": True, "out_of_bounds": errors,
                            "contact_sheet": str(folder / "contact-sheet.png")}
            print(f"{tag}：{len(document)} 页，全文与顺序一致，字体已嵌入，无越界文字。")
    write_json(out / "pdf-inspection.json", reports)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    inspect(parser.parse_args().workspace.resolve())
