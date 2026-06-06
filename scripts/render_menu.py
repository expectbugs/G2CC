#!/usr/bin/env python3
"""Glasses-OS menu rasterizer (4-tile edition).

Renders a vertical menu — N items in a deliberately NON-HUD font (URW Chancery
cursive by default, so on the glasses it's unmistakably a PICTURE, not firmware
text) — once per selected index, with a triangle arrow at the selected row.

The glasses never see text here: the PC owns every pixel. The server ships each
frame as <=256x128 gray4 BMP regions; navigating just swaps the pre-rendered
frame for the new selection. The app's renderer dirty-diffs, so only the tiles
that actually change between selections get re-pushed.

Input  (JSON on stdin): {items:[str], width, height, fontPath, fontSize,
                         tiles?:[{x,y,w,h}]}
  - tiles, if given, are crop rects in CANVAS coords (0,0 = top-left of the
    width x height menu canvas). Output is sliced into those tiles.
Output (stdout, binary): gray4 indices 0..15, one byte per pixel, row-major
  top-down. WITHOUT tiles: N full frames (width*height each), frame k has the
  arrow on item k. WITH tiles: for each selection k, each tile in order
  (k0.t0, k0.t1, ..., k1.t0, ...), tile = w*h bytes.
Loud-fails to stderr + nonzero exit (no silent failure).
"""
import sys
import json
from PIL import Image, ImageDraw, ImageFont


def render_selection(items, w, h, font, fsize, sel):
    """Full menu canvas (gray4-quantized 'L' image) with the arrow on row `sel`."""
    n = len(items)
    row_h = h // n
    img = Image.new("L", (w, h), 0)  # black background
    d = ImageDraw.Draw(img)
    for i, item in enumerate(items):
        top = i * row_h
        cy = top + row_h // 2
        # item text (white), roughly vertically centered in its row
        d.text((72, cy - fsize // 2 - 2), str(item), fill=255, font=font)
        # arrow on the selected row — a filled triangle (font-independent)
        if i == sel:
            d.polygon([(24, cy - 13), (24, cy + 13), (56, cy)], fill=255)
    # Frame border around the whole canvas so EVERY tile carries ink. An all-black
    # (all-zero gray4) tile makes the glasses choke: in the menu test they acked m0
    # then went silent when the all-black m1 was pushed (T7's inked tiles all acked).
    # See memory g2-render-limits. Also a clean menu look.
    d.rectangle([(2, 2), (w - 3, h - 3)], outline=255, width=3)
    # quantize 0..255 grayscale -> 0..15 gray4 index
    return img.point(lambda v: int(round(v / 255 * 15)))


def main() -> None:
    req = json.load(sys.stdin)
    items = list(req["items"])
    w, h = int(req["width"]), int(req["height"])
    font = ImageFont.truetype(req["fontPath"], int(req["fontSize"]))
    fsize = int(req["fontSize"])
    tiles = req.get("tiles")
    n = len(items)
    if n == 0:
        raise ValueError("no items")

    out = bytearray()
    for sel in range(n):
        q = render_selection(items, w, h, font, fsize, sel)
        if tiles:
            for t in tiles:
                x, y, tw, th = int(t["x"]), int(t["y"]), int(t["w"]), int(t["h"])
                if x < 0 or y < 0 or x + tw > w or y + th > h:
                    raise ValueError(f"tile [{x},{y},{tw},{th}] out of canvas {w}x{h}")
                out += q.crop((x, y, x + tw, y + th)).tobytes()
        else:
            out += q.tobytes()

    sys.stdout.buffer.write(bytes(out))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"render_menu error: {e}\n")
        sys.exit(1)
