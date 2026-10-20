#!/usr/bin/env python3
"""Keep every shipped cache-busting string equal to the repository tag.

The app is static: the HTML, manifest and every local asset URL carry the same
version so an installed PWA cannot mix an old cached script with new markup.
This tool makes the Git tag the single source of truth for that value.

Usage:
    .venv/bin/python tools/set_version.py set v1.2.3
    .venv/bin/python tools/set_version.py check
    .venv/bin/python tools/set_version.py check --tag v1.2.3
    .venv/bin/python tools/set_version.py show
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = (
    ROOT / "index.html",
    ROOT / "index_old.html",
    ROOT / "site.webmanifest",
)
VERSION_PATTERN = re.compile(r"^v\d+\.\d+\.\d+$")
QUERY_VERSION = re.compile(r"(\?v=)([^\"&]+)")
META_VERSION = re.compile(r'(<meta name="batapp-version" content=")([^"]*)(">)')
BUILD_VERSION = re.compile(r'(var build = ")([^"]*)(";)')
MANIFEST_VERSION = re.compile(r'("version"\s*:\s*")([^"]*)(")')


def fail(message: str) -> None:
    print("error: " + message, file=sys.stderr)
    raise SystemExit(1)


def validate(version: str) -> str:
    if not VERSION_PATTERN.fullmatch(version):
        fail(f"version {version!r} must look like v1.2.3")
    return version


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def replace_value(pattern: re.Pattern[str], text: str, version: str) -> str:
    return pattern.sub(lambda match: match.group(1) + version + match.group(3), text)


def set_version(version: str) -> None:
    validate(version)
    changed = []
    for path in FILES:
        original = read(path)
        updated = QUERY_VERSION.sub(
            lambda match: match.group(1) + version, original
        )
        if path.name == "index.html":
            updated = replace_value(META_VERSION, updated, version)
            updated = replace_value(BUILD_VERSION, updated, version)
        if path.name == "site.webmanifest":
            updated = replace_value(MANIFEST_VERSION, updated, version)
        if updated != original:
            write(path, updated)
            changed.append(path.relative_to(ROOT))
    if changed:
        print(f"set {version} in " + ", ".join(str(path) for path in changed))
    else:
        print(f"already at {version}")


def app_version() -> str:
    match = META_VERSION.search(read(ROOT / "index.html"))
    if not match:
        fail("index.html is missing <meta name=\"batapp-version\">")
    return match.group(2)


def manifest_version() -> str:
    match = MANIFEST_VERSION.search(read(ROOT / "site.webmanifest"))
    if not match:
        fail("site.webmanifest is missing its version")
    return match.group(2)


def exact_tag() -> str:
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--exact-match", "HEAD"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError:
        fail("HEAD is not tagged; pass --tag vX.Y.Z")
    return result.stdout.strip()


def check(tag: str | None) -> None:
    expected = validate(tag or exact_tag())
    problems: list[str] = []

    current = app_version()
    if current != expected:
        problems.append(f"index.html meta version is {current!r}, expected {expected!r}")

    manifest = manifest_version()
    if manifest != expected:
        problems.append(
            f"site.webmanifest version is {manifest!r}, expected {expected!r}"
        )

    for path in FILES:
        for match in QUERY_VERSION.finditer(read(path)):
            if match.group(2) != expected:
                problems.append(
                    f"{path.relative_to(ROOT)} uses ?v={match.group(2)}, expected {expected}"
                )

    if problems:
        for problem in problems:
            print("error: " + problem, file=sys.stderr)
        raise SystemExit(1)
    print(f"version matches tag {expected}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    set_parser = subparsers.add_parser("set", help="rewrite every version string")
    set_parser.add_argument("version", help="tag-shaped version, e.g. v1.2.3")

    check_parser = subparsers.add_parser("check", help="verify the files match a tag")
    check_parser.add_argument("--tag", help="expected tag; defaults to HEAD's exact tag")

    subparsers.add_parser("show", help="print the version stored in index.html")

    args = parser.parse_args()
    if args.command == "set":
        set_version(args.version)
    elif args.command == "check":
        check(args.tag)
    else:
        print(app_version())


if __name__ == "__main__":
    main()
