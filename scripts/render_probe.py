#!/usr/bin/env python3
"""Glasses-OS capability-probe tile rasterizer.

Renders each requested tile as a standalone gray4 image: a bright border + a big
centered label (e.g. "T5.3" = test 5, tile 3) on black. The label makes paint
results self-identifying on-glass — the number you SEE is the test that
painted; a partial paint shows a mix of labels; a stale number means the new
test didn't render.

Input  (JSON on stdin): {tiles:[{label,w,h}], fontPath}
Output (stdout, binary): each tile's gray4 indices (w*h bytes, 0..15, top-down),
  concatenated in the given order. Loud-fails to stderr + nonzero exit.
"""
import sys
import json
from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    req = json.load(sys.stdin)
    font_path = req["fontPath"]
    out = bytearray()
    for t in req["tiles"]:
        w, h = int(t["w"]), int(t["h"])
        label = str(t["label"])
        fs = max(14, min(64, int(min(w, h) * 0.45)))
        font = ImageFont.truetype(font_path, fs)
        img = Image.new("L", (w, h), 0)  # black
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, w - 1, h - 1], outline=255, width=2)  # bright border (L=255 -> gray4 idx 15)
        bbox = d.textbbox((0, 0), label, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((w - tw) // 2 - bbox[0], (h - th) // 2 - bbox[1]), label, fill=255, font=font)
        q = img.point(lambda v: int(round(v / 255 * 15)))
        out += q.tobytes()
    sys.stdout.buffer.write(bytes(out))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"render_probe error: {e}\n")
        sys.exit(1)
