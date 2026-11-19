#!/usr/bin/env python3
"""交互记录真实Agent的CLI／stdio MCP选路；本工具不规划或自动执行创作步骤。"""
import argparse
import hashlib
import json
import os
import select
import subprocess
import sys
import threading
import time
from pathlib import Path


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


class Process(subprocess.Popen):
    """CPython POSIX wait路径保留wait4统计；不把采样器的CPU算入被测进程。"""
    usage = None

    def _try_wait(self, flags):
        if not hasattr(os, "wait4"):
            return super()._try_wait(flags)
        try:
            pid, status, usage = os.wait4(self.pid, flags)
            if pid:
                self.usage = usage
            return pid, status
        except ChildProcessError:
            return self.pid, 0


class Monitor:
    def __init__(self, pid):
        self.pid, self.samples, self.stopped = pid, [], threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)
        self.thread.start()

    def sample(self):
        while not self.stopped.is_set():
            try:
                rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss=,time="], timeout=5).decode().splitlines()
                processes = {}
                for row in rows:
                    pid, parent, rss, cpu = row.split()
                    components = cpu.replace("-", ":").split(":")
                    seconds = sum(float(v) * (60 ** i) for i, v in enumerate(reversed(components)))
                    processes[int(pid)] = (int(parent), int(rss) * 1024, seconds)
                family = {self.pid}
                while True:
                    found = {pid for pid, (parent, _, _) in processes.items() if parent in family}
                    if found <= family:
                        break
                    family |= found
                live = [processes[pid] for pid in family if pid in processes]
                if live:
                    self.samples.append({"at": time.monotonic(), "rss_bytes": sum(p[1] for p in live),
                                         "cpu_seconds": sum(p[2] for p in live), "pids": sorted(family & processes.keys())})
            except (ValueError, OSError, subprocess.SubprocessError):
                pass
            self.stopped.wait(.1)

    def metrics(self, start=0):
        samples = [row for row in self.samples if row["at"] >= start]
        return {"sample_interval_ms": 100, "sample_count": len(samples),
                "sampled_family_peak_rss_bytes": max((r["rss_bytes"] for r in samples), default=None),
                "observed_pids": sorted({pid for row in samples for pid in row["pids"]}),
                "limit": "sampling_may_miss_short_processes_and_peaks"}

    def close(self):
        self.stopped.set()
        self.thread.join(timeout=6)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path)
    parser.add_argument("--mcp", required=True, type=Path)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--case", choices=["novel", "drama", "video"], required=True)
    parser.add_argument("--goal", required=True)
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    # PTY默认规范模式会截断长JSON请求；仅调整本工具的隔离终端。
    if sys.stdin.isatty() and os.name == "posix":
        import termios
        attributes=termios.tcgetattr(sys.stdin)
        attributes[3] &= ~(termios.ICANON | termios.ECHO)
        termios.tcsetattr(sys.stdin,termios.TCSANOW,attributes)
    report = {"case": args.case, "goal": args.goal, "selection_owner": "current_external_agent",
              "automatic_workflow": False, "os_caches": "uncontrolled", "events": [], "assertions": [],
              "platform": sys.platform, "ambient_load_average_at_start": os.getloadavg() if hasattr(os, "getloadavg") else None,
              "token_observations": [], "limits": ["no_provider_token_breakdown", "no_quality_or_author_acceptance_inference"]}
    previous=args.root/"evaluation.json"
    if previous.exists():
        report=json.loads(previous.read_text())
    mcp = monitor = None
    number = 0
    started = time.monotonic()
    prior_elapsed_ms=report.get("elapsed_ms",0)

    def save():
        report["elapsed_ms"] = prior_elapsed_ms+round((time.monotonic() - started) * 1000)
        temporary = args.root / "evaluation.tmp"
        temporary.write_bytes(encoded(report))
        temporary.replace(args.root / "evaluation.json")

    def rpc(method, params):
        nonlocal number
        number += 1
        mcp.stdin.write(encoded({"jsonrpc": "2.0", "id": number, "method": method, "params": params}) + b"\n")
        mcp.stdin.flush()
        deadline = time.monotonic() + 60
        while True:
            if not select.select([mcp.stdout], [], [], max(0, deadline-time.monotonic()))[0]:
                raise TimeoutError("MCP未返回；保留原输入与原键")
            line = mcp.stdout.readline()
            if not line:
                raise RuntimeError("MCP提前退出")
            result = json.loads(line)
            if result.get("id") == number:
                return result

    def close_mcp():
        nonlocal mcp, monitor
        if mcp is None:
            return
        mcp.stdin.close()
        try:
            mcp.wait(timeout=10)
        except subprocess.TimeoutExpired:
            mcp.kill()
            mcp.wait(timeout=5)
        monitor.close()
        usage = mcp.usage
        report.setdefault("mcp_processes", []).append({"exit_code": mcp.returncode, **monitor.metrics(),
            "binary_sha256":getattr(mcp,"binary_sha256",None),
            "wait4_cpu_seconds": usage.ru_utime + usage.ru_stime if usage else None,
            "cpu_scope": "process_and_reaped_descendants_whole_session"})
        mcp = monitor = None

    print(json.dumps({"ready": True, "commands": ["call", "assert", "tokens", "restart", "finish"]}), flush=True)
    try:
        for line in sys.stdin:
            command = json.loads(line)
            kind = command.get("command", "call")
            if kind == "tokens":
                report["token_observations"].append(command)
                save()
                print('{"recorded":true}', flush=True)
                continue
            if kind == "assert":
                value = report["events"][command["event"]]["result"]
                for segment in command["path"].strip("/").split("/"):
                    if segment:
                        value = value[int(segment)] if isinstance(value, list) else value[segment]
                passed = value == command["equals"]
                report["assertions"].append({**command, "passed": passed, "actual": value})
                save()
                print(json.dumps({"passed": passed, "actual": value}, ensure_ascii=False), flush=True)
                continue
            if kind in ("restart", "finish"):
                close_mcp()
                if kind == "finish":
                    report["conclusion"] = command.get("conclusion")
                    report["first_action"] = report["events"][0]["action"] if report["events"] else None
                    report["observed_error_count"] = sum("error" in event["result"] for event in report["events"])
                    report["assertions_passed"] = bool(report["assertions"]) and all(row["passed"] for row in report["assertions"])
                    observations=report["token_observations"]
                    report["goal_accounted_token_delta"]=observations[-1]["tokens_used"]-observations[0]["tokens_used"] if len(observations)>=2 else None
                    report["provider_input_output_tokens"]=None
                    save()
                    print(json.dumps({"finished": True, "report": str(args.root/"evaluation.json")}), flush=True)
                    break
                print('{"restarted":true}', flush=True)
                continue
            action, value = command["action"], command.get("input", {})
            surface = command.get("surface", "mcp")
            at = time.monotonic()
            provenance = None
            if surface == "cli":
                binary_sha256=hashlib.sha256(args.cli.read_bytes()).hexdigest()
                process = Process([str(args.cli), "--client", "codex", "--collaboration-dir", str(args.root/"connection"),
                                   "call", action, "--input", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                observation = Monitor(process.pid)
                try:
                    output, error = process.communicate(encoded(value), timeout=60)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)
                    raise
                finally:
                    observation.close()
                result = json.loads(output)
                metrics = observation.metrics()
                metrics.update(wait4_cpu_seconds=process.usage.ru_utime+process.usage.ru_stime if process.usage else None,
                               exit_code=process.returncode, stderr_bytes=len(error))
                temperature = "fresh_process_os_cache_uncontrolled"
            else:
                fresh = mcp is None
                if fresh:
                    binary_sha256=hashlib.sha256(args.mcp.read_bytes()).hexdigest()
                    mcp = Process([str(args.mcp), "--client", "codex", "--collaboration-dir", str(args.root/"connection")],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
                    mcp.binary_sha256=binary_sha256
                    monitor = Monitor(mcp.pid)
                    rpc("initialize", {"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent-evaluation","version":"1"}})
                    mcp.stdin.write(encoded({"jsonrpc":"2.0","method":"notifications/initialized"})+b"\n")
                arguments = {"action": action, "input": value}
                if "view" in command:
                    arguments["view"] = command["view"]
                raw = rpc("tools/call", {"name":"hetu_call_action","arguments":arguments})
                result = raw.get("result", {}).get("structuredContent", raw)
                provenance = raw.get("result", {}).get("_meta", {}).get("provenance")
                metrics = monitor.metrics(at)
                metrics["transport_bytes"] = len(encoded(raw))
                temperature = "fresh_mcp_including_initialize" if fresh else "warm_mcp_process"
                binary_sha256=getattr(mcp,"binary_sha256",None)
            event = {"surface":surface,"action":action,"input":value,"result":result,
                     "binary_sha256":binary_sha256,
                     "decision":command.get("decision"),"temperature":temperature,
                     "elapsed_ms":round((time.monotonic()-at)*1000),"resources":metrics,
                     "mcp_provenance":provenance,
                     "result_sha256":hashlib.sha256(encoded(result)).hexdigest()}
            report["events"].append(event)
            (args.root/f"step-{len(report['events'])-1:03}.json").write_bytes(encoded(event))
            save()
            display=result
            if "display_path" in command and "error" not in result:
                for segment in command["display_path"].strip("/").split("/"):
                    if segment:
                        display=display[int(segment)] if isinstance(display,list) else display[segment]
            print(json.dumps({"event":len(report["events"])-1,"status":result.get("status"),"result":display,"resources":metrics},ensure_ascii=False),flush=True)
    finally:
        close_mcp()
        save()


if __name__ == "__main__":
    main()
