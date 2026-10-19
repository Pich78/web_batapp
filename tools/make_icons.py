#!/usr/bin/env python3
"""Render the Batá app icon (SVG master + PNG favicon/home-screen set).

Three tapered, laced batá drums fanned like the reference photograph: small
Okónkolo left, large Iya (with its bell ring) centre, medium Itótele right.
Flat two-colour artwork: black background/outlines/lacing and amber drums,
with black separator outlines like the reference silhouette.

Usage:
    .venv/bin/python tools/make_icons.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

BLACK = (13, 15, 19, 255)
AMBER = (230, 164, 79, 255)
SVG_RADIUS = 224
FAVICON_CORNER = 0.22

# name, centre x, centre y, angle, height, top width, waist width,
# bottom width, bell ring
DRUMS = (
    ("okonkolo", 292, 566, -27, 410, 150, 108, 136, False),
    ("itotele", 732, 566, 27, 465, 180, 128, 160, False),
    ("iya", 512, 522, 0, 540, 220, 158, 192, True),
)


def rotate(x: float, y: float, angle: float) -> tuple[float, float]:
    rad = math.radians(angle)
    return (x * math.cos(rad) - y * math.sin(rad),
            x * math.sin(rad) + y * math.cos(rad))


def to_world(points: list[tuple[float, float]], cx: float, cy: float,
             angle: float, factor: float) -> list[tuple[int, int]]:
    result = []
    for x, y in points:
        rx, ry = rotate(x, y, angle)
        result.append((round((cx + rx) * factor), round((cy + ry) * factor)))
    return result


def body_points(height: float, top_w: float, waist_w: float, bottom_w: float) -> list[tuple[float, float]]:
    top = -height / 2
    waist = -height * 0.06
    bottom = height / 2
    return [
        (-top_w / 2, top), (top_w / 2, top),
        (waist_w / 2, waist), (bottom_w / 2, bottom),
        (-bottom_w / 2, bottom), (-waist_w / 2, waist),
    ]


def ellipse_points(cx: float, cy: float, rx: float, ry: float, count: int = 48) -> list[tuple[float, float]]:
    return [
        (cx + rx * math.cos(2 * math.pi * i / count),
         cy + ry * math.sin(2 * math.pi * i / count))
        for i in range(count)
    ]


def lacing(height: float, top_w: float, waist_w: float) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    top = -height / 2
    waist = -height * 0.06
    return [
        ((-top_w * 0.34, top + height * 0.14), (-waist_w * 0.34, waist + height * 0.08)),
        ((-top_w * 0.11, top + height * 0.12), (-waist_w * 0.11, waist + height * 0.12)),
        ((top_w * 0.11, top + height * 0.12), (waist_w * 0.11, waist + height * 0.12)),
        ((top_w * 0.34, top + height * 0.14), (waist_w * 0.34, waist + height * 0.08)),
        ((-top_w * 0.34, top + height * 0.14), (waist_w * 0.34, waist + height * 0.08)),
    ]


def draw_outline(draw: ImageDraw.ImageDraw, points: list[tuple[int, int]], width: int) -> None:
    draw.line(points + [points[0]], fill=BLACK, width=width, joint="curve")


def draw_drum(image: Image.Image, size: int, drum, detail: bool) -> None:
    name, cx, cy, angle, height, top_w, waist_w, bottom_w, bells = drum
    factor = size / 1024
    body = to_world(body_points(height, top_w, waist_w, bottom_w), cx, cy, angle, factor)
    head = to_world(ellipse_points(0, -height / 2, top_w / 2, top_w * 0.105), cx, cy, angle, factor)
    outline = max(2, round(22 * factor))

    ImageDraw.Draw(image).polygon(body, fill=AMBER)
    draw = ImageDraw.Draw(image)
    draw_outline(draw, body, outline)
    ImageDraw.Draw(image).polygon(head, fill=AMBER)
    draw_outline(draw, head, max(2, round(13 * factor)))

    if detail:
        for start, end in lacing(height, top_w, waist_w):
            a = to_world([start], cx, cy, angle, factor)[0]
            b = to_world([end], cx, cy, angle, factor)[0]
            draw.line([a, b], fill=BLACK, width=max(2, round(8 * factor)))
        if bells:
            band = to_world(ellipse_points(0, -height * 0.16, top_w * 0.52, top_w * 0.15), cx, cy, angle, factor)
            draw_outline(draw, band, max(3, round(18 * factor)))
            for i in range(7):
                t = math.pi * (0.12 + 0.76 * i / 6)
                local = (top_w * 0.52 * math.cos(t), -height * 0.16 + top_w * 0.15 * math.sin(t))
                dot = to_world([local], cx, cy, angle, factor)[0]
                radius = max(2, round(top_w * 0.035 * factor))
                draw.ellipse([dot[0] - radius, dot[1] - radius, dot[0] + radius, dot[1] + radius], fill=AMBER)


def render(size: int, rounded: bool) -> Image.Image:
    work = size * 4
    image = Image.new("RGBA", (work, work), BLACK)
    detail = size >= 64
    for drum in DRUMS:
        draw_drum(image, work, drum, detail)
    image = image.resize((size, size), Image.LANCZOS)
    if rounded:
        radius = round(size * FAVICON_CORNER)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=radius, fill=255
        )
        image.putalpha(mask)
    return image


def svg_drum(drum) -> str:
    name, cx, cy, angle, height, top_w, waist_w, bottom_w, bells = drum
    body = " ".join(f"{x:.1f},{y:.1f}" for x, y in body_points(height, top_w, waist_w, bottom_w))
    lines = []
    for start, end in lacing(height, top_w, waist_w):
        lines.append(
            f'      <line x1="{start[0]:.1f}" y1="{start[1]:.1f}" x2="{end[0]:.1f}" y2="{end[1]:.1f}"/>'
        )
    lacing_svg = ""
    if lines:
        lacing_svg = (
            '    <g stroke="#0d0f13" stroke-width="8" stroke-linecap="round">\n' +
            "\n".join(lines) + "\n    </g>\n"
        )
    bells_svg = ""
    if bells:
        dots = []
        for i in range(7):
            t = math.pi * (0.12 + 0.76 * i / 6)
            x = top_w * 0.52 * math.cos(t)
            y = -height * 0.16 + top_w * 0.15 * math.sin(t)
            dots.append(f'      <circle cx="{x:.1f}" cy="{y:.1f}" r="{top_w * 0.035:.1f}" fill="#e6a44f"/>')
        bells_svg = (
            f'    <ellipse cx="0" cy="{-height * 0.16:.1f}" rx="{top_w * 0.52:.1f}" ry="{top_w * 0.15:.1f}" '
            'fill="none" stroke="#0d0f13" stroke-width="18"/>\n' +
            "\n".join(dots) + "\n"
        )
    return f'''  <g transform="translate({cx} {cy}) rotate({angle})">
    <polygon points="{body}" fill="#e6a44f" stroke="#0d0f13" stroke-width="22" stroke-linejoin="round"/>
    <ellipse cx="0" cy="{-height / 2:.1f}" rx="{top_w / 2:.1f}" ry="{top_w * 0.105:.1f}" fill="#e6a44f" stroke="#0d0f13" stroke-width="13"/>
{lacing_svg}{bells_svg}  </g>'''


def write_svg(path: Path) -> None:
    groups = "\n".join(svg_drum(drum) for drum in DRUMS)
    path.write_text(
        f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="{SVG_RADIUS}" fill="#0d0f13"/>
{groups}
</svg>
''',
        encoding="utf-8",
    )


def main() -> int:
    ASSETS.mkdir(exist_ok=True)
    write_svg(ASSETS / "icon.svg")
    for size in (16, 32):
        render(size, rounded=True).save(ASSETS / f"icon-{size}.png", optimize=True)
    for size in (180, 192, 512):
        render(size, rounded=False).save(ASSETS / f"icon-{size}.png", optimize=True)
    (ROOT / "site.webmanifest").write_text(
        '''{
  "name": "Batá · Toques & Oru Seco",
  "short_name": "Batá",
  "start_url": "./",
  "scope": "./",
  "display": "browser",
  "background_color": "#0d0f13",
  "theme_color": "#0d0f13",
  "icons": [
    { "src": "assets/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "assets/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
''',
        encoding="utf-8",
    )
    generated = ["icon.svg", "icon-16.png", "icon-32.png", "icon-180.png", "icon-192.png", "icon-512.png"]
    for name in generated:
        path = ASSETS / name
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} B)")
    print("wrote site.webmanifest")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
