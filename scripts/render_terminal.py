#!/usr/bin/env python3
"""Terminal-grid renderer (DE Phase 5) — a tmux capture-pane snapshot → a gray4
image in render_image.py's output contract (u16 w, u16 h, w*h gray4 bytes; even
dims). Char-per-cell so columns stay aligned regardless of font metrics; 80×22
fits 480×222 at ~6×10 px. White text (gray 15) on black — htop/vim legible at
the page-2 tile push, per the spec.

stdin: JSON {"text": str, "width": int, "height": int, "cols": int, "rows": int}
"""
import json
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/dejavu/DejaVuSansMono.ttf"


def main():
    req = json.load(sys.stdin)
    w = int(req["width"]) & ~1
    h = int(req["height"]) & ~1
    lines = req.get("text", "").split("\n")
    # AUTO-SIZE to the actual capture so a pane WIDER than 80 cols isn't silently
    # clipped (review 2026-06-13): the full grid renders, scaled to fit. Clamped
    # so narrow content isn't huge and an absurd width isn't unreadable+truncated.
    while lines and not lines[-1].strip():
        lines.pop()
    longest = max((len(ln) for ln in lines), default=1)
    cols = min(max(longest, int(req.get("cols", 80))), 220)
    rows = min(max(len(lines), int(req.get("rows", 22))), 48)

    cw = w / cols
    ch = h / rows
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    # size the glyph to the cell HEIGHT (mono advance ≈ 0.6 em < cell width, so
    # columns never overlap); char-per-cell placement keeps alignment exact.
    font = ImageFont.truetype(FONT, max(8, int(ch)))
    g15 = 15 * 17

    for r, line in enumerate(lines[:rows]):
        y = int(round(r * ch))
        for c, glyph in enumerate(line[:cols]):
            if glyph == " " or not glyph.strip():
                continue
            d.text((int(round(c * cw)), y), glyph, font=font, fill=g15)

    gray4 = img.point(lambda v: v * 15 // 255)
    sys.stdout.buffer.write(struct.pack("<HH", w, h))
    sys.stdout.buffer.write(gray4.tobytes())
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"render_terminal error: {e}\n")
        sys.exit(1)
