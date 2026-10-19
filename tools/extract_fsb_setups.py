#!/usr/bin/env python3
"""Extract FSB5 Vorbis setup packets from vgmstream's codebook table.

FMOD stores no Vorbis setup packet in the FSB5 bank; it references one by the
CRC32 of the packet it used. vgmstream ships those packets as C arrays keyed by
that CRC (``src/coding/libs/vorbis_codebooks_fsb.h``, itself extracted from FMOD
by python-fsb5). This tool pulls the packets the project actually needs into a
small data file so exporting needs no network access and no codebook table.

Usage:
    python3 tools/extract_fsb_setups.py --header <vorbis_codebooks_fsb.h> \
        --out tools/data/fsb_setups.json [--crcs 0xb03f2dd0,0x1fdf9e1c,0x90021eee]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
from pathlib import Path

ARRAY_RE = r"static const uint8_t vcb_{crc:08x}\[\] = \{{(?P<body>.*?)\n\}};"
TABLE_ENTRY_RE = re.compile(r"\{0x(?P<crc>[0-9a-f]{8}),0x(?P<size>[0-9a-f]+),vcb_[0-9a-f]{8}\}")
BYTE_RE = re.compile(r"0x([0-9a-fA-F]{2})")

DEFAULT_SOURCE = (
    "https://raw.githubusercontent.com/vgmstream/vgmstream/master/src/coding/libs/vorbis_codebooks_fsb.h"
)


def parse_table(header: str) -> dict[str, int]:
    """CRC32 -> declared packet size, from the table at the end of the file."""
    return {m.group("crc"): int(m.group("size"), 16) for m in TABLE_ENTRY_RE.finditer(header)}


def parse_packet(header: str, crc: int) -> bytes:
    match = re.search(ARRAY_RE.format(crc=crc), header, re.DOTALL)
    if not match:
        raise KeyError(f"no packet array for crc32 0x{crc:08x}")
    return bytes(int(value, 16) for value in BYTE_RE.findall(match.group("body")))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--header", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--crcs", default="0xb03f2dd0,0x1fdf9e1c,0x90021eee")
    parser.add_argument("--source-url", default=DEFAULT_SOURCE)
    args = parser.parse_args()

    raw = args.header.read_bytes()
    header = raw.decode("utf-8", "replace")
    table = parse_table(header)

    setups = {}
    for token in args.crcs.split(","):
        crc = int(token.strip(), 16)
        packet = parse_packet(header, crc)
        declared = table.get(f"{crc:08x}")
        if declared is not None and declared != len(packet):
            raise SystemExit(f"0x{crc:08x}: table declares {declared} bytes but parsed {len(packet)}")
        if not packet.startswith(b"\x05vorbis"):
            raise SystemExit(f"0x{crc:08x}: packet does not start with a Vorbis setup signature")
        setups[f"0x{crc:08x}"] = {
            "size": len(packet),
            "sha256": hashlib.sha256(packet).hexdigest(),
            "base64": base64.b64encode(packet).decode("ascii"),
        }
        print(f"0x{crc:08x}  {len(packet):>6} bytes  sha256 {hashlib.sha256(packet).hexdigest()[:16]}")

    document = {
        "provenance": {
            "description": "Vorbis setup packets (CRC32-keyed) as shipped in vgmstream's codebook table, originally extracted from FMOD by python-fsb5.",
            "source_url": args.source_url,
            "source_sha256": hashlib.sha256(raw).hexdigest(),
            "source_bytes": len(raw),
        },
        "setups": setups,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=1) + "\n")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
