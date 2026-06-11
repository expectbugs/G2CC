#!/usr/bin/env python3
"""Image -> G2 gray4 for the Files image viewer (Adam 2026-06-11).

Fits the image to the LARGEST size inside maxW x maxH that preserves its
aspect ratio (up- or down-scaling, LANCZOS), Floyd-Steinberg-dithers to the
G2's 16 gray levels, and writes:

    u16-LE width, u16-LE height, then width*height bytes of gray4 indices
    (0..15, row-major top-down).

The caller splits into 2x2 tiles (each half ≤240x111 — inside the hardware
caps for any maxW/maxH ≤480x222). EXIF orientation is honored. Loud-fails to
stderr + nonzero exit.

Usage: render_image.py <path> <maxW> <maxH>
"""
import struct
import sys

from PIL import Image, ImageOps

# 16-level linear gray palette for Floyd-Steinberg quantization: palette index
# i == gray4 level i, so the quantized image's raw bytes ARE the gray4 indices.
_PAL = Image.new("P", (1, 1))
_PAL.putpalette(sum([[i * 17] * 3 for i in range(16)], []) + [0] * (768 - 48))


def main(path, max_w, max_h):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        # composite alpha over black (the display background)
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
        img = Image.alpha_composite(bg, img)
    img = img.convert("RGB")

    # Largest aspect-preserving fit (upscales small images too — "biggest size
    # that fits"). Dimensions forced EVEN so the 2x2 split is exact.
    scale = min(max_w / img.width, max_h / img.height)
    w = max(2, int(img.width * scale) & ~1)
    h = max(2, int(img.height * scale) & ~1)
    img = img.resize((w, h), Image.LANCZOS)

    q = img.quantize(palette=_PAL, dither=Image.Dither.FLOYDSTEINBERG)
    data = q.tobytes()  # palette indices == gray4 levels

    sys.stdout.buffer.write(struct.pack("<HH", w, h))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise ValueError("usage: render_image.py <path> <maxW> <maxH>")
        main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"render_image error: {e}\n")
        sys.exit(1)
