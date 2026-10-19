#!/usr/bin/env python3
"""Deserialize MonoBehaviour payloads of an IL2CPP Unity build.

IL2CPP player builds ship no type trees for scripts, so engine classes decode but
uGUI and gameplay components do not. Unity's serializer is deterministic: fields
appear base-class first, in declaration order, and each type has a fixed wire
format. This module holds the wire schemas for the classes this project needs,
plus a reader, plus a validation mode that proves a schema by consuming each
object's payload *exactly* (any wrong field, order or padding shows up as a
length mismatch).

Usage:
    python3 tools/unity_schema.py --data .work/unity/Data --validate Image,Text,Button,Slider
"""

from __future__ import annotations

import argparse
import collections
import ntpath
import struct
from pathlib import Path
from typing import Any

import UnityPy

# --------------------------------------------------------------------------- #
# wire reader
# --------------------------------------------------------------------------- #


class Reader:
    """Little-endian Unity serialized-file reader with Unity's alignment rules."""

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    @property
    def remaining(self) -> int:
        return len(self.data) - self.pos

    def align(self, size: int = 4) -> None:
        self.pos = (self.pos + size - 1) // size * size

    def raw(self, size: int) -> bytes:
        end = self.pos + size
        if end > len(self.data):
            raise ValueError(f"read past end: want {size} bytes at {self.pos}, have {self.remaining}")
        chunk = self.data[self.pos : end]
        self.pos = end
        return chunk

    def i8(self) -> int:
        value = struct.unpack_from("<b", self.raw(1))[0]
        return value

    def u8(self) -> int:
        return struct.unpack_from("<B", self.raw(1))[0]

    def boolean(self) -> bool:
        return bool(self.u8())

    def i16(self) -> int:
        return struct.unpack_from("<h", self.raw(2))[0]

    def i32(self) -> int:
        return struct.unpack_from("<i", self.raw(4))[0]

    def u32(self) -> int:
        return struct.unpack_from("<I", self.raw(4))[0]

    def i64(self) -> int:
        return struct.unpack_from("<q", self.raw(8))[0]

    def f32(self) -> float:
        return struct.unpack_from("<f", self.raw(4))[0]

    def string(self) -> str:
        length = self.i32()
        if length < 0:
            raise ValueError(f"negative string length {length} at {self.pos}")
        text = self.raw(length).decode("utf-8", "replace")
        self.align()
        return text

    def pptr(self) -> dict:
        return {"file_id": self.i32(), "path_id": self.i64()}

    def color(self) -> list[float]:
        return [round(self.f32(), 6) for _ in range(4)]

    def color32(self) -> list[int]:
        return list(self.raw(4))

    def vector(self, count: int) -> list[float]:
        return [round(self.f32(), 6) for _ in range(count)]


# --------------------------------------------------------------------------- #
# schemas: ordered serialized fields, base class first
# kinds: bool i8 u8 i16 i32 u32 i64 f32 string pptr color color32
#        vector2 vector3 vector4 rect rectoffset layerMask enum
#        struct:<name>  event  array:<kind>
# --------------------------------------------------------------------------- #

NAVIGATION = [
    ("m_Mode", "enum"),
    ("m_WrapAround", "bool"),
    ("m_SelectOnUp", "pptr"),
    ("m_SelectOnDown", "pptr"),
    ("m_SelectOnLeft", "pptr"),
    ("m_SelectOnRight", "pptr"),
]

ANIMATION_TRIGGERS = [
    ("m_NormalTrigger", "string"),
    ("m_HighlightedTrigger", "string"),
    ("m_PressedTrigger", "string"),
    ("m_SelectedTrigger", "string"),
    ("m_DisabledTrigger", "string"),
]

COLOR_BLOCK = [
    ("m_NormalColor", "color"),
    ("m_HighlightedColor", "color"),
    ("m_PressedColor", "color"),
    ("m_SelectedColor", "color"),
    ("m_DisabledColor", "color"),
    ("m_ColorMultiplier", "f32"),
    ("m_FadeDuration", "f32"),
]

SPRITE_STATE = [
    ("m_HighlightedSprite", "pptr"),
    ("m_PressedSprite", "pptr"),
    ("m_SelectedSprite", "pptr"),
    ("m_DisabledSprite", "pptr"),
]

FONT_DATA = [
    ("m_Font", "pptr"),
    ("m_FontSize", "i32"),
    ("m_FontStyle", "enum"),
    ("m_BestFit", "bool"),
    ("m_MinSize", "i32"),
    ("m_MaxSize", "i32"),
    ("m_Alignment", "enum"),
    ("m_AlignByGeometry", "bool"),
    ("m_RichText", "bool"),
    ("m_HorizontalOverflow", "enum"),
    ("m_VerticalOverflow", "enum"),
    ("m_LineSpacing", "f32"),
]

PERSISTENT_CALL = [
    ("m_Target", "pptr"),
    ("m_MethodName", "string"),
    ("m_Mode", "enum"),
    ("m_Arguments", "struct:ARGUMENTS"),
    ("m_CallState", "enum"),
]

KEYFRAME = [
    ("time", "f32"),
    ("value", "f32"),
    ("inSlope", "f32"),
    ("outSlope", "f32"),
    ("weightedMode", "enum"),
    ("inWeight", "f32"),
    ("outWeight", "f32"),
]

ANIMATION_CURVE = [
    ("m_Curve", "array:struct:KEYFRAME"),
    ("m_PreInfinity", "enum"),
    ("m_PostInfinity", "enum"),
    ("m_RotationOrder", "enum"),
]

ARGUMENTS = [
    ("m_ObjectArgument", "pptr"),
    ("m_ObjectArgumentAssemblyTypeName", "string"),
    ("m_IntArgument", "i32"),
    ("m_FloatArgument", "f32"),
    ("m_StringArgument", "string"),
    ("m_BoolArgument", "bool"),
]

# MonoBehaviour preamble, shared by every script component
PREAMBLE = [
    ("m_GameObject", "pptr"),
    ("m_Enabled", "bool"),
    ("m_Script", "pptr"),
]

GRAPHIC = PREAMBLE + [
    ("m_Material", "pptr"),
    # Same 4-byte slot as the other uGUI classes (see SLOT_CLASSES); it sits
    # before the colour, not after m_Script. Colour must start at +44 or it
    # reads [0, r, g, b] (white becomes cyan) and still passes a length check.
    ("m_Unknown4", "i32"),
    ("m_Color", "color"),
]

MASKABLE_GRAPHIC = GRAPHIC + [
    # Consecutive bools are packed; only the next 4-byte field is aligned.
    ("m_RaycastTarget", "u8raw"),
    ("m_Maskable", "u8raw"),
    ("m_Padding", "u8raw"),
    ("m_Padding2", "u8raw"),
    ("m_OnCullStateChanged", "event"),
]

SELECTABLE = PREAMBLE + [
    ("m_Navigation", "struct:NAVIGATION"),
    ("m_Transition", "enum"),
    ("m_Colors", "struct:COLOR_BLOCK"),
    ("m_SpriteState", "struct:SPRITE_STATE"),
    ("m_AnimationTriggers", "struct:ANIMATION_TRIGGERS"),
    ("m_Interactable", "bool"),
    ("m_TargetGraphic", "pptr"),
]

SCHEMAS: dict[str, list[tuple[str, str]]] = {
    "Image": MASKABLE_GRAPHIC
    + [
        ("m_Sprite", "pptr"),
        ("m_Type", "enum"),
        ("m_PreserveAspect", "bool"),
        ("m_FillCenter", "bool"),
        ("m_FillMethod", "enum"),
        ("m_FillAmount", "f32"),
        ("m_FillClockwise", "bool"),
        ("m_FillOrigin", "i32"),
        ("m_UseSpriteMesh", "bool"),
        # 1.0 in all 3776 observed instances: the 2019 9-slice multiplier
        ("m_PixelsPerUnitMultiplier", "f32"),
    ],
    "RawImage": MASKABLE_GRAPHIC + [("m_Texture", "pptr"), ("m_UVRect", "rect")],
    "Text": MASKABLE_GRAPHIC + [("m_FontData", "struct:FONT_DATA"), ("m_Text", "string")],
    "SimpleSpectrum": PREAMBLE
    + [
        ("muteGroup", "pptr"),
        ("isEnabled", "bool"),
        ("sourceType", "enum"),
        ("audioSource", "pptr"),
        ("sampleChannel", "i32"),
        ("numSamples", "i32"),
        ("windowUsed", "enum"),
        ("useLogarithmicFrequency", "bool"),
        ("multiplyByFrequency", "bool"),
        ("highFrequencyTrim", "f32"),
        ("linearSampleStretch", "f32"),
        ("barAmount", "i32"),
        ("barYScale", "f32"),
        ("barMinYScale", "f32"),
        ("barPrefab", "pptr"),
        ("barXScale", "f32"),
        ("barXSpacing", "f32"),
        ("barCurveAngle", "f32"),
        ("barXRotation", "f32"),
        ("attackDamp", "f32"),
        ("decayDamp", "f32"),
        ("useColorGradient", "bool"),
        ("colorMin", "color"),
        ("colorMax", "color"),
        ("colorValueCurve", "struct:ANIMATION_CURVE"),
        ("colorAttackDamp", "f32"),
        ("colorDecayDamp", "f32"),
    ],
    "Shadow": PREAMBLE
    + [("m_EffectColor", "color"), ("m_EffectDistance", "vector2"), ("m_UseGraphicAlpha", "bool")],
    "Mask": PREAMBLE + [("m_ShowMaskGraphic", "bool")],
    "Button": SELECTABLE + [("m_OnClick", "event")],
    "Slider": SELECTABLE
    + [
        ("m_FillRect", "pptr"),
        ("m_HandleRect", "pptr"),
        ("m_Direction", "enum"),
        ("m_MinValue", "f32"),
        ("m_MaxValue", "f32"),
        ("m_WholeNumbers", "bool"),
        ("m_Value", "f32"),
        ("m_OnValueChanged", "event"),
    ],
    "CanvasScaler": PREAMBLE
    + [
        ("m_UiScaleMode", "enum"),
        ("m_ReferencePixelsPerUnit", "f32"),
        ("m_ScaleFactor", "f32"),
        ("m_ReferenceResolution", "vector2"),
        ("m_ScreenMatchMode", "enum"),
        ("m_MatchWidthOrHeight", "f32"),
        ("m_PhysicalUnit", "enum"),
        ("m_FallbackScreenDPI", "f32"),
        ("m_DefaultSpriteDPI", "f32"),
        ("m_DynamicPixelsPerUnit", "f32"),
    ],
    "GraphicRaycaster": PREAMBLE
    + [("m_IgnoreReversedGraphics", "bool"), ("m_BlockingObjects", "enum"), ("m_BlockingMask", "layerMask")],
    "ContentSizeFitter": PREAMBLE + [("m_HorizontalFit", "enum"), ("m_VerticalFit", "enum")],
    "LayoutGroup": PREAMBLE + [("m_Padding", "rectoffset"), ("m_ChildAlignment", "enum")],
    "GridLayoutGroup": PREAMBLE
    + [
        ("m_Padding", "rectoffset"),
        ("m_ChildAlignment", "enum"),
        ("m_StartCorner", "enum"),
        ("m_StartAxis", "enum"),
        ("m_CellSize", "vector2"),
        ("m_Spacing", "vector2"),
        ("m_Constraint", "enum"),
        ("m_ConstraintCount", "i32"),
    ],
    "ScrollRect": PREAMBLE
    + [
        ("m_Content", "pptr"),
        ("m_Horizontal", "bool"),
        ("m_Vertical", "bool"),
        ("m_MovementType", "enum"),
        ("m_Elasticity", "f32"),
        ("m_Inertia", "bool"),
        ("m_DecelerationRate", "f32"),
        ("m_ScrollSensitivity", "f32"),
        ("m_Viewport", "pptr"),
        ("m_HorizontalScrollbar", "pptr"),
        ("m_VerticalScrollbar", "pptr"),
        ("m_HorizontalScrollbarVisibility", "enum"),
        ("m_VerticalScrollbarVisibility", "enum"),
        ("m_HorizontalScrollbarSpacing", "f32"),
        ("m_VerticalScrollbarSpacing", "f32"),
        ("m_OnValueChanged", "event"),
    ],
    "EventSystem": PREAMBLE
    + [("m_FirstSelected", "pptr"), ("m_sendNavigationEvents", "bool"), ("m_DragThreshold", "i32")],
    "StandaloneInputModule": PREAMBLE
    + [
        ("m_HorizontalAxis", "string"),
        ("m_VerticalAxis", "string"),
        ("m_SubmitButton", "string"),
        ("m_CancelButton", "string"),
        ("m_InputActionsPerSecond", "f32"),
        ("m_RepeatDelay", "f32"),
        ("m_ForceModuleActive", "bool"),
    ],
}

# structs referenced by field kind
STRUCTS: dict[str, list[tuple[str, str]]] = {
    "NAVIGATION": NAVIGATION,
    "COLOR_BLOCK": COLOR_BLOCK,
    "SPRITE_STATE": SPRITE_STATE,
    "ANIMATION_TRIGGERS": ANIMATION_TRIGGERS,
    "FONT_DATA": FONT_DATA,
    "ARGUMENTS": ARGUMENTS,
    "PERSISTENT_CALL": PERSISTENT_CALL,
    "KEYFRAME": KEYFRAME,
    "ANIMATION_CURVE": ANIMATION_CURVE,
}



# Classes whose serialized payload carries one extra 4-byte field between
# m_Script and their first documented field. CanvasScaler pins the position: with
# the field the parse yields m_UiScaleMode=1, m_ReferencePixelsPerUnit=100,
# m_ReferenceResolution=(1920,1080), m_MatchWidthOrHeight=1, DPI 96/96, all
# matching the app's canvas; without it every value shifts by one field.
# The field is zero in every observed instance; its meaning is unresolved.
SLOT_CLASSES = {
    "CanvasScaler",
    "ContentSizeFitter",
    "EventSystem",
    "GraphicRaycaster",
    "GridLayoutGroup",
    "Mask",
    "SimpleSpectrum",
    "Shadow",
    "Outline",
    "StandaloneInputModule",
    "ScrollRect",
}
SLOT_FIELD = ("m_Unknown4", "i32")


def schema_for(class_name: str) -> list[tuple[str, str]]:
    fields = SCHEMAS[class_name]
    if class_name in SLOT_CLASSES:
        return fields[: len(PREAMBLE)] + [SLOT_FIELD] + fields[len(PREAMBLE):]
    return fields

def read_value(reader: Reader, kind: str) -> Any:
    if kind in ("bool", "i8", "u8", "i16"):
        # Unity pads every field to a 4-byte boundary in the serialized file
        if kind == "bool":
            value: Any = reader.boolean()
        elif kind == "i8":
            value = reader.i8()
        elif kind == "u8":
            value = reader.u8()
        else:
            value = reader.i16()
        reader.align(4)
        return value
    if kind == "u8raw":
        # A byte that is packed with its neighbour (consecutive bools).
        return reader.u8()
    if kind == "i32" or kind == "enum" or kind == "layerMask":
        return reader.i32()
    if kind == "u32":
        return reader.u32()
    if kind == "i64":
        return reader.i64()
    if kind == "f32":
        return reader.f32()
    if kind == "string":
        return reader.string()
    if kind == "pptr":
        return reader.pptr()
    if kind == "color":
        return reader.color()
    if kind == "color32":
        return reader.color32()
    if kind == "vector2":
        return reader.vector(2)
    if kind == "vector3":
        return reader.vector(3)
    if kind == "vector4":
        return reader.vector(4)
    if kind == "rect":
        return reader.vector(4)
    if kind == "rectoffset":
        return [reader.i32() for _ in range(4)]
    if kind == "event":
        return read_event(reader)
    if kind.startswith("struct:"):
        name = kind.split(":", 1)[1]
        return read_struct(reader, STRUCTS[name])
    if kind.startswith("array:"):
        element = kind.split(":", 1)[1]
        size = reader.i32()
        if size < 0 or size > 1_000_000:
            raise ValueError(f"implausible array size {size}")
        return [read_value(reader, element) for _ in range(size)]
    raise ValueError(f"unknown kind {kind}")


def read_struct(reader: Reader, fields: list[tuple[str, str]]) -> dict:
    return {name: read_value(reader, kind) for name, kind in fields}


def read_event(reader: Reader) -> dict:
    """UnityEventBase as serialized by this build: a persistent-call list only.

    Verified against a Button whose click binds ``LoadNextLevel`` with a string
    argument: the call count precedes the call list and no type name is written.
    """
    return {"m_Calls": read_struct(reader, [("m_Calls", "array:struct:PERSISTENT_CALL")])["m_Calls"]}


def read_component(class_name: str, raw: bytes) -> dict:
    schema = schema_for(class_name)
    reader = Reader(raw)
    fields = read_struct(reader, schema)
    if reader.remaining != 0:
        raise ValueError(f"{class_name}: {reader.remaining} bytes unconsumed (schema mismatch)")
    return fields


# --------------------------------------------------------------------------- #
# validation harness
# --------------------------------------------------------------------------- #


def iter_monobehaviours(data_dir: Path):
    env = UnityPy.Environment()
    env.load_folder(str(data_dir))
    scripts: dict[tuple[str, int], str] = {}
    for obj in env.objects:
        if obj.type.name == "MonoScript":
            try:
                ms = obj.read()
            except Exception:
                continue
            scripts[(getattr(obj.assets_file, "name", "?"), obj.path_id)] = ms.m_ClassName

    def file_by_name(name: str):
        for key, value in env.files.items():
            if ntpath.basename(key) == name:
                return value
        return None

    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        fid, pid = struct.unpack_from("<iq", raw, 16)
        target = obj.assets_file
        if fid != 0:
            externals = obj.assets_file.externals
            if fid - 1 >= len(externals):
                continue
            target = file_by_name(ntpath.basename(externals[fid - 1].path))
            if target is None:
                continue
        script = target.objects.get(pid)
        if script is None or script.type.name != "MonoScript":
            continue
        class_name = scripts.get((target.name, pid))
        if class_name is None:
            continue
        yield getattr(obj.assets_file, "name", "?"), obj.path_id, class_name, raw


def semantic_ok(parsed: dict) -> bool:
    """Reject shifted-but-length-coincidental parses."""
    for name, value in parsed.items():
        if isinstance(value, str):
            if len(value) > 400 or any(ord(c) < 9 for c in value):
                return False
        elif isinstance(value, dict) and "file_id" in value:
            if not (0 <= value["file_id"] <= 8) or abs(value["path_id"]) > 1 << 40:
                return False
        elif name in ("m_Color", "m_EffectColor", "colorMin", "colorMax") and isinstance(value, list):
            if any(not (-0.01 <= c <= 1.01) for c in value):
                return False
        elif isinstance(value, list) and len(value) == 4 and all(isinstance(v, float) for v in value):
            pass
    return True


def validate(data_dir: Path, wanted: list[str] | None) -> int:
    stats: dict[str, list[int]] = collections.defaultdict(lambda: [0, 0, 0])
    first_failure: dict[str, str] = {}
    for file_name, path_id, class_name, raw in iter_monobehaviours(data_dir):
        if wanted and class_name not in wanted:
            continue
        if class_name not in SCHEMAS:
            continue
        try:
            parsed = read_component(class_name, raw)
            stats[class_name][0] += 1
            if semantic_ok(parsed):
                stats[class_name][1] += 1
            else:
                stats[class_name][2] += 1
                first_failure.setdefault(class_name, f"{file_name}:{path_id} length ok but values implausible")
        except Exception as error:
            stats[class_name][2] += 1
            first_failure.setdefault(class_name, f"{file_name}:{path_id} len={len(raw)} -> {error}")

    print(f"{'class':24} {'len ok':>7} {'semantic ok':>12} {'fail':>6}  first failure")
    for class_name in sorted(stats, key=lambda c: -sum(stats[c])):
        length_ok, semantic, fail = stats[class_name]
        print(f"{class_name:24} {length_ok:>7} {semantic:>12} {fail:>6}  {first_failure.get(class_name, '')}")
    missing = [c for c in (wanted or []) if c not in stats]
    if missing:
        print("no instances found for:", ", ".join(missing))
    return 1 if any(s[2] for s in stats.values()) else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--validate", default="", help="comma-separated class names (default: all known)")
    args = parser.parse_args()
    wanted = [name.strip() for name in args.validate.split(",") if name.strip()]
    return validate(args.data, wanted or None)


if __name__ == "__main__":
    raise SystemExit(main())
