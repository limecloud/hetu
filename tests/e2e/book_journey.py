#!/usr/bin/env python3
"""用完整原创作品贯通已装配 Core/MCP；作者测试句柄不进入产品 CLI。"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import re
import select
import subprocess
import time
import uuid
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/fixtures/book-journey"
APP = ROOT / "build/native/HetuDev.app/Contents"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def key(prefix: str) -> str:
    return f"journey-{prefix}-{uuid.uuid4()}"


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


class Buffer(ctypes.Structure):
    _fields_ = [("data", ctypes.POINTER(ctypes.c_uint8)), ("size", ctypes.c_uint64)]


class Core:
    """与原生客户端相同的公开 C ABI，仅供独立测试驱动。"""

    def __init__(self, path: Path, mode="author", *, project=False, task=None):
        self.lib = ctypes.CDLL(str(APP / "Frameworks/libhetu_core.dylib"))
        self.lib.hetu_context_open.argtypes = [ctypes.c_void_p, ctypes.c_uint64,
                                             ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(Buffer)]
        self.lib.hetu_request.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                        ctypes.c_uint64, ctypes.POINTER(Buffer)]
        self.lib.hetu_context_close.argtypes = [ctypes.c_void_p]
        self.lib.hetu_buffer_free.argtypes = [ctypes.POINTER(Buffer)]
        self.handle = ctypes.c_void_p()
        config = {"creation_project_path" if project else "workspace_path": str(path), "mode": mode}
        if task:
            config["task_id"] = task
        raw = json.dumps(config).encode()
        buf = Buffer()
        code = self.lib.hetu_context_open(raw, len(raw), ctypes.byref(self.handle), ctypes.byref(buf))
        self._consume(code, buf)
        catalog = self.call("capabilities.get")
        self.revisions = {a["name"]: a["contract_revision"] for a in catalog["actions"]}

    def _consume(self, code, buf):
        try:
            assert code == 0, f"ABI transport code {code}"
            value = json.loads(ctypes.string_at(buf.data, buf.size))
            return value
        finally:
            self.lib.hetu_buffer_free(ctypes.byref(buf))

    def request(self, name, **args):
        action = "hetu." + name
        revision = getattr(self, "revisions", {}).get(action, "1")
        raw = json.dumps({"action": action, "contract_revision": revision,
                          "input": args}, ensure_ascii=False).encode()
        buf = Buffer()
        code = self.lib.hetu_request(self.handle, raw, len(raw), ctypes.byref(buf))
        return self._consume(code, buf)

    def call(self, name, **args):
        result = self.request(name, **args)
        allowed = {"succeeded", "partial"}
        if name == "git.snapshot" and args.get("phase") == "prepare":
            allowed.add("pending")
        assert result["status"] in allowed, f"{name}: {result}"
        return result["data"]

    def close(self):
        if self.handle:
            self.lib.hetu_context_close(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class MCP:
    """真实 stdio 子进程；保留请求/响应证据，不冒充 Codex 宿主会话。"""

    def __init__(self, path, task, out, *, project=False):
        self.trace = []
        self.out = out
        self.task = task
        self.counter = 0
        self.stderr = (out / f"mcp-{task}.stderr.log").open("w")
        self.process = subprocess.Popen([str(APP / "Helpers/hetu-mcp"),
            "--creation-project" if project else "--workspace", str(path), "--task", task],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, bufsize=0)
        self.pending_bytes = b""
        self.rpc("server/discover", {})
        self.tools = self.rpc("tools/list", {})["tools"]
        assert {"hetu_read_creative_task", "hetu_submit_creative_result"} <= {t["name"] for t in self.tools}
        assert not any("finalize" in t["name"] or "adopt" in t["name"] for t in self.tools)

    def rpc(self, method, params):
        self.counter += 1
        params = dict(params)
        params["_meta"] = {"io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {"name": "hetu-book-journey-test", "version": "1"}}
        request = {"jsonrpc": "2.0", "id": self.counter, "method": method, "params": params}
        self.trace.append({"request": request})
        self.process.stdin.write(json.dumps(request, ensure_ascii=False).encode() + b"\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if b"\n" not in self.pending_bytes:
                readable, _, _ = select.select([self.process.stdout], [], [], 1)
                if not readable:
                    assert self.process.poll() is None, "MCP 提前退出"
                    continue
                chunk = self.process.stdout.read(65536)
                assert chunk, "MCP EOF"
                self.pending_bytes += chunk
            while b"\n" in self.pending_bytes:
                line, self.pending_bytes = self.pending_bytes.split(b"\n", 1)
                response = json.loads(line)
                self.trace.append({"response": response})
                if response.get("id") == self.counter:
                    assert "error" not in response, response
                    return response["result"]
        raise AssertionError(f"MCP 请求超时：{method}")

    def tool(self, name, args, *, success=True):
        assert name in {t["name"] for t in self.tools}, name
        result = self.rpc("tools/call", {"name": name, "arguments": args})
        value = result.get("structuredContent")
        if value is None:
            value = json.loads(next(c["text"] for c in result["content"] if c["type"] == "text"))
        if success:
            assert value["status"] in {"succeeded", "partial"}, value
            return value["data"]
        return value

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.stderr.close()
        write_json(self.out / f"mcp-{self.task}-{self.process.pid}.json", self.trace)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def submit_concept(args):
    book, _ = manuscript()
    out = ROOT / "build/book-journey/evidence"
    out.mkdir(parents=True, exist_ok=True)
    task_ref = {"scope_ref": {"kind": "creation_project", "id": args.project_id},
                "task_id": args.task, "request_revision": 1}
    with MCP(args.project, args.task, out, project=True) as mcp:
        task = mcp.tool("hetu_read_creative_task", {"task_ref": task_ref})
        assert task["request"]["task_kind"] == "book_concept"
        assert not task.get("submission"), "已有提交，须恢复而非另提同义结果"
        candidates = [{"kind": field, "title": label, "source_format": "markdown" if field == "outline" else "plain",
                       "source_ref_indices": [], "content": book[field]}
                      for field, label in [("title", "书名"), ("synopsis", "作品简介"), ("outline", "两卷十章大纲")]]
        request = {"task_ref": task_ref, "request_sha256": task["request_sha256"], "candidates": candidates,
                   "complete": True, "missing_items": [], "provenance": {"client": "Codex 当前助手 / stdio 测试驱动",
                   "skill_version": "hetu-historical-brainstorm 0.2.1", "notes": "独立原创，按固定构思任务提交。未调用模型 API，stdio 证据不代表 Codex 新会话自动发现插件。"},
                   "operation_key": "journey-concept-20261114"}
        result = mcp.tool("hetu_submit_creative_result", request)
        assert mcp.tool("hetu_submit_creative_result", request) == result, "原键重放重复提交"
        loaded = mcp.tool("hetu_read_creative_task", {"task_ref": task_ref})
        assert loaded["submission"]["submission_id"] == result["submission"]["submission_id"]
        write_json(out / "concept-receipt.json", result)
    print("构思已通过真实 MCP 提交，原键回读一致，等待作者在界面选用。")


def document_ref(document):
    return {"document_id": document["document"]["document_id"],
            "revision_id": document["revision"]["revision_id"],
            "sha256": document["revision"]["sha256"]}


def expected(record):
    return {"revision": record["revision"], "sha256": record["sha256"]}


def span(content, quote=None):
    if quote is None:
        return {"byte_start": 0, "byte_end": len(content.encode()), "quote": content}
    start = content.index(quote)
    return {"byte_start": len(content[:start].encode()),
            "byte_end": len(content[:start + len(quote)].encode()), "quote": quote}


class Journey:
    def __init__(self, workspace):
        self.path = workspace.resolve()
        assert self.path.is_relative_to(ROOT / "build/book-journey"), "只允许独立测试作品"
        self.out = self.path.parent / (self.path.name + "-验收")
        self.out.mkdir(parents=True, exist_ok=True)
        self.state_path = self.out / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {"operations": {}, "checks": []}
        self.core = Core(self.path)
        self.book, self.chapters = manuscript()
        self.source_sha = sha((FIXTURE / "manuscript.md").read_bytes())
        assert self.state.get("source_sha", self.source_sha) == self.source_sha, "测试途中夹具变化"
        self.state["source_sha"] = self.source_sha
        self.state["core_sha256"] = sha((APP / "Frameworks/libhetu_core.dylib").read_bytes())
        self.state["mcp_sha256"] = sha((APP / "Helpers/hetu-mcp").read_bytes())

    def persist(self):
        write_json(self.state_path, self.state)

    def check(self, condition, message):
        assert condition, message
        if message not in self.state["checks"]:
            self.state["checks"].append(message)
            self.persist()
            print("通过：" + message, flush=True)

    def mutate(self, tag, action, **args):
        previous = self.state["operations"].get(tag)
        if previous and previous.get("result", {}).get("status") in {"succeeded", "partial", "pending"}:
            return previous["result"]["data"]
        if previous:
            assert previous["action"] == action
            args = previous["input"]
        else:
            args["operation_key"] = key(tag)
        self.state["operations"][tag] = {"action": action, "input": args}
        self.persist()
        result = self.core.request(action, **args)
        self.state["operations"][tag]["result"] = result
        self.persist()
        assert result["status"] in {"succeeded", "partial", "pending"}, f"{tag}: {result}"
        return result["data"]

    def denied(self, action, **args):
        with Core(self.path, mode="agent") as agent:
            result = agent.request(action, **args)
        self.check(result.get("error", {}).get("code") == "forbidden", "Agent 无权执行 " + action)

    def task(self, tag, kind, brief, refs, *, edit_scope=None):
        if tag in self.state:
            return self.state[tag]
        scope = self.core.call("capabilities.get")["scope_ref"]
        args = {"scope_ref": scope, "task_kind": kind, "brief": brief, "input_refs": refs,
                "client_adapter": "codex", "language_tag": "zh-CN", "candidate_limit": 2}
        if edit_scope:
            args["edit_scope"] = edit_scope
        preview = self.core.call("creative_tasks.preview_prompt", **args)
        prepared = self.mutate(tag + "-prepare", "creative_tasks.prepare", **preview["prepare_input"])
        self.state[tag] = prepared
        self.persist()
        return prepared

    def submit(self, tag, task, candidates):
        if tag in self.state:
            return self.state[tag]
        ref = task["task_ref"]
        with MCP(self.path, ref["task_id"], self.out) as mcp:
            read = mcp.tool("hetu_read_creative_task", {"task_ref": ref})
            self.check(read["request_sha256"] == task["request_sha256"], tag + " 固定任务回读一致")
            args = {"task_ref": ref, "request_sha256": task["request_sha256"], "candidates": candidates,
                    "complete": True, "missing_items": [], "provenance": {
                        "client": "Codex 当前助手 / stdio 测试驱动", "skill_version": "hetu-historical-brainstorm 0.2.1",
                        "notes": "内容由当前助手独立撰写；实际 stdio MCP 交接，作者操作由隔离的测试句柄执行。"},
                    "operation_key": "journey-submit-" + tag}
            result = mcp.tool("hetu_submit_creative_result", args)
            self.check(mcp.tool("hetu_submit_creative_result", args) == result, tag + " 原键重放不重复创建候选")
        self.state[tag] = result
        self.persist()
        return result

    def review(self, tag, draft_id, decision="approved"):
        begun = self.mutate(tag + "-begin", "reviews.begin", draft_id=draft_id,
                            expected_draft_revision=self.core.call("drafts.get", draft_id=draft_id)["draft"]["revision"])
        self.mutate(tag + "-validate", "reviews.validate", draft_id=draft_id,
                    expected_draft_revision=begun["draft"]["revision"], plot_options={}, validation_options={})
        context = self.core.call("reviews.get", draft_id=draft_id)
        refs = [r["reference"] for r in context["reports"]] if decision == "approved" else []
        if decision == "rejected":
            reports = [self.core.call("reports.get", report_id=r["reference"]["report_id"])["report"]
                       for r in context["reports"]]
            findings = [f for report in reports for f in report["findings"]]
            self.check(any("激光炮" in json.dumps(f, ensure_ascii=False) for f in findings),
                       "不合时代的参考方案产生带原文证据的规则诊断")
        return self.mutate(tag + "-decide", "reviews.decide", draft_id=draft_id,
            expected_draft_revision=context["draft"]["revision"], input_snapshot=context["input_snapshot"],
            report_refs=refs, decision=decision, comments="已核对人物、事件、前后章及时代约束。" if decision == "approved" else "出现设定禁止的武器，驳回此方案。",
            private_comments="JOURNEY_PRIVATE_REVIEW_不得进入交付包", coverage_acknowledgement="已人工核对规则引擎未能判断的叙事与历史语境。")

    def adopt(self, tag, draft_id, target, content, selected=None):
        draft = self.core.call("drafts.get", draft_id=draft_id)["draft"]
        selections = selected or [{"source": span(content), "target": span(target["content"])}]
        preview = self.core.call("drafts.preview_adoption", draft_ref={"draft_id": draft_id,
            "revision": draft["revision"], "sha256": draft["content_sha256"]},
            target_ref=document_ref(target), new_document=None, selected_ranges=selections)
        return self.mutate(tag, "drafts.adopt", preview=preview["preview"])

    def write_book(self):
        if self.state.get("book_written"):
            return
        novel = self.core.call("novels.get")
        self.check(novel["novel"]["metadata"]["title"] == self.book["title"], "作品资料为界面确认的书名")
        docs = self.core.call("documents.list")["documents"]
        first_id = next(d["document_id"] for d in docs if d["title"] == self.chapters[0]["title"])
        first = self.core.call("documents.get", document_id=first_id)
        self.check(first["content"] == self.chapters[0]["content"], "界面粘贴、撤销、保存的首章与全文逐字一致")
        self.state["chapter_ids"] = [first_id]
        self.persist()
        metadata = dict(novel["novel"]["metadata"], status="writing")
        self.mutate("writing-status", "novels.update", expected=expected(novel), metadata=metadata)
        outline = self.mutate("outline", "documents.create", kind="novel_outline", title="全书大纲",
                              source_format="markdown", content=self.book["outline"], language_tag="zh-CN")
        bible = self.core.call("blueprints.get")
        changes = []
        characters = {}
        for i, character in enumerate(self.book["characters"], 1):
            entity_id = f"character_{i:08x}-1111-4111-8111-111111111111"
            characters[character["name"]] = entity_id
            changes.append({"type": "upsert_character", "entity": {"character_id": entity_id,
                **character, "aliases": [], "facts": [], "archived": False}})
        locations = {}
        for i, name in enumerate(["青石渡", "窑场", "旧支汊"], 1):
            entity_id = f"location_{i:08x}-2222-4222-8222-222222222222"
            locations[name] = entity_id
            changes.append({"type": "upsert_location", "entity": {"location_id": entity_id,
                "name": name, "aliases": [], "description": "虚构地点，作者确认的作品设定。",
                "interior_exterior": "exterior", "archived": False}})
        changes.extend([
            {"type": "upsert_world", "entity": {"entry_id": "entry_11111111-3333-4333-8333-333333333333",
                "title": "时代与知识边界", "description": "南宋架空地点。无系统、无现代枪械、无万能技术；主角仍需本地经验、材料和共同决策。", "source_refs": []}},
            {"type": "upsert_rule", "entity": {"rule_id": "rule_11111111-4444-4444-8444-444444444444", "revision": 1,
                "type": "forbidden_term", "scope": {"packages": ["novel", "drama"], "document_ids": [], "entity_refs": []},
                "severity": "error", "parameters": {"terms": ["激光炮"], "case_sensitive": True, "exceptions": []},
                "rationale": "作者约定没有超时代武器。", "exception_policy": "author_review"}}
        ])
        saved = self.mutate("bible", "blueprints.save", expected=expected(bible), typed_changes=changes)
        locked = self.mutate("bible-lock", "blueprints.lock", expected=expected(saved), reason="本书设定确认")
        self.state["characters"] = characters
        self.state["locations"] = locations
        self.denied("blueprints.unlock", expected=expected(locked), reason="越权解锁", operation_key=key("deny-unlock"))
        self.denied("documents.save", document_id=first_id, base_revision_id=first["revision"]["revision_id"],
                    source_format="markdown", content="不允许覆盖作者正文", operation_key=key("deny-save"))
        cover_file = ROOT / "assets/illustrations/library/cover-river-jade.jpg"
        image = self.core.call("covers.inspect_file", file_path=str(cover_file))
        self.mutate("cover", "covers.select", source={"kind": "file", "file_path": str(cover_file),
            "expected_file": {"sha256": image["sha256"], "size_bytes": image["size_bytes"]}}, expected_cover=None,
            presentation={"crop_rect": {"x": 0, "y": 0, "width": 1, "height": 1},
                          "title_overlay": self.book["title"], "author_overlay": self.book["author_name"]})
        for index, chapter in enumerate(self.chapters[1:], 2):
            tag = f"chapter-{index}"
            empty = self.mutate(tag + "-create", "documents.create", kind="novel_chapter", title=chapter["title"],
                                source_format="markdown", content="", language_tag="zh-CN")
            doc_id = empty["document"]["document_id"]
            if doc_id not in self.state["chapter_ids"]:
                self.state["chapter_ids"].append(doc_id)
                self.persist()
            refs = [{"kind": "document", "document_id": outline["document"]["document_id"],
                     "revision_id": outline["revision"]["revision_id"]},
                    {"kind": "blueprint", "revision": locked["revision"]}]
            task = self.task(tag + "-task", "chapter_draft",
                f"起草《归宋守渡》{chapter['title']}的独立参考稿。遵循两卷十章大纲、人物选择与资源约束；只交本章，不覆盖正文。", refs)
            candidates = [{"kind": "text", "title": chapter["title"], "source_format": "markdown",
                           "source_ref_indices": [0, 1], "content": chapter["content"]}]
            if index == 6:
                candidates.append({**candidates[0], "title": "不符合时代约束的方案",
                                   "content": chapter["content"] + "\n沈砚拿出激光炮。\n"})
            submission = self.submit(tag + "-submission", task, candidates)
            good = submission["submission"]["candidates"][0]
            if index == 6:
                bad = submission["submission"]["candidates"][1]
                self.review(tag + "-bad", bad["draft_ref"]["draft_id"], "rejected")
                self.check(self.core.call("documents.get", document_id=doc_id)["content"] == "", "驳回不合设定的方案不会写入正文")
            self.review(tag + "-review", good["draft_ref"]["draft_id"])
            before = self.core.call("documents.get", document_id=doc_id)
            if tag + "-adopt" not in self.state["operations"]:
                self.check(before["content"] == "" and before["document"].get("approved_revision_id") is None,
                           tag + " 审核通过未自动采纳或定稿")
                self.adopt(tag + "-adopt", good["draft_ref"]["draft_id"], before, chapter["content"])
            current = self.core.call("documents.get", document_id=doc_id)
            self.check(current["content"] == chapter["content"] and current["document"].get("approved_revision_id") is None,
                       tag + " 作者采纳后正文完整且尚未定稿")
        novel = self.core.call("novels.get")
        volume_names = list(dict.fromkeys(c["volume"] for c in self.chapters))
        volumes = [{"volume_id": f"volume_{i:08x}-5555-4555-8555-555555555555", "title": name}
                   for i, name in enumerate(volume_names, 1)]
        lookup = {d["document_id"]: d for d in novel["novel"]["chapters"]}
        chapters = [{**lookup[doc_id], "volume_id": volumes[volume_names.index(chapter["volume"])]["volume_id"]}
                    for doc_id, chapter in zip(self.state["chapter_ids"], self.chapters)]
        self.mutate("two-volumes", "novels.save_structure", expected=expected(novel), volumes=volumes, chapters=chapters)
        self.check(len(self.core.call("novels.get")["novel"]["chapters"]) == 10, "两卷十章按作者顺序组织，无重复章节")
        self.state["book_written"] = True
        self.persist()

    def revise_book(self):
        if self.state.get("book_revised"):
            return
        doc_id = self.state["chapter_ids"][0]
        original = self.core.call("documents.get", document_id=doc_id)
        baseline = self.state.setdefault("revision_baseline", original)
        self.persist()
        quotes = ["嘴里全是泥", "傍晚，第二道线高出第一道两指。"]
        replacements = ["嘴里尽是泥", "傍晚，第二道线又爬高了两指。"]
        ranges = [span(baseline["content"], q) for q in quotes]
        task = self.task("revision-task", "revision", "仅比较两个固定选区的措辞，保持事件与时代设定；每处分别提交补丁。",
            [{"kind": "document", "document_id": doc_id, "revision_id": baseline["revision"]["revision_id"]}],
            edit_scope={"document_id": doc_id, "revision_id": baseline["revision"]["revision_id"], "ranges": ranges})
        patches = [{**r, "replacement": replacement} for r, replacement in zip(ranges, replacements)]
        submission = self.submit("revision-submission", task, [{"kind": "text", "title": "开篇两处措辞比较",
            "source_format": "markdown", "source_ref_indices": [0], "patches": patches}])
        candidate = submission["submission"]["candidates"][0]
        draft_id = candidate["draft_ref"]["draft_id"]
        self.review("revision-review", draft_id)
        draft = self.core.call("drafts.get", draft_id=draft_id)
        if "revision-old-preview" not in self.state:
            old = self.core.call("drafts.preview_adoption", draft_ref={"draft_id": draft_id,
                "revision": draft["draft"]["revision"], "sha256": draft["draft"]["content_sha256"]},
                target_ref=document_ref(baseline), new_document=None, selected_ranges=[{
                    "source": span(draft["content"], replacements[0]), "target": ranges[0]}])
            self.state["revision-old-preview"] = old
            self.persist()
        edited_text = baseline["content"] + "\n作者待办：回看水位记录。\n"
        self.mutate("revision-author-continued", "documents.save", document_id=doc_id,
            base_revision_id=baseline["revision"]["revision_id"], source_format="markdown",
            content=edited_text)
        stale = self.core.request("drafts.adopt", preview=self.state["revision-old-preview"]["preview"], operation_key=key("stale-adoption"))
        self.check(stale.get("error", {}).get("code") in {"revision_conflict", "hetu.stale_evidence"},
                   "作者继续写作后，旧采纳预览被拦截")
        if "revision-selected-adoption" not in self.state["operations"]:
            self.adopt("revision-selected-adoption", draft_id, self.core.call("documents.get", document_id=doc_id),
                draft["content"], selected=[{"source": span(draft["content"], replacements[0]),
                                           "target": span(edited_text, quotes[0])}])
        if "revision-author-final" not in self.state["operations"]:
            current = self.core.call("documents.get", document_id=doc_id)
            self.check(current["content"] == edited_text.replace(quotes[0], replacements[0]),
                       "仅采纳一处改稿，未选补丁与作者后续文字保持原样")
            self.mutate("revision-author-final", "documents.save", document_id=doc_id,
                base_revision_id=current["revision"]["revision_id"], source_format="markdown", content=self.chapters[0]["content"])
        final = self.core.call("documents.get", document_id=doc_id)
        self.check(final["content"] == self.chapters[0]["content"] and bool(final["revision"].get("contribution_refs")),
                   "作者可改回自己的措辞，采纳来源仍可追溯")
        self.state["book_revised"] = True
        self.persist()

    def finalize(self, tag, doc_id):
        current = self.core.call("documents.get", document_id=doc_id)
        report = self.mutate(tag + "-check", "documents.validate", document_ref=document_ref(current), plot_options={}, validation_options={})
        read = self.core.call("reports.get", report_id=report["report"]["report_id"])
        preview = self.core.call("documents.preview_finalization", document_ref=document_ref(current),
            expected_finalization_ref=current["document"].get("finalization_ref"), report_refs=[read["reference"]],
            comments="流程测试中逐章核对全文、人物知情范围、资源代价与前后因果后确认。",
            coverage_acknowledgement="规则检查不替代文学与历史审阅；已人工检查抽取未确认及语义覆盖不足部分。")
        self.check(preview["preview"]["eligible"], tag + " 定稿证据有效")
        approved = self.mutate(tag + "-confirm", "documents.finalize", preview=preview["preview"])
        return {**document_ref(current), "finalization_ref": approved["finalization"]["reference"]}

    def finalize_book(self):
        if self.state.get("book_finalized"):
            return
        novel = self.core.call("novels.get")
        refs = [document_ref(self.core.call("documents.get", document_id=d)) for d in self.state["chapter_ids"]]
        bible = self.core.call("blueprints.get")
        unfinalized = self.core.call("bundles.preview", selection={"blueprint_ref": expected(bible), "document_refs": refs},
                                     profile="production_delivery")
        self.check(not unfinalized["preview"]["eligible"], "未定稿全书不能作为正式交付包")
        approved = []
        for index, doc_id in enumerate(self.state["chapter_ids"], 1):
            if f"final-{index}-confirm" in self.state["operations"]:
                current = self.core.call("documents.get", document_id=doc_id)
                approved.append({**document_ref(current), "finalization_ref": current["document"]["finalization_ref"]})
            else:
                approved.append(self.finalize(f"final-{index}", doc_id))
        # 后续写作修订允许继续，仍有效的作者定稿必须保持不变。
        last_id = self.state["chapter_ids"][-1]
        current = self.core.call("documents.get", document_id=last_id)
        self.mutate("after-final-writing", "documents.save", document_id=last_id,
            base_revision_id=current["revision"]["revision_id"], source_format="markdown",
            content=self.chapters[-1]["content"] + "\n后续写作稿：这里还未重新定稿，不得进入正式交付。\n")
        later = self.core.call("documents.get", document_id=last_id)
        self.check(later["document"]["approved_revision_id"] == approved[-1]["revision_id"]
                   and later["revision"]["revision_id"] != approved[-1]["revision_id"], "定稿后继续写作不会覆盖已确认版本")
        current_novel = self.core.call("novels.get")
        self.mutate("completed-status", "novels.update", expected=expected(current_novel),
                    metadata={**current_novel["novel"]["metadata"], "status": "completed"})
        self.state["finalized_refs"] = approved
        self.state["book_finalized"] = True
        self.persist()

    def drama(self):
        if self.state.get("drama_complete"):
            return
        refs = [{k: v for k, v in r.items() if k != "finalization_ref"} for r in self.state["finalized_refs"]]
        bible = self.core.call("blueprints.get")
        extracted = self.mutate("full-plot", "plot.extract", document_revisions=refs,
            blueprint_revision=bible["revision"], options={}, save_result=True)
        plot = extracted["plot"]
        self.check(len(plot["source_revisions"]) == 10 and bool(plot["nodes"]), "全书剧情抽取固定十章来源且未生成正文")
        self.check(any(n["verification"] == "needs_author_review" for n in plot["nodes"]), "自动抽取的语义仍等待作者确认")
        # 用作者逐场选定的原文证据组织十场；不把关键词匹配自动当成已确认事实。
        corrections = [{"type": "update_node", "node_id": n["node_id"], "kind": n["kind"],
            "entity_refs": n["entity_refs"], "location_ref": n.get("location_ref"), "time_ref": n.get("time_ref"),
            "speaker_ref": n.get("speaker_ref"), "time_of_day": n["time_of_day"], "verification": "dismissed"}
            for n in plot["nodes"]]
        scenes = [
            (0, "他抹掉眼前的泥，看见一只翻了肚的小船。", "青石渡", "day", ["沈砚", "许禾", "曹岑", "小满"]),
            (0, "傍晚，第二道线高出第一道两指。", "青石渡", "dusk", ["沈砚", "许禾", "曹岑"]),
            (2, "沈砚把他们拦开，借来一杆秤。", "青石渡", "day", ["沈砚", "许禾", "程复", "曹岑"]),
            (3, "沈砚只来得及把身旁的少年扑倒", "青石渡", "day", ["沈砚", "祁伍", "曹岑", "程复"]),
            (4, "到了回水湾，他们先听见敲梆子。", "青石渡", "night", ["沈砚", "曹岑", "程复"]),
            (5, "仓门打开，霉气先扑出来。", "青石渡", "dawn", ["许禾", "程复", "曹岑", "沈砚"]),
            (6, "林家父子来时，身上还带着桑叶的味道。", "旧支汊", "dusk", ["沈砚", "许禾", "程复"]),
            (7, "船靠到窑场，少年报完三百一十二", "青石渡", "night", ["沈砚", "许禾", "曹岑", "祁伍", "小满"]),
            (8, "林家的儿子提来一扇拆下的田棚门。", "旧支汊", "dawn", ["沈砚", "曹岑"]),
            (9, "许禾把一张新约贴到渡亭石柱旁", "青石渡", "day", ["沈砚", "许禾", "曹岑", "程复", "小满", "祁伍"]),
        ]
        for index, quote, place, day, names in scenes:
            content = self.chapters[index]["content"]
            source = {**span(content, quote), "document_id": refs[index]["document_id"], "revision_id": refs[index]["revision_id"]}
            corrections.append({"type": "add_node", "kind": "scene", "entity_refs": [self.state["characters"][n] for n in names],
                "location_ref": self.state["locations"][place], "time_ref": None, "speaker_ref": None,
                "time_of_day": day, "verification": "confirmed", "source_ref": source})
        for offset in range(0, len(corrections), 150):
            corrected = self.mutate(f"plot-author-scenes-{offset}", "plot.correct", plot_revision_id=plot["plot_revision_id"],
                                   corrections=corrections[offset:offset + 150])
            plot = corrected["plot"]
        nodes = [n for n in plot["nodes"] if n["verification"] == "confirmed"]
        self.check(len(nodes) == 10, "作者逐场确认人物、场地和昼夜，保留原文字节证据")
        built = self.mutate("five-episode-skeleton", "drama.build_skeleton", plot_revision_id=plot["plot_revision_id"],
            blueprint_revision=bible["revision"], episode_options={"episode_start_node_ids": [n["node_id"] for n in nodes[2::2]]})
        skeleton = built["skeleton"]
        sk_ref = {"skeleton_id": skeleton["skeleton_id"], "revision": skeleton["revision"], "sha256": built["sha256"]}
        self.state["skeleton_ref"] = sk_ref
        self.check(len(skeleton["episodes"]) == 5 and sum(len(e["scenes"]) for e in skeleton["episodes"]) == 10,
                   "小说剧情转成五集十场短剧结构")
        script = self.mutate("script-structure", "drama.create_script", skeleton_ref=sk_ref, title=self.book["title"], language_tag="zh-CN")
        script_id = script["document"]["document_id"]
        empty = self.core.call("documents.get", document_id=script_id, revision_id=script["revision"]["revision_id"])
        self.check("@" not in empty["content"] and "松半尺" not in empty["content"], "内核只建立短剧结构，没有自动编写台词")
        script_text = (FIXTURE / "drama.fountain").read_text()
        # 每个任务只读取实际授权的原著。分成两个任务，使每批完整来源均处于八个输入上限以内。
        first_part, second_part = script_text.split("# 第4集\n", 1)
        parts = [(first_part, [0, 2, 3, 4, 5], "第1至3集"),
                 ("# 第4集\n" + second_part, [6, 7, 8, 9], "第4至5集")]
        for number, (content, indices, label) in enumerate(parts, 1):
            tag = f"drama-part-{number}"
            current = self.core.call("documents.get", document_id=script_id)
            task_refs = [{"kind": "document", "document_id": script_id, "revision_id": current["revision"]["revision_id"]}]
            task_refs += [{"kind": "document", "document_id": refs[i]["document_id"], "revision_id": refs[i]["revision_id"]}
                          for i in indices]
            task_refs.append({"kind": "blueprint", "revision": bible["revision"]})
            task = self.task(tag + "-task", "drama_draft", f"按已确认五集十场结构填写{label}的独立 Fountain 候选。只用本轮原著已有事件，保留人先于货、风险与共同规则主题。", task_refs)
            submission = self.submit(tag + "-submission", task, [{"kind": "text", "title": label + "改编参考稿",
                "source_format": "fountain", "source_ref_indices": list(range(len(task_refs))), "content": content}])
            draft_id = submission["submission"]["candidates"][0]["draft_ref"]["draft_id"]
            self.review(tag + "-review", draft_id)
            if tag + "-adopt" not in self.state["operations"]:
                selections = None if number == 1 else [{"source": span(content),
                    "target": {"byte_start": len(current["content"].encode()), "byte_end": len(current["content"].encode()), "quote": ""}}]
                self.adopt(tag + "-adopt", draft_id, current, content, selected=selections)
        self.check(self.core.call("documents.get", document_id=script_id)["content"] == script_text,
                   "两次短剧任务分别授权原著，作者合并后五集全文一致")
        mapping = self.core.call("drama.get_script_mapping", document_id=script_id)
        self.check(mapping["stale"] and mapping["mapping"] == script["mapping"], "剧本填充后原始映射保留并明确标记需复核")
        comparison = self.mutate("drama-comparison", "drama.compare", skeleton_ref=sk_ref,
            source_revisions=skeleton["source_revisions"], save_result=True)
        comparison_id = comparison["comparison"]["comparison_id"]
        summary = next(c for c in self.core.call("drama.list_comparisons", skeleton_id=sk_ref["skeleton_id"], limit=50)["comparisons"]
                       if c["comparison_id"] == comparison_id)
        self.state["comparison_ref"] = {"comparison_id": comparison_id, "sha256": summary["sha256"]}
        self.state["script_ref"] = self.finalize("script-final", script_id)
        self.state["script_id"] = script_id
        self.state["drama_complete"] = True
        self.persist()

    def export(self, tag, refs, fmt, profile):
        if tag in self.state:
            return self.state[tag]
        preview = self.core.call("documents.preview_export", revision_refs=refs, format=fmt, profile=profile)
        result = self.mutate(tag, "documents.export", preview=preview["preview"], acknowledgement="已核对选集顺序、固定修订及格式转换说明。")
        path = self.path / result["path"]
        self.check(path.is_file() and path.stat().st_size > 100, tag + " 导出产物存在")
        self.state[tag] = result
        self.persist()
        return result

    def deliveries(self):
        if self.state.get("deliveries_complete"):
            return
        refs = self.state["finalized_refs"]
        for fmt in ["txt", "markdown", "docx", "pdf"]:
            self.export("novel-" + fmt, refs, fmt, "hetu-novel-zh/1")
        for fmt in ["fountain", "docx", "pdf"]:
            self.export("drama-" + fmt, [self.state["script_ref"]], fmt, "hetu-screenplay-zh/1")
        word_path = self.path / self.state["novel-docx"]["path"]
        with zipfile.ZipFile(word_path) as archive:
            document = ET.fromstring(archive.read("word/document.xml"))
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            paragraphs = ["".join(p.itertext()) for p in document.findall(".//w:p", ns)]
            word_text = "\n".join(paragraphs)
            positions = [word_text.index(c["title"]) for c in self.chapters]
            self.check(positions == sorted(positions) and len(set(positions)) == 10, "独立解析 Word，十章顺序完整")
            compact = lambda text: "".join(text.split())
            self.check(all(compact(c["content"]) in compact(word_text) for c in self.chapters), "独立解析 Word，全文中文与标点未丢失")
            styles = archive.read("word/styles.xml").decode()
            self.check("firstLineChars" in styles or "firstLine" in styles, "Word 使用中文正文首行缩进样式")
        before = len(self.core.call("novels.get")["novel"]["chapters"])
        roundtrip = self.core.call("documents.preview_import", file_path=str(word_path), format="docx", profile="hetu-novel-zh/1")
        roundtrip_text = roundtrip["preview"]["converted"]["content"]
        self.check(all(compact(c["content"]) in compact(roundtrip_text) for c in self.chapters), "全书 Word 回读预览保留十章正文")
        self.check(len(self.core.call("novels.get")["novel"]["chapters"]) == before, "回读预览不会擅自拆章或修改作品")
        fountain_path = self.path / self.state["drama-fountain"]["path"]
        fountain = fountain_path.read_text()
        self.check(len(re.findall(r"^EXT\. ", fountain, re.M)) == 10 and "@许禾" in fountain, "Fountain 导出保留十场与中文人物对白")
        bible = self.core.call("blueprints.get")
        reports = [op["result"]["data"]["reference"] for tag, op in self.state["operations"].items()
                   if tag.startswith("final-") and tag.endswith("-check")]
        first = self.core.call("documents.get", document_id=refs[0]["document_id"], revision_id=refs[0]["revision_id"])
        cue_source = {"document_id": refs[0]["document_id"], "revision_id": refs[0]["revision_id"], **span(first["content"], "有人在喊孩子。")}
        cue = self.mutate("visual-cue", "cues.save", kind="visual", title="青石渡开场", description="涨水、芦苇、翻扣小船与渡口石柱。仅为原著视觉线索，不调用生成服务。",
                           narrative_refs=[cue_source], asset_refs=[], archived=False)
        cue_ref = {"cue_id": cue["cue"]["cue_id"], "revision": cue["cue"]["revision"], "sha256": cue["sha256"]}
        selection = {"blueprint_ref": expected(bible), "document_refs": refs + [self.state["script_ref"]],
                     "skeleton_refs": [self.state["skeleton_ref"]], "comparison_refs": [self.state["comparison_ref"]],
                     "report_refs": reports, "cue_refs": [cue_ref]}
        for profile in ["production_delivery", "review_delivery"]:
            tag = "bundle-" + profile
            if tag in self.state:
                continue
            if profile == "review_delivery":
                selection = {**selection, "document_refs": [document_ref(self.core.call("documents.get", document_id=r["document_id"])) for r in refs]}
            preview = self.core.call("bundles.preview", selection=selection, profile=profile, reading_formats=["txt", "docx", "pdf"])
            self.check(preview["preview"]["eligible"], profile + " 交付选集可导出")
            result = self.mutate(tag, "bundles.export", preview=preview["preview"], acknowledgement="已确认作者定稿、原著与剧本选集、报告及素材权利。")
            verified = self.core.call("bundles.verify", bundle_id=result["bundle_id"])
            self.check(verified["verified"], profile + " Core 摘要校验通过")
            path = self.path / result["path"]
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                self.check(not any(n.startswith((".hetu/", ".git/")) or ".." in Path(n).parts for n in names), profile + " 不携带内部目录")
                texts = "\n".join(archive.read(n).decode("utf-8") for n in names if n.endswith((".json", ".md", ".txt", ".fountain")))
                self.check("JOURNEY_PRIVATE_REVIEW_" not in texts and "不得进入交付包" not in texts, profile + " 不泄露私密审核批注")
                marker = "后续写作稿：这里还未重新定稿"
                self.check((marker in texts) == (profile == "review_delivery"), profile + " 写作稿与定稿选集正确分离")
                write_json(self.out / (profile + "-archive.json"), {"path": str(path), "sha256": sha(path.read_bytes()), "files": names})
            self.state[tag] = result
            self.persist()
        self.state["deliveries_complete"] = True
        self.persist()

    def run(self):
        try:
            self.write_book()
            self.revise_book()
            self.finalize_book()
            self.drama()
            self.deliveries()
        finally:
            self.core.close()

    def verify_bundle(self, tag, result):
        path = self.path / result["path"]
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            self.check(len(names) == len(set(names)), tag + " 无重复 ZIP 条目")
            manifest = json.loads(archive.read("manifest.json"))
            for item in manifest["files"]:
                self.check(not Path(item["path"]).is_absolute() and ".." not in Path(item["path"]).parts,
                           tag + " 清单路径安全")
                raw = archive.read(item["path"])
                assert len(raw) == item["size_bytes"] and sha(raw) == item["sha256"], item["path"]
            self.check(set(names) == {i["path"] for i in manifest["files"]} | {"manifest.json"},
                       tag + " ZIP 文件与清单完全一致")
            self.check(True, tag + " 独立逐文件核对大小和 SHA-256")
            texts = "\n".join(archive.read(n).decode() for n in names
                              if n.endswith((".json", ".md", ".txt", ".fountain")))
            self.check("JOURNEY_PRIVATE_REVIEW_" not in texts, tag + " 未导出私密批注")
            marker = "后续写作稿：这里还未重新定稿"
            self.check((marker in texts) == ("review_delivery" in tag), tag + " 定稿与写作稿分离")
            write_json(self.out / (tag + "-archive.json"),
                       {"path": str(path), "sha256": sha(path.read_bytes()), "files": names})

    def final_artifacts(self):
        """按当前内核新增导出批次，保留旧产物与原操作回执。"""
        assert self.state.get("deliveries_complete"), "须先跑完整创作旅程"
        batch = self.state["core_sha256"][:12]
        latest = {}
        for kind, refs, profile in [
            ("novel", self.state["finalized_refs"], "hetu-novel-zh/1"),
            ("drama", [self.state["script_ref"]], "hetu-screenplay-zh/1"),
        ]:
            tag = kind + "-pdf"
            latest[tag] = self.export(tag + "-" + batch, refs, "pdf", profile)
        for profile in ["production_delivery", "review_delivery"]:
            old_tag = "bundle-" + profile
            self.verify_bundle(old_tag, self.state[old_tag])
            request = self.state["operations"][old_tag]["input"]["preview"]["request"]
            tag = old_tag + "-" + batch
            if tag not in self.state:
                preview = self.core.call("bundles.preview", **request)
                self.check(preview["preview"]["eligible"], tag + " 固定选集可导出")
                self.state[tag] = self.mutate(tag, "bundles.export", preview=preview["preview"],
                    acknowledgement="已重新核对当前模板分页、固定定稿选集及交付边界。")
                self.persist()
            result = self.state[tag]
            self.check(self.core.call("bundles.verify", bundle_id=result["bundle_id"])["verified"], tag + " Core 核验通过")
            self.verify_bundle(tag, result)
            latest[old_tag] = result
        self.state["latest_exports"] = latest
        self.persist()

    def git_journey(self):
        """仅在 build/book-journey 下测试作品快照，不操作源码仓库或远端。"""
        if self.state.get("git_complete"):
            return
        self.mutate("git-init", "git.init", branch="main")

        def snapshot(tag, message):
            status = self.core.call("git.status")
            prepared = self.mutate(tag + "-prepare", "git.snapshot", phase="prepare",
                expected_head=status["head"], message=message,
                author={"name": "渡舟（流程测试）", "email": "journey@hetu.test"})
            self.mutate(tag + "-approve", "git.approve_snapshot",
                snapshot_id=prepared["snapshot"]["snapshot_id"], snapshot_sha256=prepared["snapshot_sha256"])
            result = self.mutate(tag + "-execute", "git.snapshot", phase="execute",
                snapshot_id=prepared["snapshot"]["snapshot_id"])
            original = self.state["operations"][tag + "-execute"]["input"]
            replay = self.core.call("git.snapshot", **original)
            self.check(replay == result, tag + " 原键恢复不重复提交")
            return result

        first = snapshot("git-book-final", "《归宋守渡》两卷十章与五集短剧定稿")
        note = self.mutate("delivery-note", "documents.create", title="交付说明", kind="adaptation_note",
                           source_format="markdown", content="", language_tag="zh-CN")
        document = note["document"]
        current = self.core.call("documents.get", document_id=document["document_id"])
        saved = self.mutate("delivery-note-save", "documents.save", document_id=document["document_id"],
            base_revision_id=current["revision"]["revision_id"], source_format="markdown",
            content="交付范围：两卷十章小说、五集十场短剧。后续写作稿须另行定稿。\n")
        status = self.core.call("git.status")
        changed = next(c for c in status["changes"] if c["path"] == saved["revision"]["content_path"])
        diff = self.core.call("git.diff", path=changed["path"])
        self.check(diff["before"] is None and "后续写作稿须另行定稿" in diff["after"], "第二快照准确展示新增交付说明")
        second = snapshot("git-delivery-note", "补充作者交付说明")
        history = self.core.call("git.log", limit=10)["commits"]
        self.check([c["commit_id"] for c in history] == [second["commit_id"], first["commit_id"]], "作品历史仅有两次预期快照")
        self.check(not self.core.call("git.status")["changes"], "作品快照后无伪工作树变化")
        self.state["git_complete"] = True
        self.persist()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    concept = sub.add_parser("submit-concept")
    concept.add_argument("--project", type=Path, required=True)
    concept.add_argument("--project-id", required=True)
    concept.add_argument("--task", required=True)
    run = sub.add_parser("run")
    run.add_argument("--workspace", type=Path, required=True)
    verify = sub.add_parser("verify-final")
    verify.add_argument("--workspace", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "submit-concept":
        submit_concept(args)
    elif args.command == "run":
        Journey(args.workspace).run()
    elif args.command == "verify-final":
        journey = Journey(args.workspace)
        try:
            journey.final_artifacts()
            journey.git_journey()
        finally:
            journey.core.close()


if __name__ == "__main__":
    main()
