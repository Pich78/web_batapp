#!/usr/bin/env python3
"""Inventory the extracted Unity data tree with UnityPy.

Modes
-----
types   Object-type census per serialized file, plus the metadata that drives
        reconstruction: MonoScript class identities, AudioClip properties,
        Sprite/Texture2D/text asset names.
audio   Decode every AudioClip through FMOD and report the exact decoded byte
        total and duration per file (and optionally stage the decoded audio).

Usage:
    python3 tools/unity_inventory.py --data .work/unity/Data --out .work/analysis --mode types
    python3 tools/unity_inventory.py --data .work/unity/Data --out .work/analysis --mode audio [--stage DIR]
"""

from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path
from typing import Any, Iterable

import UnityPy

CODEC = {
    0: "PCM",
    1: "Vorbis",
    2: "ADPCM",
    3: "MP3",
    4: "VAG",
    5: "HEVAG",
    6: "XMA",
    7: "AAC",
    8: "GCADPCM",
    9: "ATRAC9",
}

LOAD_TYPE = {0: "DecompressOnLoad", 1: "CompressedInMemory", 2: "Streaming"}


def as_dict(obj: Any) -> dict:
    """Best-effort field extraction from a UnityPy object."""
    result = {}
    for key, value in vars(obj).items():
        if key.startswith("_"):
            continue
        result[key] = value
    return result


def pptr_name(ptr: Any) -> str | None:
    """Resolve a PPtr to the referenced object's name, if cheap to do."""
    if ptr is None:
        return None
    name = getattr(ptr, "m_Name", None)
    if name:
        return name
    try:
        referenced = ptr.read()
        return getattr(referenced, "m_Name", None)
    except Exception:
        return None


def sound_bytes(clip: Any) -> bytes | None:
    """Encoded payload of an AudioClip (its FSB5 bank or raw container)."""
    data = getattr(clip, "m_AudioData", None)
    if data:
        return bytes(data)
    resource = getattr(clip, "m_Resource", None)
    if resource is None:
        return None
    from UnityPy.helpers.ResourceReader import get_resource_data

    return get_resource_data(
        resource.m_Source,
        clip.object_reader.assets_file,
        resource.m_Offset,
        resource.m_Size,
    )


def load_environment(data_dir: Path) -> UnityPy.Environment:
    env = UnityPy.Environment()
    env.load_folder(str(data_dir))
    return env


def file_name(obj: Any) -> str:
    return getattr(obj.assets_file, "name", "?")


def rel_name(obj: Any) -> str:
    return getattr(obj.assets_file, "filename", file_name(obj))


def run_types(env: UnityPy.Environment, out: Path) -> dict:
    per_file: dict[str, dict] = collections.defaultdict(
        lambda: {"types": collections.Counter(), "monoscripts": [], "audio": [], "sprites": [], "textures": [], "text_assets": []}
    )
    for obj in env.objects:
        name = file_name(obj)
        entry = per_file[name]
        entry["types"][obj.type.name] += 1
        if obj.type.name == "MonoScript":
            script = obj.read()
            entry["monoscripts"].append(
                {
                    "class": getattr(script, "m_ClassName", None),
                    "namespace": getattr(script, "m_Namespace", None),
                    "assembly": getattr(script, "m_AssemblyName", None),
                }
            )
        elif obj.type.name == "AudioClip":
            clip = obj.read()
            payload = None
            try:
                payload = sound_bytes(clip)
            except Exception as error:  # resource resolution failures are reported, not fatal
                entry.setdefault("audio_errors", []).append(f"{clip.m_Name}: {error}")
            resource = getattr(clip, "m_Resource", None)
            entry["audio"].append(
                {
                    "file": name,
                    "name": clip.m_Name,
                    "codec": CODEC.get(clip.m_CompressionFormat, str(clip.m_CompressionFormat)),
                    "frequency": clip.m_Frequency,
                    "channels": clip.m_Channels,
                    "bits": getattr(clip, "m_BitsPerSample", None),
                    "load_type": LOAD_TYPE.get(getattr(clip, "m_LoadType", None), getattr(clip, "m_LoadType", None)),
                    "length": round(clip.m_Length, 4) if getattr(clip, "m_Length", None) else None,
                    "encoded_bytes": len(payload) if payload else 0,
                    "resource": (
                        {
                            "source": resource.m_Source,
                            "offset": resource.m_Offset,
                            "size": resource.m_Size,
                        }
                        if resource is not None
                        else None
                    ),
                }
            )
        elif obj.type.name == "Sprite":
            sprite = obj.read()
            rect = sprite.m_Rect
            entry["sprites"].append(
                {
                    "name": sprite.m_Name,
                    "rect": [round(getattr(rect, k, 0), 2) for k in ("x", "y", "width", "height")],
                    "texture": pptr_name(getattr(sprite.m_RD, "texture", None)),
                    "pivot": [round(v, 4) for v in getattr(sprite.m_RD, "pivot", [])],
                    "border": [round(v, 2) for v in getattr(sprite.m_RD, "border", [])],
                }
            )
        elif obj.type.name == "Texture2D":
            texture = obj.read()
            entry["textures"].append(
                {
                    "name": texture.m_Name,
                    "width": texture.m_Width,
                    "height": texture.m_Height,
                    "format": str(texture.m_TextureFormat),
                }
            )
        elif obj.type.name == "TextAsset":
            asset = obj.read()
            script = getattr(asset, "m_Script", None)
            if isinstance(script, str):
                raw = script.encode("utf-8", "surrogateescape")
            elif script:
                raw = bytes(script)
            else:
                raw = b""
            entry["text_assets"].append({"name": asset.m_Name, "bytes": len(raw)})

    serialized = {
        name: {
            "types": dict(sorted(entry["types"].items(), key=lambda kv: -kv[1])),
            "monoscripts": sorted({(s["assembly"], s["namespace"], s["class"]) for s in entry["monoscripts"]}),
            "audio": entry["audio"],
            "sprites": entry["sprites"],
            "textures": entry["textures"],
            "text_assets": entry["text_assets"],
            **({"audio_errors": entry["audio_errors"]} if "audio_errors" in entry else {}),
        }
        for name, entry in sorted(per_file.items())
    }

    codecs = collections.Counter()
    audio_total = 0
    audio_clips = 0
    for entry in serialized.values():
        for clip in entry["audio"]:
            codecs[clip["codec"]] += 1
            audio_total += clip["encoded_bytes"]
            audio_clips += 1

    summary = {
        "serialized_files": len(serialized),
        "objects": sum(sum(e["types"].values()) for e in serialized.values()),
        "type_census": dict(
            sorted(
                collections.Counter(
                    {t: 0 for e in serialized.values() for t in e["types"]}
                ).items(),
                key=lambda kv: kv[0],
            )
        ),
        "audio_clips": audio_clips,
        "audio_codecs": dict(codecs),
        "audio_encoded_bytes": audio_total,
        "files": {name: sorted(e["types"].keys()) for name, e in serialized.items()},
    }
    type_totals: collections.Counter = collections.Counter()
    for entry in serialized.values():
        type_totals.update(entry["types"])
    summary["type_census"] = dict(type_totals.most_common())

    (out / "file_inventory.json").write_text(json.dumps(serialized, indent=1) + "\n")
    (out / "file_inventory_summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    return summary


def run_audio(env: UnityPy.Environment, out: Path, stage: Path | None) -> dict:
    records = []
    for obj in env.objects:
        if obj.type.name != "AudioClip":
            continue
        clip = obj.read()
        name = clip.m_Name
        file = file_name(obj)
        payload = sound_bytes(clip)
        decoded = clip.samples
        if len(decoded) != 1:
            raise RuntimeError(f"expected one sample stream for {name}, got {list(decoded)}")
        (filename, data) = next(iter(decoded.items()))
        codec = CODEC.get(clip.m_CompressionFormat, str(clip.m_CompressionFormat))
        channels = clip.m_Channels or 1
        frequency = clip.m_Frequency or 44100
        pcm = filename.endswith(".wav")
        seconds = (len(data) - 44) / (channels * 2 * frequency) if pcm else None
        records.append(
            {
                "file": file,
                "name": name,
                "codec": codec,
                "frequency": frequency,
                "channels": channels,
                "encoded_bytes": len(payload) if payload else 0,
                "decoded_name": filename,
                "decoded_bytes": len(data),
                "seconds": round(seconds, 3) if seconds is not None else None,
                "decoded_sha256_16": __import__("hashlib").sha256(data).hexdigest()[:16],
            }
        )
        if stage is not None:
            target = stage / file.replace(".assets", "") / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

    total_seconds = sum(r["seconds"] or 0 for r in records)
    report = {
        "clips": records,
        "decoded_bytes": sum(r["decoded_bytes"] for r in records),
        "decoded_megabytes": round(sum(r["decoded_bytes"] for r in records) / 1e6, 1),
        "encoded_bytes": sum(r["encoded_bytes"] for r in records),
        "total_seconds": round(total_seconds, 1),
        "codecs": dict(collections.Counter(r["codec"] for r in records)),
        "staged": str(stage) if stage else None,
    }
    (out / "audio_report.json").write_text(json.dumps(report, indent=1) + "\n")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--mode", choices=("types", "audio"), default="types")
    parser.add_argument("--only", help="restrict to serialized files whose name contains this string")
    parser.add_argument("--stage", type=Path, help="directory to write decoded audio into")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    env = load_environment(args.data)
    print(f"loaded {len(env.files)} files, {len(env.cabs)} cabs from {args.data}")

    if args.mode == "types":
        summary = run_types(env, args.out)
        print(json.dumps({k: v for k, v in summary.items() if k != "files"}, indent=1))
        print("type census:", json.dumps(summary["type_census"]))
        print(f"wrote {args.out / 'file_inventory.json'}")
    else:
        report = run_audio(env, args.out, args.stage)
        print(
            json.dumps(
                {
                    "clips": len(report["clips"]),
                    "codecs": report["codecs"],
                    "encoded_megabytes": round(report["encoded_bytes"] / 1e6, 1),
                    "decoded_megabytes": report["decoded_megabytes"],
                    "total_seconds": report["total_seconds"],
                    "staged": report["staged"],
                },
                indent=1,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
