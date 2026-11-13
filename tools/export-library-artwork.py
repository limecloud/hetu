# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==13.0.0"]
# ///
"""等比导出原生插画，并登记原图、提示词和最终资源摘要。"""
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
PROMPTS = "assets/illustrations/prompts/library-v2.jsonl"
jobs = json.loads("[" + ",".join((ROOT / PROMPTS).read_text().splitlines()) + "]")
jobs.append({"out": "library-empty.png", "model": "gpt-image-2.5-sunburst"})
for job in jobs:
    job["collection"] = "library-v2"
    job["prompt_source"] = "assets/illustrations/prompts/library-empty-v2.txt" if job["out"] == "library-empty.png" else PROMPTS
for workbench_prompts in ["assets/illustrations/prompts/workbench-v1.jsonl", "assets/illustrations/prompts/workbench-dark-v1.jsonl"]:
    for line in (ROOT / workbench_prompts).read_text().splitlines():
        jobs.append({**json.loads(line), "collection": "workbench-v1", "prompt_source": workbench_prompts})
manifest_path = ROOT / "assets/manifest.json"
manifest = json.loads(manifest_path.read_text())
for job in jobs:
    source = ROOT / "output/imagegen" / job["collection"] / job["out"]
    target = ROOT / "assets/illustrations/library" / (source.stem + ".jpg")
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as original:
        original.load()
        image = ImageOps.exif_transpose(original).convert("RGB")
        if source.stem.startswith("cover-") and image.width * 3 != image.height * 2:
            raise ValueError(f"书封原图必须为 2:3，不能拉伸：{source.name}")
        image.thumbnail((768, 768) if job["collection"] == "workbench-v1" else (1536, 1152), Image.Resampling.LANCZOS)
        image.save(target, "JPEG", quality=92, optimize=True, progressive=True)
        original_record = {"path": str(source.relative_to(ROOT)), "requested_model": job["model"],
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "width": original.width, "height": original.height,
            "prompt_source": job["prompt_source"]}
    record = {"path": str(target.relative_to(ROOT)), "width": image.width, "height": image.height,
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "derived_from": original_record["path"],
        "usage": "native-workbench" if job["collection"] == "workbench-v1" else "native-library", "text_in_image": False, "resize": "proportional"}
    for collection, entry in [("originals", original_record), ("assets", record)]:
        manifest[collection] = [item for item in manifest[collection] if item["path"] != entry["path"]]
        manifest[collection].append(entry)
    print(f"{record['path']}: {image.width}×{image.height}, {target.stat().st_size:,} bytes")
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
