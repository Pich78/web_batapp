#!/usr/bin/env python3
"""Render the Batá app icon (SVG master + PNG favicon/home-screen set).

One geometry source for the hourglass drum, the charcoal tile and the lacing
marks. Pillow is a development-time dependency; the generated assets are
committed and the app never needs Python.

Usage:
    .venv/bin/python tools/make_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

# Design space (1024x1024). The drum is symmetric around x=512 / y=512.
DRUM = [
    (292, 196), (732, 196), (760, 236), (668, 466), (620, 500),
    (620, 524), (668, 558), (760, 788), (732, 828), (292, 828),
    (264, 788), (356, 558), (404, 524), (404, 500), (356, 466), (264, 236),
]
STRINGS = [
    ((270, 300), (754, 300)),
    ((270, 724), (754, 724)),
    ((450, 460), (450, 564)),
    ((512, 460), (512, 564)),
    ((574, 460), (574, 564)),
]
BACKGROUND = (13, 15, 19, 255)
AMBER_TOP = (244, 185, 99, 255)
AMBER_BOTTOM = (207, 132, 39, 255)
CORD = (13, 15, 19, 255)
SVG_RADIUS = 224
FAVICON_CORNER = 0.22


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        t = y / max(1, size - 1)
        draw.line(
            [(0, y), (size, y)],
            fill=(
                lerp(AMBER_TOP[0], AMBER_BOTTOM[0], t),
                lerp(AMBER_TOP[1], AMBER_BOTTOM[1], t),
                lerp(AMBER_TOP[2], AMBER_BOTTOM[2], t),
                255,
            ),
        )
    return image


def scaled(points: list[tuple[int, int]], size: int) -> list[tuple[int, int]]:
    factor = size / 1024
    return [(round(x * factor), round(y * factor)) for x, y in points]


def drum_layer(size: int) -> tuple[Image.Image, Image.Image]:
    """Return the finished drum layer and its silhouette mask."""
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).polygon(scaled(DRUM, size), fill=255)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste(gradient(size), (0, 0), mask)

    cords = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cord_draw = ImageDraw.Draw(cords)
    width = max(2, round(size * 0.009))
    for start, end in STRINGS:
        cord_draw.line(
            [tuple(round(v * size / 1024) for v in start),
             tuple(round(v * size / 1024) for v in end)],
            fill=CORD,
            width=width,
        )
    cord_alpha = ImageChops.multiply(cords.split()[3], mask)
    layer.paste(CORD, (0, 0), cord_alpha)
    return layer, mask


def render(size: int, rounded: bool) -> Image.Image:
    # Draw at 4x and downsample so curves and cords stay clean at 16 px.
    work = size * 4
    image = Image.new("RGBA", (work, work), BACKGROUND)
    layer, _ = drum_layer(work)
    image = Image.alpha_composite(image, layer)
    image = image.resize((size, size), Image.LANCZOS)
    if rounded:
        radius = round(size * FAVICON_CORNER)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=radius, fill=255
        )
        image.putalpha(mask)
    return image


def write_svg(path: Path) -> None:
    points = " ".join(f"{x},{y}" for x, y in DRUM)
    strings = "\n".join(
        f'      <line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}"/>'
        for a, b in STRINGS
    )
    path.write_text(
        f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4b963"/>
      <stop offset="1" stop-color="#cf8427"/>
    </linearGradient>
    <clipPath id="drum"><polygon points="{points}"/></clipPath>
  </defs>
  <rect width="1024" height="1024" rx="{SVG_RADIUS}" fill="#0d0f13"/>
  <polygon points="{points}" fill="url(#amber)"/>
  <g clip-path="url(#drum)" stroke="#0d0f13" stroke-width="12" stroke-linecap="round">
{strings}
  </g>
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
