#!/usr/bin/env python3
"""Turn the scene dumps into the layout/content data the static app loads.

Unity positions UI with RectTransforms (anchors + pivot + sizeDelta) inside a
canvas whose CanvasScaler gives a reference resolution of 1920x1080. This tool
flattens that hierarchy into absolute rectangles in canvas space (y up, origin
bottom-left, as Unity stores it), resolves sprite references to exported PNGs,
and writes everything as a classic script (``js/data.js``) because a page opened
over ``file://`` cannot fetch JSON.

Usage:
    python3 tools/build_app_data.py --scenes .work/scenes --sprites .work/analysis/sprites.json \
        --audio-report .work/analysis/audio_export.json --out js/data.js
"""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

TEXT_ANCHOR = {
    0: "upper-left", 1: "upper-center", 2: "upper-right",
    3: "middle-left", 4: "middle-center", 5: "middle-right",
    6: "lower-left", 7: "lower-center", 8: "lower-right",
}
FONT_STYLE = {0: "normal", 1: "bold", 2: "italic", 3: "bold italic"}
H_OVERFLOW = {0: "wrap", 1: "overflow"}
V_OVERFLOW = {0: "truncate", 1: "overflow"}
IMAGE_TYPE = {0: "simple", 1: "sliced", 2: "tiled", 3: "filled"}
FILL_METHOD = {0: "horizontal", 1: "vertical", 2: "radial-90", 3: "radial-180", 4: "radial-360"}
SLIDER_DIRECTION = {0: "left-to-right", 1: "right-to-left", 2: "bottom-to-top", 3: "top-to-bottom"}


def local_rect_of(transform: dict, parent_size: list[float]) -> list[float]:
    """[x, y, w, h] relative to the parent's rect minimum, in the parent's local units.

    Unity resolves anchors against the parent's *local* size; the parent's
    localScale is applied afterwards when converting to canvas units.
    """
    px, py, pw, ph = 0.0, 0.0, parent_size[0], parent_size[1]
    amin, amax = transform["anchor_min"], transform["anchor_max"]
    pivot = transform["pivot"]
    delta = transform["size_delta"]
    anchored = transform["anchored_position"]
    min_x, min_y = amin[0] * pw, amin[1] * ph
    max_x, max_y = amax[0] * pw, amax[1] * ph
    width = (max_x - min_x) + delta[0]
    height = (max_y - min_y) + delta[1]
    pivot_x = min_x + (max_x - min_x) * pivot[0] + anchored[0]
    pivot_y = min_y + (max_y - min_y) * pivot[1] + anchored[1]
    return [pivot_x - width * pivot[0], pivot_y - height * pivot[1], width, height]


def sprite_key(ref) -> str | None:
    if not isinstance(ref, dict):
        return None
    cls, name = ref.get("class"), ref.get("name")
    if cls in ("Sprite", "Texture2D") and name:
        return name
    return None


def build_screen(model: dict, sprites: dict[str, list[str]]) -> dict:
    nodes = model["nodes"]
    by_transform = {node["transform"]["path_id"]: node for node in nodes if node.get("transform")}
    by_go = {node["game_object"]: node for node in nodes}
    canvas = [c for node in nodes for c in node["components"] if c.get("type") == "Canvas"]
    scalers = [c for node in nodes for c in node["components"] if c.get("type") == "CanvasScaler"]
    reference = [1920.0, 1080.0]
    match = None
    if scalers:
        reference = scalers[0]["fields"]["m_ReferenceResolution"]
        match = scalers[0]["fields"]["m_MatchWidthOrHeight"]

    drawables: list[dict] = []
    unresolved: list[str] = []

    rects_by_transform: dict[int, list[float]] = {}

    def walk(node: dict, parent_origin: list[float], parent_size: list[float], parent_scale: float,
             order: list[int], canvas_order: int = 0, clip: list[float] | None = None, parent_active: bool = True) -> None:
        transform = node.get("transform")
        if transform is None:
            return
        canvas_component = next((c for c in node["components"] if c.get("type") == "Canvas"), None)
        if canvas_component is not None:
            # Unity drives a canvas RectTransform to the screen; its own canvas
            # size (in reference units) is what its children anchor against.
            local_scale = 1.0
            canvas_order = int(canvas_component.get("sorting_order", 0))
            scaler = next((c for c in node["components"] if c.get("type") == "CanvasScaler"), None) if False else None
            size = [float(reference[0]), float(reference[1])]
            rect = [0.0, 0.0, size[0], size[1]]
        else:
            if "anchor_min" not in transform:
                # A plain Transform (e.g. an "Actions" holder) is not drawable, but
                # its UI children still anchor to the nearest UI ancestor.
                for child_transform in transform.get("children", []):
                    child = by_transform.get(child_transform)
                    if child is not None:
                        walk(child, parent_origin, parent_size, parent_scale, order, canvas_order, clip, parent_active)
                return
            local_scale = float(transform.get("local_scale", [1.0])[0] or 1.0)
            local = local_rect_of(transform, parent_size)
            rect = [
                round(parent_origin[0] + local[0] * parent_scale, 2),
                round(parent_origin[1] + local[1] * parent_scale, 2),
                round(local[2] * parent_scale * local_scale, 2),
                round(local[3] * parent_scale * local_scale, 2),
            ]
            size = [local[2], local[3]]
        rects_by_transform[transform["path_id"]] = rect
        active = bool(node.get("active", True)) and parent_active
        if any(component.get("type") == "Mask" for component in node["components"]):
            clip = rect  # Mask/ScrollRect viewport: descendants are clipped to it
        for component in node["components"]:
            kind = component.get("type")
            fields = component.get("fields") if isinstance(component.get("fields"), dict) else None
            if kind in ("Image", "RawImage"):
                if not fields:
                    continue
                ref = fields.get("m_Sprite") if kind == "Image" else fields.get("m_Texture")
                key = sprite_key(ref)
                if isinstance(ref, dict) and ref.get("path_id") and key is None:
                    unresolved.append(f"{model['file']}:{node['path']} -> {ref.get('name')}")
                if kind == "RawImage" and key is None:
                    drawables.append(
                        {
                            "kind": "video-placeholder",
                            "rect": rect,
                            "name": node["name"],
                            "path": node["path"],
                            "active": active,
                            "order": len(order),
                            "canvas_order": canvas_order,
                        }
                    )
                    order.append(1)
                    continue
                entry = {
                    "kind": "image",
                    "rect": rect,
                    "sprite": key,
                    "color": fields.get("m_Color"),
                    "preserve_aspect": fields.get("m_PreserveAspect", False),
                    "image_type": IMAGE_TYPE.get(fields.get("m_Type", 0), "simple"),
                    "fill_method": FILL_METHOD.get(fields.get("m_FillMethod", 0)),
                    "fill_amount": fields.get("m_FillAmount"),
                    "fill_center": fields.get("m_FillCenter", True),
                    "fill_origin": fields.get("m_FillOrigin"),
                    "raycast": fields.get("m_RaycastTarget", True),
                    "enabled": fields.get("m_Enabled", True),
                    "active": active,
                    "name": node["name"],
                    "path": node["path"],
                    "order": len(order),
                    "canvas_order": canvas_order,
                    "clip": clip,
                    "overlay": (not active),
                }
                drawables.append(entry)
                order.append(1)
            elif kind == "Text":
                if not fields:
                    continue
                font = fields.get("m_FontData") or {}
                drawables.append(
                    {
                        "kind": "text",
                        "rect": rect,
                        "text": fields.get("m_Text", ""),
                        "font_size": font.get("m_FontSize"),
                        "font_style": FONT_STYLE.get(font.get("m_FontStyle", 0), "normal"),
                        "alignment": TEXT_ANCHOR.get(font.get("m_Alignment", 0), "upper-left"),
                        "line_spacing": font.get("m_LineSpacing"),
                        "best_fit": font.get("m_BestFit", False),
                        "min_size": font.get("m_MinSize"),
                        "max_size": font.get("m_MaxSize"),
                        "align_by_geometry": font.get("m_AlignByGeometry", False),
                        "rich_text": font.get("m_RichText", True),
                        "horizontal_overflow": H_OVERFLOW.get(font.get("m_HorizontalOverflow", 0), "wrap"),
                        "vertical_overflow": V_OVERFLOW.get(font.get("m_VerticalOverflow", 0), "truncate"),
                        "color": fields.get("m_Color"),
                        "enabled": fields.get("m_Enabled", True),
                        "active": active,
                        "name": node["name"],
                        "path": node["path"],
                        "order": len(order),
                        "canvas_order": canvas_order,
                        "clip": clip,
                        "overlay": (not active),
                    }
                )
                order.append(1)
            elif kind in ("Slider", "Button"):
                sub_rects = {}
                sub_paths = {}
                if kind == "Slider" and fields:
                    for key_field, label in (("m_FillRect", "fill"), ("m_HandleRect", "handle")):
                        ref = fields.get(key_field)
                        if isinstance(ref, dict) and ref.get("path_id"):
                            sub_paths[label] = ref["path_id"]
                drawables.append(
                    {
                        "kind": kind.lower(),
                        "rect": rect,
                        "name": node["name"],
                        "path": node["path"],
                        "enabled": (fields or {}).get("m_Enabled", True),
                        "interactable": (fields or {}).get("m_Interactable", True),
                        "active": active,
                        "order": len(order),
                        "canvas_order": canvas_order,
                        "clip": clip,
                        "overlay": (not active),
                        "sub_paths": sub_paths or None,
                        **sub_rects,
                        **(
                            {
                                "min": fields.get("m_MinValue"),
                                "max": fields.get("m_MaxValue"),
                                "value": fields.get("m_Value"),
                                "whole_numbers": fields.get("m_WholeNumbers", False),
                                "direction": SLIDER_DIRECTION.get(fields.get("m_Direction", 0)),
                                "calls": fields.get("m_OnValueChanged", []),
                            }
                            if kind == "Slider"
                            else {"calls": fields.get("m_OnClick", [])}
                        ),
                    }
                )
                order.append(1)
        child_origin = [rect[0], rect[1]]
        child_scale = parent_scale * local_scale
        for child_transform in transform.get("children", []):
            child = by_transform.get(child_transform)
            if child is not None:
                walk(child, child_origin, size, child_scale, order, canvas_order, clip, active)

    roots = [
        node
        for node in nodes
        if node.get("transform") and node["transform"]["parent"] not in by_transform
    ]
    for root in roots:
        walk(root, [0.0, 0.0], [float(reference[0]), float(reference[1])], 1.0, [])

    for drawable in drawables:
        if drawable["kind"] != "slider" or not drawable.get("sub_paths"):
            continue
        for label, transform_id in drawable["sub_paths"].items():
            if transform_id in rects_by_transform:
                drawable[label] = rects_by_transform[transform_id]
        drawable.pop("sub_paths", None)

    # Unity drives the fill's size at runtime, so a slider authored at value 0
    # can carry a degenerate fill rect. Every slider in a scene comes from the
    # same prefab, so take the modal fill geometry as the full-travel rect.
    import collections as _collections

    fills = _collections.Counter(
        tuple(d["fill"]) for d in drawables if d["kind"] == "slider" and d.get("fill")
    )
    if fills:
        modal, count = fills.most_common(1)[0]
        for d in drawables:
            if d["kind"] != "slider" or not d.get("fill"):
                continue
            if d["fill"][2] < 2 or d["fill"][3] < 2:
                d["fill_source"] = "prefab-modal"
                d["fill"] = list(modal)
    # wire hook names: element name -> resolved calls from the scene dump
    hooks_by_element: dict[str, list[dict]] = {}
    for entry in model.get("wiring", []):
        hooks_by_element.setdefault(entry.get("element_path") or entry["element"], []).extend(
            [
                {
                    "field": entry["field"],
                    "method": call["method"],
                    "target": call.get("game_object"),
                    "script": call.get("resolved_script") or call.get("resolved_class"),
                    "target_path_id": call.get("path_id"),
                    "string_argument": call.get("string_argument"),
                }
                for call in entry["calls"]
            ]
        )

    for drawable in drawables:
        if drawable["kind"] in ("slider", "button"):
            drawable["hooks"] = hooks_by_element.get(drawable["path"]) or hooks_by_element.get(drawable["name"], [])
    drawables.sort(key=lambda d: (d.get("canvas_order", 0), d["order"]))
    return {
        "file": model["file"],
        "slug": model["slug"],
        "scene": model["scene"],
        "title": model.get("title"),
        "volume": model.get("volume"),
        "number": model.get("number"),
        "reference_resolution": reference,
        "match_width_or_height": match,
        "canvases": canvas,
        "drawables": drawables,
        "unresolved_sprites": unresolved,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenes", required=True, type=Path)
    parser.add_argument("--sprites", required=True, type=Path)
    parser.add_argument("--audio-report", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--player-source", default="level4")
    args = parser.parse_args()

    sprite_manifest = json.loads(args.sprites.read_text())
    sprite_paths: dict[str, str] = {}
    for record in sprite_manifest["sprites"] + sprite_manifest["textures"]:
        sprite_paths.setdefault(record["name"], record["path"])
    sprite_meta = {
        record["name"]: {
            "path": sprite_paths[record["name"]],
            "border": record.get("border"),
            "width": record["width"],
            "height": record["height"],
        }
        for record in sprite_manifest["sprites"]
    }

    screens = {}
    lessons = []
    for path in sorted(args.scenes.glob("level*.json")):
        model = json.loads(path.read_text())
        screen = build_screen(model, sprite_paths)
        screens[model["file"]] = screen
        if model["slug"].startswith("volume-"):
            tracks = []
            for node in model["nodes"]:
                for component in node["components"]:
                    if component.get("type") == "AudioSource":
                        tracks.append(
                            {
                                "object": node["path"],
                                "stem": node["path"].split("/")[-1].lower(),
                                "clip": component["clip"],
                                "volume": component["volume"],
                                "loop": component["loop"],
                                "play_on_awake": component["play_on_awake"],
                            }
                        )
            slider_targets = {}
            for entry in model["wiring"]:
                if entry["element_kind"] != "Slider":
                    continue
                for call in entry["calls"]:
                    if call["method"] == "SetVolume" and call.get("game_object"):
                        slider_targets[call["game_object"]] = call.get("resolved_script")
            lessons.append(
                {
                    "scene_stem": Path(model["scene"]).stem,
                    "slug": model["slug"],
                    "volume": model["volume"],
                    "number": model["number"],
                    "title": model["title"],
                    "scene": model["scene"],
                    "level": model["file"],
                    "tracks": tracks,
                    "slider_targets": slider_targets,
                    "hooks": model["wiring"],
                }
            )

    audio_report = json.loads(args.audio_report.read_text())
    audio_by_lesson: dict[str, list[dict]] = {}
    for record in audio_report["records"]:
        audio_by_lesson.setdefault(record["slug"], []).append(
            {
                "stem": record["stem"],
                "path": record["path"],
                "clip_name": record["clip_name"],
                "seconds": round(record["duration_seconds"], 3),
                "bytes": record["ogg_bytes"],
                "sha256": record["sha256"],
            }
        )
    for lesson in lessons:
        lesson["audio"] = sorted(audio_by_lesson.get(lesson["slug"], []), key=lambda r: r["stem"])
        lesson["stems_expected"] = sorted(node["stem"] for node in lesson["tracks"])
        lesson["has_voice"] = any(node["clip"] and node["stem"] == "vox" for node in lesson["tracks"])
        lesson["tracks"] = sorted(lesson["tracks"], key=lambda node: node["stem"])

    credits = {
        "site": "http://www.batangoma.it/didattica/",
        "facebook": "https://www.facebook.com/BataNgoma/",
        "instagram": "https://www.instagram.com/paolobatablanco/",
        "youtube": "http://www.youtube.com/user/paoloBata",
        "itunes": "https://itunes.apple.com/it/artist/bata-ngoma/id1046842710",
        "note": "Content, recordings and scores belong to Paolo Batà Bianconcini.",
    }

    scene_stem_to_slug = {lesson["scene_stem"]: lesson["slug"] for lesson in lessons}
    for screen in screens.values():
        for drawable in screen["drawables"]:
            for hook in drawable.get("hooks", []) or []:
                argument = hook.get("string_argument")
                if argument:
                    hook["target_lesson"] = scene_stem_to_slug.get(argument)

    payload = {
        "generated_by": "tools/build_app_data.py",
        "scene_stem_to_slug": scene_stem_to_slug,
        "reference_resolution": screens[args.player_source]["reference_resolution"] if args.player_source in screens else [1920, 1080],
        "sprites": sprite_paths,
        "sprite_meta": sprite_meta,
        "screens": {
            "opening": screens.get("level0"),
            "volumeSelector": screens.get("level1"),
            "toqueIndex": screens.get("level2"),
            "oruSecoIndex": screens.get("level41"),
        },
        "player": screens.get(args.player_source),
        "lessons": sorted(lessons, key=lambda l: (l["volume"], str(l["number"]))),
        "credits": credits,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        "// Generated by tools/build_app_data.py - do not edit by hand.\n"
        "window.BATAPP = " + json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + ";\n"
    )
    unresolved = {name: s["unresolved_sprites"] for name, s in screens.items() if s["unresolved_sprites"]}
    print(f"wrote {args.out} ({args.out.stat().st_size/1e6:.2f} MB)")
    print(f"screens={len(screens)} lessons={len(lessons)} sprites={len(sprite_paths)}")
    print("lessons with audio:", sum(1 for l in lessons if l["audio"]))
    if unresolved:
        print("unresolved sprite references:")
        for name, items in unresolved.items():
            print(f"   {name}: {items[:3]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
