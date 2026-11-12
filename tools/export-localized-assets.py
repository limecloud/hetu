# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==13.0.0"]
# ///
"""从语言对应的原型与原图导出宣传资源，并更新摘要清单。"""
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
manifest_path = ROOT / "assets/manifest.json"
manifest = json.loads(manifest_path.read_text())

def record(relative, **metadata):
    file = ROOT / relative
    with Image.open(file) as image:
        entry = {"path": relative, "width": image.width, "height": image.height,
                 "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), **metadata}
    manifest["assets"] = [item for item in manifest["assets"] if item["path"] != relative]
    manifest["assets"].append(entry)

for source, target in [
    ("output/design/prototype-desktop-en.png", "assets/marketing/prototype-desktop-en.webp"),
    ("output/imagegen/prototype-mobile-en.png", "assets/marketing/prototype-mobile-en.webp"),
    ("output/design/prototype-website-en.png", "assets/marketing/prototype-website-en.webp"),
]:
    if (ROOT / source).exists():
        Image.open(ROOT / source).convert("RGB").save(ROOT / target, "WEBP", quality=92, method=6)
        record(target, locale="en", derived_from=source)

cream, jade, ink = "#f8f6ef", "#1e6b5e", "#20312b"
card = Image.new("RGB", (1200, 630), cream)
mascot = ImageOps.contain(Image.open(ROOT / "assets/brand/mascot-master.png"), (460, 520))
card.paste(mascot, (700, (630-mascot.height)//2), mascot)
draw = ImageDraw.Draw(card)
for x, y, text, size, color in [
    (74, 90, "Hetu", 44, jade),
    (72, 202, "A clear foundation.", 54, ink),
    (72, 279, "Room to create.", 54, ink),
    (76, 414, "Characters. Worlds. Novels. Screenplays.", 23, "#5f6f66"),
    (76, 476, "Your local story workspace", 25, "#5f6f66"),
]:
    draw.text((x, y), text, font=ImageFont.load_default(size=size), fill=color)
card.save(ROOT / "assets/marketing/social-og-en.png")
record("assets/marketing/social-og-en.png", locale="en", derived_from="assets/brand/mascot-master.png")
board = Image.open(ROOT / "assets/brand/icon-overview.png").convert("RGB")
draw = ImageDraw.Draw(board)
draw.rectangle((0, 0, 1000, 80), fill=cream)
draw.text((40, 25), "Hetu · Cross-platform icons", font=ImageFont.load_default(size=28), fill=ink)
board.save(ROOT / "assets/brand/icon-overview-en.png")
record("assets/brand/icon-overview-en.png", locale="en", derived_from="assets/brand/icon-overview.png")
mobile = ROOT / "output/imagegen/prototype-mobile-en.png"
if mobile.exists() and not any(item["path"] == str(mobile.relative_to(ROOT)) for item in manifest["originals"]):
    with Image.open(mobile) as image:
        manifest["originals"].append({"path": str(mobile.relative_to(ROOT)), "requested_model": "gpt-image-2.5-flare",
            "sha256": hashlib.sha256(mobile.read_bytes()).hexdigest(), "width": image.width, "height": image.height, "locale": "en"})
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n")
print("已导出英文界面、分享卡与图标总览，并更新资源摘要。")
