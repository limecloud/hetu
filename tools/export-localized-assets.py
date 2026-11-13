# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==13.0.0"]
# ///
"""从语言对应的原型与原图导出宣传资源，并更新摘要清单。"""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
manifest_path = ROOT / "assets/manifest.json"
manifest = json.loads(manifest_path.read_text())
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--brand-only", action="store_true", help="只导出双语品牌卡片与图标总览")
args = parser.parse_args()

def record(relative, **metadata):
    file = ROOT / relative
    with Image.open(file) as image:
        entry = {"path": relative, "width": image.width, "height": image.height,
                 "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), **metadata}
    manifest["assets"] = [item for item in manifest["assets"] if item["path"] != relative]
    manifest["assets"].append(entry)

for source, target in [
    ("output/design/prototype-desktop.png", "assets/marketing/prototype-desktop.webp"),
    ("output/design/prototype-desktop-en.png", "assets/marketing/prototype-desktop-en.webp"),
    ("output/design/prototype-mobile.png", "assets/marketing/prototype-mobile.webp"),
    ("output/design/prototype-mobile-en.png", "assets/marketing/prototype-mobile-en.webp"),
    ("output/design/prototype-website.png", "assets/marketing/prototype-website.webp"),
    ("output/design/prototype-website-en.png", "assets/marketing/prototype-website-en.webp"),
]:
    if not args.brand_only and (ROOT / source).exists():
        Image.open(ROOT / source).convert("RGB").save(ROOT / target, "WEBP", quality=92, method=6)
        record(target, locale="en" if "-en." in target else "zh-CN", derived_from=source)

cream, jade, ink = "#f8f6ef", "#1e6b5e", "#20312b"
mascot = ImageOps.contain(Image.open(ROOT / "assets/brand/mascot-master.png"), (460, 520))
chinese_fonts = [Path("/System/Library/Fonts/STHeiti Medium.ttc"), Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")]
chinese_font = next((path for path in chinese_fonts if path.is_file()), None)
if chinese_font is None:
    raise SystemExit("需要中文字体 STHeiti 或 NotoSansCJK，不能用缺字字体导出中文品牌图。")
for locale in ("zh-CN", "en"):
    english = locale == "en"
    card = Image.new("RGB", (1200, 630), cream)
    card.paste(mascot, (700, (630-mascot.height)//2), mascot)
    draw = ImageDraw.Draw(card)
    lines = [
        (74, 90, "Hetu Luoshu" if english else "河图洛书", 44, jade),
        (72, 202, "A clear foundation." if english else "设定有据", 54, ink),
        (72, 279, "Room to create." if english else "创作有序", 54, ink),
        (76, 414, "Characters. Worlds. Novels. Screenplays." if english else "人物 · 世界 · 小说 · 剧本", 23, "#5f6f66"),
        (76, 476, "Your local story workspace" if english else "属于作者的本地创作工作台", 25, "#5f6f66"),
    ]
    for x, y, text, size, color in lines:
        font = ImageFont.load_default(size=size) if english else ImageFont.truetype(str(chinese_font), size)
        draw.text((x, y), text, font=font, fill=color)
    relative = "assets/marketing/social-og-en.png" if english else "assets/marketing/social-og.png"
    card.save(ROOT / relative)
    record(relative, locale=locale, derived_from="assets/brand/mascot-master.png")
    board = Image.new("RGB", (1440, 1040), cream)
    draw = ImageDraw.Draw(board)
    label = "Hetu Luoshu · Cross-platform icons" if english else "河图洛书 Hetu Luoshu · 跨平台图标"
    font = ImageFont.load_default(size=34) if english else ImageFont.truetype(str(chinese_font), 34)
    draw.text((48, 30), label, font=font, fill=ink)
    platforms = [
        ("macOS", "ICNS · 16-1024 px", "assets/brand/icons/macos/icon-1024.png"),
        ("Windows", "Multi-size ICO · PNG", "assets/brand/icons/windows/icon-256.png"),
        ("Web", "Favicon · PWA · Maskable", "assets/brand/icons/web/icon-512.png"),
        ("iOS", "PNG · 40-1024 px", "assets/brand/icons/ios/app-icon-1024.png"),
        ("Android", "Adaptive · Legacy · Monochrome", "assets/brand/icons/android/xxxhdpi/legacy.png"),
        ("Dark" if english else "深色外观", "PNG · 1024 px", "assets/brand/app-icon-dark-1024.png"),
    ]
    for index, (title, detail, source) in enumerate(platforms):
        x, y = 48 + (index % 3) * 456, 100 + (index // 3) * 354
        draw.rounded_rectangle((x, y, x + 432, y + 330), radius=18, fill="#fffdfa", outline="#e3e7de", width=1)
        icon = ImageOps.contain(Image.open(ROOT / source).convert("RGBA"), (184, 184))
        board.paste(icon, (x + (432 - icon.width) // 2, y + 26), icon)
        title_font = ImageFont.load_default(size=29) if english else ImageFont.truetype(str(chinese_font), 29)
        draw.text((x + 216, y + 232), title, font=title_font, fill=ink, anchor="mt")
        draw.text((x + 216, y + 278), detail, font=ImageFont.load_default(size=20), fill="#5f6f66", anchor="mt")
    size_label = "Small-size previews · actual pixels" if english else "小尺寸预览 · 原始像素"
    font = ImageFont.load_default(size=23) if english else ImageFont.truetype(str(chinese_font), 23)
    draw.text((48, 840), size_label, font=font, fill=ink)
    for index, size in enumerate((16, 24, 32, 48, 64, 128)):
        source = f"assets/brand/icons/web/icon-{size}.png"
        icon = Image.open(ROOT / source).convert("RGBA")
        center = 440 + index * 164
        board.paste(icon, (center - size // 2, 952 - size), icon)
        draw.text((center, 976), str(size), font=ImageFont.load_default(size=21), fill="#5f6f66", anchor="mt")
    relative = "assets/brand/icon-overview-en.png" if english else "assets/brand/icon-overview.png"
    board.save(ROOT / relative)
    record(relative, locale=locale, source_assets=[source for _, _, source in platforms],
           layout_source="tools/export-localized-assets.py")
    for dark in (False, True):
        lockup = Image.new("RGBA", (1280, 640), (0, 0, 0, 0))
        symbol = ImageOps.contain(Image.open(ROOT / "assets/brand/mascot-master.png"), (440, 530))
        lockup.alpha_composite(symbol, (20, (640-symbol.height)//2))
        label = ImageDraw.Draw(lockup)
        color = "#f8f6ef" if dark else ink
        muted = "#b9ccc0" if dark else jade
        title = "Hetu Luoshu" if english else "河图洛书"
        title_font = ImageFont.load_default(size=100) if english else ImageFont.truetype(str(chinese_font), 120)
        label.text((500, 200), title, font=title_font, fill=color)
        subtitle = "Your local story workspace" if english else "Hetu Luoshu"
        label.text((505, 345), subtitle, font=ImageFont.load_default(size=43), fill=muted)
        relative = "assets/brand/wordmark" + ("-en" if english else "") + ("-dark" if dark else "") + ".png"
        lockup.save(ROOT / relative)
        record(relative, locale=locale, derived_from="assets/brand/mascot-master.png", theme="dark" if dark else "light")
web_manifest = "assets/brand/icons/web/manifest.webmanifest"
english_manifest = "assets/brand/icons/web/manifest-en.webmanifest"
config = json.loads((ROOT / web_manifest).read_text())
config.update(name="Hetu Luoshu", short_name="Hetu Luoshu", lang="en")
(ROOT / english_manifest).write_text(json.dumps(config, ensure_ascii=False, indent=2)+"\n")
for relative in [web_manifest, english_manifest]:
    file = ROOT / relative
    manifest["assets"] = [item for item in manifest["assets"] if item["path"] != relative]
    manifest["assets"].append({"path": relative, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "size_bytes": file.stat().st_size})
scene = "output/imagegen/hetu-luoshu-library-scene.png"
if (ROOT / scene).exists():
    target = "assets/marketing/hetu-luoshu-library-scene.webp"
    scene_image = Image.open(ROOT / scene).convert("RGB")
    scene_image.save(ROOT / target, "WEBP", quality=93, method=6)
    record(target, derived_from=scene, text_in_image=False, resize="proportional")
    target = "assets/marketing/hetu-luoshu-library-hero.webp"
    crop = (scene_image.width // 6, 0, scene_image.width, scene_image.height)
    scene_image.crop(crop).save(ROOT / target, "WEBP", quality=93, method=6)
    record(target, derived_from=scene, text_in_image=False, crop_box=list(crop), resize="proportional")
mobile = ROOT / "output/imagegen/prototype-mobile-en.png"
if not args.brand_only and mobile.exists() and not any(item["path"] == str(mobile.relative_to(ROOT)) for item in manifest["originals"]):
    with Image.open(mobile) as image:
        manifest["originals"].append({"path": str(mobile.relative_to(ROOT)), "requested_model": "gpt-image-2.5-flare",
            "sha256": hashlib.sha256(mobile.read_bytes()).hexdigest(), "width": image.width, "height": image.height, "locale": "en"})
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n")
print("已导出双语分享卡与图标总览，并更新资源摘要。")
