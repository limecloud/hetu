# /// script
# requires-python = ">=3.11"
# dependencies = ["markdown-it-py==4.0.0", "jsonschema==4.25.1"]
# ///
"""检查文档引用、示例、术语与机器 Schema 的一致性。"""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlparse
from markdown_it import MarkdownIt
from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--axi-schema", type=Path, help="可选：固定版本 AXI 结果 Schema")
args = parser.parse_args()
axi = Draft202012Validator(json.loads(args.axi_schema.read_text())) if args.axi_schema else None
markdown = MarkdownIt()
files = [root / "README.md", *sorted((root / "docs").rglob("*.md")), root / "apps/website/README.md"]
errors, schemas = [], {}
links = examples = diagrams = 0
for file in files:
    source = file.read_text()
    name = str(file.relative_to(root))
    if re.search(r"/Users/|sk-[A-Za-z0-9]{20,}", source): errors.append(name + ": 私密路径或凭据")
    if "蓝图" in source: errors.append(name + ": 旧中文术语")
    for token in markdown.parse(source):
        if token.type == "fence":
            if not token.info: errors.append(name + ": 代码块缺少语言")
            if token.info == "mermaid": diagrams += 1
            if token.info == "json":
                try:
                    data = json.loads(token.content)
                    examples += 1
                    if isinstance(data, dict) and "$schema" in data:
                        Draft202012Validator.check_schema(data)
                        schemas[data["title"]] = data
                    if axi and isinstance(data, dict) and data.get("spec_version") == "0.2.1": axi.validate(data)
                except Exception as error: errors.append(f"{name}: {error}")
        for child in token.children or []:
            if child.type not in ("link_open", "image"): continue
            href = child.attrGet("href" if child.type == "link_open" else "src")
            if not href or urlparse(href).scheme or href.startswith("#"): continue
            links += 1
            if not (file.parent / unquote(href.split("#")[0])).exists(): errors.append(f"{name}: 无效引用 {href}")
for title, filename in {"HetuSourceRef": "source-ref.schema.json", "HetuSubmitDraftInput": "draft-submit-input.schema.json"}.items():
    machine = json.loads((root / "contracts/schemas" / filename).read_text())
    if machine != schemas.get(title): errors.append(filename + ": 与文档合同不一致")
draft = json.loads((root / "contracts/fixtures/draft-submit.valid.json").read_text())
validator = Draft202012Validator(schemas["HetuSubmitDraftInput"])
validator.validate(draft)
for bad in ({**draft, "is_author": True}, {key: value for key, value in draft.items() if key != "title"}, {**draft, "package": "drama"}):
    if validator.is_valid(bad): errors.append("草稿合同未拒绝非法输入")
print(json.dumps({"documents": len(files), "local_links": links, "json_examples": examples, "schemas": len(schemas), "mermaid": diagrams, "errors": errors}, ensure_ascii=False, indent=2))
raise SystemExit(bool(errors))
