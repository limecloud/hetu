#!/usr/bin/env python3
"""隔离安装测试：模拟官方登记格式，在实际登记后丢一次回执。"""
import json
import os
from pathlib import Path
import shutil
import sys

root = Path(os.environ["CODEX_HOME"])
root.mkdir(parents=True, exist_ok=True)
args = sys.argv[1:]
with (root / "calls.log").open("a") as log:
    log.write(" ".join(args) + "\n")
state_path = root / "fixture-state.json"
state = json.loads(state_path.read_text()) if state_path.exists() else {"marketplaces": [], "installed": []}
if args[:3] == ["plugin", "marketplace", "list"]:
    result = {"marketplaces": state["marketplaces"]}
elif args[:3] == ["plugin", "marketplace", "add"]:
    market = Path(args[3])
    manifest = json.loads((market / ".agents/plugins/marketplace.json").read_text())
    record = {"name": manifest["name"], "root": str(market), "marketplaceSource": {"sourceType": "local", "source": str(market)}}
    state["marketplaces"] = [record]
    result = record
elif args[:2] == ["plugin", "add"]:
    name, market_name = args[2].split("@")
    market = Path(state["marketplaces"][0]["root"])
    manifest = json.loads((market / ".agents/plugins/marketplace.json").read_text())
    source = market / manifest["plugins"][0]["source"]["path"]
    version = json.loads((source / "plugin.json").read_text())["version"]
    target = root / "plugins/cache" / market_name / name / version
    shutil.copytree(source, target)
    state["installed"] = [{"pluginId": args[2], "installed": True, "enabled": True, "version": version}]
    state_path.write_text(json.dumps(state))
    sys.exit(1)
elif args[:2] == ["plugin", "list"]:
    result = {"installed": state["installed"]}
else:
    sys.exit(2)
state_path.write_text(json.dumps(state))
print(json.dumps(result))
