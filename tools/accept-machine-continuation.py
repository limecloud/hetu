#!/usr/bin/env python3
"""通过独立CLI与真实stdio MCP验收任务接续；仅创建隔离的测试筹备与参考稿。"""
import argparse
import atexit
import copy
import hashlib
import json
import select
import subprocess
import time
from pathlib import Path


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path)
    parser.add_argument("--mcp", required=True, type=Path)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--extended", action="store_true", help="验收逐条依据、假设状态及交接；要求实际Schema支持")
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    connection = args.root / "connection"
    receipts = []
    state_path = args.root / "session.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}

    def keep():
        temporary = state_path.with_suffix(".tmp")
        temporary.write_bytes(encoded(state))
        temporary.replace(state_path)

    def record(surface, action, result, size, elapsed):
        receipts.append(dict(surface=surface, action=action, status=result.get("status"),
                             error=result.get("error", {}).get("code"), bytes=size,
                             elapsed_ms=round(elapsed * 1000),
                             receipt_sha256=hashlib.sha256(encoded(result)).hexdigest()))

    def cli(action, value):
        start = time.monotonic()
        process = subprocess.run([str(args.cli), "--client", "codex", "--collaboration-dir", str(connection),
                                  "call", action, "--input", "-"], input=encoded(value), capture_output=True, timeout=60)
        assert not process.stderr, process.stderr.decode()
        result = json.loads(process.stdout)
        record("cli", action, result, len(process.stdout), time.monotonic() - start)
        return result

    def ok(result):
        assert result["status"] == "succeeded", result
        return result["data"]

    # 所有实际执行键在调用前固定；重复运行仅重放同一筹备与任务。
    discovery = ok(cli("hetu.collaboration.inspect", {}))
    assert len(discovery["actions"]) <= 25 and len(encoded(discovery)) < 20000
    assert all("input_schema" not in action for action in discovery["actions"])
    diagnostic = ok(cli("hetu.runtime.inspect", {"observed_skill_version": "0.3.7"}))
    assert diagnostic["session_skill_loading"] == "unknown"
    assert diagnostic["checks"][2]["state"] == "different"
    if args.extended:
        schema = ok(cli("hetu.collaboration.inspect", {"action": "hetu.task_checkpoint.save", "include_schema": True}))
        assert "hypothesis" in json.dumps(schema) and "handoff" in json.dumps(schema), "运行版尚未提供增强接续合同"
    created = ok(cli("hetu.creation_projects.create", {"brief": "本对话机器接续验收，独立测试筹备，不采用或定稿。",
                                                        "locale": "zh-CN", "operation_key": "acceptance-project"}))
    management = created["management_ref"]
    if "task_locator" not in state:
        preview = ok(cli("hetu.creative_tasks.preview_prompt", {"management_ref": management,
            "scope_ref": management["scope_ref"], "task_kind": "book_profile", "brief": "为雨夜渡口的悬疑故事准备简介参考，保留未知问题。",
            "input_refs": [], "client_adapter": "codex", "language_tag": "zh-CN"}))
        value = preview["prepare_input"] | {"management_ref": management, "operation_key": "acceptance-task"}
        value = state.setdefault("prepare_input", value)
        keep()
        task = ok(cli("hetu.creative_tasks.prepare", value))
        state["task_locator"] = task["task_locator"]
        keep()

    class Mcp:
        def __init__(self):
            self.process = subprocess.Popen([str(args.mcp), "--client", "codex", "--collaboration-dir", str(connection)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            atexit.register(self.cleanup)
            self.number = 0
            self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                   "clientInfo": {"name": "hetu-conversation-acceptance", "version": "1"}})
            self.process.stdin.write(encoded({"jsonrpc": "2.0", "method": "notifications/initialized"}) + b"\n")

        def rpc(self, method, params):
            self.number += 1
            self.process.stdin.write(encoded({"jsonrpc": "2.0", "id": self.number, "method": method, "params": params}) + b"\n")
            deadline = time.monotonic() + 60
            while True:
                assert select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))[0], "MCP timed out; keep original input and key"
                line = self.process.stdout.readline()
                assert line, "MCP closed before returning a receipt"
                value = json.loads(line)
                if value.get("id") == self.number:
                    assert "error" not in value, value
                    return value["result"], len(line)

        def call(self, action, value, view=None):
            start = time.monotonic()
            arguments = {"action": action, "input": value}
            if view is not None:
                arguments["view"] = view
            result, size = self.rpc("tools/call", {"name": "hetu_call_action", "arguments": arguments})
            record("mcp", action, result["structuredContent"], size, time.monotonic() - start)
            assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
            assert size <= 65536, (action, size)
            return result["structuredContent"]

        def close(self):
            self.process.stdin.close()
            assert self.process.wait(timeout=30) == 0
            assert not self.process.stderr.read()

        def cleanup(self):
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)

    mcp = Mcp()
    tools, _ = mcp.rpc("tools/list", {})
    assert len(tools["tools"]) <= 12
    task_ref = ok(mcp.call("hetu.collaboration.open", {"task_locator": state["task_locator"]}))["task_ref"]
    long_text = "旧渡口的灯忽然熄灭，摆渡人却说那盏灯已经亮了三十年。\r\n" + "中文与Emoji🌿的固定传输测试。\r\n" * 3000
    first_input = {"task_ref": task_ref, "artifact_kind": "synopsis", "source_format": "plain", "title": "第一版简介",
                   "base_refs": [], "content": long_text, "operation_key": "acceptance-copy"}
    first_receipt = mcp.call("hetu.working_copies.create", first_input)
    first = ok(first_receipt)
    assert mcp.call("hetu.working_copies.create", first_input) == first_receipt
    feedback_input = {"task_ref": task_ref, "target_refs": [{"kind": "working_copy", "working_copy_ref": first["working_copy_ref"]}],
        "expected_feedback_head": None, "intent": "request_changes", "public_comment": "Agent自查：保留渡口悬念，缩短测试长文；本意见不代表作者验收。",
        "selected_refs": [], "operation_key": "acceptance-feedback"}
    feedback = ok(mcp.call("hetu.task_feedback.save", feedback_input))
    feedback_ref = feedback["feedback_ref"]
    checkpoint = {"phase": "等待简介返工", "working_copy_refs": [first["working_copy_ref"]], "feedback_refs": [feedback_ref],
        "coverage": [], "statements": [{"kind": "question", "text": "摆渡人的说法是否可靠，留给作者选择。", "context_refs": []}],
        "next_actions": ["沿原稿处理公开意见，保存第二版并固定提交。"], "pending_operations": []}
    extended_checks = []
    if args.extended:
        checkpoint["steps"] = [{"title": "读取固定初稿与意见", "status": "done"},
                               {"title": "验证短简介保留失踪乘客", "status": "doing"}]
        checkpoint["statements"] += [
            {"kind": "observation", "text": "第一稿含中文、Emoji及CRLF。", "context_refs": [],
             "working_copy_refs": [first["working_copy_ref"]]},
            {"kind": "derivation", "text": f"第一稿UTF-8共{len(long_text.encode())}字节。", "context_refs": [],
             "working_copy_refs": [first["working_copy_ref"]]},
            {"kind": "hypothesis", "text": "缩短后仍可保留失踪乘客信息。", "context_refs": [],
             "prediction": "新版少于100字符，仍包含失踪和乘客。", "status": "testing", "feedback_refs": [feedback_ref]}]
        checkpoint["handoff"] = {"summary": "已保存长初稿与Agent自查，继续同一稿返工。",
                                 "pitfalls": ["意见是Agent自查，不能称为作者决定。", "传输分块结束不等于语义通读。"]}
        current = ok(mcp.call("hetu.task_checkpoint.get", {"task_ref": task_ref}))
        forged = dict(first["working_copy_ref"], sha256="0" * 64)
        for index, statement in enumerate([
            {"kind": "observation", "text": "无来源观察", "context_refs": []},
            {"kind": "hypothesis", "text": "没有依据的支持", "prediction": "需要核对", "status": "supported", "context_refs": []},
            {"kind": "hypothesis", "text": "缺少预测", "status": "testing", "context_refs": []},
            {"kind": "observation", "text": "伪造工作稿摘要", "context_refs": [], "working_copy_refs": [forged]},
            {"kind": "observation", "text": "伪造公开反馈摘要", "context_refs": [],
             "feedback_refs": [dict(feedback_ref, sha256="0" * 64)]},
        ]):
            invalid = copy.deepcopy(checkpoint)
            invalid["statements"] = [statement]
            rejected = mcp.call("hetu.task_checkpoint.save", {"task_ref": task_ref, "expected": current["expected"],
                "checkpoint": invalid, "operation_key": f"invalid-evidence-{index}"})
            assert rejected["status"] != "succeeded", rejected
            assert ok(mcp.call("hetu.task_checkpoint.get", {"task_ref": task_ref}))["expected"] == current["expected"]
        extended_checks.append("unbacked_claims_and_forged_evidence_denied_without_writes")
    saved = ok(mcp.call("hetu.task_checkpoint.save", {"task_ref": task_ref, "expected": None, "checkpoint": checkpoint, "operation_key": "acceptance-checkpoint"}))
    mcp.close()
    mcp = Mcp()
    opened = ok(mcp.call("hetu.collaboration.open", {"task_locator": state["task_locator"]}))
    assert opened["checkpoint"]["expected"] == state.get("delivered_expected", saved["expected"])
    loaded = ok(mcp.call("hetu.task_checkpoint.get", {"task_ref": task_ref}))
    assert loaded["checkpoint"] == state.get("delivered_checkpoint", checkpoint)
    if args.extended:
        assert loaded["authority"] == "agent_notes"
        assert loaded["checkpoint"]["handoff"] == state.get("delivered_checkpoint", checkpoint)["handoff"]
        extended_checks += ["evidence_links_and_handoff_reopened", "agent_notes_never_become_author_facts"]
        missing = mcp.call("hetu.operations.get", {"task_ref": task_ref, "action": "hetu.task_checkpoint.save", "key": "never-sent"})
        assert missing["error"]["code"] == "not_found", missing
        changed = copy.deepcopy(first_input)
        changed["content"] = "相同原键改变输入，不得覆盖旧稿。"
        assert mcp.call("hetu.working_copies.create", changed)["error"]["code"] == "idempotency_conflict"
        projected = ok(mcp.call("hetu.runtime.inspect", {}, {"result_path": "/runtime_version"}))
        assert projected["view"]["page"]["content"] == diagnostic["runtime_version"]
        stale = mcp.call("hetu.runtime.inspect", {}, {"expected_result_sha256": "0" * 64})
        assert stale["error"]["code"] == "hetu.stale_evidence"
        write_view = mcp.call("hetu.working_copies.create", first_input, {})
        assert write_view["error"]["code"] == "invalid_input"
        extended_checks += ["missing_operation_not_found", "changed_input_same_key_denied",
                            "readonly_projection_snapshot_checked", "write_projection_denied"]
    conflict = mcp.call("hetu.task_checkpoint.save", {"task_ref": task_ref, "expected": None, "checkpoint": checkpoint, "operation_key": "acceptance-stale"})
    assert conflict["error"]["resolution"]["action"] == "hetu.task_checkpoint.get"
    second_input = {"task_ref": task_ref, "working_copy_id": first["working_copy_ref"]["working_copy_id"], "expected": first["working_copy_ref"],
        "content": "旧渡口熄灯的那一夜，摆渡人认出了一位三十年前已经失踪的乘客。", "feedback_refs": [feedback_ref], "operation_key": "acceptance-second"}
    second_receipt = mcp.call("hetu.working_copies.save", second_input)
    second = ok(second_receipt)
    recovered = ok(cli("hetu.operations.get", {"task_ref": task_ref, "operation_id": second_receipt["operation"]["id"], "input_digest": second_receipt["operation"]["input_digest"]}))
    assert recovered["original_result"]["data"]["working_copy_ref"] == second["working_copy_ref"]
    summary = ok(mcp.call("hetu.working_copies.get", {"task_ref": task_ref, "working_copy_ref": first["working_copy_ref"]}))
    assert summary["response"]["retained"] is True and "content" not in summary["revision"]
    position, recovered_text, pages = 0, "", 0
    while position < len(long_text.encode()):
        page = ok(mcp.call("hetu.working_copies.get", {"task_ref": task_ref, "working_copy_ref": first["working_copy_ref"],
            "range": {"byte_start": position, "byte_end": len(long_text.encode())}, "max_bytes": 8192}))["content_page"]
        recovered_text += page["content"]
        position = page["range"]["byte_end"]
        pages += 1
    assert recovered_text == long_text
    submitted = ok(mcp.call("hetu.creative_tasks.submit_result", {"task_ref": task_ref, "request_sha256": task_ref["sha256"],
        "working_copy_refs": [second["working_copy_ref"]], "feedback_refs": [feedback_ref], "complete": True, "missing_items": [],
        "provenance": {"client": "codex-conversation", "skill_version": diagnostic["bundled_skill"]["version"]}, "operation_key": "acceptance-submit"}))
    candidate = submitted["candidate_refs"][0]
    assert candidate["task_ref"] == task_ref
    fixed_candidate = ok(mcp.call("hetu.creative_tasks.read_candidate", {"task_ref": task_ref, "candidate_ref": candidate, "max_bytes": 1024}))
    assert fixed_candidate["page"]["content"] == second_input["content"]
    public_feedback = ok(mcp.call("hetu.task_feedback.list", {"task_ref": task_ref}))
    assert public_feedback["feedback_head"] == feedback_ref
    assert any(result.get("working_copy_ref") == second["working_copy_ref"]
               for result in public_feedback["feedback"][0]["reported_result_refs"])
    assert public_feedback["feedback"][0]["author_acceptance"] == "not_implied"
    completed = checkpoint | {"phase": "参考稿已交付，等待作者评审", "working_copy_refs": [second["working_copy_ref"]],
                              "next_actions": ["等待作者对固定候选的实际意见，不自动采纳或定稿。"]}
    if args.extended:
        assert len(second_input["content"]) < 100 and all(word in second_input["content"] for word in ("失踪", "乘客"))
        completed = copy.deepcopy(completed)
        completed["statements"][-1]["status"] = "supported"
        completed["statements"][-1]["working_copy_refs"] = [second["working_copy_ref"]]
        completed["steps"][-1]["status"] = "done"
        completed["handoff"]["summary"] = "两版参考稿已保存，固定提交已回读，等待作者对候选的实际意见。"
        extended_checks.append("prediction_verified_against_fixed_revised_artifact")
    delivered=ok(mcp.call("hetu.task_checkpoint.save", {"task_ref": task_ref, "expected": saved["expected"],
                                               "checkpoint": completed, "operation_key": "acceptance-delivered"}))
    state["delivered_expected"]=delivered["expected"]
    state["delivered_checkpoint"]=completed
    keep()
    if args.extended:
        current = ok(mcp.call("hetu.task_checkpoint.get", {"task_ref": task_ref}))
        assert current["checkpoint"]["statements"][-1]["status"] == "supported"
        assert current["checkpoint"]["statements"][1]["working_copy_refs"] == [first["working_copy_ref"]]
        assert current["checkpoint"]["handoff"] == completed["handoff"]
        extended_checks.append("old_evidence_revision_preserved_after_new_draft")
    denied = mcp.call("hetu.collaboration.invoke", {"action": "hetu.collaboration.invoke", "input": {}})
    assert denied["error"]["code"] == "invalid_input"
    mcp.close()
    report = {"schema_version": "1.0.0", "kind": "conversation_machine_acceptance", "runtime_version": diagnostic["runtime_version"],
        "cli_sha256": hashlib.sha256(args.cli.read_bytes()).hexdigest(), "mcp_sha256": hashlib.sha256(args.mcp.read_bytes()).hexdigest(),
        "methods_version": diagnostic["bundled_skill"]["version"], "catalog_sha256": discovery["catalog_sha256"],
        "default_tool_count": len(tools["tools"]), "discovery_bytes": len(encoded(discovery)), "fixed_text_bytes": len(long_text.encode()),
        "fixed_text_sha256": hashlib.sha256(long_text.encode()).hexdigest(), "fixed_text_pages": pages,
        "checks": ["bounded_discovery", "version_difference", "generic_dispatch", "idempotent_save", "public_feedback", "checkpoint_reopen",
                   "checkpoint_conflict", "cli_mcp_recovery", "oversize_fixed_summary", "old_revision_unicode_reassembly", "fixed_submission", "fixed_candidate_read", "delivered_checkpoint", "recursive_dispatch_denied"] + extended_checks,
        "limits": ["synthetic_creation_project", "no_author_adoption_or_finalization", "no_paid_model_calls", "installed_desktop_not_updated"], "receipts": receipts}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "receipts"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
