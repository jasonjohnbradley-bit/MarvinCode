#!/usr/bin/env python3
"""Convert reMarkable .rm v6 files to SVG.

Usage: python3 rm_to_svg.py < input.rm > output.svg
       python3 rm_to_svg.py /path/to/file.rm > output.svg
"""
import sys
import warnings
from io import BytesIO
from rmscene import read_blocks, SceneLineItemBlock

WIDTH = 1404
HEIGHT = 1872

COLORS = {
    0: "#000000",   # black
    1: "#808080",   # grey
    2: "#ffffff",   # white
    3: "#ffd700",   # yellow highlight
    4: "#00ff00",   # green highlight
    5: "#ff69b4",   # pink highlight
    6: "#0000ff",   # blue
    7: "#ff0000",   # red
}


def rm_to_svg(data: bytes) -> str:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        blocks = read_blocks(BytesIO(data))

    paths = []
    for block in blocks:
        if not isinstance(block, SceneLineItemBlock):
            continue
        line = block.item.value
        if line is None or not line.points or len(line.points) < 2:
            continue

        color_val = line.color.value if hasattr(line.color, "value") else line.color
        color = COLORS.get(color_val, "#000000")
        base_width = max(line.thickness_scale * 2.0, 0.5)

        pts = line.points
        d_parts = [f"M {pts[0].x:.1f} {pts[0].y:.1f}"]
        for p in pts[1:]:
            d_parts.append(f"L {p.x:.1f} {p.y:.1f}")

        avg_pressure = sum(p.pressure for p in pts) / len(pts)
        stroke_width = max(base_width * (avg_pressure / 255.0) * 1.5, 0.5)

        opacity = 0.35 if color_val in (3, 4, 5) else 1.0

        paths.append(
            f'<path d="{" ".join(d_parts)}" '
            f'stroke="{color}" stroke-width="{stroke_width:.2f}" '
            f'fill="none" stroke-linecap="round" stroke-linejoin="round" '
            f'opacity="{opacity}"/>'
        )

    # Shift viewBox to accommodate negative x coords
    min_x = 0
    min_y = 0
    for block in [b for b in blocks if isinstance(b, SceneLineItemBlock)]:
        line = block.item.value
        if line and line.points:
            for p in line.points:
                min_x = min(min_x, p.x)
                min_y = min(min_y, p.y)

    vx = min_x - 20
    vy = min_y - 20
    vw = WIDTH - vx + 20
    vh = HEIGHT - vy + 20

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{vx:.0f} {vy:.0f} {vw:.0f} {vh:.0f}" '
        f'width="{WIDTH}" height="{HEIGHT}">\n'
        f'<rect x="{vx:.0f}" y="{vy:.0f}" width="{vw:.0f}" height="{vh:.0f}" fill="white"/>\n'
        + "\n".join(paths)
        + "\n</svg>"
    )


if __name__ == "__main__":
    if len(sys.argv) > 1:
        with open(sys.argv[1], "rb") as f:
            data = f.read()
    else:
        data = sys.stdin.buffer.read()
    print(rm_to_svg(data))
