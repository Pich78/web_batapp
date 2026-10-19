#!/usr/bin/env python3
"""Generate the SVG and PNG app icons from shared vector geometry.

Three double-headed batá drums follow the arrangement of the maintainer's
photo reference, simplified to solid amber silhouettes on black. Curved
waists and unequal heads distinguish batá from the congas in the style
reference. No photograph or external resource is needed to regenerate.

Usage: .venv/bin/python tools/make_icons.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
BLACK = "#0d0f13"
AMBER = "#e6a44f"
VERSION = "1.1.2"

# Back drums first; the largest drum sits in front, as in the photo.
# name, centre x/y, rotation, length, small head width, waist width, large head width
DRUMS = (
    ("okonkolo", 292, 522, 29, 410, 112, 78, 176),
    ("itotele", 726, 506, -30, 480, 132, 88, 204),
    ("iya", 512, 510, 0, 590, 146, 106, 264),
)


def body_commands(height, small, waist, large):
    """Smooth, asymmetrical hourglass: short neck above a broad lower shell."""
    top, bottom = -height / 2, height / 2
    return [
        ("M", -small / 2, top),
        ("C", -small * .52, top + height * .14,
         -waist / 2, -height * .23, -waist / 2, -height * .12),
        ("C", -waist / 2, height * .05,
         -large * .52, height * .26, -large / 2, bottom),
        ("C", -large * .25, bottom + large * .13,
         large * .25, bottom + large * .13, large / 2, bottom),
        ("C", large * .52, height * .26,
         waist / 2, height * .05, waist / 2, -height * .12),
        ("C", waist / 2, -height * .23,
         small * .52, top + height * .14, small / 2, top),
        ("Z",),
    ]


def sample_path(commands):
    points = []
    for command, *v in commands:
        if command == "M":
            points.append(tuple(v))
        elif command == "C":
            x0, y0 = points[-1]
            x1, y1, x2, y2, x3, y3 = v
            for step in range(1, 33):
                t = step / 32
                u = 1 - t
                points.append((u**3*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t**3*x3,
                               u**3*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t**3*y3))
    return points


def ellipse(cx, cy, rx, ry):
    return [(cx + rx * math.cos(i * math.tau / 96),
             cy + ry * math.sin(i * math.tau / 96)) for i in range(96)]


def shapes(drum):
    _, _, _, _, height, small, waist, large = drum
    # Dark separators remain readable without ropes or ornamental detail.
    return [
        (sample_path(body_commands(height, small, waist, large)), BLACK, 24),
        (ellipse(0, -height / 2, small / 2, small * .16), BLACK, 16),
        (ellipse(0, height / 2, large / 2, large * .19), BLACK, 16),
    ]


def transform(points, drum, factor):
    _, cx, cy, angle, *_ = drum
    rad = math.radians(angle)
    c, s = math.cos(rad), math.sin(rad)
    return [(round((cx + x*c - y*s) * factor),
             round((cy + x*s + y*c) * factor)) for x, y in points]


def render(size, rounded):
    work = size * 4
    image = Image.new("RGBA", (work, work), BLACK)
    draw = ImageDraw.Draw(image)
    for drum in DRUMS:
        for points, stroke, width in shapes(drum):
            points = transform(points, drum, work / 1024)
            draw.polygon(points, fill=AMBER)
            draw.line(points + [points[0]], fill=stroke,
                      width=round(width * work / 1024), joint="curve")
    if rounded:
        mask = Image.new("L", (work, work), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, work - 1, work - 1], radius=round(work * .22), fill=255)
        image.putalpha(mask)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def write_svg(path):
    groups = []
    for drum in DRUMS:
        name, cx, cy, angle, height, small, waist, large = drum
        commands = " ".join(command + " " + " ".join(f"{v:g}" for v in values)
                            for command, *values in body_commands(height, small, waist, large))
        groups.append(f'''  <g id="{name}" transform="translate({cx} {cy}) rotate({angle})" fill="{AMBER}" stroke="{BLACK}" stroke-linejoin="round">
    <path d="{commands}" stroke-width="24"/>
    <ellipse cy="{-height / 2:g}" rx="{small / 2:g}" ry="{small * .16:g}" stroke-width="16"/>
    <ellipse cy="{height / 2:g}" rx="{large / 2:g}" ry="{large * .19:g}" stroke-width="16"/>
  </g>''')
    path.write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <title>Batá — three drums</title>
  <rect width="1024" height="1024" rx="224" fill="{BLACK}"/>
{chr(10).join(groups)}
</svg>
''', encoding="utf-8")


def main():
    ASSETS.mkdir(exist_ok=True)
    write_svg(ASSETS / "icon.svg")
    for size in (16, 32, 180, 192, 512):
        path = ASSETS / f"icon-{size}.png"
        render(size, rounded=size <= 32).save(path, optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} B)")
    manifest = {
        "name": "Batá · Toques & Oru Seco", "short_name": "Batá",
        "start_url": "./", "scope": "./", "display": "browser",
        "background_color": BLACK, "theme_color": BLACK,
        "icons": [{"src": f"assets/icon-{size}.png?v={VERSION}",
                   "sizes": f"{size}x{size}", "type": "image/png"}
                  for size in (192, 512)],
    }
    (ROOT / "site.webmanifest").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("wrote assets/icon.svg and site.webmanifest")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
