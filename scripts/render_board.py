#!/usr/bin/env python3
"""Chess board renderer (upgrades.md Phase 11) — FEN → gray4 board image in
render_image.py's output contract (u16 w, u16 h, w*h gray4 bytes; even dims).

DejaVuSans chess glyphs U+2654-265F (presence VERIFIED 2026-06-11 — non-empty
bboxes). Both colors draw at gray 15; white pieces are the outline glyphs,
black the filled ones — the classic mono distinction, readable on light and
dark squares. Light/dark squares at gray 6/2; rank/file coords in the margin.

stdin: JSON {"fen": str, "width": int, "height": int}
"""
import json
import struct
import sys

import chess
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/dejavu/DejaVuSans.ttf"
# white pieces (outline glyphs) then black (filled): K Q R B N P
WHITE_GLYPHS = {"K": "♔", "Q": "♕", "R": "♖", "B": "♗", "N": "♘", "P": "♙"}
BLACK_GLYPHS = {"K": "♚", "Q": "♛", "R": "♜", "B": "♝", "N": "♞", "P": "♟"}


def main():
    req = json.load(sys.stdin)
    board = chess.Board(req["fen"])
    w = int(req["width"]) & ~1
    h = int(req["height"]) & ~1

    # Margins: 18 px horizontal for the rank digits, 16 px VERTICAL for the
    # file letters (review 2026-06-11b: the old 4 px bottom margin drew the
    # a-h labels at y=220..231 on a 222 px canvas — 100% invisible, verified
    # empirically with PIL; an 11 px label row needs real room).
    sq = min((w - 18) // 8, (h - 16) // 8)
    bw = sq * 8
    ox = (w - bw) // 2 + 7                  # nudge right of the rank labels
    oy = max(2, (h - bw - 13) // 2)         # bias up so the label row fits below

    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    piece_font = ImageFont.truetype(FONT, int(sq * 0.92))
    coord_font = ImageFont.truetype(FONT, 11)

    g = lambda v: v * 17  # gray4 level → 8-bit for drawing; quantized back below

    for rank in range(8):          # rank 8 at top
        for file in range(8):
            x0 = ox + file * sq
            y0 = oy + (7 - rank) * sq
            light = (file + rank) % 2 == 1
            d.rectangle([x0, y0, x0 + sq - 1, y0 + sq - 1], fill=g(6) if light else g(2))
            piece = board.piece_at(chess.square(file, rank))
            if piece:
                glyph = (WHITE_GLYPHS if piece.color == chess.WHITE else BLACK_GLYPHS)[piece.symbol().upper()]
                bbox = d.textbbox((0, 0), glyph, font=piece_font)
                gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
                d.text((x0 + (sq - gw) / 2 - bbox[0], y0 + (sq - gh) / 2 - bbox[1]), glyph,
                       font=piece_font, fill=g(15))
    label_y = min(oy + bw + 2, h - 13)  # keep the 11 px glyph row fully on-canvas
    for i in range(8):
        d.text((ox - 9, oy + (7 - i) * sq + sq / 2 - 6), str(i + 1), font=coord_font, fill=g(9))
        d.text((ox + i * sq + sq / 2 - 3, label_y), chr(ord("a") + i), font=coord_font, fill=g(9))

    gray4 = img.point(lambda v: v * 15 // 255)
    sys.stdout.buffer.write(struct.pack("<HH", w, h))
    sys.stdout.buffer.write(gray4.tobytes())
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"render_board error: {e}\n")
        sys.exit(1)
