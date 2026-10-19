#!/usr/bin/env python3
"""Extract the BatApp XAPK into a working tree suitable for UnityPy.

The package is an XAPK: a base APK plus an OBB expansion file. Unity splits
serialized files larger than the Android asset chunk limit into
``<name>.splitN`` members; the engine reads them as one concatenated stream, so
this tool rejoins them into ``<name>`` before anything else reads the tree.

Outputs (all under the working directory, never inside the deliverable):

    <work>/xapk/base.apk, <work>/xapk/main.obb, <work>/xapk/icon.png
    <work>/unity/Data/...            merged, splits rejoined
    <work>/native/<abi>/libil2cpp.so
    <work>/evidence/extraction.json  sizes, digests, member inventory

Usage:
    python3 tools/extract_xapk.py --xapk <path> --work <dir>
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

SPLIT_RE = re.compile(r"^(?P<base>.+)\.split(?P<index>\d+)$")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def group_splits(names: list[str]) -> tuple[dict[str, list[str]], list[str]]:
    """Return ({base: [part, ...]}, [plain names]) for one archive."""
    parts: dict[str, list[tuple[int, str]]] = {}
    plain: list[str] = []
    for name in names:
        match = SPLIT_RE.match(name)
        if match:
            parts.setdefault(match.group("base"), []).append((int(match.group("index")), name))
        else:
            plain.append(name)
    grouped = {
        base: [name for _, name in sorted(chunks)] for base, chunks in parts.items()
    }
    return grouped, plain


def extract_zip_members(
    archive: zipfile.ZipFile,
    prefix: str,
    out_dir: Path,
    *,
    rejoin_splits: bool = True,
) -> tuple[list[dict], list[dict]]:
    """Write members under ``prefix`` into ``out_dir``, rejoining split files.

    Returns (files, groups) describing what was written.
    """
    names = [n for n in archive.namelist() if n.startswith(prefix) and not n.endswith("/")]
    rel = [n[len(prefix):] for n in names]
    grouped, plain = group_splits(rel)

    files: list[dict] = []
    groups: list[dict] = []

    def write(target: Path, data: bytes, members: list[str]) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append(
            {
                "path": str(target.relative_to(out_dir.parent.parent)),
                "size": len(data),
                "sha256": sha256_bytes(data),
                "members": members,
            }
        )

    for name in plain:
        data = archive.read(prefix + name)
        write(out_dir / name, data, [prefix + name])

    if rejoin_splits:
        for base, members in grouped.items():
            buffer = io.BytesIO()
            for member in members:
                buffer.write(archive.read(prefix + member))
            write(out_dir / base, buffer.getvalue(), [prefix + m for m in members])
            groups.append({"base": base, "members": members})

    return files, groups


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xapk", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    args = parser.parse_args()

    xapk_path: Path = args.xapk
    work: Path = args.work
    xapk_dir = work / "xapk"
    unity_dir = work / "unity"
    native_dir = work / "native"
    evidence_dir = work / "evidence"
    for directory in (xapk_dir, unity_dir, native_dir, evidence_dir):
        directory.mkdir(parents=True, exist_ok=True)

    xapk_bytes = xapk_path.read_bytes()
    xapk = zipfile.ZipFile(io.BytesIO(xapk_bytes))
    members = {info.filename: info.file_size for info in xapk.infolist()}

    apk_name = next(n for n in xapk.namelist() if n.endswith(".apk"))
    obb_name = next(n for n in xapk.namelist() if n.endswith(".obb"))
    apk_bytes = xapk.read(apk_name)
    obb_bytes = xapk.read(obb_name)
    (xapk_dir / "base.apk").write_bytes(apk_bytes)
    (xapk_dir / "main.obb").write_bytes(obb_bytes)
    for icon in ("icon.png", "manifest.json"):
        if icon in members:
            (xapk_dir / icon).write_bytes(xapk.read(icon))

    apk = zipfile.ZipFile(io.BytesIO(apk_bytes))
    obb = zipfile.ZipFile(io.BytesIO(obb_bytes))

    data_root = unity_dir / "Data"
    apk_files, apk_groups = extract_zip_members(apk, "assets/bin/Data/", data_root)
    obb_files, obb_groups = extract_zip_members(obb, "assets/bin/Data/", data_root)

    native_files: list[dict] = []
    for member in apk.namelist():
        if not member.startswith("lib/") or not member.endswith("libil2cpp.so"):
            continue
        abi = member.split("/")[1]
        data = apk.read(member)
        target = native_dir / abi / "libil2cpp.so"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        native_files.append(
            {"path": str(target.relative_to(work)), "size": len(data), "sha256": sha256_bytes(data), "member": member}
        )

    combined = {f["path"]: f for f in apk_files}
    collisions = [f["path"] for f in obb_files if f["path"] in combined]
    combined.update({f["path"]: f for f in obb_files})

    report = {
        "xapk": {
            "path": str(xapk_path.resolve()),
            "size": len(xapk_bytes),
            "sha256": sha256_bytes(xapk_bytes),
            "members": members,
        },
        "apk": {"member": apk_name, "size": len(apk_bytes), "sha256": sha256_bytes(apk_bytes)},
        "obb": {"member": obb_name, "size": len(obb_bytes), "sha256": sha256_bytes(obb_bytes)},
        "unity_data": {
            "root": str(data_root.relative_to(work)),
            "file_count": len(combined),
            "total_size": sum(f["size"] for f in combined.values()),
            "rejoined_groups": apk_groups + obb_groups,
            "source_collisions": collisions,
            "files": sorted(combined.values(), key=lambda f: f["path"]),
        },
        "native": native_files,
    }
    for name in ("icon.png", "manifest.json"):
        path = xapk_dir / name
        if path.exists():
            report[name.replace(".", "_")] = {"size": path.stat().st_size, "sha256": sha256_file(path)}

    out = evidence_dir / "extraction.json"
    out.write_text(json.dumps(report, indent=1) + "\n")
    print(f"xapk   {report['xapk']['sha256'][:16]}  {report['xapk']['size']:,} bytes")
    print(f"apk    {report['apk']['sha256'][:16]}  {report['apk']['size']:,} bytes")
    print(f"obb    {report['obb']['sha256'][:16]}  {report['obb']['size']:,} bytes")
    print(
        f"unity  {report['unity_data']['file_count']} files, "
        f"{report['unity_data']['total_size']:,} bytes, "
        f"{len(report['unity_data']['rejoined_groups'])} rejoined split groups"
    )
    if collisions:
        print(f"WARNING: {len(collisions)} member collisions between apk and obb: {collisions}")
    print(f"native {[(f['member'], f['size']) for f in native_files]}")
    print(f"report {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
