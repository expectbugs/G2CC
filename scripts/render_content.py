#!/usr/bin/env python3
"""Glasses-OS CONTENT rasterizer — semantic blocks -> typeset 480x212 gray4 pages -> tiles.

The free-form content pipeline for the DE's tile mode (docs/DE_DESIGN.md §3,
docs/CONTENT_API.md): the server parses LLM markdown into blocks; this script
typesets them with real typography (DejaVu family) onto WIDTHxHEIGHT canvas
pages, paginating block-by-block (splitting oversized blocks at line
granularity — NO truncation, ever), then slices each page into the supplied
tile rects.

Input (JSON on stdin):
  { "width": 480, "height": 212,
    "tiles": [{"x":0,"y":0,"w":240,"h":106}, ...],
    "blocks": [
      {"t":"heading", "text":"...", "meta":"..."?},
      {"t":"para",    "text":"..."},
      {"t":"bullets", "items":["...", ...]},
      {"t":"code",    "lines":["...", ...]},
      {"t":"stats",   "cards":[{"value":"54°F","label":"garage"}, ...]},  # <=3 used
      {"t":"rule"} ] }

Output (stdout, binary): u32-LE page count, then pages x tiles x (w*h) bytes of
gray4 indices 0..15, row-major top-down (tile order as given).

Every page gets a hairline frame so EVERY tile carries ink (an all-black tile
hard-kills the glasses app slot — memory g2-render-limits). Loud-fails to
stderr + nonzero exit (no silent failure).
"""
import json
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = "/usr/share/fonts/dejavu"
SANS = f"{FONT_DIR}/DejaVuSans.ttf"
SANS_BOLD = f"{FONT_DIR}/DejaVuSans-Bold.ttf"
MONO = f"{FONT_DIR}/DejaVuSansMono.ttf"

# Gray levels (0-255 here; quantized /16 at the end). Mirrors the sim mockup.
INK_HEAD = 255      # headings / strong
INK_BODY = 216      # prose
INK_DIM = 138       # meta / hints
INK_BULLET = 122
RULE = 58
FRAME = 46
PANEL_BG = 22
PANEL_BORDER = 69
CARD_BG = 20
CARD_BORDER = 64

MARGIN = 14         # left/right content margin
GAP = 10            # vertical gap between blocks


class Fonts:
    def __init__(self):
        self.heading = ImageFont.truetype(SANS_BOLD, 16)
        self.meta = ImageFont.truetype(SANS, 13)
        self.body = ImageFont.truetype(SANS, 14)
        self.small = ImageFont.truetype(SANS, 13)
        self.code = ImageFont.truetype(MONO, 13)
        self.stat = ImageFont.truetype(SANS_BOLD, 21)
        self.stat_label = ImageFont.truetype(SANS, 12)


def text_w(font, s):
    return font.getbbox(s)[2] if s else 0


def wrap(font, text, max_w):
    """Greedy word-wrap; force-breaks words wider than max_w (no truncation).

    max_w is clamped to one glyph minimum: with max_w below any glyph width the
    hard-break loop's binary search still emits ≥1 char per line (lo starts at
    1), and the `while w and …` guard terminates on empty — a negative max_w
    used to spin forever here (review 2026-06-10: a long heading `meta` drove
    the computed width negative)."""
    out = []
    for raw in text.split("\n"):
        words = raw.split(" ")
        line = ""
        for w in words:
            cand = w if not line else line + " " + w
            if text_w(font, cand) <= max_w:
                line = cand
                continue
            if line:
                out.append(line)
            # the word itself may overflow — hard-break it (≥1 char per line)
            while w and text_w(font, w) > max_w:
                lo, hi = 1, len(w)
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if text_w(font, w[:mid]) <= max_w:
                        lo = mid
                    else:
                        hi = mid - 1
                out.append(w[:lo])
                w = w[lo:]
            line = w
        out.append(line)
    return out or [""]


# ---- block layout -------------------------------------------------------------
# Each block expands to a list of LINE-ATOMS: (height, draw(draw_ctx, y)) pairs.
# Pagination places atoms sequentially; an atom never splits, so heights stay
# small (one text line / one rule / one card row). `group_lead` atoms (panel
# tops) prefer not to sit alone at a page bottom but are NOT forced to fit.

class Atom:
    def __init__(self, h, draw_fn, is_gap=False):
        self.h = h
        self.draw = draw_fn
        self.is_gap = is_gap


def heading_atoms(f, cw, blk):
    text = blk.get("text", "")
    meta = blk.get("meta", "")
    # Clamp the title's width so a long meta can't drive it negative (≥80px of
    # title always survives); an over-wide meta is itself shortened to fit.
    meta_w = text_w(f.meta, meta) if meta else 0
    if meta and meta_w > cw - 96:
        while meta and text_w(f.meta, meta + "…") > cw - 96:
            meta = meta[:-1]
        meta += "…"
        meta_w = text_w(f.meta, meta)
    lines = wrap(f.heading, text, max(80, cw - (meta_w + 16 if meta else 0)))
    atoms = []

    def draw_first(d, y, line=lines[0]):
        d.text((MARGIN, y), line, font=f.heading, fill=INK_HEAD)
        if meta:
            d.text((MARGIN + cw - text_w(f.meta, meta), y + 2), meta, font=f.meta, fill=INK_DIM)

    atoms.append(Atom(22, draw_first))
    # Middle lines, then the LAST line fused with the divider — keep-together,
    # so a page break can't strand the divider alone at the top of page N+1
    # (review 2026-06-10: an orphaned divider was page 2's only ink).
    for line in lines[1:-1]:
        atoms.append(Atom(22, lambda d, y, s=line: d.text((MARGIN, y), s, font=f.heading, fill=INK_HEAD)))
    if len(lines) > 1:
        def draw_last(d, y, s=lines[-1]):
            d.text((MARGIN, y), s, font=f.heading, fill=INK_HEAD)
            d.line([(MARGIN, y + 26), (MARGIN + cw, y + 26)], fill=RULE, width=1)
        atoms.append(Atom(30, draw_last))
    else:
        # single-line heading: fuse the divider into the same atom
        first = atoms[0]
        def draw_first_with_rule(d, y, base=first.draw):
            base(d, y)
            d.line([(MARGIN, y + 26), (MARGIN + cw, y + 26)], fill=RULE, width=1)
        atoms[0] = Atom(30, draw_first_with_rule)
    return atoms


def para_atoms(f, cw, blk):
    return [Atom(19, lambda d, y, s=ln: d.text((MARGIN, y), s, font=f.body, fill=INK_BODY))
            for ln in wrap(f.body, blk.get("text", ""), cw)]


def bullets_atoms(f, cw, blk):
    atoms = []
    for item in blk.get("items", []):
        lines = wrap(f.body, str(item), cw - 16)
        for i, ln in enumerate(lines):
            def draw(d, y, s=ln, first=i == 0):
                if first:
                    d.text((MARGIN + 2, y), "•", font=f.body, fill=INK_BULLET)
                d.text((MARGIN + 16, y), s, font=f.body, fill=INK_BODY)
            atoms.append(Atom(19, draw))
    return atoms


def code_atoms(f, cw, blk):
    lines = []
    for raw in blk.get("lines", []):
        lines.extend(wrap(f.code, str(raw), cw - 20))
    if not lines:
        return []
    LH = 18
    atoms = []
    n = len(lines)
    for i, ln in enumerate(lines):
        def draw(d, y, s=ln, first=i == 0, last=i == n - 1):
            # panel slab behind this line (per-line so page splits keep the look)
            top = y - (4 if not first else 0)
            bot = y + LH + (4 if last else 0)
            d.rectangle([MARGIN, top, MARGIN + cw, bot], fill=PANEL_BG)
            d.line([(MARGIN, top), (MARGIN, bot)], fill=PANEL_BORDER)
            d.line([(MARGIN + cw, top), (MARGIN + cw, bot)], fill=PANEL_BORDER)
            if first:
                d.line([(MARGIN, top), (MARGIN + cw, top)], fill=PANEL_BORDER)
            if last:
                d.line([(MARGIN, bot), (MARGIN + cw, bot)], fill=PANEL_BORDER)
            d.text((MARGIN + 10, y), s, font=f.code, fill=INK_BODY)
        atoms.append(Atom(LH + (8 if i == n - 1 else 0), draw))
    return atoms


def stats_atoms(f, cw, blk):
    cards = blk.get("cards", [])[:3]
    if not cards:
        return []
    CH = 62
    n = len(cards)
    gap = 16
    card_w = min(150, (cw - gap * (n - 1)) // n)

    def draw(d, y):
        for i, c in enumerate(cards):
            x = MARGIN + i * (card_w + gap)
            d.rectangle([x, y, x + card_w, y + CH], fill=CARD_BG, outline=CARD_BORDER)
            d.text((x + 12, y + 8), str(c.get("value", "")), font=f.stat, fill=INK_HEAD)
            d.text((x + 12, y + 40), str(c.get("label", "")), font=f.stat_label, fill=INK_DIM)

    return [Atom(CH + 2, draw)]


def rule_atoms(f, cw, blk):
    return [Atom(9, lambda d, y: d.line([(MARGIN, y + 4), (MARGIN + cw, y + 4)], fill=RULE, width=1))]


def logo_atoms(f, cw, blk):
    """The Main-screen logo (Adam 2026-06-10): centered wordmark + glasses glyph,
    drawn as one full-pane atom. COMPACT metrics when the canvas is small (the
    Main logo now renders on a single 200×100 tile so it loads in ~1 s)."""
    title = str(blk.get("title", "G2CC"))
    sub = str(blk.get("sub", "glasses os"))
    compact = cw < 300
    big = ImageFont.truetype(SANS_BOLD, 28 if compact else 52)
    small = ImageFont.truetype(SANS, 11 if compact else 15)
    lw, lh, gap = (32, 18, 9) if compact else (54, 30, 14)
    word_pad = 6 if compact else 14
    word_h = 32 if compact else 62
    top = 2 if compact else 12
    H_LOGO = (top + lh + word_pad + word_h + 16) if compact else 180

    def draw(d, y):
        cx = MARGIN + cw // 2
        # glasses glyph: two rounded lens rects + bridge + temples
        gy = y + top
        lx = cx - lw - gap // 2
        rx = cx + gap // 2
        d.rounded_rectangle([lx, gy, lx + lw, gy + lh], radius=6 if compact else 8, outline=INK_HEAD, width=2)
        d.rounded_rectangle([rx, gy, rx + lw, gy + lh], radius=6 if compact else 8, outline=INK_HEAD, width=2)
        d.arc([lx + lw - 2, gy + 3, rx + 2, gy + lh], start=200, end=340, fill=INK_HEAD, width=2)
        d.line([(lx - 9, gy + 4), (lx, gy + 6)], fill=INK_DIM, width=2)
        d.line([(rx + lw, gy + 6), (rx + lw + 9, gy + 4)], fill=INK_DIM, width=2)
        # wordmark
        tw = text_w(big, title)
        d.text((cx - tw // 2, gy + lh + word_pad), title, font=big, fill=INK_HEAD)
        # flourish rules + subtitle
        sy = gy + lh + word_pad + word_h
        sw = text_w(small, sub)
        d.text((cx - sw // 2, sy), sub, font=small, fill=INK_DIM)
        d.line([(MARGIN + 6, sy + 7), (cx - sw // 2 - 8, sy + 7)], fill=RULE, width=1)
        d.line([(cx + sw // 2 + 8, sy + 7), (MARGIN + cw - 6, sy + 7)], fill=RULE, width=1)

    return [Atom(H_LOGO, draw)]


BLOCKS = {
    "heading": heading_atoms,
    "para": para_atoms,
    "bullets": bullets_atoms,
    "code": code_atoms,
    "stats": stats_atoms,
    "rule": rule_atoms,
    "logo": logo_atoms,
}


def paginate(atoms, width, height):
    """Place atoms top-down; overflow starts a new page. Returns list of pages,
    each a quantized 'P'-less gray4-index Image (mode L, values 0..15)."""
    pages = []
    img = None
    d = None
    y = 0
    top = 10

    def new_page():
        nonlocal img, d, y
        img = Image.new("L", (width, height), 0)
        d = ImageDraw.Draw(img)
        y = top

    def finish_page():
        # hairline frame -> EVERY tile carries ink (all-black tile kills the slot)
        d.rectangle([0, 0, width - 1, height - 1], outline=FRAME, width=1)
        pages.append(img.point(lambda v: round(v / 255 * 15)))

    new_page()
    for a in atoms:
        if y + a.h > height - 6 and y > top:   # doesn't fit (and page isn't empty)
            finish_page()
            new_page()
        if a.is_gap and y == top:
            continue   # an inter-block gap that landed at a page top: skip (consistent top margin)
        a.draw(d, y)
        y += a.h
    finish_page()
    return pages


def main():
    req = json.load(sys.stdin)
    width = int(req["width"])
    height = int(req["height"])
    tiles = req["tiles"]
    f = Fonts()
    cw = width - 2 * MARGIN

    atoms = []
    for i, blk in enumerate(req["blocks"]):
        kind = blk.get("t")
        fn = BLOCKS.get(kind)
        if fn is None:
            raise ValueError(f"unknown block type '{kind}' at index {i}")
        got = fn(f, cw, blk)
        if atoms and got:
            atoms.append(Atom(GAP, lambda d, y: None, is_gap=True))   # inter-block gap
        atoms.extend(got)
    if not atoms:
        atoms = [Atom(19, lambda d, y: d.text((MARGIN, y), "(empty)", font=f.body, fill=INK_DIM))]

    pages = paginate(atoms, width, height)

    out = bytearray(struct.pack("<I", len(pages)))
    for page in pages:
        for t in tiles:
            x, y, tw, th = int(t["x"]), int(t["y"]), int(t["w"]), int(t["h"])
            if x < 0 or y < 0 or x + tw > width or y + th > height:
                raise ValueError(f"tile [{x},{y},{tw},{th}] outside canvas {width}x{height}")
            out += page.crop((x, y, x + tw, y + th)).tobytes()
    sys.stdout.buffer.write(bytes(out))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"render_content error: {e}\n")
        sys.exit(1)
