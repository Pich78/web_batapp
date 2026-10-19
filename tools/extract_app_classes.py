#!/usr/bin/env python3
"""Extract this app's own classes from an Il2CppDumper ``dump.cs``.

Il2CppDumper (run separately, see AGENTS.md) writes a 4 MB ``dump.cs`` containing
every type in the build. This pulls out the classes that actually belong to the
app — the ones whose MonoBehaviour payloads and UnityEvent targets the port has
to reproduce — and prints their fields (with IL2CPP offsets) and method
signatures, which is what the Ghidra pass needs as a starting point.

Usage:
    python3 tools/extract_app_classes.py --dump .work/il2cpp/dump.cs \
        [--type VolumeValueChange] [--all]
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

APP_TYPES = (
    "BackButton",
    "IconPreview",
    "MoveOnClick",
    "OutputVolume",
    "PauseGame",
    "PauseMenu",
    "SceneSurf",
    "SimpleSpectrum",
    "SliderMenu",
    "SoundFileOpener",
    "UIController",
    "VolumeValueChange",
    "VolumeValueChangefromzero",
    "WebURLScript",
    "gameClose",
    "pauseScript",
)

NOISE = ("[", "// RVA", "// TypeDefIndex", "// Fields", "// Properties", "// Methods")


def read_blocks(dump: Path) -> dict[str, str]:
    lines = dump.read_text(errors="replace").splitlines()
    blocks: dict[str, str] = {}
    index = 0
    while index < len(lines):
        match = re.match(
            r"^(?:\[[^\]]*\]\s*)*(?:public|internal|private)?\s*(?:sealed\s+|abstract\s+|static\s+)*"
            r"(?:class|struct|enum)\s+([\w.]+)",
            lines[index],
        )
        if not match:
            index += 1
            continue
        name = match.group(1).split(".")[-1]
        block: list[str] = []
        depth = 0
        cursor = index
        while cursor < len(lines):
            block.append(lines[cursor])
            depth += lines[cursor].count("{") - lines[cursor].count("}")
            if depth <= 0 and "}" in lines[cursor] and cursor > index:
                break
            cursor += 1
        blocks[name] = "\n".join(block)
        index = cursor + 1
    return blocks


def summarise(name: str, block: str) -> str:
    out = [f"=== {name}"]
    for line in block.splitlines():
        text = line.strip()
        if not text or text in ("{", "}") or text.startswith(NOISE):
            continue
        if text.startswith("//") or text.startswith("/*"):
            continue
        out.append("    " + text[:160])
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump", required=True, type=Path)
    parser.add_argument("--type", dest="wanted", action="append", default=[])
    parser.add_argument("--all", action="store_true", help="print every class found in the dump")
    args = parser.parse_args()

    blocks = read_blocks(args.dump)
    if args.all:
        names = sorted(blocks)
    elif args.wanted:
        names = [name for name in args.wanted if name in blocks]
        missing = [name for name in args.wanted if name not in blocks]
        if missing:
            print("not found:", ", ".join(missing))
    else:
        names = [name for name in APP_TYPES if name in blocks]

    print(f"// Il2CppDumper dump: {args.dump}")
    print(f"// types in dump: {len(blocks)}; selected: {len(names)}")
    for name in names:
        print()
        print(summarise(name, blocks[name]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
