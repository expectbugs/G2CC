#!/usr/bin/env python3
"""Blackjack hand renderer (Games graphics-first build — Adam 2026-06-29) →
gray4 image in render_board.py's output contract (u16 w, u16 h, then w*h gray4
bytes; even dims). ONE hand per call — the controller renders the dealer hand
and the player hand as two SEPARATE small tiles (the cost model demands the
smallest possible images, re-pushed only when a hand changes; a full tile is
~10 s on the G2, a small one is exponentially quicker).

Cards are drawn FANNED left-to-right, each overlapping the previous so only its
top-left CORNER INDEX (rank + suit pip) shows except the last (fully visible)
card — the corner index is therefore the legibility-critical element and is
drawn crisply: rank as text, suit as a hand-drawn POLYGON (not a font glyph, so
the silhouette stays clean at ~10-15 px and survives the 4-bpp posterise).
Suits read by SHAPE, never colour — red and black both render dark in 16-gray.

stdin: JSON {"cards": [{"rank": str, "suit": "S|H|D|C", "down": bool?}],
             "width": int, "height": int}
  down=true → the dealer's face-down hole card (a patterned back).
"""
import json
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"

# gray4 level (0..15) → 8-bit for drawing; quantised back to 0..15 at the end.
def g(v):
    return v * 17


# Palette (gray4 levels). Suits read by SHAPE, so all four pips are the same
# dark level — colour is meaningless in 16-gray.
BG = 0          # behind the cards (the encode-time all-black guard covers the
                # degenerate empty case; a hand always has >=1 card here)
CARD_FILL = 14  # near-white card face (15 blooms on the display)
INK = 0         # rank text + suit pips + card border (max contrast)
BACK_FILL = 8   # hole-card back mid-gray
BACK_LINE = 3   # hole-card back pattern


def draw_suit(d, suit, box, fill):
    """Draw a filled suit pip inside box=(x0,y0,x1,y1). Hand-drawn silhouettes
    so they stay crisp at tiny sizes."""
    x0, y0, x1, y1 = box
    w = x1 - x0
    h = y1 - y0
    cx = (x0 + x1) / 2
    if suit == "D":  # diamond — a rhombus
        d.polygon([(cx, y0), (x1, (y0 + y1) / 2), (cx, y1), (x0, (y0 + y1) / 2)], fill=fill)
    elif suit == "H":  # heart — two lobes + a downward point
        r = w * 0.5
        d.ellipse([x0, y0, x0 + r, y0 + r * 0.95], fill=fill)
        d.ellipse([x1 - r, y0, x1, y0 + r * 0.95], fill=fill)
        d.polygon([(x0, y0 + r * 0.4), (x1, y0 + r * 0.4), (cx, y1)], fill=fill)
    elif suit == "S":  # spade — an inverted heart + a trunk
        r = w * 0.5
        d.polygon([(cx, y0), (x0, y0 + h * 0.62), (x1, y0 + h * 0.62)], fill=fill)
        d.ellipse([x0, y0 + h * 0.32, x0 + r, y0 + h * 0.32 + r * 0.95], fill=fill)
        d.ellipse([x1 - r, y0 + h * 0.32, x1, y0 + h * 0.32 + r * 0.95], fill=fill)
        d.polygon([(cx - w * 0.16, y1), (cx + w * 0.16, y1),
                   (cx + w * 0.06, y0 + h * 0.6), (cx - w * 0.06, y0 + h * 0.6)], fill=fill)
    elif suit == "C":  # club — three lobes + a trunk
        r = w * 0.42
        d.ellipse([cx - r / 2, y0, cx + r / 2, y0 + r], fill=fill)                       # top
        d.ellipse([x0, y0 + h * 0.30, x0 + r, y0 + h * 0.30 + r], fill=fill)             # bottom-left
        d.ellipse([x1 - r, y0 + h * 0.30, x1, y0 + h * 0.30 + r], fill=fill)             # bottom-right
        d.polygon([(cx - w * 0.16, y1), (cx + w * 0.16, y1),
                   (cx + w * 0.06, y0 + h * 0.55), (cx - w * 0.06, y0 + h * 0.55)], fill=fill)
    else:
        raise ValueError(f"unknown suit {suit!r}")


def draw_face(d, x, y, cw, ch, rank, suit):
    """A face-up card: light rounded body, dark 1 px border (separates fanned
    cards), top-left rank text + suit pip, and a big centre pip."""
    rad = max(2, int(cw * 0.14))
    d.rounded_rectangle([x, y, x + cw - 1, y + ch - 1], radius=rad, fill=g(CARD_FILL), outline=g(INK), width=1)

    # Corner index — rank over a small pip, top-left. 2-char "10" gets a smaller
    # font so it fits the narrow visible strip of an overlapped card.
    idx_h = max(7, int(ch * 0.30))
    fsize = int(idx_h * (0.74 if len(rank) >= 2 else 1.0))
    try:
        font = ImageFont.truetype(FONT_BOLD, fsize)
    except OSError:
        font = ImageFont.truetype(FONT, fsize)
    d.text((x + 2, y + 1), rank, font=font, fill=g(INK))
    pip = max(5, int(cw * 0.22))
    py = y + 2 + idx_h
    draw_suit(d, suit, (x + 2, py, x + 2 + pip, py + pip), g(INK))

    # Centre pip — bigger, for the fully-visible card; harmless under an overlap.
    cpip_w = int(cw * 0.46)
    cpip_h = int(ch * 0.40)
    ccx = x + cw // 2
    ccy = y + ch // 2
    draw_suit(d, suit, (ccx - cpip_w // 2, ccy - cpip_h // 2, ccx + cpip_w // 2, ccy + cpip_h // 2), g(INK))


def draw_back(d, x, y, cw, ch):
    """The dealer's face-down hole card — a patterned back, unmistakably not a
    face."""
    rad = max(2, int(cw * 0.14))
    d.rounded_rectangle([x, y, x + cw - 1, y + ch - 1], radius=rad, fill=g(BACK_FILL), outline=g(INK), width=1)
    inset = max(2, int(cw * 0.12))
    d.rounded_rectangle([x + inset, y + inset, x + cw - 1 - inset, y + ch - 1 - inset],
                        radius=max(1, rad // 2), outline=g(BACK_LINE), width=1)
    # Diagonal lattice inside the inner frame.
    step = max(4, int(cw * 0.22))
    for off in range(-ch, cw, step):
        d.line([(x + max(inset, off), y + inset), (x + min(cw - inset, off + ch), y + ch - inset)], fill=g(BACK_LINE), width=1)


def layout(n, width, height, cw):
    """Left-to-right fan positions. Few cards pack left with a small gap; many
    cards fan to fill the width (overlapping), but never overflow."""
    margin = 1
    if n <= 1:
        return [margin]
    avail = width - 2 * margin
    fill_step = (avail - cw) / (n - 1)   # spreads to exactly fill the width
    step = min(fill_step, cw + 3)        # cap so a 2-card hand isn't flung apart
    return [round(margin + i * step) for i in range(n)]


def main():
    req = json.load(sys.stdin)
    cards = req["cards"]
    w = int(req["width"]) & ~1
    h = int(req["height"]) & ~1
    if w < 8 or h < 8:
        raise ValueError(f"hand canvas {w}x{h} too small")
    n = len(cards)
    if n == 0:
        raise ValueError("render_hand: empty hand (controller should not render a hand tile with no cards)")

    margin = 1
    ch = h - 2 * margin
    cw = max(12, round(ch * 0.70))
    # If the fan would exceed the canvas even fully overlapped at a readable
    # reveal, the cap in layout() already prevents overflow; cw is unchanged.
    xs = layout(n, w, h, cw)

    img = Image.new("L", (w, h), g(BG))
    d = ImageDraw.Draw(img)
    for i, c in enumerate(cards):
        x = xs[i]
        y = margin
        if c.get("down"):
            draw_back(d, x, y, cw, ch)
        else:
            draw_face(d, x, y, cw, ch, str(c["rank"]), str(c["suit"]))

    gray4 = img.point(lambda v: v * 15 // 255)
    sys.stdout.buffer.write(struct.pack("<HH", w, h))
    sys.stdout.buffer.write(gray4.tobytes())
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"render_hand error: {e}\n")
        sys.exit(1)
