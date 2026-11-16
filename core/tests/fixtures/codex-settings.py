#!/usr/bin/env python3
"""隔离安装测试：精确市场发现、升级及可控丢回执，不接触真实客户端。"""
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
    # 模拟无关市场损坏：全局发现必失败，所选市场仍可用。
    sys.exit(17)
elif args[:3] == ["plugin", "marketplace", "add"]:
    if (root / "market-add-conflict").exists():
        sys.exit(19)
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
    state["installed"] = [{"pluginId": args[2], "name": name, "marketplaceName": market_name,
                           "installed": True, "enabled": True, "version": version,
                           "source": {"source": "local", "path": str(source)},
                           "marketplaceSource": {"sourceType": "local", "source": str(market)}}]
    state_path.write_text(json.dumps(state))
    if (root / "drop-receipt").exists():
        sys.exit(1)
    result = {"installed": True}
elif args[:2] == ["plugin", "list"]:
    if (root / "fail-list").exists():
        sys.exit(18)
    assert "--marketplace" in args
    result = {"installed": state["installed"], "available": []}
    if (root / "foreign-source").exists() and result["installed"]:
        result["installed"][0]["marketplaceSource"]["source"] = str(root / "foreign")
    if (root / "duplicate-record").exists():
        result["available"] = result["installed"]
else:
    sys.exit(2)
# 发现命令只读，故障注入不能改变既有登记。
if args[:2] != ["plugin", "list"]:
    state_path.write_text(json.dumps(state))
print(json.dumps(result))
