#!/usr/bin/env python3
"""从共享文案生成 Mac JSON 和 String Catalog，并核对双语占位符。"""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent

def generate():
    source = json.loads((ROOT / "assets/localization/native.json").read_text())
    catalog = {"sourceLanguage": "zh-Hans", "version": "1.0", "strings": {}}
    for key, entry in source.items():
        expected = set(entry["parameters"])
        for locale in ["zh-CN", "en"]:
            if not entry[locale].strip() or set(re.findall(r"\{([a-z_]+)\}", entry[locale])) != expected:
                raise ValueError(f"文案 {key}/{locale} 的翻译或占位符不完整")
        if not entry["purpose"].strip():
            raise ValueError(f"文案 {key} 缺少用途")
        catalog["strings"][key] = {"comment": entry["purpose"], "localizations": {
            target: {"stringUnit": {"state": "translated", "value": entry[locale]}}
            for locale, target in [("zh-CN", "zh-Hans"), ("en", "en")]
        }}
    referenced, prefixes = set(), set()
    for path in (ROOT / "apps/macos/Sources").rglob("*.swift"):
        for key in re.findall(r'\b(?:t|text)\("([a-z][a-z0-9_.-]+)"', path.read_text()):
            (prefixes if key.endswith(".") else referenced).add(key)
    definitions = json.loads((ROOT / "contracts/schemas/blueprint.schema.json").read_text())["$defs"]
    fact = definitions["fact"]
    life = next(item["then"]["properties"]["value"]["enum"] for item in fact["allOf"] if item["if"]["properties"]["predicate"]["const"] == "life_state")
    families = {
        "appearance.": ["system", "light", "dark"],
        "entity.kind.": [item["properties"]["type"]["const"].removeprefix("upsert_") for item in definitions["change"]["oneOf"] if item["properties"]["type"]["const"].startswith("upsert_")],
        "fact.predicate.": fact["properties"]["predicate"]["enum"], "fact.life.": life,
        "faction.relation.": definitions["faction"]["properties"]["relations"]["items"]["properties"]["type"]["enum"],
        "location.": definitions["location"]["properties"]["interior_exterior"]["enum"],
        "package.": definitions["scope"]["properties"]["packages"]["items"]["enum"],
        **{"rule." + field + ".": definitions["rule"]["properties"][schema_field]["enum"] for field, schema_field in [("type", "type"), ("severity", "severity"), ("exception", "exception_policy")]},
    }
    plot = json.loads((ROOT / "contracts/schemas/plot.schema.json").read_text())["$defs"]
    node = plot["node"]["properties"]
    families.update({"plot." + key + ".": node[field]["enum"] for key, field in [("kind", "kind"), ("time_of_day", "time_of_day"), ("verification", "verification"), ("method", "extraction_method")]})
    families["plot.missing."] = node["missing_prerequisites"]["items"]["enum"]
    coverage = plot["coverage"]["properties"]
    families["plot.coverage."] = coverage["status"]["enum"]
    families["plot.skip."] = coverage["unparsed_ranges"]["items"]["properties"]["reason"]["enum"]
    families["plot.budget."] = next(item for item in coverage["budget_stop"]["anyOf"] if item.get("type") == "object")["properties"]["reason"]["enum"]
    families["plot.relation."] = plot["edge"]["properties"]["relation"]["enum"]
    annotation = next(item for item in node["annotation"]["anyOf"] if item.get("type") == "object")
    families["annotation.context."] = annotation["properties"]["context"]["enum"]
    report = json.loads((ROOT / "contracts/schemas/validation-report.schema.json").read_text())
    finding = report["$defs"]["finding"]["properties"]
    families["validation.certainty."] = finding["certainty"]["enum"]
    families["validation.missing."] = finding["missing_prerequisites"]["items"]["enum"]
    families["validation.status."] = report["properties"]["status"]["enum"]
    families["shell.coverage."] = list(report["properties"]["coverage"]["properties"]["counts"]["properties"])
    families["validation.budget."] = report["properties"]["coverage"]["properties"]["budget_stop"]["anyOf"][1]["enum"]
    disposition = json.loads((ROOT / "contracts/schemas/finding-disposition-input.schema.json").read_text())
    families["validation.disposition."] = disposition["properties"]["disposition"]["enum"]
    drama = json.loads((ROOT / "contracts/schemas/drama-skeleton.schema.json").read_text())
    families["drama.missing."] = drama["$defs"]["scene"]["properties"]["missing_fields"]["items"]["enum"]
    comparison = json.loads((ROOT / "contracts/schemas/drama-comparison.schema.json").read_text())
    families["drama.diff."] = comparison["properties"]["items"]["items"]["properties"]["kind"]["enum"]
    families["drama.field."] = ["title"] + comparison["properties"]["items"]["items"]["properties"]["details"]["properties"]["fields"]["items"]["enum"]
    families["novel.status."] = json.loads((ROOT / "contracts/schemas/novel.schema.json").read_text())["$defs"]["metadata"]["properties"]["status"]["enum"]
    families["review.state."] = ["submitted", "in_review", "approved", "changes_requested", "rejected", "superseded"]
    families["review.decision."] = ["approved", "changes_requested", "rejected", "withdrawn"]
    media = json.loads((ROOT / "contracts/schemas/media.schema.json").read_text())["$defs"]
    families["media.kind."] = media["cue"]["properties"]["kind"]["enum"]
    families["media.rights."] = media["asset"]["properties"]["rights_status"]["enum"]
    families["media.source_type."] = media["source"]["properties"]["source_type"]["enum"]
    referenced.update(finding["message_key"]["enum"])
    for prefix in prefixes:
        if prefix not in families:
            raise ValueError(f"动态文案前缀缺少枚举合同：{prefix}")
        referenced.update(prefix + value for value in families[prefix])
    missing = referenced - source.keys()
    if missing:
        raise ValueError(f"缺少文案：{sorted(missing)}")
    out = ROOT / "apps/macos/Sources/HetuNative/Resources"
    out.mkdir(parents=True, exist_ok=True)
    (out / "NativeStrings.json").write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n")
    (out / "Localizable.xcstrings").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    print(f"本地化：{len(source)} 个双语键及占位符通过")

if __name__ == "__main__":
    generate()
