#!/usr/bin/env python3
"""scout-show — push a live frame to the G2 glasses mid-turn (docs/SCOUT.md).

The Scout window's Claude Code subprocess calls this via Bash while a turn is
in flight to paint progress on the glasses NOW. Live frames are DISPOSABLE —
anything worth keeping goes in the final answer (text pages / ```g2img blocks),
which is durable and scrollable.

Usage:
    scout_show.py text "Searching PrevostStuff + RVT… 3 candidates so far"
    scout_show.py image /home/user/scout/downloads/coach1.jpg --caption "2016 Marathon"
    scout_show.py status

Rules the server enforces (truthful replies, never silent):
  - Frames display only while a turn is in flight (idle pushes are rejected).
  - Text frames must fit one glanceable page (<=560 UTF-8 bytes) — long content
    belongs in your answer, which paginates.
  - Image paths must be absolute LOCAL files (download first). ~1-2 s render.

Exit codes:
    0  frame delivered to Scout's ACTIVE view (or `status` succeeded). Note the
       honest limits: the BLE push itself takes seconds, and a notification
       overlay / blanked screen can cover the view — 0 means "Scout is showing
       it", not a hardware ack.
    3  accepted, but not currently visible (Scout window parked/inactive)
    2  rejected by the server (reason printed — e.g. no turn in flight,
       text frame too long for one glanceable page)
    1  transport/config error (server down, bad token, malformed reply)

Config: reads ~/.g2cc/config.json for the port + auth token. Overrides:
G2CC_SCOUT_URL (e.g. http://127.0.0.1:7300) and G2CC_TOKEN.

No socket timeout by design (house no-timeouts rule): the server replies when
the outcome is real — an image render legitimately takes a couple of seconds.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

CONFIG_PATH = os.path.expanduser("~/.g2cc/config.json")


def bounded(s: str, n: int = 200) -> str:
    """Bound a diagnostic string WITH a visible marker (never a silent slice)."""
    return s if len(s) <= n else s[:n] + f"… [{len(s)} chars total]"


def load_endpoint() -> tuple[str, str]:
    """(base_url, token) from env overrides, else ~/.g2cc/config.json. Loud on failure."""
    url = os.environ.get("G2CC_SCOUT_URL", "").rstrip("/")
    token = os.environ.get("G2CC_TOKEN", "")
    if url and token:
        return url, token
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = json.load(f)
    except OSError as e:
        raise RuntimeError(
            f"cannot read {CONFIG_PATH} ({e}) — set G2CC_SCOUT_URL + G2CC_TOKEN instead")
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{CONFIG_PATH} is not valid JSON: {e}")
    port = cfg.get("port")
    cfg_token = cfg.get("authToken")
    if not isinstance(port, int) or not isinstance(cfg_token, str) or not cfg_token:
        raise RuntimeError(f"{CONFIG_PATH} is missing a usable port/authToken")
    return url or f"http://127.0.0.1:{port}", token or cfg_token


def call(base: str, token: str, method: str, path: str, body: dict | None) -> dict:
    req = urllib.request.Request(
        base + path,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        # No timeout kwarg — deliberate (module docstring). Loopback + a server
        # that always answers when the outcome is known.
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        # 401/403 replies still carry a JSON body with the reason.
        raw = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            raise RuntimeError(f"HTTP {e.code}: {bounded(raw)}")
        raise RuntimeError(f"HTTP {e.code}: {parsed.get('detail') or parsed.get('error') or bounded(raw)}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"cannot reach the G2CC server at {base}: {e.reason}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f"malformed server reply: {bounded(raw)}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Push a live frame to the G2 glasses (Scout)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("text", help="show a short glanceable text frame")
    t.add_argument("text", help="the frame text (<=560 UTF-8 bytes)")
    i = sub.add_parser("image", help="show an image file (absolute local path)")
    i.add_argument("path", help="absolute path to a local image file")
    i.add_argument("--caption", default=None, help="short caption (rides the title bar)")
    sub.add_parser("status", help="report the live-channel status (JSON)")
    args = ap.parse_args()

    try:
        base, token = load_endpoint()
        if args.cmd == "status":
            out = call(base, token, "GET", "/scout/live/status", None)
            print(json.dumps(out, indent=1))
            return 0
        if args.cmd == "text":
            body = {"kind": "text", "text": args.text}
        else:
            if not os.path.isabs(args.path):
                print(f"error: path must be absolute (got '{args.path}')", file=sys.stderr)
                return 2
            body = {"kind": "image", "path": args.path}
            if args.caption:
                body["caption"] = args.caption
        out = call(base, token, "POST", "/scout/live", body)
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    detail = out.get("detail", "(no detail)")
    if out.get("ok") and out.get("displayed"):
        print(f"shown: {detail}")
        return 0
    if out.get("ok"):
        print(f"accepted but NOT visible: {detail}", file=sys.stderr)
        return 3
    print(f"rejected: {detail}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
