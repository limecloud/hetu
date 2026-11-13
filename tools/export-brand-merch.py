# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==13.0.0"]
# ///
"""在无文字周边母图上精确排版，按语言导出河图洛书周边展示。"""
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = "output/imagegen/hetu-luoshu-merch-base-sunburst.png"
base = Image.open(ROOT / SOURCE).convert("RGBA")
chinese_font = "/System/Library/Fonts/STHeiti Medium.ttc"
english_font = "/System/Library/Fonts/Supplemental/Arial.ttf"

def label(image, lines, center, angle, color):
    tile = Image.new("RGBA", (380, 150))
    draw = ImageDraw.Draw(tile)
    y = 20
    for text, size, chinese in lines:
        font = ImageFont.truetype(chinese_font if chinese else english_font, size)
        box = draw.textbbox((0, 0), text, font=font)
        draw.text(((380 - (box[2]-box[0]))/2, y), text, font=font, fill=color, stroke_width=0)
        y += size + 8
    tile = tile.rotate(angle, Image.Resampling.BICUBIC, expand=True)
    image.alpha_composite(tile, (round(center[0]-tile.width/2), round(center[1]-tile.height/2)))

manifest_path = ROOT / "assets/manifest.json"
manifest = json.loads(manifest_path.read_text())
if not any(item["path"] == SOURCE for item in manifest["originals"]):
    manifest["originals"].append({"path": SOURCE, "requested_model": "gpt-image-2.5-sunburst",
        "width": base.width, "height": base.height, "sha256": hashlib.sha256((ROOT / SOURCE).read_bytes()).hexdigest(),
        "prompt_source": "output/imagegen/prompts/hetu-luoshu-merch.txt", "reference_image": "output/imagegen/brand-merch.png"})

for english in (False, True):
    image = base.copy()
    main = "Hetu Luoshu" if english else "河图洛书"
    # 文字布局跟随原物品的平面与倾角，四字中文和英文分别排版。
    label(image, [(main, 24 if english else 30, not english), ("STORY NOTES" if english else "Hetu Luoshu", 14, False)], (278, 259), 9, "#a87836")
    label(image, [(main, 21, not english)], (1185, 379), 0, "#f2e3ba")
    label(image, [(main, 23 if english else 27, not english), ("STICKERS" if english else "Hetu Luoshu", 13, False)], (1232, 505), -6, "#aa7834")
    label(image, [("HETU" if english else "河图", 20, not english), ("LUOSHU" if english else "洛书", 19, not english)], (821, 789), -7, "#f5e7c7")
    suffix = "-en" if english else ""
    target = f"assets/marketing/brand-merch{suffix}.webp"
    (ROOT / "output/design").mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(ROOT / f"output/design/brand-merch{suffix}.png")
    image.convert("RGB").save(ROOT / target, "WEBP", quality=94, method=6)
    manifest["assets"] = [item for item in manifest["assets"] if item["path"] != target]
    manifest["assets"].append({"path": target, "width": image.width, "height": image.height,
        "sha256": hashlib.sha256((ROOT / target).read_bytes()).hexdigest(), "locale": "en" if english else "zh-CN",
        "derived_from": SOURCE, "method": "localized-typesetting"})
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print("已导出中英文周边展示，保留原物品和角色比例。")
