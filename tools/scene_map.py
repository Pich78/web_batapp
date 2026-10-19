#!/usr/bin/env python3
"""Map Unity levels to scenes, lessons and shared asset files.

Unity numbers ``levelN`` by the included-scene list in ``BuildSettings``; the
per-scene assets live in ``sharedassetsN``. This reads that list from
``globalgamemanagers`` instead of inferring order from strings, then pairs each
level with its sharedassets file and checks the pairing against the audio clip
names inside it.

Usage:
    python3 tools/scene_map.py --data .work/unity/Data --out .work/analysis
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import UnityPy

LESSON_RE = re.compile(r"Lezione\s+(?P<number>\d+[AB]?)\s*-\s*(?P<title>.+?)(?:\s+\d+-slider)?$")


def slugify(value: str) -> str:
    value = value.lower().replace("’", "'")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def lesson_identity(scene_path: str) -> dict:
    stem = Path(scene_path).stem
    if "VOLUME 1" in scene_path:
        volume = "volume-1"
    elif "VOLUME 2" in scene_path:
        volume = "volume-2"
    else:
        volume = "app"
    match = LESSON_RE.search(stem)
    if match and volume != "app":
        number = match.group("number")
        title = match.group("title").strip()
        return {"volume": volume, "number": number, "title": title, "slug": f"{volume}/{number}-{slugify(title)}"}
    return {"volume": volume, "number": None, "title": stem, "slug": f"{volume}/{slugify(stem)}"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    env = UnityPy.Environment()
    env.load_folder(str(args.data))

    scenes: list[str] = []
    for obj in env.objects:
        if obj.type.name != "BuildSettings":
            continue
        settings = obj.read()
        for scene in settings.scenes:
            scenes.append(scene if isinstance(scene, str) else scene.path)

    if not scenes:
        raise SystemExit("no BuildSettings scene list found")

    # UnityPy indexes assets files by basename; normalise to the inventory's names.
    inventory = json.loads((args.out / "file_inventory.json").read_text())

    entries = []
    for index, scene_path in enumerate(scenes):
        level = f"level{index}"
        assets = f"sharedassets{index}.assets"
        identity = lesson_identity(scene_path)
        clips = [clip["name"] for clip in inventory.get(assets, {}).get("audio", [])]
        # content check: the lesson title (or its first word) should appear in a clip name
        token = slugify((identity["title"] or "").split()[0]) if identity["title"] else ""
        matched = None
        if token and clips:
            matched = any(token.replace("-", "") in slugify(name).replace("-", "") for name in clips)
        entries.append(
            {
                "level": level,
                "assets": assets,
                "scene": scene_path,
                **identity,
                "clips": clips,
                "title_in_clip_names": matched,
            }
        )

    report = {
        "scene_count": len(entries),
        "entries": entries,
        "unverified_pairings": [e["scene"] for e in entries if e["title_in_clip_names"] is False],
    }
    (args.out / "scene_map.json").write_text(json.dumps(report, indent=1) + "\n")

    for entry in entries:
        flag = "" if entry["title_in_clip_names"] is not False else "  <-- clip names do not mention the title"
        print(f"{entry['level']:>7} {entry['assets']:>22}  {entry['scene']}{flag}")
    print(f"\n{len(entries)} scenes; unverified pairings: {len(report['unverified_pairings'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
