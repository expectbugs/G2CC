#!/usr/bin/env python3
"""```chart fenced-block renderer (upgrades.md Phase 8).

stdin: JSON {"spec": {...}, "width": int, "height": int}
stdout: u16-LE width, u16-LE height, then width*height bytes of gray4 indices
        (0..15, row-major) — EXACTLY render_image.py's output contract, so the
        server-side tile splitter is shared.

Spec shape (taught to the model in server/prompts/aria-g2.md):
  {"type": "line"|"bar"|"scatter",
   "title": str?, "xlabel": str?, "ylabel": str?,
   "x": [num|str, ...]?,                  # shared x values/categories
   "series": [{"label": str?, "y": [num, ...]}, ...]}
  shorthand: {"y": [...]} == one anonymous line series.

Styled for the 576x288 16-gray green display: black bg, white thick lines,
big fonts. Malformed specs loud-fail (stderr + exit 1) — the server renders
that as a visible failure page, never a silent blank.
"""
import io
import json
import struct
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image

# Big-and-bright defaults: the pane is 480x222 at arm's length on glass.
plt.rcParams.update({
    "figure.facecolor": "black", "axes.facecolor": "black",
    "axes.edgecolor": "white", "axes.labelcolor": "white",
    "xtick.color": "white", "ytick.color": "white",
    "text.color": "white",
    "font.size": 13, "axes.titlesize": 16, "axes.labelsize": 13,
    "lines.linewidth": 3.5, "lines.markersize": 9,
    "axes.grid": True, "grid.color": "white", "grid.alpha": 0.25,
    "legend.facecolor": "black", "legend.edgecolor": "white",
})
# Distinguishable on a 16-gray panel: white, light gray, mid gray + linestyles.
SERIES_STYLE = [("#ffffff", "-"), ("#bbbbbb", "--"), ("#888888", "-."), ("#dddddd", ":")]


def normalize_series(spec):
    series = spec.get("series")
    if series is None and "y" in spec:
        series = [{"y": spec["y"]}]
    if not isinstance(series, list) or not series:
        raise ValueError("spec needs 'series': [{y: [...]}, ...] (or shorthand 'y')")
    for s in series:
        ys = s.get("y")
        if not isinstance(ys, list) or not ys:
            raise ValueError("every series needs a non-empty numeric 'y' list")
        # None -> NaN (review 2026-07-05, coupled with stats.ts series()): a
        # sampler gap must render AS a gap — matplotlib breaks the line at NaN —
        # never as a fabricated 0 dip. Additive: all-numeric specs unchanged.
        s["y"] = [float(v) if v is not None else float("nan") for v in ys]
    return series


def main():
    req = json.load(sys.stdin)
    spec = req["spec"]
    if isinstance(spec, str):  # tolerate a JSON-string spec
        spec = json.loads(spec)
    w = int(req["width"]) & ~1
    h = int(req["height"]) & ~1
    if w < 64 or h < 64:
        raise ValueError(f"target {w}x{h} too small")

    ctype = str(spec.get("type", "line")).lower()
    series = normalize_series(spec)
    x = spec.get("x")

    dpi = 100
    fig = plt.figure(figsize=(w / dpi, h / dpi), dpi=dpi)
    ax = fig.add_subplot(111)

    any_label = False
    for i, s in enumerate(series):
        ys = s["y"]
        xs = x if isinstance(x, list) and len(x) == len(ys) else list(range(len(ys)))
        color, ls = SERIES_STYLE[i % len(SERIES_STYLE)]
        label = s.get("label")
        any_label = any_label or bool(label)
        if ctype == "bar":
            n = len(series)
            width = 0.8 / n
            pos = [j + (i - (n - 1) / 2) * width for j in range(len(ys))]
            ax.bar(pos, ys, width=width, color=color, label=label)
            if isinstance(x, list) and len(x) == len(ys):
                ax.set_xticks(range(len(ys)), [str(v) for v in x])
        elif ctype == "scatter":
            ax.scatter(xs, ys, color=color, label=label)
        else:
            ax.plot(xs, ys, color=color, linestyle=ls, label=label)

    if spec.get("title"):
        ax.set_title(str(spec["title"]))
    if spec.get("xlabel"):
        ax.set_xlabel(str(spec["xlabel"]))
    if spec.get("ylabel"):
        ax.set_ylabel(str(spec["ylabel"]))
    if any_label:
        ax.legend()
    fig.tight_layout(pad=0.6)

    png = io.BytesIO()
    fig.savefig(png, format="png", dpi=dpi, facecolor="black")
    png.seek(0)
    img = Image.open(png).convert("L").resize((w, h), Image.LANCZOS)
    # Linear 0..255 → gray4 index (no dithering — keeps chart lines crisp).
    gray4 = img.point(lambda v: v * 15 // 255)

    sys.stdout.buffer.write(struct.pack("<HH", w, h))
    sys.stdout.buffer.write(gray4.tobytes())
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"render_chart error: {e}\n")
        sys.exit(1)
