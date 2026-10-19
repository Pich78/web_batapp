#!/usr/bin/env python3
"""Search for the serialization layout that validates every sampled object.

The EL2CPP build ships no type trees, so layouts are derived by constraint
satisfaction: candidate variants of the ambiguous blocks (UnityEvent framing,
Navigation/ColorBlock/SpriteState/AnimationTriggers widths, an unexplained
4-byte field some classes carry) are parsed against real objects, and a variant
only survives if it consumes each payload *exactly* and every decoded value is
plausible. Nothing here is committed to the app; it is a derivation tool.

Usage:
    python3 tools/derive_schema.py --data .work/unity/Data --class Button --samples 40
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("unity_schema", HERE / "unity_schema.py")
us = importlib.util.module_from_spec(spec)
spec.loader.exec_module(us)


def strict(fields, parsed) -> bool:
    for name, kind in fields:
        value = parsed.get(name)
        if kind == "bool" and value not in (0, 1, True, False):
            return False
        if kind == "f32" and (value is None or not math.isfinite(value) or abs(value) > 1e7):
            return False
        if kind == "string" and (len(value) > 400 or any(ord(c) < 9 for c in value)):
            return False
        if kind == "pptr" and not (0 <= value["file_id"] <= 8 and abs(value["path_id"]) <= (1 << 40)):
            return False
        if kind == "color" and any(not (-0.01 <= c <= 1.01) for c in value):
            return False
        if kind == "vector2" and any(not math.isfinite(c) or abs(c) > 1e5 for c in value):
            return False
        if kind == "i32" and abs(value) > (1 << 31):
            return False
    return True


def score(samples: list[bytes], fields, limit: int) -> int:
    ok = 0
    for raw in samples[:limit]:
        reader = us.Reader(raw)
        try:
            parsed = us.read_struct(reader, fields)
            if reader.remaining != 0 or not strict(fields, parsed):
                return ok
            ok += 1
        except Exception:
            return ok
    return ok


# ---- variant blocks ------------------------------------------------------- #

def navigation(wrap: bool):
    return [("m_Mode", "enum")] + ([("m_WrapAround", "bool")] if wrap else []) + [
        ("m_SelectOnUp", "pptr"),
        ("m_SelectOnDown", "pptr"),
        ("m_SelectOnLeft", "pptr"),
        ("m_SelectOnRight", "pptr"),
    ]


def color_block(selected: bool):
    fields = [
        ("m_NormalColor", "color"),
        ("m_HighlightedColor", "color"),
        ("m_PressedColor", "color"),
    ]
    if selected:
        fields.append(("m_SelectedColor", "color"))
    fields += [("m_DisabledColor", "color"), ("m_ColorMultiplier", "f32"), ("m_FadeDuration", "f32")]
    return fields


def sprite_state(selected: bool):
    fields = [("m_HighlightedSprite", "pptr"), ("m_PressedSprite", "pptr")]
    if selected:
        fields.append(("m_SelectedSprite", "pptr"))
    fields.append(("m_DisabledSprite", "pptr"))
    return fields


def animation_triggers(selected: bool):
    names = ["m_NormalTrigger", "m_HighlightedTrigger", "m_PressedTrigger"]
    if selected:
        names.append("m_SelectedTrigger")
    names.append("m_DisabledTrigger")
    return [(n, "string") for n in names]


def event_layout(variant: str):
    if variant == "typename":
        return [("m_TypeName", "string"), ("m_Calls", "array:struct:PERSISTENT_CALL")]
    if variant == "plain":
        return [("m_Calls", "array:struct:PERSISTENT_CALL")]
    if variant == "plain_trailing":
        return [("m_Calls", "array:struct:PERSISTENT_CALL"), ("m_Trailing", "bool")]
    if variant == "typename_trailing":
        return [
            ("m_TypeName", "string"),
            ("m_Calls", "array:struct:PERSISTENT_CALL"),
            ("m_Trailing", "bool"),
        ]
    raise ValueError(variant)


def call_variant(mode: str):
    arguments = [("m_ObjectArgument", "pptr"), ("m_ObjectArgumentAssemblyTypeName", "string")]
    if mode == "full":
        arguments += [
            ("m_IntArgument", "i32"),
            ("m_FloatArgument", "f32"),
            ("m_StringArgument", "string"),
            ("m_BoolArgument", "bool"),
        ]
    call = [("m_Target", "pptr"), ("m_MethodName", "string"), ("m_Mode", "enum"), ("m_Arguments", "inline")]
    if mode == "trailing":
        call.append(("m_Extra", "bool"))
    return call


def build_button(gap: bool, wrap: bool, selected: bool, event_variant: str, call_mode: str):
    fields = list(us.PREAMBLE)
    if gap:
        fields.append(("m_Unknown", "i32"))
    fields += navigation(wrap)
    fields += [("m_Transition", "enum"), ("m_Colors", "inline"), ("m_SpriteState", "inline"),
               ("m_AnimationTriggers", "inline"), ("m_Interactable", "bool"), ("m_TargetGraphic", "pptr")]
    fields += [("m_OnClick", "inline")]
    return fields


class InlineResolver:
    """Resolve 'inline' kinds using the variant blocks chosen for this candidate."""

    def __init__(self, blocks, call_mode, event_variant):
        self.blocks = blocks
        self.call_mode = call_mode
        self.event_variant = event_variant

    def expand(self, fields):
        out = []
        for name, kind in fields:
            if kind != "inline":
                out.append((name, kind))
                continue
            if name in self.blocks:
                out.append((name, "struct:INLINE"))
            elif name == "m_OnClick" or name == "m_OnValueChanged" or name == "m_OnCullStateChanged":
                out.append(("m_Event", "event"))
            else:
                out.append((name, kind))
        return out


def expand_inline(fields, blocks, call_fields, event_fields):
    """Replace placeholder kinds with concrete nested field lists."""
    out = []
    for name, kind in fields:
        if kind == "inline":
            if name in blocks:
                out.append((name, "struct:" + name))
            elif name.startswith("m_On"):
                out.append((name, "struct:EVENT"))
            else:
                out.append((name, "i32"))
        else:
            out.append((name, kind))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--class", dest="class_name", required=True)
    parser.add_argument("--samples", type=int, default=30)
    args = parser.parse_args()

    samples = collections.defaultdict(list)
    for _file, _pid, class_name, raw in us.iter_monobehaviours(args.data):
        if len(samples[class_name]) < args.samples:
            samples[class_name].append(raw)
    target = samples[args.class_name]
    print(f"{args.class_name}: {len(target)} samples (sizes: {sorted({len(r) for r in target})})")

    # the nested-struct reader needs concrete lists, so generate a dedicated reader
    results = []
    for gap in (False, True):
        for wrap in (False, True):
            for selected in (False, True):
                blocks = {
                    "m_Navigation": navigation(wrap),
                    "m_Colors": color_block(selected),
                    "m_SpriteState": sprite_state(selected),
                    "m_AnimationTriggers": animation_triggers(selected),
                    "m_Arguments": [("m_ObjectArgument", "pptr"), ("m_ObjectArgumentAssemblyTypeName", "string"),
                                    ("m_IntArgument", "i32"), ("m_FloatArgument", "f32"),
                                    ("m_StringArgument", "string"), ("m_BoolArgument", "bool")],
                }
                for event_variant in ("typename", "plain", "plain_trailing", "typename_trailing"):
                    blocks["EVENT"] = event_layout(event_variant)
                    fields = expand_inline(build_button(gap, wrap, selected, event_variant, "full"), blocks, None, None)
                    # resolve nested kinds via STRUCTS override
                    saved = dict(us.STRUCTS)
                    us.STRUCTS.update(blocks)
                    try:
                        ok = score(target, fields, args.samples)
                    finally:
                        us.STRUCTS.clear()
                        us.STRUCTS.update(saved)
                    if ok:
                        results.append(
                            {
                                "score": ok,
                                "gap_after_preamble": gap,
                                "navigation_wrap": wrap,
                                "selected_fields": selected,
                                "event": event_variant,
                                "fields": [f"{n}:{k}" for n, k in fields],
                            }
                        )
    results.sort(key=lambda r: -r["score"])
    print(f"{len(results)} validating variants")
    for entry in results[:6]:
        print(json.dumps({k: v for k, v in entry.items() if k != "fields"}, indent=1))
    if results:
        best = results[0]
        print("best fields:", ", ".join(best["fields"]))
    (Path(".work/analysis") / f"schema_search_{args.class_name}.json").write_text(json.dumps(results, indent=1) + "\n")
    return 0 if results else 1


if __name__ == "__main__":
    raise SystemExit(main())
