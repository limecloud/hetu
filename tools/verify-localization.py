"""核验共享双语词库、占位符及创作方法名称。"""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent


def verify():
    source = json.loads((ROOT / "assets/localization/shared.json").read_text())
    for key, entry in source.items():
        expected = set(entry["parameters"])
        for locale in ["zh-CN", "en"]:
            text = entry[locale]
            if not text.strip() or set(re.findall(r"\{([a-z_]+)\}", text)) != expected:
                raise ValueError(f"文案 {key}/{locale} 的翻译或占位符不完整")
        if not entry["purpose"].strip():
            raise ValueError(f"文案 {key} 缺少用途")
    catalog = json.loads((ROOT / "integrations/catalog.json").read_text())
    required = {suite["titleKey"] for suite in catalog["suites"]}
    required.update("agent.skill." + name for name in catalog["skills"])
    missing = required - source.keys()
    if missing:
        raise ValueError(f"缺少创作方法名称：{sorted(missing)}")
    print(f"共享本地化：{len(source)} 个双语键及创作方法名称通过")


if __name__ == "__main__":
    verify()
