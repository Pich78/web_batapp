#!/usr/bin/env python3
"""Dump every Unity scene into a JSON model the static port can be built from.

Engine classes (GameObject, Transform/RectTransform, Canvas, CanvasRenderer,
AudioSource, Camera, Sprite, Texture2D, Animator, MonoScript) are read by
UnityPy; script components are read with the schemas in ``unity_schema``.
Pointers are resolved into readable references (game-object path, component
class, asset name) so the model can be used without Unity.

Usage:
    python3 tools/dump_scenes.py --data .work/unity/Data --scene-map .work/analysis/scene_map.json \
        --out .work/scenes [--only level2,level4]
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import ntpath
import struct
from pathlib import Path

import UnityPy

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("unity_schema", HERE / "unity_schema.py")
us = importlib.util.module_from_spec(spec)
spec.loader.exec_module(us)

def field_of(obj, *names, default=None):
    """UnityPy names generated fields inconsistently; try each candidate."""
    for name in names:
        value = getattr(obj, name, None)
        if value is not None:
            return value
    return default


def flag(obj, *names, default=False) -> bool:
    return bool(field_of(obj, *names, default=default))


def as_list(value, default=(0.0, 0.0, 0.0)) -> list[float]:
    """UnityPy returns math types or plain sequences depending on version."""
    for attr in ("x", "y", "z", "w"):
        pass
    if isinstance(value, (list, tuple)):
        return [round(float(v), 6) for v in value]
    parts = [getattr(value, name, None) for name in ("x", "y", "z", "w")]
    parts = [float(p) for p in parts if p is not None]
    if parts:
        return [round(v, 6) for v in parts]
    parts = [getattr(value, name, None) for name in ("r", "g", "b", "a")]
    parts = [float(p) for p in parts if p is not None]
    if parts:
        return [round(v, 6) for v in parts]
    return [round(float(v), 6) for v in default]


CORE_TYPES = {
    "GameObject",
    "Transform",
    "RectTransform",
    "Canvas",
    "CanvasRenderer",
    "AudioSource",
    "AudioListener",
    "Camera",
    "Animator",
    "MonoScript",
    "Sprite",
    "Texture2D",
    "AnimationClip",
}


class SceneDumper:
    def __init__(self, env: UnityPy.Environment):
        self.env = env
        self.files_by_base: dict[str, object] = {}
        for key, value in env.files.items():
            self.files_by_base[ntpath.basename(key)] = value
        self.transform_indices: dict[str, dict] = {}
        self.scripts: dict[str, str] = {}
        for name, file in self.files_by_base.items():
            for path_id, reader in getattr(file, "objects", {}).items():
                if reader.type.name != "MonoScript":
                    continue
                try:
                    ms = reader.read()
                    self.scripts[f"{name}:{path_id}"] = ms.m_ClassName
                except Exception:
                    continue

    # -- pointer helpers ---------------------------------------------------- #
    @staticmethod
    def ptr_ids(pptr) -> tuple[int, int]:
        if isinstance(pptr, dict):
            return int(pptr.get("file_id", 0)), int(pptr.get("path_id", 0))
        file_id = getattr(pptr, "m_FileID", getattr(pptr, "file_id", 0))
        path_id = getattr(pptr, "m_PathID", getattr(pptr, "path_id", 0))
        return int(file_id or 0), int(path_id or 0)

    @staticmethod
    def owner_of(reader) -> int:
        """First field of every component is m_GameObject (a PPtr)."""
        try:
            return int(struct.unpack_from("<q", reader.get_raw_data(), 4)[0])
        except Exception:
            return 0

    def resolve(self, file_name: str, pptr):
        file_id, path_id = self.ptr_ids(pptr)
        if not path_id:
            return None
        if file_id == 0:
            target_name, target = file_name, self.files_by_base.get(file_name)
        else:
            externals = getattr(self.files_by_base[file_name], "externals", [])
            if file_id - 1 >= len(externals):
                return None
            target_name = ntpath.basename(externals[file_id - 1].path)
            target = self.files_by_base.get(target_name)
        if target is None:
            return None
        reader = target.objects.get(path_id)
        if reader is None:
            return None
        return target_name, reader

    def name_of(self, file_name: str, pptr) -> str | None:
        resolved = self.resolve(file_name, pptr)
        if resolved is None:
            return None
        _target, reader = resolved
        try:
            value = reader.read()
        except Exception:
            return f"<{reader.type.name}>"
        return getattr(value, "m_Name", None) or f"<{reader.type.name}>"

    def class_of(self, file_name: str, pptr) -> str | None:
        resolved = self.resolve(file_name, pptr)
        if resolved is None:
            return None
        target_name, reader = resolved
        if reader.type.name == "MonoScript":
            return self.scripts.get(f"{target_name}:{reader.path_id}")
        return reader.type.name

    # -- per-scene dump ----------------------------------------------------- #
    def game_object_path(self, file_name: str, go_id: int) -> str:
        index = self.transform_indices.setdefault(file_name, self.build_go_parents(file_name))
        names, seen = [], set()
        current = go_id
        while current and current not in seen:
            seen.add(current)
            entry = index.get(current)
            if entry is None:
                break
            names.append(entry["name"])
            current = entry["parent_go"]
        return "/".join(reversed(names)) if names else f"<go:{go_id}>"

    def build_go_parents(self, file_name: str) -> dict[int, dict]:
        """game object id -> {name, parent_go}, resolving transform parents."""
        file = self.files_by_base[file_name]
        objects = getattr(file, "objects", {})
        go_name: dict[int, str] = {}
        transform_parent: dict[int, int] = {}   # transform path id -> parent transform path id
        go_of_transform: dict[int, int] = {}
        for path_id, reader in objects.items():
            kind = reader.type.name
            if kind == "GameObject":
                try:
                    go_name[path_id] = reader.read().m_Name
                except Exception:
                    go_name[path_id] = f"<go:{path_id}>"
            elif kind in ("Transform", "RectTransform"):
                try:
                    transform = reader.read()
                except Exception:
                    continue
                transform_parent[path_id] = int(transform.m_Father.m_PathID) if transform.m_Father else 0
                go_of_transform[path_id] = int(transform.m_GameObject.m_PathID)
        parent_go_of_transform = {
            transform_id: go_of_transform.get(parent_id, 0)
            for transform_id, parent_id in transform_parent.items()
        }
        go_parent: dict[int, int] = {}
        for transform_id, go_id in go_of_transform.items():
            go_parent[go_id] = parent_go_of_transform.get(transform_id, 0)
        return {go_id: {"name": go_name.get(go_id, f"<go:{go_id}>"), "parent_go": go_parent.get(go_id, 0)} for go_id in go_of_transform.values()}

    def describe_pptr(self, file_name: str, pptr) -> dict:
        """Resolve a pointer to class + owning game-object path."""
        file_id, path_id = self.ptr_ids(pptr)
        if not path_id:
            return {}
        target_file = file_name
        if file_id:
            externals = getattr(self.files_by_base[file_name], "externals", [])
            if file_id - 1 >= len(externals):
                return {"path_id": path_id}
            target_file = ntpath.basename(externals[file_id - 1].path)
        resolved = self.resolve(file_name, pptr)
        out = {"path_id": path_id, "file": target_file}
        if resolved is None:
            return out
        _name, reader = resolved
        if reader.type.name == "MonoScript":
            out["class"] = self.scripts.get(f"{target_file}:{reader.path_id}")
            return out
        out["class"] = reader.type.name
        if reader.type.name == "MonoBehaviour":
            raw = reader.get_raw_data()
            try:
                script_file_id, script_id = struct.unpack_from("<iq", raw, 16)
            except Exception:
                script_file_id, script_id = 0, 0
            script_file = target_file
            if script_file_id:
                externals = getattr(self.files_by_base[target_file], "externals", [])
                if script_file_id - 1 < len(externals):
                    script_file = ntpath.basename(externals[script_file_id - 1].path)
            out["script_class"] = self.scripts.get(f"{script_file}:{script_id}")
            owner = self.owner_of(reader)
            if owner:
                out["game_object"] = self.game_object_path(target_file, owner)
        return out

    def dump(self, file_name: str) -> dict:
        file = self.files_by_base[file_name]
        objects = getattr(file, "objects", {})
        go_names: dict[int, str] = {}
        go_active: dict[int, bool] = {}
        components: dict[int, list[dict]] = collections.defaultdict(list)
        transforms: dict[int, dict] = {}
        raws: dict[int, bytes] = {}

        # first pass: game objects and component membership
        for path_id, reader in objects.items():
            if reader.type.name == "GameObject":
                try:
                    go = reader.read()
                    go_names[path_id] = go.m_Name
                    go_active[path_id] = bool(getattr(go, "m_IsActive", True))
                    for component in go.m_Components:
                        components[component.m_PathID].append({"owner": path_id, "type": None})
                except Exception:
                    go_names[path_id] = f"<go:{path_id}>"

        # second pass: components
        for path_id, reader in objects.items():
            type_name = reader.type.name
            if type_name == "MonoScript" or type_name == "GameObject":
                continue
            if type_name in ("Transform", "RectTransform"):
                try:
                    transform = reader.read()
                except Exception:
                    continue
                parent_id = transform.m_Father.m_PathID if transform.m_Father else 0
                entry = {
                    "path_id": path_id,
                    "game_object": transform.m_GameObject.m_PathID,
                    "parent": parent_id,
                    "children": [c.m_PathID for c in transform.m_Children],
                    "local_position": as_list(transform.m_LocalPosition),
                    "local_scale": as_list(transform.m_LocalScale, (1.0, 1.0, 1.0)),
                    "local_rotation": as_list(transform.m_LocalRotation, (0.0, 0.0, 0.0, 1.0)),
                    "type": type_name,
                }
                if type_name == "RectTransform":
                    entry.update(
                        {
                            "anchor_min": as_list(transform.m_AnchorMin),
                            "anchor_max": as_list(transform.m_AnchorMax, (1.0, 1.0, 0.0)),
                            "anchored_position": as_list(transform.m_AnchoredPosition),
                            "size_delta": as_list(transform.m_SizeDelta),
                            "pivot": as_list(transform.m_Pivot, (0.5, 0.5, 0.0)),
                        }
                    )
                transforms[path_id] = entry
                for bucket in components[path_id]:
                    bucket["type"] = type_name
                continue

            if type_name == "AudioSource":
                try:
                    source = reader.read()
                except Exception:
                    continue
                components[path_id].append(
                    {
                        "owner": self.owner_of(reader),
                        "type": "AudioSource",
                        "clip": (lambda clip: self.name_of(file_name, clip) if clip is not None else None)(field_of(source, "m_audioClip", "m_AudioClip")),
                        "volume": round(field_of(source, "m_Volume", default=1.0), 4),
                        "loop": flag(source, "Loop", "m_Loop"),
                        "play_on_awake": flag(source, "m_PlayOnAwake", "PlayOnAwake"),
                        "mute": flag(source, "Mute", "m_Mute"),
                        "pitch": round(field_of(source, "m_Pitch", default=1.0), 4),
                        "spatial_blend": round(field_of(source, "SpatialBlend", "m_SpatialBlend", default=0.0), 4),
                        "mixer_group": (lambda group: self.name_of(file_name, group) if group is not None else None)(field_of(source, "OutputAudioMixerGroup", "m_OutputAudioMixerGroup")),
                    }
                )
                continue

            if type_name == "Camera":
                try:
                    camera = reader.read()
                except Exception:
                    continue
                background = getattr(camera, "m_BackGroundColor", None)
                if background is None:
                    background = getattr(camera, "background_color", None)
                components[path_id].append(
                    {
                        "owner": self.owner_of(reader),
                        "type": "Camera",
                        "orthographic": bool(getattr(camera, "orthographic", False)),
                        "orthographic_size": round(getattr(camera, "orthographic_size", getattr(camera, "m_OrthographicSize", 0.0)), 4),
                        "background": as_list(background) if background is not None else None,
                        "rect": as_list(getattr(camera, "rect", None)) if getattr(camera, "rect", None) is not None else None,
                    }
                )
                continue

            if type_name == "Canvas":
                try:
                    canvas = reader.read()
                except Exception:
                    continue
                components[path_id].append(
                    {
                        "owner": self.owner_of(reader),
                        "type": "Canvas",
                        "render_mode": int(getattr(canvas, "m_RenderMode", -1)),
                        "sorting_order": int(getattr(canvas, "m_SortingOrder", 0)),
                        "override_sorting": bool(getattr(canvas, "m_OverrideSorting", False)),
                        "pixel_perfect": bool(getattr(canvas, "m_PixelPerfect", False)),
                        "target_display": int(getattr(canvas, "m_TargetDisplay", 0)),
                    }
                )
                continue

            if type_name == "MonoBehaviour":
                raw = reader.get_raw_data()
                raws[path_id] = raw
                file_id, script_id = struct.unpack_from("<iq", raw, 16)
                externals = getattr(file, "externals", [])
                script_file = file_name
                if file_id:
                    if file_id - 1 >= len(externals):
                        continue
                    script_file = ntpath.basename(externals[file_id - 1].path)
                class_name = self.scripts.get(f"{script_file}:{script_id}")
                entry: dict = {"type": class_name or f"MonoBehaviour:{script_id}", "path_id": path_id}
                if class_name in us.SCHEMAS:
                    try:
                        parsed = us.read_component(class_name, raw)
                        entry["fields"] = self.decode_fields(file_name, class_name, parsed)
                    except Exception as error:
                        entry["fields_error"] = str(error)
                try:
                    owner = struct.unpack_from("<q", raw, 4)[0]
                    entry["owner"] = owner
                except Exception:
                    pass
                components[path_id].append(entry)
                continue

            if type_name in CORE_TYPES:
                if type_name in ("Transform", "RectTransform"):
                    continue
                components[path_id].append({"owner": self.owner_of(reader), "type": type_name})

        # assemble nodes: only game objects that own a transform
        by_go: dict[int, dict] = {}
        for path_id, transform in transforms.items():
            go_id = transform["game_object"]
            by_go.setdefault(
                go_id,
                {
                    "game_object": go_id,
                    "name": go_names.get(go_id, f"<go:{go_id}>"),
                    "path": self.game_object_path(file_name, go_id),
                    "active": go_active.get(go_id, True),
                    "transform": transform,
                    "components": [],
                },
            )
        for path_id, entries in components.items():
            for entry in entries:
                go_id = entry.get("owner")
                if go_id is None:
                    continue
                node = by_go.get(go_id)
                if node is None:
                    continue
                node["components"].append({k: v for k, v in entry.items() if k != "owner"})

        wiring = []
        for node in by_go.values():
            for component in node["components"]:
                if component.get("type") not in ("Button", "Slider"):
                    continue
                fields = component.get("fields") or {}
                for field_name, calls in fields.items():
                    if not isinstance(calls, list) or not calls:
                        continue
                    if not isinstance(calls[0], dict) or "method" not in calls[0]:
                        continue
                    wiring.append(
                        {
                            "element": node["name"],
                            "element_path": node["path"],
                            "element_kind": component["type"],
                            "field": field_name,
                            "calls": [
                                self.describe_call(file_name, call)
                                for call in calls
                            ],
                        }
                    )
        return {
            "file": file_name,
            "wiring": wiring,
            "nodes": list(by_go.values()),
            "audio_clips": sorted(
                {
                    component["clip"]
                    for node in by_go.values()
                    for component in node["components"]
                    if component.get("type") == "AudioSource" and component.get("clip")
                }
            ),
        }

    def describe_call(self, file_name: str, call: dict) -> dict:
        resolved = self.describe_pptr(
            file_name,
            {"file_id": call.get("target_file_id", 0), "path_id": call.get("target_path_id", 0)},
        )
        return {
            "method": call["method"],
            **resolved,
            "resolved_class": resolved.get("script_class") or call["target_class"],
            "target_name": call["target"],
            "string_argument": call["string_argument"],
            "float_argument": call["float_argument"],
        }

    def decode_fields(self, file_name: str, class_name: str, parsed: dict) -> dict:
        """Turn raw field values into readable references."""
        out: dict = {}
        for name, value in parsed.items():
            if isinstance(value, dict) and "file_id" in value:
                out[name] = {
                    "class": self.class_of(file_name, value),
                    "name": self.name_of(file_name, value),
                    "path_id": value["path_id"],
                }
            elif isinstance(value, dict) and "m_Calls" in value:  # UnityEvent
                out[name] = [
                    {
                        "target_class": self.class_of(file_name, call["m_Target"]),
                        "target": self.name_of(file_name, call["m_Target"]),
                        "target_file_id": int(call["m_Target"]["file_id"]),
                        "target_path_id": int(call["m_Target"]["path_id"]),
                        "method": call["m_MethodName"],
                        "mode": call["m_Mode"],
                        "call_state": call["m_CallState"],
                        "string_argument": call["m_Arguments"]["m_StringArgument"],
                        "int_argument": call["m_Arguments"]["m_IntArgument"],
                        "float_argument": round(call["m_Arguments"]["m_FloatArgument"], 4),
                        "bool_argument": bool(call["m_Arguments"]["m_BoolArgument"]),
                        "object_argument": call["m_Arguments"]["m_ObjectArgumentAssemblyTypeName"],
                    }
                    for call in value["m_Calls"]
                ]
            elif isinstance(value, list) and value and isinstance(value[0], dict) and "m_MethodName" in value[0]:
                out[name] = [
                    {
                        "target_class": self.class_of(file_name, call["m_Target"]),
                        "target": self.name_of(file_name, call["m_Target"]),
                        "target_file_id": int(call["m_Target"]["file_id"]),
                        "target_path_id": int(call["m_Target"]["path_id"]),
                        "method": call["m_MethodName"],
                        "mode": call["m_Mode"],
                        "call_state": call["m_CallState"],
                        "string_argument": call["m_Arguments"]["m_StringArgument"],
                        "int_argument": call["m_Arguments"]["m_IntArgument"],
                        "float_argument": round(call["m_Arguments"]["m_FloatArgument"], 4),
                        "bool_argument": bool(call["m_Arguments"]["m_BoolArgument"]),
                        "object_argument": call["m_Arguments"]["m_ObjectArgumentAssemblyTypeName"],
                    }
                    for call in value
                ]
            else:
                out[name] = value
        return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--scene-map", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    scene_map = json.loads(args.scene_map.read_text())
    wanted = {name.strip() for name in args.only.split(",") if name.strip()}
    args.out.mkdir(parents=True, exist_ok=True)

    env = UnityPy.Environment()
    env.load_folder(str(args.data))
    dumper = SceneDumper(env)

    summary = []
    for entry in scene_map["entries"]:
        file_name = entry["level"] + ""
        if wanted and file_name not in wanted:
            continue
        if file_name not in dumper.files_by_base:
            print(f"missing file for {entry['scene']}: {file_name}")
            continue
        model = dumper.dump(file_name)
        model.update({k: entry[k] for k in ("scene", "volume", "number", "title", "slug", "assets")})
        (args.out / f"{file_name}.json").write_text(json.dumps(model, indent=1, sort_keys=False) + "\n")
        texts = [
            component
            for node in model["nodes"]
            for component in node["components"]
            if component.get("type") == "Text" and component.get("fields", {}).get("m_Text")
        ]
        buttons = [c for node in model["nodes"] for c in node["components"] if c.get("type") == "Button"]
        sliders = [c for node in model["nodes"] for c in node["components"] if c.get("type") == "Slider"]
        summary.append(
            {
                "level": file_name,
                "scene": entry["scene"],
                "slug": entry["slug"],
                "nodes": len(model["nodes"]),
                "texts": len(texts),
                "buttons": len(buttons),
                "sliders": len(sliders),
                "audio_sources": sum(1 for n in model["nodes"] for c in n["components"] if c.get("type") == "AudioSource"),
                "clips": model["audio_clips"],
            }
        )
        print(
            f"{file_name:>8} {entry['slug']:<34} nodes={len(model['nodes']):>5} texts={len(texts):>3} "
            f"buttons={len(buttons):>3} sliders={len(sliders)} sources={summary[-1]['audio_sources']}"
        )
    (args.out / "_summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
