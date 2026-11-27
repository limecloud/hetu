#!/usr/bin/env python3
"""隔离验证公开CLI/MCP、真实PTY、Bot配置与固定协议会话；不调用付费模型。"""
import json
import os
import base64
import hashlib
import select
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = Path(os.environ.get("HETU_TEST_NODE", "/Users/coso/.nvm/versions/node/v25.0.0/bin/node"))
CLI = Path(os.environ.get("HETU_TEST_CLI", str(ROOT / "target/debug/hetu")))
MCP = Path(os.environ.get("HETU_TEST_MCP", str(ROOT / "target/debug/hetu-mcp")))
SCRATCH = Path(tempfile.mkdtemp(prefix="hetu-external-accept-"))
COLLAB = SCRATCH / "collaboration"
COLLAB.mkdir()
FIXTURE_NODE = SCRATCH / "node"
FIXTURE_NODE.symlink_to(NODE)
ENV = {**os.environ, "HETU_LOCAL_SETTINGS_DIR": str(SCRATCH / "settings"),
       "HETU_PLUGIN_NODE": str(NODE), "HETU_OPENCODE_BIN": str(SCRATCH / "opencode"),
       "TEST_PROTOCOL_LOG": str(SCRATCH / "wire.jsonl")}
CHECKS = []
OUTPUT = Path(os.environ.get("HETU_TEST_OUTPUT", str(ROOT / "output/verification/external-execution-2026-11-27")))
COMPUTER_MODE = os.environ.get("HETU_TEST_COMPUTER_MODE", "full")
assert COMPUTER_MODE in ("full", "image-only"), "computer test mode must be explicit"


def call(domain, value, client="generic"):
    result = subprocess.run([str(CLI), "--client", client,
                             "--collaboration-dir", str(COLLAB), "call",
                             f"hetu.{domain}.request", "--input", "-"],
                            input=json.dumps(value), capture_output=True, text=True,
                            env=ENV, timeout=50)
    return json.loads(result.stdout)


def ok(result):
    assert result["status"] == "succeeded", result.get("error")
    return result["data"]


def check(name, **details):
    CHECKS.append({"name": name, "passed": True, **details})
    print(name, flush=True)


class Mcp:
    def __init__(self, command=None):
        self.process = subprocess.Popen(command or [str(MCP), "--client", "generic",
                                         "--collaboration-dir", str(COLLAB)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=ENV)
        self.sequence = 0
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "hetu-isolated-acceptance", "version": "1"}})
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.process.stdin.flush()

    def rpc(self, method, params):
        self.sequence += 1
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.sequence,
                                            "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.process.stdout], [], [], max(0, deadline-time.monotonic()))
            assert ready, "MCP timeout"
            line = self.process.stdout.readline()
            assert line, "MCP closed"
            value = json.loads(line)
            if value.get("id") == self.sequence:
                assert "error" not in value, value.get("error")
                return value["result"]
        raise AssertionError("MCP timeout")

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)


def computer_journey(mcp, permissions):
    image_only = COMPUTER_MODE == "image-only"
    if sys.platform != "darwin" or not permissions.get("screen_capture") or not image_only and not permissions.get("accessibility"):
        CHECKS.append({"name": "public native computer journey", "passed": False,
                       "not_run": "requires macOS helper and existing accessibility/screen capture permissions"})
        return
    binary = SCRATCH / "computer-fixture"
    subprocess.run(["xcrun", "swiftc", str(ROOT / "apps/desktop/tests/fixtures/computer-window.swift"),
                    "-o", str(binary)], capture_output=True, check=True, timeout=60)
    fixture = subprocess.Popen([str(binary), *(["--screenshot-only"] if image_only else [])], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        assert select.select([fixture.stdout], [], [], 10)[0], "native fixture startup timeout"
        assert fixture.stdout.readline().startswith("READY "), "native fixture not ready"
        target = {"pid": fixture.pid}
        deadline = time.monotonic() + 5
        while True:
            windows = ok(call("computer", {"method": "windows", "app": target, "limit": 128}))["items"]
            matches = [window for window in windows if window.get("title") == "HETU-COMPUTER-FIXTURE"]
            if matches:
                break
            assert time.monotonic() < deadline, "fixture window not found"
            time.sleep(.1)
        session = "computer-public-fixture"
        observe = {"method": "snapshot", "session_id": session, "app": target,
                   "window_id": matches[0]["window_id"], "screenshot": {"max_edge": 800}}
        snapshot = ok(call("computer", observe))
        if image_only:
            assert snapshot["accessibility_status"]["state"] == "unavailable" and snapshot["elements"] == []
        else:
            field = next(row for row in snapshot["elements"] if row.get("identifier") == "hetu-fixture-input")
            assert field["value"] == "SAFE-COMPUTER-FIXTURE"
        pixels = base64.b64decode(snapshot["screenshot"]["data"], validate=True)
        assert pixels.startswith(b"\x89PNG\r\n\x1a\n")
        OUTPUT.mkdir(parents=True, exist_ok=True)
        screenshot = OUTPUT / "native-fixture.png"
        screenshot.write_bytes(pixels)
        subprocess.run(["sips", "-s", "format", "png", str(screenshot), "--out",
                        str(SCRATCH / "decoded.png")], capture_output=True, check=True, timeout=10)
        response = mcp.rpc("tools/call", {"name": "hetu_computer", "arguments": observe})
        assert response.get("isError") is not True, response
        images = [block for block in response["content"] if block["type"] == "image"]
        assert len(images) == 1 and images[0]["mimeType"] == "image/png"
        assert base64.b64decode(images[0]["data"], validate=True).startswith(b"\x89PNG")
        structured = response["structuredContent"]
        assert structured["data"]["screenshot"]["delivered_as"] == "mcp_image"
        assert "data" not in structured["data"]["screenshot"]
        check("public CLI native snapshot and MCP image block decode", nodes=len(snapshot["elements"]),
              png_sha256=hashlib.sha256(pixels).hexdigest(), pixel_width=snapshot["screenshot"]["width"],
              pixel_height=snapshot["screenshot"]["height"])
        if image_only:
            action = {"method": "act", "session_id": session, "snapshot_ref": snapshot["snapshot_ref"],
                      "element_index": 0, "operation_key": "image-only-ax-refused",
                      "action": {"kind": "set_value", "text": "MUST-NOT-BE-WRITTEN"}}
            assert call("computer", action)["status"] != "succeeded"
            latest = ok(call("computer", observe))
            ok(call("computer", {"method": "takeover", "session_id": session,
                                  "snapshot_ref": latest["snapshot_ref"], "operation_key": "image-only-takeover"}))
            owner = ok(call("computer", observe))
            assert owner["control"]["state"] == "taken_over" and owner["control"]["owned"]
            foreign = ok(call("computer", {**observe, "session_id": "foreign-image-only"}, "codex"))
            assert foreign["control"]["state"] == "taken_over" and not foreign["control"]["owned"]
            window_action = {"method": "act", "session_id": "foreign-image-only",
                             "snapshot_ref": foreign["snapshot_ref"], "operation_key": "image-only-frozen",
                             "action": {"kind": "focus_window"}}
            frozen = call("computer", window_action, "codex")
            assert frozen["error"]["code"] == "computer_taken_over", frozen
            ok(call("computer", {"method": "resume", "session_id": session,
                                  "snapshot_ref": owner["snapshot_ref"], "operation_key": "image-only-resume"}))
            stale = call("computer", {**window_action, "session_id": session,
                                       "snapshot_ref": owner["snapshot_ref"], "operation_key": "image-only-stale"})
            assert stale["error"]["code"] == "snapshot_stale", stale
            assert ok(call("computer", observe))["control"]["state"] == "active"
            check("public screenshot-only observation, AX refusal and cross-client takeover/resume", full_ax_verified=False)
            return
        action = {"method": "act", "session_id": session, "snapshot_ref": snapshot["snapshot_ref"],
                  "element_index": field["index"], "operation_key": "computer-set-value",
                  "action": {"kind": "set_value", "text": "SAFE-PUBLIC-AX-VALUE"},
                  "verify": {"value_equals": "SAFE-PUBLIC-AX-VALUE"}}
        receipt = ok(call("computer", action))
        assert receipt["state"] == "succeeded", receipt
        assert receipt["result"]["readback"]["verification"] == "matched_at_original_route", receipt
        assert ok(call("computer", action)) == receipt, "repeat key dispatched instead of reading original receipt"
        assert call("computer", {**action, "action": {"kind": "set_value", "text": "changed"}})["status"] != "succeeded"
        assert call("computer", {**action, "operation_key": "foreign-ref"}, "codex")["status"] != "succeeded"
        latest = ok(call("computer", observe))
        takeover = {"method": "takeover", "session_id": session, "snapshot_ref": latest["snapshot_ref"],
                    "operation_key": "computer-takeover"}
        ok(call("computer", takeover))
        owner_snapshot = ok(call("computer", observe))
        assert owner_snapshot["control"]["state"] == "taken_over" and owner_snapshot["control"]["owned"]
        foreign_observe = {**observe, "session_id": "foreign-computer"}
        foreign = ok(call("computer", foreign_observe, "codex"))
        assert foreign["control"]["state"] == "taken_over" and not foreign["control"]["owned"]
        frozen = {**action, "session_id": "foreign-computer", "snapshot_ref": foreign["snapshot_ref"],
                  "operation_key": "foreign-frozen"}
        assert call("computer", frozen, "codex")["error"]["code"] == "computer_taken_over"
        assert call("computer", {"method": "resume", "session_id": session,
                                  "snapshot_ref": latest["snapshot_ref"], "operation_key": "stale-resume"})["error"]["code"] == "snapshot_stale"
        resume = {"method": "resume", "session_id": session, "snapshot_ref": owner_snapshot["snapshot_ref"],
                  "operation_key": "computer-resume"}
        ok(call("computer", resume))
        assert call("computer", {**action, "snapshot_ref": owner_snapshot["snapshot_ref"],
                                  "operation_key": "stale-after-resume"})["error"]["code"] == "snapshot_stale"
        final = ok(call("computer", observe))
        assert final["control"]["state"] == "active"
        field = next(row for row in final["elements"] if row.get("identifier") == "hetu-fixture-input")
        final_action = {**action, "snapshot_ref": final["snapshot_ref"], "element_index": field["index"],
                        "operation_key": "new-after-resume", "action": {"kind": "set_value", "text": "SAFE-RESUMED-AX"},
                        "verify": {"value_equals": "SAFE-RESUMED-AX"}}
        assert ok(call("computer", final_action))["result"]["readback"]["verification"] == "matched_at_original_route"
        check("public background AX set value, original key, cross-client takeover and fresh-observation resume")
    finally:
        fixture.terminate()
        fixture.wait(timeout=5)


def main():
    fixture = subprocess.run([str(ROOT / "target/debug/examples/external_execution_fixture"),
                              str(SCRATCH / "work"), str(COLLAB)], capture_output=True,
                             text=True, env=ENV, check=True, timeout=20)
    work = json.loads(fixture.stdout)["work_ref"]
    materialize = "import {acp} from './apps/desktop/tests/fixtures/external-protocol-fixture.ts';import {writeFileSync} from 'node:fs';writeFileSync(process.argv[1],acp.replace('NODE',process.argv[2]).replace('FIXTURE_VERSION','2.0.14'),{mode:0o700});"
    subprocess.run([str(NODE), "--input-type=module", "-e", materialize, str(SCRATCH / "opencode"), str(FIXTURE_NODE)], cwd=ROOT, check=True)
    (SCRATCH / "wire.jsonl").write_text("")
    for domain in ("sessions", "bots", "computer"):
        assert ok(call(domain, {"method": "capabilities"}))["input_schema"]["oneOf"]
    check("CLI schemas discovered")
    mcp = Mcp()
    try:
        names = {tool["name"] for tool in mcp.rpc("tools/list", {})["tools"]}
        assert {"hetu_sessions", "hetu_bots", "hetu_computer"} <= names
        for domain in ("sessions", "bots", "computer"):
            response = mcp.rpc("tools/call", {"name": f"hetu_{domain}", "arguments": {"method": "capabilities"}})
            assert response.get("isError") is not True, response
            assert response["structuredContent"]["status"] == "succeeded"
        check("stdio MCP exposes all three execution tools")
        created = ok(call("sessions", {"method": "create", "launch": {"client": "shell", "surface": "tui"}, "operation_key": "shell-create"}))
        started = ok(call("sessions", {"method": "start", "session_id": created["session_id"], "generation": created["generation"], "operation_key": "shell-start"}))
        write = {"method": "input", "session_id": started["session_id"], "generation": started["generation"],
                 "data": "printf 'HETU-PUBLIC-PTY-OK\\n'\r", "operation_key": "shell-input"}
        ok(call("sessions", write))
        time.sleep(.2)
        assert "HETU-PUBLIC-PTY-OK" in ok(call("sessions", {"method": "read", "session_id": started["session_id"]}))["output"]
        ok(call("sessions", write))
        changed = {**write, "data": "different"}
        assert call("sessions", changed)["status"] != "succeeded"
        ok(call("sessions", {"method": "stop", "session_id": started["session_id"], "generation": started["generation"], "operation_key": "shell-stop"}))
        assert call("sessions", {**write, "operation_key": "stale-input"})["status"] != "succeeded"
        check("real PTY survives CLI calls; repeat keys and stale generations fenced")
        config = {"name": "固定协议助手", "purpose": "阅读当前隔离小说，保留作者意见。", "execution": {"provider_id": "opencode", "surface": "gui", "model_id": "test-model"}}
        bot = ok(call("bots", {"method": "create", "work_ref": work, "config": config, "operation_key": "bot-create"}))
        reference = bot["bot_ref"]
        assert ok(call("bots", {"method": "get", "bot_id": reference["bot_id"], "work_ref": work}))["bot"]["config"] == config
        bad = {**work, "object_id": "different-work"}
        assert call("bots", {"method": "get", "bot_id": reference["bot_id"], "work_ref": bad})["status"] != "succeeded"
        assert call("bots", {"method": "get", "bot_id": reference["bot_id"], "work_ref": work}, "codex")["status"] != "succeeded"
        check("Bot configuration fixed to actual Core work and client scope")
        session = ok(call("bots", {"method": "session_create", "expected_ref": reference, "work_ref": work, "operation_key": "bot-session"}))
        identity = session["result"]
        started = ok(call("bots", {"method": "session_start", "session_id": identity["session_id"], "generation": identity["generation"], "work_ref": work, "operation_key": "bot-start"}))["result"]
        send = {"method": "session_send", "session_id": started["session_id"], "generation": started["generation"], "work_ref": work, "data": "核对隔离样本", "operation_key": "bot-send"}
        ok(call("bots", send))
        original = ok(call("bots", {"method": "operation", "operation_key": "bot-send"}))
        assert original["state"] == "succeeded" and original["result"]["session_id"] == started["session_id"]
        read = ok(call("bots", {"method": "session_read", "session_id": started["session_id"], "work_ref": work}))
        approval = read["external"]["approvals"][0]
        request = ok(call("bots", {"method": "session_interaction", "session_id": started["session_id"], "request_id": approval["id"], "work_ref": work}))["request"]
        assert any(option["id"] == "allow-once" for option in request["options"])
        ok(call("bots", {"method": "session_approve", "session_id": started["session_id"], "generation": started["generation"], "approval_id": approval["id"], "option_id": "allow-once", "work_ref": work, "operation_key": "bot-approve"}))
        ok(call("bots", send))
        wire = [json.loads(line) for line in (SCRATCH / "wire.jsonl").read_text().splitlines()]
        assert sum(value.get("method") == "session/prompt" for value in wire) == 1
        conversation = ok(call("bots", {"method": "session_read", "session_id": started["session_id"], "work_ref": work, "format": "conversation"}))
        assert any(message["role"] == "user" and message["text"] == "核对隔离样本" for message in conversation["conversation"]["messages"])
        profile = COLLAB / "sessions/generic/profile"
        session_record = json.loads((profile / "agent-sessions" / (started["session_id"] + ".json")).read_text())
        scope_digest = hashlib.sha256(json.dumps([session_record["cwd"], str(COLLAB), session_record["work_ref"], False], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        sandbox = profile / "external-sessions" / scope_digest / session_record["external_state"]["id"] / "opencode"
        relay_script = MCP.parent.parent / "app/dist/agent-mcp-relay.mjs"
        if not relay_script.is_file():
            assert MCP.parent.name in ("debug", "release"), "packaged relay missing"
            relay_script = ROOT / "apps/desktop/dist/agent-mcp-relay.mjs"
        relay = Mcp([str(NODE), str(relay_script), str(sandbox / "hetu-mcp.json")])
        try:
            response = relay.rpc("tools/call", {"name": "hetu_call_action", "arguments": {"action": "hetu.execution.invoke", "input": {"workspace_path": str(SCRATCH / "work"), "command": {"action": "hetu.documents.create", "contract_revision": "1", "input": {"kind": "novel_chapter", "title": "Bot公开回执稿", "source_format": "markdown", "content": "隔离样本：原Bot的真实MCP保存。🌿", "operation_key": "public-bot-result"}}}}})
            saved = ok(ok(response["structuredContent"])["result"])
            fixed = {"document_id": saved["document"]["document_id"], "revision_id": saved["revision"]["revision_id"], "sha256": saved["revision"]["sha256"]}
            actual = ok(relay.rpc("tools/call", {"name": "hetu_call_action", "arguments": {"action": "hetu.documents.get", "input": {"document_id": fixed["document_id"], "revision_id": fixed["revision_id"]}}})["structuredContent"])
            assert actual["work_ref"] == work and actual["revision"]["sha256"] == fixed["sha256"]
        finally:
            relay.close()
        view = ok(call("bots", {"method": "session_read", "session_id": started["session_id"], "work_ref": work, "format": "conversation"}))
        assert view["conversation"]["receipts_complete"] and any(tool["server"] == "hetu" and fixed["revision_id"] in tool["output"] for tool in view["conversation"]["receipts"])
        check("public Bot conversation retains actual MCP receipts independently verified by Core", fixed_reference=fixed)
        draft = "保留中文长草稿🍃\n" * 1200
        draft_write = {"method": "session_draft", "session_id": started["session_id"], "generation": started["generation"], "work_ref": work, "data": draft, "operation_key": "bot-draft"}
        draft_receipt = ok(call("bots", draft_write))
        view = ok(call("bots", {"method": "session_read", "session_id": started["session_id"], "work_ref": work, "format": "conversation"}))
        assert view["draft_complete"] is False
        restored = ""; offset = 0
        while True:
            part = ok(call("bots", {"method": "session_draft_read", "session_id": started["session_id"], "work_ref": work, "generation": view["generation"], "expected_draft_version": view["draft_version"], "offset": offset, "limit": 4000}))
            restored += part["draft"]
            if part["next_offset"] is None:
                break
            offset = part["next_offset"]
        assert restored == draft
        assert call("bots", draft_write, "codex")["status"] != "succeeded"
        assert call("sessions", {"method": "draft", "session_id": started["session_id"], "generation": started["generation"], "data": "bypass", "operation_key": "draft-bypass"})["status"] != "succeeded"
        check("Bot structured messages and original-version draft paging preserve author text")
        paused = ok(call("bots", {"method": "pause", "expected_ref": reference, "work_ref": work, "operation_key": "bot-pause"}))
        assert call("bots", {**send, "operation_key": "paused-send"})["status"] != "succeeded"
        ok(call("bots", {**draft_write, "data": draft + "停用后保留。", "operation_key": "paused-draft"}))
        assert ok(call("bots", draft_write)) == draft_receipt
        assert call("sessions", {"method": "send", "session_id": started["session_id"], "generation": started["generation"], "work_ref": work, "data": "bypass", "operation_key": "bypass"})["status"] != "succeeded"
        ok(call("bots", {"method": "session_read", "session_id": started["session_id"], "work_ref": work}))
        ok(call("bots", {"method": "session_stop", "session_id": started["session_id"], "generation": started["generation"], "work_ref": work, "operation_key": "bot-stop"}))
        assert call("bots", {"method": "update", "expected_ref": reference, "patch": {"name": "stale"}, "work_ref": work, "operation_key": "stale-update"})["status"] != "succeeded"
        assert paused["bot_ref"]["revision"] > reference["revision"]
        check("fixed Bot model, original approvals, once-only send, pause/CAS and regular-session bypass")
        permissions = ok(call("computer", {"method": "permissions"}))
        assert permissions["prompt_requested"] is False
        assert ok(call("computer", {"method": "apps", "limit": 128}))["items"]
        check("native computer observation without permission prompts", permissions=permissions)
        computer_journey(mcp, permissions)
    finally:
        mcp.close()
if __name__ == "__main__":
    failure = None
    try:
        main()
    except BaseException as error:
        failure = type(error).__name__ + ": " + str(error)
        raise
    finally:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        runtime = {name: {"path": str(binary.resolve()), "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
                   for name, binary in (("cli", CLI), ("mcp", MCP), ("node", NODE))}
        service = CLI.parent.parent / "app/dist/agent-machine-service.mjs"
        if not service.is_file() and CLI.parent.name in ("debug", "release"):
            service = ROOT / "apps/desktop/dist/agent-machine-service.mjs"
        if service.is_file():
            runtime["agent_machine_service"] = {"path": str(service.resolve()), "sha256": hashlib.sha256(service.read_bytes()).hexdigest()}
        (OUTPUT / "machine-acceptance.json").write_text(json.dumps({"passed": failure is None and all(row["passed"] for row in CHECKS), "checks": CHECKS, "runtime": runtime, "computer_mode": COMPUTER_MODE, "full_ax_verified": COMPUTER_MODE == "full" and failure is None and any(row["name"].startswith("public background AX") for row in CHECKS), "paid_model_calls": 0, "error": failure}, ensure_ascii=False, indent=2) + "\n")
