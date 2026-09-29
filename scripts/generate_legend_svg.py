#!/usr/bin/env python3
"""Rebuild docs/legend.svg from table cell colors in styles.css.

Run from repo root:
  python3 scripts/generate_legend_svg.py

Do not hand-edit docs/legend.svg. Labels (thresholds) live here; colors come from CSS.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS_PATH = ROOT / "styles.css"
OUT_PATH = ROOT / "docs" / "legend.svg"

# .table-container td.foo { background: #abc; color: white; }
RULE_RE = re.compile(
    r"\.table-container\s+td\.([a-z0-9-]+)\s*\{([^}]*)\}",
    re.IGNORECASE,
)
PROP_RE = re.compile(r"(background(?:-color)?|color)\s*:\s*([^;]+);", re.IGNORECASE)


def parse_table_colors(css: str) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for m in RULE_RE.finditer(css):
        name = m.group(1)
        body = m.group(2)
        props: dict[str, str] = {}
        for pm in PROP_RE.finditer(body):
            key = pm.group(1).lower()
            val = pm.group(2).strip()
            if key.startswith("background"):
                props["bg"] = val
            elif key == "color":
                props["fg"] = val
        if props:
            out[name] = props
    return out


def norm_fg(fg: str | None) -> str:
    if not fg:
        return "#333333"
    fg = fg.strip().lower()
    if fg == "white":
        return "#ffffff"
    return fg


def cell_from_class(colors: dict[str, dict[str, str]], cls: str, label: str) -> dict:
    props = colors.get(cls)
    if not props:
        raise KeyError(f"missing CSS class .table-container td.{cls}")
    return {
        "label": label,
        "bg": props.get("bg", "#ffffff"),
        "fg": norm_fg(props.get("fg")),
    }


def rows(colors: dict[str, dict[str, str]]) -> list[dict]:
    c = lambda cls, label: cell_from_class(colors, cls, label)
    return [
        {
            "title": "雲量（％）",
            "cells": [
                {"label": "20未満", "bg": "#ffffff", "fg": "#333333"},
                c("cloud-1", "20"),
                c("cloud-2", "40"),
                c("cloud-3", "60"),
                c("cloud-4", "80"),
                c("cloud-5", "100"),
            ],
        },
        {
            "title": "降水量（mm/h）",
            "cells": [
                c("rain-1", "0.1"),
                c("rain-2", "1"),
                c("rain-3", "5"),
                c("rain-4", "10"),
                c("rain-5", "20"),
                c("rain-6", "30"),
                c("rain-7", "50"),
                c("rain-8", "80"),
            ],
        },
        {
            "title": "風（m/s）",
            "cells": [
                c("wind-1", "5"),
                c("wind-2", "10"),
                c("wind-3", "15"),
                c("wind-4", "20"),
                c("wind-5", "25"),
            ],
        },
        {
            "title": "湿度（％）",
            "cells": [
                c("humid-dry", "30以下"),
                c("humid-1", "80"),
                c("humid-2", "90"),
                c("humid-3", "100"),
            ],
        },
        {
            "title": "気温（℃・文字色）",
            "cells": [
                {"label": "-5未満", "bg": "#ffffff", "fg": colors["temp-cold3"]["fg"]},
                {"label": "0未満", "bg": "#ffffff", "fg": colors["temp-cold2"]["fg"]},
                {"label": "5未満", "bg": "#ffffff", "fg": colors["temp-cold1"]["fg"]},
                {"label": "5〜25", "bg": "#ffffff", "fg": "#333333"},
                {"label": "25以上", "bg": "#ffffff", "fg": colors["temp-hot1"]["fg"]},
                {"label": "30以上", "bg": "#ffffff", "fg": colors["temp-hot2"]["fg"]},
                {"label": "35以上", "bg": "#ffffff", "fg": colors["temp-hot3"]["fg"]},
            ],
        },
        {
            "title": "気圧 低下",
            "cells": [
                c("press-fall-1", "弱"),
                c("press-fall-2", "中"),
                c("press-fall-3", "強"),
            ],
        },
        {
            "title": "気圧 上昇",
            "cells": [c("press-rise", "上昇")],
        },
        {
            "title": "潮位 満寄り",
            "cells": [
                c("tide-high-1", "1"),
                c("tide-high-2", "2"),
                c("tide-high-3", "3"),
                c("tide-high-4", "4"),
                c("tide-high-5", "5"),
            ],
        },
        {
            "title": "潮位 干寄り",
            "cells": [
                c("tide-low-1", "1"),
                c("tide-low-2", "2"),
                c("tide-low-3", "3"),
                c("tide-low-4", "4"),
                c("tide-low-5", "5"),
            ],
        },
        {
            "title": "過ぎた時間",
            "cells": [{"label": "過去", "bg": "#ffffff", "fg": "#cccccc"}],
        },
    ]


def esc(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def build_svg(row_data: list[dict]) -> str:
    label_w = 150
    cell_w = 64
    cell_h = 30
    pad_x = 12
    pad_y = 12
    gap = 4
    row_h = cell_h + gap
    max_cells = max(len(r["cells"]) for r in row_data)
    width = pad_x + label_w + max_cells * cell_w + pad_x
    height = pad_y + len(row_data) * row_h + pad_y - gap

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="sans-serif">',
        f'<!-- Generated by scripts/generate_legend_svg.py — do not edit by hand -->',
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
    ]

    for ri, row in enumerate(row_data):
        y = pad_y + ri * row_h
        ty = y + 19
        parts.append(
            f'<text x="{pad_x}" y="{ty}" font-size="12" fill="#333">{esc(row["title"])}</text>'
        )
        for ci, cell in enumerate(row["cells"]):
            x = pad_x + label_w + ci * cell_w
            bg = cell["bg"]
            fg = cell["fg"]
            parts.append(
                f'<rect x="{x}" y="{y}" width="{cell_w}" height="{cell_h}" '
                f'fill="{esc(bg)}" stroke="#ccc"/>'
            )
            parts.append(
                f'<text x="{x + cell_w / 2}" y="{ty}" font-size="12" fill="{esc(fg)}" '
                f'text-anchor="middle">{esc(cell["label"])}</text>'
            )

    parts.append("</svg>\n")
    return "\n".join(parts)


def main() -> int:
    css = CSS_PATH.read_text(encoding="utf-8")
    colors = parse_table_colors(css)
    required = [
        "cloud-1", "cloud-5", "rain-1", "rain-8", "wind-1", "wind-5",
        "humid-dry", "humid-3", "temp-cold3", "temp-hot3",
        "press-fall-1", "press-fall-3", "press-rise",
        "tide-high-1", "tide-high-5", "tide-low-1", "tide-low-5",
    ]
    missing = [k for k in required if k not in colors]
    if missing:
        print(f"missing CSS classes: {', '.join(missing)}", file=sys.stderr)
        return 1

    svg = build_svg(rows(colors))
    OUT_PATH.write_text(svg, encoding="utf-8")
    print(f"wrote {OUT_PATH.relative_to(ROOT)} ({len(svg)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
