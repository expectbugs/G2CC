#!/usr/bin/env python3
"""WireScene JSON (stdin) -> PNG — the no-glasses compositor check.

Draws what the glasses WOULD show for a server-composed scene: image regions
pixel-exact (the BMPs we'd send, via PIL), text/list regions approximated
(DejaVu — the firmware font differs; treat as layout guide). Also validates
the scene against the CLIENT's hardware rules (G2Renderer.validate +
SceneCodec clock constraints) and prints violations loudly.

Usage: node <something printing WireScene JSON> | scene_to_png.py out.png
"""
import base64
import io
import json
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 576, 288
# Mirrors shared/src/constants.ts CLOCK_* (33px bars / x474 — Adam cal 2026-06-10).
CLOCK = {"x": 474, "y": 0, "w": 102, "h": 33}
SANS = ImageFont.truetype("/usr/share/fonts/dejavu/DejaVuSans.ttf", 15)


def gray(v):
    return (0, int(v * 255 / 15), 0)


def main(out_path):
    scene = json.load(sys.stdin)
    regions = scene["regions"]

    # ---- client-rule validation (loud) ----
    problems = []
    if len(regions) + 1 > 12:   # +1 = the client-injected clock
        problems.append(f"{len(regions)}+clock containers > 12")
    texts = [r for r in regions if r["kind"] == "text"]
    imgs = [r for r in regions if r["kind"] == "image"]
    lists = [r for r in regions if r["kind"] == "list"]
    if len(texts) + 1 > 8:
        problems.append(f"{len(texts)}+clock text regions > 8")
    if len(imgs) > 4:
        problems.append(f"{len(imgs)} image regions > 4")
    captures = [r["name"] for r in regions
                if (r["kind"] == "text" and (r.get("content") or {}).get("scroll"))
                or (r["kind"] == "list" and (r.get("content") or {}).get("eventCapture"))]
    # Mirror the client exactly: >1 is the hard reject; 0 renders but input is
    # dead (G2Renderer warns) — warn here too, don't fail.
    if len(captures) > 1:
        problems.append(f"event-capture regions = {captures} (a page allows exactly ONE)")
    elif len(captures) == 0:
        print("warn: no event-capture region — input will be dead on this page")
    # Native-list caps (mirrors G2Renderer.validate)
    for r in lists:
        c = r.get("content") or {}
        items = c.get("items") or []
        if len(items) > 20:
            problems.append(f"list '{r['name']}' has {len(items)} items (SDK max 20)")
        for it in items:
            if len(it) > 64:
                problems.append(f"list '{r['name']}' item >64 chars: {it[:40]}…")
    ids = [r["id"] for r in regions]
    if len(set(ids)) != len(ids) or 1 in ids:
        problems.append(f"region id problem (dup or reserved clock id 1): {ids}")
    for r in regions:
        if (r["x"] < CLOCK["x"] + CLOCK["w"] and r["x"] + r["w"] > CLOCK["x"]
                and r["y"] < CLOCK["y"] + CLOCK["h"] and r["y"] + r["h"] > CLOCK["y"]):
            problems.append(f"region '{r['name']}' overlaps the clock cutout")
        if r["x"] < 0 or r["y"] < 0 or r["x"] + r["w"] > W or r["y"] + r["h"] > H:
            problems.append(f"region '{r['name']}' out of bounds")
        if r["kind"] == "image":
            if r["w"] > 288 or r["h"] > 129:
                problems.append(f"image '{r['name']}' {r['w']}x{r['h']} over 288x129")

    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)

    # client clock (injected)
    d.rectangle([CLOCK["x"], CLOCK["y"], CLOCK["x"] + CLOCK["w"] - 1, CLOCK["y"] + CLOCK["h"] - 1], outline=gray(6))
    d.text((CLOCK["x"] + 8, CLOCK["y"] + 9), "1:04 PM", font=SANS, fill=gray(15))

    for r in regions:
        x, y, w, h = r["x"], r["y"], r["w"], r["h"]
        style = r.get("style") or {}
        c = r.get("content") or {}
        if style.get("borderWidth"):
            d.rectangle([x, y, x + w - 1, y + h - 1], outline=gray(style.get("borderColor", 6)))
        if r["kind"] == "image" and c.get("bmpBase64"):
            bmp = Image.open(io.BytesIO(base64.b64decode(c["bmpBase64"]))).convert("L")
            if bmp.size != (w, h):
                problems.append(f"image '{r['name']}' BMP {bmp.size} != region {w}x{h}")
            g = Image.merge("RGB", (Image.new("L", bmp.size, 0), bmp, Image.new("L", bmp.size, 0)))
            img.paste(g, (x, y))
            # all-black check
            if bmp.getextrema()[1] == 0:
                problems.append(f"image '{r['name']}' is ALL-BLACK (hardware kill)")
        elif r["kind"] == "text":
            ty = y + 8
            for line in str(c.get("text", "")).split("\n"):
                if ty > y + h - 12:
                    break  # firmware clips/scrolls; guide only
                d.text((x + 8, ty), line, font=SANS, fill=gray(13))
                ty += 19
        elif r["kind"] == "list":
            ty = y + 6
            for i, item in enumerate(c.get("items", [])):
                if ty > y + h - 16:
                    break
                if i == 0 and c.get("selectBorder", True):
                    tw = d.textbbox((0, 0), item, font=SANS)[2]
                    d.rounded_rectangle([x + 4, ty - 3, min(x + w - 4, x + 12 + tw), ty + 19], radius=6, outline=gray(13))
                d.text((x + 10, ty), item, font=SANS, fill=gray(13 if i == 0 else 8))
                ty += 34

    img.save(out_path)
    print(f"wrote {out_path} ({len(regions)} regions; {len(texts)}t/{len(lists)}l/{len(imgs)}i + clock)")
    if problems:
        print("RULE VIOLATIONS:")
        for p in problems:
            print(f"  ✗ {p}")
        sys.exit(2)
    print("client-rule check: OK")


if __name__ == "__main__":
    try:
        main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/scene.png")
    except Exception as e:
        sys.stderr.write(f"scene_to_png error: {e}\n")
        sys.exit(1)
