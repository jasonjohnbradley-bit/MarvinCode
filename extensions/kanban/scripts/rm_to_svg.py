#!/usr/bin/env python3
"""Convert reMarkable .rm v6 files to SVG.

Usage: python3 rm_to_svg.py < input.rm > output.svg
       python3 rm_to_svg.py /path/to/file.rm > output.svg

Fidelity notes:
- v6 x coordinates are centred on the page midline, so everything is shifted
  by +WIDTH/2 and the viewBox grows to the real ink bounds (never clipping).
- Strokes use the device-computed per-point width (point.width / 4 at the
  1404px page scale), rendered as runs of constant-width path segments.
- Tombstoned (deleted) items and eraser strokes are skipped.
- Typed text (RootTextBlock) is rendered as SVG text.
"""
import sys
import warnings
from io import BytesIO
from xml.sax.saxutils import escape

from rmscene import read_blocks, SceneLineItemBlock
from rmscene.scene_stream import RootTextBlock, SceneTombstoneItemBlock
from rmscene.scene_items import Pen, PenColor

WIDTH = 1404
HEIGHT = 1872
X_SHIFT = WIDTH / 2  # v6 stroke x coordinates are centred on the page midline
MIN_STROKE_WIDTH = 0.7
TEXT_FONT_SIZE = 34
TEXT_LINE_HEIGHT = 48

COLORS = {
    PenColor.BLACK.value: "#000000",
    PenColor.GRAY.value: "#767676",
    PenColor.WHITE.value: "#ffffff",
    PenColor.YELLOW.value: "#ffe949",
    PenColor.GREEN.value: "#2fbb4f",
    PenColor.PINK.value: "#ff41c1",
    PenColor.BLUE.value: "#0062cc",
    PenColor.RED.value: "#d82727",
    PenColor.GRAY_OVERLAP.value: "#767676",
    PenColor.HIGHLIGHT.value: "#fbd75b",
    PenColor.GREEN_2.value: "#17b26e",
    PenColor.CYAN.value: "#00b8d4",
    PenColor.MAGENTA.value: "#cb32db",
    PenColor.YELLOW_2.value: "#ffd837",
}

HIGHLIGHTER_TOOLS = {Pen.HIGHLIGHTER_1.value, Pen.HIGHLIGHTER_2.value}
SKIP_TOOLS = {Pen.ERASER.value, Pen.ERASER_AREA.value}
PENCIL_TOOLS = {Pen.PENCIL_1.value, Pen.PENCIL_2.value}
MECH_PENCIL_TOOLS = {Pen.MECHANICAL_PENCIL_1.value, Pen.MECHANICAL_PENCIL_2.value}
SHADER_TOOL = getattr(Pen, "SHADER", None)
HIGHLIGHT_COLORS = {PenColor.YELLOW.value, PenColor.GREEN.value, PenColor.PINK.value,
                    PenColor.HIGHLIGHT.value, PenColor.YELLOW_2.value}


def enum_value(value):
    return value.value if hasattr(value, "value") else value


def line_style(line):
    """(css color, opacity, linecap) for a stroke, honouring pen and color."""
    tool = enum_value(line.tool)
    color_val = enum_value(line.color)

    rgba = getattr(line, "color_rgba", None)
    if rgba:
        color = "#%02x%02x%02x" % ((rgba >> 16) & 0xFF, (rgba >> 8) & 0xFF, rgba & 0xFF)
    else:
        color = COLORS.get(color_val, "#000000")

    if tool in HIGHLIGHTER_TOOLS:
        return color, 0.4, "butt"
    if tool in PENCIL_TOOLS:
        return color, 0.75, "round"
    if tool in MECH_PENCIL_TOOLS:
        return color, 0.85, "round"
    if SHADER_TOOL is not None and tool == SHADER_TOOL.value:
        return color, 0.25, "round"
    if color_val in HIGHLIGHT_COLORS:
        return color, 0.55, "round"
    return color, 1.0, "round"


def point_width(point, line):
    """Stroke width in page px: the device precomputes it per point (x4)."""
    stored = getattr(point, "width", 0) or 0
    if stored > 0:
        return max(stored / 4.0, MIN_STROKE_WIDTH)
    return max(line.thickness_scale * 2.0, MIN_STROKE_WIDTH)


def smooth_path_d(coords):
    """SVG path data through the given (x, y) points as a Catmull-Rom spline
    expressed in cubic Beziers. Rounder and more natural than a raw polyline,
    which makes handwriting far more legible once rasterised."""
    n = len(coords)
    if n < 2:
        return ""
    if n == 2:
        (x0, y0), (x1, y1) = coords
        return f"M {x0:.1f} {y0:.1f} L {x1:.1f} {y1:.1f}"
    d = [f"M {coords[0][0]:.1f} {coords[0][1]:.1f}"]
    for i in range(n - 1):
        p0 = coords[i - 1] if i > 0 else coords[0]
        p1 = coords[i]
        p2 = coords[i + 1]
        p3 = coords[i + 2] if i + 2 < n else coords[n - 1]
        # Catmull-Rom -> Bezier control points (tension 0.5, the standard form)
        c1x = p1[0] + (p2[0] - p0[0]) / 6.0
        c1y = p1[1] + (p2[1] - p0[1]) / 6.0
        c2x = p2[0] - (p3[0] - p1[0]) / 6.0
        c2y = p2[1] - (p3[1] - p1[1]) / 6.0
        d.append(f"C {c1x:.1f} {c1y:.1f} {c2x:.1f} {c2y:.1f} {p2[0]:.1f} {p2[1]:.1f}")
    return " ".join(d)


def stroke_paths(line):
    """Render one stroke as constant-width segment runs (bucketed to 0.5px)."""
    color, opacity, cap = line_style(line)
    pts = line.points

    if len(pts) == 1:
        p = pts[0]
        r = point_width(p, line) / 2
        return [f'<circle cx="{p.x + X_SHIFT:.1f}" cy="{p.y:.1f}" r="{r:.2f}" '
                f'fill="{color}" opacity="{opacity}"/>']

    paths = []
    run = [pts[0]]
    run_bucket = round(point_width(pts[0], line) * 2) / 2

    def flush(points, bucket):
        if len(points) < 2:
            return
        d = smooth_path_d([(p.x + X_SHIFT, p.y) for p in points])
        paths.append(
            f'<path d="{d}" stroke="{color}" stroke-width="{bucket:.2f}" '
            f'fill="none" stroke-linecap="{cap}" stroke-linejoin="round" '
            f'opacity="{opacity}"/>')

    for p in pts[1:]:
        bucket = round(point_width(p, line) * 2) / 2
        if bucket != run_bucket:
            run.append(p)
            flush(run, run_bucket)
            run = [p]        # overlap at the boundary point keeps runs joined
            run_bucket = bucket
        else:
            run.append(p)
    flush(run, run_bucket)
    return paths


def text_elements(block):
    """Typed text: best-effort paragraph layout via rmscene's TextDocument."""
    value = block.value
    lines = []
    try:
        from rmscene.text import TextDocument
        doc = TextDocument.from_scene_item(value)
        for paragraph in doc.contents:
            text = "".join(getattr(span, "s", str(span)) for span in paragraph.contents)
            style = getattr(getattr(paragraph, "style", None), "value", None)
            lines.append((text, str(style or "")))
    except Exception:
        try:
            items = value.items.sequence_items()
            raw = "".join(i.value for i in items if isinstance(getattr(i, "value", None), str))
            lines = [(part, "") for part in raw.split("\n")]
        except Exception:
            return []

    x = getattr(value, "pos_x", -X_SHIFT) + X_SHIFT
    y = getattr(value, "pos_y", 0) + TEXT_FONT_SIZE
    elements = []
    for text, style in lines:
        if text.strip():
            style_upper = style.upper()
            weight = ' font-weight="bold"' if ("HEADING" in style_upper or "BOLD" in style_upper) else ""
            size = TEXT_FONT_SIZE + 10 if "HEADING" in style_upper else TEXT_FONT_SIZE
            prefix = "• " if "BULLET" in style_upper else ""
            elements.append(
                f'<text x="{x:.1f}" y="{y:.1f}" font-family="sans-serif" '
                f'font-size="{size}"{weight} fill="#000000">{escape(prefix + text)}</text>')
        y += TEXT_LINE_HEIGHT
    return elements


def rm_to_svg(data: bytes) -> str:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        blocks = list(read_blocks(BytesIO(data)))

    tombstoned = {b.item.item_id for b in blocks if isinstance(b, SceneTombstoneItemBlock)}

    elements = []
    min_x, min_y = 0.0, 0.0
    max_x, max_y = float(WIDTH), float(HEIGHT)

    for block in blocks:
        if isinstance(block, SceneLineItemBlock):
            if block.item.item_id in tombstoned:
                continue
            line = block.item.value
            if line is None or not getattr(line, "points", None):
                continue
            if enum_value(line.tool) in SKIP_TOOLS:
                continue
            for p in line.points:
                x = p.x + X_SHIFT
                min_x, max_x = min(min_x, x), max(max_x, x)
                min_y, max_y = min(min_y, p.y), max(max_y, p.y)
            elements.extend(stroke_paths(line))
        elif isinstance(block, RootTextBlock):
            elements.extend(text_elements(block))

    vx, vy = min_x - 20, min_y - 20
    vw, vh = max_x - vx + 20, max_y - vy + 20

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{vx:.0f} {vy:.0f} {vw:.0f} {vh:.0f}" '
        f'width="{vw:.0f}" height="{vh:.0f}">\n'
        f'<rect x="{vx:.0f}" y="{vy:.0f}" width="{vw:.0f}" height="{vh:.0f}" fill="white"/>\n'
        + "\n".join(elements)
        + "\n</svg>"
    )


if __name__ == "__main__":
    if len(sys.argv) > 1:
        with open(sys.argv[1], "rb") as f:
            data = f.read()
    else:
        data = sys.stdin.buffer.read()
    print(rm_to_svg(data))
