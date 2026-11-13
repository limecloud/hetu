#!/usr/bin/env python3
"""通过真实动态库核验 C ABI 所有权、UTF-8、任务与 Agent 权限。"""
import argparse
import ctypes as c
import fcntl
import json
from pathlib import Path
import tempfile
import subprocess

ROOT = Path(__file__).resolve().parent.parent

class Buffer(c.Structure):
    _fields_ = [("data", c.POINTER(c.c_uint8)), ("size", c.c_uint64)]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", action="store_true", help="同时验证已构建 Swift CLI 的 JSON 管道与退出码")
    args = parser.parse_args()
    lib = c.CDLL(str(ROOT / "build/native/lib/libhetu_core.dylib"))
    byte_pointer = c.POINTER(c.c_uint8)
    lib.hetu_context_open.argtypes = [byte_pointer, c.c_uint64, c.POINTER(c.c_void_p), c.POINTER(Buffer)]
    lib.hetu_request.argtypes = [c.c_void_p, byte_pointer, c.c_uint64, c.POINTER(Buffer)]
    lib.hetu_task_start.argtypes = [c.c_void_p, byte_pointer, c.c_uint64, c.POINTER(c.c_void_p), c.POINTER(Buffer)]
    lib.hetu_task_poll.argtypes = [c.c_void_p, c.POINTER(Buffer)]
    lib.hetu_task_cancel.argtypes = [c.c_void_p, c.POINTER(Buffer)]
    lib.hetu_buffer_free.argtypes = [c.POINTER(Buffer)]
    lib.hetu_context_close.argtypes = [c.c_void_p]
    lib.hetu_task_release.argtypes = [c.c_void_p]
    for name in ["hetu_buffer_free", "hetu_context_close", "hetu_task_release"]:
        getattr(lib, name).restype = None
    def take(buffer):
        try:
            return json.loads(c.string_at(buffer.data, buffer.size))
        finally:
            lib.hetu_buffer_free(c.byref(buffer))
            assert not buffer.data and buffer.size == 0
            lib.hetu_buffer_free(c.byref(buffer))
    def payload(value):
        data = json.dumps(value, ensure_ascii=False).encode()
        return (c.c_uint8 * len(data)).from_buffer_copy(data)
    def opened(path, mode, create=False):
        config = {"workspace_path": str(path), "mode": mode}
        if create:
            config["create"] = {"title": "中文 ABI 项目", "locale": "zh-CN", "operation_key": "init"}
        data = payload(config); context = c.c_void_p(); out = Buffer()
        assert lib.hetu_context_open(data, len(data), c.byref(context), c.byref(out)) == 0
        receipt = take(out)
        assert receipt["status"] == "succeeded", receipt
        assert context.value
        return context
    def request(context, action, fields):
        data = payload({"action": action, "contract_revision": "1", "input": fields}); out = Buffer()
        assert lib.hetu_request(context, data, len(data), c.byref(out)) == 0
        return take(out)

    assert lib.hetu_abi_version() == 1
    with tempfile.TemporaryDirectory(prefix="河图 ABI ") as folder:
        path = Path(folder) / "我的作品 空格"
        author = opened(path, "author", True)
        created = request(author, "hetu.documents.create", {"kind":"novel_chapter", "title":"第一章", "source_format":"markdown", "content":"你好，雨夜。🌧️", "operation_key":"create"})
        assert created["status"] == "succeeded", created
        agent = opened(path, "agent")
        read = request(agent, "hetu.documents.get", {"document_id":created["data"]["document"]["document_id"]})
        assert read["data"]["content"] == "你好，雨夜。🌧️"
        denied = request(agent, "hetu.documents.save", {"document_id":created["data"]["document"]["document_id"], "base_revision_id":created["data"]["revision"]["revision_id"], "source_format":"markdown", "content":"不应写入", "operation_key":"deny"})
        assert denied["error"]["code"] == "forbidden"
        if args.cli:
            command = [str(ROOT / ".build/debug/hetu"), "--workspace", str(path), "call"]
            read_process = subprocess.run([*command, "hetu.documents.get", "--input", "-"], input=json.dumps({"document_id":created["data"]["document"]["document_id"]}), text=True, capture_output=True, cwd=folder, timeout=30)
            assert read_process.returncode == 0, read_process.stderr
            assert not read_process.stderr
            assert json.loads(read_process.stdout)["data"]["content"] == "你好，雨夜。🌧️"
            denied_process = subprocess.run([*command, "hetu.documents.create", "--input", "-"], input=json.dumps({"kind":"novel_chapter", "title":"越权新建", "source_format":"markdown", "content":"不能绕过权限", "operation_key":"denied-cli"}), text=True, capture_output=True, cwd=folder, timeout=30)
            assert denied_process.returncode == 3, denied_process.stdout
            assert json.loads(denied_process.stdout)["error"]["code"] == "forbidden"
            draft_input = json.dumps({"package":"novel", "source_format":"markdown", "title":"跨进程草稿", "content":"同一原操作只接收一次。", "blueprint_revision":1, "operation_key":"cli-replay"})
            with (path / ".hetu/workspace.lock").open("r+b") as lease:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                info_process = subprocess.run([*command, "hetu.workspaces.get", "--input", "-"], input="{}", text=True, capture_output=True, cwd=folder, timeout=30)
                assert info_process.returncode == 0 and not info_process.stderr, info_process.stdout
                assert json.loads(info_process.stdout)["data"]["access"]["write_available"] is False
                reading_process = subprocess.run([*command, "hetu.documents.get", "--input", "-"], input=json.dumps({"document_id":created["data"]["document"]["document_id"]}), text=True, capture_output=True, cwd=folder, timeout=30)
                assert reading_process.returncode == 0 and not reading_process.stderr, reading_process.stdout
                assert json.loads(reading_process.stdout)["data"]["content"] == "你好，雨夜。🌧️"
                busy_process = subprocess.run([*command, "hetu.drafts.submit", "--input", "-"], input=draft_input, text=True, capture_output=True, cwd=folder, timeout=30)
                assert busy_process.returncode == 5 and not busy_process.stderr, busy_process.stdout
                assert json.loads(busy_process.stdout)["error"]["code"] == "hetu.workspace_busy"
                fcntl.flock(lease, fcntl.LOCK_UN)
            receipts = []
            for _ in range(2):
                draft_process = subprocess.run([*command, "hetu.drafts.submit", "--input", "-"], input=draft_input, text=True, capture_output=True, cwd=folder, timeout=30)
                assert draft_process.returncode == 0, draft_process.stdout
                receipts.append(json.loads(draft_process.stdout))
            assert receipts[0] == receipts[1], "两个独立 CLI 进程必须返回同一草稿与原回执"
            fixture = request(author, "hetu.documents.create", {"kind":"novel_chapter", "title":"剧情预算", "source_format":"markdown", "content":"# 夜\n\n林舟推门。\n\n林舟走。", "operation_key":"plot-source"})["data"]
            plot_input = {"document_revisions":[{"document_id":fixture["document"]["document_id"], "revision_id":fixture["revision"]["revision_id"], "sha256":fixture["revision"]["sha256"]}], "blueprint_revision":1, "options":{"max_nodes":1}, "save_result":True, "operation_key":"plot-cli-partial"}
            partial_receipts = []
            for _ in range(2):
                process = subprocess.run([*command, "hetu.plot.extract", "--input", "-"], input=json.dumps(plot_input), text=True, capture_output=True, cwd=folder, timeout=30)
                assert process.returncode == 6 and not process.stderr, process.stdout
                result = json.loads(process.stdout)
                assert result["status"] == "partial" and result["data"]["saved"]
                assert result["data"]["plot"]["coverage"]["budget_stop"]["reason"] == "max_nodes"
                partial_receipts.append(result)
            assert partial_receipts[0] == partial_receipts[1], "partial 已保存结果必须沿原键恢复"
        malformed = (c.c_uint8 * 2)(0xFF, 0x00); out = Buffer()
        assert lib.hetu_request(agent, malformed, 2, c.byref(out)) == 0
        assert take(out)["error"]["code"] == "invalid_input"
        data = payload({"action":"hetu.documents.list", "contract_revision":"1", "input":{}})
        task = c.c_void_p(); out = Buffer()
        assert lib.hetu_task_start(agent, data, len(data), c.byref(task), c.byref(out)) == 0
        assert take(out)["status"] == "succeeded" and task.value
        # close 必须等待已启动任务，结果缓冲／任务句柄在上下文关闭后仍可读取。
        lib.hetu_context_close(agent)
        assert lib.hetu_task_poll(task, c.byref(out)) == 0
        receipt = take(out)
        assert receipt["data"]["task_state"] == "completed", receipt
        assert receipt["data"]["original_result"]["status"] == "succeeded", receipt
        assert lib.hetu_task_cancel(task, c.byref(out)) == 0
        assert take(out)["data"]["original_result"]["status"] == "succeeded"
        lib.hetu_task_release(task)
        lib.hetu_context_close(author)
        lib.hetu_context_close(None); lib.hetu_task_release(None); lib.hetu_buffer_free(None)
    print("C ABI：动态库、中文、缓冲释放、权限、异步任务与 close 生命周期通过")
    if args.cli:
        print("Swift CLI：仓库外启动、中文 JSON 管道、权限、写入期间可读、写入锁与释放恢复及原键重放通过")

if __name__ == "__main__":
    main()
