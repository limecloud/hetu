# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==13.0.0"]
# ///
"""从品牌原图导出带透明边距的 macOS 图标，并更新资源摘要。"""
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = "assets/brand/app-icon-1024.png"
DESTINATION = ROOT / "assets/brand/icons/macos"
SIZES = (16, 32, 64, 128, 256, 512, 1024)


def main():
    canvas_size, artwork_size, inset = 1024, 824, 100
    # 高分辨率遮罩保留小尺寸圆角的平滑边缘，画布边距由所有尺寸共同继承。
    scale = 4
    mask = Image.new("L", (artwork_size * scale, artwork_size * scale))
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, mask.width - 1, mask.height - 1), radius=185 * scale, fill=255
    )
    mask = mask.resize((artwork_size, artwork_size), Image.Resampling.LANCZOS)
    with Image.open(ROOT / SOURCE) as original:
        artwork = original.convert("RGBA").resize(
            (artwork_size, artwork_size), Image.Resampling.LANCZOS
        )
    artwork.putalpha(mask)
    canvas = Image.new("RGBA", (canvas_size, canvas_size))
    canvas.alpha_composite(artwork, (inset, inset))

    DESTINATION.mkdir(parents=True, exist_ok=True)
    images = {
        size: canvas.resize((size, size), Image.Resampling.LANCZOS) for size in SIZES
    }
    paths = []
    for size, image in images.items():
        destination = DESTINATION / f"icon-{size}.png"
        image.save(destination)
        paths.append(destination)
    icns = DESTINATION / "Hetu.icns"
    with tempfile.TemporaryDirectory(prefix="hetu-icon-") as temporary:
        iconset = Path(temporary) / "Hetu.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            images[size].save(iconset / f"icon_{size}x{size}.png")
            images[size * 2].save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(
            ["/usr/bin/iconutil", "-c", "icns", "-o", str(icns), str(iconset)],
            check=True,
        )
    paths.append(icns)

    manifest_path = ROOT / "assets/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    entries = {entry["path"]: entry for entry in manifest["assets"]}
    for destination in paths:
        relative = destination.relative_to(ROOT).as_posix()
        data = destination.read_bytes()
        with Image.open(destination) as image:
            entry = {
                "path": relative,
                "sha256": hashlib.sha256(data).hexdigest(),
                "size_bytes": len(data),
                "width": image.width,
                "height": image.height,
                "format": image.format,
                "mode": image.mode,
                "derived_from": SOURCE,
            }
        if relative in entries:
            entries[relative].update(entry)
        else:
            manifest["assets"].append(entry)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print("已导出 macOS 各尺寸图标与 ICNS，并同步资源摘要。")


if __name__ == "__main__":
    main()
