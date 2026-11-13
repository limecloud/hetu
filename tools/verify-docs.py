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
fragments = references = 0
sources = {file: file.read_text() for file in files}
parsed = {file: markdown.parse(source) for file, source in sources.items()}


def heading_ids(tokens):
    """按 GitHub 标题锚点规则处理标点、行内代码与重复标题。"""
    result, counts = set(), {}
    for index, token in enumerate(tokens):
        if token.type != "heading_open":
            continue
        title = "".join(child.content for child in tokens[index + 1].children or []
                        if child.type in ("text", "code_inline", "image"))
        slug = re.sub(r"[^\w\- ]", "", title.lower()).replace(" ", "-")
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        result.add(f"{slug}-{count}" if count else slug)
    return result


anchors = {file.resolve(): heading_ids(tokens) for file, tokens in parsed.items()}
owners = {
    "FR": (root / "docs/01-产品需求PRD.md", r"^\| (FR-\d{2}) \|"),
    "US": (root / "docs/26-用户故事与用例.md", r"^\| (US-\d{2}) \|"),
    "UC": (root / "docs/26-用户故事与用例.md", r"^## \d+\. (UC-\d{2}) "),
    "E2E": (root / "docs/19-测试策略与验收矩阵.md", r"^- (E2E-\d{2}) "),
    "AC": (root / "docs/19-测试策略与验收矩阵.md", r"^\| (AC-\d{2})／"),
}
declared = {}
for prefix, (file, pattern) in owners.items():
    ids = re.findall(pattern, sources[file], re.MULTILINE)
    if len(ids) != len(set(ids)):
        errors.append(f"{file.name}: {prefix} 定义重复")
    declared[prefix] = set(ids)


def referenced_ids(source):
    """展开 FR-01／03 和 UC-01～03，避免简写绕过引用检查。"""
    for match in re.finditer(r"\b(FR|US|UC|E2E|AC)-(\d{2}(?:[／～]\d{2})*)", source):
        prefix, suffix = match.groups()
        parts = re.split(r"([／～])", suffix)
        previous = int(parts[0])
        yield f"{prefix}-{previous:02d}"
        for index in range(1, len(parts), 2):
            current = int(parts[index + 1])
            if parts[index] == "～":
                if current < previous:
                    errors.append(f"编号范围倒置: {match.group()}")
                for number in range(previous + 1, current):
                    yield f"{prefix}-{number:02d}"
            yield f"{prefix}-{current:02d}"
            previous = current


for file in files:
    source = sources[file]
    name = str(file.relative_to(root))
    if re.search(r"/Users/|sk-[A-Za-z0-9]{20,}", source): errors.append(name + ": 私密路径或凭据")
    if "蓝图" in source: errors.append(name + ": 旧中文术语")
    for reference in referenced_ids(source):
        references += 1
        if reference not in declared[reference.rsplit("-", 1)[0]]:
            errors.append(f"{name}: 未定义编号 {reference}")
    for token in parsed[file]:
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
            if not href or urlparse(href).scheme: continue
            links += 1
            link = urlparse(href)
            target = (file.parent / unquote(link.path)).resolve() if link.path else file.resolve()
            if not target.exists():
                errors.append(f"{name}: 无效引用 {href}")
            elif link.fragment and target in anchors:
                fragments += 1
                if unquote(link.fragment) not in anchors[target]:
                    errors.append(f"{name}: 无效标题锚点 {href}")

use_case_source = sources[owners["UC"][0]]
trace_section = re.split(r"^## \d+\. 逐用例追踪与验收索引$", use_case_source, flags=re.MULTILINE)
trace_rows = re.findall(r"^\| (UC-\d{2}) ", trace_section[-1], re.MULTILINE) if len(trace_section) == 2 else []
if len(trace_rows) != len(set(trace_rows)) or set(trace_rows) != declared["UC"]:
    errors.append("用户用例与逐用例追踪表不一致")
for title, filename in {"HetuSourceRef": "source-ref.schema.json", "HetuSubmitDraftInput": "draft-submit-input.schema.json"}.items():
    machine = json.loads((root / "contracts/schemas" / filename).read_text())
    if machine != schemas.get(title): errors.append(filename + ": 与文档合同不一致")
draft = json.loads((root / "contracts/fixtures/draft-submit.valid.json").read_text())
validator = Draft202012Validator(schemas["HetuSubmitDraftInput"])
validator.validate(draft)
for bad in ({**draft, "is_author": True}, {key: value for key, value in draft.items() if key != "title"}, {**draft, "package": "drama"}):
    if validator.is_valid(bad): errors.append("草稿合同未拒绝非法输入")
print(json.dumps({"documents": len(files), "local_links": links, "fragment_links": fragments,
                  "traceability": {key: len(value) for key, value in declared.items()},
                  "id_references": references, "json_examples": examples, "schemas": len(schemas),
                  "mermaid": diagrams, "errors": errors}, ensure_ascii=False, indent=2))
raise SystemExit(bool(errors))
