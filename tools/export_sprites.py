#!/usr/bin/env python3
"""Export the app's sprites and textures as PNG.

Every `Sprite` is cut from its atlas texture (with its pivot, pixels-per-unit
and 9-slice border recorded), and every `Texture2D` is decoded as a whole.
UnityPy handles the platform texture formats (ETC/ETC2/ASTC/…) through its
bundled decoders.

Usage:
    python3 tools/export_sprites.py --data .work/unity/Data --out assets/img \
        --manifest .work/analysis/sprites.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

import UnityPy


def slugify(value: str) -> str:
    value = value.lower().replace("’", "'")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "unnamed"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    env = UnityPy.Environment()
    env.load_folder(str(args.data))

    def as_list(value, default=(0.0, 0.0, 0.0, 0.0)) -> list[float]:
        if isinstance(value, (list, tuple)):
            return [round(float(v), 4) for v in value]
        parts = [getattr(value, name, None) for name in ("x", "y", "z", "w")]
        parts = [float(p) for p in parts if p is not None]
        return [round(v, 4) for v in parts] or list(default)

    sprites = []
    textures = []
    seen_names: dict[str, int] = {}

    for obj in env.objects:
        kind = obj.type.name
        if kind not in ("Sprite", "Texture2D"):
            continue
        try:
            asset = obj.read()
        except Exception as error:
            print(f"skip {kind} {obj.path_id}: {error}")
            continue
        name = getattr(asset, "m_Name", None) or f"{kind}_{obj.path_id}"
        base = slugify(name)
        index = seen_names.get(base, 0)
        seen_names[base] = index + 1
        filename = f"{base}.png" if index == 0 else f"{base}~{index}.png"
        try:
            image = asset.image
        except Exception as error:
            print(f"decode failed {kind} {name}: {error}")
            continue
        if image is None:
            print(f"no image for {kind} {name}")
            continue
        if image.mode not in ("RGBA", "RGB"):
            image = image.convert("RGBA")
        target = args.out / filename
        image.save(target)
        payload = target.read_bytes()
        record = {
            "name": name,
            "type": kind,
            "file": getattr(obj.assets_file, "name", "?"),
            "path_id": obj.path_id,
            "path": filename,
            "width": image.width,
            "height": image.height,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        if kind == "Sprite":
            record.update(
                {
                    "rect": as_list(getattr(asset, "m_Rect", None), (0, 0, 0, 0)),
                    "pivot": as_list(getattr(asset, "m_Pivot", None), (0, 0, 0, 0)),
                    "pixels_to_units": round(float(getattr(asset, "m_PixelsToUnits", 100.0)), 4),
                    "border": as_list(getattr(asset, "m_Border", None), (0, 0, 0, 0)),
                    "texture": getattr(getattr(asset, "m_RD", None), "texture", None)
                    and None,  # filled below when cheap
                }
            )
            sprites.append(record)
        else:
            textures.append(record)

    manifest = {
        "sprites": sprites,
        "textures": textures,
        "sprite_count": len(sprites),
        "texture_count": len(textures),
        "total_bytes": sum(r["bytes"] for r in sprites + textures),
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"sprites={len(sprites)} textures={len(textures)} bytes={manifest['total_bytes']:,} -> {args.out}")
    for record in sprites[:15]:
        print(f"   sprite {record['name'][:36]:36} {record['width']:>5}x{record['height']:<5} border={record['border']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
