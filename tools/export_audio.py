#!/usr/bin/env python3
"""Export BatApp lesson audio as Ogg Vorbis without re-encoding the audio.

Unity stores every stem as an FSB5 bank. The bank holds raw Vorbis packets with
16-bit length prefixes plus the CRC32 of the Vorbis setup packet that FMOD used
(``VORBISDATA`` metadata); the setup packet itself lives in the encoder. This
tool rebuilds an Ogg container around the untouched packets, injecting the
original setup packet recovered by ``tools/extract_fsb_setups.py``. The exported
``.ogg`` therefore carries the app's encoded audio bit-for-bit.

Verification (``--verify``) decodes the remuxed Ogg with ffmpeg and the original
bank with FMOD, then compares the two PCM streams sample by sample.

Usage:
    python3 tools/export_audio.py --inventory .work/analysis/file_inventory.json \
        --scene-map .work/analysis/scene_map.json --data .work/unity/Data \
        --setups tools/data/fsb_setups.json --out assets/audio \
        --report .work/analysis/audio_export.json [--verify] [--verify-all] [--limit N]
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import json
import re
import struct
import subprocess
import sys
from io import BytesIO
from pathlib import Path

import fsb5
import fsb5.vorbis as fv
from fsb5 import BinaryReader, MetadataChunkType

STEMS = ("iya", "ito", "oko", "vox", "beat")
VENDOR = b"Batapp static port (FSB5 remux, original Vorbis packets)"


def slugify(value: str) -> str:
    value = value.lower().replace("’", "'")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def stem_for(clip_name: str) -> str:
    token = slugify(clip_name.strip().lower()).split("-")[0]
    return token if token in STEMS else slugify(clip_name)


def build_id_header(channels: int, frequency: int, long_exp: int = 11, short_exp: int = 8) -> bytes:
    """Vorbis identification packet; FSB Vorbis uses 2048/256 sample blocks."""
    return (
        b"\x01vorbis"
        + struct.pack("<I", 0)
        + bytes([channels])
        + struct.pack("<I", frequency)
        + struct.pack("<iii", 0, 0, 0)
        + bytes([(long_exp << 4) | short_exp])
        + b"\x01"
    )


def build_comment_header(vendor: bytes = VENDOR) -> bytes:
    return b"\x03vorbis" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 0) + b"\x01"


def make_packet(data: bytes, packetno: int, granulepos: int = 0, b_o_s: int = 0, e_o_s: int = 0):
    """Wrap bytes in a libogg packet; the returned buffer must outlive the packet."""
    holder = ctypes.create_string_buffer(data, len(data))
    packet = fv.OggPacket()
    packet.packet = ctypes.cast(holder, ctypes.POINTER(ctypes.c_char))
    packet.bytes = len(data)
    packet.b_o_s = b_o_s
    packet.e_o_s = e_o_s
    packet.granulepos = granulepos
    packet.packetno = packetno
    return packet, holder


def bank_frame_count(bank: bytes) -> int:
    """Authoritative frame count from the FSB5 sample header (bits 63..34)."""
    version = struct.unpack_from("<I", bank, 0x04)[0]
    base_header_size = 0x3C if version == 1 else 0x40
    sample_mode = struct.unpack_from("<Q", bank, base_header_size)[0]
    return (sample_mode >> 34) & 0x3FFFFFFF


def remux_with_setup(sample, setup: bytes, frame_count: int) -> bytes:
    """Mux an FSB5 Vorbis subsound into Ogg using the original setup packet.

    ``frame_count`` is the bank's stored length; it becomes the end-of-stream
    granule so decoders output exactly the original number of frames instead of
    the untrimmed block sum.
    """
    channels, frequency = sample.channels, sample.frequency
    info, comment = fv.VorbisInfo(), fv.VorbisComment()
    headers = [
        make_packet(build_id_header(channels, frequency), 0, b_o_s=1),
        make_packet(build_comment_header(), 1),
        make_packet(setup, 2),
    ]
    for packet, _ in headers:
        fv.vorbis.vorbis_synthesis_headerin(info, comment, packet)

    state = fv.OggStreamState(1)
    out = BytesIO()
    for packet, _ in headers:
        fv.ogg.ogg_stream_packetin(state, packet)
        fv.write_packets(state, out)
    fv.write_packets(state, out, func=fv.ogg.ogg_stream_flush)

    reader = BinaryReader(BytesIO(sample.data))
    size = reader.read_type("H")
    packetno = 2
    granulepos = 0
    previous_blocksize = 0
    while size:
        packetno += 1
        payload = reader.read(size)
        try:
            size = reader.read_type("H")
        except ValueError:
            size = 0
        packet, _holder = make_packet(payload, packetno, e_o_s=1 if not size else 0)
        blocksize = fv.vorbis.vorbis_packet_blocksize(info, packet)
        if not blocksize:
            raise RuntimeError("vorbis_packet_blocksize failed for a packet")
        granulepos = granulepos + (blocksize + previous_blocksize) // 4 if previous_blocksize else 0
        packet.granulepos = frame_count if not size else granulepos
        previous_blocksize = blocksize
        fv.ogg.ogg_stream_packetin(state, packet)
        fv.write_packets(state, out)
    return out.getvalue()


def ogg_audio_packets(ogg_bytes: bytes) -> list[bytes]:
    """Extract the audio packets (packet 3 onwards) from an Ogg Vorbis stream."""
    packets: list[bytes] = []
    offset = 0
    pending = bytearray()
    while offset < len(ogg_bytes):
        if ogg_bytes[offset : offset + 4] != b"OggS":
            raise ValueError(f"not an Ogg page at offset {offset}")
        segment_count = ogg_bytes[offset + 26]
        lacing = ogg_bytes[offset + 27 : offset + 27 + segment_count]
        body_start = offset + 27 + segment_count
        body_offset = body_start
        for length in lacing:
            pending.extend(ogg_bytes[body_offset : body_offset + length])
            body_offset += length
            if length < 255:
                packets.append(bytes(pending))
                pending.clear()
        offset = body_offset
    return packets[3:]  # skip identification, comment and setup


def fsb_packets(sample) -> list[bytes]:
    """Packet payloads as stored in the FSB5 subsound (16-bit length prefixed)."""
    reader = BinaryReader(BytesIO(sample.data))
    packets = []
    try:
        size = reader.read_type("H")
    except ValueError:
        return packets
    while size:
        packets.append(reader.read(size))
        try:
            size = reader.read_type("H")
        except ValueError:
            break
    return packets


def decode_with_ffmpeg(ogg_bytes: bytes) -> bytes:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"],
        input=ogg_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return result.stdout


def decode_with_fmod(bank_bytes: bytes, name: str, channels: int, frequency: int) -> bytes:
    from fmod_toolkit import raw_to_wav

    samples = raw_to_wav(bank_bytes, name, channels, frequency, convert_pcm_float=True)
    if len(samples) != 1:
        raise RuntimeError(f"expected one subsound for {name}, got {list(samples)}")
    return next(iter(samples.values()))[44:]  # strip the fixed 44-byte RIFF/fmt/data header


def compare(pcm_a: bytes, pcm_b: bytes) -> dict:
    import numpy as np

    a = np.frombuffer(pcm_a[: len(pcm_a) // 2 * 2], dtype="<i2")
    b = np.frombuffer(pcm_b[: len(pcm_b) // 2 * 2], dtype="<i2")
    length = min(len(a), len(b))
    diff = np.abs(a[:length].astype("i4") - b[:length].astype("i4"))
    mismatches = int((diff != 0).sum())
    return {
        "samples_a": int(len(a)),
        "samples_b": int(len(b)),
        "sample_delta": int(len(a) - len(b)),
        "compared_samples": int(length),
        "mismatched_samples": mismatches,
        "mismatch_ratio": round(mismatches / length, 6) if length else None,
        "max_abs_difference": int(diff.max()) if length else None,
        "first_mismatch_sample": int(np.argmax(diff != 0)) if mismatches else None,
    }


def load_setups(path: Path) -> dict[int, bytes]:
    document = json.loads(path.read_text())
    return {
        int(crc, 16): base64.b64decode(entry["base64"])
        for crc, entry in document["setups"].items()
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--scene-map", required=True, type=Path)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--setups", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--verify-all", action="store_true", help="verify every clip, not just the first two")
    parser.add_argument("--limit", type=int, help="export only the first N clips")
    args = parser.parse_args()

    inventory = json.loads(args.inventory.read_text())
    scene_map = json.loads(args.scene_map.read_text())
    scene_by_assets = {entry["assets"]: entry for entry in scene_map["entries"]}
    setups = load_setups(args.setups)

    clips = [(file_name, clip) for file_name, entry in sorted(inventory.items()) for clip in entry.get("audio", [])]
    if args.limit:
        clips = clips[: args.limit]

    file_cache: dict[str, bytes] = {}
    records = []
    verified = []
    for index, (file_name, clip) in enumerate(clips, start=1):
        resource = clip.get("resource")
        if not resource:
            raise SystemExit(f"{clip['name']}: no streamed resource")
        source = args.data / resource["source"]
        if file_name not in file_cache:
            file_cache = {file_name: source.read_bytes()}
        bank = file_cache[file_name][resource["offset"] : resource["offset"] + resource["size"]]
        if bank[:4] != b"FSB5":
            raise SystemExit(f"{clip['name']}: expected FSB5 payload at {resource}")
        if clip["codec"] != "Vorbis":
            raise SystemExit(f"{clip['name']}: unsupported codec {clip['codec']}")

        fsb = fsb5.load(bank)
        if len(fsb.samples) != 1:
            raise SystemExit(f"{clip['name']}: expected one subsound, got {len(fsb.samples)}")
        setup_crc = fsb.samples[0].metadata[MetadataChunkType.VORBISDATA].crc32
        if setup_crc not in setups:
            raise SystemExit(f"{clip['name']}: no setup packet for crc32 0x{setup_crc:08x}")
        frame_count = bank_frame_count(bank)
        ogg = remux_with_setup(fsb.samples[0], setups[setup_crc], frame_count)

        scene = scene_by_assets.get(file_name, {})
        stem = stem_for(clip["name"])
        relative = Path(scene.get("slug", slugify(file_name))) / f"{stem}.ogg"
        target = args.out / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(ogg)

        record = {
            "level": scene.get("level"),
            "scene": scene.get("scene"),
            "volume": scene.get("volume"),
            "lesson": scene.get("number"),
            "lesson_title": scene.get("title"),
            "slug": scene.get("slug"),
            "assets": file_name,
            "clip_name": clip["name"],
            "stem": stem,
            "path": str(relative),
            "setup_crc32": f"0x{setup_crc:08x}",
            "frame_count": frame_count,
            "unity_frames": round(clip["length"] * clip["frequency"]) if clip.get("length") else None,
            "encoded_bank_bytes": len(bank),
            "ogg_bytes": len(ogg),
            "sha256": hashlib.sha256(ogg).hexdigest(),
            "duration_seconds": clip["length"],
            "frequency": clip["frequency"],
            "channels": clip["channels"],
        }

        if args.verify and (args.verify_all or index <= 2):
            original_packets = fsb_packets(fsb.samples[0])
            remuxed_packets = ogg_audio_packets(ogg)
            packets_identical = original_packets == remuxed_packets
            original = decode_with_fmod(bank, clip["name"], clip["channels"], clip["frequency"])
            remuxed = decode_with_ffmpeg(ogg)
            verification = compare(original, remuxed)
            verification.update(
                {
                    "packets_in_bank": len(original_packets),
                    "packets_in_ogg": len(remuxed_packets),
                    "packets_identical": packets_identical,
                    "decoded_frames_ogg": len(remuxed) // (2 * clip["channels"]),
                    "decoded_frames_fmod": len(original) // (2 * clip["channels"]),
                    "bank_frames": frame_count,
                    "unity_frames": round(clip["length"] * clip["frequency"]) if clip.get("length") else None,
                }
            )
            record["verification"] = verification
            verified.append({"path": str(relative), **verification})

        records.append(record)
        if index % 25 == 0 or index == len(clips):
            print(f"  {index}/{len(clips)} clips exported", file=sys.stderr)

    report = {
        "clips": len(records),
        "ogg_bytes": sum(r["ogg_bytes"] for r in records),
        "bank_bytes": sum(r["encoded_bank_bytes"] for r in records),
        "duration_seconds": round(sum(r["duration_seconds"] or 0 for r in records), 1),
        "stems": sorted({r["stem"] for r in records}),
        "lessons": len({r["slug"] for r in records}),
        "setup_crcs": sorted({r["setup_crc32"] for r in records}),
        "verified": verified,
        "records": records,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=1) + "\n")

    print(f"exported {report['clips']} clips across {report['lessons']} lessons -> {args.out}")
    print(f"ogg total {report['ogg_bytes']/1e6:.1f} MB (banks {report['bank_bytes']/1e6:.1f} MB), {report['duration_seconds']/60:.1f} min")
    print(f"stems: {report['stems']} setups: {report['setup_crcs']}")
    for entry in verified:
        print(
            f"verify {entry['path']}: packets_identical={entry['packets_identical']} "
            f"frames ogg={entry['decoded_frames_ogg']} fmod={entry['decoded_frames_fmod']} bank={entry['bank_frames']} unity={entry['unity_frames']} "
            f"| mismatch={entry['mismatched_samples']}/{entry['compared_samples']} max_diff={entry['max_abs_difference']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
