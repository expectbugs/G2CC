#!/usr/bin/env python3
"""Measure the G2 firmware-font glyph widths from a fontcal simulator screenshot.

Input: the 576x288 RGBA PNG from the simulator's GET /api/screenshot/glasses, rendering
sdk-demo/src/fontcal.ts. For each row band, finds the ink bounding box (text is light on a black
field) and reports the pixel width — repeated-single-glyph rows divide out to per-glyph width; mixed
rows give realistic per-char averages. ROWS / ROW_H / ROW_GAP MUST match fontcal.ts.
"""
import sys
import numpy as np
from PIL import Image

ROW_H = 34
ROW_GAP = 2
# (label, string) — identical order to sdk-demo/src/fontcal.ts ROWS.
ROWS = [
    ("20xW", "WWWWWWWWWWWWWWWWWWWW"),
    ("20xi", "iiiiiiiiiiiiiiiiiiii"),
    ("20xN", "NNNNNNNNNNNNNNNNNNNN"),
    ("10xDigit", "0123456789"),
    ("lower26", "abcdefghijklmnopqrstuvwxyz"),
    ("upper26", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    ("sentence", "The quick brown fox jumps over a"),
    ("ui-row", "Inbox  Re: shipment delayed 3 days"),
]
INK = 128  # alpha > this = ink


def main(path):
    # The sim renders the G2 display as solid GREEN (R0 G255 B0) with the actual glyph shapes in
    # the ALPHA channel — so ink = alpha, NOT luminance (a luminance convert collapses green to a
    # flat ~150 and discards every glyph; that mistake cost an afternoon).
    rgba = np.array(Image.open(path).convert("RGBA"))
    img = rgba[..., 3]
    h, w = img.shape
    print(f"# image {w}x{h}, ink = alpha>{INK}\n")
    per_char_avgs = []
    glyph_w = {}
    for i, (label, s) in enumerate(ROWS):
        y0 = i * (ROW_H + ROW_GAP)
        y1 = min(y0 + ROW_H, h)
        band = img[y0:y1]
        cols = np.where(band.max(axis=0) > INK)[0]
        if len(cols) == 0:
            print(f"  {label:9} (NO INK in band y={y0}..{y1}) '{s}'")
            continue
        left, right = int(cols.min()), int(cols.max())
        width = right - left + 1
        if len(set(s)) == 1:
            g = s[0]
            gw = width / len(s)
            glyph_w[g] = gw
            note = f"-> {gw:5.2f} px/glyph  ('{g}' x{len(s)})"
        else:
            avg = width / len(s)
            per_char_avgs.append(avg)
            note = f"-> {avg:5.2f} px/char avg  ({len(s)} chars)"
        print(f"  {label:9} ink={width:3}px  x[{left:3}..{right:3}]  {note}")

    print("\n# ---- layout implications ----")
    if per_char_avgs:
        avg = sum(per_char_avgs) / len(per_char_avgs)
        wide = max(glyph_w.values()) if glyph_w else avg
        for region, px in (("content row (75%/432px)", 432), ("menu (25%/144px)", 144),
                           ("full width (576px)", 576)):
            print(f"  {region:26}: ~{px/avg:4.0f} avg chars   /   ~{px/wide:4.0f} all-caps-W (worst)")
        print(f"\n  (avg char ~{avg:.1f}px from real strings; widest glyph ~{wide:.1f}px)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/fontcal.png")
