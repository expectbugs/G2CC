#!/usr/bin/env python3
"""fetch_images.py — list/download images from a web page with JS rendering (docs/SCOUT.md).

The image-side sibling of ~/aria/fetch_page.py (which extracts TEXT only).
Playwright renders the page (lazy-loaded galleries included), then:

    list URL                         -> JSON array of content images (stdout)
    get URL --index N --out DIR      -> download the Nth listed image
    get URL --match "bathroom" --out DIR -> download the first alt/title match
    shot URL --out FILE [--full]     -> screenshot the rendered page

Downloads go through the SAME browser context (cookies/referer survive), so
gallery CDNs that reject bare curl still serve us. Run with the aria venv:

    /home/user/aria/venv/bin/python /home/user/G2CC/scripts/fetch_images.py list "URL"

CC-invoked ONLY — the G2CC server never runs this (it renders local files only).
All failures: loud stderr + exit 1. `get` with no match exits 1 and lists the
available alts so the next attempt can be precise.
"""

import argparse
import hashlib
import json
import os
import re
import sys

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36")

COLLECT_JS = """
() => {
  const out = [];
  for (const img of document.querySelectorAll('img')) {
    const src = img.currentSrc || img.src || '';
    if (!src || src.startsWith('data:')) continue;
    out.push({
      src,
      alt: (img.alt || img.title || '').trim(),
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
    });
  }
  const og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
  if (og && og.content) out.push({ src: og.content, alt: 'og:image', width: 0, height: 0 });
  return out;
}
"""

EXT_BY_TYPE = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
    "image/bmp": "bmp", "image/svg+xml": "svg",
}


def collect(page, min_dim: int, max_count: int) -> list[dict]:
    """Rendered content images, icon-filtered, deduped, index-stamped."""
    raw = page.evaluate(COLLECT_JS)
    seen: set[str] = set()
    out: list[dict] = []
    for c in raw:
        if c["src"] in seen:
            continue
        seen.add(c["src"])
        # og:image (0x0 = dimensions unknown) always passes; rendered imgs must
        # clear the icon filter on BOTH axes.
        if c["width"] and c["height"] and (c["width"] < min_dim or c["height"] < min_dim):
            continue
        out.append(c)
    if len(out) > max_count:
        # LOUD cap (never silent): the caller sees exactly how many were dropped.
        print(f"note: {len(out)} candidates, keeping the first {max_count} "
              f"(raise --max to see more)", file=sys.stderr)
        out = out[:max_count]
    for i, c in enumerate(out):
        c["index"] = i
    return out


def open_page(pw, url: str, timeout: int, wait: int):
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(user_agent=UA)
    page = context.new_page()
    page.goto(url, timeout=timeout, wait_until="domcontentloaded")
    # Give JS galleries a bounded grace period, but never block on ad networks
    # that hold the connection open (the fetch_page.py pattern).
    try:
        page.wait_for_load_state("networkidle", timeout=5000)
    except Exception:
        pass
    if wait > 0:
        page.wait_for_timeout(wait)
    # Nudge lazy-loaders: scroll to the bottom and back so below-the-fold
    # gallery images populate currentSrc.
    try:
        page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(700)
        page.evaluate("() => window.scrollTo(0, 0)")
        page.wait_for_timeout(300)
    except Exception as e:
        print(f"note: lazy-load scroll nudge failed ({e}) — continuing with what rendered",
              file=sys.stderr)
    return browser, context, page


def cmd_list(args) -> int:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, _context, page = open_page(pw, args.url, args.timeout, args.wait)
        try:
            cands = collect(page, args.min_dim, args.max)
        finally:
            browser.close()
    print(json.dumps(cands, indent=1))
    return 0


def pick(cands: list[dict], index: int | None, match: str | None) -> dict:
    if index is not None:
        if 0 <= index < len(cands):
            return cands[index]
        raise RuntimeError(f"--index {index} out of range (0..{len(cands) - 1})")
    assert match is not None
    m = match.lower()
    for c in cands:
        if m in c["alt"].lower():
            return c
    alts = [f"  [{c['index']}] {c['alt'] or '(no alt)'} ({c['width']}x{c['height']})"
            for c in cands]
    raise RuntimeError("no image alt/title matches "
                       f"'{match}'. Candidates:\n" + "\n".join(alts))


def cmd_get(args) -> int:
    if (args.index is None) == (args.match is None):
        print("error: get needs exactly one of --index N or --match STR", file=sys.stderr)
        return 1
    from playwright.sync_api import sync_playwright
    os.makedirs(args.out, exist_ok=True)
    with sync_playwright() as pw:
        browser, context, page = open_page(pw, args.url, args.timeout, args.wait)
        try:
            cands = collect(page, args.min_dim, args.max)
            if not cands:
                raise RuntimeError("no content images found on the page "
                                   f"(min dimension filter: {args.min_dim}px)")
            chosen = pick(cands, args.index, args.match)
            # Same-context request: cookies + a real browser TLS/header profile.
            resp = context.request.get(chosen["src"], headers={"Referer": args.url})
            if not resp.ok:
                raise RuntimeError(f"download failed: HTTP {resp.status} for {chosen['src']}")
            ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
            body = resp.body()
            if ctype and not ctype.startswith("image/"):
                raise RuntimeError(f"got {ctype or 'unknown content-type'} instead of an image "
                                   f"({len(body)}B) — likely a hotlink block page")
            ext = EXT_BY_TYPE.get(ctype)
            if not ext:
                # Fall back to the URL's extension; refuse if neither side knows.
                m = re.search(r"\.(jpe?g|png|webp|gif|avif|bmp)(?:[?#]|$)", chosen["src"], re.I)
                if not m:
                    raise RuntimeError(f"cannot determine image type (content-type '{ctype}', "
                                       f"url {chosen['src']})")
                ext = m.group(1).lower().replace("jpeg", "jpg")
            digest = hashlib.sha1(chosen["src"].encode()).hexdigest()[:8]
            path = os.path.join(args.out, f"img-{chosen['index']}-{digest}.{ext}")
            with open(path, "wb") as f:
                f.write(body)
        finally:
            browser.close()
    print(json.dumps({"saved": os.path.abspath(path), "bytes": len(body),
                      "src": chosen["src"], "alt": chosen["alt"],
                      "width": chosen["width"], "height": chosen["height"]}, indent=1))
    return 0


def cmd_shot(args) -> int:
    from playwright.sync_api import sync_playwright
    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with sync_playwright() as pw:
        browser, _context, page = open_page(pw, args.url, args.timeout, args.wait)
        try:
            page.screenshot(path=args.out, full_page=args.full)
        finally:
            browser.close()
    print(json.dumps({"saved": os.path.abspath(args.out)}))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="List/download images from a JS-rendered web page")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("url", help="page URL")
        p.add_argument("--timeout", type=int, default=15000,
                       help="page load timeout ms (default 15000)")
        p.add_argument("--wait", type=int, default=0,
                       help="extra wait after load ms (default 0)")
        p.add_argument("--min-dim", type=int, default=200,
                       help="drop images smaller than this on either axis (default 200)")
        p.add_argument("--max", type=int, default=40,
                       help="max candidates (default 40; excess noted on stderr)")

    common(sub.add_parser("list", help="JSON-list the page's content images"))
    g = sub.add_parser("get", help="download one image (by --index or --match)")
    common(g)
    g.add_argument("--index", type=int, default=None, help="candidate index from `list`")
    g.add_argument("--match", default=None, help="case-insensitive alt/title substring")
    g.add_argument("--out", required=True, help="output DIRECTORY")
    s = sub.add_parser("shot", help="screenshot the rendered page")
    common(s)
    s.add_argument("--out", required=True, help="output PNG file path")
    s.add_argument("--full", action="store_true", help="full-page screenshot")
    args = ap.parse_args()

    try:
        return {"list": cmd_list, "get": cmd_get, "shot": cmd_shot}[args.cmd](args)
    except Exception as e:  # loud single exit point — Playwright raises many types
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
