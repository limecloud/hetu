#!/usr/bin/env python3
"""河图小说导入：原稿快照、可审阅目录、固定批次与原键接续。只使用公开 Agent CLI。"""
import argparse
import base64
import hashlib
import io
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
import zipfile

MAX_SOURCE = 64 * 1024 * 1024
MAX_EXPANDED = 64 * 1024 * 1024
CHAPTER = re.compile(r"^(?:第(?P<zh>[0-9零〇一二三四五六七八九十百千万两]+)(?:章|节|回(?=\s|[：:、.．]|$))[^\r\n]{0,76}|Chapter\s+(?P<en>[0-9IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)(?:\b[^\r\n]{0,76}))$", re.I)
VOLUME = re.compile(r"^(?:第[0-9零〇一二三四五六七八九十百千万两]+卷[^\r\n]{0,76}|(?:Book|Part)\s+[0-9IVXLCDM]+\b[^\r\n]{0,76})$", re.I)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
    temporary = path.with_name(path.name + ".pending")
    with temporary.open("wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    temporary.replace(path)


class ReadingHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if not self.skip and tag in ("p", "div", "br", "h1", "h2", "h3", "li"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        if not self.skip and tag in ("p", "div", "h1", "h2", "h3", "li"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def decode(raw, encoding=None):
    if encoding:
        return raw.decode(encoding), encoding
    for marker, codec in [(b"\xff\xfe", "utf-16"), (b"\xfe\xff", "utf-16"), (b"\xef\xbb\xbf", "utf-8-sig")]:
        if raw.startswith(marker):
            return raw.decode(codec), codec
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return raw.decode("gb18030"), "gb18030"


def archive(raw_path):
    z = zipfile.ZipFile(raw_path)
    entries = z.infolist()
    if len(entries) > 10000 or sum(x.file_size for x in entries) > MAX_EXPANDED:
        z.close()
        raise ValueError("压缩文档超过解析预算，请分卷或转换后继续。")
    for x in entries:
        p = PurePosixPath(x.filename)
        if p.is_absolute() or ".." in p.parts or "\\" in x.filename or x.flag_bits & 1:
            z.close()
            raise ValueError("文档包含越界路径或加密条目。")
    if len({x.filename for x in entries}) != len(entries):
        z.close()
        raise ValueError("文档包含重名条目，无法确定原稿。")
    return z


def read_source(path, encoding=None):
    raw = path.read_bytes()
    if not raw or len(raw) > MAX_SOURCE:
        raise ValueError("原稿为空或超过64 MiB，请按原有分卷拆分。")
    suffix = path.suffix.lower()
    warnings = []
    if suffix == ".docx":
        with archive(io.BytesIO(raw)) as z:
            root = ET.fromstring(z.read("word/document.xml"))
        ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        paragraphs = []
        for p in root.iter(ns + "p"):
            parts = []
            for child in p.iter():
                if child.tag == ns + "t": parts.append(child.text or "")
                elif child.tag in (ns + "br", ns + "cr"): parts.append("\n")
                elif child.tag == ns + "tab": parts.append("\t")
            paragraphs.append("".join(parts))
        text, codec = "\n\n".join(paragraphs), "docx-reading-order"
        warnings.append("Word按段落提取正文；批注、修订标记、图片与富文本样式保留在原文件快照，未还原为正文。")
    elif suffix == ".epub":
        with archive(io.BytesIO(raw)) as z:
            container = ET.fromstring(z.read("META-INF/container.xml"))
            opf = next(x.attrib["full-path"] for x in container.iter() if x.tag.endswith("}rootfile"))
            package = ET.fromstring(z.read(opf))
            items = {x.attrib["id"]: x.attrib["href"] for x in package.iter() if x.tag.endswith("}item")}
            text_parts = []
            from urllib.parse import unquote
            import posixpath
            for x in package.iter():
                if not x.tag.endswith("}itemref"): continue
                name = posixpath.normpath(posixpath.join(posixpath.dirname(opf), unquote(items[x.attrib["idref"]]).split("#")[0]))
                if name.startswith("../") or name.startswith("/"): raise ValueError("EPUB阅读顺序指向文档外。")
                data = z.read(name)
                declaration = re.match(br'\s*<\?xml[^>]*encoding=[\"\x27]([^\"\x27]+)', data[:256])
                codec = declaration.group(1).decode("ascii") if declaration else None
                html, _ = decode(data, codec)
                parser = ReadingHTML(); parser.feed(html); text_parts.append("".join(parser.parts))
        text, codec = "\n\n".join(text_parts), "epub-spine"
        warnings.append("EPUB按spine提取正文；未列入阅读顺序的封面、附件和版式保留在原始快照。")
    elif suffix in (".html", ".htm", ".xhtml"):
        html, codec = decode(raw, encoding); parser = ReadingHTML(); parser.feed(html); text = "".join(parser.parts)
        warnings.append("HTML提取可读文字，不执行脚本；样式和图片保留在原始快照。")
    elif suffix in (".txt", ".md", ".markdown", ".text"):
        text, codec = decode(raw, encoding)
    else:
        raise ValueError("此格式需要Agent先选择转换或OCR方法；支持直接读取TXT、Markdown、DOCX、EPUB和HTML。")
    if not text.strip() or "\x00" in text or len(text.encode()) > MAX_EXPANDED:
        raise ValueError("未获得有效阅读文本，请核对格式和编码。")
    return raw, text, codec, warnings


def chapter_number(match):
    s = match.group("zh") or match.group("en") or ""
    if s.isdecimal(): return int(s)
    names = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
    if s.lower() in names: return names.index(s.lower()) + 1
    if re.fullmatch("[IVXLCDM]+", s, re.I):
        values = dict(I=1, V=5, X=10, L=50, C=100, D=500, M=1000)
        total, previous = 0, 0
        for char in reversed(s.upper()):
            value = values[char]; total += -value if value < previous else value; previous = max(previous, value)
        return total
    digits = dict(zip("零〇一二三四五六七八九两", [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 2]))
    units = {"十": 10, "百": 100, "千": 1000, "万": 10000}
    number, total = 0, 0
    for char in s:
        if char in digits: number = digits[char]
        elif char in units:
            unit = units[char]
            if unit == 10000: total = (total + number) * unit
            else: total += (number or 1) * unit
            number = 0
        else: return None
    if s: return total + number
    return None


def make_layout(text, pattern=None):
    custom = re.compile(pattern) if pattern else None
    markers, warnings = [], []
    offset, current_volume, group, previous = 0, None, 0, None
    for line in text.splitlines(keepends=True):
        label = re.sub(r"^#{1,6}\s+", "", line.strip()).strip()
        if VOLUME.fullmatch(label):
            current_volume = label; group += 1
            markers.append({"start": offset, "title": label, "volume": label, "kind": "volume_heading"})
            previous = None
        else:
            match = CHAPTER.fullmatch(label)
            if (custom and custom.fullmatch(label)) or (not custom and match):
                number = chapter_number(match) if match else None
                if number == 1 and previous and previous > 1:
                    group += 1; current_volume = f"第{group}部分"
                    warnings.append(f"章号重新从1开始：{label}；按原稿顺序提出新分组，卷名须由Agent核对。")
                if group == 0: group = 1
                if current_volume is None: current_volume = "第1部分"
                if number is not None and previous is not None and number <= previous and number != 1:
                    warnings.append(f"保留重号或倒序标题：{label}")
                markers.append({"start": offset, "title": label, "volume": current_volume, "kind": "chapter"})
                if number is not None: previous = number
        offset += len(line)
    if not markers:
        warnings.append("未识别可靠章标题；保留完整原稿。Agent应核对后提供layout或章节模式。")
        return [{"start": 0, "end": len(text), "title": "原稿", "volume": "原稿", "kind": "unstructured"}], warnings
    if markers[0]["start"]:
        markers.insert(0, {"start": 0, "title": "作品说明", "volume": "作品说明", "kind": "front_matter"})
    for i, marker in enumerate(markers):
        marker["end"] = markers[i + 1]["start"] if i + 1 < len(markers) else len(text)
    return markers, warnings


def validate_layout(text, units):
    cursor = 0
    if not units: raise ValueError("目录不能为空。")
    for u in units:
        if type(u.get("start")) is not int or type(u.get("end")) is not int or u["start"] != cursor or not cursor < u["end"] <= len(text):
            raise ValueError("目录范围必须从0连续覆盖全文，不能重叠、遗漏或产生空章。")
        if not u.get("title", "").strip() or len(u["title"]) > 200 or not u.get("volume", "").strip():
            raise ValueError("目录标题或分卷无效。")
        cursor = u["end"]
    if cursor != len(text): raise ValueError("目录未覆盖原稿结尾。")


def plan(args):
    source = args.source.resolve(); output = args.output.resolve()
    if output.exists() and any(output.iterdir()): raise ValueError("导入记录目录已存在，请沿原plan和journal继续。")
    raw, text, codec, warnings = read_source(source, args.encoding)
    if args.layout:
        units = json.loads(args.layout.read_text())["units"]
    else:
        units, notes = make_layout(text, args.chapter_pattern); warnings += notes
    validate_layout(text, units)
    volumes = {}
    for i, u in enumerate(units):
        volume = u["volume"]
        if volume not in volumes: volumes[volume] = "volume_" + str(uuid.uuid4())
        u.update(index=i, volume_id=volumes[volume], content_sha256=sha(text[u["start"]:u["end"]].encode()))
    output.mkdir(parents=True, exist_ok=True)
    (output / "source.bin").write_bytes(raw); (output / "reading.txt").write_bytes(text.encode())
    value = {"schema_version": "1.0.0", "source_name": source.name, "source_path": str(source), "source_sha256": sha(raw), "encoding": codec, "reading_sha256": sha(text.encode()), "reading_characters": len(text), "volumes": [{"volume_id": value, "title": key} for key, value in volumes.items()], "units": units, "warnings": warnings}
    save(output / "plan.json", value)
    print(json.dumps({"plan": str(output / "plan.json"), "source_sha256": value["source_sha256"], "documents": len(units), "chapters": sum(x.get("kind") == "chapter" for x in units), "volumes": len(volumes), "warnings": warnings}, ensure_ascii=False))


def loaded(path):
    value = json.loads(path.read_text()); folder = path.parent
    if sha((folder / "source.bin").read_bytes()) != value["source_sha256"]: raise ValueError("原文件快照摘要变化。")
    text = (folder / "reading.txt").read_bytes().decode("utf-8")
    if sha(text.encode()) != value["reading_sha256"]: raise ValueError("阅读文本摘要变化。")
    validate_layout(text, value["units"])
    for u in value["units"]:
        if sha(text[u["start"]:u["end"]].encode()) != u["content_sha256"]: raise ValueError("章节范围或摘要变化。")
    return value, text


def command(args):
    path = args.plan.resolve(); manifest, text = loaded(path); journal_path = path.parent / "journal.json"
    plan_sha = sha(path.read_bytes())
    journal = json.loads(journal_path.read_text()) if journal_path.exists() else {"source_sha256": manifest["source_sha256"], "plan_sha256": plan_sha, "next_index": 0, "imported": [], "volumes_ready": False}
    if journal["plan_sha256"] != plan_sha: raise ValueError("导入目录在开始后发生变化，请保留原计划和原操作。")
    if args.command == "status":
        print(json.dumps({"source": manifest["source_name"], "total_documents": len(manifest["units"]), "verified_documents": journal["next_index"], "remaining": len(manifest["units"]) - journal["next_index"], "pending": journal.get("pending", {}).get("proposal_id"), "warnings": manifest["warnings"]}, ensure_ascii=False)); return
    reference = json.loads(args.management_ref.read_text())
    if reference.get("scope_ref", {}).get("kind") != "workspace": raise ValueError("需要确切已有小说作品的management_ref。")
    if journal.get("scope_ref", reference["scope_ref"]) != reference["scope_ref"] or journal["source_sha256"] != manifest["source_sha256"]: raise ValueError("此导入记录已绑定其他作品或原稿。")
    journal["scope_ref"] = reference["scope_ref"]
    def invoke(action, fields):
        cmd = [str(args.cli.resolve()), "--client", args.client]
        if args.collaboration_dir: cmd += ["--collaboration-dir", str(args.collaboration_dir.resolve())]
        request = {"management_ref": reference, **fields}
        result = subprocess.run(cmd + ["call", "hetu." + action, "--input", "-"], input=json.dumps(request, ensure_ascii=False), capture_output=True, text=True, timeout=300)
        value = json.loads(result.stdout)
        log = path.parent / "receipts.jsonl"
        with log.open("a") as f: f.write(json.dumps({"action": action, "input_sha256": sha(json.dumps(request, sort_keys=True, ensure_ascii=False).encode()), "exit_code": result.returncode, "result": value}, ensure_ascii=False) + "\n")
        if result.returncode or value.get("status") != "succeeded": raise ValueError(json.dumps(value, ensure_ascii=False))
        return value["data"]
    if args.command == "prepare":
        if journal.get("pending"):
            pending = journal["pending"]
            if pending.get("proposal_id"):
                current = invoke("agent_operations.get", {"proposal_id": pending["proposal_id"]})
                print(json.dumps({"proposal_id": current["proposal_id"], "proposal_sha256": current["proposal_sha256"], "state": current["state"], "journal": str(journal_path)}, ensure_ascii=False)); return
            prepared = invoke("agent_operations.prepare", pending["prepare_input"])
        else:
            if journal["next_index"] >= len(manifest["units"]): print("所有章节已导入并核对。"); return
            current = invoke("novels.get", {})
            if not journal["volumes_ready"]:
                fields = {"expected": {"revision": current["revision"], "sha256": current["sha256"]}, "volumes": current["novel"]["volumes"] + manifest["volumes"], "chapters": current["novel"]["chapters"]}
                action, summary, indices = "novels.save_structure", "导入原稿的分卷目录", []
            else:
                items, indices = [], []
                for u in manifest["units"][journal["next_index"]:]:
                    data = text[u["start"]:u["end"]].encode()
                    item = {"source": {"inline_source": {"filename": f"{u['index'] + 1:06}.txt", "base64": base64.b64encode(data).decode(), "sha256": sha(data)}, "format": "txt", "profile": "source/1"}, "title": u["title"], "language_tag": args.locale, "volume_id": u["volume_id"]}
                    if items and (len(items) >= 32 or len(json.dumps(items + [item], ensure_ascii=False).encode()) > 768 * 1024): break
                    items.append(item); indices.append(u["index"])
                fields = {"expected": {"revision": current["revision"], "sha256": current["sha256"]}, "items": items, "acknowledgement": "按固定原稿范围导入，保留原文、来源和重复标题；不采纳AI稿，不标为定稿。"}
                action, summary = "documents.import_batch", f"导入原稿第{indices[0] + 1}至{indices[-1] + 1}篇，共{len(items)}篇"
            key = "import-" + manifest["source_sha256"][:20] + "-" + (str(indices[0]) if indices else "volumes")
            fields["operation_key"] = key
            pending = {"indices": indices, "prepare_input": {"action": "hetu." + action, "input": fields, "summary": summary, "operation_key": "prepare-" + key}, "execute_key": "execute-" + key}
            journal["pending"] = pending; save(journal_path, journal)
            prepared = invoke("agent_operations.prepare", pending["prepare_input"])
        pending.update(proposal_id=prepared["proposal_id"], proposal_sha256=prepared["proposal_sha256"])
        save(journal_path, journal)
        print(json.dumps({"proposal_id": prepared["proposal_id"], "proposal_sha256": prepared["proposal_sha256"], "state_revision": prepared["state_revision"], "summary": prepared["summary"], "journal": str(journal_path)}, ensure_ascii=False))
    else:
        pending = journal.get("pending")
        if not pending or not pending.get("proposal_id"): raise ValueError("没有已准备的方案，请先prepare。")
        result = invoke("agent_operations.execute", {"proposal_id": pending["proposal_id"], "proposal_sha256": pending["proposal_sha256"], "operation_key": pending["execute_key"]})["result"]
        if pending["indices"]:
            documents = result["documents"]
            if len(documents) != len(pending["indices"]): raise ValueError("实际导入数量与固定批次不符。")
            for index, document in zip(pending["indices"], documents):
                unit = manifest["units"][index]
                actual = invoke("documents.get", {"document_id": document["document"]["document_id"], "revision_id": document["revision"]["revision_id"]})
                revision, report = actual["revision"], document["import_report"]
                # TXT进入Markdown编辑表示时会转义标点；原字节与内部修订分别核验。
                if (sha(actual["content"].encode()) != document["revision"]["sha256"]
                    or revision["sha256"] != document["revision"]["sha256"]
                    or revision["origin_kind"] != "import"
                    or revision["import_ref"]["source_sha256"] != unit["content_sha256"]
                    or report["source_sha256"] != unit["content_sha256"]
                    or report["document_ref"]["sha256"] != revision["sha256"]):
                    raise ValueError("实际章节内容或导入来源不符。")
                journal["imported"].append({"index": index, "document_id": actual["document"]["document_id"], "revision_id": revision["revision_id"], "sha256": revision["sha256"], "source_sha256": unit["content_sha256"]})
            journal["next_index"] = pending["indices"][-1] + 1
        else: journal["volumes_ready"] = True
        journal.pop("pending"); save(journal_path, journal)
        print(json.dumps({"verified_documents": journal["next_index"], "total_documents": len(manifest["units"]), "volumes_ready": journal["volumes_ready"]}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__); sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("plan"); p.add_argument("--source", type=Path, required=True); p.add_argument("--output", type=Path, required=True); p.add_argument("--encoding"); p.add_argument("--chapter-pattern"); p.add_argument("--layout", type=Path)
    for name in ["status", "prepare", "execute"]:
        p = sub.add_parser(name); p.add_argument("--plan", type=Path, required=True)
        if name != "status":
            p.add_argument("--cli", type=Path, required=True); p.add_argument("--management-ref", type=Path, required=True); p.add_argument("--collaboration-dir", type=Path); p.add_argument("--client", choices=["codex", "claude-code", "workbuddy", "generic"], default="codex"); p.add_argument("--locale", choices=["zh-CN", "en"], default="zh-CN")
    args = parser.parse_args()
    try:
        plan(args) if args.command == "plan" else command(args)
    except (ValueError, OSError, KeyError, StopIteration, ET.ParseError, zipfile.BadZipFile, subprocess.TimeoutExpired) as error:
        print(json.dumps({"status": "failed", "error": str(error), "recovery": "保留plan与journal，核对原请求后沿原键继续。"}, ensure_ascii=False), file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
