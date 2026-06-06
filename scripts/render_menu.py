#!/usr/bin/env python3
"""Glasses-OS menu rasterizer (Phase 1 end-to-end proof).

Renders a vertical menu — N items in a deliberately NON-HUD font (URW Chancery
cursive by default, so on the glasses it's unmistakably a PICTURE, not firmware
text) — once per selected index, with a triangle arrow at the selected row.

The glasses never see text here: the PC owns every pixel. The server tiles each
frame into <=200x100 gray4 BMP regions and ships them; scrolling the clock
antenna just swaps to the next pre-rendered frame.

Input  (JSON on stdin): {items:[str], width, height, fontPath, fontSize}
Output (stdout, binary): N frames concatenated, each width*height bytes, one
  byte per pixel = gray4 index 0..15 (row-major, top-down). Frame k has the
  arrow on item k. Loud-fails to stderr + nonzero exit (no silent failure).
"""
import sys
import json
from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    req = json.load(sys.stdin)
    items = list(req["items"])
    w, h = int(req["width"]), int(req["height"])
    font = ImageFont.truetype(req["fontPath"], int(req["fontSize"]))
    fsize = int(req["fontSize"])
    n = len(items)
    if n == 0:
        raise ValueError("no items")
    row_h = h // n

    out = bytearray()
    for sel in range(n):
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
        # quantize 0..255 grayscale -> 0..15 gray4 index
        q = img.point(lambda v: int(round(v / 255 * 15)))
        out += q.tobytes()

    sys.stdout.buffer.write(bytes(out))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"render_menu error: {e}\n")
        sys.exit(1)
